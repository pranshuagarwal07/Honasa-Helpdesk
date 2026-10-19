// Consolidate stock: one form over pallet and shelf bins (GET /api/inv/consolidate-plan) with two goals, Empty bins
// and Tidy pallets. One result view: blockers first, then what the plan frees
// (gross and net, never just "freed"), the IM upload files in order, each zone before and after,
// and every move in a table a supervisor can sort and filter. Every field of the v2 output contract
// (docs/CONSOLIDATION_V2.md) is optional here: on a server without it the view falls back to the
// fields the planners return today.

// ---- small helpers (names kept apart from the other tool files' globals) -------------
const csNum = x => typeof x === 'number' && Number.isFinite(x);
const csPick = (...xs) => xs.find(csNum);
const csFmt = x => csNum(x) ? fmt(x) : '–';
const csPl = (n, w, ws) => `${fmt(n)} ${n === 1 ? w : ws || w + 's'}`;
const csP1 = x => !csNum(x) ? '–' : (x < 10 ? x.toFixed(1) : Math.round(x)) + '%';
const csNat = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), undefined, {numeric: true});
const csDl = href => { const a = document.createElement('a'); a.href = href; document.body.append(a); a.click(); a.remove(); };
const csStore = (k, v) => { try { v === undefined ? localStorage.removeItem(k) : localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)); } catch {} };
const csLoad = k => { try { return localStorage.getItem(k); } catch { return null; } };
const csUnit = (q, u) => !csNum(q) ? '–' : `${fmt(q)} ${u === 'L2' ? (q === 1 ? 'case' : 'cases') : u === 'L0' ? (q === 1 ? 'each' : 'eaches') : u === 'L3' ? (q === 1 ? 'pallet' : 'pallets') : esc(u || '')}`.trim();
const CS_KIND = {pallet: 'Whole pallet', merge: 'Onto pallet', samebin: 'Same-bin merge', pour: 'Loose into bin'};
const CS_LV = {block: 'fail', warn: 'warn', info: 'info'};
const CS_PAGE = 100;

