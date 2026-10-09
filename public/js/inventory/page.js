// Inventory page: shared helpers, the API call, and switching between the tools (#mode).
// Loaded first; the tool files after it use these globals. start.js opens the first mode.
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

// ---- modes ----------------------------------------------------------------------
const MODES = {"case":["Test case","Set up exact stock for a test. Pick bins, SKUs and batches, and download a sheet that passes the uploader's checks."],"build":["Bulk fill","Fill a warehouse to a target occupancy using only the SKUs, batches and bins it already has."],"check":["Check a sheet","Find every problem in an Append/Reset sheet before the upload burns its HU codes."],"verify":["Verify an upload","Compare what you uploaded with the stock now in those bins, and find pallets a failed upload left behind."],"consolidate":["Consolidate stock","Free bins in the stock as it is now. Shelf bins: empty them into others by moving eaches or whole cases, by bin type, checked against bin volume and mixing rules. Pallets: merge partial pallets and empty bins by moving whole pallets. Bins under % full: empty nearly empty bins of any inventory zone into the zones and bin types you pick."],"masters":["Check masters","Check SKU, batch and production batch master sheets before they go into encarta, including the batch code rule: year, month, price (26JAN499)."]};
function showMode(m) {
  if (!MODES[m]) m = 'case';
  for (const v of Object.keys(MODES)) $('#v-' + v).hidden = v !== m;
  $('#mode-title').textContent = MODES[m][0];
  $('#mode-lede').textContent = MODES[m][1];
  document.title = MODES[m][0] + ' · ' + DESK.name;
  document.querySelectorAll('.rail-nav a[data-nav]').forEach(a => a.dataset.nav === m ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  if (location.hash.slice(1) !== m) history.replaceState(null, '', '#' + m);
  if (m === 'verify') renderVerifyLast();
  if (m === 'build' && !state.snap) loadSnapshot();
}
