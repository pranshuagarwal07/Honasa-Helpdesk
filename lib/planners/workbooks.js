// The workbook behind each planner's download: a summary, the plan sheet by sheet, and the IM
// upload sheets. consolidationSheets is shared with Check a sheet's annotated download.
// The pallet and bins-under-% workbooks read the v2 output contract (docs/CONSOLIDATION_V2.md: stats, warnings,
// zones, moves[].fromZone/toZone/fromArea/toArea/crossZone) and fall back to what older plans carry, so the download
// works whichever planner version made the plan.
const ExcelJS = require("exceljs");
const { pct, litres } = require("../core/util");
const { addSheet } = require("../core/xlsx");
const { casesText } = require("../wms/pallets");
const { addImSheets } = require("../im-upload/files");
const { PALLET_IM_NOTES } = require("../im-upload/rows");

const num = (x, d = 2) => (x === null || x === undefined || Number.isNaN(Number(x)) ? null : +Number(x).toFixed(d));
const coll = new Intl.Collator(undefined, { numeric: true }).compare;
// zone / area of a move's ends: the move's own fields, else the bin's
const where = (m, x) => {
  const f = m?.binByCode?.get(x.fromBin), t = m?.binByCode?.get(x.toBin);
  const fromZone = x.fromZone ?? f?.zone ?? null, toZone = x.toZone ?? t?.zone ?? null;
  return { fromZone, toZone, fromArea: x.fromArea ?? f?.area ?? null, toArea: x.toArea ?? t?.area ?? null,
    cross: (x.crossZone ?? (fromZone !== toZone)) ? "Yes" : "No" };
};
const WHERE_COLS = [["From zone", "fromZone", 12], ["From area", "fromArea", 10], ["To zone", "toZone", 12], ["To area", "toArea", 10], ["Cross-zone", "cross", 10]];

