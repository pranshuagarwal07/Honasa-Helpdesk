// Empty pallet bins in two stages, one plan (Consolidate "Empty bins" with merge first; docs/CONSOLIDATION_V2.md phase 2):
//   1) merges: like part-full pallets poured onto each other (pallet-merge.js palletPlan, no whole-pallet moves), freeing
//      positions even in bins that stay occupied
//   2) empty bins: relocate.js relocatePlan on the stock as the merges leave it
// The stock between the stages is worked out here by applying the merge moves to the stock read, not taken from the
// planner, so stage 2 and its re-check start from what the IM upload will really have done. The WMS closes a pallet whose
// cases are all picked off (and a bin left with nothing is empty), so stage 2 may use the positions the merges free at once.
// The plain plan (stage 2 alone on the stock read) is made too, and the better of the two by the objective is kept:
// merging first never makes the plan worse.
//
// input: what relocateInput reads (bins, stock, leaving, busy, emptyPallets, skus, allowed, wmsUnit, ...)
// opts: from, to (pallet "zone|bin type" cells), crossZone, checkWeight, objective, belowPct, useEmpty, skipEmptyPalletBins
const { palletPlan } = require("./pallet-merge");
const { validatePalletPlan } = require("./pallet-merge-check");
const { relocatePlan } = require("./relocate");
const { validateRelocate } = require("./relocate-check");

const up = (s) => String(s ?? "").trim().toUpperCase();
const P = (x) => (x === null || x === undefined || x === "" ? "" : String(Number(x)));
const palletHu = (hu) => (hu && !String(hu).startsWith("BIN_HU_") ? hu : null);
const coll = new Intl.Collator(undefined, { numeric: true }).compare;

// the Pallets planner's input from what relocateInput read: one read of the stock and the locks for both stages
function mergeInputOf(ri) {
  const busy = ri.busy || new Map();
  const why = (list) => [...new Set(list.map((x) => (x.mode === "HU" ? `pallet ${x.hu} locked` : `${x.mode} lock`) + (x.who ? ` by ${x.who}` : "")))].join(", ");
  return { bins: ri.bins, stock: ri.stock, leaving: ri.leaving || new Map(), skus: ri.skus, allowed: ri.allowed, wmsUnit: ri.wmsUnit,
    busy: new Set([...busy].filter(([, l]) => l.length).map(([b]) => b)), busyWhy: new Map([...busy].map(([b, l]) => [b, why(l)])),
    emptyHus: ri.emptyPallets || new Map(), busyError: ri.lockError, emptyHuError: ri.emptyPalletError, fixedError: ri.fixedError };
}

// the stock after some moves, applied line by line (merge moves name fromHu, Bins under % full moves name hu)
function applyMoves(stock, moves) {
  const S = new Map([...stock].map(([b, ls]) => [b, ls.map((l) => ({ ...l, hu: palletHu(l.hu) }))]));
  const same = (l, m, hu) => l.hu === hu && l.sku === m.sku && up(l.batch) === up(m.batch) && up(l.bucket) === up(m.bucket) && up(l.inclusion) === up(m.inclusion)
    && (l.iloc || "") === (m.iloc || "") && P(l.price) === P(m.price) && l.uom === m.uom;
  for (const m of moves) {
    const hu = palletHu(m.fromHu ?? m.hu), src = S.get(m.fromBin) || [];
    let left = m.qty;
    for (const l of src) if (left > 1e-9 && l.qty > 0 && same(l, m, hu)) { const t = Math.min(left, l.qty); l.qty -= t; left -= t; }
    if (left > 1e-9) throw new Error(`${m.fromBin} doesn't hold ${m.qty} ${m.uom} ${m.sku} ${m.batch}${hu ? ` on ${hu}` : ""} for step ${m.step ?? ""}`);
    S.set(m.fromBin, src.filter((l) => l.qty > 1e-9));
    const toHu = m.kind === "pallet" ? hu : m.kind === "pour" ? null : palletHu(m.toHu);
    const dst = S.get(m.toBin) || [], cur = dst.find((l) => same(l, m, toHu));
    if (cur) cur.qty += m.qty;
    else dst.push({ hu: toHu, sku: m.sku, batch: m.batch, bucket: m.bucket, inclusion: m.inclusion, iloc: m.iloc, price: m.price, uom: m.uom, qty: m.qty, locked: false });
    S.set(m.toBin, dst);
  }
  return S;
}

