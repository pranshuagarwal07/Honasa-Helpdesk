// Verify an upload: did each line of the sheet land in its bin, and which pallets with the
// fill's prefix a failed upload left behind empty.
const { upper } = require("../core/util");

// db = { wms, q, tryQ }
async function verify({ wms, q, tryQ }, whId, rows, prefix) {
  const binCodes = [...new Set(rows.map((r) => r.bin))];
  const actual = await q(wms, `SELECT "binCode", "skuCode", upper(trim(batch)) AS batch, uom, sum(qty)::float AS qty FROM inventory
      WHERE "whId" = $1 AND "deletedAt" IS NULL AND "binCode" = ANY($2) GROUP BY 1, 2, 3, 4`, [whId, binCodes]);
  const have = new Map(actual.map((a) => [`${a.binCode}|${a.skuCode}|${a.batch}|${a.uom}`, a.qty]));
  const want = new Map();
  rows.forEach((r) => { const k = `${r.bin}|${r.sku}|${upper(r.batch)}|${r.uom}`; want.set(k, (want.get(k) || 0) + Number(r.qty)); });
  const lines = [...want].map(([k, qty]) => {
    const [bin, sku, batch, uom] = k.split("|"), got = have.get(k) || 0;
    return { bin, sku, batch, uom, expected: qty, actual: got, status: got === 0 ? "missing" : got === qty ? "landed" : "different" };
  });
  const hus = [...new Set(rows.map((r) => r.hu).filter(Boolean))];
  let emptyHUs = [], err = null;
  if (prefix) {
    [emptyHUs, err] = await tryQ(wms, `SELECT h.code FROM handling_unit h WHERE h."whId" = $1 AND h.code LIKE $2
        AND NOT EXISTS (SELECT 1 FROM handling_unit_quant hq WHERE hq."huId" = h.id AND hq.qty > 0) ORDER BY h.code LIMIT 500`,
      [whId, prefix.replace(/[%_]/g, "\\$&") + "%"]);
  }
  const count = (s) => lines.filter((l) => l.status === s).length;
  return {
    lines: lines.filter((l) => l.status !== "landed").slice(0, 300),
    totals: { lines: lines.length, landed: count("landed"), missing: count("missing"), different: count("different"), hus: hus.length },
    emptyHUs: emptyHUs.map((h) => h.code), emptyHUError: err, prefix,
  };
}

module.exports = { verify };
