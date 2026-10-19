// Independent check of a pallet consolidation plan (pallet-merge.js palletPlan): replay every move in order on fresh
// stock, case moves (wave 1) then whole pallets (wave 2), and confirm nothing breaks. Written separately on purpose;
// shares no logic with the planner. Returns { ok, errs, emptied, moves } like relocate-check.js.
const up = (s) => String(s ?? "").trim().toUpperCase();
const P = (x) => (x === null || x === undefined || x === "" ? "" : String(Number(x)));
const TOL = 1e-6;

function validatePalletPlan(input, plan) {
  const { bins, stock, skus, allowed } = input, o = plan.opts || {};
  const leaving = input.leaving || new Map(), busy = input.busy || new Set(), emptyHus = input.emptyHus || new Map();
  const errs = [];
  const err = (m) => { if (errs.length < 50) errs.push(m); };
  const B = new Map(bins.map((b) => [b.code, b]));
  const sku = (c) => skus.get(c) || {};
  // one unit's share of a full pallet (best fit = L2inL3 cases); NaN = can't size
  const fillOf = (c, uom) => { const s = sku(c); return uom === "L3" ? 1 : !s.L2inL3 ? NaN : uom === "L2" ? 1 / s.L2inL3 : uom === "L0" && s.L0inL2 ? 1 / (s.L0inL2 * s.L2inL3) : NaN; };
  const kg = (c, uom) => { const s = sku(c); if (!s.L0wt) return 0; return uom === "L0" ? s.L0wt : uom === "L2" ? s.L0wt * (s.L0inL2 || 0) : uom === "L3" ? s.L0wt * (s.L0inL2 || 0) * (s.L2inL3 || 0) : 0; };
  const cellsOf = (x) => (Array.isArray(x) ? x : x?.cells || []).map(up);
  const inScope = (sc, b) => { const c = cellsOf(sc); return !c.length || c.includes(`${up(b.zone)}|${up(b.binType)}`); };
  const maxKgOf = (b) => (o.checkWeight !== false && b.maxKg > 0 && b.maxKg < 1e6 ? b.maxKg : null);
  const isPallet = (hu) => hu && !String(hu).startsWith("BIN_HU_");
  const wu = (bin, l) => (input.wmsUnit ? input.wmsUnit(bin, l.sku, l.uom) || 0 : 0);

  // fresh stock: bin -> lines { hu, sku, batch, bucket, inclusion, iloc, price, uom, qty }, one per pallet and stock
  const norm = (l) => ({ hu: isPallet(l.hu) ? l.hu : null, sku: l.sku, batch: up(l.batch), bucket: up(l.bucket), inclusion: up(l.inclusion), iloc: l.iloc || "", price: P(l.price), uom: l.uom, qty: l.qty });
  const same = (a, b) => a.hu === b.hu && a.sku === b.sku && a.batch === b.batch && a.bucket === b.bucket && a.inclusion === b.inclusion && a.iloc === b.iloc && a.price === b.price && a.uom === b.uom;
  const S = new Map(), G = new Map(), lockedHus = new Set(), lockedBins = new Set(busy);
  for (const [bin, ls] of stock) {
    const list = [];
    for (const l0 of ls) {
      if (!(l0.qty > 0)) continue;
      if (l0.locked) { lockedBins.add(bin); if (l0.hu) lockedHus.add(l0.hu); }
      const l = norm(l0), cur = list.find((x) => same(x, l));
      if (cur) cur.qty += l.qty; else list.push(l);
    }
    S.set(bin, list);
  }
  for (const [bin, ls] of leaving) G.set(bin, ls.filter((l) => l.qty > 0).map(norm));
  const leavingHus = (bin) => new Set((G.get(bin) || []).filter((l) => l.hu).map((l) => l.hu));
  const total = () => [...S.values()].flat().reduce((t, l) => t + l.qty, 0);
  const before = total();
  const use = (bin) => [...(S.get(bin) || []), ...(G.get(bin) || [])].reduce((t, l) => t + wu(bin, l) * l.qty, 0);
  const w0 = new Map([...new Set([...S.keys(), ...G.keys()])].map((b) => [b, use(b)]));
  const heldBefore = new Set([...S].filter(([b, ls]) => ls.length || (G.get(b) || []).length).map(([b]) => b));
  for (const b of G.keys()) if ((G.get(b) || []).length) heldBefore.add(b);
  const palletsBefore = (bin) => new Set([...(S.get(bin) || []).filter((l) => l.hu).map((l) => l.hu), ...leavingHus(bin)]).size;
  const pb = new Map([...B.keys()].map((b) => [b, palletsBefore(b)]));

  const common = (tag, f, t, lines) => {
    if (!f || !t) { err(`${tag}: unknown bin`); return false; }
    for (const b of [f, t]) {
      if (b.huType !== "PALLET") err(`${tag}: ${b.code} isn't a pallet bin`);
      if (b.status !== "ACTIVE") err(`${tag}: ${b.code} is ${b.status}`);
      if (b.fixed) err(`${tag}: ${b.code} is a fixed bin`);
      if (lockedBins.has(b.code)) err(`${tag}: ${b.code} has locked stock or stock arriving: nothing in or out`);
    }
    if (!inScope(o.from, f)) err(`${tag}: source outside the From choice`);
    if (!inScope(o.to, t)) err(`${tag}: target outside the To choice`);
    if (f.zone !== t.zone) {
      if (!o.crossZone) err(`${tag}: crosses from ${f.zone} to ${t.zone} with cross-zone off`);
      else if (allowed) for (const l of lines) if (!allowed(t, l.sku, l.uom, l.bucket)) err(`${tag}: search table doesn't allow ${l.sku} ${l.uom} ${l.bucket} in ${t.zone}`);
    }
    return true;
  };

  // ---- wave 1: case moves onto a pallet of like stock -------------------------------------------
  const in1 = new Map(), receivedHus = new Set(), givers = new Set(), targets1 = new Set();
  for (const [i, mv] of (plan.moves || []).entries()) {
    const f = B.get(mv.fromBin), t = B.get(mv.toBin), tag = `case move ${i + 1} ${mv.qty} ${mv.uom} ${mv.sku} ${mv.fromBin}/${mv.fromHu}->${mv.toBin}/${mv.toHu}`;
    const l = norm({ ...mv, hu: mv.fromHu });
    if (!common(tag, f, t, [l])) continue;
    if (!Number.isInteger(mv.qty) || mv.qty <= 0) err(`${tag}: qty not a positive whole number`);
    if (l.inclusion && l.inclusion !== "INCLUDED") err(`${tag}: moves ${l.inclusion} stock`);
    if (lockedHus.has(mv.fromHu) || lockedHus.has(mv.toHu)) err(`${tag}: a pallet locked by a task`);
    if (leavingHus(f.code).has(mv.fromHu) || leavingHus(t.code).has(mv.toHu)) err(`${tag}: a pallet with stock being picked`);
    if (mv.fromHu === mv.toHu) err(`${tag}: onto itself`);
    if (receivedHus.has(mv.fromHu)) err(`${tag}: gives from a pallet that received cases`);
    if (givers.has(mv.toHu)) err(`${tag}: pours onto a pallet that gives its cases away`);
    const fl = S.get(f.code) || [], idx = fl.findIndex((x) => same(x, l) && x.qty >= mv.qty);
    if (idx < 0) { err(`${tag}: source pallet doesn't hold that`); continue; }
    const tl = S.get(t.code) || [];
    const onto = tl.filter((x) => x.hu === mv.toHu);
    if (!onto.length) { err(`${tag}: target pallet ${mv.toHu} isn't in ${t.code}`); continue; }
    // only like stock merges: the target pallet holds the same SKU, batch, bucket, price, owner and inclusion only
    if (onto.some((x) => x.sku !== l.sku || x.batch !== l.batch || x.bucket !== l.bucket || x.price !== l.price || x.iloc !== l.iloc || x.inclusion !== l.inclusion))
      err(`${tag}: target pallet holds other stock`);
    fl[idx].qty -= mv.qty; if (!fl[idx].qty) fl.splice(idx, 1);
    const dst = { ...l, hu: mv.toHu, qty: mv.qty }, j = tl.findIndex((x) => same(x, dst));
    if (j >= 0) tl[j].qty += mv.qty; else tl.push(dst);
    S.set(t.code, tl);
    // the IM upload counts a destination's stock before any of the wave leaves it: start + everything poured in
    in1.set(t.code, (in1.get(t.code) || 0) + wu(t.code, l) * mv.qty);
    receivedHus.add(`${mv.toHu}`); givers.add(mv.fromHu); targets1.add(t.code);
  }
  for (const [bin, add] of in1) if (!((w0.get(bin) || 0) + add <= 1 + TOL)) err(`${bin}: ${(((w0.get(bin) || 0) + add) * 100).toFixed(1)}% of its WMS capacity in the case moves' upload, over 100%`);
  // a pallet poured from is poured completely (the plan counts it freed)
  for (const hu of givers) for (const [bin, ls] of S) if (ls.some((x) => x.hu === hu)) err(`${bin}/${hu}: only partly poured`);
  const w1 = new Map([...new Set([...S.keys(), ...G.keys()])].map((b) => [b, use(b)]));

  // ---- wave 2: whole pallets ------------------------------------------------------------------
  const in2 = new Map(), sources2 = new Set(), targets2 = new Set(), moved = new Map(); // bin -> HUs moved in
  for (const [i, mv] of (plan.pack?.moves || []).entries()) {
    const f = B.get(mv.fromBin), t = B.get(mv.toBin), tag = `pallet move ${i + 1} ${mv.hu} ${mv.fromBin}->${mv.toBin}`;
    const fl = S.get(mv.fromBin) || [], lines = fl.filter((x) => x.hu === mv.hu);
    if (!common(tag, f, t, lines)) continue;
    if (f.code === t.code) err(`${tag}: same bin`);
    if (!lines.length) { err(`${tag}: ${mv.fromBin} doesn't hold that pallet`); continue; }
    if (lockedHus.has(mv.hu)) err(`${tag}: pallet locked by a task`);
    if (leavingHus(f.code).has(mv.hu)) err(`${tag}: pallet has stock being picked, so it can't move whole`);
    if (lines.some((x) => x.inclusion && x.inclusion !== "INCLUDED")) err(`${tag}: pallet holds stock that isn't INCLUDED`);
    if (targets2.has(f.code)) err(`${tag}: source already received a pallet`);
    if (sources2.has(t.code)) err(`${tag}: target is a bin being emptied`);
    if (heldBefore.has(t.code) && !(S.get(t.code) || []).length && !(G.get(t.code) || []).length) err(`${tag}: target was emptied by this plan, then refilled`);
    if (!heldBefore.has(t.code) && !targets2.has(t.code)) {
      // a bin empty from the start only pays when smaller than the one being emptied
      if (!(Math.max(1, Number(t.cap) || 1) < Math.max(1, Number(f.cap) || 1))) err(`${tag}: target was empty and isn't smaller`);
    }
    sources2.add(f.code); targets2.add(t.code);
    S.set(f.code, fl.filter((x) => x.hu !== mv.hu));
    const tl = S.get(t.code) || [];
    tl.push(...lines.map((x) => ({ ...x })));
    S.set(t.code, tl);
    in2.set(t.code, (in2.get(t.code) || 0) + lines.reduce((s, x) => s + wu(t.code, x) * x.qty, 0));
    if (!moved.has(t.code)) moved.set(t.code, new Set());
    moved.get(t.code).add(mv.hu);
  }
  for (const [bin, add] of in2) if (!((w1.get(bin) || 0) + add <= 1 + TOL)) err(`${bin}: ${(((w1.get(bin) || 0) + add) * 100).toFixed(1)}% of its WMS capacity in the whole-pallet upload, over 100%`);
  if (Math.abs(total() - before) > 1e-6) err(`stock not conserved: ${before} -> ${total()}`);

  // ---- every bin that received: rules after the plan ---------------------------------------------
  for (const code of new Set([...targets1, ...targets2])) {
    const b = B.get(code), ls = [...(S.get(code) || []), ...(G.get(code) || [])];
    const skuSet = new Set(ls.map((l) => l.sku)), keySet = new Set(ls.map((l) => `${l.sku}|${l.batch}`)), qset = new Set(ls.map((l) => `${l.sku}|${l.batch}|${l.bucket}|${l.price}`));
    if (b.multiSku === false && b.multiBatch === false && qset.size > 1) err(`${code}: strict bin ends with ${qset.size} different SKU/batch/bucket/price`);
    if (b.multiSku === false && skuSet.size > 1) err(`${code}: not multi-SKU but holds ${[...skuSet].join(", ")}`);
    if (b.multiBatch === false && [...skuSet].some((s) => [...keySet].filter((k) => k.startsWith(s + "|")).length > 1)) err(`${code}: not multi-batch but holds ${[...keySet].join(", ")}`);
    if (b.maxSku && skuSet.size > b.maxSku) err(`${code}: ${skuSet.size} SKUs > max ${b.maxSku}`);
    if (b.maxSkuBatch && keySet.size > b.maxSkuBatch) err(`${code}: ${keySet.size} SKU-batches > max ${b.maxSkuBatch}`);
    if (new Set(ls.map((l) => l.iloc)).size > 1) err(`${code}: mixes inventory owners`);
    const w = ls.reduce((t, l) => t + kg(l.sku, l.uom) * l.qty, 0), mk = maxKgOf(b);
    if (mk !== null && w > mk + 1e-6) err(`${code}: ${w.toFixed(1)} kg after, over ${mk} kg`);
    const hus = new Map();
    for (const l of ls.filter((x) => x.hu)) { if (!hus.has(l.hu)) hus.set(l.hu, []); hus.get(l.hu).push(l); }
    if (targets2.has(code)) {
      // positions: pallets (with stock being picked too), loose stock as one, empty pallet HUs the floor must clear first
      const cap = Math.max(1, Number(b.cap) || 1), loose = ls.some((l) => !l.hu) ? 1 : 0, held = hus.size + loose + (emptyHus.get(code) || []).length;
      if (held > cap) err(`${code}: ${held} pallets in ${cap} position(s)`);
    }
    for (const [hu, pl] of hus) {
      const got = receivedHus.has(hu), came = moved.get(code)?.has(hu);
      if (!got && !came) continue; // a pallet the plan didn't touch
      const skuP = new Set(pl.map((l) => l.sku)), keyP = new Set(pl.map((l) => `${l.sku}|${l.batch}`)), qP = new Set(pl.map((l) => `${l.sku}|${l.batch}|${l.bucket}|${l.price}`));
      if (b.huMultiSku === false && b.huMultiBatch === false && qP.size > 1) err(`${code}/${hu}: strict pallet holds ${qP.size} different quants`);
      if (b.huMultiSku === false && skuP.size > 1) err(`${code}/${hu}: pallet not multi-SKU but holds ${[...skuP].join(", ")}`);
      if (b.huMultiBatch === false && [...skuP].some((s) => [...keyP].filter((k) => k.startsWith(s + "|")).length > 1)) err(`${code}/${hu}: pallet not multi-batch but holds ${[...keyP].join(", ")}`);
      // best fit: a pallet that received cases may not go over 100% of a full pallet
      const fill = pl.filter((l) => !l.gone).reduce((t, l) => t + fillOf(l.sku, l.uom) * l.qty, 0);
      if (got && !(fill <= 1 + TOL)) err(`${code}/${hu}: pallet ends at ${(fill * 100).toFixed(1)}% of best fit`);
    }
  }
  let emptied = 0;
  for (const code of heldBefore) if (!(S.get(code) || []).length && !(G.get(code) || []).length) emptied++;
  if (plan.stats && emptied !== plan.stats.binsEmptied) err(`plan says ${plan.stats.binsEmptied} bins emptied, replay empties ${emptied}`);
  if (plan.stats && givers.size !== plan.stats.palletsFreed) err(`plan says ${plan.stats.palletsFreed} pallets freed, replay pours ${givers.size}`);
  // positions: the brief's net count, recomputed from the replay
  const capOf = (c) => Math.max(1, Number(B.get(c)?.cap) || 1);
  let pos = 0;
  for (const code of B.keys()) {
    const now = (S.get(code) || []).length || (G.get(code) || []).length, had = heldBefore.has(code);
    if (had && !now) pos += capOf(code);
    else if (!had && now) pos -= capOf(code);
    else if (had) pos += Math.min(capOf(code), pb.get(code)) - Math.min(capOf(code), palletsBefore(code)); // merged away frees one, moved in takes one
  }
  if (plan.stats && pos !== plan.stats.positionsFreed) err(`plan says ${plan.stats.positionsFreed} positions freed, replay frees ${pos}`);
  return { ok: !errs.length, errs, emptied, moves: (plan.moves || []).length + (plan.pack?.moves || []).length };
}

module.exports = { validatePalletPlan };
