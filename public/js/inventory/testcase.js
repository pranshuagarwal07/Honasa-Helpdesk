// ================= test case builder =================
// Rows are edited here; bins, SKUs and batches come from the live catalog, and the
// server runs the same checks as the uploader on every change.
const TC = { cat: null, rows: [], last: null, vtimer: null, preset: null, verifyRows: null };
const EXEMPT = new Set(['PICK_AND_DROP', 'STAGING', 'REJECT']);
const dmy = k => k ? k.split('-').reverse().join('/') : '';
const daysLeft = k => k ? Math.round((Date.parse(k) - Date.parse(TC.cat.today)) / 86400000) : null;
const caseOp = () => document.querySelector('input[name=c-op]:checked').value;
const binInfo = code => TC.cat?.binMap.get(code);
const skuInfo = code => TC.cat?.skuMap.get(code);
const uomFor = bin => bin?.huType === 'PALLET' ? 'L2' : 'L0';
const isValidBatch = b => b.active && !b.vendorLot && b.exp > TC.cat.today;
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;

async function loadCatalog(refresh) {
  if (!/^\d+$/.test(wh())) { $('#c-foot').hidden = false; $('#c-foot').innerHTML = '<span class="msg bad">The warehouse id needs to be a number. Fix it under Warehouse id.</span>'; return; }
  $('#c-foot').innerHTML = '<span class="msg">Loading bins, SKUs and batches for this warehouse…</span>';
  try { TC.cat = await api('/api/inv/catalog?' + qs(refresh ? {refresh: '1'} : {})); }
  catch (e) { $('#c-foot').innerHTML = `<span class="msg bad">${esc(e.message)}</span>`; return; }
  const c = TC.cat;
  c.binMap = new Map(c.bins.map(a => [a[0], {code: a[0], zone: a[1], area: a[2], areaType: a[3], binType: a[4], huType: a[5], cap: a[6],
    status: a[7], level: a[8], multiSku: a[9], multiBatch: a[10], id: a[11], zoneId: a[12], areaId: a[13]}]));
  c.binList = [...c.binMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  c.skuMap = new Map(c.skus.map(a => [a[0], {code: a[0], clazz: a[1], active: a[2], base: a[3], L0inL2: a[4], L2inL3: a[5], baseCode: a[6] || a[0]}]));
  c.skuList = [...c.skuMap.values()].sort((a, b) => a.code.localeCompare(b.code));
  c.batchOf = sku => (c.batches[sku] || []).map(a => ({sku, code: a[0], mfg: a[1], exp: a[2], active: a[3], hasProd: a[4], vendorLot: a[5]}));
  c.batchBins = new Map(); // sku|batch -> bins already holding it
  for (const [bin, lines] of Object.entries(c.stock)) for (const [sku, batch] of lines) {
    const k = `${sku}|${batch}`;
    if (!c.batchBins.has(k)) c.batchBins.set(k, new Set());
    c.batchBins.get(k).add(bin);
  }
  c.zones = [...new Set(c.binList.map(b => b.zone).filter(Boolean))].sort();
  const pallets = c.kinds.filter(k => /PALLET/i.test(k));
  $('#c-kind').innerHTML = (pallets.length ? pallets : ['PALLET']).map(k => `<option ${k === 'PALLET' ? 'selected' : ''}>${esc(k)}</option>`).join('');
  $('#c-prefix').value = c.suggestedPrefix;
  restoreDraft();
  fillBinFilter();
  if (TC.preset) openPreset(TC.preset);
  renderGrid();
  scheduleValidate();
}

// search table: lowest sequence allowing this class/uom/bucket in the bin, or null
function allowed(bin, sku, uom, bucket) {
  if (!bin || !sku?.clazz) return null;
  if (EXEMPT.has(bin.areaType)) return 0;
  const s = TC.cat.search[`${String(sku.clazz).toUpperCase()}|${uom}|${String(bucket || 'Good').toUpperCase()}`];
  if (!s) return null;
  const seqs = [s.B?.[bin.id], s.Z?.[bin.zoneId], s.A?.[bin.areaId]].filter(x => x !== undefined);
  return seqs.length ? Math.min(...seqs) : null;
}

// batch list is sorted by expiry, earliest first
function pickBatch(sku, mode = 'longest') {
  const list = TC.cat.batchOf(sku).filter(isValidBatch);
  if (!list.length) return null;
  if (mode === 'shortest') return list[0];
  if (mode === 'near') return list.find(b => daysLeft(b.exp) < Number($('#c-shelf').value || 30)) || list[0];
  return list[list.length - 1];
}
// loose eaches go on the base (un-suffixed) SKU when the case SKU has one
const looseSku = (s, choice = 'base') => (choice === 'base' && s && !s.base && skuInfo(s.baseCode)) || s;
// warn when base-SKU eaches would put a second SKU into a single-SKU bin
function looseHint(bin, sku, where) {
  const el = $('#pf-loose-h'); if (!el || !sku) return;
  const choice = pfVal('pf-loosesku'), l = looseSku(sku, choice);
  const second = l.code !== sku.code && bin?.multiSku === false && Number(pv('pf-loose')) > 0;
  el.textContent = second ? `${bin.code} takes one SKU only, and ${l.code} would be a second. Choose Same SKU, or a multi-SKU bin.`
    : `Added as an L0 line of ${l.code} on the same ${where}.`;
  el.className = 'hintline' + (second ? ' bad' : '');
}
function looseBatch(base, caseBatch) {
  const list = TC.cat.batchOf(base.code);
  return list.find(b => b.code === caseBatch && isValidBatch(b))?.code ?? pickBatch(base.code)?.code;
}
const unitUom = (unit, bin) => unit === 'L0' || unit === 'L2' ? unit : uomFor(bin);
const caseQty = (sku, uom) => uom === 'L2' ? 1 : (sku?.L0inL2 || 1);
const palletQty = (sku, uom) => uom === 'L2' ? Math.max(1, Math.floor(sku?.L2inL3 || 1)) : (sku?.L0inL2 || 1) * Math.max(1, Math.floor(sku?.L2inL3 || 1));

const huPad = (p, n) => p + String(n).padStart(huDigits(p, $('#c-len').value), '0');
function nextHu() {
  const p = $('#c-prefix').value.trim();
  let max = 0;
  for (const r of TC.rows) if (r.hu && r.hu.startsWith(p)) { const n = parseInt(r.hu.slice(p.length), 10); if (n > max) max = n; }
  return huPad(p, max + 1);
}
const caseLenHint = () => huLenHint($('#c-prefix').value, $('#c-len').value, $('#c-len-h'), new Set(TC.rows.map(r => r.hu).filter(Boolean)).size);

function setBatch(r, code) {
  const b = TC.cat.batchOf(r.sku).find(x => x.code === code);
  r.batch = code || '';
  r.mfg = b?.mfg || '';
  r.exp = b?.exp || '';
}
function setBin(r, code) {
  r.bin = code;
  const b = binInfo(code);
  if (!b) return;
  r.uom = uomFor(b);
  if (b.huType === 'PALLET') { if (!r.hu) r.hu = nextHu(); r.hukind = r.hukind || $('#c-kind').value; }
  else { r.hu = ''; r.hukind = ''; }
}
function setSku(r, code) {
  r.sku = code;
  if (!TC.cat.batchOf(code).some(b => b.code === r.batch)) setBatch(r, pickBatch(code)?.code);
}
function addRow(o = {}) {
  const r = {bin: '', sku: '', qty: o.qty ?? '', uom: o.uom || 'L0', batch: '', mfg: '', exp: '', bucket: o.bucket || 'Good',
    inclusion: o.inclusion || 'INCLUDED', hu: '', hukind: ''};
  if (o.bin) setBin(r, o.bin);
  if (o.uom) r.uom = o.uom;
  if (o.hu) { r.hu = o.hu; r.hukind = $('#c-kind').value; }
  TC.rows.push(r);
  if (o.sku) { r.sku = o.sku; setBatch(r, o.batch !== undefined ? o.batch : pickBatch(o.sku, o.batchMode)?.code); }
  return r;
}

// ---- grid ---------------------------------------------------------------------
const COLS = [['#', ''], ['Bin', 'w-bin'], ['SKU', 'w-sku'], ['Qty', 'w-qty'], ['UOM', 'w-uom'], ['Batch', 'w-batch'],
  ['HU code and kind', 'w-hu'], ['Bucket and status', 'w-status'], ['', '']];

function binSub(r) {
  const b = binInfo(r.bin);
  if (!r.bin) return '';
  if (!b) return '<span class="sub bad">Not a bin in this warehouse</span>';
  const stock = TC.cat.stock[r.bin];
  const kind = b.huType === 'PALLET' ? `pallet bin for ${plural(b.cap, 'pallet')}` : `${String(b.huType || '').toLowerCase()} bin`;
  return `<span class="sub">${esc(b.zone)}, ${kind}${b.status !== 'ACTIVE' ? `, ${esc(b.status)}` : ''}, ${stock ? `has ${plural(stock.length, 'stock line')}` : 'empty'}</span>`;
}
function skuSub(r) {
  const s = skuInfo(r.sku), b = binInfo(r.bin);
  if (!r.sku) return '';
  if (!s) return '<span class="sub bad">Not a SKU for this principal</span>';
  const facts = [`class ${s.clazz || 'none'}`, s.L0inL2 ? `case ${s.L0inL2}` : '', s.L2inL3 ? `pallet ${Math.floor(s.L2inL3)} cs` : ''].filter(Boolean).join(', ');
  const no = b && s.clazz && allowed(b, s, r.uom, r.bucket) === null;
  const eachHint = r.uom === 'L0' && !s.base && s.baseCode !== s.code ? `. Eaches are usually on ${s.baseCode}` : '';
  return `<span class="sub ${no ? 'bad' : ''}">${esc(facts)}${no ? '. The search table doesn\'t allow it here' : ''}${esc(eachHint)}</span>`;
}
// short label for the picker; the detail sits underneath so the cell stays readable
const batchLabel = b => `${b.code}${!b.active ? ' (inactive)' : b.vendorLot ? ' (vendor lot)' : daysLeft(b.exp) <= 0 ? ' (expired)' : ''}`;
const batchState = exp => { const d = daysLeft(exp); return d === null ? '' : d <= 0 ? 'bad' : d < Number($('#c-shelf').value || 30) ? 'near' : ''; };
function batchSub(r) {
  if (!r.batch) return '';
  const d = daysLeft(r.exp), st = batchState(r.exp);
  if (!r.exp) return '<span class="bsub"><span class="tag bad">Not in the batch master</span></span>';
  return `<span class="bsub"><span>Made</span><b>${esc(dmy(r.mfg))}</b><span>Expires</span><b>${esc(dmy(r.exp))}</b>
    <span class="tag ${st}">${d <= 0 ? `Expired ${-d} days ago` : `${d} days left`}</span></span>`;
}
// one batch option. The closed picker shows the code and a short expiry line; the open list shows
// days left on the right, made / expires / shelf life left lined up, tags and a shelf-life bar.
function batchOpt(b, selected, {blockVendor, tags = []} = {}) {
  const d = daysLeft(b.exp), st = !b.active || b.vendorLot ? 'bad' : batchState(b.exp);
  const left = d === null ? 'No expiry' : d <= 0 ? `Expired ${fmt(-d)}d ago` : `${fmt(d)} days left`;
  const span = b.mfg && b.exp ? Date.parse(b.exp) - Date.parse(b.mfg) : 0;
  const life = span > 0 && d !== null ? Math.max(0, Math.min(100, Math.round(d * 86400000 / span * 100))) : null;
  const sub = `exp ${dmy(b.exp)}, ${left.toLowerCase()}${b.vendorLot ? ', also a vendor lot' : ''}`;
  const cols = [`Made=${b.mfg ? dmy(b.mfg) : 'unknown'}`, `Expires=${b.exp ? dmy(b.exp) : 'unknown'}`, life !== null ? `Life left=${life}%` : ''].filter(Boolean).join('|');
  const bins = TC.cat.batchBins.get(`${b.sku}|${b.code}`)?.size || 0;
  const allTags = [...tags, !b.active && 'Inactive', b.vendorLot && 'Vendor lot', bins && `In ${plural(bins, 'bin')}`].filter(Boolean);
  return `<option value="${esc(b.code)}" data-sub="${esc(sub)}" data-tone="${st}" data-right="${esc(left)}" data-cols="${esc(cols)}"
    data-tags="${esc(allTags.join('|'))}" ${life !== null ? `data-life="${life}"` : ''} ${blockVendor && b.vendorLot ? 'disabled' : ''} data-main="${esc(b.code)}" ${selected ? 'selected' : ''}>${esc(batchLabel(b))}</option>`;
}
// batches grouped the way a tester picks them, earliest expiry first inside each group
function batchGroups(sku, val, opts = {}) {
  const list = TC.cat.batchOf(sku), near = Number($('#c-shelf').value || 30);
  const valid = list.filter(isValidBatch), first = valid[0]?.code, last = valid.length > 1 ? valid[valid.length - 1].code : null;
  const groups = [['Good to use', []], [`Expiring within ${near} days`, []], ['Expired', []], ['Inactive or vendor lot', []]];
  for (const b of list) {
    const d = daysLeft(b.exp);
    groups[!b.active || b.vendorLot ? 3 : d === null || d <= 0 ? 2 : d < near ? 1 : 0][1].push(b);
  }
  const tagsOf = b => [b.code === first && 'FEFO next', b.code === last && 'Longest life'];
  return groups.filter(([, bs]) => bs.length).map(([label, bs]) => `<optgroup label="${esc(label)}">${bs.map(b => batchOpt(b, b.code === val, {...opts, tags: tagsOf(b)})).join('')}</optgroup>`).join('');
}
function batchOptions(r) {
  const list = TC.cat.batchOf(r.sku);
  const orphan = r.batch && !list.some(b => b.code === r.batch) ? `<option value="${esc(r.batch)}" data-sub="not in the batch master" data-tone="bad" data-right="Not in master" selected>${esc(r.batch)}</option>` : '';
  return `<option value="">${list.length ? 'Pick a batch' : r.sku ? 'No batches' : 'Pick a SKU first'}</option>${batchGroups(r.sku, r.batch)}${orphan}`;
}
const OPT_SUB = {L0: 'eaches', L2: 'cases', L3: 'pallets', Good: 'sellable stock', Damaged: 'damaged bucket',
  INCLUDED: 'counted in stock', 'PRE-GRN': 'received, not yet GRN-ed', 'POST-GIN': 'issued, not yet shipped'};
const sel = (f, val, opts) => `<select data-f="${f}">${opts.map(o => `<option ${o === val ? 'selected' : ''} data-sub="${esc(OPT_SUB[o] || '')}">${esc(o)}</option>`).join('')}</select>`;

function rowHtml(r, i) {
  const kinds = [...new Set([...TC.cat.kinds, r.hukind].filter(Boolean))];
  const noHu = binInfo(r.bin)?.huType === 'BIN' && !r.hu;
  return `<tr data-i="${i}">
    <td class="rn">${i + 2}</td>
    <td><input data-f="bin" class="${binInfo(r.bin) ? 'is-bin' : ''}" list="dl-bins" value="${esc(r.bin)}" spellcheck="false" aria-label="Bin, row ${i + 2}">${binSub(r)}</td>
    <td><input data-f="sku" list="dl-skus" value="${esc(r.sku)}" spellcheck="false" aria-label="SKU, row ${i + 2}">${skuSub(r)}</td>
    <td><input data-f="qty" type="number" min="1" step="1" value="${esc(r.qty)}" aria-label="Quantity, row ${i + 2}"></td>
    <td>${sel('uom', r.uom, ['L0', 'L2', 'L3'])}</td>
    <td><select data-f="batch" data-cb-width="430" aria-label="Batch, row ${i + 2}">${batchOptions(r)}</select>${batchSub(r)}</td>
    <td><div class="stack"><input data-f="hu" value="${esc(r.hu)}" spellcheck="false" ${noHu ? 'disabled placeholder="Shelf bin, no HU"' : ''} aria-label="HU code, row ${i + 2}">
      <select data-f="hukind" ${noHu ? 'disabled' : ''} aria-label="HU kind, row ${i + 2}"><option value=""></option>${kinds.map(k => `<option ${k === r.hukind ? 'selected' : ''}>${esc(k)}</option>`).join('')}</select></div></td>
    <td><div class="stack">${sel('bucket', r.bucket, ['Good', 'Damaged'])}${sel('inclusion', r.inclusion, ['INCLUDED', 'PRE-GRN', 'POST-GIN'])}</div></td>
    <td><button type="button" class="del" title="Remove row ${i + 2}" aria-label="Remove row ${i + 2}">×</button></td></tr>`;
}

function renderGrid() {
  const g = $('#c-grid');
  $('#c-count').textContent = TC.rows.length ? `${TC.rows.length}` : '';
  if (!TC.cat) return;
  caseLenHint();
  if (!TC.rows.length) {
    g.innerHTML = '<tbody><tr><td class="grid-empty" colspan="9">No rows yet. Start from a preset above, add a blank row, or load an existing sheet to edit it. Each row is checked against live master data as you go.</td></tr></tbody>';
    return;
  }
  // keep the caret where it was when checks re-render the grid
  const a = document.activeElement, focus = a?.closest?.('#c-grid tr') ? {i: a.closest('tr').dataset.i, f: a.dataset.f || a.dataset.cbFor} : null;
  g.innerHTML = `<thead><tr>${COLS.map(([h, c]) => `<th class="${c}">${h}</th>`).join('')}</tr></thead><tbody>${TC.rows.map(rowHtml).join('')}</tbody>`;
  applyIssues();
  if (focus) g.querySelector(`tr[data-i="${focus.i}"] [data-f="${focus.f}"]`)?.focus();
}

function applyIssues() {
  const iss = TC.last?.rowIssues || {};
  document.querySelectorAll('#c-grid tr[data-i]').forEach(tr => {
    // a row nobody has started yet isn't painted red; the dock bar still lists what it needs
    const r = TC.rows[Number(tr.dataset.i)];
    const list = r && !r.bin && !r.sku && !r.batch && (r.qty === '' || r.qty == null) ? [] : iss[Number(tr.dataset.i) + 2] || [];
    tr.querySelectorAll('[data-f]').forEach(el => {
      const fields = el.dataset.f === 'batch' ? ['batch', 'mfg', 'exp'] : [el.dataset.f];
      const mine = list.filter(t => fields.includes(t.field));
      el.classList.toggle('c-bad', mine.some(t => t.level === 'fail'));
      el.classList.toggle('c-warn', mine.length > 0 && !mine.some(t => t.level === 'fail'));
      el.title = mine.map(t => t.title).join('\n');
    });
  });
}

function fillList(dl, list, value, label) {
  const v = String(value || '').trim().toUpperCase(), hits = [];
  const text = x => x.zone !== undefined ? `${x.code} ${x.zone || ''} ${x.area || ''}`.toUpperCase() : x.code.toUpperCase();
  for (const x of list) { if (!v || text(x).includes(v)) { hits.push(x); if (hits.length >= 80) break; } }
  $(dl).innerHTML = hits.map(x => `<option value="${esc(x.code)}">${esc(label(x))}</option>`).join('');
}
// area / zone / empty filter from the Bin search bar
function filteredBins() {
  const a = $('#bf-area').value, z = $('#bf-zone').value, empty = $('#bf-empty').checked;
  return TC.cat.binList.filter(b => (!a || b.area === a) && (!z || b.zone === z) && (!empty || !TC.cat.stock[b.code]));
}
function fillBinFilter() {
  const c = TC.cat, a = $('#bf-area').value;
  const areas = [...new Map(c.binList.filter(b => b.area).map(b => [b.area, b.areaType])).entries()].sort((x, y) => x[0].localeCompare(y[0]));
  $('#bf-area').innerHTML = '<option value="">All areas</option>' + areas.map(([code, type]) => `<option value="${esc(code)}" ${code === a ? 'selected' : ''}>${esc(code)} (${esc(String(type || '').toLowerCase())})</option>`).join('');
  const z = $('#bf-zone').value;
  const zones = [...new Set(c.binList.filter(b => b.zone && (!$('#bf-area').value || b.area === $('#bf-area').value)).map(b => b.zone))].sort();
  $('#bf-zone').innerHTML = '<option value="">All zones</option>' + zones.map(code => `<option ${code === z ? 'selected' : ''}>${esc(code)}</option>`).join('');
  const n = filteredBins().length;
  $('#bf-count').textContent = `${n.toLocaleString()} bin${n === 1 ? '' : 's'} match`;
}
$('#bf-area').addEventListener('change', () => { $('#bf-zone').value = ''; fillBinFilter(); if (TC.preset) refreshPreset(TC.preset); });
$('#bf-zone').addEventListener('change', () => { fillBinFilter(); if (TC.preset) refreshPreset(TC.preset); });
$('#bf-empty').addEventListener('change', fillBinFilter);
const binLabel = b => `${b.zone || ''}, ${b.huType || ''}${TC.cat.stock[b.code] ? ', has stock' : ', empty'}`;
const skuLabel = s => `class ${s.clazz || 'none'}${s.active ? '' : ', inactive'}`;
function listFor(el) {
  const k = el.dataset.f || el.dataset.pick;
  if (k === 'bin' || k === 'bin-any') fillList('#dl-bins', filteredBins(), el.value, binLabel);
  else if (k === 'bin-pallet') fillList('#dl-bins', filteredBins().filter(b => b.huType === 'PALLET'), el.value, binLabel);
  else if (k === 'sku') fillList('#dl-skus', TC.cat.skuList.filter(s => s.active), el.value, skuLabel);
}

$('#c-grid').addEventListener('focusin', e => { if (e.target.matches('[data-f=bin],[data-f=sku]')) listFor(e.target); });
$('#c-grid').addEventListener('input', e => { if (e.target.matches('[data-f=bin],[data-f=sku]')) listFor(e.target); });
$('#c-grid').addEventListener('change', e => {
  const tr = e.target.closest('tr[data-i]'); if (!tr) return;
  const r = TC.rows[Number(tr.dataset.i)], f = e.target.dataset.f, v = e.target.value.trim();
  if (f === 'bin') setBin(r, v);
  else if (f === 'sku') setSku(r, v);
  else if (f === 'batch') setBatch(r, v);
  else if (f === 'qty') r.qty = v === '' ? '' : Number(v);
  else r[f] = v;
  renderGrid();
  scheduleValidate();
});
$('#c-grid').addEventListener('click', e => {
  if (!e.target.matches('.del')) return;
  TC.rows.splice(Number(e.target.closest('tr').dataset.i), 1);
  renderGrid(); scheduleValidate();
});

// ---- case bar --------------------------------------------------------------------
$('#c-add').onclick = () => { addRow(); renderGrid(); scheduleValidate(); $('#c-grid tr:last-child [data-f=bin]')?.focus(); };
$('#c-clear').onclick = () => { if (TC.rows.length && confirm(`Remove all ${TC.rows.length} rows?`)) { TC.rows = []; renderGrid(); scheduleValidate(); } };
// renumber pallet HUs, e.g. after a failed upload burned the old codes or the code length changed;
// rows that shared a pallet (loose eaches on top) keep sharing it
function renumberHus() {
  const p = $('#c-prefix').value.trim(), map = new Map(); let n = 0;
  TC.rows.forEach(r => { if (!r.hu) return; if (!map.has(r.hu)) map.set(r.hu, huPad(p, ++n)); r.hu = map.get(r.hu); });
  renderGrid(); scheduleValidate();
}
$('#c-prefix').addEventListener('change', renumberHus);
$('#c-len').addEventListener('change', renumberHus);
$('#c-prefix').addEventListener('input', caseLenHint);
$('#c-len').addEventListener('input', caseLenHint);
$('#c-kind').addEventListener('change', () => { TC.rows.forEach(r => { if (r.hu) r.hukind = $('#c-kind').value; }); renderGrid(); scheduleValidate(); });
document.querySelectorAll('input[name=c-op]').forEach(el => el.addEventListener('change', scheduleValidate));
$('#c-shelf').addEventListener('change', () => { renderGrid(); scheduleValidate(); });
$('#c-name').addEventListener('change', saveDraft);
$('#c-import').onchange = async e => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  try {
    const r = await api('/api/inv/parse?' + qs(), {method: 'POST', body: await f.arrayBuffer()});
    if (TC.rows.length && !confirm(`Replace the ${TC.rows.length} rows in the grid with ${r.rows.length} rows from ${f.name}?`)) return;
    TC.rows = r.rows.map(x => ({bin: x.bin, sku: x.sku, qty: x.qty, uom: x.uom || 'L0', batch: x.batch || '', mfg: x.mfg || '', exp: x.exp || '',
      bucket: x.bucket || 'Good', inclusion: x.inclusion || 'INCLUDED', hu: x.hu || '', hukind: x.hukind || ''}));
    const op = r.rows[0]?.op; if (op) document.getElementById(op === 'RESET' ? 'cop-r' : 'cop-a').checked = true;
    if (!$('#c-name').value) $('#c-name').value = f.name.replace(/\.xlsx$/i, '');
    renderGrid(); scheduleValidate();
  } catch (err) { alert(err.message); }
};

