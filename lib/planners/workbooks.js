// The workbook behind each planner's download: a summary, the plan sheet by sheet, and the IM
// upload sheets. consolidationSheets is shared with Check a sheet's annotated download.
const ExcelJS = require("exceljs");
const { pct, litres } = require("../core/util");
const { addSheet } = require("../core/xlsx");
const { casesText } = require("../wms/pallets");
const { addImSheets } = require("../im-upload/files");
const { PALLET_IM_NOTES } = require("../im-upload/rows");

// the merge plan, pour by pour, and every pallet's fill; shared by the checked sheet and the stock plan
function consolidationSheets(wb, m, cons, pack) {
  addSheet(wb, "Consolidation", [["SKU", "sku", 18], ["Batch", "batch", 16], ["Best fit (cases)", "bestFit"], ["Partial pallets", "pallets"],
    ["Cases in them", "cases"], ["Pallets needed", "need"], ["Pallets freed", "frees"], ["Bins", "bins", 8], ["Pallets (HU@bin fill)", "list", 90]],
    cons.merges.map((g) => ({ ...g, bestFit: g.bestFit && +g.bestFit.toFixed(2), cases: g.cases === null ? null : +g.cases.toFixed(2), list: g.list.join(", ") })));
  addSheet(wb, "Moves", [["SKU", "sku", 18], ["Batch", "batch", 16], ["From bin", "fromBin", 18], ["From pallet", "fromHu", 18],
    ["To bin", "toBin", 18], ["To pallet", "toHu", 18], ["Cases", "cases", 10], ["Share of a pallet", "share", 16]],
    cons.moves.map((x) => ({ ...x, cases: x.cases === null ? null : +x.cases.toFixed(2), share: pct(x.share) })));
  if (pack) addSheet(wb, "Bin moves", [["Zone", "zone", 14], ["Bin type", "binType", 14], ["Empty this bin", "fromBin", 18], ["Pallet", "hu", 18],
    ["Move it to bin", "toBin", 18], ["Stock on it", "stock", 60]], pack.moves);
  addSheet(wb, "Pallet fill", [["Zone", "zone", 14], ["Bin", "bin", 18], ["Pallet", "hu", 18], ["From", "source", 9], ["Stock", "stock", 60],
    ["Fill vs best fit", "fill", 14], ["State", "state", 16], ["Plan", "merge", 26]],
    cons.pallets.map((p) => ({ zone: m.binByCode.get(p.bin)?.zone, bin: p.bin, hu: p.hu, source: p.source === "sheet" ? "Sheet" : "In stock",
      stock: casesText(m, p) + (p.gone?.length ? ` · being picked (not counted): ${casesText(m, { lines: p.gone })}` : ""), fill: p.share === null ? "" : pct(p.share), state: p.state,
      merge: p.mergeInto ? "Empty it (see Moves)" : p.keepFor ? "Keep, receives cases" : p.moveTo ? `Move whole to ${p.moveTo} (see Bin moves)` : "" }))
      .sort((a, b) => String(a.zone).localeCompare(String(b.zone)) || a.bin.localeCompare(b.bin)));
  if (cons.shelf.top.length) addSheet(wb, "Shelf spread", [["SKU", "sku", 18], ["Batch", "batch", 16], ["Bins", "bins", 8], ["Bin codes", "list", 90]],
    cons.shelf.top.map((x) => ({ ...x, list: x.list.join(", ") })));
}
async function planWorkbook(plan) {
  const { m, cons, pack } = plan, st = cons.stats;
  const wb = new ExcelJS.Workbook();
  addSheet(wb, "Summary", [["What", "k", 52], ["Value", "v", 22]], [
    { k: "Warehouse", v: m.whId }, { k: "Stock read at", v: new Date(m.loadedAt).toLocaleString() },
    { k: "Pallet bins (storage, active)", v: st.palletBins }, { k: "Pallet positions", v: st.positions },
    { k: "Positions used", v: st.used }, { k: "Positions free", v: st.spare }, { k: "Pallet bins completely empty", v: st.emptyBins },
    { k: "Pallets", v: st.pallets }, { k: "Full pallets (at best fit)", v: st.full }, { k: "Partial pallets", v: st.partial },
    { k: "Over best fit", v: st.over }, { k: "Mixed SKU/batch pallets", v: st.mixed }, { k: "Pallets without an L2inL3", v: st.unsized },
    { k: "Pallets locked by a task (left out)", v: st.locked || 0 },
    { k: "Pallets in bins with locked stock or stock arriving (put lock; left out, and nothing moves into those bins)", v: st.busy || 0 },
    { k: "Pallets whose stock is all being picked (left out)", v: st.picking || 0 },
    { k: "Stock being picked (pick lock)", v: "Not counted in a pallet's fill and never moved; still counted in the WMS capacity check until it's picked" },
    { k: "Pallets freed by merging same SKU + batch", v: st.frees }, { k: "  of which inside the same bin", v: st.sameBinFrees },
    { k: "Bins emptied by merging", v: st.binsEmptied },
    { k: "Bins emptied by moving whole pallets", v: pack.stats.bins }, { k: "  whole pallets to move", v: pack.stats.pallets },
    { k: "Free positions after merging", v: st.spare + st.frees },
    { k: "Shelf SKU-batches spread over several bins", v: cons.shelf.groups },
  ]);
  consolidationSheets(wb, m, cons, pack);
  addImSheets(wb, plan.im, PALLET_IM_NOTES, plan.imHeld);
  return wb.xlsx.writeBuffer();
}

