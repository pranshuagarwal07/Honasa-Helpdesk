// UAT desk server: loads the environment's config, opens the database pools, serves the pages
// in public/ and hands every /api/... request to the feature modules in lib/.
//
// Run:  run.bat       -> SBX_HONASA_UAT  on http://localhost:8765
//       run-prod.bat  -> SBX_HONASA_PROD on http://localhost:8766 (read-only: lookups, sheets, compare; no pushes)
// The environment comes from APP_ENV (default SBX_HONASA_UAT); its connection lives in config/envs.json.
// Layout: public/ pages and assets, lib/ the feature modules, config/ connections, data/ saved templates.
// Needs the StackBox VPN.
const http = require("http");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

// ---- config -----------------------------------------------------------------
const ENV = process.env.APP_ENV || "SBX_HONASA_UAT";
const ENVS_FILE = path.join(__dirname, "config", "envs.json");
const PUBLIC = path.join(__dirname, "public");
const CFG = JSON.parse(fs.readFileSync(ENVS_FILE, "utf8"))[ENV];
const die = (msg) => { console.error(msg); process.exit(1); };
if (!CFG) die(`config/envs.json has no "${ENV}" entry.`);
if (!CFG.password) die(`Add the read-only database password for ${ENV} to config/envs.json ("password"), then start again.`);
// read-only envs (PROD) never push acks: no cincout URL, and /api/push refuses
const READ_ONLY = !!CFG.readOnly || !CFG.cincout;
// only prefills the page — on UAT, NOT 1756300152797421, which is another wh in the same DB
const DEFAULT_WH_ID = CFG.defaultWhId || "";
const DB_HOST = { host: CFG.host, port: CFG.port || 5432, user: CFG.user, password: CFG.password };
const URLS = READ_ONLY ? {} : {
  GRN: CFG.cincout + "/internal/integration/inbound/grn-ack",
  GIN: CFG.cincout + "/internal/integration/outbound/gin-ack",
};
const PORT = Number(process.env.PORT) || CFG.appPort || 8765;
const LABEL = ENV.replace(/^SBX_HONASA_/, ""); // "UAT", "PROD"
const RUN_BAT = ENV === "SBX_HONASA_UAT" ? "run.bat" : `run-${LABEL.toLowerCase()}.bat`;

// an idle connection dropping (VPN reconnect, DB restart) emits "error" on the pool;
// unhandled, that kills the whole server, so log it and let the next query reconnect
const keepAlive = (p, label) => { p.on("error", (e) => console.error(`${label}: idle database connection dropped (${e.message})`)); return p; };
// self-signed internal cert — same default the wms repo uses
const pool = (database) => keepAlive(new Pool({ ...DB_HOST, database, ssl: { rejectUnauthorized: false }, max: 4,
  connectionTimeoutMillis: 10000, statement_timeout: 120000 }), database);
const wms = pool(CFG.databases?.wms || "postgres");
const encarta = pool(CFG.databases?.encarta || "encarta");
const q = async (db, sql, params = []) => (await db.query(sql, params)).rows;
const tryQ = async (db, sql, params) => {
  try { return [await q(db, sql, params), null]; }
  catch (e) { return [[], e.message]; } // column/table differs on this schema version
};

// ---- http -------------------------------------------------------------------
// read per request so page edits show up on refresh without a restart
const RAIL_FOOT = "Pushing an ack writes to the WMS. Building, checking and verifying sheets never do.";
// the sidebar is one file for every page; nav marks the link of a page that has no modes
const page = (file, nav) => {
  // the file's own leading comment is for whoever edits it, not for the page
  let rail = fs.readFileSync(path.join(PUBLIC, "partials", "rail.html"), "utf8").replace(/^<!--[\s\S]*?-->\r?\n/, "").trimEnd();
  if (nav) rail = rail.replace(`data-nav="${nav}"`, `data-nav="${nav}" aria-current="page"`);
  const html = fs.readFileSync(path.join(PUBLIC, file), "utf8").replace("<!--#rail-->", () => rail)
    .replaceAll("__ENV__", ENV).replaceAll("__WH__", DEFAULT_WH_ID)
    .replaceAll("UAT desk", `${LABEL} desk`).replaceAll("run.bat", RUN_BAT);
  return !READ_ONLY ? html : html.replace("<body>", '<body class="read-only">')
    .replace(RAIL_FOOT, `Read-only: this app never writes to ${ENV}. Ack pushes are switched off here.`);
};
// inventory and ops mark their current link themselves, from the #mode in the address
const PAGES = { "/": ["index.html", "acks"], "/inventory": ["inventory.html"], "/compare": ["compare.html", "compare"], "/ops": ["ops.html"] };

