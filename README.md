# UAT desk

A local web app for Honasa UAT work: GRN/GIN acks, inventory sheets (test cases, bulk fill,
checking, verifying, consolidation), master sheet checks, operations reports and config
comparison between warehouses.

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
lib/             one module per feature, each handling its own /api/... routes
  acks.js          GRN and GIN acks: lookup, payload, push (refused when read-only)
  inventory.js     test case, bulk fill, check a sheet, verify, consolidate stock
  im-upload.js     IM cockpit Internal Movement upload sheets from a consolidation plan
  masters.js       SKU, batch and production batch master checks
  ops.js           go-live readiness, putaway explainer, stuck stock
  compare.js       compare two nodes' config
public/          what the browser loads
  index.html       acks
  inventory.html   inventory and masters tools
  ops.html         operations tools
  compare.html     compare nodes
  app.css          shared styles and design tokens
  combo.js         the dropdowns used on every page
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
_archive/        old copies and logs, kept for reference; nothing reads them
```

`_archive/backup-20261003/` includes an old copy of `envs.json` with passwords. Treat the folder
like `config/` and don't share it.
