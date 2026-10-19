// Bench for the two pallet-bin planners (Pallets = pallet-merge + packBins, Bins under % = relocate) on a
// frozen copy of a real warehouse, so a planner change can be measured against the old one on the same stock.
//
//   node scripts/bench-consolidation.js --snapshot            read PROD (read-only) once, save the fixture
//   node scripts/bench-consolidation.js --snapshot --add      add only queries the newest fixture lacks (keeps its data)
//   node scripts/bench-consolidation.js                       run the working tree's planners on the newest fixture
//   node scripts/bench-consolidation.js --baseline HEAD       ...and the planners as of a git ref, same fixture
//   options: --fixture <file>  --env SBX_HONASA_PROD  --wh 1662652404097787  --md (markdown table)
//            --out <dir> (also write each run's plan workbook there, a smoke test of the downloads)
//
// The fixture is every database answer the routes needed (SQL + params -> rows), not hand-picked objects:
// replaying them through each version's own loaders (load-masters, palletLocks, wmsCapacity, relocateInput,
// palletLines) rebuilds m, its Maps and Sets, locks, the capacity tables and the planner inputs exactly as the
// server would, so a planner that starts reading something new from m still sees it. Each run goes through
// the real route (GET /api/inv/consolidate, /api/inv/relocate) with the token store tapped to get the full
// plan, so A/B's route changes are measured as shipped. A query the fixture lacks fails loudly: re-snapshot.
//
// Numbers: the route's contract stats when the version has them (stats.heldBack present), else the bench's
// own replay of the planned IM rows on the fixture stock (marked *). The replay always runs as a cross-check.
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");
const { execFileSync, spawnSync } = require("child_process");

const REPO = path.resolve(__dirname, "..");
const FIXTURES = path.join(REPO, "tests", "fixtures");
const args = process.argv.slice(2);
const arg = (k, d) => { const i = args.indexOf(k); return i >= 0 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : d; };
const flag = (k) => args.includes(k);
const WH = arg("--wh", "1662652404097787");
const ENV = arg("--env", "SBX_HONASA_PROD");
const EPS = 1e-6;

// the scopes the user ran on PROD on 10 Oct (bins-under-% "ZONE-3" and "ZONE-1 ZONE-2" downloads)
const T = (z, ...d) => d.map((n) => `${z}|${n}D-PALLET-BIN`);
const SCOPES = [
  { name: "all pallet bins", cells: [], relocate: false }, // the Pallets plan as the user ran it (no scope before v2)
  { name: "Z3 1D/2D", cells: T("ZONE-3", 1, 2) },
  { name: "Z1 1-3D + Z2 1-2D", cells: [...T("ZONE-1", 1, 2, 3), ...T("ZONE-2", 1, 2)] },
];

// ---- fixture: recorded queries, columnar to keep it small ---------------------------------------------
const norm = (sql) => String(sql).replace(/\s+/g, " ").trim();
const qkey = (db, sql, params) => `${db}\u0001${norm(sql)}\u0001${JSON.stringify(params ?? [])}`;
const pack = (rows) => { const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))]; return { cols, data: rows.map((r) => cols.map((c) => r[c] ?? null)) }; };
const unpack = ({ cols, data }) => data.map((d) => Object.fromEntries(cols.map((c, i) => [c, d[i]])));

