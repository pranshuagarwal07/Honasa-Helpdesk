// Check a sheet: every rule of the uploader, putaway and drops, on every row, not fail-fast;
// the catalog of those checks; and the sheet back with its rows painted red / yellow.
// Port of the appendinv skill's validate_fill.py.
const ExcelJS = require("exceljs");
const { upper, todayKey, addDays, daysBetween, fmtN, pct } = require("../core/util");
const { EXEMPT_AREAS, allowedSeq } = require("../wms/search");
const { palletShare, palletsAfter, casesText } = require("../wms/pallets");
const { consolidationSheets } = require("../planners/workbooks");
const { templateFor } = require("./templates");

// test cases set up odd stock on purpose (expired, short-dated, on top of existing
// stock), so there those checks warn instead of blocking; upload rejections still block
const WARN_IN_TESTCASE = new Set(["2c", "2d", "6a", "8c"]);
const FIELD_OF_CHECK = { "1a": "batch", "1b": "batch", "1c": "batch", "1d": "batch", "2a": "batch", "2b": "batch", "2c": "exp", "2d": "exp",
  "2e": "mfg", "2f": "exp", "2g": "batch", "3a": "sku", "4a": "sku", "5a": "bin", "5b": "bin", "5c": "hu", "5d": "hu", "5e": "hukind",
  "5f": "hu", "5g": "hu", "5h": "hu", "6a": "bin", "6b": "sku", "6c": "batch", "7a": "op", "7b": "qty", "7c": "uom", "7d": "bucket",
  "7e": "inclusion", "7f": "row", "8a": "sku", "8b": "sku", "8c": "uom",
  "6d": "sku", "6e": "batch", "6f": "sku", "6g": "batch", "9a": "qty", "9b": "sku", "7i": "op" };

