// IM upload files (lib/im-upload/files.js): the capacity hold-back and its dependency rule, and the uploader's
// format rules the "IM upload order" sheet tells the user about (Sheet1 alone, lowercase "true"/"false" text,
// Destination HU rows in their own file, duplicates merged).
const test = require("node:test");
const assert = require("node:assert");
const ExcelJS = require("exceljs");
const { imFiles, imWorkbook, addImSheets, IM_COLS } = require("../../lib/im-upload/files");

// cap: every unit of SKU "BIG" fills 10% of any bin, "FREE" takes no room; stock: bin -> [{sku, uom, qty}]
const capOf = (stock = {}) => ({ unit: (bin, sku) => (sku === "BIG" ? 0.1 : 0), stock: new Map(Object.entries(stock)) });
const cases = (fromBin, hu, sku, qty, toBin, toPallet, extra = {}) => ({ fromBin, hu, sku, batch: "B1", bucket: "GOOD", uom: "L2", qty, toBin, pickHu: false, toPallet, unit: `${fromBin}|${hu}`, ...extra });
const whole = (fromBin, hu, toBin, lines, extra = {}) => ({ fromBin, hu, toBin, pickHu: true, lines, ...extra });
const heldBy = (held, pred) => held.find(pred);

test("a row over capacity names its own bin with % before and with the row", () => {
  // T1 holds 95%: one BIG case takes it to 105%. The other row of the same pallet goes to T2, which has room.
  const rows = [cases("S1", "P1", "FREE", 5, "T2", "Q2"), cases("S1", "P1", "BIG", 1, "T1", "Q1")];
  const { files, held } = imFiles(rows, capOf({ T1: [{ sku: "BIG", uom: "L2", qty: 9.5 }] }));
  assert.equal(files.length, 0);
  const over = heldBy(held, (r) => r.toBin === "T1");
  assert.equal(over.cause, "capacity");
  assert.equal(over.capBin, "T1");
  assert.equal(over.pctBefore, 95);
  assert.equal(over.pctAfter, 105);
  assert.match(over.why, /^Destination T1 would be at 105% .*\(95% before this upload\)/);
  // the T2 row is held because its pallet can't be emptied, and says so instead of blaming T2
  const mate = heldBy(held, (r) => r.toBin === "T2");
  assert.equal(mate.cause, "unit");
  assert.match(mate.why, /pallet P1 in S1/);
  assert.match(mate.why, /Destination T1/);
  assert.ok(!/Destination T2/.test(mate.why));
});

test("rows that don't rely on a held row still go in the upload", () => {
  const rows = [cases("S1", "P1", "BIG", 2, "T1", "Q1"), cases("S9", "P9", "FREE", 3, "T9", "Q9")];
  const { files, held } = imFiles(rows, capOf({ T1: [{ sku: "BIG", uom: "L2", qty: 9 }] }));
  assert.deepEqual(held.map((r) => r.fromBin), ["S1"]);
  assert.deepEqual(files.flatMap((f) => f.rows.map((r) => r.fromBin)), ["S9"]);
});

test("a held whole-pallet move holds every row that drops onto that pallet", () => {
  // P1 can't go into T1 (full); a later row drops cases onto P1 in T1 (and takes no room itself)
  const rows = [whole("S1", "P1", "T1", [{ sku: "BIG", uom: "L2", qty: 3 }], { unit: "pack|S1" }), cases("S2", "P2", "FREE", 4, "T1", "P1")];
  const { files, held } = imFiles(rows, capOf({ T1: [{ sku: "BIG", uom: "L2", qty: 9 }] }));
  assert.equal(files.length, 0);
  const dep = heldBy(held, (r) => r.fromBin === "S2");
  assert.equal(dep.cause, "depends");
  assert.match(dep.why, /Drops onto pallet P1, which the held-back move pallet P1 S1 -> T1 was bringing into T1/);
});

test("a held row holds the later whole move of the pallet it was filling", () => {
  // cases onto Q1 in T1 are refused; the plan then moves Q1 whole to T5 counting on those cases
  const rows = [cases("S1", "P1", "BIG", 2, "T1", "Q1"), whole("T1", "Q1", "T5", [{ sku: "FREE", uom: "L2", qty: 10 }], { unit: "pack|T1", phase: 2 })];
  const { files, held } = imFiles(rows, capOf({ T1: [{ sku: "BIG", uom: "L2", qty: 9 }] }));
  assert.equal(files.length, 0);
  const dep = heldBy(held, (r) => r.pickHu);
  assert.equal(dep.cause, "depends");
  assert.match(dep.why, /Moves pallet Q1, which the held-back row .* was filling/);
});

test("a whole-pallet move that assumed a pallet was emptied is held with it", () => {
  // P1's cases can't leave S1 (T1 full), so P1 stays in S1: the later whole move of P7 into S1 has no position
  const rows = [cases("S1", "P1", "BIG", 2, "T1", "Q1"), whole("S7", "P7", "S1", [{ sku: "FREE", uom: "L2", qty: 5 }], { unit: "pack|S7", phase: 2 }),
    whole("S8", "P8", "T8", [{ sku: "FREE", uom: "L2", qty: 5 }], { unit: "pack|S8", phase: 2 })];
  const { files, held } = imFiles(rows, capOf({ T1: [{ sku: "BIG", uom: "L2", qty: 9 }] }));
  const dep = heldBy(held, (r) => r.hu === "P7");
  assert.equal(dep.cause, "depends");
  assert.match(dep.why, /Assumes pallet P1 in S1 is emptied first.*S1 has no free position for pallet P7/);
  // the unrelated whole move still goes
  assert.deepEqual(files.flatMap((f) => f.rows.map((r) => r.hu)), ["P8"]);
});

