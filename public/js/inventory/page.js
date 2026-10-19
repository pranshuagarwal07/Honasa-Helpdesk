// Inventory page (also the Masters module): shared helpers, the API call, and the module's tabs and features.
// Loaded first; the tool files after it use these globals. start.js opens the first feature.
const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmt = n => Number(n).toLocaleString();
const state = {snap: null, token: null, prefix: null};

try { $('#wh').value = localStorage.getItem('whId') || DESK.wh; } catch { $('#wh').value = DESK.wh; }
const wh = () => $('#wh').value.trim();
// remember the warehouse as soon as it's typed, and its principal override per warehouse
const loadPrincipal = () => { try { $('#principal').value = localStorage.getItem('principal:' + wh()) || ''; } catch {} };
loadPrincipal();
$('#wh').addEventListener('input', () => { if (/^\d+$/.test(wh())) { try { localStorage.setItem('whId', wh()); } catch {} loadPrincipal(); } });
$('#principal').addEventListener('input', () => { try { const p = $('#principal').value.trim(); p ? localStorage.setItem('principal:' + wh(), p) : localStorage.removeItem('principal:' + wh()); } catch {} });
const qs = extra => new URLSearchParams({whId: wh(), ...($('#principal').value.trim() ? {principalId: $('#principal').value.trim()} : {}), ...extra});

// pallet HU codes are the prefix plus a zero-padded counter, padded out to the chosen total length
const huDigits = (prefix, len) => Math.max(1, (Number(len) || prefix.length + 5) - prefix.length);
function huLenHint(prefix, len, el, need = 0) {
  const p = prefix.trim(), want = Number(len) || p.length + 5, d = huDigits(p, want), room = 10 ** d - 1;
  if (!p) { el.textContent = 'Set an HU prefix to see what the pallet codes will look like.'; return; }
  const warn = [];
  if (want < p.length + 1) warn.push(`That's shorter than the prefix allows. The shortest is ${p.length + 1} characters.`);
  if (need > room) warn.push(`${fmt(need)} pallets need more than ${d} digit${d > 1 ? 's' : ''}, so later codes would run longer. Make it at least ${p.length + String(need).length}.`);
  el.innerHTML = `Pallet codes will look like <span class="rl sm">${esc(p + '1'.padStart(d, '0'))}</span>
    <b>${p.length + d} characters</b>: the prefix (${p.length}) and a ${d}-digit counter, room for ${fmt(room)} pallet${room === 1 ? '' : 's'}${need ? `. ${fmt(need)} used so far` : ''}.`
    + warn.map(w => `<span class="warn-line">${esc(w)}</span>`).join('');
}

async function api(path, opts = {}) {
  let r;
  try { r = await fetch(path, opts); } catch { throw new Error(`Can't reach the local server. Start it with ${DESK.runBat}.`); }
  const body = await r.json().catch(() => ({error: `HTTP ${r.status}`}));
  if (!r.ok || body.error) throw new Error(body.error || `HTTP ${r.status}`);
  return body;
}

// ---- module navigation --------------------------------------------------------------
// This page is two modules: Inventory (/inventory) and Masters (/masters, DESK.module). js/tabs.js draws
// their tabs and sub-tabs and shows one feature's section at a time; start.js opens it once every tool file
// has loaded, because the onShow hooks below call functions defined in the files after this one.
const MOVE_RULES = 'Every move is checked against the WMS capacity check, positions, mixing rules and task locks.';
const MASTERS_LEDE = 'Check master sheets before they go into encarta, including the batch code rule: year, month, price (26JAN499).';
const MODULES = {
  inventory: {name: 'Inventory', tabs: [
    {id: 'sheets', label: 'Build sheets', features: [
      {id: 'case', label: 'Test case', view: '#v-case', lede: "Set up exact stock for a test. Pick bins, SKUs and batches, and download a sheet that passes the uploader's checks."},
      {id: 'fill', label: 'Bulk fill', view: '#v-build', lede: 'Fill a warehouse to a target occupancy using only the SKUs, batches and bins it already has.',
        onShow: () => { if (!state.snap) loadSnapshot(); }}]},
    {id: 'check', label: 'Check', features: [
      {id: 'sheet', label: 'Check a sheet', view: '#v-check', lede: 'Find every problem in an Append/Reset sheet before the upload burns its HU codes.'},
      {id: 'verify', label: 'Verify an upload', view: '#v-verify', lede: 'Compare what you uploaded with the stock now in those bins, and find pallets a failed upload left behind.',
        onShow: () => renderVerifyLast()}]},
    {id: 'consolidate', label: 'Consolidate', features: [
      {id: 'empty', label: 'Empty bins', view: '#v-consolidate', title: 'Empty bins',
        lede: 'Empty the bins under a % full into others: pallets by pallet positions, shelf bins by volume. ' + MOVE_RULES, onShow: () => cuSetGoal('empty')},
      {id: 'tidy', label: 'Tidy pallets', view: '#v-consolidate', title: 'Tidy pallets',
        lede: 'Merge part-full pallets so fewer pallets hold the same stock. ' + MOVE_RULES, onShow: () => cuSetGoal('tidy')}]},
    {id: 'im', label: 'IM uploads', features: [
      {id: 'files', label: 'IM files', view: '#v-imfiles', title: 'IM upload files', lede: 'Internal Movement upload files for the IM cockpit, built from a Consolidate plan.'},
      {id: 'checker', label: 'IM checker', view: '#v-imcheck', title: 'IM upload checker', lede: "Check any IM upload file against the uploader's rules and the live stock before you upload it."}]}],
    // the old one-level #mode links
    legacy: {case: 'sheets/case', build: 'sheets/fill', check: 'check/sheet', verify: 'check/verify', consolidate: 'consolidate'}},
  masters: {name: 'Masters', tabs: [
    {id: 'check', label: 'Check sheets', features: [
      {id: 'all', label: 'All sheets', view: '#v-masters', title: 'Check master sheets', lede: MASTERS_LEDE, onShow: () => mastersFocus('')},
      {id: 'sku', label: 'SKU', view: '#v-masters', title: 'Check the SKU master', lede: MASTERS_LEDE, onShow: () => mastersFocus('sku')},
      {id: 'batch', label: 'Batch', view: '#v-masters', title: 'Check the batch master', lede: MASTERS_LEDE, onShow: () => mastersFocus('batch')},
      {id: 'production', label: 'Production batch', view: '#v-masters', title: 'Check the production batch master', lede: MASTERS_LEDE,
        onShow: () => mastersFocus('production')}]}],
    legacy: {masters: 'check/all'}},
};
const MODULE = MODULES[DESK.module] || MODULES.inventory;
// tool files jump between features with showMode('verify') and the like (old mode names work too)
function showMode(m) { Tabs.go(m); }
