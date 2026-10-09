// Empty bins under a % full: move their stock into other bins of the zones and bin types you choose,
// for every inventory area: pallet bins (stock on pallets, counted in pallet positions) and shelf bins
// (counted by volume). Pallet stock only goes to pallet bins, shelf stock only to shelf bins.
//
// Pure: takes plain data, returns a plan. lib/inventory.js builds the input from the DB.
//
// input:
//   bins:  [{ code, zone, zoneId, area, areaType, status, huType, binType, cap, volCC, maxKg,
//             multiSku, multiBatch, maxSku, maxSkuBatch, huMultiSku, huMultiBatch, fixed }]
//          cap = pallet positions (bin type palletCapacity); huMulti* = what one pallet may mix (bin type)
//   stock: Map binCode -> [{ hu, sku, batch, bucket, price, inclusion, iloc, uom, qty, locked }]   hu null = loose; free stock only
//   leaving: optional Map binCode -> [{ hu, sku, batch, bucket, price, iloc, uom, qty }]   stock a pick task is taking out. It
//          doesn't count toward fill, but until it's gone it keeps its pallet's position and the bin's and pallet's mixing
//          rules, counts in the WMS capacity check, and its pallet can't move whole (the WMS won't move a locked HU)
//   skus:  Map code -> { volL0, volL2, volL3, L0wt, L0inL2, L2inL3 }   (cc, kg; L2inL3 = cases per full pallet)
//   allowed(bin, sku, uom, bucket) -> bool   the search table, for moves into another zone
//   wmsUnit(binCode, sku, uom) -> number     optional: one unit's share of the bin as the WMS counts it when
//          IM moves stock in (best fit, else positions x units per pallet, else volume). The WMS refuses an
//          IM that takes a bin's total over 100%, even when the pallet it lands on has room.
// opts:
//   from, to:   { areas, zones, binTypes, cells } codes (cells = "zone|bin type" pairs); empty = any inventory bin. A bin can be in both.
//   belowPct:   only empty bins under this % full (default 100 = any). Pallet bins: full pallets (the SKU's L3)
//               over pallet positions. Shelf bins: stock volume over bin volume.
//   useEmpty:   which empty bins may receive: "smaller" (default: only bins smaller than the one being emptied, fewer
//               pallet positions or less volume, so the move frees space), "any" (e.g. to clear a zone), "none"
//   checkWeight: keep targets within the bin type's max kg (default true)
//   fillPct:    fill shelf targets up to this % of their volume (default 100)
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
const shuffled = (name) => {
  const h = (code) => { let x = 2166136261; for (const ch of name + "|" + code) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0; return x; };
  return (a, b) => h(a.b.code) - h(b.b.code);
};
const clonePallet = (p) => ({ ...p, lines: new Map([...p.lines].map(([k, v]) => [k, { ...v }])), skus: new Set(p.skus), keys: new Set(p.keys), quants: new Set(p.quants) });
const cloneState = (t) => ({ ...t, skus: new Set(t.skus), keys: new Set(t.keys), quants: new Set(t.quants), ilocs: new Set(t.ilocs),
  lines: new Map([...t.lines].map(([k, v]) => [k, { ...v }])), pallets: new Map([...t.pallets].map(([k, p]) => [k, clonePallet(p)])) });

