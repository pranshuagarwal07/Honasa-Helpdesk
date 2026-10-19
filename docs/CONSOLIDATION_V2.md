# Consolidation v2: shared brief for the agents

Branch: `consolidation-v2` (one working tree, `C:\Users\pranshu.agarwal\Desktop\honasa-ack`).
Four agents work here at the same time. **Edit only the files you own** (table below). If you need a
change in a file you don't own, write it under "Requests" at the end of this file and work around it.
Don't commit, don't switch branches, don't run `git stash`/`reset`/`checkout` — the lead commits.

| Agent | Owns |
|---|---|
| A — pallet merge | `lib/planners/pallet-merge.js`, new `lib/planners/pallet-merge-check.js`, `lib/im-upload/rows.js` (`palletImRows`, `palletLines`), the `GET /api/inv/consolidate` block in `lib/inventory/index.js`, `tests/unit/pallet-merge*.test.js` |
| B — bins under % full | `lib/planners/relocate.js`, `lib/planners/relocate-check.js`, `lib/planners/inputs.js`, `lib/wms/locks.js`, the `GET /api/inv/relocate` block in `lib/inventory/index.js`, `tests/unit/relocate*.test.js` |
| C — UI | `public/js/inventory/consolidate.js`, the `<section id="v-consolidate">` part of `public/pages/inventory.html`, `public/css/app.css` |
| D — workbooks, IM files, bench | `lib/planners/workbooks.js`, `lib/im-upload/files.js`, `scripts/bench-consolidation.js`, `tests/fixtures/`, `tests/integration/` |

A and B both edit `lib/inventory/index.js`: touch only your own route block, with small, targeted Edits
(never rewrite the file).

## Running things

- Node built-in test runner: `node --test tests/` .
- Server: `set APP_ENV=SBX_HONASA_PROD` (read-only) or `SBX_HONASA_UAT`, and a port of your own so you
  don't clash: A 8801, B 8802, C 8803, D 8804 (`PORT=880x`). Never use 8765 / 8766 (the user's servers).
- Databases: read-only SELECTs only, on any env including PROD. Never write. Never push an ack.
- Real warehouse for testing: SBX_HONASA_PROD, whId `1662652404097787`.

## What we learned on PROD on 9–10 Oct (real failures the plans must avoid)

1. **IM upload capacity refusals.** The Pallets plan merged cases into bins the WMS then refused
   ("Qty exceeds bin capacity": bin over 100% as `lib/wms/capacity.js` counts it); 30 rows ended in
   "Not in IM upload". The planner must use the WMS capacity (`wmsCapacity().unit`) *while planning*, so
   every planned move is uploadable.
2. **Cross-zone / cross-area moves with no control.** The Pallets plan moved cases from mezzanine (ZONE-3
   / MP, M-TEMP) to ground bins (ZONE-1/2 PALLET), and from MP into the overflow areas (G-TEMP / M-TEMP).
   Same SLOC (CO01) so legal for the ERP, but heavy for the floor. Default must be same zone; cross-zone
   only when asked, and then only where the search table allows (`allowedSeq`).
3. **Only like stock merges.** Merge only lines with the same SKU, batch, bucket, ILOC (owner) and
   inclusion status. Never move POST-GIN / PRE-GRN stock (loading reads only INCLUDED).
4. **Busy bins.** A bin with arriving stock (PUT lock, e.g. an open inbound putaway) or locked stock takes
   nothing and gives nothing. A Bins-under-% plan sent a pallet into D-R06-03 while INBOUND-4 had a PUT
   lock there — check whether the `inventory` view actually returns PUT-lock rows; if it doesn't, read
   locks from `handling_unit_quant` (`"lockMode" <> 'NONE'`) as well.
5. **Pallet bins are single-pallet-per-position.** 1D = 1 pallet, 2D = 2, 3D = 3 (`palletCapacity`), and
   most bins are `multiSku=false, multiBatch=false`. An uploaded IM whose destination is full fails with
   "Destination Bin Not Found" (INTERNAL_MOVEMENT-28).
6. **Empty pallet HUs** (handling_unit with no quants) sit in some bins (PBL0064 in D-R06-13, PBL0763 in
   A-R12-06). The WMS doesn't count them, but the floor can't put a pallet there until it's cleared. Report
   them as warnings on any bin a plan uses.
