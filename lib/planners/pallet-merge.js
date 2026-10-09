// Consolidate stock (pallet bins): how many pallet positions merging same SKU + batch partial
// pallets would free, then whole-pallet moves that empty multi-position bins.
const { upper, pct } = require("../core/util");
const { EXEMPT_AREAS } = require("../wms/search");
const { isResetSheet, palletsAfter, casesText } = require("../wms/pallets");

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

  // shelf (BIN-type) bins: the same SKU + batch spread over several bins. No best fit
  // for shelves (putaway sizes them by volume), so these are only candidates to look at.
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

  return {
    isReset,
    stats: { ...st, palletBins: binsN, positions, used, spare: positions - used, emptyBins, frees, binsEmptied, mergeGroups: merges.length,
      sameBinFrees: merges.filter((g) => g.oneBin).reduce((t, g) => t + g.frees, 0) },
    zones: [...zones.values()].map((z) => ({ ...z, spare: z.positions - z.used })).sort((a, b) => b.frees - a.frees || a.zone.localeCompare(b.zone)),
    merges, moves, pallets, emptiedBins, shelf: { groups: spread.length, extraBins: spread.reduce((t, s) => t + s.bins - 1, 0), top: spread.slice(0, 200) },
  };
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

module.exports = { consolidation, packBins };
