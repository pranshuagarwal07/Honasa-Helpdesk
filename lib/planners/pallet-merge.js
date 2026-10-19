// Consolidate stock (pallet bins).
//  consolidation(m, rows): Check a sheet's estimate, in pallet shares: how many positions merging same SKU + batch
//    partial pallets would free once the sheet is in. packBins: its whole-pallet follow-up (kept for callers of the old API).
//  palletPlan(input, opts): the stock plan behind GET /api/inv/consolidate, in whole units of the real stock lines, so
//    every move it plans passes the IM upload (WMS bin capacity, Destination HU rules) and the floor's rules (zone, locks,
//    positions, mixing, weight). Its input comes from relocateInput (planners/chain.js mergeInputOf); pallet-merge-check.js replays it independently.
const { upper, pct } = require("../core/util");
const { EXEMPT_AREAS, allowedSeq } = require("../wms/search");
const { isResetSheet, palletsAfter, casesText } = require("../wms/pallets");
const { unitKg, mixOk, quantId } = require("./eaches");

// Only same SKU + same batch partial pallets merge, so the result is valid whatever the
// bin type's mixing flags. Keep the fullest pallets, pour the emptiest into them.
// locked: HUs a task holds; busy: bins with locked stock or stock arriving (put lock), which pallets
// neither leave nor go into; leaving: stock being picked (see palletsAfter)
function consolidation(m, rows, { locked = new Set(), busy = new Set(), leaving = new Map() } = {}) {
  const isReset = isResetSheet(rows);
  // storage only: INVENTORY areas, or every non-working area if the node has none
  const hasInv = m.bins.some((b) => b.huType === "PALLET" && b.areaType === "INVENTORY");
  const storage = (b) => b && b.status === "ACTIVE" && (hasInv ? b.areaType === "INVENTORY" : !EXEMPT_AREAS.has(b.areaType));
  const pallets = [...palletsAfter(m, rows, isReset, leaving).values()].filter((p) => storage(m.binByCode.get(p.bin)));
  const st = { pallets: pallets.length, full: 0, over: 0, partial: 0, mixed: 0, unsized: 0 };
  const groups = new Map();
  for (const p of pallets) {
    // a task holds it: it can't be poured from or into until the task ends
    if (locked.has(p.hu)) { p.state = "Locked by a task"; st.locked = (st.locked || 0) + 1; continue; }
    if (busy.has(p.bin)) { p.state = "Bin has locked stock or stock arriving"; st.busy = (st.busy || 0) + 1; continue; }
    if (p.leaving && !p.lines.length) { p.state = "All of it being picked"; st.picking = (st.picking || 0) + 1; continue; }
    if (p.share === null) { p.state = "No best fit"; st.unsized++; continue; }
    if (p.keys.size > 1) { p.state = "Mixed"; st.mixed++; continue; }
    if (p.share > 1 + 1e-9) { p.state = "Over best fit"; st.over++; continue; }
    if (p.share >= 1 - 1e-9) { p.state = "Full"; st.full++; continue; }
    p.state = "Partial"; st.partial++;
    const k = [...p.keys][0];
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  const palletsInBin = new Map();
  for (const p of pallets) palletsInBin.set(p.bin, (palletsInBin.get(p.bin) || 0) + 1);
  const removedInBin = new Map();
  const merges = [], moves = [];
  for (const [k, list] of groups) {
    if (list.length < 2) continue;
    const total = list.reduce((t, p) => t + p.share, 0), need = Math.ceil(total - 1e-9);
    if (need >= list.length) continue;
    const [sku, batch] = k.split("|"), bf = m.skus.get(sku)?.L2inL3 || null;
    // fullest first; on a tie keep the pallet whose bin holds more, so small bins empty
    list.sort((a, b) => b.share - a.share || palletsInBin.get(b.bin) - palletsInBin.get(a.bin));
    const keep = list.slice(0, need), drop = list.slice(need);
    const room = keep.map((p) => ({ p, left: 1 - p.share }));
    for (const d of [...drop].reverse()) {
      let left = d.share;
      for (const r of room) {
        if (left <= 1e-9) break;
        const take = Math.min(left, r.left);
        if (take <= 1e-9) continue;
        moves.push({ sku, batch, fromBin: d.bin, fromHu: d.hu, toBin: r.p.bin, toHu: r.p.hu, cases: bf ? take * bf : null, share: take });
        r.left -= take; left -= take;
      }
      d.mergeInto = true;
      removedInBin.set(d.bin, (removedInBin.get(d.bin) || 0) + 1);
    }
    keep.forEach((p) => { p.keepFor = true; });
    merges.push({ sku, batch, bestFit: bf, pallets: list.length, cases: bf ? total * bf : null, fill: total, need, frees: list.length - need,
      bins: new Set(list.map((p) => p.bin)).size, oneBin: new Set(list.map((p) => p.bin)).size === 1,
      list: list.map((p) => `${p.hu}@${p.bin} ${pct(p.share)}`) });
  }
  merges.sort((a, b) => b.frees - a.frees || a.sku.localeCompare(b.sku));
  const emptiedBins = [...removedInBin].filter(([b, n]) => n === palletsInBin.get(b)).map(([b]) => b);
  const binsEmptied = emptiedBins.length;

  // positions: active pallet bins in storage areas
  const zones = new Map();
  let positions = 0, used = 0, emptyBins = 0, binsN = 0;
  for (const b of m.bins) {
    if (b.huType !== "PALLET" || !storage(b)) continue;
    const n = palletsInBin.get(b.code) || 0;
    binsN++; positions += b.cap; used += Math.min(n, b.cap); if (!n) emptyBins++;
    const zk = b.zone || "(no zone)";
    if (!zones.has(zk)) zones.set(zk, { zone: zk, area: b.area || "", bins: 0, positions: 0, used: 0, partial: 0, frees: 0 });
    const z = zones.get(zk);
    z.bins++; z.positions += b.cap; z.used += Math.min(n, b.cap);
  }
  for (const p of pallets) {
    const z = zones.get(m.binByCode.get(p.bin)?.zone || "(no zone)");
    if (!z) continue;
    if (p.state === "Partial") z.partial++;
    if (p.mergeInto) z.frees++;
  }
  const frees = merges.reduce((t, g) => t + g.frees, 0);

  return {
    isReset,
    stats: { ...st, palletBins: binsN, positions, used, spare: positions - used, emptyBins, frees, binsEmptied, mergeGroups: merges.length,
      sameBinFrees: merges.filter((g) => g.oneBin).reduce((t, g) => t + g.frees, 0) },
    zones: [...zones.values()].map((z) => ({ ...z, spare: z.positions - z.used })).sort((a, b) => b.frees - a.frees || a.zone.localeCompare(b.zone)),
    merges, moves, pallets, emptiedBins, shelf: shelfSpread(m, rows, isReset),
  };
}

// shelf (BIN-type) bins: the same SKU + batch spread over several bins. No best fit
// for shelves (putaway sizes them by volume), so these are only candidates to look at.
function shelfSpread(m, rows = [], isReset = false) {
  const shelf = new Map();
  const shelfNote = (bin, sku, batch) => {
    if (m.binByCode.get(bin)?.huType !== "BIN" || EXEMPT_AREAS.has(m.binByCode.get(bin)?.areaType) || m.binByCode.get(bin)?.areaType === "WORK_CENTER") return;
    const k = `${sku}|${upper(batch)}`;
    if (!shelf.has(k)) shelf.set(k, new Set());
    shelf.get(k).add(bin);
  };
  const sheetBins = new Set(rows.map((r) => r.bin));
  for (const [bin, list] of m.occupied) if (!(isReset && sheetBins.has(bin))) list.forEach((x) => shelfNote(bin, x.skuCode, x.batch));
  rows.forEach((r) => shelfNote(r.bin, r.sku, r.batch));
  const spread = [...shelf].filter(([, b]) => b.size > 1).map(([k, b]) => ({ sku: k.split("|")[0], batch: k.split("|")[1], bins: b.size, list: [...b].sort() }))
    .sort((a, b) => b.bins - a.bins);
  return { groups: spread.length, extraBins: spread.reduce((t, s) => t + s.bins - 1, 0), top: spread.slice(0, 200) };
}

// Whole-pallet moves that empty multi-position bins. After the merges, the pallets of the
// emptiest bins go into bins of the same zone and bin type that already hold pallets and
// have room, within the target's multi-SKU / multi-batch rules and SKU caps. Moving a whole
// pallet frees no position, but it frees the bin for something else.
function packBins(m, cons, locked = new Set(), busy = new Set()) {
  const palletsOf = new Map();
  // a pallet merged away is gone, unless stock is still being picked from it: then it holds its position until the pick is done
  for (const p of cons.pallets) if (!p.mergeInto || p.leaving) { if (!palletsOf.has(p.bin)) palletsOf.set(p.bin, []); palletsOf.get(p.bin).push(p); }
  // loose stock (no pallet) stays put, so a bin holding any can't be emptied by moving pallets
  const hasLoose = (bin) => {
    const all = (m.occupied.get(bin) || []).reduce((t, x) => t + x.qty, 0);
    let onPallets = 0;
    for (const lines of (m.palletStock.get(bin) || new Map()).values()) for (const x of lines) onPallets += x.qty;
    return all - onPallets > 1e-6;
  };
  // what each bin holds now (loose stock included), as SKUs and SKU|batch keys
  const holds = (bin) => {
    const skus = new Set(), keys = new Set();
    for (const x of m.occupied.get(bin) || []) { skus.add(x.skuCode); keys.add(`${x.skuCode}|${upper(x.batch)}`); }
    return { skus, keys };
  };
  const groups = new Map();
  for (const [code, list] of palletsOf) {
    const b = m.binByCode.get(code);
    if (!b || b.cap < 2 || list.length >= b.cap || busy.has(code)) continue;
    const k = `${b.zone}|${b.binType}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push({ b, pallets: list, n: list.length, ...holds(code) });
  }
  const fits = (t, p) => {
    if (t.n + 1 > t.b.cap) return false;
    const skus = new Set([...t.skus, ...p.skus]), keys = new Set([...t.keys, ...p.keys]);
    if (t.b.multiSku === false && skus.size > 1) return false;
    if (t.b.multiBatch === false && [...skus].some((sku) => [...keys].filter((k) => k.startsWith(sku + "|")).length > 1)) return false;
    if (t.b.maxSku && skus.size > t.b.maxSku) return false;
    if (t.b.maxSkuBatch && keys.size > t.b.maxSkuBatch) return false;
    return true;
  };
  const bins = [], moves = [];
  for (const list of groups.values()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.n - b.n || a.b.code.localeCompare(b.b.code));
    const emptied = new Set(), received = new Set();
    for (const src of list) {
      if (emptied.has(src.b.code) || received.has(src.b.code)) continue;
      if (src.pallets.some((p) => locked.has(p.hu) || p.leaving) || hasLoose(src.b.code)) continue;
      // try it on copies; keep only if every pallet finds a bin
      const sim = new Map(list.filter((t) => t !== src && !emptied.has(t.b.code)).map((t) => [t.b.code, { ...t, skus: new Set(t.skus), keys: new Set(t.keys) }]));
      const plan = [];
      for (const p of src.pallets) {
        // the bin with the least room left that still takes it, so bins fill up rather than spread
        const t = [...sim.values()].filter((x) => fits(x, p)).sort((a, b) => (a.b.cap - a.n) - (b.b.cap - b.n) || a.b.code.localeCompare(b.b.code))[0];
        if (!t) { plan.length = 0; break; }
        t.n++; p.skus.forEach((x) => t.skus.add(x)); p.keys.forEach((x) => t.keys.add(x));
        plan.push({ p, to: t.b.code });
      }
      if (plan.length !== src.pallets.length) continue;
      for (const t of sim.values()) { const real = list.find((x) => x.b.code === t.b.code); Object.assign(real, { n: t.n, skus: t.skus, keys: t.keys }); }
      emptied.add(src.b.code);
      plan.forEach(({ to }) => received.add(to));
      for (const { p, to } of plan) {
        p.moveTo = to;
        moves.push({ zone: src.b.zone, binType: src.b.binType, fromBin: src.b.code, hu: p.hu, toBin: to, stock: casesText(m, p) });
      }
      bins.push({ bin: src.b.code, zone: src.b.zone, area: src.b.area, binType: src.b.binType, cap: src.b.cap, pallets: plan.length, to: [...new Set(plan.map((x) => x.to))] });
    }
  }
  bins.sort((a, b) => String(a.zone).localeCompare(String(b.zone)) || a.bin.localeCompare(b.bin));
  return { bins, moves, stats: { bins: bins.length, pallets: moves.length } };
}



// ==== the stock plan ===========================================================================
// input (chain.js mergeInputOf builds it from relocateInput; tests build it by hand):
//   bins:  [{ code, zone, area, areaType, status, huType, binType, cap, maxKg, multiSku, multiBatch, maxSku, maxSkuBatch,
//             huMultiSku, huMultiBatch, fixed }]   cap = pallet positions (palletCapacity)
//   stock: Map binCode -> [{ hu, sku, batch, bucket, inclusion, iloc, price, uom, qty, locked }]   every quant not being picked
//   leaving: Map binCode -> lines   stock a pick task is taking out: not fill and never moved, but until it's gone it keeps its
//          pallet where it is, the bin's and pallet's mixing as they are, and counts in the WMS capacity check
//   busy: Set binCode, busyWhy: Map binCode -> text   bins a task holds that the stock lines don't show (stock arriving: PUT lock)
//   emptyHus: Map binCode -> [huCode]   pallet HUs with no stock: the WMS doesn't count them, the floor must clear them first
//   skus: Map code -> { L0inL2, L2inL3, L0wt }   allowed(bin, sku, uom, bucket) -> bool: the search table, for cross-zone moves
//   wmsUnit(binCode, sku, uom) -> one unit's share of the bin as the IM upload's capacity check counts it
// opts: from, to = "zone|binType" cells (empty = every inventory pallet bin); crossZone (default off: same zone only);
//   wholePallets (default on); checkWeight (default on); objective "positions" (default) | "bins"
//
// 1) merges: like partial pallets (same SKU, batch, bucket, price, owner, inclusion; one zone unless crossZone) need
//    ceil(total fill) pallets. Which ones stay is chosen for the whole warehouse at once: bins a group shares with
//    others only empty when every pallet in them goes. Exact search per group (every keeper set; groups are small) in
//    rounds, each group against the others as they stand, plus a joint move that empties a bin several groups share;
//    then fewest cases moved, then same-bin merges (Destination HU), then same zone. Pours are whole units, within
//    best fit, the WMS capacity check, max kg and mixing rules.
// 2) whole pallets: bins the merges left under-used are emptied into bins of the To scope with free positions (or an
//    empty smaller bin) when that frees positions (or bins) and costs none of the other.
// The IM upload counts a destination bin's stock before any of the wave's stock leaves it, so the planner does too:
// case moves (wave 1) see each bin's starting stock plus everything poured in; whole pallets (wave 2) see wave 1 done.
const EPS = 1e-9, WMS_MAX = 1 + 1e-6; // the IM upload lets a bin total 1e-6 over 100%
const SUSPECT_KG = 1_000_000; // a bin type max kg at or above this is a placeholder
const up = (s) => String(s ?? "").trim().toUpperCase();
const coll = new Intl.Collator(undefined, { numeric: true }).compare;
// loading reads only INCLUDED stock: POST-GIN / PRE-GRN never moves (no status at all = an older schema: included)
const included = (l) => !l.inclusion || up(l.inclusion) === "INCLUDED";
// like stock: the WMS quant (sku, batch, bucket, price) plus owner and inclusion
const likeKey = (l) => `${quantId(l)}|${l.iloc || ""}|${up(l.inclusion || "INCLUDED")}`;
const lineKey = (l) => `${likeKey(l)}|${l.uom}`;
// shelf stock sits on the bin's own HU (BIN_HU_<bin>): that's loose, not a pallet
const palletOf = (hu) => (hu && !String(hu).startsWith("BIN_HU_") ? hu : null);
// share of one full pallet (best fit = the SKU's L2inL3 cases) one unit takes; null = no best fit
function fillUnit(skus, sku, uom) {
  const s = skus.get(sku);
  if (uom === "L3") return 1;
  if (!s?.L2inL3) return null;
  if (uom === "L2") return 1 / s.L2inL3;
  return uom === "L0" && s.L0inL2 ? 1 / (s.L0inL2 * s.L2inL3) : null;
}
const cellsOf = (x) => (Array.isArray(x) ? x : x?.cells || []).map(up).filter(Boolean);
const flag = (v, d) => (v === undefined || v === null || v === "" ? d : !(v === false || v === 0 || v === "0" || up(v) === "FALSE"));
const planOpts = (opts = {}) => ({ from: { cells: cellsOf(opts.from) }, to: { cells: cellsOf(opts.to) }, crossZone: flag(opts.crossZone, false),
  wholePallets: flag(opts.wholePallets, true), checkWeight: flag(opts.checkWeight, true), objective: opts.objective === "bins" ? "bins" : "positions" });
// lexicographic: > 0 when a is better
const lex = (a, b) => { for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 1e-9) return a[i] - b[i]; return 0; };

// SKUs, SKU|batch keys, quants and owners of some lines (what mixOk and huOk read)
function setsOf(lines) {
  const s = { skus: new Set(), keys: new Set(), quants: new Set(), ilocs: new Set() };
  for (const l of lines) { s.skus.add(l.sku); s.keys.add(`${l.sku}|${l.batch}`); s.quants.add(quantId(l)); s.ilocs.add(l.iloc || ""); }
  return s;
}
const binLines = (t) => [...t.loose, ...t.gone, ...[...t.pallets.values()].flatMap((p) => [...p.lines.values(), ...p.gone])];
const refresh = (t) => Object.assign(t, setsOf(binLines(t)));
// positions taken: each pallet (one holding only stock being picked too), loose stock as one, and empty pallet HUs
const posUsed = (t) => t.pallets.size + (t.loose.length || t.gone.length ? 1 : 0) + t.emptyHus.length;
// what one pallet may mix: the bin type's huMultiSku / huMultiBatch (both off = one quant per pallet)
function huOk(b, ps, l) {
  const ms = b.huMultiSku !== false, mb = b.huMultiBatch !== false, k = `${l.sku}|${l.batch}`;
  if (!ms && !mb) return [...ps.quants].every((q) => q === quantId(l));
  if (!ms && [...ps.skus].some((s) => s !== l.sku)) return false;
  return !(!mb && [...ps.keys].some((x) => x.startsWith(l.sku + "|") && x !== k));
}
// a bin already breaking its own rules (bad data, rules changed later) can give but takes nothing
function broken(t) {
  const ms = t.b.multiSku !== false, mb = t.b.multiBatch !== false;
  if (!ms && !mb && t.quants.size > 1) return true;
  if (!ms && t.skus.size > 1) return true;
  if (!mb && [...t.skus].some((sku) => [...t.keys].filter((k) => k.startsWith(sku + "|")).length > 1)) return true;
  if ((t.b.maxSku && t.skus.size > t.b.maxSku) || (t.b.maxSkuBatch && t.keys.size > t.b.maxSkuBatch) || t.ilocs.size > 1) return true;
  return t.capKg !== null && t.kg > t.capKg + EPS;
}

// every storage pallet bin with its pallets, as the plan starts
function loadBins(input, o) {
  const { bins, stock, leaving = new Map(), skus, wmsUnit, busy = new Set(), busyWhy = new Map(), emptyHus = new Map() } = input;
  // storage only: INVENTORY areas, or every non-working area if the node has none
  const hasInv = bins.some((b) => b.huType === "PALLET" && b.areaType === "INVENTORY");
  const storage = (b) => b.huType === "PALLET" && b.status === "ACTIVE" && (hasInv ? b.areaType === "INVENTORY" : !EXEMPT_AREAS.has(b.areaType));
  const scope = (cells) => { const c = new Set(cells); return (b) => !c.size || c.has(`${up(b.zone)}|${up(b.binType)}`); };
  const inFrom = scope(o.from.cells), inTo = scope(o.to.cells);
  const S = new Map(), all = [];
  for (const b of bins) {
    if (!storage(b)) continue;
    const t = { b, code: b.code, zone: b.zone || "", area: b.area || "", cap: Math.max(1, Number(b.cap) || 1), pallets: new Map(), loose: [], gone: [],
      emptyHus: [...(emptyHus.get(b.code) || [])], kg: 0, kgIn1: 0, w0: 0, wIn1: 0, wOut1: 0, wIn2: 0, locked: busy.has(b.code), why: busyWhy.get(b.code) || null,
      fixed: !!b.fixed, inFrom: inFrom(b), inTo: inTo(b), capKg: o.checkWeight && b.maxKg > 0 && b.maxKg < SUSPECT_KG ? b.maxKg : null };
    const take = (l0, isGone) => {
      if (!(l0.qty > 0)) return;
      const l = { sku: l0.sku, batch: up(l0.batch), bucket: up(l0.bucket), inclusion: up(l0.inclusion), iloc: l0.iloc || "", price: l0.price ?? "", uom: l0.uom, qty: l0.qty };
      t.kg += unitKg(skus, l.sku, l.uom) * l.qty; // stock being picked is still there until it's picked
      if (wmsUnit) t.w0 += (wmsUnit(b.code, l.sku, l.uom) || 0) * l.qty;
      if (l0.locked) { t.locked = true; t.why = t.why || "locked stock"; }
      const hu = palletOf(l0.hu);
      if (!hu) { (isGone ? t.gone : t.loose).push(l); return; }
      if (!t.pallets.has(hu)) { const p = { hu, t, bin0: b.code, lines: new Map(), gone: [], locked: false, excluded: false }; t.pallets.set(hu, p); all.push(p); }
      const p = t.pallets.get(hu);
      if (l0.locked) p.locked = true;
      if (isGone) { p.gone.push(l); return; }
      if (!included(l)) p.excluded = true;
      const k = lineKey(l), cur = p.lines.get(k);
      if (cur) cur.qty += l.qty; else p.lines.set(k, l);
    };
    for (const l of stock.get(b.code) || []) take(l, false);
    for (const l of leaving.get(b.code) || []) take(l, true);
    t.had = t.pallets.size > 0 || t.loose.length > 0 || t.gone.length > 0;
    t.palletsBefore = t.pallets.size; t.posBefore = posUsed(t);
    refresh(t); t.broken = broken(t);
    S.set(b.code, t);
  }
  return { S, all };
}

// each pallet's fill and state; candidates: partial, free to give or take, and in the From or To scope
function classify(all, skus) {
  const st = { pallets: all.length, full: 0, over: 0, partial: 0, mixed: 0, unsized: 0, locked: 0, busy: 0, picking: 0, excluded: 0, fixed: 0, outOfScope: 0 };
  for (const p of all) {
    const t = p.t, ls = [...p.lines.values()], fs = ls.map((l) => fillUnit(skus, l.sku, l.uom));
    p.lines0 = ls.map((l) => ({ ...l }));
    p.fill = fs.some((x) => x === null) ? null : ls.reduce((s, l, i) => s + fs[i] * l.qty, 0);
    p.leaving = p.gone.length > 0;
    const likes = new Set([...ls, ...p.gone].map(likeKey));
    const [state, k] = p.locked ? ["Locked by a task", "locked"] : t.locked ? [`Bin is busy (${t.why || "locked stock or stock arriving"})`, "busy"]
      : t.fixed ? ["Fixed bin", "fixed"] : p.excluded ? ["Stock not INCLUDED (POST-GIN / PRE-GRN)", "excluded"]
      : p.leaving && !ls.length ? ["All of it being picked", "picking"] : p.fill === null ? ["No best fit", "unsized"]
      : likes.size > 1 ? ["Mixed", "mixed"] : p.fill > 1 + 1e-6 ? ["Over best fit", "over"] : p.fill >= 1 - 1e-6 ? ["Full", "full"] : ["Partial", "partial"];
    p.state = state; st[k]++;
    p.cand = k === "partial" && !p.leaving && (t.inFrom || t.inTo);
    if (k === "partial" && p.leaving) p.state = "Partial, stock being picked";
    else if (k === "partial" && !p.cand) { p.state = "Partial, outside the scope"; st.outOfScope++; }
  }
  return st;
}

// pour one pallet's lines onto keepers, whole units within best fit, the WMS capacity check (wave 1: the bin's starting
// stock plus all poured in), max kg, zone and mixing rules. ctx = what this plan adds on top of the live state.
// Returns [{ l, k, n }], or null when some of it finds no room (then none of it moves).
const newCtx = () => ({ fill: new Map(), w: new Map(), kg: new Map() });
function pourDrop(d, keepers, ctx, env) {
  const { skus, wmsUnit, zoneOk, strict } = env, out = [];
  const lines = [...d.lines.values()].sort((a, b) => fillUnit(skus, b.sku, b.uom) - fillUnit(skus, a.sku, a.uom) || coll(a.uom, b.uom));
  for (const l of lines) {
    const sh = fillUnit(skus, l.sku, l.uom), uk = unitKg(skus, l.sku, l.uom);
    let left = l.qty;
    const room = (k) => {
      const t = k.t;
      if (!k.canTake || !zoneOk(d.t, t, l)) return 0;
      let n = Math.floor((1 - k.fill - (ctx.fill.get(k) || 0)) / sh + 1e-6);
      const wu = wmsUnit ? wmsUnit(t.code, l.sku, l.uom) || 0 : 0;
      if (wu > 0) n = Math.min(n, Math.floor((WMS_MAX - t.w0 - t.wIn1 - (ctx.w.get(t) || 0)) / wu + EPS));
      if (t.capKg !== null && uk > 0) n = Math.min(n, Math.floor((t.capKg - t.kg - t.kgIn1 - (ctx.kg.get(t) || 0)) / uk + EPS));
      // like stock, so the rules hold by construction; the live pass checks them anyway
      if (n > 0 && strict && !(mixOk(t, l) && huOk(t.b, setsOf(k.lines.values()), l))) return 0;
      return Math.max(0, n);
    };
    while (left > 0) {
      // same bin first (Destination HU), same zone, one that takes the rest (tightest), else the roomiest
      let best = null, bn = 0, br = null;
      for (const k of keepers) {
        const n = room(k);
        if (n <= 0) continue;
        const r = [k.t === d.t ? 1 : 0, k.t.zone === d.t.zone ? 1 : 0, n >= left ? 1 : 0, n >= left ? -n : n];
        if (!best || lex(r, br) > 0 || (!lex(r, br) && (coll(k.t.code, best.t.code) || coll(k.hu, best.hu)) < 0)) { best = k; bn = n; br = r; }
      }
      if (!best) return null;
      const n = Math.min(left, bn), wu = wmsUnit ? wmsUnit(best.t.code, l.sku, l.uom) || 0 : 0;
      ctx.fill.set(best, (ctx.fill.get(best) || 0) + n * sh);
      ctx.w.set(best.t, (ctx.w.get(best.t) || 0) + n * wu);
      ctx.kg.set(best.t, (ctx.kg.get(best.t) || 0) + n * uk);
      out.push({ l, k: best, n });
      left -= n;
    }
  }
  return out;
}

// like partial pallets: one group per SKU + batch + bucket + price + owner + inclusion (+ zone unless crossZone)
function groupsOf(all, skus, o) {
  const G = new Map();
  for (const p of all) {
    if (!p.cand) continue;
    const l = p.lines.values().next().value, k = likeKey(l) + (o.crossZone ? "" : `|${p.t.zone}`);
    if (!G.has(k)) G.set(k, { key: k, sku: l.sku, batch: l.batch, bucket: l.bucket, iloc: l.iloc, zone: o.crossZone ? null : p.t.zone, bf: skus.get(l.sku)?.L2inL3 || null, pallets: [] });
    G.get(k).pallets.push(p);
  }
  const out = [];
  for (const g of G.values()) {
    const ps = g.pallets.sort((a, b) => b.fill - a.fill || coll(a.t.code, b.t.code) || coll(a.hu, b.hu));
    g.total = ps.reduce((s, p) => s + p.fill, 0);
    g.need = Math.max(1, Math.ceil(g.total - 1e-6));
    // a pallet outside From can't go; outside To (or in a bin breaking its rules) it stays but takes nothing
    ps.forEach((p) => { p.mustKeep = !p.t.inFrom; p.canTake = p.t.inTo && !p.t.broken; });
    g.bins = [...new Set(ps.map((p) => p.t))];
    g.cache = new Map(); g.keep = null; g.curIn = new Map(); g.parts = null;
    if (ps.length >= 2 && Math.max(g.need, ps.filter((p) => p.mustKeep).length) < ps.length) out.push(g);
  }
  return out;
}

const nCk = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); };
function combos(items, k) {
  const out = [], cur = [];
  const rec = (i) => { if (cur.length === k) { out.push(cur.slice()); return; } for (let j = i; j <= items.length - (k - cur.length); j++) { cur.push(items[j]); rec(j + 1); cur.pop(); } };
  rec(0);
  return out;
}

// which pallets of each group stay (keepers) and which are poured into them (drops)
function chooseKeepers(groups, S, o, env) {
  const t0 = Date.now(), LIMIT = 1500;
  const B = new Map(); // bin -> { cand: group pallets in it, drop: of them dropped, anchored: something else keeps it occupied }
  for (const t of S.values()) B.set(t, { cand: 0, drop: 0, anchored: t.loose.length > 0 || t.gone.length > 0 });
  const inGroup = new Set(groups.flatMap((g) => g.pallets));
  for (const t of S.values()) for (const p of t.pallets.values()) if (inGroup.has(p)) B.get(t).cand++; else B.get(t).anchored = true;
  const tuple = (E, PG, C, SB, SZ) => (o.objective === "bins" ? [E, PG, -C, SB, SZ] : [PG, E, -C, SB, SZ]);
  // the group's own part of the score: pallets freed, cases moved, drops with a keeper in their bin / zone
  const partsOf = (g, keep) => {
    const x = { drops: 0, cases: 0, sb: 0, sz: 0, dIn: new Map() };
    g.pallets.forEach((p, i) => {
      if (keep[i]) return;
      x.drops++; x.cases += p.fill * (g.bf || 1); x.dIn.set(p.t, (x.dIn.get(p.t) || 0) + 1);
      if (g.pallets.some((k, j) => keep[j] && k.t === p.t)) x.sb++;
      if (g.pallets.some((k, j) => keep[j] && k.t.zone === p.t.zone)) x.sz++;
    });
    return x;
  };
  // scored over the bins it touches, every other group as it stands: a bin empties only when all its pallets go
  const evalGroup = (g, keep) => {
    const x = partsOf(g, keep);
    let E = 0, PG = x.drops;
    for (const t of g.bins) {
      const b = B.get(t), d = b.drop - (g.curIn.get(t) || 0) + (x.dIn.get(t) || 0);
      if (!b.anchored && d === b.cand) { E++; PG += t.cap - b.cand; }
    }
    return tuple(E, PG, x.cases, x.sb, x.sz);
  };
  const total = () => {
    let E = 0, PG = 0, C = 0, SB = 0, SZ = 0;
    for (const g of groups) if (g.parts) { PG += g.parts.drops; C += g.parts.cases; SB += g.parts.sb; SZ += g.parts.sz; }
    for (const [t, b] of B) if (!b.anchored && b.cand && b.drop === b.cand) { E++; PG += t.cap - b.cand; }
    return tuple(E, PG, C, SB, SZ);
  };
  const apply = (g, keep) => {
    for (const [t, n] of g.curIn) B.get(t).drop -= n;
    g.keep = keep; g.parts = keep ? partsOf(g, keep) : null; g.curIn = keep ? g.parts.dIn : new Map();
    for (const [t, n] of g.curIn) B.get(t).drop += n;
  };
  // can the keepers take every drop, in whole units? (static: the bins as they are, other groups aside)
  const feasible = (g, keep) => {
    const key = keep.join("");
    if (g.cache.has(key)) return g.cache.get(key);
    const ctx = newCtx(), keepers = g.pallets.filter((p, i) => keep[i]);
    const ok = g.pallets.filter((p, i) => !keep[i]).every((d) => pourDrop(d, keepers, ctx, env) !== null);
    g.cache.set(key, ok);
    return ok;
  };
  // the best feasible keeper set: every set when there are few, else a swap search from a greedy start.
  // forced: pallets that must go (to empty a bin several groups share)
  const bestFor = (g, forced) => {
    const n = g.pallets.length, must = [], free = [];
    g.pallets.forEach((p, i) => { if (p.mustKeep) must.push(i); else if (!forced?.has(p)) free.push(i); });
    if (forced && g.pallets.some((p) => p.mustKeep && forced.has(p))) return null;
    const mk = (idx) => { const keep = new Array(n).fill(0); for (const i of must) keep[i] = 1; for (const i of idx) keep[i] = 1; return keep; };
    for (let K = Math.max(g.need, must.length); K < n; K++) {
      const kf = K - must.length;
      if (kf > free.length) break;
      if (nCk(free.length, kf) <= LIMIT) {
        const list = combos(free, kf).map((c) => { const keep = mk(c); return { keep, s: evalGroup(g, keep) }; }).sort((a, b) => lex(b.s, a.s));
        const hit = list.find((x) => feasible(g, x.keep));
        if (hit) return hit.keep;
        continue;
      }
      // many pallets: keep the fullest in bins that stay occupied anyway, then swap while it gets better
      const pref = free.slice().sort((a, b) => B.get(g.pallets[b].t).anchored - B.get(g.pallets[a].t).anchored || g.pallets[b].fill - g.pallets[a].fill);
      let keep = mk(pref.slice(0, kf));
      if (!feasible(g, keep)) continue;
      for (let it = 0, better = true; better && it < 50; it++) {
        better = false;
        const s0 = evalGroup(g, keep);
        for (const i of free) for (const j of free) {
          if (!keep[i] || keep[j]) continue;
          const k2 = keep.slice(); k2[i] = 0; k2[j] = 1;
          if (lex(evalGroup(g, k2), s0) > 0 && feasible(g, k2)) { keep = k2; better = true; break; }
        }
      }
      return keep;
    }
    return null;
  };
  for (const g of groups) apply(g, bestFor(g));
  for (let pass = 0; pass < 8 && Date.now() - t0 < 2000; pass++) {
    let changed = false;
    for (const g of groups) {
      if (!g.keep) continue;
      const k = bestFor(g);
      if (k && lex(evalGroup(g, k), evalGroup(g, g.keep)) > 0) { apply(g, k); changed = true; }
    }
    // a bin that holds pallets of several groups: empty it when every group can let its pallets there go and it pays overall
    for (const [t, b] of B) {
      if (b.anchored || !b.cand || b.drop === b.cand) continue;
      const gs = groups.filter((g) => g.keep && g.bins.includes(t));
      if (gs.length < 2 || gs.reduce((s, g) => s + g.pallets.filter((p) => p.t === t).length, 0) !== b.cand) continue;
      const before = total(), saved = gs.map((g) => g.keep);
      let ok = true;
      for (const g of gs) { const k = bestFor(g, new Set(g.pallets.filter((p) => p.t === t))); if (!k) { ok = false; break; } apply(g, k); }
      if (ok && lex(total(), before) > 0) changed = true;
      else gs.forEach((g, i) => apply(g, saved[i]));
    }
    if (!changed) break;
  }
  return { binInfo: B };
}

// whole pallets out of bins the merges left under-used, into bins with free positions (wave 2: the case moves are done)
function packWhole(S, o, env) {
  const { skus, wmsUnit, zoneOk } = env, moves = [], bins = [];
  const plKg = (p) => [...p.lines.values()].reduce((s, l) => s + unitKg(skus, l.sku, l.uom) * l.qty, 0);
  const plW = (t, p) => (wmsUnit ? [...p.lines.values()].reduce((s, l) => s + (wmsUnit(t.code, l.sku, l.uom) || 0) * l.qty, 0) : 0);
  const fillOf = (t) => [...t.pallets.values()].reduce((s, p) => s + (p.fill || 0), 0);
  const srcOk = (t) => t.inFrom && !t.locked && !t.fixed && t.pallets.size > 0 && !t.loose.length && !t.gone.length
    && [...t.pallets.values()].every((p) => !p.locked && !p.leaving && !p.excluded && p.lines.size > 0);
  const pool = [...S.values()].filter((t) => t.inTo && !t.locked && !t.fixed && !t.broken && !t.emptied1);
  const order = o.objective === "bins" ? (a, b) => a.pallets.size - b.pallets.size || b.cap - a.cap
    : (a, b) => b.cap / b.pallets.size - a.cap / a.pallets.size || a.pallets.size - b.pallets.size;
  const sources = [...S.values()].filter(srcOk).sort((a, b) => order(a, b) || fillOf(a) - fillOf(b) || coll(a.code, b.code));
  const gone = new Set(), took = new Set();
  for (const src of sources) {
    if (took.has(src)) continue;
    const sim = new Map(); // target -> what this source adds: { n, w, kg, sets, wasEmpty }
    const isEmpty = (t) => !t.had && !took.has(t) && !sim.has(t);
    const plan = [];
    for (const p of [...src.pallets.values()].sort((a, b) => (b.fill || 0) - (a.fill || 0) || coll(a.hu, b.hu))) {
      const lines = [...p.lines.values()], kg = plKg(p);
      const fits = (t) => {
        if (t === src || gone.has(t)) return false;
        const v = sim.get(t) || { n: 0, w: 0, kg: 0 };
        if (isEmpty(t) && !(t.cap < src.cap)) return false; // an empty bin only pays when it's smaller
        if (posUsed(t) + v.n + 1 > t.cap) return false;
        if (t.capKg !== null && t.kg + v.kg + kg > t.capKg + EPS) return false;
        if (wmsUnit && t.w0 + t.wIn1 - t.wOut1 + t.wIn2 + v.w + plW(t, p) > WMS_MAX) return false;
        if (!lines.every((l) => zoneOk(src, t, l))) return false;
        // the pallet as it is must meet this bin type's pallet rules, and the bin its own
        const hp = setsOf([]), x = { b: t.b, ...setsOf([]) };
        for (const s of ["skus", "keys", "quants", "ilocs"]) x[s] = new Set(v.sets ? v.sets[s] : t[s]);
        for (const l of lines) {
          if (!huOk(t.b, hp, l) || !mixOk(x, l)) return false;
          for (const [s, val] of [["skus", l.sku], ["keys", `${l.sku}|${l.batch}`], ["quants", quantId(l)], ["ilocs", l.iloc || ""]]) { hp[s].add(val); x[s].add(val); }
        }
        return true;
      };
      const shares = (t) => lines.some((l) => t.skus.has(l.sku));
      let best = null, br = null;
      for (const t of pool) {
        if (!fits(t)) continue;
        const v = sim.get(t) || { n: 0 };
        const r = [isEmpty(t) ? 0 : 1, shares(t) ? 1 : 0, -(t.cap - posUsed(t) - v.n - 1), t.zone === src.zone ? 1 : 0, isEmpty(t) ? -t.cap : 0];
        if (!best || lex(r, br) > 0 || (!lex(r, br) && coll(t.code, best.code) < 0)) { best = t; br = r; }
      }
      if (!best) { plan.length = 0; break; }
      const v = sim.get(best) || { n: 0, w: 0, kg: 0, sets: setsOf(binLines(best)), wasEmpty: isEmpty(best) };
      v.n++; v.w += plW(best, p); v.kg += kg;
      for (const l of lines) { v.sets.skus.add(l.sku); v.sets.keys.add(`${l.sku}|${l.batch}`); v.sets.quants.add(quantId(l)); v.sets.ilocs.add(l.iloc || ""); }
      sim.set(best, v);
      plan.push({ p, t: best });
    }
    if (!plan.length) continue;
    const empties = [...sim].filter(([, v]) => v.wasEmpty).map(([t]) => t);
    const gPos = src.cap - empties.reduce((s, t) => s + t.cap, 0), gBins = 1 - empties.length;
    const [g1, g2] = o.objective === "bins" ? [gBins, gPos] : [gPos, gBins];
    if (!(g1 > 0 && g2 >= 0)) continue;
    for (const { p, t } of plan) {
      const w = plW(t, p), kg = plKg(p);
      src.pallets.delete(p.hu); t.pallets.set(p.hu, p);
      t.wIn2 += w; t.kg += kg; src.kg -= kg;
      p.moveTo = t.code; p.t = t; took.add(t); if (sim.get(t).wasEmpty) t.wasEmptyUsed = true;
      moves.push({ kind: "pallet", zone: src.zone, binType: src.b.binType, fromBin: src.code, hu: p.hu, toBin: t.code, stock: casesText(null, { lines: [...p.lines.values()] }),
        lines: [...p.lines.values()].map((l) => ({ sku: l.sku, batch: l.batch, bucket: l.bucket, iloc: l.iloc, inclusion: l.inclusion, price: l.price, uom: l.uom, qty: l.qty })),
        fromZone: src.zone, toZone: t.zone, fromArea: src.area, toArea: t.area, fromBinType: src.b.binType, toBinType: t.b.binType,
        crossZone: src.zone !== t.zone, toWasEmpty: !!sim.get(t).wasEmpty, received: !!p.received });
    }
    for (const t of sim.keys()) refresh(t);
    refresh(src); src.emptied2 = true; gone.add(src);
    bins.push({ bin: src.code, zone: src.zone, area: src.area, binType: src.b.binType, cap: src.cap, pallets: plan.length, to: [...new Set(plan.map((x) => x.t.code))] });
  }
  bins.sort((a, b) => coll(String(a.zone), String(b.zone)) || coll(a.bin, b.bin));
  return { bins, moves, stats: { bins: bins.length, pallets: moves.length } };
}

function palletPlan(input, opts = {}) {
  const o = planOpts(opts), { skus, wmsUnit, allowed } = input;
  // same zone unless asked; then only where the search table lets this class, unit and bucket in
  const zoneOk = (from, to, l) => from.zone === to.zone || (o.crossZone && (!allowed || allowed(to.b, l.sku, l.uom, l.bucket)));
  const env = { skus, wmsUnit, zoneOk, strict: false };
  const { S, all } = loadBins(input, o);
  const st = classify(all, skus);
  const groups = groupsOf(all, skus, o);
  chooseKeepers(groups, S, o, env);

  // 1) the merges, for real, on the live state: drops that empty a bin first, biggest first
  const live = { ...env, strict: true }, moves = [], merges = [];
  let noRoom = 0;
  const binDrops = new Map();
  for (const g of groups) if (g.keep) g.pallets.forEach((p, i) => { if (!g.keep[i]) binDrops.set(p.t, (binDrops.get(p.t) || 0) + 1); });
  const empties = (t) => !t.loose.length && !t.gone.length && binDrops.get(t) === t.pallets.size;
  for (const g of groups) {
    if (!g.keep) continue;
    const keepers = g.pallets.filter((p, i) => g.keep[i]), drops = g.pallets.filter((p, i) => !g.keep[i])
      .sort((a, b) => empties(b.t) - empties(a.t) || b.fill - a.fill);
    let done = 0;
    for (const d of drops) {
      const ctx = newCtx(), pours = pourDrop(d, keepers, ctx, live);
      if (!pours) { d.state = "Partial, no room on the pallets kept"; noRoom++; continue; }
      for (const { l, k, n } of pours) {
        const sh = fillUnit(skus, l.sku, l.uom), uk = unitKg(skus, l.sku, l.uom);
        const wuT = wmsUnit ? wmsUnit(k.t.code, l.sku, l.uom) || 0 : 0, wuS = wmsUnit ? wmsUnit(d.t.code, l.sku, l.uom) || 0 : 0;
        const kl = { ...l, qty: n }, key = lineKey(kl), cur = k.lines.get(key);
        if (cur) cur.qty += n; else k.lines.set(key, kl);
        k.fill += n * sh; k.received = true;
        k.t.wIn1 += wuT * n; k.t.kgIn1 += uk * n; d.t.wOut1 += wuS * n; d.t.kg -= uk * n;
        moves.push({ kind: "merge", sku: l.sku, batch: l.batch, bucket: l.bucket, inclusion: l.inclusion, iloc: l.iloc, price: l.price, uom: l.uom, qty: n,
          fromBin: d.t.code, fromHu: d.hu, toBin: k.t.code, toHu: k.hu, sameBin: d.t === k.t, cases: g.bf ? n * sh * g.bf : null, share: n * sh,
          fromZone: d.t.zone, toZone: k.t.zone, fromArea: d.t.area, toArea: k.t.area, fromBinType: d.t.b.binType, toBinType: k.t.b.binType,
          crossZone: d.t.zone !== k.t.zone, toPalletAfter: k.fill });
      }
      d.t.pallets.delete(d.hu); d.lines = new Map(); d.dropped = true; d.sameBinOnly = pours.every((x) => x.k.t === d.t); done++;
    }
    for (const k of keepers) if (k.received) k.keepFor = true;
    if (!done) continue;
    const dropped = g.pallets.filter((p) => p.dropped), bins = new Set(g.pallets.map((p) => p.t.code));
    merges.push({ sku: g.sku, batch: g.batch, bucket: g.bucket, iloc: g.iloc, zone: g.zone, bestFit: g.bf, pallets: g.pallets.length, cases: g.bf ? g.total * g.bf : null,
      fill: g.total, need: g.pallets.length - done, frees: done, bins: bins.size, oneBin: bins.size === 1, sameBin: dropped.filter((p) => p.sameBinOnly).length,
      list: g.pallets.map((p) => `${p.hu}@${p.bin0} ${pct(p.fill)}${p.dropped ? " → poured" : p.keepFor ? " ← keeps" : ""}`) });
  }
  // the kg poured in is now there; outflows are done too (wave 2 sees the stock as wave 1 left it)
  for (const t of S.values()) { t.kg += t.kgIn1; t.kgIn1 = 0; refresh(t); t.broken = broken(t); t.emptied1 = t.had && !t.pallets.size && !t.loose.length && !t.gone.length; }
  const emptiedBins = [...S.values()].filter((t) => t.emptied1).map((t) => t.code);

  // 2) whole pallets
  const pack = o.wholePallets ? packWhole(S, o, env) : { bins: [], moves: [], stats: { bins: 0, pallets: 0 } };

  // what the plan frees: bins emptied (gross), empty bins used, positions (net), as the brief defines them. A bin that
  // stays occupied counts its change both ways: a pallet merged away frees a position, a whole pallet moved in takes one
  const emptied = [...S.values()].filter((t) => t.had && !t.pallets.size && !t.loose.length && !t.gone.length);
  const usedEmpty = [...S.values()].filter((t) => t.wasEmptyUsed);
  const kept = [...S.values()].filter((t) => t.had && !emptied.includes(t));
  const keptDelta = (t) => Math.min(t.cap, t.palletsBefore) - Math.min(t.cap, t.pallets.size);
  const positionsFreed = emptied.reduce((s, t) => s + t.cap, 0) - usedEmpty.reduce((s, t) => s + t.cap, 0) + kept.reduce((s, t) => s + keptDelta(t), 0);
  const allMoves = [...moves, ...pack.moves];
  allMoves.forEach((m, i) => { m.step = i + 1; });
  const unitsOf = (m) => (m.kind === "pallet" ? m.lines.reduce((s, l) => s + l.qty, 0) : m.qty);

  // per zone, before and after
  const zones = new Map();
  let positions = 0, used = 0, emptyBins = 0;
  for (const t of S.values()) {
    const z = zones.get(t.zone || "(no zone)") || { zone: t.zone || "(no zone)", area: t.area, bins: 0, positions: 0, usedBefore: 0, used: 0, partial: 0, frees: 0,
      binsEmptied: 0, emptyBinsUsed: 0, positionsFreed: 0 };
    zones.set(z.zone, z);
    const before = Math.min(t.palletsBefore, t.cap), after = Math.min(t.pallets.size, t.cap);
    z.bins++; z.positions += t.cap; z.usedBefore += before; z.used += after;
    positions += t.cap; used += before; if (!t.palletsBefore) emptyBins++;
    if (emptied.includes(t)) { z.binsEmptied++; z.positionsFreed += t.cap; }
    else if (t.had) z.positionsFreed += keptDelta(t);
    if (t.wasEmptyUsed) { z.emptyBinsUsed++; z.positionsFreed -= t.cap; }
  }
  for (const p of all) {
    const z = zones.get(S.get(p.bin0)?.zone || "(no zone)");
    if (!z) continue;
    if (p.state === "Partial") z.partial++;
    if (p.dropped) z.frees++;
  }

  // warnings: what the floor or the reader must know
  const warnings = [], warn = (level, code, text, bins) => warnings.push({ level, code, text, bins: [...new Set(bins)].sort(coll).slice(0, 200) });
  const usedBins = new Set(allMoves.flatMap((m) => [m.fromBin, m.toBin]));
  const withEmpty = [...usedBins].filter((c) => S.get(c)?.emptyHus.length);
  if (withEmpty.length) warn("warn", "empty-pallet-in-target", `${withEmpty.length} bin${withEmpty.length === 1 ? "" : "s"} the plan uses still hold an empty pallet HU (${withEmpty.slice(0, 5).map((c) => `${c}: ${S.get(c).emptyHus.join(", ")}`).join("; ")}${withEmpty.length > 5 ? "; ..." : ""}). The WMS doesn't count it; clear it on the floor.`, withEmpty);
  const busyBins = [...S.values()].filter((t) => t.locked);
  if (busyBins.length) warn("info", "put-lock", `${busyBins.length} bin${busyBins.length === 1 ? " is" : "s are"} busy (locked stock, or stock arriving with a PUT lock): nothing goes in or out.`, busyBins.map((t) => t.code));
  const unsized = all.filter((p) => p.state === "No best fit");
  if (unsized.length) warn("info", "no-best-fit", `${unsized.length} pallet${unsized.length === 1 ? " has" : "s have"} a SKU with no best fit (L2inL3); left as they are: ${[...new Set(unsized.flatMap((p) => p.lines0.map((l) => l.sku)))].slice(0, 10).join(", ")}.`, unsized.map((p) => p.bin0));
  const excl = all.filter((p) => p.excluded);
  if (excl.length) warn("info", "not-included", `${excl.length} pallet${excl.length === 1 ? " holds" : "s hold"} stock that isn't INCLUDED (POST-GIN / PRE-GRN); never moved.`, excl.map((p) => p.bin0));
  const cz = allMoves.filter((m) => m.crossZone);
  if (cz.length) warn("warn", "cross-zone", `${cz.length} move${cz.length === 1 ? " crosses" : "s cross"} zones (allowed by the search table).`, cz.flatMap((m) => [m.fromBin, m.toBin]));
  if (noRoom) warn("info", "no-room", `${noRoom} pallet${noRoom === 1 ? "" : "s"} planned to pour found no room once the other merges were in, so ${noRoom === 1 ? "it stays" : "they stay"} as ${noRoom === 1 ? "it is" : "they are"}.`, all.filter((p) => p.state.startsWith("Partial, no room")).map((p) => p.bin0));
  if (input.lockError) warn("warn", "lock-read-failed", `Couldn't read task locks (${input.lockError}), so locked stock may appear in the plan.`, []);
  if (input.busyError) warn("warn", "lock-read-failed", `Couldn't read PUT locks off the handling units (${input.busyError}); only the stock lines' locks are used.`, []);
  if (input.emptyHuError) warn("info", "empty-hu-read-failed", `Couldn't read empty pallet HUs (${input.emptyHuError}).`, []);

  const drops = all.filter((p) => p.dropped);
  return {
    isReset: false, opts: o,
    stats: { ...st, palletBins: S.size, positions, used, spare: positions - used, emptyBins, frees: drops.length, mergeGroups: merges.length,
      sameBinFrees: drops.filter((p) => p.sameBinOnly).length, mergeBinsEmptied: emptiedBins.length,
      binsEmptied: emptied.length, emptyBinsUsed: usedEmpty.length, netBinsFreed: emptied.length - usedEmpty.length, positionsFreed, palletsFreed: drops.length,
      moves: allMoves.length, caseMoves: moves.length, sameBinMoves: moves.filter((m) => m.sameBin).length, wholePallets: pack.moves.length,
      casesMoved: allMoves.reduce((s, m) => s + unitsOf(m), 0), crossZoneMoves: cz.length, heldBack: 0, noRoom },
    zones: [...zones.values()].map((z) => ({ ...z, spare: z.positions - z.used, spareBefore: z.positions - z.usedBefore }))
      .sort((a, b) => b.positionsFreed - a.positionsFreed || coll(a.zone, b.zone)),
    merges: merges.sort((a, b) => b.frees - a.frees || coll(a.sku, b.sku)), moves, pack, warnings, emptiedBins,
    bins: { emptied: emptied.map((t) => t.code).sort(coll), emptyUsed: usedEmpty.map((t) => t.code).sort(coll) },
    // for the workbook's Pallet fill sheet (casesText reads lines as a list)
    pallets: all.map((p) => ({ hu: p.hu, bin: p.bin0, source: "stock", lines: p.lines0, gone: p.gone, share: p.fill, state: p.state,
      mergeInto: !!p.dropped, keepFor: !!p.keepFor, moveTo: p.moveTo || null })),
  };
}

module.exports = { consolidation, packBins, shelfSpread, palletPlan, planOpts };