// what a plan does to the pallet bins, end to end, counted from the stock before and after (the output contract):
// bins emptied, empty bins used, net positions (a bin that stays occupied counts its change in pallets both ways),
// pallets that disappear; per zone too
function netOf(bins, before, after, inScope) {
  const view = (S, code) => { const ls = (S.get(code) || []).filter((l) => l.qty > 1e-9); return { any: ls.length > 0, hus: new Set(ls.map((l) => palletHu(l.hu)).filter(Boolean)), loose: ls.some((l) => !palletHu(l.hu)) }; }; // BIN_HU_ stock is loose
  const st = { binsEmptied: 0, emptyBinsUsed: 0, positionsFreed: 0, emptied: [], emptyUsed: [] }, zones = new Map(), husBefore = new Set(), husAfter = new Set();
  for (const b of bins) {
    if (b.huType !== "PALLET" || !inScope(b)) continue;
    const cap = Math.max(1, Number(b.cap) || 1), x = view(before, b.code), y = view(after, b.code);
    const used = (v) => Math.min(cap, v.hus.size + (v.loose ? 1 : 0));
    x.hus.forEach((h) => husBefore.add(h)); y.hus.forEach((h) => husAfter.add(h));
    const k = `${b.area || ""}|${b.zone}`;
    if (!zones.has(k)) zones.set(k, { zone: b.zone, area: b.area || "", bins: 0, positions: 0, usedBefore: 0, used: 0, binsEmptied: 0, emptyBinsUsed: 0, positionsFreed: 0 });
    const z = zones.get(k);
    z.bins++; z.positions += cap; z.usedBefore += used(x); z.used += used(y);
    let d = 0;
    if (x.any && !y.any) { st.binsEmptied++; z.binsEmptied++; st.emptied.push(b.code); d = cap; }
    else if (!x.any && y.any) { st.emptyBinsUsed++; z.emptyBinsUsed++; st.emptyUsed.push(b.code); d = -cap; }
    else if (x.any) d = used(x) - used(y);
    st.positionsFreed += d; z.positionsFreed += d;
  }
  st.netBinsFreed = st.binsEmptied - st.emptyBinsUsed;
  st.palletsFreed = [...husBefore].filter((h) => !husAfter.has(h)).length;
  st.zones = [...zones.values()].map((z) => ({ ...z, spare: z.positions - z.used, spareBefore: z.positions - z.usedBefore }))
    .sort((a, b) => b.positionsFreed - a.positionsFreed || coll(String(a.zone), String(b.zone)));
  return st;
}

// > 0 when score a is better than b by the objective (more positions, then net bins; or the other way round; then fewer moves)
const better = (o, a, b) => { const k = o.objective === "bins" ? ["netBinsFreed", "positionsFreed"] : ["positionsFreed", "netBinsFreed"];
  return (a[k[0]] - b[k[0]]) || (a[k[1]] - b[k[1]]) || (b.moves - a.moves); };

