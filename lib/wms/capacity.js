// WMS bin capacity, as an IM upload checks it.
// cincout internal-movement.route.ts:243-246: the destination bin's stock plus every row of the
// upload going into it, each unit counted by commons calculateBinVolumeUsageForQK, must total
// 100% or less. One unit: 1 / bin type best fit for the SKU+UOM; else with a pallet capacity,
// L3 = 1 / capacity and other UOMs (when useDerivedPalletBestFit, default on) 1 / floor(capacity x
// units per L3); else the unit's volume over the bin type's maxVolumeInCC.
// One unit's share of a bin: t = the bin type { palletCapacity, maxVolumeInCC, useDerivedPalletBestFit },
// s = the SKU from loadMasters (units and vols per UOM), bf = the bin type's best fit for this SKU + UOM.
function unitShare(t, s, uom, bf) {
  const pc = Number(t.palletCapacity);
  const inL3 = s?.units?.L3 > 0 && s?.units?.[uom] > 0 ? s.units.L3 / s.units[uom] : 0;
  const vol = s?.vols?.[uom] > 0 && Number(t.maxVolumeInCC) > 0 ? s.vols[uom] / Number(t.maxVolumeInCC) : 0;
  return bf > 0 && Number.isSafeInteger(bf) ? 1 / bf
    : pc > 0 && uom === "L3" ? 1 / pc
    : pc > 0 && t.useDerivedPalletBestFit !== false && inL3 > 0 ? 1 / Math.floor(pc * inL3)
    : vol;
}

// db = { wms, tryQ }. Returns { unit(binCode, sku, uom) -> share of the bin, stock: binCode -> lines }.
async function wmsCapacity({ wms, tryQ }, whId, m) {
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
    const u = unitShare(t, m.skus.get(sku), uom, bestFit.get(k));
    memo.set(k, u);
    return u;
  };
  // what each bin holds now, every quant (the check doesn't skip locked stock)
  const stock = new Map([...m.occupied].map(([bin, ls]) => [bin, ls.map((l) => ({ sku: l.skuCode, uom: l.uom, qty: l.qty }))]));
  return { unit, stock };
}

module.exports = { wmsCapacity, unitShare };
