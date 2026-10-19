// Empty bins under a % full: move their stock into other bins of the zones and bin types you choose,
// for every inventory area: pallet bins (stock on pallets, counted in pallet positions) and shelf bins
// (counted by volume). Pallet stock only goes to pallet bins, shelf stock only to shelf bins.
//
// Pure: takes plain data, returns a plan. lib/planners/inputs.js (relocateInput) builds the input from the DB.
//
// input:
//   bins:  [{ code, zone, zoneId, area, areaType, status, huType, binType, cap, volCC, maxKg,
//             multiSku, multiBatch, maxSku, maxSkuBatch, huMultiSku, huMultiBatch, fixed }]
//          cap = pallet positions (bin type palletCapacity); huMulti* = what one pallet may mix (bin type)
//   stock: Map binCode -> [{ hu, sku, batch, bucket, price, inclusion, iloc, uom, qty, locked }]   hu null = loose; free stock only
//   leaving: optional Map binCode -> [{ hu, sku, batch, bucket, price, iloc, uom, qty }]   stock a pick task is taking out. It
//          doesn't count toward fill, but until it's gone it keeps its pallet's position and the bin's and pallet's mixing
//          rules, counts in the WMS capacity check, and its pallet can't move whole (the WMS won't move a locked HU)
//   busy:  optional Map binCode -> [{ hu, mode, qty, who }]   stock arriving (PUT) or held by a task, read from the HU tables
//          (binLocks): such a bin takes nothing and gives nothing, whatever the inventory table says
//   emptyPallets: optional Map binCode -> [huCode]   pallets with no stock standing in a bin. The WMS ignores them; the floor
//          can't put a pallet where one stands
//   skus:  Map code -> { volL0, volL2, volL3, L0wt, L0inL2, L2inL3 }   (cc, kg; L2inL3 = cases per full pallet = best fit)
//   allowed(bin, sku, uom, bucket) -> bool   the search table, for moves into another zone
//   wmsUnit(binCode, sku, uom) -> number     optional: one unit's share of the bin as the WMS counts it when
//          IM moves stock in (best fit, else positions x units per pallet, else volume). The WMS refuses an
//          IM that takes a bin's total over 100%, even when the pallet it lands on has room.
//   lockError: optional string, set when the HU tables couldn't be read for locks (reported as a warning)
// opts:
//   from, to:   { areas, zones, binTypes, cells } codes (cells = "zone|bin type" pairs); empty = any inventory bin. A bin can be in both.
//   belowPct:   only empty bins under this % full (default 100 = any). Pallet bins: full pallets (the SKU's L3)
//               over pallet positions. Shelf bins: stock volume over bin volume.
//   useEmpty:   which empty bins may receive: "smaller" (default: only bins smaller than the one being emptied, fewer
//               pallet positions or less volume, so the move frees space), "any" (e.g. to clear a zone), "none"
//   crossZone:  let stock go to another zone, where the search table lets it in (default false: same zone only)
//   checkWeight: keep targets within the bin type's max kg (default true)
//   fillPct:    fill shelf targets up to this % of their volume (default 100)
//   objective:  "positions" (default: most net pallet positions freed, then net bins freed, then fewest empty bins used,
//               then fewest units moved, then fewest moves) or "bins" (net bins freed first, then positions, ...)
//   skipEmptyPalletBins: keep bins with an empty pallet in them out of the empty-bin pool, and count that pallet as a held
//               position in bins that hold stock (default true)
//   seed, maxIters, budgetMs: the search (below). Same input + same seed = same plan, unless the time budget cuts it short
//               (stats.search.stoppedBy says so)
//
// Search: each pass is greedy over the bins to empty in one order: a bin is emptied only when all its stock finds room,
// and only when that frees something net (unless useEmpty is "any"). Passes with a dozen fixed and seeded orders, then
// an iterated local search over the order (bins not emptied first, move one to the front, swap two, reverse a run),
// keeping a change when the plan is at least as good by the objective.
const { unitVol, unitKg, mixOk, lineKey, quantId } = require("./eaches");
const lk = (l) => lineKey(l) + "|" + (l.iloc || ""); // per owner too: two owners never share a line
const EPS = 1e-9;
const up = (s) => String(s ?? "").trim().toUpperCase();
const INVENTORY = (b) => b.areaType === "INVENTORY";
const SUSPECT_CC = 10_000_000, SUSPECT_KG = 1_000_000; // bin type values at or above these are placeholders

