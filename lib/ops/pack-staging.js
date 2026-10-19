// API trigger: pack pallet -> staging (ISS-1701).
// Cartons packed on a pallet at a pack station sometimes never get a move-to-staging task. The device's
// "Move to Next Task" publishes ob-pack.hu.completed; publishing it ourselves on wms-outbox does the same.
//
// The check mirrors the consumer, cincout provisional-pack-staging.event.ts handlePackHUCompleted
// (traced 2026-10-19). It returns 200 OK from the outbox either way and then quietly does nothing when:
//  - the task isn't an active OUTBOUND_PACK, or its session is COMPLETED / CANCELLED
//  - the pack task's attrs.pickStrat isn't PICK_BY_CUSTOMER / PICK_BY_INVOICE
//  - the pallet has no bin
//  - no ob_pack_chu row for (session, pallet) has a packed item of this task without an
//    OUTBOUND_STAGING / STAGING_SEGREGATION row for (session, pallet, carton) already
// So a second publish is harmless (everything is already staged), and the only proof it worked is
// the staging rows appearing. It doesn't close the worker's open pallet (pd_pick_drop_active_hu).
// Reads only; send() is the one write, and the caller refuses it on read-only environments.
const EVENT = "ob-pack.hu.completed";
const STAGE = `"taskKind" = 'OUTBOUND_STAGING' AND "taskSubKind" = 'STAGING_SEGREGATION'`;
const PICK_STRATS = ["PICK_BY_CUSTOMER", "PICK_BY_INVOICE"];
const ENDED = ["COMPLETED", "CANCELLED"];

