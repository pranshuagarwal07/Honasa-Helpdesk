// The which-checks-run picker, shared by Check a sheet and Check masters.
// which checks run: the server's catalog, minus the ids turned off here (kept per viewer).
// Storing what's off, not what's on, means a check added later starts switched on.
const LV_NAME = {fail: 'Red', warn: 'Yellow', info: 'Information'};
function makePicker(root, storeKey, url) {
  const P = {kinds: null, off: {}, last: null};
  try { P.off = JSON.parse(localStorage.getItem(storeKey) || '{}') || {}; } catch {}
  const groups = root.querySelector('.pick-groups'), count = root.querySelector('.pick-count');
  const save = () => { try { localStorage.setItem(storeKey, JSON.stringify(P.off)); } catch {} };
  const presetOff = (k, p) => k.checks.filter(c => p === 'none' || (p === 'fail' && c.level !== 'fail')).map(c => c.id);
  const setOff = (kind, ids) => { P.off[kind] = [...ids]; save(); render(); };
  P.offSet = k => new Set(P.off[k] || []);
  // only ids the server still knows; a check removed later shouldn't count as "off"
  P.offIds = k => k.checks.filter(c => P.offSet(k.kind).has(c.id)).map(c => c.id);
  P.skip = () => P.kinds ? Object.fromEntries(P.kinds.map(k => [k.kind, P.offIds(k)])) : undefined;
  function render() {
    if (!P.kinds) return;
    let on = 0, all = 0;
    const open = new Set([...groups.querySelectorAll('details[open]')].map(d => d.dataset.kind));
    groups.innerHTML = P.kinds.map(k => {
      const off = P.offSet(k.kind), n = k.checks.filter(c => !off.has(c.id)).length;
      on += n; all += k.checks.length;
      return `<details class="pick-group" data-kind="${k.kind}" ${open.has(k.kind) ? 'open' : ''}>
      <summary><span>${esc(k.name)}</span><small class="${n < k.checks.length ? 'some' : ''}">${n} of ${k.checks.length} on</small></summary>
      <div class="pick-tools"><button type="button" class="link" data-kp="all">All</button><button type="button" class="link" data-kp="fail">Red only</button><button type="button" class="link" data-kp="none">None</button></div>
      <ul class="pick-list">${k.checks.map(c => `<li><label><input type="checkbox" data-id="${esc(c.id)}" ${off.has(c.id) ? '' : 'checked'}>
        <span class="lv ${c.level}" title="${LV_NAME[c.level]}"></span><b class="pid">${esc(c.id)}</b><span>${esc(c.title)}</span></label></li>`).join('')}</ul></details>`;
    }).join('');
    count.textContent = `${on} of ${all} on`;
    count.classList.toggle('some', on < all);
    groups.querySelectorAll('.pick-group').forEach(g => {
      const k = P.kinds.find(x => x.kind === g.dataset.kind);
      g.querySelectorAll('input[data-id]').forEach(i => i.onchange = () => {
        const off = P.offSet(k.kind); i.checked ? off.delete(i.dataset.id) : off.add(i.dataset.id); setOff(k.kind, off);
      });
      g.querySelectorAll('[data-kp]').forEach(b => b.onclick = () => setOff(k.kind, presetOff(k, b.dataset.kp)));
    });
  }
  root.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
    if (!P.kinds) return;
    for (const k of P.kinds) P.off[k.kind] = presetOff(k, b.dataset.preset);
    save(); render();
  });
  // "Check again" for whatever was dropped last, with the checks as they are now
  P.rerun = (names, run) => {
    const el = root.querySelector('.pick-rerun');
    el.innerHTML = `<div class="download" style="margin-top:14px"><button type="button" class="btn small">Check again</button>
      <p>Re-runs ${names.map(esc).join(', ')} with the checks selected above. No need to drop ${names.length === 1 ? 'it' : 'them'} again.</p></div>`;
    el.querySelector('button').onclick = run;
  };
  (async () => {
    try { P.kinds = (await api(url)).kinds; render(); }
    catch (e) { count.textContent = ''; groups.innerHTML = `<div class="callout warn">Couldn't load the list of checks, so every check runs. If the server was started before this update, restart it with ${DESK.runBat}. (${esc(e.message)})</div>`; }
  })();
  return P;
}