// ---- reading a plan response (today's shape or the v2 contract) ----------------------
// what kind of move: whole pallet, cases onto another pallet (in another bin or the same one), loose pour
function csMoveKind(m) {
  const k = String(m.kind || '').toLowerCase().replace(/[^a-z]/g, ''), same = !!m.fromBin && m.fromBin === m.toBin;
  if (['pallet', 'whole', 'wholepallet', 'pack', 'move'].includes(k) || m.whole === true || m.pickHu === true) return 'pallet';
  if (k === 'samebin' || k === 'samebinmerge') return 'samebin';
  if (k === 'pour' || k === 'loose') return 'pour';
  if (k === 'merge' || k === 'onto' || k === 'ontopallet') return same ? 'samebin' : 'merge';
  if (m.toHu || m.cases !== undefined || m.share !== undefined) return same ? 'samebin' : 'merge';
  return m.hu ? 'pallet' : 'pour';
}
function csMoves(list) {
  return (Array.isArray(list) ? list : []).map((m, i) => {
    const kind = csMoveKind(m), fromZone = m.fromZone ?? m.zone ?? '', toZone = m.toZone ?? m.zone ?? '';
    const hu = m.hu ?? m.fromHu ?? '', toHu = m.toHu ?? (kind === 'pallet' ? hu : '');
    const x = {step: csPick(m.step) ?? i + 1, kind, fromBin: m.fromBin || '', toBin: m.toBin || '', fromZone, toZone,
      fromArea: m.fromArea || '', toArea: m.toArea || '', hu, toHu, sku: m.sku || '', batch: m.batch || '', stock: m.stock || '',
      qty: csPick(m.qty, m.cases, m.units) ?? null, uom: m.uom || (m.cases !== undefined ? 'L2' : ''),
      crossZone: typeof m.crossZone === 'boolean' ? m.crossZone : !!(fromZone && toZone && fromZone !== toZone),
      toWasEmpty: !!m.toWasEmpty, stage: m.stage, fromOccPct: m.fromOccPct, toPalletAfter: m.toPalletAfter, toPositions: m.toPositions, toCap: m.toCap,
      toKgAfter: m.toKgAfter, toMaxKg: m.toMaxKg, toUsedAfterCC: m.toUsedAfterCC, toBinVolCC: m.toBinVolCC};
    x.text = [x.fromBin, x.toBin, x.hu, x.toHu, x.sku, x.batch, x.stock, x.fromZone, x.toZone].join(' ').toLowerCase();
    return x;
  });
}
// the headline numbers, from the contract's stats or worked out from today's fields
function csStats(r, kind, moves) {
  const s = r.stats || {}, v2 = csNum(s.netBinsFreed);
  const shown = moves.length, cross = shown ? moves.filter(m => m.crossZone).length : null;
  // the Pallets route lists its moves as steps (first 1000 of stepsCount); Bins under % full as moves (stats.moves in all)
  const steps = csPick(r.stepsCount, s.moves), partial = csNum(steps) && steps > shown;
  if (kind === 'pallet' && !v2) {
    // today: merges only pour onto pallets already in a bin, and whole-pallet moves go to bins holding pallets,
    // so no empty bin is used; each pallet merged away frees its position
    const p = (r.pack && r.pack.stats) || {}, merged = s.binsEmptied || 0, packed = p.bins || 0;
    return {kind, legacy: true, binsEmptied: merged + packed, emptyBinsUsed: 0, netBinsFreed: merged + packed,
      positionsFreed: csPick(s.frees) ?? null, palletsFreed: csPick(s.frees) ?? null,
      moves: (csNum(r.moves) ? r.moves : shown) + (p.pallets || 0), casesMoved: null, crossZoneMoves: cross,
      heldBack: csPick(r.imHeld) ?? null, split: {merged, packed}, partial: false, shown};
  }
  const be = csPick(s.binsEmptied), eu = csPick(s.emptyBinsUsed);
  return {kind, legacy: !v2, binsEmptied: be ?? null, emptyBinsUsed: eu ?? null,
    netBinsFreed: csPick(s.netBinsFreed, s.netFreed, csNum(be) && csNum(eu) ? be - eu : undefined) ?? null,
    positionsFreed: csPick(s.positionsFreed) ?? null,
    palletsFreed: csPick(s.palletsFreed, s.palletsMerged, kind === 'pallet' ? s.frees : undefined) ?? null,
    moves: csPick(s.moves, csNum(r.moves) ? r.moves : undefined, shown) ?? null,
    casesMoved: csPick(s.casesMoved, s.unitsMoved) ?? null,
    crossZoneMoves: csPick(s.crossZoneMoves, partial ? undefined : cross) ?? null, crossShown: cross,
    heldBack: csPick(s.heldBack, r.imHeld) ?? null, partial, shown, steps};
}
const csCells = x => Array.isArray(x) ? x : x && Array.isArray(x.cells) ? x.cells : typeof x === 'string' ? x.split(',').filter(Boolean) : [];
// blockers, warnings and notes: the contract's warnings[] plus what today's fields say
function csWarnings(r, kind, st, moves, sent = {}) {
  const out = (Array.isArray(r.warnings) ? r.warnings : []).map(w => ({level: CS_LV[w.level] ? w.level : 'warn', code: String(w.code || ''),
    text: String(w.text || w.code || 'Warning'), bins: Array.isArray(w.bins) ? w.bins.map(String) : [], items: Array.isArray(w.items) ? w.items : []}));
  const has = code => out.some(w => w.code === code);
  if (r.check && r.check.ok === false) out.unshift({level: 'block', code: 're-check', text: "The re-check found problems, so this plan can't be uploaded. Don't use it.", bins: [],
    items: (r.check.errs || []).map(String)});
  if (csNum(st.heldBack) && st.heldBack > 0 && !has('held-back')) out.push({level: 'warn', code: 'held-back',
    text: `${csPl(st.heldBack, 'planned move')} left out of the IM upload: the WMS would refuse ${st.heldBack === 1 ? 'it' : 'them'} with "Qty exceeds bin capacity". The bins ${st.heldBack === 1 ? 'it' : 'they'} would empty stay as they are, so the numbers below are higher than what the upload does. The workbook's Not in IM upload sheet lists each one.`,
    bins: Array.isArray(r.heldBins) ? r.heldBins : [], items: []});
  if (r.lockError && !has('lock-read-failed')) out.push({level: 'warn', code: 'lock-read-failed', text: String(r.lockError), bins: [], items: []});
  if (r.fixedError && !has('fixed-read-failed')) out.push({level: 'warn', code: 'fixed-read-failed', text: String(r.fixedError), bins: [], items: []});
  const xz = moves.filter(m => m.crossZone);
  if (xz.length && !has('cross-zone')) out.push({level: 'info', code: 'cross-zone',
    text: `${csPl(xz.length, 'move')}${st.partial ? ' of those listed' : ''} ${xz.length === 1 ? 'goes' : 'go'} to another zone. Same storage location, so the ERP allows it, but it's heavier work for the floor.`,
    bins: [...new Set(xz.flatMap(m => [m.fromBin, m.toBin]))], items: []});
  if (kind === 'pallet' && r.stats && r.stats.unsized && !has('no-best-fit')) out.push({level: 'info', code: 'no-best-fit',
    text: `${csPl(r.stats.unsized, 'pallet')} without a best fit (no L2inL3 on the SKU), so ${r.stats.unsized === 1 ? 'it was' : 'they were'} left alone.`, bins: [], items: []});
  // a server that doesn't echo the options may be running the old planner, which ignores them
  const sentOpts = Object.keys(sent).filter(k => sent[k] !== undefined && sent[k] !== '');
  if (sentOpts.length && !r.opts) out.push({level: 'info', code: 'old-planner', text: "The server didn't echo the options it used, so it may be running the old planner, which ignores the scope and rules you picked. Restart the server after the planner update and run again.", bins: [], items: []});
  else if (r.opts && sentOpts.length) {
    const missing = sentOpts.filter(k => !['from', 'to'].includes(k) && r.opts[k] === undefined);
    if (missing.length) out.push({level: 'info', code: 'opts-ignored', text: `The server ignored ${missing.join(', ')}; this plan was made without ${missing.length === 1 ? 'it' : 'them'}.`, bins: [], items: []});
  }
  const order = {block: 0, warn: 1, info: 2};
  return out.sort((a, b) => order[a.level] - order[b.level]);
}
// zones after the plan; today's pallet zones count before it, and Bins under % full has none yet
function csZones(r, kind, moves, scope) {
  const zs = Array.isArray(r.zones) ? r.zones : [];
  if (zs.length) return zs.map(z => {
    const v2 = csNum(z.positionsFreed) || csNum(z.binsEmptied);
    const freed = v2 ? z.positionsFreed || 0 : z.frees || 0;
    const usedAfter = csNum(z.used) ? (v2 ? z.used : z.used - freed) : null;
    const usedBefore = csPick(z.usedBefore, csNum(z.used) ? (v2 ? z.used + freed : z.used) : undefined) ?? null;
    return {zone: z.zone || '(no zone)', area: z.area || '', positions: csPick(z.positions) ?? null, usedBefore, usedAfter,
      spare: csPick(v2 ? z.spare : undefined, csNum(z.positions) && csNum(usedAfter) ? z.positions - usedAfter : undefined) ?? null,
      binsEmptied: csPick(z.binsEmptied, z.binsFreed) ?? null, emptyUsed: csPick(z.emptyBinsUsed) ?? null, positionsFreed: freed};
  }).filter(z => z.positions || z.binsEmptied || z.positionsFreed).sort((a, b) => (b.positionsFreed || 0) - (a.positionsFreed || 0) || csNat(a.zone, b.zone));
  // worked out from the bins emptied, the empty bins used and the pallet positions of each bin type
  const cell = new Map(), zone = new Map();
  for (const a of scope || []) for (const z of a.zones || []) for (const t of z.types || []) {
    cell.set(`${z.zone}|${t.binType}`, t);
    if (!zone.has(z.zone)) zone.set(z.zone, {area: a.area, positions: 0});
    if (t.kind === 'PALLET') zone.get(z.zone).positions += (t.bins || 0) * Math.max(1, t.cap || 1);
  }
  const posOf = (z, bt, isPallet) => { const t = cell.get(`${z}|${bt}`); return t ? (t.kind === 'PALLET' ? Math.max(1, t.cap || 1) : 0) : isPallet ? 1 : 0; };
  const rows = new Map(), row = z => { if (!rows.has(z)) rows.set(z, {zone: z || '(no zone)', area: zone.get(z)?.area || '', positions: zone.get(z)?.positions || null,
    usedBefore: null, usedAfter: null, spare: null, binsEmptied: 0, emptyUsed: 0, positionsFreed: 0}); return rows.get(z); };
  for (const e of Array.isArray(r.emptied) ? r.emptied : []) { const x = row(e.zone); x.binsEmptied++; x.positionsFreed += posOf(e.zone, e.binType, e.kind === 'pallet'); }
  const seen = new Set();
  for (const m of moves) if (m.toWasEmpty && !seen.has(m.toBin)) {
    seen.add(m.toBin); const x = row(m.toZone), src = (Array.isArray(r.moves) ? r.moves : r.steps || []).find(o => o.toBin === m.toBin);
    x.emptyUsed++; x.positionsFreed -= posOf(m.toZone, src && src.toBinType, m.kind !== 'pour');
  }
  return [...rows.values()].sort((a, b) => b.positionsFreed - a.positionsFreed || csNat(a.zone, b.zone));
}
function csImFiles(r) {
  const all = Array.isArray(r.im) ? r.im : [];
  return all.map((f, i) => {
    const n = csPick(f.n) ?? i + 1, wave = csPick(f.wave) ?? 1;
    let after = f.after ?? f.uploadAfter;
    if (after === undefined || after === null) after = all.filter(g => (csPick(g.wave) ?? 1) < wave).map((g, j) => csPick(g.n) ?? j + 1);
    if (csNum(after)) after = [after];
    return {n, wave, what: String(f.what || 'Moves'), rows: csPick(f.rows) ?? null, whole: csPick(f.whole) ?? 0, sameBin: !!f.sameBin, after, note: f.note ? String(f.note) : ''};
  });
}
function csModel(r, kind, ctx = {}) {
  const moves = csMoves(Array.isArray(r.steps) ? r.steps : r.moves), st = csStats(r, kind, moves);
  st.imRows = Array.isArray(r.im) ? r.im.reduce((t, f) => t + (csPick(f.rows) || 0), 0) : null;
  const warns = csWarnings(r, kind, st, moves, ctx.sent || {});
  return {r, kind, plan: ctx.plan || (kind === 'pallet' ? 'pallet' : 'relocate'), st, moves, warns, zones: csZones(r, kind, moves, ctx.scope), im: csImFiles(r),
    checkFailed: !!(r.check && r.check.ok === false), blocks: warns.filter(w => w.level === 'block' && w.code !== 're-check').length, sent: ctx.sent || {}};
}