// the contract stats, each with how it was got: the plan's own (v2), else counted here from the plan and its IM rows.
// moves and heldBack always come from the upload files themselves: they are what the IM upload will get.
function contractStats(m, st, { im = [], imHeld = [] }, legacy) {
  const rows = [...im.flatMap((f) => f.rows), ...imHeld];
  const units = (r) => (r.pickHu ? (r.lines || []).reduce((t, l) => t + (Number(l.qty) || 0), 0) : Number(r.qty) || 0);
  const v2 = st && "emptyBinsUsed" in st && "positionsFreed" in st && "crossZoneMoves" in st;
  const pick = (k, fb, how) => (v2 && st[k] !== undefined && st[k] !== null ? { v: st[k], how: "" } : { v: fb, how });
  const binsEmptied = pick("binsEmptied", legacy.binsEmptied, legacy.binsEmptiedHow);
  const emptyBinsUsed = pick("emptyBinsUsed", legacy.emptyBinsUsed, legacy.emptyBinsUsedHow);
  return {
    v2, binsEmptied, emptyBinsUsed,
    netBinsFreed: pick("netBinsFreed", binsEmptied.v - emptyBinsUsed.v, "Bins emptied minus empty bins used"),
    positionsFreed: pick("positionsFreed", legacy.positionsFreed, legacy.positionsFreedHow),
    palletsFreed: pick("palletsFreed", legacy.palletsFreed, legacy.palletsFreedHow),
    moves: { v: rows.length, how: "" },
    casesMoved: pick("casesMoved", num(rows.reduce((t, r) => t + units(r), 0)), "Summed from the IM rows"),
    crossZoneMoves: pick("crossZoneMoves", rows.filter((r) => where(m, r).cross === "Yes").length, "Counted from the IM rows"),
    heldBack: { v: imHeld.length, how: "" },
  };
}
const RESULT_ROWS = [
  ["binsEmptied", "Bins emptied (gross: left with no stock)"], ["emptyBinsUsed", "Empty bins used (were empty, receive stock)"],
  ["netBinsFreed", "Net bins freed (emptied minus empty bins used)"], ["positionsFreed", "Net pallet positions freed"],
  ["palletsFreed", "Pallets freed (merged away)"], ["moves", "Moves (IM upload rows, held back included)"], ["casesMoved", "Units moved (L2 cases + L0 eaches, as they are)"],
  ["crossZoneMoves", "Moves to another zone"], ["heldBack", "Held back from the IM upload (see Not in IM upload; should be 0)"],
];
// Summary: what was asked, the result as the contract counts it, the re-check, then the plan's own details
function summarySheet(wb, head, cs, check, details) {
  const rows = [...head, { k: "" }, { k: "Result", v: cs.v2 ? "" : "This plan predates the v2 counts: rows with a note are counted here" },
    ...RESULT_ROWS.map(([key, label]) => ({ k: label, v: cs[key].v, note: cs[key].how })),
    { k: "Independent re-check of every move", v: !check ? "No independent check for this plan" : check.ok ? "Passed" : `FAILED: ${(check.errs || []).slice(0, 3).join("; ")}` },
    { k: "" }, { k: "Details" }, ...details];
  const s = addSheet(wb, "Summary", [["What", "k", 58], ["Value", "v", 40], ["Note", "note", 60]], rows);
  s.eachRow((r) => { if (["Result", "Details"].includes(r.getCell(1).value)) r.font = { bold: true }; });
  return s;
}
// Warnings: the plan's warnings[]; an older plan has none, so the ones its IM rows show are listed instead
function warningsSheet(wb, m, warnings, { im = [], imHeld = [] }) {
  let list = warnings;
  if (!Array.isArray(list)) {
    const rows = im.flatMap((f) => f.rows), cz = rows.filter((r) => where(m, r).cross === "Yes");
    list = [{ level: "info", code: "no-warnings", text: "This plan doesn't report warnings (older planner). Listed below: what its IM rows show.", bins: [] }];
    if (cz.length) list.push({ level: "warn", code: "cross-zone", text: `${cz.length} upload row(s) move stock to another zone.`, bins: cz.flatMap((r) => [r.fromBin, r.toBin]) });
    if (imHeld.length) list.push({ level: "warn", code: "held-back", text: `${imHeld.length} planned row(s) are left out of the IM upload (see Not in IM upload).`, bins: imHeld.map((r) => r.toBin) });
  }
  const LEVEL = { block: "Blocks", warn: "Warning", info: "Info" };
  addSheet(wb, "Warnings", [["Level", "level", 10], ["Code", "code", 24], ["What", "text", 100], ["Bins", "n", 7], ["Bin codes", "bins", 80]],
    list.length ? list.map((w) => ({ ...w, level: LEVEL[w.level] || w.level, n: (w.bins || []).length, bins: [...new Set(w.bins || [])].sort(coll).join(", ") }))
      : [{ level: "", code: "", text: "No warnings" }]);
}
// Zones: per zone after the plan (zones[]); without it, counted here from the bins emptied and empty bins used
function zonesSheet(wb, m, zones, emptied, emptyUsed) {
  let rows = zones;
  if (!rows?.length || !rows.some((z) => "binsEmptied" in z)) {
    const by = new Map();
    const z = (code) => { const b = m.binByCode.get(code), k = b?.zone || "(no zone)"; if (!by.has(k)) by.set(k, { zone: k, area: b?.area || "", binsEmptied: 0, emptyBinsUsed: 0, positionsFreed: 0 }); return [by.get(k), b]; };
    const cap = (b) => (b?.huType === "PALLET" ? Math.max(1, b.cap || 1) : 0);
    for (const c of emptied) { const [r, b] = z(c); r.binsEmptied++; r.positionsFreed += cap(b); }
    for (const c of emptyUsed) { const [r, b] = z(c); r.emptyBinsUsed++; r.positionsFreed -= cap(b); }
    const old = new Map((rows || []).map((x) => [x.zone, x])); // an older pallet plan's zones: bins, positions, used before
    rows = [...by.values()].map((r) => ({ ...old.get(r.zone), ...r, note: "Counted from the bins emptied and empty bins used (older plan)" }));
  }
  addSheet(wb, "Zones", [["Zone", "zone", 14], ["Area", "area", 12], ["Bins", "bins", 8], ["Positions", "positions", 10], ["Used after", "used", 10], ["Spare after", "spare", 10],
    ["Bins emptied", "binsEmptied", 10], ["Empty bins used", "emptyBinsUsed", 10], ["Net positions freed", "positionsFreed", 12], ["Pallets freed", "frees", 10], ["Note", "note", 50]],
    [...rows].sort((a, b) => coll(String(a.area), String(b.area)) || coll(String(a.zone), String(b.zone))));
}

