// Append/Reset Inventory: build a fill, check any sheet, verify an upload.
// Port of the appendinv skill's build_fill.py / validate_fill.py, reading master
// data live from the WMS and encarta DBs instead of nine Excel exports.
// The rules and their sources are documented in that skill's SKILL.md.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const ExcelJS = require("exceljs");
const { eachesPlan } = require("./eaches");
const { validatePlan } = require("./eaches-check");
const { relocatePlan } = require("./relocate");
const { validateRelocate } = require("./relocate-check");
const { imFiles, imWorkbook, addImSheets } = require("./im-upload");

const TEMPLATE_COLS = [
  "Bin Code", "HU Code", "HU Kind Code", "Sku Code", "Quantity", "UOM (L0/L2/L3)",
  "Bucket (Good/Damaged)", "Inclusion Status (PRE-GRN/INCLUDED/POST-GIN)",
  "Operation Type (APPEND/RESET)", "Batch Code",
  "Manufacture Date (DD/MM/YYYY)", "Expiry Date (DD/MM/YYYY)",
  "Outer HU", "Outer HU Kind",
];
// header text -> row field; matched on the lowercased header's start
const HEADER_FIELDS = [
  ["bin code", "bin"], ["hu kind code", "hukind"], ["hu code", "hu"], ["sku code", "sku"],
  ["quantity", "qty"], ["uom", "uom"], ["bucket", "bucket"], ["inclusion status", "inclusion"],
  ["operation type", "op"], ["batch code", "batch"], ["manufacture date", "mfg"],
  ["expiry date", "exp"], ["outer hu kind", "outerHuKind"], ["outer hu", "outerHu"], ["iloc", "iloc"],
];
const fieldOf = (h) => (HEADER_FIELDS.find(([p]) => String(h || "").trim().toLowerCase().startsWith(p)) || [])[1];

// search index isn't checked in these working areas — and we never seed stock into them
const EXEMPT_AREAS = new Set(["PICK_AND_DROP", "STAGING", "REJECT"]);
// fill rate by rack level, lowest first; mean ~1 so each zone still lands on target
const LEVEL_BIAS = [1.2, 1.17, 1.05, 0.89, 0.69];
const SESSION_EXEMPT = ["INTERNAL_MOVEMENT_HOLDING", "DWS", "HU_SCAN_EXCEPTION", "OUTBOUND_HOLDING"];
const KNOWN_IDENTIFIERS = new Set(["skuClass", "skuClassType", "uom", "bucket"]);
// what holds a stock line, from the inventory view ($2 = the all-zero task id the WMS uses for "none"):
// PICK = a pick task is taking it out (lockMode PICK); LOCKED = anything else: the HU is locked by a task,
// stock is arriving (PUT), FLOATING, BLOCKED, or a task holds the quant; '' = free
const LOCK_KIND = `CASE WHEN "huLockTaskId" IS NOT NULL AND "huLockTaskId"::text <> $2 THEN 'LOCKED'
  WHEN "quantLockMode" = 'PICK' THEN 'PICK'
  WHEN ("quantLockMode" IS NOT NULL AND "quantLockMode" <> 'NONE') OR ("lockedByTaskId" IS NOT NULL AND "lockedByTaskId"::text <> $2) THEN 'LOCKED'
  ELSE '' END`;
const ZERO_ID = "00000000-0000-0000-0000-000000000000";
// a warehouse's own column layout, saved from "Use my template"
const TEMPLATE_DIR = path.join(__dirname, "..", "data", "templates");

// ---- small helpers ------------------------------------------------------------
const todayKey = () => { const d = new Date(); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const addDays = (key, n) => { const [y, m, d] = key.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const upper = (s) => String(s ?? "").trim().toUpperCase();

// Excel cells arrive as Date (UTC midnight), serial numbers or text
function dayKeyOf(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === "number") return dayKeyOf(new Date(Math.round((v - 25569) * 86400000)));
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? ymd(+m[1], +m[2], +m[3]) : null;
}
const utcDate = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== "object") return v;
  if ("result" in v) return v.result;
  if ("text" in v) return v.text;
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  return String(v);
}