test("dependencies chain: a row relying on a dependent row is held too", () => {
  const rows = [whole("S1", "P1", "T1", [{ sku: "BIG", uom: "L2", qty: 3 }], { unit: "pack|S1" }),
    cases("S2", "P2", "FREE", 4, "T1", "P1"), // onto P1, which never arrives
    whole("S2", "P3", "T3", [{ sku: "FREE", uom: "L2", qty: 1 }], { unit: "S2|P2" }), // same unit as the row above
    cases("S4", "P4", "FREE", 1, "T3", "P3")]; // onto P3, whose move is held with its unit
  const { files, held } = imFiles(rows, capOf({ T1: [{ sku: "BIG", uom: "L2", qty: 9 }] }));
  assert.equal(files.length, 0);
  assert.equal(held.length, 4);
  assert.equal(heldBy(held, (r) => r.fromBin === "S4").cause, "depends");
});

test("without a capacity check nothing is held", () => {
  const { held, files } = imFiles([cases("S1", "P1", "BIG", 50, "T1", "Q1")]);
  assert.equal(held.length, 0);
  assert.equal(files[0].rows.length, 1);
});

async function readBack(buf) { const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf); return wb; }

test("the upload file is Sheet1 alone, headers in the uploader's order, Pick HU as lowercase text", async () => {
  const { files } = imFiles([cases("S1", "P1", "FREE", 2, "T1", "Q1"), whole("S2", "P2", "T2", [{ sku: "FREE", uom: "L2", qty: 1 }], { sku: "FREE", batch: "B1", uom: "L2", qty: 1 })]);
  assert.equal(files.length, 1);
  const wb = await readBack(await imWorkbook(files[0]));
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["Sheet1"]);
  const s = wb.getWorksheet("Sheet1");
  assert.deepEqual(s.getRow(1).values.slice(1), IM_COLS.map(([h]) => h));
  const pick = IM_COLS.findIndex(([, k]) => k === "pickHu") + 1;
  const vals = [2, 3].map((i) => s.getRow(i).getCell(pick).value);
  assert.deepEqual(vals.sort(), ["false", "true"]);
  vals.forEach((v) => assert.equal(typeof v, "string")); // not an Excel boolean: the uploader reads TRUE as false
  assert.equal(s.getColumn(pick).numFmt, "@");
});

test("Destination HU rows get their own file; equal rows merge; one row per whole pallet", () => {
  const rows = [cases("S1", "P1", "FREE", 2, "T1", "Q1"), cases("S1", "P1", "FREE", 3, "T1", "Q1"),
    cases("S3", "P3", "FREE", 1, "S3", "Q3", { toHu: "Q3" }),
    whole("S2", "P2", "T2", [], { phase: 2 }), whole("S2", "P2", "T2", [], { phase: 2 })];
  const { files } = imFiles(rows);
  for (const f of files) assert.ok(f.rows.every((r) => !!r.toHu === f.sameBin), "a file is all Destination HU rows or none");
  const all = files.flatMap((f) => f.rows);
  assert.equal(all.filter((r) => r.fromBin === "S1").length, 1);
  assert.equal(all.find((r) => r.fromBin === "S1").qty, 5);
  assert.equal(all.filter((r) => r.hu === "P2").length, 1);
  assert.ok(files.find((f) => f.rows.some((r) => r.hu === "P2")).wave > 1, "whole moves after the case moves");
});

test("the plan workbook lists held rows with the bin, its % and the cause", async () => {
  const rows = [cases("S1", "P1", "BIG", 1, "T1", "Q1"), cases("S9", "P9", "FREE", 1, "T9", "Q9")];
  const { files, held } = imFiles(rows, capOf({ T1: [{ sku: "BIG", uom: "L2", qty: 9.5 }] }));
  const wb0 = new ExcelJS.Workbook();
  addImSheets(wb0, files, [], held);
  const wb = await readBack(await wb0.xlsx.writeBuffer());
  assert.deepEqual(wb.worksheets.map((s) => s.name), ["IM upload order", "IM upload 1", "IM drop onto pallet", "Not in IM upload"]);
  const h = wb.getWorksheet("Not in IM upload"), head = h.getRow(1).values.slice(1);
  const row = Object.fromEntries(head.map((k, i) => [k, h.getRow(2).values[i + 1]]));
  assert.equal(row["Bin over capacity"], "T1");
  assert.equal(row["Its % before the upload"], 95);
  assert.equal(row["Its % with this row"], 105);
  assert.equal(row["Held because"], "Bin over capacity");
  const order = wb.getWorksheet("IM upload order");
  const notes = [];
  order.eachRow((r) => notes.push(String(r.getCell(3).value || "")));
  assert.ok(notes.some((t) => /lowercase text true \/ false/.test(t)));
  assert.ok(notes.some((t) => /only sheet is named Sheet1/.test(t)));
  assert.ok(notes.some((t) => /1 planned move left out .*1 would take a bin over the WMS capacity check/.test(t)));
});
