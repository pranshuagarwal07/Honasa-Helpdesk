# Honasa Helpdesk

Local helpdesk toolkit for StackBox WMS on Honasa (UAT and PROD): GRN/GIN acks, inventory sheets
(test cases, bulk fill, checking, verifying, consolidation), master sheet checks, IM upload plans,
operations reports, config comparison between warehouses and debugging scripts.

## Before you start: add your credentials

The app ships **without any credentials**. `config/envs.json` holds the database connections and is
kept out of git (see `.gitignore`), so a fresh clone won't start until you create it.

1. Install **Node 18 or later** and connect to the **StackBox VPN** (the databases and WMS services
   are only reachable over it).
2. Copy the example file:
   ```
   copy config\envs.example.json config\envs.json
   ```
3. Fill in `config/envs.json` for each environment you'll use (`SBX_HONASA_UAT`, `SBX_HONASA_PROD`):

   | Field | What to put |
   |---|---|
   | `host`, `port` | The environment's read-only Postgres host and port |
   | `user`, `password` | A **read-only** database user. The server refuses to start without a password |
   | `databases` | Database names: `wms` (usually `postgres`), `encarta`, `backbone` |
   | `cincout` | UAT only: the internal wms-cincout URL used to push GRN/GIN acks. Leave it out for PROD |
   | `readOnly` | `true` for PROD. Ack pushes and API triggers are switched off and the sidebar turns red |
   | `outbox` | Optional: the wms-outbox URL for API triggers. Defaults to the `cincout` URL with `wms-cincout` changed to `wms-outbox`; PROD's is built in, and there the app only shows the Swagger body and curl command |
   | `defaultWhId`, `appPort` | Optional: the warehouse id preselected in the UI, and the port (8765 UAT, 8766 PROD) |

   Get the read-only connection details from Trinetra (`get_db_urls` / `list_urls` for the
   environment) or from your team lead. Use only the **read-only** user: this app never needs write
   access to the databases.
4. Start it with `run.bat` (UAT) or `run-prod.bat` (PROD).
   - If `config/envs.json` doesn't exist, the server stops straight away with a "no such file"
     (`ENOENT`) error. Go back to step 2.
   - If the environment's entry or password is missing, it stops with a message saying what to add,
     e.g. `Add the read-only database password for SBX_HONASA_UAT to config/envs.json`.

   The Compare page can also use any other environment you add to the same file.

**Never commit or share `config/envs.json`** (or the old copy under `_archive/`). It contains
passwords. Check `git status` before every commit; `config/envs.json` must never appear there.

## Run it

| | Starts | Port | Writes to the WMS |
|---|---|---|---|
| `run.bat` | SBX_HONASA_UAT | 8765 | Only when you push an ack |
| `run-prod.bat` | SBX_HONASA_PROD | 8766 | Never (read-only) |

Each script restarts its server if it's already running, so run it again after changing code.
Pages and styles are read on every request, so edits under `public/` only need a browser refresh.

Needs Node 18 or later, the StackBox VPN, and `config/envs.json` with your credentials. See
[Before you start](#before-you-start-add-your-credentials).

## Modules

The sidebar lists one entry per module. Inside a module, a tab bar holds its sections and each section has
sub-tabs for its features. The address keeps your place as `/<module>#<tab>/<feature>`, and the last place is
remembered per module.

| Module (route) | Tab | Features |
|---|---|---|
| Operations (`/ops`) | Go-live · Putaway · Stock health | Readiness · Why putaway says no · Stuck stock |
| | API triggers | Pack → staging (ISS-1701: check a pack pallet, then send `ob-pack.hu.completed`) · Putaway slotting (re-run `pick-drop-provisional.drop.slotting.v2` for "Destination Bin Not Found") |
| Acks (`/`) | Inbound · Outbound | GRN ack · GIN ack |
| Inventory (`/inventory`) | Build sheets | Test case · Bulk fill |
| | Check | Check a sheet · Verify an upload |
| | Consolidate | Empty bins · Tidy pallets |
| | IM uploads | IM files · IM checker (placeholder until the checker is merged) |
| Masters (`/masters`) | Check sheets | All sheets · SKU · Batch · Production batch |
| Config (`/compare`) | Compare | Compare nodes |

Old links like `/inventory#verify` or `/ops#stuck` still open the right feature, and `/inventory#masters`
goes to `/masters`.

**To add a feature:** add its section to the module's page with `hidden` and an id, then add
`{id, label, view: '#that-id', lede, onShow}` to the module's `tabs` list. That list is in
`public/js/inventory/page.js` (Inventory and Masters), `ops.js`, `acks.js` or `compare.js`. `public/js/tabs.js`
draws the tab bar and sub-tabs and shows one feature at a time. A new module also needs a route in `PAGES`
(`server.js`) and a link in `public/partials/rail.html`.

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
  pages/           acks.html (/), inventory.html (/inventory and /masters), ops.html (/ops), compare.html (/compare)
                   server.js fills in the sidebar, the module and the environment (the DESK line) when it serves them
  css/app.css      shared styles and design tokens
  js/              rail.js (sidebar), tabs.js (each module's tab bar and sub-tabs), combo.js (the dropdowns
                   on every page), one file per page:
                   acks.js, ops.js, compare.js, and inventory/ with one file per tool, loaded in
                   order by inventory.html (page.js first, start.js last)
  partials/        rail.html, the sidebar on every page (one link per module)
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
