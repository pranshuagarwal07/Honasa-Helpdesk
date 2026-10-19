// Pallet consolidation planner (palletPlan) and its independent replay (validatePalletPlan), on small hand-built warehouses.
const test = require("node:test");
const assert = require("node:assert/strict");
const { palletPlan, consolidation } = require("../../lib/planners/pallet-merge");
const { validatePalletPlan } = require("../../lib/planners/pallet-merge-check");
const { palletImRows } = require("../../lib/im-upload/rows");
const { imFiles } = require("../../lib/im-upload/files");

// SKU A: 40 cases a pallet, 12 eaches a case; B: 50 cases a pallet
const SKUS = new Map([["A", { L2inL3: 40, L0inL2: 12, L0wt: 0.1, units: { L0: 1, L2: 12, L3: 480 } }], ["B", { L2inL3: 50, L0inL2: 10, L0wt: 0.1, units: { L0: 1, L2: 10, L3: 500 } }],
  ["N", { L2inL3: null, L0inL2: 10, L0wt: 0.1 }]]);
const bin = (code, o = {}) => ({ code, zone: "Z1", area: "A1", areaType: "INVENTORY", status: "ACTIVE", huType: "PALLET", binType: o.cap > 1 ? `${o.cap}D` : "1D", cap: 1, maxKg: null,
  multiSku: false, multiBatch: false, maxSku: null, maxSkuBatch: null, huMultiSku: true, huMultiBatch: true, fixed: false, ...o });
const L = (hu, sku, batch, qty, o = {}) => ({ hu, sku, batch, bucket: "GOOD", inclusion: "INCLUDED", iloc: "CO01", price: "100", uom: "L2", qty, locked: false, ...o });
// the WMS check, derived pallet best fit: one case = 1 / (positions x cases a pallet), unless a bin type best fit overrides
const wms = (bins, override = {}) => { const by = new Map(bins.map((b) => [b.code, b])); return (code, sku, uom) => {
  if (override[code]) return override[code];
  const s = SKUS.get(sku), cap = by.get(code)?.cap || 1;
  return uom === "L2" ? 1 / Math.floor(cap * s.L2inL3) : uom === "L0" ? 1 / Math.floor(cap * s.L2inL3 * s.L0inL2) : 1 / cap; }; };
const input = (bins, stock, extra = {}) => ({ bins, stock: new Map(Object.entries(stock)), leaving: new Map(), skus: SKUS, wmsUnit: wms(bins, extra.override), allowed: () => true, ...extra });
const run = (inp, opts) => { const plan = palletPlan(inp, opts), check = validatePalletPlan(inp, plan); assert.deepEqual(check.errs, []); return plan; };
// IM files for a plan, with the capacity check the upload runs
const imOf = (inp, plan) => imFiles(palletImRows(plan), { unit: inp.wmsUnit, stock: new Map([...inp.stock].map(([b, ls]) => [b, ls.map((l) => ({ sku: l.sku, uom: l.uom, qty: l.qty }))])) });

test("same-bin merge: Destination HU, one position freed", () => {
  const bins = [bin("X", { cap: 2 })];
  const inp = input(bins, { X: [L("P1", "A", "B1", 20), L("P2", "A", "B1", 15)] });
  const plan = run(inp);
  assert.equal(plan.stats.palletsFreed, 1);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.moves[0].sameBin, true);
  assert.equal(plan.moves[0].fromHu, "P2"); // fewest cases moved
  assert.equal(plan.stats.positionsFreed, 1);
  assert.equal(plan.stats.binsEmptied, 0);
  const rows = palletImRows(plan);
  assert.equal(rows[0].toHu, "P1");
  assert.equal(rows[0].iloc, "CO01");
  assert.equal(rows[0].bucket, "GOOD");
  assert.equal(imOf(inp, plan).held.length, 0);
});

test("WMS capacity refuses a merge the pallet's best fit would allow", () => {
  const bins = [bin("X"), bin("Y")];
  const stock = { X: [L("P1", "A", "B1", 25)], Y: [L("P2", "A", "B1", 10)] };
  // the bin type best fit is 30 cases, not the SKU's 40: 35 cases fit a pallet but not the bin
  const tight = run(input(bins, stock, { override: { X: 1 / 30, Y: 1 / 30 } }));
  assert.equal(tight.moves.length, 0);
  const loose = run(input(bins, stock));
  assert.equal(loose.moves.length, 1);
  assert.equal(loose.stats.binsEmptied, 1);
  assert.equal(loose.moves[0].fromBin, "Y");
});

test("cross-zone: off keeps zones apart; on follows the search table", () => {
  const bins = [bin("X"), bin("Y", { zone: "Z2" })];
  const stock = { X: [L("P1", "A", "B1", 20)], Y: [L("P2", "A", "B1", 15)] };
  assert.equal(run(input(bins, stock)).moves.length, 0);
  const on = run(input(bins, stock), { crossZone: "1" });
  assert.equal(on.moves.length, 1);
  assert.equal(on.stats.crossZoneMoves, 1);
  assert.equal(on.moves[0].crossZone, true);
  assert.ok(on.warnings.some((w) => w.code === "cross-zone"));
  const refused = run(input(bins, stock, { allowed: () => false }), { crossZone: true });
  assert.equal(refused.moves.length, 0);
});