// ---- rendering (strings only, so it can be tested without a browser) -----------------
function csVerdictHtml(M) {
  const {r, st, kind} = M, s = r.stats || {};
  const pos = st.positionsFreed, net = st.netBinsFreed, any = (pos || 0) > 0 || (net || 0) > 0 || (st.binsEmptied || 0) > 0;
  const head = M.checkFailed ? "Don't use this plan: the re-check failed"
    : kind === 'pallet' && s.palletBins === 0 ? 'No pallet bins in storage areas'
    : !any ? 'Nothing to free with these options'
    : [csNum(pos) && pos ? csPl(pos, 'net pallet position') : '', csNum(net) && net ? csPl(net, 'net bin') : '', !pos && !net ? csPl(st.binsEmptied, 'bin') + ' emptied' : '']
      .filter(Boolean).join(' and ') + (pos || net ? ' can be freed' : '');
  const light = M.checkFailed ? 'red' : M.blocks ? 'red' : any ? 'green' : 'yellow';
  const sub = [kind === 'pallet' && csNum(s.pallets) ? `${fmt(s.pallets)} pallets in ${fmt(s.palletBins)} pallet bins` : '',
    kind === 'relocate' && csNum(s.under) ? `${fmt(s.under)} of ${fmt(s.fromStocked)} stocked bins are under ${esc(r.opts && r.opts.belowPct)}% full` : '',
    r.loadedAt ? `stock read ${esc(new Date(r.loadedAt).toLocaleTimeString())}` : ''].filter(Boolean).join(' · ');
  return `<div class="verdict-big"><span class="light ${light}"></span><h3>${head}</h3>${M.blocks && !M.checkFailed ? `<span class="pill bad">${csPl(M.blocks, 'blocker')} to clear first</span>` : ''}</div>
    ${sub ? `<p class="hint cs-sub">${sub}</p>` : ''}
    ${!any && !M.checkFailed ? `<p class="hint">Try a wider scope, ${kind === 'pallet' ? 'allow moves between zones, or aim for whole bins' : 'a higher % full, or let empty bins receive'}.</p>` : ''}`;
}
// the options the plan was made with: the server's echo, else what was asked for
function csOptsHtml(M) {
  const o = M.r.opts || M.sent || {}, echoed = !!M.r.opts, on = x => x === true || x === 1 || x === '1';
  const from = csCells(o.from), to = csCells(o.to), p = [];
  const kinds = new Set((Array.isArray(M.r.parts) ? M.r.parts : []).map(x => x.kind)), palletPart = !kinds.size || kinds.has('pallet');
  p.push(!from.length ? 'Every pallet bin' : `${csPl(from.length, 'bin type')}${to.length && to.join() !== from.join() ? ` into ${csPl(to.length, 'bin type')}` : ''}`);
  if (M.kind === 'pallet') {
    if (o.wholePallets !== undefined) p.push(on(o.wholePallets) ? 'Whole pallets to empty bins' : 'No whole-pallet moves');
  } else {
    if (o.belowPct !== undefined) p.push(Number(o.belowPct) >= 100 ? 'Bins of any fill' : `Bins under ${esc(o.belowPct)}% full`);
    if (o.useEmpty && palletPart) p.push({smaller: 'Empty bins: only smaller', any: 'Empty bins: any', none: 'No empty bins'}[o.useEmpty] || esc(o.useEmpty));
    if (o.mergeFirst !== undefined && palletPart) p.push(on(o.mergeFirst) ? 'Merges part-full pallets first' : 'No merging first');
    if (o.skipEmptyPalletBins !== undefined && palletPart) p.push(on(o.skipEmptyPalletBins) ? 'Skips bins with an empty pallet' : 'Uses bins with an empty pallet');
    if (kinds.has('shelf')) {
      const u = csCells(o.uoms);
      if (u.length) p.push(`Shelf: moves ${u.map(x => ({L0: 'eaches', L2: 'cases'})[x] || esc(x)).join(' and ')}`);
      if (csNum(Number(o.fillPct)) && Number(o.fillPct) < 100) p.push(`Shelf: fill up to ${esc(o.fillPct)}%`);
    }
  }
  if (o.crossZone !== undefined) p.push(on(o.crossZone) ? 'Moves between zones allowed' : 'Same zone only');
  if (o.checkWeight !== undefined) p.push(on(o.checkWeight) ? 'Within max kg' : 'Max kg not checked');
  if (o.objective) p.push(o.objective === 'bins' ? 'Aim: free whole bins' : 'Aim: free pallet positions');
  return p.length ? `<p class="cs-optline"><span>${echoed ? 'Made with' : 'Asked for'}</span>${p.map(x => `<span class="pill muted">${x}</span>`).join('')}</p>` : '';
}
function csWarnHtml(M) {
  const ws = M.warns;
  if (!ws.length) return `<div class="panel-sec cs-warns ok"><p class="cs-clear"><span class="pill ok">No blockers</span> ${M.r.check && M.r.check.ok ? 'Every step was replayed on the stock and passed positions, pallet fill, weight, mixing rules and scope.' : 'The planner reported no warnings.'}</p></div>`;
  const n = l => ws.filter(w => w.level === l).length, b = n('block'), w = n('warn'), i = n('info');
  const bins = (list, k) => {
    if (!list.length) return '';
    const chip = x => `<li>${esc(x)}</li>`, first = list.slice(0, 12);
    return `<ul class="sample cs-bins" aria-label="Bins">${first.map(chip).join('')}</ul>${list.length > 12 ? `<details class="cs-more"><summary>All ${fmt(list.length)} bins</summary><ul class="sample cs-bins">${list.slice(12).map(chip).join('')}</ul></details>` : ''}
      ${M.moves.length ? `<button type="button" class="link cs-showbins" data-cs-bins="${k}">Show their moves</button>` : ''}`;
  };
  const tag = {block: '<span class="pill bad">Blocks upload</span>', warn: '<span class="pill warn">Check</span>', info: '<span class="pill muted">Note</span>'};
  return `<div class="panel-sec cs-warns${b || M.checkFailed ? ' has-block' : ''}">
    <h3>Before you upload<small>${[b ? csPl(b, 'blocker') : '', w ? csPl(w, 'warning') : '', i ? csPl(i, 'note') : ''].filter(Boolean).join(' · ')}</small></h3>
    <ul class="cs-wl">${ws.map((x, k) => `<li class="cs-w ${x.level}"><span class="lv ${CS_LV[x.level]}" aria-hidden="true"></span><div>
      <p>${tag[x.level]} ${esc(x.text)}${x.code ? ` <small class="cs-code">${esc(x.code)}</small>` : ''}</p>
      ${x.items.length ? `<ul class="cs-items">${x.items.slice(0, 10).map(e => `<li>${esc(e)}</li>`).join('')}</ul>` : ''}
      ${bins(x.bins, k)}</div></li>`).join('')}</ul></div>`;
}
function csKpiHtml(st) {
  // a move here is one planned step; the IM upload can split or hold back some
  const t = (label, v, sub, cls = '') => `<div class="cs-kpi${cls ? ' ' + cls : ''}"><dt>${label}</dt><dd>${csFmt(v)}</dd>${sub ? `<small>${sub}</small>` : ''}</div>`;
  const diff = csNum(st.binsEmptied) && csNum(st.emptyBinsUsed) ? `${fmt(st.binsEmptied)} emptied − ${fmt(st.emptyBinsUsed)} empty used` : '';
  const neg = x => csNum(x) && x < 0 ? ' neg' : '';
  const xz = csNum(st.crossZoneMoves) ? (st.crossZoneMoves ? `${fmt(st.crossZoneMoves)} between zones` : 'all within their zone')
    : csNum(st.crossShown) && st.crossShown ? `${fmt(st.crossShown)} between zones in the first ${fmt(st.shown)}`
    : csNum(st.imRows) && st.imRows !== st.moves ? `${fmt(st.imRows)} IM upload rows` : 'IM upload rows';
  return `<dl class="cs-kpis">
    ${t('Bins emptied <span>gross</span>', st.binsEmptied, st.split ? `${fmt(st.split.merged)} by merging, ${fmt(st.split.packed)} by moving pallets` : 'left with no stock')}
    ${t('Empty bins used', st.emptyBinsUsed, st.legacy && st.kind === 'pallet' ? 'this planner only fills bins holding stock' : 'were empty, now take stock')}
    ${t('Net bins freed', st.netBinsFreed, diff, 'key' + neg(st.netBinsFreed))}
    ${t('Net pallet positions freed', st.positionsFreed, csNum(st.positionsFreed) ? 'bins emptied and merges, less empty bins used' : 'not reported by this server', 'key' + neg(st.positionsFreed))}
    ${t('Pallets freed', st.palletsFreed, 'merged away, so they disappear')}
    ${t('Moves', st.moves, xz)}
    ${t('Cases moved', st.casesMoved, csNum(st.casesMoved) ? 'cases and eaches, summed' : 'not reported by this server')}
  </dl>`;
}
function csImHtml(M) {
  const {r, im, plan} = M;
  const wb = `<div class="download cs-wb"><button type="button" class="btn" data-cs-wb>Download the full plan workbook</button>
    <p>Summary, every move in order, bins emptied, ${M.kind === 'pallet' ? "each pallet's fill" : 'bins not emptied and why'}, moves left out of the upload, and the IM upload sheets.</p></div>`;
  let body;
  if (M.checkFailed) body = '<div class="callout warn"><b>No IM upload:</b> the plan failed its re-check, so the server won\'t hand out upload files for it.</div>';
  else if (!Array.isArray(r.im)) body = '<p class="hint">This server didn\'t list the IM upload files; they\'re in the workbook.</p>';
  else if (!im.length) body = '<p class="hint">Nothing to upload: the plan has no moves the IM upload accepts.</p>';
  else {
    const total = im.reduce((t, f) => t + (f.rows || 0), 0);
    const first = im[0].n;
    const after = f => typeof f.after === 'string' ? esc(f.after) : f.after.length ? `Upload after the tasks of file${f.after.length === 1 ? '' : 's'} ${f.after.join(', ')} are done`
      : f.n === first ? 'Upload first' : `Same wave as file ${first}: upload it right after`;
    body = `${M.blocks ? `<label class="callout warn cs-ack"><input type="checkbox" data-cs-ack> <span><b>${csPl(M.blocks, 'blocker')} above.</b> Clear ${M.blocks === 1 ? 'it' : 'them'} on the floor first; tick here when that's done to unlock the files.</span></label>` : ''}
      <ol class="cs-im" aria-label="IM upload files, in order">${im.map(f => `<li class="cs-imf">
        <input type="checkbox" class="cs-imdone" data-im-done="${f.n}" aria-label="File ${f.n} uploaded and its tasks done">
        <span class="cs-imn" aria-hidden="true">${f.n}</span>
        <div class="cs-imb"><b>${esc(f.what)}</b>
          <small>${csPl(f.rows || 0, 'row')}${f.whole ? ` · ${fmt(f.whole)} whole pallet${f.whole === 1 ? '' : 's'} (Pick HU true)` : ''}${f.sameBin ? ' · Destination HU on every row' : ''} · wave ${f.wave}</small>
          <small class="cs-after${f.after.length ? ' wait' : ''}">${after(f)}</small>${f.note ? `<small>${esc(f.note)}</small>` : ''}</div>
        <button type="button" class="btn small" data-im-plan="${plan}" data-im-token="${esc(r.token)}" data-im-file="${f.n}" ${M.blocks ? 'disabled' : ''}>Download file ${f.n}</button></li>`).join('')}</ol>
      <p class="hint cs-improg" data-im-prog>${im.length > 1 ? `Upload them in order. ` : ''}Tick a file once it's uploaded and its tasks are done.</p>`;
    body = `<p class="hint cs-imhint">IM cockpit &gt; Internal Movement Upload: Sheet1, Pick HU true for a whole pallet. ${csPl(im.length, 'file')}, ${csPl(total, 'row')}.</p>` + body;
  }
  return `<div class="panel-sec cs-imsec"><h3>Upload to the WMS</h3>${body}${wb}</div>`;
}
function csZoneHtml(M) {
  const zs = M.zones;
  if (!zs.length) return '';
  const bars = zs.some(z => csNum(z.positions) && csNum(z.usedBefore));
  const pct = (a, b) => b ? Math.max(0, Math.min(100, a / b * 100)) : 0;
  const bar = z => !(csNum(z.positions) && z.positions && csNum(z.usedBefore)) ? '' : `<div class="cs-zbar" role="img"
      aria-label="Used ${fmt(z.usedBefore)} of ${fmt(z.positions)} before, ${fmt(z.usedAfter)} after">
      <span class="b"><i style="width:${pct(z.usedBefore, z.positions).toFixed(1)}%"></i></span><span class="a"><i style="width:${pct(z.usedAfter, z.positions).toFixed(1)}%"></i></span></div>
      <small class="sub">${csP1(pct(z.usedBefore, z.positions))} → ${csP1(pct(z.usedAfter, z.positions))}</small>`;
  const emptyCol = zs.some(z => csNum(z.emptyUsed));
  return `<div class="panel-sec"><div class="act-head"><h3>By zone<small>${bars ? 'pallet positions before and after the plan' : 'bins emptied and empty bins used per zone'}</small></h3>
    ${bars ? '<div class="legend"><span><i class="cs-lb"></i>Used before</span><span><i class="cs-la"></i>Used after</span></div>' : ''}</div>
    <div class="table-wrap"><table class="cs-zt"><thead><tr><th>Zone</th><th>Area</th><th class="num">Positions</th>${bars ? '<th class="num">Used<small class="sub">before → after</small></th><th class="num">Spare after</th>' : ''}
      <th class="num">Bins emptied</th>${emptyCol ? '<th class="num">Empty bins used</th>' : ''}<th class="num">Positions freed</th>${bars ? '<th class="cs-zbc">Used, before and after</th>' : ''}</tr></thead>
    <tbody>${zs.map(z => `<tr><td class="key">${esc(z.zone)}</td><td>${esc(z.area)}</td><td class="num">${csFmt(z.positions)}</td>
      ${bars ? `<td class="num">${csFmt(z.usedBefore)} → <b>${csFmt(z.usedAfter)}</b></td><td class="num">${csFmt(z.spare)}</td>` : ''}
      <td class="num">${z.binsEmptied ? `<b>${fmt(z.binsEmptied)}</b>` : csFmt(z.binsEmptied)}</td>${emptyCol ? `<td class="num">${csFmt(z.emptyUsed)}</td>` : ''}
      <td class="num${z.positionsFreed < 0 ? ' t-bad' : ''}">${z.positionsFreed ? `<b>${fmt(z.positionsFreed)}</b>` : '0'}</td>${bars ? `<td class="cs-zbc">${bar(z)}</td>` : ''}</tr>`).join('')}</tbody></table></div></div>`;
}