// share of one full pallet taken by one unit of this uom, or null when the SKU has no pallet size
function unitShare(skus, sku, uom) {
  const s = skus.get(sku);
  if (uom === "L3") return 1;
  if (!s?.L2inL3) return null;
  if (uom === "L2") return 1 / s.L2inL3;
  if (uom === "L0") return s.L0inL2 ? 1 / (s.L0inL2 * s.L2inL3) : null;
  return null;
}
// what one pallet may mix: the bin type's huMultiSku / huMultiBatch, the same way bin rules work
function huOk(b, p, l) {
  const ms = b.huMultiSku !== false, mb = b.huMultiBatch !== false, k = `${l.sku}|${up(l.batch)}`;
  if (!ms && !mb) return [...p.quants].every((q) => q === quantId(l));
  if (!ms && [...p.skus].some((s) => s !== l.sku)) return false;
  if (!mb && [...p.keys].some((x) => x.startsWith(l.sku + "|") && x !== k)) return false;
  return true;
}
// a pallet that already breaks its bin type's pallet rules takes nothing more
function palletBroken(b, p) {
  const ms = b.huMultiSku !== false, mb = b.huMultiBatch !== false;
  if (!ms && !mb && p.quants.size > 1) return true;
  if (!ms && p.skus.size > 1) return true;
  return !mb && [...p.skus].some((sku) => [...p.keys].filter((k) => k.startsWith(sku + "|")).length > 1);
}
// WMS keeps shelf stock on the bin's own handling unit (BIN_HU_<bin>): that's the bin, not a pallet
const palletOf = (b, hu) => (b.huType === "PALLET" && hu && !String(hu).startsWith("BIN_HU_") ? hu : null);
const coll = new Intl.Collator(undefined, { numeric: true }).compare;
// the first of a list by a comparator, in one pass (sorting thousands of empty bins per pour is slow)
const best = (list, cmp) => { let b; for (const x of list) if (b === undefined || cmp(x, b) < 0) b = x; return b; };
const scopeOf = (sc = {}) => {
  const a = new Set((sc.areas || []).map(up)), z = new Set((sc.zones || []).map(up)), t = new Set((sc.binTypes || []).map(up)), c = new Set((sc.cells || []).map(up));
  // cells: exact "zone|bin type" pairs, so ZONE-1 3D and ZONE-2 1D don't also pull in ZONE-1 1D
  return (b) => (!a.size || a.has(up(b.area))) && (!z.size || z.has(up(b.zone))) && (!t.size || t.has(up(b.binType)))
    && (!c.size || c.has(`${up(b.zone)}|${up(b.binType)}`));
};
const hashOf = (s) => { let x = 2166136261; for (const ch of s) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0; return x; };
// seeded PRNG (mulberry32): the search is the same every run
const rngOf = (seed) => { let a = hashOf(String(seed)) || 1; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; };
const clonePallet = (p) => ({ ...p, lines: new Map([...p.lines].map(([k, v]) => [k, { ...v }])), skus: new Set(p.skus), keys: new Set(p.keys), quants: new Set(p.quants) });
const cloneState = (t) => ({ ...t, skus: new Set(t.skus), keys: new Set(t.keys), quants: new Set(t.quants), ilocs: new Set(t.ilocs),
  lines: new Map([...t.lines].map(([k, v]) => [k, { ...v }])), pallets: new Map([...t.pallets].map(([k, p]) => [k, clonePallet(p)])) });
const newPallet = (hu) => ({ hu, lines: new Map(), skus: new Set(), keys: new Set(), quants: new Set(), share: 0, kg: 0, locked: false });

function binState(b, lines, skus, o, wu, gone, busy, empties) {
  const pallet = b.huType === "PALLET";
  const st = { b, pallet, lines: new Map(), pallets: new Map(), loose: 0, skus: new Set(), keys: new Set(), quants: new Set(), ilocs: new Set(),
    used: 0, share: 0, kg: 0, sized: true, locked: false, lockedInv: false, wu, wms: 0, busy: busy || [], emptyPals: pallet ? empties || [] : [] };
  for (const l0 of lines || []) {
    if (!(l0.qty > 0)) continue;
    const l = { ...l0, batch: up(l0.batch), hu: palletOf(b, l0.hu) };
    const k = lk(l), cur = st.lines.get(k);
    if (cur) cur.qty += l.qty; else st.lines.set(k, { ...l });
    st.skus.add(l.sku); st.keys.add(`${l.sku}|${l.batch}`); st.quants.add(quantId(l)); st.ilocs.add(l.iloc || "");
    st.kg += unitKg(skus, l.sku, l.uom) * l.qty;
    if (wu) st.wms += wu(b.code, l.sku, l.uom) * l.qty;
    if (l.locked) st.locked = st.lockedInv = true;
    // loading reads only INCLUDED stock: POST-GIN / PRE-GRN never moves (no status at all = an older schema: included)
    if (l.inclusion && up(l.inclusion) !== "INCLUDED") st.excluded = true;
    if (pallet) {
      const sh = unitShare(skus, l.sku, l.uom);
      if (sh === null) st.sized = false; else st.share += sh * l.qty;
      if (!l.hu) { st.loose += l.qty; continue; }
      if (!st.pallets.has(l.hu)) st.pallets.set(l.hu, newPallet(l.hu));
      const p = st.pallets.get(l.hu), pk = lk(l), pc = p.lines.get(pk);
      if (pc) pc.qty += l.qty; else p.lines.set(pk, { ...l });
      p.skus.add(l.sku); p.keys.add(`${l.sku}|${l.batch}`); p.quants.add(quantId(l));
      p.share += (sh || 0) * l.qty; p.kg += unitKg(skus, l.sku, l.uom) * l.qty;
      if (l.locked) p.locked = true;
    } else {
      const v = unitVol(skus, l.sku, l.uom);
      if (v === null) st.sized = false; else st.used += v * l.qty;
    }
  }
  for (const l0 of gone || []) {
    if (!(l0.qty > 0)) continue;
    const l = { ...l0, batch: up(l0.batch), hu: palletOf(b, l0.hu) };
    st.skus.add(l.sku); st.keys.add(`${l.sku}|${l.batch}`); st.quants.add(quantId(l)); st.ilocs.add(l.iloc || "");
    if (wu) st.wms += wu(b.code, l.sku, l.uom) * l.qty;
    st.leaving = true;
    if (!pallet) continue;
    if (!l.hu) { st.leavingLoose = true; continue; }
    if (!st.pallets.has(l.hu)) st.pallets.set(l.hu, newPallet(l.hu));
    const p = st.pallets.get(l.hu);
    p.skus.add(l.sku); p.keys.add(`${l.sku}|${l.batch}`); p.quants.add(quantId(l)); p.leaving = true;
  }
  // stock arriving or held by a task, seen in the HU tables: nothing in, nothing out (the inventory table may lag them)
  if (st.busy.length) st.locked = true;
  st.capKg = o.checkWeight && b.maxKg > 0 && b.maxKg < SUSPECT_KG ? b.maxKg : null;
  if (pallet) { st.positions = Math.max(1, Number(b.cap) || 1); st.occ = st.share / st.positions; }
  else {
    st.capCC = b.volCC > 0 && b.volCC < SUSPECT_CC ? b.volCC * o.fillPct / 100 : null;
    st.occ = b.volCC > 0 && b.volCC < SUSPECT_CC ? st.used / b.volCC : null;
  }
  return st;
}
// does the bin already break its own rules? then it can be emptied, but takes nothing
function brokenNow(t) {
  const ms = t.b.multiSku !== false, mb = t.b.multiBatch !== false;
  if (!ms && !mb && t.quants.size > 1) return true;
  if (!ms && t.skus.size > 1) return true;
  if (!mb && [...t.skus].some((sku) => [...t.keys].filter((k) => k.startsWith(sku + "|")).length > 1)) return true;
  if (t.b.maxSku && t.skus.size > t.b.maxSku) return true;
  if (t.b.maxSkuBatch && t.keys.size > t.b.maxSkuBatch) return true;
  if (t.ilocs.size > 1) return true;
  if (t.pallet && t.pallets.size + (t.loose || t.leavingLoose ? 1 : 0) > t.positions) return true; // more pallets than positions
  return t.capKg !== null && t.kg > t.capKg + EPS;
}
// units of a line the WMS still lets into the bin: its total stays at or under 100% (it allows 1e-6 over)
function wmsRoom(t, l) {
  if (!t.wu) return Infinity;
  const u = t.wu(t.b.code, l.sku, l.uom);
  return u > 0 ? Math.max(0, Math.floor((1 + 1e-6 - t.wms) / u + EPS)) : Infinity;
}
// add a line to a bin state (and to one of its pallets when given)
function addLine(t, l, n, skus, p) {
  const k = lk(l), cur = t.lines.get(k);
  if (cur) cur.qty += n; else t.lines.set(k, { ...l, qty: n });
  t.skus.add(l.sku); t.keys.add(`${l.sku}|${up(l.batch)}`); t.quants.add(quantId(l)); t.ilocs.add(l.iloc || "");
  const kg = unitKg(skus, l.sku, l.uom) * n;
  t.kg += kg;
  if (t.wu) t.wms += t.wu(t.b.code, l.sku, l.uom) * n;
  if (t.pallet) { const sh = unitShare(skus, l.sku, l.uom) * n; t.share += sh; t.occ = t.share / t.positions; if (p) { p.share += sh; p.kg += kg; } }
  else { t.used += unitVol(skus, l.sku, l.uom) * n; t.occ = t.b.volCC ? t.used / t.b.volCC : null; }
  if (p) { const pc = p.lines.get(k); if (pc) pc.qty += n; else p.lines.set(k, { ...l, qty: n }); p.skus.add(l.sku); p.keys.add(`${l.sku}|${up(l.batch)}`); p.quants.add(quantId(l)); }
}
// positions a pallet bin has taken: its pallets, loose stock as one, and (when they're skipped) the empty pallets standing in it
const heldOf = (t, o) => t.pallets.size + (t.loose || t.leavingLoose ? 1 : 0) + (o.skipEmptyPalletBins ? t.emptyPals.length : 0);
const posOf = (t) => (t.pallet ? t.positions : 0);
// a cheap first look at what mixOk decides for single-SKU / single-quant bins (most pallet bins): a bin holding other stock
// can't take this line. Only ever says no where mixOk would; mixOk still decides the rest
const mixMaybe = (t, l, qid) => (t.b.multiSku !== false ? true : t.b.multiBatch === false ? !t.quants.size || (t.quants.size === 1 && t.quants.has(qid))
  : !t.skus.size || (t.skus.size === 1 && t.skus.has(l.sku)));

