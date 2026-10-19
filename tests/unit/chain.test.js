// Merge first, then empty bins (chain.js): two stages in one plan, never worse than emptying bins alone.
const test = require("node:test");
const assert = require("node:assert/strict");
const { chainPlan, validateChain, applyMoves } = require("../../lib/planners/chain");
const { chainImRows } = require("../../lib/im-upload/rows");
const { imFiles } = require("../../lib/im-upload/files");

// SKU A, B: 40 cases a full pallet
const SKUS = new Map([["A", { L2inL3: 40, L0inL2: 12, L0wt: 0 }], ["B", { L2inL3: 40, L0inL2: 12, L0wt: 0 }]]);
const bin = (code, o = {}) => ({ code, zone: "Z1", area: "A1", areaType: "INVENTORY", status: "ACTIVE", huType: "PALLET", binType: `${o.cap || 2}D`, cap: 2, maxKg: null,
  multiSku: true, multiBatch: true, maxSku: null, maxSkuBatch: null, huMultiSku: false, huMultiBatch: false, fixed: false, ...o }); // one quant per pallet, as most pallet bins
const L = (hu, sku, qty, o = {}) => ({ hu, sku, batch: "B1", bucket: "GOOD", inclusion: "INCLUDED", iloc: "CO01", price: 10, uom: "L2", qty, locked: false, ...o });
const input = (bins, stock) => ({ bins, stock: new Map(Object.entries(stock)), leaving: new Map(), busy: new Map(), emptyPallets: new Map(), skus: SKUS, allowed: () => true });
const CELLS = ["Z1|2D", "Z1|1D"];
const opts = (o = {}) => ({ from: CELLS, to: CELLS, belowPct: 100, useEmpty: "smaller", skipEmptyPalletBins: true, checkWeight: true, ...o });
const run = (inp, o) => { const plan = chainPlan(inp, opts(o)), check = validateChain(plan); assert.deepEqual(check.errs, []); return plan; };

// X holds two part-full pallets of A; Y (one position) holds a part-full pallet of B that only fits into X
const bins = [bin("X"), bin("Y", { cap: 1 })];
const stock = { X: [L("P1", "A", 10), L("P2", "A", 15)], Y: [L("P3", "B", 5)] };

test("merging first frees a position emptying bins alone can't; stage 2 uses it in a later upload", () => {
  // the WMS closes P1 once its cases are all on P2, so X has a free position for Y's pallet
  const inp = input(bins, stock);
  const plan = run(inp);
  assert.equal(plan.stats.mergedFirst, true);
  assert.equal(plan.stats.plain.positionsFreed, 0); // X is full and Y's pallet has nowhere to go
  assert.deepEqual(plan.moves.map((m) => [m.stage, m.kind, m.fromBin, m.hu, m.toBin, m.toHu, m.qty]), [[1, "merge", "X", "P1", "X", "P2", 10], [2, "pallet", "Y", "P3", "X", "P3", 5]]);
  assert.equal(plan.stats.binsEmptied, 1);
  assert.equal(plan.stats.positionsFreed, 1); // Y's one position; X goes from 2 pallets to 2
  assert.ok(!plan.warnings.some((w) => w.code === "empty-pallets-left"));
  // the stock as the plan leaves it: X holds P2 (25 A) and P3 (5 B), Y nothing
  const end = applyMoves(inp.stock, plan.moves);
  assert.deepEqual((end.get("X") || []).map((l) => `${l.hu}:${l.sku}${l.qty}`).sort(), ["P2:A25", "P3:B5"]);
  assert.deepEqual(end.get("Y"), []);
  // the merge (Destination HU, its own file) in wave 1; the pallet into X waits for it
  const { files, held } = imFiles(chainImRows(plan));
  assert.equal(held.length, 0);
  assert.deepEqual(files.map((f) => [f.wave, f.sameBin, f.rows.map((r) => `${r.fromBin}>${r.toBin}${r.pickHu ? " whole" : ""}`).join(",")]),
    [[1, true, "X>X"], [2, false, "Y>X whole"]]);
});

test("an empty pallet HU already standing in a bin still holds its position", () => {
  const inp = { ...input(bins, stock), emptyPallets: new Map([["X", ["OLD1"]]]) };
  const plan = run(inp); // X: P2 (after the merge) + OLD1 = both positions, so Y's pallet can't come in
  assert.equal(plan.stats.binsEmptied, 0);
  assert.ok(plan.moves.every((m) => m.stage === 1));
});

test("nothing to merge: the plain plan, said so", () => {
  const plan = run(input([bin("X"), bin("Y")], { X: [L("P1", "A", 10)], Y: [L("P2", "A", 20)] }));
  // one pallet per bin: stage 1 has no same-bin pair; Bins under % full merges X's pallet onto Y's either way
  assert.equal(plan.stats.binsEmptied, 1);
  assert.ok(plan.moves.every((m) => m.stage === 2 || m.stage === 1));
  assert.equal(plan.stats.positionsFreed, Math.max(plan.stats.plain.positionsFreed, plan.stats.chain.positionsFreed));
});

test("never worse than emptying bins alone, by the objective", () => {
  for (const objective of ["positions", "bins"]) {
    const plan = run(input(bins, stock), { objective });
    const k = objective === "bins" ? "netBinsFreed" : "positionsFreed";
    assert.ok(plan.stats[k] >= plan.stats.plain[k], `${objective}: ${plan.stats[k]} < ${plan.stats.plain[k]}`);
  }
});
