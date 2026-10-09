// Test case presets: forms that add rows for a common test in one go.
// ---- presets ------------------------------------------------------------------------
document.querySelectorAll('.preset').forEach(b => b.onclick = () => openPreset(TC.preset === b.dataset.preset ? null : b.dataset.preset));

const pfField = (label, inner, hint = '', cls = '') => `<label class="field ${cls}"><span>${label}</span>${inner}${hint ? `<small class="hintline" ${hint}></small>` : ''}</label>`;
const pfSeg = (name, opts, val) => `<div class="seg" role="radiogroup">${opts.map(([v, l]) => `<input type="radio" name="${name}" id="${name}-${v}" value="${v}" ${v === val ? 'checked' : ''}><label for="${name}-${v}">${l}</label>`).join('')}</div>`;
const pfVal = name => document.querySelector(`#preset-form input[name="${name}"]:checked`)?.value;
const pv = id => document.getElementById(id)?.value.trim() ?? '';
const selectOpts = (opts, val) => opts.map(([v, l]) => `<option value="${esc(v)}" ${v === val ? 'selected' : ''}>${esc(l)}</option>`).join('');

function openPreset(p) {
  TC.preset = p;
  document.querySelectorAll('.preset').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.preset === p)));
  const box = $('#preset-form');
  if (!p || !TC.cat) { box.innerHTML = ''; return; }
  const forms = {single: formSingle, status: formSingle, fefo: formFefo, pallets: formPallets, many: formMany};
  box.innerHTML = `<div class="panel"><div class="panel-sec">${forms[p](p)}</div></div>`;
  box.querySelectorAll('[data-pick]').forEach(el => { el.addEventListener('focus', () => listFor(el)); el.addEventListener('input', () => listFor(el)); });
  box.querySelectorAll('input, select').forEach(el => el.addEventListener('change', () => refreshPreset(p)));
  box.querySelectorAll('.quick button').forEach(b => b.onclick = () => { $('#pf-qty').value = b.dataset.qty; });
  $('#pf-add').onclick = () => addFromPreset(p);
  $('#pf-loose')?.addEventListener('input', () => refreshPreset(p));
  refreshPreset(p);
}

function describeBin(code, hintEl) {
  const b = binInfo(code), el = document.querySelector(hintEl); if (!el) return b;
  if (!code) { el.textContent = ''; el.className = 'hintline'; return b; }
  if (!b) { el.textContent = 'Not a bin in this warehouse.'; el.className = 'hintline bad'; return b; }
  const stock = TC.cat.stock[code];
  el.textContent = `${b.zone}, ${b.huType === 'PALLET' ? `pallet bin for ${plural(b.cap, 'pallet')}` : String(b.huType || '').toLowerCase() + ' bin'}, ${stock ? `has ${plural(stock.length, 'stock line')}` : 'empty'}${b.status !== 'ACTIVE' ? `, ${b.status}` : ''}.`;
  el.className = 'hintline' + (b.status !== 'ACTIVE' ? ' bad' : '');
  return b;
}
function describeSku(code, bin, uom, bucket, hintEl) {
  const s = skuInfo(code), el = document.querySelector(hintEl); if (!el) return s;
  if (!code) { el.textContent = ''; el.className = 'hintline'; return s; }
  if (!s) { el.textContent = 'Not a SKU for this principal.'; el.className = 'hintline bad'; return s; }
  const seq = bin ? allowed(bin, s, uom, bucket) : undefined;
  el.textContent = `Class ${s.clazz || 'none'}${s.L0inL2 ? `, case of ${s.L0inL2}` : ''}${s.L2inL3 ? `, ${Math.floor(s.L2inL3)} cases a pallet` : ''}.`
    + (seq === undefined ? '' : seq === null ? ` The search table doesn't allow ${uom} ${bucket} stock of this class here.` : ` Allowed here (search sequence ${seq}).`)
    + (uom === 'L0' && !s.base && s.baseCode !== s.code ? ` For eaches, the base SKU is ${s.baseCode}.` : '');
  el.className = 'hintline' + (seq === null || !s.clazz ? ' bad' : seq !== undefined ? ' ok' : '');
  return s;
}
function batchSelect(sku, val) {
  const list = TC.cat.batchOf(sku);
  if (!list.length) return `<option value="">${sku ? 'No batches for this SKU' : 'Pick a SKU first'}</option>`;
  return batchGroups(sku, val, {blockVendor: true});
}
function batchMeta() {
  const el = $('#pf-batch-h'); if (!el) return;
  const b = TC.cat.batchOf(pv('pf-sku')).find(x => x.code === pv('pf-batch'));
  if (!b) { el.textContent = ''; el.className = 'batchmeta'; return; }
  const d = daysLeft(b.exp);
  el.textContent = `Made ${dmy(b.mfg)}, expires ${dmy(b.exp)}, ${d <= 0 ? `expired ${-d} days ago` : `${d} days left`}.`;
  el.className = 'batchmeta ' + batchState(b.exp);
}
const freeBins = (zone, huType) => {
  const used = new Set(TC.rows.map(r => r.bin));
  return TC.cat.binList.filter(b => b.zone === zone && b.huType === huType && b.status === 'ACTIVE' && !TC.cat.stock[b.code] && !used.has(b.code));
};

