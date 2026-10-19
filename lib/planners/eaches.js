// Eaches consolidation for shelf (BIN-type) bins: empty the emptiest bins by pouring their
// stock into bins that already hold stock and have room, within the chosen areas and zones.
// Every pour is checked against the target bin's volume and weight and its multi-SKU,
// multi-batch, max SKU and max SKU-batch rules, counting what's already in it.
//
// Pure: takes plain data, returns a plan. lib/inventory.js builds the input from the DB.
//
// input:
//   bins:  [{ code, zone, zoneId, area, areaId, areaType, status, huType, binType, volCC, maxKg,
//             multiSku, multiBatch, maxSku, maxSkuBatch, fixed }]   fixed = has an active storage_bin_fixed_mapping
//   stock: Map binCode -> [{ sku, batch, bucket, price, inclusion, uom, qty, locked, iloc }]   free stock (pick-locked stock is in leaving)
//   leaving: optional Map binCode -> [{ sku, batch, bucket, price, uom, qty, iloc }]   stock a pick task is taking out: it
//          doesn't count toward fill, but keeps the bin's mixing rules until it's gone
//   skus:  Map code -> { volL0, volL2, volL3, L0wt, L0inL2, L2inL3, clazz }   (cc, kg)
//   allowed(bin, sku, uom, bucket) -> bool   the search table, for pours into another zone
//   busy: optional Map binCode -> [{ hu, mode, qty, who }]   stock arriving (PUT) or held by a task, read from the HU tables
//          (binLocks): such a bin takes nothing and gives nothing, whatever the inventory table says
//   wmsUnit(binCode, sku, uom) -> number   optional: one unit's share of the bin as the IM upload's capacity check counts it.
//          The WMS refuses an IM that takes a bin's total over 100% ("Qty exceeds bin capacity"), so every pour stays within it
//   lockError: optional string, set when the HU tables couldn't be read for locks (reported as a warning)
// opts:
//   from, to:     "zone|bin type" cells (or { cells }): bins of From may be emptied, bins of To may receive; a bin can be in
//                 both. Empty = every shelf bin the other filters let in
//   areas, zones: codes to work within (empty = all storage shelf bins)
//   binTypes:     bin type codes to work within (empty = all)
//   uoms:         units to move, of L0 (eaches), L2 (cases), L3 (default L0). A bin holding any other unit is left alone;
//                 cases move whole, sized by their own uom volume
//   emptyBelowPct: only empty bins filled below this % of their volume (default 100 = any); fuller bins can still receive
//   crossZone:    pour between zones of the same area (default: only within a zone)
//   fillPct:      fill a target to at most this % of its volume (default 100)
//   checkWeight:  also keep targets within the bin type's max kg (default true; WMS itself doesn't check weight)
//   suspectVolCC: a bin type volume at or above this is treated as unset (default 10,000,000 cc = 10 m3)
const EPS = 1e-9, WMS_MAX = 1 + 1e-6; // the IM upload lets a bin total 1e-6 over 100%
const up = (s) => String(s ?? "").trim().toUpperCase();
const priceOf = (p) => (p === null || p === undefined || p === "" ? "" : String(Number(p)));
// WMS quantEquals: sku, bucket, batch, price (quant-utils.ts)
const quantId = (l) => `${l.sku}|${up(l.batch)}|${up(l.bucket)}|${priceOf(l.price)}`;
const lineKey = (l) => `${quantId(l)}|${l.inclusion || ""}|${l.uom}`;
const UNIT = { L0: "eaches", L2: "cases (L2)", L3: "outer cases (L3)" };
const EXEMPT = new Set(["PICK_AND_DROP", "STAGING", "REJECT", "WORK_CENTER", "TRANSPORTATION"]);

function unitVol(skus, sku, uom) {
  const s = skus.get(sku);
  if (!s) return null;
  const v = uom === "L0" ? s.volL0 : uom === "L2" ? s.volL2 : uom === "L3" ? s.volL3 : null;
  // a case recorded smaller than one each (or an outer case smaller than a case) is a master data slip: treat it as unsized
  if (uom === "L2" && s.volL0 > 0 && v < s.volL0) return null;
  if (uom === "L3" && (s.volL2 || s.volL0) > 0 && v < (s.volL2 || s.volL0)) return null;
  return v > 0 ? v : null;
}
function unitKg(skus, sku, uom) {
  const s = skus.get(sku);
  if (!s?.L0wt) return 0; // no weight: weight isn't the limit we can check
  if (uom === "L0") return s.L0wt;
  if (uom === "L2") return s.L0inL2 ? s.L0wt * s.L0inL2 : 0;
  if (uom === "L3") return s.L0inL2 && s.L2inL3 ? s.L0wt * s.L0inL2 * s.L2inL3 : 0;
  return 0;
}