// deterministic RNG so the same seed gives the same sheet
function rngFrom(seed) {
  let a = seed >>> 0;
  const next = () => { a |= 0; a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return { random: next, int: (n) => Math.floor(next() * n), choice: (arr) => arr[Math.floor(next() * arr.length)] };
}

// even stride over a location-sorted list, so empties sit between filled bins
function scatter(list, n) {
  if (n <= 0) return [];
  if (n >= list.length) return [...list];
  const step = list.length / n;
  return Array.from({ length: n }, (_, i) => list[Math.min(list.length - 1, Math.floor(i * step + step / 2))]);
}

// ---- master data, live from the DBs ---------------------------------------------
module.exports = function inventoryModule({ wms, encarta, q, tryQ }) {
  const cache = new Map(); // whId -> { at, m }
  const builds = new Map(); // token -> { whId, rows, headers, prefix, at }
  const checked = new Map(); // token -> { whId, buffer, v, cons, m, name, at } for the annotated download
  const plans = new Map(); // token -> { whId, m, cons, pack, locked, at } for the consolidation plan download
  const eachPlans = new Map(); // token -> { whId, m, plan, check, at } for the eaches plan download
  const relocPlans = new Map(); // token -> { whId, m, plan, check, at } for the "bins under % full" download

  // skuCodes: the SKUs on the sheet in hand, to find the principal of a warehouse with no stock yet
  async function loadMasters(whId, { principalId, refresh, skuCodes } = {}) {
    const hit = cache.get(whId);
    if (hit && !refresh && Date.now() - hit.at < 10 * 60000 && (!principalId || hit.m.principalId === principalId)) return hit.m;

    // newer columns first; an older schema without them still loads
    const withFallback = async (full, basic, params) => { const [rows, err] = await tryQ(wms, full, params); return err ? q(wms, basic, params) : rows; };
    const [areas, zones, binTypes, bins, search, defs, inv, huCodes, kinds, sessions, invSkuIds, [huStock]] = await Promise.all([
      q(wms, 'SELECT id, code, type, active FROM storage_area WHERE "whId" = $1', [whId]),
      q(wms, 'SELECT id, code, "areaId", active FROM storage_zone WHERE "whId" = $1', [whId]),
      withFallback('SELECT id, code, "storageHUType", "palletCapacity", "maxWeightInKG", "maxVolumeInCC", active, "huMultiSku", "huMultiBatch" FROM storage_bin_type WHERE "whId" = $1',
        'SELECT id, code, "storageHUType", "palletCapacity", "maxWeightInKG", "maxVolumeInCC", active FROM storage_bin_type WHERE "whId" = $1', [whId]),
      withFallback('SELECT id, code, "binTypeId", "zoneId", status, "multiSku", "multiBatch", level, "maxSkuCount", "maxSkuBatchCount" FROM storage_bin WHERE "whId" = $1',
        'SELECT id, code, "binTypeId", "zoneId", status, "multiSku", "multiBatch", level FROM storage_bin WHERE "whId" = $1', [whId]),
      q(wms, 'SELECT "storageId", "storageType", "identifierValues", sequence FROM storage_search_index WHERE "whId" = $1 AND active', [whId]),
      q(wms, 'SELECT "storageType", identifier FROM storage_identifier_definition WHERE "whId" = $1 AND active', [whId]),
      q(wms, `SELECT "binCode", "skuCode", upper(trim(batch)) AS batch, uom, sum(qty)::float AS qty FROM inventory
               WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0 GROUP BY 1, 2, 3, 4`, [whId]),
      q(wms, 'SELECT code FROM handling_unit WHERE "whId" = $1', [whId]),
      q(wms, 'SELECT code FROM handling_unit_kind WHERE "whId" = $1 AND active', [whId]),
      q(wms, `SELECT kind, code, state FROM session WHERE "whId" = $1 AND active AND state IN ('PENDING', 'ONGOING')
               AND NOT (kind = ANY($2)) ORDER BY kind, code`, [whId, SESSION_EXEMPT]),
      q(wms, 'SELECT DISTINCT "skuId" FROM inventory WHERE "whId" = $1 AND "deletedAt" IS NULL LIMIT 500', [whId]),
      // stock per pallet, for pallet-level checks, capacity counts and consolidation
      tryQ(wms, `SELECT "binCode", "huCode", "skuCode", upper(trim(batch)) AS batch, uom, sum(qty)::float AS qty FROM inventory
                  WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0 AND "huCode" IS NOT NULL GROUP BY 1, 2, 3, 4, 5`, [whId]),
    ]);

    // encarta has no wh -> principal table (core resolves it), so read it off the SKUs already stocked here
    let principal = principalId;
    const tried = []; // what each fallback found, for the error when none works
    const principalOf = async (rows, what) => {
      const ids = rows.map((r) => String(r.skuId)).filter(Boolean);
      if (!ids.length) { tried.push(`${what}: none`); return undefined; }
      const [p, err] = await tryQ(encarta,
        "SELECT principal_id::text AS id, count(*)::int AS n FROM skus WHERE id::text = ANY($1) GROUP BY 1 ORDER BY 2 DESC LIMIT 1", [ids]);
      tried.push(err ? `${what}: encarta lookup failed (${err})` : p[0] ? `${what}: ${p[0].id}` : `${what}: ${ids.length} sku ids, none in encarta (e.g. ${ids[0]})`);
      return p[0]?.id;
    };
    if (!principal) principal = await principalOf(invSkuIds, "stock");
    // an empty warehouse: try the SKUs on its ASNs, then a single-principal encarta
    if (!principal) {
      const [asnSkus, err] = await tryQ(wms, 'SELECT DISTINCT "skuId" FROM inb_asn_lineitem WHERE "whId" = $1 LIMIT 500', [whId]);
      principal = err ? (tried.push(`ASN lines: ${err}`), undefined) : await principalOf(asnSkus, "ASN lines");
    }
    if (!principal) {
      const [only, err] = await tryQ(encarta, "SELECT principal_id::text AS id FROM skus WHERE principal_id IS NOT NULL GROUP BY 1 LIMIT 2");
      if (only.length === 1) principal = only[0].id;
      else tried.push(err ? `encarta principals: ${err}` : `encarta principals: ${only.length ? "more than one" : "none, the encarta database in config/envs.json has no SKUs at all (wrong host or database for this env?)"}`);
    }
    // a shared encarta (PROD) before go-live: the principal whose SKU master holds these codes —
    // the sheet's, plus the codes stocked here (in case the stock's sku ids don't match encarta's)
    let tied = [];
    const codes = [...new Set([...(skuCodes || []), ...inv.map((r) => r.skuCode)].map(upper).filter(Boolean))].slice(0, 5000);
    if (!principal && codes.length) {
      const [hits, err] = await tryQ(encarta, `SELECT principal_id::text AS id, count(DISTINCT upper(trim(code)))::int AS n FROM skus
                                          WHERE upper(trim(code)) = ANY($1) AND principal_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC LIMIT 5`, [codes]);
      if (hits.length === 1 || (hits.length > 1 && hits[0].n > hits[1].n)) principal = hits[0].id;
      else if (hits.length) tied = hits.map((h) => `${h.id} (${h.n} of ${codes.length} SKUs)`);
      else tried.push(err ? `SKU codes: encarta lookup failed (${err})` : `SKU codes: none of ${codes.length} in encarta (e.g. ${codes.slice(0, 3).join(", ")})`);
    } else if (!principal) tried.push("SKU codes: none to look up");
    if (!principal) throw new Error(tied.length
      ? `The SKUs are in more than one encarta principal: ${tied.join(", ")}. Enter the principal id under Advanced.`
      : `Couldn't work out the encarta principal for this warehouse. Tried: ${tried.join("; ")}. Enter the principal id under Advanced.`);

    const [skus, uoms, batches, prod] = await Promise.all([
      q(encarta, `SELECT s.id::text AS id, s.code, s.active, s.product_id::text AS product_id, s.classifications AS cls, b.code AS base_code
                   FROM skus s LEFT JOIN skus b ON b.id = s.base_sku_id WHERE s.principal_id::text = $1`, [principal]),
      q(encarta, `SELECT u.sku_id::text AS sku_id, u.hierarchy, u.units::float AS units, u.weight::float AS weight, u.volume::float AS volume FROM uoms u
                   JOIN skus s ON s.id = u.sku_id WHERE s.principal_id::text = $1 AND u.active IS NOT FALSE`, [principal]),
      q(encarta, `SELECT b.sku_code, upper(trim(b.code)) AS code, to_char(b.packing_date, 'YYYY-MM-DD') AS mfg,
                   to_char(b.expiry_date, 'YYYY-MM-DD') AS exp, b.active FROM batches b JOIN skus s ON s.id = b.sku_id
                   WHERE s.principal_id::text = $1`, [principal]),
      // every distribution batch mirrors itself into production_batches — those aren't vendor lots
      q(encarta, `SELECT b.sku_code, upper(trim(b.code)) AS parent, upper(trim(pb.code)) AS lot FROM production_batches pb
                   JOIN batches b ON b.id = pb.batch_id JOIN skus s ON s.id = b.sku_id
                   WHERE s.principal_id::text = $1 AND upper(trim(pb.code)) <> upper(trim(b.code))`, [principal]),
    ]);

    // the other class sources; any of them may be missing on an older or newer encarta
    const productIds = `SELECT product_id FROM skus WHERE principal_id::text = $1`;
    const [[products], [nodeOv], [prodNodeOv], [legacySku], [legacyProd]] = await Promise.all([
      tryQ(encarta, `SELECT id::text AS id, product_classifications AS cls FROM products WHERE id IN (${productIds})`, [principal]),
      tryQ(encarta, `SELECT sku_id::text AS sku_id, classifications AS cls FROM node_overrides WHERE node_id::text = $1`, [whId]),
      tryQ(encarta, `SELECT product_id::text AS product_id, classifications AS cls FROM product_node_overrides WHERE node_id::text = $1`, [whId]),
      tryQ(encarta, `SELECT c.sku_id::text AS sku_id, c.type, c.value FROM classifications c JOIN skus s ON s.id = c.sku_id WHERE s.principal_id::text = $1`, [principal]),
      tryQ(encarta, `SELECT pc.product_id::text AS product_id, pc.type, pc.value FROM product_classifications pc WHERE pc.product_id IN (${productIds})`, [principal]),
    ]);

    const m = { whId, principalId: principal, loadedAt: new Date().toISOString(), sessions, warnings: [] };
    m.areaById = new Map(areas.map((a) => [a.id, a]));
    m.zoneById = new Map(zones.map((z) => [z.id, z]));
    m.binTypeById = new Map(binTypes.map((t) => [t.id, t]));
    m.bins = bins.map((b) => {
      const zone = m.zoneById.get(b.zoneId), area = zone && m.areaById.get(zone.areaId), bt = m.binTypeById.get(b.binTypeId);
      return {
        id: b.id, code: b.code, status: b.status, multiSku: b.multiSku, multiBatch: b.multiBatch,
        level: b.level === null || b.level === undefined || b.level === "" ? null : Number(b.level),
        zoneId: b.zoneId, zone: zone?.code, zoneActive: zone?.active !== false,
        areaId: area?.id, area: area?.code, areaType: area?.type, areaActive: area?.active !== false,
        binTypeId: b.binTypeId, binType: bt?.code, huType: bt?.storageHUType, cap: Math.max(1, Number(bt?.palletCapacity) || 1),
        maxKg: Number(bt?.maxWeightInKG) > 0 ? Number(bt.maxWeightInKG) : null,
        volCC: Number(bt?.maxVolumeInCC) > 0 ? Number(bt.maxVolumeInCC) : null, // shelf bins are sized by volume
        // putaway caps on top of multiSku / multiBatch; null = no cap
        maxSku: Number(b.maxSkuCount) > 0 ? Number(b.maxSkuCount) : null,
        maxSkuBatch: Number(b.maxSkuBatchCount) > 0 ? Number(b.maxSkuBatchCount) : null,
        // pallet-level mixing comes from the bin type; the column defaults to true
        huMultiSku: bt?.huMultiSku !== false, huMultiBatch: bt?.huMultiBatch !== false,
      };
    });
    m.binByCode = new Map(m.bins.map((b) => [b.code, b]));
    m.palletStock = new Map(); // binCode -> huCode -> [{sku, batch, uom, qty}], pallet bins only
    for (const r of huStock) {
      if (m.binByCode.get(r.binCode)?.huType !== "PALLET") continue;
      if (!m.palletStock.has(r.binCode)) m.palletStock.set(r.binCode, new Map());
      const hus = m.palletStock.get(r.binCode);
      if (!hus.has(r.huCode)) hus.set(r.huCode, []);
      hus.get(r.huCode).push({ sku: r.skuCode, batch: r.batch, uom: r.uom, qty: r.qty });
    }

    // the class type the search table is keyed on (skuClassType), else WMS's default "ABC"
    const typeVotes = new Map();
    for (const r of search) { const t = r.identifierValues?.skuClassType; if (t) typeVotes.set(upper(t), (typeVotes.get(upper(t)) || 0) + 1); }
    m.classType = [...typeVotes].sort((a, b) => b[1] - a[1])[0]?.[0] || "ABC";

    // search index -> what each zone takes: key class|uom|bucket -> zoneId -> sequence.
    // Putaway (storage search/repository.ts) has AREA and ZONE rows only: a bin qualifies when one
    // row of its area and one of its zone are each within the quant's values and together equal
    // them exactly. So every (area row, zone row) pair of a zone gives the keys that zone takes.
    // Ordering is area sequence, then zone sequence.
    m.search = { ZONE: new Map(), BIN: new Map(), AREA: new Map() };
    const extra = new Set();
    const rowsOf = { AREA: new Map(), ZONE: new Map() };
    for (const r of search) {
      const v = r.identifierValues || {};
      for (const [k, val] of Object.entries(v)) if (!KNOWN_IDENTIFIERS.has(k) && val !== null && val !== "") extra.add(k);
      const map = rowsOf[r.storageType];
      if (!map) continue;
      if (!map.has(String(r.storageId))) map.set(String(r.storageId), []);
      map.get(String(r.storageId)).push({ v, seq: Number(r.sequence) || 0 });
    }
    // identifiers putaway searches with; one this page doesn't fill in takes any value
    const ids = new Set(defs.map((d) => d.identifier));
    const any = { uom: ["L0", "L1", "L2", "L3"], bucket: ["GOOD", "DAMAGED", "BLOCKED", "EXPIRED", "EXCESS", "NEAREXPIRY", "MISSING"] };
    const take = (zoneId, cls, uom, bucket, seq) => {
      const key = `${cls}|${uom}|${bucket}`;
      if (!m.search.ZONE.has(key)) m.search.ZONE.set(key, new Map());
      const cur = m.search.ZONE.get(key).get(zoneId);
      if (cur === undefined || seq < cur) m.search.ZONE.get(key).set(zoneId, seq);
    };
    m.searchClassFree = !ids.has("skuClass"); // zone rules don't look at class at all
    for (const [zoneId, zrows] of rowsOf.ZONE) {
      const areaId = String(m.zoneById.get(zoneId)?.areaId ?? "");
      for (const a of rowsOf.AREA.get(areaId) || []) {
        for (const z of zrows) {
          const merged = { ...a.v, ...z.v };
          if (merged.skuClassType && upper(merged.skuClassType) !== m.classType) continue;
          // the pair must name every identifier putaway uses (else the quant carries a key it lacks)
          if ([...ids].some((k) => KNOWN_IDENTIFIERS.has(k) && k !== "skuClassType" && !(k in merged))) continue;
          const seq = a.seq * 1000 + z.seq;
          const cls = ids.has("skuClass") ? [upper(merged.skuClass)] : ["*"];
          const uoms = ids.has("uom") ? [upper(merged.uom)] : any.uom;
          const buckets = ids.has("bucket") ? [upper(merged.bucket)] : any.bucket;
          for (const c of cls) for (const u of uoms) for (const bk of buckets) take(zoneId, c, u, bk, seq);
        }
      }
    }
    if (extra.size) m.warnings.push(`The search table also uses ${[...extra].join(", ")}. The app only checks class, UOM and bucket, so rows may still be rejected on those.`);
    m.identifiers = defs.map((d) => `${d.storageType}:${d.identifier}`);

    m.occupied = new Map(); // binCode -> [{sku, batch, uom, qty}]
    for (const r of inv) { if (!m.occupied.has(r.binCode)) m.occupied.set(r.binCode, []); m.occupied.get(r.binCode).push(r); }
    m.huCodes = new Set(huCodes.map((r) => r.code));
    m.kinds = kinds.map((k) => k.code);

    // SKUs with their UOM facts
    const uomBy = new Map();
    for (const u of uoms) { if (!uomBy.has(u.sku_id)) uomBy.set(u.sku_id, {}); uomBy.get(u.sku_id)[u.hierarchy] = u; }
    // classifications arrive as {"ABC":"A"} (JSONB today), an array of {type, value} (older), or legacy rows
    const typesSeen = new Set();
    const pickType = (cls) => {
      let v = cls;
      if (typeof v === "string") { try { v = JSON.parse(v); } catch { return undefined; } }
      if (!v) return undefined;
      if (Array.isArray(v)) { v.forEach((e) => e?.type && typesSeen.add(e.type)); return v.find((e) => upper(e?.type) === m.classType)?.value; }
      if (typeof v === "object") { Object.keys(v).forEach((k) => typesSeen.add(k)); const k = Object.keys(v).find((x) => upper(x) === m.classType); return k ? v[k] : undefined; }
      return undefined;
    };
    const fromRows = (rows, idKey) => {
      const out = new Map();
      for (const r of rows) { typesSeen.add(r.type); if (upper(r.type) === m.classType && r.value) out.set(r[idKey], r.value); }
      return out;
    };
    const productCls = new Map(products.map((p) => [p.id, pickType(p.cls)]));
    const nodeCls = new Map(nodeOv.map((o) => [o.sku_id, pickType(o.cls)]));
    const prodNodeCls = new Map(prodNodeOv.map((o) => [o.product_id, pickType(o.cls)]));
    const legacySkuCls = fromRows(legacySku, "sku_id"), legacyProdCls = fromRows(legacyProd, "product_id");
    m.classSources = { warehouse: 0, sku: 0, product: 0 };
    const classOf = (s) => {
      const tries = [["warehouse", nodeCls.get(s.id)], ["warehouse", prodNodeCls.get(s.product_id)],
        ["sku", pickType(s.cls) ?? legacySkuCls.get(s.id)], ["product", productCls.get(s.product_id) ?? legacyProdCls.get(s.product_id)]];
      const hit = tries.find(([, v]) => v !== undefined && v !== null && String(v).trim() !== "");
      if (!hit) return null;
      m.classSources[hit[0]]++;
      return upper(hit[1]);
    };
    const weights = [];
    m.skus = new Map();
    for (const s of skus) {
      const u = uomBy.get(s.id) || {};
      const L2 = u.L2?.units, L3 = u.L3?.units;
      const rec = {
        code: s.code, active: s.active === true, base: !s.base_code || s.base_code === s.code, baseCode: s.base_code || s.code, clazz: classOf(s),
        L0inL2: L2 > 0 ? L2 : null, L2inL3: L2 > 0 && L3 > 0 ? L3 / L2 : null, L0wt: u.L0?.weight > 0 ? u.L0.weight : null,
        // cc per unit of each UOM, for shelf bins (putaway fills them by volume)
        volL0: u.L0?.volume > 0 ? u.L0.volume : null, volL2: u.L2?.volume > 0 ? u.L2.volume : null, volL3: u.L3?.volume > 0 ? u.L3.volume : null,
        // eaches in each UOM and cc per unit, as the WMS bin capacity check reads them
        units: Object.fromEntries(["L0", "L1", "L2", "L3"].map((h) => [h, u[h]?.units > 0 ? u[h].units : h === "L0" ? 1 : null])),
        vols: Object.fromEntries(["L0", "L1", "L2", "L3"].map((h) => [h, u[h]?.volume > 0 ? u[h].volume : null])),
      };
      if (rec.L0wt) weights.push(rec.L0wt);
      m.skus.set(s.code, rec);
    }
    // encarta doesn't say grams or kg; a median above 5 can only be grams for a single each
    weights.sort((a, b) => a - b);
    m.weightUnit = weights.length && weights[Math.floor(weights.length / 2)] > 5 ? "g" : "kg";
    if (m.weightUnit === "g") for (const s of m.skus.values()) if (s.L0wt) s.L0wt /= 1000;
    const classified = [...m.skus.values()].filter((x) => x.clazz).length;
    if (!classified) m.warnings.push(`No SKU has a "${m.classType}" class, so nothing can match the search table. Class types found: ${[...typesSeen].join(", ") || "none"}.`);

    m.batches = new Map(); // sku|code -> batch
    for (const b of batches) m.batches.set(`${b.sku_code}|${b.code}`, b);
    m.prodLots = new Set(prod.map((p) => `${p.sku_code}|${p.lot}`));
    m.prodParents = new Set(prod.map((p) => `${p.sku_code}|${p.parent}`));

    cache.set(whId, { at: Date.now(), m });
    return m;
  }

  // lowest search sequence allowing class+uom+bucket in this bin, or null
  function allowedSeq(m, bin, clazz, uom, bucket) {
    const key = `${m.searchClassFree ? "*" : upper(clazz)}|${upper(uom)}|${upper(bucket)}`;
    const s = m.search.ZONE.get(key)?.get(String(bin.zoneId));
    return s === undefined ? null : s;
  }
  const zoneSeq = (m, zoneBin, clazz, uom, bucket) => allowedSeq(m, zoneBin, clazz, uom, bucket);

  // ---- pallets and best fit ---------------------------------------------------------
  // best fit for a pallet = the SKU's L2inL3 (cases per pallet). A line's share of one
  // pallet: L2 qty / L2inL3, L0 qty / (L0inL2 * L2inL3), L3 = whole pallets. null = can't size.
  function palletShare(m, sku, uom, qty) {
    const s = m.skus.get(sku), bf = s?.L2inL3;
    if (uom === "L3") return Number(qty);
    if (!bf) return null;
    if (uom === "L2") return qty / bf;
    if (uom === "L0") return s.L0inL2 ? qty / (s.L0inL2 * bf) : null;
    return null;
  }
  const isResetSheet = (rows) => { const ops = new Set(rows.map((r) => r.op)); return ops.size === 1 && ops.has("RESET"); };

  // every pallet in a pallet bin once the sheet is in: stock already there (unless RESET
  // replaces that bin) plus the sheet's pallets. key -> {hu, bin, source, lines, rows}
  // leaving: bin|hu|sku|batch|uom -> qty a pick task is taking out; it's left out of the pallet's fill,
  // but its SKU-batch stays on the pallet until then
  function palletsAfter(m, rows, isReset = isResetSheet(rows), leaving = new Map()) {
    const sheetBins = new Set(rows.map((r) => r.bin));
    const out = new Map();
    for (const [bin, hus] of m.palletStock) {
      if (isReset && sheetBins.has(bin)) continue;
      // keyed by bin too: bad data can put one HU code in two bins, and both still take a position
      for (const [hu, lines] of hus) {
        const free = [], gone = [];
        for (const l of lines) {
          const out1 = Math.min(l.qty, leaving.get([bin, hu, l.sku, l.batch, l.uom].join("|")) || 0);
          if (out1 > 0) gone.push({ ...l, qty: out1 });
          if (l.qty - out1 > 1e-9) free.push({ ...l, qty: l.qty - out1 });
        }
        out.set(`E|${hu}|${bin}`, { hu, bin, source: "stock", lines: free, gone, leaving: gone.length > 0, rows: [] });
      }
    }
    for (const r of rows) {
      if (!r.hu || m.binByCode.get(r.bin)?.huType !== "PALLET") continue;
      const k = `S|${r.hu}|${r.bin}`;
      if (!out.has(k)) out.set(k, { hu: r.hu, bin: r.bin, source: "sheet", lines: [], rows: [] });
      out.get(k).lines.push({ sku: r.sku, batch: upper(r.batch), uom: r.uom, qty: Number(r.qty) || 0 });
      out.get(k).rows.push(r.row);
    }
    for (const p of out.values()) {
      const shares = p.lines.map((l) => palletShare(m, l.sku, l.uom, l.qty));
      p.share = shares.some((s) => s === null) ? null : shares.reduce((t, s) => t + s, 0);
      p.skus = new Set(p.lines.map((l) => l.sku));
      p.keys = new Set([...p.lines, ...(p.gone || [])].map((l) => `${l.sku}|${l.batch}`));
    }
    return out;
  }
  const casesText = (m, p) => p.lines.map((l) => `${fmtN(l.qty)} ${l.uom} of ${l.sku}${l.batch ? ` (${l.batch})` : ""}`).join(" + ");
  const fmtN = (n) => Number(n.toFixed(2)).toLocaleString("en-IN");
  const pct = (x) => `${Math.round(x * 100)}%`;

  function snapshot(m) {
    const byArea = new Map();
    for (const b of m.bins) {
      const k = b.area || "(no area)";
      if (!byArea.has(k)) byArea.set(k, { area: k, type: b.areaType || "", bins: 0, active: 0, occupied: 0, zones: new Set() });
      const a = byArea.get(k);
      a.bins++; if (b.status === "ACTIVE") a.active++; if (m.occupied.has(b.code)) a.occupied++; if (b.zone) a.zones.add(b.zone);
    }
    const skus = [...m.skus.values()];
    return {
      whId: m.whId, principalId: m.principalId, loadedAt: m.loadedAt, weightUnit: m.weightUnit,
      areas: [...byArea.values()].map((a) => ({ ...a, zones: a.zones.size })).sort((x, y) => x.type.localeCompare(y.type) || x.area.localeCompare(y.area)),
      skus: { total: skus.length, active: skus.filter((s) => s.active).length, classified: skus.filter((s) => s.active && s.clazz).length },
      batches: m.batches.size, huCodes: m.huCodes.size, kinds: m.kinds, sessions: m.sessions, warnings: m.warnings,
      classType: m.classType, classSources: m.classSources,
      suggestedPrefix: suggestPrefix(m),
    };
  }

  // a short prefix no HU in this warehouse starts with, e.g. F2909A
  function suggestPrefix(m) {
    const d = new Date(), base = `F${String(d.getDate()).padStart(2, "0")}${String(d.getMonth() + 1).padStart(2, "0")}`;
    const codes = [...m.huCodes];
    for (const c of "ABCDEFGHJKLMNPQRSTUVWXYZ") if (!codes.some((h) => h.startsWith(base + c))) return base + c;
    return base + crypto.randomBytes(2).toString("hex").toUpperCase();
  }

  // ---- build a fill --------------------------------------------------------------
  function build(m, o) {
    const rng = rngFrom(Number(o.seed) || 20260916);
    const today = todayKey(), minExp = addDays(today, Number(o.shelfLifeDays) || 0);
    const bucket = o.bucket || "Good";
    const areaTypes = new Set(o.areaTypes?.length ? o.areaTypes : ["INVENTORY"]);
    const include = o.skuInclude ? new RegExp(o.skuInclude) : null;
    const exclude = o.skuExclude ? new RegExp(o.skuExclude) : null;
    const skipped = { skus: {}, zones: [] };
    const skipSku = (why, code) => { (skipped.skus[why] ||= []).push(code); };

    // usable SKUs and their batches
    const batchesBySku = new Map();
    for (const b of m.batches.values()) {
      const k = `${b.sku_code}|${b.code}`;
      if (b.active !== true || !b.exp || !b.mfg || b.exp <= minExp || b.mfg > today || m.prodLots.has(k)) continue;
      if (!batchesBySku.has(b.sku_code)) batchesBySku.set(b.sku_code, []);
      batchesBySku.get(b.sku_code).push({ ...b, hasProd: m.prodParents.has(k) });
    }
    for (const [s, list] of batchesBySku) {
      list.sort((a, b) => (b.hasProd - a.hasProd) || a.exp.localeCompare(b.exp));
      const withProd = list.filter((b) => b.hasProd);
      batchesBySku.set(s, (withProd.length ? withProd : list).slice(0, Number(o.maxBatchesPerSku) || 6));
    }
    const known = [];
    for (const s of m.skus.values()) {
      if (!s.active) continue;
      if (include && !include.test(s.code)) continue;
      if (exclude && exclude.test(s.code)) continue;
      if (!s.clazz) { skipSku(`No ${m.classType} class`, s.code); continue; }
      if (!batchesBySku.has(s.code)) { skipSku(`No active batch with over ${o.shelfLifeDays} days shelf life`, s.code); continue; }
      known.push(s);
    }
    let poolL2 = known.filter((s) => !s.base && s.L2inL3 >= 1), poolL0 = known.filter((s) => s.base && s.L0inL2 > 0);
    if (!poolL2.length) poolL2 = known.filter((s) => s.L2inL3 >= 1); // node without a base-SKU split
    if (!poolL0.length) poolL0 = known.filter((s) => s.L0inL2 > 0);

    // target bins, grouped by zone
    const zones = new Map();
    for (const b of m.bins) {
      if (!areaTypes.has(b.areaType) || b.status !== "ACTIVE" || !b.zoneActive || !b.areaActive) continue;
      const k = `${b.zone}|${b.huType}`;
      if (!zones.has(k)) zones.set(k, []);
      zones.get(k).push(b);
    }
    const target = Math.max(0, Math.min(1, Number(o.target)));
    const plan = [], summary = [];
    for (const [, zb] of [...zones].sort((a, b) => a[0].localeCompare(b[0]))) {
      const z = zb[0], huType = z.huType, uom = huType === "PALLET" ? "L2" : huType === "BIN" ? "L0" : null;
      const occ = zb.filter((b) => m.occupied.has(b.code)).length;
      const base = { zone: z.zone, area: z.area, huType, uom, bins: zb.length, occupiedNow: occ };
      if (!uom) { skipped.zones.push({ ...base, why: `Bin type holds ${huType || "unknown"} units, which fills don't cover` }); continue; }
      const classes = [...new Set((uom === "L2" ? poolL2 : poolL0).map((s) => s.clazz))];
      if (!classes.some((c) => zoneSeq(m, z, c, uom, bucket) !== null)) {
        skipped.zones.push({ ...base, why: `The search table allows no ${uom} ${bucket} stock of any usable class here` }); continue;
      }
      const want = Math.max(0, Math.round(zb.length * target) - occ);
      const free = zb.filter((b) => !m.occupied.has(b.code)).sort((a, b) => a.code.localeCompare(b.code));
      const levels = [...new Set(free.map((b) => b.level).filter((l) => l !== null))].sort((a, b) => a - b);
      let chosen;
      if (levels.length > 1) {
        const tiers = levels.map((lv, i) => ({ bins: free.filter((b) => b.level === lv), bias: LEVEL_BIAS[Math.min(i, LEVEL_BIAS.length - 1)] }));
        const raw = tiers.reduce((t, x) => t + x.bins.length * x.bias, 0);
        const k = raw ? want / raw : 0;
        chosen = new Set(tiers.flatMap((t) => scatter(t.bins, Math.round(t.bins.length * t.bias * k))));
        if (chosen.size < want) scatter(free.filter((b) => !chosen.has(b)), want - chosen.size).forEach((b) => chosen.add(b));
        chosen = [...chosen].sort((a, b) => a.code.localeCompare(b.code)).slice(0, want);
      } else {
        chosen = scatter(free, want);
      }
      chosen.forEach((b) => plan.push({ bin: b, zone: z, uom }));
      summary.push({ ...base, newBins: chosen.length, finalBins: occ + chosen.length,
        nowPct: +(occ / zb.length * 100).toFixed(1), finalPct: +((occ + chosen.length) / zb.length * 100).toFixed(1) });
    }

    // class weights follow the node's own search sequence, so seq-1 classes dominate
    const cursor = new Map(), bcursor = new Map();
    function nextSku(zBin, uom, pool) {
      const seqs = [...new Set(pool.map((s) => s.clazz))].map((c) => [c, zoneSeq(m, zBin, c, uom, bucket)]).filter(([, s]) => s !== null);
      if (!seqs.length) return null;
      const best = Math.min(...seqs.map(([, s]) => s));
      const opts = seqs.map(([c, s]) => [c, s === best ? 8 : s === best + 1 ? 3 : 1, pool.filter((p) => p.clazz === c).map((p) => p.code).sort()])
        .filter(([, , members]) => members.length);
      if (!opts.length) return null;
      let r = rng.random() * opts.reduce((t, [, w]) => t + w, 0);
      const pick = opts.find(([, w]) => (r -= w) <= 0) || opts[opts.length - 1];
      const k = `${zBin.zone}|${uom}|${pick[0]}`;
      const i = cursor.has(k) ? cursor.get(k) : rng.int(pick[2].length);
      cursor.set(k, i + 1);
      return pick[2][i % pick[2].length];
    }
    function nextBatch(s) {
      const list = batchesBySku.get(s);
      const i = bcursor.has(s) ? bcursor.get(s) : rng.int(list.length);
      bcursor.set(s, i + 1);
      return list[i % list.length];
    }

    const common = { bucket, inclusion: o.inclusion || "INCLUDED", op: o.op === "RESET" ? "RESET" : "APPEND" };
    const rows = [];
    let huN = 0;
    // pallet code = prefix + counter, zero-padded so the whole code is huLength long
    const huDigits = Math.max(1, (Number(o.huLength) || o.huPrefix.length + 5) - o.huPrefix.length);
    const byZone = new Map();
    for (const p of plan) { if (!byZone.has(p.zone.zone + p.uom)) byZone.set(p.zone.zone + p.uom, []); byZone.get(p.zone.zone + p.uom).push(p); }
    for (const items of byZone.values()) {
      const { zone, uom } = items[0];
      if (uom === "L2") {
        for (let i = 0; i < items.length;) {
          const s = nextSku(zone, "L2", poolL2);
          if (!s) break;
          const b = nextBatch(s), full = Math.floor(m.skus.get(s).L2inL3);
          const run = Math.min(rng.choice([1, 1, 2, 2, 3]), items.length - i); // a reserve SKU spans a few bins
          for (let r = 0; r < run; r++, i++) {
            const bin = items[i].bin, n = bin.cap < 2 || rng.random() > 0.25 ? bin.cap : bin.cap - 1;
            for (let pn = 0; pn < n; pn++) {
              let qty = full;
              if (pn === n - 1 && rng.random() < 0.3) qty = Math.max(1, Math.floor(full * (0.4 + rng.random() * 0.5)));
              huN++;
              rows.push({ ...common, bin: bin.code, hu: `${o.huPrefix}${String(huN).padStart(huDigits, "0")}`, hukind: o.huKind, sku: s, qty, uom: "L2", batch: b.code, mfg: b.mfg, exp: b.exp });
            }
          }
        }
      } else {
        for (const { bin } of items) {
          const s = nextSku(zone, "L0", poolL0);
          if (!s) continue;
          const b = nextBatch(s), sk = m.skus.get(s);
          let qty = Math.floor(sk.L0inL2) * rng.choice([1, 1, 2, 2, 3]);
          if (sk.L0wt && sk.L0wt > 0.02) qty = Math.min(qty, Math.floor((bin.maxKg || Number(o.maxKgPerBin) || 35) / sk.L0wt));
          qty = Math.max(5, Math.min(qty, Number(o.maxEachesPerBin) || 600));
          rows.push({ ...common, bin: bin.code, hu: "", hukind: "", sku: s, qty, uom: "L0", batch: b.code, mfg: b.mfg, exp: b.exp });
        }
      }
    }
    rows.forEach((r, i) => { r.row = i + 2; });

    const totals = {
      rows: rows.length, bins: new Set(rows.map((r) => r.bin)).size, skus: new Set(rows.map((r) => r.sku)).size,
      batches: new Set(rows.map((r) => `${r.sku}|${r.batch}`)).size, newHUs: rows.filter((r) => r.hu).length,
      poolL2: poolL2.length, poolL0: poolL0.length,
    };
    const hus = rows.filter((r) => r.hu);
    const huCodes = hus.length ? { length: o.huPrefix.length + huDigits, digits: huDigits, first: hus[0].hu, last: hus[hus.length - 1].hu,
      overflow: huN > 10 ** huDigits - 1 } : null;
    return { rows, huCodes, summary, skipped: { zones: skipped.zones, skus: Object.entries(skipped.skus).map(([why, codes]) => ({ why, count: codes.length, sample: codes.slice(0, 12) })) }, totals };
  }

  // ---- checks: every rule, every row, not fail-fast --------------------------------
  // test cases set up odd stock on purpose (expired, short-dated, on top of existing
  // stock), so there those checks warn instead of blocking; upload rejections still block
  const WARN_IN_TESTCASE = new Set(["2c", "2d", "6a", "8c"]);
  const FIELD_OF_CHECK = { "1a": "batch", "1b": "batch", "1c": "batch", "1d": "batch", "2a": "batch", "2b": "batch", "2c": "exp", "2d": "exp",
    "2e": "mfg", "2f": "exp", "2g": "batch", "3a": "sku", "4a": "sku", "5a": "bin", "5b": "bin", "5c": "hu", "5d": "hu", "5e": "hukind",
    "5f": "hu", "5g": "hu", "5h": "hu", "6a": "bin", "6b": "sku", "6c": "batch", "7a": "op", "7b": "qty", "7c": "uom", "7d": "bucket",
    "7e": "inclusion", "7f": "row", "8a": "sku", "8b": "sku", "8c": "uom",
    "6d": "sku", "6e": "batch", "6f": "sku", "6g": "batch", "9a": "qty", "9b": "sku", "7i": "op" };

  function validate(m, rows, { headers, sheetNames, shelfLifeDays = 180, mode, skip = new Set() } = {}) {
    const out = [], rowIssues = {};
    const today = todayKey(), minExp = addDays(today, Number(shelfLifeDays) || 0);
    const add = (id, title, bad, extra = {}) => {
      if (skip.has(id)) return;
      const rowsBad = [...new Set(bad.map((r) => r.row ?? r))].sort((a, b) => a - b);
      // soft = works, but against best practice (yellow); everything else blocks (red)
      const level = extra.soft || (mode === "testcase" && WARN_IN_TESTCASE.has(id)) ? "warn" : "fail";
      out.push({ id, title, level, status: rowsBad.length || extra.fail ? level : "pass", count: rowsBad.length, rows: rowsBad.slice(0, 25), detail: extra.detail || "" });
      for (const n of rowsBad) (rowIssues[n] ||= []).push({ id, title, field: FIELD_OF_CHECK[id] || "row", level });
    };
    const info = (id, title, detail) => { if (!skip.has(id)) out.push({ id, title, level: "info", status: "info", detail, count: 0, rows: [] }); };
    const key = (r) => `${r.sku}|${upper(r.batch)}`;
    const binOf = (r) => m.binByCode.get(r.bin);
    const skuOf = (r) => m.skus.get(r.sku);

    // 1 distribution batch vs vendor lot
    add("1a", "Batch code is in the distribution batch master for that SKU", rows.filter((r) => !m.batches.has(key(r))));
    add("1b", "That batch is active", rows.filter((r) => m.batches.has(key(r)) && m.batches.get(key(r)).active !== true));
    add("1c", "No row uses a vendor (production) lot as the batch code", rows.filter((r) => m.prodLots.has(key(r)) && !m.batches.has(key(r))));
    add("1d", "No batch code is ambiguous (valid in both batch masters)", rows.filter((r) => m.prodLots.has(key(r)) && m.batches.has(key(r))));
    info("1e", "Rows whose batch also has a production batch", `${rows.filter((r) => m.prodParents.has(key(r))).length} of ${rows.length}`);

    // 2 dates
    const withBatch = rows.filter((r) => m.batches.has(key(r)));
    add("2a", "Manufacture date matches the batch master", withBatch.filter((r) => r.mfg !== m.batches.get(key(r)).mfg), { detail: "Copy dates from the master verbatim, or the upload rewrites the batch." });
    add("2b", "Expiry date matches the batch master", withBatch.filter((r) => r.exp !== m.batches.get(key(r)).exp));
    add("2c", "No expired batch", rows.filter((r) => !r.exp || r.exp <= today));
    // soft: real opening stock has short-dated batches that still have to go in; expired (2c) stays hard
    add("2d", `Over ${shelfLifeDays} days of shelf life left`, rows.filter((r) => r.exp && r.exp > today && r.exp <= minExp), { soft: true,
      detail: rows.some((r) => r.exp) ? `Shortest: ${Math.min(...rows.filter((r) => r.exp).map((r) => daysBetween(today, r.exp)))} days` : "" });
    add("2e", "Manufacture date isn't in the future", rows.filter((r) => r.mfg && r.mfg > today));
    add("2f", "Expiry is after manufacture", rows.filter((r) => r.mfg && r.exp && r.exp <= r.mfg));
    const dates = new Map();
    rows.forEach((r) => { const k = key(r); if (!dates.has(k)) dates.set(k, new Set()); dates.get(k).add(`${r.mfg}|${r.exp}`); });
    add("2g", "One manufacture/expiry date per SKU and batch", rows.filter((r) => dates.get(key(r)).size > 1));

    // 3 ABC class — per SKU, never inferred from a sibling
    add("3a", `Every SKU has a ${m.classType} class`, rows.filter((r) => !skuOf(r)?.clazz));

    // 4 search table
    add("4a", "The search table allows each row's class, UOM and bucket in its bin",
      rows.filter((r) => { const b = binOf(r), s = skuOf(r); return b && s?.clazz && !EXEMPT_AREAS.has(b.areaType) && allowedSeq(m, b, s.clazz, r.uom, r.bucket) === null; }),
      { detail: m.warnings.find((w) => w.startsWith("The search table")) || "" });

    // 5 bins and HUs
    add("5a", "Every bin code exists", rows.filter((r) => !binOf(r)));
    add("5b", "Every target bin is active", rows.filter((r) => binOf(r) && binOf(r).status !== "ACTIVE"));
    add("5c", "HU code is blank on BIN-type bins", rows.filter((r) => binOf(r)?.huType === "BIN" && r.hu));
    add("5d", "Pallet bins have an HU code with a kind containing PALLET", rows.filter((r) => binOf(r)?.huType === "PALLET" && (!r.hu || !upper(r.hukind).includes("PALLET"))));
    add("5e", "HU kind code exists in this warehouse", rows.filter((r) => r.hukind && !m.kinds.includes(r.hukind)));
    const huBins = new Map();
    rows.filter((r) => r.hu).forEach((r) => { if (!huBins.has(r.hu)) huBins.set(r.hu, new Set()); huBins.get(r.hu).add(r.bin); });
    add("5g", "Each HU code sits in one bin", rows.filter((r) => r.hu && huBins.get(r.hu).size > 1));
    add("5h", "New HU codes don't already exist in the warehouse", rows.filter((r) => r.hu && m.huCodes.has(r.hu)),
      { detail: "Existing codes are burned. Use a new HU prefix." });
    const huLens = new Map();
    for (const h of new Set(rows.map((r) => r.hu).filter(Boolean))) huLens.set(h.length, (huLens.get(h.length) || 0) + 1);
    if (huLens.size) info("5i", "Pallet HU code length", [...huLens].sort((a, b) => a[0] - b[0])
      .map(([len, n]) => `${len} characters${huLens.size > 1 ? ` (${n} code${n > 1 ? "s" : ""})` : ""}`).join(", "));

    // 6 occupancy and multi-SKU / multi-batch, counted after the update
    const ops = new Set(rows.map((r) => r.op));
    const isReset = ops.size === 1 && ops.has("RESET");
    const occupiedRows = rows.filter((r) => m.occupied.has(r.bin));
    if (isReset) info("6a", "Bins that already hold stock", `${new Set(occupiedRows.map((r) => r.bin)).size} bins will be emptied and replaced by RESET`);
    // soft: topping up occupied bins is normal when no bin is free; the hard clashes are 6b-6g and 5f
    else add("6a", "Rows going into bins that already hold stock", occupiedRows, { soft: true,
      detail: `${new Set(occupiedRows.map((r) => r.bin)).size} bins. APPEND adds to what's there, so make sure these rows aren't stock that's already in the system, or it doubles.` });
    // the upload itself enforces none of 6b-6g; putaway and drops do, so a breach here
    // uploads fine and then blocks every later drop into that bin or pallet
    const after = new Map(), sheetOnly = new Map();
    const note = (map, bin, sku, batch) => { if (!map.has(bin)) map.set(bin, { skus: new Set(), batches: new Set() }); map.get(bin).skus.add(sku); map.get(bin).batches.add(`${sku}|${batch}`); };
    const rowBins = new Set(rows.map((r) => r.bin));
    if (!isReset) for (const bin of rowBins) (m.occupied.get(bin) || []).forEach((x) => note(after, bin, x.skuCode, upper(x.batch)));
    rows.forEach((r) => { note(after, r.bin, r.sku, upper(r.batch)); note(sheetOnly, r.bin, r.sku, upper(r.batch)); });
    // "Bin: A, B" for the first few offending bins; * marks what's already in the bin
    const binExamples = (bad, list) => {
      const bins = [...new Set(bad.map((r) => r.bin))];
      const fromStock = bins.filter((b) => list(sheetOnly.get(b)).length < list(after.get(b)).length).length;
      const ex = bins.slice(0, 4).map((b) => `${b}: ${list(after.get(b)).map((x) => list(sheetOnly.get(b)).includes(x) ? x : x + "*").join(", ")}`);
      return `${bins.length} bin${bins.length === 1 ? "" : "s"}${fromStock ? `, ${fromStock} because of stock already in the bin (marked *)` : ""}. ${ex.join(" · ")}${bins.length > 4 ? " · …" : ""}`;
    };
    const skuList = (x) => [...(x?.skus || [])];
    const batchList = (x) => [...(x?.batches || [])].map((k) => k.replace("|", " "));
    // a case SKU and its base SKU are two SKUs to putaway (it compares sku ids)
    const bad6b = rows.filter((r) => binOf(r) && binOf(r).multiSku === false && after.get(r.bin).skus.size > 1);
    add("6b", "One SKU per bin where the bin isn't multi-SKU (counting stock already in it)", bad6b,
      { detail: bad6b.length ? binExamples(bad6b, skuList) : "A case SKU and its base SKU count as two SKUs." });
    // multi-batch is about batches of one SKU; a case SKU and its base SKU on the same batch code are two SKUs, not two batches
    const batchesOfSku = (bin, sku) => [...after.get(bin).batches].filter((k) => k.startsWith(sku + "|")).length;
    const bad6c = rows.filter((r) => binOf(r) && binOf(r).multiBatch === false && batchesOfSku(r.bin, r.sku) > 1);
    add("6c", "One batch per SKU where the bin isn't multi-batch (counting stock already in it)", bad6c,
      { detail: bad6c.length ? binExamples(bad6c, batchList) : "" });
    const bad6d = rows.filter((r) => binOf(r)?.maxSku && after.get(r.bin).skus.size > binOf(r).maxSku);
    add("6d", "SKUs per bin within the bin's max SKU count", bad6d,
      { detail: bad6d.length ? binExamples(bad6d, skuList) : m.bins.some((b) => b.maxSku) ? "" : "No bin here sets a max SKU count." });
    const bad6e = rows.filter((r) => binOf(r)?.maxSkuBatch && after.get(r.bin).batches.size > binOf(r).maxSkuBatch);
    add("6e", "SKU-batches per bin within the bin's max SKU-batch count", bad6e,
      { detail: bad6e.length ? binExamples(bad6e, batchList) : m.bins.some((b) => b.maxSkuBatch) ? "" : "No bin here sets a max SKU-batch count." });

    // pallets: what each bin holds once the sheet is in
    const pallets = palletsAfter(m, rows, isReset);
    const palletsInBin = new Map();
    for (const p of pallets.values()) palletsInBin.set(p.bin, (palletsInBin.get(p.bin) || 0) + 1);
    const over5f = rows.filter((r) => r.hu && binOf(r)?.huType === "PALLET" && palletsInBin.get(r.bin) > binOf(r).cap);
    add("5f", "Pallets per bin within the bin type's capacity (counting pallets already there)", over5f, {
      detail: over5f.length ? [...new Set(over5f.map((r) => r.bin))].slice(0, 5)
        .map((b) => `${b}: ${palletsInBin.get(b)} pallets, room for ${m.binByCode.get(b).cap}`).join(" · ") : "" });
    const sheetPallets = [...pallets.values()].filter((p) => p.source === "sheet");
    const mixedSku = sheetPallets.filter((p) => !m.binByCode.get(p.bin).huMultiSku && p.skus.size > 1);
    add("6f", "One SKU per pallet where the bin type doesn't allow mixed-SKU pallets", mixedSku.flatMap((p) => p.rows), {
      detail: mixedSku.slice(0, 4).map((p) => `${p.hu} in ${p.bin}: ${[...p.skus].join(", ")}`).join(" · ") });
    const mixedBatch = sheetPallets.filter((p) => !m.binByCode.get(p.bin).huMultiBatch
      && [...p.skus].some((s) => [...p.keys].filter((k) => k.startsWith(s + "|")).length > 1));
    add("6g", "One batch per SKU on a pallet where the bin type doesn't allow mixed-batch pallets", mixedBatch.flatMap((p) => p.rows), {
      detail: mixedBatch.slice(0, 4).map((p) => `${p.hu} in ${p.bin}: ${[...p.keys].map((k) => k.replace("|", " ")).join(", ")}`).join(" · ") });

    // 9 best fit: one pallet holds L2inL3 cases of a SKU. Soft: the upload and putaway accept more.
    const overFit = sheetPallets.filter((p) => p.share !== null && p.share > 1 + 1e-9);
    add("9a", "No pallet holds more than its best fit (L2inL3 cases)", overFit.flatMap((p) => p.rows), { soft: true,
      detail: overFit.length ? overFit.slice(0, 4).map((p) => `${p.hu} in ${p.bin}: ${casesText(m, p)} = ${pct(p.share)} of best fit` +
        (p.skus.size === 1 ? ` (${fmtN(m.skus.get([...p.skus][0])?.L2inL3 || 0)} cases)` : "")).join(" · ") + (overFit.length > 4 ? " · …" : "") : "" });
    const unsized = rows.filter((r) => r.hu && binOf(r)?.huType === "PALLET" && skuOf(r) && palletShare(m, r.sku, r.uom, 1) === null);
    add("9b", "Every pallet SKU has an L2inL3 (cases per pallet) in its UOM master", unsized, { soft: true,
      detail: unsized.length ? `Best fit can't be checked for ${[...new Set(unsized.map((r) => r.sku))].slice(0, 8).join(", ")}${new Set(unsized.map((r) => r.sku)).size > 8 ? ", …" : ""}. Putaway falls back to volume for these.` : "" });

    // 7 the uploader's row contract
    add("7a", "Operation type is the same on every row", ops.size > 1 ? rows : [], { detail: [...ops].join(", ") });
    add("7i", "Operation type is APPEND or RESET", rows.filter((r) => !["APPEND", "RESET"].includes(r.op)),
      { detail: [...ops].filter((o) => !["APPEND", "RESET"].includes(o)).map((o) => o ? `"${o}"` : "blank").join(", ") });
    add("7b", "Quantity is a positive whole number", rows.filter((r) => !(Number(r.qty) > 0) || Number(r.qty) % 1 !== 0));
    add("7c", "UOM is L0, L2 or L3", rows.filter((r) => !["L0", "L2", "L3"].includes(r.uom)));
    add("7d", "Bucket is Good or Damaged", rows.filter((r) => !["Good", "Damaged"].includes(r.bucket)));
    add("7e", "Inclusion status is PRE-GRN, INCLUDED or POST-GIN", rows.filter((r) => !["PRE-GRN", "INCLUDED", "POST-GIN"].includes(r.inclusion)));
    const lines = new Map();
    rows.forEach((r) => { const k = [r.bin, r.hu || "", r.sku, r.uom, upper(r.batch), r.bucket, r.inclusion].join("|"); lines.set(k, (lines.get(k) || 0) + 1); });
    add("7f", "No duplicate stock line (bin, HU, SKU, UOM, batch, bucket, status)", rows.filter((r) => lines.get([r.bin, r.hu || "", r.sku, r.uom, upper(r.batch), r.bucket, r.inclusion].join("|")) > 1));
    if (headers) {
      const expected = templateFor(m.whId);
      const same = headers.length === expected.length && headers.every((h, i) => h === expected[i]);
      // a sheet downloaded from this page carries our extra columns
      const ours = headers.slice(expected.length).every((h) => ["Check", "Issues", "Pallet fill vs best fit"].includes(h)) && headers.length > expected.length;
      add("7g", "Header row matches this warehouse's template", [], { fail: !same, detail: same ? ""
        : ours ? "This is a checked sheet from this page. Delete its Check, Issues and Pallet fill columns before uploading." : `Expected: ${expected.join(" | ")}` });
    }
    if (sheetNames) add("7h", "Data is on the first sheet, named Sheet1", [], { fail: sheetNames[0] !== "Sheet1", detail: `Sheets: ${sheetNames.join(", ")}` });

    // 8 SKU master
    add("8a", "Every SKU exists in the SKU master", rows.filter((r) => !skuOf(r)));
    add("8b", "Every SKU is active", rows.filter((r) => skuOf(r) && !skuOf(r).active));
    const l0 = new Set(rows.filter((r) => r.uom === "L0").map((r) => r.sku)), l2 = new Set(rows.filter((r) => r.uom === "L2").map((r) => r.sku));
    add("8c", "No SKU is written at both L0 and L2", rows.filter((r) => l0.has(r.sku) && l2.has(r.sku)));

    return {
      checks: out,
      failed: out.filter((c) => c.status === "fail").length,
      warned: out.filter((c) => c.status === "warn").length,
      passed: out.filter((c) => c.status === "pass").length,
      rowIssues,
      checksOff: skip.size,
      sessions: m.sessions,
      warnings: m.warnings,
    };
  }

  const CHECK_GROUPS = { 1: "Batch master", 2: "Dates", 3: "ABC class", 4: "Search table", 5: "Bins and HUs", 6: "Bin and pallet mixing", 7: "Row format", 8: "SKU master", 9: "Best fit" };
  let checkCatalog = null;
  function checksCatalog() {
    if (checkCatalog) return checkCatalog;
    const empty = { batches: new Map(), prodLots: new Map(), prodParents: new Set(), skus: new Map(), binByCode: new Map(), bins: [], kinds: [],
      huCodes: new Set(), occupied: new Map(), palletStock: new Map(), search: {}, warnings: [], sessions: [], classType: "ABC", whId: "" };
    const v = validate(empty, [], { headers: [], sheetNames: ["Sheet1"] });
    // only shown when the sheet has pallet codes, so the empty run never reaches it
    v.checks.push({ id: "5i", title: "Pallet HU code length", level: "info" });
    const kinds = new Map();
    for (const c of v.checks) {
      const g = c.id[0];
      if (!kinds.has(g)) kinds.set(g, { kind: g, name: CHECK_GROUPS[g] || "Other", checks: [] });
      if (!kinds.get(g).checks.some((x) => x.id === c.id)) kinds.get(g).checks.push({ id: c.id, title: c.title.replace(/Over \d+ days/, "Over N days"), level: c.level });
    }
    for (const k of kinds.values()) k.checks.sort((a, b) => a.id.localeCompare(b.id));
    return (checkCatalog = { kinds: [...kinds.values()].sort((a, b) => a.kind.localeCompare(b.kind)) });
  }

  // ---- consolidation: how many pallet positions merging would free ----------------------
  // Only same SKU + same batch partial pallets merge, so the result is valid whatever the
  // bin type's mixing flags. Keep the fullest pallets, pour the emptiest into them.
  // locked: HUs a task holds; busy: bins with locked stock or stock arriving (put lock), which pallets
  // neither leave nor go into; leaving: stock being picked (see palletsAfter)
  function consolidation(m, rows, { locked = new Set(), busy = new Set(), leaving = new Map() } = {}) {
    const isReset = isResetSheet(rows);
    // storage only: INVENTORY areas, or every non-working area if the node has none
    const hasInv = m.bins.some((b) => b.huType === "PALLET" && b.areaType === "INVENTORY");
    const storage = (b) => b && b.status === "ACTIVE" && (hasInv ? b.areaType === "INVENTORY" : !EXEMPT_AREAS.has(b.areaType));
    const pallets = [...palletsAfter(m, rows, isReset, leaving).values()].filter((p) => storage(m.binByCode.get(p.bin)));
    const st = { pallets: pallets.length, full: 0, over: 0, partial: 0, mixed: 0, unsized: 0 };
    const groups = new Map();
    for (const p of pallets) {
      // a task holds it: it can't be poured from or into until the task ends
      if (locked.has(p.hu)) { p.state = "Locked by a task"; st.locked = (st.locked || 0) + 1; continue; }
      if (busy.has(p.bin)) { p.state = "Bin has locked stock or stock arriving"; st.busy = (st.busy || 0) + 1; continue; }
      if (p.leaving && !p.lines.length) { p.state = "All of it being picked"; st.picking = (st.picking || 0) + 1; continue; }
      if (p.share === null) { p.state = "No best fit"; st.unsized++; continue; }
      if (p.keys.size > 1) { p.state = "Mixed"; st.mixed++; continue; }
      if (p.share > 1 + 1e-9) { p.state = "Over best fit"; st.over++; continue; }
      if (p.share >= 1 - 1e-9) { p.state = "Full"; st.full++; continue; }
      p.state = "Partial"; st.partial++;
      const k = [...p.keys][0];
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }

    const palletsInBin = new Map();
    for (const p of pallets) palletsInBin.set(p.bin, (palletsInBin.get(p.bin) || 0) + 1);
    const removedInBin = new Map();
    const merges = [], moves = [];
    for (const [k, list] of groups) {
      if (list.length < 2) continue;
      const total = list.reduce((t, p) => t + p.share, 0), need = Math.ceil(total - 1e-9);
      if (need >= list.length) continue;
      const [sku, batch] = k.split("|"), bf = m.skus.get(sku)?.L2inL3 || null;
      // fullest first; on a tie keep the pallet whose bin holds more, so small bins empty
      list.sort((a, b) => b.share - a.share || palletsInBin.get(b.bin) - palletsInBin.get(a.bin));
      const keep = list.slice(0, need), drop = list.slice(need);
      const room = keep.map((p) => ({ p, left: 1 - p.share }));
      for (const d of [...drop].reverse()) {
        let left = d.share;
        for (const r of room) {
          if (left <= 1e-9) break;
          const take = Math.min(left, r.left);
          if (take <= 1e-9) continue;
          moves.push({ sku, batch, fromBin: d.bin, fromHu: d.hu, toBin: r.p.bin, toHu: r.p.hu, cases: bf ? take * bf : null, share: take });
          r.left -= take; left -= take;
        }
        d.mergeInto = true;
        removedInBin.set(d.bin, (removedInBin.get(d.bin) || 0) + 1);
      }
      keep.forEach((p) => { p.keepFor = true; });
      merges.push({ sku, batch, bestFit: bf, pallets: list.length, cases: bf ? total * bf : null, fill: total, need, frees: list.length - need,
        bins: new Set(list.map((p) => p.bin)).size, oneBin: new Set(list.map((p) => p.bin)).size === 1,
        list: list.map((p) => `${p.hu}@${p.bin} ${pct(p.share)}`) });
    }
    merges.sort((a, b) => b.frees - a.frees || a.sku.localeCompare(b.sku));
    const emptiedBins = [...removedInBin].filter(([b, n]) => n === palletsInBin.get(b)).map(([b]) => b);
    const binsEmptied = emptiedBins.length;

    // positions: active pallet bins in storage areas
    const zones = new Map();
    let positions = 0, used = 0, emptyBins = 0, binsN = 0;
    for (const b of m.bins) {
      if (b.huType !== "PALLET" || !storage(b)) continue;
      const n = palletsInBin.get(b.code) || 0;
      binsN++; positions += b.cap; used += Math.min(n, b.cap); if (!n) emptyBins++;
      const zk = b.zone || "(no zone)";
      if (!zones.has(zk)) zones.set(zk, { zone: zk, area: b.area || "", bins: 0, positions: 0, used: 0, partial: 0, frees: 0 });
      const z = zones.get(zk);
      z.bins++; z.positions += b.cap; z.used += Math.min(n, b.cap);
    }
    for (const p of pallets) {
      const z = zones.get(m.binByCode.get(p.bin)?.zone || "(no zone)");
      if (!z) continue;
      if (p.state === "Partial") z.partial++;
      if (p.mergeInto) z.frees++;
    }
    const frees = merges.reduce((t, g) => t + g.frees, 0);

    // shelf (BIN-type) bins: the same SKU + batch spread over several bins. No best fit
    // for shelves (putaway sizes them by volume), so these are only candidates to look at.
    const shelf = new Map();
    const shelfNote = (bin, sku, batch) => {
      if (m.binByCode.get(bin)?.huType !== "BIN" || EXEMPT_AREAS.has(m.binByCode.get(bin)?.areaType) || m.binByCode.get(bin)?.areaType === "WORK_CENTER") return;
      const k = `${sku}|${upper(batch)}`;
      if (!shelf.has(k)) shelf.set(k, new Set());
      shelf.get(k).add(bin);
    };
    const sheetBins = new Set(rows.map((r) => r.bin));
    for (const [bin, list] of m.occupied) if (!(isReset && sheetBins.has(bin))) list.forEach((x) => shelfNote(bin, x.skuCode, x.batch));
    rows.forEach((r) => shelfNote(r.bin, r.sku, r.batch));
    const spread = [...shelf].filter(([, b]) => b.size > 1).map(([k, b]) => ({ sku: k.split("|")[0], batch: k.split("|")[1], bins: b.size, list: [...b].sort() }))
      .sort((a, b) => b.bins - a.bins);

    return {
      isReset,
      stats: { ...st, palletBins: binsN, positions, used, spare: positions - used, emptyBins, frees, binsEmptied, mergeGroups: merges.length,
        sameBinFrees: merges.filter((g) => g.oneBin).reduce((t, g) => t + g.frees, 0) },
      zones: [...zones.values()].map((z) => ({ ...z, spare: z.positions - z.used })).sort((a, b) => b.frees - a.frees || a.zone.localeCompare(b.zone)),
      merges, moves, pallets, emptiedBins, shelf: { groups: spread.length, extraBins: spread.reduce((t, s) => t + s.bins - 1, 0), top: spread.slice(0, 200) },
    };
  }

  // Whole-pallet moves that empty multi-position bins. After the merges, the pallets of the
  // emptiest bins go into bins of the same zone and bin type that already hold pallets and
  // have room, within the target's multi-SKU / multi-batch rules and SKU caps. Moving a whole
  // pallet frees no position, but it frees the bin for something else.
  function packBins(m, cons, locked = new Set(), busy = new Set()) {
    const palletsOf = new Map();
    // a pallet merged away is gone, unless stock is still being picked from it: then it holds its position until the pick is done
    for (const p of cons.pallets) if (!p.mergeInto || p.leaving) { if (!palletsOf.has(p.bin)) palletsOf.set(p.bin, []); palletsOf.get(p.bin).push(p); }
    // loose stock (no pallet) stays put, so a bin holding any can't be emptied by moving pallets
    const hasLoose = (bin) => {
      const all = (m.occupied.get(bin) || []).reduce((t, x) => t + x.qty, 0);
      let onPallets = 0;
      for (const lines of (m.palletStock.get(bin) || new Map()).values()) for (const x of lines) onPallets += x.qty;
      return all - onPallets > 1e-6;
    };
    // what each bin holds now (loose stock included), as SKUs and SKU|batch keys
    const holds = (bin) => {
      const skus = new Set(), keys = new Set();
      for (const x of m.occupied.get(bin) || []) { skus.add(x.skuCode); keys.add(`${x.skuCode}|${upper(x.batch)}`); }
      return { skus, keys };
    };
    const groups = new Map();
    for (const [code, list] of palletsOf) {
      const b = m.binByCode.get(code);
      if (!b || b.cap < 2 || list.length >= b.cap || busy.has(code)) continue;
      const k = `${b.zone}|${b.binType}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push({ b, pallets: list, n: list.length, ...holds(code) });
    }
    const fits = (t, p) => {
      if (t.n + 1 > t.b.cap) return false;
      const skus = new Set([...t.skus, ...p.skus]), keys = new Set([...t.keys, ...p.keys]);
      if (t.b.multiSku === false && skus.size > 1) return false;
      if (t.b.multiBatch === false && [...skus].some((sku) => [...keys].filter((k) => k.startsWith(sku + "|")).length > 1)) return false;
      if (t.b.maxSku && skus.size > t.b.maxSku) return false;
      if (t.b.maxSkuBatch && keys.size > t.b.maxSkuBatch) return false;
      return true;
    };
    const bins = [], moves = [];
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      list.sort((a, b) => a.n - b.n || a.b.code.localeCompare(b.b.code));
      const emptied = new Set(), received = new Set();
      for (const src of list) {
        if (emptied.has(src.b.code) || received.has(src.b.code)) continue;
        if (src.pallets.some((p) => locked.has(p.hu) || p.leaving) || hasLoose(src.b.code)) continue;
        // try it on copies; keep only if every pallet finds a bin
        const sim = new Map(list.filter((t) => t !== src && !emptied.has(t.b.code)).map((t) => [t.b.code, { ...t, skus: new Set(t.skus), keys: new Set(t.keys) }]));
        const plan = [];
        for (const p of src.pallets) {
          // the bin with the least room left that still takes it, so bins fill up rather than spread
          const t = [...sim.values()].filter((x) => fits(x, p)).sort((a, b) => (a.b.cap - a.n) - (b.b.cap - b.n) || a.b.code.localeCompare(b.b.code))[0];
          if (!t) { plan.length = 0; break; }
          t.n++; p.skus.forEach((x) => t.skus.add(x)); p.keys.forEach((x) => t.keys.add(x));
          plan.push({ p, to: t.b.code });
        }
        if (plan.length !== src.pallets.length) continue;
        for (const t of sim.values()) { const real = list.find((x) => x.b.code === t.b.code); Object.assign(real, { n: t.n, skus: t.skus, keys: t.keys }); }
        emptied.add(src.b.code);
        plan.forEach(({ to }) => received.add(to));
        for (const { p, to } of plan) {
          p.moveTo = to;
          moves.push({ zone: src.b.zone, binType: src.b.binType, fromBin: src.b.code, hu: p.hu, toBin: to, stock: casesText(m, p) });
        }
        bins.push({ bin: src.b.code, zone: src.b.zone, area: src.b.area, binType: src.b.binType, cap: src.b.cap, pallets: plan.length, to: [...new Set(plan.map((x) => x.to))] });
      }
    }
    bins.sort((a, b) => String(a.zone).localeCompare(String(b.zone)) || a.bin.localeCompare(b.bin));
    return { bins, moves, stats: { bins: bins.length, pallets: moves.length } };
  }

  const addSheet = (wb, name, cols, data) => {
    const s = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
    s.columns = cols.map(([header, key, w]) => ({ header, key, width: w || 14 }));
    s.getRow(1).font = { bold: true };
    data.forEach((d) => s.addRow(d));
    return s;
  };
  // the merge plan, pour by pour, and every pallet's fill; shared by the checked sheet and the stock plan
  function consolidationSheets(wb, m, cons, pack) {
    addSheet(wb, "Consolidation", [["SKU", "sku", 18], ["Batch", "batch", 16], ["Best fit (cases)", "bestFit"], ["Partial pallets", "pallets"],
      ["Cases in them", "cases"], ["Pallets needed", "need"], ["Pallets freed", "frees"], ["Bins", "bins", 8], ["Pallets (HU@bin fill)", "list", 90]],
      cons.merges.map((g) => ({ ...g, bestFit: g.bestFit && +g.bestFit.toFixed(2), cases: g.cases === null ? null : +g.cases.toFixed(2), list: g.list.join(", ") })));
    addSheet(wb, "Moves", [["SKU", "sku", 18], ["Batch", "batch", 16], ["From bin", "fromBin", 18], ["From pallet", "fromHu", 18],
      ["To bin", "toBin", 18], ["To pallet", "toHu", 18], ["Cases", "cases", 10], ["Share of a pallet", "share", 16]],
      cons.moves.map((x) => ({ ...x, cases: x.cases === null ? null : +x.cases.toFixed(2), share: pct(x.share) })));
    if (pack) addSheet(wb, "Bin moves", [["Zone", "zone", 14], ["Bin type", "binType", 14], ["Empty this bin", "fromBin", 18], ["Pallet", "hu", 18],
      ["Move it to bin", "toBin", 18], ["Stock on it", "stock", 60]], pack.moves);
    addSheet(wb, "Pallet fill", [["Zone", "zone", 14], ["Bin", "bin", 18], ["Pallet", "hu", 18], ["From", "source", 9], ["Stock", "stock", 60],
      ["Fill vs best fit", "fill", 14], ["State", "state", 16], ["Plan", "merge", 26]],
      cons.pallets.map((p) => ({ zone: m.binByCode.get(p.bin)?.zone, bin: p.bin, hu: p.hu, source: p.source === "sheet" ? "Sheet" : "In stock",
        stock: casesText(m, p) + (p.gone?.length ? ` · being picked (not counted): ${casesText(m, { lines: p.gone })}` : ""), fill: p.share === null ? "" : pct(p.share), state: p.state,
        merge: p.mergeInto ? "Empty it (see Moves)" : p.keepFor ? "Keep, receives cases" : p.moveTo ? `Move whole to ${p.moveTo} (see Bin moves)` : "" }))
        .sort((a, b) => String(a.zone).localeCompare(String(b.zone)) || a.bin.localeCompare(b.bin)));
    if (cons.shelf.top.length) addSheet(wb, "Shelf spread", [["SKU", "sku", 18], ["Batch", "batch", 16], ["Bins", "bins", 8], ["Bin codes", "list", 90]],
      cons.shelf.top.map((x) => ({ ...x, list: x.list.join(", ") })));
  }
  async function planWorkbook(plan) {
    const { m, cons, pack } = plan, st = cons.stats;
    const wb = new ExcelJS.Workbook();
    addSheet(wb, "Summary", [["What", "k", 52], ["Value", "v", 22]], [
      { k: "Warehouse", v: m.whId }, { k: "Stock read at", v: new Date(m.loadedAt).toLocaleString() },
      { k: "Pallet bins (storage, active)", v: st.palletBins }, { k: "Pallet positions", v: st.positions },
      { k: "Positions used", v: st.used }, { k: "Positions free", v: st.spare }, { k: "Pallet bins completely empty", v: st.emptyBins },
      { k: "Pallets", v: st.pallets }, { k: "Full pallets (at best fit)", v: st.full }, { k: "Partial pallets", v: st.partial },
      { k: "Over best fit", v: st.over }, { k: "Mixed SKU/batch pallets", v: st.mixed }, { k: "Pallets without an L2inL3", v: st.unsized },
      { k: "Pallets locked by a task (left out)", v: st.locked || 0 },
      { k: "Pallets in bins with locked stock or stock arriving (put lock; left out, and nothing moves into those bins)", v: st.busy || 0 },
      { k: "Pallets whose stock is all being picked (left out)", v: st.picking || 0 },
      { k: "Stock being picked (pick lock)", v: "Not counted in a pallet's fill and never moved; still counted in the WMS capacity check until it's picked" },
      { k: "Pallets freed by merging same SKU + batch", v: st.frees }, { k: "  of which inside the same bin", v: st.sameBinFrees },
      { k: "Bins emptied by merging", v: st.binsEmptied },
      { k: "Bins emptied by moving whole pallets", v: pack.stats.bins }, { k: "  whole pallets to move", v: pack.stats.pallets },
      { k: "Free positions after merging", v: st.spare + st.frees },
      { k: "Shelf SKU-batches spread over several bins", v: cons.shelf.groups },
    ]);
    consolidationSheets(wb, m, cons, pack);
    addImSheets(wb, plan.im, PALLET_IM_NOTES, plan.imHeld);
    return wb.xlsx.writeBuffer();
  }

  // ---- WMS bin capacity, as an IM upload checks it ---------------------------------------
  // cincout internal-movement.route.ts:243-246: the destination bin's stock plus every row of the
  // upload going into it, each unit counted by commons calculateBinVolumeUsageForQK, must total
  // 100% or less. One unit: 1 / bin type best fit for the SKU+UOM; else with a pallet capacity,
  // L3 = 1 / capacity and other UOMs (when useDerivedPalletBestFit, default on) 1 / floor(capacity x
  // units per L3); else the unit's volume over the bin type's maxVolumeInCC.
  async function wmsCapacity(whId, m) {
    const [[types, typeErr], [fits], [ids]] = await Promise.all([
      tryQ(wms, 'SELECT id, "palletCapacity", "maxVolumeInCC", "useDerivedPalletBestFit" FROM storage_bin_type WHERE "whId" = $1', [whId]),
      tryQ(wms, 'SELECT "binTypeId", "skuId", uom, "bestFitCount" FROM storage_bin_type_best_fit WHERE "whId" = $1 AND active', [whId]),
      tryQ(wms, 'SELECT DISTINCT "skuId", "skuCode" FROM inventory WHERE "whId" = $1 AND "deletedAt" IS NULL', [whId]),
    ]);
    // an older schema without the column: it defaults to true
    const typeById = new Map(typeErr ? [...m.binTypeById].map(([id, t]) => [id, { ...t, useDerivedPalletBestFit: true }]) : types.map((t) => [t.id, t]));
    const codeOf = new Map(ids.map((r) => [String(r.skuId), r.skuCode]));
    const bestFit = new Map(fits.map((f) => [`${f.binTypeId}|${codeOf.get(String(f.skuId))}|${f.uom}`, Number(f.bestFitCount)]));
    const memo = new Map();
    const unit = (binCode, sku, uom) => {
      const b = m.binByCode.get(binCode), t = b && typeById.get(b.binTypeId);
      if (!t) return 0;
      const k = `${b.binTypeId}|${sku}|${uom}`;
      if (memo.has(k)) return memo.get(k);
      const s = m.skus.get(sku), bf = bestFit.get(k), pc = Number(t.palletCapacity);
      const inL3 = s?.units?.L3 > 0 && s?.units?.[uom] > 0 ? s.units.L3 / s.units[uom] : 0;
      const vol = s?.vols?.[uom] > 0 && Number(t.maxVolumeInCC) > 0 ? s.vols[uom] / Number(t.maxVolumeInCC) : 0;
      const u = bf > 0 && Number.isSafeInteger(bf) ? 1 / bf
        : pc > 0 && uom === "L3" ? 1 / pc
        : pc > 0 && t.useDerivedPalletBestFit !== false && inL3 > 0 ? 1 / Math.floor(pc * inL3)
        : vol;
      memo.set(k, u);
      return u;
    };
    // what each bin holds now, every quant (the check doesn't skip locked stock)
    const stock = new Map([...m.occupied].map(([bin, ls]) => [bin, ls.map((l) => ({ sku: l.skuCode, uom: l.uom, qty: l.qty }))]));
    return { unit, stock };
  }

  // ---- IM cockpit upload rows, per plan ------------------------------------------------
  // a whole-pallet row shows the stock only for a single-SKU pallet (the uploader ignores it)
  const wholeRow = (fromBin, hu, toBin, lines, extra) => {
    const one = lines.length === 1 ? lines[0] : null;
    return { fromBin, hu, toBin, pickHu: true, ...(one ? { sku: one.sku, batch: one.batch, bucket: one.bucket, uom: one.uom, qty: one.qty } : {}),
      lines: lines.map((l) => ({ sku: l.sku, uom: l.uom, qty: l.qty })), ...extra };
  };
  // pallet stock with bucket and ILOC, which the merge plan doesn't carry: bin|hu -> lines
  async function palletLines(whId) {
    const rows = await q(wms, `SELECT "binCode", "huCode", "skuCode" AS sku, upper(trim(batch)) AS batch, bucket, uom, iloc, sum(qty)::float AS qty FROM inventory
                                WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0 AND "huCode" IS NOT NULL AND ${LOCK_KIND} = ''
                                GROUP BY 1, 2, 3, 4, 5, 6, 7`, [whId, ZERO_ID]);
    const out = new Map();
    for (const r of rows) { const k = `${r.binCode}|${r.huCode}`; if (!out.has(k)) out.set(k, []); out.get(k).push(r); }
    return out;
  }
  // merges: cases off each emptied pallet, the plan's shares turned into its real lines;
  // then the whole-pallet bin moves, which assume the merges are done
  function palletImRows(m, cons, pack, lines) {
    const rows = [], got = new Map(); // hu -> cases received, for the stock shown on its later whole move
    const byDrop = new Map();
    for (const mv of cons.moves) { const k = `${mv.fromBin}|${mv.fromHu}`; if (!byDrop.has(k)) byDrop.set(k, []); byDrop.get(k).push(mv); }
    for (const [k, mvs] of byDrop) {
      // biggest unit first; each pour gets whole units up to its running share, the last takes the rest
      const units = (lines.get(k) || []).map((l) => ({ l, left: l.qty, u: palletShare(m, l.sku, l.uom, 1) })).filter((x) => x.u).sort((a, b) => b.u - a.u);
      let target = 0, done = 0;
      mvs.forEach((mv, i) => {
        target += mv.share;
        for (const x of units) {
          const n = i === mvs.length - 1 ? x.left : Math.min(x.left, Math.floor((target - done) / x.u + 1e-9));
          if (n <= 0) continue;
          x.left -= n; done += n * x.u;
          rows.push({ fromBin: mv.fromBin, hu: mv.fromHu, sku: x.l.sku, batch: x.l.batch, bucket: x.l.bucket, uom: x.l.uom, qty: n, iloc: x.l.iloc,
            toBin: mv.toBin, pickHu: false, toHu: mv.fromBin === mv.toBin ? mv.toHu : null, toPallet: mv.toHu, unit: k });
          if (!got.has(mv.toHu)) got.set(mv.toHu, []);
          got.get(mv.toHu).push({ ...x.l, qty: n });
        }
      });
    }
    for (const mv of pack.moves) {
      const sum = new Map();
      for (const l of [...(lines.get(`${mv.fromBin}|${mv.hu}`) || []), ...(got.get(mv.hu) || [])]) {
        const k = [l.sku, l.batch, l.bucket, l.uom].join("|");
        sum.set(k, { ...l, qty: (sum.get(k)?.qty || 0) + l.qty });
      }
      rows.push(wholeRow(mv.fromBin, mv.hu, mv.toBin, [...sum.values()], { phase: 2, unit: `pack|${mv.fromBin}` }));
    }
    return rows;
  }
  // bins under % full: whole pallets, cases onto a pallet in another bin, loose pours; in step order
  function relocateImRows(plan) {
    const rows = [], seen = new Set();
    plan.moves.forEach((p, i) => {
      if (p.kind === "pallet") {
        const k = `${p.fromBin}|${p.hu}|${p.toBin}`;
        if (seen.has(k)) return;
        seen.add(k);
        rows.push(wholeRow(p.fromBin, p.hu, p.toBin, plan.moves.filter((x, j) => j >= i && x.kind === "pallet" && x.hu === p.hu && x.fromBin === p.fromBin && x.toBin === p.toBin)));
      } else {
        rows.push({ fromBin: p.fromBin, hu: p.hu || null, sku: p.sku, batch: p.batch, bucket: p.bucket, uom: p.uom, qty: p.qty, iloc: p.iloc, toBin: p.toBin,
          pickHu: false, toHu: p.kind === "merge" && p.fromBin === p.toBin ? p.toHu : null, toPallet: p.kind === "merge" ? p.toHu : null });
      }
    });
    return rows;
  }
  // shelf eaches: loose stock, bin to bin
  const eachesImRows = (plan) => plan.moves.map((p) => ({ fromBin: p.fromBin, sku: p.sku, batch: p.batch, bucket: p.bucket, uom: p.uom, qty: p.qty, iloc: p.iloc, toBin: p.toBin, pickHu: false }));
  const PALLET_IM_NOTES = ["The whole-pallet moves assume the case moves have emptied their pallets, so they're in a later upload."];
  const imSummary = (files) => files.map((f) => ({ n: f.n, wave: f.wave, what: f.what, rows: f.rows.length, whole: f.whole, sameBin: f.sameBin }));

  // ---- eaches consolidation: shelf bins, by volume -----------------------------------
  // areas and zones of shelf (BIN-type) storage bins, for the pickers
  function eachesScope(m) {
    const areas = new Map();
    for (const b of m.bins) {
      if (b.huType !== "BIN" || ["PICK_AND_DROP", "STAGING", "REJECT", "WORK_CENTER", "TRANSPORTATION"].includes(b.areaType)) continue;
      const a = b.area || "(no area)";
      if (!areas.has(a)) areas.set(a, { area: a, type: b.areaType, zones: new Map() });
      const zs = areas.get(a).zones;
      if (!zs.has(b.zone)) zs.set(b.zone, { zone: b.zone, bins: 0, occupied: 0, volumes: new Set() });
      const z = zs.get(b.zone);
      z.bins++; if (m.occupied.has(b.code)) z.occupied++; if (b.volCC) z.volumes.add(b.volCC);
    }
    return [...areas.values()].map((a) => ({ area: a.area, type: a.type,
      zones: [...a.zones.values()].map((z) => ({ ...z, volumes: [...z.volumes].sort((x, y) => x - y) })).sort((x, y) => String(x.zone).localeCompare(String(y.zone))) }))
      .sort((x, y) => x.area.localeCompare(y.area));
  }
  // bin types of those shelf bins, for the bin type picker
  function eachesTypes(m) {
    const types = new Map();
    for (const b of m.bins) {
      if (b.huType !== "BIN" || ["PICK_AND_DROP", "STAGING", "REJECT", "WORK_CENTER", "TRANSPORTATION"].includes(b.areaType)) continue;
      const k = b.binType || "(none)";
      if (!types.has(k)) types.set(k, { binType: k, volCC: b.volCC, maxKg: b.maxKg, bins: 0, occupied: 0, areas: new Set() });
      const t = types.get(k);
      t.bins++; if (m.occupied.has(b.code)) t.occupied++; t.areas.add(b.area || "(no area)");
    }
    return [...types.values()].map((t) => ({ ...t, areas: [...t.areas].sort() })).sort((x, y) => x.binType.localeCompare(y.binType));
  }
  // ---- bins under % full: every inventory area, pallet and shelf bins ------------------
  // areas -> zones -> bin types of every inventory bin, for the From and To pickers
  function relocateScope(m) {
    const areas = new Map();
    for (const b of m.bins) {
      if (b.areaType !== "INVENTORY" || !["PALLET", "BIN"].includes(b.huType)) continue;
      const a = b.area || "(no area)";
      if (!areas.has(a)) areas.set(a, { area: a, zones: new Map() });
      const zs = areas.get(a).zones;
      if (!zs.has(b.zone)) zs.set(b.zone, { zone: b.zone, bins: 0, occupied: 0, types: new Map() });
      const z = zs.get(b.zone), occ = m.occupied.has(b.code), k = b.binType || "(none)";
      z.bins++; if (occ) z.occupied++;
      if (!z.types.has(k)) z.types.set(k, { binType: k, kind: b.huType, cap: b.cap, volCC: b.volCC, maxKg: b.maxKg, bins: 0, occupied: 0 });
      const t = z.types.get(k); t.bins++; if (occ) t.occupied++;
    }
    const num = (x, y) => String(x).localeCompare(String(y), undefined, { numeric: true });
    return [...areas.values()].map((a) => ({ area: a.area,
      zones: [...a.zones.values()].map((z) => ({ ...z, types: [...z.types.values()].sort((x, y) => num(x.binType, y.binType)) })).sort((x, y) => num(x.zone, y.zone)) }))
      .sort((x, y) => num(x.area, y.area));
  }
  // stock pallet by pallet with what the rules need: bucket, price, owner, task locks
  async function relocateInput(whId, m, cap) {
    const [inv, fixed] = await Promise.all([
      q(wms, `SELECT "binCode", "huCode", "skuCode", upper(trim(batch)) AS batch, bucket, "inclusionStatus" AS inclusion, uom, price::float AS price, iloc,
                 ${LOCK_KIND} AS lock, sum(qty)::float AS qty
               FROM inventory WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10`, [whId, ZERO_ID]),
      tryQ(wms, 'SELECT b.code FROM storage_bin_fixed_mapping f JOIN storage_bin b ON b.id = f."binId" WHERE f."whId" = $1 AND f.active', [whId]),
    ]);
    const fixedSet = new Set(fixed[0].map((r) => r.code));
    // stock a pick task is taking out goes apart: it leaves, so the plan neither moves it nor counts it as fill
    const stock = new Map(), leaving = new Map();
    for (const r of inv) {
      const to = r.lock === "PICK" ? leaving : stock;
      if (!to.has(r.binCode)) to.set(r.binCode, []);
      to.get(r.binCode).push({ hu: r.huCode || null, sku: r.skuCode, batch: r.batch, bucket: r.bucket, inclusion: r.inclusion, uom: r.uom, price: r.price, iloc: r.iloc, qty: r.qty, locked: r.lock === "LOCKED" });
    }
    return {
      bins: m.bins.map((b) => ({ ...b, fixed: fixedSet.has(b.code) })), stock, leaving, skus: m.skus,
      allowed: (bin, sku, uom, bucket) => { const c = m.skus.get(sku)?.clazz; return !!c && allowedSeq(m, bin, c, uom, bucket) !== null; },
      wmsUnit: cap?.unit,
      fixedError: fixed[1],
    };
  }
  const HOW = { merge: "Onto a pallet already there", pallet: "Whole pallet", pour: "Loose into the bin" };
  async function relocateWorkbook({ m, plan, check, im, imHeld }) {
    const wb = new ExcelJS.Workbook(), st = plan.stats, o = plan.opts;
    addSheet(wb, "Summary", [["What", "k", 52], ["Value", "v", 60]], [
      { k: "Warehouse", v: m.whId }, { k: "Stock read at", v: new Date(m.loadedAt).toLocaleString() },
      { k: "Empty bins of (zone | bin type)", v: (o.from.cells || []).join(", ") || "All" }, { k: "Into bins of (zone | bin type)", v: (o.to.cells || []).join(", ") || "All" },
      { k: "Only bins under (% full)", v: o.belowPct >= 100 ? "Any fill" : o.belowPct },
      { k: "How full is measured", v: "Pallet bins: full pallets (the SKU's L3) over pallet positions. Shelf bins: stock volume over bin volume." },
      { k: "Empty bins can receive", v: { smaller: "Only bins smaller than the one being emptied", any: "Any empty bin", none: "No" }[o.useEmpty] }, { k: "Keep bins within the bin type's max kg", v: o.checkWeight ? "Yes" : "No" },
      { k: "Bins to empty from", v: st.fromBins }, { k: "  holding stock", v: st.fromStocked }, { k: `  under ${o.belowPct}% full`, v: st.under },
      { k: "  of those, could be planned (unlocked, active, sized)", v: st.candidates },
      { k: "Bins that can receive", v: st.toUsable }, { k: "  of them empty", v: st.toEmpty },
      { k: "Bins emptied", v: st.binsEmptied }, { k: "Steps", v: st.moves }, { k: "Pallets moved whole", v: st.palletsMovedWhole },
      { k: "Pallets merged onto others", v: st.palletsMerged }, { k: "Empty bins used", v: st.emptyBinsUsed }, { k: "Net bins freed (emptied minus empty bins used)", v: st.netFreed }, { k: "Pallet positions freed", v: st.positionsFreed },
      { k: "Every step re-checked (positions, pallet fill, weight, mixing rules, scope)", v: check.ok ? "Passed" : `FAILED: ${check.errs.slice(0, 3).join("; ")}` },
      { k: "Do the steps in order", v: "A later step can put cases onto a pallet an earlier step moved in." },
    ]);
    const pct = (x) => (x === null || x === undefined ? null : +(x * 100).toFixed(1));
    addSheet(wb, "Steps", [["Step", "step", 6], ["From bin", "fromBin", 16], ["From zone", "fromZone", 12], ["From bin type", "fromBinType", 16], ["From % full", "fromPct", 9],
      ["Pallet", "hu", 14], ["SKU", "sku", 18], ["Batch", "batch", 14], ["Qty", "qty", 8], ["Unit", "uom", 6], ["How", "how", 26],
      ["To bin", "toBin", 16], ["To zone", "toZone", 12], ["To bin type", "toBinType", 16], ["To pallet", "toHu", 14], ["To bin was empty", "wasEmpty", 9],
      ["To pallet after (% of a full pallet)", "palletAfter", 12], ["Pallets in to bin after", "positions", 10], ["Positions", "toCap", 9],
      ["To bin volume after (L)", "volAfter", 11], ["To bin kg after", "kg", 10], ["To bin max kg", "toMaxKg", 10]],
      plan.moves.map((p) => ({ ...p, fromPct: +p.fromOccPct.toFixed(2), how: HOW[p.kind], wasEmpty: p.toWasEmpty ? "Yes" : "No", palletAfter: p.kind === "pour" ? null : pct(p.toPalletAfter),
        positions: p.kind === "pour" ? null : p.toPositions, toCap: p.kind === "pour" ? null : p.toCap, volAfter: p.kind === "pour" ? litres(p.toUsedAfterCC) : null, kg: +p.toKgAfter.toFixed(1) })));
    addSheet(wb, "Bins emptied", [["Bin", "bin", 16], ["Zone", "zone", 12], ["Area", "area", 12], ["Bin type", "binType", 16], ["% full", "pct", 8], ["Pallets", "pallets", 8], ["Into", "to", 40], ["Note", "note", 40]],
      plan.emptied.map((e) => ({ ...e, pct: +e.occPct.toFixed(2), to: e.to.join(", "), note: e.afterPick ? "Empty once the stock being picked from it leaves" : "" })));
    addSheet(wb, "Not emptied", [["Bin", "bin", 16], ["Zone", "zone", 12], ["Area", "area", 12], ["Bin type", "binType", 16], ["% full", "pct", 8], ["Why", "why", 60], ["Stock", "stock", 70]],
      plan.notEmptied.map((n) => ({ ...n, pct: n.occPct === null ? null : +n.occPct.toFixed(2) })));
    addImSheets(wb, im, ["A step that puts cases onto a pallet an earlier step moves in is in a later upload."], imHeld);
    return wb.xlsx.writeBuffer();
  }

  // the stock line by line with what the shelf rules need: bucket, price, owner, task locks
  async function eachesInput(whId, m) {
    const [inv, fixed] = await Promise.all([
      q(wms, `SELECT "binCode", "skuCode", upper(trim(batch)) AS batch, bucket, "inclusionStatus" AS inclusion, uom, price::float AS price, iloc,
                 ${LOCK_KIND} AS lock, sum(qty)::float AS qty
               FROM inventory WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`, [whId, ZERO_ID]),
      // a bin mapped to a SKU, EAN or product is left alone
      tryQ(wms, 'SELECT b.code FROM storage_bin_fixed_mapping f JOIN storage_bin b ON b.id = f."binId" WHERE f."whId" = $1 AND f.active', [whId]),
    ]);
    const fixedSet = new Set(fixed[0].map((r) => r.code));
    // stock a pick task is taking out goes apart, as for bins under % full
    const stock = new Map(), leaving = new Map();
    for (const r of inv) {
      const to = r.lock === "PICK" ? leaving : stock;
      if (!to.has(r.binCode)) to.set(r.binCode, []);
      to.get(r.binCode).push({ sku: r.skuCode, batch: r.batch, bucket: r.bucket, inclusion: r.inclusion, uom: r.uom, price: r.price, iloc: r.iloc, qty: r.qty, locked: r.lock === "LOCKED" });
    }
    return {
      bins: m.bins.map((b) => ({ ...b, fixed: fixedSet.has(b.code) })), stock, leaving, skus: m.skus,
      // pours into another zone must be allowed there by the search table
      allowed: (bin, sku, uom, bucket) => { const c = m.skus.get(sku)?.clazz; return !!c && allowedSeq(m, bin, c, uom, bucket) !== null; },
      fixedError: fixed[1],
    };
  }
  const litres = (cc) => (cc === null || cc === undefined ? null : +(cc / 1000).toFixed(2));
  async function eachesWorkbook({ m, plan, check, im, imHeld }) {
    const wb = new ExcelJS.Workbook(), st = plan.stats, o = plan.opts;
    addSheet(wb, "Summary", [["What", "k", 52], ["Value", "v", 40]], [
      { k: "Warehouse", v: m.whId }, { k: "Stock read at", v: new Date(m.loadedAt).toLocaleString() },
      { k: "Areas", v: (o.areas || []).join(", ") || "All" }, { k: "Zones", v: (o.zones || []).join(", ") || "All" },
      { k: "Bin types", v: (o.binTypes || []).join(", ") || "All" },
      { k: "Units moved", v: (o.uoms || ["L0"]).map((x) => ({ L0: "Eaches (L0)", L2: "Cases (L2), whole", L3: "Outer cases (L3), whole" })[x]).join(", ") },
      { k: "Only empty bins under (% of bin volume)", v: o.emptyBelowPct >= 100 ? "Any fill" : o.emptyBelowPct },
      { k: "  bins at or above that, used only to receive", v: st.tooFull || 0 },
      { k: "Pour between zones of an area", v: o.crossZone ? "Yes" : "No, only within a zone" },
      { k: "Keep bins within the bin type's max kg", v: o.checkWeight ? "Yes" : "No (WMS putaway doesn't check weight either)" }, { k: "Fill targets up to (% of bin volume)", v: o.fillPct },
      { k: "Shelf bins in scope", v: st.binsInScope }, { k: "  holding stock", v: st.occupied }, { k: "  usable (chosen units only, unlocked, sized)", v: st.usable },
      { k: "  left out: locked by a task", v: st.locked }, { k: "  left out: fixed bins", v: st.fixed }, { k: "  left out: SKU without a volume for its unit", v: st.unsized },
      { k: "  left out: holds a unit not chosen", v: st.nonEach }, { k: "  emptied only, never filled: already breaks its mixing rules", v: st.broken },
      { k: "Bins whose bin type volume looks unset", v: st.suspectVol }, { k: "Every bin left out, with the reason", v: "See the Left out sheet" },
      { k: "Bins emptied", v: st.binsEmptied }, { k: "Most that could be emptied (upper bound)", v: st.bestPossible },
      { k: "Plan is the best possible", v: st.optimal ? "Yes" : "Not proven" },
      { k: "Moves", v: st.moves }, { k: "Eaches moved", v: st.eachesMoved },
      { k: "Every move re-checked (volume, weight, mixing rules)", v: check.ok ? "Passed" : `FAILED: ${check.errs.slice(0, 3).join("; ")}` },
    ]);
    addSheet(wb, "Moves", [["SKU", "sku", 18], ["Batch", "batch", 14], ["Qty", "qty", 8], ["Unit", "uom", 7], ["From bin", "fromBin", 16], ["From zone", "fromZone", 13],
      ["From bin volume (L)", "fromVol", 12], ["From bin used (L)", "fromUsed", 12], ["To bin", "toBin", 16], ["To zone", "toZone", 13],
      ["Unit volume (cc)", "unitVolCC", 11], ["Move volume (L)", "moveVol", 11], ["To bin volume (L)", "toVol", 12], ["To bin before (L)", "before", 12],
      ["To bin after (L)", "after", 12], ["To bin after (% full)", "pct", 12], ["To bin kg after", "kg", 10], ["To bin max kg", "toMaxKg", 10], ["Same SKU-batch already there", "sameKey", 12]],
      plan.moves.map((p) => ({ ...p, fromVol: litres(p.fromBinVolCC), fromUsed: litres(p.fromUsedCC), moveVol: litres(p.moveVolCC), toVol: litres(p.toBinVolCC),
        before: litres(p.toUsedBeforeCC), after: litres(p.toUsedAfterCC), pct: p.toBinVolCC ? +(p.toUsedAfterCC / p.toBinVolCC * 100).toFixed(1) : null,
        kg: +p.toKgAfter.toFixed(2), unitVolCC: +p.unitVolCC.toFixed(1), sameKey: p.sameKey ? "Yes" : "No" })));
    addSheet(wb, "Bins emptied", [["Bin", "bin", 16], ["Zone", "zone", 14], ["Area", "area", 12], ["Bin type", "binType", 14], ["Volume (L)", "vol", 10],
      ["Used (L)", "used", 10], ["Lines", "lines", 8], ["Into", "to", 40], ["Note", "note", 40]],
      plan.emptied.map((e) => ({ ...e, vol: litres(e.volCC), used: litres(e.usedCC), to: e.to.join(", "), note: e.afterPick ? "Empty once the stock being picked from it leaves" : "" })));
    addSheet(wb, "Bins receiving", [["Bin", "bin", 16], ["Zone", "zone", 14], ["Volume (L)", "vol", 10], ["Before (L)", "before", 10], ["Poured in (L)", "in", 11],
      ["After (L)", "after", 10], ["After (% full)", "pct", 11], ["kg after", "kg", 9], ["Max kg", "maxKg", 8], ["From", "from", 40]],
      plan.targets.map((t) => ({ ...t, vol: litres(t.volCC), before: litres(t.beforeCC), in: litres(t.inCC), after: litres(t.afterCC),
        pct: t.fillPct === null ? null : +t.fillPct.toFixed(1), kg: +t.kgAfter.toFixed(2), from: t.from.join(", ") })));
    addSheet(wb, "Left out", [["Bin", "bin", 16], ["Zone", "zone", 14], ["Area", "area", 12], ["Bin type", "binType", 14], ["Why", "reason", 50], ["Stock", "stock", 60]],
      [...plan.leftOut].sort((a, b) => a.reason.localeCompare(b.reason) || a.bin.localeCompare(b.bin, undefined, { numeric: true })));
    addImSheets(wb, im, [], imHeld);
    return wb.xlsx.writeBuffer();
  }

  // the uploaded sheet back, rows painted red (hard) / yellow (soft) with the reasons,
  // plus the consolidation plan
  async function annotatedSheet(m, buffer, v, cons) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    let width = 0;
    ws.getRow(1).eachCell({ includeEmpty: false }, (c, i) => { width = Math.max(width, i); });
    const RED = "FFF4C7C3", YELLOW = "FFFFF0B3";
    const fillOf = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
    const cResult = width + 1, cIssues = width + 2, cFill = width + 3;
    ws.getCell(1, cResult).value = "Check"; ws.getCell(1, cIssues).value = "Issues"; ws.getCell(1, cFill).value = "Pallet fill vs best fit";
    [cResult, cIssues, cFill].forEach((c) => { ws.getCell(1, c).font = { bold: true }; });
    ws.getColumn(cResult).width = 8; ws.getColumn(cIssues).width = 70; ws.getColumn(cFill).width = 26;
    const fillByRow = new Map();
    for (const p of cons.pallets) if (p.source === "sheet") for (const n of p.rows)
      fillByRow.set(n, p.share === null ? "no L2inL3" : `${pct(p.share)}${p.state === "Partial" && p.mergeInto ? ", merge (see Moves)" : ""}`);
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const iss = v.rowIssues[n] || [];
      const hard = iss.some((i) => i.level === "fail");
      row.getCell(cResult).value = !iss.length ? "OK" : hard ? "HARD" : "SOFT";
      row.getCell(cIssues).value = iss.map((i) => `${i.level === "fail" ? "[hard]" : "[soft]"} ${i.title}`).join("; ") || null;
      if (fillByRow.has(n)) row.getCell(cFill).value = fillByRow.get(n);
      // loaded cells share style objects (all date cells, say): copy before filling
      if (iss.length) for (let c = 1; c <= cFill; c++) { const cell = row.getCell(c); cell.style = { ...cell.style, fill: fillOf(hard ? RED : YELLOW) }; }
    });

    const sheet = (name, cols, data) => {
      const s = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
      s.columns = cols.map(([header, key, w]) => ({ header, key, width: w || 14 }));
      s.getRow(1).font = { bold: true };
      data.forEach((d) => s.addRow(d));
      return s;
    };
    const st = cons.stats;
    sheet("Summary", [["What", "k", 52], ["Value", "v", 16]], [
      { k: "Pallet bins (storage, active)", v: st.palletBins }, { k: "Pallet positions", v: st.positions },
      { k: "Positions used after this sheet", v: st.used }, { k: "Positions free after this sheet", v: st.spare },
      { k: "Pallet bins completely empty", v: st.emptyBins }, { k: "Pallets", v: st.pallets },
      { k: "Full pallets (at best fit)", v: st.full }, { k: "Partial pallets", v: st.partial }, { k: "Over best fit", v: st.over },
      { k: "Mixed SKU/batch pallets", v: st.mixed }, { k: "Pallets without an L2inL3", v: st.unsized },
      { k: "Pallets freed by merging same SKU + batch", v: st.frees }, { k: "  of which inside the same bin", v: st.sameBinFrees },
      { k: "Bins emptied by merging", v: st.binsEmptied },
      { k: "Free positions after merging", v: st.spare + st.frees },
      { k: "Shelf SKU-batches spread over several bins", v: cons.shelf.groups },
      { k: "Hard (red) checks failing", v: v.failed }, { k: "Soft (yellow) warnings", v: v.warned },
    ]);
    consolidationSheets(wb, m, cons);
    return wb.xlsx.writeBuffer();
  }

  // ---- templates and xlsx ----------------------------------------------------------
  function templateFor(whId) {
    try { return JSON.parse(fs.readFileSync(path.join(TEMPLATE_DIR, `${whId}.json`), "utf8")); } catch { return TEMPLATE_COLS; }
  }
  const hasTemplate = (whId) => fs.existsSync(path.join(TEMPLATE_DIR, `${whId}.json`));

  async function readSheet(buffer) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("The file has no sheets.");
    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(cellValue(c.value) ?? "").trim(); });
    while (headers.length && !headers[headers.length - 1]) headers.pop();
    const fields = headers.map(fieldOf);
    if (!fields.includes("bin") || !fields.includes("sku")) throw new Error("Row 1 needs the template headers (Bin Code, Sku Code, ...).");
    const rows = [];
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const r = { row: n };
      fields.forEach((f, i) => { if (f) r[f] = cellValue(row.getCell(i + 1).value); });
      if (!r.bin && !r.sku) return;
      r.bin = String(r.bin ?? "").trim(); r.sku = String(r.sku ?? "").trim();
      r.hu = String(r.hu ?? "").trim(); r.hukind = String(r.hukind ?? "").trim();
      r.uom = upper(r.uom); r.op = upper(r.op); r.inclusion = upper(r.inclusion);
      r.bucket = String(r.bucket ?? "").trim(); r.batch = upper(r.batch);
      r.qty = Number(r.qty); r.mfg = dayKeyOf(r.mfg); r.exp = dayKeyOf(r.exp);
      rows.push(r);
    });
    return { headers, rows, sheetNames: wb.worksheets.map((w) => w.name) };
  }

  async function templateHeaders(buffer) {
    const { headers } = await readSheet(buffer).catch(async () => {
      const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buffer);
      const h = []; wb.worksheets[0].getRow(1).eachCell((c, i) => { h[i - 1] = String(cellValue(c.value) ?? "").trim(); });
      return { headers: h };
    });
    if (!headers.some((h) => fieldOf(h) === "bin")) throw new Error("That doesn't look like the Append/Reset template: no Bin Code column.");
    return headers;
  }

  async function writeSheet(rows, headers) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet("Sheet1", { views: [{ state: "frozen", ySplit: 1 }] });
    ws.columns = headers.map((h) => ({ header: h, key: h, width: Math.max(10, Math.min(44, h.length + 2)) }));
    for (const r of rows) {
      ws.addRow(headers.map((h) => {
        const f = fieldOf(h);
        if (f === "mfg" || f === "exp") return r[f] ? utcDate(r[f]) : null;
        if (f === "qty") return Number(r.qty);
        return r[f] === "" || r[f] === undefined ? null : r[f];
      }));
    }
    headers.forEach((h, i) => { if (["mfg", "exp"].includes(fieldOf(h))) ws.getColumn(i + 1).numFmt = "dd/mm/yyyy"; });
    ws.getRow(1).font = { bold: true };
    return wb.xlsx.writeBuffer();
  }

  // ---- verify after upload ----------------------------------------------------------
  async function verify(whId, rows, prefix) {
    const binCodes = [...new Set(rows.map((r) => r.bin))];
    const actual = await q(wms, `SELECT "binCode", "skuCode", upper(trim(batch)) AS batch, uom, sum(qty)::float AS qty FROM inventory
      WHERE "whId" = $1 AND "deletedAt" IS NULL AND "binCode" = ANY($2) GROUP BY 1, 2, 3, 4`, [whId, binCodes]);
    const have = new Map(actual.map((a) => [`${a.binCode}|${a.skuCode}|${a.batch}|${a.uom}`, a.qty]));
    const want = new Map();
    rows.forEach((r) => { const k = `${r.bin}|${r.sku}|${upper(r.batch)}|${r.uom}`; want.set(k, (want.get(k) || 0) + Number(r.qty)); });
    const lines = [...want].map(([k, qty]) => {
      const [bin, sku, batch, uom] = k.split("|"), got = have.get(k) || 0;
      return { bin, sku, batch, uom, expected: qty, actual: got, status: got === 0 ? "missing" : got === qty ? "landed" : "different" };
    });
    const hus = [...new Set(rows.map((r) => r.hu).filter(Boolean))];
    let emptyHUs = [], err = null;
    if (prefix) {
      [emptyHUs, err] = await tryQ(wms, `SELECT h.code FROM handling_unit h WHERE h."whId" = $1 AND h.code LIKE $2
        AND NOT EXISTS (SELECT 1 FROM handling_unit_quant hq WHERE hq."huId" = h.id AND hq.qty > 0) ORDER BY h.code LIMIT 500`,
        [whId, prefix.replace(/[%_]/g, "\\$&") + "%"]);
    }
    const count = (s) => lines.filter((l) => l.status === s).length;
    return {
      lines: lines.filter((l) => l.status !== "landed").slice(0, 300),
      totals: { lines: lines.length, landed: count("landed"), missing: count("missing"), different: count("different"), hus: hus.length },
      emptyHUs: emptyHUs.map((h) => h.code), emptyHUError: err, prefix,
    };
  }

  // ---- test case builder -------------------------------------------------------------
  // grid rows arrive as plain JSON; give them the same shape readSheet produces
  function normalizeRows(list) {
    return list.map((r, i) => ({
      row: i + 2,
      bin: String(r.bin ?? "").trim(), hu: String(r.hu ?? "").trim(), hukind: String(r.hukind ?? "").trim(),
      sku: String(r.sku ?? "").trim(), qty: Number(r.qty), uom: upper(r.uom), bucket: String(r.bucket ?? "").trim(),
      inclusion: upper(r.inclusion), op: upper(r.op), batch: upper(r.batch), mfg: dayKeyOf(r.mfg), exp: dayKeyOf(r.exp),
    }));
  }

  // everything the pickers need, compact: bins with their stock, SKUs, batches, search table
  function catalog(m) {
    const bins = m.bins.map((b) => [b.code, b.zone, b.area, b.areaType, b.binType, b.huType, b.cap, b.status, b.level,
      b.multiSku, b.multiBatch, b.id, b.zoneId, b.areaId]);
    const stock = {};
    for (const [code, list] of m.occupied) stock[code] = list.map((x) => [x.skuCode, x.batch, x.uom, x.qty]);
    const skus = [...m.skus.values()].map((s) => [s.code, s.clazz, s.active, s.base, s.L0inL2, s.L2inL3, s.baseCode]);
    const batches = {};
    for (const b of m.batches.values()) {
      const k = `${b.sku_code}|${b.code}`;
      (batches[b.sku_code] ||= []).push([b.code, b.mfg, b.exp, b.active === true, m.prodParents.has(k), m.prodLots.has(k)]);
    }
    for (const list of Object.values(batches)) list.sort((a, b) => String(a[2]).localeCompare(String(b[2])));
    const search = {};
    // zone rules that ignore class ("*") apply to every class the page might look up
    const classes = [...new Set([...m.skus.values()].map((s) => s.clazz).filter(Boolean))];
    for (const [type, map] of Object.entries(m.search)) for (const [key, ids] of map) {
      for (const k of key.startsWith("*|") ? classes.map((c) => c + key.slice(1)) : [key]) (search[k] ||= {})[type[0]] = Object.fromEntries(ids);
    }
    return {
      whId: m.whId, loadedAt: m.loadedAt, today: todayKey(), suggestedPrefix: suggestPrefix(m), kinds: m.kinds,
      classType: m.classType, classSources: m.classSources,
      sessions: m.sessions, warnings: m.warnings, bins, stock, skus, batches, search,
    };
  }

  // ---- routes ----------------------------------------------------------------------
  const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };
  const isWh = (v) => /^\d+$/.test(String(v ?? ""));

  async function handle(req, res, u, send) {
    if (!u.pathname.startsWith("/api/inv/")) return false;
    // the list of checks is the same for every warehouse
    if (req.method === "GET" && u.pathname === "/api/inv/check-catalog") { send(res, 200, checksCatalog()); return true; }
    const whId = u.searchParams.get("whId") || "";
    if (!isWh(whId)) { send(res, 400, { error: "whId must be a number" }); return true; }
    const principalId = u.searchParams.get("principalId") || undefined;
    const route = `${req.method} ${u.pathname}`;

    if (route === "GET /api/inv/snapshot") {
      const m = await loadMasters(whId, { principalId, refresh: u.searchParams.get("refresh") === "1" });
      send(res, 200, { ...snapshot(m), template: { custom: hasTemplate(whId), headers: templateFor(whId) } });
    } else if (route === "POST /api/inv/build") {
      const o = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!o.huPrefix || !/^[A-Za-z0-9_-]{2,20}$/.test(o.huPrefix)) { send(res, 400, { error: "HU prefix must be 2 to 20 letters, digits, - or _." }); return true; }
      if (o.huLength !== undefined && o.huLength !== null) {
        const n = Number(o.huLength);
        if (!Number.isInteger(n) || n < o.huPrefix.length + 1 || n > 40) {
          send(res, 400, { error: `Pallet code length must be a whole number from ${o.huPrefix.length + 1} (the prefix plus one digit) to 40.` }); return true;
        }
      }
      const m = await loadMasters(whId, { principalId });
      const b = build(m, o);
      if (b.huCodes?.overflow) {
        const need = o.huPrefix.length + String(b.totals.newHUs).length;
        send(res, 400, { error: `This fill needs ${b.totals.newHUs.toLocaleString()} pallet codes, more than ${b.huCodes.digits} digit${b.huCodes.digits > 1 ? "s" : ""} can count. Make the pallet code length at least ${need}.` });
        return true;
      }
      const v = validate(m, b.rows, { shelfLifeDays: o.shelfLifeDays });
      const token = crypto.randomBytes(8).toString("hex");
      builds.set(token, { whId, rows: b.rows, headers: templateFor(whId), prefix: o.huPrefix, at: Date.now(), target: o.target, failed: v.failed });
      for (const [t, x] of builds) if (Date.now() - x.at > 6 * 3600000) builds.delete(t);
      send(res, 200, { token, ...b, rows: b.rows.slice(0, 200), validation: v });
    } else if (route === "GET /api/inv/download") {
      const b = builds.get(u.searchParams.get("token"));
      if (!b || b.whId !== whId) { send(res, 404, { error: "That fill has expired. Build it again." }); return true; }
      if (b.failed) { send(res, 409, { error: "This fill has failing checks, so it can't be downloaded." }); return true; }
      const buf = await writeSheet(b.rows, b.headers);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Append_Inventory_${whId}_${Math.round(Number(b.target) * 100)}pct_${b.prefix}.xlsx"`,
      });
      res.end(Buffer.from(buf));
    } else if (route === "POST /api/inv/check") {
      // fresh masters: the point is to check against the stock in the bins right now
      const buffer = await readBody(req);
      const sheet = await readSheet(buffer);
      const m = await loadMasters(whId, { principalId, refresh: true, skuCodes: sheet.rows.map((r) => r.sku) });
      const shelf = Number(u.searchParams.get("shelfLifeDays") || 180);
      const skip = new Set(String(u.searchParams.get("skip") || "").split(",").map((x) => x.trim()).filter(Boolean));
      const v = validate(m, sheet.rows, { headers: sheet.headers, sheetNames: sheet.sheetNames, shelfLifeDays: shelf, skip });
      const cons = consolidation(m, sheet.rows);
      const token = crypto.randomBytes(8).toString("hex");
      checked.set(token, { whId, buffer, v, cons, m, name: String(u.searchParams.get("name") || "sheet").replace(/\.xlsx$/i, ""), at: Date.now() });
      for (const [t, x] of checked) if (Date.now() - x.at > 2 * 3600000) checked.delete(t);
      send(res, 200, { rows: sheet.rows.length, ...v, token, loadedAt: m.loadedAt, consolidation: {
        isReset: cons.isReset, stats: cons.stats, zones: cons.zones, merges: cons.merges.slice(0, 100), moves: cons.moves.length,
        shelf: { groups: cons.shelf.groups, extraBins: cons.shelf.extraBins, top: cons.shelf.top.slice(0, 30) } } });
    } else if (route === "GET /api/inv/consolidate") {
      // fresh: the plan is only as good as the stock it was read from
      const m = await loadMasters(whId, { principalId, refresh: true });
      const [lk, lockErr] = await tryQ(wms, `SELECT "binCode", "huCode", "skuCode" AS sku, upper(trim(batch)) AS batch, uom, lock, sum(qty)::float AS qty
          FROM (SELECT *, ${LOCK_KIND} AS lock FROM inventory WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0) x
         WHERE lock <> '' GROUP BY 1, 2, 3, 4, 5, 6`, [whId, ZERO_ID]);
      // LOCKED: that pallet is left alone, and so is its bin (nothing in or out). PICK: that stock is leaving
      const locked = new Set(), busy = new Set(), leaving = new Map();
      for (const r of lk) {
        if (r.lock === "LOCKED") { busy.add(r.binCode); if (r.huCode) locked.add(r.huCode); continue; }
        const k = [r.binCode, r.huCode, r.sku, r.batch, r.uom].join("|");
        leaving.set(k, (leaving.get(k) || 0) + r.qty);
      }
      const cons = consolidation(m, [], { locked, busy, leaving });
      const pack = packBins(m, cons, locked, busy);
      const { files: im, held: imHeld } = imFiles(palletImRows(m, cons, pack, await palletLines(whId)), await wmsCapacity(whId, m));
      const token = crypto.randomBytes(8).toString("hex");
      plans.set(token, { whId, m, cons, pack, im, imHeld, at: Date.now() });
      for (const [t, x] of plans) if (Date.now() - x.at > 2 * 3600000) plans.delete(t);
      const freedIn = new Map();
      for (const b of [...cons.emptiedBins, ...pack.bins.map((x) => x.bin)]) { const z = m.binByCode.get(b)?.zone || "(no zone)"; freedIn.set(z, (freedIn.get(z) || 0) + 1); }
      send(res, 200, { token, loadedAt: m.loadedAt, lockError: lockErr ? "Couldn't read task locks on this schema, so locked pallets may appear in the plan." : null,
        stats: cons.stats, moves: cons.moves.length, merges: cons.merges.slice(0, 100),
        zones: cons.zones.map((z) => ({ ...z, binsFreed: freedIn.get(z.zone) || 0 })),
        pack: { stats: pack.stats, bins: pack.bins.slice(0, 100) }, im: imSummary(im), imHeld: imHeld.length,
        shelf: { groups: cons.shelf.groups, extraBins: cons.shelf.extraBins, top: cons.shelf.top.slice(0, 30) } });
    } else if (route === "GET /api/inv/consolidate-download") {
      const p = plans.get(u.searchParams.get("token"));
      if (!p || p.whId !== whId) { send(res, 404, { error: "That plan has expired. Run it again." }); return true; }
      const buf = await planWorkbook(p);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Consolidation_${whId}_${new Date(p.m.loadedAt).toISOString().slice(0, 10)}.xlsx"`,
      });
      res.end(Buffer.from(buf));
    } else if (route === "GET /api/inv/eaches-scope") {
      const m = await loadMasters(whId, { principalId });
      send(res, 200, { areas: eachesScope(m), binTypes: eachesTypes(m) });
    } else if (route === "GET /api/inv/consolidate-eaches") {
      // fresh: the plan is only as good as the stock it was read from
      const m = await loadMasters(whId, { principalId, refresh: true });
      const list = (k) => String(u.searchParams.get(k) || "").split(",").map((x) => x.trim()).filter(Boolean);
      const opts = { areas: list("areas"), zones: list("zones"), crossZone: u.searchParams.get("crossZone") === "1",
        fillPct: Number(u.searchParams.get("fillPct")) || 100, checkWeight: u.searchParams.get("checkWeight") !== "0",
        binTypes: list("binTypes"), uoms: list("uoms").length ? list("uoms") : ["L0"], emptyBelowPct: Number(u.searchParams.get("emptyBelowPct")) || 100 };
      const input = await eachesInput(whId, m);
      const plan = eachesPlan(input, opts);
      const check = validatePlan(input, plan); // a second, independent pass over every move
      const { files: im, held: imHeld } = imFiles(eachesImRows(plan), await wmsCapacity(whId, m));
      const token = crypto.randomBytes(8).toString("hex");
      eachPlans.set(token, { whId, m, plan, check, im, imHeld, at: Date.now() });
      for (const [t, x] of eachPlans) if (Date.now() - x.at > 2 * 3600000) eachPlans.delete(t);
      send(res, 200, { token, loadedAt: m.loadedAt, opts: plan.opts, stats: plan.stats, check: { ok: check.ok, errs: check.errs.slice(0, 10) }, im: imSummary(im), imHeld: imHeld.length,
        fixedError: input.fixedError ? "Couldn't read fixed bin mappings on this schema, so fixed bins may appear in the plan." : null,
        moves: plan.moves.slice(0, 400), emptied: plan.emptied.length, targets: plan.targets.length,
        leftOut: plan.leftOut.slice(0, 200), leftOutCount: plan.leftOut.length,
        leftOutBy: plan.leftOut.reduce((t, x) => ({ ...t, [x.reason]: (t[x.reason] || 0) + 1 }), {}) });
    } else if (route === "GET /api/inv/relocate-scope") {
      const m = await loadMasters(whId, { principalId, refresh: u.searchParams.get("refresh") === "1" });
      send(res, 200, { areas: relocateScope(m) });
    } else if (route === "GET /api/inv/relocate") {
      const list = (k) => String(u.searchParams.get(k) || "").split(",").map((x) => x.trim()).filter(Boolean);
      const opts = { from: { cells: list("from") }, to: { cells: list("to") }, belowPct: Number(u.searchParams.get("belowPct")) || 100,
        useEmpty: u.searchParams.get("useEmpty") || "smaller", checkWeight: u.searchParams.get("checkWeight") !== "0" };
      if (!opts.from.cells.length || !opts.to.cells.length) { send(res, 400, { error: "Tick at least one bin type on each side: bins to empty, and bins to move into." }); return true; }
      // fresh: the plan is only as good as the stock it was read from
      const m = await loadMasters(whId, { principalId, refresh: true });
      const cap = await wmsCapacity(whId, m);
      const input = await relocateInput(whId, m, cap);
      const plan = relocatePlan(input, opts);
      const check = validateRelocate(input, plan); // a second, independent replay of every step
      const { files: im, held: imHeld } = imFiles(relocateImRows(plan), cap);
      const token = crypto.randomBytes(8).toString("hex");
      relocPlans.set(token, { whId, m, plan, check, im, imHeld, at: Date.now() });
      for (const [t, x] of relocPlans) if (Date.now() - x.at > 2 * 3600000) relocPlans.delete(t);
      send(res, 200, { token, loadedAt: m.loadedAt, opts: plan.opts, stats: plan.stats, check: { ok: check.ok, errs: check.errs.slice(0, 10) }, im: imSummary(im), imHeld: imHeld.length,
        fixedError: input.fixedError ? "Couldn't read fixed bin mappings on this schema, so fixed bins may appear in the plan." : null,
        moves: plan.moves.slice(0, 500), emptied: plan.emptied.slice(0, 500), notEmptied: plan.notEmptied.slice(0, 300), notEmptiedCount: plan.notEmptied.length,
        notEmptiedBy: plan.notEmptied.reduce((t, x) => { const k = x.why.startsWith("No bin takes") ? "No bin can take its stock" : x.why; return { ...t, [k]: (t[k] || 0) + 1 }; }, {}) });
    } else if (route === "GET /api/inv/relocate-download") {
      const p = relocPlans.get(u.searchParams.get("token"));
      if (!p || p.whId !== whId) { send(res, 404, { error: "That plan has expired. Run it again." }); return true; }
      const buf = await relocateWorkbook(p);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Bins_under_${p.plan.opts.belowPct}pct_${whId}_${new Date(p.m.loadedAt).toISOString().slice(0, 10)}.xlsx"`,
      });
      res.end(Buffer.from(buf));
    } else if (route === "GET /api/inv/consolidate-eaches-download") {
      const p = eachPlans.get(u.searchParams.get("token"));
      if (!p || p.whId !== whId) { send(res, 404, { error: "That plan has expired. Run it again." }); return true; }
      const buf = await eachesWorkbook(p);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Eaches_consolidation_${whId}_${new Date(p.m.loadedAt).toISOString().slice(0, 10)}.xlsx"`,
      });
      res.end(Buffer.from(buf));
    } else if (route === "GET /api/inv/im-download") {
      // one IM cockpit upload file of a plan, as Sheet1 alone
      const kind = u.searchParams.get("plan");
      const p = ({ pallet: plans, eaches: eachPlans, relocate: relocPlans })[kind]?.get(u.searchParams.get("token"));
      if (!p || p.whId !== whId) { send(res, 404, { error: "That plan has expired. Run it again." }); return true; }
      if (p.check && !p.check.ok) { send(res, 409, { error: "The plan failed its re-check, so it can't be uploaded." }); return true; }
      const file = p.im.find((x) => x.n === Number(u.searchParams.get("file") || 1));
      if (!file) { send(res, 404, { error: "That plan has no such upload file." }); return true; }
      const buf = await imWorkbook(file);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="IM_upload_${kind}_${file.n}_of_${p.im.length}_${whId}_${new Date(p.m.loadedAt).toISOString().slice(0, 10)}.xlsx"`,
      });
      res.end(Buffer.from(buf));
    } else if (route === "GET /api/inv/check-download") {
      const c = checked.get(u.searchParams.get("token"));
      if (!c || c.whId !== whId) { send(res, 404, { error: "That check has expired. Drop the sheet again." }); return true; }
      const buf = await annotatedSheet(c.m, c.buffer, c.v, c.cons);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Checked_${c.name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60)}_${whId}.xlsx"`,
      });
      res.end(Buffer.from(buf));
    } else if (route === "POST /api/inv/verify") {
      const token = u.searchParams.get("token");
      let rows, prefix = u.searchParams.get("prefix") || "";
      if (token) {
        const b = builds.get(token);
        if (!b || b.whId !== whId) { send(res, 404, { error: "That fill has expired. Drop the uploaded file instead." }); return true; }
        rows = b.rows; prefix = prefix || b.prefix;
      } else if (/json/.test(req.headers?.["content-type"] || "")) {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        rows = normalizeRows(body.rows || []);
        prefix = prefix || body.prefix || "";
      } else {
        rows = (await readSheet(await readBody(req))).rows;
      }
      send(res, 200, await verify(whId, rows, prefix));
    } else if (route === "POST /api/inv/parse") {
      const sheet = await readSheet(await readBody(req));
      send(res, 200, { rows: sheet.rows, headers: sheet.headers });
    } else if (route === "GET /api/inv/catalog") {
      const m = await loadMasters(whId, { principalId, refresh: u.searchParams.get("refresh") === "1" });
      send(res, 200, catalog(m));
    } else if (route === "POST /api/inv/validate-rows") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const rows = normalizeRows(body.rows || []);
      const m = await loadMasters(whId, { principalId, skuCodes: rows.map((r) => r.sku) });
      send(res, 200, validate(m, rows, { shelfLifeDays: body.shelfLifeDays ?? 0, mode: "testcase" }));
    } else if (route === "POST /api/inv/export") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const rows = normalizeRows(body.rows || []);
      const m = await loadMasters(whId, { principalId, skuCodes: rows.map((r) => r.sku) });
      if (!rows.length) { send(res, 400, { error: "Add at least one row first." }); return true; }
      const v = validate(m, rows, { shelfLifeDays: body.shelfLifeDays ?? 0, mode: "testcase" });
      if (v.failed) { send(res, 409, { error: `${v.failed} check${v.failed > 1 ? "s" : ""} still fail. Fix the highlighted rows first.` }); return true; }
      const buf = await writeSheet(rows, templateFor(whId));
      const name = String(body.name || "test-case").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="TC_${name}_${whId}.xlsx"`,
      });
      res.end(Buffer.from(buf));
    } else if (route === "POST /api/inv/template") {
      const headers = await templateHeaders(await readBody(req));
      fs.mkdirSync(TEMPLATE_DIR, { recursive: true });
      fs.writeFileSync(path.join(TEMPLATE_DIR, `${whId}.json`), JSON.stringify(headers, null, 2));
      send(res, 200, { headers });
    } else {
      send(res, 404, { error: "not found" });
    }
    return true;
  }
  // the encarta principal behind a warehouse, for the master checks
  handle.principalOf = async (whId) => (await loadMasters(whId)).principalId;
  handle.loadMasters = loadMasters;
  return handle;
};
