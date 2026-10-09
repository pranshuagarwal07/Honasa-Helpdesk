// ---- check a sheet ---------------------------------------------------------------
function wireDrop(zone, input, handler) {
  const z = $(zone);
  z.addEventListener('dragover', e => { e.preventDefault(); z.classList.add('over'); });
  z.addEventListener('dragleave', () => z.classList.remove('over'));
  z.addEventListener('drop', e => { e.preventDefault(); z.classList.remove('over'); if (e.dataTransfer.files[0]) handler(e.dataTransfer.files[0]); });
  $(input).onchange = e => { if (e.target.files[0]) handler(e.target.files[0]); e.target.value = ''; };
}

const KP = makePicker($('#k-pick'), 'uatdesk.checksOff', '/api/inv/check-catalog');
wireDrop('#drop-check', '#file-check', checkSheet);
async function checkSheet(f) {
  const out = $('#check-out');
  KP.rerun([f.name], () => checkSheet(f));
  out.innerHTML = `<div class="loading">Checking ${esc(f.name)}…</div>`;
  try {
    const skip = KP.kinds ? KP.kinds.flatMap(KP.offIds) : [];
    const v = await api('/api/inv/check?' + qs({shelfLifeDays: $('#shelf').value, name: f.name, ...(skip.length ? {skip: skip.join(',')} : {})}), {method: 'POST', body: await f.arrayBuffer()});
    out.innerHTML = `<div class="panel" style="margin-top:16px">
      <div class="panel-sec"><h3>${esc(f.name)}<small>${fmt(v.rows)} rows, checked against stock as of ${esc(new Date(v.loadedAt).toLocaleTimeString())}${v.checksOff ? ` · ${plural(v.checksOff, 'check')} off` : ''}</small></h3>
        ${v.checks.length ? checklistHtml(v) : '<div class="callout warn">Every check is off, so nothing was checked. Turn some on above and press Check again.</div>'}</div>
      ${sessionsHtml(v.sessions) ? `<div class="panel-sec">${sessionsHtml(v.sessions)}</div>` : ''}
      <div class="panel-sec"><div class="download"><button type="button" class="btn primary" id="dl-checked">Download checked sheet</button>
          <p>Your sheet with the red and yellow rows marked and the reason on each, plus Summary, Consolidation, Moves and Pallet fill tabs.</p></div>
        <p class="hint" style="margin:12px 0 0"><b class="t-bad">Red</b> blocks: the upload or the next putaway or drop into that bin or pallet will fail. The uploader doesn't check multi-SKU, multi-batch or capacity, so these get past it.
          <b class="t-warn">Yellow</b> works, but goes against best fit. Row numbers are spreadsheet rows, so row 2 is the first data row.</p></div></div>
    ${consolidationHtml(v.consolidation)}`;
    doneDrop('#drop-check', 'Check another sheet: drop it here, or choose a file');
    $('#dl-checked').onclick = () => {
      const a = document.createElement('a');
      a.href = '/api/inv/check-download?' + qs({token: v.token});
      document.body.append(a); a.click(); a.remove();
    };
  } catch (e) { out.innerHTML = `<div class="alert">${esc(e.message)}</div>`; }
}

function doneDrop(sel, text) { const z = $(sel); z.classList.add('done'); z.querySelector('b').textContent = text; }

