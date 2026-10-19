// ---- check masters ---------------------------------------------------------------
const b64 = buf => { const b = new Uint8Array(buf); let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000)); return btoa(s); };

const MP = makePicker($('#m-pick'), 'uatdesk.mastersOff', '/api/masters/catalog');

// the Masters sub-tabs (SKU, Batch, Production batch) show only that sheet's checks; All sheets shows every
// kind. Files of any kind are still accepted, so sheets dropped together are still checked against each other.
const MASTER_SHEET = {sku: 'SKU master', batch: 'batch master', production: 'production batch master'};
function mastersFocus(kind) {
  const p = $('#m-pick');
  if (kind) p.dataset.only = kind; else delete p.dataset.only;
  $('#drop-masters b').textContent = kind ? `Drop the ${MASTER_SHEET[kind]} sheet here, or choose files`
    : 'Drop SKU, batch and/or production batch master sheets here, or choose files';
}

async function checkMasters(files) {
  const out = $('#masters-out');
  files = [...files].filter(f => /\.xlsx$/i.test(f.name));
  if (!files.length) { out.innerHTML = '<div class="alert">Drop .xlsx files.</div>'; return; }
  if (!/^\d+$/.test(wh())) { out.innerHTML = '<div class="alert">The warehouse id needs to be a number. Fix it under Warehouse id.</div>'; return; }
  MP.rerun(files.map(f => f.name), () => checkMasters(files));
  out.innerHTML = `<div class="loading">Checking ${files.map(f => esc(f.name)).join(', ')}…</div>`;
  try {
    const body = {whId: wh(), principalId: $('#principal').value.trim() || undefined,
      skip: MP.skip(),
      files: await Promise.all(files.map(async f => ({name: f.name, data: b64(await f.arrayBuffer())})))};
    const r = await api('/api/masters/check', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    out.innerHTML = `<p class="hint" style="margin:14px 0 0">Checked against encarta principal ${esc(r.principal)}: ${fmt(r.live.skus)} SKUs, ${fmt(r.live.batches)} batches, ${fmt(r.live.production)} production lots.
      <b class="t-bad">Red</b>: encarta rejects it, or it goes in as wrong data. <b class="t-warn">Yellow</b>: suspicious, worth a look. Row numbers are spreadsheet rows, so row 2 is the first data row.</p>` +
      r.results.map(v => v.error ? `<div class="alert">${esc(v.name)}: ${esc(v.error)}</div>` : !v.checks.length ? `<div class="panel" style="margin-top:16px">
        <div class="panel-sec"><h3>${esc(v.kindName)}<small>${esc(v.name)} · ${fmt(v.rows)} rows</small></h3>
          <div class="callout warn">Every ${esc(v.kindName.toLowerCase())} check is off, so nothing was checked. Turn some on above and press Check again.</div></div></div>` : `<div class="panel" style="margin-top:16px">
        <div class="panel-sec"><h3>${esc(v.kindName)}<small>${esc(v.name)} · ${fmt(v.rows)} rows · ${fmt(v.rowsHard)} red, ${fmt(v.rowsSoft)} yellow${v.checksOff ? ` · ${fmt(v.checksOff)} check${v.checksOff === 1 ? '' : 's'} off` : ''}</small></h3>
          <div class="download" style="margin-bottom:14px"><button type="button" class="btn primary" data-dl="${esc(v.token)}">Download checked sheet</button>
            <p>Your sheet with red and yellow rows and the exact problem on each row in an Issues column.</p></div>
          ${v.fixes && (v.fixes.rows || v.fixes.review) ? `<div class="download" style="margin-bottom:14px"><button type="button" class="btn" data-fix="${esc(v.token)}">Download fix sheet</button>
            <p>${fmt(v.fixes.rows)} ready-to-upload AddBatchTemplate row${v.fixes.rows === 1 ? '' : 's'} (missing family batches copied across, case configs corrected)${v.fixes.review ? `, plus ${fmt(v.fixes.review)} date fix${v.fixes.review === 1 ? '' : 'es'} to review first` : ''}${v.fixes.skipped ? `. ${fmt(v.fixes.skipped)} gap${v.fixes.skipped === 1 ? '' : 's'} not fixed because the source batch is itself wrong` : ''}. Re-check the fix sheet here before uploading it.</p></div>` : ''}
          ${checklistHtml(v)}</div></div>`).join('');
    doneDrop('#drop-masters', 'Check other sheets: drop them here, or choose files');
    const get = url => { const a = document.createElement('a'); a.href = url; document.body.append(a); a.click(); a.remove(); };
    out.querySelectorAll('[data-dl]').forEach(b => b.onclick = () => get('/api/masters/download?token=' + encodeURIComponent(b.dataset.dl)));
    out.querySelectorAll('[data-fix]').forEach(b => b.onclick = () => get('/api/masters/fixes?token=' + encodeURIComponent(b.dataset.fix)));
  } catch (e) { out.innerHTML = `<div class="alert">${esc(e.message)}</div>`; }
}
{
  const z = $('#drop-masters');
  z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('over'); checkMasters(e.dataTransfer.files); });
  $('#file-masters').onchange = e => { checkMasters(e.target.files); e.target.value = ''; };
}
