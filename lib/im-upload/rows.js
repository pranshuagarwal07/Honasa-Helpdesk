// IM cockpit upload rows from each plan: pallet merges then whole-pallet bin moves, bins under
// % full, and shelf eaches. files.js splits them into upload files.
const { palletShare } = require("../wms/pallets");
const { LOCK_KIND, ZERO_ID } = require("../wms/locks");

// a whole-pallet row shows the stock only for a single-SKU pallet (the uploader ignores it)
const wholeRow = (fromBin, hu, toBin, lines, extra) => {
  const one = lines.length === 1 ? lines[0] : null;
  return { fromBin, hu, toBin, pickHu: true, ...(one ? { sku: one.sku, batch: one.batch, bucket: one.bucket, uom: one.uom, qty: one.qty } : {}),
    lines: lines.map((l) => ({ sku: l.sku, uom: l.uom, qty: l.qty })), ...extra };
};
// pallet stock with bucket and ILOC, which the merge plan doesn't carry: bin|hu -> lines
async function palletLines({ wms, q }, whId) {
  const rows = await q(wms, `SELECT "binCode", "huCode", "skuCode" AS sku, upper(trim(batch)) AS batch, bucket, uom, iloc, sum(qty)::float AS qty FROM inventory
                                WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0 AND "huCode" IS NOT NULL AND ${LOCK_KIND} = ''
                                GROUP BY 1, 2, 3, 4, 5, 6, 7`, [whId, ZERO_ID]);
  const out = new Map();
  for (const r of rows) { const k = `${r.binCode}|${r.huCode}`; if (!out.has(k)) out.set(k, []); out.get(k).push(r); }
  return out;
}
// merges: cases off each emptied pallet, the plan's shares turned into its real lines;
// then the whole-pallet bin moves, which assume the merges are done
function palletImRows(m, cons, pack, lines) {
  const rows = [], got = new Map(); // hu -> cases received, for the stock shown on its later whole move
  const byDrop = new Map();
  for (const mv of cons.moves) { const k = `${mv.fromBin}|${mv.fromHu}`; if (!byDrop.has(k)) byDrop.set(k, []); byDrop.get(k).push(mv); }
  for (const [k, mvs] of byDrop) {
    // biggest unit first; each pour gets whole units up to its running share, the last takes the rest
    const units = (lines.get(k) || []).map((l) => ({ l, left: l.qty, u: palletShare(m, l.sku, l.uom, 1) })).filter((x) => x.u).sort((a, b) => b.u - a.u);
    let target = 0, done = 0;
    mvs.forEach((mv, i) => {
      target += mv.share;
      for (const x of units) {
        const n = i === mvs.length - 1 ? x.left : Math.min(x.left, Math.floor((target - done) / x.u + 1e-9));
        if (n <= 0) continue;
        x.left -= n; done += n * x.u;
        rows.push({ fromBin: mv.fromBin, hu: mv.fromHu, sku: x.l.sku, batch: x.l.batch, bucket: x.l.bucket, uom: x.l.uom, qty: n, iloc: x.l.iloc,
          toBin: mv.toBin, pickHu: false, toHu: mv.fromBin === mv.toBin ? mv.toHu : null, toPallet: mv.toHu, unit: k });
        if (!got.has(mv.toHu)) got.set(mv.toHu, []);
        got.get(mv.toHu).push({ ...x.l, qty: n });
      }
    });
  }
  for (const mv of pack.moves) {
    const sum = new Map();
    for (const l of [...(lines.get(`${mv.fromBin}|${mv.hu}`) || []), ...(got.get(mv.hu) || [])]) {
      const k = [l.sku, l.batch, l.bucket, l.uom].join("|");
      sum.set(k, { ...l, qty: (sum.get(k)?.qty || 0) + l.qty });
    }
    rows.push(wholeRow(mv.fromBin, mv.hu, mv.toBin, [...sum.values()], { phase: 2, unit: `pack|${mv.fromBin}` }));
  }
  return rows;
}
// bins under % full: whole pallets, cases onto a pallet in another bin, loose pours; in step order
function relocateImRows(plan) {
  const rows = [], seen = new Set();
  plan.moves.forEach((p, i) => {
    if (p.kind === "pallet") {
      const k = `${p.fromBin}|${p.hu}|${p.toBin}`;
      if (seen.has(k)) return;
      seen.add(k);
      rows.push(wholeRow(p.fromBin, p.hu, p.toBin, plan.moves.filter((x, j) => j >= i && x.kind === "pallet" && x.hu === p.hu && x.fromBin === p.fromBin && x.toBin === p.toBin)));
    } else {
      rows.push({ fromBin: p.fromBin, hu: p.hu || null, sku: p.sku, batch: p.batch, bucket: p.bucket, uom: p.uom, qty: p.qty, iloc: p.iloc, toBin: p.toBin,
        pickHu: false, toHu: p.kind === "merge" && p.fromBin === p.toBin ? p.toHu : null, toPallet: p.kind === "merge" ? p.toHu : null });
    }
  });
  return rows;
}
// shelf eaches: loose stock, bin to bin
const eachesImRows = (plan) => plan.moves.map((p) => ({ fromBin: p.fromBin, sku: p.sku, batch: p.batch, bucket: p.bucket, uom: p.uom, qty: p.qty, iloc: p.iloc, toBin: p.toBin, pickHu: false }));
const PALLET_IM_NOTES = ["The whole-pallet moves assume the case moves have emptied their pallets, so they're in a later upload."];
const imSummary = (files) => files.map((f) => ({ n: f.n, wave: f.wave, what: f.what, rows: f.rows.length, whole: f.whole, sameBin: f.sameBin }));

module.exports = { wholeRow, palletLines, palletImRows, relocateImRows, eachesImRows, PALLET_IM_NOTES, imSummary };