test("only like stock merges: bucket, owner and inclusion apart; POST-GIN never moves", () => {
  const bins = ["X", "Y", "W", "V", "U"].map((c) => bin(c));
  const stock = { X: [L("P1", "A", "B1", 20)], Y: [L("P2", "A", "B1", 10, { bucket: "DAMAGED" })], W: [L("P3", "A", "B1", 10, { iloc: "CO02" })],
    V: [L("P4", "A", "B1", 10, { inclusion: "POST_GIN" })] };
  const none = run(input(bins, stock));
  assert.equal(none.moves.length, 0);
  assert.equal(none.stats.excluded, 1);
  const one = run(input(bins, { ...stock, U: [L("P5", "A", "B1", 5)] }));
  assert.equal(one.moves.length, 1);
  assert.deepEqual([one.moves[0].fromHu, one.moves[0].toHu], ["P5", "P1"]);
});

test("busy and locked bins: nothing in or out", () => {
  const bins = [bin("X"), bin("Y"), bin("W")];
  const locked = run(input(bins, { X: [L("P1", "A", "B1", 20, { locked: true })], Y: [L("P2", "A", "B1", 15)] }));
  assert.equal(locked.moves.length, 0);
  const put = run(input(bins, { X: [L("P1", "A", "B1", 20)], Y: [L("P2", "A", "B1", 15)] }, { busy: new Set(["X"]) }));
  assert.equal(put.moves.length, 0);
  assert.ok(put.warnings.some((w) => w.code === "put-lock" && w.bins.includes("X")));
  // stock being picked: its pallet neither gives nor takes
  const inp = input(bins, { X: [L("P1", "A", "B1", 20)], Y: [L("P2", "A", "B1", 15)] });
  inp.leaving = new Map([["X", [L("P1", "A", "B1", 2)]]]);
  assert.equal(run(inp).moves.length, 0);
});

test("keepers chosen to empty a bin two groups share (not the fullest pallets)", () => {
  // X holds the fuller pallets of A and B; Y1 / Y2 hold the emptier ones next to full pallets that keep them occupied
  const bins = [bin("X", { cap: 2, multiSku: true }), bin("Y1", { cap: 2 }), bin("Y2", { cap: 2 })];
  const inp = input(bins, { X: [L("A1", "A", "B1", 24), L("B1", "B", "B1", 30)], Y1: [L("F1", "A", "B1", 40), L("A2", "A", "B1", 12)], Y2: [L("F2", "B", "B1", 50), L("B2", "B", "B1", 15)] });
  const plan = run(inp);
  assert.deepEqual(plan.bins.emptied, ["X"]);
  assert.deepEqual(plan.moves.map((m) => m.fromHu).sort(), ["A1", "B1"]);
  assert.equal(plan.stats.binsEmptied, 1);
  assert.equal(plan.stats.positionsFreed, 2);
});

test("best fit is never exceeded and every pour is whole units", () => {
  // 9 partial pallets of A over 1D and 2D bins, cases and loose eaches
  const bins = [];
  const stock = {};
  const qty = [7, 13, 22, 31, 9, 18, 26, 5, 35];
  qty.forEach((q, i) => { const c = `R${i}`; bins.push(bin(c, { cap: i % 3 ? 1 : 2 })); stock[c] = [L(`H${i}`, "A", "B1", q), ...(i % 2 ? [L(`H${i}`, "A", "B1", 5, { uom: "L0" })] : [])]; });
  const inp = input(bins, stock);
  const plan = run(inp);
  const total = qty.reduce((s, q) => s + q, 0) / 40 + 4 * 5 / 480;
  assert.equal(plan.stats.palletsFreed, qty.length - Math.ceil(total));
  for (const p of plan.pallets.filter((x) => x.keepFor)) {
    const after = plan.moves.filter((m) => m.toHu === p.hu).at(-1).toPalletAfter;
    assert.ok(after <= 1 + 1e-9, `${p.hu} at ${after}`);
  }
  assert.ok(plan.moves.every((m) => Number.isInteger(m.qty) && m.qty > 0));
  assert.equal(imOf(inp, plan).held.length, 0);
});

