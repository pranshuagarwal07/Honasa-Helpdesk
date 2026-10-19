// SAP order -> OMS allocation -> WMS OBD -> WMS picked, one row per SO line, all qty in eaches.
// Usage (from honasa-ack):
//   node scripts/order-trace/order-trace.js --so 1291029237,1291029240
//   node scripts/order-trace/order-trace.js --from 2026-10-10 --to 2026-10-12      (IST dates, OMS order created)
//   add --env SBX_HONASA_UAT to point elsewhere, --out file.csv to choose the output file
const fs = require('fs');
const path = require('path');
const { Client, types } = require('pg');

types.setTypeParser(1114, v => v); // OMS stores naive UTC; keep the raw text

const args = {};
process.argv.slice(2).forEach((a, i, all) => { if (a.startsWith('--')) args[a.slice(2)] = all[i + 1]; });
const envName = args.env || 'SBX_HONASA_PROD';
const env = require('../../config/envs.json')[envName];
const WH = args.wh || '1662652404097787';
const sql = f => fs.readFileSync(path.join(__dirname, f), 'utf8');

function connect(database) {
  return new Client({ host: env.host, port: env.port, user: env.user, password: env.password, database,
    ssl: { rejectUnauthorized: false }, options: '-c default_transaction_read_only=on' });
}

// IST date -> naive UTC timestamp text
const istToUtc = d => new Date(new Date(d + 'T00:00:00+05:30').getTime()).toISOString().replace('T', ' ').slice(0, 19);
const utcToIst = v => v ? new Date(v.replace(' ', 'T') + 'Z').toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', hour12: false }) : '';

(async () => {
  const sos = args.so ? args.so.split(',').map(s => s.trim().replace(/^SO/i, '')) : null;
  if (!sos && !(args.from && args.to)) throw new Error('pass --so <list> or --from YYYY-MM-DD --to YYYY-MM-DD');
  const toExcl = args.to && new Date(new Date(args.to + 'T00:00:00+05:30').getTime() + 86400000).toISOString().slice(0, 10);

  const oms = connect(env.databases.oms || 'oms');
  await oms.connect();
  const omsRows = (await oms.query(sql('oms.sql'), [WH, sos, sos ? null : istToUtc(args.from), sos ? null : istToUtc(toExcl)])).rows;
  await oms.end();

  const soList = [...new Set(omsRows.map(r => r.so))];
  const wms = connect(env.databases.wms);
  await wms.connect();
  const wmsRows = soList.length ? (await wms.query(sql('wms.sql'), [WH, soList])).rows : [];
  await wms.end();

  const byLine = new Map();
  for (const r of wmsRows) {
    // lines without a lineCode were not created from an OMS line; keep each one separate
    const k = r.so_line == null ? r.so + '|' + r.line_code + '|' + r.wms_sku + '|' + r.do_no + '|' + r.wms_batch : r.so + '-' + r.so_line;
    if (!byLine.has(k)) byLine.set(k, []);
    byLine.get(k).push(r);
  }

  const uniq = xs => [...new Set(xs.filter(Boolean))].join(' | ');
  const out = omsRows.map(o => {
    const w = byLine.get(o.so + '-' + o.so_line) || [];
    byLine.delete(o.so + '-' + o.so_line);
    const act = w.filter(r => r.active);
    const obd = act.reduce((s, r) => s + Number(r.obd_ea), 0);
    const picked = act.reduce((s, r) => s + Number(r.picked_ea), 0);
    const alloc = Number(o.oms_alloc_ea);
    const sap = Number(o.sap_qty_ea);
    let status;
    if (alloc === 0) status = 'NOT ALLOCATED';
    else if (!w.length) status = 'ALLOCATED, NO OBD IN WMS';
    else if (!act.length) status = 'OBD LINE DEACTIVATED';
    else if (obd < alloc) status = 'OBD < ALLOCATED';
    else if (obd > alloc) status = 'OBD > ALLOCATED';
    else if (picked === 0) status = 'NOT PICKED';
    else if (picked < obd) status = 'PART PICKED';
    else status = alloc < sap ? 'PICKED (SHORT ALLOCATED)' : 'PICKED';
    return {
      so: o.so, customer: o.customer, pushed_at_ist: utcToIst(o.pushed_at), so_line: o.so_line, product: o.product,
      sap_uom: o.sap_uom, sap_qty_ea: sap, oms_state: o.oms_state, oms_alloc_ea: alloc, oms_alloc_detail: o.oms_alloc_detail,
      wms_do: uniq(w.map(r => r.do_no)), wms_shipment: uniq(w.map(r => r.shipment)), wms_sku: uniq(w.map(r => r.wms_sku)),
      wms_uom: uniq(w.map(r => r.wms_uom)), wms_obd_qty: act.reduce((s, r) => s + r.obd_qty, 0), wms_obd_ea: obd,
      wms_deactivated: uniq(w.filter(r => !r.active).map(r => r.deactivation_reason || 'deactivated')),
      wms_picked_ea: picked, wms_picked_batches: uniq(w.map(r => r.picked_batches)),
      short_alloc_ea: sap - alloc, short_obd_ea: w.length ? alloc - obd : '', short_pick_ea: w.length ? obd - picked : '', status,
    };
  });
  for (const [k, ws] of byLine) // WMS lines with no matching OMS line
    out.push({ so: ws[0].so, so_line: ws[0].so_line ?? '', product: ws[0].product, wms_do: uniq(ws.map(r => r.do_no)),
      wms_shipment: uniq(ws.map(r => r.shipment)), wms_sku: uniq(ws.map(r => r.wms_sku)), wms_uom: uniq(ws.map(r => r.wms_uom)),
      wms_obd_qty: ws.filter(r => r.active).reduce((s, r) => s + r.obd_qty, 0), wms_obd_ea: ws.filter(r => r.active).reduce((s, r) => s + Number(r.obd_ea), 0),
      wms_picked_ea: ws.reduce((s, r) => s + Number(r.picked_ea), 0), wms_picked_batches: uniq(ws.map(r => r.picked_batches)),
      status: ws[0].so_line == null ? 'WMS LINE WITHOUT SO LINE NO.' : 'WMS LINE NOT IN OMS' });

  const cols = Object.keys(out[0] || { so: 1 });
  const esc = v => v == null ? '' : /[",\n]/.test(String(v)) ? '"' + String(v).replace(/"/g, '""') + '"' : String(v);
  const csv = [cols.join(','), ...out.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
  const file = args.out || `order-trace-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '')}.csv`;
  fs.writeFileSync(file, csv);
  console.log(`${out.length} SO lines from ${soList.length} orders -> ${path.resolve(file)}`);
  const counts = out.reduce((m, r) => (m[r.status] = (m[r.status] || 0) + 1, m), {});
  console.table(counts);
})().catch(e => { console.error(e.message); process.exit(1); });
