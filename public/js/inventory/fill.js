// Bulk fill: settings, build, the checklist, download.
// ---- settings ------------------------------------------------------------------
const bulkLenHint = () => huLenHint($('#prefix').value, $('#len').value, $('#len-h'));
$('#prefix').addEventListener('input', bulkLenHint);
$('#len').addEventListener('input', () => { bulkLenHint(); try { localStorage.setItem('uatdesk.huLen', $('#len').value); } catch {} });
$('#t-range').oninput = () => { $('#t-num').value = $('#t-range').value; };
$('#t-num').oninput = () => { $('#t-range').value = $('#t-num').value; };
$('#tmpl-file').onchange = async e => {
  const f = e.target.files[0]; if (!f) return;
  try {
    const r = await api('/api/inv/template?' + qs(), {method: 'POST', body: await f.arrayBuffer()});
    $('#tmpl-name').textContent = `your template (${r.headers.length} columns)`;
  } catch (err) { alert(err.message); }
  e.target.value = '';
};

$('#settings').onsubmit = async e => {
  e.preventDefault();
  const areas = [...document.querySelectorAll('input[name=area]:checked')].map(x => x.value);
  if (!areas.length) { alert('Pick at least one area to fill.'); return; }
  const o = {
    target: Number($('#t-num').value) / 100, areaTypes: areas,
    op: document.querySelector('input[name=op]:checked').value,
    huPrefix: $('#prefix').value.trim(), huLength: Number($('#len').value) || undefined, huKind: $('#kind').value, shelfLifeDays: Number($('#shelf').value),
    skuInclude: $('#inc').value.trim(), skuExclude: $('#exc').value.trim(), bucket: $('#bucket').value, inclusion: $('#incl').value,
    maxBatchesPerSku: Number($('#maxb').value), maxEachesPerBin: Number($('#maxe').value), maxKgPerBin: Number($('#maxkg').value), seed: Number($('#seed').value),
  };
  const btn = $('#go-build');
  btn.disabled = true; btn.textContent = 'Building…';
  try {
    const r = await api('/api/inv/build?' + qs(), {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(o)});
    state.token = r.token; state.prefix = o.huPrefix; state.target = o.target;
    $('#build-out').innerHTML = buildHtml(r, o);
    $('#dl') && ($('#dl').onclick = download);
    $('#to-verify') && ($('#to-verify').onclick = () => showMode('verify'));
    $('#back-snap').onclick = () => { $('#build-out').innerHTML = snapshotHtml(state.snap); $('#reload').onclick = () => loadSnapshot(true); };
  } catch (err) {
    $('#build-out').innerHTML = `<div class="alert">${esc(err.message)}</div>`;
  }
  btn.disabled = false; btn.textContent = 'Build fill';
};

// 2,3,4,5,9 -> "2–5, 9"
const rowRuns = rows => { const out = []; for (const x of rows) { const l = out[out.length - 1]; if (l && x === l[1] + 1) l[1] = x; else out.push([x, x]); }
  return out.map(([a, b]) => a === b ? a : b === a + 1 ? `${a}, ${b}` : `${a}–${b}`).join(', '); };
function checklistHtml(v) {
  const order = {fail: 0, warn: 1, info: 2, pass: 3};
  const items = [...v.checks].sort((a, b) => order[a.status] - order[b.status]);
  const li = c => `<li class="${c.status}"><span class="mark">${c.status === 'fail' || c.status === 'warn' ? '!' : c.status === 'pass' ? '✓' : 'i'}</span><div>${esc(c.title)}
    ${(c.status === 'fail' || c.status === 'warn') && c.count && c.rows.length ? `<small class="rows">${c.count > 1 ? 'Rows' : 'Row'} ${rowRuns(c.rows)}${c.count > c.rows.length ? ` … (${fmt(c.count)} in all)` : ''}</small>` : ''}
    ${(c.status === 'fail' || c.status === 'warn') && c.count && !c.rows.length ? `<small class="rows">${fmt(c.count)} missing</small>` : ''}
    ${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</div></li>`;
  const bad = items.filter(c => c.status !== 'pass'), good = items.filter(c => c.status === 'pass');
  return `<div class="verdict">${v.failed ? `<span class="pill bad">${v.failed} failed</span>` : `<span class="pill ok">${v.warned ? 'No blockers' : 'All checks pass'}</span>`}${v.warned ? ` <span class="pill warn">${v.warned} warning${v.warned > 1 ? 's' : ''}</span>` : ''}
      <span class="hint" style="margin:0">${v.passed} of ${v.checks.filter(c => c.status !== 'info').length} checks pass</span></div>
    ${bad.length ? `<ul class="checklist" style="margin-top:10px">${bad.map(li).join('')}</ul>` : ''}
    <details style="margin-top:10px"><summary>Passing checks (${good.length})</summary><ul class="checklist" style="margin-top:6px">${good.map(li).join('')}</ul></details>`;
}

