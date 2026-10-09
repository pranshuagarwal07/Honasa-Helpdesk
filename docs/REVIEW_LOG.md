# UAT desk review log

> Written before the 2026-10-04 reorganisation: `inv.js` is now `lib/inventory.js`, `test-sheets/` is now `scripts/` (the generator) and `samples/check-tests/` (the sheets).

Review loop over the whole app: read each area critically, fix what is clearly wrong, then test
against UAT on port 8799. The test never touches the 8765/8766 servers, never writes to a database
and never queries PROD.

| # | Area | Status |
|---|------|--------|
| 1 | masters.js (Check masters) | done |
| 2 | inv.js checks + consolidation | done |
| 3 | server.js (acks, routing, env config) | done |
| 4 | inventory.html (Check a sheet, Check masters, Test case, Bulk fill UI) + the 4a search fix | done |
| 5 | index.html (acks page) | done |
| 6 | compare.js + compare.html | done |
| 7 | test-sheets/make-check-test.js | done |
| 8 | app.css + combo.js | done |
| 9 | ops.js + ops.html (new tools) | done |

## 1. masters.js — 2026-10-03

Read end to end. The date parsing matches the formats encarta accepts, the duplicate keys match
encarta's, files dropped together reference each other, and the family check (B21) handles
inactive batches and SKUs.

Fixed:
- **Error messages printed the file name twice** ("x.xlsx: x.xlsx: row 1 …"). The page already
  adds the name, so the server messages no longer do.
- **Unreadable files gave a cryptic zip error.** An Excel lock file (`~$…`) now says to drop the
  real file; anything else says to save the file as .xlsx.
- **Re-dropping a downloaded "Checked_" sheet** failed the header check without saying why. It now
  says to delete the Check and Issues columns before uploading.
- **P15 (one vendor lot per parent batch)** grouped rows with blank lot codes together, which
  could flag them as false matches. Blank codes are now left to P1.
- **New check B23 (yellow): a leading zero in the code's price** (`26JAN0499`) used to pass,
  because 0499 = 499 as a number.

Verified: the lock file, a non-xlsx file, the leading-zero row and a re-dropped checked sheet
each give the new message. The SKU, batch and production trap files give the same results as
before.

## 2. inv.js: Append/Reset checks and consolidation (2026-10-03)

Read validate(), palletsAfter(), consolidation() and the annotated download. These hold up:
- Multi-SKU / multi-batch counting against stock already in the bin.
- A base SKU and its case SKU counted as two SKUs.
- Pallet capacity, including pallets already in the bin.
- Best-fit maths.
- Merge selection: keeps the fullest pallets, and the moves always fit into them.

Fixed:
- **2d "over N days of shelf life left" was red.** For go-live opening stock, short-dated batches
  are real and must still be uploaded, so it is now yellow. Expired stock (2c) stays red. Bulk fill
  never picks short-dated batches, and Test case already showed it yellow, so neither changes.
- **Missing check: 7i, Operation Type is APPEND or RESET.** Before, a blank or misspelt
  operation (`APEND`) passed whenever every row had the same value, and the upload then rejected it.
- **Existing pallets were keyed by HU code alone.** If one HU code sat in two bins (bad data), one
  pallet vanished from the capacity and consolidation counts. They are now keyed by HU and bin.
- **Re-dropping a checked sheet** now tells you to delete the Check, Issues and Pallet fill columns,
  instead of printing the whole expected header row.

Verified: the 309-row test sheet for 525099899745193 still matches its answer key (309/309). The
trap sheet gives the same results. A variant with a blank operation, a misspelt operation and a
60-day batch flags 7i red and 2d yellow, as intended.

## 3. server.js: acks, routing, environment config (2026-10-03)

These hold up:
- PROD read-only guard: the 403 comes before the request body is used.
- After a push, the status is re-read from the database to verify the ack landed.
- The environment config is loaded from envs.json.

Fixed:
- **Any web page in the browser could push an ack.** Listening on 127.0.0.1 doesn't stop a page on
  another site from POSTing to `localhost:8765/api/push`, and DNS rebinding could read data through
  the API. Now every request must be addressed to `localhost:<port>` or `127.0.0.1:<port>`, and a
  request whose Origin is another site gets a 403.
