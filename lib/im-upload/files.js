// Internal Movement upload sheets (IM cockpit > Internal Movement Upload) from a consolidation plan.
// The uploader's rules, from wms panel-gateway internal-movement.route.ts and utils.ts:
//  - sheet named Sheet1, these headers in this order
//  - Pick HU is read as the lowercase text "true"; anything else, TRUE included, is false
//  - Pick HU true moves the whole HU: one row per HU (a second row for it fails the file), and
//    SKU/Batch/Quality/UOM/Quantity on the row are ignored (the HU's own stock is moved)
//  - Destination HU only for an HU-to-HU transfer inside one bin (destination bin = source bin,
//    the HU already there), and once any row has one, every row must: those go in their own file
//  - a row whose every field matches another row is rejected as a duplicate
// And from cincout internal-movement.route.ts:243-246, "Qty exceeds bin capacity for bin[..]": each
// destination bin's stock now plus every row of the file going into it must total 100% or less, one
// unit counted as the caller's cap.unit() says. Stock leaving the bin in the same file isn't taken off.
const ExcelJS = require("exceljs");

const IM_COLS = [
  ["Source Bin", "fromBin", 16], ["HU Code (OPTIONAL)", "hu", 18], ["SKU", "sku", 18], ["Batch", "batch", 14], ["Quality", "bucket", 10],
  ["UOM", "uom", 7], ["Quantity", "qty", 10], ["Destination Bin (OPTIONAL)", "toBin", 16], ["Pick HU (TRUE/FALSE)", "pickHu", 12],
  ["Destination UOM (OPTIONAL)", "toUom", 12], ["ILOC (OPTIONAL)", "iloc", 12], ["Destination HU Code (OPTIONAL)", "toHu", 18],
];

// row: { fromBin, hu, sku, batch, bucket, uom, qty, toBin, pickHu, iloc, toHu (same-bin transfer only),
//        toPallet (the pallet to drop onto, for the guide), phase (earliest file wave),
//        lines (a whole-HU row's stock: [{sku, uom, qty}]), unit (rows that stand or fall together; default the source bin) }
// cap (optional): { unit(binCode, sku, uom) -> one unit's share of the bin, stock: Map binCode -> [{sku, uom, qty}] }
// Returns { files, held }: held = rows left out because a file would take a bin over capacity, with why.
function imFiles(rows, cap) {
  let live = rows;
  const held = [];
  for (let i = 0; i < 500; i++) {
    const files = buildFiles(live);
    const over = cap ? overCapacity(files, cap) : [];
    if (!over.length) return { files, held };
    // hold back every row of a source that would overflow a bin: it can't be emptied anyway
    const out = new Map();
    for (const o of over) for (const r of o.rows) if (!out.has(unitOf(r))) out.set(unitOf(r), o.why);
    // and rows that drop onto a pallet a held row was bringing in
    for (let grew = true; grew;) {
      grew = false;
      const gone = new Set(live.filter((r) => r.pickHu && out.has(unitOf(r))).map((r) => r.hu));
      for (const r of live) if (!out.has(unitOf(r)) && r.toPallet && gone.has(r.toPallet)) { out.set(unitOf(r), `Drops onto pallet ${r.toPallet}, which is held back`); grew = true; }
    }
    held.push(...live.filter((r) => out.has(unitOf(r))).map((r) => ({ ...r, why: out.get(unitOf(r)) })));
    live = live.filter((r) => !out.has(unitOf(r)));
  }
  throw new Error("Couldn't fit the IM upload within the WMS bin capacity check.");
}
const unitOf = (r) => r.unit || r.fromBin;

