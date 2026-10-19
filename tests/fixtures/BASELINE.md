# Consolidation bench: baseline (HEAD 4f37ae4, before v2)

Fixture `prod-1662652404097787-2026-10-10.json`, taken 2026-10-10 11:36 UTC (17:06 IST) from SBX_HONASA_PROD,
read-only. It holds every database answer the two routes needed (32 queries, 4.5 MB), replayed through each
version's own loaders. Internal warehouse data: keep it local (see the .gitignore request in docs/CONSOLIDATION_V2.md).

Re-run: `node scripts/bench-consolidation.js --baseline 4f37ae4` (old vs working tree on the same fixture).
A new snapshot (`--snapshot`) is a new point in time, so re-run the baseline on it rather than comparing with this table.

| planner | scope | emptied | emptyUsed | net | posFreed | palFreed | moves | cases | xZone | held | check | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| pallets | all pallet bins (no scope before v2) | 35 | 0 | 35 | 93 | 81 | 119 | 1045 | 30 | 28 | - (none) | 76 |
| relocate | Z3 1D/2D | 12 | 7 | 5 | 14 | 4 | 14 | 195 | 0 | 0 | ok | 115 |
| relocate | Z1 1-3D + Z2 1-2D | 7 | 4 | 3 | 11 | 3 | 9 | 36 | 6 | 0 | ok | 636 |

Scopes: `ZONE-3|1D-PALLET-BIN, ZONE-3|2D-PALLET-BIN` and `ZONE-1|1D..3D-PALLET-BIN, ZONE-2|1D..2D-PALLET-BIN`, as
both From and To; relocate with belowPct 100, useEmpty smaller. HEAD's pallet route ignores from/to, so its scoped
runs equal the whole-warehouse run.

All numbers here are the bench's replay (HEAD has no contract stats): the planned IM rows (uploads + held back)
applied to the fixture stock. Stock a pick task is taking out is left out before and after, so a bin whose free
stock all moves counts as emptied (relocate calls these "empty once the stock being picked leaves").

- emptied / emptyUsed / net: source bins left with no stock / bins empty before that receive stock / the difference.
- posFreed: positions of bins emptied - positions of empty bins used + change in positions taken inside pallet bins
  occupied before and after (merges free one; a whole pallet moved into a free position takes one).
- palFreed: pallets (HUs) holding stock before and none after. moves: IM rows. cases: units moved (L2 + L0 as is).
- xZone: rows whose source and destination zones differ. held: rows left out of the upload by the WMS capacity guard.
- ms: the route, fastest of 2, masters rebuild (~70 ms) included.

Where the planner's own figures differ from the replay (expected, by definition):
- pallets binsEmptied 33 (planner) vs 35: D-R04-12 and D-R09-10 keep only stock being picked once the merges run.
- relocate Z3 positionsFreed 15 (planner) vs 14: the planner doesn't charge the free position a whole pallet takes in
  a bin that already held stock.

What the baseline shows (the PROD lessons): the Pallets plan moves 30 of 119 rows across zones and 28 rows can't
be uploaded (WMS capacity); relocate uses 7 empty bins to empty 12 in ZONE-3, so only 5 bins net.
