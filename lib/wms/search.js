// The storage search table: which zones putaway lets a class + UOM + bucket into. loadMasters
// builds m.search from storage_search_index (see wms/load-masters.js); these read it.
const { upper } = require("../core/util");

// search index isn't checked in these working areas — and we never seed stock into them
const EXEMPT_AREAS = new Set(["PICK_AND_DROP", "STAGING", "REJECT"]);

// lowest search sequence allowing class+uom+bucket in this bin, or null
function allowedSeq(m, bin, clazz, uom, bucket) {
  const key = `${m.searchClassFree ? "*" : upper(clazz)}|${upper(uom)}|${upper(bucket)}`;
  const s = m.search.ZONE.get(key)?.get(String(bin.zoneId));
  return s === undefined ? null : s;
}
const zoneSeq = (m, zoneBin, clazz, uom, bucket) => allowedSeq(m, zoneBin, clazz, uom, bucket);

module.exports = { EXEMPT_AREAS, allowedSeq, zoneSeq };