function validate(m, rows, { headers, sheetNames, shelfLifeDays = 180, mode, skip = new Set() } = {}) {
  const out = [], rowIssues = {};
  const today = todayKey(), minExp = addDays(today, Number(shelfLifeDays) || 0);
  const add = (id, title, bad, extra = {}) => {
    if (skip.has(id)) return;
    const rowsBad = [...new Set(bad.map((r) => r.row ?? r))].sort((a, b) => a - b);
    // soft = works, but against best practice (yellow); everything else blocks (red)
    const level = extra.soft || (mode === "testcase" && WARN_IN_TESTCASE.has(id)) ? "warn" : "fail";
    out.push({ id, title, level, status: rowsBad.length || extra.fail ? level : "pass", count: rowsBad.length, rows: rowsBad.slice(0, 25), detail: extra.detail || "" });
    for (const n of rowsBad) (rowIssues[n] ||= []).push({ id, title, field: FIELD_OF_CHECK[id] || "row", level });
  };
  const info = (id, title, detail) => { if (!skip.has(id)) out.push({ id, title, level: "info", status: "info", detail, count: 0, rows: [] }); };
  const key = (r) => `${r.sku}|${upper(r.batch)}`;
  const binOf = (r) => m.binByCode.get(r.bin);
  const skuOf = (r) => m.skus.get(r.sku);

  // 1 distribution batch vs vendor lot
  add("1a", "Batch code is in the distribution batch master for that SKU", rows.filter((r) => !m.batches.has(key(r))));
  add("1b", "That batch is active", rows.filter((r) => m.batches.has(key(r)) && m.batches.get(key(r)).active !== true));
  add("1c", "No row uses a vendor (production) lot as the batch code", rows.filter((r) => m.prodLots.has(key(r)) && !m.batches.has(key(r))));
  add("1d", "No batch code is ambiguous (valid in both batch masters)", rows.filter((r) => m.prodLots.has(key(r)) && m.batches.has(key(r))));
  info("1e", "Rows whose batch also has a production batch", `${rows.filter((r) => m.prodParents.has(key(r))).length} of ${rows.length}`);

  // 2 dates
  const withBatch = rows.filter((r) => m.batches.has(key(r)));
  add("2a", "Manufacture date matches the batch master", withBatch.filter((r) => r.mfg !== m.batches.get(key(r)).mfg), { detail: "Copy dates from the master verbatim, or the upload rewrites the batch." });
  add("2b", "Expiry date matches the batch master", withBatch.filter((r) => r.exp !== m.batches.get(key(r)).exp));
  add("2c", "No expired batch", rows.filter((r) => !r.exp || r.exp <= today));
  // soft: real opening stock has short-dated batches that still have to go in; expired (2c) stays hard
  add("2d", `Over ${shelfLifeDays} days of shelf life left`, rows.filter((r) => r.exp && r.exp > today && r.exp <= minExp), { soft: true,
    detail: rows.some((r) => r.exp) ? `Shortest: ${Math.min(...rows.filter((r) => r.exp).map((r) => daysBetween(today, r.exp)))} days` : "" });
  add("2e", "Manufacture date isn't in the future", rows.filter((r) => r.mfg && r.mfg > today));
  add("2f", "Expiry is after manufacture", rows.filter((r) => r.mfg && r.exp && r.exp <= r.mfg));
  const dates = new Map();
  rows.forEach((r) => { const k = key(r); if (!dates.has(k)) dates.set(k, new Set()); dates.get(k).add(`${r.mfg}|${r.exp}`); });
  add("2g", "One manufacture/expiry date per SKU and batch", rows.filter((r) => dates.get(key(r)).size > 1));

  // 3 ABC class — per SKU, never inferred from a sibling
  add("3a", `Every SKU has a ${m.classType} class`, rows.filter((r) => !skuOf(r)?.clazz));

  // 4 search table
  add("4a", "The search table allows each row's class, UOM and bucket in its bin",
    rows.filter((r) => { const b = binOf(r), s = skuOf(r); return b && s?.clazz && !EXEMPT_AREAS.has(b.areaType) && allowedSeq(m, b, s.clazz, r.uom, r.bucket) === null; }),
    { detail: m.warnings.find((w) => w.startsWith("The search table")) || "" });

  // 5 bins and HUs
  add("5a", "Every bin code exists", rows.filter((r) => !binOf(r)));
  add("5b", "Every target bin is active", rows.filter((r) => binOf(r) && binOf(r).status !== "ACTIVE"));
  add("5c", "HU code is blank on BIN-type bins", rows.filter((r) => binOf(r)?.huType === "BIN" && r.hu));
  add("5d", "Pallet bins have an HU code with a kind containing PALLET", rows.filter((r) => binOf(r)?.huType === "PALLET" && (!r.hu || !upper(r.hukind).includes("PALLET"))));
  add("5e", "HU kind code exists in this warehouse", rows.filter((r) => r.hukind && !m.kinds.includes(r.hukind)));
  const huBins = new Map();
  rows.filter((r) => r.hu).forEach((r) => { if (!huBins.has(r.hu)) huBins.set(r.hu, new Set()); huBins.get(r.hu).add(r.bin); });
  add("5g", "Each HU code sits in one bin", rows.filter((r) => r.hu && huBins.get(r.hu).size > 1));
  add("5h", "New HU codes don't already exist in the warehouse", rows.filter((r) => r.hu && m.huCodes.has(r.hu)),
    { detail: "Existing codes are burned. Use a new HU prefix." });
  const huLens = new Map();
  for (const h of new Set(rows.map((r) => r.hu).filter(Boolean))) huLens.set(h.length, (huLens.get(h.length) || 0) + 1);
  if (huLens.size) info("5i", "Pallet HU code length", [...huLens].sort((a, b) => a[0] - b[0])
    .map(([len, n]) => `${len} characters${huLens.size > 1 ? ` (${n} code${n > 1 ? "s" : ""})` : ""}`).join(", "));

  // 6 occupancy and multi-SKU / multi-batch, counted after the update
  const ops = new Set(rows.map((r) => r.op));
  const isReset = ops.size === 1 && ops.has("RESET");
  const occupiedRows = rows.filter((r) => m.occupied.has(r.bin));
  if (isReset) info("6a", "Bins that already hold stock", `${new Set(occupiedRows.map((r) => r.bin)).size} bins will be emptied and replaced by RESET`);
  // soft: topping up occupied bins is normal when no bin is free; the hard clashes are 6b-6g and 5f
  else add("6a", "Rows going into bins that already hold stock", occupiedRows, { soft: true,
    detail: `${new Set(occupiedRows.map((r) => r.bin)).size} bins. APPEND adds to what's there, so make sure these rows aren't stock that's already in the system, or it doubles.` });
  // the upload itself enforces none of 6b-6g; putaway and drops do, so a breach here
  // uploads fine and then blocks every later drop into that bin or pallet
  const after = new Map(), sheetOnly = new Map();
  const note = (map, bin, sku, batch) => { if (!map.has(bin)) map.set(bin, { skus: new Set(), batches: new Set() }); map.get(bin).skus.add(sku); map.get(bin).batches.add(`${sku}|${batch}`); };
  const rowBins = new Set(rows.map((r) => r.bin));
  if (!isReset) for (const bin of rowBins) (m.occupied.get(bin) || []).forEach((x) => note(after, bin, x.skuCode, upper(x.batch)));
  rows.forEach((r) => { note(after, r.bin, r.sku, upper(r.batch)); note(sheetOnly, r.bin, r.sku, upper(r.batch)); });
  // "Bin: A, B" for the first few offending bins; * marks what's already in the bin
  const binExamples = (bad, list) => {
    const bins = [...new Set(bad.map((r) => r.bin))];
    const fromStock = bins.filter((b) => list(sheetOnly.get(b)).length < list(after.get(b)).length).length;
    const ex = bins.slice(0, 4).map((b) => `${b}: ${list(after.get(b)).map((x) => list(sheetOnly.get(b)).includes(x) ? x : x + "*").join(", ")}`);
    return `${bins.length} bin${bins.length === 1 ? "" : "s"}${fromStock ? `, ${fromStock} because of stock already in the bin (marked *)` : ""}. ${ex.join(" · ")}${bins.length > 4 ? " · …" : ""}`;
  };
  const skuList = (x) => [...(x?.skus || [])];
  const batchList = (x) => [...(x?.batches || [])].map((k) => k.replace("|", " "));
  // a case SKU and its base SKU are two SKUs to putaway (it compares sku ids)
  const bad6b = rows.filter((r) => binOf(r) && binOf(r).multiSku === false && after.get(r.bin).skus.size > 1);
  add("6b", "One SKU per bin where the bin isn't multi-SKU (counting stock already in it)", bad6b,
    { detail: bad6b.length ? binExamples(bad6b, skuList) : "A case SKU and its base SKU count as two SKUs." });
  // multi-batch is about batches of one SKU; a case SKU and its base SKU on the same batch code are two SKUs, not two batches
  const batchesOfSku = (bin, sku) => [...after.get(bin).batches].filter((k) => k.startsWith(sku + "|")).length;
  const bad6c = rows.filter((r) => binOf(r) && binOf(r).multiBatch === false && batchesOfSku(r.bin, r.sku) > 1);
  add("6c", "One batch per SKU where the bin isn't multi-batch (counting stock already in it)", bad6c,
    { detail: bad6c.length ? binExamples(bad6c, batchList) : "" });
  const bad6d = rows.filter((r) => binOf(r)?.maxSku && after.get(r.bin).skus.size > binOf(r).maxSku);
  add("6d", "SKUs per bin within the bin's max SKU count", bad6d,
    { detail: bad6d.length ? binExamples(bad6d, skuList) : m.bins.some((b) => b.maxSku) ? "" : "No bin here sets a max SKU count." });
  const bad6e = rows.filter((r) => binOf(r)?.maxSkuBatch && after.get(r.bin).batches.size > binOf(r).maxSkuBatch);
  add("6e", "SKU-batches per bin within the bin's max SKU-batch count", bad6e,
    { detail: bad6e.length ? binExamples(bad6e, batchList) : m.bins.some((b) => b.maxSkuBatch) ? "" : "No bin here sets a max SKU-batch count." });

  // pallets: what each bin holds once the sheet is in
  const pallets = palletsAfter(m, rows, isReset);
  const palletsInBin = new Map();
  for (const p of pallets.values()) palletsInBin.set(p.bin, (palletsInBin.get(p.bin) || 0) + 1);
  const over5f = rows.filter((r) => r.hu && binOf(r)?.huType === "PALLET" && palletsInBin.get(r.bin) > binOf(r).cap);
  add("5f", "Pallets per bin within the bin type's capacity (counting pallets already there)", over5f, {
    detail: over5f.length ? [...new Set(over5f.map((r) => r.bin))].slice(0, 5)
      .map((b) => `${b}: ${palletsInBin.get(b)} pallets, room for ${m.binByCode.get(b).cap}`).join(" · ") : "" });
  const sheetPallets = [...pallets.values()].filter((p) => p.source === "sheet");
  const mixedSku = sheetPallets.filter((p) => !m.binByCode.get(p.bin).huMultiSku && p.skus.size > 1);
  add("6f", "One SKU per pallet where the bin type doesn't allow mixed-SKU pallets", mixedSku.flatMap((p) => p.rows), {
    detail: mixedSku.slice(0, 4).map((p) => `${p.hu} in ${p.bin}: ${[...p.skus].join(", ")}`).join(" · ") });
  const mixedBatch = sheetPallets.filter((p) => !m.binByCode.get(p.bin).huMultiBatch
    && [...p.skus].some((s) => [...p.keys].filter((k) => k.startsWith(s + "|")).length > 1));
  add("6g", "One batch per SKU on a pallet where the bin type doesn't allow mixed-batch pallets", mixedBatch.flatMap((p) => p.rows), {
    detail: mixedBatch.slice(0, 4).map((p) => `${p.hu} in ${p.bin}: ${[...p.keys].map((k) => k.replace("|", " ")).join(", ")}`).join(" · ") });

  // 9 best fit: one pallet holds L2inL3 cases of a SKU. Soft: the upload and putaway accept more.
  const overFit = sheetPallets.filter((p) => p.share !== null && p.share > 1 + 1e-9);
  add("9a", "No pallet holds more than its best fit (L2inL3 cases)", overFit.flatMap((p) => p.rows), { soft: true,
    detail: overFit.length ? overFit.slice(0, 4).map((p) => `${p.hu} in ${p.bin}: ${casesText(m, p)} = ${pct(p.share)} of best fit` +
      (p.skus.size === 1 ? ` (${fmtN(m.skus.get([...p.skus][0])?.L2inL3 || 0)} cases)` : "")).join(" · ") + (overFit.length > 4 ? " · …" : "") : "" });
  const unsized = rows.filter((r) => r.hu && binOf(r)?.huType === "PALLET" && skuOf(r) && palletShare(m, r.sku, r.uom, 1) === null);
  add("9b", "Every pallet SKU has an L2inL3 (cases per pallet) in its UOM master", unsized, { soft: true,
    detail: unsized.length ? `Best fit can't be checked for ${[...new Set(unsized.map((r) => r.sku))].slice(0, 8).join(", ")}${new Set(unsized.map((r) => r.sku)).size > 8 ? ", …" : ""}. Putaway falls back to volume for these.` : "" });

  // 7 the uploader's row contract
  add("7a", "Operation type is the same on every row", ops.size > 1 ? rows : [], { detail: [...ops].join(", ") });
  add("7i", "Operation type is APPEND or RESET", rows.filter((r) => !["APPEND", "RESET"].includes(r.op)),
    { detail: [...ops].filter((o) => !["APPEND", "RESET"].includes(o)).map((o) => o ? `"${o}"` : "blank").join(", ") });
  add("7b", "Quantity is a positive whole number", rows.filter((r) => !(Number(r.qty) > 0) || Number(r.qty) % 1 !== 0));
  add("7c", "UOM is L0, L2 or L3", rows.filter((r) => !["L0", "L2", "L3"].includes(r.uom)));
  add("7d", "Bucket is Good or Damaged", rows.filter((r) => !["Good", "Damaged"].includes(r.bucket)));
  add("7e", "Inclusion status is PRE-GRN, INCLUDED or POST-GIN", rows.filter((r) => !["PRE-GRN", "INCLUDED", "POST-GIN"].includes(r.inclusion)));
  const lines = new Map();
  rows.forEach((r) => { const k = [r.bin, r.hu || "", r.sku, r.uom, upper(r.batch), r.bucket, r.inclusion].join("|"); lines.set(k, (lines.get(k) || 0) + 1); });
  add("7f", "No duplicate stock line (bin, HU, SKU, UOM, batch, bucket, status)", rows.filter((r) => lines.get([r.bin, r.hu || "", r.sku, r.uom, upper(r.batch), r.bucket, r.inclusion].join("|")) > 1));
  if (headers) {
    const expected = templateFor(m.whId);
    const same = headers.length === expected.length && headers.every((h, i) => h === expected[i]);
    // a sheet downloaded from this page carries our extra columns
    const ours = headers.slice(expected.length).every((h) => ["Check", "Issues", "Pallet fill vs best fit"].includes(h)) && headers.length > expected.length;
    add("7g", "Header row matches this warehouse's template", [], { fail: !same, detail: same ? ""
      : ours ? "This is a checked sheet from this page. Delete its Check, Issues and Pallet fill columns before uploading." : `Expected: ${expected.join(" | ")}` });
  }
  if (sheetNames) add("7h", "Data is on the first sheet, named Sheet1", [], { fail: sheetNames[0] !== "Sheet1", detail: `Sheets: ${sheetNames.join(", ")}` });

  // 8 SKU master
  add("8a", "Every SKU exists in the SKU master", rows.filter((r) => !skuOf(r)));
  add("8b", "Every SKU is active", rows.filter((r) => skuOf(r) && !skuOf(r).active));
  const l0 = new Set(rows.filter((r) => r.uom === "L0").map((r) => r.sku)), l2 = new Set(rows.filter((r) => r.uom === "L2").map((r) => r.sku));
  add("8c", "No SKU is written at both L0 and L2", rows.filter((r) => l0.has(r.sku) && l2.has(r.sku)));

  return {
    checks: out,
    failed: out.filter((c) => c.status === "fail").length,
    warned: out.filter((c) => c.status === "warn").length,
    passed: out.filter((c) => c.status === "pass").length,
    rowIssues,
    checksOff: skip.size,
    sessions: m.sessions,
    warnings: m.warnings,
  };
}