// what merging partial pallets of the same SKU + batch would free, after this sheet
const n2 = x => x === null || x === undefined ? '–' : Number(x.toFixed(1)).toLocaleString();
function mergesSec(c) {
  const s = c.stats;
  const rows = c.merges.map(g => `<tr><td class="sku">${esc(g.sku)}</td><td class="code">${esc(g.batch)}</td><td class="num">${n2(g.bestFit)}</td>
    <td class="num">${fmt(g.pallets)}</td><td class="num">${n2(g.cases)}</td><td class="num">${fmt(g.need)}</td><td class="num"><b>${fmt(g.frees)}</b></td>
    <td>${g.oneBin ? 'Same bin' : `${fmt(g.bins)} bins`}</td></tr>`).join('');
  return rows ? `<div class="panel-sec"><h3>Merge candidates<small>${c.merges.length < s.mergeGroups ? `top ${c.merges.length} of ${fmt(s.mergeGroups)}` : `${fmt(s.mergeGroups)} SKU-batch${s.mergeGroups === 1 ? '' : 'es'}`}</small></h3><div class="table-wrap"><table><thead><tr><th>SKU</th><th>Batch</th><th class="num">Best fit</th><th class="num">Partial pallets</th><th class="num">Cases</th><th class="num">Needs</th><th class="num">Frees</th><th>Where</th></tr></thead><tbody>${rows}</tbody></table></div></div>` : '';
}
function shelfSec(c) {
  if (!c.shelf.groups) return '';
  const li = c.shelf.top.slice(0, 15).map(x => `<li><span class="code">${esc(x.sku)}</span> <span class="code">${esc(x.batch)}</span>: ${fmt(x.bins)} bins <small class="code">${esc(x.list.slice(0, 6).join(', '))}${x.list.length > 6 ? ', …' : ''}</small></li>`).join('');
  return `<div class="panel-sec"><h3>Shelf bins<small>${fmt(c.shelf.groups)} SKU-batches sit in more than one shelf bin (${fmt(c.shelf.extraBins)} extra bins)</small></h3>
      <p class="hint" style="margin:0 0 8px">Shelves have no best fit, because putaway sizes them by volume. Check these by eye before merging.</p><ul class="skips">${li}</ul></div>`;
}
function consolidationHtml(c) {
  if (!c) return '';
  const s = c.stats, pctOf = (a, b) => b ? Math.round(a / b * 100) + '%' : '–';
  const zones = c.zones.filter(z => z.positions).map(z => `<tr><td class="key">${esc(z.zone)}</td><td>${esc(z.area)}</td>
    <td class="num">${fmt(z.positions)}</td><td class="num">${fmt(z.used)}</td><td class="num">${fmt(z.spare)}</td>
    <td class="num">${fmt(z.partial)}</td><td class="num">${z.frees ? `<b>${fmt(z.frees)}</b>` : '0'}</td></tr>`).join('');
  return `<div class="panel">
    <div class="panel-sec"><h3>Consolidation<small>pallet bins after this sheet${c.isReset ? ' (RESET replaces the stock in its bins)' : ', counting stock already there'}</small></h3>
      <dl class="stats">
        <div><dt>Free after sheet</dt><dd>${fmt(s.spare)}</dd></div>
        <div><dt>Freed by merging</dt><dd>${fmt(s.frees)}</dd></div>
        <div><dt>Free after merging</dt><dd>${fmt(s.spare + s.frees)}</dd></div>
      </dl>
      <details style="margin-top:12px"><summary>How that adds up</summary>
      <dl class="stats" style="margin-top:12px">
        <div><dt>Pallet positions</dt><dd>${fmt(s.positions)}</dd></div>
        <div><dt>Partial pallets</dt><dd>${fmt(s.partial)}</dd></div>
        <div><dt>Bins emptied</dt><dd>${fmt(s.binsEmptied)}</dd></div>
      </dl>
      <p class="hint" style="margin:12px 0 0">${fmt(s.palletBins)} active pallet bins (${pctOf(s.used, s.positions)} of positions used, ${fmt(s.emptyBins)} bins empty).
        ${fmt(s.pallets)} pallets: ${fmt(s.full)} at best fit, ${fmt(s.partial)} partial, ${fmt(s.over)} over best fit, ${fmt(s.mixed)} mixed SKU/batch${s.unsized ? `, ${fmt(s.unsized)} without an L2inL3` : ''}.
        Merging only joins pallets of the same SKU and batch, so it's allowed whatever the bin type's mixing rules.
        ${s.frees ? `${fmt(s.mergeGroups)} SKU-batches can merge; ${fmt(s.sameBinFrees)} of the ${fmt(s.frees)} freed pallets are inside the same bin. The Moves tab of the download lists every pour.` : 'No two partial pallets of the same SKU and batch add up to fewer pallets.'}</p></details></div>
    ${zones ? `<div class="panel-sec"><h3>By zone</h3><div class="table-wrap"><table><thead><tr><th>Zone</th><th>Area</th><th class="num">Positions</th><th class="num">Used</th><th class="num">Free</th><th class="num">Partial pallets</th><th class="num">Freed by merging</th></tr></thead><tbody>${zones}</tbody></table></div></div>` : ''}
    ${mergesSec(c)}
    ${shelfSec(c)}
  </div>`;
}
