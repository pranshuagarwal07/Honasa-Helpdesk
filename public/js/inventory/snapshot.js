// ---- warehouse snapshot ---------------------------------------------------------
async function loadSnapshot(refresh) {
  if (!/^\d+$/.test(wh())) { $('#build-out').innerHTML = '<div class="alert">The warehouse id needs to be a number. Fix it under Warehouse id.</div>'; return; }
  try { localStorage.setItem('whId', wh()); } catch {}
  $('#go-build').disabled = true;
  $('#build-out').innerHTML = '<div class="loading">Loading bins, search table, stock and master data for this warehouse…</div>';
  try {
    state.snap = await api('/api/inv/snapshot?' + qs(refresh ? {refresh: '1'} : {}));
  } catch (e) {
    $('#build-out').innerHTML = `<div class="alert">${esc(e.message)}</div>`; return;
  }
  const s = state.snap;
  $('#prefix').value = s.suggestedPrefix;
  let len = null; try { len = Number(localStorage.getItem('uatdesk.huLen')) || null; } catch {}
  $('#len').value = len || s.suggestedPrefix.length + 5;
  bulkLenHint();
  $('#v-prefix').value = $('#v-prefix').value || s.suggestedPrefix;
  const pallets = s.kinds.filter(k => /PALLET/i.test(k));
  $('#kind').innerHTML = (pallets.length ? pallets : ['PALLET']).map(k => `<option ${k === 'PALLET' ? 'selected' : ''}>${esc(k)}</option>`).join('');
  $('#tmpl-name').textContent = s.template.custom ? 'your template' : 'standard';
  $('#go-build').disabled = false;
  $('#build-out').innerHTML = snapshotHtml(s);
  $('#reload').onclick = () => loadSnapshot(true);
}

function sessionsHtml(sessions) {
  if (!sessions?.length) return '';
  const byKind = {};
  sessions.forEach(x => { (byKind[x.kind] ||= []).push(x.code); });
  return `<div class="callout warn"><b>${sessions.length} open session${sessions.length > 1 ? 's' : ''} will block the upload.</b>
    Close them, or tick Force update when you upload in the panel.
    <ul>${Object.entries(byKind).map(([k, c]) => `<li>${esc(k)}: ${esc(c.slice(0, 6).join(', '))}${c.length > 6 ? ` and ${c.length - 6} more` : ''}</li>`).join('')}</ul></div>`;
}

function snapshotHtml(s) {
  const rows = s.areas.map(a => {
    const pct = a.bins ? a.occupied / a.bins * 100 : 0;
    return `<tr><td class="key">${esc(a.area)}</td><td>${esc(a.type)}</td><td class="num">${fmt(a.zones)}</td><td class="num">${fmt(a.bins)}</td>
      <td class="num">${fmt(a.occupied)}</td><td><div class="occ"><div class="bar"><i class="now" style="width:${pct}%"></i></div><span>${pct.toFixed(0)}%</span></div></td></tr>`;
  }).join('');
  return `<div class="panel">
    <div class="panel-sec"><div class="act-head" style="margin:0 0 14px"><h3 style="margin:0">Warehouse today</h3>
      <button type="button" class="btn small" id="reload">Reload</button></div>
      <dl class="stats">
        <div><dt>Active SKUs with a class</dt><dd>${fmt(s.skus.classified)}</dd></div>
        <div><dt>Batches</dt><dd>${fmt(s.batches)}</dd></div>
        <div><dt>HU codes in use</dt><dd>${fmt(s.huCodes)}</dd></div>
        <div><dt>Open sessions</dt><dd>${fmt(s.sessions.length)}</dd></div>
      </dl></div>
    ${s.sessions.length || s.warnings.length ? `<div class="panel-sec">${sessionsHtml(s.sessions)}${s.warnings.map(w => `<div class="callout warn">${esc(w)}</div>`).join('')}</div>` : ''}
    <div class="panel-sec"><div class="table-wrap"><table>
      <thead><tr><th>Area</th><th>Type</th><th class="num">Zones</th><th class="num">Bins</th><th class="num">Occupied</th><th>Occupancy</th></tr></thead>
      <tbody>${rows}</tbody></table></div></div>
    <div class="panel-sec"><p class="hint" style="margin:0">Principal ${esc(s.principalId)}. Weights read as ${s.weightUnit === 'g' ? 'grams' : 'kilograms'}. Loaded ${new Date(s.loadedAt).toLocaleTimeString()}.
      Set the target on the left and build the fill.</p></div>
  </div>`;
}

$('#wh').addEventListener('change', () => { state.token = null; state.snap = null; if (!$('#v-build').hidden) loadSnapshot(); });
