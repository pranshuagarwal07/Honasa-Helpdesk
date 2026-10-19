// One Consolidate plan out of the planners behind it (GET /api/inv/consolidate-plan).
// The user ticks zone | bin type cells and picks a goal; each kind of bin goes to the planner built for it:
//   goal "tidy"  (free positions inside bins): pallet cells -> pallet-merge.js palletPlan
//   goal "empty" (empty bins under a % full):  pallet cells -> chain.js chainPlan (merges first, then relocate.js relocatePlan;
//                                              relocatePlan alone with mergeFirst off), shelf cells -> eaches.js eachesPlan
// Pallet and shelf bins never trade stock (pallet stock only goes to pallet bins), so the parts are independent: their
// moves, IM upload rows, warnings and zone rows add up. Each part keeps its own plan and independent re-check.
const { upper: up } = require("../core/util");

// split "zone|bin type" cells by the kind of bin they hold, from the inventory bins the pickers list
function splitCells(m, cells) {
  const kind = new Map();
  for (const b of m.bins) {
    if (b.areaType !== "INVENTORY" || !["PALLET", "BIN"].includes(b.huType)) continue;
    const c = `${up(b.zone)}|${up(b.binType)}`;
    if (!kind.has(c)) kind.set(c, b.huType === "PALLET" ? "pallet" : "shelf");
  }
  const out = { pallet: [], shelf: [], unknown: [] };
  for (const c0 of cells) { const c = up(c0); (out[kind.get(c)] || out.unknown).push(c); }
  return out;
}

const SUMS = ["binsEmptied", "emptyBinsUsed", "netBinsFreed", "positionsFreed", "palletsFreed", "casesMoved", "crossZoneMoves", "heldBack"];
const ZONE_SUMS = ["bins", "positions", "used", "usedBefore", "spare", "spareBefore", "binsUsed", "binsEmptied", "emptyBinsUsed", "positionsFreed", "frees", "partial", "binsFreed"];
const LABEL = { pallet: "Pallet bins", shelf: "Shelf bins" };
// the moves of one part in upload order: pallet-merge keeps case moves and whole pallets apart
const movesOf = (p) => (p.engine === "pallets" ? [...p.plan.moves, ...(p.plan.pack?.moves || [])] : p.plan.moves);

// parts: [{ kind: "pallet" | "shelf", engine: "pallets" | "relocate" | "eaches", plan, check }]
// notes: extra warnings from the route (e.g. cells a goal doesn't use)
function combinePlans(parts, { goal, opts, notes = [] } = {}) {
  const many = parts.length > 1;
  // one step numbering across the parts, written onto the moves themselves so the workbook sheets match the screen
  const steps = [];
  for (const p of parts) for (const mv of movesOf(p)) { mv.step = steps.length + 1; mv.part = p.kind; steps.push(mv); }

  const stats = { ...(many ? {} : parts[0]?.plan.stats), steps: steps.length };
  for (const k of SUMS) stats[k] = parts.reduce((t, p) => t + (Number(p.plan.stats?.[k]) || 0), 0);

  // warnings: each part's own, named by bin kind when there are two; a lock read that failed once is said once
  const warnings = [...notes], seen = new Set();
  for (const p of parts) for (const w of p.plan.warnings || []) {
    if (w.code === "lock-read-failed") { if (seen.has(w.code)) continue; seen.add(w.code); }
    warnings.push({ ...w, text: many && w.code !== "lock-read-failed" ? `${LABEL[p.kind]}: ${w.text}` : w.text, part: p.kind });
  }
  const order = { block: 0, warn: 1, info: 2 };
  warnings.sort((a, b) => (order[a.level] ?? 3) - (order[b.level] ?? 3));

  // zones: one row per area | zone, pallet and shelf bins of a zone added together
  const zones = new Map();
  for (const p of parts) for (const z of p.plan.zones || []) {
    const k = `${z.area || ""}|${z.zone}`;
    if (!zones.has(k)) { zones.set(k, { ...z }); continue; }
    const t = zones.get(k);
    for (const f of ZONE_SUMS) if (typeof z[f] === "number") t[f] = (t[f] || 0) + z[f];
  }

  const errs = parts.flatMap((p) => (p.check?.errs || []).map((e) => (many ? `${LABEL[p.kind]}: ${e}` : e)));
  return {
    goal, opts, stats, warnings, steps,
    zones: [...zones.values()].sort((a, b) => (b.positionsFreed || 0) - (a.positionsFreed || 0) || (b.binsEmptied || 0) - (a.binsEmptied || 0)
      || String(a.zone).localeCompare(String(b.zone), undefined, { numeric: true })),
    check: { ok: parts.every((p) => !p.check || p.check.ok), errs },
    // bins emptied and empty bins used, every part (the workbook's Bins emptied and Zones sheets read them)
    bins: { emptied: parts.flatMap((p) => p.plan.bins?.emptied || (p.plan.emptied || []).map((e) => e.bin)),
      emptyUsed: parts.flatMap((p) => p.plan.bins?.emptyUsed || [...new Set(p.plan.moves.filter((x) => x.toWasEmpty).map((x) => x.toBin))]) },
    parts: parts.map((p) => ({ kind: p.kind, engine: p.engine, stats: p.plan.stats, check: p.check ? { ok: p.check.ok, errs: p.check.errs.slice(0, 10) } : null })),
  };
}

// bins in scope a plan left as they are, and why: Bins under % full's notEmptied plus the shelf planner's left out
function notEmptiedOf(parts) {
  const out = [];
  for (const p of parts) {
    if (p.engine === "relocate" || p.engine === "chain") out.push(...p.plan.notEmptied.map((n) => ({ ...n, kind: p.kind })));
    // left out also lists bins that break their own rules: those can still be emptied, so only the ones that weren't
    const gone = new Set((p.plan.emptied || []).map((e) => e.bin));
    if (p.engine === "eaches") out.push(...p.plan.leftOut.filter((n) => !gone.has(n.bin)).map((n) => ({ bin: n.bin, zone: n.zone, area: n.area, binType: n.binType, occPct: null, why: n.reason, stock: n.stock, kind: p.kind })));
  }
  return out;
}

module.exports = { splitCells, combinePlans, notEmptiedOf, movesOf };
