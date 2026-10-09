// Readable dropdowns. Every <select> becomes a button that opens a list with big
// rows, a detail line and a filter box; every input with a <datalist> gets the same
// list as its suggestions. The native elements stay in the DOM as the source of
// truth, so page code keeps reading .value, setting innerHTML and listening for change.
//   <option data-sub="detail" data-tone="bad|near|ok">  adds a detail line
//   data-right="129 days left"   a badge on the right, coloured by data-tone
//   data-cols="Made=02/02/25|Expires=11/03/27"  aligned facts, shown in the list instead of data-sub
//   data-tags="In stock|Longest life"   small tags;  data-life="62"  a 0-100 bar
//   data-main="HB2401"   what the list shows instead of the option text (the closed button keeps the text)
//   <optgroup label>   becomes a heading;  <select data-cb-width="400">  widens the list
//   "CODE (detail)" option text is split the same way
//   <datalist data-filtered>  the page filters the list itself; show it as is
//   <select data-native>      leave this one alone
(() => {
  const SEARCH_FROM = 8;   // show the filter box from this many options
  const MAX_ROWS = 300;
  const sync = new WeakMap(); // select -> refresh its button
  let cur = null;             // the open list: {anchor, kind, items, active, ...}
  let waiting = null;         // an input that closed for want of suggestions; reopens when they arrive
  let seq = 0;

  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]));
  const norm = s => String(s ?? '').toLowerCase();
  const split = (text, sub) => {
    text = String(text ?? '').trim();
    if (sub) return [text, sub];
    const m = text.match(/^(.+?) \((.+)\)$/);
    return m ? [m[1], m[2]] : [text, ''];
  };
  const mark = (s, q) => {
    if (!q) return esc(s);
    const i = norm(s).indexOf(q);
    return i < 0 ? esc(s) : esc(s.slice(0, i)) + '<mark>' + esc(s.slice(i, i + q.length)) + '</mark>' + esc(s.slice(i + q.length));
  };

  // ---- the one popover --------------------------------------------------------
  const pop = document.createElement('div');
  pop.className = 'cb-pop';
  pop.hidden = true;
  pop.innerHTML = '<div class="cb-find"><input type="text" class="cb-search" placeholder="Type to filter" spellcheck="false" autocomplete="off" aria-label="Filter options" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="cb-list"></div>'
    + '<ul class="cb-list" role="listbox" tabindex="-1"></ul><div class="cb-foot"></div>';
  const search = pop.querySelector('.cb-search'), list = pop.querySelector('.cb-list'), foot = pop.querySelector('.cb-foot');
  list.id = 'cb-list';
  // keep focus where it is while clicking in the list
  pop.addEventListener('mousedown', e => { if (e.target !== search) e.preventDefault(); });
  pop.addEventListener('click', e => {
    const li = e.target.closest('li[data-k]');
    if (li && !li.classList.contains('dis')) choose(Number(li.dataset.k));
  });
  list.addEventListener('mousemove', e => {
    const li = e.target.closest('li[data-k]');
    if (li && cur && cur.active !== Number(li.dataset.k)) setActive(Number(li.dataset.k), false);
  });
  search.addEventListener('input', () => render());
  search.addEventListener('keydown', e => keys(e));
  list.addEventListener('keydown', e => keys(e));
  search.addEventListener('blur', () => setTimeout(() => { if (cur?.kind === 'select' && !pop.contains(document.activeElement) && document.activeElement !== cur.anchor) close(false); }));
  list.addEventListener('blur', () => setTimeout(() => { if (cur?.kind === 'select' && !pop.contains(document.activeElement) && document.activeElement !== cur.anchor) close(false); }));

  function place() {
    if (!cur) return;
    const r = cur.anchor.getBoundingClientRect();
    if (r.bottom < 0 || r.top > innerHeight || (!r.width && !r.height)) return close(false);
    const below = innerHeight - r.bottom - 12, above = r.top - 12;
    const up = below < 220 && above > below;
    const room = Math.max(140, Math.min(540, up ? above : below));
    const w = Math.min(Math.max(r.width, cur.minWidth), innerWidth - 16);
    pop.style.width = w + 'px';
    pop.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
    pop.style.maxHeight = room + 'px';
    pop.style.top = up ? '' : (r.bottom + 4) + 'px';
    pop.style.bottom = up ? (innerHeight - r.top + 4) + 'px' : '';
    pop.classList.toggle('up', up);
  }
  addEventListener('resize', place);
  const sized = typeof ResizeObserver === 'function' ? new ResizeObserver(() => place()) : null;
  addEventListener('scroll', e => { if (cur && !pop.contains(e.target)) place(); }, true);
  document.addEventListener('pointerdown', e => {
    if (cur && !pop.contains(e.target) && e.target !== cur.anchor && !cur.anchor.contains(e.target)) close(false);
  }, true);

  function items() {
    if (cur.kind === 'select') {
      return [...cur.el.options].map((o, i) => {
        const [main, sub] = split(o.text, o.dataset.sub);
        return {k: i, value: o.value, main: o.dataset.main || main || (o.value ? o.value : 'None'), sub, tone: o.dataset.tone || '',
          dis: o.disabled, empty: !o.value && !main, placeholder: !o.value, sel: i === cur.el.selectedIndex,
          group: o.parentElement.tagName === 'OPTGROUP' ? o.parentElement.label : '', right: o.dataset.right || '',
          cols: o.dataset.cols ? o.dataset.cols.split('|').map(c => c.split('=')) : null,
          tags: o.dataset.tags ? o.dataset.tags.split('|').filter(Boolean) : [], life: o.dataset.life ?? ''};
      });
    }
    const dl = document.getElementById(cur.el.dataset.cbList);
    return [...(dl?.options || [])].map((o, i) => {
      const label = o.label && o.label !== o.value ? o.label : '';
      return {k: i, value: o.value, main: o.value, sub: label, tone: o.dataset.tone || '', dis: o.disabled, sel: o.value === cur.el.value,
        group: '', right: '', cols: null, tags: [], life: ''};
    });
  }

  function render() {
    if (!cur) return;
    const all = items();
    const dl = cur.kind === 'input' ? document.getElementById(cur.el.dataset.cbList) : null;
    if (cur.kind === 'input' && !all.length && !(cur.el.value.trim() && dl?.hasAttribute('data-filtered'))) { const el = cur.el; close(false); waiting = el; return; }
    const q = norm(cur.kind === 'input' ? cur.el.value.trim() : search.value.trim());
    // a page that filters its own datalist may match on more than the text shown
    const filter = q && !(dl && dl.hasAttribute('data-filtered')) && !(cur.kind === 'input' && all.some(x => x.value === cur.el.value));
    const hay = x => norm([x.main, x.sub, x.right, x.group, ...x.tags, ...(x.cols || []).map(c => c.join(' '))].join(' '));
    cur.items = filter ? all.filter(x => hay(x).includes(q)) : all;
    const shown = cur.items.slice(0, MAX_ROWS);
    const counts = new Map();
    shown.forEach(x => x.group && counts.set(x.group, (counts.get(x.group) || 0) + 1));
    let group = '';
    const row = x => {
      const head = x.group && x.group !== group ? `<li class="cb-group" role="presentation">${esc(x.group)}<span>${counts.get(x.group)}</span></li>` : '';
      group = x.group;
      const tone = esc(x.tone);
      const detail = x.cols ? `<span class="cb-cols">${x.cols.map(([k, v]) => v === undefined ? `<span>${mark(k, q)}</span>` : `<span>${esc(k)} <b>${mark(v, q)}</b></span>`).join('')}</span>`
        : x.sub ? `<span class="cb-sub ${tone}">${mark(x.sub, q)}</span>` : '';
      const life = x.life !== '' ? `<span class="cb-life ${tone}"><i style="width:${Math.max(0, Math.min(100, Number(x.life) || 0))}%"></i></span>` : '';
      return head + `<li role="option" id="cb-o-${x.k}" data-k="${x.k}" aria-selected="${x.sel}" ${x.dis ? 'aria-disabled="true"' : ''}
        class="${x.sel ? 'sel' : ''} ${x.dis ? 'dis' : ''} ${x.placeholder ? 'ph' : ''}">
        <span class="cb-line"><span class="cb-main">${x.empty ? 'None' : mark(x.main, q)}</span>${x.tags.map(t => `<span class="cb-tag">${mark(t, q)}</span>`).join('')}
        ${x.right ? `<span class="cb-pill ${tone}">${mark(x.right, q)}</span>` : ''}</span>${detail}${life}</li>`;
    };
    list.innerHTML = shown.length ? shown.map(row).join('')
      : `<li class="cb-none">${all.length || cur.kind === 'input' ? 'No matches' : 'Nothing to pick'}</li>`;
    const capped = dl?.dataset.limit && all.length >= Number(dl.dataset.limit);
    foot.textContent = cur.items.length > MAX_ROWS ? `Showing ${MAX_ROWS} of ${cur.items.length.toLocaleString()}. Type to narrow.`
      : capped ? `First ${all.length} matches. Type to narrow.` : '';
    foot.hidden = !foot.textContent;
    const keep = cur.items.find(x => x.k === cur.active && !x.dis);
    const start = keep || cur.items.find(x => x.sel && !x.dis) || (q || cur.kind === 'select' ? cur.items.find(x => !x.dis) : null);
    setActive(start ? start.k : -1, true);
    place();
  }

  function setActive(k, scroll) {
    cur.active = k;
    list.querySelectorAll('li.on').forEach(li => li.classList.remove('on'));
    const li = list.querySelector(`li[data-k="${k}"]`);
    const owner = cur.kind === 'input' ? cur.el : search.offsetParent ? search : list;
    if (li) {
      li.classList.add('on');
      owner.setAttribute('aria-activedescendant', li.id);
      if (scroll) li.scrollIntoView({block: 'nearest'});
    } else owner.removeAttribute('aria-activedescendant');
  }

  function move(d) {
    const ok = cur.items.filter(x => !x.dis).slice(0, MAX_ROWS);
    if (!ok.length) return;
    const i = ok.findIndex(x => x.k === cur.active);
    const n = i < 0 ? (d > 0 ? 0 : ok.length - 1) : Math.max(0, Math.min(ok.length - 1, i + d));
    setActive(ok[n].k, true);
  }

  function keys(e) {
    if (!cur) return false;
    const k = e.key;
    if (k === 'ArrowDown' || k === 'ArrowUp') { e.preventDefault(); move(k === 'ArrowDown' ? 1 : -1); return true; }
    if (k === 'PageDown' || k === 'PageUp') { e.preventDefault(); move(k === 'PageDown' ? 8 : -8); return true; }
    if ((k === 'Home' || k === 'End') && e.target !== search && cur.kind === 'select') { e.preventDefault(); move(k === 'Home' ? -1e6 : 1e6); return true; }
    if (k === 'Enter' && cur.active >= 0) { e.preventDefault(); choose(cur.active); return true; }
    if (k === 'Escape') { e.preventDefault(); e.stopPropagation(); waiting = null; close(true); return true; }
    if (k === 'Tab') { close(false); return false; }
    // no filter box: jump to the next option starting with the typed letter
    if (cur.kind === 'select' && e.target === list && k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const ok = cur.items.filter(x => !x.dis), i = ok.findIndex(x => x.k === cur.active);
      const hit = [...ok.slice(i + 1), ...ok.slice(0, i + 1)].find(x => norm(x.main).startsWith(norm(k)));
      if (hit) setActive(hit.k, true);
      return true;
    }
    return false;
  }

  function open(kind, el, anchor, opts = {}) {
    if (cur && cur.el === el) return;
    close(false);
    waiting = null;
    cur = {kind, el, anchor, active: -1, items: [], minWidth: Number(el.dataset.cbWidth) || (kind === 'select' ? 220 : 300)};
    anchor.setAttribute('aria-expanded', 'true');
    anchor.setAttribute('aria-controls', list.id);
    const count = kind === 'select' ? el.options.length : 0;
    pop.querySelector('.cb-find').hidden = kind !== 'select' || count < SEARCH_FROM;
    search.value = opts.typed || '';
    pop.hidden = false;
    if (!pop.isConnected) document.body.append(pop);
    sized?.observe(anchor);
    render();
    if (!cur) return;
    if (kind === 'select') (pop.querySelector('.cb-find').hidden ? list : search).focus({preventScroll: true});
  }

  function close(refocus) {
    if (!cur) return;
    const c = cur;
    cur = null;
    pop.hidden = true;
    sized?.disconnect();
    c.anchor.setAttribute('aria-expanded', 'false');
    c.anchor.removeAttribute('aria-activedescendant');
    if (refocus && c.anchor.isConnected) c.anchor.focus({preventScroll: true});
  }

  function choose(k) {
    const c = cur;
    if (!c) return;
    waiting = null;
    if (c.kind === 'select') {
      close(true);
      if (c.el.selectedIndex === k) return;
      c.el.selectedIndex = k;
      c.el.dispatchEvent(new Event('input', {bubbles: true}));
      c.el.dispatchEvent(new Event('change', {bubbles: true}));
    } else {
      const opt = document.getElementById(c.el.dataset.cbList)?.options[k];
      close(false);
      if (!opt) return;
      c.el.value = opt.value;
      c.el.dataset.cbQuiet = '1';
      c.el.dispatchEvent(new Event('input', {bubbles: true}));
      delete c.el.dataset.cbQuiet;
      c.el.dispatchEvent(new Event('change', {bubbles: true}));
    }
  }

  // ---- <select> -------------------------------------------------------------------
  function nameOf(sel) {
    const lab = sel.labels?.[0];
    const t = sel.getAttribute('aria-label') || lab?.querySelector('span')?.textContent || lab?.firstChild?.textContent || '';
    return t.replace(/\s+/g, ' ').trim();
  }

  function enhanceSelect(sel) {
    if (sync.has(sel) || sel.multiple || sel.size > 1 || sel.closest('[data-native]')) return;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'listbox');
    btn.setAttribute('aria-expanded', 'false');
    btn.innerHTML = '<span class="cb-val"></span><span class="cb-sub"></span>';
    if (sel.dataset.f) btn.dataset.cbFor = sel.dataset.f;
    sel.after(btn);
    sel.classList.add('cb-native');
    sel.tabIndex = -1;
    sel.setAttribute('aria-hidden', 'true');
    const val = btn.firstChild, sub = btn.lastChild;
    const refresh = () => {
      const o = sel.options[sel.selectedIndex];
      const [main, detail] = o ? split(o.text, o.dataset.sub) : ['', ''];
      val.textContent = main || (o?.value ? o.value : sel.options.length ? 'None' : sel.dataset.cbEmpty || '—');
      sub.textContent = detail;
      sub.className = 'cb-sub ' + (o?.dataset.tone || '');
      btn.className = ['cb-btn', ...[...sel.classList].filter(c => c !== 'cb-native')].join(' ') + (o && !o.value ? ' ph' : '');
      btn.disabled = sel.disabled || !sel.options.length;
      if (sel.title) btn.title = sel.title; else btn.removeAttribute('title');
      const name = nameOf(sel);
      btn.setAttribute('aria-label', `${name ? name + ': ' : ''}${val.textContent}${detail ? ', ' + detail : ''}`);
      if (cur?.el === sel) render();
    };
    // page code sets .value directly (swap buttons, resets); keep the button in step
    for (const p of ['value', 'selectedIndex']) {
      const d = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, p);
      Object.defineProperty(sel, p, {configurable: true, get() { return d.get.call(this); }, set(v) { d.set.call(this, v); refresh(); }});
    }
    sync.set(sel, refresh);
    sel.addEventListener('change', refresh);
    sel.addEventListener('focus', () => btn.focus());
    btn.addEventListener('click', () => (cur?.el === sel ? close(true) : open('select', sel, btn)));
    btn.addEventListener('keydown', e => {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' ', 'F4'].includes(e.key) || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); open('select', sel, btn); }
      else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && sel.options.length >= SEARCH_FROM) { e.preventDefault(); open('select', sel, btn, {typed: e.key}); }
    });
    refresh();
    if (document.activeElement === sel) btn.focus();
  }

  // ---- <input list> ----------------------------------------------------------------
  function enhanceInput(inp) {
    if (inp.dataset.cbList) return;
    inp.dataset.cbList = inp.getAttribute('list');
    inp.removeAttribute('list'); // no native popup underneath ours
    inp.setAttribute('role', 'combobox');
    inp.setAttribute('aria-autocomplete', 'list');
    inp.setAttribute('aria-expanded', 'false');
    inp.setAttribute('autocomplete', 'off');
    const show = () => { if (document.activeElement === inp) cur?.el === inp ? render() : open('input', inp, inp); };
    inp.addEventListener('pointerdown', () => setTimeout(show));
    inp.addEventListener('input', () => { if (!inp.dataset.cbQuiet) show(); });
    inp.addEventListener('keydown', e => {
      if (cur?.el === inp) { keys(e); return; }
      if (e.key === 'ArrowDown' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); show(); }
    });
    inp.addEventListener('blur', () => { if (waiting === inp) waiting = null; if (cur?.el === inp) close(false); });
  }

  // ---- wire up everything, now and as pages render more ----------------------------
  function scan(root) {
    if (root.nodeType !== 1) return;
    if (root.matches('select')) enhanceSelect(root);
    else if (root.matches('input[list]')) enhanceInput(root);
    root.querySelectorAll?.('select').forEach(enhanceSelect);
    root.querySelectorAll?.('input[list]').forEach(enhanceInput);
  }
  new MutationObserver(recs => {
    const touched = new Set();
    let lists = false;
    for (const r of recs) {
      if (r.type === 'childList') r.addedNodes.forEach(scan);
      const t = r.target.nodeType === 1 ? r.target : r.target.parentElement;
      const s = t?.closest?.('select');
      if (s && sync.has(s)) touched.add(s);
      if (t?.closest?.('datalist')) lists = true;
    }
    touched.forEach(s => sync.get(s)());
    if (cur && !cur.anchor.isConnected) close(false);
    if (lists && cur?.kind === 'input') render();
    else if (lists && !cur && waiting && waiting === document.activeElement) open('input', waiting, waiting);
  }).observe(document.documentElement, {childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['class', 'title', 'disabled', 'selected', 'label']});
  scan(document.body);
  document.body.append(pop);
})();
