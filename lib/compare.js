// Compare nodes — diff every master/config table of two warehouses, which may sit in
// different environments. Read-only: SELECTs only.
//
// Rows are matched by business key, never by id. Every UUID in a row (FK columns and
// ids inside JSON) is swapped for the key of the row it points at on that side, so a
// zone's "areaId" compares as its area code. Environments come from config/envs.json.
const fs = require("fs");
const ExcelJS = require("exceljs");

// ---- what gets compared -------------------------------------------------------
// key: columns that identify a row across warehouses ("a|b" = first one present,
// "*Identifiers" = every column ending that way). Empty key = match on the whole row.
// single: one row per warehouse. by: no whId column, scoped through another table.
const SECTIONS = [
  { id: "layout", name: "Layout", on: true, tables: [
    { t: "storage_area", key: ["code"] },
    { t: "storage_zone", key: ["code"] },
    { t: "storage_bin_type", key: ["code"] },
    { t: "storage_bin", key: ["code"], bins: true },
    { t: "storage_bin_type_best_fit", key: ["binTypeId", "skuId", "uom"] },
    { t: "storage_bin_fixed_sku", key: ["binId", "skuId"] },
    // what putaway reads today: bins reserved for a SKU / product / EAN, and bins blocked per task
    { t: "storage_bin_fixed_mapping", key: ["binId", "mode", "value"] },
    { t: "task_bin_mode_lock", key: ["binId", "taskKind", "taskSubKind", "mode"] },
    { t: "storage_dockdoor", key: ["code"] },
    { t: "storage_bin_dockdoor", key: ["binId", "dockdoorId"] },
    { t: "storage_activity_zone", key: ["code"] },
    { t: "storage_area_sloc", key: ["areaCode|areaId", "quality"] },
    { t: "area_allocation_eligibility", key: ["areaId"] },
    { t: "bin_status_reason_mapping", key: ["status", "reason", "subReason"] },
    { t: "iloc", key: ["code"] },
    { t: "lane", key: ["code"] },
    { t: "lane_mhe_type_mapping", key: ["laneCode|laneId", "mheKind|mheKindId"] },
    { t: "storage_time_config", single: true },
  ] },
  { id: "search", name: "Search and identifiers", on: true, tables: [
    { t: "storage_identifier_definition", key: ["storageType", "identifier"] },
    { t: "storage_search_index", key: ["storageType", "storageCode|storageId", "identifierValues"] },
  ] },
  { id: "hu", name: "Handling units", on: true, tables: [
    { t: "handling_unit_kind", key: ["code"] },
    { t: "storage_kind", key: ["code"] },
    { t: "handling_unit_compatibility_matrix", key: ["outerKindId", "innerKindId"], by: ["outerKindId", "handling_unit_kind"] },
    { t: "handling_unit_storage_compatibility_matrix", key: ["huKindId", "storageKindId"], by: ["huKindId", "handling_unit_kind"] },
    { t: "hu_code_generate_strategy", key: ["prefix"] },
  ] },
  { id: "inbound", name: "Inbound strategies", on: true, tables: [
    { t: "strategy_inb_task_seq", key: ["*Identifiers", "sequence"] },
    { t: "strategy_inb_qc", key: ["*Identifiers", "sequence"] },
    { t: "strategy_putpick_bin_search", key: ["taskType", "priority", "*Identifiers"] },
  ] },
  { id: "outbound", name: "Outbound strategies", on: true, tables: [
    { t: "strategy_ob_task_seq", key: ["*Identifiers", "sequence"] },
    { t: "strategy_ob_line_split", key: ["*Identifiers", "sequence"] },
    { t: "ob_strat", key: ["skuClass", "uom"] },
    { t: "batch_allocation_strategy", key: ["*Identifiers", "sequence"] },
    { t: "strategy_ob_balance_shelf_life", key: ["*Identifiers", "sequence"] },
  ] },
  // one row per task kind / sub-kind / label and identifiers: drop slotting mode, base-SKU
  // interchange, HU kinds, scan rules… — the flags that differ quietly between warehouses
  { id: "tasks", name: "Task strategies", on: true, tables: [
    { t: "task_strategy", key: ["taskKind", "taskSubKind", "taskLabel", "*Identifiers", "sequence"] },
  ] },
  { id: "replen", name: "Replenishment", on: true, tables: [
    { t: "strategy_auto_replen", key: ["*Identifiers", "sequence"] },
    { t: "strategy_advance_replen", key: ["*Identifiers", "sequence"] },
    { t: "strategy_ob_demand_replen", key: ["*Identifiers", "sequence"] },
  ] },
  { id: "process", name: "Process config", on: true, tables: [
    { t: "ob_trip_process_flag", key: ["processFlag", "code"] },
    { t: "ob_session_profile", key: ["name", "priority"] },
    { t: "ob_session_profile_config", key: [] },
    { t: "session_creation_check", key: ["checkName", "sessionKind"] },
    { t: "strategy_vas_task_seq", key: ["*Identifiers", "sequence"] },
    { t: "task_priority", key: ["taskKind", "taskSubkind|taskSubKind"] },
    { t: "task_creation_reason", key: ["kind", "reason", "subReason"] },
    { t: "reason_bucket_mapping", key: ["taskKind", "reason", "bucket"] },
    { t: "reason_code", key: ["reasonCode"] },
    { t: "movement_code", key: ["movementCode"] },
    { t: "print_template", key: ["purpose"] },
    { t: "ep_config", key: ["taskKind", "taskSubKind|taskSubkind"] },
    { t: "auto_approval_threshold_config", key: ["creationMethod", "class", "category", "areaCode"] },
  ] },
  { id: "qc", name: "QC", on: true, tables: [
    { t: "sampling_plan", key: ["minLotSize", "maxLotSize"] },
    { t: "sampling_size", key: [] },
    { t: "qc_material_group", key: ["materialGroup"] },
    { t: "qc_material_group_bucket", key: [] },
    { t: "qc_material_group_sampling", key: [] },
    { t: "qc_material_group_sku", key: [] },
    { t: "material_type_rules_mapping", key: ["materialType"] },
    { t: "sku_material_type_mapping", key: ["skuId|skuCode", "materialType"] },
  ] },
  { id: "yard", name: "Yard and analytics", on: true, tables: [
    { t: "prioritization_profile", key: ["name", "priority"] },
    { t: "dock_scheduling_bucket", key: ["startTime", "endTime", "sessionKind"] },
    { t: "loading_unloading_speed", key: ["vehicleType", "channel", "operation"] },
    { t: "parking_zone", key: ["code"] },
    { t: "parking_slot", key: ["code"] },
    { t: "sku_expiry_threshold_config", key: ["attributeType", "attributeValue"] },
    { t: "sku_expiry_tag_config", key: ["attributeType", "attributeValue", "tagNo"] },
  ] },
  { id: "people", name: "Equipment and workforce", on: false, tables: [
    { t: "mhe_kind", key: ["code"] },
    { t: "mhe", key: ["code"] },
    { t: "mhe_unmapping_reason", key: ["reasonCode"] },
    { t: "mhe_uom_eligibility", key: ["mheCode|mheKindId", "storageType", "storageCodes|storageIds"] },
    { t: "resource_group", key: ["code"] },
    { t: "shift", key: ["code"] },
    { t: "worker", key: ["code"] },
    { t: "worker_role", key: ["workerId", "taskKind", "role"] },
    { t: "wh_optimization_mode", single: true },
  ] },
  { id: "other", name: "Other masters", on: true, tables: [
    { t: "distributor", key: ["code"] },
    { t: "sku", key: ["code"] },
    { t: "warehouse", single: true },
  ] },
  { id: "classes", name: "Class overrides", on: true, encarta: true },
  { id: "settings", name: "Client settings", on: true, backbone: true },
];