// the merge plan, pour by pour, and every pallet's fill; shared by the checked sheet and the stock plan
function consolidationSheets(wb, m, cons, pack) {
  addSheet(wb, "Consolidation", [["SKU", "sku", 18], ["Batch", "batch", 16], ["Best fit (cases)", "bestFit"], ["Partial pallets", "pallets"],
    ["Cases in them", "cases"], ["Pallets needed", "need"], ["Pallets freed", "frees"], ["Bins", "bins", 8], ["Pallets (HU@bin fill)", "list", 90]],
    cons.merges.map((g) => ({ ...g, bestFit: num(g.bestFit), cases: num(g.cases), list: (g.list || []).join(", ") })));
  addSheet(wb, "Moves", [["Step", "step", 6], ["SKU", "sku", 18], ["Batch", "batch", 16], ["From bin", "fromBin", 18], ["From pallet", "fromHu", 18],
    ["To bin", "toBin", 18], ["To pallet", "toHu", 18], ["Qty", "qty", 8], ["Unit", "uom", 6], ["Cases", "cases", 10], ["Share of a pallet", "share", 16], ...WHERE_COLS],
    cons.moves.map((x) => ({ ...x, cases: num(x.cases), share: x.share === null || x.share === undefined ? null : pct(x.share), ...where(m, x) })));
  if (pack) addSheet(wb, "Bin moves", [["Step", "step", 6], ["Zone", "zone", 14], ["Bin type", "binType", 14], ["Empty this bin", "fromBin", 18], ["Pallet", "hu", 18],
    ["Move it to bin", "toBin", 18], ["To bin type", "toBinType", 14], ["To bin was empty", "wasEmpty", 9], ["Stock on it", "stock", 60], ...WHERE_COLS],
    pack.moves.map((x) => ({ ...x, wasEmpty: x.toWasEmpty === undefined ? null : x.toWasEmpty ? "Yes" : "No", toBinType: x.toBinType ?? m.binByCode.get(x.toBin)?.binType, ...where(m, x) })));
  addSheet(wb, "Pallet fill", [["Zone", "zone", 14], ["Bin", "bin", 18], ["Pallet", "hu", 18], ["From", "source", 9], ["Stock", "stock", 60],
    ["Fill vs best fit", "fill", 14], ["State", "state", 16], ["Plan", "merge", 26]],
    cons.pallets.map((p) => ({ zone: m.binByCode.get(p.bin)?.zone, bin: p.bin, hu: p.hu, source: p.source === "sheet" ? "Sheet" : "In stock",
      stock: casesText(m, p) + (p.gone?.length ? ` · being picked (not counted): ${casesText(m, { lines: p.gone })}` : ""), fill: p.share === null || p.share === undefined ? "" : pct(p.share), state: p.state,
      merge: p.mergeInto ? "Empty it (see Moves)" : p.keepFor ? "Keep, receives cases" : p.moveTo ? `Move whole to ${p.moveTo} (see Bin moves)` : "" }))
      .sort((a, b) => String(a.zone).localeCompare(String(b.zone)) || a.bin.localeCompare(b.bin)));
  if (cons.shelf?.top?.length) addSheet(wb, "Shelf spread", [["SKU", "sku", 18], ["Batch", "batch", 16], ["Bins", "bins", 8], ["Bin codes", "list", 90]],
    cons.shelf.top.map((x) => ({ ...x, list: x.list.join(", ") })));
}