// specific stock / bucket-status
function formSingle(p) {
  const st = p === 'status';
  return `<h3>${st ? 'Bucket or status stock' : 'Specific stock in a bin'}</h3><div class="pf-grid">
    ${pfField('Bin', '<input type="text" id="pf-bin" data-pick="bin-any" list="dl-bins" spellcheck="false">', 'id="pf-bin-h"')}
    ${pfField('SKU', '<input type="text" id="pf-sku" data-pick="sku" list="dl-skus" spellcheck="false">', 'id="pf-sku-h"')}
    ${pfField('Batch', '<select id="pf-batch" data-cb-width="430"></select><small class="batchmeta" id="pf-batch-h"></small>')}
    ${pfField('Unit', pfSeg('pf-unit', [['auto', 'From bin'], ['L2', 'Cases (L2)'], ['L0', 'Eaches (L0)']], 'auto'), 'id="pf-unit-h"')}
    ${pfField('Quantity <small id="pf-uom"></small>', '<input type="number" id="pf-qty" min="1"><div class="quick" id="pf-quick"></div>')}
    ${pfField('Loose eaches on top (L0)', '<input type="number" id="pf-loose" min="0" placeholder="None">' + pfSeg('pf-loosesku', [['base', 'Base SKU'], ['same', 'Same SKU']], 'base'), 'id="pf-loose-h"')}
    ${pfField('Bucket', pfSeg('pf-bucket', [['Good', 'Good'], ['Damaged', 'Damaged']], st ? 'Damaged' : 'Good'))}
    ${pfField('Inclusion status', pfSeg('pf-incl', [['INCLUDED', 'Included'], ['PRE-GRN', 'Pre-GRN'], ['POST-GIN', 'Post-GIN']], 'INCLUDED'))}
  </div><div class="pf-actions" style="margin-top:16px"><button type="button" class="btn primary" id="pf-add">Add row</button><small id="pf-msg"></small></div>`;
}
// FEFO / batch mix
function formFefo() {
  return `<h3>FEFO / batch mix</h3><div class="pf-grid">
    ${pfField('SKU', '<input type="text" id="pf-sku" data-pick="sku" list="dl-skus" spellcheck="false">', 'id="pf-sku-h"')}
    ${pfField('Stored as', pfSeg('pf-uomsel', [['L2', 'Pallets (L2)'], ['L0', 'Loose (L0)']], 'L2'))}
    ${pfField('Placement', pfSeg('pf-place', [['spread', 'One bin per batch'], ['one', 'All in one bin']], 'spread'))}
    <div class="field" id="pf-place-box"></div>
    ${pfField('Quantity per batch', '<input type="number" id="pf-qty" min="1"><div class="quick" id="pf-quick"></div>')}
    <div class="field wide"><span>Batches <small class="hintline">Earliest expiry first. Tick the ones to stock.</small></span><div class="batchpick" id="pf-batches"></div></div>
  </div><div class="pf-actions" style="margin-top:16px"><button type="button" class="btn primary" id="pf-add">Add rows</button><small id="pf-msg"></small></div>`;
}
// multi-pallet
function formPallets() {
  return `<h3>Several pallets in one bin</h3><div class="pf-grid">
    ${pfField('Pallet bin', '<input type="text" id="pf-bin" data-pick="bin-pallet" list="dl-bins" spellcheck="false">', 'id="pf-bin-h"')}
    ${pfField('SKU', '<input type="text" id="pf-sku" data-pick="sku" list="dl-skus" spellcheck="false">', 'id="pf-sku-h"')}
    ${pfField('Pallets', '<input type="number" id="pf-count" min="1" value="2">', 'id="pf-count-h"')}
    ${pfField('Cases on the last pallet', '<input type="number" id="pf-partial" min="0" placeholder="Full">', 'id="pf-partial-h"')}
    ${pfField('Loose eaches on the last pallet (L0)', '<input type="number" id="pf-loose" min="0" placeholder="None">' + pfSeg('pf-loosesku', [['base', 'Base SKU'], ['same', 'Same SKU']], 'base'), 'id="pf-loose-h"')}
    ${pfField('Batch', '<select id="pf-batch" data-cb-width="430"></select><small class="batchmeta" id="pf-batch-h"></small>')}
    ${pfField('Batches across pallets', pfSeg('pf-rot', [['same', 'Same batch'], ['rotate', 'Rotate batches']], 'same'))}
  </div><div class="pf-actions" style="margin-top:16px"><button type="button" class="btn primary" id="pf-add">Add rows</button><small id="pf-msg"></small></div>`;
}
// across many SKUs
function formMany() {
  const zones = TC.cat.zones.map(z => { const b = TC.cat.binList.find(x => x.zone === z); return [z, `${z} (${String(b?.huType || '').toLowerCase()}, ${b?.area || ''})`]; });
  return `<h3>Across many SKUs</h3><div class="pf-grid">
    ${pfField('Zone', `<select id="pf-zone">${selectOpts(zones, $('#bf-zone').value || zones[0]?.[0])}</select>`, 'id="pf-zone-h"')}
    ${pfField('SKUs', '<input type="number" id="pf-count" min="1" value="10">', 'id="pf-count-h"')}
    ${pfField('ABC class', pfSeg('pf-class', [['', 'Any'], ['A', 'A'], ['B', 'B'], ['C', 'C']], ''))}
    ${pfField('SKU codes matching', '<input type="text" id="pf-regex" placeholder="Optional regular expression" spellcheck="false">')}
    ${pfField('Unit', pfSeg('pf-unit', [['auto', 'From bin'], ['L2', 'Cases (L2)'], ['L0', 'Eaches (L0)']], 'auto'), 'id="pf-unit-h"')}
    ${pfField('Quantity', pfSeg('pf-qtyrule', [['pallet', 'Full pallet'], ['case', 'One case'], ['custom', 'Custom']], 'pallet') + '<input type="number" id="pf-qty" min="1" placeholder="Custom quantity" style="margin-top:6px">')}
    ${pfField('Batch expiry', pfSeg('pf-brule', [['longest', 'Longest'], ['shortest', 'Shortest'], ['near', 'Near expiry']], 'longest'))}
    ${pfField('Bucket', pfSeg('pf-bucket', [['Good', 'Good'], ['Damaged', 'Damaged']], 'Good'))}
    ${pfField('Inclusion status', pfSeg('pf-incl', [['INCLUDED', 'Included'], ['PRE-GRN', 'Pre-GRN'], ['POST-GIN', 'Post-GIN']], 'INCLUDED'))}
  </div><div class="pf-actions" style="margin-top:16px"><button type="button" class="btn primary" id="pf-add">Add rows</button><small id="pf-msg"></small></div>`;
}