7. **"Freed" is ambiguous.** Report gross bins emptied, empty bins used, net bins freed and net pallet
   positions freed separately.

## Best fit (the core constraint)

Best fit for a pallet = the SKU's `L2inL3` (cases per full pallet). A pallet's fill = Σ line qty / best
fit (L0 via L0inL2). A merged pallet may not exceed 100% of best fit. Pallets with no best fit are left
alone and reported. The WMS capacity check (bin type best fit, else derived pallet best fit, else volume)
is a second, separate limit on the *bin*; both must hold.

## Output contract (server → UI and workbooks)

Both `GET /api/inv/consolidate` (pallets) and `GET /api/inv/relocate` keep every field they return today
and **add** these (the UI must also cope with them missing):

```js
stats: {
  binsEmptied,        // gross: bins left with no stock
  emptyBinsUsed,      // bins that were empty and receive stock
  netBinsFreed,       // binsEmptied - emptyBinsUsed
  positionsFreed,     // net pallet positions freed (positions of bins emptied - positions of empty bins used,
                      //  plus positions freed inside bins that stay occupied, for merges)
  palletsFreed,       // pallets that disappear (merged away)
  moves,              // IM rows
  casesMoved,         // units moved, summed (L2 cases + L0 eaches as they are)
  crossZoneMoves,     // moves whose from-zone != to-zone
  heldBack,           // planned moves left out of the IM upload (should be 0 now)
}
warnings: [{ level: "block" | "warn" | "info", code, text, bins: [binCode...] }]
// e.g. code "empty-pallet-in-target", "put-lock", "no-best-fit", "cross-zone", "lock-read-failed"
moves[i] additionally: { fromZone, toZone, fromArea, toArea, crossZone: bool }
zones: [{ zone, area, bins, positions, used, spare, binsEmptied, positionsFreed }]   // per zone, after the plan
opts: the options actually used (echo)
```

Pallets route — new query params (all optional; defaults keep today's behaviour except where it was
wrong): `from`, `to` = comma-separated `zone|binType` cells (same as relocate; empty = every inventory
pallet bin), `crossZone=1` (allow moves between zones, search table permitting), `wholePallets=1` (also
move whole pallets to empty bins; default 1), `checkWeight` (default 1), `objective=positions|bins`
(default positions). The UI can fill the pickers from `GET /api/inv/relocate-scope`.

## Requests (agents append here)


**From A (pallet merge), for C (UI) and D (workbooks):**
- Pallets route: `moves` stays the count it always was (case moves). The per-move list is **`steps`** (case moves
  `kind:"merge"`, then whole pallets `kind:"pallet"`, in upload order; first 1000, total in `stepsCount`). Each step has
  fromZone/toZone/fromArea/toArea/fromBinType/toBinType/crossZone; merges also qty/uom/bucket/iloc/sameBin/toPalletAfter,
  pallets also `lines` and `toWasEmpty`. Also returned: `check {ok, errs}`, `warnings`, `opts`.
- `stats.binsEmptied` is now **gross** (merges + whole pallets) per the contract. The old merges-only number is
  `stats.mergeBinsEmptied`; whole-pallet bins are still `pack.stats.bins`. So the UI's old `s.binsEmptied + p.bins`
  double counts: use `s.binsEmptied` (or `s.netBinsFreed`). Same for the workbook line "Bins emptied by merging"
  (read `mergeBinsEmptied`). Extra stats: `caseMoves`, `sameBinMoves`, `wholePallets`, `plannedMoves`, `noRoom`,
  `excluded` (pallets with POST-GIN / PRE-GRN stock), `outOfScope`.
- `stats.moves` = IM rows across the upload files (+ held); `stats.heldBack` = rows held back (0 on PROD now).
- `zones[]`: `used`/`spare` are after the plan; `usedBefore`/`spareBefore`, `partial`, `frees`, `binsFreed`,
  `emptyBinsUsed` also there.
- Plan store (`plans` token): `{ whId, m, cons, pack, plan, check, im, imHeld }`; `cons` is the plan itself (same
  merges / moves / pallets / stats shape the workbook reads, moves now in whole units with bucket and ILOC), so
  `planWorkbook` works unchanged. `palletImRows(plan)` is the new call; the old 4-argument call still works.