const CHECK_GROUPS = { 1: "Batch master", 2: "Dates", 3: "ABC class", 4: "Search table", 5: "Bins and HUs", 6: "Bin and pallet mixing", 7: "Row format", 8: "SKU master", 9: "Best fit" };
let checkCatalog = null;
function checksCatalog() {
  if (checkCatalog) return checkCatalog;
  const empty = { batches: new Map(), prodLots: new Map(), prodParents: new Set(), skus: new Map(), binByCode: new Map(), bins: [], kinds: [],
    huCodes: new Set(), occupied: new Map(), palletStock: new Map(), search: {}, warnings: [], sessions: [], classType: "ABC", whId: "" };
  const v = validate(empty, [], { headers: [], sheetNames: ["Sheet1"] });
  // only shown when the sheet has pallet codes, so the empty run never reaches it
  v.checks.push({ id: "5i", title: "Pallet HU code length", level: "info" });
  const kinds = new Map();
  for (const c of v.checks) {
    const g = c.id[0];
    if (!kinds.has(g)) kinds.set(g, { kind: g, name: CHECK_GROUPS[g] || "Other", checks: [] });
    if (!kinds.get(g).checks.some((x) => x.id === c.id)) kinds.get(g).checks.push({ id: c.id, title: c.title.replace(/Over \d+ days/, "Over N days"), level: c.level });
  }
  for (const k of kinds.values()) k.checks.sort((a, b) => a.id.localeCompare(b.id));
  return (checkCatalog = { kinds: [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)) });
}