// a bin's state: what it holds and how full it is
function binState(b, lines, skus, o, gone, busy, wu) {
  const st = { b, lines: new Map(), skus: new Set(), keys: new Set(), quants: new Set(), ilocs: new Set(), used: 0, kg: 0, sized: true, locked: false, nonEach: false,
    excluded: false, busy: busy || [], wu, wms: 0 };
  // stock being picked counts in the WMS capacity check until it's gone
  const wms = (l) => (wu ? (wu(b.code, l.sku, l.uom) || 0) * l.qty : 0);
  for (const l of gone || []) {
    if (!(l.qty > 0)) continue;
    st.wms += wms(l);
    st.skus.add(l.sku); st.keys.add(`${l.sku}|${up(l.batch)}`); st.quants.add(quantId(l)); st.ilocs.add(l.iloc || ""); st.leaving = true;
  }
  for (const l of lines || []) {
    if (!(l.qty > 0)) continue;
    const k = lineKey(l);
    const cur = st.lines.get(k);
    if (cur) cur.qty += l.qty; else st.lines.set(k, { sku: l.sku, batch: up(l.batch), bucket: l.bucket, price: l.price, inclusion: l.inclusion, iloc: l.iloc, uom: l.uom, qty: l.qty });
    st.skus.add(l.sku); st.keys.add(`${l.sku}|${up(l.batch)}`); st.quants.add(quantId(l)); st.ilocs.add(l.iloc || "");
    const v = unitVol(skus, l.sku, l.uom);
    if (v === null) st.sized = false; else st.used += v * l.qty;
    st.kg += unitKg(skus, l.sku, l.uom) * l.qty;
    st.wms += wms(l);
    if (l.locked) st.locked = true;
    // loading reads only INCLUDED stock: POST-GIN / PRE-GRN never moves (no status at all = an older schema: included)
    if (l.inclusion && up(l.inclusion) !== "INCLUDED") st.excluded = true;
    if (!o.uomSet.has(l.uom)) st.nonEach = true; // a unit we weren't asked to move
  }
  // stock arriving or held by a task, seen in the HU tables: nothing in, nothing out (the inventory table may lag them)
  if (st.busy.length) st.locked = true;
  st.cap = b.volCC > 0 && b.volCC < o.suspectVolCC ? b.volCC * o.fillPct / 100 : null;
  // WMS putaway never checks weight (only volume); checkWeight adds the bin type's max kg as a safety cap
  st.capKg = o.checkWeight && b.maxKg > 0 ? b.maxKg : null;
  return st;
}

// would the bin still take this quant? Mirrors WMS slotting isCompatible (bin-state-v3.ts):
//   multiSku=false, multiBatch=false: every quant already there must equal it (sku, bucket, batch, price)
//   multiSku=false, multiBatch=true:  same SKU only
//   multiSku=true,  multiBatch=false: that SKU's stock there must be on the same batch
// plus maxSkuCount / maxSkuBatchCount, counting the new quant
function mixOk(t, l) {
  const sku = l.sku, batch = up(l.batch), k = `${sku}|${batch}`;
  // stock of two inventory owners never shares a bin (WMS checks iloc when owner-only is on)
  if ([...t.ilocs].some((x) => x !== (l.iloc || ""))) return false;
  const ms = t.b.multiSku !== false, mb = t.b.multiBatch !== false;
  if (!ms && !mb) { if ([...t.quants].some((q) => q !== quantId(l))) return false; }
  else if (!ms) { if ([...t.skus].some((s) => s !== sku)) return false; }
  else if (!mb) { if ([...t.keys].some((x) => x.startsWith(sku + "|") && x !== k)) return false; }
  const skus = t.skus.has(sku) ? t.skus.size : t.skus.size + 1;
  if (t.b.maxSku && skus > t.b.maxSku) return false;
  if (t.b.maxSkuBatch && (t.keys.has(k) ? t.keys.size : t.keys.size + 1) > t.b.maxSkuBatch) return false;
  return true;
}
// does the bin already break its own rules with what's in it now? (bad data, or rules changed
// after it was filled) Such a bin can be emptied, but nothing is poured into it.
function brokenNow(t) {
  const ms = t.b.multiSku !== false, mb = t.b.multiBatch !== false;
  if (!ms && !mb && t.quants.size > 1) return true;
  if (!ms && t.skus.size > 1) return true;
  if (!mb && [...t.skus].some((sku) => [...t.keys].filter((k) => k.startsWith(sku + "|")).length > 1)) return true;
  if (t.b.maxSku && t.skus.size > t.b.maxSku) return true;
  if (t.b.maxSkuBatch && t.keys.size > t.b.maxSkuBatch) return true;
  return t.ilocs.size > 1;
}
// one unit of line l's share of bin t as the IM upload's capacity check counts it (0 = not counted)
const wmsOf = (t, l) => (t.wu && l ? t.wu(t.b.code, l.sku, l.uom) || 0 : 0);
// whole units of line l the target can still take, by volume, weight and the WMS capacity check
function room(t, uv, uk, l) {
  // already over its weight limit (heavy stock already in it): takes nothing, even of a SKU with no weight
  if (t.capKg && t.kg > t.capKg + EPS) return 0;
  let n = Math.floor((t.cap - t.used) / uv + EPS);
  if (t.capKg && uk > 0) n = Math.min(n, Math.floor((t.capKg - t.kg) / uk + EPS));
  const wu = wmsOf(t, l);
  if (wu > 0) n = Math.min(n, Math.floor((WMS_MAX - t.wms) / wu + EPS));
  return Math.max(0, n);
}
const cellsOf = (x) => (Array.isArray(x) ? x : x?.cells || []).map(up).filter(Boolean);

