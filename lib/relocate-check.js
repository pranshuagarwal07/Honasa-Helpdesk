// Independent check of a "bins under X% full" plan (lib/relocate.js): replay every move on the original stock,
// pallet by pallet, and confirm nothing breaks. Written separately on purpose; shares no logic with it.
const up = (s) => String(s ?? "").trim().toUpperCase();
const P = (x) => (x === null || x === undefined || x === "" ? "" : String(Number(x)));

function validateRelocate(input, plan) {
  const { bins, stock, skus, allowed } = input, o = plan.opts;
  // stock being picked out: not moved by the plan, but it holds its pallet's position and counts in the WMS capacity check
  const leaving = input.leaving || new Map();
  const leavingHus = (code) => new Set((leaving.get(code) || []).filter((l) => l.qty > 0 && l.hu && !String(l.hu).startsWith("BIN_HU_")).map((l) => l.hu));
  const errs = [];
  const err = (m) => { if (errs.length < 50) errs.push(m); };
  const B = new Map(bins.map((b) => [b.code, b]));
  const sku = (c) => skus.get(c) || {};
  const perUnit = (c, uom) => { const s = sku(c); return uom === "L3" ? 1 : !s.L2inL3 ? NaN : uom === "L2" ? 1 / s.L2inL3 : uom === "L0" && s.L0inL2 ? 1 / (s.L0inL2 * s.L2inL3) : NaN; };
  const vol = (c, uom) => { const s = sku(c), v = uom === "L0" ? s.volL0 : uom === "L2" ? s.volL2 : s.volL3; return v > 0 ? v : NaN; };
  const kg = (c, uom) => { const s = sku(c); if (!s.L0wt) return 0; return uom === "L0" ? s.L0wt : uom === "L2" ? s.L0wt * (s.L0inL2 || 0) : uom === "L3" ? s.L0wt * (s.L0inL2 || 0) * (s.L2inL3 || 0) : 0; };
  const inScope = (sc = {}, b) => (!(sc.areas || []).length || sc.areas.map(up).includes(up(b.area))) && (!(sc.zones || []).length || sc.zones.map(up).includes(up(b.zone)))
    && (!(sc.binTypes || []).length || sc.binTypes.map(up).includes(up(b.binType)))
    && (!(sc.cells || []).length || sc.cells.map(up).includes(`${up(b.zone)}|${up(b.binType)}`));
  const maxKgOf = (b) => (o.checkWeight && b.maxKg > 0 && b.maxKg < 1e6 ? b.maxKg : null);

  // stock: bin -> list of {hu, sku, batch, bucket, price, iloc, uom, qty}
  const S = new Map();
  for (const [bin, ls] of stock) {
    // one line per pallet and stock (the DB can split the same stock over rows)
    const m = new Map();
    for (const l of ls) if (l.qty > 0) {
      // shelf stock sits on the bin's own HU (BIN_HU_<bin>): it's the bin, not a pallet
      const b = B.get(bin), hu = b && b.huType === "PALLET" && l.hu && !String(l.hu).startsWith("BIN_HU_") ? l.hu : null;
      const x = { hu, sku: l.sku, batch: up(l.batch), bucket: up(l.bucket), price: P(l.price), iloc: l.iloc || "", uom: l.uom, qty: l.qty };
      const k = [x.hu, x.sku, x.batch, x.bucket, x.price, x.iloc, x.uom].join("|");
      if (m.has(k)) m.get(k).qty += x.qty; else m.set(k, x);
    }
    S.set(bin, [...m.values()]);
  }
  const lockedBins = new Set([...stock].filter(([, ls]) => ls.some((l) => l.qty > 0 && l.locked)).map(([b]) => b));
  const total = () => [...S.values()].flat().reduce((t, l) => t + l.qty, 0);
  const before = total();
  const occBefore = new Map();
  for (const b of bins) {
    const ls = S.get(b.code) || [];
    if (b.huType === "PALLET") occBefore.set(b.code, ls.reduce((t, l) => t + perUnit(l.sku, l.uom) * l.qty, 0) / Math.max(1, Number(b.cap) || 1));
    else occBefore.set(b.code, b.volCC > 0 ? ls.reduce((t, l) => t + vol(l.sku, l.uom) * l.qty, 0) / b.volCC : NaN);
  }
  const heldBefore = new Set([...S].filter(([, ls]) => ls.length).map(([b]) => b));
  const palletsBefore = new Map([...S].map(([b, ls]) => [b, new Set([...ls.filter((l) => l.hu).map((l) => l.hu), ...leavingHus(b)]).size]));
  const sources = new Set(), targets = new Set(), mergedHus = new Set(), movedHus = new Set();
  const same = (l, p) => l.sku === p.sku && l.batch === up(p.batch) && l.uom === p.uom && l.bucket === up(p.bucket) && l.price === P(p.price) && l.iloc === (p.iloc || "");

  for (const [i, p] of plan.moves.entries()) {
    const f = B.get(p.fromBin), t = B.get(p.toBin), tag = `move ${i + 1} ${p.qty} ${p.uom} ${p.sku} ${p.fromBin}${p.hu ? "/" + p.hu : ""}->${p.toBin}${p.toHu ? "/" + p.toHu : ""}`;
    if (!f || !t) { err(`${tag}: unknown bin`); continue; }
    if (f.code === t.code) err(`${tag}: same bin`);
    if (!Number.isInteger(p.qty) || p.qty <= 0) err(`${tag}: qty not a positive whole number`);
    if (!inScope(o.from, f)) err(`${tag}: source outside the From choice`);
    if (!inScope(o.to, t)) err(`${tag}: target outside the To choice`);
    for (const b of [f, t]) {
      if (b.areaType !== "INVENTORY") err(`${tag}: ${b.code} not in an inventory area`);
      if (b.status !== "ACTIVE") err(`${tag}: ${b.code} is ${b.status}`);
      if (b.fixed) err(`${tag}: ${b.code} is a fixed bin`);
      if (lockedBins.has(b.code)) err(`${tag}: ${b.code} has stock locked by a task`);
    }
    if ((f.huType === "PALLET") !== (t.huType === "PALLET")) err(`${tag}: between a pallet bin and a shelf bin`);
    if (o.belowPct < 100 && !sources.has(f.code) && !(occBefore.get(f.code) < o.belowPct / 100 - 1e-9)) err(`${tag}: source ${(occBefore.get(f.code) * 100).toFixed(2)}% full, not under ${o.belowPct}%`);
    if (!heldBefore.has(t.code) && !targets.has(t.code)) {
      // the first move into a bin that was empty: allowed only as the option says
      const pos = (b) => Math.max(1, Number(b.cap) || 1);
      if (o.useEmpty === "none") err(`${tag}: target was empty and empty bins weren't allowed`);
      else if (o.useEmpty !== "any" && !(t.huType === "PALLET" ? pos(t) < pos(f) : t.volCC < f.volCC)) err(`${tag}: target was empty and isn't smaller than the bin being emptied`);
    }
    if (f.zone !== t.zone && allowed && !allowed(t, p.sku, p.uom, p.bucket)) err(`${tag}: search table doesn't allow it in ${t.zone}`);
    if (targets.has(f.code)) err(`${tag}: source already received stock`);
    if (sources.has(t.code)) err(`${tag}: target is a bin being emptied`);
    sources.add(f.code); targets.add(t.code);
    const fl = S.get(f.code) || [];
    const idx = fl.findIndex((l) => same(l, p) && (l.hu || null) === (p.hu || null) && l.qty >= p.qty);
    if (idx < 0) { err(`${tag}: source doesn't hold that on that pallet`); continue; }
    const line = fl[idx];
    line.qty -= p.qty; if (!line.qty) fl.splice(idx, 1);
    if (!S.has(t.code)) S.set(t.code, []);
    const tl = S.get(t.code);
    if (p.kind === "merge") {
      if (!tl.some((l) => l.hu === p.toHu)) err(`${tag}: target pallet ${p.toHu} isn't in ${t.code}`);
      mergedHus.add(`${t.code}|${p.toHu}`);
    } else if (p.kind === "pallet") {
      movedHus.add(`${t.code}|${p.toHu}`);
      if (leavingHus(f.code).has(p.hu)) err(`${tag}: pallet ${p.hu} has stock being picked, so it can't move whole`);
      if (p.toHu !== p.hu) err(`${tag}: a whole-pallet move must keep its pallet`);
    } else if (p.kind === "pour") {
      if (f.huType === "PALLET") err(`${tag}: pour from a pallet bin`);
    } else err(`${tag}: unknown kind ${p.kind}`);
    const dst = { ...line, hu: p.kind === "pour" ? null : p.toHu, qty: p.qty };
    const j = tl.findIndex((l) => same(l, dst) && l.hu === dst.hu);
    if (j >= 0) tl[j].qty += p.qty; else tl.push(dst);
  }
  // whole-pallet moves: the pallet left its source completely
  for (const p of plan.moves.filter((m) => m.kind === "pallet")) if ((S.get(p.fromBin) || []).some((l) => l.hu === p.hu)) err(`pallet ${p.hu} only partly moved out of ${p.fromBin}`);
  if (Math.abs(total() - before) > 1e-6) err(`stock not conserved: ${before} -> ${total()}`);

  let emptiedReal = 0;
  for (const code of sources) { if ((S.get(code) || []).length) err(`${code}: planned to empty but still holds ${(S.get(code) || []).length} line(s)`); else emptiedReal++; }
  for (const code of targets) {
    const b = B.get(code), ls = S.get(code) || [];
    const skuSet = new Set(ls.map((l) => l.sku)), keySet = new Set(ls.map((l) => `${l.sku}|${l.batch}`)), qset = new Set(ls.map((l) => `${l.sku}|${l.batch}|${l.bucket}|${l.price}`));
    if (b.multiSku === false && b.multiBatch === false && qset.size > 1) err(`${code}: strict bin ends with ${qset.size} different SKU/batch/bucket/price`);
    if (b.multiSku === false && skuSet.size > 1) err(`${code}: not multi-SKU but holds ${[...skuSet].join(", ")}`);
    if (b.multiBatch === false && [...skuSet].some((s) => [...keySet].filter((k) => k.startsWith(s + "|")).length > 1)) err(`${code}: not multi-batch but holds ${[...keySet].join(", ")}`);
    if (b.maxSku && skuSet.size > b.maxSku) err(`${code}: ${skuSet.size} SKUs > max ${b.maxSku}`);
    if (b.maxSkuBatch && keySet.size > b.maxSkuBatch) err(`${code}: ${keySet.size} SKU-batches > max ${b.maxSkuBatch}`);
    if (new Set(ls.map((l) => l.iloc)).size > 1) err(`${code}: mixes inventory owners`);
    const w = ls.reduce((t, l) => t + kg(l.sku, l.uom) * l.qty, 0), mk = maxKgOf(b);
    if (mk !== null && w > mk + 1e-6) err(`${code}: ${w.toFixed(1)} kg after, over ${mk} kg`);
    // the WMS refuses an IM that takes the bin's total over 100% of what it counts the bin can hold
    if (input.wmsUnit) {
      const u = [...ls, ...(leaving.get(code) || [])].reduce((t, l) => t + input.wmsUnit(code, l.sku, l.uom) * l.qty, 0);
      if (!(u <= 1 + 1e-6)) err(`${code}: ${(u * 100).toFixed(1)}% of its WMS capacity after, over 100%`);
    }
    if (b.huType === "PALLET") {
      const hus = new Map();
      for (const l of ls.filter((x) => x.hu)) { if (!hus.has(l.hu)) hus.set(l.hu, []); hus.get(l.hu).push(l); }
      const cap = Math.max(1, Number(b.cap) || 1);
      const held = new Set([...hus.keys(), ...leavingHus(code)]).size;
      if (held > cap && held > (palletsBefore.get(code) || 0)) err(`${code}: ${held} pallets in ${cap} position(s)`);
      for (const [hu, pl] of hus) {
        if (!mergedHus.has(`${code}|${hu}`) && !movedHus.has(`${code}|${hu}`)) continue; // a pallet the plan didn't touch
        const skuP = new Set(pl.map((l) => l.sku)), keyP = new Set(pl.map((l) => `${l.sku}|${l.batch}`)), qP = new Set(pl.map((l) => `${l.sku}|${l.batch}|${l.bucket}|${l.price}`));
        if (b.huMultiSku === false && b.huMultiBatch === false && qP.size > 1) err(`${code}/${hu}: strict pallet holds ${qP.size} different quants`);
        if (b.huMultiSku === false && skuP.size > 1) err(`${code}/${hu}: pallet not multi-SKU but holds ${[...skuP].join(", ")}`);
        if (b.huMultiBatch === false && [...skuP].some((s) => [...keyP].filter((k) => k.startsWith(s + "|")).length > 1)) err(`${code}/${hu}: pallet not multi-batch but holds ${[...keyP].join(", ")}`);
        const share = pl.reduce((t, l) => t + perUnit(l.sku, l.uom) * l.qty, 0);
        if (mergedHus.has(`${code}|${hu}`) && !(share <= 1 + 1e-6)) err(`${code}/${hu}: pallet ends ${(share * 100).toFixed(1)}% of a full pallet`);
      }
    } else {
      const v = ls.reduce((t, l) => t + vol(l.sku, l.uom) * l.qty, 0), cap = b.volCC * (o.fillPct || 100) / 100;
      if (!(v <= cap + 1e-6)) err(`${code}: ${v.toFixed(0)} cc after, over ${cap.toFixed(0)} cc`);
    }
  }
  if (emptiedReal !== plan.stats.binsEmptied) err(`plan says ${plan.stats.binsEmptied} bins emptied, replay empties ${emptiedReal}`);
  return { ok: !errs.length, errs, emptied: emptiedReal, moves: plan.moves.length };
}

module.exports = { validateRelocate };
