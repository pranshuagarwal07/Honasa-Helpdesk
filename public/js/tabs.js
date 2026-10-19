// Module navigation shared by every page: module (sidebar) -> tabs (tab bar) -> features (sub-tabs).
// A page puts <div id="modnav"></div> above its .page-head and, once its tool scripts have loaded, calls
//   Tabs.init({ name, tabs: [{ id, label, features: [{ id, label, view, title, lede, onShow }] }], legacy, hash })
// Each feature shows one element (its `view` selector); every other feature's view is hidden. Two features
// may share a view (onShow then sets it up). The address is #tab/feature, so links, refresh and the back
// button keep your place; `legacy` maps old #mode links onto it. With hash: false the address is left alone
// (Compare uses #sec-* anchors of its own). The last place is remembered per module for the next visit.
const Tabs = (() => {
  let M = null, cur = null;
  const last = {};
  const q = s => document.querySelector(s);
  const escH = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const storeKey = () => 'hh.tab:' + M.key;

  // "#tab/feature", a legacy "#mode", or "tab" alone -> { tab, feature } (null if it isn't one of ours)
  function resolve(raw) {
    raw = String(raw || '').replace(/^#/, '');
    if (M.legacy && M.legacy[raw]) raw = M.legacy[raw];
    const [t, f] = raw.split('/');
    const tab = M.tabs.find(x => x.id === t);
    if (!tab) return null;
    const feature = tab.features.find(x => x.id === f) || tab.features.find(x => x.id === last[tab.id]) || tab.features[0];
    return { tab, feature };
  }

  function render() {
    const nav = q('#modnav');
    if (!nav) return;
    const href = (t, f) => M.hash === false ? '#' : `#${t.id}/${f.id}`;
    const tabs = M.tabs.map(t => {
      const f = t.features.find(x => x.id === last[t.id]) || t.features[0];
      return `<a href="${href(t, f)}" data-tab="${t.id}"${t === cur.tab ? ' aria-current="page"' : ''}>${escH(t.label)}</a>`;
    }).join('');
    const subs = cur.tab.features.length > 1 ? cur.tab.features.map(f =>
      `<a href="${href(cur.tab, f)}" data-feature="${f.id}"${f === cur.feature ? ' aria-current="page"' : ''}>${escH(f.label)}</a>`).join('') : '';
    nav.innerHTML = `<p class="mod-name">${escH(M.name)}</p>
      <nav class="tabbar" aria-label="${escH(M.name)} sections">${tabs}</nav>
      <nav class="subtabs" aria-label="${escH(cur.tab.label)} features"${subs ? '' : ' hidden'}>${subs}</nav>`;
    if (M.hash === false) {   // no address to follow: switch on click instead
      nav.querySelectorAll('[data-tab]').forEach(a => a.onclick = e => { e.preventDefault(); go(a.dataset.tab); });
      nav.querySelectorAll('[data-feature]').forEach(a => a.onclick = e => { e.preventDefault(); go(cur.tab.id + '/' + a.dataset.feature); });
    }
  }

  function show(to) {
    cur = to;
    const views = new Set(M.tabs.flatMap(t => t.features.map(f => f.view)));
    for (const sel of views) {          // touch `hidden` only when it changes: tool scripts watch it
      const el = q(sel); if (!el) continue;
      const hide = sel !== to.feature.view;
      if (el.hidden !== hide) el.hidden = hide;
    }
    last[to.tab.id] = to.feature.id;
    const title = to.feature.title || to.feature.label;
    if (q('#mode-title')) q('#mode-title').textContent = title;
    if (q('#mode-lede')) q('#mode-lede').textContent = to.feature.lede || '';
    document.title = `${title} · ${M.name} · ${DESK.name}`;
    const path = `${to.tab.id}/${to.feature.id}`;
    if (M.hash !== false && location.hash.slice(1) !== path) history.replaceState(null, '', '#' + path);
    try { localStorage.setItem(storeKey(), path); } catch {}
    render();
    if (to.feature.onShow) to.feature.onShow();
  }

  // go('tab/feature' | 'tab' | legacy mode); unknown targets are ignored
  function go(path) { const to = resolve(path); if (to) show(to); return !!to; }

  function init(module) {
    M = { key: DESK.module || module.name.toLowerCase(), ...module };
    let saved = null; try { saved = localStorage.getItem(storeKey()); } catch {}
    const start = (M.hash !== false && resolve(location.hash)) || resolve(saved) || resolve(M.tabs[0].id);
    show(start);
    // hashes that aren't a tab (e.g. in-page anchors) are left alone
    if (M.hash !== false) addEventListener('hashchange', () => go(location.hash));
  }

  return { init, go, current: () => cur };
})();
