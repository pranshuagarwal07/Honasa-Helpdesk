// Operations: go-live readiness, why putaway says no, stuck stock, API triggers.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const fmt = n => Number(n || 0).toLocaleString();
const wh = () => $('#wh').value.trim();
try { $('#wh').value = localStorage.getItem('whId') || DESK.wh; } catch { $('#wh').value = DESK.wh; }
$('#wh').addEventListener('change', () => { try { localStorage.setItem('whId', wh()); } catch {} });
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };

async function api(path, opts = {}) {
  let r;
  try { r = await fetch(path, opts); } catch { throw new Error(`Can't reach the local server. Start it with ${DESK.runBat}.`); }
  const body = await r.json().catch(() => ({}));
  if (!r.ok || body.error) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}
const needWh = out => { if (/^\d+$/.test(wh())) return false; out.innerHTML = '<div class="alert" role="alert">The warehouse id needs to be a number. Fix it in the sidebar.</div>'; $('#wh').focus(); return true; };
const ago = h => h === null || h === undefined ? '' : h < 1 ? 'under an hour' : h < 48 ? `${h} h` : `${Math.round(h / 24)} days`;

// ---- module navigation (js/tabs.js) ---------------------------------------------------
Tabs.init({name: 'Operations', tabs: [
  {id: 'golive', label: 'Go-live', features: [
    {id: 'ready', label: 'Readiness', view: '#v-ready', title: 'Go-live readiness',
      lede: 'One report for a warehouse before it goes live: what will block the first uploads, putaway and picking, and what differs from a warehouse that already works.'}]},
  {id: 'putaway', label: 'Putaway', features: [
    {id: 'explain', label: 'Why putaway says no', view: '#v-putaway',
      lede: 'Give a SKU, batch, UOM and quantity. See every bin putaway can use, in the order it would try them, and for every other bin the rule that rejects it.'}]},
  {id: 'health', label: 'Stock health', features: [
    {id: 'stuck', label: 'Stuck stock', view: '#v-stuck',
      lede: 'Stock and pallets the WMS still treats as busy, and the sessions holding up the inventory upload.'}]},
  {id: 'api', label: 'API triggers', features: [
    {id: 'pack-staging', label: 'Pack → staging', view: '#v-pack', title: 'Pack pallet to staging',
      lede: 'Cartons are packed on a pallet at a pack station but no move-to-staging task appears. Check the pallet, then send the event the device’s Move to Next Task would have sent.'}]}],
  // the old one-level #mode links
  legacy: {ready: 'golive/ready', putaway: 'putaway/explain', stuck: 'health/stuck'}});