// the uploaded sheet back, rows painted red (hard) / yellow (soft) with the reasons,
// plus the consolidation plan
async function annotatedSheet(m, buffer, v, cons) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  let width = 0;
  ws.getRow(1).eachCell({ includeEmpty: false }, (c, i) => { width = Math.max(width, i); });
  const RED = "FFF4C7C3", YELLOW = "FFFFF0B3";
  const fillOf = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
  const cResult = width + 1, cIssues = width + 2, cFill = width + 3;
  ws.getCell(1, cResult).value = "Check"; ws.getCell(1, cIssues).value = "Issues"; ws.getCell(1, cFill).value = "Pallet fill vs best fit";
  [cResult, cIssues, cFill].forEach((c) => { ws.getCell(1, c).font = { bold: true }; });
  ws.getColumn(cResult).width = 8; ws.getColumn(cIssues).width = 70; ws.getColumn(cFill).width = 26;
  const fillByRow = new Map();
  for (const p of cons.pallets) if (p.source === "sheet") for (const n of p.rows)
    fillByRow.set(n, p.share === null ? "no L2inL3" : `${pct(p.share)}${p.state === "Partial" && p.mergeInto ? ", merge (see Moves)" : ""}`);
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const iss = v.rowIssues[n] || [];
    const hard = iss.some((i) => i.level === "fail");
    row.getCell(cResult).value = !iss.length ? "OK" : hard ? "HARD" : "SOFT";
    row.getCell(cIssues).value = iss.map((i) => `${i.level === "fail" ? "[hard]" : "[soft]"} ${i.title}`).join("; ") || null;
    if (fillByRow.has(n)) row.getCell(cFill).value = fillByRow.get(n);
    // loaded cells share style objects (all date cells, say): copy before filling
    if (iss.length) for (let c = 1; c <= cFill; c++) { const cell = row.getCell(c); cell.style = { ...cell.style, fill: fillOf(hard ? RED : YELLOW) }; }
  });

  const sheet = (name, cols, data) => {
    const s = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    s.columns = cols.map(([header, key, w]) => ({ header, key, width: w || 14 }));
    s.getRow(1).font = { bold: true };
    data.forEach((d) => s.addRow(d));
    return s;
  };
  const st = cons.stats;
  sheet("Summary", [["What", "k", 52], ["Value", "v", 16]], [
    { k: "Pallet bins (storage, active)", v: st.palletBins }, { k: "Pallet positions", v: st.positions },
    { k: "Positions used after this sheet", v: st.used }, { k: "Positions free after this sheet", v: st.spare },
    { k: "Pallet bins completely empty", v: st.emptyBins }, { k: "Pallets", v: st.pallets },
    { k: "Full pallets (at best fit)", v: st.full }, { k: "Partial pallets", v: st.partial }, { k: "Over best fit", v: st.over },
    { k: "Mixed SKU/batch pallets", v: st.mixed }, { k: "Pallets without an L2inL3", v: st.unsized },
    { k: "Pallets freed by merging same SKU + batch", v: st.frees }, { k: "  of which inside the same bin", v: st.sameBinFrees },
    { k: "Bins emptied by merging", v: st.binsEmptied },
    { k: "Free positions after merging", v: st.spare + st.frees },
    { k: "Shelf SKU-batches spread over several bins", v: cons.shelf.groups },
    { k: "Hard (red) checks failing", v: v.failed }, { k: "Soft (yellow) warnings", v: v.warned },
  ]);
  consolidationSheets(wb, m, cons);
  return wb.xlsx.writeBuffer();
}

module.exports = { validate, checksCatalog, annotatedSheet, CHECK_GROUPS, FIELD_OF_CHECK, WARN_IN_TESTCASE };