function normOpts(opts) {
  const o = { belowPct: 100, useEmpty: "smaller", crossZone: false, checkWeight: true, fillPct: 100, objective: "positions", skipEmptyPalletBins: true,
    seed: 1, maxIters: 400, budgetMs: 2500, ...opts };
  o.checkWeight = o.checkWeight !== false && o.checkWeight !== "0";
  o.crossZone = o.crossZone === true || o.crossZone === 1 || o.crossZone === "1" || up(o.crossZone) === "TRUE";
  o.useEmpty = o.useEmpty === false || o.useEmpty === "0" || o.useEmpty === "none" ? "none" : o.useEmpty === true || o.useEmpty === "1" || o.useEmpty === "any" ? "any" : "smaller";
  o.belowPct = Math.min(100, Math.max(0.01, Number(o.belowPct) || 100));
  o.fillPct = Math.min(100, Math.max(1, Number(o.fillPct) || 100));
  o.objective = o.objective === "bins" ? "bins" : "positions";
  o.skipEmptyPalletBins = o.skipEmptyPalletBins !== false && o.skipEmptyPalletBins !== "0";
  o.maxIters = Math.max(0, Math.floor(Number(o.maxIters) || 0));
  o.budgetMs = Math.max(0, Number(o.budgetMs) || 0);
  o.from = o.from || {}; o.to = o.to || {};
  return o;
}

