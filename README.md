# Honasa Helpdesk

Local helpdesk toolkit for StackBox WMS on Honasa (UAT and PROD): GRN/GIN acks, inventory sheets
(test cases, bulk fill, checking, verifying, consolidation), master sheet checks, IM upload plans,
operations reports, config comparison between warehouses and debugging scripts.

## Run it

| | Starts | Port | Writes to the WMS |
|---|---|---|---|
| `run.bat` | SBX_HONASA_UAT | 8765 | Only when you push an ack |
| `run-prod.bat` | SBX_HONASA_PROD | 8766 | Never (read-only) |

Each script restarts its server if it's already running, so run it again after changing code.
Pages and styles are read on every request, so edits under `public/` only need a browser refresh.

Needs Node 18 or later, the StackBox VPN, and `config/envs.json` (copy `config/envs.example.json`
and fill in the read-only database user and password).

## Folders

```
server.js        entry point: config, database pools, page serving; passes /api/... to lib/
lib/             one folder per feature; each feature's index.js handles its own /api/... routes
  core/            shared helpers: db.js (pools, q, tryQ), http.js (send, readBody, sendXlsx),
                   xlsx.js (addSheet, cellValue), tokens.js (results kept for a download),
                   util.js (upper, day keys, number formats)
  wms/             reads and rules of the WMS itself
    load-masters.js  a warehouse's bins, zones, search table, stock and encarta SKUs (cached 10 min)
    search.js        which zones the search table lets a class + UOM + bucket into
    pallets.js       best fit and every pallet in each bin (palletShare, palletsAfter)
    capacity.js      the bin capacity check an IM upload runs (wmsCapacity, unitShare)
    locks.js         task locks on stock (LOCK_KIND, palletLocks)
  acks/            GRN and GIN acks: lookup, payload, push (refused when read-only)
  inventory/       the /api/inv/... routes (index.js) and the inventory tools:
    fill.js          bulk fill            check.js     check a sheet, its annotated download
    verify.js        verify an upload     testcase.js  rows from the test case grid
    catalog.js       snapshot and pickers sheet.js     read/write Append/Reset sheets
    templates.js     the column template, a warehouse's own saved in data/templates/
  planners/        consolidation planners
    pallet-merge.js  merge partial pallets, empty bins by moving whole pallets
    eaches.js        shelf bins by volume (+ eaches-check.js, an independent re-check)
    relocate.js      bins under % full (+ relocate-check.js, an independent replay)
    inputs.js        the pickers' scopes and the stock each planner reads
    workbooks.js     each plan's download
  im-upload/       IM cockpit Internal Movement upload files from a plan
    rows.js          plan -> upload rows       files.js   rows -> files the uploader accepts
  masters/         SKU, batch and production batch master checks
  ops/             go-live readiness, putaway explainer, stuck stock
  compare/         compare two nodes' config
public/          what the browser loads
  pages/           acks.html (/), inventory.html (/inventory), ops.html (/ops), compare.html (/compare)
                   server.js fills in the sidebar and the environment (the DESK line) when it serves them
  css/app.css      shared styles and design tokens
  js/              rail.js (sidebar), combo.js (the dropdowns on every page), one file per page:
                   acks.js, ops.js, compare.js, and inventory/ with one file per tool, loaded in
                   order by inventory.html (page.js first, start.js last)
  partials/        rail.html, the sidebar on every page
tests/           unit/, integration/, fixtures/ (Node's built-in test runner)
config/
  envs.json        database connections per environment (contains passwords; don't share)
  envs.example.json  the same shape with no real values
data/
  templates/       column layouts saved with "Use my template", one file per warehouse
                   (created the first time one is saved)
scripts/
  make-check-test.js   builds a deliberately broken sheet plus its answer key for testing Check a sheet
samples/
  check-tests/     sheets made by that script
docs/
  REVIEW_LOG.md    notes from earlier review passes
_archive/        old copies, logs and .bak files, kept for reference; nothing reads them (not in git)
```

`_archive/backup-20261003/` includes an old copy of `envs.json` with passwords. Treat the folder
like `config/` and don't share it.