// ---- moves table: sort, filter, chips, pages ------------------------------------------
const CS_COLS = [['step', '#', 'num'], ['from', 'From bin'], ['to', 'To bin'], ['hu', 'Pallet'], ['sku', 'SKU', '', 'batch'], ['qty', 'Qty', 'num'], ['kind', 'How']];
const CS_SORT = {step: m => m.step, from: m => m.fromBin, to: m => m.toBin, hu: m => m.hu, sku: m => m.sku + ' ' + m.batch, qty: m => m.qty ?? -1, kind: m => CS_KIND[m.kind]};
function csMovesView(st) {
  const words = st.q.toLowerCase().split(/\s+/).filter(Boolean), get = CS_SORT[st.key] || CS_SORT.step;
  const list = st.moves.filter(m => (!st.cross || m.crossZone) && (!st.whole || m.kind === 'pallet') && (!st.empty || m.toWasEmpty)
    && (!st.bins || st.bins.has(m.fromBin) || st.bins.has(m.toBin)) && words.every(w => m.text.includes(w)));
  return list.sort((a, b) => { const x = get(a), y = get(b); return (typeof x === 'number' && typeof y === 'number' ? x - y : csNat(x, y)) * st.dir || a.step - b.step; });
}
function csMoveRow(m) {
  const kg = csNum(m.toKgAfter) ? `${Math.round(m.toKgAfter)}${csNum(m.toMaxKg) && m.toMaxKg ? ` / ${fmt(m.toMaxKg)}` : ''} kg` : '';
  const after = [m.kind === 'pour' ? (csNum(m.toUsedAfterCC) ? `${litres(m.toUsedAfterCC)} of ${litres(m.toBinVolCC)} L` : '')
    : csNum(m.toPositions) && csNum(m.toCap) ? `${fmt(m.toPositions)} of ${fmt(m.toCap)} position${m.toCap === 1 ? '' : 's'}` : '',
    (m.kind === 'merge' || m.kind === 'samebin') && csNum(m.toPalletAfter) ? `pallet ${csP1(m.toPalletAfter * 100)} full` : '', kg,
    m.stage === 1 ? 'stage 1: merging pallets' : m.stage === 2 ? 'stage 2: emptying bins' : ''].filter(Boolean).join(' · ');
  const hu = m.kind === 'pallet' ? `${esc(m.hu || '–')}<small class="sub">moves whole</small>` : m.kind === 'pour' ? (m.hu ? esc(m.hu) : '<span class="cs-dim">loose</span>')
    : `${esc(m.hu || '–')} <span class="cs-arrow" aria-label="onto">→</span> ${esc(m.toHu || '–')}`;
  return `<tr${m.crossZone ? ' class="xz"' : ''}><td class="num">${m.step}</td>
    <td class="bin">${esc(m.fromBin)}<small class="sub">${esc(m.fromZone)}${csNum(m.fromOccPct) ? ` · ${csP1(m.fromOccPct)} full` : ''}</small></td>
    <td class="bin cs-to">${esc(m.toBin)}<small class="sub">${esc(m.toZone)}${m.crossZone ? ' <span class="pill warn">Cross-zone</span>' : ''}${m.toWasEmpty ? ' <span class="pill ok">Was empty</span>' : ''}</small></td>
    <td class="code">${hu}</td>
    <td class="sku">${m.sku ? esc(m.sku) : `<span class="cs-dim">${esc(m.stock || '–')}</span>`}<small class="sub">${esc(m.batch)}</small></td>
    <td class="num"><b>${csUnit(m.qty, m.uom)}</b></td>
    <td class="cs-how"><span class="cs-k k-${m.kind}">${CS_KIND[m.kind]}</span>${after ? `<small class="sub">${after}</small>` : ''}</td></tr>`;
}
function csMovesHtml(M, id) {
  const {moves, st, r} = M;
  if (!moves.length) {
    if (!st.moves) return '';
    return `<div class="panel-sec"><h3>Moves<small>${csPl(st.moves, 'move')}</small></h3><p class="hint" style="margin:0">This server only counts the moves${csNum(r.moves) && r.pack ? ` (${csPl(r.moves, 'pour')} onto pallets, ${csPl(r.pack.stats.pallets || 0, 'whole pallet')})` : ''}; the workbook lists every one. The planner update adds them here.</p></div>`;
  }
  const c = f => moves.filter(f).length, cross = c(m => m.crossZone), whole = c(m => m.kind === 'pallet'), empty = c(m => m.toWasEmpty);
  const chip = (k, label, n) => `<button type="button" class="cs-chip" data-mt="${k}" aria-pressed="false" ${n ? '' : 'disabled'}>${label} <b>${fmt(n)}</b></button>`;
  return `<div class="panel-sec cs-moves" id="${id}"><div class="act-head"><h3>Moves<small>${st.partial ? `first ${fmt(moves.length)} of ${fmt(st.steps)}; the workbook has all` : csPl(moves.length, 'move')}, in the order to do them</small></h3></div>
    <div class="cs-mt-tools">
      <label class="cs-search"><span class="sr">Filter moves</span><input type="search" data-mt="q" placeholder="Filter by bin, SKU, batch or pallet" spellcheck="false" autocomplete="off"></label>
      <div class="cs-chips" role="group" aria-label="Show only">${chip('cross', 'Cross-zone', cross)}${chip('whole', 'Whole pallets', whole)}${chip('empty', 'Into empty bins', empty)}
        <span class="cs-chip on" data-mt-binchip hidden><span data-mt-binlabel></span> <button type="button" class="cs-x" data-mt="clearbins" aria-label="Stop filtering by these bins">×</button></span></div>
      <span class="cs-count" data-mt-count role="status"></span></div>
    <div class="table-wrap"><table class="cs-mt"><thead><tr>${CS_COLS.map(([k, label, cls, sub]) => `<th class="${cls || ''}" data-col="${k}" aria-sort="${k === 'step' ? 'ascending' : 'none'}"><button type="button" class="cs-sort" data-sort="${k}">${label}${sub ? ` <small>· ${sub}</small>` : ''}</button></th>`).join('')}</tr></thead>
      <tbody></tbody></table></div>
    <div class="cs-pager" data-mt-pager hidden><button type="button" class="btn small" data-mt="prev">Previous</button><span data-mt-page></span><button type="button" class="btn small" data-mt="next">Next</button></div>
    <p class="hint" style="margin:10px 0 0">Do the steps in order: a later step can put cases onto a pallet an earlier one moved in.</p></div>`;
}
// wires one moves table; returns showBins() for the warnings' "Show their moves"
function csMovesMount(root, moves) {
  if (!root) return {showBins() {}};
  const st = {moves, key: 'step', dir: 1, q: '', cross: false, whole: false, empty: false, bins: null, page: 0};
  const q = s => root.querySelector(s);
  function draw() {
    const list = csMovesView(st), pages = Math.max(1, Math.ceil(list.length / CS_PAGE));
    st.page = Math.max(0, Math.min(st.page, pages - 1));
    const from = st.page * CS_PAGE, slice = list.slice(from, from + CS_PAGE);
    q('tbody').innerHTML = slice.length ? slice.map(csMoveRow).join('')
      : `<tr><td colspan="${CS_COLS.length}" class="cs-none">No move matches. <button type="button" class="link" data-mt="reset">Clear the filters</button></td></tr>`;
    q('[data-mt-count]').textContent = !list.length ? `0 of ${fmt(moves.length)} moves` : list.length === moves.length && pages === 1 ? csPl(moves.length, 'move')
      : `${fmt(from + 1)}–${fmt(from + slice.length)} of ${fmt(list.length)}${list.length < moves.length ? ` (filtered from ${fmt(moves.length)})` : ''}`;
    q('[data-mt-pager]').hidden = pages < 2;
    q('[data-mt-page]').textContent = `Page ${st.page + 1} of ${pages}`;
    q('[data-mt="prev"]').disabled = st.page === 0; q('[data-mt="next"]').disabled = st.page >= pages - 1;
    root.querySelectorAll('th[data-col]').forEach(th => th.setAttribute('aria-sort', th.dataset.col === st.key ? (st.dir > 0 ? 'ascending' : 'descending') : 'none'));
    ['cross', 'whole', 'empty'].forEach(k => q(`[data-mt="${k}"]`).setAttribute('aria-pressed', String(st[k])));
    q('[data-mt-binchip]').hidden = !st.bins;
  }
  root.addEventListener('click', e => {
    const s = e.target.closest('[data-sort]'), b = e.target.closest('[data-mt]');
    if (s) { const k = s.dataset.sort; st.dir = st.key === k ? -st.dir : 1; st.key = k; st.page = 0; draw(); return; }
    if (!b || b.tagName === 'INPUT') return;
    const k = b.dataset.mt;
    if (k === 'prev') st.page--; else if (k === 'next') st.page++;
    else if (k === 'clearbins') { st.bins = null; st.page = 0; }
    else if (k === 'reset') { Object.assign(st, {q: '', cross: false, whole: false, empty: false, bins: null, page: 0}); q('[data-mt="q"]').value = ''; }
    else if (k in st) { st[k] = !st[k]; st.page = 0; }
    draw();
    if (k === 'prev' || k === 'next') root.scrollIntoView({block: 'start', behavior: 'smooth'});
  });
  let t = null;
  q('[data-mt="q"]').addEventListener('input', e => { clearTimeout(t); t = setTimeout(() => { st.q = e.target.value; st.page = 0; draw(); }, 120); });
  draw();
  return {showBins(bins, label) {
    st.bins = new Set(bins); st.page = 0; q('[data-mt-binlabel]').textContent = label; draw();
    root.scrollIntoView({block: 'start', behavior: 'smooth'}); q('[data-mt-binchip] button').focus({preventScroll: true});
  }};
}