// ---- readiness ----------------------------------------------------------------------
(async () => {
  try {
    const r = await api('/api/compare/envs');
    $('#r-env').innerHTML = '<option value="">Don’t compare</option>' + r.envs.map(e => `<option ${e === DESK.env ? 'selected' : ''}>${esc(e)}</option>`).join('');
    const last = store.get('ops.ref');
    if (last) { if (last.env !== undefined) $('#r-env').value = last.env; $('#r-wh').value = last.wh || ''; }
  } catch { $('#r-env').innerHTML = '<option value="">Don’t compare</option>'; }
})();
$('#f-ready').onsubmit = async e => {
  e.preventDefault();
  const out = $('#ready-out');
  if (needWh(out)) return;
  const refEnv = $('#r-env').value, refWh = $('#r-wh').value.trim();
  if (refEnv && refWh && !/^\d+$/.test(refWh)) { out.innerHTML = '<div class="alert" role="alert">The reference warehouse id needs to be a number.</div>'; return; }
  store.set('ops.ref', { env: refEnv, wh: refWh });
  try { localStorage.setItem('whId', wh()); } catch {}
  const go = $('#r-go'); go.disabled = true; go.textContent = 'Checking…';
  out.innerHTML = '<div class="loading" style="margin-top:16px">Reading bins, search rules, the SKU and batch masters, stock and sessions…</div>';
  try {
    const qs = new URLSearchParams({ whId: wh(), ...(refEnv && refWh ? { refEnv, refWh } : {}) });
    out.innerHTML = readyHtml(await api('/api/ops/ready?' + qs));
  } catch (err) { out.innerHTML = `<div class="alert" role="alert">${esc(err.message)}</div>`; }
  go.disabled = false; go.textContent = 'Run readiness check';
};
function readyHtml(r) {
  const word = { red: 'Not ready', yellow: 'Ready, with warnings', green: 'Ready' }[r.verdict];
  const n = { fail: 0, warn: 0 }; r.items.forEach(i => { if (n[i.level] !== undefined) n[i.level]++; });
  const secs = [...new Set(r.items.map(i => i.section))];
  // first dozen as chips; the rest behind "Show all", and the whole list one click from the clipboard
  const SHOW = 12;
  const chips = list => `<ul class="sample">${list.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
  const samples = (i, k) => !i.sample.length || i.level === 'pass' ? '' : `<ul class="sample">${i.sample.map((s, j) => `<li${j >= SHOW ? ' class="extra" hidden' : ''}>${esc(s)}</li>`).join('')}</ul>
      <div class="sample-tools">${i.sample.length > SHOW ? `<button type="button" class="link" data-more="${i.sample.length - SHOW}" aria-expanded="false">Show ${fmt(i.sample.length - SHOW)} more</button>` : ''}
        <button type="button" class="link" data-copy="${k}">Copy ${i.count > i.sample.length ? `these ${fmt(i.sample.length)}` : 'list'}</button>${i.count > i.sample.length ? `<span>${fmt(i.count - i.sample.length)} more not listed</span>` : ''}</div>`;
  const li = (i, k) => `<li class="${i.level}"><span class="mark">${i.level === 'fail' || i.level === 'warn' ? '!' : i.level === 'pass' ? '✓' : 'i'}</span><div>${esc(i.title)}${i.count ? ` <b>(${fmt(i.count)})</b>` : ''}
      ${i.detail && i.level !== 'pass' ? `<small>${esc(i.detail)}</small>` : ''}${samples(i, k)}</div></li>`;
  READY_ITEMS = r.items;
  return `<div class="panel" style="margin-top:16px">
    <div class="panel-sec"><div class="verdict-big"><span class="light ${r.verdict}"></span><h3 style="margin:0">${word}</h3>
      ${n.fail ? `<span class="pill bad">${n.fail} blocking</span>` : ''}${n.warn ? ` <span class="pill warn">${n.warn} warning${n.warn > 1 ? 's' : ''}</span>` : ''}
      <span class="hint" style="margin:0">Warehouse ${esc(r.whId)}, principal ${esc(r.principal)}, read ${esc(new Date(r.loadedAt).toLocaleTimeString())}</span></div>
      ${r.fixToken || r.cmp ? `<div class="download" style="margin-top:14px">
        ${r.fixToken ? `<a class="btn" href="/api/masters/fixes?token=${encodeURIComponent(r.fixToken)}">Download batch fix sheet (${fmt(r.fixRows)} rows)</a>` : ''}
        ${r.cmp ? `<a class="btn" href="/compare">Open Compare nodes</a>` : ''}
        <p>The fix sheet is an AddBatchTemplate: family batches copied across and case configs corrected. Check it in Check masters before uploading.</p></div>` : ''}
    </div>
    ${secs.map(s => `<div class="panel-sec"><h4 class="sec-h">${esc(s)}</h4><ul class="checklist">${r.items.map((i, k) => i.section === s ? li(i, k) : '').join('')}</ul></div>`).join('')}
  </div>`;
}
let READY_ITEMS = [];
$('#ready-out').addEventListener('click', async e => {
  const m = e.target.closest('[data-more]');
  if (m) { const open = m.getAttribute('aria-expanded') !== 'true';
    m.closest('li').querySelectorAll('.sample li.extra').forEach(li => { li.hidden = !open; });
    m.setAttribute('aria-expanded', String(open)); m.textContent = open ? 'Show fewer' : `Show ${fmt(m.dataset.more)} more`; return; }
  const b = e.target.closest('[data-copy]');
  if (!b) return;
  const list = READY_ITEMS[Number(b.dataset.copy)]?.sample || [];
  const label = b.dataset.label || (b.dataset.label = b.textContent);
  try { await navigator.clipboard.writeText(list.join('\n')); b.textContent = `Copied ${list.length}`; }
  catch { b.textContent = 'Copy failed'; }
  setTimeout(() => { b.textContent = label; }, 1600);
});

// ---- putaway explainer ------------------------------------------------------------------
{
  const last = store.get('ops.put');
  if (last) { $('#p-sku').value = last.sku || ''; $('#p-batch').value = last.batch || ''; $('#p-uom').value = last.uom || 'L2'; $('#p-qty').value = last.qty || 1;
    $('#p-bucket').value = last.bucket || 'Good'; (last.mode === 'loose' ? $('#p-loose') : $('#p-pal')).checked = true; }
}
$('#f-put').onsubmit = async e => {
  e.preventDefault();
  const out = $('#put-out');
  if (needWh(out)) return;
  const o = { sku: $('#p-sku').value.trim(), batch: $('#p-batch').value.trim(), uom: $('#p-uom').value, qty: Number($('#p-qty').value) || 0,
    bucket: $('#p-bucket').value, mode: document.querySelector('input[name=p-mode]:checked').value };
  if (!o.sku) { $('#p-sku').focus(); return; }
  store.set('ops.put', o);
  const go = $('#p-go'); go.disabled = true; go.textContent = 'Working…';
  out.innerHTML = '<div class="loading" style="margin-top:16px">Walking every bin through the putaway rules…</div>';
  try { out.innerHTML = putHtml(await api('/api/ops/explain?' + new URLSearchParams({ whId: wh() }), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(o) })); }
  catch (err) { out.innerHTML = `<div class="alert" role="alert">${esc(err.message)}</div>`; }
  go.disabled = false; go.textContent = 'Explain';
};
function putHtml(r) {
  const s = r.sku;
  const rows = r.eligible.map((b, i) => `<tr><td class="num">${i + 1}</td><td class="bin">${esc(b.bin)}</td><td>${esc(b.zone)}</td><td>${esc(b.area)} <small class="hint">${esc(b.areaType)}</small></td><td>${esc(b.binType)}</td><td class="num">${esc(b.seq.join(' / '))}</td><td>${esc(b.room || '')}${b.partial ? ' <span class="pill warn">not all of it</span>' : ''}</td></tr>`).join('');
  return `<div class="panel" style="margin-top:16px">
    <div class="panel-sec">
      <div class="kv"><span class="rl sm">${esc(s.code)}</span><span>Class <b>${esc(s.clazz || 'none')}</b></span><span>L0inL2 <b>${esc(s.L0inL2 ?? '–')}</b></span><span>L2inL3 <b>${esc(s.L2inL3 ?? '–')}</b></span>
        ${r.batch ? `<span>Batch <span class="rl sm">${esc(r.batch.code)}</span> expires ${esc(r.batch.exp)}</span>` : ''}<span>Searches with <b>${esc(Object.entries(r.query).map(([k, v]) => `${k} ${v}`).join(', '))}</b></span></div>
      ${r.notes.map(n => `<div class="callout warn" style="margin-top:12px">${esc(n)}</div>`).join('')}
      <dl class="stats" style="margin-top:18px"><div><dt>Bins checked</dt><dd>${fmt(r.bins)}</dd></div><div><dt>Putaway can use</dt><dd>${fmt(r.eligibleCount)}</dd></div>
        ${r.storageEligible !== r.eligibleCount ? `<div><dt>In storage areas</dt><dd>${fmt(r.storageEligible)}</dd></div>` : ''}</dl>
    </div>
    <div class="panel-sec"><h3>Bins putaway can use<small>in the order it tries them: area, then zone search sequence, then putaway position${r.eligibleCount > r.eligible.length ? `; first ${r.eligible.length}` : ''}</small></h3>
      ${rows ? `<div class="table-wrap"><table><thead><tr><th class="num">#</th><th>Bin</th><th>Zone</th><th>Area</th><th>Bin type</th><th class="num">Sequence</th><th>Room</th></tr></thead><tbody>${rows}</tbody></table></div>`
        : '<div class="alert" style="margin:0">No bin in this warehouse takes it. The reasons are below.</div>'}</div>
    <div class="panel-sec"><h3>Why the other bins say no<small>first rule each bin fails, in the order putaway checks them</small></h3>
      ${r.rejected.map(g => { const one = g.whys.length === 1 && g.whys[0].n === g.count;
        return `<div class="rule-group"><h4><span class="n">${fmt(g.count)}</span><span>${esc(g.rule)}${one ? `<span class="why">${esc(g.whys[0].why)}</span>` : ''}</span></h4>
        ${one ? '' : `<ul>${g.whys.map(w => `<li>${fmt(w.n)} × ${esc(w.why)}</li>`).join('')}</ul>`}
        <ul class="sample bins">${g.examples.map(x => `<li title="${esc(x.why)}"><span class="rl sm">${esc(x.bin)}</span></li>`).join('')}</ul></div>`; }).join('') || '<p class="none-msg">Every bin takes it.</p>'}</div>
  </div>`;
}

// ---- stuck stock ------------------------------------------------------------------------
$('#stuck-out').addEventListener('click', e => {
  const a = e.target.closest('[data-jump]'); if (!a) return;
  e.preventDefault(); document.getElementById(a.dataset.jump)?.scrollIntoView({block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
});
$('#s-go').onclick = async () => {
  const out = $('#stuck-out');
  if (needWh(out)) return;
  const go = $('#s-go'); go.disabled = true; go.textContent = 'Looking…';
  out.innerHTML = '<div class="loading" style="margin-top:16px">Reading locks, pallets, bins and sessions…</div>';
  try { out.innerHTML = stuckHtml(await api('/api/ops/stuck?' + new URLSearchParams({ whId: wh() }))); }
  catch (err) { out.innerHTML = `<div class="alert" role="alert">${esc(err.message)}</div>`; }
  go.disabled = false; go.textContent = 'Find stuck stock';
};
function table(cols, rows, empty) {
  if (!rows.length) return `<p class="none-msg">${esc(empty)}</p>`;
  return `<div class="table-wrap"><table><thead><tr>${cols.map(([h, , c]) => `<th class="${c || ''}">${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(r =>
    `<tr>${cols.map(([, f, c]) => { const v = typeof f === 'function' ? f(r) : r[f]; const none = v === null || v === undefined || v === '';
      return `<td class="${c || ''}${none ? ' none' : ''}">${none ? '—' : esc(v)}</td>`; }).join('')}</tr>`).join('')}</tbody></table></div>`;
}
function stuckHtml(r) {
  const blocking = r.sessions.filter(s => s.blocksUpload);
  const empty = [];
  const sec = (title, n, body, note, id, short) => { if (!n) { empty.push(short); return ''; }
    return `<div class="panel-sec" id="${id}"><h3>${esc(title)}<small>${fmt(n)} found</small></h3>${note ? `<p class="hint" style="margin:0 0 10px">${esc(note)}</p>` : ''}${body}</div>`; };
  const count = (label, n, id, hot) => n ? `<div class="${hot ? 'hot' : ''}"><dt>${esc(label)}</dt><dd><a href="#${id}" data-jump="${id}" aria-label="${esc(label)}: ${fmt(n)}">${fmt(n)}</a></dd></div>`
    : `<div class="zero"><dt>${esc(label)}</dt><dd>0</dd></div>`;
  return `<div class="panel" style="margin-top:16px">
    <div class="panel-sec" style="padding:14px 12px"><dl class="counts">
      ${count('Blocking sessions', blocking.length, 'st-sessions', true)}${count('Locked stock lines', r.lockedQuants.length, 'st-quants')}
      ${count('Locked pallets', r.lockedHUs.length, 'st-hus')}${count('Empty pallets', r.emptyPallets.length, 'st-empty')}
      ${count('In inactive bins', r.inactiveBins.length, 'st-inactive')}${count('Negative', r.negative.length, 'st-negative', true)}</dl>
      ${r.errors.length ? `<div class="callout warn" style="margin-top:12px">Some lists couldn't be read on this schema: ${esc(r.errors.join('; '))}</div>` : ''}</div>
    ${sec('Open sessions', r.sessions.length, table([['Kind', 'kind'], ['Code', 'code', 'code'], ['State', 'state'], ['Open for', s => ago(s.hours)], ['Blocks the inventory upload', s => s.blocksUpload ? 'Yes' : 'No']], r.sessions, 'No open sessions.'),
      'Append/Reset refuses to run while an inbound, outbound or similar session is open. Close or complete these first.', 'st-sessions', 'open sessions')}
    ${sec('Stock locked by a finished or missing task', r.lockedQuants.length, table([['Bin', 'bin', 'bin'], ['Pallet', 'hu', 'code'], ['SKU', 'sku', 'sku'], ['Batch', 'batch', 'code'], ['Qty', x => fmt(x.qty), 'num'], ['UOM', 'uom'], ['Lock', 'mode'], ['Task', x => [x.kind, x.task_code].filter(Boolean).join(' ') || x.task], ['Why stuck', 'why'], ['Since', x => ago(x.hours)]], r.lockedQuants, 'Nothing locked by a dead task.'),
      'Picking and putaway skip locked stock. The lock should have cleared when the task ended.', 'st-quants', 'locked stock')}
    ${sec('Pallets locked by a finished or missing task', r.lockedHUs.length, table([['Bin', 'bin', 'bin'], ['Pallet', 'hu', 'code'], ['Task', x => [x.kind, x.task_code].filter(Boolean).join(' ') || x.task], ['Why stuck', 'why'], ['Since', x => ago(x.hours)]], r.lockedHUs, 'No pallet locked by a dead task.'), '', 'st-hus', 'locked pallets')}
    ${sec('Empty pallets in bins', r.emptyPallets.length, table([['Bin', 'bin', 'bin'], ['Pallet', 'hu', 'code'], ['Empty for', x => ago(x.hours)]], r.emptyPallets, 'No empty pallets.'),
      'Each one takes a pallet position, so the bin looks full to putaway.', 'st-empty', 'empty pallets')}
    ${sec('Stock in inactive bins, zones or areas', r.inactiveBins.length, table([['Bin', 'bin', 'bin'], ['Why', 'why'], ['SKU', 'sku', 'sku'], ['Batch', 'batch', 'code'], ['Qty', x => fmt(x.qty), 'num'], ['UOM', 'uom']], r.inactiveBins, 'None.'),
      'Picking can’t reach stock in a bin that isn’t ACTIVE.', 'st-inactive', 'inactive bins')}
    ${sec('Negative quantities', r.negative.length, table([['Bin', 'bin', 'bin'], ['Pallet', 'hu', 'code'], ['SKU', 'sku', 'sku'], ['Batch', 'batch', 'code'], ['Qty', x => fmt(x.qty), 'num'], ['UOM', 'uom']], r.negative, ''), '', 'st-negative', 'negative stock')}
    ${empty.length ? `<div class="panel-sec"><p class="clear-list">Nothing found: ${empty.map(x => `<b>${esc(x)}</b>`).join(' · ')}</p></div>` : ''}
  </div>`;
}

// ---- API triggers: pack pallet -> staging (lib/ops/pack-staging.js) ----------------------------
{
  const last = store.get('ops.pack');
  if (last) { $('#k-task').value = last.task || ''; $('#k-pallet').value = last.pallet || ''; }
}
let PACK = null;   // the last check: the send button's label comes from it
async function packCheck(note = '') {
  const out = $('#pack-out');
  if (needWh(out)) return;
  const task = $('#k-task').value.trim(), pallet = $('#k-pallet').value.trim();
  if (!task) { $('#k-task').focus(); return; }
  if (!pallet) { $('#k-pallet').focus(); return; }
  store.set('ops.pack', { task, pallet });
  const go = $('#k-go'); go.disabled = true; go.textContent = 'Checking…';
  out.innerHTML = '<div class="loading" style="margin-top:16px">Reading the task, the pallet and its cartons…</div>';
  try { PACK = await api('/api/ops/pack-staging?' + new URLSearchParams({ whId: wh(), task, pallet })); out.innerHTML = packHtml(PACK, note); }
  catch (err) { out.innerHTML = `<div class="alert" role="alert">${esc(err.message)}</div>`; }
  go.disabled = false; go.textContent = 'Check pallet';
}
$('#f-pack').onsubmit = e => { e.preventDefault(); packCheck(); };

const cmdBlock = (label, key, text) => `<div class="cmd"><div class="cmd-head"><span>${esc(label)}</span>
  <button type="button" class="btn small" data-pcopy="${key}">Copy</button></div><pre id="pc-${key}">${esc(text)}</pre></div>`;
function packCommands(r) {
  const url = `${r.outbox}/outbox/event-bus/publish/${r.event}`, body = JSON.stringify(r.payload);
  return {
    event: r.event,
    body: JSON.stringify(r.payload, null, 2),
    curl: `curl -X POST '${url}' \\\n  -H 'Content-Type: application/json' \\\n  -d '${body}'`,
    // Windows PowerShell 5.1 strips the quotes inside a JSON argument to curl.exe; Invoke-RestMethod doesn't
    ps: `Invoke-RestMethod -Method Post -Uri "${url}" -ContentType "application/json" -Body '${body}'`,
  };
}
function packHtml(r, note) {
  const t = r.task, p = r.pallet;
  const nFail = r.items.filter(i => i.level === 'fail').length, nWarn = r.items.filter(i => i.level === 'warn').length;
  const li = i => `<li class="${i.level}"><span class="mark">${i.level === 'pass' ? '✓' : '!'}</span><div>${esc(i.title)}${i.detail && i.level !== 'pass' ? `<small>${esc(i.detail)}</small>` : ''}</div></li>`;
  const where = c => c.onPallet ? 'this pallet' : c.nowOn ? `${c.nowOn}${c.nowIn ? ' in ' + c.nowIn : ''}` : '';
  const cartons = table([['Carton', 'carton', 'code'], ['Packed by', 'task', 'code'], ['Packed', c => !c.thisTask ? '' : c.packed ? 'Yes' : 'No'],
    ['Staging row', c => c.staging ? c.staging : c.thisTask && c.packed ? 'None yet' : ''], ['Now on', where], ['Invoice', 'invoice', 'code'], ['GIN', c => c.gin || (c.invoice ? 'NO GIN' : '')]],
    r.cartons, `Nothing was packed onto ${p.code} in session ${t.session}.`);
  const others = r.onPallet.filter(c => c.session !== t.session || (c.task || '').toUpperCase() !== t.code.toUpperCase());
  const C = r.outbox ? packCommands(r) : null;
  let sendSec;
  if (!r.ready) sendSec = `<p class="none-msg">Nothing to send: the event would answer 200 OK and then do nothing. Fix what’s marked above, or check again later.</p>`;
  else if (!C) sendSec = `<div class="alert" style="margin:0">No wms-outbox address for ${esc(r.env)}. Add "outbox" to its entry in config/envs.json.</div>`;
  else if (r.readOnly) sendSec = `<p class="ro-note">Read-only: this app never writes to ${esc(r.env)}. Send it yourself, once, from the office network or VPN. No login token is needed.</p>
    <div class="send-opts">
      <div><h4 class="sec-h" style="margin:16px 0 0">Option A · Swagger</h4><ol>
        <li>Open <a href="${esc(r.outbox)}/docs" target="_blank" rel="noopener">wms-outbox /docs</a>.</li>
        <li>Under <b>default</b>, expand <b>POST /outbox/event-bus/publish/{event}</b> and click <b>Try it out</b>.</li>
        <li>Set <b>event</b> to the value below. Leave stringPayload and integerPayload empty.</li>
        <li>Replace the request body with the body below, then <b>Execute</b>. Success is <b>200</b> with body <b>OK</b>.</li></ol>
        ${cmdBlock('event', 'event', C.event)}${cmdBlock('Request body', 'body', C.body)}</div>
      <div><h4 class="sec-h" style="margin:16px 0 0">Option B · terminal</h4>
        <p class="hint" style="margin:8px 0 0">Prints <b>OK</b> on success. A 400 means the body was changed; a timeout means you’re off the VPN.</p>
        ${cmdBlock('Git Bash, macOS, Linux', 'curl', C.curl)}${cmdBlock('Windows PowerShell', 'ps', C.ps)}</div>
    </div>`;
  else sendSec = `<div class="send-row"><button type="button" class="btn primary big" id="k-send">Send ${esc(r.event)}</button>
      <small>Posts {taskId, huId} to ${esc(r.outbox.replace(/^https?:\/\//, ''))}/outbox/event-bus/publish/${esc(r.event)}, then checks again.</small></div>
    <details><summary>Or send it yourself</summary>${cmdBlock('Request body', 'body', C.body)}${cmdBlock('curl', 'curl', C.curl)}${cmdBlock('Windows PowerShell', 'ps', C.ps)}</details>`;
  return `<div class="panel" style="margin-top:16px">
    <div class="panel-sec">
      <div class="verdict-big"><span class="light ${r.ready ? (nWarn ? 'yellow' : 'green') : 'red'}"></span>
        <h3>${r.ready ? 'Ready to send' : 'Don’t send: the event would do nothing'}</h3>
        ${nFail ? `<span class="pill bad">${nFail} blocking</span>` : ''}${nWarn ? ` <span class="pill warn">${nWarn} warning${nWarn > 1 ? 's' : ''}</span>` : ''}
        <span class="hint">Read ${esc(new Date(r.checkedAt).toLocaleTimeString())}</span></div>
      ${note}
      <div class="kv" style="margin-top:14px"><span>Task <span class="rl sm">${esc(t.code)}</span></span><span>Session <b>${esc(t.session)}</b></span>
        <span>Pallet <span class="rl sm">${esc(p.code)}</span></span><span>In <b>${esc(p.bin || 'no bin')}</b></span><span>Pick strategy <b>${esc(t.pickStrat || 'not set')}</b></span></div>
    </div>
    <div class="panel-sec"><ul class="checklist">${r.items.map(li).join('')}</ul></div>
    <div class="panel-sec"><h3>Cartons packed onto ${esc(p.code)} in ${esc(t.session)}<small>${fmt(r.counts.toStage)} waiting for staging, ${fmt(r.counts.staged)} staged</small></h3>${cartons}
      ${others.length ? `<p class="hint">On the pallet now, packed by another task: ${others.map(c => `${esc(c.carton)} (${esc(c.task || 'unknown')})`).join(', ')}.</p>` : ''}
      ${r.stagingTasks.length ? `<p class="hint">Open staging tasks in ${esc(t.session)}: ${r.stagingTasks.map(x => `<b>${esc(x.code)}</b> ${esc(x.state)}`).join(', ')}. A worker moves the cartons from there to a STG-01-nn bin.</p>` : ''}</div>
    <div class="panel-sec"><h3>Send it<small>once per pallet; a repeat finds everything staged and does nothing</small></h3>${sendSec}
      <div id="k-res"></div></div>
    <div class="panel-sec"><h3>After sending</h3>
      <div class="send-row"><button type="button" class="btn" id="k-again">Check again</button>
        <small>Within a few seconds the cartons get staging rows. A staging task shows up once a staging worker is assigned, which can take minutes.</small></div>
      <ul class="side-notes" style="margin-top:14px">
        <li>The trigger doesn’t close the worker’s open pallet. It can’t go on another pack task until that worker presses Move to Next Task or the pack task completes.</li>
        <li>If the GIN was already SENT or ACKED, the cartons move but the ERP doesn’t change. Report them to ops.</li></ul></div>
  </div>`;
}
$('#pack-out').addEventListener('click', async e => {
  const c = e.target.closest('[data-pcopy]');
  if (c) {
    const text = $('#pc-' + c.dataset.pcopy)?.textContent || '';
    try { await navigator.clipboard.writeText(text); c.textContent = 'Copied'; } catch { c.textContent = 'Copy failed'; }
    setTimeout(() => { c.textContent = 'Copy'; }, 1500);
    return;
  }
  if (e.target.closest('#k-again')) return packCheck();
  const b = e.target.closest('#k-send');
  if (!b) return;
  b.disabled = true; b.textContent = 'Sending…';
  try {
    const r = await api('/api/ops/pack-staging/send?' + new URLSearchParams({ whId: wh() }), { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ task: $('#k-task').value.trim(), pallet: $('#k-pallet').value.trim() }) });
    const a = r.after;
    const note = r.sent
      ? `<div class="callout${a.counts.toStage ? ' warn' : ''}" style="margin-top:14px">Sent: wms-outbox answered ${esc(r.status)} ${esc(r.body)}. ${a.counts.toStage
          ? `${fmt(a.counts.toStage)} carton(s) still have no staging row. The queue may be slow: check again in a minute.` : `All ${fmt(a.counts.staged)} carton(s) now have staging rows.`}</div>`
      : `<div class="alert" role="alert">${r.reason ? esc(r.reason) : `Not sent: wms-outbox answered ${esc(r.status)} ${esc(r.body)}`}</div>`;
    PACK = a; $('#pack-out').innerHTML = packHtml(a, note);
  } catch (err) {
    $('#k-res').innerHTML = `<div class="alert" role="alert">${esc(err.message)}</div>`;
    b.disabled = false; b.textContent = 'Send ' + PACK.event;
  }
});