// p: what the consolidate route keeps for the download: { m, cons, pack, im, imHeld } and, from v2, plan, check
async function planWorkbook(p) {
  const { m, cons, pack } = p, plan = p.plan || cons, st = plan.stats || cons.stats, o = plan.opts || {};
  const wb = new ExcelJS.Workbook();
  // the older plan: bins emptied by merging plus by whole-pallet moves; no empty bin is ever used; a position per pallet merged away
  const emptiedOld = [...(cons.emptiedBins || []), ...(pack?.bins || []).map((b) => b.bin)];
  const emptied = plan.bins?.emptied || emptiedOld, emptyUsed = plan.bins?.emptyUsed || [];
  const cs = contractStats(m, st, p, { binsEmptied: emptiedOld.length, binsEmptiedHow: "Bins emptied by merging + by moving whole pallets",
    emptyBinsUsed: 0, emptyBinsUsedHow: "This plan only moves into bins already holding pallets",
    positionsFreed: st.frees, positionsFreedHow: "Older count: one position per pallet merged away (whole-pallet moves free none)",
    palletsFreed: st.frees, palletsFreedHow: "Pallets merged away" });
  const cells = (x) => (Array.isArray(x) ? x : x?.cells || []).join(", ") || "Every inventory pallet bin";
  summarySheet(wb, [
    { k: "Warehouse", v: m.whId }, { k: "Stock read at", v: new Date(m.loadedAt).toLocaleString() },
    { k: "Empty bins of (zone | bin type)", v: cells(o.from) }, { k: "Into bins of (zone | bin type)", v: cells(o.to) },
    ...(p.plan ? [{ k: "Moves between zones", v: o.crossZone ? "Allowed where the search table lets the stock in" : "No, same zone only" },
      { k: "Also move whole pallets to empty bins", v: o.wholePallets === false ? "No" : "Yes" }, { k: "Keep bins within the bin type's max kg", v: o.checkWeight === false ? "No" : "Yes" },
      { k: "Aim for", v: o.objective === "bins" ? "Most bins emptied" : "Most pallet positions freed" }] : []),
  ], cs, p.check, [
    { k: "Pallet bins (storage, active)", v: st.palletBins }, { k: "Pallet positions", v: st.positions },
    { k: "Positions used", v: st.used }, { k: "Positions free", v: st.spare }, { k: "Pallet bins completely empty", v: st.emptyBins },
    { k: "Pallets", v: st.pallets }, { k: "Full pallets (at best fit)", v: st.full }, { k: "Partial pallets", v: st.partial },
    { k: "Over best fit", v: st.over }, { k: "Mixed SKU/batch pallets", v: st.mixed }, { k: "Pallets without an L2inL3", v: st.unsized },
    { k: "Pallets locked by a task (left out)", v: st.locked || 0 },
    { k: "Pallets in bins with locked stock or stock arriving (put lock; left out, and nothing moves into those bins)", v: st.busy || 0 },
    { k: "Pallets whose stock is all being picked (left out)", v: st.picking || 0 },
    { k: "Stock being picked (pick lock)", v: "Not counted in a pallet's fill and never moved; still counted in the WMS capacity check until it's picked" },
    { k: "Pallets freed by merging same SKU + batch", v: st.frees }, { k: "  of which inside the same bin", v: st.sameBinFrees },
    { k: "Bins emptied by merging", v: st.mergeBinsEmptied ?? (p.plan ? undefined : st.binsEmptied) },
    { k: "Bins emptied by moving whole pallets", v: pack?.stats?.bins }, { k: "  whole pallets to move", v: pack?.stats?.pallets },
    { k: "Free positions after merging", v: (st.spare || 0) + (st.frees || 0) },
    { k: "Shelf SKU-batches spread over several bins", v: cons.shelf?.groups },
  ].filter((r) => r.v !== undefined));
  warningsSheet(wb, m, plan.warnings, p);
  zonesSheet(wb, m, plan.zones || cons.zones, emptied, emptyUsed);
  addSheet(wb, "Bins emptied", [["Bin", "bin", 16], ["Zone", "zone", 12], ["Area", "area", 12], ["Bin type", "binType", 16], ["Positions", "cap", 9], ["How", "how", 40]],
    [...emptied].sort(coll).map((c) => { const b = m.binByCode.get(c) || {}; const whole = (pack?.bins || []).find((x) => x.bin === c);
      return { bin: c, zone: b.zone, area: b.area, binType: b.binType, cap: b.cap, how: whole ? `Whole pallets moved to ${whole.to.join(", ")}` : "Its pallets merged onto others (see Moves)" }; }));
  consolidationSheets(wb, m, cons, pack);
  addImSheets(wb, p.im, PALLET_IM_NOTES, p.imHeld);
  return wb.xlsx.writeBuffer();
}