**From A, for B (locks):** the pallets route no longer calls `palletLocks`; `palletInput` (pallet-merge.js) reads
locks itself: the inventory view's LOCK_KIND, plus `handling_unit_quant."lockMode"` not NONE/PICK (stock arriving)
and locked HUs with nothing on them, both mapped to their bin, as busy. Reuse it for relocate if useful. The
`palletLocks` import in lib/inventory/index.js is now unused; I left that line alone (shared header).

## Phase 1 (14 Oct): one Consolidate screen

The three tabs (Shelf bins, Pallets, Bins under % full) are one form now: a goal, one zone × bin type picker over
pallet and shelf bins, and the rules for the bin kinds ticked. `GET /api/inv/consolidate-plan` (`lib/planners/combined.js`)
sends each kind to its planner and adds the parts up in the same output contract (one step numbering, one set of IM
upload files, one workbook from `consolidate-plan-download`; `im-download?plan=unified`):
- `goal=tidy`: pallet cells -> `palletPlan` (shelf cells are ignored, with a note)
- `goal=empty`: pallet cells -> `relocatePlan`, shelf cells -> `eachesPlan` (pallet stock never goes to shelf bins)

The old routes (`consolidate`, `relocate`, `consolidate-eaches`) still answer, for the bench and older links.
Done along with it: the shelf planner never moves stock that isn't INCLUDED, reads PUT / task locks from the HU tables
(`binLocks`), plans within the WMS capacity check, takes From / To cells and returns the contract; Bins under % full has
a `crossZone` switch (default off, as rule 2 says) and also leaves non-INCLUDED stock alone.
## Phase 2 (14 Oct): merge first, then empty bins

`lib/planners/chain.js`, behind Empty bins on pallet bins (`mergeFirst`, default on; the screen's "Merge part-full pallets
first"): stage 1 is the Pallets merges (palletPlan, no whole-pallet moves), stage 2 is relocatePlan on the stock the merges
leave, worked out by applying the merge moves to the stock read (not taken from the planner). Both stages read one
relocateInput (one stock and lock read). A pallet the merges empty stays in its bin as an empty pallet and holds its
position in stage 2 (unless "Skip bins with an empty pallet" is off); `empty-pallets-left` lists them. The plain plan is
made too and the better by the objective is kept, so merging first never makes a plan worse (warning `merge-first` says
which and by how much). IM rows (`chainImRows`): the merges first; a stage 2 row touching a bin the merges touched waits a
wave. Re-checks: validatePalletPlan on stage 1, validateRelocate on stage 2 from the post-merge stock.

Bench (10 Oct fixture, net positions freed / bins emptied): every pallet bin 23 / 21 plain -> 67 / 21 merge first;
Z1+Z2 1 / 1 -> 45 / 1; Z3 13 / 11 both (plain kept). The plan's counts match the bench replay on every row.

Also fixed with it: positions freed is honest everywhere (a whole pallet into a bin that holds stock takes a position;
Pallets, Bins under % full and the re-check), and the Pallets plan warns about the empty pallets its merges leave.
Still open: the old Pallets route's palletInput and relocateInput read locks and empty HUs differently (the one screen
uses relocateInput for both stages), and the Pallets plan never blocks on an empty pallet in a target bin.

## Decisions (14 Oct, user)

- No SAP posting for bin-to-bin IM within one SLOC.
- The WMS closes a pallet whose cases are all picked off by IM, and a bin left with nothing is empty. chain.js no longer
  holds positions for pallets the merges empty, and palletPlan no longer warns about them (`empty-pallets-left` is gone).
  Empty pallet HUs already standing in bins (read from the HU tables) still hold their position. Bench, every pallet bin:
  merge first now frees 70 positions (was 67), ZONE-1+2 47, ZONE-3 14 (merge first now kept there too).
- Default aim: free whole bins for Empty bins, free pallet positions for Tidy pallets; the screen remembers it per goal.
- The old Pallets route (`GET /api/inv/consolidate`, its download and `im-download?plan=pallet`) and `palletInput` are retired.
  Tidy pallets reads stock and locks through `relocateInput` (chain.js `mergeInputOf`), the same read as Empty bins.
Still open: who may run and upload on PROD (HCPL); Tidy pallets warns but doesn't block on an empty pallet HU in a target
bin; moving the screen into the WMS portal.
