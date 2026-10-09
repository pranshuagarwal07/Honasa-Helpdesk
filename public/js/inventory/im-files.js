// ---- IM cockpit upload files of a consolidation plan --------------------------------
// one button per file; more than one when a later file needs the earlier tasks done first,
// or when same-bin pallet transfers (Destination HU on every row) must go in a file of their own
function imDlHtml(r, plan) {
  if (!r.im || (r.check && !r.check.ok)) return '';
  // moves the IM upload would refuse ("Qty exceeds bin capacity"): left out, listed in the plan workbook
  const held = r.imHeld ? `<div class="callout warn" style="margin-top:10px">${plural(r.imHeld, 'planned move')} left out of the IM upload: the WMS would refuse them with "Qty exceeds bin capacity" because a bin would go over 100% of what it counts the bin can hold. Download the plan and see <b>Not in IM upload</b> for each one and why.</div>` : '';
  if (!r.im.length) return held;
  const many = r.im.length > 1;
  const btns = r.im.map(f => `<button type="button" class="btn" data-im-plan="${plan}" data-im-token="${esc(r.token)}" data-im-file="${f.n}">${many ? `IM upload ${f.n} of ${r.im.length}` : 'Download IM upload'}</button>`).join('');
  const what = r.im.map(f => `${many ? `<b>${f.n}</b>: ` : ''}${esc(f.what)}, ${plural(f.rows, 'row')}${f.whole ? ` (${fmt(f.whole)} Pick HU true)` : ''}${f.wave > 1 ? `, after the wave ${f.wave - 1} tasks are done` : ''}`).join('<br>');
  return `<div class="download" style="margin-top:10px">${btns}
    <p>Ready for IM cockpit &gt; Internal Movement Upload: Sheet1, Pick HU as true/false (whole pallet = true), every bin within the WMS capacity check.${many ? ' Upload them in order.' : ''}<br>${what}</p></div>${held}`;
}
document.addEventListener('click', e => {
  const b = e.target.closest('[data-im-plan]');
  if (!b) return;
  const a = document.createElement('a');
  a.href = '/api/inv/im-download?' + qs({plan: b.dataset.imPlan, token: b.dataset.imToken, file: b.dataset.imFile});
  document.body.append(a); a.click(); a.remove();
});