// rows over the WMS bin capacity check, file by file and wave by wave; a later wave sees the stock
// as the earlier waves left it. Within a wave, a file is checked against the stock both before and
// after the wave's earlier files ran, whichever is fuller (the tasks may or may not be done yet).
function overCapacity(files, cap) {
  const clone = (st) => new Map([...st].map(([b, ls]) => [b, ls.map((l) => ({ ...l }))]));
  const state = clone(cap.stock);
  const use = (bin, ls) => (ls || []).reduce((t, l) => t + cap.unit(bin, l.sku, l.uom) * l.qty, 0);
  const inOf = (r) => (r.pickHu ? r.lines || [] : [{ sku: r.sku, uom: r.uom, qty: r.qty }]);
  const apply = (st, r) => {
    const src = st.get(r.fromBin) || [];
    for (const l of inOf(r)) {
      let left = l.qty;
      for (const s of src) if (left > 0 && s.sku === l.sku && s.uom === l.uom) { const t = Math.min(left, s.qty); s.qty -= t; left -= t; }
    }
    if (!st.has(r.toBin)) st.set(r.toBin, []);
    st.get(r.toBin).push(...inOf(r).map((l) => ({ ...l })));
  };
  const bad = [];
  for (const w of [...new Set(files.map((f) => f.wave))].sort((a, b) => a - b)) {
    const start = clone(state);
    for (const f of files.filter((x) => x.wave === w)) {
      const byBin = new Map();
      for (const r of f.rows) if (r.toBin) { if (!byBin.has(r.toBin)) byBin.set(r.toBin, []); byBin.get(r.toBin).push(r); }
      for (const [bin, rs] of byBin) {
        const base = Math.max(use(bin, start.get(bin)), use(bin, state.get(bin)));
        let u = base;
        const over = [];
        for (const r of rs) { u += use(bin, inOf(r)); if (u > 1 + 1e-6) over.push(r); }
        if (over.length) bad.push({ bin, rows: over, why: `${bin} would be at ${(u * 100).toFixed(1)}% of what the WMS lets it hold (${(base * 100).toFixed(1)}% before this upload); IM upload refuses a bin over 100% ("Qty exceeds bin capacity")` });
      }
      for (const r of f.rows) apply(state, r);
    }
  }
  return bad;
}

function buildFiles(rows) {
  const waved = [];
  for (const r of rows) {
    let w = r.phase || 1;
    for (const e of waved) {
      const after =
        (e.pickHu && (e.hu === r.hu || e.hu === r.toPallet) && !(r.pickHu && e.hu === r.hu && e.toBin === r.toBin)) || // that pallet moved first
        (r.hu && e.toPallet === r.hu) || // a pallet that receives cases, then moves or gives some
        (!r.hu && e.toBin === r.fromBin && e.fromBin !== r.fromBin); // loose stock arrives in a bin this row picks loose from
      if (after) w = Math.max(w, e.wave + 1);
    }
    waved.push({ ...r, wave: w });
  }
  // one file per wave, and same-bin HU transfers (Destination HU on every row) apart from the rest
  const groups = new Map();
  for (const r of waved) {
    const k = `${String(r.wave).padStart(3, "0")}|${r.toHu ? "b" : "a"}`;
    if (!groups.has(k)) groups.set(k, new Map());
    // equal rows merge (the uploader rejects duplicates); a whole-HU row's quantity isn't read
    const dk = IM_COLS.filter(([, f]) => f !== "qty").map(([, f]) => cell(r, f)).join("\u0001");
    const g = groups.get(k);
    if (g.has(dk)) { if (!r.pickHu) g.get(dk).qty += r.qty; } else g.set(dk, { ...r });
  }
  return [...groups].sort(([a], [b]) => a.localeCompare(b)).map(([k, g], i) => {
    const list = [...g.values()], wave = Number(k.split("|")[0]), sameBin = k.endsWith("b");
    const whole = list.filter((r) => r.pickHu).length, off = list.filter((r) => r.hu && !r.pickHu).length, loose = list.length - whole - off;
    const parts = [whole && "whole pallets (Pick HU true)", off && "cases off pallets into other bins", loose && "loose stock, bin to bin"].filter(Boolean);
    return { n: i + 1, wave, sameBin, rows: list, whole,
      what: sameBin ? "Cases onto another pallet in the same bin (Destination HU)" : parts.join(", ").replace(/^./, (c) => c.toUpperCase()) };
  });
}

function cell(r, f) {
  if (f === "pickHu") return r.pickHu ? "true" : "false";
  if (f === "toHu") return r.toHu || null;
  const v = r[f];
  return v === undefined || v === "" ? null : f === "qty" ? +Number(v).toFixed(3) : v;
}

