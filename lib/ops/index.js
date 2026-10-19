// Operations: go-live readiness, "why won't putaway take this?", the stuck-stock finder, and API triggers.
// Read-only: every query here is a SELECT. The one write is an API trigger's send, refused on read-only environments.
//
// The putaway rules mirror wms cincout put-bin-search.ts / bin-state-v3.ts and storage
// search/repository.ts (traced 2026-10-03):
//  - search index rows exist per AREA and ZONE only; a bin qualifies when one area row and one
//    zone row are each contained in the quant's identifier values and together equal them exactly
//  - area, zone active; bin status ACTIVE
//  - hasTaskLevelBlockRule bins blocked by an active task_bin_mode_lock in PUT/BOTH mode
//  - storage_bin_fixed_mapping (SKU / PRODUCT / L0_EAN) when the bin has any
//  - area rollingDays: incoming batch expiry vs the same SKU's batches already in the bin
//  - multiSku / multiBatch, maxSkuCount / maxSkuBatchCount on the bin
//  - pallets: PALLET (or NONE) bin type, pallet positions = palletCapacity minus pallets inside,
//    onlyFullPallet rejects partial pallets
//  - loose stock: best fit (storage_bin_type_best_fit) else volume, per bin type
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
const upper = (s) => String(s ?? "").trim().toUpperCase();
const ZERO = "00000000-0000-0000-0000-000000000000";
const STORAGE_AREA = (t) => t === "INVENTORY";
const packStaging = require("./pack-staging");
const slottingRetrigger = require("./slotting-retrigger");

