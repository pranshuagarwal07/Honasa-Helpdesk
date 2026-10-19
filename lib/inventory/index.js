// Inventory tools, the /api/inv/... routes: test case, bulk fill, check a sheet, verify an upload,
// and consolidation: one plan over pallet and shelf bins (consolidate-plan, see planners/combined.js) and the
// three planners behind it (pallets, shelf eaches, bins under % full) on their own routes, with their IM
// upload files. The routes are here; the work is in the files next to this one, lib/wms/ (masters,
// search table, pallets, capacity, locks), lib/planners/ and lib/im-upload/.
const { readBody, isWh, sendXlsx } = require("../core/http");
const { tokenStore } = require("../core/tokens");
const { createMastersLoader } = require("../wms/load-masters");
const { wmsCapacity } = require("../wms/capacity");
const { consolidation, palletPlan, shelfSpread } = require("../planners/pallet-merge");
const { validatePalletPlan } = require("../planners/pallet-merge-check");
const { eachesPlan } = require("../planners/eaches");
const { validatePlan } = require("../planners/eaches-check");
const { relocatePlan } = require("../planners/relocate");
const { validateRelocate } = require("../planners/relocate-check");
const { eachesScope, eachesTypes, relocateScope, relocateInput, eachesInput } = require("../planners/inputs");
const { relocateWorkbook, eachesWorkbook, combinedWorkbook } = require("../planners/workbooks");
const { splitCells, combinePlans, notEmptiedOf } = require("../planners/combined");
const { imFiles, imWorkbook, palletLines, palletImRows, relocateImRows, chainImRows, eachesImRows, imSummary } = require("../im-upload");
const { chainPlan, validateChain, mergeInputOf } = require("../planners/chain");
const { snapshot, catalog } = require("./catalog");
const { build } = require("./fill");
const { validate, checksCatalog, annotatedSheet } = require("./check");
const { verify } = require("./verify");
const { normalizeRows } = require("./testcase");
const { readSheet, writeSheet } = require("./sheet");
const { templateFor, hasTemplate, templateHeaders, saveTemplate } = require("./templates");