function chainPlan(ri, opts = {}) {
  const t0 = Date.now(), cells = (x) => (Array.isArray(x) ? x : x?.cells || []).map(up);
  const from = cells(opts.from), to = cells(opts.to);
  const inScope = (b) => { const c = `${up(b.zone)}|${up(b.binType)}`; return from.includes(c) || to.includes(c); };
  const relocOpts = { from: { cells: from }, to: { cells: to }, crossZone: opts.crossZone, checkWeight: opts.checkWeight, objective: opts.objective,
    belowPct: opts.belowPct, useEmpty: opts.useEmpty, skipEmptyPalletBins: opts.skipEmptyPalletBins };

  // the plain plan: empty bins on the stock as read
  const plain = relocatePlan(ri, relocOpts);
  const plainNet = netOf(ri.bins, ri.stock, applyMoves(ri.stock, plain.moves), inScope);

  // 1) merges, on the same stock and locks
  const mi = mergeInputOf(ri);
  const merge = palletPlan(mi, { from, to, crossZone: opts.crossZone, checkWeight: opts.checkWeight, objective: opts.objective, wholePallets: false });
  const after1 = applyMoves(ri.stock, merge.moves);
  // 2) empty bins on what the merges leave: the WMS closes a pallet whose cases all went onto others, so its position is free
  const ri2 = { ...ri, stock: after1 };
  const reloc = relocatePlan(ri2, relocOpts);
  const chainNet = netOf(ri.bins, ri.stock, applyMoves(after1, reloc.moves), inScope);

  const chainMoves = merge.moves.length + reloc.moves.length;
  const useChain = merge.moves.length > 0 && better(opts, { ...chainNet, moves: chainMoves }, { ...plainNet, moves: plain.moves.length }) > 0;
  const stages = useChain ? { merge, reloc, mergeInput: mi, relocInput: ri2 } : { merge: null, reloc: plain, mergeInput: null, relocInput: ri };
  const net = useChain ? chainNet : plainNet;

  // the moves in upload order: merges (stage 1), then emptying bins (stage 2)
  const mergeMoves = (stages.merge?.moves || []).map((m) => Object.assign(m, { hu: m.fromHu, stage: 1 }));
  const moves = [...mergeMoves, ...stages.reloc.moves.map((m) => Object.assign(m, { stage: 2 }))];
  moves.forEach((m, i) => { m.step = i + 1; });

  // warnings: one per code, the bins of both stages together
  const warnings = [], byCode = new Map();
  const add = (w) => { const cur = byCode.get(w.code); if (!cur) { const x = { ...w, bins: [...(w.bins || [])] }; byCode.set(w.code, x); warnings.push(x); return; }
    cur.bins = [...new Set([...cur.bins, ...(w.bins || [])])].sort(coll); if ((w.level === "block" && cur.level !== "block") || (w.level === "warn" && cur.level === "info")) { cur.level = w.level; cur.text = w.text; } };
  // stage 1's own warnings that say something stage 2 doesn't (its lock and data notes are stage 2's too)
  for (const w of stages.merge?.warnings || []) if (["empty-pallet-in-target", "no-room", "cross-zone"].includes(w.code)) add(w);
  for (const w of stages.reloc.warnings || []) add(w);
  if (merge.moves.length && !useChain) add({ level: "info", code: "merge-first", text: `Merging part-full pallets first would free less here (${chainNet.positionsFreed} positions and ${chainNet.netBinsFreed} net bins, against ${plainNet.positionsFreed} and ${plainNet.netBinsFreed}), so the plan empties bins without it.`, bins: [] });
  if (useChain) add({ level: "info", code: "merge-first", text: `Part-full pallets are merged first (${merge.moves.length} case move${merge.moves.length === 1 ? "" : "s"}), then bins are emptied: ${chainNet.positionsFreed} positions and ${chainNet.netBinsFreed} net bins, against ${plainNet.positionsFreed} and ${plainNet.netBinsFreed} without merging. The merges go in the first upload; the moves that rely on them wait for their tasks.`, bins: [] });
  const order = { block: 0, warn: 1, info: 2 };
  warnings.sort((a, b) => order[a.level] - order[b.level]);

  // bins emptied, end to end, with where their stock went
  const binBy = new Map(ri.bins.map((b) => [b.code, b])), to2 = new Map();
  for (const m of moves) { if (!to2.has(m.fromBin)) to2.set(m.fromBin, new Set()); to2.get(m.fromBin).add(m.toBin); }
  const occ = new Map((stages.reloc.notEmptied || []).concat(stages.reloc.emptied || []).map((e) => [e.bin, e.occPct]));
  const emptied = net.emptied.sort(coll).map((c) => { const b = binBy.get(c) || {}; return { bin: c, zone: b.zone, area: b.area, binType: b.binType, kind: "pallet", occPct: occ.get(c) ?? null,
    pallets: new Set((ri.stock.get(c) || []).map((l) => palletHu(l.hu)).filter(Boolean)).size, to: [...(to2.get(c) || [])].sort(coll), afterPick: !!(ri.leaving?.get(c) || []).length }; });
  const gone = new Set(net.emptied);
  const notEmptied = (stages.reloc.notEmptied || []).filter((n) => !gone.has(n.bin));

  const rs = stages.reloc.stats, cz = moves.filter((m) => m.crossZone).length;
  return {
    opts: { ...stages.reloc.opts, mergeFirst: true, mergedFirst: useChain },
    stats: { ...rs, candidates: rs.candidates, binsEmptied: net.binsEmptied, emptyBinsUsed: net.emptyBinsUsed, netBinsFreed: net.netBinsFreed, netFreed: net.netBinsFreed,
      positionsFreed: net.positionsFreed, palletsFreed: net.palletsFreed, moves: moves.length, casesMoved: moves.reduce((t, m) => t + m.qty, 0), crossZoneMoves: cz, heldBack: 0,
      mergedFirst: useChain, mergeMoves: mergeMoves.length, palletsMerged: (useChain ? merge.stats.palletsFreed : 0) + (rs.palletsMerged || 0), palletsMovedWhole: rs.palletsMovedWhole,
      plain: { positionsFreed: plainNet.positionsFreed, netBinsFreed: plainNet.netBinsFreed, moves: plain.moves.length },
      chain: { positionsFreed: chainNet.positionsFreed, netBinsFreed: chainNet.netBinsFreed, moves: chainMoves }, ms: Date.now() - t0 },
    warnings, zones: net.zones, moves, emptied, notEmptied, bins: { emptied: net.emptied, emptyUsed: net.emptyUsed }, stages,
  };
}

// both stages' independent re-checks, each on the stock it starts from
function validateChain(plan) {
  const s = plan.stages, errs = [];
  if (s.merge) { const c = validatePalletPlan(s.mergeInput, s.merge); errs.push(...c.errs.map((e) => `merges: ${e}`)); }
  const c2 = validateRelocate(s.relocInput, s.reloc); errs.push(...c2.errs.map((e) => (s.merge ? `emptying bins: ${e}` : e)));
  return { ok: !errs.length, errs };
}

module.exports = { chainPlan, validateChain, applyMoves, netOf, mergeInputOf };
