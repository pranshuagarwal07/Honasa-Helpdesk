// Compare nodes: two warehouses' config side by side, section by section.
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = { get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} } };
try { $('#wh').value = localStorage.getItem('whId') || DESK.wh; } catch { $('#wh').value = DESK.wh; }
$('#wh').addEventListener('change', () => { try { localStorage.setItem('whId', $('#wh').value.trim()); } catch {} });

const S = { envs: [], sections: [], wh: { a: [], b: [] }, result: null, filt: { D: true, A: true, B: true, q: '' } };

async function api(path, opts) {
  const r = await fetch(path, opts);
  const body = await r.json().catch(() => ({ error: 'The server sent back something that is not JSON.' }));
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

// ---- form ------------------------------------------------------------------------
async function init() {
  let meta;
  try { meta = await api('/api/compare/envs'); }
  catch (e) { $('#out').innerHTML = `<div class="alert" role="alert">Couldn't load the environment list: ${esc(e.message)}. Restart the app with ${DESK.runBat}.</div>`; return; }
  S.envs = meta.envs; S.sections = meta.sections;
  if (!S.envs.length) { $('#out').innerHTML = '<div class="alert" role="alert">No environments set up. Add them to config/envs.json, then reload.</div>'; return; }
  const last = store.get('cmp:last') || {};
  for (const side of ['a', 'b']) {
    const sel = $('#' + side + '-env');
    sel.innerHTML = S.envs.map((e) => `<option>${esc(e)}</option>`).join('');
    const want = last[side]?.env || (side === 'a' ? DESK.env : S.envs.find((e) => e !== DESK.env) || S.envs[0]);
    if (S.envs.includes(want)) sel.value = want;
    $('#' + side + '-wh').value = last[side]?.whId || (side === 'a' ? $('#wh').value : '');
    sel.addEventListener('change', () => loadWarehouses(side));
    $('#' + side + '-wh').addEventListener('input', () => who(side));
  }
  const on = new Set(last.sections || S.sections.filter((s) => s.on).map((s) => s.id));
  $('#sections').innerHTML = S.sections.map((s) => `<span class="chip"><input type="checkbox" id="s-${s.id}" value="${s.id}" ${on.has(s.id) ? 'checked' : ''}><label for="s-${s.id}">${esc(s.name)}</label></span>`).join('');
  document.querySelectorAll('[data-all]').forEach((b) => b.onclick = () => document.querySelectorAll('#sections input').forEach((i) => { i.checked = b.dataset.all === '1'; }));
  $('#o-inactive').checked = !!last.inactive;
  $('#o-bins').checked = !!last.binRows;
  loadWarehouses('a'); loadWarehouses('b');
}

async function loadWarehouses(side) {
  const env = $('#' + side + '-env').value;
  $('#' + side + '-who').textContent = 'Loading warehouses…';
  try {
    const r = await api('/api/compare/warehouses?env=' + encodeURIComponent(env));
    S.wh[side] = r.warehouses;
    $('#' + side + '-list').innerHTML = r.warehouses.map((w) => `<option value="${esc(w.id)}">${esc([w.name, w.code].filter(Boolean).join(' · '))}</option>`).join('');
    who(side, r.err ? `Couldn't list warehouses: ${r.err}` : null);
  } catch (e) {
    S.wh[side] = [];
    who(side, e.message);
  }
}

function who(side, err) {
  const el = $('#' + side + '-who'), id = $('#' + side + '-wh').value.trim();
  el.classList.toggle('err', !!err);
  if (err) { el.textContent = err; return; }
  const w = S.wh[side].find((x) => x.id === id);
  if (w) el.innerHTML = `<b>${esc(w.name || w.code || 'Unnamed')}</b>${w.code && w.name ? ' · ' + esc(w.code) : ''}`;
  else if (id && !/^\d+$/.test(id)) el.textContent = 'A warehouse id is all digits.';
  else if (id && S.wh[side].length) el.textContent = `Not in this environment's warehouse list.`;
  else el.textContent = S.wh[side].length ? `${S.wh[side].length} warehouse${S.wh[side].length === 1 ? '' : 's'} in this environment.` : '';
}

$('#swap').onclick = () => {
  for (const f of ['env', 'wh']) { const a = $('#a-' + f).value; $('#a-' + f).value = $('#b-' + f).value; $('#b-' + f).value = a; }
  [S.wh.a, S.wh.b] = [S.wh.b, S.wh.a];
  const la = $('#a-list').innerHTML; $('#a-list').innerHTML = $('#b-list').innerHTML; $('#b-list').innerHTML = la;
  who('a'); who('b');
};

$('#cmp-form').onsubmit = async (ev) => {
  ev.preventDefault();
  const body = {
    a: { env: $('#a-env').value, whId: $('#a-wh').value.trim() },
    b: { env: $('#b-env').value, whId: $('#b-wh').value.trim() },
    sections: [...document.querySelectorAll('#sections input:checked')].map((i) => i.value),
    inactive: $('#o-inactive').checked, binRows: $('#o-bins').checked,
  };
  for (const s of ['a', 'b']) {
    if (!/^\d+$/.test(body[s].whId)) { $('#run-msg').textContent = `Node ${s.toUpperCase()} needs a warehouse id.`; $('#' + s + '-wh').focus(); return; }
  }
  if (!body.sections.length) { $('#run-msg').textContent = 'Pick at least one thing to compare.'; return; }
  if (body.a.env === body.b.env && body.a.whId === body.b.whId) { $('#run-msg').textContent = 'A and B are the same node.'; return; }
  store.set('cmp:last', body);
  $('#run-msg').textContent = '';
  $('#run').disabled = true;
  const t0 = Date.now();
  $('#out').innerHTML = `<div class="loading" role="status"><span>Reading both nodes… <span id="secs">0</span>s</span></div>`;
  const tick = setInterval(() => { const el = $('#secs'); if (el) el.textContent = Math.round((Date.now() - t0) / 1000); }, 500);
  try {
    S.result = await api('/api/compare/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    render();
  } catch (e) {
    $('#out').innerHTML = `<div class="alert" role="alert">${esc(e.message)}</div>`;
  } finally { clearInterval(tick); $('#run').disabled = false; }
};

// ---- results ---------------------------------------------------------------------
const WORD = { D: 'Different', A: 'Only in A', B: 'Only in B' };
const pills = (x) => [
  x.diff ? `<span class="pill d">${x.diff} different</span>` : '',
  x.onlyA ? `<span class="pill a">${x.onlyA} only in A</span>` : '',
  x.onlyB ? `<span class="pill b">${x.onlyB} only in B</span>` : '',
  `<span class="pill s">${x.same} same</span>`,
].join('');
const nodeLabel = (n) => n.name || `Warehouse ${n.whId}`;

function render() {
  const r = S.result;
  const total = (x) => x.diff + x.onlyA + x.onlyB;
  r.sections.sort((x, y) => (total(y) > 0) - (total(x) > 0));
  const secs = r.sections;
  const max = Math.max(1, ...secs.map((s) => s.same + total(s)));
  const w = (n, all) => `${(100 * n / all).toFixed(2)}%`;
  $('#out').innerHTML = `
    <div class="vs">
      <div class="vs-side"><span class="side">A</span><div><strong>${esc(nodeLabel(r.a))}</strong><span class="meta"><span class="rl sm">${esc(r.a.env)}</span> ${esc(r.a.whId)}</span></div></div>
      <span class="vs-word" aria-hidden="true">vs</span>
      <div class="vs-side"><span class="side b">B</span><div><strong>${esc(nodeLabel(r.b))}</strong><span class="meta"><span class="rl sm">${esc(r.b.env)}</span> ${esc(r.b.whId)}</span></div></div>
      <a class="btn" href="/api/compare/export?token=${encodeURIComponent(r.token)}">Download Excel</a>
    </div>
    <div class="board" role="list">
      <div class="bh"><span>Section</span><span><span class="lg">Different</span><span class="sh" aria-hidden="true">Diff</span></span><span><span class="lg">Only in A</span><span class="sh" aria-hidden="true">A</span></span><span><span class="lg">Only in B</span><span class="sh" aria-hidden="true">B</span></span><span>Same</span><span></span></div>
      ${secs.map((s) => {
        const all = s.same + total(s) || 1;
        return `<a href="#sec-${s.id}" role="listitem" data-open="${s.id}">
          <span class="nm">${esc(s.name)}${total(s) ? '' : ' <span class="clean">· all match</span>'}</span>
          <span class="n ${s.diff ? '' : 'zero'}" title="Different">${s.diff}</span>
          <span class="n ${s.onlyA ? '' : 'zero'}" title="Only in A">${s.onlyA}</span>
          <span class="n ${s.onlyB ? '' : 'zero'}" title="Only in B">${s.onlyB}</span>
          <span class="n zero" title="Same">${s.same}</span>
          <span class="bar" aria-hidden="true"><i class="d" style="width:${w(s.diff, all)}"></i><i class="a" style="width:${w(s.onlyA, all)}"></i><i class="b" style="width:${w(s.onlyB, all)}"></i><i class="s" style="width:${w(s.same, all)}"></i></span>
        </a>`;
      }).join('')}
    </div>
    <div class="filters">
      <input type="search" id="f-q" placeholder="Filter by table, code, field or value" value="${esc(S.filt.q)}" aria-label="Filter the differences">
      <div class="chips" role="group" aria-label="Show">
        ${['D', 'A', 'B'].map((k) => `<span class="chip ${k.toLowerCase()}"><input type="checkbox" id="f-${k}" ${S.filt[k] ? 'checked' : ''}><label for="f-${k}">${WORD[k]}</label></span>`).join('')}
      </div>
    </div>
    <div id="secs-out"></div>`;
  document.querySelectorAll('.board a').forEach((a) => a.addEventListener('click', () => { const d = document.getElementById('sec-' + a.dataset.open); if (d) d.open = true; }));
  $('#f-q').addEventListener('input', (e) => { S.filt.q = e.target.value; renderSections(); });
  for (const k of ['D', 'A', 'B']) $('#f-' + k).addEventListener('change', (e) => { S.filt[k] = e.target.checked; renderSections(); });
  renderSections();
}

function renderSections() {
  const r = S.result, q = S.filt.q.trim().toLowerCase();
  const la = esc(`A · ${nodeLabel(r.a)}`), lb = esc(`B · ${nodeLabel(r.b)}`);
  const hit = (t, row) => !q || [t.table, row.key, ...row.fields.flat()].some((x) => String(x ?? '').toLowerCase().includes(q));
  const html = [];
  for (const s of r.sections) {
    const tables = s.tables.map((t) => ({ t, rows: t.rows.filter((row) => S.filt[row.s] && hit(t, row)) }));
    const shown = tables.filter((x) => x.rows.length);
    const clean = s.tables.filter((t) => !t.skipped && !(t.diff + t.onlyA + t.onlyB));
    const missing = s.tables.filter((t) => t.skipped);
    const anyDiff = s.diff + s.onlyA + s.onlyB > 0;
    if (q && !shown.length) continue;
    html.push(`<details class="sec" id="sec-${s.id}" ${anyDiff && (shown.length || !q) ? 'open' : ''}>
      <summary><h3>${esc(s.name)}</h3><span class="pills">${pills(s)}</span></summary>
      <div class="sec-body">
        ${shown.map(({ t, rows }) => tableBlock(t, rows, la, lb)).join('') || (anyDiff ? '<p class="none-left">No differences match the filter.</p>' : '<p class="none-left">Everything in this section matches.</p>')}
        ${clean.length ? `<p class="matching">Matching: ${clean.map((t) => `<code>${esc(t.table)}</code> (${t.same})`).join(', ')}</p>` : ''}
        ${clean.filter((t) => t.notes.length).map((t) => `<ul class="tnotes">${t.notes.map((n) => `<li><code>${esc(t.table)}</code>: ${esc(n)}</li>`).join('')}</ul>`).join('')}
        ${missing.length ? `<p class="matching">Not in either schema: ${missing.map((t) => `<code>${esc(t.table)}</code>`).join(', ')}</p>` : ''}
      </div>
    </details>`);
  }
  $('#secs-out').innerHTML = html.join('') || '<p class="none-left">Nothing matches the filter.</p>';
}

function tableBlock(t, rows, la, lb) {
  const body = rows.map((row) => {
    const cls = row.s.toLowerCase();
    const src = row.src || [];
    const srcNote = (i) => (src[i] ? `<small>set on ${esc(src[i])}</small>` : '');
    if (row.s === 'D') {
      return row.fields.map((f, i) => `<tr class="d">
        ${i === 0 ? `<td class="k" rowspan="${row.fields.length}">${esc(row.key)}<small>${WORD.D}</small></td>` : ''}
        <td class="f">${esc(f[0])}</td>
        <td class="v va${f[1] === '' ? ' none' : ''}" data-side="A">${f[1] === '' ? 'not set' : esc(f[1])}${srcNote(0)}</td>
        <td class="v vb${f[2] === '' ? ' none' : ''}" data-side="B">${f[2] === '' ? 'not set' : esc(f[2])}${srcNote(1)}</td></tr>`).join('');
    }
    // a row on one side only: one line, full contents folded away
    const list = `<dl>${row.fields.map((f) => `<dt>${esc(f[0])}</dt><dd>${esc(f[1])}</dd>`).join('')}</dl>`;
    const one = row.fields.length === 1
      ? `${esc(row.fields[0][1])}${srcNote(row.s === 'A' ? 0 : 1)}`
      : row.fields.length <= 5 ? list : `<details><summary>${row.fields.length} fields</summary>${list}</details>`;
    const field = row.fields.length === 1 ? esc(row.fields[0][0]) : 'whole row';
    const missing = `<td class="v none" data-side="${row.s === 'A' ? 'B' : 'A'}">missing</td>`;
    const present = `<td class="v" data-side="${row.s}">${one}</td>`;
    return `<tr class="${cls}"><td class="k">${esc(row.key)}<small>${WORD[row.s]}</small></td><td class="f">${field}</td>${row.s === 'A' ? present + missing : missing + present}</tr>`;
  }).join('');
  return `<section class="tbl">
    <div class="tbl-head"><code>${esc(t.table)}</code><span class="pills">${pills(t)}</span></div>
    ${t.notes.length ? `<ul class="tnotes">${t.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}
    <table class="dt">
      <colgroup><col style="width:24%"><col style="width:16%"><col style="width:30%"><col style="width:30%"></colgroup>
      <thead><tr><th>${t.summary ? 'Zone · bin type · status' : 'Row'}</th><th>Field</th><th class="ha">${la}</th><th class="hb">${lb}</th></tr></thead>
      <tbody>${body}</tbody>
    </table>
  </section>`;
}

init();
