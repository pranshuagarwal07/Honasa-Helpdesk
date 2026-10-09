// Bulk fill: an Append/Reset sheet that brings each zone's bins up to a target fill, with
// classes weighted by the warehouse's own search sequence. Port of the appendinv skill's build_fill.py.
const { todayKey, addDays } = require("../core/util");
const { zoneSeq } = require("../wms/search");

// fill rate by rack level, lowest first; mean ~1 so each zone still lands on target
const LEVEL_BIAS = [1.2, 1.17, 1.05, 0.89, 0.69];


// deterministic RNG so the same seed gives the same sheet
function rngFrom(seed) {
  let a = seed >>> 0;
  const next = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { random: next, int: (n) => Math.floor(next() * n), choice: (arr) => arr[Math.floor(next() * arr.length)] };
}

// even stride over a location-sorted list, so empties sit between filled bins
function scatter(list, n) {
  if (n <= 0) return [];
  if (n >= list.length) return [...list];
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.min(list.length - 1, Math.floor(i * step + step / 2))]);
}

function build(m, o) {
  const rng = rngFrom(Number(o.seed) || 20260916);
  const today = todayKey(), minExp = addDays(today, Number(o.shelfLifeDays) || 0);
  const bucket = o.bucket || "Good";
  const areaTypes = new Set(o.areaTypes?.length ? o.areaTypes : ["INVENTORY"]);
  const include = o.skuInclude ? new RegExp(o.skuInclude) : null;
  const exclude = o.skuExclude ? new RegExp(o.skuExclude) : null;
  const skipped = { skus: {}, zones: [] };
  const skipSku = (why, code) => { (skipped.skus[why] ||= []).push(code); };

  // usable SKUs and their batches
  const batchesBySku = new Map();
  for (const b of m.batches.values()) {
    const k = `${b.sku_code}|${b.code}`;
    if (b.active !== true || !b.exp || !b.mfg || b.exp <= minExp || b.mfg > today || m.prodLots.has(k)) continue;
    if (!batchesBySku.has(b.sku_code)) batchesBySku.set(b.sku_code, []);
    batchesBySku.get(b.sku_code).push({ ...b, hasProd: m.prodParents.has(k) });
  }
  for (const [s, list] of batchesBySku) {
    list.sort((a, b) => (b.hasProd - a.hasProd) || a.exp.localeCompare(b.exp));
    const withProd = list.filter((b) => b.hasProd);
    batchesBySku.set(s, (withProd.length ? withProd : list).slice(0, Number(o.maxBatchesPerSku) || 6));
  }
  const known = [];
  for (const s of m.skus.values()) {
    if (!s.active) continue;
    if (include && !include.test(s.code)) continue;
    if (exclude && exclude.test(s.code)) continue;
    if (!s.clazz) { skipSku(`No ${m.classType} class`, s.code); continue; }
    if (!batchesBySku.has(s.code)) { skipSku(`No active batch with over ${o.shelfLifeDays} days shelf life`, s.code); continue; }
    known.push(s);
  }
  let poolL2 = known.filter((s) => !s.base && s.L2inL3 >= 1), poolL0 = known.filter((s) => s.base && s.L0inL2 > 0);
  if (!poolL2.length) poolL2 = known.filter((s) => s.L2inL3 >= 1); // node without a base-SKU split
  if (!poolL0.length) poolL0 = known.filter((s) => s.L0inL2 > 0);

  // target bins, grouped by zone
  const zones = new Map();
  for (const b of m.bins) {
    if (!areaTypes.has(b.areaType) || b.status !== "ACTIVE" || !b.zoneActive || !b.areaActive) continue;
    const k = `${b.zone}|${b.huType}`;
    if (!zones.has(k)) zones.set(k, []);
    zones.get(k).push(b);
  }
  const target = Math.max(0, Math.min(1, Number(o.target)));
  const plan = [], summary = [];
  for (const [, zb] of [...zones].sort((a, b) => a[0].localeCompare(b[0]))) {
    const z = zb[0], huType = z.huType, uom = huType === "PALLET" ? "L2" : huType === "BIN" ? "L0" : null;
    const occ = zb.filter((b) => m.occupied.has(b.code)).length;
    const base = { zone: z.zone, area: z.area, huType, uom, bins: zb.length, occupiedNow: occ };
    if (!uom) { skipped.zones.push({ ...base, why: `Bin type holds ${huType || "unknown"} units, which fills don't cover` }); continue; }
    const classes = [...new Set((uom === "L2" ? poolL2 : poolL0).map((s) => s.clazz))];
    if (!classes.some((c) => zoneSeq(m, z, c, uom, bucket) !== null)) {
      skipped.zones.push({ ...base, why: `The search table allows no ${uom} ${bucket} stock of any usable class here` }); continue;
    }
    const want = Math.max(0, Math.round(zb.length * target) - occ);
    const free = zb.filter((b) => !m.occupied.has(b.code)).sort((a, b) => a.code.localeCompare(b.code));
    const levels = [...new Set(free.map((b) => b.level).filter((l) => l !== null))].sort((a, b) => a - b);
    let chosen;
    if (levels.length > 1) {
      const tiers = levels.map((lv, i) => ({ bins: free.filter((b) => b.level === lv), bias: LEVEL_BIAS[Math.min(i, LEVEL_BIAS.length - 1)] }));
      const raw = tiers.reduce((t, x) => t + x.bins.length * x.bias, 0);
      const k = raw ? want / raw : 0;
      chosen = new Set(tiers.flatMap((t) => scatter(t.bins, Math.round(t.bins.length * t.bias * k))));
      if (chosen.size < want) scatter(free.filter((b) => !chosen.has(b)), want - chosen.size).forEach((b) => chosen.add(b));
      chosen = [...chosen].sort((a, b) => a.code.localeCompare(b.code)).slice(0, want);
    } else {
      chosen = scatter(free, want);
    }
    chosen.forEach((b) => plan.push({ bin: b, zone: z, uom }));
    summary.push({ ...base, newBins: chosen.length, finalBins: occ + chosen.length,
      nowPct: +(occ / zb.length * 100).toFixed(1), finalPct: +((occ + chosen.length) / zb.length * 100).toFixed(1) });
  }

  // class weights follow the node's own search sequence, so seq-1 classes dominate
  const cursor = new Map(), bcursor = new Map();
  function nextSku(zBin, uom, pool) {
    const seqs = [...new Set(pool.map((s) => s.clazz))].map((c) => [c, zoneSeq(m, zBin, c, uom, bucket)]).filter(([, s]) => s !== null);
    if (!seqs.length) return null;
    const best = Math.min(...seqs.map(([, s]) => s));
    const opts = seqs.map(([c, s]) => [c, s === best ? 8 : s === best + 1 ? 3 : 1, pool.filter((p) => p.clazz === c).map((p) => p.code).sort()])
      .filter(([, , members]) => members.length);
    if (!opts.length) return null;
    let r = rng.random() * opts.reduce((t, [, w]) => t + w, 0);
    const pick = opts.find(([, w]) => (r -= w) <= 0) || opts[opts.length - 1];
    const k = `${zBin.zone}|${uom}|${pick[0]}`;
    const i = cursor.has(k) ? cursor.get(k) : rng.int(pick[2].length);
    cursor.set(k, i + 1);
    return pick[2][i % pick[2].length];
  }
  function nextBatch(s) {
    const list = batchesBySku.get(s);
    const i = bcursor.has(s) ? bcursor.get(s) : rng.int(list.length);
    bcursor.set(s, i + 1);
    return list[i % list.length];
  }

  const common = { bucket, inclusion: o.inclusion || "INCLUDED", op: o.op === "RESET" ? "RESET" : "APPEND" };
  const rows = [];
  let huN = 0;
  // pallet code = prefix + counter, zero-padded so the whole code is huLength long
  const huDigits = Math.max(1, (Number(o.huLength) || o.huPrefix.length + 5) - o.huPrefix.length);
  const byZone = new Map();
  for (const p of plan) { if (!byZone.has(p.zone.zone + p.uom)) byZone.set(p.zone.zone + p.uom, []); byZone.get(p.zone.zone + p.uom).push(p); }
  for (const items of byZone.values()) {
    const { zone, uom } = items[0];
    if (uom === "L2") {
      for (let i = 0; i < items.length;) {
        const s = nextSku(zone, "L2", poolL2);
        if (!s) break;
        const b = nextBatch(s), full = Math.floor(m.skus.get(s).L2inL3);
        const run = Math.min(rng.choice([1, 1, 2, 2, 3]), items.length - i); // a reserve SKU spans a few bins
        for (let r = 0; r < run; r++, i++) {
          const bin = items[i].bin, n = bin.cap < 2 || rng.random() > 0.25 ? bin.cap : bin.cap - 1;
          for (let pn = 0; pn < n; pn++) {
            let qty = full;
            if (pn === n - 1 && rng.random() < 0.3) qty = Math.max(1, Math.floor(full * (0.4 + rng.random() * 0.5)));
            huN++;
            rows.push({ ...common, bin: bin.code, hu: `${o.huPrefix}${String(huN).padStart(huDigits, "0")}`, hukind: o.huKind, sku: s, qty, uom: "L2", batch: b.code, mfg: b.mfg, exp: b.exp });
          }
        }
      }
    } else {
      for (const { bin } of items) {
        const s = nextSku(zone, "L0", poolL0);
        if (!s) continue;
        const b = nextBatch(s), sk = m.skus.get(s);
        let qty = Math.floor(sk.L0inL2) * rng.choice([1, 1, 2, 2, 3]);
        if (sk.L0wt && sk.L0wt > 0.02) qty = Math.min(qty, Math.floor((bin.maxKg || Number(o.maxKgPerBin) || 35) / sk.L0wt));
        qty = Math.max(5, Math.min(qty, Number(o.maxEachesPerBin) || 600));
        rows.push({ ...common, bin: bin.code, hu: "", hukind: "", sku: s, qty, uom: "L0", batch: b.code, mfg: b.mfg, exp: b.exp });
      }
    }
  }
  rows.forEach((r, i) => { r.row = i + 2; });

  const totals = {
    rows: rows.length, bins: new Set(rows.map((r) => r.bin)).size, skus: new Set(rows.map((r) => r.sku)).size,
    batches: new Set(rows.map((r) => `${r.sku}|${r.batch}`)).size, newHUs: rows.filter((r) => r.hu).length,
    poolL2: poolL2.length, poolL0: poolL0.length,
  };
  const hus = rows.filter((r) => r.hu);
  const huCodes = hus.length ? { length: o.huPrefix.length + huDigits, digits: huDigits, first: hus[0].hu, last: hus[hus.length - 1].hu,
    overflow: huN > 10 ** huDigits - 1 } : null;
  return { rows, huCodes, summary, skipped: { zones: skipped.zones, skus: Object.entries(skipped.skus).map(([why, codes]) => ({ why, count: codes.length, sample: codes.slice(0, 12) })) }, totals };
}

module.exports = { build };