// ---- the whole result -------------------------------------------------------------------
function csPlanHtml(M, extra = '') {
  return `<div class="panel cs-result" data-plan="${M.plan}">
    <div class="panel-sec">${csVerdictHtml(M)}${csOptsHtml(M)}</div>
    ${csWarnHtml(M)}
    <div class="panel-sec">${csKpiHtml(M.st)}</div>
    ${csImHtml(M)}
    ${csZoneHtml(M)}
    ${csMovesHtml(M, `${M.plan}-moves`)}
    ${extra}
  </div>`;
}
function csPlanMount(out, M, wbUrl) {
  const mt = csMovesMount(out.querySelector('.cs-moves'), M.moves);
  out.querySelectorAll('[data-cs-bins]').forEach(b => b.onclick = () => {
    const w = M.warns[Number(b.dataset.csBins)];
    mt.showBins(w.bins, `${w.code || 'Warning'}: ${csPl(w.bins.length, 'bin')}`);
  });
  const wb = out.querySelector('[data-cs-wb]');
  if (wb) wb.onclick = () => csDl(wbUrl);
  const ack = out.querySelector('[data-cs-ack]');
  if (ack) ack.onchange = () => out.querySelectorAll('[data-im-plan]').forEach(b => { b.disabled = !ack.checked; });
  // which files are uploaded, kept per plan token in this browser
  const key = 'cs-im-done:' + M.r.token, done = new Set(JSON.parse(csLoad(key) || '[]'));
  const boxes = [...out.querySelectorAll('[data-im-done]')], prog = out.querySelector('[data-im-prog]');
  const sync = () => {
    boxes.forEach(x => x.closest('li').classList.toggle('done', x.checked));
    if (prog && boxes.length) { const n = boxes.filter(x => x.checked).length; prog.textContent = n === boxes.length ? `${boxes.length === 1 ? 'Uploaded' : `All ${boxes.length} files uploaded`}. Check the bins in the WMS once the tasks are done.` : `${n} of ${boxes.length} uploaded. ${boxes.length > 1 ? 'Upload them in order; w' : 'W'}ait for a file's tasks to finish before the next wave.`; }
  };
  boxes.forEach(x => { x.checked = done.has(x.dataset.imDone); x.onchange = () => { x.checked ? done.add(x.dataset.imDone) : done.delete(x.dataset.imDone); csStore(key, [...done]); sync(); }; });
  if (done.size) sync();
}
// a result made with other options than the ones now on screen
function csStale(outSel) {
  const res = document.querySelector(`${outSel} .cs-result`);
  if (!res || res.querySelector('.cs-stale')) return;
  res.insertAdjacentHTML('afterbegin', '<div class="callout warn cs-stale" role="status"><b>The options changed</b> since this plan was made. Run it again before you upload anything.</div>');
}
function csBusy(btn, out, msg) {
  btn.disabled = true; btn.dataset.label = btn.dataset.label || btn.textContent; btn.textContent = 'Reading stock…';
  out.innerHTML = `<div class="panel cs-loading" style="margin-top:16px"><div class="panel-sec"><div class="loading" style="padding:0">${msg}</div>
    <p class="hint">Fresh stock, every run: this takes a few seconds on a big warehouse.</p></div></div>`;
  return () => { btn.disabled = false; btn.textContent = btn.dataset.label; };
}
function csError(out, e, retry) {
  out.innerHTML = `<div class="alert cs-err" role="alert">${esc(e.message)} <button type="button" class="btn small">Try again</button></div>`;
  out.querySelector('button').onclick = retry;
}
const csSay = t => { const s = $('#cs-status'); if (s) s.textContent = t; };