function quickButtons(sku, uom) {
  const q = $('#pf-quick'); if (!q) return;
  q.innerHTML = sku ? `<button type="button" data-qty="${caseQty(sku, uom)}">One case (${caseQty(sku, uom)})</button><button type="button" data-qty="${palletQty(sku, uom)}">Full pallet (${palletQty(sku, uom)})</button>` : '';
  q.querySelectorAll('button').forEach(b => b.onclick = () => { $('#pf-qty').value = b.dataset.qty; });
}

// keep hints, batch lists and defaults in step with what's been picked
function refreshPreset(p) {
  if (p === 'single' || p === 'status') {
    const bin = describeBin(pv('pf-bin'), '#pf-bin-h'), uom = unitUom(pfVal('pf-unit'), bin), bucket = pfVal('pf-bucket');
    const sku = describeSku(pv('pf-sku'), bin, uom, bucket, '#pf-sku-h');
    $('#pf-unit-h').textContent = pfVal('pf-unit') === 'auto' && bin ? `${bin.huType === 'PALLET' ? 'Pallet' : 'This'} bin, so ${uom === 'L2' ? 'cases' : 'eaches'}.` : '';
    const loose = $('#pf-loose');
    loose.disabled = uom !== 'L2';
    if (loose.disabled) loose.value = '';
    if (uom !== 'L2') { $('#pf-loose-h').textContent = 'Only when stocking cases.'; $('#pf-loose-h').className = 'hintline'; }
    else looseHint(bin, sku, bin?.huType === 'PALLET' ? 'pallet' : 'bin');
    const cur = pv('pf-batch');
    $('#pf-batch').innerHTML = batchSelect(pv('pf-sku'), cur || pickBatch(pv('pf-sku'))?.code);
    batchMeta();
    $('#pf-uom').textContent = bin || pfVal('pf-unit') !== 'auto' ? `(${uom === 'L2' ? 'cases, L2' : 'eaches, L0'})` : '';
    quickButtons(sku, uom);
    if (sku && TC.pfLast !== sku.code + uom) { $('#pf-qty').value = uom === 'L2' ? palletQty(sku, uom) : caseQty(sku, uom); TC.pfLast = sku.code + uom; }
  } else if (p === 'pallets') {
    const bin = describeBin(pv('pf-bin'), '#pf-bin-h');
    const sku = describeSku(pv('pf-sku'), bin, 'L2', 'Good', '#pf-sku-h');
    if (bin && document.activeElement?.id === 'pf-bin') $('#pf-count').value = bin.cap;
    $('#pf-count-h').textContent = bin ? `This bin holds ${plural(bin.cap, 'pallet')}.` : '';
    $('#pf-count-h').className = 'hintline' + (bin && Number(pv('pf-count')) > bin.cap ? ' bad' : '');
    $('#pf-partial-h').textContent = sku ? `A full pallet is ${Math.floor(sku.L2inL3 || 0)} cases.` : '';
    looseHint(bin, sku, 'pallet');
    $('#pf-batch').innerHTML = batchSelect(pv('pf-sku'), pv('pf-batch') || pickBatch(pv('pf-sku'))?.code);
    batchMeta();
  } else if (p === 'fefo') {
    const uom = pfVal('pf-uomsel'), place = pfVal('pf-place');
    const sku = describeSku(pv('pf-sku'), null, uom, 'Good', '#pf-sku-h');
    const box = $('#pf-place-box');
    if (place === 'one' && !$('#pf-bin')) {
      box.innerHTML = `<span>Bin</span><input type="text" id="pf-bin" data-pick="bin-any" list="dl-bins" spellcheck="false"><small class="hintline" id="pf-bin-h"></small>`;
      $('#pf-bin').addEventListener('focus', () => listFor($('#pf-bin'))); $('#pf-bin').addEventListener('input', () => listFor($('#pf-bin')));
      $('#pf-bin').addEventListener('change', () => refreshPreset('fefo'));
    } else if (place === 'spread' && !$('#pf-zone')) {
      box.innerHTML = `<span>Zone</span><select id="pf-zone"></select><small class="hintline" id="pf-zone-h"></small>`;
      $('#pf-zone').addEventListener('change', () => refreshPreset('fefo'));
    }
    const zoneBin = z => TC.cat.binList.find(x => x.zone === z);
    if (place === 'spread') {
      const cur = pv('pf-zone');
      const zones = TC.cat.zones.filter(z => { const b = zoneBin(z); return b && (b.huType === 'PALLET' || b.huType === 'BIN') && (!sku || allowed(b, sku, uom, 'Good') !== null); });
      $('#pf-zone').innerHTML = zones.length ? selectOpts(zones.map(z => [z, `${z} (${String(zoneBin(z).huType).toLowerCase()}, ${freeBins(z, zoneBin(z).huType).length} empty)`]), zones.includes(cur) ? cur : zones.includes($('#bf-zone').value) ? $('#bf-zone').value : zones[0]) : '<option value="">No zone allows this SKU</option>';
      $('#pf-zone-h').textContent = sku ? 'Zones where the search table allows this SKU.' : '';
    } else {
      const bin = describeBin(pv('pf-bin'), '#pf-bin-h');
      if (bin && bin.multiBatch === false) { $('#pf-bin-h').textContent += ' This bin takes one batch only.'; $('#pf-bin-h').className = 'hintline bad'; }
    }
    quickButtons(sku, uom);
    if (sku && TC.pfLast !== sku.code + uom) { $('#pf-qty').value = uom === 'L2' ? palletQty(sku, uom) : caseQty(sku, uom); TC.pfLast = sku.code + uom; }
    const list = TC.cat.batchOf(pv('pf-sku'));
    const checked = new Set([...document.querySelectorAll('#pf-batches input:checked')].map(x => x.value).filter(c => list.some(b => b.code === c)));
    const valid = list.filter(isValidBatch);
    if (!checked.size && valid.length) { valid.slice(0, Math.min(3, valid.length)).forEach(b => checked.add(b.code)); }
    $('#pf-batches').innerHTML = list.length ? list.map(b => `<label class="${b.vendorLot || !b.active ? 'dis' : ''}"><input type="checkbox" value="${esc(b.code)}" ${checked.has(b.code) ? 'checked' : ''} ${b.vendorLot || !b.active ? 'disabled' : ''}>
      ${esc(b.code)} <small>expires ${dmy(b.exp)}, ${b.vendorLot ? 'also a vendor lot, not allowed' : !b.active ? 'inactive' : daysLeft(b.exp) <= 0 ? 'expired' : `${daysLeft(b.exp)} days left`}</small></label>`).join('')
      : '<span class="hintline">Pick a SKU to see its batches.</span>';
  } else if (p === 'many') {
    const zone = pv('pf-zone'), zb = TC.cat.binList.find(b => b.zone === zone);
    const free = zb ? freeBins(zone, zb.huType).length : 0;
    $('#pf-zone-h').textContent = zb ? `${free} empty active bins left in this zone.` : '';
    const u = unitUom(pfVal('pf-unit'), zb);
    $('#pf-unit-h').textContent = zb ? `${u === 'L2' ? 'Case-pack SKUs in cases' : 'Base SKUs in eaches'}; the search table must allow ${u} here.` : '';
    const n = manyPool().length;
    $('#pf-count-h').textContent = `${n} SKUs qualify for this zone.`;
    $('#pf-count-h').className = 'hintline' + (n ? '' : ' bad');
  }
}

