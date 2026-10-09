// Master data for one warehouse, live from the WMS and encarta databases instead of nine Excel
// exports: areas, zones, bin types, bins, the search table, stock, HU codes and kinds, open
// sessions, and encarta's SKUs, UOMs, batches, production batches and classes.
// Port of the appendinv skill's loading step; the rules and their sources are in that skill's SKILL.md.
const { upper } = require("../core/util");

const SESSION_EXEMPT = ["INTERNAL_MOVEMENT_HOLDING", "DWS", "HU_SCAN_EXCEPTION", "OUTBOUND_HOLDING"];
const KNOWN_IDENTIFIERS = new Set(["skuClass", "skuClassType", "uom", "bucket"]);

// db = { wms, encarta, q, tryQ }. Returns loadMasters(whId, { principalId, refresh, skuCodes }),
// which caches each warehouse for 10 minutes.
function createMastersLoader({ wms, encarta, q, tryQ }) {
  const cache = new Map(); // whId -> { at, m }

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
  return loadMasters;
}

module.exports = { createMastersLoader };