// db facade the lib modules take ({ wms, encarta, q, tryQ }); `answer` resolves one query
function facade(answer) {
  const wms = { name: "wms" }, encarta = { name: "encarta" };
  const q = async (db, sql, params = []) => answer(db.name, sql, params);
  const tryQ = async (db, sql, params) => { try { return [await q(db, sql, params), null]; } catch (e) { return [[], e.message]; } };
  return { wms, encarta, q, tryQ };
}
function replayDb(fx) {
  const map = new Map(fx.queries.map((x) => [qkey(x.db, x.sql, x.params), x]));
  const missing = [];
  const db = facade((name, sql, params) => {
    const hit = map.get(qkey(name, sql, params));
    if (!hit) { missing.push(norm(sql).slice(0, 140)); throw new Error(`not in fixture (re-run --snapshot): ${norm(sql).slice(0, 80)}`); }
    if (hit.err) throw new Error(hit.err);
    return unpack(hit.rows); // fresh objects: loaders mutate rows
  });
  db.missing = missing;
  return db;
}
const newestFixture = () => {
  const f = fs.existsSync(FIXTURES) ? fs.readdirSync(FIXTURES).filter((x) => x.startsWith(`prod-${WH}-`) && x.endsWith(".json")).sort().pop() : null;
  if (!f) throw new Error(`No fixture for ${WH} in tests/fixtures. Run: node scripts/bench-consolidation.js --snapshot`);
  return path.join(FIXTURES, f);
};
const loadFixture = (file = newestFixture()) => JSON.parse(fs.readFileSync(file, "utf8"));
// m as the server builds it, from a fixture (for unit tests that want real data)
async function fixtureMasters(fx = loadFixture(), root = REPO) {
  return require(path.join(root, "lib/wms/load-masters")).createMastersLoader(replayDb(fx))(fx.meta.whId);
}

