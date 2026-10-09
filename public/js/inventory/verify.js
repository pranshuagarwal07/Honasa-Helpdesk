// ---- verify an upload ------------------------------------------------------------
function renderVerifyLast() {
  if (TC.verifyRows?.length) {
    $('#verify-last').innerHTML = `<div class="download" style="margin-top:4px"><button type="button" class="btn primary" id="v-run-case">Verify the test case</button>
      <p>${esc($('#c-name').value || 'Test case')}: ${plural(TC.verifyRows.length, 'row')}, prefix ${esc($('#c-prefix').value)}.</p></div>`;
    $('#v-run-case').onclick = () => runVerify(qs({prefix: $('#v-prefix').value.trim()}), JSON.stringify({rows: TC.verifyRows}), {'Content-Type': 'application/json'});
    return;
  }
  $('#verify-last').innerHTML = state.token
    ? `<div class="download" style="margin-top:4px"><button type="button" class="btn primary" id="v-last">Verify the fill you just built</button>
       <p>Uses the ${Math.round(state.target * 100)}% fill with prefix ${esc(state.prefix)}.</p></div>`
    : '<p class="hint" style="margin:4px 0 0">A fill or test case you build in this session shows up here, ready to verify in one click.</p>';
  $('#v-last') && ($('#v-last').onclick = () => runVerify(qs({token: state.token, prefix: $('#v-prefix').value.trim()})));
}
wireDrop('#drop-verify', '#file-verify', async f => { if (await runVerify(qs({prefix: $('#v-prefix').value.trim()}), await f.arrayBuffer())) doneDrop('#drop-verify', 'Verify another sheet: drop it here, or choose a file'); });

async function runVerify(params, body, headers) {
  const out = $('#verify-out');
  out.innerHTML = '<div class="loading">Comparing with the stock in those bins…</div>';
  try {
    const r = await api('/api/inv/verify?' + params, {method: 'POST', body, headers});
    const t = r.totals;
    const all = t.landed === t.lines;
    const lines = r.lines.map(l => `<tr><td class="bin">${esc(l.bin)}</td><td class="sku">${esc(l.sku)}</td><td class="code">${esc(l.batch)}</td><td>${esc(l.uom)}</td>
      <td class="num">${fmt(l.expected)}</td><td class="num">${fmt(l.actual)}</td><td><span class="pill ${l.status === 'missing' ? 'bad' : 'warn'}">${l.status === 'missing' ? 'Missing' : 'Different qty'}</span></td></tr>`).join('');
    out.innerHTML = `<div class="panel" style="margin-top:16px">
      <div class="panel-sec"><div class="verdict-big"><span class="light ${all ? 'green' : 'red'}"></span>
        <h3>${all ? 'Everything landed' : t.missing === t.lines ? 'Nothing landed' : `${plural(t.missing + t.different, 'line')} not as expected`}</h3>
        <span class="hint">${fmt(t.landed)} of ${fmt(t.lines)} stock lines landed</span></div></div>
      ${lines ? `<div class="panel-sec"><h3>Not as expected</h3><div class="table-wrap"><table><thead><tr><th>Bin</th><th>SKU</th><th>Batch</th><th>UOM</th><th class="num">Expected</th><th class="num">In the bin</th><th>Status</th></tr></thead><tbody>${lines}</tbody></table></div>
        ${t.missing === t.lines ? '<p class="hint">Nothing landed. The upload probably failed; check the panel for the error.</p>' : ''}${t.different ? '<p class="hint">A bin that already held stock shows the old stock plus what was added, so it appears here as a different quantity.</p>' : ''}</div>` : ''}
      <div class="panel-sec"><h3>Empty pallets with prefix ${esc(r.prefix || '(none)')}</h3>
        ${r.emptyHUError ? `<div class="callout warn">Couldn't check: ${esc(r.emptyHUError)}</div>`
          : r.emptyHUs.length ? `<div class="callout warn"><b>${plural(r.emptyHUs.length, 'empty HU')}</b> with this prefix. A failed upload creates them, and those codes are now burned. Use a new prefix before retrying.</div>
              <ul class="sample">${r.emptyHUs.slice(0, 30).map(h => `<li>${esc(h)}</li>`).join('')}</ul>
              <p class="hint" style="margin:8px 0 0"><button type="button" class="link" id="v-copy-hu">Copy ${r.emptyHUs.length > 30 ? 'all ' + fmt(r.emptyHUs.length) : 'list'}</button>${r.emptyHUs.length > 30 ? ` · ${fmt(r.emptyHUs.length - 30)} more not shown` : ''}</p>`
          : '<p class="none-msg">None. No HU codes were burned.</p>'}</div></div>`;
    const cp = $('#v-copy-hu');
    cp && (cp.onclick = async () => { const label = cp.textContent;
      try { await navigator.clipboard.writeText(r.emptyHUs.join('\n')); cp.textContent = `Copied ${fmt(r.emptyHUs.length)}`; } catch { cp.textContent = 'Copy failed'; }
      setTimeout(() => { cp.textContent = label; }, 1600); });
    return true;
  } catch (e) { out.innerHTML = `<div class="alert">${esc(e.message)}</div>`; }
}