const HOW = { merge: "Onto a pallet already there", pallet: "Whole pallet", pour: "Loose into the bin" };
async function relocateWorkbook(p) {
  const { m, plan, check, im, imHeld } = p;
  const wb = new ExcelJS.Workbook(), st = plan.stats, o = plan.opts;
  const emptyUsed = [...new Set(plan.moves.filter((x) => x.toWasEmpty).map((x) => x.toBin))];
  const cs = contractStats(m, st, p, { binsEmptied: st.binsEmptied, emptyBinsUsed: st.emptyBinsUsed ?? emptyUsed.length, positionsFreed: st.positionsFreed,
    palletsFreed: st.palletsMerged, palletsFreedHow: "Pallets merged onto others (moved whole ones stay)" });
  summarySheet(wb, [
    { k: "Warehouse", v: m.whId }, { k: "Stock read at", v: new Date(m.loadedAt).toLocaleString() },
    { k: "Empty bins of (zone | bin type)", v: (o.from.cells || []).join(", ") || "All" }, { k: "Into bins of (zone | bin type)", v: (o.to.cells || []).join(", ") || "All" },
    { k: "Only bins under (% full)", v: o.belowPct >= 100 ? "Any fill" : o.belowPct },
    { k: "How full is measured", v: "Pallet bins: full pallets (the SKU's L3) over pallet positions. Shelf bins: stock volume over bin volume." },
    { k: "Empty bins can receive", v: { smaller: "Only bins smaller than the one being emptied", any: "Any empty bin", none: "No" }[o.useEmpty] }, { k: "Keep bins within the bin type's max kg", v: o.checkWeight ? "Yes" : "No" },
  ], cs, check, [
    { k: "Bins to empty from", v: st.fromBins }, { k: "  holding stock", v: st.fromStocked }, { k: `  under ${o.belowPct}% full`, v: st.under },
    { k: "  of those, could be planned (unlocked, active, sized)", v: st.candidates },
    { k: "Bins that can receive", v: st.toUsable }, { k: "  of them empty", v: st.toEmpty },
    { k: "Bins emptied", v: st.binsEmptied }, { k: "Steps", v: st.plannedMoves ?? st.steps ?? plan.moves.length }, { k: "Pallets moved whole", v: st.palletsMovedWhole },
    { k: "Pallets merged onto others", v: st.palletsMerged }, { k: "Empty bins used", v: st.emptyBinsUsed }, { k: "Net bins freed (emptied minus empty bins used)", v: st.netBinsFreed ?? st.netFreed }, { k: "Pallet positions freed", v: st.positionsFreed },
    { k: "Do the steps in order", v: "A later step can put cases onto a pallet an earlier step moved in." },
  ].filter((r) => r.v !== undefined));
  warningsSheet(wb, m, plan.warnings, p);
  zonesSheet(wb, m, plan.zones, plan.emptied.map((e) => e.bin), emptyUsed);
  relocateSheets(wb, m, plan);
  addImSheets(wb, im, ["A step that puts cases onto a pallet an earlier step moves in is in a later upload."], imHeld);
  return wb.xlsx.writeBuffer();
}
// Steps, Bins emptied and Not emptied of a Bins under % full plan; names: other sheet names (the combined workbook)
function relocateSheets(wb, m, plan, names = {}) {
  const pc = (x) => (x === null || x === undefined ? null : +(x * 100).toFixed(1));
  addSheet(wb, names.steps || "Steps", [["Step", "step", 6], ...(plan.moves.some((x) => x.stage) ? [["Stage", "stageText", 16]] : []), ["From bin", "fromBin", 16], ["From zone", "fromZone", 12], ["From area", "fromArea", 10], ["From bin type", "fromBinType", 16], ["From % full", "fromPct", 9],
    ["Pallet", "hu", 14], ["SKU", "sku", 18], ["Batch", "batch", 14], ["Qty", "qty", 8], ["Unit", "uom", 6], ["How", "how", 26],
    ["To bin", "toBin", 16], ["To zone", "toZone", 12], ["To area", "toArea", 10], ["To bin type", "toBinType", 16], ["Cross-zone", "cross", 10], ["To pallet", "toHu", 14], ["To bin was empty", "wasEmpty", 9],
    ["To pallet after (% of a full pallet)", "palletAfter", 12], ["Pallets in to bin after", "positions", 10], ["Positions", "toCap", 9],
    ["To bin volume after (L)", "volAfter", 11], ["To bin kg after", "kg", 10], ["To bin max kg", "toMaxKg", 10]],
    plan.moves.map((x) => ({ ...x, ...where(m, x), stageText: x.stage === 1 ? "1: merge pallets" : x.stage === 2 ? "2: empty bins" : null, fromPct: num(x.fromOccPct), how: x.kind === "merge" && x.fromBin === x.toBin ? "Onto a pallet in the same bin" : HOW[x.kind], wasEmpty: x.toWasEmpty ? "Yes" : "No", palletAfter: x.kind === "pour" ? null : pc(x.toPalletAfter),
      positions: x.kind === "pour" ? null : x.toPositions, toCap: x.kind === "pour" ? null : x.toCap, volAfter: x.kind === "pour" ? litres(x.toUsedAfterCC) : null, kg: num(x.toKgAfter, 1) })));
  addSheet(wb, names.emptied || "Bins emptied", [["Bin", "bin", 16], ["Zone", "zone", 12], ["Area", "area", 12], ["Bin type", "binType", 16], ["% full", "pct", 8], ["Pallets", "pallets", 8], ["Into", "to", 40], ["Note", "note", 40]],
    plan.emptied.map((e) => ({ ...e, pct: num(e.occPct), to: e.to.join(", "), note: e.afterPick ? "Empty once the stock being picked from it leaves" : "" })));
  addSheet(wb, names.notEmptied || "Not emptied", [["Bin", "bin", 16], ["Zone", "zone", 12], ["Area", "area", 12], ["Bin type", "binType", 16], ["% full", "pct", 8], ["Why", "why", 60], ["Stock", "stock", 70]],
    plan.notEmptied.map((n) => ({ ...n, pct: num(n.occPct) })));
}