test("whole pallets: into a bin with a free position, or an empty smaller bin; objective bins skips the latter", () => {
  const bins = [bin("X", { cap: 2 }), bin("Z", { cap: 2 }), bin("W", { cap: 3 }), bin("E", { cap: 1 })];
  const stock = { X: [L("P1", "A", "B1", 40)], Z: [L("P2", "A", "B1", 40)], W: [L("P3", "B", "B1", 50)] };
  const inp = input(bins, stock);
  const plan = run(inp);
  assert.equal(plan.pack.moves.length, 2);
  assert.deepEqual(plan.bins.emptied, ["W", "X"].sort());
  assert.deepEqual(plan.bins.emptyUsed, ["E"]);
  assert.equal(plan.stats.netBinsFreed, 1);
  // X and W emptied, E (was empty) used, and P1 takes Z's free position
  assert.equal(plan.stats.positionsFreed, 2 + 3 - 1 - 1);
  const rows = palletImRows(plan);
  assert.ok(rows.every((r) => r.pickHu && r.phase === 2));
  assert.equal(imOf(inp, plan).held.length, 0);
  const bins2 = run(inp, { objective: "bins" });
  assert.equal(bins2.pack.moves.length, 1);
  assert.equal(bins2.stats.emptyBinsUsed, 0);
  assert.equal(run(inp, { wholePallets: "0" }).pack.moves.length, 0);
});

test("whole pallets respect bin mixing, positions and scope; cases then the pallet that received them", () => {
  const bins = [bin("X", { cap: 2 }), bin("Z", { cap: 2 }), bin("Q", { cap: 2, zone: "Z2" })];
  // P2 (A) into Z? Z holds B and isn't multi-SKU: refused. X -> Z blocked, Q other zone: blocked
  const inp = input(bins, { X: [L("P1", "A", "B1", 40)], Z: [L("P2", "B", "B1", 50)], Q: [L("P3", "A", "B1", 30)] });
  assert.equal(run(inp).pack.moves.length, 0);
  // two half pallets in a 2D bin merge, then the keeper moves whole into a bin with a free position of the same SKU
  const bins2 = [bin("X", { cap: 2 }), bin("Z", { cap: 2 })];
  const inp2 = input(bins2, { X: [L("P1", "A", "B1", 20), L("P2", "A", "B1", 10)], Z: [L("P3", "A", "B1", 40)] });
  const plan = run(inp2);
  assert.equal(plan.moves.length, 1);
  assert.equal(plan.pack.moves.length, 1);
  assert.equal(plan.pack.moves[0].hu, "P1");
  assert.equal(plan.pack.moves[0].lines[0].qty, 30); // carries the cases it received
  const { files, held } = imOf(inp2, plan);
  assert.equal(held.length, 0);
  assert.ok(files.find((f) => f.rows.some((r) => r.pickHu)).wave > files.find((f) => f.rows.some((r) => !r.pickHu)).wave);
  // From / To scope: X may only give, nothing may land outside To
  const scoped = run(inp2, { from: ["Z1|2D"], to: ["NONE|2D"] });
  assert.equal(scoped.moves.length + scoped.pack.moves.length, 0);
});

test("weight and no-best-fit pallets are left alone", () => {
  const bins = [bin("X", { maxKg: 30 }), bin("Y")];
  // 20 + 15 cases x 1.2 kg = 42 kg > 30 kg max: X can't take Y's cases; Y can take X's (no max)
  const plan = run(input(bins, { X: [L("P1", "A", "B1", 20)], Y: [L("P2", "A", "B1", 15)] }));
  assert.equal(plan.moves[0].toBin, "Y");
  const off = run(input([bin("X", { maxKg: 30 }), bin("Y", { maxKg: 30 })], { X: [L("P1", "A", "B1", 20)], Y: [L("P2", "A", "B1", 15)] }));
  assert.equal(off.moves.length, 0);
  const n = run(input(bins, { X: [L("P1", "N", "B1", 5)], Y: [L("P2", "N", "B1", 5)] }));
  assert.equal(n.moves.length, 0);
  assert.ok(n.warnings.some((w) => w.code === "no-best-fit"));
});

test("the replay catches a plan that breaks the rules", () => {
  const bins = [bin("X"), bin("Y")];
  const inp = input(bins, { X: [L("P1", "A", "B1", 30)], Y: [L("P2", "A", "B1", 15)] });
  const plan = palletPlan(input(bins, { X: [L("P1", "A", "B1", 25)], Y: [L("P2", "A", "B1", 15)] }));
  // replayed on stock where P1 holds 30: 45 cases on one pallet
  const check = validatePalletPlan(inp, plan);
  assert.equal(check.ok, false);
  assert.ok(check.errs.some((e) => /best fit|WMS capacity/.test(e)));
});

test("Check a sheet's consolidation(m, rows) still works", () => {
  const b = bin("X", { cap: 2 });
  const m = { bins: [b], binByCode: new Map([["X", b]]), skus: SKUS, occupied: new Map([["X", [{ skuCode: "A", batch: "B1", uom: "L2", qty: 35 }]]]),
    palletStock: new Map([["X", new Map([["P1", [{ sku: "A", batch: "B1", uom: "L2", qty: 20 }]], ["P2", [{ sku: "A", batch: "B1", uom: "L2", qty: 15 }]]])]]) };
  const cons = consolidation(m, []);
  assert.equal(cons.stats.frees, 1);
  assert.equal(cons.shelf.groups, 0);
});
