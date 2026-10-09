// GRN and GIN acks: give it an ASN no or an outbound order code, it builds the
// GRN ack / GIN ack payload from the WMS DB, lets you review/edit it, pushes it to
// cincout's internal integration endpoint, then re-reads status to prove it landed.
// Routes: GET /api/lookup, POST /api/push (refused when the environment is read-only).
module.exports = function acksModule({ wms, encarta, q, tryQ, URLS, READ_ONLY, ENV }) {
  const isWh = (v) => /^\d+$/.test(String(v ?? ""));

  async function skuCodes(ids) {
    const uniq = [...new Set(ids.filter(Boolean).map(String))];
    if (!uniq.length) return {};
    const rows = await q(encarta, "SELECT id::text AS id, code FROM skus WHERE id::text = ANY($1)", [uniq]);
    return Object.fromEntries(rows.map((r) => [r.id, r.code]));
  }

  // ---- GRN (inbound) ----------------------------------------------------------
  async function grnState(asnId) {
    const grns = await q(wms, 'SELECT * FROM inb_grn WHERE "asnId" = $1 AND active ORDER BY "createdAt" DESC', [asnId]);
    let lines = [], err = null;
    if (grns.length) {
      [lines, err] = await tryQ(wms, 'SELECT * FROM inb_grn_line WHERE "grnId" = $1 ORDER BY "createdAt"', [grns[0].id]);
      const codes = await skuCodes(lines.map((l) => l.skuId));
      lines = lines.map((l) => ({ skuCode: codes[String(l.skuId)] ?? "?", ...l }));
    }
    return { grns, lines, err };
  }

  async function lookupAsn(code, wh) {
    const asns = await q(wms,
      // typed codes often differ in case from the stored one; prefer an exact match
      'SELECT id, "asnNo", "sessionId", active, "createdAt" FROM inb_asn WHERE "whId" = $1 AND upper("asnNo") = upper($2) ' +
      'ORDER BY ("asnNo" = $2) DESC, active DESC, "createdAt" DESC', [wh, code]);
    if (!asns.length) return null;
    const asn = asns[0];
    code = asn.asnNo; // cincout matches the stored code exactly, so the payload must carry it
    const warnings = [];
    if (!asn.active) warnings.push("ASN is inactive — grn-ack only looks at active ASNs.");
    if (!asn.sessionId) warnings.push("ASN has no sessionId (not released) — grn-ack will 400.");
    if (asns.filter((a) => a.active).length > 1) warnings.push("More than one active ASN row with this number.");

    const { grns, lines, err } = await grnState(asn.id);
    if (!grns.length) warnings.push("No active inb_grn for this ASN yet — finish GRN first.");
    else {
      const st = grns[0].status;
      if (st === "ACKED") warnings.push("GRN is already ACKED — pushing again is a no-op.");
      else if (!["SENT", "PARTIAL_ACKED"].includes(st)) warnings.push(`GRN status is ${st}; only SENT / PARTIAL_ACKED are ackable.`);
    }
    if (err) warnings.push("Couldn't read GRN lines: " + err);
    if (grns.length) {
      // grnAck reads huMap.get(line.huId!).storageId — an inactive / other-wh pallet crashes it with a 500
      const [badHus, huErr] = await tryQ(wms, `
        SELECT l."huId", h.id IS NULL AS missing, h.active, h."whId"
          FROM inb_grn_line l
          JOIN inb_grn g ON g.id = l."grnId"
          LEFT JOIN handling_unit h ON h.id = l."huId"
         WHERE l."grnId" = $1 AND l."huId" IS NOT NULL
           AND (h.id IS NULL OR h.active = false OR h."whId" <> g."whId")`, [grns[0].id]);
      if (badHus.length) {
        const list = badHus.map((h) => `${h.huId} (${h.missing ? "missing" : !h.active ? "inactive" : "wh " + h.whId})`);
        warnings.push(`GRN lines point to pallets cincout can't load: ${list.join(", ")}. The ack will fail with a 500 ` +
          "(\"reading 'storageId'\") until those pallets are active in this warehouse.");
      } else if (huErr) {
        warnings.push("Couldn't check the GRN pallets (" + huErr + "). If the push returns a 500, look for GRN_ACK_FAILED in the cincout logs.");
      }
    }

    const pos = await q(wms, 'SELECT DISTINCT "poNo" FROM inb_asn_lineitem WHERE "whId" = $1 AND "asnNo" = $2 AND active', [wh, code]);
    const poNos = pos.map((p) => p.poNo).filter(Boolean);
    const notes = ["The session must have grnAckByAPI = true, or cincout refuses the ack."];

    return {
      type: "GRN",
      code,
      url: URLS.GRN,
      readOnly: READ_ONLY,
      summary: { asn, grn: grns[0] ?? null, poNos },
      lines,
      warnings,
      notes,
      payload: { whId: Number(wh), asnNo: code },
      // grnAckLevel=PO sessions reject asnNo and need asnWithPos
      altPayload: { whId: Number(wh), asnWithPos: [{ asnNo: code, poNos, grNo: null }] },
      altLabel: "PO-level (asnWithPos)",
    };
  }

  // ---- GIN (outbound) ---------------------------------------------------------
  async function lookupOrder(code, wh) {
    const orders = await q(wms,
      'SELECT id, code, "sessionId", "ginStatus", "tripCode", active, "createdAt" FROM ob_order ' +
      'WHERE "whId" = $1 AND upper(code) = upper($2) ORDER BY (code = $2) DESC, active DESC, "createdAt" DESC', [wh, code]);
    if (!orders.length) return null;
    code = orders[0].code; // the stored spelling, which the gin-ack payload must use
    // duplicate sessions can reuse an order code; prefer the one actually awaiting ack
    const active = orders.filter((o) => o.active).length ? orders.filter((o) => o.active) : orders;
    const order = active.find((o) => o.ginStatus === "SENT") ?? active[0];
    const warnings = [];
    if (active.length > 1) warnings.push(`${active.length} active ob_order rows share this code; using session ${order.sessionId}.`);
    if (!order.sessionId || !order.ginStatus || order.ginStatus === "PENDING")
      warnings.push(`Order ginStatus=${order.ginStatus}, sessionId=${order.sessionId}: the handler rejects this (E021).`);
    else if (order.ginStatus === "ACKED") warnings.push("Order already ACKED — only a processFlag '11' full reversal is accepted now.");
    else if (order.ginStatus !== "SENT") warnings.push(`Order ginStatus=${order.ginStatus}; first ack expects SENT.`);
    if (!order.tripCode) warnings.push("ob_order.tripCode is empty — envelope tripCode must match it (E269).");

    const rows = order.sessionId ? await q(wms, `
      SELECT g.id AS "ginId", g."tripCode" AS "ginTripCode", g.status AS "ginStatus", g."loadCompletedAt",
             gl."skuId", gl.uom, gl.batch, gl."loadedQty"
        FROM ob_gin g
        JOIN ob_gin_line gl ON gl."whId" = g."whId" AND gl."ginId" = g.id
       WHERE g."whId" = $1 AND g."invoiceCode" = $2 AND g."sessionId" = $3
       ORDER BY g.id, gl."skuId", gl.uom, gl.batch`, [wh, code, order.sessionId]) : [];
    if (!rows.length) warnings.push("No ob_gin / ob_gin_line rows for this order+session — nothing to ack.");
    if (rows.some((r) => r.loadCompletedAt === null))
      warnings.push("A GIN has loadCompletedAt = NULL — the whole ack aborts. Complete loading first.");
    const codes = await skuCodes(rows.map((r) => r.skuId));

    // handler sums loadedQty per (sku, uom, batch) and compares to issuedQty,
    // so one input line per key — splitting would read as a short issue (reversal)
    const agg = new Map();
    for (const r of rows) {
      const key = [r.skuId, r.uom, r.batch].join("|");
      if (!agg.has(key))
        agg.set(key, { skuCode: codes[String(r.skuId)] ?? "?", uom: r.uom, batch: r.batch, issuedQty: 0, ginTripCode: r.ginTripCode });
      agg.get(key).issuedQty += Number(r.loadedQty ?? 0);
    }
    const loaded = [...agg.values()];
    if (loaded.some((a) => a.skuCode === "?")) warnings.push("Some skuIds didn't resolve in encarta — fix skuCode before pushing.");

    const [flagRows] = await tryQ(wms, 'SELECT * FROM ob_trip_process_flag WHERE "whId" = $1 AND active', [wh]);
    const flags = flagRows.map((f) => ({ code: f.code, processFlag: f.processFlag }));
    const defaultFlag = (flags.find((f) => String(f.processFlag) !== "11") ?? flags[0])?.code ?? "";
    if (!flags.length) warnings.push("No ob_trip_process_flag rows found — set processFlag by hand.");
    const notes = ["The session must have ginAckByApi = \"true\", or cincout returns 200 and writes nothing."];

    const trip = order.tripCode || rows[0]?.ginTripCode || "";
    const deliverOrderInput = loaded.map((a) => ({
      tripCode: a.ginTripCode || trip, mmTripCode: trip, orderCode: code, deliveryOrder: code, lineCode: null,
      skuCode: a.skuCode, uom: a.uom, batch: a.batch, issuedQty: a.issuedQty, processFlag: defaultFlag,
      huCode: null, huType: null, xdock: null, vehicleType: null, transporterCode: null, transporterName: null,
      tripPriority: null, customerOrderQty: null, deliveryOrderQty: null, orderType: null, truckType: null,
      latestPickDate: null, earliestPickDate: null, promoCode: null, promoLineType: null, ratio: null, erpInvoiceCode: null,
    }));
    const gins = [...new Map(rows.map((r) => [r.ginId, { ginId: r.ginId, status: r.ginStatus, loadCompletedAt: r.loadCompletedAt }])).values()];

    return {
      type: "GIN",
      code,
      url: URLS.GIN,
      readOnly: READ_ONLY,
      summary: { order, gins, processFlags: flags },
      lines: loaded,
      warnings,
      notes,
      payload: { whId: Number(wh), tripCode: trip, ginAckLevel: "DELIVERY_ORDER", deliverOrderInput },
    };
  }

  async function lookup(code, kind, wh) {
    const tried = [];
    for (const [k, fn] of [["asn", lookupAsn], ["order", lookupOrder]]) {
      if (kind !== "auto" && kind !== k) continue;
      tried.push(k);
      const res = await fn(code, wh);
      if (res) return res;
    }
    const what = tried.length > 1 ? "ASN or order" : tried[0] === "asn" ? "ASN" : "order";
    return { error: `No ${what} with code ${code} in warehouse ${wh}. Check the code and the whId.` };
  }

  async function verify(type, p) {
    const wh = String(p.whId);
    if (type === "GRN") {
      const code = p.asnNo ?? p.asnNos?.[0] ?? p.asnWithPos?.[0]?.asnNo;
      const asn = await q(wms, 'SELECT id FROM inb_asn WHERE "whId" = $1 AND "asnNo" = $2 AND active', [wh, code]);
      if (!asn.length) return {};
      const { grns, lines } = await grnState(asn[0].id);
      return { grn: grns[0] ?? null, lines: lines.map((l) => ({ skuCode: l.skuCode, status: l.status, grNo: l.grNo, updatedAt: l.updatedAt })) };
    }
    const code = p.deliverOrderInput?.[0]?.deliveryOrder;
    return {
      orders: await q(wms, 'SELECT code, "sessionId", "ginStatus", "updatedAt" FROM ob_order WHERE "whId" = $1 AND code = $2 AND active', [wh, code]),
      gins: await q(wms, 'SELECT id, status, "updatedAt", "loadCompletedAt" FROM ob_gin WHERE "whId" = $1 AND "invoiceCode" = $2 ORDER BY "updatedAt" DESC', [wh, code]),
    };
  }

  async function push(type, payload) {
    let status, body;
    try {
      const r = await fetch(URLS[type], {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload), signal: AbortSignal.timeout(90000),
      });
      status = r.status;
      body = await r.text();
    } catch (e) {
      status = 0;
      body = `request failed: ${e.message} (on VPN?)`;
    }
    let after = {}, verifyError = null;
    try { after = await verify(type, payload); } catch (e) { verifyError = e.message; }
    return { status, body, after, verifyError };
  }

  // ---- routes -----------------------------------------------------------------
  // a route that answers returns true, so the server stops looking
  return async function handle(req, res, u, send) {
    const isAck = (req.method === "GET" && u.pathname === "/api/lookup") || (req.method === "POST" && u.pathname === "/api/push");
    if (!isAck) return false;
    await (async () => {
      if (req.method === "GET" && u.pathname === "/api/lookup") {
        const code = (u.searchParams.get("code") || "").trim();
        const wh = (u.searchParams.get("whId") || "").trim();
        if (!code) return send(res, 400, { error: "code required" });
        if (!isWh(wh)) return send(res, 400, { error: "whId must be a number" });
        return send(res, 200, await lookup(code, u.searchParams.get("kind") || "auto", wh));
      }
      if (req.method === "POST" && u.pathname === "/api/push") {
        let raw = "";
        for await (const chunk of req) raw += chunk;
        const { type, payload } = JSON.parse(raw);
        if (READ_ONLY) return send(res, 403, { error: `${ENV} is read-only in this app. Acks aren't pushed from here.` });
        if (!URLS[type]) return send(res, 400, { error: "type must be GRN or GIN" });
        if (!isWh(payload?.whId)) return send(res, 400, { error: "payload whId must be a number" });
        return send(res, 200, await push(type, payload));
      }
    })();
    return true;
  };
};
