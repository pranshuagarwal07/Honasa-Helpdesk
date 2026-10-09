// Task locks on stock, as SQL over the inventory view, and the read the pallet plan uses.
// what holds a stock line, from the inventory view ($2 = the all-zero task id the WMS uses for "none"):
// PICK = a pick task is taking it out (lockMode PICK); LOCKED = anything else: the HU is locked by a task,
// stock is arriving (PUT), FLOATING, BLOCKED, or a task holds the quant; '' = free
const LOCK_KIND = `CASE WHEN "huLockTaskId" IS NOT NULL AND "huLockTaskId"::text <> $2 THEN 'LOCKED'
  WHEN "quantLockMode" = 'PICK' THEN 'PICK'
  WHEN ("quantLockMode" IS NOT NULL AND "quantLockMode" <> 'NONE') OR ("lockedByTaskId" IS NOT NULL AND "lockedByTaskId"::text <> $2) THEN 'LOCKED'
  ELSE '' END`;
const ZERO_ID = "00000000-0000-0000-0000-000000000000";

// Stock a task holds, for the pallet plan. db = { wms, tryQ }.
// LOCKED: that pallet is left alone, and so is its bin (nothing in or out). PICK: that stock is leaving.
// lockError is set when this schema can't be read for locks (the plan then runs without them).
async function palletLocks({ wms, tryQ }, whId) {
  const [lk, lockErr] = await tryQ(wms, `SELECT "binCode", "huCode", "skuCode" AS sku, upper(trim(batch)) AS batch, uom, lock, sum(qty)::float AS qty
          FROM (SELECT *, ${LOCK_KIND} AS lock FROM inventory WHERE "whId" = $1 AND "deletedAt" IS NULL AND qty > 0) x
         WHERE lock <> '' GROUP BY 1, 2, 3, 4, 5, 6`, [whId, ZERO_ID]);
  const locked = new Set(), busy = new Set(), leaving = new Map();
  for (const r of lk) {
    if (r.lock === "LOCKED") { busy.add(r.binCode); if (r.huCode) locked.add(r.huCode); continue; }
    const k = [r.binCode, r.huCode, r.sku, r.batch, r.uom].join("|");
    leaving.set(k, (leaving.get(k) || 0) + r.qty);
  }
  return { locked, busy, leaving, lockError: lockErr };
}

module.exports = { LOCK_KIND, ZERO_ID, palletLocks };
