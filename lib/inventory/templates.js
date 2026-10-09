// The Append/Reset Inventory template: the standard columns, or a warehouse's own layout
// saved with "Use my template" as data/templates/<whId>.json.
const fs = require("fs");
const path = require("path");
const ExcelJS = require("exceljs");
const { cellValue } = require("../core/xlsx");
const { fieldOf, readSheet } = require("./sheet");

const TEMPLATE_COLS = [
  "Bin Code", "HU Code", "HU Kind Code", "Sku Code", "Quantity", "UOM (L0/L2/L3)",
  "Bucket (Good/Damaged)", "Inclusion Status (PRE-GRN/INCLUDED/POST-GIN)",
  "Operation Type (APPEND/RESET)", "Batch Code",
  "Manufacture Date (DD/MM/YYYY)", "Expiry Date (DD/MM/YYYY)",
  "Outer HU", "Outer HU Kind",
];
// a warehouse's own column layout, saved from "Use my template"
const TEMPLATE_DIR = path.join(__dirname, "..", "..", "data", "templates");

function templateFor(whId) {
  try { return JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, `${whId}.json`), "utf8")); } catch { return TEMPLATE_COLS; }
}
const hasTemplate = (whId) => fs.existsSync(path.join(TEMPLATE_DIR, `${whId}.json`));

async function templateHeaders(buffer) {
  const { headers } = await readSheet(buffer).catch(async () => {
    const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
    const h = []; wb.worksheets[0].getRow(1).eachCell((c, i) => { h[i - 1] = String(cellValue(c.value) ?? "").trim(); });
    return { headers: h };
  });
  if (!headers.some((h) => fieldOf(h) === "bin")) throw new Error("That doesn't look like the Append/Reset template: no Bin Code column.");
  return headers;
}

function saveTemplate(whId, headers) {
  fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
  fs.writeFileSync(path.join(TEMPLATE_DIR, `${whId}.json`), JSON.stringify(headers, null, 2));
}

module.exports = { TEMPLATE_COLS, TEMPLATE_DIR, templateFor, hasTemplate, templateHeaders, saveTemplate };
