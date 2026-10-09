// Consolidate stock: pallets, shelf eaches, and bins under % full.
// ---- consolidate stock ------------------------------------------------------------
$('#cs-go').onclick = async () => {
  const out = $('#cs-out');
  if (!/^\d+$/.test(wh())) { out.innerHTML = '<div class="alert" role="alert">The warehouse id needs to be a number. Fix it under Warehouse id.</div>'; return; }
  const go = $('#cs-go'); go.disabled = true; go.textContent = 'Reading stock…';
  out.innerHTML = '<div class="loading" style="margin-top:16px">Reading bins, pallets, stock and task locks…</div>';
  try {
    const r = await api('/api/inv/consolidate?' + qs());
    out.innerHTML = stockPlanHtml(r);
    go.classList.remove('primary'); go.dataset.label = 'Read the stock again';
    $('#cs-dl') && ($('#cs-dl').onclick = () => { const a = document.createElement('a'); a.href = '/api/inv/consolidate-download?' + qs({token: r.token}); document.body.append(a); a.click(); a.remove(); });
  } catch (e) { out.innerHTML = `<div class="alert" role="alert">${esc(e.message)}</div>`; }
  go.disabled = false; go.textContent = go.dataset.label || 'Find what can be freed';
};
function stockPlanHtml(r) {
  const s = r.stats, p = r.pack.stats, binsFreed = s.binsEmptied + p.bins, any = s.frees || binsFreed;
  const pctOf = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';
  const head = !s.palletBins ? 'No pallet bins in storage areas'
    : any ? [s.frees ? plural(s.frees, 'pallet position') : '', binsFreed ? plural(binsFreed, 'bin') : ''].filter(Boolean).join(' and ') + ' can be freed'
    : 'Nothing to consolidate';
  const zones = r.zones.filter(z => z.positions).map(z => `<tr><td class="key">${esc(z.zone)}</td><td>${esc(z.area)}</td>
    <td class="num">${fmt(z.positions)}</td><td class="num">${fmt(z.used)}</td><td class="num">${fmt(z.spare)}</td>
    <td class="num">${fmt(z.partial)}</td><td class="num">${z.frees ? `<b>${fmt(z.frees)}</b>` : '0'}</td><td class="num">${z.binsFreed ? `<b>${fmt(z.binsFreed)}</b>` : '0'}</td></tr>`).join('');
  const packRows = r.pack.bins.map(b => `<tr><td class="bin">${esc(b.bin)}</td><td class="key">${esc(b.zone)}</td><td>${esc(b.binType)}</td>
    <td class="num">${fmt(b.pallets)} of ${fmt(b.cap)}</td><td>${b.to.map(t => `<span class="mono">${esc(t)}</span>`).join(', ')}</td></tr>`).join('');
  return `<div class="panel" style="margin-top:16px">
    <div class="panel-sec"><div class="verdict-big"><span class="light ${any ? 'green' : 'yellow'}"></span><h3>${head}</h3>
      <span class="hint">${fmt(s.pallets)} pallets in ${fmt(s.palletBins)} pallet bins, read ${esc(new Date(r.loadedAt).toLocaleTimeString())}</span></div>
      <dl class="stats" style="margin-top:18px">
        <div><dt>Positions free now</dt><dd>${fmt(s.spare)}</dd></div>
        <div><dt>Freed by merging</dt><dd>${fmt(s.frees)}</dd></div>
        <div><dt>Free after merging</dt><dd>${fmt(s.spare + s.frees)}</dd></div>
        <div><dt>Bins freed</dt><dd>${fmt(binsFreed)}</dd></div>
      </dl>
      <p class="hint" style="margin:12px 0 0">${pctOf(s.used, s.positions)} of ${fmt(s.positions)} positions used, ${fmt(s.emptyBins)} pallet bins empty.
        ${fmt(s.full)} pallets at best fit, ${fmt(s.partial)} partial, ${fmt(s.over)} over best fit, ${fmt(s.mixed)} mixed SKU/batch${s.unsized ? `, ${fmt(s.unsized)} without an L2inL3 (fill unknown, so never merged)` : ''}${s.locked ? `, ${fmt(s.locked)} locked by a task` : ''}${s.busy ? `, ${fmt(s.busy)} in bins with locked stock or stock arriving (nothing moves in or out of those bins)` : ''}${s.picking ? `, ${fmt(s.picking)} with all their stock being picked` : ''}. Stock being picked isn't counted in a pallet's fill and is never moved.</p>
      ${r.lockError ? `<div class="callout warn" style="margin-top:12px">${esc(r.lockError)}</div>` : ''}
      ${any || r.shelf.groups ? `<div class="download" style="margin-top:16px"><button type="button" class="btn primary" id="cs-dl">Download the plan</button>
        <p>Summary, every pour (Moves), every whole-pallet move (Bin moves), each pallet's fill and plan, shelf bins to look at, and the IM upload sheets.</p></div>` : ''}
      ${imDlHtml(r, 'pallet')}</div>
    ${mergesSec(r).replace('<h3>Merge candidates', '<h3>Merge partial pallets').replace('</small></h3>', '</small></h3><p class="hint" style="margin:0 0 10px">Pour the emptiest pallets of a SKU and batch into the fullest, up to best fit. Only the same SKU and batch, so the bin type\'s mixing rules don\'t matter. Each pallet emptied frees a position.</p>')}
    ${packRows ? `<div class="panel-sec"><h3>Bins to empty by moving whole pallets<small>${plural(p.bins, 'bin')}, ${plural(p.pallets, 'pallet')} to move${r.pack.bins.length < p.bins ? `; first ${r.pack.bins.length}` : ''}</small></h3>
      <p class="hint" style="margin:0 0 10px">Multi-position bins only, after the merges above. Each pallet goes to a bin of the same zone and bin type that already holds pallets, has room, and allows the SKUs and batches it would then hold. Bins with loose stock or a locked pallet stay as they are.</p>
      <div class="table-wrap"><table><thead><tr><th>Empty this bin</th><th>Zone</th><th>Bin type</th><th class="num">Pallets</th><th>Move them to</th></tr></thead><tbody>${packRows}</tbody></table></div></div>` : ''}
    ${zones ? `<div class="panel-sec"><h3>By zone</h3><div class="table-wrap"><table><thead><tr><th>Zone</th><th>Area</th><th class="num">Positions</th><th class="num">Used</th><th class="num">Free</th><th class="num">Partial pallets</th><th class="num">Freed by merging</th><th class="num">Bins freed</th></tr></thead><tbody>${zones}</tbody></table></div></div>` : ''}
    ${shelfSec(r)}
  </div>`;
}

// ---- consolidate eaches (shelf bins) ------------------------------------------------
function csKind(k) {
  $('#cs-eaches').hidden = k !== 'eaches'; $('#cs-pallets').hidden = k !== 'pallets'; $('#cs-relocate').hidden = k !== 'relocate';
  if (k === 'relocate') crLoad();
}
document.querySelectorAll('input[name="cs-kind"]').forEach(r => r.addEventListener('change', () => {
  const k = document.querySelector('input[name="cs-kind"]:checked').value;
  csKind(k);
  try { localStorage.setItem('cs-kind', k); } catch {}
}));
try { const k = localStorage.getItem('cs-kind'); if (k === 'pallets' || k === 'relocate') { $(k === 'pallets' ? '#csk-p' : '#csk-r').checked = true; setTimeout(() => csKind(k)); } } catch {}

// ---- bins under % full (every inventory area) ----------------------------------------
const CR = {wh: null, areas: []};
const crSaved = side => { try { return JSON.parse(localStorage.getItem(`cr-${side}:` + wh()) || 'null'); } catch { return null; } };
const crCells = side => [...document.querySelectorAll(`#cr-${side} input[data-cell]:checked`)].map(x => x.dataset.cell);
function crCount(side) {
  const on = [...document.querySelectorAll(`#cr-${side} input[data-cell]:checked`)];
  const bins = on.reduce((t, x) => t + Number(x.dataset.bins), 0), occ = on.reduce((t, x) => t + Number(x.dataset.occ), 0);
  $(`#cr-${side}-count`).textContent = on.length ? `${plural(on.length, 'bin type')} ticked: ${fmt(bins)} bins, ${fmt(occ)} holding stock` : 'Tick at least one bin type';
}
function crPicker(side) {
  const saved = crSaved(side) || [];
  const typeTxt = t => t.kind === 'PALLET' ? `${t.cap} pallet${t.cap === 1 ? '' : 's'}` : t.volCC >= 1e7 ? 'volume unset' : t.volCC ? `${litres(t.volCC)} L shelf` : 'no volume';
  $(`#cr-${side}`).innerHTML = CR.areas.length ? CR.areas.map(a => `<fieldset class="ce-area"><legend><label><input type="checkbox" data-area="${esc(a.area)}"> <b>${esc(a.area)}</b></label></legend>
    ${a.zones.map(z => `<div class="cr-zone"><label class="cr-zl"><input type="checkbox" data-zone="${esc(z.zone)}" data-of="${esc(a.area)}"> <span class="mono">${esc(z.zone)}</span>
        <small>${fmt(z.occupied)} of ${fmt(z.bins)} hold stock</small></label>
      <div class="cr-types">${z.types.map(t => { const cell = `${z.zone}|${t.binType}`; return `<label class="cr-type"><input type="checkbox" data-cell="${esc(cell)}" data-z="${esc(z.zone)}" data-a="${esc(a.area)}"
        data-bins="${t.bins}" data-occ="${t.occupied}" ${saved.includes(cell) ? 'checked' : ''}> <span class="mono">${esc(t.binType)}</span> <small>${typeTxt(t)} · ${fmt(t.occupied)}/${fmt(t.bins)}</small></label>`; }).join('')}</div></div>`).join('')}
    </fieldset>`).join('') : '<p class="hint">No inventory bins in this warehouse.</p>';
  crSync(side); crCount(side);
}
// zone and area boxes follow the bin types under them
function crSync(side) {
  const box = $(`#cr-${side}`);
  const set = (el, kids) => { el.checked = kids.length && kids.every(k => k.checked); el.indeterminate = !el.checked && kids.some(k => k.checked); };
  box.querySelectorAll('input[data-zone]').forEach(z => set(z, [...box.querySelectorAll(`input[data-cell][data-z="${CSS.escape(z.dataset.zone)}"]`)]));
  box.querySelectorAll('input[data-area]').forEach(a => set(a, [...box.querySelectorAll(`input[data-cell][data-a="${CSS.escape(a.dataset.area)}"]`)]));
}
['from', 'to'].forEach(side => $(`#cr-${side}`).addEventListener('change', e => {
  const t = e.target, box = $(`#cr-${side}`);
  if (t.dataset.area) box.querySelectorAll(`input[data-cell][data-a="${CSS.escape(t.dataset.area)}"]`).forEach(x => { x.checked = t.checked; });
  if (t.dataset.zone) box.querySelectorAll(`input[data-cell][data-z="${CSS.escape(t.dataset.zone)}"]`).forEach(x => { x.checked = t.checked; });
  crSync(side); crCount(side);
  try { localStorage.setItem(`cr-${side}:` + wh(), JSON.stringify(crCells(side))); } catch {}
}));
async function crLoad(force) {
  if (!/^\d+$/.test(wh())) { $('#cr-from-count').textContent = 'Set the warehouse id first'; return; }
  if (!force && CR.wh === wh()) return;
  $('#cr-from-count').textContent = 'Loading areas…'; $('#cr-to-count').textContent = '';
  try {
    const r = await api('/api/inv/relocate-scope?' + qs(force ? {refresh: '1'} : {}));
    CR.wh = wh(); CR.areas = r.areas;
    crPicker('from'); crPicker('to');
  } catch (e) { $('#cr-from').innerHTML = `<div class="alert" role="alert">${esc(e.message)}</div>`; $('#cr-from-count').textContent = ''; }
}
$('#cr-reload').onclick = () => crLoad(true);
try { const b = localStorage.getItem('cr-below'); if (b) $('#cr-below').value = b; const e = localStorage.getItem('cr-empty'); if (e) $('#cr-empty').value = e; } catch {}
$('#cr-empty').addEventListener('change', () => { try { localStorage.setItem('cr-empty', $('#cr-empty').value); } catch {} });
$('#cr-below').addEventListener('change', () => { try { localStorage.setItem('cr-below', $('#cr-below').value); } catch {} });
new MutationObserver(() => { if (!$('#v-consolidate').hidden && !$('#cs-relocate').hidden) crLoad(); }).observe($('#v-consolidate'), {attributes: true, attributeFilter: ['hidden']});
$('#cr-go').onclick = async () => {
  const out = $('#cr-out');
  if (!/^\d+$/.test(wh())) { out.innerHTML = '<div class="alert" role="alert">The warehouse id needs to be a number. Fix it under Warehouse id.</div>'; return; }
  await crLoad();
  const from = crCells('from'), to = crCells('to');
  if (!from.length || !to.length) { out.innerHTML = '<div class="alert" role="alert">Tick at least one bin type to empty, and at least one to move into.</div>'; return; }
  const below = Math.min(100, Math.max(0.1, Number($('#cr-below').value) || 100));
  const go = $('#cr-go'); go.disabled = true; go.textContent = 'Reading stock…';
  out.innerHTML = '<div class="loading" style="margin-top:16px">Reading bins, pallets, stock, pallet sizes and task locks…</div>';
  try {
    const r = await api('/api/inv/relocate?' + qs({from: from.join(','), to: to.join(','), belowPct: below,
      useEmpty: $('#cr-empty').value, checkWeight: $('#cr-kg').checked ? '1' : '0'}));
    out.innerHTML = crHtml(r);
    $('#cr-dl') && ($('#cr-dl').onclick = () => { const a = document.createElement('a'); a.href = '/api/inv/relocate-download?' + qs({token: r.token}); document.body.append(a); a.click(); a.remove(); });
  } catch (e) { out.innerHTML = `<div class="alert" role="alert">${esc(e.message)}</div>`; }
  go.disabled = false; go.textContent = 'Find bins to empty';
};
function crHtml(r) {
  const s = r.stats, o = r.opts, p1 = x => x === null || x === undefined ? '–' : (x < 10 ? x.toFixed(2) : x.toFixed(1)) + '%';
  const unit = (q, u) => `${fmt(q)} ${u === 'L2' ? (q === 1 ? 'case' : 'cases') : u === 'L0' ? (q === 1 ? 'each' : 'eaches') : u === 'L3' ? (q === 1 ? 'pallet' : 'pallets') : u}`;
  const how = p => p.kind === 'merge' ? `Onto pallet <span class="mono">${esc(p.toHu)}</span>` : p.kind === 'pallet' ? 'Whole pallet' : 'Loose into bin';
  const after = p => p.kind === 'pour' ? `${litres(p.toUsedAfterCC)} of ${litres(p.toBinVolCC)} L`
    : `pallet ${p1(p.toPalletAfter * 100)} full<small class="sub">${fmt(p.toPositions)} of ${fmt(p.toCap)} position${p.toCap === 1 ? '' : 's'} used</small>`;
  const rows = r.moves.map(p => `<tr><td class="num">${p.step}</td><td class="bin">${esc(p.fromBin)}<small class="sub">${esc(p.fromZone)} · ${p1(p.fromOccPct)}</small></td>
    <td class="code">${esc(p.hu || '–')}</td><td class="sku">${esc(p.sku)}<small class="sub">${esc(p.batch)}</small></td><td class="num"><b>${unit(p.qty, p.uom)}</b></td>
    <td>${how(p)}</td><td class="bin">${esc(p.toBin)}<small class="sub">${esc(p.toZone)}${p.toWasEmpty ? ' · <span class="pill ok">was empty</span>' : ''}</small></td>
    <td class="num">${after(p)}</td><td class="num">${p.toKgAfter.toFixed(0)}${p.toMaxKg ? ` / ${fmt(p.toMaxKg)}` : ''}</td></tr>`).join('');
  const why = Object.entries(r.notEmptiedBy || {}).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${fmt(n)} × ${w.toLowerCase()}`);
  const notRows = r.notEmptied.map(n => `<tr><td class="bin">${esc(n.bin)}</td><td class="key">${esc(n.zone)}</td><td class="code">${esc(n.binType)}</td><td class="num">${p1(n.occPct)}</td>
    <td>${esc(n.why)}</td><td class="code">${esc(n.stock)}</td></tr>`).join('');
  return `<div class="panel" style="margin-top:16px">
    <div class="panel-sec"><div class="verdict-big"><span class="light ${s.binsEmptied ? 'green' : 'yellow'}"></span>
      <h3>${s.binsEmptied ? `${plural(s.binsEmptied, 'bin')} can be emptied` : 'No bin can be emptied'}</h3>
      <span class="hint">${fmt(s.under)} of ${fmt(s.fromStocked)} stocked bins to empty from are under ${o.belowPct}% full · read ${esc(new Date(r.loadedAt).toLocaleTimeString())}</span></div>
      <dl class="stats" style="margin-top:18px">
        <div><dt>Under ${o.belowPct}%</dt><dd>${fmt(s.under)}</dd></div>
        <div><dt>Bins emptied</dt><dd>${fmt(s.binsEmptied)}</dd></div>
        <div><dt>Steps</dt><dd>${fmt(s.moves)}</dd></div>
        <div><dt>Pallets moved whole</dt><dd>${fmt(s.palletsMovedWhole)}</dd></div>
        <div><dt>Pallets merged</dt><dd>${fmt(s.palletsMerged)}</dd></div>
        <div><dt>Empty bins used</dt><dd>${fmt(s.emptyBinsUsed)}</dd></div>
        <div><dt>Net bins freed</dt><dd>${fmt(s.netFreed)}</dd></div>
        ${s.positionsFreed ? `<div><dt>Pallet positions freed</dt><dd>${fmt(s.positionsFreed)}</dd></div>` : ''}
      </dl>
      <p class="hint" style="margin:12px 0 0">${fmt(s.toUsable)} bins can receive (${fmt(s.toEmpty)} of the ticked ones are empty; ${{smaller: 'only ones smaller than the bin being emptied are used', any: 'any of them can be used', none: 'none are used'}[o.useEmpty]}).
        ${why.length ? `Not emptied: ${why.join('; ')}.` : ''} Do the steps in order: a later step can put cases onto a pallet an earlier one moved in.</p>
      ${r.check.ok ? `<div class="callout" style="margin-top:12px"><span class="pill ok">Re-checked</span> Every step was replayed pallet by pallet and passed positions, pallet fill, weight, mixing rules and scope.</div>`
        : `<div class="callout warn" style="margin-top:12px"><b>The re-check found problems; don't use this plan.</b> ${r.check.errs.map(esc).join('; ')}</div>`}
      ${r.fixedError ? `<div class="callout warn" style="margin-top:12px">${esc(r.fixedError)}</div>` : ''}
      ${s.moves || r.notEmptiedCount ? `<div class="download" style="margin-top:16px"><button type="button" class="btn primary" id="cr-dl">Download the plan</button>
        <p>Summary, every step in order, bins emptied, every bin under ${o.belowPct}% that wasn't, with the reason, and the IM upload sheets.</p></div>` : ''}
      ${imDlHtml(r, 'relocate')}</div>
    ${rows ? `<div class="panel-sec"><h3>Steps<small>${r.moves.length < s.moves ? `first ${fmt(r.moves.length)} of ${fmt(s.moves)}` : plural(s.moves, 'step')}, in order</small></h3>
      <div class="table-wrap"><table><thead><tr><th class="num">#</th><th>From bin<small class="sub">zone · % full</small></th><th>Pallet</th><th>SKU<small class="sub">batch</small></th><th class="num">Qty</th>
        <th>How</th><th>To bin</th><th class="num">To after</th><th class="num">kg</th></tr></thead><tbody>${rows}</tbody></table></div></div>` : ''}
    ${notRows ? `<div class="panel-sec"><details><summary>Under ${o.belowPct}% but not emptied (${fmt(r.notEmptiedCount)})</summary><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Bin</th><th>Zone</th><th>Bin type</th>
      <th class="num">% full</th><th>Why</th><th>Stock</th></tr></thead><tbody>${notRows}</tbody></table></div>${r.notEmptiedCount > r.notEmptied.length ? `<p class="hint">First ${fmt(r.notEmptied.length)}; the download has all of them.</p>` : ''}</details></div>` : ''}
  </div>`;
}

const CE = {wh: null, areas: []};
const litres = cc => cc === null || cc === undefined ? '–' : Number((cc / 1000).toFixed(1)).toLocaleString();
// remembered ticks per warehouse: {areas: [...], zones: [...]}; first time, every INVENTORY area
const ceSaved = () => { try { return JSON.parse(localStorage.getItem('ce-scope:' + wh()) || 'null'); } catch { return null; } };
function ceSave() {
  const areas = [...document.querySelectorAll('#ce-scope input[data-area]:checked')].map(x => x.dataset.area);
  const zones = [...document.querySelectorAll('#ce-scope input[data-zone]:checked')].map(x => x.dataset.zone);
  try { localStorage.setItem('ce-scope:' + wh(), JSON.stringify({areas, zones})); } catch {}
  ceCount();
}
function ceCount() {
  const z = [...document.querySelectorAll('#ce-scope input[data-zone]:checked')];
  const bins = z.reduce((t, x) => t + Number(x.dataset.occ), 0);
  $('#ce-count').textContent = z.length ? `${plural(z.length, 'zone')} ticked, ${fmt(bins)} bins holding stock` : 'Tick at least one zone';
}
async function ceLoad(force) {
  if (!/^\d+$/.test(wh())) { $('#ce-count').textContent = 'Set the warehouse id first'; return; }
  if (!force && CE.wh === wh()) return;
  $('#ce-count').textContent = 'Loading areas…';
  try {
    const r = await api('/api/inv/eaches-scope?' + qs(force ? {refresh: '1'} : {}));
    CE.wh = wh(); CE.areas = r.areas; ceTypes(r.binTypes || []);
    const saved = ceSaved();
    const on = (a, z) => saved ? saved.zones.includes(z.zone) : a.type === 'INVENTORY';
    $('#ce-scope').innerHTML = r.areas.length ? r.areas.map(a => `<fieldset class="ce-area"><legend><label><input type="checkbox" data-area="${esc(a.area)}"
        ${a.zones.every(z => on(a, z)) ? 'checked' : ''}> <b>${esc(a.area)}</b> <small>${esc(a.type)}</small></label></legend>
      ${a.zones.map(z => `<label class="ce-zone"><input type="checkbox" data-zone="${esc(z.zone)}" data-of="${esc(a.area)}" data-occ="${z.occupied}" ${on(a, z) ? 'checked' : ''}>
        <span class="mono">${esc(z.zone)}</span> <small>${fmt(z.occupied)} of ${fmt(z.bins)} bins hold stock · ${z.volumes.map(v => v >= 1e7 ? `<span class="pill warn" title="Looks unset; these bins are skipped">${litres(v)} L</span>` : `${litres(v)} L`).join(', ') || 'no volume set'}</small></label>`).join('')}
      </fieldset>`).join('') : '<p class="hint">No shelf (BIN-type) storage bins in this warehouse.</p>';
    ceCount();
  } catch (e) { $('#ce-scope').innerHTML = `<div class="alert" role="alert">${esc(e.message)}</div>`; $('#ce-count').textContent = ''; }
}
$('#ce-scope').addEventListener('change', e => {
  const t = e.target;
  if (t.dataset.area) document.querySelectorAll(`#ce-scope input[data-of="${CSS.escape(t.dataset.area)}"]`).forEach(z => { z.checked = t.checked; });
  if (t.dataset.of) { const zs = [...document.querySelectorAll(`#ce-scope input[data-of="${CSS.escape(t.dataset.of)}"]`)];
    const a = document.querySelector(`#ce-scope input[data-area="${CSS.escape(t.dataset.of)}"]`); a.checked = zs.every(z => z.checked); a.indeterminate = !a.checked && zs.some(z => z.checked); }
  ceSave();
});
$('#ce-reload').onclick = () => ceLoad(true);
const ceTypesSaved = () => { try { return JSON.parse(localStorage.getItem('ce-bt:' + wh()) || 'null'); } catch { return null; } };
function ceTypes(list) {
  const saved = ceTypesSaved();
  $('#ce-types').innerHTML = list.length ? list.map(t => `<label class="ce-type"><input type="checkbox" data-bt="${esc(t.binType)}" data-occ="${t.occupied}" ${!saved || saved.includes(t.binType) ? 'checked' : ''}>
    <span class="mono">${esc(t.binType)}</span> <small>${t.volCC >= 1e7 ? `<span class="pill warn" title="Looks unset; these bins are skipped">${litres(t.volCC)} L</span>` : t.volCC ? litres(t.volCC) + ' L' : 'no volume'}${t.maxKg ? ` · ${fmt(t.maxKg)} kg` : ''} · ${fmt(t.occupied)} of ${fmt(t.bins)} hold stock · ${t.areas.map(esc).join(', ')}</small></label>`).join('')
    : '<p class="hint">No shelf bin types.</p>';
  ceTypesCount();
}
function ceTypesCount() {
  const all = [...document.querySelectorAll('#ce-types input[data-bt]')], on = all.filter(x => x.checked);
  $('#ce-bt-count').textContent = !all.length ? '' : on.length === all.length ? 'All ticked' : on.length ? `${on.length} of ${all.length} ticked` : 'Tick at least one';
}
$('#ce-types').addEventListener('change', () => {
  try { localStorage.setItem('ce-bt:' + wh(), JSON.stringify([...document.querySelectorAll('#ce-types input[data-bt]:checked')].map(x => x.dataset.bt))); } catch {}
  ceTypesCount();
});
// units and the fill limit are remembered across warehouses
try { const u = JSON.parse(localStorage.getItem('ce-units') || 'null'); if (u) { $('#ce-u-l0').checked = u.includes('L0'); $('#ce-u-l2').checked = u.includes('L2'); } } catch {}
try { const b = localStorage.getItem('ce-below'); if (b) $('#ce-below').value = b; } catch {}
const ceUnits = () => [['L0', '#ce-u-l0'], ['L2', '#ce-u-l2']].filter(([, id]) => $(id).checked).map(([u]) => u);
[$('#ce-u-l0'), $('#ce-u-l2')].forEach(x => x.addEventListener('change', () => { try { localStorage.setItem('ce-units', JSON.stringify(ceUnits())); } catch {} }));
$('#ce-below').addEventListener('change', () => { try { localStorage.setItem('ce-below', $('#ce-below').value); } catch {} });
// load when the Consolidate view opens, and again if the warehouse changes
new MutationObserver(() => { if (!$('#v-consolidate').hidden) ceLoad(); }).observe($('#v-consolidate'), {attributes: true, attributeFilter: ['hidden']});
if (!$('#v-consolidate').hidden) ceLoad();