function buildHtml(r, o) {
  const t = r.totals, v = r.validation;
  const zones = r.summary.map(z => `<tr><td class="key">${esc(z.zone)}</td><td>${esc(z.area)}</td><td>${z.huType === 'PALLET' ? 'Pallet' : 'Bin'}</td>
    <td class="num">${fmt(z.bins)}</td><td class="num">${fmt(z.occupiedNow)}</td><td class="num">${fmt(z.newBins)}</td>
    <td><div class="occ"><div class="bar"><i class="now" style="width:${z.nowPct}%"></i><i class="new" style="width:${z.finalPct - z.nowPct}%"></i></div><span>${z.finalPct.toFixed(0)}%</span></div></td></tr>`).join('');
  const preview = r.rows.slice(0, 200).map(x => `<tr><td class="num">${x.row}</td><td class="bin">${esc(x.bin)}</td><td class="code">${esc(x.hu)}</td><td class="code">${esc(x.sku)}</td>
    <td class="num">${fmt(x.qty)}</td><td>${esc(x.uom)}</td><td class="code">${esc(x.batch)}</td><td>${esc(x.mfg)}</td><td>${esc(x.exp)}</td></tr>`).join('');
  const skipZ = r.skipped.zones.map(z => `<li>${esc(z.zone)} <small>(${esc(z.area)}, ${fmt(z.bins)} bins)</small>: ${esc(z.why)}</li>`).join('');
  const skipS = r.skipped.skus.map(s => `<li>${esc(s.why)}: ${fmt(s.count)} SKU${s.count === 1 ? '' : 's'} <small>e.g. ${esc(s.sample.slice(0, 6).join(', '))}</small></li>`).join('');
  return `<div class="panel">
    <div class="panel-sec"><div class="act-head" style="margin:0 0 14px"><h3 style="margin:0">Fill to ${Math.round(o.target * 100)}%<small>${esc(o.op.toLowerCase())}, prefix ${esc(o.huPrefix)}</small></h3>
      <button type="button" class="link back" id="back-snap">Back to overview</button></div>
      <dl class="stats">
        <div><dt>Rows</dt><dd>${fmt(t.rows)}</dd></div><div><dt>Bins filled</dt><dd>${fmt(t.bins)}</dd></div>
        <div><dt>SKUs</dt><dd>${fmt(t.skus)}</dd></div><div><dt>Batches</dt><dd>${fmt(t.batches)}</dd></div>
        <div><dt>New pallet HUs</dt><dd>${fmt(t.newHUs)}</dd></div>
      </dl>
      ${r.huCodes ? `<p class="hint" style="margin:12px 0 0">Pallet codes are ${r.huCodes.length} characters, <span class="mono">${esc(r.huCodes.first)}</span> to <span class="mono">${esc(r.huCodes.last)}</span>.</p>` : ''}</div>
    <div class="panel-sec">
      ${t.rows ? `<div class="download">
        <button type="button" class="btn primary big" id="dl" ${v.failed ? 'disabled' : ''}>Download sheet</button>
        <p>${v.failed ? 'Fix the failing checks below first. A failed upload burns every HU code in the sheet.'
          : 'Upload it in the panel under Append/Reset Inventory, then come back and verify it landed.'}</p>
        ${v.failed ? '' : '<button type="button" class="btn" id="to-verify">Verify after upload</button>'}</div>`
        : '<div class="alert" style="margin:0">Nothing to add. Every zone is already at or above the target, or no SKU is allowed in the empty bins.</div>'}
      ${sessionsHtml(v.sessions) ? `<div style="margin-top:14px">${sessionsHtml(v.sessions)}</div>` : ''}
    </div>
    <div class="panel-sec"><h3>Checks</h3>${checklistHtml(v)}</div>
  </div>
  <div class="panel">
    <div class="panel-sec"><div class="act-head"><h3 style="margin:0">By zone</h3>
      <div class="legend"><span><i class="now"></i>Stock today</span><span><i class="new"></i>Added</span></div></div>
      ${zones ? `<div class="table-wrap"><table><thead><tr><th>Zone</th><th>Area</th><th>Holds</th><th class="num">Bins</th><th class="num">Full now</th><th class="num">Adding</th><th>After</th></tr></thead><tbody>${zones}</tbody></table></div>`
        : '<p class="none-msg">No zone qualified.</p>'}</div>
    ${skipZ || skipS ? `<div class="panel-sec"><h3>Left out</h3><ul class="skips">${skipZ}${skipS}</ul></div>` : ''}
    ${preview ? `<div class="panel-sec"><details><summary>First ${Math.min(200, t.rows)} of ${fmt(t.rows)} rows</summary><div class="table-wrap" style="margin-top:10px"><table>
      <thead><tr><th class="num">Row</th><th>Bin</th><th>HU</th><th>SKU</th><th class="num">Qty</th><th>UOM</th><th>Batch</th><th>Mfg</th><th>Expiry</th></tr></thead><tbody>${preview}</tbody></table></div></details></div>` : ''}
  </div>`;
}

function download() {
  const a = document.createElement('a');
  a.href = '/api/inv/download?' + qs({token: state.token});
  document.body.append(a); a.click(); a.remove();
  $('#v-prefix').value = state.prefix;
}