function binState(b, lines, skus, o, wu, gone) {
  const pallet = b.huType === "PALLET";
  const st = { b, pallet, lines: new Map(), pallets: new Map(), loose: 0, skus: new Set(), keys: new Set(), quants: new Set(), ilocs: new Set(),
    used: 0, share: 0, kg: 0, sized: true, locked: false, wu, wms: 0 };
  for (const l0 of lines || []) {
    if (!(l0.qty > 0)) continue;
    const l = { ...l0, batch: up(l0.batch), hu: palletOf(b, l0.hu) };
    const k = lk(l), cur = st.lines.get(k);
    if (cur) cur.qty += l.qty; else st.lines.set(k, { ...l });
    st.skus.add(l.sku); st.keys.add(`${l.sku}|${l.batch}`); st.quants.add(quantId(l)); st.ilocs.add(l.iloc || "");
    st.kg += unitKg(skus, l.sku, l.uom) * l.qty;
    if (wu) st.wms += wu(b.code, l.sku, l.uom) * l.qty;
    if (l.locked) st.locked = true;
    if (pallet) {
      const sh = unitShare(skus, l.sku, l.uom);
      if (sh === null) st.sized = false; else st.share += sh * l.qty;
      if (!l.hu) { st.loose += l.qty; continue; }
      if (!st.pallets.has(l.hu)) st.pallets.set(l.hu, { hu: l.hu, lines: new Map(), skus: new Set(), keys: new Set(), quants: new Set(), share: 0, kg: 0, locked: false });
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
    if (!st.pallets.has(l.hu)) st.pallets.set(l.hu, { hu: l.hu, lines: new Map(), skus: new Set(), keys: new Set(), quants: new Set(), share: 0, kg: 0, locked: false });
    const p = st.pallets.get(l.hu);
    p.skus.add(l.sku); p.keys.add(`${l.sku}|${l.batch}`); p.quants.add(quantId(l)); p.leaving = true;
  }
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

function planOnce({ bins, stock, skus, allowed, wmsUnit, leaving }, opts, order) {
  const o = { belowPct: 100, useEmpty: "smaller", checkWeight: true, fillPct: 100, ...opts };
  o.checkWeight = o.checkWeight !== false && o.checkWeight !== "0";
  o.useEmpty = o.useEmpty === false || o.useEmpty === "0" || o.useEmpty === "none" ? "none" : o.useEmpty === true || o.useEmpty === "1" || o.useEmpty === "any" ? "any" : "smaller";
  o.belowPct = Math.min(100, Math.max(0.01, Number(o.belowPct) || 100));
  o.fillPct = Math.min(100, Math.max(1, Number(o.fillPct) || 100));
  o.from = o.from || {}; o.to = o.to || {};
  const inFrom = scopeOf(o.from), inTo = scopeOf(o.to);
  const live = (b) => INVENTORY(b) && (b.huType === "PALLET" || b.huType === "BIN");

  const states = new Map();
  for (const b of bins) if (live(b) && (inFrom(b) || inTo(b))) states.set(b.code, binState(b, stock.get(b.code), skus, o, wmsUnit, leaving?.get(b.code)));
  const st = { fromBins: 0, fromStocked: 0, under: 0, toBins: 0, toEmpty: 0, toUsable: 0 };
  const sources = [], notEmptied = [];
  const stockText = (s) => [...s.lines.values()].map((l) => `${l.qty} ${l.uom} ${l.sku} ${l.batch}${l.hu ? ` (${l.hu})` : ""}`).join(" + ");
  const under = (s) => o.belowPct >= 100 || (s.occ !== null && s.occ < o.belowPct / 100 - EPS);
  for (const s of states.values()) {
    if (!inFrom(s.b)) continue;
    st.fromBins++;
    if (!s.lines.size) continue;
    st.fromStocked++;
    if (!under(s)) continue;
    st.under++;
    s.broken = brokenNow(s);
    const why = s.b.status !== "ACTIVE" ? `Bin is ${s.b.status}` : s.locked ? "Stock locked by a task" : s.b.fixed ? "Fixed bin (mapped to a SKU, EAN or product)"
      : !s.sized ? (s.pallet ? "A SKU in it has no pallet size (L2 or L3 units)" : "A SKU in it has no volume for its unit")
      : s.pallet && s.loose ? "Loose stock not on a pallet" : null;
    if (why) notEmptied.push({ bin: s.b.code, zone: s.b.zone, area: s.b.area, binType: s.b.binType, occPct: s.occ === null ? null : s.occ * 100, why, stock: stockText(s) });
    else sources.push(s);
  }
  // targets: in the To scope, active, unlocked, not fixed, sized, within their own rules
  const targetOk = (t) => inTo(t.b) && t.b.status === "ACTIVE" && !t.locked && !t.b.fixed && t.sized && !brokenNow(t)
    && (t.pallet || t.capCC !== null) && (o.useEmpty !== "none" || t.lines.size > 0);
  for (const t of states.values()) if (inTo(t.b)) { st.toBins++; if (!t.lines.size) st.toEmpty++; if (targetOk(t)) st.toUsable++; }

  const oc = (x) => x.occ ?? 0;
  const first = { occ: (a, b) => oc(a) - oc(b), size: (a, b) => a.lines.size - b.lines.size || oc(a) - oc(b), big: (a, b) => oc(b) - oc(a) }[order] || shuffled(order);
  sources.sort((a, b) => first(a, b) || coll(a.b.code, b.b.code));

  const received = new Set(), gone = new Set(), moves = [], emptied = [];
  const poolCodes = [...states.values()].filter(targetOk).map((t) => t.b.code); // receiving keeps a bin within its rules
  const zoneOk = (src, t, l) => t.b.zone === src.b.zone || !allowed || allowed(t.b, l.sku, l.uom, l.bucket);
  for (const src of sources) {
    if (received.has(src.b.code)) { continue; }
    // this source's working copies of the targets it pours into: copied on first write only
    const sim = new Map();
    const view = (t) => sim.get(t.b.code) || t;
    const simOf = (t) => { if (!sim.has(t.b.code)) sim.set(t.b.code, cloneState(t)); return sim.get(t.b.code); };
    // an empty bin only takes from a bigger one, unless any empty bin is allowed (an equal one frees nothing)
    const smaller = (t) => (t.pallet ? t.positions < src.positions : t.b.volCC < src.b.volCC);
    const pool = poolCodes.filter((c) => c !== src.b.code && !gone.has(c)).map((c) => states.get(c))
      .filter((t) => t.pallet === src.pallet && (t.lines.size > 0 || o.useEmpty === "any" || smaller(t)));
    const plan = [];
    let fail = null;
    const kgRoom = (t, uk) => (t.capKg === null || !(uk > 0) ? Infinity : Math.floor((t.capKg - t.kg) / uk + EPS));
    const base = (l, t) => ({ fromBin: src.b.code, fromZone: src.b.zone, fromBinType: src.b.binType, fromOccPct: (src.occ ?? 0) * 100, sku: l.sku, batch: l.batch, bucket: l.bucket, price: l.price,
      inclusion: l.inclusion, iloc: l.iloc, uom: l.uom, toBin: t.b.code, toZone: t.b.zone, toBinType: t.b.binType, toWasEmpty: t.lines.size === 0 });
    if (src.pallet) {
      // each pallet: merge it onto pallets of the same stock that have room; else move it whole into a free position
      const pals = [...src.pallets.values()].sort((a, b) => b.share - a.share || a.hu.localeCompare(b.hu));
      for (const p of pals) {
        // 1) merge every line onto pallets that take it (same rules as the bin and the pallet), fullest first
        const tries = [];
        let ok = true;
        const trial = new Map();
        const tv = (t) => trial.get(t.b.code) || view(t);
        const tw = (t) => { if (!trial.has(t.b.code)) trial.set(t.b.code, cloneState(view(t))); return trial.get(t.b.code); };
        for (const l of p.lines.values()) {
          const sh = unitShare(skus, l.sku, l.uom), uk = unitKg(skus, l.sku, l.uom);
          let left = l.qty;
          const cands = [];
          for (const t0 of pool) {
            const t = tv(t0);
            if (!t.lines.size || !mixOk(t, l) || !zoneOk(src, t, l)) continue;
            for (const tp of t.pallets.values()) if (!tp.locked && !palletBroken(t.b, tp) && huOk(t.b, tp, l)) cands.push({ t0, hu: tp.hu, share: tp.share, same: tp.quants.has(quantId(l)) });
          }
          // same stock first, then the fullest pallet
          cands.sort((a, b) => (b.same - a.same) || b.share - a.share || a.t0.b.code.localeCompare(b.t0.b.code) || a.hu.localeCompare(b.hu));
          for (const { t0, hu } of cands) {
            if (!left) break;
            const t = tw(t0), tp = t.pallets.get(hu);
            if (!mixOk(t, l) || !huOk(t.b, tp, l)) continue;
            const n = Math.min(left, Math.floor((1 - tp.share) / sh + EPS), kgRoom(t, uk), wmsRoom(t, l));
            if (n <= 0) continue;
            const before = tp.share;
            addLine(t, l, n, skus, tp);
            tries.push({ ...base(l, t), kind: "merge", hu: p.hu, toHu: tp.hu, qty: n, unitShare: sh, toPalletBefore: before, toPalletAfter: tp.share,
              toPositions: t.pallets.size, toCap: t.positions, toKgAfter: t.kg, toMaxKg: t.capKg });
            left -= n;
          }
          if (left) { ok = false; break; }
        }
        if (ok) { for (const [k, t] of trial) sim.set(k, t); plan.push(...tries); continue; }
        // a pallet a pick task is taking stock from is locked: the WMS won't move it whole
        if (p.leaving) { fail = `Pallet ${p.hu} has stock being picked, so it can't move whole, and no pallet takes all its other stock`; break; }
        // 2) the whole pallet into a free position: a bin already holding stock first, then an empty one
        const lines = [...p.lines.values()];
        const fits = (t) => {
          if (t.pallets.size + (t.loose || t.leavingLoose ? 1 : 0) + 1 > t.positions) return false;
          if (t.capKg !== null && t.kg + p.kg > t.capKg + EPS) return false;
          if (t.wu && t.wms + lines.reduce((s, l) => s + t.wu(t.b.code, l.sku, l.uom) * l.qty, 0) > 1 + 1e-6) return false;
          // the pallet as it is must meet this bin type's pallet rules too (another bin type may be stricter)
          const hp = { skus: new Set(), keys: new Set(), quants: new Set() };
          for (const l of lines) { if (!huOk(t.b, hp, l)) return false; hp.skus.add(l.sku); hp.keys.add(`${l.sku}|${up(l.batch)}`); hp.quants.add(quantId(l)); }
          const x = cloneState(t);
          for (const l of lines) { if (!mixOk(x, l) || !zoneOk(src, x, l)) return false; addLine(x, l, l.qty, skus); }
          return true;
        };
        const sameSku = (t) => lines.some((l) => t.skus.has(l.sku));
        const pick = best(pool.map(view).filter(fits), (a, b) => ((b.lines.size > 0) - (a.lines.size > 0)) || (sameSku(b) - sameSku(a))
          || (a.lines.size ? (a.positions - a.pallets.size) - (b.positions - b.pallets.size) : a.positions - b.positions)
          || ((b.b.zone === src.b.zone) - (a.b.zone === src.b.zone)) || coll(a.b.code, b.b.code));
        if (!pick) { fail = `No bin takes pallet ${p.hu} (${lines.map((l) => `${l.qty} ${l.uom} ${l.sku} ${l.batch}`).join(" + ")})`; break; }
        const cand = simOf(pick), wasEmpty = cand.lines.size === 0, posBefore = cand.pallets.size;
        const np = { hu: p.hu, lines: new Map(), skus: new Set(), keys: new Set(), quants: new Set(), share: 0, kg: 0, locked: false };
        cand.pallets.set(p.hu, np);
        for (const l of lines) addLine(cand, l, l.qty, skus, np);
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
            (a, b) => ((b.lines.size > 0) - (a.lines.size > 0)) || (b.keys.has(k) - a.keys.has(k)) || ((room(b) >= left) - (room(a) >= left))
              || ((a.capCC - a.used) - (b.capCC - b.used)) || ((b.b.zone === src.b.zone) - (a.b.zone === src.b.zone)) || coll(a.b.code, b.b.code));
          if (!c0) { fail = `No bin takes ${left} ${l.uom} of ${l.sku} ${l.batch}`; break; }
          const c = simOf(c0), n = Math.min(left, room(c)), before = c.used, wasEmpty = c.lines.size === 0;
          addLine(c, l, n, skus);
          plan.push({ ...base(l, c), toWasEmpty: wasEmpty, kind: "pour", hu: null, toHu: null, qty: n, unitVolCC: uv, moveVolCC: n * uv,
            toBinVolCC: c.b.volCC, toCapCC: c.capCC, toUsedBeforeCC: before, toUsedAfterCC: c.used, toKgAfter: c.kg, toMaxKg: c.capKg });
          left -= n;
        }
        if (fail) break;
      }
    }
    if (fail) { notEmptied.push({ bin: src.b.code, zone: src.b.zone, area: src.b.area, binType: src.b.binType, occPct: (src.occ ?? 0) * 100, why: fail, stock: stockText(src) }); continue; }
    const took = new Set(plan.map((p) => p.toBin));
    for (const [code, t] of sim) if (took.has(code)) { states.set(code, t); received.add(code); }
    gone.add(src.b.code);
    moves.push(...plan);
    emptied.push({ bin: src.b.code, afterPick: !!src.leaving, zone: src.b.zone, area: src.b.area, binType: src.b.binType, kind: src.pallet ? "pallet" : "shelf", occPct: (src.occ ?? 0) * 100,
      pallets: src.pallets.size, lines: src.lines.size, to: [...took] });
  }
  // sources skipped because they took stock in this plan
  for (const s of sources) if (!gone.has(s.b.code) && received.has(s.b.code) && !notEmptied.some((n) => n.bin === s.b.code))
    notEmptied.push({ bin: s.b.code, zone: s.b.zone, area: s.b.area, binType: s.b.binType, occPct: (s.occ ?? 0) * 100, why: "Receives stock in this plan", stock: stockText(s) });
  const byCode = (x, y) => String(x).localeCompare(String(y), undefined, { numeric: true });
  // in the order they were planned: a later move can merge onto a pallet an earlier one brought in
  moves.forEach((m, i) => { m.step = i + 1; });
  emptied.sort((x, y) => byCode(x.bin, y.bin));
  notEmptied.sort((x, y) => (x.occPct ?? 0) - (y.occPct ?? 0) || byCode(x.bin, y.bin));
  const emptyUsed = new Set(moves.filter((m) => m.toWasEmpty).map((m) => m.toBin));
  // pallet positions freed: those of the pallet bins emptied, less those of the empty pallet bins now used
  const posOf = (code) => { const b = bins.find((x) => x.code === code); return b && b.huType === "PALLET" ? Math.max(1, Number(b.cap) || 1) : 0; };
  const positionsFreed = emptied.reduce((t, e) => t + posOf(e.bin), 0) - [...emptyUsed].reduce((t, c) => t + posOf(c), 0);
  return {
    opts: o,
    stats: { ...st, candidates: sources.length, binsEmptied: emptied.length, moves: moves.length, unitsMoved: moves.reduce((t, m) => t + m.qty, 0),
      palletsMovedWhole: new Set(moves.filter((m) => m.kind === "pallet").map((m) => m.hu)).size, palletsMerged: new Set(moves.filter((m) => m.kind === "merge").map((m) => m.hu)).size,
      emptyBinsUsed: emptyUsed.size, netFreed: emptied.length - emptyUsed.size, positionsFreed, targetBins: new Set(moves.map((m) => m.toBin)).size },
    emptied, moves, notEmptied,
  };
}

// greedy by source order; try a few and keep the most bins emptied, then fewest empty bins used, then fewest moves
function relocatePlan(input, opts = {}) {
  let best = null;
  for (const order of ["occ", "size", "big", "r1", "r2", "r3"]) {
    const p = planOnce(input, opts, order), a = p.stats, b = best?.stats;
    if (!best || a.binsEmptied > b.binsEmptied || (a.binsEmptied === b.binsEmptied && (a.emptyBinsUsed < b.emptyBinsUsed
      || (a.emptyBinsUsed === b.emptyBinsUsed && a.moves < b.moves)))) best = p;
    if (best.stats.binsEmptied === best.stats.candidates) break; // every candidate emptied
  }
  return best;
}

module.exports = { relocatePlan, unitShare };