module.exports = function packStaging({ wms, q, tryQ, OUTBOX }) {
  async function check(whId, taskCode, palletCode) {
    const W = String(whId), T = String(taskCode || "").trim(), P = String(palletCode || "").trim();
    if (!T || !P) throw new Error("Enter the pack task code and the pallet code.");
    const [[task], [pallet]] = await Promise.all([
      q(wms, `SELECT t.id::text AS id, t.code, t.kind, t.state, t.active, t.attrs->>'pickStrat' AS "pickStrat", t.attrs->>'zoneCode' AS zone,
                     s.id::text AS "sessionId", s.code AS session, s.state AS "sessionState"
                FROM task t JOIN session s ON s.id = t."sessionId"
               WHERE t."whId" = $1 AND upper(t.code) = upper($2) ORDER BY t.active DESC, t."createdAt" DESC LIMIT 1`, [W, T]),
      q(wms, `SELECT h.id::text AS id, h.code, h.state, b.code AS bin
                FROM handling_unit h LEFT JOIN storage_bin b ON b.id = h."storageId"
               WHERE h."whId" = $1 AND upper(h.code) = upper($2) ORDER BY h."updatedAt" DESC LIMIT 1`, [W, P]),
    ]);
    if (!task) throw new Error(`No task ${T} in warehouse ${W}. Pack task codes look like OUTBOUND-97-4.`);
    if (!pallet) throw new Error(`No pallet ${P} in warehouse ${W}. Pallet codes look like PBL0309.`);

    // every carton packed onto this pallet in this session, with what the handler would make of it
    const [cartons, [open], [stagingTasks]] = await Promise.all([
      // one row per carton: a carton can have more than one pack row (this task's wins)
      q(wms, `SELECT * FROM (
              SELECT DISTINCT ON (pc."packingCHUId") pc."createdAt" AS at,
                     pc."packingCHUCode" AS carton, pk.code AS task, (pc."taskId" = $3) AS "thisTask",
                     (c."outerHuId" = $2) AS "onPallet", oh.code AS "nowOn", ob.code AS "nowIn",
                     EXISTS (SELECT 1 FROM ob_pack_item pi WHERE pi."taskId" = $3 AND pi."packedAt" IS NOT NULL
                              AND (pi."obPackCHUId" = pc.id OR pi."chuId" = pc."packingCHUId")) AS packed,
                     (SELECT sp.state FROM pd_provisional_item sp WHERE sp."sessionId" = pc."sessionId" AND sp."huId" = $2
                         AND sp."innerHUId" = pc."packingCHUId" AND ${STAGE} ORDER BY sp."createdAt" DESC LIMIT 1) AS staging,
                     i.code AS invoice,
                     (SELECT string_agg(DISTINCT g.status, '/') FROM ob_gin g WHERE g."invoiceId" = i.id) AS gin
                FROM ob_pack_chu pc
                JOIN task pk ON pk.id = pc."taskId"
                LEFT JOIN handling_unit c ON c.id = pc."packingCHUId"
                LEFT JOIN handling_unit oh ON oh.id = c."outerHuId"
                LEFT JOIN storage_bin ob ON ob.id = oh."storageId"
                LEFT JOIN invoice i ON i.id::text = pc."identifierId"
               WHERE pc."sessionId" = $1 AND pc."carrierHUId" = $2
               ORDER BY pc."packingCHUId", (pc."taskId" = $3) DESC, pc."createdAt" DESC) x
             ORDER BY at`, [task.sessionId, pallet.id, task.id]),
      tryQ(wms, `SELECT a."workerId"::text AS worker, t.code AS task FROM pd_pick_drop_active_hu a LEFT JOIN task t ON t.id = a."taskId"
                  WHERE a."huId" = $1`, [pallet.id]),
      // staging tasks of the session that haven't finished: where staged cartons wait for a worker
      tryQ(wms, `SELECT code, state, "createdAt" FROM task WHERE "sessionId" = $1 AND kind = 'OUTBOUND_STAGING' AND active
                   AND state NOT IN ('COMPLETED', 'CANCELLED') ORDER BY "createdAt"`, [task.sessionId]),
    ]);
    // cartons on the pallet now, and which session/task packed them (a pallet often carries several tasks)
    const [onPallet] = await tryQ(wms, `
      SELECT c.code AS carton, pk.code AS task, s.code AS session
        FROM handling_unit c
        LEFT JOIN LATERAL (SELECT "taskId", "sessionId" FROM ob_pack_chu WHERE "packingCHUId" = c.id ORDER BY "createdAt" DESC LIMIT 1) pc ON true
        LEFT JOIN task pk ON pk.id = pc."taskId" LEFT JOIN session s ON s.id = pc."sessionId"
       WHERE c."outerHuId" = $1 ORDER BY c.code`, [pallet.id]);

    const toStage = cartons.filter((c) => c.thisTask && c.packed && !c.staging);
    const staged = cartons.filter((c) => c.staging);
    const otherTasks = [...new Set((onPallet || []).filter((c) => c.task && c.task.toUpperCase() !== task.code.toUpperCase()).map((c) => c.task))];
    const sentGin = [...new Set(toStage.filter((c) => /SENT|ACKED/.test(c.gin || "")).map((c) => `${c.invoice} ${c.gin}`))];

    const items = [];
    const add = (level, title, detail = "") => items.push({ level, title, detail });
    if (task.kind !== "OUTBOUND_PACK") add("fail", `${task.code} is an ${task.kind} task, not a pack task`, "The event only acts on OUTBOUND_PACK tasks.");
    else if (!task.active || ENDED.includes(task.state)) add("fail", `Pack task is ${task.state}${task.active ? "" : ", inactive"}`, "The event does nothing for a finished task. Escalate.");
    else add("pass", `Pack task ${task.code} is ${task.state}`);
    if (ENDED.includes(task.sessionState)) add("fail", `Session ${task.session} is ${task.sessionState}`, "The event does nothing once the session has ended. Escalate.");
    else add("pass", `Session ${task.session} is ${task.sessionState}`);
    if (task.kind === "OUTBOUND_PACK" && !PICK_STRATS.includes(task.pickStrat))
      add("fail", `Pack task's pick strategy is ${task.pickStrat || "not set"}`, "The event only stages for PICK_BY_CUSTOMER or PICK_BY_INVOICE.");
    if (!pallet.bin) add("fail", `${pallet.code} isn't in a bin`, "Staging can't start from nowhere. Re-drop the pallet at the pack station first.");
    else if (/^PCK-ST/i.test(pallet.bin)) add("pass", `${pallet.code} is at pack station ${pallet.bin}`);
    else add("warn", `${pallet.code} is in ${pallet.bin}, not a pack station`, "The runbook expects the pallet at a PCK-ST bin. Check it hasn't already been moved.");
    if (toStage.length) add("pass", `${toStage.length} carton${toStage.length > 1 ? "s" : ""} packed by ${task.code} without a staging row`);
    else if (otherTasks.length) add("fail", `${task.code} has no cartons waiting on ${pallet.code}`,
      `The cartons on it now were packed by ${otherTasks.join(", ")}. Check ${otherTasks.length > 1 ? "those task codes" : "that task code"} instead.`);
    else if (staged.length) add("fail", "Nothing left to stage: every carton already has a staging row",
      "Look for a waiting OUTBOUND_STAGING task instead. Sending again does nothing.");
    else add("fail", `${task.code} packed nothing onto ${pallet.code}`, "Check the task and pallet codes. If the cartons have left the pallet, there is nothing to trigger.");
    if (sentGin.length) add("warn", `GIN already ${sentGin.length > 1 ? "sent for" : "sent:"} ${sentGin.join(", ")}`,
      "The ERP already counts these cartons as dispatched. Triggering moves them physically but changes nothing in the ERP: report them to ops.");
    if (open?.length) add("warn", `${pallet.code} is still a worker's open pallet (on ${open.map((o) => o.task || "?").join(", ")})`,
      "The trigger doesn't close it. It can't go on another pack task until that worker presses Move to Next Task or the pack task completes.");

    const payload = { taskId: task.id, huId: pallet.id };
    return {
      event: EVENT, outbox: OUTBOX || null, task, pallet, payload,
      ready: !items.some((i) => i.level === "fail"),
      items, cartons, onPallet: onPallet || [], stagingTasks: stagingTasks || [], openBy: open || [],
      counts: { toStage: toStage.length, staged: staged.length, onPallet: (onPallet || []).length },
      checkedAt: new Date().toISOString(),
    };
  }

  // the one write: publish the event on wms-outbox, then read the pallet again to show what changed
  async function send(whId, taskCode, palletCode) {
    if (!OUTBOX) throw new Error("No wms-outbox address for this environment. Add \"outbox\" to its entry in config/envs.json.");
    const before = await check(whId, taskCode, palletCode);
    if (!before.ready) return { sent: false, reason: "The checks don't pass, so the event would do nothing. Nothing was sent.", after: before };
    let status, body;
    try {
      const r = await fetch(`${OUTBOX}/outbox/event-bus/publish/${EVENT}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(before.payload), signal: AbortSignal.timeout(30000),
      });
      status = r.status; body = (await r.text()).slice(0, 2000);
    } catch (e) { status = 0; body = `request failed: ${e.message} (on VPN?)`; }
    // the consumer runs off a queue; give it a moment before reading the staging rows back
    if (status === 200) await new Promise((r) => setTimeout(r, 4000));
    return { sent: status === 200, status, body, after: await check(whId, taskCode, palletCode) };
  }

  return { check, send, EVENT };
};