module.exports = function inventoryModule({ wms, encarta, q, tryQ }) {
  const db = { wms, encarta, q, tryQ };
  const loadMasters = createMastersLoader(db);
  const builds = tokenStore(6 * 3600000); // { whId, rows, headers, prefix, at, target, failed } for the fill download and verify
  const checked = tokenStore(2 * 3600000); // { whId, buffer, v, cons, m, name, at } for the annotated download
  const eachPlans = tokenStore(2 * 3600000); // { whId, m, plan, check, im, imHeld, at } for the eaches plan download
  const relocPlans = tokenStore(2 * 3600000); // { whId, m, plan, check, im, imHeld, at } for the "bins under % full" download
  const unified = tokenStore(2 * 3600000); // { whId, m, goal, parts, combined, check, im, imHeld, shelf, at } for the one Consolidate plan

  // ---- routes ----------------------------------------------------------------------
  async function handle(req, res, u, send) {
    if (!u.pathname.startsWith("/api/inv/")) return false;
    // the list of checks is the same for every warehouse
    if (req.method === "GET" && u.pathname === "/api/inv/check-catalog") { send(res, 200, checksCatalog()); return true; }
    const whId = u.searchParams.get("whId") || "";
    if (!isWh(whId)) { send(res, 400, { error: "whId must be a number" }); return true; }
    const principalId = u.searchParams.get("principalId") || undefined;
    const route = `${req.method} ${u.pathname}`;

    if (route === "GET /api/inv/snapshot") {
      const m = await loadMasters(whId, { principalId, refresh: u.searchParams.get("refresh") === "1" });
      send(res, 200, { ...snapshot(m), template: { custom: hasTemplate(whId), headers: templateFor(whId) } });
    } else if (route === "POST /api/inv/build") {
      const o = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!o.huPrefix || !/^[A-Za-z0-9_-]{2,20}$/.test(o.huPrefix)) { send(res, 400, { error: "HU prefix must be 2 to 20 letters, digits, - or _." }); return true; }
      if (o.huLength !== undefined && o.huLength !== null) {
        const n = Number(o.huLength);
        if (!Number.isInteger(n) || n < o.huPrefix.length + 1 || n > 40) {
          send(res, 400, { error: `Pallet code length must be a whole number from ${o.huPrefix.length + 1} (the prefix plus one digit) to 40.` }); return true;
        }
      }
      const m = await loadMasters(whId, { principalId });
      const b = build(m, o);
      if (b.huCodes?.overflow) {
        const need = o.huPrefix.length + String(b.totals.newHUs).length;
        send(res, 400, { error: `This fill needs ${b.totals.newHUs.toLocaleString()} pallet codes, more than ${b.huCodes.digits} digit${b.huCodes.digits > 1 ? "s" : ""} can count. Make the pallet code length at least ${need}.` });
        return true;
      }
      const v = validate(m, b.rows, { shelfLifeDays: o.shelfLifeDays });
      const token = builds.put({ whId, rows: b.rows, headers: templateFor(whId), prefix: o.huPrefix, at: Date.now(), target: o.target, failed: v.failed });
      send(res, 200, { token, ...b, rows: b.rows.slice(0, 200), validation: v });
    } else if (route === "GET /api/inv/download") {
      const b = builds.get(u.searchParams.get("token"));
      if (!b || b.whId !== whId) { send(res, 404, { error: "That fill has expired. Build it again." }); return true; }
      if (b.failed) { send(res, 409, { error: "This fill has failing checks, so it can't be downloaded." }); return true; }
      const buf = await writeSheet(b.rows, b.headers);
      sendXlsx(res, `Append_Inventory_${whId}_${Math.round(Number(b.target) * 100)}pct_${b.prefix}.xlsx`, buf);
    } else if (route === "POST /api/inv/check") {
      // fresh masters: the point is to check against the stock in the bins right now
      const buffer = await readBody(req);
      const sheet = await readSheet(buffer);
      const m = await loadMasters(whId, { principalId, refresh: true, skuCodes: sheet.rows.map((r) => r.sku) });
      const shelf = Number(u.searchParams.get("shelfLifeDays") || 180);
      const skip = new Set(String(u.searchParams.get("skip") || "").split(",").map((x) => x.trim()).filter(Boolean));
      const v = validate(m, sheet.rows, { headers: sheet.headers, sheetNames: sheet.sheetNames, shelfLifeDays: shelf, skip });
      const cons = consolidation(m, sheet.rows);
      const token = checked.put({ whId, buffer, v, cons, m, name: String(u.searchParams.get("name") || "sheet").replace(/\.xlsx$/i, ""), at: Date.now() });
      send(res, 200, { rows: sheet.rows.length, ...v, token, loadedAt: m.loadedAt, consolidation: {
        isReset: cons.isReset, stats: cons.stats, zones: cons.zones, merges: cons.merges.slice(0, 100), moves: cons.moves.length,
        shelf: { groups: cons.shelf.groups, extraBins: cons.shelf.extraBins, top: cons.shelf.top.slice(0, 30) } } });
    } else if (route === "GET /api/inv/consolidate-plan") {
      // The one Consolidate screen. goal: "empty" (default) or "tidy"; from, to: "zone|binType" cells of pallet and shelf
      // bins (to empty = the same as from); crossZone=1; checkWeight (default 1); objective=positions|bins (default: bins for
      // Empty bins, positions for Tidy pallets);
      // tidy: wholePallets (default 1); empty: belowPct (default 100), useEmpty, skipEmptyPalletBins (default 1), mergeFirst (default 1:
      // merge part-full pallets first, kept only when it frees more; planners/chain.js),
      // shelf units uoms (default L0) and fillPct (default 100)
      const list = (k) => String(u.searchParams.get(k) || "").split(",").map((x) => x.trim()).filter(Boolean);
      const p1 = (k, d) => (u.searchParams.get(k) ?? d) === "1";
      const goal = u.searchParams.get("goal") === "tidy" ? "tidy" : "empty";
      const fromCells = list("from"), toCells = list("to").length ? list("to") : fromCells;
      if (!fromCells.length) { send(res, 400, { error: "Tick at least one bin type to take stock from." }); return true; }
      const opts = { goal, from: fromCells, to: toCells, crossZone: p1("crossZone", "0"), checkWeight: p1("checkWeight", "1"),
        objective: ["bins", "positions"].includes(u.searchParams.get("objective")) ? u.searchParams.get("objective") : goal === "tidy" ? "positions" : "bins", wholePallets: p1("wholePallets", "1"),
        belowPct: Math.min(100, Math.max(0.01, Number(u.searchParams.get("belowPct")) || 100)), useEmpty: u.searchParams.get("useEmpty") || "smaller",
        skipEmptyPalletBins: p1("skipEmptyPalletBins", "1"), mergeFirst: p1("mergeFirst", "1"), uoms: list("uoms").length ? list("uoms") : ["L0"], fillPct: Number(u.searchParams.get("fillPct")) || 100 };
      // fresh: the plan is only as good as the stock it was read from
      const m = await loadMasters(whId, { principalId, refresh: true });
      const cap = await wmsCapacity(db, whId, m);
      const F = splitCells(m, fromCells), T = splitCells(m, toCells), parts = [], notes = [];
      const note = (text) => notes.push({ level: "info", code: "scope", text, bins: [] });
      if (F.unknown.length || T.unknown.length) note(`${[...new Set([...F.unknown, ...T.unknown])].join(", ")}: no inventory bins of that zone and bin type, so left out.`);
      const common = { crossZone: opts.crossZone, checkWeight: opts.checkWeight, objective: opts.objective };
      if (goal === "tidy") {
        if (!F.pallet.length) { send(res, 400, { error: "Tidy pallets works on pallet bins: tick at least one pallet bin type to take from." }); return true; }
        if (!T.pallet.length) { send(res, 400, { error: "Tick at least one pallet bin type to put the pallets into." }); return true; }
        if (F.shelf.length || T.shelf.length) note("Tidy pallets works on pallet bins only, so the shelf bin types ticked were left out. Pick Empty bins to empty shelf bins.");
        // one stock and lock read for every planner (the old Pallets route's own read is retired)
        const input = mergeInputOf(await relocateInput(db, whId, m, cap));
        const plan = palletPlan(input, { ...common, from: F.pallet, to: T.pallet, wholePallets: opts.wholePallets });
        parts.push({ kind: "pallet", engine: "pallets", input, plan, check: validatePalletPlan(input, plan) });
      } else {
        for (const [kind, f, t] of [["Pallet", F.pallet, T.pallet], ["Shelf", F.shelf, T.shelf]]) {
          if (f.length && !t.length) note(`${kind} bin types are ticked to empty, but none to move into (pallet stock only goes to pallet bins, shelf stock to shelf bins), so they were left out.`);
        }
        if (F.pallet.length && T.pallet.length) {
          const input = await relocateInput(db, whId, m, cap);
          const po = { ...common, belowPct: opts.belowPct, useEmpty: opts.useEmpty, skipEmptyPalletBins: opts.skipEmptyPalletBins };
          if (opts.mergeFirst) {
            const plan = chainPlan(input, { ...po, from: F.pallet, to: T.pallet });
            parts.push({ kind: "pallet", engine: "chain", input, plan, check: validateChain(plan) });
          } else {
            const plan = relocatePlan(input, { ...po, from: { cells: F.pallet }, to: { cells: T.pallet } });
            parts.push({ kind: "pallet", engine: "relocate", input, plan, check: validateRelocate(input, plan) });
          }
        }
        if (F.shelf.length && T.shelf.length) {
          const input = await eachesInput(db, whId, m, cap);
          const plan = eachesPlan(input, { crossZone: opts.crossZone, checkWeight: opts.checkWeight, from: F.shelf, to: T.shelf, uoms: opts.uoms, fillPct: opts.fillPct, emptyBelowPct: opts.belowPct });
          parts.push({ kind: "shelf", engine: "eaches", input, plan, check: validatePlan(input, plan) });
        }
        if (!parts.length) { send(res, 400, { error: "Tick bin types to empty and bin types of the same kind (pallet or shelf) to move into." }); return true; }
      }
      const c = combinePlans(parts, { goal, opts, notes });
      const rowsOf = (p) => ({ pallets: palletImRows, relocate: relocateImRows, chain: chainImRows, eaches: eachesImRows })[p.engine](p.plan);
      const { files: im, held: imHeld } = imFiles(parts.flatMap(rowsOf), cap);
      // moves = IM rows (equal rows merge in the upload); heldBack should stay 0: every planner met the capacity check
      c.stats.plannedMoves = c.steps.length;
      c.stats.moves = im.reduce((t, x) => t + x.rows.length, 0) + imHeld.length;
      c.stats.heldBack = imHeld.length;
      const pal = parts.find((p) => p.engine === "pallets"), shelf = pal ? shelfSpread(m) : null;
      const token = unified.put({ whId, m, goal, parts, combined: c, check: c.check, im, imHeld, shelf, at: Date.now() });
      const notEmptied = notEmptiedOf(parts);
      const whyKey = (w) => (w.startsWith("No bin takes") ? "No bin can take its stock" : w.replace(/ \(.*\)$/, ""));
      send(res, 200, { token, loadedAt: m.loadedAt, goal, opts, stats: c.stats, check: { ok: c.check.ok, errs: c.check.errs.slice(0, 10) }, warnings: c.warnings,
        zones: c.zones, parts: c.parts, moves: c.steps.length, steps: c.steps.slice(0, 1000), stepsCount: c.steps.length, im: imSummary(im), imHeld: imHeld.length,
        fixedError: parts.some((p) => p.input.fixedError) ? "Couldn't read fixed bin mappings on this schema, so fixed bins may appear in the plan." : null,
        notEmptied: notEmptied.slice(0, 300), notEmptiedCount: notEmptied.length,
        notEmptiedBy: notEmptied.reduce((t, x) => ({ ...t, [whyKey(x.why)]: (t[whyKey(x.why)] || 0) + 1 }), {}),
        // tidy: the Pallets plan's own detail (merge groups, whole-pallet bins, shelf SKU-batches spread over bins)
        ...(pal ? { merges: pal.plan.merges.slice(0, 100), pack: { stats: pal.plan.pack.stats, bins: pal.plan.pack.bins.slice(0, 100) },
          shelf: { groups: shelf.groups, extraBins: shelf.extraBins, top: shelf.top.slice(0, 30) } } : {}) });
    } else if (route === "GET /api/inv/consolidate-plan-download") {
      const p = unified.get(u.searchParams.get("token"));
      if (!p || p.whId !== whId) { send(res, 404, { error: "That plan has expired. Run it again." }); return true; }
      const buf = await combinedWorkbook(p);
      sendXlsx(res, `Consolidation_${p.goal}_${whId}_${new Date(p.m.loadedAt).toISOString().slice(0, 10)}.xlsx`, buf);
    } else if (route === "GET /api/inv/eaches-scope") {
      const m = await loadMasters(whId, { principalId });
      send(res, 200, { areas: eachesScope(m), binTypes: eachesTypes(m) });
    } else if (route === "GET /api/inv/consolidate-eaches") {
      // fresh: the plan is only as good as the stock it was read from
      const m = await loadMasters(whId, { principalId, refresh: true });
      const list = (k) => String(u.searchParams.get(k) || "").split(",").map((x) => x.trim()).filter(Boolean);
      const opts = { areas: list("areas"), zones: list("zones"), crossZone: u.searchParams.get("crossZone") === "1",
        fillPct: Number(u.searchParams.get("fillPct")) || 100, checkWeight: u.searchParams.get("checkWeight") !== "0",
        binTypes: list("binTypes"), uoms: list("uoms").length ? list("uoms") : ["L0"], emptyBelowPct: Number(u.searchParams.get("emptyBelowPct")) || 100 };
      const cap = await wmsCapacity(db, whId, m);
      const input = await eachesInput(db, whId, m, cap);
      const plan = eachesPlan(input, opts);
      const check = validatePlan(input, plan); // a second, independent pass over every move
      const { files: im, held: imHeld } = imFiles(eachesImRows(plan), cap);
      const token = eachPlans.put({ whId, m, plan, check, im, imHeld, at: Date.now() });
      send(res, 200, { token, loadedAt: m.loadedAt, opts: plan.opts, stats: plan.stats, check: { ok: check.ok, errs: check.errs.slice(0, 10) }, im: imSummary(im), imHeld: imHeld.length,
        fixedError: input.fixedError ? "Couldn't read fixed bin mappings on this schema, so fixed bins may appear in the plan." : null,
        moves: plan.moves.slice(0, 400), emptied: plan.emptied.length, targets: plan.targets.length,
        leftOut: plan.leftOut.slice(0, 200), leftOutCount: plan.leftOut.length,
        leftOutBy: plan.leftOut.reduce((t, x) => ({ ...t, [x.reason]: (t[x.reason] || 0) + 1 }), {}) });
    } else if (route === "GET /api/inv/relocate-scope") {
      const m = await loadMasters(whId, { principalId, refresh: u.searchParams.get("refresh") === "1" });
      send(res, 200, { areas: relocateScope(m) });
    } else if (route === "GET /api/inv/relocate") {
      const list = (k) => String(u.searchParams.get(k) || "").split(",").map((x) => x.trim()).filter(Boolean);
      const opts = { from: { cells: list("from") }, to: { cells: list("to") }, belowPct: Number(u.searchParams.get("belowPct")) || 100,
        useEmpty: u.searchParams.get("useEmpty") || "smaller", checkWeight: u.searchParams.get("checkWeight") !== "0",
        objective: u.searchParams.get("objective") || "positions", skipEmptyPalletBins: u.searchParams.get("skipEmptyPalletBins") !== "0",
        crossZone: u.searchParams.get("crossZone") === "1" };
      if (!opts.from.cells.length || !opts.to.cells.length) { send(res, 400, { error: "Tick at least one bin type on each side: bins to empty, and bins to move into." }); return true; }
      // fresh: the plan is only as good as the stock it was read from
      const m = await loadMasters(whId, { principalId, refresh: true });
      const cap = await wmsCapacity(db, whId, m);
      const input = await relocateInput(db, whId, m, cap);
      const plan = relocatePlan(input, opts);
      const check = validateRelocate(input, plan); // a second, independent replay of every step
      const { files: im, held: imHeld } = imFiles(relocateImRows(plan), cap);
      const token = relocPlans.put({ whId, m, plan, check, im, imHeld, at: Date.now() });
      send(res, 200, { token, loadedAt: m.loadedAt, opts: plan.opts, stats: plan.stats, check: { ok: check.ok, errs: check.errs.slice(0, 10) }, im: imSummary(im), imHeld: imHeld.length,
        fixedError: input.fixedError ? "Couldn't read fixed bin mappings on this schema, so fixed bins may appear in the plan." : null,
        moves: plan.moves.slice(0, 500), emptied: plan.emptied.slice(0, 500), notEmptied: plan.notEmptied.slice(0, 300), notEmptiedCount: plan.notEmptied.length,
        notEmptiedBy: plan.notEmptied.reduce((t, x) => { const k = x.why.startsWith("No bin takes") ? "No bin can take its stock" : x.why; return { ...t, [k]: (t[k] || 0) + 1 }; }, {}) });
    } else if (route === "GET /api/inv/relocate-download") {
      const p = relocPlans.get(u.searchParams.get("token"));
      if (!p || p.whId !== whId) { send(res, 404, { error: "That plan has expired. Run it again." }); return true; }
      const buf = await relocateWorkbook(p);
      sendXlsx(res, `Bins_under_${p.plan.opts.belowPct}pct_${whId}_${new Date(p.m.loadedAt).toISOString().slice(0, 10)}.xlsx`, buf);
    } else if (route === "GET /api/inv/consolidate-eaches-download") {
      const p = eachPlans.get(u.searchParams.get("token"));
      if (!p || p.whId !== whId) { send(res, 404, { error: "That plan has expired. Run it again." }); return true; }
      const buf = await eachesWorkbook(p);
      sendXlsx(res, `Eaches_consolidation_${whId}_${new Date(p.m.loadedAt).toISOString().slice(0, 10)}.xlsx`, buf);
    } else if (route === "GET /api/inv/im-download") {
      // one IM cockpit upload file of a plan, as Sheet1 alone
      const kind = u.searchParams.get("plan");
      const p = ({ eaches: eachPlans, relocate: relocPlans, unified })[kind]?.get(u.searchParams.get("token"));
      if (!p || p.whId !== whId) { send(res, 404, { error: "That plan has expired. Run it again." }); return true; }
      if (p.check && !p.check.ok) { send(res, 409, { error: "The plan failed its re-check, so it can't be uploaded." }); return true; }
      const file = p.im.find((x) => x.n === Number(u.searchParams.get("file") || 1));
      if (!file) { send(res, 404, { error: "That plan has no such upload file." }); return true; }
      const buf = await imWorkbook(file);
      sendXlsx(res, `IM_upload_${kind}_${file.n}_of_${p.im.length}_${whId}_${new Date(p.m.loadedAt).toISOString().slice(0, 10)}.xlsx`, buf);
    } else if (route === "GET /api/inv/check-download") {
      const c = checked.get(u.searchParams.get("token"));
      if (!c || c.whId !== whId) { send(res, 404, { error: "That check has expired. Drop the sheet again." }); return true; }
      const buf = await annotatedSheet(c.m, c.buffer, c.v, c.cons);
      sendXlsx(res, `Checked_${c.name.replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60)}_${whId}.xlsx`, buf);
    } else if (route === "POST /api/inv/verify") {
      const token = u.searchParams.get("token");
      let rows, prefix = u.searchParams.get("prefix") || "";
      if (token) {
        const b = builds.get(token);
        if (!b || b.whId !== whId) { send(res, 404, { error: "That fill has expired. Drop the uploaded file instead." }); return true; }
        rows = b.rows; prefix = prefix || b.prefix;
      } else if (/json/.test(req.headers?.["content-type"] || "")) {
        const body = JSON.parse((await readBody(req)).toString("utf8"));
        rows = normalizeRows(body.rows || []);
        prefix = prefix || body.prefix || "";
      } else {
        rows = (await readSheet(await readBody(req))).rows;
      }
      send(res, 200, await verify(db, whId, rows, prefix));
    } else if (route === "POST /api/inv/parse") {
      const sheet = await readSheet(await readBody(req));
      send(res, 200, { rows: sheet.rows, headers: sheet.headers });
    } else if (route === "GET /api/inv/catalog") {
      const m = await loadMasters(whId, { principalId, refresh: u.searchParams.get("refresh") === "1" });
      send(res, 200, catalog(m));
    } else if (route === "POST /api/inv/validate-rows") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const rows = normalizeRows(body.rows || []);
      const m = await loadMasters(whId, { principalId, skuCodes: rows.map((r) => r.sku) });
      send(res, 200, validate(m, rows, { shelfLifeDays: body.shelfLifeDays ?? 0, mode: "testcase" }));
    } else if (route === "POST /api/inv/export") {
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      const rows = normalizeRows(body.rows || []);
      const m = await loadMasters(whId, { principalId, skuCodes: rows.map((r) => r.sku) });
      if (!rows.length) { send(res, 400, { error: "Add at least one row first." }); return true; }
      const v = validate(m, rows, { shelfLifeDays: body.shelfLifeDays ?? 0, mode: "testcase" });
      if (v.failed) { send(res, 409, { error: `${v.failed} check${v.failed > 1 ? "s" : ""} still fail. Fix the highlighted rows first.` }); return true; }
      const buf = await writeSheet(rows, templateFor(whId));
      const name = String(body.name || "test-case").replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 60);
      sendXlsx(res, `TC_${name}_${whId}.xlsx`, buf);
    } else if (route === "POST /api/inv/template") {
      const headers = await templateHeaders(await readBody(req));
      saveTemplate(whId, headers);
      send(res, 200, { headers });
    } else {
      send(res, 404, { error: "not found" });
    }
    return true;
  }
  // the encarta principal behind a warehouse, for the master checks
  handle.principalOf = async (whId) => (await loadMasters(whId)).principalId;
  handle.loadMasters = loadMasters;
  return handle;
};
