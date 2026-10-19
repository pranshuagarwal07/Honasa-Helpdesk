// API trigger: re-run drop slotting (putaway "Destination Bin Not Found").
// Publishing pick-drop-provisional.drop.slotting.v2 {whId} on wms-outbox re-runs destination slotting for the
// whole warehouse. There's no cron: a failed row only gets another go when a carrier HU forms or someone publishes this.
//
// The check mirrors the consumer, cincout provisional-slotting-drop-v2.event.ts (traced 2026-10-19). A run only
// picks up provisional rows that are:
//  - in a session that is ONGOING or PENDING and active
//  - not deactivated, with no path and no destination zone yet, with a source bin, and a pick HU or a formed carrier HU
// Everything else is skipped quietly. attrs.reason ("Destination Bin Not Found") is diagnostics only: it doesn't block
// a retry, but if no eligible bin has freed up since, the retry fails the same way. Runs hold a per-warehouse lock and
// re-read rows inside it, so sending twice is harmless. It covers every task kind, not just putaway.
// Reads only; send() is the one write, and the caller refuses it on read-only environments.
const EVENT = "pick-drop-provisional.drop.slotting.v2";
const LIVE = `s.active AND s.state IN ('ONGOING', 'PENDING')`;
const PICKED_UP = `p."pathAssignedAt" IS NULL AND p."destZoneId" IS NULL AND p."sourceBinId" IS NOT NULL
  AND (p."pickHU" IS TRUE OR p."carrierHUFormedId" IS NOT NULL)`;

module.exports = function slottingRetrigger({ wms, q, OUTBOX }) {
  async function check(whId) {
    const W = [String(whId)];
    const [eligible, putaway] = await Promise.all([
      // what a run would retry, per session and task kind
      q(wms, `SELECT s.code AS session, s.kind, s.state, p."taskKind" AS "taskKind", count(*)::int AS rows,
                     count(DISTINCT p."huId")::int AS hus, string_agg(DISTINCT p."huCode", ', ') AS pallets,
                     count(*) FILTER (WHERE p.attrs->>'reason' IS NOT NULL)::int AS failed,
                     string_agg(DISTINCT p.attrs->>'reason', ', ') AS reasons,
                     to_char(min(p."createdAt") AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS since
                FROM pd_provisional_item p JOIN session s ON s.id = p."sessionId"
               WHERE p."whId" = $1 AND p."deactivatedAt" IS NULL AND ${LIVE} AND ${PICKED_UP}
               GROUP BY 1, 2, 3, 4 ORDER BY min(p."createdAt")`, W),
      // inbound putaway rows with no destination bin, per pallet, with why a run would or wouldn't touch them
      q(wms, `SELECT s.code AS session, s.state, p."huCode" AS pallet, count(*)::int AS rows,
                     CASE WHEN NOT (${LIVE}) THEN 'ended'
                          WHEN ${PICKED_UP} THEN 'retry'
                          WHEN p."destZoneId" IS NOT NULL OR p."pathAssignedAt" IS NOT NULL THEN 'zoned'
                          ELSE 'unformed' END AS why,
                     string_agg(DISTINCT p.attrs->>'reason', ', ') AS reason, hb.code AS "nowIn",
                     (hb.id IS NOT DISTINCT FROM p."sourceBinId") AS "atSource",
                     EXISTS (SELECT 1 FROM handling_unit_quant hq WHERE hq."huId" = p."huId" AND hq.qty > 0) AS stock,
                     to_char(min(p."createdAt") AT TIME ZONE 'Asia/Kolkata', 'DD Mon HH24:MI') AS since
                FROM pd_provisional_item p JOIN session s ON s.id = p."sessionId"
                LEFT JOIN handling_unit h ON h.id = p."huId" LEFT JOIN storage_bin hb ON hb.id = h."storageId"
               WHERE p."whId" = $1 AND p."deactivatedAt" IS NULL AND p."destBinId" IS NULL
                 AND p."taskKind" = 'INBOUND_PUTAWAY' AND s.kind = 'INBOUND'
               GROUP BY 1, 2, 3, 5, p."huId", hb.id, hb.code, p."sourceBinId" ORDER BY min(p."createdAt")`, W),
    ]);

    const by = (w) => putaway.filter((r) => r.why === w);
    const retry = eligible.reduce((n, e) => n + e.rows, 0);
    const notPutaway = eligible.filter((e) => e.taskKind !== "INBOUND_PUTAWAY");
    const ended = by("ended"), failedEnded = ended.filter((r) => r.reason);
    const items = [];
    const add = (level, title, detail = "") => items.push({ level, title, detail });
    if (retry) add("pass", `A run would retry ${retry} row${retry > 1 ? "s" : ""} in ${new Set(eligible.map((e) => e.session)).size} session(s)`);
    else add("fail", "A run would retry nothing", "Every row with no destination is either already zoned, in an ended session, or has no formed pallet. Sending would do nothing.");
    const putawayRetry = by("retry");
    if (putawayRetry.length) add("pass", `${putawayRetry.length} inbound putaway pallet${putawayRetry.length > 1 ? "s" : ""} would get another slotting attempt`);
    const kinds = {};
    for (const e of notPutaway) kinds[e.taskKind] = (kinds[e.taskKind] || 0) + e.rows;
    if (notPutaway.length) add("warn", `It also retries ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(", ")} row${notPutaway.reduce((n, e) => n + e.rows, 0) > 1 ? "s" : ""}`,
      "The event covers the whole warehouse, not just putaway. Those rows are listed below.");
    if (eligible.some((e) => e.failed)) add("warn", "Some of these already failed with \"Destination Bin Not Found\"",
      "A retry only helps if a bin has freed up since, or the putaway bin search strategy changed. Otherwise it fails the same way.");
    if (failedEnded.length) add("info", `${failedEnded.length} "Destination Bin Not Found" pallet${failedEnded.length > 1 ? "s" : ""} in finished sessions can't be retried`,
      "The event skips COMPLETED and CANCELLED sessions. These are left-over rows; see where each pallet is now below.");
    if (by("zoned").length) add("info", `${by("zoned").length} putaway pallet${by("zoned").length > 1 ? "s have" : " has"} a destination zone and wait for the drop`,
      "Not stuck: the bin is chosen when the pallet is dropped. A run leaves them alone.");

    return {
      event: EVENT, outbox: OUTBOX || null, payload: { whId: Number(whId) },
      ready: retry > 0, items, eligible, putaway,
      counts: { retry, putawayRetry: putawayRetry.length, zoned: by("zoned").length, ended: ended.length, unformed: by("unformed").length },
      checkedAt: new Date().toISOString(),
    };
  }

  // the one write: publish the event on wms-outbox, then read the warehouse again
  async function send(whId) {
    if (!OUTBOX) throw new Error("No wms-outbox address for this environment. Add \"outbox\" to its entry in config/envs.json.");
    const before = await check(whId);
    if (!before.ready) return { sent: false, reason: "A run would retry nothing, so nothing was sent.", after: before };
    let status, body;
    try {
      const r = await fetch(`${OUTBOX}/outbox/event-bus/publish/${EVENT}`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(before.payload), signal: AbortSignal.timeout(30000),
      });
      status = r.status; body = (await r.text()).slice(0, 2000);
    } catch (e) { status = 0; body = `request failed: ${e.message} (on VPN?)`; }
    // slotting runs off a queue under a warehouse lock; give it a moment before reading back
    if (status === 200) await new Promise((r) => setTimeout(r, 6000));
    return { sent: status === 200, status, body, before: before.counts, after: await check(whId) };
  }

  return { check, send, EVENT };
};
