// The one Consolidate plan (combined.js): cells split by bin kind, and the parts' plans added up.
const test = require("node:test");
const assert = require("node:assert/strict");
const { splitCells, combinePlans, notEmptiedOf } = require("../../lib/planners/combined");
const { relocatePlan } = require("../../lib/planners/relocate");
const { validateRelocate } = require("../../lib/planners/relocate-check");
const { eachesPlan } = require("../../lib/planners/eaches");
const { validatePlan } = require("../../lib/planners/eaches-check");

const SKUS = new Map([["A", { L2inL3: 40, L0inL2: 12, L0wt: 0, volL0: 100, volL2: 1200, volL3: 48000 }]]);
const B = (code, huType, binType, o = {}) => ({ code, zone: "Z1", area: "A1", areaType: "INVENTORY", status: "ACTIVE", huType, binType, cap: huType === "PALLET" ? 2 : 0,
  volCC: huType === "BIN" ? 10000 : 0, maxKg: null, multiSku: true, multiBatch: true, huMultiSku: true, huMultiBatch: true, fixed: false, ...o });
const bins = [B("P-1", "PALLET", "2D"), B("P-2", "PALLET", "2D"), B("S-1", "BIN", "S10"), B("S-2", "BIN", "S10")];
const L = (hu, uom, qty) => ({ hu, sku: "A", batch: "B1", bucket: "GOOD", inclusion: "INCLUDED", iloc: "CO01", price: 10, uom, qty, locked: false });
const stock = new Map([["P-1", [L("H1", "L2", 10)]], ["P-2", [L("H2", "L2", 20)]], ["S-1", [L(null, "L0", 10)]], ["S-2", [L(null, "L0", 40)]]]);
const input = { bins, stock, leaving: new Map(), skus: SKUS, allowed: () => true };

test("cells split by the kind of bin they hold; unknown cells apart", () => {
  const m = { bins };
  assert.deepEqual(splitCells(m, ["Z1|2D", "z1|s10", "Z9|X"]), { pallet: ["Z1|2D"], shelf: ["Z1|S10"], unknown: ["Z9|X"] });
});

test("pallet and shelf parts add up: one step numbering, stats, zones, warnings, check", () => {
  const pal = relocatePlan(input, { from: { cells: ["Z1|2D"] }, to: { cells: ["Z1|2D"] } });
  const shelf = eachesPlan(input, { from: ["Z1|S10"], to: ["Z1|S10"] });
  const parts = [{ kind: "pallet", engine: "relocate", plan: pal, check: validateRelocate(input, pal) },
    { kind: "shelf", engine: "eaches", plan: shelf, check: validatePlan(input, shelf) }];
  const c = combinePlans(parts, { goal: "empty", notes: [{ level: "info", code: "scope", text: "note", bins: [] }] });
  assert.equal(c.stats.binsEmptied, pal.stats.binsEmptied + shelf.stats.binsEmptied);
  assert.equal(c.stats.binsEmptied, 2);
  assert.equal(c.stats.positionsFreed, pal.stats.positionsFreed);
  assert.deepEqual(c.steps.map((s) => s.step), c.steps.map((s, i) => i + 1));
  assert.deepEqual([...new Set(c.steps.map((s) => s.part))], ["pallet", "shelf"]);
  assert.equal(c.zones.length, 1); // one zone row: pallet and shelf bins of Z1 together
  assert.equal(c.zones[0].binsEmptied, 2);
  assert.equal(c.check.ok, true);
  assert.ok(c.warnings.some((w) => w.code === "scope"));
  assert.deepEqual(c.bins.emptied.sort(), ["P-1", "S-1"]);
  // a failed part fails the whole plan, its errors named by bin kind
  parts[1].check = { ok: false, errs: ["boom"] };
  const bad = combinePlans(parts, { goal: "empty" });
  assert.equal(bad.check.ok, false);
  assert.deepEqual(bad.check.errs, ["Shelf bins: boom"]);
  assert.ok(Array.isArray(notEmptiedOf(parts)));
});
