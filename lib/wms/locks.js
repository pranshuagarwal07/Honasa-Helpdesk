// Task locks on stock, as SQL over the inventory view, the read the pallet plan uses, and bins held by a task
// read from the HU tables themselves (binLocks, for bins under % full).
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

// Bins with stock arriving or held by a task, straight from the HU tables rather than the inventory table (a
// projection the WMS keeps in step with them; on PROD on 10 Oct it carried every lock, but a plan must not depend
// on that). PUT = stock arriving (an inbound putaway or IM drop slotted there), FLOATING / BLOCKED / any other mode
// or a task on a mode-NONE quant = held; an HU locked by a task (lockTaskId) = the whole pallet is held. PICK quants
// are left out: that stock is leaving, and the planners read it from the inventory table as such.
// who = the session or task code holding it (an inbound session locks with its own id, so the session code shows).
// Returns { busy: Map binCode -> [{ hu, mode, qty, who }], error } — error set when this schema has no such tables
// (the planners then rely on the inventory table's lock columns alone).
async function binLocks({ wms, tryQ }, whId) {
  const [[qs, qErr], [hs, hErr]] = await Promise.all([
    tryQ(wms, `SELECT b.code AS "binCode", h.code AS "huCode", coalesce(q."lockMode", 'NONE') AS mode, sum(q.qty)::float AS qty,
                  coalesce(s.code, t.code, q."lockedByTaskId"::text) AS who
             FROM handling_unit_quant q JOIN storage_bin b ON b.id = q."effectiveStorageId" LEFT JOIN handling_unit h ON h.id = q."huId"
             LEFT JOIN session s ON s.id = q."lockedByTaskId" LEFT JOIN task t ON t.id = q."lockedByTaskId"
            WHERE q."whId" = $1 AND q.qty <> 0 AND ((q."lockMode" IS NOT NULL AND q."lockMode" NOT IN ('NONE', 'PICK'))
               OR (coalesce(q."lockMode", 'NONE') = 'NONE' AND q."lockedByTaskId" IS NOT NULL AND q."lockedByTaskId"::text <> $2))
            GROUP BY 1, 2, 3, 5`, [whId, ZERO_ID]),
    tryQ(wms, `SELECT b.code AS "binCode", h.code AS "huCode", 'HU' AS mode, 0 AS qty, coalesce(s.code, t.code, h."lockTaskId"::text) AS who
             FROM handling_unit h JOIN storage_bin b ON b.id = h."effectiveStorageId"
             LEFT JOIN session s ON s.id = h."lockTaskId" LEFT JOIN task t ON t.id = h."lockTaskId"
            WHERE h."whId" = $1 AND h.state = 'inside' AND h."lockTaskId" IS NOT NULL AND h."lockTaskId"::text <> $2`, [whId, ZERO_ID]),
  ]);
  const busy = new Map();
  for (const r of [...qs, ...hs]) {
    if (!busy.has(r.binCode)) busy.set(r.binCode, []);
    busy.get(r.binCode).push({ hu: r.huCode || null, mode: r.mode, qty: Number(r.qty) || 0, who: r.who || "" });
  }
  return { busy, error: qErr || hErr || null };
}

module.exports = { LOCK_KIND, ZERO_ID, palletLocks, binLocks };