function imSheet(wb, name, rows) {
  const s = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  s.columns = IM_COLS.map(([header, key, width]) => ({ header, key, width }));
  s.getRow(1).font = { bold: true };
  // text, so the uploader reads "true" and not an Excel boolean
  s.getColumn(9).numFmt = "@";
  for (const r of rows) s.addRow(Object.fromEntries(IM_COLS.map(([, f]) => [f, cell(r, f)])));
  return s;
}

// one file, ready to upload as is
async function imWorkbook(file) {
  const wb = new ExcelJS.Workbook();
  imSheet(wb, "Sheet1", file.rows);
  return wb.xlsx.writeBuffer();
}

// the plan workbook's copy: an order sheet, then each file's rows, then what was held back
function addImSheets(wb, files, notes = [], held = []) {
  if (held.length) notes = [...notes, `${held.length} planned move${held.length === 1 ? " is" : "s are"} left out of the uploads because a bin would go over the WMS capacity check: see Not in IM upload.`];
  if (!files.length && !held.length) return;
  const s = wb.addWorksheet("IM upload order", { views: [{ state: "frozen", ySplit: 1 }] });
  s.columns = [{ header: "Upload", key: "n", width: 8 }, { header: "Sheet", key: "sheet", width: 14 }, { header: "What it moves", key: "what", width: 56 },
    { header: "Rows", key: "rows", width: 8 }, { header: "Pick HU true", key: "whole", width: 12 }, { header: "Upload after", key: "after", width: 34 }];
  s.getRow(1).font = { bold: true };
  for (const f of files) s.addRow({ n: f.n, sheet: `IM upload ${f.n}`, what: f.what, rows: f.rows.length, whole: f.whole,
    after: f.wave > 1 ? `The tasks of every wave ${f.wave - 1} upload are done` : "Nothing; upload first" });
  s.addRow({});
  for (const t of [
    "Copy an IM upload sheet into a file whose only sheet is named Sheet1 (or use the IM upload download in the app, which does that), then upload it in IM cockpit.",
    "Pick HU is the lowercase text true / false: the uploader reads anything else, TRUE included, as false.",
    "Pick HU true moves the whole pallet, one row per pallet. The uploader ignores its SKU, batch and quantity and moves what is on the HU; they're filled in only for a single-SKU pallet, to read.",
    "Pick HU false with an HU code picks cases off that pallet; the node needs wms.allowPartialHUPickInIMByUpload on.",
    ...notes,
  ]) s.addRow({ n: "", what: t });
  for (const f of files) imSheet(wb, `IM upload ${f.n}`, f.rows);
  // cases picked off a pallet into another bin: the upload can't name the pallet they go onto
  // (Destination HU works only inside one bin), so the operator needs this at the drop
  const drops = files.flatMap((f) => f.rows.filter((r) => r.toPallet && !r.toHu && !r.pickHu).map((r) => ({ n: f.n, ...r })));
  if (drops.length) {
    const d = wb.addWorksheet("IM drop onto pallet", { views: [{ state: "frozen", ySplit: 1 }] });
    d.columns = [["Upload", "n", 8], ["Source Bin", "fromBin", 16], ["HU Code", "hu", 18], ["SKU", "sku", 18], ["Batch", "batch", 14], ["UOM", "uom", 7],
      ["Quantity", "qty", 10], ["Destination Bin", "toBin", 16], ["Drop onto pallet", "toPallet", 18]].map(([header, key, width]) => ({ header, key, width }));
    d.getRow(1).font = { bold: true };
    drops.forEach((r) => d.addRow(r));
  }
  if (held.length) {
    const h = wb.addWorksheet("Not in IM upload", { views: [{ state: "frozen", ySplit: 1 }] });
    h.columns = [["Source Bin", "fromBin", 16], ["HU Code", "hu", 18], ["SKU", "sku", 18], ["Batch", "batch", 14], ["UOM", "uom", 7], ["Quantity", "qty", 10],
      ["Destination Bin", "toBin", 16], ["Pick HU", "pick", 9], ["Why it's left out", "why", 110]].map(([header, key, width]) => ({ header, key, width }));
    h.getRow(1).font = { bold: true };
    held.forEach((r) => h.addRow({ ...r, pick: r.pickHu ? "true" : "false" }));
  }
}

module.exports = { IM_COLS, imFiles, imWorkbook, addImSheets };