- **A dropped idle DB connection (VPN reconnect) could crash the server.** The pg pools now handle
  their `error` event: the error is logged and the next query reconnects.
- **The main WMS and encarta pools had no query timeout.** They now have a 2-minute timeout; the
  Compare pools already had 60 s.

Verified on 8799:
- Pages load via localhost and via 127.0.0.1.
- A foreign Host and a foreign Origin both get 403.
- A push from the app's own page with an invalid type gets 400, so no ack is sent.
- The asn-098 lookup works.
- The 309-row sheet still matches its answer key, and the batch trap file gives the same results.

Not testable here: an actual VPN drop.

## Paused for new features (2026-10-03)

Built at the user's request, between pass 3 and pass 4:
- `ops.js` and `ops.html`: go-live readiness, the putaway explainer and the stuck-stock finder.
- masters.js: a fix sheet for batch checks, and `liveBatchCheck`.
- compare.js: `route.run`, exposed for the readiness report.

To do in the remaining passes:
- **inv.js 4a ("search table allows…") doesn't follow the real putaway rule.** It accepts any one
  BIN, ZONE or AREA row. Putaway actually needs one area row and one zone row that together equal the
  quant's values (as `ops.js` searchFit does). Make 4a use the same logic.
- Review ops.js and ops.html like the other areas.

## 4. Search-rule fix (4a) and inventory.html (2026-10-03)

Fixed:
- **4a "the search table allows each row's class, UOM and bucket in its bin" didn't follow putaway.**
  It accepted any one BIN, ZONE or AREA row whose own values held the class, UOM and bucket. Real
  putaway (storage search/repository.ts) has AREA and ZONE rows only. A bin qualifies when one area
  row and one zone row are each within the quant's values and together equal them exactly. UAT's
  area rows are empty, so the results happened to agree there. But a warehouse whose area rows carry
  a value (say bucket) would have had every row falsely red. A bin in an area with no search row was
  wrongly passed.
  - inv.js now works out, per zone, every class|UOM|bucket its (area row, zone row) pairs allow,
    ordered by area then zone sequence. Check a sheet, Bulk fill and the Test case page all read that.
  - If zone rules don't use class at all, any class matches.
- **Verified.** On three UAT warehouses x three class/UOM combinations, the "allowed bins" of Check
  a sheet and Bulk fill agree bin by bin with the putaway explainer (0 disagreements). The 309-row
  sheet is 309/309, the trap sheet is unchanged, and Bulk fill builds 552 rows with 0 failures.

inventory.html was read through: the api helper, mode switching, the warehouse-change handlers,
Check a sheet and Check masters rendering. Changing the warehouse already reloads the Bulk fill
overview and the Test case catalog. Left as is: a warehouse change clears the Test case grid without
asking. The rows name bins of the old warehouse, so keeping them would be wrong too.

## 5. Acks page: index.html and the lookups in server.js (2026-10-03)

These hold up:
- Push is a two-step arm and confirm. The PROD guard blocks it on the client and the server.
- After a push, the status is re-read and the verdict comes from the database, not from the HTTP 200.
- GRN acks offer PO-level and ASN-level payloads.

Fixed:
- **ASN numbers and order codes were matched case-sensitively.** Typing `ASN-098` for the stored
  `asn-098` gave "No ASN with code…". Lookups now ignore case and prefer an exact match. The payload,
  and the code shown on the page, use the code exactly as stored, because cincout matches it exactly.

Verified: `asn-098` and `ASN-098` both resolve to `asn-098` with the same payload. An upper-cased order
code resolves to its stored spelling `L0PickTest`. An unknown code still gives the "No ASN or order"
message. No push was sent.

## 6. Compare nodes: compare.js and compare.html (2026-10-03)

These hold up:
- Rows are matched by business key.
- Ids are translated to codes, three levels deep (bin → zone → area), and SKU ids to codes via encarta.
- Loose value comparison treats off and unset as the same, and "5" as equal to 5.
- The display limit is lifted for the Excel export.