// everything every pass shares: the bins as they are now, which can be emptied and which can receive
function prepare({ bins, stock, skus, allowed, wmsUnit, leaving, busy, emptyPallets }, opts) {
  const o = normOpts(opts);
  const inFrom = scopeOf(o.from), inTo = scopeOf(o.to);
  const live = (b) => INVENTORY(b) && (b.huType === "PALLET" || b.huType === "BIN");
  const states = new Map();
  for (const b of bins) if (live(b) && (inFrom(b) || inTo(b)))
    states.set(b.code, binState(b, stock.get(b.code), skus, o, wmsUnit, leaving?.get(b.code), busy?.get(b.code), emptyPallets?.get(b.code)));
  const st = { fromBins: 0, fromStocked: 0, under: 0, toBins: 0, toEmpty: 0, toUsable: 0 };
  const sources = [], fixedOut = [];
  const stockText = (s) => [...s.lines.values()].map((l) => `${l.qty} ${l.uom} ${l.sku} ${l.batch}${l.hu ? ` (${l.hu})` : ""}`).join(" + ");
  const busyText = (s) => [...new Set(s.busy.map((x) => `${x.mode === "HU" ? `pallet ${x.hu} locked` : `${x.mode} lock${x.qty ? ` of ${x.qty}` : ""}`}${x.who ? ` by ${x.who}` : ""}`))].join(", ");
  const under = (s) => o.belowPct >= 100 || (s.occ !== null && s.occ < o.belowPct / 100 - EPS);
  for (const s of states.values()) {
    if (!inFrom(s.b)) continue;
    st.fromBins++;
    if (!s.lines.size) continue;
    st.fromStocked++;
    if (!under(s)) continue;
    st.under++;
    s.broken = brokenNow(s);
    const why = s.b.status !== "ACTIVE" ? `Bin is ${s.b.status}` : s.busy.length ? `Stock arriving or held by a task (${busyText(s)})` : s.locked ? "Stock locked by a task"
      : s.b.fixed ? "Fixed bin (mapped to a SKU, EAN or product)"
      : s.excluded ? "Stock not INCLUDED (POST-GIN / PRE-GRN)"
      : !s.sized ? (s.pallet ? "A SKU in it has no pallet size (L2 or L3 units)" : "A SKU in it has no volume for its unit")
      : s.pallet && s.loose ? "Loose stock not on a pallet" : null;
    if (why) fixedOut.push({ bin: s.b.code, zone: s.b.zone, area: s.b.area, binType: s.b.binType, occPct: s.occ === null ? null : s.occ * 100, why, stock: stockText(s) });
    else sources.push(s);
  }
  // targets: in the To scope, active, unlocked (nothing arriving), not fixed, only INCLUDED stock, sized, within their own rules; an empty bin
  // with an empty pallet standing in it isn't empty on the floor
  const targetOk = (t) => inTo(t.b) && t.b.status === "ACTIVE" && !t.locked && !t.b.fixed && !t.excluded && t.sized && !brokenNow(t)
    && (t.pallet || t.capCC !== null) && (o.useEmpty !== "none" || t.lines.size > 0)
    && !(o.skipEmptyPalletBins && !t.lines.size && t.emptyPals.length);
  for (const t of states.values()) if (inTo(t.b)) { st.toBins++; if (!t.lines.size) st.toEmpty++; if (targetOk(t)) st.toUsable++; }
  sources.sort((a, b) => coll(a.b.code, b.b.code));
  return { o, inFrom, inTo, states, st, sources, fixedOut, stockText, skus, allowed, bins,
    poolCodes: [...states.values()].filter(targetOk).map((t) => t.b.code) };
}

// positions a plan's whole pallets take in bins that held stock before it (a bin that was empty is counted whole instead)
const takenBy = (ctx, moves) => new Set(moves.filter((m) => m.kind === "pallet" && ctx.states.get(m.toBin)?.pallet && ctx.states.get(m.toBin).lines.size > 0)
  .map((m) => `${m.toBin}|${m.hu}`)).size;

