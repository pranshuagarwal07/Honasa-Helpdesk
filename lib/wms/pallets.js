// Pallets and best fit: a line's share of one pallet, and every pallet in each pallet bin once
// a sheet is in. Used by Check a sheet, the pallet consolidation plan and its IM rows.
const { upper, fmtN } = require("../core/util");

// best fit for a pallet = the SKU's L2inL3 (cases per pallet). A line's share of one
// pallet: L2 qty / L2inL3, L0 qty / (L0inL2 * L2inL3), L3 = whole pallets. null = can't size.
function palletShare(m, sku, uom, qty) {
  const s = m.skus.get(sku), bf = s?.L2inL3;
  if (uom === "L3") return Number(qty);
  if (!bf) return null;
  if (uom === "L2") return qty / bf;
  if (uom === "L0") return s.L0inL2 ? qty / (s.L0inL2 * bf) : null;
  return null;
}
const isResetSheet = (rows) => { const ops = new Set(rows.map((r) => r.op)); return ops.size === 1 && ops.has("RESET"); };

// every pallet in a pallet bin once the sheet is in: stock already there (unless RESET
// replaces that bin) plus the sheet's pallets. key -> {hu, bin, source, lines, rows}
// leaving: bin|hu|sku|batch|uom -> qty a pick task is taking out; it's left out of the pallet's fill,
// but its SKU-batch stays on the pallet until then
function palletsAfter(m, rows, isReset = isResetSheet(rows), leaving = new Map()) {
  const sheetBins = new Set(rows.map((r) => r.bin));
  const out = new Map();
  for (const [bin, hus] of m.palletStock) {
    if (isReset && sheetBins.has(bin)) continue;
    // keyed by bin too: bad data can put one HU code in two bins, and both still take a position
    for (const [hu, lines] of hus) {
      const free = [], gone = [];
      for (const l of lines) {
        const out1 = Math.min(l.qty, leaving.get([bin, hu, l.sku, l.batch, l.uom].join("|")) || 0);
        if (out1 > 0) gone.push({ ...l, qty: out1 });
        if (l.qty - out1 > 1e-9) free.push({ ...l, qty: l.qty - out1 });
      }
      out.set(`E|${hu}|${bin}`, { hu, bin, source: "stock", lines: free, gone, leaving: gone.length > 0, rows: [] });
    }
  }
  for (const r of rows) {
    if (!r.hu || m.binByCode.get(r.bin)?.huType !== "PALLET") continue;
    const k = `S|${r.hu}|${r.bin}`;
    if (!out.has(k)) out.set(k, { hu: r.hu, bin: r.bin, source: "sheet", lines: [], rows: [] });
    out.get(k).lines.push({ sku: r.sku, batch: upper(r.batch), uom: r.uom, qty: Number(r.qty) || 0 });
    out.get(k).rows.push(r.row);
  }
  for (const p of out.values()) {
    const shares = p.lines.map((l) => palletShare(m, l.sku, l.uom, l.qty));
    p.share = shares.some((s) => s === null) ? null : shares.reduce((t, s) => t + s, 0);
    p.skus = new Set(p.lines.map((l) => l.sku));
    p.keys = new Set([...p.lines, ...(p.gone || [])].map((l) => `${l.sku}|${l.batch}`));
  }
  return out;
}
const casesText = (m, p) => p.lines.map((l) => `${fmtN(l.qty)} ${l.uom} of ${l.sku}${l.batch ? ` (${l.batch})` : ""}`).join(" + ");

module.exports = { palletShare, isResetSheet, palletsAfter, casesText };
