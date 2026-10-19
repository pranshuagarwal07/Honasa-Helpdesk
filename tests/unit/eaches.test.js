// Shelf planner (eachesPlan) and its independent replay (validatePlan), on small hand-built warehouses.
const test = require("node:test");
const assert = require("node:assert/strict");
const { eachesPlan } = require("../../lib/planners/eaches");
const { validatePlan } = require("../../lib/planners/eaches-check");

// SKU A: 100 cc an each; shelf bins of 10 L hold 100 eaches
const SKUS = new Map([["A", { volL0: 100, volL2: 1200, L0wt: 0, L0inL2: 12 }]]);
const bin = (code, o = {}) => ({ code, zone: "Z1", area: "A1", areaType: "INVENTORY", status: "ACTIVE", huType: "BIN", binType: "S10", volCC: 10000, maxKg: null,
  multiSku: true, multiBatch: true, maxSku: null, maxSkuBatch: null, fixed: false, ...o });
const L = (qty, o = {}) => ({ sku: "A", batch: "B1", bucket: "GOOD", price: 10, inclusion: "INCLUDED", iloc: "CO01", uom: "L0", qty, locked: false, ...o });
const input = (bins, stock, extra = {}) => ({ bins, stock: new Map(Object.entries(stock)), leaving: new Map(), skus: SKUS, allowed: () => true, ...extra });
const run = (inp, opts = {}) => { const plan = eachesPlan(inp, opts), check = validatePlan(inp, plan); assert.deepEqual(check.errs, []); return plan; };

test("two part-full shelf bins of the same stock: one empties, in the output contract", () => {
  const plan = run(input([bin("X"), bin("Y")], { X: [L(10)], Y: [L(40)] }));
  assert.equal(plan.stats.binsEmptied, 1);
  assert.equal(plan.stats.netBinsFreed, 1);
  assert.equal(plan.stats.positionsFreed, 0);
  assert.equal(plan.stats.crossZoneMoves, 0);
  assert.deepEqual(plan.moves.map((m) => [m.step, m.kind, m.fromBin, m.toBin, m.qty, m.crossZone]), [[1, "pour", "X", "Y", 10, false]]);
  assert.equal(plan.zones[0].binsEmptied, 1);
});

test("stock that isn't INCLUDED never moves and takes nothing in", () => {
  const plan = run(input([bin("X"), bin("Y")], { X: [L(5, { inclusion: "POST_GIN" })], Y: [L(50)] }));
  assert.equal(plan.moves.length, 0);
  assert.ok(plan.leftOut.some((x) => x.bin === "X" && /not INCLUDED/.test(x.reason)));
  assert.ok(plan.warnings.some((w) => w.code === "not-included" && w.bins.includes("X")));
});

test("a bin a task holds in the HU tables gives and takes nothing", () => {
  const busy = new Map([["Y", [{ hu: null, mode: "PUT", qty: 5, who: "INBOUND-4" }]]]);
  const plan = run(input([bin("X"), bin("Y")], { X: [L(10)], Y: [L(40)] }, { busy }));
  assert.equal(plan.moves.length, 0);
  assert.ok(plan.leftOut.some((x) => x.bin === "Y" && /INBOUND-4/.test(x.reason)));
});

test("pours stay within the WMS capacity check, not just the bin volume", () => {
  // the WMS counts an each of A as 1/50 of a bin: Y at 40 takes 10 more, not 60
  const wmsUnit = () => 1 / 50;
  const inp = input([bin("X"), bin("Y")], { X: [L(30)], Y: [L(40)] }, { wmsUnit });
  const plan = run(inp);
  assert.equal(plan.moves.length, 0); // 30 won't fit in the 10 the WMS leaves
  const ok = run(input([bin("X"), bin("Y")], { X: [L(10)], Y: [L(40)] }, { wmsUnit }));
  assert.equal(ok.stats.binsEmptied, 1);
  assert.ok(ok.moves.every((m) => m.toWmsAfter <= 1 + 1e-6));
});

test("From and To cells: only From bins give, only To bins take", () => {
  const bins = [bin("X", { binType: "S10" }), bin("Y", { binType: "S20", volCC: 20000 })];
  // X can't be emptied into Y unless Y is in To
  assert.equal(run(input(bins, { X: [L(10)], Y: [L(40)] }), { from: ["Z1|S10"], to: ["Z1|S10"] }).moves.length, 0);
  const plan = run(input(bins, { X: [L(10)], Y: [L(40)] }), { from: ["Z1|S10"], to: ["Z1|S20"] });
  assert.deepEqual(plan.moves.map((m) => [m.fromBin, m.toBin]), [["X", "Y"]]);
});

test("the replay catches a pour of stock that isn't INCLUDED and a pour over the WMS capacity", () => {
  const inp = input([bin("X"), bin("Y")], { X: [L(30, { inclusion: "PRE_GRN" })], Y: [L(40)] }, { wmsUnit: () => 1 / 50 });
  const plan = eachesPlan(inp, {});
  plan.moves.push({ sku: "A", batch: "B1", bucket: "GOOD", price: 10, inclusion: "PRE_GRN", iloc: "CO01", uom: "L0", qty: 30, fromBin: "X", toBin: "Y",
    fromBinVolCC: 10000, toBinVolCC: 10000, unitVolCC: 100, moveVolCC: 3000, toCapCC: 10000, toUsedAfterCC: 7000 });
  plan.stats.binsEmptied = 1;
  const errs = validatePlan(inp, plan).errs.join("\n");
  assert.match(errs, /moves PRE_GRN stock/);
  assert.match(errs, /WMS capacity/);
});