// ---- the one form: zone / bin type pickers (pallet and shelf bins), goal, rules ------------
const CR = {wh: null, areas: []};
const litres = cc => cc === null || cc === undefined ? '–' : Number((cc / 1000).toFixed(1)).toLocaleString();
const cuSaved = side => { try { return JSON.parse(localStorage.getItem(`cu-${side}:` + wh()) || 'null'); } catch { return null; } };
const pickBoxes = side => [...document.querySelectorAll(`#cu-${side} input[data-cell]`)];
const cuCells = side => pickBoxes(side).filter(x => x.checked).map(x => x.dataset.cell);
// the bin kinds ticked (PALLET, BIN) on the sides in use
const cuKinds = () => new Set([...pickBoxes('from'), ...($('#cu-same').checked ? [] : pickBoxes('to'))].filter(x => x.checked).map(x => x.dataset.kind));
const cuGoal = () => (document.querySelector('input[name="cu-goal"]:checked') || {}).value || 'empty';
function cuCount(side) {
  const all = pickBoxes(side), on = all.filter(x => x.checked), n = k => on.filter(x => x.dataset.kind === k).reduce((t, x) => t + Number(x.dataset.bins), 0);
  const occ = on.reduce((t, x) => t + Number(x.dataset.occ), 0), pal = n('PALLET'), shelf = n('BIN');
  $(`#cu-${side}-count`).textContent = !all.length ? '' : !on.length ? 'Tick at least one bin type'
    : `${csPl(on.length, 'bin type')}: ${[pal ? csPl(pal, 'pallet bin') : '', shelf ? csPl(shelf, 'shelf bin') : ''].filter(Boolean).join(', ')}, ${fmt(occ)} holding stock`;
}
function cuPicker(side) {
  const saved = cuSaved(side), on = t => cell => saved ? saved.includes(cell) : t.kind === 'PALLET'; // first time: every pallet bin
  const typeTxt = t => t.kind === 'PALLET' ? `${t.cap} pallet${t.cap === 1 ? '' : 's'}` : t.volCC >= 1e7 ? 'volume unset' : t.volCC ? `${litres(t.volCC)} L shelf` : 'no volume';
  $(`#cu-${side}`).innerHTML = CR.areas.length ? CR.areas.map(a => `<fieldset class="ce-area"><legend><label><input type="checkbox" data-area="${esc(a.area)}"> <b>${esc(a.area)}</b></label></legend>
    ${a.zones.map(z => `<div class="cr-zone"><label class="cr-zl"><input type="checkbox" data-zone="${esc(z.zone)}" data-of="${esc(a.area)}"> <span class="mono">${esc(z.zone)}</span>
        <small>${fmt(z.occupied)} of ${fmt(z.bins)} hold stock</small></label>
      <div class="cr-types">${z.types.map(t => { const cell = `${z.zone}|${t.binType}`; return `<label class="cr-type"><input type="checkbox" data-cell="${esc(cell)}" data-z="${esc(z.zone)}" data-a="${esc(a.area)}"
        data-kind="${esc(t.kind)}" data-bins="${t.bins}" data-occ="${t.occupied}" ${on(t)(cell) ? 'checked' : ''}> <span class="mono">${esc(t.binType)}</span> <small>${typeTxt(t)} · ${fmt(t.occupied)}/${fmt(t.bins)}</small></label>`; }).join('')}</div></div>`).join('')}
    </fieldset>`).join('') : '<p class="hint">No inventory pallet or shelf bins in this warehouse.</p>';
  cuSync(side); cuCount(side);
}
// zone and area boxes follow the bin types under them
function cuSync(side) {
  const box = $(`#cu-${side}`);
  const set = (el, kids) => { el.checked = kids.length && kids.every(k => k.checked); el.indeterminate = !el.checked && kids.some(k => k.checked); };
  box.querySelectorAll('input[data-zone]').forEach(z => set(z, [...box.querySelectorAll(`input[data-cell][data-z="${CSS.escape(z.dataset.zone)}"]`)]));
  box.querySelectorAll('input[data-area]').forEach(a => set(a, [...box.querySelectorAll(`input[data-cell][data-a="${CSS.escape(a.dataset.area)}"]`)]));
}
const cuSaveCells = side => { csStore(`cu-${side}:` + wh(), cuCells(side)); cuSync(side); cuCount(side); cuShow(); csStale('#cu-out'); };
for (const side of ['from', 'to']) $(`#cu-${side}`).addEventListener('change', e => {
  const t = e.target, box = $(`#cu-${side}`);
  if (t.dataset.area) box.querySelectorAll(`input[data-cell][data-a="${CSS.escape(t.dataset.area)}"]`).forEach(x => { x.checked = t.checked; });
  if (t.dataset.zone) box.querySelectorAll(`input[data-cell][data-z="${CSS.escape(t.dataset.zone)}"]`).forEach(x => { x.checked = t.checked; });
  cuSaveCells(side);
});
// Every pallet bin / Every shelf bin / Clear
document.querySelectorAll('[data-cu-tick]').forEach(b => b.onclick = () => {
  const k = b.dataset.cuTick; pickBoxes(b.dataset.side).forEach(x => { x.checked = !!k && x.dataset.kind === k; }); cuSaveCells(b.dataset.side);
});
async function cuLoad(force) {
  if (!/^\d+$/.test(wh())) { $('#cu-from-count').textContent = 'Set the warehouse id first'; return; }
  if (!force && CR.wh === wh()) return;
  $('#cu-from-count').textContent = 'Loading areas…'; $('#cu-to-count').textContent = '';
  try {
    const r = await api('/api/inv/relocate-scope?' + qs(force ? {refresh: '1'} : {}));
    CR.wh = wh(); CR.areas = r.areas;
    cuPicker('from'); cuPicker('to'); cuShow();
  } catch (e) {
    $('#cu-from').innerHTML = `<div class="alert" role="alert">${esc(e.message)} <button type="button" class="btn small" data-scope-retry>Try again</button></div>`; $('#cu-from-count').textContent = '';
    $('#cu-from [data-scope-retry]').onclick = () => cuLoad(true);
  }
}
$('#cu-reload').onclick = () => cuLoad(true);
new MutationObserver(() => { if (!$('#v-consolidate').hidden) cuLoad(); }).observe($('#v-consolidate'), {attributes: true, attributeFilter: ['hidden']});
if (!$('#v-consolidate').hidden) cuLoad();

