// Independent check of an eaches plan (lib/eaches.js): replay every move on the original stock and confirm
// nothing breaks. Written separately from eaches.js on purpose; shares no logic with it.
const up = (s) => String(s ?? "").trim().toUpperCase();

function validatePlan(input, plan) {
  const { bins, stock, skus, allowed } = input, o = plan.opts;
  const errs = [];
  const err = (m) => { if (errs.length < 50) errs.push(m); };
  const binBy = new Map(bins.map((b) => [b.code, b]));
  const vol = (sku, uom) => { const s = skus.get(sku); return uom === "L0" ? s?.volL0 : uom === "L2" ? s?.volL2 : s?.volL3; };
  const kg = (sku, uom) => { const s = skus.get(sku); if (!s?.L0wt) return 0; return uom === "L0" ? s.L0wt : uom === "L2" ? s.L0wt * (s.L0inL2 || 0) : s.L0wt * (s.L0inL2 || 0) * (s.L2inL3 || 0); };
  const areaSet = new Set((o.areas || []).map(up)), zoneSet = new Set((o.zones || []).map(up)), typeSet = new Set((o.binTypes || []).map(up));
  const units = new Set(o.uoms && o.uoms.length ? o.uoms : ["L0"]), below = Number(o.emptyBelowPct) || 100;
  // what a bin held before the plan, in cc
  const usedBefore = (code) => (stock.get(code) || []).reduce((t, l) => t + (l.qty > 0 ? (vol(l.sku, l.uom) || NaN) * l.qty : 0), 0);

  // working copy of the stock: bin -> Map(sku|batch|uom|bucket -> qty)
  const S = new Map();
  for (const [bin, lines] of stock) {
    const m = new Map();
    for (const l of lines) if (l.qty > 0) { const k = `${l.sku}|${up(l.batch)}|${l.uom}|${up(l.bucket)}|${l.inclusion || ""}|${l.price === null || l.price === undefined || l.price === "" ? "" : Number(l.price)}`; m.set(k, (m.get(k) || 0) + l.qty); }
    S.set(bin, m);
  }
  const total = () => { let t = 0; for (const m of S.values()) for (const q of m.values()) t += q; return t; };
  const before = total();
  const lockedBins = new Set([...stock].filter(([, ls]) => ls.some((l) => l.locked)).map(([b]) => b));
  const touched = new Set(), targets = new Set(), sources = new Set();
  const brokenBefore = (b) => {
    const ls = (stock.get(b.code) || []).filter((l) => l.qty > 0);
    const skuSet = new Set(ls.map((l) => l.sku)), keySet = new Set(ls.map((l) => l.sku + "|" + up(l.batch)));
    const qset = new Set(ls.map((l) => [l.sku, up(l.batch), up(l.bucket), l.price ?? ""].join("|"))), owners = new Set(ls.map((l) => l.iloc || ""));
    if (b.multiSku === false && b.multiBatch === false && qset.size > 1) return true;
    if (b.multiSku === false && skuSet.size > 1) return true;
    if (b.multiBatch === false && [...skuSet].some((s) => [...keySet].filter((k) => k.startsWith(s + "|")).length > 1)) return true;
    if (b.maxSku && skuSet.size > b.maxSku) return true;
    if (b.maxSkuBatch && keySet.size > b.maxSkuBatch) return true;
    return owners.size > 1;
  };

  for (const [i, p] of plan.moves.entries()) {
    const f = binBy.get(p.fromBin), t = binBy.get(p.toBin);
    const tag = `move ${i + 1} ${p.sku} ${p.qty} ${p.fromBin}->${p.toBin}`;
    if (!f || !t) { err(`${tag}: unknown bin`); continue; }
    if (p.fromBin === p.toBin) err(`${tag}: same bin`);
    if (!Number.isInteger(p.qty) || p.qty <= 0) err(`${tag}: qty not a positive whole number`);
    if (!units.has(p.uom)) err(`${tag}: moves ${p.uom}, not a chosen unit`);
    if (below < 100 && !sources.has(p.fromBin) && !(usedBefore(p.fromBin) < f.volCC * below / 100)) err(`${tag}: source is ${(usedBefore(p.fromBin) / f.volCC * 100).toFixed(1)}% full, not under ${below}%`);
    if (!(p.fromBinVolCC > 0) || !(p.toBinVolCC > 0) || !(p.unitVolCC > 0)) err(`${tag}: missing a volume (from ${p.fromBinVolCC}, to ${p.toBinVolCC}, L0 ${p.unitVolCC})`);
    if (Math.abs(p.moveVolCC - p.qty * p.unitVolCC) > 1e-6) err(`${tag}: move volume isn't qty x L0 volume`);
    if (p.toUsedAfterCC > p.toCapCC + 1e-6) err(`${tag}: plan itself says target over capacity`);
    for (const b of [f, t]) {
      if (b.huType !== "BIN") err(`${tag}: ${b.code} is not a shelf bin`);
      if (b.status !== "ACTIVE") err(`${tag}: ${b.code} not active`);
      if (areaSet.size && !areaSet.has(up(b.area))) err(`${tag}: ${b.code} outside chosen areas`);
      if (zoneSet.size && !zoneSet.has(up(b.zone))) err(`${tag}: ${b.code} outside chosen zones`);
      if (typeSet.size && !typeSet.has(up(b.binType))) err(`${tag}: ${b.code} is bin type ${b.binType}, not a chosen one`);
      if (lockedBins.has(b.code)) err(`${tag}: ${b.code} has locked stock`);
      if (b.fixed) err(`${tag}: ${b.code} is a fixed bin`);
    }
    if (!o.crossZone && f.zone !== t.zone) err(`${tag}: crosses zones`);
    if (f.area !== t.area) err(`${tag}: crosses areas`);
    if (f.zone !== t.zone && allowed && !allowed(t, p.sku, p.uom, p.bucket)) err(`${tag}: search table doesn't allow it in ${t.zone}`);
    if (targets.has(p.fromBin)) err(`${tag}: source already received stock (chain)`);
    if (!targets.has(p.toBin) && brokenBefore(t)) err(`${tag}: target already breaks its own mixing rules`);
    if (sources.has(p.toBin)) err(`${tag}: target is a bin being emptied`);
    sources.add(p.fromBin); targets.add(p.toBin); touched.add(p.fromBin); touched.add(p.toBin);
    const fm = S.get(p.fromBin) || new Map();
    const fk = [...fm.keys()].find((k) => k.startsWith(`${p.sku}|${up(p.batch)}|${p.uom}|${up(p.bucket)}|`) && k.endsWith(`|${p.price === null || p.price === undefined || p.price === "" ? "" : Number(p.price)}`));
    if (!fk || fm.get(fk) < p.qty) { err(`${tag}: source doesn't hold that much`); continue; }
    fm.set(fk, fm.get(fk) - p.qty); if (fm.get(fk) === 0) fm.delete(fk);
    if (!S.has(p.toBin)) S.set(p.toBin, new Map());
    const tm = S.get(p.toBin);
    if (![...tm.values()].some((q) => q > 0)) err(`${tag}: target was empty (moving into an empty bin frees nothing)`);
    tm.set(fk, (tm.get(fk) || 0) + p.qty);
  }
  // owners: replay which ilocs each bin holds
  const own = new Map();
  for (const [bin, lines] of stock) own.set(bin, new Set(lines.filter((l) => l.qty > 0).map((l) => l.iloc || "")));
  for (const p of plan.moves) {
    // the owner the move says it carries must be one the source really holds for that SKU-batch
    const owners = (stock.get(p.fromBin) || []).filter((l) => l.sku === p.sku && up(l.batch) === up(p.batch)).map((l) => l.iloc || "");
    if (!owners.includes(p.iloc || "")) err(`move ${p.sku} ${p.fromBin}->${p.toBin}: source holds no stock of owner "${p.iloc || ""}"`);
    if (!own.has(p.toBin)) own.set(p.toBin, new Set()); own.get(p.toBin).add(p.iloc || "");
  }
  for (const b of targets) if (own.get(b).size > 1) err(`${b}: mixes inventory owners ${[...own.get(b)].join(", ")}`);
  if (Math.abs(total() - before) > 1e-6) err(`stock not conserved: ${before} -> ${total()}`);

  // the end state of every touched bin
  let emptiedReal = 0;
  for (const code of touched) {
    const b = binBy.get(code), m = S.get(code) || new Map();
    const lines = [...m].filter(([, q]) => q > 0).map(([k, q]) => { const [sku, batch, uom, bucket, , price] = k.split("|"); return { sku, batch, uom, bucket, price, q }; });
    if (sources.has(code)) { if (lines.length) err(`${code}: planned to empty but still holds ${lines.length} line(s)`); else emptiedReal++; continue; }
    const v = lines.reduce((t, l) => t + (vol(l.sku, l.uom) || NaN) * l.q, 0);
    const w = lines.reduce((t, l) => t + kg(l.sku, l.uom) * l.q, 0);
    const cap = b.volCC * o.fillPct / 100;
    if (!(v <= cap + 1e-6)) err(`${code}: ${v.toFixed(0)} cc after, over ${cap.toFixed(0)} cc`);
    if (o.checkWeight && b.maxKg > 0 && w > b.maxKg + 1e-6) err(`${code}: ${w.toFixed(2)} kg after, over ${b.maxKg} kg`);
    const skuSet = new Set(lines.map((l) => l.sku)), keySet = new Set(lines.map((l) => `${l.sku}|${l.batch}`));
    const qset = new Set(lines.map((l) => `${l.sku}|${l.batch}|${l.bucket}|${l.price}`));
    if (b.multiSku === false && b.multiBatch === false && qset.size > 1) err(`${code}: strict bin holds ${qset.size} different quants (sku/batch/bucket/price)`);
    if (b.multiSku === false && skuSet.size > 1) err(`${code}: not multi-SKU but holds ${[...skuSet].join(", ")}`);
    if (b.multiBatch === false && [...skuSet].some((s) => [...keySet].filter((k) => k.startsWith(s + "|")).length > 1)) err(`${code}: not multi-batch but holds ${[...keySet].join(", ")}`);
    if (b.maxSku && skuSet.size > b.maxSku) err(`${code}: ${skuSet.size} SKUs > max ${b.maxSku}`);
    if (b.maxSkuBatch && keySet.size > b.maxSkuBatch) err(`${code}: ${keySet.size} SKU-batches > max ${b.maxSkuBatch}`);
  }
  if (emptiedReal !== plan.stats.binsEmptied) err(`plan says ${plan.stats.binsEmptied} bins emptied, replay empties ${emptiedReal}`);
  return { ok: !errs.length, errs, emptied: emptiedReal, moves: plan.moves.length };
}

module.exports = { validatePlan };
