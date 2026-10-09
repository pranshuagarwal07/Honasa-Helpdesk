// What the inventory page shows about a warehouse: the snapshot, and the compact catalog the
// test case pickers use (bins with their stock, SKUs, batches, search table).
const crypto = require("crypto");
const { todayKey } = require("../core/util");

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

module.exports = { snapshot, suggestPrefix, catalog };