// always loaded, because other tables point at their rows
const REF_TABLES = new Set(["storage_area", "storage_zone", "storage_bin_type", "storage_dockdoor", "handling_unit_kind", "storage_kind",
  "mhe_kind", "lane", "worker", "ob_session_profile", "qc_material_group", "sampling_plan"]);
// bookkeeping columns — never compared
const SKIP_COL = /^(id|whId|node_id|nodeId|version|txnId|active|deactivatedAt|deletedAt)$|^(created|updated|deleted|modified|synced|lastSynced|deactivated)(_?(at|by|on|byname|by_name|time))?$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKU_COL = /^sku_?id$/i;
const PRODUCT_BLOCKS = ["wms", "tms", "yms", "oms", "lht", "sfa"]; // merged one level deeper by backbone-core
const LIMIT = { n: 400 }; // differing rows sent to the page per table; the export lifts it
const ORDER = "DAB";

// ---- values ---------------------------------------------------------------------
// object keys are sorted; list order is kept, because it can matter (a task sequence)
const sortDeep = (v) => {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === "object" && !(v instanceof Date)) return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortDeep(v[k])]));
  return v;
};
// loose: "off" and "unset" read the same, "5" equals 5, JSON text equals JSON
const norm = (v) => {
  if (v === null || v === undefined || v === "" || v === false) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v);
  if (typeof v === "string" && /^[[{]/.test(v.trim())) { try { return norm(JSON.parse(v)); } catch { return v; } }
  if (Array.isArray(v)) return v.length ? sortDeep(v) : null;
  if (typeof v === "object") return Object.keys(v).length ? sortDeep(v) : null;
  return v;
};
const strictText = (v) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(sortDeep(v)) : String(v));
const same = (a, b, strict) => (strict ? strictText(a) === strictText(b) : JSON.stringify(norm(a)) === JSON.stringify(norm(b)));
const show = (v) => {
  const n = norm(v);
  if (n === null) return v === false ? "false" : "";
  return typeof n === "object" ? JSON.stringify(n) : String(n);
};
// swap every known UUID (anywhere in the value) for the key of the row it points at
const translate = (v, ids) => {
  if (typeof v === "string" && UUID.test(v)) return ids.get(v.toLowerCase()) ?? `‹id ${v.slice(0, 8)}›`;
  if (Array.isArray(v)) return v.map((x) => translate(x, ids));
  if (v && typeof v === "object" && !(v instanceof Date)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, translate(x, ids)]));
  if (typeof v === "string" && /^[[{]/.test(v.trim())) { try { return translate(JSON.parse(v), ids); } catch { return v; } }
  return v;
};
// row labels: "line {channel: B2C} · storage {} · seq 2"
const brief = (v) => {
  if (Array.isArray(v)) return "[" + v.map(brief).join(", ") + "]";
  if (v && typeof v === "object") return "{" + Object.keys(v).sort().map((k) => `${k}: ${brief(v[k])}`).join(", ") + "}";
  return String(v);
};
const keyPart = (col, v) => {
  if (/Identifiers$/.test(col)) {
    let o = v;
    if (typeof o === "string") { try { o = JSON.parse(o); } catch {} }
    return `${col.replace(/Identifiers$/, "")} ${o && typeof o === "object" ? brief(o) : "{}"}`;
  }
  const t = show(v) || "∅";
  if (col === "sequence") return `seq ${t}`;
  if (col === "priority") return `priority ${t}`;
  return v && typeof v === "object" ? brief(v) : t;
};
const keyCols = (spec, cols) => {
  const out = [];
  for (const k of spec.key || []) {
    if (k.startsWith("*")) out.push(...cols.filter((c) => c.endsWith(k.slice(1))).sort());
    else { const hit = k.split("|").find((c) => cols.includes(c)); if (hit) out.push(hit); }
  }
  return out;
};
const isLive = (r) => r.active !== false && r.deactivatedAt == null && r.deletedAt == null;
const allTables = () => SECTIONS.flatMap((s) => (s.tables || []).map((t) => ({ ...t, section: s.id })));
const newResult = (table, notes = []) => ({ table, same: 0, diff: 0, onlyA: 0, onlyB: 0, rows: [], notes });
const capNote = (res) => {
  const total = res.diff + res.onlyA + res.onlyB;
  if (total > res.rows.length) res.notes.push(`Showing the first ${res.rows.length} of ${total} differences. The Excel export has all of them.`);
  res.rows.sort((x, y) => ORDER.indexOf(x.s) - ORDER.indexOf(y.s) || String(x.key).localeCompare(String(y.key)));
  return res;
};

module.exports = function makeCompare({ connect, envsFile }) {
  // connect(env, dbKey, envConfig) -> async (sql, params) => rows
  const readEnvs = () => { try { return JSON.parse(fs.readFileSync(envsFile, "utf8")); } catch { return {}; } };
  const db = (env, which) => connect(env, which, readEnvs()[env]);
  const tryQ = async (fn, sql, params) => { try { return [await fn(sql, params), null]; } catch (e) { return [[], e.message]; } };

  // ---- one side's WMS tables ------------------------------------------------------
  async function columnsOf(q, names) {
    const rows = await q(`SELECT table_schema, table_name, column_name FROM information_schema.columns
                           WHERE table_name = ANY($1) AND table_schema NOT IN ('pg_catalog', 'information_schema')
                           ORDER BY (table_schema = 'public') DESC, table_schema, table_name, ordinal_position`, [names]);
    const out = {};
    for (const r of rows) {
      const t = (out[r.table_name] ||= { schema: r.table_schema, cols: [] });
      if (t.schema === r.table_schema) t.cols.push(r.column_name);
    }
    return out;
  }

  async function loadSide(env, whId, opts) {
    const q = db(env, "wms");
    const specs = allTables().filter((t) => opts.sections.includes(t.section) || REF_TABLES.has(t.t));
    const meta = await columnsOf(q, specs.map((s) => s.t));
    const data = {};
    const idsOf = async (table) => {
      const m = meta[table];
      if (!m) return [];
      const [rows] = await tryQ(q, `SELECT id::text AS id FROM "${m.schema}"."${table}" WHERE "whId"::text = $1`, [whId]);
      return rows.map((r) => r.id);
    };
    await Promise.all(specs.map(async (s) => {
      const m = meta[s.t];
      if (!m) { data[s.t] = { missing: true }; return; }
      const from = `"${m.schema}"."${s.t}"`;
      let sql, params;
      if (s.by) { sql = `SELECT * FROM ${from} WHERE "${s.by[0]}"::text = ANY($1)`; params = [await idsOf(s.by[1])]; }
      else if (s.t === "warehouse") { sql = `SELECT * FROM ${from} WHERE id::text = $1`; params = [whId]; }
      else if (!m.cols.includes("whId")) { data[s.t] = { missing: true, note: "has no whId column in this environment" }; return; }
      else { sql = `SELECT * FROM ${from} WHERE "whId"::text = $1`; params = [whId]; }
      const [rows, err] = await tryQ(q, sql, params);
      data[s.t] = { raw: rows, cols: m.cols, err };
    }));
    const side = { env, whId, data };
    await keyRows(side);
    return side;
  }

  // key strings for every row, and the id -> key map built from them
  async function keyRows(side) {
    const ids = new Map();
    let skuNum = new Map();
    const build = () => {
      const next = new Map();
      for (const s of allTables()) {
        const d = side.data[s.t];
        if (!d || !d.raw) continue;
        const kc = s.single ? [] : keyCols(s, d.cols);
        d.keyCols = kc;
        d.rows = d.raw.map((r) => {
          const t = {};
          for (const [k, v] of Object.entries(r)) {
            t[k] = k === "id" ? v : SKU_COL.test(k) && skuNum.has(String(v)) ? skuNum.get(String(v)) : translate(v, ids);
          }
          const key = s.single ? "(this warehouse)" : kc.length ? kc.map((c) => keyPart(c, t[c])).join(" · ") : null;
          return { raw: r, t, key, live: isLive(r) };
        });
        for (const r of d.rows) if (r.raw.id && UUID.test(String(r.raw.id))) next.set(String(r.raw.id).toLowerCase(), r.key ?? `${s.t} row`);
      }
      for (const [k, v] of next) ids.set(k, v);
    };
    // three passes resolve references two levels deep (bin -> zone -> area)
    for (let pass = 0; pass < 3; pass++) build();

    // SKU ids point into encarta: look the codes up in this side's environment
    const skuIds = new Set();
    const walk = (v, col) => {
      if (typeof v === "string" && UUID.test(v)) { if (!ids.has(v.toLowerCase())) skuIds.add(v); }
      else if (SKU_COL.test(col || "") && v !== null && v !== undefined && /^\d+$/.test(String(v))) skuIds.add(String(v));
      else if (Array.isArray(v)) v.forEach((x) => walk(x));
      else if (v && typeof v === "object" && !(v instanceof Date)) Object.values(v).forEach((x) => walk(x));
    };
    for (const d of Object.values(side.data)) for (const r of d.raw || []) for (const [k, v] of Object.entries(r)) if (k !== "id") walk(v, k);
    if (skuIds.size) {
      const [skus] = await tryQ(db(side.env, "encarta"), "SELECT id::text AS id, code FROM skus WHERE id::text = ANY($1)", [[...skuIds]]);
      if (skus.length) {
        for (const r of skus) ids.set(r.id.toLowerCase(), r.code);
        skuNum = new Map(skus.map((r) => [r.id, r.code]));
        build(); build();
      }
    }
    side.ids = ids;
  }

  // ---- diff one WMS table ---------------------------------------------------------------
  function diffTable(spec, A, B, opts) {
    const a = A.data[spec.t] || { missing: true }, b = B.data[spec.t] || { missing: true };
    const res = newResult(spec.t);
    if (a.missing && b.missing) return { ...res, skipped: true, notes: ["Table isn't in either environment's schema."] };
    for (const [d, side] of [[a, A], [b, B]]) {
      if (d.missing) res.notes.push(d.note ? `${side.env}: table ${d.note}.` : `Not in ${side.env}'s schema (older WMS version?).`);
      if (d.err) res.notes.push(`${side.env}: ${d.err}`);
    }
    const colsA = a.cols || [], colsB = b.cols || [];
    if (a.cols && b.cols) {
      const oa = colsA.filter((c) => !colsB.includes(c) && !SKIP_COL.test(c)), ob = colsB.filter((c) => !colsA.includes(c) && !SKIP_COL.test(c));
      if (oa.length) res.notes.push(`Columns only in ${A.env}: ${oa.join(", ")} (not compared).`);
      if (ob.length) res.notes.push(`Columns only in ${B.env}: ${ob.join(", ")} (not compared).`);
    }
    const cols = (a.cols && b.cols ? colsA.filter((c) => colsB.includes(c)) : colsA.length ? colsA : colsB).filter((c) => !SKIP_COL.test(c));
    const pick = (d) => (d.rows || []).filter((r) => opts.inactive || r.live);
    const ra = pick(a), rb = pick(b);

    if (spec.bins && !opts.binRows) return binSummary(res, ra, rb);

    const kc = a.keyCols?.length ? a.keyCols : b.keyCols || [];
    const whole = (r) => cols.map((c) => show(r.t[c])).join("\u0001");
    const keyOf = (r) => (spec.single ? "(this warehouse)" : kc.length ? r.key : whole(r));
    const label = (r) => (spec.single ? "(this warehouse)" : kc.length ? r.key
      : cols.filter((c) => show(r.t[c])).slice(0, 4).map((c) => `${c}=${show(r.t[c])}`).join(", ")) + (r.live ? "" : " (deactivated)");
    const fieldsOf = (r) => cols.filter((c) => show(r.t[c]) !== "").map((c) => [c, show(r.t[c])]);
    const push = (row) => { if (res.rows.length < LIMIT.n) res.rows.push(row); };
    const group = (rows) => {
      const m = new Map();
      for (const r of rows) { const k = keyOf(r); if (!m.has(k)) m.set(k, []); m.get(k).push(r); }
      return m;
    };
    const ga = group(ra), gb = group(rb);

    for (const k of new Set([...ga.keys(), ...gb.keys()])) {
      const xa = [...(ga.get(k) || [])];
      let xb = [...(gb.get(k) || [])];
      // duplicate keys: pair identical rows first, then the rest in order
      if (xa.length > 1 || xb.length > 1) {
        const rest = [];
        for (const r of xb) {
          const i = xa.findIndex((x) => whole(x) === whole(r));
          if (i >= 0) { xa.splice(i, 1); res.same++; } else rest.push(r);
        }
        xb = rest;
      }
      for (let i = 0; i < Math.max(xa.length, xb.length); i++) {
        const x = xa[i], y = xb[i];
        if (x && !y) { res.onlyA++; push({ s: "A", key: label(x), fields: fieldsOf(x) }); continue; }
        if (y && !x) { res.onlyB++; push({ s: "B", key: label(y), fields: fieldsOf(y) }); continue; }
        const changed = cols.filter((c) => !kc.includes(c) && !same(x.t[c], y.t[c]));
        if (!changed.length) { res.same++; continue; }
        res.diff++;
        push({ s: "D", key: label(x), fields: changed.map((c) => [c, show(x.t[c]), show(y.t[c])]) });
      }
    }
    return capNote(res);
  }

  // bins: counts by zone × bin type × status, since two sites rarely share bin codes
  function binSummary(res, ra, rb) {
    const count = (rows) => {
      const m = new Map();
      for (const r of rows) {
        const k = [show(r.t.zoneId) || "no zone", show(r.t.binTypeId) || "no bin type", show(r.t.status) || "no status"].join(" · ");
        m.set(k, (m.get(k) || 0) + 1);
      }
      return m;
    };
    const ca = count(ra), cb = count(rb);
    for (const k of new Set([...ca.keys(), ...cb.keys()])) {
      const x = ca.get(k), y = cb.get(k);
      if (x && !y) { res.onlyA++; res.rows.push({ s: "A", key: k, fields: [["bins", String(x)]] }); }
      else if (y && !x) { res.onlyB++; res.rows.push({ s: "B", key: k, fields: [["bins", String(y)]] }); }
      else if (x !== y) { res.diff++; res.rows.push({ s: "D", key: k, fields: [["bins", String(x), String(y)]] }); }
      else res.same++;
    }
    res.summary = true;
    res.notes.push(`Bins are counted by zone · bin type · status (${ra.length} vs ${rb.length} bins). Turn on "Compare bins one by one" for warehouses that share bin codes.`);
    return capNote(res);
  }

  // ---- key/value lists: class overrides and client settings -----------------------------
  function diffPairs(table, la, lb, notes = [], strict = false) {
    const res = newResult(table, notes);
    const val = (r) => (r.v !== undefined ? r.v : r.cls);
    const txt = (v) => (strict ? strictText(v) : show(v));
    const ma = new Map(la.map((r) => [r.key, r])), mb = new Map(lb.map((r) => [r.key, r]));
    const push = (row) => { if (res.rows.length < LIMIT.n) res.rows.push(row); };
    for (const k of new Set([...ma.keys(), ...mb.keys()])) {
      const x = ma.get(k), y = mb.get(k), f = (x || y).field || "value";
      if (x && !y) { res.onlyA++; push({ s: "A", key: k, fields: [[f, txt(val(x))]], src: [x.src] }); }
      else if (y && !x) { res.onlyB++; push({ s: "B", key: k, fields: [[f, txt(val(y))]], src: [undefined, y.src] }); }
      else if (!same(val(x), val(y), strict)) { res.diff++; push({ s: "D", key: k, fields: [[f, txt(val(x)), txt(val(y))]], src: [x.src, y.src] }); }
      else res.same++;
    }
    return capNote(res);
  }

  async function classSide(env, whId) {
    const q = db(env, "encarta");
    const [sku, e1] = await tryQ(q, "SELECT sku_id::text AS id, classifications AS cls FROM node_overrides WHERE node_id::text = $1", [whId]);
    const [prod, e2] = await tryQ(q, "SELECT product_id::text AS id, classifications AS cls FROM product_node_overrides WHERE node_id::text = $1", [whId]);
    const [skus] = sku.length ? await tryQ(q, "SELECT id::text AS id, code FROM skus WHERE id::text = ANY($1)", [sku.map((r) => r.id)]) : [[]];
    const [prods] = prod.length ? await tryQ(q, "SELECT * FROM products WHERE id::text = ANY($1)", [prod.map((r) => r.id)]) : [[]];
    const sc = new Map(skus.map((r) => [r.id, r.code]));
    const pc = new Map(prods.map((r) => [String(r.id), r.code ?? r.name ?? String(r.id)]));
    return {
      sku: sku.map((r) => ({ key: sc.get(r.id) ?? `sku ${r.id}`, cls: r.cls, field: "classifications" })),
      product: prod.map((r) => ({ key: pc.get(r.id) ?? `product ${r.id}`, cls: r.cls, field: "classifications" })),
      errs: [e1, e2].filter(Boolean).map((e) => `${env}: ${e}`),
    };
  }

  // effective settings = each ancestor's override applied root-first, node last; shallow at
  // the top level, one level deeper for product blocks. Schema defaults live only in code.
  async function settingsSide(env, whId) {
    const [layers, err] = await tryQ(db(env, "backbone"), `
      WITH RECURSIVE anc(id, "parentId", depth) AS (
        SELECT id, "parentId", 0 FROM node WHERE id::text = $1
        UNION ALL
        SELECT n.id, n."parentId", a.depth + 1 FROM node n JOIN anc a ON n.id = a."parentId"
         WHERE n.id <> n."parentId" AND a.depth < 15
      )
      SELECT a.depth, n.id::text AS id, n.code, n.name, n."group", s.data
        FROM anc a JOIN node n ON n.id = a.id LEFT JOIN node_settings s ON s."nodeId" = a.id
       ORDER BY a.depth DESC`, [whId]);
    const flat = new Map();
    for (const l of layers) {
      const data = typeof l.data === "string" ? JSON.parse(l.data) : l.data || {};
      const src = l.depth === 0 ? "this node" : `${l.group ? l.group + "/" : ""}${l.code || l.name || l.id}`;
      for (const [k, v] of Object.entries(data)) {
        if (PRODUCT_BLOCKS.includes(k) && v && typeof v === "object" && !Array.isArray(v)) {
          for (const [k2, v2] of Object.entries(v)) flat.set(`${k}.${k2}`, { v: v2, src });
        } else flat.set(k, { v, src });
      }
    }
    return {
      list: [...flat].map(([key, o]) => ({ key, v: o.v, src: o.src, field: "value" })),
      found: layers.some((l) => l.depth === 0), err,
      chain: layers.map((l) => l.code || l.name || l.id),
    };
  }

  // ---- one comparison -------------------------------------------------------------------
  function diffAll(ctx) {
    const { A, B, sa, sb, ca, cb, ta, tb, opts } = ctx;
    const sections = [];
    for (const s of SECTIONS) {
      if (!opts.sections.includes(s.id)) continue;
      let tables;
      if (s.tables) tables = s.tables.map((t) => diffTable(t, sa, sb, opts));
      else if (s.encarta) tables = [diffPairs("SKU class overrides", ca.sku, cb.sku, [...ca.errs, ...cb.errs]), diffPairs("Product class overrides", ca.product, cb.product)];
      else {
        const notes = [ta.err && `${A.env}: ${ta.err}`, tb.err && `${B.env}: ${tb.err}`].filter(Boolean);
        if (!ta.err && !ta.found) notes.push(`${A.env}: node ${A.whId} isn't in backbone.`);
        if (!tb.err && !tb.found) notes.push(`${B.env}: node ${B.whId} isn't in backbone.`);
        const t = diffPairs("Effective settings", ta.list, tb.list, notes, true);
        t.notes.push(`Only values stored in the database are compared; a key left at its schema default shows as not set. Inherited from: A ${ta.chain.join(" › ") || "—"}; B ${tb.chain.join(" › ") || "—"}.`);
        t.settings = true;
        tables = [t];
      }
      const sum = (f) => tables.reduce((n, t) => n + (t[f] || 0), 0);
      sections.push({ id: s.id, name: s.name, same: sum("same"), diff: sum("diff"), onlyA: sum("onlyA"), onlyB: sum("onlyB"), tables });
    }
    return sections;
  }

  const results = new Map(); // token -> comparison, for the export

  async function run(body) {
    const A = { env: String(body.a?.env || ""), whId: String(body.a?.whId || "").trim() };
    const B = { env: String(body.b?.env || ""), whId: String(body.b?.whId || "").trim() };
    const envs = readEnvs();
    for (const [n, s] of [["A", A], ["B", B]]) {
      if (!envs[s.env]) throw new Error(`Node ${n}: environment "${s.env}" isn't in config/envs.json.`);
      if (!/^\d+$/.test(s.whId)) throw new Error(`Node ${n}: the warehouse id needs to be a number.`);
    }
    const known = SECTIONS.map((s) => s.id);
    const picked = Array.isArray(body.sections) ? body.sections.filter((x) => known.includes(x)) : [];
    const opts = { sections: picked.length ? picked : SECTIONS.filter((s) => s.on).map((s) => s.id), inactive: !!body.inactive, binRows: !!body.binRows };
    const want = (id) => opts.sections.includes(id);
    const wantWms = SECTIONS.some((s) => s.tables && want(s.id));
    const started = Date.now();
    const [sa, sb, ca, cb, ta, tb, na, nb] = await Promise.all([
      wantWms ? loadSide(A.env, A.whId, opts) : null, wantWms ? loadSide(B.env, B.whId, opts) : null,
      want("classes") ? classSide(A.env, A.whId) : null, want("classes") ? classSide(B.env, B.whId) : null,
      want("settings") ? settingsSide(A.env, A.whId) : null, want("settings") ? settingsSide(B.env, B.whId) : null,
      nodeName(A.env, A.whId), nodeName(B.env, B.whId),
    ]);
    const ctx = { A, B, sa, sb, ca, cb, ta, tb, opts };
    const token = Math.random().toString(36).slice(2);
    const out = { token, ms: Date.now() - started, a: { ...A, name: na }, b: { ...B, name: nb }, opts, sections: diffAll(ctx) };
    results.set(token, { out, ctx });
    if (results.size > 20) results.delete(results.keys().next().value);
    return out;
  }

  async function nodeName(env, whId) {
    const [rows] = await tryQ(db(env, "backbone"), "SELECT code, name FROM node WHERE id::text = $1", [whId]);
    return rows[0] ? rows[0].name || rows[0].code : null;
  }

  async function warehouses(env) {
    if (!readEnvs()[env]) throw new Error(`Environment "${env}" isn't in config/envs.json.`);
    const [wh, err] = await tryQ(db(env, "wms"), "SELECT id::text AS id FROM warehouse ORDER BY id");
    const ids = wh.map((r) => r.id);
    const [nodes] = ids.length ? await tryQ(db(env, "backbone"), "SELECT id::text AS id, code, name FROM node WHERE id::text = ANY($1)", [ids]) : [[]];
    const nm = new Map(nodes.map((n) => [n.id, n]));
    return { warehouses: ids.map((id) => ({ id, code: nm.get(id)?.code || "", name: nm.get(id)?.name || "" })), err };
  }

  async function exportXlsx(token) {
    const hit = results.get(token);
    if (!hit) return null;
    const { out, ctx } = hit;
    LIMIT.n = Infinity;
    let secs;
    try { secs = diffAll(ctx); } finally { LIMIT.n = 400; }
    const wb = new ExcelJS.Workbook();
    const la = `${out.a.env} ${out.a.name || out.a.whId}`, lb = `${out.b.env} ${out.b.name || out.b.whId}`;
    const FILL = { D: "FFFFE9A8", A: "FFD7E6FF", B: "FFFFDCC8" };
    const WORD = { D: "Different", A: "Only in A", B: "Only in B" };
    const sum = wb.addWorksheet("Summary");
    sum.addRow([`A: ${la} (${out.a.whId})`]);
    sum.addRow([`B: ${lb} (${out.b.whId})`]);
    sum.addRow([]);
    sum.addRow(["Section", "Table", "Same", "Different", "Only in A", "Only in B", "Notes"]).font = { bold: true };
    for (const s of secs) for (const t of s.tables) sum.addRow([s.name, t.table, t.same, t.diff, t.onlyA, t.onlyB, t.notes.join(" ")]);
    sum.columns.forEach((c, i) => (c.width = [24, 40, 8, 10, 10, 10, 90][i]));
    for (const s of secs) {
      const rows = s.tables.flatMap((t) => t.rows.map((r) => ({ t: t.table, ...r })));
      if (!rows.length) continue;
      const ws = wb.addWorksheet(s.name.slice(0, 31));
      ws.addRow(["Table", "Row", "Status", "Field", `A: ${la}`, `B: ${lb}`]).font = { bold: true };
      for (const r of rows) for (const f of r.fields) {
        const vals = r.s === "D" ? [f[1], f[2]] : r.s === "A" ? [f[1], ""] : ["", f[1]];
        ws.addRow([r.t, r.key, WORD[r.s], f[0], ...vals]).getCell(3).fill = { type: "pattern", pattern: "solid", fgColor: { argb: FILL[r.s] } };
      }
      ws.columns.forEach((c, i) => (c.width = [34, 44, 12, 26, 44, 44][i]));
      ws.views = [{ state: "frozen", ySplit: 1 }];
    }
    return { buf: await wb.xlsx.writeBuffer(), name: `compare_${out.a.env}_${out.a.whId}_vs_${out.b.env}_${out.b.whId}.xlsx` };
  }

  const readBody = (req) => new Promise((ok, bad) => {
    let s = "";
    req.on("data", (c) => (s += c));
    req.on("end", () => { try { ok(s ? JSON.parse(s) : {}); } catch (e) { bad(e); } });
    req.on("error", bad);
  });

  async function route(req, res, u, send) {
    if (!u.pathname.startsWith("/api/compare/")) return false;
    const p = u.pathname.slice("/api/compare/".length);
    try {
      if (req.method === "GET" && p === "envs") {
        send(res, 200, { envs: Object.keys(readEnvs()), sections: SECTIONS.map(({ id, name, on }) => ({ id, name, on })) });
      } else if (req.method === "GET" && p === "warehouses") {
        send(res, 200, await warehouses(u.searchParams.get("env")));
      } else if (req.method === "POST" && p === "run") {
        send(res, 200, await run(await readBody(req)));
      } else if (req.method === "GET" && p === "export") {
        const x = await exportXlsx(u.searchParams.get("token"));
        if (!x) send(res, 404, { error: "That comparison has expired. Run it again, then export." });
        else {
          res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": `attachment; filename="${x.name}"` });
          res.end(Buffer.from(x.buf));
        }
      } else send(res, 404, { error: "not found" });
    } catch (e) {
      send(res, 400, { error: e.message });
    }
    return true;
  }
  route.run = run; // the readiness report compares config through this
  return route;
};