Fixed (missing coverage):
- **`task_strategy` wasn't compared.** That is where `dropSlottingMode`, `allowBaseSkuInterchange`,
  HU kinds, scan rules and so on live: the per-warehouse flags that quietly differ. There is a new
  "Task strategies" section, keyed by taskKind, taskSubKind, taskLabel, the *Identifiers columns and
  sequence.
- **`storage_bin_fixed_mapping` and `task_bin_mode_lock` weren't compared.** Putaway reads both: bins
  reserved for a SKU, product or EAN, and bins blocked per task. They are now in Layout, keyed by bin
  code. The registry still lists the old `storage_bin_fixed_sku`, which exists in neither environment;
  the result says so.

Verified: 525099899745193 vs 1232206196556382 on UAT now shows task_strategy with 14 rows the same,
18 different (e.g. enableDropBinSequenceBasedOnHULoadOrder false vs true on INBOUND_PUTAWAY), 9 only
in A and 7 only in B. The new layout tables load: neither warehouse has rows, and there is no error.

## 7. test-sheets/make-check-test.js (2026-10-03)

These hold up:
- It reads the warehouse's search rules through the catalog, so the 4a fix flows into it without changes.
- Bins are picked by capacity, not bin-type name.
- Scarce occupied bins are shared across the cases.
- Each case writes the answer key.

Fixed:
- **The HU kind was hard-coded as `PALLET`.** On a warehouse whose pallet kind has another name, every
  pallet row would also have failed 5e ("HU kind exists"), which the answer key doesn't expect. It now
  uses the warehouse's own kind: `PALLET`, or else the first kind containing PALLET.
- **Re-running it always replaced the sheet being tested.** An `OUT_DIR` environment variable now sends
  the output elsewhere.

Verified: regenerated into scratch for both UAT warehouses and checked each sheet against its own answer
key: 525099899745193 304/304, 1232206196556382 398/398. Every case is still flagged exactly as intended.
The sheets in test-sheets/ were left untouched.

## 8. app.css and combo.js (2026-10-03)

Fixed:
- **`.checklist li` styled every list item inside a checklist, not just its rows.** That is what
  squeezed the readiness report's code chips into slivers (the user's screenshot). The rule is now
  `.checklist > li`, so a nested list can't be crushed on any page.
- **The Operations page used native dropdowns,** which the user found hard to read. It now loads
  combo.js like the other pages. UOM options carry a detail line: L2 (cases), L0 (eaches), L3 (pallets).
  combo.js already keeps its button in step when page code sets `.value`, which the page does.

Verified with headless Edge on port 8799:
- The Operations page renders with the custom dropdowns, and the Operations section shows in the sidebar.
- The readiness chip markup, drawn with the real CSS, shows whole codes on one line, with "Show all 13"
  and "Copy list" beneath.

## 9. Operations tools: ops.js and ops.html (2026-10-03)

These hold up:
- The explainer's rule order matches the WMS code: status, search, task block, fixed mapping, rolling
  days, multi-SKU/batch, max counts, HU type, pallet positions, only-full-pallet, capacity.
- Search matching is shared with 4a.
- Stuck locks count only when their task or session has ended or is missing.
- Readiness pulls everything from the same functions the other pages use.

Fixed:
- **With no batch entered, the explainer gave false "Multi-batch" rejections** for bins already holding
  the same SKU. The batch is optional, but "(no batch)" never matched the stored batch. Without a batch,
  single-batch bins are now judged by SKU; the rolling-days and max-SKU-batch rules are skipped, and a
  note says so.
- **Loose cases into a pallet bin ignored pallet positions,** so full pallet bins showed as usable. They
  now need a free position. The reason names the HU_RELAXED drop strategy, which could top up a part
  pallet instead.

Verified on 1756300152797421, SKU 10101163-0048:
- Pallet with batch: unchanged (66 usable).
- Pallet with no batch: the 3 Multi-batch rejections are gone and the note shows.
- Loose L2: 31 full pallet bins are now rejected under "Pallet positions".

Known limits, left as they are:
- Bins fixed to an L0 EAN aren't matched against the SKU's EAN.
- With no best fit, room isn't calculated, because bin and UOM volumes use different units.

## Done

All nine areas have been reviewed once. Nothing material is left open.