const HOW = { merge: "Onto a pallet already there", pallet: "Whole pallet", pour: "Loose into the bin" };
async function relocateWorkbook({ m, plan, check, im, imHeld }) {
  const wb = new ExcelJS.Workbook(), st = plan.stats, o = plan.opts;
  addSheet(wb, "Summary", [["What", "k", 52], ["Value", "v", 60]], [
    { k: "Warehouse", v: m.whId }, { k: "Stock read at", v: new Date(m.loadedAt).toLocaleString() },
    { k: "Empty bins of (zone | bin type)", v: (o.from.cells || []).join(", ") || "All" }, { k: "Into bins of (zone | bin type)", v: (o.to.cells || []).join(", ") || "All" },
    { k: "Only bins under (% full)", v: o.belowPct >= 100 ? "Any fill" : o.belowPct },
    { k: "How full is measured", v: "Pallet bins: full pallets (the SKU's L3) over pallet positions. Shelf bins: stock volume over bin volume." },
    { k: "Empty bins can receive", v: { smaller: "Only bins smaller than the one being emptied", any: "Any empty bin", none: "No" }[o.useEmpty] }, { k: "Keep bins within the bin type's max kg", v: o.checkWeight ? "Yes" : "No" },
    { k: "Bins to empty from", v: st.fromBins }, { k: "  holding stock", v: st.fromStocked }, { k: `  under ${o.belowPct}% full`, v: st.under },
    { k: "  of those, could be planned (unlocked, active, sized)", v: st.candidates },
    { k: "Bins that can receive", v: st.toUsable }, { k: "  of them empty", v: st.toEmpty },
    { k: "Bins emptied", v: st.binsEmptied }, { k: "Steps", v: st.moves }, { k: "Pallets moved whole", v: st.palletsMovedWhole },
    { k: "Pallets merged onto others", v: st.palletsMerged }, { k: "Empty bins used", v: st.emptyBinsUsed }, { k: "Net bins freed (emptied minus empty bins used)", v: st.netFreed }, { k: "Pallet positions freed", v: st.positionsFreed },
    { k: "Every step re-checked (positions, pallet fill, weight, mixing rules, scope)", v: check.ok ? "Passed" : `FAILED: ${check.errs.slice(0, 3).join("; ")}` },
    { k: "Do the steps in order", v: "A later step can put cases onto a pallet an earlier step moved in." },
  ]);
  const pct = (x) => (x === null || x === undefined ? null : +(x * 100).toFixed(1));
  addSheet(wb, "Steps", [["Step", "step", 6], ["From bin", "fromBin", 16], ["From zone", "fromZone", 12], ["From bin type", "fromBinType", 16], ["From % full", "fromPct", 9],
    ["Pallet", "hu", 14], ["SKU", "sku", 18], ["Batch", "batch", 14], ["Qty", "qty", 8], ["Unit", "uom", 6], ["How", "how", 26],
    ["To bin", "toBin", 16], ["To zone", "toZone", 12], ["To bin type", "toBinType", 16], ["To pallet", "toHu", 14], ["To bin was empty", "wasEmpty", 9],
    ["To pallet after (% of a full pallet)", "palletAfter", 12], ["Pallets in to bin after", "positions", 10], ["Positions", "toCap", 9],
    ["To bin volume after (L)", "volAfter", 11], ["To bin kg after", "kg", 10], ["To bin max kg", "toMaxKg", 10]],
    plan.moves.map((p) => ({ ...p, fromPct: +p.fromOccPct.toFixed(2), how: HOW[p.kind], wasEmpty: p.toWasEmpty ? "Yes" : "No", palletAfter: p.kind === "pour" ? null : pct(p.toPalletAfter),
      positions: p.kind === "pour" ? null : p.toPositions, toCap: p.kind === "pour" ? null : p.toCap, volAfter: p.kind === "pour" ? litres(p.toUsedAfterCC) : null, kg: +p.toKgAfter.toFixed(1) })));
  addSheet(wb, "Bins emptied", [["Bin", "bin", 16], ["Zone", "zone", 12], ["Area", "area", 12], ["Bin type", "binType", 16], ["% full", "pct", 8], ["Pallets", "pallets", 8], ["Into", "to", 40], ["Note", "note", 40]],
    plan.emptied.map((e) => ({ ...e, pct: +e.occPct.toFixed(2), to: e.to.join(", "), note: e.afterPick ? "Empty once the stock being picked from it leaves" : "" })));
  addSheet(wb, "Not emptied", [["Bin", "bin", 16], ["Zone", "zone", 12], ["Area", "area", 12], ["Bin type", "binType", 16], ["% full", "pct", 8], ["Why", "why", 60], ["Stock", "stock", 70]],
    plan.notEmptied.map((n) => ({ ...n, pct: n.occPct === null ? null : +n.occPct.toFixed(2) })));
  addImSheets(wb, im, ["A step that puts cases onto a pallet an earlier step moves in is in a later upload."], imHeld);
  return wb.xlsx.writeBuffer();
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
  addSheet(wb, "Moves", [["SKU", "sku", 18], ["Batch", "batch", 14], ["Qty", "qty", 8], ["Unit", "uom", 7], ["From bin", "fromBin", 16], ["From zone", "fromZone", 13],
    ["From bin volume (L)", "fromVol", 12], ["From bin used (L)", "fromUsed", 12], ["To bin", "toBin", 16], ["To zone", "toZone", 13],
    ["Unit volume (cc)", "unitVolCC", 11], ["Move volume (L)", "moveVol", 11], ["To bin volume (L)", "toVol", 12], ["To bin before (L)", "before", 12],
    ["To bin after (L)", "after", 12], ["To bin after (% full)", "pct", 12], ["To bin kg after", "kg", 10], ["To bin max kg", "toMaxKg", 10], ["Same SKU-batch already there", "sameKey", 12]],
    plan.moves.map((p) => ({ ...p, fromVol: litres(p.fromBinVolCC), fromUsed: litres(p.fromUsedCC), moveVol: litres(p.moveVolCC), toVol: litres(p.toBinVolCC),
      before: litres(p.toUsedBeforeCC), after: litres(p.toUsedAfterCC), pct: p.toBinVolCC ? +(p.toUsedAfterCC / p.toBinVolCC * 100).toFixed(1) : null,
      kg: +p.toKgAfter.toFixed(2), unitVolCC: +p.unitVolCC.toFixed(1), sameKey: p.sameKey ? "Yes" : "No" })));
  addSheet(wb, "Bins emptied", [["Bin", "bin", 16], ["Zone", "zone", 14], ["Area", "area", 12], ["Bin type", "binType", 14], ["Volume (L)", "vol", 10],
    ["Used (L)", "used", 10], ["Lines", "lines", 8], ["Into", "to", 40], ["Note", "note", 40]],
    plan.emptied.map((e) => ({ ...e, vol: litres(e.volCC), used: litres(e.usedCC), to: e.to.join(", "), note: e.afterPick ? "Empty once the stock being picked from it leaves" : "" })));
  addSheet(wb, "Bins receiving", [["Bin", "bin", 16], ["Zone", "zone", 14], ["Volume (L)", "vol", 10], ["Before (L)", "before", 10], ["Poured in (L)", "in", 11],
    ["After (L)", "after", 10], ["After (% full)", "pct", 11], ["kg after", "kg", 9], ["Max kg", "maxKg", 8], ["From", "from", 40]],
    plan.targets.map((t) => ({ ...t, vol: litres(t.volCC), before: litres(t.beforeCC), in: litres(t.inCC), after: litres(t.afterCC),
      pct: t.fillPct === null ? null : +t.fillPct.toFixed(1), kg: +t.kgAfter.toFixed(2), from: t.from.join(", ") })));
  addSheet(wb, "Left out", [["Bin", "bin", 16], ["Zone", "zone", 14], ["Area", "area", 12], ["Bin type", "binType", 14], ["Why", "reason", 50], ["Stock", "stock", 60]],
    [...plan.leftOut].sort((a, b) => a.reason.localeCompare(b.reason) || a.bin.localeCompare(b.bin, undefined, { numeric: true })));
  addImSheets(wb, im, [], imHeld);
  return wb.xlsx.writeBuffer();
}

module.exports = { consolidationSheets, planWorkbook, relocateWorkbook, eachesWorkbook };