// ---- a version of the app: the working tree or a git ref extracted outside the repo ---------------------
function extractRef(ref) {
  const sha = execFileSync("git", ["rev-parse", "--short", ref], { cwd: REPO, encoding: "utf8" }).trim();
  const dir = path.join(os.tmpdir(), `honasa-bench-${ref.replace(/[^A-Za-z0-9_.-]+/g, "_")}-${sha}`);
  const files = execFileSync("git", ["ls-tree", "-r", "--name-only", sha, "lib"], { cwd: REPO, encoding: "utf8" }).split(/\r?\n/).filter(Boolean);
  for (const f of files) {
    const to = path.join(dir, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.writeFileSync(to, execFileSync("git", ["show", `${sha}:${f}`], { cwd: REPO, maxBuffer: 64 << 20 }));
  }
  // exceljs / pg from the repo's node_modules (a junction needs no admin rights on Windows)
  const nm = path.join(dir, "node_modules");
  if (!fs.existsSync(nm)) fs.symlinkSync(path.join(REPO, "node_modules"), nm, "junction");
  return { label: `${ref} (${sha})`, root: dir };
}

// require a version's inventory routes with its token store tapped, so the full plan behind a response is ours
function loadVersion(root, db) {
  const tok = path.join(root, "lib/core/tokens.js");
  const real = require(tok).tokenStore;
  const tap = { last: null };
  const mod = new Module(tok, null); mod.filename = tok; mod.loaded = true;
  mod.exports = { tokenStore: (ttl) => { const s = real(ttl); return { ...s, put: (v) => { tap.last = v; return s.put(v); } }; } };
  const inv = path.join(root, "lib/inventory/index.js");
  // fresh copies of this version's modules: each run gets its own masters cache and the tapped store
  for (const k of Object.keys(require.cache)) if (k.startsWith(path.join(root, "lib") + path.sep)) delete require.cache[k];
  require.cache[tok] = mod;
  const handle = require(inv)(db);
  const call = async (pathname, params) => {
    const u = new URL(`http://localhost${pathname}?${new URLSearchParams({ whId: WH, ...params })}`);
    let out;
    tap.last = null;
    await handle({ method: "GET", headers: {} }, {}, u, (res, code, body) => { out = { code, body }; });
    return { ...out, plan: tap.last };
  };
  const opt = (rel) => { try { return require(path.join(root, rel)); } catch { return null; } };
  return { call, handle, root, mods: { locks: opt("lib/wms/locks.js"), palletCheck: fs.existsSync(path.join(root, "lib/planners/pallet-merge-check.js")) ? opt("lib/planners/pallet-merge-check.js") : null } };
}

const routes = (scope) => [
  ...(scope.relocate === false ? [] : [{ planner: "relocate", path: "/api/inv/relocate", params: { from: scope.cells.join(","), to: scope.cells.join(","), belowPct: "100", useEmpty: "smaller" } }]),
  // the one Consolidate route (planners/combined.js): Empty bins with and without merging first (planners/chain.js).
  // ALL = every pallet cell of the fixture, filled in by runVersion
  // (the old Pallets route is retired: Tidy pallets runs through the one route too)
  { planner: "tidy", path: "/api/inv/consolidate-plan", unified: true, params: { goal: "tidy", from: scope.cells.length ? scope.cells.join(",") : "ALL" } },
  ...[["empty/pos", "0", "positions"], ["empty+merge/pos", "1", "positions"], ["empty/bins", "0", "bins"], ["empty+merge/bins", "1", "bins"]].map(([name, mf, aim]) => ({ planner: name,
    path: "/api/inv/consolidate-plan", unified: true,
    params: { goal: "empty", from: scope.cells.length ? scope.cells.join(",") : "ALL", belowPct: "100", useEmpty: "smaller", mergeFirst: mf, objective: aim } })),
];

// ---- snapshot: run every route of the working tree and of HEAD against PROD, recording each answer -----
async function snapshot() {
  const { makePool, q: realQ } = require(path.join(REPO, "lib/core/db"));
  const cfg = JSON.parse(fs.readFileSync(path.join(REPO, "config/envs.json"), "utf8"))[ENV];
  if (!cfg?.password) throw new Error(`config/envs.json has no password for ${ENV}`);
  // belt and braces on top of the read-only user: every session refuses writes
  const conn = { host: cfg.host, port: cfg.port || 5432, user: cfg.user, password: cfg.password, options: "-c default_transaction_read_only=on" };
  const pools = Object.fromEntries(["wms", "encarta"].map((n) => [n, makePool(conn, cfg.databases?.[n] || n, { statementTimeout: 300000, label: `${ENV}/${n}` })]));
  const rec = new Map();
  // --add: keep the newest fixture's answers (its point in time, so its baseline still holds) and only ask for
  // the queries a planner has started to make since
  const base = flag("--add") ? loadFixture(arg("--fixture") || newestFixture()) : null;
  for (const x of base?.queries || []) rec.set(qkey(x.db, x.sql, x.params), { ...x, rows: unpack(x.rows) });
  const db = facade(async (name, sql, params) => {
    if (!/^\s*(SELECT|WITH)\b/i.test(sql) || /;\s*\S/.test(sql)) throw new Error(`bench refuses non-SELECT SQL: ${norm(sql).slice(0, 60)}`);
    const k = qkey(name, sql, params);
    // one point in time: a query asked twice (each route reloads masters) gets the first answer
    if (!rec.has(k)) {
      const t = Date.now();
      try { rec.set(k, { db: name, sql: norm(sql), params, rows: await realQ(pools[name], sql, params) }); }
      catch (e) { rec.set(k, { db: name, sql: norm(sql), params, err: e.message, rows: [] }); }
      process.stderr.write(`  ${name} ${((Date.now() - t) / 1000).toFixed(1)}s ${rec.get(k).rows.length} rows  ${norm(sql).slice(0, 70)}\n`);
    }
    const r = rec.get(k);
    if (r.err) throw new Error(r.err);
    return r.rows.map((x) => ({ ...x }));
  });
  const versions = [{ label: "working tree", root: REPO }];
  try { versions.push(extractRef("HEAD")); } catch (e) { console.warn(`HEAD not extracted: ${e.message}`); }
  for (const v of versions) {
    const app = loadVersion(v.root, db);
    for (const s of SCOPES) for (const r of routes(s)) {
      const out = await app.call(r.path, r.params).catch((e) => ({ code: "throw", body: { error: e.message } }));
      console.log(`${v.label} ${r.planner} [${s.name}]: ${out.code}${out.code === 200 ? "" : " " + JSON.stringify(out.body).slice(0, 200)}`);
    }
    if (app.mods.locks?.palletLocks) await app.mods.locks.palletLocks(db, WH).catch(() => {});
  }
  await Promise.all(Object.values(pools).map((p) => p.end()));

  let queries = [...rec.values()];
  const date = new Date().toISOString().slice(0, 10);
  const meta = base ? { ...base.meta, added: [...(base.meta.added || []), `${new Date().toISOString()}: ${rec.size - base.queries.length} queries`] }
    : { whId: WH, env: ENV, takenAt: new Date().toISOString(), trimmed: "", scopes: SCOPES };
  const write = () => {
    const file = base ? path.resolve(arg("--fixture") || newestFixture()) : path.join(FIXTURES, `prod-${WH}-${date}.json`);
    fs.mkdirSync(FIXTURES, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ meta, queries: queries.map((x) => ({ ...x, rows: pack(x.rows) })) }));
    return file;
  };
  let file = write(), mb = fs.statSync(file).size / 1e6;
  if (mb > 20) {
    // too big for comfort: drop masters the planners never read (HU codes for new pallets, batch and lot
    // masters for sheet checks; the loader copes with them empty) and keep inventory rows of pallet bins only
    const TRIM = [/^SELECT code FROM handling_unit WHERE/, /FROM batches b JOIN skus/, /FROM production_batches pb/];
    queries = queries.map((x) => (TRIM.some((re) => re.test(x.sql)) ? { ...x, rows: [] } : x));
    const bins = rec.get([...rec.keys()].find((k) => k.includes("FROM storage_bin WHERE")))?.rows || [];
    const types = rec.get([...rec.keys()].find((k) => k.includes("FROM storage_bin_type WHERE") && k.includes("storageHUType")))?.rows || [];
    const palletType = new Set(types.filter((t) => t.storageHUType === "PALLET").map((t) => t.id));
    const palletBin = new Set(bins.filter((b) => palletType.has(b.binTypeId)).map((b) => b.code));
    queries = queries.map((x) => (/FROM inventory/.test(x.sql) && x.rows[0] && "binCode" in x.rows[0] ? { ...x, rows: x.rows.filter((r) => palletBin.has(r.binCode)) } : x));
    meta.trimmed = "fixture was over 20 MB: HU codes, encarta batches and lots, inventory rows of shelf bins";
    file = write(); mb = fs.statSync(file).size / 1e6;
  }
  console.log(`\nSaved ${path.relative(REPO, file)}: ${queries.length} queries, ${mb.toFixed(1)} MB`);
}

