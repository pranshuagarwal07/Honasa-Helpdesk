// Test case builder: the page edits rows and sends them here as plain JSON.
const { upper, dayKeyOf } = require("../core/util");

// grid rows arrive as plain JSON; give them the same shape readSheet produces
function normalizeRows(list) {
  return list.map((r, i) => ({
    row: i + 2,
    bin: String(r.bin ?? "").trim(), hu: String(r.hu ?? "").trim(), hukind: String(r.hukind ?? "").trim(),
    sku: String(r.sku ?? "").trim(), qty: Number(r.qty), uom: upper(r.uom), bucket: String(r.bucket ?? "").trim(),
    inclusion: upper(r.inclusion), op: upper(r.op), batch: upper(r.batch), mfg: dayKeyOf(r.mfg), exp: dayKeyOf(r.exp),
  }));
}

module.exports = { normalizeRows };