// options for the goal and the bin kinds ticked only; the rest hide
const CU_GOAL = {empty: 'Leave bins completely empty: bins under the % below give their stock to others.', tidy: 'Merge part-full pallets so fewer pallets hold the same stock, even where the bin keeps others. Pallet bins only.'};
function cuShow() {
  const goal = cuGoal(), kinds = cuKinds();
  document.querySelectorAll('#cu-form [data-show-goal], #cu-form [data-show-kind]').forEach(el => {
    el.hidden = (!!el.dataset.showGoal && el.dataset.showGoal !== goal) || (!!el.dataset.showKind && !kinds.has(el.dataset.showKind));
  });
  const h = document.querySelector('[data-goal-hint]'); if (h) h.textContent = CU_GOAL[goal];
}
const cuSame = () => { $('#cu-to').hidden = $('#cu-same').checked; $('#cu-to-count').hidden = $('#cu-same').checked; cuShow(); };
$('#cu-same').addEventListener('change', () => { cuSame(); csStale('#cu-out'); });

// options remembered across runs; the objective's hint follows the choice
const CS_OBJ = {positions: 'Most pallet positions back, even when a bin keeps a pallet.', bins: 'Most bins left completely empty, e.g. to hand a bin over or re-slot it.'};
function csObj(p) { const v = (document.querySelector(`input[name="${p}-obj"]:checked`) || {}).value || 'positions'; const h = document.querySelector(`[data-obj-hint="${p}"]`); if (h) h.textContent = CS_OBJ[v]; return v; }
const CU_BOXES = ['cu-same', 'cu-cross', 'cu-kg', 'cu-whole', 'cu-merge', 'cu-skipep', 'cu-u-l0', 'cu-u-l2'], CU_VALUES = ['cu-below', 'cu-empty', 'cu-fill'];
// the aim is remembered per goal: Empty bins starts on free whole bins, Tidy pallets on free pallet positions
const CU_AIM = {empty: 'bins', tidy: 'positions'};
(function cuRemember() {
  let saved = {}; try { saved = JSON.parse(localStorage.getItem('cu-opts') || '{}') || {}; } catch {}
  for (const id of CU_BOXES) if (saved[id] !== undefined) $('#' + id).checked = !!saved[id];
  for (const id of CU_VALUES) if (saved[id] !== undefined) $('#' + id).value = saved[id];
  const pick = (name, v) => { const x = v && document.querySelector(`input[name="${name}"][value="${v}"]`); if (x) x.checked = true; };
  const aimOf = g => saved['obj-' + g] || CU_AIM[g];
  pick('cu-goal', saved.goal); pick('cu-obj', aimOf(cuGoal()));
  const save = () => { saved = {...saved, ...Object.fromEntries(CU_BOXES.map(id => [id, $('#' + id).checked])), ...Object.fromEntries(CU_VALUES.map(id => [id, $('#' + id).value])),
    goal: cuGoal(), ['obj-' + cuGoal()]: csObj('cu')}; csStore('cu-opts', saved); cuShow(); csStale('#cu-out'); };
  [...CU_BOXES, ...CU_VALUES].forEach(id => $('#' + id).addEventListener('change', save));
  document.querySelectorAll('input[name="cu-obj"]').forEach(x => x.addEventListener('change', save));
  // a new goal brings back its own aim before it is saved
  document.querySelectorAll('input[name="cu-goal"]').forEach(x => x.addEventListener('change', () => { pick('cu-obj', aimOf(cuGoal())); csObj('cu'); save(); }));
  csObj('cu'); cuSame();
})();
// the Consolidate sub-tabs (Empty bins, Tidy pallets) pick the goal; its in-page switch is hidden
function cuSetGoal(goal) {
  const x = document.querySelector(`input[name="cu-goal"][value="${goal}"]`);
  if (x && !x.checked) { x.checked = true; x.dispatchEvent(new Event('change', {bubbles: true})); }
  cuShow();
}

