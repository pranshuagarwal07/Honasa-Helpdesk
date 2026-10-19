// What the shelf and bins-under-%-full planners read before they run: the area / zone / bin type
// pickers, and the stock line by line with what their rules need. Functions that read the
// database take db = { wms, q, tryQ } first.
const { LOCK_KIND, ZERO_ID, binLocks } = require("../wms/locks");
const { allowedSeq } = require("../wms/search");

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
// stock pallet by pallet with what the rules need: bucket, price, owner, task locks; plus bins a task holds (read
// from the HU tables too, see binLocks) and empty pallets: an HU in a bin with no stock on it. The inventory table
// leaves those out and the WMS ignores them, but the floor can't put a pallet into a position one stands in.
async function relocateInput({ wms, q, tryQ }, whId, m, cap) {
  const [inv, fixed, locks, [empties, emptyErr]] = await Promise.all([
    q(wms, `SELECT "binCode", "huCode", "skuCode", upper(trim(batch)) AS batch, bucket, "inclusionStatus" AS inclusion, uom, price::float AS price, iloc,
                 ${LOCK_KIND} AS lock, sum(qty)::float AS qty
               FROM inventory WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9, 10`, [whId, ZERO_ID]),
    tryQ(wms, 'SELECT b.code FROM storage_bin_fixed_mapping f JOIN storage_bin b ON b.id = f."binId" WHERE f."whId" = $1 AND f.active', [whId]),
    binLocks({ wms, tryQ }, whId),
    // an outer HU with inner HUs isn't empty: its stock sits on the inner ones (and shows in inventory)
    tryQ(wms, `SELECT b.code AS "binCode", h.code AS "huCode" FROM handling_unit h JOIN storage_bin b ON b.id = h."effectiveStorageId"
               WHERE h."whId" = $1 AND h.state = 'inside' AND h.code NOT LIKE 'BIN\_HU\_%'
                 AND NOT EXISTS (SELECT 1 FROM handling_unit_quant x WHERE x."huId" = h.id AND x.qty > 0)
                 AND NOT EXISTS (SELECT 1 FROM handling_unit i WHERE i."outerHuId" = h.id)`, [whId]),
  ]);
  const fixedSet = new Set(fixed[0].map((r) => r.code));
  const emptyPallets = new Map();
  for (const r of empties) { if (!emptyPallets.has(r.binCode)) emptyPallets.set(r.binCode, []); emptyPallets.get(r.binCode).push(r.huCode); }
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
    busy: locks.busy, emptyPallets,
    fixedError: fixed[1], lockError: locks.error, emptyPalletError: emptyErr,
  };
}

// the stock line by line with what the shelf rules need: bucket, price, owner, task locks; plus bins a task holds,
// read from the HU tables too (binLocks), and the WMS capacity check (cap = wmsCapacity(), optional)
async function eachesInput({ wms, q, tryQ }, whId, m, cap) {
  const [inv, fixed, locks] = await Promise.all([
    q(wms, `SELECT "binCode", "skuCode", upper(trim(batch)) AS batch, bucket, "inclusionStatus" AS inclusion, uom, price::float AS price, iloc,
                 ${LOCK_KIND} AS lock, sum(qty)::float AS qty
               FROM inventory WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0 GROUP BY 1, 2, 3, 4, 5, 6, 7, 8, 9`, [whId, ZERO_ID]),
    // a bin mapped to a SKU, EAN or product is left alone
    tryQ(wms, 'SELECT b.code FROM storage_bin_fixed_mapping f JOIN storage_bin b ON b.id = f."binId" WHERE f."whId" = $1 AND f.active', [whId]),
    binLocks({ wms, tryQ }, whId),
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
    busy: locks.busy, wmsUnit: cap?.unit,
    fixedError: fixed[1], lockError: locks.error,
  };
}

module.exports = { eachesScope, eachesTypes, relocateScope, relocateInput, eachesInput };