// one greedy pass over the sources in this order
function planOnce(ctx, sources) {
  const { o, skus, allowed, stockText, poolCodes } = ctx;
  const states = new Map(ctx.states); // a pass replaces states, never changes them: ctx stays as read
  const received = new Set(), gone = new Set(), moves = [], emptied = [], notEmptied = [...ctx.fixedOut];
  // same zone unless asked; then only where the search table lets this class, unit and bucket in
  const zoneOk = (src, t, l) => t.b.zone === src.b.zone || (o.crossZone && (!allowed || allowed(t.b, l.sku, l.uom, l.bucket)));
  let posFreed = 0, emptyUsed = 0;
  // targets by what they can take, so a source only looks at bins that might: empty ones, multi-SKU ones, and single-SKU /
  // single-quant ones already holding its SKU / quant (the rest would fail mixOk). Bins only gain stock during a pass
  const idx = { empty: new Set(), open: new Set(), byQ: new Map(), byS: new Map() };
  const put = (m, k, c) => { if (!m.has(k)) m.set(k, new Set()); m.get(k).add(c); };
  const index = (t) => {
    const c = t.b.code;
    if (!t.lines.size && !t.quants.size) { idx.empty.add(c); return; }
    idx.empty.delete(c);
    if (t.b.multiSku !== false) idx.open.add(c); else if (t.b.multiBatch === false) for (const q of t.quants) put(idx.byQ, q, c); else for (const k of t.skus) put(idx.byS, k, c);
  };
  for (const c of poolCodes) index(states.get(c));
  const poolFor = (src) => {
    const codes = new Set([...idx.empty, ...idx.open]);
    for (const l of src.lines.values()) { for (const c of idx.byQ.get(quantId(l)) || []) codes.add(c); for (const c of idx.byS.get(l.sku) || []) codes.add(c); }
    return [...codes];
  };
  for (const src of sources) {
    if (received.has(src.b.code)) continue;
    // this source's working copies of the targets it pours into: copied on first write only
    const sim = new Map();
    const view = (t) => sim.get(t.b.code) || t;
    const simOf = (t) => { if (!sim.has(t.b.code)) sim.set(t.b.code, cloneState(t)); return sim.get(t.b.code); };
    // an empty bin only takes from a bigger one, unless any empty bin is allowed (an equal one frees nothing)
    const smaller = (t) => (t.pallet ? t.positions < src.positions : t.b.volCC < src.b.volCC);
    const pool = poolFor(src).filter((c) => c !== src.b.code && !gone.has(c)).map((c) => states.get(c))
      .filter((t) => t.pallet === src.pallet && (t.lines.size > 0 || o.useEmpty === "any" || smaller(t)));
    const plan = [], usedBins = new Set(); // usedBins: where this source already sends stock (fewer distinct targets)
    let fail = null;
    const kgRoom = (t, uk) => (t.capKg === null || !(uk > 0) ? Infinity : Math.floor((t.capKg - t.kg) / uk + EPS));
    const base = (l, t) => ({ fromBin: src.b.code, fromZone: src.b.zone, fromArea: src.b.area, fromBinType: src.b.binType, fromOccPct: (src.occ ?? 0) * 100,
      sku: l.sku, batch: l.batch, bucket: l.bucket, price: l.price, inclusion: l.inclusion, iloc: l.iloc, uom: l.uom,
      toBin: t.b.code, toZone: t.b.zone, toArea: t.b.area, toBinType: t.b.binType, toWasEmpty: t.lines.size === 0, crossZone: t.b.zone !== src.b.zone });
    if (src.pallet) {
      // each pallet: merge it onto pallets of the same stock that have room; else move it whole into a free position
      const pals = [...src.pallets.values()].sort((a, b) => b.share - a.share || a.hu.localeCompare(b.hu));
      for (const p of pals) {
        // 1) merge every line onto pallets that take it (same rules as the bin and the pallet)
        const tries = [];
        let ok = true;
        const trial = new Map(), trialBins = new Set(usedBins);
        const tv = (t) => trial.get(t.b.code) || view(t);
        const tw = (t) => { if (!trial.has(t.b.code)) trial.set(t.b.code, cloneState(view(t))); return trial.get(t.b.code); };
        for (const l of p.lines.values()) {
          const sh = unitShare(skus, l.sku, l.uom), uk = unitKg(skus, l.sku, l.uom), qid = quantId(l);
          let left = l.qty;
          const cands = [];
          for (const t0 of pool) {
            const t = tv(t0);
            if (!t.lines.size || !mixMaybe(t, l, qid) || !mixOk(t, l) || !zoneOk(src, t, l)) continue;
            // not onto a pallet a task holds or is picking from: the WMS (and the picker) may be moving it
            for (const tp of t.pallets.values()) if (!tp.locked && !tp.leaving && !palletBroken(t.b, tp) && huOk(t.b, tp, l)) cands.push({ t0, hu: tp.hu, same: tp.quants.has(qid), zone: t0.b.zone === src.b.zone });
          }
          // not enough room on all of them together (pallet room alone; weight and WMS capacity only cut it): don't try
          let roomAll = 0;
          for (const c of cands) { roomAll += Math.max(0, Math.floor((1 - tv(c.t0).pallets.get(c.hu).share) / sh + EPS)); if (roomAll >= left) break; }
          if (roomAll < left) { ok = false; break; }
          // best fit: a pallet that takes all that's left and ends fullest (exactly full first); else the one taking most.
          // Same zone first; then a bin this source already sends to; then the same stock, the fuller pallet, the code
          while (left > 0) {
            let pick = null;
            for (const c of cands) {
              const t = tv(c.t0), tp = t.pallets.get(c.hu);
              if (!mixOk(t, l) || !huOk(t.b, tp, l)) continue;
              const n = Math.min(left, Math.floor((1 - tp.share) / sh + EPS), kgRoom(t, uk), wmsRoom(t, l));
              if (n <= 0) continue;
              const x = { c, n, all: n === left, after: tp.share + n * sh, usedBy: trialBins.has(c.t0.b.code), share: tp.share };
              if (!pick || (x.c.zone - pick.c.zone || x.all - pick.all || (x.all ? Math.round((x.after - pick.after) * 1e6) : x.n - pick.n) || x.usedBy - pick.usedBy
                || x.c.same - pick.c.same || x.share - pick.share || coll(pick.c.t0.b.code, x.c.t0.b.code) || pick.c.hu.localeCompare(x.c.hu)) > 0) pick = x;
            }
            if (!pick) break;
            const t = tw(pick.c.t0), tp = t.pallets.get(pick.c.hu), before = tp.share;
            addLine(t, l, pick.n, skus, tp);
            trialBins.add(t.b.code);
            tries.push({ ...base(l, t), kind: "merge", hu: p.hu, toHu: tp.hu, qty: pick.n, unitShare: sh, toPalletBefore: before, toPalletAfter: tp.share,
              toPositions: t.pallets.size, toCap: t.positions, toKgAfter: t.kg, toMaxKg: t.capKg });
            left -= pick.n;
          }
          if (left) { ok = false; break; }
        }
        if (ok) { for (const [k, t] of trial) sim.set(k, t); for (const b of trialBins) usedBins.add(b); plan.push(...tries); continue; }
        // a pallet a pick task is taking stock from is locked: the WMS won't move it whole
        if (p.leaving) { fail = `Pallet ${p.hu} has stock being picked, so it can't move whole, and no pallet takes all its other stock`; break; }
        // 2) the whole pallet into a free position: a bin already holding stock first, then an empty one
        const lines = [...p.lines.values()], qids = lines.map(quantId);
        const fits = (t) => {
          // one pallet per position: what the bin holds (pallets, loose stock, empty pallets) plus this one
          if (heldOf(t, o) + 1 > t.positions) return false;
          if (!lines.every((l, i) => mixMaybe(t, l, qids[i]))) return false;
          if (t.capKg !== null && t.kg + p.kg > t.capKg + EPS) return false;
          // the pallet as it is must meet this bin type's pallet rules too (another bin type may be stricter)
          const hp = { skus: new Set(), keys: new Set(), quants: new Set() };
          for (const l of lines) { if (!huOk(t.b, hp, l)) return false; hp.skus.add(l.sku); hp.keys.add(`${l.sku}|${up(l.batch)}`); hp.quants.add(quantId(l)); }
          // the bin's mixing rules with every line added: only the sets mixOk reads, not a whole copy of the bin
          const x = { b: t.b, ilocs: new Set(t.ilocs), quants: new Set(t.quants), skus: new Set(t.skus), keys: new Set(t.keys) };
          for (const l of lines) {
            if (!zoneOk(src, t, l) || !mixOk(x, l)) return false;
            x.ilocs.add(l.iloc || ""); x.quants.add(quantId(l)); x.skus.add(l.sku); x.keys.add(`${l.sku}|${up(l.batch)}`);
          }
          if (t.wu && t.wms + lines.reduce((s, l) => s + t.wu(t.b.code, l.sku, l.uom) * l.qty, 0) > 1 + 1e-6) return false;
          return true;
        };
        const sameSku = (t) => lines.some((l) => t.skus.has(l.sku));
        // a bin holding stock first (an empty one costs a bin), same zone, one this source already sends to, the same SKU,
        // then the tightest fit: fewest positions left in a bin holding stock, fewest positions in an empty one
        const pick = best(pool.map(view).filter(fits), (a, b) => ((b.lines.size > 0) - (a.lines.size > 0)) || ((b.b.zone === src.b.zone) - (a.b.zone === src.b.zone))
          || (usedBins.has(b.b.code) - usedBins.has(a.b.code)) || (sameSku(b) - sameSku(a))
          || (a.lines.size ? (a.positions - heldOf(a, o)) - (b.positions - heldOf(b, o)) : a.positions - b.positions) || coll(a.b.code, b.b.code));
        if (!pick) { fail = `No bin takes pallet ${p.hu} (${lines.map((l) => `${l.qty} ${l.uom} ${l.sku} ${l.batch}`).join(" + ")})`; break; }
        const cand = simOf(pick), wasEmpty = cand.lines.size === 0, posBefore = cand.pallets.size;
        const np = newPallet(p.hu);
        cand.pallets.set(p.hu, np);
        for (const l of lines) addLine(cand, l, l.qty, skus, np);
        usedBins.add(cand.b.code);
        plan.push(...lines.map((l) => ({ ...base(l, cand), toWasEmpty: wasEmpty, kind: "pallet", hu: p.hu, toHu: p.hu, qty: l.qty, unitShare: unitShare(skus, l.sku, l.uom),
          toPalletBefore: 0, toPalletAfter: np.share, toPositionsBefore: posBefore, toPositions: cand.pallets.size, toCap: cand.positions, toKgAfter: cand.kg, toMaxKg: cand.capKg })));
      }
    } else {
      // shelf: pour each line into shelf bins by volume
      const lines = [...src.lines.values()].sort((a, b) => unitVol(skus, b.sku, b.uom) * b.qty - unitVol(skus, a.sku, a.uom) * a.qty);
      for (const l of lines) {
        const uv = unitVol(skus, l.sku, l.uom), uk = unitKg(skus, l.sku, l.uom), k = `${l.sku}|${up(l.batch)}`;
        let left = l.qty;
        while (left > 0) {
          const room = (t) => Math.max(0, Math.min(Math.floor((t.capCC - t.used) / uv + EPS), kgRoom(t, uk), wmsRoom(t, l)));
          const c0 = best(pool.map(view).filter((t) => room(t) > 0 && mixOk(t, l) && zoneOk(src, t, l)),
            (a, b) => ((b.lines.size > 0) - (a.lines.size > 0)) || ((b.b.zone === src.b.zone) - (a.b.zone === src.b.zone)) || (b.keys.has(k) - a.keys.has(k))
              || ((room(b) >= left) - (room(a) >= left)) || (usedBins.has(b.b.code) - usedBins.has(a.b.code))
              || ((a.capCC - a.used) - (b.capCC - b.used)) || coll(a.b.code, b.b.code));
          if (!c0) { fail = `No bin takes ${left} ${l.uom} of ${l.sku} ${l.batch}`; break; }
          const c = simOf(c0), n = Math.min(left, room(c)), before = c.used, wasEmpty = c.lines.size === 0;
          addLine(c, l, n, skus);
          usedBins.add(c.b.code);
          plan.push({ ...base(l, c), toWasEmpty: wasEmpty, kind: "pour", hu: null, toHu: null, qty: n, unitVolCC: uv, moveVolCC: n * uv,
            toBinVolCC: c.b.volCC, toCapCC: c.capCC, toUsedBeforeCC: before, toUsedAfterCC: c.used, toKgAfter: c.kg, toMaxKg: c.capKg });
          left -= n;
        }
        if (fail) break;
      }
    }
    const took = new Set(plan.map((p) => p.toBin)), newEmpty = new Set(plan.filter((p) => p.toWasEmpty).map((p) => p.toBin));
    const taken = takenBy(ctx, plan);
    // worth it only when it frees something net: emptying a 2-position bin into two empty 1-position bins frees nothing
    if (!fail && o.useEmpty !== "any" && newEmpty.size) {
      const gainPos = posOf(src) - [...newEmpty].reduce((t, c) => t + posOf(states.get(c)), 0) - taken, gainBins = 1 - newEmpty.size;
      const [a, b] = o.objective === "bins" ? [gainBins, gainPos] : [gainPos, gainBins];
      if (a < 0 || (a === 0 && b <= 0)) fail = `Emptying it would use ${newEmpty.size} empty bin(s) and free nothing net`;
    }
    if (fail) { notEmptied.push({ bin: src.b.code, zone: src.b.zone, area: src.b.area, binType: src.b.binType, occPct: (src.occ ?? 0) * 100, why: fail, stock: stockText(src) }); continue; }
    for (const [code, t] of sim) if (took.has(code)) { states.set(code, t); received.add(code); index(t); }
    gone.add(src.b.code);
    moves.push(...plan);
    posFreed += posOf(src) - [...newEmpty].reduce((t, c) => t + posOf(ctx.states.get(c)), 0) - taken;
    emptyUsed += newEmpty.size;
    emptied.push({ bin: src.b.code, afterPick: !!src.leaving, zone: src.b.zone, area: src.b.area, binType: src.b.binType, kind: src.pallet ? "pallet" : "shelf", occPct: (src.occ ?? 0) * 100,
      pallets: src.pallets.size, lines: src.lines.size, to: [...took] });
  }
  // sources skipped because they took stock in this plan
  for (const s of ctx.sources) if (!gone.has(s.b.code) && received.has(s.b.code))
    notEmptied.push({ bin: s.b.code, zone: s.b.zone, area: s.b.area, binType: s.b.binType, occPct: (s.occ ?? 0) * 100, why: "Receives stock in this plan", stock: stockText(s) });
  const units = moves.reduce((t, m) => t + m.qty, 0);
  return { moves, emptied, notEmptied, states, gone, score: { positionsFreed: posFreed, netBins: emptied.length - emptyUsed, emptyUsed, units, moves: moves.length, binsEmptied: emptied.length } };
}