// ---- the bench's own replay of a plan's IM rows on the fixture stock ----------------------------------
// Independent of both planners: counts what the upload rows would actually do to the bins.
function replayMetrics(m, rows, held, leaving) {
  const bin = (c) => m.binByCode.get(c);
  const isPal = (c) => bin(c)?.huType === "PALLET";
  const huOf = (c, hu) => (isPal(c) && hu && !String(hu).startsWith("BIN_HU_") ? hu : "");
  // bin -> Map(hu|sku|batch|uom -> qty); pallet bins from palletStock, the rest of a bin's stock loose
  const S = new Map();
  const add = (c, k, n) => { if (!S.has(c)) S.set(c, new Map()); const b = S.get(c); b.set(k, (b.get(k) || 0) + n); };
  for (const [c, ls] of m.occupied) for (const l of ls) add(c, `|${l.skuCode}|${String(l.batch ?? "").trim().toUpperCase()}|${l.uom}`, l.qty);
  for (const [c, hus] of m.palletStock) for (const [hu, ls] of hus) for (const l of ls) { add(c, `${huOf(c, hu)}|${l.sku}|${l.batch}|${l.uom}`, l.qty); add(c, `|${l.sku}|${l.batch}|${l.uom}`, -l.qty); } // BIN_HU_ stock in a pallet bin stays loose
  // stock a pick task is taking out leaves anyway: left out before and after, so only the plan's effect counts
  for (const [k, n] of leaving || []) { const [c, hu, sku, batch, uom] = k.split("|"); add(c, `${huOf(c, hu)}|${sku}|${batch}|${uom}`, -n); }
  const view = (c) => { const hus = new Set(); let any = false, loose = false; for (const [k, n] of S.get(c) || []) if (n > EPS) { any = true; const h = k.split("|")[0]; if (h) hus.add(h); else loose = true; } return { any, hus, loose }; };
  const used = (c, v) => Math.min(Math.max(1, bin(c)?.cap || 1), v.hus.size + (v.loose ? 1 : 0));
  const touched = new Set(), from = new Set(), to = new Set();
  for (const r of rows) { touched.add(r.fromBin); touched.add(r.toBin); from.add(r.fromBin); to.add(r.toBin); }
  const before = new Map([...touched].map((c) => [c, view(c)]));
  let cases = 0, misses = 0, cross = 0, crossArea = 0;
  for (const r of rows) {
    const src = S.get(r.fromBin) || new Map();
    if (r.pickHu) {
      for (const [k, n] of [...src]) if (k.split("|")[0] === r.hu && n > EPS) { src.set(k, 0); add(r.toBin, k, n); cases += n; }
    } else {
      const rest = `${r.sku}|${String(r.batch ?? "").toUpperCase()}|${r.uom}`;
      let k = `${huOf(r.fromBin, r.hu)}|${rest}`;
      if (!((src.get(k) || 0) >= r.qty - EPS)) { misses++; k = [...src.keys()].find((x) => x.endsWith("|" + rest) && src.get(x) >= r.qty - EPS) || k; }
      src.set(k, (src.get(k) || 0) - r.qty);
      add(r.toBin, `${huOf(r.toBin, r.toHu || r.toPallet)}|${rest}`, r.qty);
      cases += r.qty;
    }
    if (bin(r.fromBin)?.zone !== bin(r.toBin)?.zone) cross++;
    if (bin(r.fromBin)?.area !== bin(r.toBin)?.area) crossArea++;
  }
  const after = new Map([...touched].map((c) => [c, view(c)]));
  const emptied = [...from].filter((c) => before.get(c).any && !after.get(c).any);
  const emptyUsed = [...to].filter((c) => !before.get(c).any && after.get(c).any);
  // positions as the contract counts them: every position of a bin emptied, less every position of an empty
  // bin now used, plus the change in positions taken inside pallet bins occupied before and after
  const capOf = (c) => (isPal(c) ? Math.max(1, bin(c)?.cap || 1) : 0);
  let pos = emptied.reduce((t, c) => t + capOf(c), 0) - emptyUsed.reduce((t, c) => t + capOf(c), 0), pallets = 0;
  for (const c of touched) if (isPal(c) && before.get(c).any && after.get(c).any) pos += used(c, before.get(c)) - used(c, after.get(c));
  const husBefore = new Set(), husAfter = new Set();
  for (const c of touched) { before.get(c).hus.forEach((h) => husBefore.add(h)); after.get(c).hus.forEach((h) => husAfter.add(h)); }
  pallets = [...husBefore].filter((h) => !husAfter.has(h)).length;
  return { binsEmptied: emptied.length, emptyBinsUsed: emptyUsed.length, netBinsFreed: emptied.length - emptyUsed.length, positionsFreed: pos,
    palletsFreed: pallets, moves: rows.length, casesMoved: +cases.toFixed(2), crossZoneMoves: cross, crossAreaMoves: crossArea, heldBack: held, misses };
}