// ---- run ------------------------------------------------------------------------------------
$('#cu-go').onclick = async function run() {
  const out = $('#cu-out'), fail = t => { out.innerHTML = `<div class="alert" role="alert">${t}</div>`; };
  if (!/^\d+$/.test(wh())) return fail('The warehouse id needs to be a number. Fix it under Warehouse id.');
  await cuLoad();
  const goal = cuGoal(), from = cuCells('from'), to = $('#cu-same').checked ? from : cuCells('to'), kinds = cuKinds();
  if (!from.length) return fail('Tick at least one bin type to take stock from.');
  if (!to.length) return fail('Tick at least one bin type to put it into, or tick The same bins as above.');
  if (goal === 'tidy' && !kinds.has('PALLET')) return fail('Tidy pallets works on pallet bins: tick at least one pallet bin type, or pick Empty bins.');
  const units = [['L0', '#cu-u-l0'], ['L2', '#cu-u-l2']].filter(([, id]) => $(id).checked).map(([u]) => u);
  if (goal === 'empty' && kinds.has('BIN') && !units.length) return fail('Tick eaches, cases or both to move in shelf bins.');
  const on = id => $(id).checked ? '1' : '0';
  const sent = {goal, from: from.join(','), to: to.join(','), crossZone: on('#cu-cross'), checkWeight: on('#cu-kg'), objective: csObj('cu'),
    ...(goal === 'tidy' ? {wholePallets: on('#cu-whole')}
      : {belowPct: Math.min(100, Math.max(0.1, Number($('#cu-below').value) || 100)), useEmpty: $('#cu-empty').value, skipEmptyPalletBins: on('#cu-skipep'), mergeFirst: on('#cu-merge'),
        uoms: units.join(','), fillPct: Math.min(100, Math.max(10, Number($('#cu-fill').value) || 100))})};
  const done = csBusy($('#cu-go'), out, 'Reading bins, pallets, stock, best fits, volumes and task locks…');
  try {
    const r = await api('/api/inv/consolidate-plan?' + qs(sent));
    const M = csModel(r, goal === 'tidy' ? 'pallet' : 'relocate', {sent, scope: CR.areas, plan: 'unified'});
    out.innerHTML = csPlanHtml(M, goal === 'tidy' ? cpExtraHtml(r) : cuPartsHtml(r) + crExtraHtml(r));
    csPlanMount(out, M, '/api/inv/consolidate-plan-download?' + qs({token: r.token}));
    csSay(`Plan ready. ${M.warns.some(w => w.level === 'block') ? 'Blockers listed first. ' : ''}${csFmt(M.st.netBinsFreed)} net bins and ${csFmt(M.st.positionsFreed)} net pallet positions freed.`);
    $('#cu-go').dataset.label = 'Run again';
  } catch (e) { csError(out, e, run); }
  done();
};

// Tidy pallets' extra detail: merge candidates, whole-pallet bin moves and shelf bins to look at
function cpExtraHtml(r) {
  const s = r.stats || {}, parts = [];
  if (Array.isArray(r.merges) && r.merges.length && typeof mergesSec === 'function') parts.push(mergesSec(r).replace('<div class="panel-sec">', '<div>'));
  const pack = r.pack && Array.isArray(r.pack.bins) ? r.pack.bins : [];
  if (pack.length) parts.push(`<h3>Bins emptied by moving whole pallets<small>${csPl(r.pack.stats.bins, 'bin')}, ${csPl(r.pack.stats.pallets, 'pallet')}${pack.length < r.pack.stats.bins ? `; first ${pack.length}` : ''}</small></h3>
    <div class="table-wrap"><table><thead><tr><th>Empty this bin</th><th>Zone</th><th>Bin type</th><th class="num">Pallets</th><th>Move them to</th></tr></thead><tbody>${pack.map(b => `<tr><td class="bin">${esc(b.bin)}</td><td class="key">${esc(b.zone)}</td><td>${esc(b.binType)}</td>
      <td class="num">${fmt(b.pallets)} of ${fmt(b.cap)}</td><td>${(b.to || []).map(t => `<span class="mono">${esc(t)}</span>`).join(', ')}</td></tr>`).join('')}</tbody></table></div>`);
  if (r.shelf && r.shelf.groups && typeof shelfSec === 'function') parts.push(shelfSec(r).replace('<div class="panel-sec">', '<div>'));
  const facts = csNum(s.pallets) ? `<p class="hint" style="margin:0 0 12px">${fmt(s.used)} of ${fmt(s.positions)} pallet positions used, ${fmt(s.emptyBins)} pallet bins empty. ${fmt(s.full)} pallets at best fit, ${fmt(s.partial)} partial, ${fmt(s.over)} over best fit, ${fmt(s.mixed)} mixed SKU/batch${s.locked ? `, ${fmt(s.locked)} locked by a task` : ''}${s.busy ? `, ${fmt(s.busy)} in bins with locked or arriving stock (left alone)` : ''}${s.picking ? `, ${fmt(s.picking)} with all their stock being picked` : ''}.</p>` : '';
  return parts.length || facts ? `<div class="panel-sec"><details class="cs-detail"><summary>More detail: pallets, merge candidates${pack.length ? ', whole-pallet moves' : ''}${r.shelf && r.shelf.groups ? ', shelf bins' : ''}</summary><div class="cs-detail-body">${facts}${parts.join('<div class="cs-gap"></div>')}</div></details></div>` : '';
}
// Empty bins: what each kind of bin gave, side by side
function cuPartsHtml(r) {
  const ps = Array.isArray(r.parts) ? r.parts : [];
  if (!ps.length) return '';
  const row = p => { const s = p.stats || {}, shelf = p.kind === 'shelf';
    const mf = p.engine === 'chain' && s.plain ? `<small class="sub">${s.mergedFirst ? `merged first: ${fmt(s.mergeMoves)} case moves; without, ${fmt(s.plain.positionsFreed)} positions` : `merging first freed less (${fmt(s.chain.positionsFreed)} positions), not used`}</small>` : '';
    return `<tr><td class="key">${shelf ? 'Shelf bins' : 'Pallet bins'}${mf}</td><td class="num"><b>${csFmt(s.binsEmptied)}</b>${shelf && csNum(s.bestPossible) ? `<small class="sub">most possible ${fmt(s.bestPossible)}${s.optimal ? ', reached' : ''}</small>` : ''}</td>
      <td class="num">${csFmt(s.emptyBinsUsed)}</td><td class="num">${shelf ? '–' : csFmt(s.positionsFreed)}</td><td class="num">${csFmt(s.moves)}</td><td class="num">${csFmt(s.casesMoved)}</td>
      <td>${p.check ? (p.check.ok ? '<span class="pill ok">Passed</span>' : '<span class="pill bad">Failed</span>') : '–'}</td></tr>`; };
  return `<div class="panel-sec"><h3>By kind of bin<small>pallet bins by pallet positions, shelf bins by volume</small></h3>
    <div class="table-wrap"><table><thead><tr><th>Bins</th><th class="num">Emptied</th><th class="num">Empty bins used</th><th class="num">Net positions freed</th><th class="num">Moves</th><th class="num">Units moved</th><th>Re-check</th></tr></thead>
    <tbody>${ps.map(row).join('')}</tbody></table></div></div>`;
}
// bins in scope the plan left as they are, and why
function crExtraHtml(r) {
  const o = r.opts || {}, list = Array.isArray(r.notEmptied) ? r.notEmptied : [];
  if (!list.length) return '';
  const why = Object.entries(r.notEmptiedBy || {}).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${fmt(n)} × ${esc(w.toLowerCase())}`);
  const below = csNum(Number(o.belowPct)) && Number(o.belowPct) < 100 ? `Under ${esc(o.belowPct)}% but not emptied` : 'Not emptied';
  return `<div class="panel-sec"><details class="cs-detail"><summary>${below} (${fmt(r.notEmptiedCount ?? list.length)})</summary><div class="cs-detail-body">
    ${why.length ? `<p class="hint" style="margin:0 0 10px">Why: ${why.join('; ')}.</p>` : ''}
    <div class="table-wrap"><table><thead><tr><th>Bin</th><th>Zone</th><th>Bin type</th><th class="num">% full</th><th>Why</th><th>Stock</th></tr></thead><tbody>${list.map(n => `<tr><td class="bin">${esc(n.bin)}</td><td class="key">${esc(n.zone)}</td><td class="code">${esc(n.binType)}</td><td class="num">${csP1(n.occPct)}</td>
      <td>${esc(n.why)}</td><td class="code">${esc(n.stock)}</td></tr>`).join('')}</tbody></table></div>${(r.notEmptiedCount || 0) > list.length ? `<p class="hint">First ${fmt(list.length)}; the workbook has all of them.</p>` : ''}</div></details></div>`;
}