async function eachesWorkbook({ m, plan, check, im, imHeld }) {
  const wb = new ExcelJS.Workbook(), st = plan.stats, o = plan.opts;
  addSheet(wb, "Summary", [["What", "k", 52], ["Value", "v", 40]], [
    { k: "Warehouse", v: m.whId }, { k: "Stock read at", v: new Date(m.loadedAt).toLocaleString() },
    { k: "Areas", v: (o.areas || []).join(", ") || "All" }, { k: "Zones", v: (o.zones || []).join(", ") || "All" },
    { k: "Bin types", v: (o.binTypes || []).join(", ") || "All" },
    { k: "Units moved", v: (o.uoms || ["L0"]).map((x) => ({ L0: "Eaches (L0)", L2: "Cases (L2), whole", L3: "Outer cases (L3), whole" })[x]).join(", ") },
    { k: "Only empty bins under (% of bin volume)", v: o.emptyBelowPct >= 100 ? "Any fill" : o.emptyBelowPct },
    { k: "  bins at or above that, used only to receive", v: st.tooFull || 0 },
    { k: "Pour between zones of an area", v: o.crossZone ? "Yes" : "No, only within a zone" },
    { k: "Keep bins within the bin type's max kg", v: o.checkWeight ? "Yes" : "No (WMS putaway doesn't check weight either)" }, { k: "Fill targets up to (% of bin volume)", v: o.fillPct },
    { k: "Shelf bins in scope", v: st.binsInScope }, { k: "  holding stock", v: st.occupied }, { k: "  usable (chosen units only, unlocked, sized)", v: st.usable },
    { k: "  left out: locked by a task", v: st.locked }, { k: "  left out: fixed bins", v: st.fixed }, { k: "  left out: SKU without a volume for its unit", v: st.unsized },
    { k: "  left out: holds a unit not chosen", v: st.nonEach }, { k: "  emptied only, never filled: already breaks its mixing rules", v: st.broken },
    { k: "Bins whose bin type volume looks unset", v: st.suspectVol }, { k: "Every bin left out, with the reason", v: "See the Left out sheet" },
    { k: "Bins emptied", v: st.binsEmptied }, { k: "Most that could be emptied (upper bound)", v: st.bestPossible },
    { k: "Plan is the best possible", v: st.optimal ? "Yes" : "Not proven" },
    { k: "Moves", v: st.moves }, { k: "Eaches moved", v: st.eachesMoved },
    { k: "Every move re-checked (volume, weight, mixing rules)", v: check.ok ? "Passed" : `FAILED: ${check.errs.slice(0, 3).join("; ")}` },
  ]);
  eachesSheets(wb, plan);
  addImSheets(wb, im, [], imHeld);
  return wb.xlsx.writeBuffer();
}
// Moves, Bins emptied, Bins receiving and Left out of a shelf plan; prefix: sheet name prefix (the combined workbook)
function eachesSheets(wb, plan, prefix = "") {
  const name = (n) => (prefix ? prefix + n[0].toLowerCase() + n.slice(1) : n); // Shelf moves, Shelf bins emptied, ...
  addSheet(wb, name("Moves"), [["Step", "step", 6], ["SKU", "sku", 18], ["Batch", "batch", 14], ["Qty", "qty", 8], ["Unit", "uom", 7], ["From bin", "fromBin", 16], ["From zone", "fromZone", 13],
    ["From bin volume (L)", "fromVol", 12], ["From bin used (L)", "fromUsed", 12], ["To bin", "toBin", 16], ["To zone", "toZone", 13],
    ["Unit volume (cc)", "unitVolCC", 11], ["Move volume (L)", "moveVol", 11], ["To bin volume (L)", "toVol", 12], ["To bin before (L)", "before", 12],
    ["To bin after (L)", "after", 12], ["To bin after (% full)", "pct", 12], ["To bin kg after", "kg", 10], ["To bin max kg", "toMaxKg", 10], ["Same SKU-batch already there", "sameKey", 12]],
    plan.moves.map((p) => ({ ...p, fromVol: litres(p.fromBinVolCC), fromUsed: litres(p.fromUsedCC), moveVol: litres(p.moveVolCC), toVol: litres(p.toBinVolCC),
      before: litres(p.toUsedBeforeCC), after: litres(p.toUsedAfterCC), pct: p.toBinVolCC ? +(p.toUsedAfterCC / p.toBinVolCC * 100).toFixed(1) : null,
      kg: +p.toKgAfter.toFixed(2), unitVolCC: +p.unitVolCC.toFixed(1), sameKey: p.sameKey ? "Yes" : "No" })));
  addSheet(wb, name("Bins emptied"), [["Bin", "bin", 16], ["Zone", "zone", 14], ["Area", "area", 12], ["Bin type", "binType", 14], ["Volume (L)", "vol", 10],
    ["Used (L)", "used", 10], ["Lines", "lines", 8], ["Into", "to", 40], ["Note", "note", 40]],
    plan.emptied.map((e) => ({ ...e, vol: litres(e.volCC), used: litres(e.usedCC), to: e.to.join(", "), note: e.afterPick ? "Empty once the stock being picked from it leaves" : "" })));
  addSheet(wb, name("Bins receiving"), [["Bin", "bin", 16], ["Zone", "zone", 14], ["Volume (L)", "vol", 10], ["Before (L)", "before", 10], ["Poured in (L)", "in", 11],
    ["After (L)", "after", 10], ["After (% full)", "pct", 11], ["kg after", "kg", 9], ["Max kg", "maxKg", 8], ["From", "from", 40]],
    plan.targets.map((t) => ({ ...t, vol: litres(t.volCC), before: litres(t.beforeCC), in: litres(t.inCC), after: litres(t.afterCC),
      pct: t.fillPct === null ? null : +t.fillPct.toFixed(1), kg: +t.kgAfter.toFixed(2), from: t.from.join(", ") })));
  addSheet(wb, name("Left out"), [["Bin", "bin", 16], ["Zone", "zone", 14], ["Area", "area", 12], ["Bin type", "binType", 14], ["Why", "reason", 50], ["Stock", "stock", 60]],
    [...plan.leftOut].sort((a, b) => a.reason.localeCompare(b.reason) || a.bin.localeCompare(b.bin, undefined, { numeric: true })));
}

