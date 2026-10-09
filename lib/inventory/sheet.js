// Append/Reset Inventory sheets in and out: header matching, reading rows, writing Sheet1.
const ExcelJS = require("exceljs");
const { upper, dayKeyOf, utcDate } = require("../core/util");
const { cellValue } = require("../core/xlsx");

// header text -> row field; matched on the lowercased header's start
const HEADER_FIELDS = [
  ["bin code", "bin"], ["hu kind code", "hukind"], ["hu code", "hu"], ["sku code", "sku"],
  ["quantity", "qty"], ["uom", "uom"], ["bucket", "bucket"], ["inclusion status", "inclusion"],
  ["operation type", "op"], ["batch code", "batch"], ["manufacture date", "mfg"],
  ["expiry date", "exp"], ["outer hu kind", "outerHuKind"], ["outer hu", "outerHu"], ["iloc", "iloc"],
];
const fieldOf = (h) => (HEADER_FIELDS.find(([p]) => String(h || "").trim().toLowerCase().startsWith(p)) || [])[1];

async function readSheet(buffer) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(buffer);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error("The file has no sheets.");
  const headers = [];
  ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(cellValue(c.value) ?? "").trim(); });
  while (headers.length && !headers[headers.length - 1]) headers.pop();
  const fields = headers.map(fieldOf);
  if (!fields.includes("bin") || !fields.includes("sku")) throw new Error("Row 1 needs the template headers (Bin Code, Sku Code, ...).");
  const rows = [];
  ws.eachRow((row, n) => {
    if (n === 1) return;
    const r = { row: n };
    fields.forEach((f, i) => { if (f) r[f] = cellValue(row.getCell(i + 1).value); });
    if (!r.bin && !r.sku) return;
    r.bin = String(r.bin ?? "").trim(); r.sku = String(r.sku ?? "").trim();
    r.hu = String(r.hu ?? "").trim(); r.hukind = String(r.hukind ?? "").trim();
    r.uom = upper(r.uom); r.op = upper(r.op); r.inclusion = upper(r.inclusion);
    r.bucket = String(r.bucket ?? "").trim(); r.batch = upper(r.batch);
    r.qty = Number(r.qty); r.mfg = dayKeyOf(r.mfg); r.exp = dayKeyOf(r.exp);
    rows.push(r);
  });
  return { headers, rows, sheetNames: wb.worksheets.map((w) => w.name) };
}

async function writeSheet(rows, headers) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1", { views: [{ state: "frozen", ySplit: 1 }] });
  ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(10, Math.min(44, h.length + 2)) }));
  for (const r of rows) {
    ws.addRow(headers.map((h) => {
      const f = fieldOf(h);
      if (f === "mfg" || f === "exp") return r[f] ? utcDate(r[f]) : null;
      if (f === "qty") return Number(r.qty);
      return r[f] === "" || r[f] === undefined ? null : r[f];
    }));
  }
  headers.forEach((h, i) => { if (["mfg", "exp"].includes(fieldOf(h))) ws.getColumn(i + 1).numFmt = "dd/mm/yyyy"; });
  ws.getRow(1).font = { bold: true };
  return wb.xlsx.writeBuffer();
}

module.exports = { HEADER_FIELDS, fieldOf, readSheet, writeSheet };