module.exports = function opsModule({ wms, encarta, q, tryQ, inventory, masters, compare, ENV, READ_ONLY, OUTBOX }) {
  const staging = packStaging({ wms, q, tryQ, OUTBOX });
  const slotting = slottingRetrigger({ wms, q, OUTBOX });
  const cache = new Map(); // whId -> { at, x }

  // ---- everything the putaway rules read that the inventory masters don't already hold ----
  async function loadExtra(whId) {
    const hit = cache.get(whId);
    if (hit && Date.now() - hit.at < 2 * 60000) return hit.x;
    const W = [whId];
    const fb = async (full, basic) => { const [r, e] = await tryQ(wms, full, W); return e ? (await tryQ(wms, basic, W))[0] : r; };
    const [index, defs, binX, typeX, areaX, [locks], [fixed], [huCount]] = await Promise.all([
      q(wms, `SELECT "storageId"::text AS id, "storageType" AS type, "identifierValues" AS vals, sequence::float AS seq
                FROM storage_search_index WHERE "whId" = $1 AND active AND "storageType" IN ('AREA', 'ZONE')`, W),
      q(wms, `SELECT DISTINCT identifier FROM storage_identifier_definition WHERE "whId" = $1 AND active`, W),
      fb(`SELECT id::text AS id, "hasTaskLevelBlockRule" AS blockrule, "putawayPosition" AS pos FROM storage_bin WHERE "whId" = $1`,
        `SELECT id::text AS id FROM storage_bin WHERE "whId" = $1`),
      fb(`SELECT id::text AS id, "maxVolumeInCC"::float AS vol, "onlyFullPallet" AS fullonly, "palletCapacity" AS cap FROM storage_bin_type WHERE "whId" = $1`,
        `SELECT id::text AS id, "maxVolumeInCC"::float AS vol, "palletCapacity" AS cap FROM storage_bin_type WHERE "whId" = $1`),
      fb(`SELECT id::text AS id, "rollingDays" AS rolling FROM storage_area WHERE "whId" = $1`, `SELECT id::text AS id FROM storage_area WHERE "whId" = $1`),
      tryQ(wms, `SELECT "binId"::text AS bin, mode, "taskKind" AS kind, "taskSubKind" AS sub FROM task_bin_mode_lock WHERE "whId" = $1 AND active`, W),
      tryQ(wms, `SELECT "binId"::text AS bin, mode, upper(trim(value)) AS value FROM storage_bin_fixed_mapping WHERE "whId" = $1 AND active`, W),
      tryQ(wms, `SELECT b.code, count(*)::int AS n FROM handling_unit h JOIN storage_bin b ON b.id = h."storageId"
                  WHERE h."whId" = $1 AND h.state = 'inside' AND h.id IS DISTINCT FROM b."binHuId" GROUP BY 1`, W),
    ]);
    const x = {
      areaRows: new Map(), zoneRows: new Map(),
      identifiers: defs.map((d) => d.identifier),
      bin: new Map(binX.map((b) => [b.id, b])), type: new Map(typeX.map((t) => [t.id, t])), area: new Map(areaX.map((a) => [a.id, a])),
      locks: new Map(), fixed: new Map(), hus: new Map(huCount.map((h) => [h.code, h.n])),
    };
    for (const r of index) {
      const m = r.type === "AREA" ? x.areaRows : x.zoneRows;
      if (!m.has(r.id)) m.set(r.id, []);
      m.get(r.id).push({ vals: r.vals || {}, seq: r.seq });
    }
    for (const l of locks) { if (!x.locks.has(l.bin)) x.locks.set(l.bin, []); x.locks.get(l.bin).push(l); }
    for (const f of fixed) { if (!x.fixed.has(f.bin)) x.fixed.set(f.bin, []); x.fixed.get(f.bin).push(f); }
    cache.set(whId, { at: Date.now(), x });
    return x;
  }

  // one area row + one zone row, each within the quant's values, together exactly equal to them
  const eq = (a, b) => upper(a) === upper(b);
  function searchFit(x, bin, qv) {
    const ar = x.areaRows.get(String(bin.areaId)) || [], zr = x.zoneRows.get(String(bin.zoneId)) || [];
    if (!ar.length) return { ok: false, why: `area ${bin.area} has no putaway search row` };
    if (!zr.length) return { ok: false, why: `zone ${bin.zone} has no putaway search row` };
    const within = (vals) => Object.entries(vals).every(([k, v]) => k in qv && eq(qv[k], v));
    let best = null;
    for (const a of ar) {
      if (!within(a.vals)) continue;
      for (const z of zr) {
        if (!within(z.vals)) continue;
        const merged = { ...a.vals, ...z.vals };
        if (Object.keys(qv).every((k) => k in merged && eq(merged[k], qv[k])) && Object.keys(merged).every((k) => k in qv)) {
          const seq = [a.seq, z.seq];
          if (!best || seq[0] < best[0] || (seq[0] === best[0] && seq[1] < best[1])) best = seq;
        }
      }
    }
    if (best) return { ok: true, seq: best };
    // name the value the zone doesn't take, e.g. "zone RTN-BIN takes uom L0, not L2"
    for (const [rows, where] of [[ar, `area ${bin.area}`], [zr, `zone ${bin.zone}`]]) {
      for (const k of Object.keys(qv)) {
        const vals = new Set(rows.filter((r) => k in r.vals).map((r) => upper(r.vals[k])));
        if (vals.size && !vals.has(upper(qv[k]))) return { ok: false, why: `${where} takes ${k} ${[...vals].sort().slice(0, 4).join("/")}${vals.size > 4 ? "/…" : ""}, not ${qv[k] ?? "blank"}` };
      }
    }
    return { ok: false, why: `zone ${bin.zone} has no search row for ${Object.entries(qv).map(([k, v]) => `${k} ${v}`).join(" + ")}` };
  }

  // the identifier values putaway searches with, for one SKU line
  function queryValues(x, m, sku, { uom, bucket, batch }) {
    const qv = {};
    for (const id of x.identifiers) {
      if (id === "uom") qv.uom = uom;
      else if (id === "bucket") qv.bucket = bucket;
      else if (id === "skuClass") qv.skuClass = sku.clazz;
      else if (id === "skuClassType") qv.skuClassType = m.classType;
      else if (id === "batch") qv.batch = batch;
      else qv[id] = null; // not something this page knows; the reason will say so
    }
    return qv;
  }

  // ---- "why won't putaway take this?" ------------------------------------------------------
  async function explain(whId, o) {
    const m = await inventory.loadMasters(whId);
    const x = await loadExtra(whId);
    const code = upper(o.sku);
    const sku = m.skus.get(code) || [...m.skus.values()].find((s) => upper(s.code) === code);
    if (!sku) throw new Error(`SKU ${o.sku} isn't in this warehouse's SKU master.`);
    const uom = upper(o.uom || "L2"), bucket = o.bucket || "Good", batch = upper(o.batch), qty = Number(o.qty) || 0;
    const mode = o.mode === "pallet" ? "pallet" : "loose";
    const b = batch ? m.batches.get(`${sku.code}|${batch}`) : null;
    const notes = [];
    if (batch && !b) notes.push(`Batch ${batch} isn't in the batch master for ${sku.code}.`);
    if (!batch) notes.push("No batch given, so single-batch bins are judged by SKU only, and rolling-days and max SKU-batch rules are skipped. Enter the batch for an exact answer.");
    if (!sku.clazz) notes.push(`${sku.code} has no ${m.classType} class, so no search row can match it. Putaway will find no bin anywhere.`);
    const qv = queryValues(x, m, sku, { uom, bucket, batch });
    const unknown = Object.entries(qv).filter(([, v]) => v === null).map(([k]) => k);
    if (unknown.length) notes.push(`The search rules also use ${unknown.join(", ")}, which this page can't fill in, so matches may be off.`);

    // encarta volumes for this SKU, and its best fit per bin type (keyed by the encarta sku id)
    const [vols] = await tryQ(encarta, `SELECT s.id::text AS id, u.hierarchy, u.volume::float AS vol FROM uoms u JOIN skus s ON s.id = u.sku_id
                      WHERE upper(s.code) = $1 AND s.principal_id::text = $2 AND u.active IS NOT FALSE`, [code, String(m.principalId)]);
    let bestFit = new Map();
    if (vols[0]?.id) {
      const [bf] = await tryQ(wms, `SELECT "binTypeId"::text AS type, uom, "bestFitCount"::float AS n FROM storage_bin_type_best_fit
                                     WHERE "whId" = $1 AND active AND "skuId"::text = $2`, [whId, vols[0].id]);
      bestFit = new Map(bf.map((r) => [`${r.type}|${r.uom}`, r.n]));
    }
    const volOf = new Map(vols.map((v) => [v.hierarchy, v.vol]));
    const unitVol = volOf.get(uom) || null;

    const results = [];
    for (const bin of m.bins) {
      const bx = x.bin.get(String(bin.id)) || {}, tx = x.type.get(String(bin.binTypeId)) || null;
      const area = x.area.get(String(bin.areaId)) || {};
      const stock = m.occupied.get(bin.code) || [];
      const r = { bin: bin.code, zone: bin.zone, area: bin.area, areaType: bin.areaType, binType: bin.binType, pos: bx.pos ?? null };
      const reject = (rule, why) => { r.rule = rule; r.why = why; results.push(r); };
      if (bin.status !== "ACTIVE") { reject("Bin status", `bin is ${bin.status || "not ACTIVE"}`); continue; }
      if (!bin.zoneActive) { reject("Bin status", `zone ${bin.zone} is inactive`); continue; }
      if (!bin.areaActive) { reject("Bin status", `area ${bin.area} is inactive`); continue; }
      const s = searchFit(x, bin, qv);
      if (!s.ok) { reject("Search rules", s.why); continue; }
      r.seq = s.seq;
      if (bx.blockrule && (x.locks.get(String(bin.id)) || []).some((l) => l.mode === "BOTH" || l.mode === "PUT")) {
        reject("Task block", "bin is locked for putaway by a task bin-mode lock"); continue;
      }
      const fx = x.fixed.get(String(bin.id));
      if (fx?.length && !fx.some((f) => (f.mode === "SKU" && f.value === code) || (f.mode === "PRODUCT" && f.value === upper(sku.baseCode)))) {
        reject("Fixed mapping", `bin is reserved for ${fx.map((f) => `${f.mode} ${f.value}`).slice(0, 3).join(", ")}`); continue;
      }
      const same = stock.filter((q2) => upper(q2.skuCode) === code);
      if (area.rolling > 0 && b?.exp) {
        const far = same.map((q2) => m.batches.get(`${sku.code}|${upper(q2.batch)}`)?.exp).filter(Boolean)
          .find((e) => Math.abs((Date.parse(e) - Date.parse(b.exp)) / 86400000) > area.rolling);
        if (far) { reject("Rolling days", `area allows batches within ${area.rolling} days of expiry; the bin holds one expiring ${far}`); continue; }
      }
      const skus = new Set(stock.map((q2) => upper(q2.skuCode))), keys = new Set(stock.map((q2) => `${upper(q2.skuCode)}|${upper(q2.batch)}`));
      const mine = `${code}|${batch}`;
      // with no batch given, batch rules can only be judged by SKU (noted once below)
      const sameKey = batch ? keys.size === 1 && keys.has(mine) : skus.size === 1 && skus.has(code);
      if (bin.multiSku && !bin.multiBatch && batch && same.some((q2) => upper(q2.batch) !== batch)) { reject("Multi-batch", `bin holds ${code} in batch ${upper(same[0].batch)} and isn't multi-batch`); continue; }
      if (!bin.multiSku && bin.multiBatch && stock.length && !skus.has(code)) { reject("Multi-SKU", `bin holds ${[...skus].slice(0, 2).join(", ")} and isn't multi-SKU`); continue; }
      if (!bin.multiSku && !bin.multiBatch && stock.length && !(sameKey && stock.every((q2) => q2.uom === uom))) {
        reject(skus.has(code) ? "Multi-batch" : "Multi-SKU", `bin holds ${[...keys].slice(0, 2).map((k) => k.replace("|", " ")).join(", ")} and allows one SKU-batch`); continue;
      }
      if (bin.maxSku && !skus.has(code) && skus.size >= bin.maxSku) { reject("Max SKUs", `bin already has ${skus.size} SKUs, max ${bin.maxSku}`); continue; }
      if (batch && bin.maxSkuBatch && !keys.has(mine) && keys.size >= bin.maxSkuBatch) { reject("Max SKU-batches", `bin already has ${keys.size} SKU-batches, max ${bin.maxSkuBatch}`); continue; }
      const t = tx || {};
      if (mode === "pallet") {
        if (!["PALLET", "NONE"].includes(bin.huType)) { reject("HU type", `bin type ${bin.binType} holds ${bin.huType || "no"} HUs, not pallets`); continue; }
        const inside = x.hus.get(bin.code) || 0, cap = Number(t.cap) || bin.cap;
        if (inside >= cap) { reject("Pallet positions", `${inside} of ${cap} pallet positions taken`); continue; }
        const partial = sku.L2inL3 && uom === "L2" && qty > 0 && qty < sku.L2inL3;
        if (t.fullonly && partial) { reject("Only full pallets", `bin type takes full pallets only; ${qty} of ${sku.L2inL3} cases`); continue; }
        r.room = `${cap - inside} of ${cap} pallet positions free`;
      } else {
        // loose cases into a pallet bin still need a pallet position, unless the drop strategy is
        // HU_RELAXED, which tops up a part pallet of the same SKU first
        if (bin.huType === "PALLET") {
          const inside = x.hus.get(bin.code) || 0, cap = Number(t.cap) || bin.cap;
          if (inside >= cap) { reject("Pallet positions", `${inside} of ${cap} pallet positions taken (only a HU_RELAXED drop strategy could top up a pallet already there)`); continue; }
        }
        const fit = bestFit.get(`${bin.binTypeId}|${uom}`);
        if (fit) {
          const roomN = Math.floor(fit - (same.filter((q2) => q2.uom === uom).reduce((n, q2) => n + Number(q2.qty), 0)));
          if (roomN < 1) { reject("Capacity", `best fit ${fit} ${uom} per bin, already full`); continue; }
          r.room = `room for ${roomN} ${uom} (best fit ${fit})`;
          if (qty && roomN < qty) r.partial = true;
        } else {
          // the bin's maxVolumeInCC and encarta's uom volume don't share a unit we can rely on,
          // so don't invent a number: say what putaway will size it by
          r.room = t.vol > 0 && unitVol > 0 ? `no best fit: putaway sizes by volume (bin ${t.vol}, ${uom} ${unitVol})` : "no best fit and no volume: putaway can't size it";
        }
      }
      r.rule = null; r.ok = true; results.push(r);
    }
    const ok = results.filter((r) => r.ok).sort((a, b2) => a.seq[0] - b2.seq[0] || a.seq[1] - b2.seq[1] || (a.pos ?? 1e9) - (b2.pos ?? 1e9) || a.bin.localeCompare(b2.bin));
    const byRule = new Map();
    for (const r of results.filter((r2) => !r2.ok)) {
      if (!byRule.has(r.rule)) byRule.set(r.rule, { rule: r.rule, count: 0, examples: [], whys: new Map() });
      const g = byRule.get(r.rule); g.count++;
      g.whys.set(r.why, (g.whys.get(r.why) || 0) + 1);
      if (g.examples.length < 8) g.examples.push(r);
    }
    const order = ["Bin status", "Search rules", "Task block", "Fixed mapping", "Rolling days", "Multi-SKU", "Multi-batch", "Max SKUs", "Max SKU-batches", "HU type", "Pallet positions", "Only full pallets", "Capacity"];
    return {
      sku: { code: sku.code, clazz: sku.clazz, L0inL2: sku.L0inL2, L2inL3: sku.L2inL3, active: sku.active }, batch: b ? { code: batch, exp: b.exp } : null,
      query: qv, mode, uom, qty, notes, bins: m.bins.length, eligible: ok.slice(0, 300), eligibleCount: ok.length,
      storageEligible: ok.filter((r) => STORAGE_AREA(r.areaType)).length,
      rejected: order.filter((k) => byRule.has(k)).map((k) => { const g = byRule.get(k); return { rule: k, count: g.count, examples: g.examples,
        whys: [...g.whys].sort((a, b2) => b2[1] - a[1]).slice(0, 6).map(([w, n]) => ({ why: w, n })) }; }),
    };
  }

  // ---- stuck stock -----------------------------------------------------------------------------
  async function stuck(whId) {
    const W = [whId];
    // a lock's owner is a task or, for some flows (outbound packing), the session itself; the lock
    // is live while its owner is PENDING/ONGOING, and stuck once the owner has ended or is gone
    const owner = (col) => `LEFT JOIN task t ON t.id = ${col} LEFT JOIN session s ON s.id = ${col}`;
    const ownerCols = `coalesce(t.kind, s.kind) AS kind, coalesce(t.code, s.code) AS task_code, coalesce(t.state, s.state) AS state,
                       coalesce(t.active, s.active) AS owner_active, coalesce(t."updatedAt", s."updatedAt") AS task_updated,
                       CASE WHEN t.id IS NOT NULL THEN 'task' WHEN s.id IS NOT NULL THEN 'session' END AS owner`;
    const dead = `(coalesce(t.state, s.state) IS NULL OR coalesce(t.state, s.state) IN ('COMPLETED', 'CANCELLED') OR coalesce(t.active, s.active) = false)`;
    const [[locked, e1], [huLocked, e2], [empty, e3], [inactive, e4], [sessions, e5], [negative, e6]] = await Promise.all([
      tryQ(wms, `SELECT b.code AS bin, h.code AS hu, hq."skuId"::text AS sku_id, upper(trim(hq.batch)) AS batch, hq.uom, hq.qty::float AS qty, hq."lockMode" AS mode,
                        hq."lockedByTaskId"::text AS task, ${ownerCols}
                   FROM handling_unit_quant hq JOIN handling_unit h ON h.id = hq."huId" LEFT JOIN storage_bin b ON b.id = h."storageId"
                   ${owner(`hq."lockedByTaskId"`)}
                  WHERE hq."whId" = $1 AND hq.qty > 0 AND hq."lockMode" <> 'NONE' AND hq."lockedByTaskId" IS NOT NULL AND hq."lockedByTaskId" <> '${ZERO}'
                    AND ${dead}
                  ORDER BY b.code, h.code LIMIT 2000`, W),
      tryQ(wms, `SELECT b.code AS bin, h.code AS hu, h."lockTaskId"::text AS task, ${ownerCols}
                   FROM handling_unit h LEFT JOIN storage_bin b ON b.id = h."storageId" ${owner(`h."lockTaskId"`)}
                  WHERE h."whId" = $1 AND h.state = 'inside' AND h."lockTaskId" IS NOT NULL AND h."lockTaskId" <> '${ZERO}'
                    AND ${dead}
                  ORDER BY b.code LIMIT 2000`, W),
      tryQ(wms, `SELECT b.code AS bin, h.code AS hu, h."updatedAt" AS since FROM handling_unit h
                   JOIN storage_bin b ON b.id = h."storageId" JOIN storage_bin_type bt ON bt.id = b."binTypeId"
                  WHERE h."whId" = $1 AND h.state = 'inside' AND bt."storageHUType" = 'PALLET' AND h.id IS DISTINCT FROM b."binHuId"
                    AND NOT EXISTS (SELECT 1 FROM handling_unit_quant hq WHERE hq."huId" = h.id AND hq.qty > 0)
                  ORDER BY b.code LIMIT 2000`, W),
      tryQ(wms, `SELECT i."binCode" AS bin, i."binStatus" AS status, z.active AS zone_active, a.active AS area_active, i."skuCode" AS sku,
                        upper(trim(i.batch)) AS batch, i.uom, sum(i.qty)::float AS qty
                   FROM inventory i JOIN storage_bin b ON b.id = i."binId" JOIN storage_zone z ON z.id = b."zoneId" JOIN storage_area a ON a.id = z."areaId"
                  WHERE i."whId" = $1 AND i."deletedAt" IS NULL AND i.qty > 0 AND (i."binStatus" <> 'ACTIVE' OR NOT z.active OR NOT a.active)
                  GROUP BY 1, 2, 3, 4, 5, 6, 7 ORDER BY 1 LIMIT 2000`, W),
      tryQ(wms, `SELECT kind, code, state, "createdAt" AS created, "updatedAt" AS updated FROM session
                  WHERE "whId" = $1 AND active AND state IN ('PENDING', 'ONGOING') ORDER BY "createdAt"`, W),
      tryQ(wms, `SELECT b.code AS bin, h.code AS hu, hq."skuId"::text AS sku_id, upper(trim(hq.batch)) AS batch, hq.uom, hq.qty::float AS qty
                   FROM handling_unit_quant hq JOIN handling_unit h ON h.id = hq."huId" LEFT JOIN storage_bin b ON b.id = h."storageId"
                  WHERE hq."whId" = $1 AND hq.qty < 0 LIMIT 500`, W),
    ]);
    // sku codes for the quant rows
    const ids = [...new Set([...locked, ...negative].map((r) => r.sku_id).filter(Boolean))];
    const codes = ids.length ? new Map((await q(encarta, "SELECT id::text AS id, code FROM skus WHERE id::text = ANY($1)", [ids])).map((r) => [r.id, r.code])) : new Map();
    for (const r of [...locked, ...negative]) r.sku = codes.get(r.sku_id) || r.sku_id;
    const now = Date.now(), age = (t) => t ? Math.round((now - Date.parse(t)) / 3600000) : null;
    const whyDead = (r) => !r.owner ? "the task or session that locked it no longer exists"
      : r.owner_active === false && !["COMPLETED", "CANCELLED"].includes(r.state) ? `its ${r.owner} is inactive (${r.state})` : `its ${r.owner} is ${r.state}`;
    // inbound/outbound sessions block the Append/Reset upload; the exempt kinds don't
    const EXEMPT = ["INTERNAL_MOVEMENT_HOLDING", "DWS", "HU_SCAN_EXCEPTION", "OUTBOUND_HOLDING"];
    return {
      errors: [e1, e2, e3, e4, e5, e6].filter(Boolean),
      lockedQuants: locked.map((r) => ({ ...r, why: whyDead(r), hours: age(r.task_updated) })),
      lockedHUs: huLocked.map((r) => ({ ...r, why: whyDead(r), hours: age(r.task_updated) })),
      emptyPallets: empty.map((r) => ({ ...r, hours: age(r.since) })),
      inactiveBins: inactive.map((r) => ({ ...r, why: r.status !== "ACTIVE" ? `bin is ${r.status}` : !r.zone_active ? "zone is inactive" : "area is inactive" })),
      sessions: sessions.map((s) => ({ ...s, hours: age(s.created), blocksUpload: !EXEMPT.includes(s.kind) })),
      negative,
    };
  }

  // ---- go-live readiness ---------------------------------------------------------------------
  async function readiness(whId, { refEnv, refWh } = {}) {
    const m = await inventory.loadMasters(whId, { refresh: true });
    const x = await loadExtra(whId);
    const items = [];
    const add = (section, title, level, count, detail, sample = []) => items.push({ section, title, level: count ? level : "pass", count, detail, sample: sample.slice(0, 1000) });
    const info = (section, title, detail) => items.push({ section, title, level: "info", count: 0, detail, sample: [] });

    // open sessions
    const st = await stuck(whId);
    const blocking = st.sessions.filter((s) => s.blocksUpload);
    add("Sessions", "No open session blocks the Append/Reset upload", "fail", blocking.length,
      "The inventory upload refuses to run while these are open.", blocking.map((s) => `${s.kind} ${s.code} (${s.state}, ${s.hours} h)`));

    // SKU master as this warehouse sees it
    const skus = [...m.skus.values()].filter((s) => s.active);
    const noClass = skus.filter((s) => !s.clazz), noL2 = skus.filter((s) => !s.L0inL2), noL3 = skus.filter((s) => !s.L2inL3 && !s.base);
    add("SKUs", `Every active SKU has a class (${m.classType})`, "fail", noClass.length, "Putaway searches by class, so these can't go anywhere.", noClass.map((s) => s.code));
    add("SKUs", "Every active SKU has L0inL2 (units per case)", "fail", noL2.length, "", noL2.map((s) => s.code));
    add("SKUs", "Every active case SKU has L2inL3 (cases per pallet, the best fit)", "warn", noL3.length, "Best fit can't be checked, and putaway falls back to volume.", noL3.map((s) => s.code));

    // can putaway place each class + UOM at all?
    const storageBins = m.bins.filter((b) => STORAGE_AREA(b.areaType) && b.status === "ACTIVE" && b.zoneActive && b.areaActive);
    const combos = new Map();
    for (const s of skus) {
      if (!s.clazz) continue;
      for (const uom of s.base ? ["L0"] : ["L2"]) {
        const k = `${s.clazz}|${uom}`;
        if (!combos.has(k)) combos.set(k, { clazz: s.clazz, uom, skus: [] });
        combos.get(k).skus.push(s.code);
      }
    }
    const homeless = [];
    for (const c of combos.values()) {
      const fake = { clazz: c.clazz };
      const qv = queryValues(x, m, fake, { uom: c.uom, bucket: "Good", batch: "" });
      const n = storageBins.filter((b) => searchFit(x, b, qv).ok).length;
      c.bins = n;
      if (!n) homeless.push(c);
    }
    add("Putaway", "Every class + UOM in use has a storage bin the search rules allow (Good bucket)", "fail", homeless.length,
      "Stock of these SKUs has nowhere to go.", homeless.map((c) => `class ${c.clazz} ${c.uom}: ${c.skus.length} SKUs, e.g. ${c.skus.slice(0, 3).join(", ")}`));
    info("Putaway", "Storage bins per class + UOM", [...combos.values()].sort((a, b) => a.clazz.localeCompare(b.clazz) || a.uom.localeCompare(b.uom))
      .map((c) => `${c.clazz} ${c.uom}: ${c.bins} bins`).join(" · "));

    // bin types
    const types = new Map();
    for (const b of m.bins) if (!types.has(b.binType)) types.set(b.binType, b);
    const palletTypes = [...types.values()].filter((b) => b.huType === "PALLET" && STORAGE_AREA(b.areaType));
    const noCap = palletTypes.filter((b) => !(Number(x.type.get(String(b.binTypeId))?.cap) > 0));
    add("Bins", "Every storage pallet bin type has a pallet capacity", "fail", noCap.length, "Pallet putaway and the capacity checks need it.", noCap.map((b) => b.binType));
    const noVol = [...types.values()].filter((b) => STORAGE_AREA(b.areaType) && !(x.type.get(String(b.binTypeId))?.vol > 0));
    add("Bins", "Every storage bin type has a max volume", "warn", noVol.length, "Without best fit, putaway sizes loose stock by volume.", noVol.map((b) => b.binType));
    const inactiveStorage = m.bins.filter((b) => STORAGE_AREA(b.areaType) && b.status !== "ACTIVE");
    info("Bins", "Storage bins", `${storageBins.length} active, ${inactiveStorage.length} not active, ${storageBins.filter((b) => !m.occupied.has(b.code)).length} active and empty.`);

    // batches: the master check on everything encarta holds for this principal
    const live = await masters.liveBatchCheck(String(m.principalId));
    const pick = (id) => live.checks.find((c) => c.id === id) || { count: 0, detail: "" };
    for (const [id, title, level] of [["B5", "Batch codes follow YY + month + price", "fail"], ["B7", "Batch code month matches the packing date", "fail"],
      ["B8", "Batch code price matches the price", "fail"], ["B10", "Expiry after packing", "fail"], ["B12", "Case config equals L0inL2", "fail"],
      ["B22", "Case config equals the number in the case SKU code", "fail"], ["B21", "Base and case SKUs carry the same batches", "fail"],
      ["B3", "No orphan batches (SKU deleted)", "warn"], ["B17", "No batch code is also a vendor lot of the same SKU", "fail"]]) {
      const c = pick(id);
      // batches are principal-wide, and that list's row numbers mean nothing to a reader
      add("Batches", `${title} (all of this principal's batches)`, level, c.count, c.detail.replace(/row \d+: /g, "").slice(0, 400));
    }
    info("Batches", "Fix sheet", live.fixes.rows ? `A ready-to-upload fix sheet with ${live.fixes.rows} rows is available below.` : "Nothing to fix automatically.");

    // stuck stock in short
    add("Stock", "No stock locked by a finished or missing task", "fail", st.lockedQuants.length + st.lockedHUs.length, "See Stuck stock for the list.");
    add("Stock", "No empty pallets sitting in bins", "warn", st.emptyPallets.length, "They take pallet positions.", st.emptyPallets.map((p) => `${p.hu} in ${p.bin}`));
    add("Stock", "No stock in inactive bins, zones or areas", "warn", st.inactiveBins.length, "", st.inactiveBins.map((r) => `${r.bin}: ${r.why}`));

    // config against a reference warehouse
    let cmp = null;
    if (refWh) {
      try {
        const r = await compare.run({ a: { env: ENV, whId }, b: { env: refEnv || ENV, whId: refWh } });
        cmp = { token: r.token, b: r.b, sections: r.sections.map((s) => ({ name: s.name, same: s.same, diff: s.diff, onlyA: s.onlyA, onlyB: s.onlyB })) };
        const total = cmp.sections.reduce((n, s) => n + s.diff + s.onlyA + s.onlyB, 0);
        add("Config", `Config matches ${refEnv || ENV} ${r.b.name || refWh}`, "warn", total, "Differences aren't always wrong. Open Compare nodes for the details.",
          cmp.sections.filter((s) => s.diff + s.onlyA + s.onlyB).map((s) => `${s.name}: ${s.diff} different, ${s.onlyA} only here, ${s.onlyB} only there`));
      } catch (e) { add("Config", "Config against the reference warehouse", "warn", 1, `Couldn't compare: ${e.message}`); }
    }

    return { whId, principal: m.principalId, loadedAt: m.loadedAt, items, fixToken: live.fixes.rows ? live.token : null, fixRows: live.fixes.rows, cmp,
      verdict: items.some((i) => i.level === "fail") ? "red" : items.some((i) => i.level === "warn") ? "yellow" : "green" };
  }

  // ---- routes --------------------------------------------------------------------------------
  const readBody = async (req) => { const ch = []; for await (const c of req) ch.push(c); return Buffer.concat(ch).toString("utf8"); };
  return async function handle(req, res, u, send) {
    if (!u.pathname.startsWith("/api/ops/")) return false;
    const whId = u.searchParams.get("whId") || "";
    if (!/^\d+$/.test(whId)) { send(res, 400, { error: "Enter the warehouse id first." }); return true; }
    const route = `${req.method} ${u.pathname}`;
    if (route === "GET /api/ops/stuck") send(res, 200, await stuck(whId));
    else if (route === "POST /api/ops/explain") send(res, 200, await explain(whId, JSON.parse((await readBody(req)) || "{}")));
    else if (route === "GET /api/ops/pack-staging")
      send(res, 200, { ...(await staging.check(whId, u.searchParams.get("task"), u.searchParams.get("pallet"))), readOnly: READ_ONLY, env: ENV });
    else if (route === "POST /api/ops/pack-staging/send") {
      if (READ_ONLY) send(res, 403, { error: `${ENV} is read-only in this app. Send the event yourself from Swagger or curl.` });
      else { const b = JSON.parse((await readBody(req)) || "{}"); send(res, 200, await staging.send(whId, b.task, b.pallet)); }
    }
    else if (route === "GET /api/ops/slotting-retrigger") send(res, 200, { ...(await slotting.check(whId)), readOnly: READ_ONLY, env: ENV });
    else if (route === "POST /api/ops/slotting-retrigger/send") {
      if (READ_ONLY) send(res, 403, { error: `${ENV} is read-only in this app. Send the event yourself from Swagger or curl.` });
      else send(res, 200, await slotting.send(whId));
    }
    else if (route === "GET /api/ops/ready") send(res, 200, await readiness(whId, { refEnv: u.searchParams.get("refEnv") || "", refWh: (u.searchParams.get("refWh") || "").trim() }));
    else send(res, 404, { error: "not found" });
    return true;
  };
};
