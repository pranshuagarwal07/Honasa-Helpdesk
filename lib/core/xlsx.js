// Excel helpers: a plain sheet with a frozen bold header, and a cell's value whatever form ExcelJS gives it.

// cols: [[header, key, width]]; data: one object per row, keyed by the cols' keys
const addSheet = (wb, name, cols, data) => {
  const s = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
  s.columns = cols.map(([header, key, w]) => ({ header, key, width: w || 14 }));
  s.getRow(1).font = { bold: true };
  data.forEach((d) => s.addRow(d));
  return s;
};

// formula cells carry a result, hyperlinks text, rich text runs
function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== "object") return v;
  if ("result" in v) return v.result;
  if ("text" in v) return v.text;
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  return String(v);
}

module.exports = { addSheet, cellValue };