// scripts, styles and images under public/. Pages only ever go through page(), never raw.
const ASSET_TYPES = { ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml",
  ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const asset = (pathname) => {
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { return null; }
  const file = path.resolve(PUBLIC, "." + rel);
  if (!file.startsWith(PUBLIC + path.sep) || rel.split("/").some((part) => part.startsWith("."))) return null;
  const type = ASSET_TYPES[path.extname(file).toLowerCase()];
  if (!type || !fs.existsSync(file) || !fs.statSync(file).isFile()) return null;
  return { file, type };
};
const inventory = require("./lib/inventory")({ wms, encarta, q, tryQ });
const masters = require("./lib/masters")({ encarta, q, tryQ, principalOf: inventory.principalOf });

// Compare nodes: any environment listed in config/envs.json, one read-only pool per env + database
const envPools = new Map();
const compare = require("./lib/compare")({
  envsFile: ENVS_FILE,
  connect: (env, which, cfg) => {
    const database = cfg?.databases?.[which];
    if (!database) return async () => { throw new Error(`config/envs.json has no "${which}" database for ${env}.`); };
    const conn = { host: cfg.host, port: cfg.port || 5432, user: cfg.user, password: cfg.password };
    if (!conn.password) return async () => { throw new Error(`Add the read-only database password for ${env} to config/envs.json, then run the comparison again.`); };
    const id = `${env}/${which}`;
    if (!envPools.has(id)) {
      envPools.set(id, keepAlive(new Pool({ ...conn, database,
        ssl: { rejectUnauthorized: false }, max: 4, connectionTimeoutMillis: 10000, statement_timeout: 60000 }), id));
    }
    const p = envPools.get(id);
    return async (sql, params = []) => (await p.query(sql, params)).rows;
  },
});

const acks = require("./lib/acks")({ wms, encarta, q, tryQ, URLS, READ_ONLY, ENV });
const ops = require("./lib/ops")({ wms, encarta, q, tryQ, inventory, masters, compare, ENV });

const send = (res, code, body, type = "application/json") => {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "Content-Type": type });
  res.end(data);
};

// Only this app's own pages may use it. Listening on 127.0.0.1 isn't enough: any web page
// open in the browser can POST to localhost (and could push an ack), and DNS rebinding can
// read through it. So the Host must be this port on localhost, and a cross-site Origin is refused.
const LOCAL = new Set([`localhost:${PORT}`, `127.0.0.1:${PORT}`]);
const fromHere = (req) => LOCAL.has(req.headers.host) &&
  (!req.headers.origin || LOCAL.has(String(req.headers.origin).replace(/^http:\/\//, "")));

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  if (!fromHere(req)) return send(res, 403, { error: "Only pages served by this app can call it." });
  try {
    if (req.method === "GET" && PAGES[u.pathname]) return send(res, 200, page(...PAGES[u.pathname]), "text/html; charset=utf-8");
    const a = req.method === "GET" && !u.pathname.startsWith("/api/") && asset(u.pathname);
    // no-cache: the browser re-checks on every load, so an edit shows up on refresh
    if (a) { res.setHeader("Cache-Control", "no-cache"); return send(res, 200, fs.readFileSync(a.file), a.type); }
    if (await inventory(req, res, u, send)) return;
    if (await masters(req, res, u, send)) return;
    if (await ops(req, res, u, send)) return;
    if (await compare(req, res, u, send)) return;
    if (await acks(req, res, u, send)) return;
    send(res, 404, { error: "not found" });
  } catch (e) {
    send(res, 500, { error: e.message });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`Honasa ${LABEL} desk on http://localhost:${PORT}  (${ENV}${READ_ONLY ? ", read-only" : ""})`));