// < 0 when plan score a is better than b, by the objective
function cmpScore(o, a, b) {
  const [a1, a2, b1, b2] = o.objective === "bins" ? [a.netBins, a.positionsFreed, b.netBins, b.positionsFreed] : [a.positionsFreed, a.netBins, b.positionsFreed, b.netBins];
  return (b1 - a1) || (b2 - a2) || (a.emptyUsed - b.emptyUsed) || (a.units - b.units) || (a.moves - b.moves);
}

// stats, warnings and per-zone totals of the plan kept
function finish(ctx, run, input, search) {
  const { o, st } = ctx;
  const { moves, emptied, notEmptied, states, gone } = run;
  const byCode = (x, y) => String(x).localeCompare(String(y), undefined, { numeric: true });
  // in the order they were planned: a later move can merge onto a pallet an earlier one brought in
  moves.forEach((m, i) => { m.step = i + 1; });
  emptied.sort((x, y) => byCode(x.bin, y.bin));
  notEmptied.sort((x, y) => (x.occPct ?? 0) - (y.occPct ?? 0) || byCode(x.bin, y.bin));
  const emptyUsed = new Set(moves.filter((m) => m.toWasEmpty).map((m) => m.toBin)), emptiedSet = new Set(emptied.map((e) => e.bin));
  const pos = (code) => posOf(ctx.states.get(code) || {});
  const positionsFreed = emptied.reduce((t, e) => t + pos(e.bin), 0) - [...emptyUsed].reduce((t, c) => t + pos(c), 0) - takenBy(ctx, moves);
  // a source pallet whose stock goes onto more than one pallet: legal, but the floor splits it
  const parts = new Map();
  for (const m of moves) if (m.hu) { const k = `${m.fromBin}|${m.hu}`; if (!parts.has(k)) parts.set(k, new Set()); parts.get(k).add(`${m.toBin}|${m.toHu}`); }
  const split = [...parts].filter(([, s]) => s.size > 1).map(([k]) => k);
  const splitSet = new Set(split);
  for (const m of moves) m.splitPallet = !!m.hu && splitSet.has(`${m.fromBin}|${m.hu}`);
  const crossZoneMoves = moves.filter((m) => m.crossZone).length;
  const palletsMerged = new Set(moves.filter((m) => m.kind === "merge").map((m) => `${m.fromBin}|${m.hu}`)).size;
  const stats = { ...st, candidates: ctx.sources.length, binsEmptied: emptied.length, moves: moves.length, unitsMoved: run.score.units, casesMoved: run.score.units,
    palletsMovedWhole: new Set(moves.filter((m) => m.kind === "pallet").map((m) => m.hu)).size, palletsMerged, palletsFreed: palletsMerged,
    emptyBinsUsed: emptyUsed.size, netFreed: emptied.length - emptyUsed.size, netBinsFreed: emptied.length - emptyUsed.size, positionsFreed,
    targetBins: new Set(moves.map((m) => m.toBin)).size, crossZoneMoves, splitPallets: split.length, heldBack: 0, search };

  const warnings = [];
  const w = (level, code, text, bins = []) => warnings.push({ level, code, text, bins: [...new Set(bins)].sort(byCode) });
  if (input.lockError) w("warn", "lock-read-failed", `Couldn't read task locks from the HU tables (${input.lockError}); only the inventory table's lock columns were used.`);
  if (input.emptyPalletError) w("warn", "empty-pallet-read-failed", `Couldn't read empty pallets (${input.emptyPalletError}); bins with an empty pallet in them may be used.`);
  const inScope = [...ctx.states.values()];
  const busy = inScope.filter((s) => s.busy.length || s.lockedInv);
  if (busy.length) w("info", "put-lock", `${busy.length} bin(s) in scope have stock arriving (PUT) or held by a task: left out, nothing in or out.`, busy.map((s) => s.b.code));
  const hidden = busy.filter((s) => s.busy.length && !s.lockedInv);
  if (hidden.length) w("warn", "put-lock", `${hidden.length} of them show a lock only in the HU tables, not in the inventory table.`, hidden.map((s) => s.b.code));
  // every bin the plan uses that has an empty pallet standing in it
  const used = new Map();
  for (const m of moves) { if (!used.has(m.toBin)) used.set(m.toBin, { to: true, wasEmpty: m.toWasEmpty }); else used.get(m.toBin).to = true; if (!used.has(m.fromBin)) used.set(m.fromBin, { to: false }); }
  for (const [code, u] of used) {
    const e = ctx.states.get(code)?.emptyPals || [];
    if (!e.length) continue;
    const who = `empty pallet${e.length > 1 ? "s" : ""} ${e.join(", ")}`;
    if (!u.to) w("info", "empty-pallet-in-target", `${code} is emptied, but ${who} still stand${e.length > 1 ? "" : "s"} in it: clear before using the bin.`, [code]);
    else if (u.wasEmpty) w("block", "empty-pallet-in-target", `${code} receives a pallet but ${who} stand${e.length > 1 ? "" : "s"} in it: clear first.`, [code]);
    else w("warn", "empty-pallet-in-target", `${code} receives stock and has ${who} in it.`, [code]);
  }
  const skipped = inScope.filter((t) => o.skipEmptyPalletBins && ctx.inTo(t.b) && !t.lines.size && t.emptyPals.length);
  if (skipped.length) w("info", "empty-pallet-skipped", `${skipped.length} empty bin(s) have an empty pallet in them, so they weren't used.`, skipped.map((t) => t.b.code));
  const excl = inScope.filter((s) => s.excluded);
  if (excl.length) w("info", "not-included", `${excl.length} bin(s) in scope hold stock that isn't INCLUDED (POST-GIN / PRE-GRN): never moved, and nothing goes into them.`, excl.map((s) => s.b.code));
  const noFit = notEmptied.filter((n) => n.why.includes("no pallet size"));
  if (noFit.length) w("info", "no-best-fit", `${noFit.length} bin(s) hold a SKU with no pallet size (cases per pallet), so they were left alone.`, noFit.map((n) => n.bin));
  if (crossZoneMoves) w("warn", "cross-zone", `${crossZoneMoves} move(s) go to another zone (the search table allows them).`, moves.filter((m) => m.crossZone).flatMap((m) => [m.fromBin, m.toBin]));
  if (split.length) w("info", "split-pallet", `${split.length} pallet(s) are split over more than one target pallet.`, split.map((k) => k.split("|")[0]));
  if (emptyUsed.size) w("info", "empty-target-race", "Empty bins in this plan can be taken by a putaway or another task before the IM upload: run the plan again just before uploading.", [...emptyUsed]);

  // per zone, after the plan: positions held and spare, bins emptied, net positions freed
  const zones = new Map();
  for (const s of inScope) {
    const k = `${s.b.area}|${s.b.zone}`;
    if (!zones.has(k)) zones.set(k, { zone: s.b.zone, area: s.b.area, bins: 0, positions: 0, used: 0, spare: 0, binsUsed: 0, binsEmptied: 0, positionsFreed: 0 });
    const z = zones.get(k), t = states.get(s.b.code) || s, out = gone.has(s.b.code);
    z.bins++;
    if (!out && t.lines.size) z.binsUsed++;
    if (s.pallet) { z.positions += s.positions; z.used += out ? 0 : Math.min(s.positions, heldOf(t, o)); }
    if (emptiedSet.has(s.b.code)) { z.binsEmptied++; z.positionsFreed += posOf(s); }
    if (emptyUsed.has(s.b.code)) z.positionsFreed -= posOf(s);
    else if (!emptiedSet.has(s.b.code)) z.positionsFreed -= takenBy(ctx, moves.filter((m) => m.toBin === s.b.code));
  }
  for (const z of zones.values()) z.spare = z.positions - z.used;
  return { opts: o, stats, warnings, zones: [...zones.values()].sort((a, b) => byCode(a.area, b.area) || byCode(a.zone, b.zone)), emptied, moves, notEmptied };
}