// ---- checks, footer, export --------------------------------------------------------
const payloadRows = () => TC.rows.map(r => ({...r, op: caseOp()}));
function scheduleValidate() { clearTimeout(TC.vtimer); TC.vtimer = setTimeout(validateRows, 400); saveDraft(); renderFoot(true); }
async function validateRows() {
  if (!TC.cat) return;
  if (!TC.rows.length) { TC.last = null; renderFoot(); return; }
  try {
    TC.last = await api('/api/inv/validate-rows?' + qs(), {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({rows: payloadRows(), shelfLifeDays: Number($('#c-shelf').value) || 0})});
  } catch (e) { TC.last = {error: e.message}; }
  applyIssues(); renderFoot();
}

function renderFoot(pending) {
  const f = $('#c-foot'), v = TC.last, n = TC.rows.length;
  if (!TC.cat) return;
  f.hidden = !n;
  if (!n) return;
  if (pending || !v) { const b = $('#c-dl'); if (b) b.disabled = true; return; }
  if (v.error) { f.innerHTML = `<span class="msg bad">${esc(v.error)}</span>`; return; }
  const bad = v.checks.filter(c => c.status === 'fail'), warn = v.checks.filter(c => c.status === 'warn');
  // rows nobody has started yet fail every rule; listing them all buries the real problems
  const unstarted = x => { const r = TC.rows[x - 2]; return !!r && !r.bin && !r.sku && !r.batch && (r.qty === '' || r.qty == null); };
  const fresh = TC.rows.filter((r, i) => unstarted(i + 2)).length;
  const shown = [...bad, ...warn].map(c => ({...c, more: c.count > c.rows.length, after: Math.max(0, ...c.rows), rows: c.rows.filter(x => !unstarted(x))})).filter(c => c.rows.length || c.more);
  const item = c => !c.rows.length ? `<li>${esc(c.title)}: rows after ${c.after}</li>`
    : `<li>${esc(c.title)}: row${c.rows.length > 1 ? 's' : ''} ${c.rows.map(x => `<button type="button" class="link" data-row="${x}">${x}</button>`).join(', ')}${c.more ? ', …' : ''}</li>`;
  const list = !shown.length ? '' : shown.length <= 3 ? `<ul>${shown.map(item).join('')}</ul>`
    : `<details><summary>Show the list (${shown.length})</summary><ul>${shown.map(item).join('')}</ul></details>`;
  // the pills count what's listed; blank rows get their own line
  const badShown = shown.filter(c => c.status === 'fail').length, warnShown = shown.length - badShown;
  f.innerHTML = `<div class="msg">
      ${badShown ? `<span class="pill bad">${plural(badShown, 'problem')} to fix</span>` : bad.length ? (fresh ? '' : `<span class="pill bad">${plural(bad.length, 'problem')} to fix</span>`) : '<span class="pill ok">Ready to download</span>'}
      ${warnShown ? `<span class="pill warn">${plural(warnShown, 'warning')}</span>` : ''}
      ${fresh ? `<span class="pill muted">Fill or remove ${plural(fresh, 'blank row')}</span>` : ''}
      ${n === fresh ? '' : `<span class="hint foot-stats" style="margin-left:6px">${plural(n, 'row')}, ${plural(new Set(TC.rows.map(r => r.bin).filter(Boolean)).size, 'bin')}, ${plural(TC.rows.filter(r => r.hu).length, 'new HU')}</span>`}
      ${list}
      ${v.sessions?.length ? `<ul><li>${plural(v.sessions.length, 'open session')} will block the upload. Tick Force update in the panel.</li></ul>` : ''}
    </div>
    <button type="button" class="btn" id="c-verify">Verify after upload</button>
    <button type="button" class="btn primary big" id="c-dl" ${bad.length ? 'disabled' : ''}>Download sheet</button>`;
  f.querySelectorAll('[data-row]').forEach(a => a.onclick = () => flashRow(Number(a.dataset.row)));
  $('#c-dl').onclick = exportCase;
  $('#c-verify').onclick = () => { TC.verifyRows = payloadRows(); $('#v-prefix').value = $('#c-prefix').value.trim(); showMode('verify'); };
}
function flashRow(n) {
  const tr = document.querySelector(`#c-grid tr[data-i="${n - 2}"]`); if (!tr) return;
  tr.scrollIntoView({block: 'center', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'});
  tr.classList.add('flash'); setTimeout(() => tr.classList.remove('flash'), 1400);
  tr.querySelector('.c-bad, .c-warn')?.focus();
}

async function exportCase() {
  const btn = $('#c-dl'); btn.disabled = true; btn.textContent = 'Preparing…';
  try {
    const r = await fetch('/api/inv/export?' + qs(), {method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({rows: payloadRows(), name: $('#c-name').value.trim() || 'test-case', shelfLifeDays: Number($('#c-shelf').value) || 0})});
    if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `HTTP ${r.status}`); }
    const blob = await r.blob();
    const name = (r.headers.get('Content-Disposition') || '').match(/filename="([^"]+)"/)?.[1] || 'test-case.xlsx';
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    TC.verifyRows = payloadRows(); $('#v-prefix').value = $('#c-prefix').value.trim();
  } catch (e) { alert(e.message); }
  btn.disabled = false; btn.textContent = 'Download sheet';
}

function saveDraft() {
  if (!TC.cat) return;
  try { localStorage.setItem('tc:' + wh(), JSON.stringify({name: $('#c-name').value, prefix: $('#c-prefix').value, len: $('#c-len').value, op: caseOp(), shelf: $('#c-shelf').value, rows: TC.rows})); } catch {}
}
function restoreDraft() {
  let d = null;
  try { d = JSON.parse(localStorage.getItem('tc:' + wh()) || 'null'); } catch {}
  TC.rows = d?.rows || [];
  $('#c-name').value = d?.name || '';
  if (d?.prefix) $('#c-prefix').value = d.prefix;
  $('#c-len').value = d?.len || $('#c-prefix').value.trim().length + 5;
  if (d?.shelf) $('#c-shelf').value = d.shelf;
  document.getElementById(d?.op === 'RESET' ? 'cop-r' : 'cop-a').checked = true;
}