// a fixed pseudo-random order per name, so the same stock always gives the same plan
const shuffled = (name) => {
  const h = (code) => { let x = 2166136261; for (const ch of name + "|" + code) x = Math.imul(x ^ ch.charCodeAt(0), 16777619) >>> 0; return x; };
  return (a, b) => h(a.b.code) - h(b.b.code);
};

function planOnce({ bins, stock, skus, allowed, leaving, busy, wmsUnit }, opts = {}, order = "used") {
  const o = { fillPct: 100, suspectVolCC: 10_000_000, crossZone: false, checkWeight: true, ...opts };
  o.checkWeight = o.checkWeight !== false && o.checkWeight !== "0";
  o.fillPct = Math.min(100, Math.max(1, Number(o.fillPct) || 100));
  o.emptyBelowPct = Math.min(100, Math.max(1, Number(o.emptyBelowPct) || 100));
  o.uoms = [...new Set((o.uoms && o.uoms.length ? o.uoms : ["L0"]).map(up))].filter((u) => ["L0", "L2", "L3"].includes(u));
  if (!o.uoms.length) o.uoms = ["L0"];
  o.binTypes = o.binTypes || [];
  o.from = { cells: cellsOf(o.from) }; o.to = { cells: cellsOf(o.to) };
  const fromSet = new Set(o.from.cells), toSet = new Set(o.to.cells), cell = (b) => `${up(b.zone)}|${up(b.binType)}`;
  const inFrom = (b) => !fromSet.size || fromSet.has(cell(b)), inTo = (b) => !toSet.size || toSet.has(cell(b));
  Object.defineProperty(o, "uomSet", { value: new Set(o.uoms), enumerable: false });
  const areaSet = new Set((o.areas || []).map(up)), zoneSet = new Set((o.zones || []).map(up)), typeSet = new Set(o.binTypes.map(up));
  const inScope = (b) => b.huType === "BIN" && b.status === "ACTIVE" && !EXEMPT.has(b.areaType)
    && (!areaSet.size || areaSet.has(up(b.area))) && (!zoneSet.size || zoneSet.has(up(b.zone))) && (!typeSet.size || typeSet.has(up(b.binType))) && (inFrom(b) || inTo(b));
  // only bins of From below the chosen fill (of the bin's own volume) are emptied; fuller ones can still receive
  const canGive = (s) => inFrom(s.b) && (o.emptyBelowPct >= 100 || s.used < s.b.volCC * o.emptyBelowPct / 100 - EPS);
  // only bins of To receive (a bin outside To stays as it is when it isn't emptied)
  const takes = (s) => !s.broken && inTo(s.b);

  const states = new Map(), binsBy = new Map(bins.map((b) => [b.code, b]));
  const st = { binsInScope: 0, occupied: 0, emptyBins: 0, locked: 0, busy: 0, excluded: 0, fixed: 0, broken: 0, unsized: 0, nonEach: 0, suspectVol: 0, noVol: 0 };
  const zoneRows = new Map(); // per area | zone, for the zones table
  const zoneOf = (b) => { const k = `${b.area}|${b.zone}`; if (!zoneRows.has(k)) zoneRows.set(k, { zone: b.zone, area: b.area, bins: 0, binsUsed: 0, binsEmptied: 0, emptyBinsUsed: 0, positionsFreed: 0 }); return zoneRows.get(k); };
  for (const b of bins) {
    if (!inScope(b)) continue;
    st.binsInScope++;
    zoneOf(b).bins++;
    const s = binState(b, stock.get(b.code), skus, o, leaving?.get(b.code), busy?.get(b.code), wmsUnit);
    if (!(b.volCC > 0)) st.noVol++; else if (b.volCC >= o.suspectVolCC) st.suspectVol++;
    if (!s.lines.size) { st.emptyBins++; continue; }
    st.occupied++;
    zoneOf(b).binsUsed++;
    if (s.locked) st.locked++;
    if (s.busy.length) st.busy++;
    if (s.excluded) st.excluded++;
    s.broken = brokenNow(s);
    if (s.broken) st.broken++;
    if (b.fixed) st.fixed++;
    if (!s.sized) st.unsized++;
    if (s.nonEach) st.nonEach++;
    states.set(b.code, s);
  }
  // a bin can give or take only when it's all eaches, unlocked, sized, has a real volume and
  // isn't a fixed bin (its mapping decides what goes in, and emptying it just invites a refill)
  const usable = (s) => !s.locked && !s.excluded && !s.b.fixed && s.sized && !s.nonEach && s.cap !== null;
  const busyText = (s) => [...new Set(s.busy.map((x) => `${x.mode === "HU" ? `pallet ${x.hu} locked` : `${x.mode} lock${x.qty ? ` of ${x.qty}` : ""}`}${x.who ? ` by ${x.who}` : ""}`))].join(", ");
  // every stocked bin the plan won't touch, or only empties, and why
  const why = (s) => s.busy.length ? `Stock arriving or held by a task (${busyText(s)})` : s.locked ? "Stock locked by a task"
    : s.excluded ? "Stock not INCLUDED (POST-GIN / PRE-GRN)" : s.b.fixed ? "Fixed bin (mapped to a SKU, EAN or product)"
    : s.nonEach ? `Holds units not chosen (moving ${o.uoms.map((u) => UNIT[u]).join(" and ")} only)` : !s.sized ? "A SKU in it has no volume for its unit (or a case smaller than an each)"
    : !(s.b.volCC > 0) ? "Bin type has no volume" : s.cap === null ? "Bin type volume looks unset (10,000 L or more)" : null;
  const leftOut = [];
  for (const s of states.values()) {
    const r = why(s) || (s.broken ? "Already breaks its own mixing rules: can be emptied, won't receive" : null);
    if (r) leftOut.push({ bin: s.b.code, zone: s.b.zone, area: s.b.area, binType: s.b.binType, reason: r,
      stock: [...s.lines.values()].map((l) => `${l.qty} ${l.uom} ${l.sku} ${l.batch}`).join(" + ") });
  }
  const groupOf = (b) => (o.crossZone ? `A|${b.area}` : `Z|${b.zone}`);
  const groups = new Map();
  for (const s of states.values()) {
    if (!usable(s)) continue;
    const g = groupOf(s.b);
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(s);
  }

  // how far from the best possible: the fewest bins each group's stock could be left in,
  // ignoring how it splits between bins, so a true upper bound on bins emptied.
  // A bin kept holds at most its capacity, or what it already holds if that's more
  // (stock already over a limit stays put); by volume and, when checked, by weight.
  // bins too full to empty are kept whatever happens; then the biggest of the rest until the total is held
  const fewest = (l, capOf, total) => {
    let n = 0, t = 0;
    for (const s of l) if (!canGive(s)) { n++; t += capOf(s); }
    const caps = l.filter(canGive).map(capOf).sort((x, y) => y - x);
    for (let i = 0; t < total - EPS && i < caps.length; i++) { t += caps[i]; n++; }
    return Math.max(1, n);
  };
  const keepersNeeded = (l) => {
    const vol = l.reduce((t, s) => t + s.used, 0), kg = l.reduce((t, s) => t + s.kg, 0);
    let n = fewest(l, (s) => (takes(s) ? Math.max(s.cap, s.used) : s.used), vol);
    if (o.checkWeight && l.every((s) => s.capKg)) n = Math.max(n, fewest(l, (s) => (takes(s) ? Math.max(s.capKg, s.kg) : s.kg), kg));
    return Math.min(l.length, n);
  };
  // one quant, one line per bin: count in whole eaches (a bin's room rounds down), which is exact
  const keepersInEaches = (l) => {
    const x = [...l[0].lines.values()][0], uv = unitVol(skus, x.sku, x.uom), uk = unitKg(skus, x.sku, x.uom);
    const capU = new Map(l.map((s) => [s, [...s.lines.values()][0].qty + (takes(s) ? room(s, uv, uk, x) : 0)]));
    const total = l.reduce((t, s) => t + [...s.lines.values()][0].qty, 0);
    return fewest(l, (s) => capU.get(s), total);
  };
  let lowerBound = 0, usableOcc = 0, tooFull = 0;
  for (const list of groups.values()) {
    usableOcc += list.length; tooFull += list.filter((s) => !canGive(s)).length;
    // strict bins (not multi-SKU, not multi-batch) only ever merge the same quant: bound each quant on its own
    const strict = list.every((s) => s.b.multiSku === false && s.b.multiBatch === false);
    if (strict) {
      const byQuant = new Map();
      for (const s of list) { const k = [...s.quants].sort().join(","); if (!byQuant.has(k)) byQuant.set(k, []); byQuant.get(k).push(s); }
      for (const [k, l] of byQuant) lowerBound += k.includes(",") ? l.length : l.every((s) => s.lines.size === 1) && new Set(l.map((s) => [...s.lines.values()][0].uom)).size === 1 ? keepersInEaches(l) : keepersNeeded(l); // a mixed bin can't take or give
    } else lowerBound += keepersNeeded(list);
  }
  const bestPossible = usableOcc - lowerBound;

  const moves = [], emptied = [];
  const received = new Set(), gone = new Set();
  // the zone, area and bin type of a pour's two ends (the output contract's per-move fields)
  const where = (src, t) => ({ kind: "pour", fromZone: src.b.zone, toZone: t.b.zone, fromArea: src.b.area, toArea: t.b.area, fromBinType: src.b.binType, toBinType: t.b.binType,
    crossZone: src.b.zone !== t.b.zone, toWasEmpty: false });
  // pour n units of line l from src into target t (a bin state), updating t; returns the move
  const pour = (src, t, l, n, uv, uk) => {
    const k = `${l.sku}|${l.batch}`, before = t.used;
    t.used += n * uv; t.kg += n * uk; t.wms += n * wmsOf(t, l); t.skus.add(l.sku); t.keys.add(k); t.quants.add(quantId(l)); t.ilocs.add(l.iloc || "");
    return { ...where(src, t), sku: l.sku, batch: l.batch, bucket: l.bucket, price: l.price, inclusion: l.inclusion, iloc: l.iloc, uom: l.uom, qty: n, fromBin: src.b.code, toBin: t.b.code,
      fromBinVolCC: src.b.volCC, fromUsedCC: src.used, area: t.b.area, unitVolCC: uv, moveVolCC: n * uv, toBinVolCC: t.b.volCC, toCapCC: t.cap,
      toUsedBeforeCC: before, toUsedAfterCC: t.used, toKgAfter: t.kg, toMaxKg: t.capKg, toWmsAfter: t.wms, sameKey: true };
  };
  // src is emptied by these moves (targets already updated)
  const commit = (src, plan) => {
    for (const p of plan) {
      const real = states.get(p.toBin), lk = lineKey(p), cur = real.lines.get(lk);
      if (cur) cur.qty += p.qty; else real.lines.set(lk, { sku: p.sku, batch: p.batch, bucket: p.bucket, price: p.price, inclusion: p.inclusion, uom: p.uom, qty: p.qty });
      received.add(p.toBin);
    }
    gone.add(src.b.code);
    emptied.push({ bin: src.b.code, afterPick: !!src.leaving, zone: src.b.zone, area: src.b.area, binType: src.b.binType, volCC: src.b.volCC, usedCC: src.used,
      lines: src.lines.size, to: [...new Set(plan.map((p) => p.toBin))] });
    moves.push(...plan);
  };
  // Exact pass for strict bins (not multi-SKU, not multi-batch) holding one quant: they can only
  // ever merge with bins of that same quant, and every each is the same size, so the fewest bins
  // that can keep the lot are the ones that can hold the most eaches (what they hold plus their
  // room). Keep those, empty the rest into them. That is optimal for the group.
  function exactPass(list) {
    const byQ = new Map();
    for (const s of list) {
      if (s.b.multiSku !== false || s.b.multiBatch !== false || s.lines.size !== 1) continue;
      const l = [...s.lines.values()][0], k = quantId(l) + "|" + (l.iloc || "") + "|" + l.uom;
      if (!byQ.has(k)) byQ.set(k, []);
      byQ.get(k).push({ s, l });
    }
    for (const g of byQ.values()) {
      if (g.length < 2) continue;
      const { l } = g[0], uv = unitVol(skus, l.sku, l.uom), uk = unitKg(skus, l.sku, l.uom);
      for (const x of g) { x.units = x.l.qty; x.room = takes(x.s) ? room(x.s, uv, uk, l) : 0; x.capU = x.units + x.room; }
      const total = g.reduce((t, x) => t + x.units, 0);
      // most eaches first; on a tie the one already holding more (fewer moves), then by code
      g.sort((a, b) => b.capU - a.capU || b.units - a.units || a.s.b.code.localeCompare(b.s.b.code));
      // bins too full to empty stay; then the ones that hold the most
      const forced = g.filter((x) => !canGive(x.s)), free = g.filter((x) => canGive(x.s));
      let i = 0, held = forced.reduce((t, x) => t + x.capU, 0);
      while (held < total && i < free.length) held += free[i++].capU;
      const n = forced.length + i;
      if (n >= g.length) continue;
      // Any n bins that can hold the lot are an optimal keep set. Among them (all of them while
      // that's a few hundred sets) and two pour orders, take the plan with the fewest moves,
      // then the fewest eaches carried.
      const assign = (keep, tight) => {
        const drop = g.filter((x) => !keep.includes(x)).sort((p, q) => q.units - p.units || p.s.b.code.localeCompare(q.s.b.code));
        const left = new Map(keep.map((x) => [x, x.room]));
        return drop.map((d) => {
          const ok = (k) => left.get(k) > 0 && (k.s.b.zone === d.s.b.zone || !allowed || allowed(k.s.b, d.l.sku, d.l.uom, d.l.bucket));
          // one keeper that takes it all (tightest or roomiest), else split over the roomiest
          const whole = keep.filter((k) => ok(k) && left.get(k) >= d.units).sort((p, q) => (tight ? 1 : -1) * (left.get(p) - left.get(q)))[0];
          let parts = [];
          if (whole) parts.push([whole, d.units]);
          else {
            let rest = d.units;
            for (const k of keep.filter(ok).sort((p, q) => left.get(q) - left.get(p))) { if (!rest) break; const q = Math.min(rest, left.get(k)); parts.push([k, q]); rest -= q; }
            if (rest) parts = null; // not placeable (search table across zones): it stays
          }
          if (parts) parts.forEach(([k, q]) => left.set(k, left.get(k) - q));
          return { d, parts };
        });
      };
      const rate = (p) => { const done = p.filter((x) => x.parts); return [done.length, -done.reduce((t, x) => t + x.parts.length, 0), -done.reduce((t, x) => t + x.d.units, 0)]; };
      const better = (x, y) => { for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };
      const keepSets = [[...forced, ...free.slice(0, i)]];
      let count = 1;
      for (let j = 0; j < i; j++) count = count * (free.length - j) / (j + 1);
      if (count <= 400) {
        keepSets.length = 0;
        const pickSets = (from, chosen, cap) => {
          if (chosen.length === n) { if (cap >= total) keepSets.push([...chosen]); return; }
          for (let j = from; j <= free.length - (n - chosen.length); j++) { chosen.push(free[j]); pickSets(j + 1, chosen, cap + free[j].capU); chosen.pop(); }
        };
        pickSets(0, [...forced], forced.reduce((t, x) => t + x.capU, 0));
      }
      let best = null, bestRate = null;
      for (const keep of keepSets) for (const tight of [true, false]) {
        const p = assign(keep, tight), r = rate(p);
        if (!best || better(r, bestRate)) { best = p; bestRate = r; }
      }
      for (const { d, parts } of best) if (parts) commit(d.s, parts.map(([k, q]) => pour(d.s, k.s, d.l, q, uv, uk)));
    }
  }
  for (const list of groups.values()) if (list.length >= 2) exactPass(list);

  for (const list of groups.values()) {
    if (list.length < 2) continue;
    // empty the bins holding the least first
    // which bins to try emptying first; eachesPlan runs a few orders and keeps the best plan
    const first = { used: (a, b) => a.used - b.used, lines: (a, b) => a.lines.size - b.lines.size || a.used - b.used,
      fill: (a, b) => a.used / a.cap - b.used / b.cap, small: (a, b) => a.cap - b.cap || a.used - b.used }[order] || shuffled(order);
    const sources = [...list].sort((a, b) => first(a, b) || a.b.code.localeCompare(b.b.code));
    for (const src of sources) {
      if (received.has(src.b.code) || gone.has(src.b.code) || !canGive(src)) continue;
      // try on copies of the targets; keep only if everything finds a place
      const sim = new Map();
      const simOf = (t) => {
        if (!sim.has(t.b.code)) sim.set(t.b.code, { ...t, skus: new Set(t.skus), keys: new Set(t.keys), quants: new Set(t.quants), ilocs: new Set(t.ilocs), lines: new Map([...t.lines].map(([k, v]) => [k, { ...v }])) });
        return sim.get(t.b.code);
      };
      const plan = [];
      let ok = true;
      const srcLines = [...src.lines.values()].sort((a, b) => unitVol(skus, b.sku, b.uom) * b.qty - unitVol(skus, a.sku, a.uom) * a.qty);
      for (const l of srcLines) {
        const uv = unitVol(skus, l.sku, l.uom), uk = unitKg(skus, l.sku, l.uom), k = `${l.sku}|${l.batch}`;
        let left = l.qty;
        while (left > 0) {
          const cands = list.filter((t) => t !== src && !gone.has(t.b.code))
            .map(simOf)
            .filter((t) => takes(t) && mixOk(t, l) && room(t, uv, uk, l) > 0
              && (t.b.zone === src.b.zone || !allowed || allowed(t.b, l.sku, l.uom, l.bucket)));
          if (!cands.length) { ok = false; break; }
          // same SKU-batch first, then one that takes it all, then the fullest (best fit), then same zone
          cands.sort((a, b) => (b.keys.has(k) - a.keys.has(k))
            || ((room(b, uv, uk, l) >= left) - (room(a, uv, uk, l) >= left))
            || ((a.cap - a.used) - (b.cap - b.used))
            || ((b.b.zone === src.b.zone) - (a.b.zone === src.b.zone))
            || a.b.code.localeCompare(b.b.code));
          const t = cands[0], n = Math.min(left, room(t, uv, uk, l));
          const before = t.used;
          t.used += n * uv; t.kg += n * uk; t.wms += n * wmsOf(t, l); t.skus.add(l.sku); t.keys.add(k); t.quants.add(quantId(l)); t.ilocs.add(l.iloc || "");
          plan.push({ ...where(src, t), sku: l.sku, batch: l.batch, bucket: l.bucket, price: l.price, inclusion: l.inclusion, iloc: l.iloc, uom: l.uom, qty: n, fromBin: src.b.code, toBin: t.b.code,
            fromBinVolCC: src.b.volCC, fromUsedCC: src.used, area: t.b.area, unitVolCC: uv, moveVolCC: n * uv, toBinVolCC: t.b.volCC, toCapCC: t.cap,
            toUsedBeforeCC: before, toUsedAfterCC: t.used, toKgAfter: t.kg, toMaxKg: t.capKg, toWmsAfter: t.wms, sameKey: t.keys.has(k) });
          left -= n;
        }
        if (!ok) break;
      }
      if (!ok) continue;
      // commit: only the bins that actually took something
      const took = new Set(plan.map((p) => p.toBin));
      for (const t of sim.values()) {
        if (!took.has(t.b.code)) continue;
        const real = states.get(t.b.code);
        Object.assign(real, { used: t.used, kg: t.kg, wms: t.wms, skus: t.skus, keys: t.keys, quants: t.quants, ilocs: t.ilocs });
        received.add(t.b.code);
      }
      for (const p of plan) {
        const real = states.get(p.toBin);
        const lk = lineKey(p);
        const cur = real.lines.get(lk);
        if (cur) cur.qty += p.qty; else real.lines.set(lk, { sku: p.sku, batch: p.batch, bucket: p.bucket, price: p.price, inclusion: p.inclusion, uom: p.uom, qty: p.qty });
      }
      gone.add(src.b.code);
      emptied.push({ bin: src.b.code, afterPick: !!src.leaving, zone: src.b.zone, area: src.b.area, binType: src.b.binType, volCC: src.b.volCC, usedCC: src.used,
        lines: src.lines.size, to: [...new Set(plan.map((p) => p.toBin))] });
      moves.push(...plan);
    }
  }


  // in shelf order, so the list can be worked aisle by aisle (no move depends on another)
  const byCode = (x, y) => x.localeCompare(y, undefined, { numeric: true });
  moves.sort((x, y) => byCode(x.fromBin, y.fromBin) || byCode(x.toBin, y.toBin));
  emptied.sort((x, y) => byCode(x.bin, y.bin));
  moves.forEach((p, i) => { p.step = i + 1; });
  for (const e of emptied) zoneOf(binsBy.get(e.bin)).binsEmptied++;
  const crossZoneMoves = moves.filter((p) => p.crossZone).length;

  // what the floor or the reader must know (docs/CONSOLIDATION_V2.md warnings)
  const warnings = [], warn = (level, code, text, list) => warnings.push({ level, code, text, bins: [...new Set(list)].sort(byCode).slice(0, 200) });
  const busyBins = [...states.values()].filter((s) => s.locked);
  if (busyBins.length) warn("info", "put-lock", `${busyBins.length} shelf bin(s) in scope have stock arriving (PUT) or held by a task: left out, nothing in or out.`, busyBins.map((s) => s.b.code));
  const excl = [...states.values()].filter((s) => s.excluded);
  if (excl.length) warn("info", "not-included", `${excl.length} shelf bin(s) in scope hold stock that isn't INCLUDED (POST-GIN / PRE-GRN): never moved, and nothing goes into them.`, excl.map((s) => s.b.code));
  if (crossZoneMoves) warn("warn", "cross-zone", `${crossZoneMoves} pour(s) go to another zone of the same area (the search table allows them).`, moves.filter((p) => p.crossZone).flatMap((p) => [p.fromBin, p.toBin]));
  if (st.suspectVol) warn("info", "suspect-volume", `${st.suspectVol} shelf bin(s) have a bin type volume that looks unset (10,000 L or more); left alone.`, []);

  // a summary per target bin: volume before, poured in, after
  const targets = new Map();
  for (const p of moves) {
    if (!targets.has(p.toBin)) targets.set(p.toBin, { bin: p.toBin, zone: p.toZone, volCC: p.toBinVolCC, capCC: p.toCapCC, beforeCC: p.toUsedBeforeCC, inCC: 0, afterCC: 0, maxKg: p.toMaxKg, kgAfter: 0, from: new Set() });
    const t = targets.get(p.toBin);
    t.beforeCC = Math.min(t.beforeCC, p.toUsedBeforeCC); t.inCC += p.moveVolCC; t.afterCC = Math.max(t.afterCC, p.toUsedAfterCC);
    t.kgAfter = Math.max(t.kgAfter, p.toKgAfter); t.from.add(p.fromBin);
  }
  return {
    opts: o,
    stats: { ...st, usable: usableOcc, tooFull, binsEmptied: emptied.length, moves: moves.length, eachesMoved: moves.reduce((t, p) => t + p.qty, 0), bestPossible,
      optimal: emptied.length >= bestPossible,
      // the output contract: shelf bins have no pallet positions, and a pour never goes into an empty bin
      emptyBinsUsed: 0, netBinsFreed: emptied.length, positionsFreed: 0, palletsFreed: 0, casesMoved: moves.reduce((t, p) => t + p.qty, 0), crossZoneMoves, heldBack: 0 },
    warnings, zones: [...zoneRows.values()].sort((a, b) => byCode(String(a.area), String(b.area)) || byCode(String(a.zone), String(b.zone))),
    emptied, moves, leftOut,
    targets: [...targets.values()].map((t) => ({ ...t, from: [...t.from], fillPct: t.volCC ? t.afterCC / t.volCC * 100 : null })),
  };
}

// The exact pass is the same every time; the greedy pass for mixed bins depends on which bins it
// tries to empty first, so try a few orders: most bins emptied, then fewest moves, then fewest eaches.
function eachesPlan(input, opts = {}) {
  let best = null;
  // 4 named orders + 4 shuffles: on random mixed warehouses 8 orders free ~2.5% more bins than 4, and 24 free no more than 8
  for (const order of ["used", "lines", "fill", "small", "r1", "r2", "r3", "r4"]) {
    const p = planOnce(input, opts, order), a = p.stats, b = best?.stats;
    if (!best || a.binsEmptied > b.binsEmptied || (a.binsEmptied === b.binsEmptied && (a.moves < b.moves || (a.moves === b.moves && a.eachesMoved < b.eachesMoved)))) best = p;
    if (best.stats.optimal) break; // can't empty more; the first order already has the fewest-moves exact plan for strict bins
  }
  if (input.lockError) best.warnings.unshift({ level: "warn", code: "lock-read-failed", text: `Couldn't read task locks from the HU tables (${input.lockError}); only the inventory table's lock columns were used.`, bins: [] });
  return best;
}

module.exports = { eachesPlan, unitVol, unitKg, mixOk, lineKey, quantId };