function manyPool() {
  const zone = pv('pf-zone'), zb = TC.cat.binList.find(b => b.zone === zone);
  if (!zb) return [];
  const uom = unitUom(pfVal('pf-unit'), zb), cls = pfVal('pf-class'), bucket = pfVal('pf-bucket');
  let re = null; try { re = pv('pf-regex') ? new RegExp(pv('pf-regex')) : null; } catch {}
  const ok = s => s.active && s.clazz && (!cls || s.clazz === cls) && (!re || re.test(s.code)) && allowed(zb, s, uom, bucket) !== null && pickBatch(s.code, pfVal('pf-brule'));
  let pool = TC.cat.skuList.filter(s => ok(s) && (uom === 'L2' ? !s.base && s.L2inL3 >= 1 : s.base && s.L0inL2 > 0));
  if (!pool.length) pool = TC.cat.skuList.filter(s => ok(s) && (uom === 'L2' ? s.L2inL3 >= 1 : s.L0inL2 > 0));
  return pool;
}

function addFromPreset(p) {
  const msg = t => { $('#pf-msg').textContent = t; };
  const before = TC.rows.length;
  if (p === 'single' || p === 'status') {
    if (!binInfo(pv('pf-bin')) || !skuInfo(pv('pf-sku'))) return msg('Pick a bin and a SKU from the list.');
    if (!(Number(pv('pf-qty')) > 0)) return msg('Enter a quantity.');
    const bin = binInfo(pv('pf-bin')), sku = skuInfo(pv('pf-sku')), uom = unitUom(pfVal('pf-unit'), bin);
    const main = addRow({bin: bin.code, sku: sku.code, uom, qty: Number(pv('pf-qty')), batch: pv('pf-batch'), bucket: pfVal('pf-bucket'), inclusion: pfVal('pf-incl')});
    const loose = Number(pv('pf-loose'));
    if (uom === 'L2' && loose > 0) {
      const base = looseSku(sku, pfVal('pf-loosesku'));
      addRow({bin: bin.code, sku: base.code, uom: 'L0', qty: loose, batch: looseBatch(base, main.batch), bucket: main.bucket, inclusion: main.inclusion, hu: main.hu || undefined});
    }
    $('#pf-bin').value = ''; $('#pf-loose').value = ''; refreshPreset(p);
  } else if (p === 'pallets') {
    const bin = binInfo(pv('pf-bin')), sku = skuInfo(pv('pf-sku'));
    if (!bin || !sku) return msg('Pick a pallet bin and a SKU from the list.');
    const n = Number(pv('pf-count')) || 1, full = Math.max(1, Math.floor(sku.L2inL3 || 1)), last = Number(pv('pf-partial'));
    const valid = TC.cat.batchOf(sku.code).filter(isValidBatch);
    for (let i = 0; i < n; i++) {
      const batch = pfVal('pf-rot') === 'rotate' && valid.length ? valid[i % valid.length].code : pv('pf-batch');
      addRow({bin: bin.code, sku: sku.code, uom: 'L2', qty: i === n - 1 && last > 0 ? last : full, batch, hu: nextHu()});
    }
    const loose = Number(pv('pf-loose')), lastRow = TC.rows[TC.rows.length - 1];
    if (loose > 0) {
      const base = looseSku(sku, pfVal('pf-loosesku'));
      addRow({bin: bin.code, sku: base.code, uom: 'L0', qty: loose, batch: looseBatch(base, lastRow.batch), hu: lastRow.hu});
    }
  } else if (p === 'fefo') {
    const sku = skuInfo(pv('pf-sku')), uom = pfVal('pf-uomsel'), qty = Number(pv('pf-qty'));
    const batches = [...document.querySelectorAll('#pf-batches input:checked')].map(x => x.value);
    if (!sku) return msg('Pick a SKU from the list.');
    if (!batches.length) return msg('Tick at least one batch.');
    if (!(qty > 0)) return msg('Enter a quantity per batch.');
    let bins;
    if (pfVal('pf-place') === 'one') {
      if (!binInfo(pv('pf-bin'))) return msg('Pick a bin from the list.');
      bins = batches.map(() => pv('pf-bin'));
    } else {
      const zb = TC.cat.binList.find(b => b.zone === pv('pf-zone'));
      const free = zb ? freeBins(zb.zone, zb.huType) : [];
      if (free.length < batches.length) return msg(`Only ${free.length} empty bins left in that zone.`);
      bins = free.slice(0, batches.length).map(b => b.code);
    }
    batches.forEach((batch, i) => {
      const bin = binInfo(bins[i]);
      addRow({bin: bins[i], sku: sku.code, uom, qty, batch, hu: bin?.huType === 'PALLET' ? nextHu() : undefined});
    });
  } else if (p === 'many') {
    const zone = pv('pf-zone'), zb = TC.cat.binList.find(b => b.zone === zone);
    if (!zb) return msg('Pick a zone.');
    const uom = unitUom(pfVal('pf-unit'), zb), pool = manyPool(), n = Math.min(Number(pv('pf-count')) || 1, pool.length);
    const free = freeBins(zone, zb.huType);
    if (!pool.length) return msg('No SKU qualifies for this zone with these filters.');
    const count = Math.min(n, free.length);
    for (let i = 0; i < count; i++) {
      const s = pool[i], rule = pfVal('pf-qtyrule');
      const qty = rule === 'custom' ? Number(pv('pf-qty')) || 1 : rule === 'case' ? caseQty(s, uom) : palletQty(s, uom);
      addRow({bin: free[i].code, sku: s.code, uom, qty, batchMode: pfVal('pf-brule'), bucket: pfVal('pf-bucket'), inclusion: pfVal('pf-incl'),
        hu: zb.huType === 'PALLET' ? nextHu() : undefined});
    }
    const asked = Number(pv('pf-count')) || 1;
    if (count < n) msg(`Added ${count}. The zone ran out of empty bins.`);
    else if (n < asked) msg(`Added ${count}. Only ${plural(pool.length, 'SKU')} qualify for this zone with these filters.`);
  }
  const added = TC.rows.length - before;
  if (added && !$('#pf-msg').textContent.startsWith('Added')) msg(`Added ${plural(added, 'row')}.`);
  renderGrid(); scheduleValidate();
  if (p !== 'single' && p !== 'status') refreshPreset(p);
}

$('#wh').addEventListener('change', () => { TC.rows = []; TC.last = null; loadCatalog(); });