const KEYS = ["binsEmptied", "emptyBinsUsed", "netBinsFreed", "positionsFreed", "palletsFreed", "moves", "casesMoved", "crossZoneMoves", "heldBack"];
async function runVersion(v, fx) {
  const db = replayDb(fx);
  const app = loadVersion(v.root, db);
  const t0 = Date.now();
  await app.handle.loadMasters(WH, { refresh: true }); // the masters rebuild each route also does, timed for the reader
  const mastersMs = Date.now() - t0;
  const reps = Math.max(1, Number(arg("--repeat", 2)) || 1);
  let leaving = new Map();
  try { leaving = (await app.mods.locks.palletLocks(db, WH)).leaving || leaving; } catch { /* a changed locks API: no pick adjustment */ }
  const out = [];
  // every pallet cell, for the unified route on the whole-warehouse scope
  const mAll = await app.handle.loadMasters(WH);
  const allCells = [...new Set(mAll.bins.filter((b) => b.huType === "PALLET" && b.areaType === "INVENTORY").map((b) => `${b.zone}|${b.binType}`))].join(",");
  for (const s of SCOPES) for (const r0 of routes(s)) {
    const r = r0.params.from === "ALL" ? { ...r0, params: { ...r0.params, from: allCells } } : r0;
    // fastest of --repeat runs (default 2): the first run of a version pays for JIT warm-up
    let res, ms = Infinity;
    for (let i = 0; i < reps; i++) {
      const t = Date.now();
      res = await app.call(r.path, r.params).catch((e) => ({ code: "throw", body: { error: e.stack } }));
      ms = Math.min(ms, Date.now() - t);
    }
    const row = { version: v.label, planner: r.planner, scope: s.name, ms, code: res.code };
    if (res.code !== 200 || !res.plan) { out.push({ ...row, error: (res.body?.error || "no plan").split("\n")[0] }); continue; }
    const p = res.plan, body = res.body, held = p.imHeld || [];
    const imRows = [...(p.im || []).flatMap((f) => f.rows), ...held];
    const rep = replayMetrics(p.m, imRows, held.length, leaving);
    const contract = body.stats && "heldBack" in body.stats;
    row.stats = contract ? Object.fromEntries(KEYS.map((k) => [k, body.stats[k]])) : rep;
    row.source = contract ? "contract" : "replay";
    row.replay = rep;
    // what the version itself claimed before the contract, to cross-check the replay on old code
    const st = body.stats || {};
    row.legacy = contract ? null : r.planner === "pallets" ? { binsEmptied: (st.binsEmptied || 0) + (p.pack?.stats?.bins || 0), palletsFreed: st.frees }
      : { binsEmptied: st.binsEmptied, emptyBinsUsed: st.emptyBinsUsed, netBinsFreed: st.netFreed, positionsFreed: st.positionsFreed };
    // pallets: an old route ignores from/to, so its "scoped" run is the whole warehouse
    row.note = r.planner === "pallets" && s.cells.length && !body.opts ? "scope ignored (whole wh)" : "";
    const chk = p.check || body.check;
    row.check = chk ? (chk.ok ? "ok" : `FAIL ${String(chk.errs?.[0] || "").slice(0, 60)}`) : app.mods.palletCheck && r.planner === "pallets" ? "check not wired" : "-";
    row.warnings = (body.warnings || []).length;
    if (flag("--out")) {
      const wbs = require(path.join(v.root, "lib/planners/workbooks.js"));
      const dir = arg("--out"); fs.mkdirSync(dir, { recursive: true });
      const buf = await (r.unified ? wbs.combinedWorkbook(p) : wbs.relocateWorkbook(p));
      fs.writeFileSync(path.join(dir, `${v.label.replace(/\W+/g, "_")}-${r.planner}-${s.name.replace(/\W+/g, "_")}.xlsx`), Buffer.from(buf));
    }
    out.push(row);
  }
  if (db.missing.length) console.warn(`${v.label}: ${db.missing.length} queries not in the fixture (re-run --snapshot), e.g. ${db.missing[0]}`);
  return { rows: out, mastersMs };
}