$('#ce-go').onclick = async () => {
  const out = $('#ce-out');
  if (!/^\d+$/.test(wh())) { out.innerHTML = '<div class="alert" role="alert">The warehouse id needs to be a number. Fix it under Warehouse id.</div>'; return; }
  await ceLoad();
  const zones = [...document.querySelectorAll('#ce-scope input[data-zone]:checked')];
  if (!zones.length) { out.innerHTML = '<div class="alert" role="alert">Tick at least one zone to merge within.</div>'; return; }
  const areas = [...new Set(zones.map(z => z.dataset.of))];
  const allTypes = [...document.querySelectorAll('#ce-types input[data-bt]')], types = allTypes.filter(x => x.checked).map(x => x.dataset.bt);
  if (allTypes.length && !types.length) { out.innerHTML = '<div class="alert" role="alert">Tick at least one bin type.</div>'; return; }
  const uoms = ceUnits();
  if (!uoms.length) { out.innerHTML = '<div class="alert" role="alert">Tick eaches, cases or both to move.</div>'; return; }
  const below = Math.min(100, Math.max(1, Number($('#ce-below').value) || 100));
  const go = $('#ce-go'); go.disabled = true; go.textContent = 'Reading stock…';
  out.innerHTML = '<div class="loading" style="margin-top:16px">Reading shelf bins, stock, volumes and task locks…</div>';
  try {
    const r = await api('/api/inv/consolidate-eaches?' + qs({areas: areas.join(','), zones: zones.map(z => z.dataset.zone).join(','),
      crossZone: $('#ce-cross').checked ? '1' : '0', checkWeight: $('#ce-kg').checked ? '1' : '0', fillPct: $('#ce-fill').value || 100,
      binTypes: types.length === allTypes.length ? '' : types.join(','), uoms: uoms.join(','), emptyBelowPct: below}));
    out.innerHTML = ceHtml(r);
    $('#ce-dl') && ($('#ce-dl').onclick = () => { const a = document.createElement('a'); a.href = '/api/inv/consolidate-eaches-download?' + qs({token: r.token}); document.body.append(a); a.click(); a.remove(); });
  } catch (e) { out.innerHTML = `<div class="alert" role="alert">${esc(e.message)}</div>`; }
  go.disabled = false; go.textContent = 'Find bins to empty';
};
function ceHtml(r) {
  const s = r.stats, pctOf = (a, b) => b ? (a / b * 100).toFixed(1) + '%' : '–';
  // stocked bins the plan skips (or only empties), counted by reason
  const left = Object.entries(r.leftOutBy || {}).sort((a, b) => b[1] - a[1]).map(([w, n]) => `${fmt(n)} × ${w.toLowerCase()}`);
  const leftRows = (r.leftOut || []).map(x => `<tr><td class="bin">${esc(x.bin)}</td><td class="key">${esc(x.zone)}</td><td>${esc(x.reason)}</td><td class="code">${esc(x.stock)}</td></tr>`).join('');
  const rows = r.moves.map(p => {
    const fits = p.toUsedAfterCC <= p.toCapCC + 1e-6 && (!p.toMaxKg || p.toKgAfter <= p.toMaxKg + 1e-6);
    return `<tr><td class="sku">${esc(p.sku)}</td><td class="code">${esc(p.batch)}</td><td class="num"><b>${fmt(p.qty)}</b><small class="sub">${p.uom === 'L0' ? (p.qty === 1 ? 'each' : 'eaches') : p.uom === 'L2' ? (p.qty === 1 ? 'case' : 'cases') : p.uom}</small></td>
      <td class="bin">${esc(p.fromBin)}<small class="sub">${litres(p.fromUsedCC)} of ${litres(p.fromBinVolCC)} L</small></td>
      <td class="bin">${esc(p.toBin)}${p.toZone !== p.fromZone ? `<small class="sub">${esc(p.toZone)}</small>` : ''}</td>
      <td class="num">${Number(p.unitVolCC.toFixed(1)).toLocaleString()}</td><td class="num">${litres(p.moveVolCC)}</td><td class="num">${litres(p.toBinVolCC)}</td>
      <td class="num">${litres(p.toUsedBeforeCC)} → <b>${litres(p.toUsedAfterCC)}</b><small class="sub">${pctOf(p.toUsedBeforeCC, p.toBinVolCC)} → ${pctOf(p.toUsedAfterCC, p.toBinVolCC)}</small></td>
      <td class="num">${p.toKgAfter.toFixed(1)}${p.toMaxKg ? ` / ${fmt(p.toMaxKg)}` : ''}</td>
      <td>${fits ? '<span class="pill ok">Fits</span>' : '<span class="pill bad">Over</span>'}</td></tr>`;
  }).join('');
  return `<div class="panel" style="margin-top:16px">
    <div class="panel-sec"><div class="verdict-big"><span class="light ${s.binsEmptied ? 'green' : 'yellow'}"></span>
      <h3>${s.binsEmptied ? `${plural(s.binsEmptied, 'shelf bin')} can be emptied` : 'No shelf bin can be emptied'}</h3>
      <span class="hint">${fmt(s.occupied)} of ${fmt(s.binsInScope)} shelf bins in scope hold stock, read ${esc(new Date(r.loadedAt).toLocaleTimeString())}</span></div>
      <dl class="stats" style="margin-top:18px">
        <div><dt>Bins emptied</dt><dd>${fmt(s.binsEmptied)}</dd></div>
        <div><dt>Most possible</dt><dd>${fmt(s.bestPossible)}${s.optimal ? ' <span class="pill ok" title="No plan can empty more bins under these rules">Best possible</span>' : ''}</dd></div>
        <div><dt>Moves</dt><dd>${fmt(s.moves)}</dd></div>
        <div><dt>${r.opts.uoms && r.opts.uoms.some(x => x !== 'L0') ? 'Units moved' : 'Eaches moved'}</dt><dd>${fmt(s.eachesMoved)}</dd></div>
      </dl>
      <p class="hint" style="margin:12px 0 0">Most possible: the fewest bins each SKU, batch and price could be squeezed into under these rules, counted in whole units${r.opts.checkWeight ? ' and kg' : ''}. ${s.optimal ? 'This plan reaches it.' : ''}
        ${r.opts.emptyBelowPct < 100 ? `${plural(s.tooFull || 0, 'bin')} at ${r.opts.emptyBelowPct}% full or more ${s.tooFull === 1 ? 'was' : 'were'} only used to receive.` : ''}
        ${left.length ? `Bins left out: ${left.join('; ')}.` : 'No stocked bin in scope was left out.'}</p>
      ${leftRows ? `<details style="margin-top:10px"><summary>Left out bins (${fmt(r.leftOutCount)})</summary><div class="table-wrap" style="margin-top:8px"><table><thead><tr><th>Bin</th><th>Zone</th><th>Why</th><th>Stock</th></tr></thead><tbody>${leftRows}</tbody></table></div>${r.leftOutCount > r.leftOut.length ? `<p class="hint">First ${fmt(r.leftOut.length)}; the download has all of them.</p>` : ''}</details>` : ''}
      ${r.check.ok ? `<div class="callout" style="margin-top:12px"><span class="pill ok">Re-checked</span> Every move was replayed on the stock and passed volume, weight and mixing rules.</div>`
        : `<div class="callout warn" style="margin-top:12px"><b>The re-check found problems; don't use this plan.</b> ${r.check.errs.map(esc).join('; ')}</div>`}
      ${r.fixedError ? `<div class="callout warn" style="margin-top:12px">${esc(r.fixedError)}</div>` : ''}
      ${s.moves ? `<div class="download" style="margin-top:16px"><button type="button" class="btn primary" id="ce-dl">Download the plan</button>
        <p>Summary, every move with bin and unit volumes (Moves), bins emptied, each receiving bin before and after, every bin left out with the reason, and the IM upload sheet.</p></div>` : ''}
      ${imDlHtml(r, 'eaches')}</div>
    ${rows ? `<div class="panel-sec"><h3>Moves<small>${r.moves.length < s.moves ? `first ${fmt(r.moves.length)} of ${fmt(s.moves)}` : plural(s.moves, 'move')}, in bin order</small></h3>
      <div class="table-wrap"><table><thead><tr><th>SKU</th><th>Batch</th><th class="num">Qty</th><th>From bin<small class="sub">used of volume</small></th><th>To bin</th>
        <th class="num">Unit (cc)<small class="sub">L0 or L2</small></th><th class="num">Move (L)</th><th class="num">To bin (L)</th><th class="num">To bin fill (L)</th><th class="num">kg</th><th></th></tr></thead>
        <tbody>${rows}</tbody></table></div></div>` : ''}
  </div>`;
}
