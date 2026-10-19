// Bins under % full planner (relocatePlan) and its independent replay (validateRelocate), on small hand-built warehouses.
const test = require("node:test");
const assert = require("node:assert/strict");
const { relocatePlan } = require("../../lib/planners/relocate");
const { validateRelocate } = require("../../lib/planners/relocate-check");

// SKU A: 40 cases a pallet, 12 eaches a case
const SKUS = new Map([["A", { L2inL3: 40, L0inL2: 12, L0wt: 0.1, volL0: 100, volL2: 1200, volL3: 48000 }]]);
const bin = (code, o = {}) => ({ code, zone: "Z1", area: "A1", areaType: "INVENTORY", status: "ACTIVE", huType: "PALLET", binType: "2D", cap: 2, maxKg: null,
  multiSku: true, multiBatch: true, maxSku: null, maxSkuBatch: null, huMultiSku: true, huMultiBatch: true, fixed: false, ...o });
const L = (hu, qty, o = {}) => ({ hu, sku: "A", batch: "B1", bucket: "GOOD", inclusion: "INCLUDED", iloc: "CO01", price: 100, uom: "L2", qty, locked: false, ...o });
const input = (bins, stock) => ({ bins, stock: new Map(Object.entries(stock)), leaving: new Map(), skus: SKUS, allowed: () => true });
const CELLS = { cells: ["Z1|2D"] };
const run = (inp, opts = {}) => { const plan = relocatePlan(inp, { from: CELLS, to: CELLS, ...opts }), check = validateRelocate(inp, plan); assert.deepEqual(check.errs, []); return plan; };

test("like partial pallets in two bins merge and one bin empties", () => {
  const plan = run(input([bin("X"), bin("Y")], { X: [L("P1", 10)], Y: [L("P2", 20)] }));
  assert.equal(plan.stats.binsEmptied, 1);
  assert.ok(plan.moves.every((m) => m.kind === "merge"));
});

test("stock that isn't INCLUDED never moves and takes nothing in", () => {
  // X holds a POST-GIN pallet: it can't be emptied, and Y's INCLUDED cases may not go onto it
  const plan = run(input([bin("X"), bin("Y")], { X: [L("P1", 10, { inclusion: "POST_GIN" })], Y: [L("P2", 20)] }));
  assert.equal(plan.moves.length, 0);
  assert.ok(plan.notEmptied.some((n) => n.bin === "X" && /not INCLUDED/.test(n.why)));
  assert.ok(plan.warnings.some((w) => w.code === "not-included" && w.bins.includes("X")));
  // the same with no inclusion status at all (an older schema) counts as INCLUDED
  const old = run(input([bin("X"), bin("Y")], { X: [L("P1", 10, { inclusion: null })], Y: [L("P2", 20)] }));
  assert.equal(old.stats.binsEmptied, 1);
});

test("the replay catches a move of stock that isn't INCLUDED", () => {
  const inp = input([bin("X"), bin("Y")], { X: [L("P1", 10, { inclusion: "PRE_GRN" })], Y: [L("P2", 20)] });
  const plan = relocatePlan(inp, { from: CELLS, to: CELLS });
  plan.moves.push({ kind: "merge", fromBin: "X", hu: "P1", toBin: "Y", toHu: "P2", sku: "A", batch: "B1", bucket: "GOOD", price: 100, inclusion: "PRE_GRN", iloc: "CO01", uom: "L2", qty: 10 });
  const errs = validateRelocate(inp, plan).errs.join("\n");
  assert.match(errs, /moves PRE_GRN stock/);
});

test("objective and skipEmptyPalletBins are honoured and echoed", () => {
  const plan = run(input([bin("X"), bin("Y")], { X: [L("P1", 10)], Y: [L("P2", 20)] }), { objective: "bins", skipEmptyPalletBins: "0" });
  assert.equal(plan.opts.objective, "bins");
  assert.equal(plan.opts.skipEmptyPalletBins, false);
});

test("cross-zone: off keeps zones apart; on follows the search table", () => {
  const bins = [bin("X", { zone: "Z1" }), bin("Y", { zone: "Z2" })], stock = { X: [L("P1", 10)], Y: [L("P2", 20)] };
  const cells = { cells: ["Z1|2D", "Z2|2D"] };
  const off = run(input(bins, stock), { from: cells, to: cells });
  assert.equal(off.moves.length, 0);
  const on = run(input(bins, stock), { from: cells, to: cells, crossZone: "1" });
  assert.equal(on.stats.binsEmptied, 1);
  assert.ok(on.moves.every((m) => m.crossZone));
  // the search table says no: stays apart even with cross-zone on
  const no = run({ ...input(bins, stock), allowed: () => false }, { from: cells, to: cells, crossZone: true });
  assert.equal(no.moves.length, 0);
  // and the replay refuses a cross-zone move the plan wasn't allowed to make
  const plan = relocatePlan(input(bins, stock), { from: cells, to: cells });
  plan.moves.push({ ...on.moves[0] });
  assert.match(validateRelocate(input(bins, stock), plan).errs.join("\n"), /cross-zone off/);
});
