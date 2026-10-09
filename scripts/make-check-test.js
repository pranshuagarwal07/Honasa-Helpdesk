// Builds a large Append/Reset sheet for a UAT warehouse that exercises every Check-a-sheet rule:
// clean rows, top-ups into occupied bins, and a known number of planted violations.
// Writes Check_test_<wh>.xlsx (drop it on Check a sheet) and Check_test_<wh>_answer_key.xlsx.
// Needs the app running against UAT:  node scripts/make-check-test.js <whId> [port]
// Bins are picked by pallet capacity (1, 2, 3+), not bin-type name, so any node layout works.
const path = require("path");
const ExcelJS = require("exceljs");
const { Client } = require("pg");
const env = require("../config/envs.json").SBX_HONASA_UAT;

// OUT_DIR writes somewhere else, e.g. to re-run a check without replacing the sheet being tested
const OUT = process.env.OUT_DIR || path.join(__dirname, "..", "samples", "check-tests");
const WH = process.argv[2] || "1232206196556382", BASE = `http://localhost:${process.argv[3] || 8765}`;
if (!/^[0-9]+$/.test(WH)) { console.error("usage: node make-check-test.js <whId> [port]"); process.exit(1); }
let seed = 20261003;
const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };

(async () => {
  const get = async (p) => { const r = await (await fetch(BASE + p)).json(); if (r.error) throw new Error(r.error); return r; };
  const c = await get(`/api/inv/catalog?whId=${WH}&refresh=1`);
  const snap = await get(`/api/inv/snapshot?whId=${WH}`);
  const db = new Client({ host: env.host, user: env.user, password: env.password, database: env.databases.wms, ssl: { rejectUnauthorized: false } });
  await db.connect();
  const hus = (await db.query(`SELECT "binCode", count(DISTINCT "huCode")::int AS n FROM inventory WHERE "whId" = $1 AND "deletedAt" IS NULL
                               AND qty > 0 AND "huCode" IS NOT NULL GROUP BY 1`, [WH])).rows;
  const flags = (await db.query(`SELECT code, "huMultiSku", "huMultiBatch" FROM storage_bin_type WHERE "whId" = $1`, [WH])).rows;
  await db.end();
  const palletsIn = new Map(hus.map((h) => [h.binCode, h.n]));
  const typeFlags = new Map(flags.map((f) => [f.code, f]));

  // batches comfortably past the 180-day shelf-life check
  const minExp = new Date(Date.now() + 200 * 86400000).toISOString().slice(0, 10);
  const B = (b) => ({ code: b[0], zone: b[1], areaType: b[3], type: b[4], huType: b[5], cap: b[6], status: b[7], multiSku: b[9], multiBatch: b[10], id: b[11], zoneId: b[12], areaId: b[13] });
  const bins = c.bins.map(B).filter((b) => b.status === "ACTIVE" && b.areaType === "INVENTORY");
  const skuRec = new Map(c.skus.map((s) => [s[0], { code: s[0], clazz: s[1], active: s[2], base: s[3], L0inL2: s[4], L2inL3: s[5] }]));
  const goodBatches = (sku) => (c.batches[sku] || []).filter((b) => b[3] && !b[5] && b[1] && b[2] && b[2] > minExp && b[1] <= c.today);
  const allowed = (cls, uom, bin) => { const e = c.search[`${cls}|${uom}|GOOD`] || {}; return [e.B?.[bin.id], e.Z?.[bin.zoneId], e.A?.[bin.areaId]].some((x) => x !== undefined); };
  // pallet SKUs: case SKUs with a whole L2inL3; shelf SKUs: base SKUs. Never one SKU at both UOMs (check 8c).
  const palletSkus = [...skuRec.values()].filter((s) => s.active && s.clazz && !s.base && s.L2inL3 >= 4 && Number.isInteger(s.L2inL3) && goodBatches(s.code).length >= 2);
  const shelfSkus = [...skuRec.values()].filter((s) => s.active && s.clazz && s.base && s.L0inL2 > 0 && goodBatches(s.code).length >= 1);
  const usedBins = new Set(), usedSku = new Map(); // sku -> uom
  const okFor = (s, uom, bin) => allowed(s.clazz, uom, bin) && (!usedSku.has(s.code) || usedSku.get(s.code) === uom);
  const skuFor = (pool, uom, bin, not = []) => { for (let i = 0; i < 400; i++) { const s = pick(pool); if (!not.includes(s.code) && okFor(s, uom, bin)) return s; } return null; };
  const take = (list, n, f = () => true) => { const out = []; for (const b of list) { if (out.length >= n) break; if (!usedBins.has(b.code) && f(b)) { usedBins.add(b.code); out.push(b); } } return out; };

  const emptyShelf = shuffle(bins.filter((b) => b.huType === "BIN" && !c.stock[b.code]));
  // occupied bins holding exactly one SKU-batch; "good" = that batch passes every date check too
  const okSku = (sku, uom) => { const s = skuRec.get(sku); return s?.active && s.clazz && (uom === "L0" ? s.L0inL2 > 0 : Number.isInteger(s.L2inL3)); };
  const occupiedAny = shuffle(bins.filter((b) => b.huType === "PALLET" && c.stock[b.code]?.length === 1 && c.stock[b.code][0][2] === "L2" && okSku(c.stock[b.code][0][0], "L2")));
  const occupiedGood = occupiedAny.filter((b) => goodBatches(c.stock[b.code][0][0]).some((x) => x[0] === c.stock[b.code][0][1]));
  const occShelf = shuffle(bins.filter((b) => b.huType === "BIN" && c.stock[b.code]?.length === 1 && c.stock[b.code][0][2] === "L0" && okSku(c.stock[b.code][0][0], "L0")));
  const altBatch = (b) => goodBatches(c.stock[b.code][0][0]).find((x) => x[0] !== c.stock[b.code][0][1]);
  const shelfAlt = (b) => (!usedSku.has(c.stock[b.code][0][0]) || usedSku.get(c.stock[b.code][0][0]) === "L0") && altBatch(b);

  const rows = [];
  let hn = 0;
  const prefix = "T" + c.suggestedPrefix.slice(1);
  const newHu = () => `${prefix}${String(++hn).padStart(5, "0")}`;
  // batch is a batch-master row [code, mfg, exp, ...]
  const add = (cat, expect, bin, s, qty, batch, uom = "L2", hu) => {
    usedSku.set(s.code, uom);
    rows.push({ cat, expect, bin: bin.code, hu: uom === "L0" ? "" : hu || newHu(), sku: s.code, qty, uom, batch });
    return rows[rows.length - 1].hu;
  };
  const batchOf = (s, i = 0) => goodBatches(s.code)[i % goodBatches(s.code).length];
  const sameBatch = (sku, code) => goodBatches(sku).find((x) => x[0] === code);
  const reuse = (sku) => !usedSku.has(sku) || usedSku.get(sku) === "L2";

  // Cases that need scarce bins go first. Empty storage pallet bins by capacity: 1, 2, 3+.
  const emptyCap = (f) => shuffle(bins.filter((b) => b.huType === "PALLET" && !c.stock[b.code] && f(b.cap)));
  const e1 = emptyCap((n) => n === 1), e2 = emptyCap((n) => n === 2), e3 = emptyCap((n) => n >= 3);
  // occupied bins are scarce on a near-empty node: share them across the cases that need them
  const share = (pool, cases) => Math.min(10, Math.max(1, Math.floor(pool.length / cases)));
  const qP = share(occupiedAny, 4), qS = share(occShelf, 3);
  const room = (b) => (palletsIn.get(b.code) || 1) < b.cap;
  const stockOf = (b) => c.stock[b.code][0]; // [sku, batch, uom, qty]

  // -- on top of current stock ----------------------------------------------------
  // 6c vs stock: same SKU, another batch, into an occupied single-batch pallet bin with room
  for (const b of take(occupiedAny, qP, (b) => !b.multiBatch && room(b) && reuse(stockOf(b)[0]) && altBatch(b))) {
    const s = skuRec.get(stockOf(b)[0]);
    add("6c: a second batch on top of the stock (pallet bin)", "HARD 6c + SOFT 6a", b, s, s.L2inL3, altBatch(b));
  }
  // same on shelf bins (L0), where there is no pallet capacity to trip over
  for (const b of take(occShelf, qS, (b) => !b.multiBatch && shelfAlt(b))) {
    const s = skuRec.get(stockOf(b)[0]);
    add("6c: a second batch on top of the stock (shelf bin)", "HARD 6c + SOFT 6a", b, s, Math.max(5, Math.floor(s.L0inL2) * 2), shelfAlt(b), "L0");
  }
  // 6b vs stock: a different SKU into an occupied single-SKU bin with room
  for (const b of take(occupiedAny, qP, (b) => !b.multiSku && room(b))) {
    const s = skuFor(palletSkus, "L2", b, [stockOf(b)[0]]); if (!s) continue;
    add("6b: a second SKU on top of the stock (pallet bin)", "HARD 6b + SOFT 6a", b, s, s.L2inL3, batchOf(s));
  }
  for (const b of take(occShelf, qS, (b) => !b.multiSku)) {
    const s = skuFor(shelfSkus, "L0", b, [stockOf(b)[0]]); if (!s) continue;
    add("6b: a second SKU on top of the stock (shelf bin)", "HARD 6b + SOFT 6a", b, s, Math.max(5, Math.floor(s.L0inL2) * 2), batchOf(s), "L0");
  }
  // 5f: one more pallet (same SKU-batch) into a bin that is already full
  for (const b of take(occupiedGood, qP, (b) => !room(b) && reuse(stockOf(b)[0]))) {
    const s = skuRec.get(stockOf(b)[0]);
    add("5f: one more pallet into a full bin", "HARD 5f + SOFT 6a", b, s, s.L2inL3, sameBatch(s.code, stockOf(b)[1]));
  }
  // top-up: same SKU + batch as the stock, into a bin with a free pallet position -> yellow 6a only
  for (const b of take(occupiedGood, 25, (b) => room(b) && reuse(stockOf(b)[0]))) {
    const s = skuRec.get(stockOf(b)[0]);
    add("Top-up: same SKU-batch as the stock in the bin", "SOFT 6a", b, s, s.L2inL3, sameBatch(s.code, stockOf(b)[1]));
  }
  // shelf top-up: same SKU + batch as the shelf stock -> yellow 6a only
  for (const b of take(occShelf, 25, (b) => goodBatches(stockOf(b)[0]).some((x) => x[0] === stockOf(b)[1])
      && (!usedSku.has(stockOf(b)[0]) || usedSku.get(stockOf(b)[0]) === "L0"))) {
    const s = skuRec.get(stockOf(b)[0]);
    add("Top-up: same SKU-batch as the stock in the shelf bin", "SOFT 6a", b, s, Math.max(5, Math.floor(s.L0inL2) * 2), sameBatch(s.code, stockOf(b)[1]), "L0");
  }

  // -- empty pallet bins --------------------------------------------------------------
  // 5f: two pallets in a one-pallet bin
  for (const b of take(e1, 6)) {
    const s = skuFor(palletSkus, "L2", b); if (!s) continue;
    const bt = batchOf(s);
    add("5f: two pallets in a one-pallet bin", "HARD 5f", b, s, s.L2inL3, bt); add("5f: two pallets in a one-pallet bin", "HARD 5f", b, s, s.L2inL3, bt);
  }
  // 6f: mixed-SKU pallet where the bin type forbids it (also breaks 6b)
  for (const b of take(shuffle([...e1, ...e2]), 6, (b) => typeFlags.get(b.type)?.huMultiSku === false)) {
    const s1 = skuFor(palletSkus, "L2", b), s2 = s1 && skuFor(palletSkus, "L2", b, [s1.code]); if (!s2) continue;
    const hu = add("6f: two SKUs on one pallet", "HARD 6f + 6b", b, s1, Math.floor(s1.L2inL3 / 2), batchOf(s1));
    add("6f: two SKUs on one pallet", "HARD 6f + 6b", b, s2, Math.floor(s2.L2inL3 / 2), batchOf(s2), "L2", hu);
  }
  // 6g: one SKU, two batches on one pallet where the bin type forbids mixed batches (also breaks 6c)
  for (const b of take(e3, 6, (b) => typeFlags.get(b.type)?.huMultiBatch === false)) {
    const s = skuFor(palletSkus, "L2", b); if (!s) continue;
    const hu = add("6g: two batches on one pallet", "HARD 6g + 6c", b, s, Math.floor(s.L2inL3 / 2), batchOf(s, 0));
    add("6g: two batches on one pallet", "HARD 6g + 6c", b, s, Math.floor(s.L2inL3 / 2), batchOf(s, 1), "L2", hu);
  }
  // 6b in the sheet: two SKUs as two pallets in one empty single-SKU bin
  for (const b of take(e2, 8, (b) => !b.multiSku)) {
    const s1 = skuFor(palletSkus, "L2", b), s2 = s1 && skuFor(palletSkus, "L2", b, [s1.code]); if (!s2) continue;
    add("6b: two SKUs in one bin (both from the sheet)", "HARD 6b", b, s1, s1.L2inL3, batchOf(s1));
    add("6b: two SKUs in one bin (both from the sheet)", "HARD 6b", b, s2, s2.L2inL3, batchOf(s2));
  }
  // 6c in the sheet: one SKU, two batches, two pallets in one empty single-batch bin
  for (const b of take(e2, 8, (b) => !b.multiBatch)) {
    const s = skuFor(palletSkus, "L2", b); if (!s) continue;
    add("6c: two batches in one bin (both from the sheet)", "HARD 6c", b, s, s.L2inL3, batchOf(s, 0));
    add("6c: two batches in one bin (both from the sheet)", "HARD 6c", b, s, s.L2inL3, batchOf(s, 1));
  }
  // merge inside one bin: two ~30% pallets of one SKU-batch
  const merges = [];
  for (const b of take(e2, 8)) {
    const s = skuFor(palletSkus, "L2", b); if (!s) continue;
    const bt = batchOf(s), q = Math.max(1, Math.round(s.L2inL3 * 0.3));
    add("Merge: two partial pallets in one bin", "OK (merge candidate)", b, s, q, bt); add("Merge: two partial pallets in one bin", "OK (merge candidate)", b, s, q, bt);
    merges.push({ sku: s.code, batch: bt[0], pallets: 2, cases: 2 * q, bestFit: s.L2inL3, need: Math.ceil(2 * q / s.L2inL3), frees: 2 - Math.ceil(2 * q / s.L2inL3), sameBin: b.code });
  }
  // 9a: one pallet over best fit (120-150% of L2inL3)
  for (const b of take(e1, 12)) {
    const s = skuFor(palletSkus, "L2", b); if (!s) continue;
    add("9a: pallet over best fit", "SOFT 9a", b, s, Math.ceil(s.L2inL3 * (1.2 + rnd() * 0.3)), batchOf(s));
  }
  // merge across bins: one 20-45% pallet per bin, 2-4 bins, same SKU-batch
  const spare = shuffle([...e1, ...e3]);
  for (let g = 0; g < 20; g++) {
    const n = 2 + Math.floor(rnd() * 3), group = take(spare, n);
    if (group.length < n) break;
    const s = palletSkus.find((x) => okFor(x, "L2", group[0]) && group.every((b) => allowed(x.clazz, "L2", b)) && !usedSku.has(x.code));
    if (!s) continue;
    const bt = batchOf(s);
    let cases = 0;
    for (const b of group) { const q = Math.max(1, Math.round(s.L2inL3 * (0.2 + rnd() * 0.25))); cases += q; add("Merge: partial pallets of one SKU-batch over several bins", "OK (merge candidate)", b, s, q, bt); }
    merges.push({ sku: s.code, batch: bt[0], pallets: n, cases, bestFit: s.L2inL3, need: Math.ceil(cases / s.L2inL3), frees: n - Math.ceil(cases / s.L2inL3) });
  }
  // clean: full pallets into what's left, one SKU-batch per bin, filled to capacity
  for (const b of take(shuffle([...e2, ...e3, ...e1]), 40)) {
    const s = skuFor(palletSkus, "L2", b); if (!s) continue;
    const bt = batchOf(s);
    for (let i = 0; i < b.cap; i++) add("Clean: full pallets into an empty bin", "OK", b, s, s.L2inL3, bt);
  }

  // -- empty shelf bins ------------------------------------------------------------------
  const shelfBins = take(emptyShelf, 60);
  for (let i = 0; i < shelfBins.length;) {
    const s = skuFor(shelfSkus, "L0", shelfBins[i]); if (!s) { i++; continue; }
    const bt = batchOf(s), spread = rnd() < 0.3 ? 2 + Math.floor(rnd() * 2) : 1;
    for (let k = 0; k < spread && i < shelfBins.length; k++, i++) {
      if (!allowed(s.clazz, "L0", shelfBins[i])) continue;
      add(spread > 1 ? "Clean shelf: one SKU-batch over several shelf bins" : "Clean shelf", "OK", shelfBins[i], s, Math.max(5, Math.floor(s.L0inL2) * 2), bt, "L0");
    }
  }

  shuffle(rows); // so the problems aren't in blocks
  rows.forEach((r, i) => { r.row = i + 2; });

  // ---- the sheet: exactly this warehouse's template ----
  const headers = snap.template.headers;
  // this warehouse's own pallet HU kind (the upload checks it exists and contains PALLET)
  const palletKind = (c.kinds || []).find((k) => k === "PALLET") || (c.kinds || []).find((k) => /PALLET/i.test(k)) || "PALLET";
  const val = (h, r) => {
    const k = h.toLowerCase();
    if (k.startsWith("bin code")) return r.bin; if (k.startsWith("hu kind")) return r.hu ? palletKind : null; if (k.startsWith("hu code")) return r.hu || null;
    if (k.startsWith("sku code")) return r.sku; if (k.startsWith("quantity")) return r.qty; if (k.startsWith("uom")) return r.uom;
    if (k.startsWith("bucket")) return "Good"; if (k.startsWith("inclusion")) return "INCLUDED"; if (k.startsWith("operation")) return "APPEND";
    if (k.startsWith("batch")) return r.batch[0];
    if (k.startsWith("manufacture")) return new Date(r.batch[1] + "T00:00:00Z"); if (k.startsWith("expiry")) return new Date(r.batch[2] + "T00:00:00Z");
    return null;
  };
  const wb = new ExcelJS.Workbook(), ws = wb.addWorksheet("Sheet1", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = headers.map((h) => ({ header: h, width: Math.max(12, Math.min(40, h.length + 2)) }));
  ws.getRow(1).font = { bold: true };
  rows.forEach((r) => ws.addRow(headers.map((h) => val(h, r))));
  headers.forEach((h, i) => { if (/date/i.test(h)) ws.getColumn(i + 1).numFmt = "dd/mm/yyyy"; });
  const file = path.join(OUT, `Check_test_${WH}.xlsx`);
  await wb.xlsx.writeFile(file);

  // ---- answer key ----
  const key = new ExcelJS.Workbook();
  const sum = key.addWorksheet("Expected");
  sum.columns = [{ header: "Case", width: 54 }, { header: "Expected", width: 22 }, { header: "Rows", width: 8 }, { header: "Bins", width: 8 }];
  const cats = new Map();
  rows.forEach((r) => { if (!cats.has(r.cat)) cats.set(r.cat, { expect: r.expect, rows: 0, bins: new Set() }); cats.get(r.cat).rows++; cats.get(r.cat).bins.add(r.bin); });
  [...cats].forEach(([k, v]) => sum.addRow([k, v.expect, v.rows, v.bins.size]));
  sum.addRow([]); sum.addRow(["Total rows", "", rows.length]);
  sum.addRow(["Merge groups planted", "", merges.length]); sum.addRow(["Pallets freeable from planted merges", "", merges.reduce((t, m) => t + m.frees, 0)]);
  sum.addRow([]); sum.addRow(["Note: the Consolidation numbers also include partial pallets already in UAT stock, so they are higher than the planted ones."]);
  sum.getRow(1).font = { bold: true };
  const det = key.addWorksheet("Rows");
  det.columns = ["Row", "Case", "Expected", "Bin", "HU", "SKU", "Qty", "UOM", "Batch"].map((h) => ({ header: h, width: h === "Case" ? 50 : 16 }));
  det.getRow(1).font = { bold: true };
  [...rows].sort((a, b) => a.row - b.row).forEach((r) => det.addRow([r.row, r.cat, r.expect, r.bin, r.hu, r.sku, r.qty, r.uom, r.batch[0]]));
  const mg = key.addWorksheet("Merges planted");
  mg.columns = ["SKU", "Batch", "Best fit", "Partial pallets", "Cases", "Pallets needed", "Pallets freed", "Same bin"].map((h) => ({ header: h, width: 16 }));
  mg.getRow(1).font = { bold: true };
  merges.forEach((m) => mg.addRow([m.sku, m.batch, m.bestFit, m.pallets, m.cases, m.need, m.frees, m.sameBin || ""]));
  await key.xlsx.writeFile(path.join(OUT, `Check_test_${WH}_answer_key.xlsx`));

  console.log(`${rows.length} rows -> ${file}`);
  [...cats].forEach(([k, v]) => console.log(`  ${String(v.rows).padStart(4)} rows ${String(v.bins.size).padStart(3)} bins  ${k}  => ${v.expect}`));
  console.log(`  merges planted: ${merges.length} groups, ${merges.reduce((t, m) => t + m.frees, 0)} pallets freeable`);
  console.log(JSON.stringify({ rows: rows.map((r) => [r.row, r.expect]), merges }), "\n__KEY__");
})().catch((e) => { console.error(e); process.exit(1); });