function relocatePlan(input, opts = {}) {
  const t0 = Date.now(), ctx = prepare(input, opts), o = ctx.o, src = ctx.sources;
  const oc = (x) => x.occ ?? 0;
  const sorted = (cmp) => [...src].sort((a, b) => cmp(a, b) || coll(a.b.code, b.b.code));
  const shuffle = (list, rnd) => { const a = [...list]; for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  // fixed orders first: emptiest, fewest lines, fullest, biggest bins (most positions to free), fewest pallets, least stock
  const orders = [
    sorted((a, b) => oc(a) - oc(b)), sorted((a, b) => a.lines.size - b.lines.size || oc(a) - oc(b)), sorted((a, b) => oc(b) - oc(a)),
    sorted((a, b) => posOf(b) - posOf(a) || oc(a) - oc(b)), sorted((a, b) => a.pallets.size - b.pallets.size || oc(a) - oc(b)),
    sorted((a, b) => (a.share || a.used) - (b.share || b.used)), sorted((a, b) => posOf(b) - posOf(a) || a.pallets.size - b.pallets.size || oc(a) - oc(b)),
  ];
  const rnd = rngOf(o.seed);
  for (let i = 0; i < 5; i++) orders.push(shuffle(src, rnd));
  let bestRun = null, bestOrder = null, passes = 0, improved = 0, stoppedBy = "done";
  const perfect = (r) => r.score.binsEmptied === src.length && r.score.emptyUsed === 0; // nothing left to gain
  const tryOrder = (ord) => {
    const r = planOnce(ctx, ord); passes++;
    const c = bestRun ? cmpScore(o, r.score, bestRun.score) : -1;
    if (c < 0 && bestRun) improved++;
    if (c <= 0) { bestRun = r; bestOrder = ord; } // equal: move on (plateaus)
  };
  for (const ord of orders) { tryOrder(ord); if (perfect(bestRun)) break; }
  // iterated local search on the order of the best pass so far
  for (let it = 0; it < o.maxIters && src.length > 1 && !perfect(bestRun); it++) {
    if (Date.now() - t0 > o.budgetMs) { stoppedBy = "time"; break; }
    const done = new Set(bestRun.emptied.map((e) => e.bin)), a = [...bestOrder], kind = rnd();
    let next;
    if (kind < 0.4) {
      // some of the bins not emptied go first
      const left = a.filter((s) => !done.has(s.b.code)), pickd = left.filter(() => rnd() < 0.5);
      if (!pickd.length && left.length) pickd.push(left[Math.floor(rnd() * left.length)]);
      const ps = new Set(pickd);
      next = [...shuffle(pickd, rnd), ...a.filter((s) => !ps.has(s))];
    } else if (kind < 0.65) { const i = Math.floor(rnd() * a.length); next = [a[i], ...a.slice(0, i), ...a.slice(i + 1)]; } // one to the front
    else if (kind < 0.85) { const i = Math.floor(rnd() * a.length), j = Math.floor(rnd() * a.length); [a[i], a[j]] = [a[j], a[i]]; next = a; } // swap two
    else { let i = Math.floor(rnd() * a.length), j = Math.floor(rnd() * a.length); if (i > j) [i, j] = [j, i]; next = [...a.slice(0, i), ...a.slice(i, j + 1).reverse(), ...a.slice(j + 1)]; }
    tryOrder(next);
  }
  if (stoppedBy === "done" && perfect(bestRun)) stoppedBy = "all emptied";
  return finish(ctx, bestRun, input, { passes, improved, ms: Date.now() - t0, stoppedBy, seed: o.seed });
}

module.exports = { relocatePlan, unitShare };
