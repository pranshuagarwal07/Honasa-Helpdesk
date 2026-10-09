// The sidebar: collapse/expand (remembered), and on phones keep the current page's link in view.
// Loaded right after the sidebar markup on every page.
(() => {
  const root = document.documentElement, btn = document.getElementById('rail-toggle');
  const sync = () => {
    const min = root.classList.contains('rail-min'), t = min ? 'Expand sidebar' : 'Collapse sidebar';
    btn.setAttribute('aria-expanded', String(!min));
    btn.title = t;
    btn.querySelector('.sr').textContent = t;
    document.querySelectorAll('.rail-nav a').forEach(a => min ? a.title = a.textContent.trim() : a.removeAttribute('title'));
  };
  // phone layout: the nav is a sideways strip, so bring the current page into it
  const center = () => {
    const nav = document.querySelector('.rail-nav'), cur = nav && nav.querySelector('[aria-current]');
    if (cur && nav.scrollWidth > nav.clientWidth) nav.scrollLeft = cur.offsetLeft - (nav.clientWidth - cur.offsetWidth) / 2;
  };
  addEventListener('load', center);
  document.fonts && document.fonts.ready.then(center);
  addEventListener('hashchange', () => setTimeout(center));
  btn.onclick = () => {
    root.classList.toggle('rail-min');
    try { localStorage.setItem('uatdesk.rail', root.classList.contains('rail-min') ? 'min' : 'full'); } catch (e) {}
    sync();
  };
  sync();
})();