// the one Consolidate plan (combined.js): the Pallets workbook as it was for "tidy"; for "empty", one Summary,
// Warnings and Zones over every part, then each part's own sheets and the IM upload sheets
// p: { m, goal, parts, combined, im, imHeld }
async function combinedWorkbook(p) {
  const { m, goal, parts, combined: c, im, imHeld } = p;
  if (goal === "tidy" && parts.length === 1) {
    const plan = parts[0].plan;
    return planWorkbook({ m, cons: { ...plan, shelf: p.shelf || { top: [] } }, pack: plan.pack, plan, check: c.check, im, imHeld });
  }
  const wb = new ExcelJS.Workbook(), o = c.opts || {}, st = c.stats;
  const part = (k) => parts.find((x) => x.kind === k);
  const pal = part("pallet"), shelf = part("shelf");
  const cs = contractStats(m, st, p, { binsEmptied: st.binsEmptied, emptyBinsUsed: st.emptyBinsUsed, positionsFreed: st.positionsFreed, palletsFreed: st.palletsFreed });
  const cells = (x) => (x || []).join(", ") || "None";
  summarySheet(wb, [
    { k: "Warehouse", v: m.whId }, { k: "Stock read at", v: new Date(m.loadedAt).toLocaleString() },
    { k: "Goal", v: goal === "tidy" ? "Tidy pallets: free positions inside bins" : `Empty bins under ${o.belowPct >= 100 ? "any" : o.belowPct + "%"} full` },
    { k: "Take stock from (zone | bin type)", v: cells(o.from) }, { k: "Put it into (zone | bin type)", v: cells(o.to) },
    { k: "Moves between zones", v: o.crossZone ? "Allowed where the search table lets the stock in" : "No, same zone only" },
    { k: "Keep bins within the bin type's max kg", v: o.checkWeight === false ? "No" : "Yes" },
    { k: "Aim for", v: o.objective === "bins" ? "Most bins emptied" : "Most pallet positions freed" },
    ...(pal ? [{ k: "Pallet bins: empty bins can receive", v: { smaller: "Only bins smaller than the one being emptied", any: "Any empty bin", none: "No" }[pal.plan.opts.useEmpty] }] : []),
    ...(shelf ? [{ k: "Shelf bins: units moved", v: shelf.plan.opts.uoms.join(", ") }, { k: "Shelf bins: fill up to (% of volume)", v: shelf.plan.opts.fillPct }] : []),
  ], cs, c.check, [
    ...(pal ? [{ k: pal.engine === "chain" ? (pal.plan.stats.mergedFirst ? "Pallet bins (part-full pallets merged first, then bins emptied)" : "Pallet bins (bins emptied; merging first freed less, so it wasn't used)")
      : "Pallet bins (Bins under % full planner)" }, { k: "  bins emptied", v: pal.plan.stats.binsEmptied }, { k: "  empty bins used", v: pal.plan.stats.emptyBinsUsed },
      ...(pal.engine === "chain" ? [{ k: "  case moves merging pallets first", v: pal.plan.stats.mergeMoves }, { k: "  without merging first: positions / net bins / moves", v: `${pal.plan.stats.plain.positionsFreed} / ${pal.plan.stats.plain.netBinsFreed} / ${pal.plan.stats.plain.moves}` },
        { k: "  merging first: positions / net bins / moves", v: `${pal.plan.stats.chain.positionsFreed} / ${pal.plan.stats.chain.netBinsFreed} / ${pal.plan.stats.chain.moves}` }] : []),
      { k: "  net pallet positions freed", v: pal.plan.stats.positionsFreed }, { k: "  pallets moved whole", v: pal.plan.stats.palletsMovedWhole }, { k: "  pallets merged onto others", v: pal.plan.stats.palletsMerged },
      { k: "  re-check", v: pal.check.ok ? "Passed" : "FAILED" }] : []),
    ...(shelf ? [{ k: "Shelf bins (shelf planner)" }, { k: "  bins emptied", v: shelf.plan.stats.binsEmptied }, { k: "  most that could be emptied (upper bound)", v: shelf.plan.stats.bestPossible },
      { k: "  units moved", v: shelf.plan.stats.eachesMoved }, { k: "  re-check", v: shelf.check.ok ? "Passed" : "FAILED" }] : []),
    { k: "Do the steps in order", v: "A later step can put cases onto a pallet an earlier step moved in." },
  ].filter((r) => r.v !== undefined));
  warningsSheet(wb, m, c.warnings, p);
  zonesSheet(wb, m, c.zones, c.bins.emptied, c.bins.emptyUsed);
  if (pal) relocateSheets(wb, m, pal.plan, shelf ? { steps: "Pallet steps", emptied: "Pallet bins emptied", notEmptied: "Pallet bins not emptied" } : {});
  if (shelf) eachesSheets(wb, shelf.plan, pal ? "Shelf " : "");
  addImSheets(wb, im, pal ? ["A step that puts cases onto a pallet an earlier step moves in is in a later upload."] : [], imHeld);
  return wb.xlsx.writeBuffer();
}

module.exports = { consolidationSheets, planWorkbook, relocateWorkbook, eachesWorkbook, combinedWorkbook };