function table(rows, md) {
  const H = ["planner", "scope", "version", "emptied", "emptyUsed", "net", "posFreed", "palFreed", "moves", "cases", "xZone", "held", "check", "ms"];
  const lines = rows.map((r) => r.error ? [r.planner, r.scope, r.version, `ERROR ${r.error.slice(0, 90)}`] : [r.planner, r.scope, r.version,
    ...KEYS.map((k) => `${r.stats[k] ?? "?"}${r.source === "replay" ? "*" : ""}`), r.check, String(r.ms)].map(String).concat(r.note ? [r.note] : []));
  if (md) return [`| ${H.join(" | ")} | note |`, `|${H.map(() => "---").join("|")}|---|`, ...lines.map((l) => `| ${l.join(" | ")} |`)].join("\n");
  const w = H.map((h, i) => Math.max(h.length, ...lines.map((l) => (l.length > 4 || i < 3 ? (l[i] || "").length : 0))));
  const fmt = (l) => l.map((c, i) => (i < H.length ? String(c).padEnd(w[i]) : c)).join("  ");
  return [fmt(H), ...lines.map(fmt)].join("\n");
}

async function bench() {
  const file = arg("--fixture") || newestFixture();
  const fx = loadFixture(file);
  console.log(`Fixture ${path.relative(REPO, file)} (taken ${fx.meta.takenAt}, ${fx.queries.length} queries)`);
  const versions = [];
  if (arg("--baseline")) versions.push(extractRef(arg("--baseline")));
  versions.push({ label: "working tree", root: REPO });
  const all = [];
  // each version in its own process, so neither pays for the other's heap or JIT state in the timings
  for (const v of versions) {
    const pass = ["--repeat", "--out"].flatMap((k) => (arg(k) ? [k, arg(k)] : []));
    const res = spawnSync(process.execPath, [__filename, "--worker", v.root, v.label, "--fixture", file, ...pass], { encoding: "utf8", maxBuffer: 256 << 20 });
    const line = (res.stdout || "").split(/\r?\n/).find((l) => l.startsWith("@@BENCH "));
    process.stderr.write(res.stderr || "");
    if (!line) throw new Error(`${v.label}: worker failed\n${res.stdout}\n${res.stderr}`);
    const r = JSON.parse(line.slice(8));
    console.log(`${v.label}: masters rebuild ${r.mastersMs} ms (included in each ms below)`);
    all.push(...r.rows);
  }
  all.sort((a, b) => a.planner.localeCompare(b.planner) || SCOPES.findIndex((s) => s.name === a.scope) - SCOPES.findIndex((s) => s.name === b.scope));
  console.log("\n" + table(all, flag("--md")));
  console.log("\n* = the version has no contract stats; the bench's replay of its IM rows (files + held back) on the fixture stock.");
  // the replay cross-checks a contract claim: a difference is worth a look (or a bench bug)
  for (const r of all) if (r.source === "contract") {
    const diff = KEYS.filter((k) => k !== "heldBack" && r.replay[k] !== r.stats[k] && !(k === "moves" || k === "casesMoved")).map((k) => `${k} ${r.stats[k]} vs replay ${r.replay[k]}`);
    if (diff.length) console.log(`replay differs: ${r.planner} [${r.scope}] ${r.version}: ${diff.join(", ")}`);
  }
  for (const r of all) if (r.legacy) {
    const diff = Object.entries(r.legacy).filter(([k, v]) => v !== undefined && v !== r.replay[k]).map(([k, v]) => `${k} ${v} vs replay ${r.replay[k]}`);
    if (diff.length) console.log(`replay differs from the planner's own stats: ${r.planner} [${r.scope}] ${r.version}: ${diff.join(", ")}`);
  }
  for (const r of all) if (!r.error && r.replay.misses) console.log(`replay: ${r.replay.misses} IM rows of ${r.planner} [${r.scope}] ${r.version} take stock the source pallet doesn't hold as written`);
  if (flag("--json")) console.log(JSON.stringify(all.map(({ stats, replay, ...x }) => ({ ...x, stats, replay })), null, 1));
}

async function worker() {
  const i = args.indexOf("--worker");
  const r = await runVersion({ root: args[i + 1], label: args[i + 2] }, loadFixture(arg("--fixture")));
  console.log("@@BENCH " + JSON.stringify(r));
}

if (require.main === module) {
  (flag("--snapshot") ? snapshot() : flag("--worker") ? worker() : bench()).catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}
module.exports = { loadFixture, replayDb, fixtureMasters, replayMetrics, SCOPES };
