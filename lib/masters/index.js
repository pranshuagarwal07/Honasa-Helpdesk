// Check masters: validate SKU, batch and production batch upload sheets before they go into encarta.
// encarta's own upload only checks the header, required fields, in-file duplicates, that the SKU /
// parent batch exists, L0inL2 % L0inL1, and (production only) expiry >= packing. Everything else
// here — the batch code rule, case config, dates vs code, prices, collisions — is ours.
// Red = encarta rejects it, or it lands as wrong data. Yellow = suspicious, check it.
const crypto = require("crypto");
const ExcelJS = require("exceljs");

// row 1 of encarta's current Add*Template files (the upload compares it exactly)
const TEMPLATES = {
  sku: ["code", "name", "description", "short description", "product code", "sub category code", "sub brand code", "ingredients",
    "shelf life", "active from", "active till", "fulfillment type", "identifier1", "identifier2", "invoice life", "inventory type",
    "avg l0 per put", "image", "L0inL1 Qty", "L0inL2 Qty", "L2inL3 Qty", "L0 Wt", "L0 Vol", "L1 Wt", "L1 Vol", "L2 Wt", "L2 Vol",
    "L0 EAN", "L1 EAN", "L2 EAN", "L0 Package Type", "L1 Package Type", "L2 Package Type", "L3 Package Type", "tag1", "tag2", "tag3",
    "tag4", "tag5", "tag6", "tag7", "tag8", "special storage indicator", "tag10", "layers", "cases per layer", "handling unit type",
    "batch date print level", "destruction days", "active", "L0 Gross Wt kg", "L1 Gross Wt kg", "L2 Gross Wt kg", "L3 Gross Wt kg",
    "stacking priority", "plant code", "is rotation allowed"],
  batch: ["sku code", "code", "batch name", "batch desc", "price lot", "price", "source factory", "case config", "packing date",
    "expiry date", "destruction days", "active", "tag1"],
  production: ["batch code", "sku code", "code", "price", "source factory", "packing date", "expiry date", "active"],
};
const KIND_NAME = { sku: "SKU master", batch: "Batch master", production: "Production batch master" };
const MONTHS = ["JAN", "FEB", "MAR", "APR", "MAY", "JUN", "JUL", "AUG", "SEP", "OCT", "NOV", "DEC"];
// YY + 3-letter month + price, e.g. 26JAN499, 26MAY99, 24DEC1240
const BATCH_RULE = new RegExp(`^(\\d{2})(${MONTHS.join("|")})(\\d+)$`);

const upper = (s) => String(s ?? "").trim().toUpperCase();
const norm = (h) => String(h ?? "").toLowerCase().replace(/_/g, " ").replace(/\s+/g, " ").trim();
const blank = (v) => v === null || v === undefined || String(v).trim() === "";
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const today = () => { const d = new Date(); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
const num = (v) => (blank(v) ? null : Number(v));

function cellValue(v) {
  if (v === null || v === undefined) return null;
  if (v instanceof Date || typeof v !== "object") return v;
  if ("result" in v) return v.result;
  if ("text" in v) return v.text;
  if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join("");
  return String(v);
}

// the date strings encarta accepts (app/schemas.py), plus real Excel dates. -> {key} | {bad} | null
function parseDate(v) {
  if (blank(v)) return null;
  if (v instanceof Date) return isNaN(v) ? { bad: true } : { key: ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()) };
  if (typeof v === "number") return { bad: true, why: "a plain number, not a date" };
  const s = String(v).trim().slice(0, 19).replace(/\s+\d{1,2}:\d{2}(:\d{2})?$/, "");
  const ok = (y, m, d) => { const t = new Date(Date.UTC(y, m - 1, d)); return t.getUTCMonth() === m - 1 && t.getUTCDate() === d ? { key: ymd(y, m, d) } : { bad: true }; };
  let m;
  if ((m = s.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/))) return ok(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{4})(\d{2})(\d{2})$/))) return ok(+m[1], +m[2], +m[3]);
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/))) return ok(+m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2})$/))) return ok(2000 + +m[3], +m[2], +m[1]);
  if ((m = s.match(/^(\d{2})(\d{2})(\d{4})$/))) return ok(+m[3], +m[2], +m[1]);
  return { bad: true };
}
const parseBool = (v) => {
  if (blank(v)) return null;
  if (typeof v === "boolean") return v;
  const s = String(v).trim().toLowerCase();
  if (["true", "1", "yes", "y", "t"].includes(s)) return true;
  if (["false", "0", "no", "n", "f"].includes(s)) return false;
  return "bad";
};
// GS1 check digit for EAN-8/UPC-12/EAN-13/GTIN-14
function eanOk(code) {
  const s = String(code).trim();
  if (!/^\d{8}$|^\d{12,14}$/.test(s)) return false;
  const d = s.split("").map(Number), check = d.pop();
  const sum = d.reverse().reduce((t, x, i) => t + x * (i % 2 === 0 ? 3 : 1), 0);
  return (10 - (sum % 10)) % 10 === check;
}

module.exports = function mastersModule({ encarta, q, tryQ, principalOf }) {
  const cache = new Map(); // principal -> { at, d }
  const checked = new Map(); // token -> { buffer, name, rowIssues, at }

  // ---- live masters for one principal -------------------------------------------------
  async function loadLive(principal) {
    const hit = cache.get(principal);
    if (hit && Date.now() - hit.at < 5 * 60000) return hit.d;
    const P = [principal];
    const [skus, uoms, batches, prods, products, [plants]] = await Promise.all([
      q(encarta, `SELECT s.code, s.active, s.shelf_life, p.code AS product, b.code AS base FROM skus s
                   LEFT JOIN products p ON p.id = s.product_id LEFT JOIN skus b ON b.id = s.base_sku_id
                   WHERE s.principal_id::text = $1`, P),
      q(encarta, `SELECT s.code, u.hierarchy, u.units FROM uoms u JOIN skus s ON s.id = u.sku_id
                   WHERE s.principal_id::text = $1 AND u.active IS NOT FALSE`, P),
      q(encarta, `SELECT sku_code, upper(trim(code)) AS code, price, case_config, active,
                   to_char(packing_date, 'YYYY-MM-DD') AS mfg, to_char(expiry_date, 'YYYY-MM-DD') AS exp
                   FROM batches WHERE principal_id::text = $1`, P),
      q(encarta, `SELECT b.sku_code, upper(trim(b.code)) AS parent, upper(trim(pb.code)) AS code, pb.price, pb.active,
                   to_char(pb.packing_date, 'YYYY-MM-DD') AS mfg, to_char(pb.expiry_date, 'YYYY-MM-DD') AS exp
                   FROM production_batches pb JOIN batches b ON b.id = pb.batch_id WHERE pb.principal_id::text = $1`, P),
      q(encarta, "SELECT upper(trim(code)) AS code FROM products WHERE principal_id::text = $1", P),
      tryQ(encarta, "SELECT upper(trim(code)) AS code FROM plants WHERE principal_id::text = $1", P),
    ]);
    const units = new Map();
    for (const u of uoms) { if (!units.has(u.code)) units.set(u.code, {}); units.get(u.code)[u.hierarchy] = Number(u.units); }
    const d = {
      principal,
      skus: new Map(skus.map((s) => {
        const u = units.get(s.code) || {};
        return [upper(s.code), { code: s.code, active: s.active === true, shelfLife: Number(s.shelf_life) || null, product: s.product,
          base: s.base ? upper(s.base) : null,
          L0inL1: u.L1 || null, L0inL2: u.L2 || null, L2inL3: u.L2 && u.L3 ? u.L3 / u.L2 : null }];
      })),
      batches: new Map(batches.map((b) => [`${upper(b.sku_code)}|${b.code}`, b])),
      prods: new Map(prods.map((p) => [`${upper(p.sku_code)}|${p.parent}|${p.code}`, p])),
      prodCodes: new Map(), // sku|lot -> set of parent codes
      products: new Set(products.map((p) => p.code)),
      plants: plants.length ? new Set(plants.map((p) => p.code)) : null,
      counts: { skus: skus.length, batches: batches.length, production: prods.length },
    };
    for (const p of prods) { const k = `${upper(p.sku_code)}|${p.code}`; if (!d.prodCodes.has(k)) d.prodCodes.set(k, new Set()); d.prodCodes.get(k).add(p.parent); }
    cache.set(principal, { at: Date.now(), d });
    return d;
  }

  // ---- read one workbook ----------------------------------------------------------------
  async function readBook(buffer, name) {
    const wb = new ExcelJS.Workbook();
    try { await wb.xlsx.load(buffer); }
    catch {
      throw new Error(name.startsWith("~$")
        ? "this is Excel's temporary lock file, not the sheet. Drop the file without ~$ at the start."
        : "couldn't open it as an .xlsx workbook. Save it from Excel as .xlsx and try again.");
    }
    const ws = wb.worksheets[0];
    if (!ws) throw new Error("the file has no sheets.");
    const headers = [];
    ws.getRow(1).eachCell({ includeEmpty: true }, (c, i) => { headers[i - 1] = String(cellValue(c.value) ?? "").trim(); });
    while (headers.length && !headers[headers.length - 1]) headers.pop();
    // which template is this: the one sharing the most header names. Panel exports name the
    // same fields in snake_case (packing_date, L0inL2_Qty), so compare names normalised.
    const low = headers.map(norm);
    const score = (k) => TEMPLATES[k].filter((h) => low.includes(norm(h))).length / TEMPLATES[k].length;
    const kind = ["production", "batch", "sku"].map((k) => [k, score(k)]).sort((a, b) => b[1] - a[1])[0];
    if (kind[1] < 0.5) throw new Error("row 1 doesn't look like an SKU, batch or production batch template or panel export.");
    const isExport = low.includes("created at") || low.includes("updated at");
    const col = new Map(low.map((h, i) => [h, i]));
    const rows = [];
    const stray = new Set();
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const vals = [];
      row.eachCell({ includeEmpty: true }, (c, i) => { vals[i - 1] = cellValue(c.value); });
      if (vals.every(blank)) return;
      vals.forEach((v, i) => { if (i >= headers.length || !headers[i]) { if (!blank(v)) stray.add(i + 1); } });
      const get = (h) => { const i = col.get(norm(h)); return i === undefined ? null : vals[i] ?? null; };
      rows.push({ row: n, get, raw: vals });
    });
    return { kind: kind[0], isExport, headers, rows, sheetName: ws.name, sheets: wb.worksheets.map((w) => w.name), stray: [...stray] };
  }

  // ---- checks -------------------------------------------------------------------------------
  // skip: Set of check ids the user turned off; those report nothing and mark no rows
  function checker(skip = new Set()) {
    const out = [], rowIssues = {};
    // bad: [{row, msg}] ; level "fail" | "warn"
    const add = (id, title, level, bad, detail = "") => {
      if (skip.has(id)) return;
      const uniq = new Map();
      for (const b of bad) if (!uniq.has(b.row)) uniq.set(b.row, b.msg);
      const rows = [...uniq.keys()].sort((a, b) => a - b);
      const status = rows.length ? level : "pass";
      const ex = [...uniq].slice(0, 4).map(([r, m]) => `row ${r}: ${m}`).join(" · ");
      out.push({ id, title, level, status, count: rows.length, rows: rows.slice(0, 25), detail: rows.length ? (detail ? detail + " " : "") + ex + (rows.length > 4 ? " · …" : "") : detail });
      for (const b of bad) (rowIssues[b.row] ||= []).push({ id, title, level, msg: b.msg });
    };
    // a problem with no row in this file (something missing from it): counted and listed, no rows marked
    const list = (id, title, level, items, detail = "") => {
      if (skip.has(id)) return;
      out.push({ id, title, level, status: items.length ? level : "pass", count: items.length, rows: [],
        detail: items.length ? (detail ? detail + " " : "") + items.slice(0, 6).join(" · ") + (items.length > 6 ? ` · … (${items.length} in all)` : "") : "" });
    };
    const fixed = (id, title, level, fail, detail) => { if (!skip.has(id)) out.push({ id, title, level, status: fail ? level : "pass", count: 0, rows: [], detail: fail ? detail : "" }); };
    const info = (id, title, detail) => { if (!skip.has(id)) out.push({ id, title, level: "info", status: "info", count: 0, rows: [], detail }); };
    const result = () => ({ checks: out, rowIssues, failed: out.filter((c) => c.status === "fail").length,
      warned: out.filter((c) => c.status === "warn").length, passed: out.filter((c) => c.status === "pass").length });
    return { add, list, fixed, info, result, on: (id) => !skip.has(id) };
  }

  function headerChecks(c, book) {
    const want = TEMPLATES[book.kind];
    if (book.isExport) {
      // an export is for checking what's already in encarta, not for uploading back
      c.info("H1", "Panel export", `Checked as data. It can't be uploaded as it is: encarta needs the exact Add${book.kind === "sku" ? "SKU" : book.kind === "batch" ? "Batch" : "ProductionBatch"}Template header row (no underscores, no created_at/updated_at).`);
      c.info("H3", "Sheet read", `"${book.sheetName}", ${book.rows.length} rows.`);
      return;
    }
    const same = book.headers.length === want.length && book.headers.every((h, i) => h === want[i]);
    const missing = want.filter((h) => !book.headers.includes(h)), extra = book.headers.filter((h) => h && !want.includes(h));
    // a sheet downloaded from this page carries our Check / Issues columns
    const ours = extra.length && extra.every((h) => ["Check", "Issues"].includes(h));
    c.fixed("H1", "Header row matches encarta's template exactly", "fail", !same, ours
      ? "This is a checked sheet from this page. Delete its Check and Issues columns before uploading, or encarta rejects the whole file."
      : `encarta rejects the whole file ("Wrong template uploaded").${missing.length ? ` Missing: ${missing.join(", ")}.` : ""}${extra.length ? ` Not in the template: ${extra.join(", ")}.` : ""}${!missing.length && !extra.length ? " Same names, different order or spelling." : ""}`);
    c.fixed("H2", "Values only under named columns", "warn", book.stray.length > 0, `Column${book.stray.length > 1 ? "s" : ""} ${book.stray.join(", ")} ha${book.stray.length > 1 ? "ve" : "s"} values but no header, so the upload ignores them.`);
    c.info("H3", "Sheet read", `"${book.sheetName}" (encarta reads the first sheet, whatever its name)${book.sheets.length > 1 ? `; also in the file: ${book.sheets.slice(1).join(", ")}` : ""}.`);
  }

  // SKUs defined by an SKU file in the same drop
  function skuDefsFrom(book) {
    const m = new Map();
    for (const r of book.rows) {
      const code = upper(r.get("code")); if (!code) continue;
      m.set(code, { code, active: parseBool(r.get("active")) !== false, shelfLife: num(r.get("shelf life")),
        L0inL1: num(r.get("L0inL1 Qty")), L0inL2: num(r.get("L0inL2 Qty")), L2inL3: num(r.get("L2inL3 Qty")), fromFile: true,
        base: upper(r.get("base sku code")) || null });
    }
    return m;
  }
  function batchDefsFrom(book) {
    const m = new Map();
    for (const r of book.rows) {
      const sku = upper(r.get("sku code")), code = upper(r.get("code")); if (!sku || !code) continue;
      m.set(`${sku}|${code}`, { sku_code: sku, code, price: num(r.get("price")), mfg: parseDate(r.get("packing date"))?.key || null,
        exp: parseDate(r.get("expiry date"))?.key || null, case_config: num(r.get("case config")), active: parseBool(r.get("active")) !== false, fromFile: true });
    }
    return m;
  }
  function lotDefsFrom(book) {
    return book.rows.map((r) => ({ sku: upper(r.get("sku code")), parent: upper(r.get("batch code")), code: upper(r.get("code")),
      active: parseBool(r.get("active")) !== false })).filter((l) => l.sku && l.parent && l.code);
  }
  // sku|batch keys that have at least one active production lot: encarta's, with dropped production rows applied on top
  function batchesWithLots(live, lotDefs) {
    const lots = new Map(); // sku|parent -> Set of active lot codes
    const mark = (sku, parent, code, on) => { const k = `${sku}|${parent}`; if (!lots.has(k)) lots.set(k, new Set()); on ? lots.get(k).add(code) : lots.get(k).delete(code); };
    for (const l of live.prods.values()) mark(upper(l.sku_code), l.parent, l.code, l.active !== false);
    for (const l of lotDefs) mark(l.sku, l.parent, l.code, l.active);
    return new Set([...lots].filter(([, v]) => v.size).map(([k]) => k));
  }

  // ---- SKU master --------------------------------------------------------------------------
  function checkSku(book, live, skip) {
    const c = checker(skip); headerChecks(c, book);
    const R = book.rows;
    const need = ["code", "name", "product code", "fulfillment type", "L0inL1 Qty", "L0inL2 Qty", "L2inL3 Qty", "L2 Wt", "L2 Vol"];
    c.add("S1", "Required columns are filled", "fail", R.flatMap((r) => { const miss = need.filter((h) => blank(r.get(h))); return miss.length ? [{ row: r.row, msg: `no ${miss.join(", ")}` }] : []; }),
      "encarta requires code, name, product code, fulfillment type, L0inL1, L0inL2, L2inL3, L2 Wt and L2 Vol.");
    const seen = new Map(); R.forEach((r) => { const k = upper(r.get("code")); if (k) seen.set(k, (seen.get(k) || 0) + 1); });
    c.add("S2", "No SKU code twice in the file", "fail", R.filter((r) => seen.get(upper(r.get("code"))) > 1).map((r) => ({ row: r.row, msg: upper(r.get("code")) })),
      "encarta rejects the file.");
    const qtyBad = R.flatMap((r) => ["L0inL1 Qty", "L0inL2 Qty", "L2inL3 Qty"].filter((h) => !blank(r.get(h)) && !(Number.isInteger(num(r.get(h))) && num(r.get(h)) > 0))
      .map((h) => ({ row: r.row, msg: `${h} = ${r.get(h)}` })));
    c.add("S3", "L0inL1, L0inL2 and L2inL3 are whole numbers above zero", "fail", qtyBad, "A zero L0inL2 crashes the upload (it divides by it).");
    c.add("S4", "L0inL2 is a multiple of L0inL1 (and not smaller)", "fail", R.filter((r) => {
      const a = num(r.get("L0inL1 Qty")), b = num(r.get("L0inL2 Qty"));
      return a > 0 && b > 0 && (b % a !== 0 || b < a);
    }).map((r) => ({ row: r.row, msg: `L0inL1 ${r.get("L0inL1 Qty")}, L0inL2 ${r.get("L0inL2 Qty")}` })), "encarta rejects these rows.");
    // Honasa convention: base SKU 8 digits, case SKU <base>-<L0inL2 as 4 digits>
    c.add("S5", "Case SKU code suffix equals L0inL2 (e.g. 10100002-0060 holds 60)", "fail", R.flatMap((r) => {
      const m = upper(r.get("code")).match(/^(\d+)-(\d+)$/), b = num(r.get("L0inL2 Qty"));
      return m && b > 0 && Number(m[2]) !== b ? [{ row: r.row, msg: `${upper(r.get("code"))} but L0inL2 is ${b}` }] : [];
    }));
    c.add("S6", "SKU code looks like 12345678 or 12345678-0060", "warn", R.filter((r) => upper(r.get("code")) && !/^\d{8}(-\d{4})?$/.test(upper(r.get("code"))))
      .map((r) => ({ row: r.row, msg: upper(r.get("code")) })));
    const rel = (a, b) => Math.abs(a - b) / Math.max(Math.abs(a), Math.abs(b), 1e-9);
    c.add("S7", "L0 and L1 weight/volume agree with L2 (L2 = L0 × L0inL2)", "warn", R.flatMap((r) => {
      const n2 = num(r.get("L0inL2 Qty")), n1 = num(r.get("L0inL1 Qty")), msgs = [];
      for (const k of ["Wt", "Vol"]) {
        const l0 = num(r.get(`L0 ${k}`)), l1 = num(r.get(`L1 ${k}`)), l2 = num(r.get(`L2 ${k}`));
        if (l0 > 0 && l2 > 0 && n2 > 0 && rel(l0 * n2, l2) > 0.02) msgs.push(`L0 ${k} ${l0} × ${n2} = ${+(l0 * n2).toFixed(3)}, L2 ${k} is ${l2}`);
        if (l0 > 0 && l1 > 0 && n1 > 0 && rel(l0 * n1, l1) > 0.02) msgs.push(`L1 ${k} ${l1} isn't L0 × ${n1}`);
      }
      return msgs.length ? [{ row: r.row, msg: msgs.join("; ") }] : [];
    }), "Blank L0/L1 values are fine: encarta fills them from L2.");
    c.add("S8", "L2 weight and volume above zero", "warn", R.filter((r) => !blank(r.get("L2 Wt")) && (num(r.get("L2 Wt")) <= 0 || num(r.get("L2 Vol")) <= 0))
      .map((r) => ({ row: r.row, msg: `L2 Wt ${r.get("L2 Wt")}, L2 Vol ${r.get("L2 Vol")}` })), "Putaway sizes bins by volume when there's no best fit.");
    c.add("S9", "Gross weight isn't below net weight", "warn", R.flatMap((r) => ["L0", "L1", "L2"].filter((l) => {
      const g = num(r.get(`${l} Gross Wt kg`)), w = num(r.get(`${l} Wt`)); return g > 0 && w > 0 && g < w * 0.999;
    }).map((l) => ({ row: r.row, msg: `${l} gross ${r.get(`${l} Gross Wt kg`)} < net ${r.get(`${l} Wt`)}` }))));
    // a cell can hold several EANs separated by commas
    const badEans = (v) => String(v).split(/[,;\s]+/).filter(Boolean).filter((e) => !eanOk(e));
    c.add("S10", "L0 EAN is a valid barcode (8, 12, 13 or 14 digits, correct check digit)", "warn",
      R.filter((r) => !blank(r.get("L0 EAN")) && badEans(r.get("L0 EAN")).length).map((r) => ({ row: r.row, msg: badEans(r.get("L0 EAN")).join(", ") })));
    c.add("S11", "Shelf life is set (whole days)", "warn", R.filter((r) => !(Number.isInteger(num(r.get("shelf life"))) && num(r.get("shelf life")) > 0))
      .map((r) => ({ row: r.row, msg: blank(r.get("shelf life")) ? "blank" : String(r.get("shelf life")) })), "Batch checks compare expiry with it.");
    c.add("S12", "Active is TRUE or FALSE", "fail", R.filter((r) => parseBool(r.get("active")) === "bad").map((r) => ({ row: r.row, msg: String(r.get("active")) })));
    if (live.plants) c.add("S13", "Plant code exists for this principal", "fail", R.filter((r) => !blank(r.get("plant code")) && !live.plants.has(upper(r.get("plant code"))))
      .map((r) => ({ row: r.row, msg: upper(r.get("plant code")) })), "encarta rejects the file.");
    c.add("S14", "Product code is in the product master", "warn", R.filter((r) => !blank(r.get("product code")) && !live.products.has(upper(r.get("product code"))))
      .map((r) => ({ row: r.row, msg: upper(r.get("product code")) })), "Add the product first if the upload complains.");
    const inFile = new Set(R.map((r) => upper(r.get("code"))));
    // base from the base_sku_code column (exports have it), else the code's prefix
    c.add("S15", "A case SKU's base SKU exists (in this file or encarta)", "warn", R.flatMap((r) => {
      const code = upper(r.get("code")), col = upper(r.get("base sku code")), m = code.match(/^(\d+)-\d+$/);
      const base = col && col !== code ? col : m?.[1];
      return base && !inFile.has(base) && !live.skus.has(base) ? [{ row: r.row, msg: `${code}: no ${base}` }] : [];
    }));
    c.add("S18", "Base SKU column agrees with the code (12345678-0060 → 12345678)", "warn", R.flatMap((r) => {
      const code = upper(r.get("code")), col = upper(r.get("base sku code")), m = code.match(/^(\d+)-\d+$/);
      return col && m && col !== m[1] ? [{ row: r.row, msg: `${code} has base ${col}` }] : [];
    }));
    c.add("S16", "Existing SKUs keep their case configuration", "warn", R.flatMap((r) => {
      const ex = live.skus.get(upper(r.get("code"))); if (!ex) return [];
      const ch = [["L0inL1", "L0inL1 Qty"], ["L0inL2", "L0inL2 Qty"], ["L2inL3", "L2inL3 Qty"]]
        .filter(([k, h]) => ex[k] && num(r.get(h)) > 0 && Number(ex[k]) !== num(r.get(h))).map(([k, h]) => `${k} ${ex[k]} → ${r.get(h)}`);
      return ch.length ? [{ row: r.row, msg: `${upper(r.get("code"))}: ${ch.join(", ")}` }] : [];
    }), "These rows overwrite an SKU already in encarta. Stock, open orders and batches use the old pack sizes.");
    const exist = R.filter((r) => live.skus.has(upper(r.get("code")))).length;
    c.info("S17", "New vs existing", `${R.length - exist} new SKUs, ${exist} already in encarta (they will be updated).`);
    return c.result();
  }

  // ---- batch master ------------------------------------------------------------------------
  function checkBatchRow(code, priceV, mfgKey) {
    const m = code.match(BATCH_RULE);
    if (!m) return { format: false };
    const out = { format: true, yy: m[1], mon: m[2], price: m[3] };
    if (mfgKey) out.ymOk = mfgKey.slice(2, 4) === m[1] && MONTHS[Number(mfgKey.slice(5, 7)) - 1] === m[2];
    if (priceV !== null && !isNaN(priceV)) out.priceOk = Number(m[3]) === priceV;
    return out;
  }

  function checkBatch(book, live, skuDefs, skip, lotDefs = []) {
    const c = checker(skip); headerChecks(c, book);
    const R = book.rows, T = today();
    const skuOf = (code) => skuDefs.get(code) || live.skus.get(code);
    const P = R.map((r) => {
      const rawCode = String(r.get("code") ?? ""), code = upper(rawCode);
      return { r, sku: upper(r.get("sku code")), rawCode, code, price: num(r.get("price")), cc: num(r.get("case config")),
        mfg: parseDate(r.get("packing date")), exp: parseDate(r.get("expiry date")), active: parseBool(r.get("active")) };
    });
    c.add("B1", "SKU code, code, price, packing date and expiry date are filled", "fail", P.flatMap((p) => {
      const miss = [["sku code", p.sku], ["code", p.code], ["price", p.price !== null], ["packing date", p.mfg], ["expiry date", p.exp]].filter(([, v]) => !v).map(([h]) => h);
      return miss.length ? [{ row: p.r.row, msg: `no ${miss.join(", ")}` }] : [];
    }), "encarta only requires sku code and code, but the batch code rule and FEFO need the rest.");
    const dup = new Map(); P.forEach((p) => { const k = `${p.sku}|${p.code}`; dup.set(k, (dup.get(k) || 0) + 1); });
    c.add("B2", "No SKU + batch code twice in the file", "fail", P.filter((p) => p.code && dup.get(`${p.sku}|${p.code}`) > 1).map((p) => ({ row: p.r.row, msg: `${p.sku} ${p.code}` })), "encarta rejects the file.");
    c.add("B3", "SKU exists (in an SKU file dropped with this one, or encarta)", "fail", P.filter((p) => p.sku && !skuOf(p.sku)).map((p) => ({ row: p.r.row, msg: p.sku })),
      book.isExport ? "Orphan batches: their SKU no longer exists in encarta." : "encarta rejects the file.");
    c.add("B4", "SKU is active", "warn", P.filter((p) => skuOf(p.sku) && skuOf(p.sku).active === false).map((p) => ({ row: p.r.row, msg: p.sku })));
    const rule = P.map((p) => ({ p, k: p.code ? checkBatchRow(p.code, p.price, p.mfg?.key) : null }));
    c.add("B5", "Batch code is YY + month + price, e.g. 26JAN499", "fail", rule.filter(({ p, k }) => k && !k.format).map(({ p }) => ({ row: p.r.row, msg: p.code })),
      "Two-digit manufacture year, three-letter month in capitals (JAN…DEC), then the price in digits.");
    c.add("B6", "Batch code is already upper case with no spaces", "warn", P.filter((p) => p.rawCode && (p.rawCode !== p.rawCode.trim().toUpperCase() || /\s/.test(p.rawCode.trim())))
      .map((p) => ({ row: p.r.row, msg: JSON.stringify(p.rawCode) })), "encarta trims and upper-cases it, so it lands right, but the source sheet is off.");
    c.add("B7", "Code's year and month match the packing date", "fail", rule.filter(({ k }) => k?.format && k.ymOk === false)
      .map(({ p, k }) => ({ row: p.r.row, msg: `${p.code} says ${k.mon} 20${k.yy}, packing date is ${p.mfg.key}` })));
    c.add("B8", "Code's price matches the price column", "fail", rule.filter(({ k }) => k?.format && k.priceOk === false)
      .map(({ p, k }) => ({ row: p.r.row, msg: `${p.code} says ${k.price}, price is ${p.price}` })));
    c.add("B23", "Price in the code has no leading zero (26JAN499, not 26JAN0499)", "warn", rule.filter(({ k }) => k?.format && /^0\d/.test(k.price))
      .map(({ p }) => ({ row: p.r.row, msg: p.code })));
    c.add("B9", "Packing and expiry dates are dates encarta can read", "fail", P.filter((p) => p.mfg?.bad || p.exp?.bad)
      .map((p) => ({ row: p.r.row, msg: [p.mfg?.bad && `packing "${p.r.get("packing date")}"`, p.exp?.bad && `expiry "${p.r.get("expiry date")}"`].filter(Boolean).join(", ") })),
      "Use a real date or YYYY-MM-DD / DD/MM/YYYY text.");
    c.add("B10", "Expiry is after the packing date", "fail", P.filter((p) => p.mfg?.key && p.exp?.key && p.exp.key <= p.mfg.key)
      .map((p) => ({ row: p.r.row, msg: `${p.mfg.key} → ${p.exp.key}` })), "The batch upload doesn't check this, so a bad pair goes straight in.");
    c.add("B11", "Price is above zero", "fail", P.filter((p) => p.price !== null && !(p.price > 0)).map((p) => ({ row: p.r.row, msg: String(p.r.get("price")) })));
    c.add("B12", "Case config equals the SKU's L0inL2", "fail", P.filter((p) => p.cc !== null && skuOf(p.sku)?.L0inL2 && p.cc !== Number(skuOf(p.sku).L0inL2))
      .map((p) => ({ row: p.r.row, msg: `${p.sku}: case config ${p.cc}, L0inL2 ${skuOf(p.sku).L0inL2}${skuOf(p.sku).fromFile ? " (in the SKU file you dropped)" : ""}` })));
    // the case config written into a case SKU's code: 10100002-0060 -> 60
    const codeCc = (sku) => { const m = sku.match(/^\d+-(\d+)$/); return m ? Number(m[1]) : null; };
    c.add("B22", "Case config equals the one in the SKU code (10100002-0060 → 60)", "fail", P.filter((p) => p.cc !== null && codeCc(p.sku) !== null && p.cc !== codeCc(p.sku))
      .map((p) => ({ row: p.r.row, msg: `${p.sku}: case config ${p.cc}, code says ${codeCc(p.sku)}` })));
    c.add("B13", "Case config is filled on case-SKU batches", "warn", P.filter((p) => p.cc === null && /-\d+$/.test(p.sku)).map((p) => ({ row: p.r.row, msg: p.sku })));
    c.add("B14", "Expiry minus packing is close to the SKU's shelf life (±31 days)", "warn", P.filter((p) => {
      const sl = skuOf(p.sku)?.shelfLife; return sl && p.mfg?.key && p.exp?.key && Math.abs(days(p.mfg.key, p.exp.key) - sl) > 31;
    }).map((p) => ({ row: p.r.row, msg: `${days(p.mfg.key, p.exp.key)} days, shelf life ${skuOf(p.sku).shelfLife}${skuOf(p.sku).fromFile ? " (SKU file)" : ""}` })));
    c.add("B15", "Packing date isn't in the future", "warn", P.filter((p) => p.mfg?.key && p.mfg.key > T).map((p) => ({ row: p.r.row, msg: p.mfg.key })));
    c.add("B16", "Batch isn't expired already", "warn", P.filter((p) => p.exp?.key && p.exp.key <= T).map((p) => ({ row: p.r.row, msg: p.exp.key })));
    c.add("B17", "No vendor (production) lot of this SKU already uses this code", "fail", P.filter((p) => live.prodCodes.has(`${p.sku}|${p.code}`))
      .map((p) => ({ row: p.r.row, msg: `${p.sku} ${p.code} is a production lot of ${[...live.prodCodes.get(`${p.sku}|${p.code}`)].join(", ")}` })),
      "The same code in both masters makes stock uploads and scans ambiguous.");
    c.add("B18", "Existing batches keep their price, dates and case config", "warn", P.flatMap((p) => {
      const ex = live.batches.get(`${p.sku}|${p.code}`); if (!ex) return [];
      const ch = [];
      if (p.price !== null && ex.price !== null && Number(ex.price) !== p.price) ch.push(`price ${ex.price} → ${p.price}`);
      if (p.mfg?.key && ex.mfg && ex.mfg !== p.mfg.key) ch.push(`packing ${ex.mfg} → ${p.mfg.key}`);
      if (p.exp?.key && ex.exp && ex.exp !== p.exp.key) ch.push(`expiry ${ex.exp} → ${p.exp.key}`);
      if (p.cc !== null && ex.case_config && Number(ex.case_config) !== p.cc) ch.push(`case config ${ex.case_config} → ${p.cc}`);
      return ch.length ? [{ row: p.r.row, msg: `${p.sku} ${p.code}: ${ch.join(", ")}` }] : [];
    }), "These rows overwrite a batch already in encarta, including any stock already on it.");
    c.add("B19", "Active is TRUE or FALSE", "fail", P.filter((p) => p.active === "bad").map((p) => ({ row: p.r.row, msg: String(p.r.get("active")) })));
    const hasLot = batchesWithLots(live, lotDefs);
    c.add("B24", "Every batch has a production batch (in a production file dropped with this one, or encarta)", "fail",
      P.filter((p) => p.sku && p.code && p.active !== false && skuOf(p.sku) && !hasLot.has(`${p.sku}|${p.code}`)).map((p) => ({ row: p.r.row, msg: `${p.sku} ${p.code}` })),
      book.isExport ? "These batches have no active production batch in encarta." : "Upload a production batch for each one, or drop the production batch file with this one to check them together.");
    const exist = P.filter((p) => live.batches.has(`${p.sku}|${p.code}`)).length;
    c.info("B20", "New vs existing", `${P.length - exist} new batches, ${exist} already in encarta (they will be updated).`);

    // B21 a base SKU and all its case SKUs (10100002, 10100002-0045, 10100002-0060) carry the same
    // active batch codes. Batches = encarta's, with this file's rows applied on top.
    const baseOf = (code) => {
      const d = skuDefs.get(code)?.base || live.skus.get(code)?.base;
      if (d) return d;
      const m = code.match(/^(\d+)-\d+$/);
      return m ? m[1] : code;
    };
    const families = new Map(); // base -> Set of active member SKUs
    const join = (code, active) => { if (!active) return; const b = baseOf(code); if (!families.has(b)) families.set(b, new Set()); families.get(b).add(code); };
    for (const [code, s] of live.skus) if (!skuDefs.has(code)) join(code, s.active);
    for (const [code, s] of skuDefs) join(code, s.active);
    const have = new Map(); // sku -> Set of active batch codes after this upload
    const mark = (sku, code, on) => { if (!have.has(sku)) have.set(sku, new Set()); on ? have.get(sku).add(code) : have.get(sku).delete(code); };
    for (const b of live.batches.values()) if (b.active !== false) mark(upper(b.sku_code), b.code, true);
    for (const p of P) if (p.sku && p.code) mark(p.sku, p.code, p.active !== false);
    const gaps = []; // {base, sku, code}
    for (const [base, members] of families) {
      if (members.size < 2) continue;
      const all = new Set([...members].flatMap((m) => [...(have.get(m) || [])]));
      for (const code of all) for (const m of members) if (!have.get(m)?.has(code)) gaps.push({ base, sku: m, code });
    }
    const gapBy = new Map(); // base|code -> skus missing it
    for (const g of gaps) { const k = `${g.base}|${g.code}`; if (!gapBy.has(k)) gapBy.set(k, []); gapBy.get(k).push(g.sku); }
    const fileKeys = new Set(P.filter((p) => p.active !== false).map((p) => `${baseOf(p.sku)}|${p.code}`));
    // only talk about the families this file touches
    const touched = new Set(P.filter((p) => p.sku).map((p) => baseOf(p.sku)));
    const outside = [...gapBy.keys()].filter((k) => !fileKeys.has(k) && touched.has(k.split("|")[0]));
    const famBad = new Set(gaps.map((g) => g.base).filter((b) => touched.has(b)));
    c.add("B21", "Base SKU and its case SKUs all have the same batches", "fail", P.flatMap((p) => {
      if (!p.sku || !p.code || p.active === false) return [];
      const missing = gapBy.get(`${baseOf(p.sku)}|${p.code}`);
      return missing ? [{ row: p.r.row, msg: `${p.code} isn't on ${missing.slice(0, 4).join(", ")}${missing.length > 4 ? ` (+${missing.length - 4} more)` : ""}` }] : [];
    }), !famBad.size ? "" : `${famBad.size} SKU famil${famBad.size === 1 ? "y has" : "ies have"} batches missing on some members${outside.length
      ? `; ${outside.length} of those gaps are in encarta already and not touched by this file (e.g. ${outside.slice(0, 3).map((k) => { const [b, code] = k.split("|"); return `${code} missing on ${gapBy.get(k).slice(0, 2).join(", ")}`; }).join("; ")})` : ""}.`);

    // ---- fix sheet: rows that put the obvious problems right, in AddBatchTemplate form ----
    const fixes = new Map(), why = new Map(), review = [], skipped = [];
    const fromRow = (p) => ({ code: p.code, price: p.price, mfg: p.mfg?.key || null, exp: p.exp?.key || null, cc: p.cc,
      name: p.r.get("batch name"), desc: p.r.get("batch desc"), lot: p.r.get("price lot"), factory: p.r.get("source factory"),
      destruction: num(p.r.get("destruction days")), tag1: p.r.get("tag1"), sku: p.sku });
    const fromLive = (b) => ({ code: b.code, price: b.price === null ? null : Number(b.price), mfg: b.mfg, exp: b.exp, cc: b.case_config, sku: upper(b.sku_code) });
    // only copy a batch that is itself right, or the copy spreads the problem
    const sound = (b) => {
      if (!b?.mfg || !b.exp || b.exp <= b.mfg || !(b.price > 0)) return false;
      const k = checkBatchRow(b.code, b.price, b.mfg);
      return k.format && k.ymOk !== false && k.priceOk !== false;
    };
    const fixRow = (sku, b, cc) => ({ "sku code": sku, code: b.code, "batch name": b.name ?? null, "batch desc": b.desc ?? null,
      "price lot": b.lot ?? null, price: b.price, "source factory": b.factory ?? null, "case config": cc ?? null,
      "packing date": b.mfg, "expiry date": b.exp, "destruction days": b.destruction ?? null, active: true, tag1: b.tag1 ?? null });
    // case config a SKU's batches should carry: the code's number, else (case SKUs only) L0inL2
    const ccFor = (sku) => codeCc(sku) ?? null;
    // each kind of fix row follows the check that finds its problem: no fix for a check that's off
    for (const [k, missing] of c.on("B21") ? gapBy : []) {
      const [base, code] = k.split("|");
      if (!touched.has(base)) continue;
      const fileSrc = P.find((p) => p.code === code && p.active !== false && baseOf(p.sku) === base && skuOf(p.sku));
      const liveSrc = !fileSrc && [...(families.get(base) || [])].map((m) => live.batches.get(`${m}|${code}`)).find((b) => b && b.active !== false);
      const src = fileSrc ? fromRow(fileSrc) : liveSrc ? fromLive(liveSrc) : null;
      if (!sound(src)) { skipped.push({ sku: missing.join(", "), code, why: "The batch breaks the code rule or its dates are off. Fix the batch first, then its copies." }); continue; }
      // a source that exists only in this file goes in too, so the fix sheet works on its own
      if (fileSrc && !live.batches.has(`${fileSrc.sku}|${code}`) && !fixes.has(`${fileSrc.sku}|${code}`)) {
        fixes.set(`${fileSrc.sku}|${code}`, fixRow(fileSrc.sku, src, fileSrc.cc ?? ccFor(fileSrc.sku)));
        why.set(`${fileSrc.sku}|${code}`, "The batch itself, from your file, so this sheet uploads on its own");
      }
      for (const m of missing) {
        // creating a batch with a code that is already one of m's vendor lots makes that code ambiguous
        if (live.prodCodes.has(`${m}|${code}`)) { skipped.push({ sku: m, code, why: `${code} is already a production lot of ${m} (under ${[...live.prodCodes.get(`${m}|${code}`)].join(", ")}).` }); continue; }
        fixes.set(`${m}|${code}`, fixRow(m, src, ccFor(m)));
        why.set(`${m}|${code}`, `Copy of ${src.sku} ${code}, so ${base} and its case SKUs carry the same batches`);
      }
    }
    for (const p of P) {
      // only correct rows that are otherwise right; a row with other problems needs a person
      if (!p.code || !skuOf(p.sku) || p.cc === null || p.active === false || !sound(fromRow(p)) || live.prodCodes.has(`${p.sku}|${p.code}`)) continue;
      const want = ccFor(p.sku) ?? (/-\d+$/.test(p.sku) ? Number(skuOf(p.sku).L0inL2) || null : null);
      if (want === null || p.cc === want || !c.on(codeCc(p.sku) !== null ? "B22" : "B12")) continue;
      const k = `${p.sku}|${p.code}`;
      fixes.set(k, fixRow(p.sku, fromRow(p), want));
      why.set(k, `Case config ${p.cc} → ${want}${codeCc(p.sku) !== null ? " (the number in the SKU code)" : " (the SKU's L0inL2)"}`);
    }
    for (const { p, k } of rule) {
      if (!k?.format || k.ymOk !== false || !skuOf(p.sku) || !c.on("B7")) continue;
      const mfg = `20${k.yy}-${String(MONTHS.indexOf(k.mon) + 1).padStart(2, "0")}-01`;
      review.push({ ...fixRow(p.sku, fromRow(p), p.cc ?? ccFor(p.sku)), "packing date": mfg, was: p.mfg.key,
        why: `Code says ${k.mon} 20${k.yy}; packing date moved to the 1st of that month. Check the expiry too, then copy the row into Sheet1. If the date is right, the code is wrong, and a new code is a new batch.` });
    }
    return { ...c.result(), fixes: { rows: [...fixes.entries()].map(([k, r]) => ({ ...r, _why: why.get(k) })), review, skipped } };
  }

  // ---- production batch master --------------------------------------------------------------
  function checkProduction(book, live, skuDefs, batchDefs, skip, lotDefs = []) {
    const c = checker(skip); headerChecks(c, book);
    const R = book.rows, T = today();
    const skuOf = (code) => skuDefs.get(code) || live.skus.get(code);
    const parentOf = (sku, code) => batchDefs.get(`${sku}|${code}`) || live.batches.get(`${sku}|${code}`);
    const P = R.map((r) => {
      const rawCode = String(r.get("code") ?? "");
      return { r, sku: upper(r.get("sku code")), parent: upper(r.get("batch code")), rawCode, code: upper(rawCode), price: num(r.get("price")),
        mfg: parseDate(r.get("packing date")), exp: parseDate(r.get("expiry date")), active: parseBool(r.get("active")) };
    });
    c.add("P1", "Batch code, SKU code and code are filled", "fail", P.flatMap((p) => {
      const miss = [["batch code", p.parent], ["sku code", p.sku], ["code", p.code]].filter(([, v]) => !v).map(([h]) => h);
      return miss.length ? [{ row: p.r.row, msg: `no ${miss.join(", ")}` }] : [];
    }), "encarta requires all three.");
    c.add("P2", "Price, packing date and expiry date are filled", "warn", P.flatMap((p) => {
      const miss = [["price", p.price !== null], ["packing date", p.mfg], ["expiry date", p.exp]].filter(([, v]) => !v).map(([h]) => h);
      return miss.length ? [{ row: p.r.row, msg: `no ${miss.join(", ")}` }] : [];
    }));
    const dup = new Map(); P.forEach((p) => { const k = `${p.parent}|${p.sku}|${p.code}`; dup.set(k, (dup.get(k) || 0) + 1); });
    c.add("P3", "No batch code + SKU + code twice in the file", "fail", P.filter((p) => p.code && dup.get(`${p.parent}|${p.sku}|${p.code}`) > 1)
      .map((p) => ({ row: p.r.row, msg: `${p.sku} ${p.parent} ${p.code}` })), "encarta rejects the file.");
    c.add("P4", "SKU exists", "fail", P.filter((p) => p.sku && !skuOf(p.sku)).map((p) => ({ row: p.r.row, msg: p.sku })),
      book.isExport ? "Orphan lots: their SKU no longer exists in encarta." : "encarta rejects the file.");
    c.add("P5", "Parent batch exists for that SKU (in a batch file dropped with this one, or encarta)", "fail",
      P.filter((p) => p.sku && p.parent && skuOf(p.sku) && !parentOf(p.sku, p.parent)).map((p) => ({ row: p.r.row, msg: `${p.sku} ${p.parent}` })),
      "encarta rejects the file. Upload the batch master first.");
    const rule = P.map((p) => ({ p, k: p.parent ? checkBatchRow(p.parent, p.price, p.mfg?.key) : null }));
    c.add("P6", "Parent batch code is YY + month + price, e.g. 26JAN499", "fail", rule.filter(({ k }) => k && !k.format).map(({ p }) => ({ row: p.r.row, msg: p.parent })));
    c.add("P7", "Price matches the price in the parent batch code", "fail", rule.filter(({ k }) => k?.format && k.priceOk === false)
      .map(({ p, k }) => ({ row: p.r.row, msg: `${p.parent} says ${k.price}, price is ${p.price}` })));
    c.add("P8", "Price matches the parent batch's price", "fail", P.filter((p) => { const b = parentOf(p.sku, p.parent); return b && b.price !== null && p.price !== null && Number(b.price) !== p.price; })
      .map((p) => ({ row: p.r.row, msg: `${p.price} vs batch ${parentOf(p.sku, p.parent).price}` })));
    c.add("P9", "Packing and expiry dates are dates encarta can read", "fail", P.filter((p) => p.mfg?.bad || p.exp?.bad)
      .map((p) => ({ row: p.r.row, msg: [p.mfg?.bad && `packing "${p.r.get("packing date")}"`, p.exp?.bad && `expiry "${p.r.get("expiry date")}"`].filter(Boolean).join(", ") })));
    c.add("P10", "Expiry is on or after the packing date", "fail", P.filter((p) => p.mfg?.key && p.exp?.key && p.exp.key < p.mfg.key)
      .map((p) => ({ row: p.r.row, msg: `${p.mfg.key} → ${p.exp.key}` })), "encarta rejects these.");
    c.add("P11", "Packing month matches the parent batch code's month", "warn", rule.filter(({ k }) => k?.format && k.ymOk === false)
      .map(({ p, k }) => ({ row: p.r.row, msg: `${p.parent} says ${k.mon} 20${k.yy}, packing date is ${p.mfg.key}` })));
    c.add("P12", "Dates match the parent batch's dates", "warn", P.flatMap((p) => {
      const b = parentOf(p.sku, p.parent); if (!b) return [];
      const ch = [];
      if (p.mfg?.key && b.mfg && b.mfg !== p.mfg.key) ch.push(`packing ${p.mfg.key} vs ${b.mfg}`);
      if (p.exp?.key && b.exp && b.exp !== p.exp.key) ch.push(`expiry ${p.exp.key} vs ${b.exp}`);
      return ch.length ? [{ row: p.r.row, msg: ch.join(", ") }] : [];
    }));
    c.add("P13", "Production code isn't the parent batch code itself", "fail", P.filter((p) => p.code && p.code === p.parent).map((p) => ({ row: p.r.row, msg: p.code })),
      "A lot with its parent's code makes the batch ambiguous in stock uploads.");
    const distCodes = new Set([...live.batches.keys(), ...batchDefs.keys()]);
    c.add("P14", "Production code isn't also a distribution batch code of that SKU", "fail", P.filter((p) => p.code && p.code !== p.parent && distCodes.has(`${p.sku}|${p.code}`))
      .map((p) => ({ row: p.r.row, msg: `${p.sku} ${p.code}` })), "Same code in both masters is ambiguous for stock uploads and scans.");
    const lotParents = new Map();
    // blank lot codes are P1's problem; grouping them here would pair unrelated rows
    P.filter((p) => p.code).forEach((p) => { const k = `${p.sku}|${p.code}`; if (!lotParents.has(k)) lotParents.set(k, new Set(live.prodCodes.get(k) || [])); lotParents.get(k).add(p.parent); });
    c.add("P15", "One vendor lot belongs to one parent batch", "warn", P.filter((p) => p.code && lotParents.get(`${p.sku}|${p.code}`).size > 1)
      .map((p) => ({ row: p.r.row, msg: `${p.sku} ${p.code} under ${[...lotParents.get(`${p.sku}|${p.code}`)].join(", ")}` })));
    c.add("P16", "Production code is upper case with no spaces", "warn", P.filter((p) => p.rawCode && (p.rawCode !== p.rawCode.trim().toUpperCase() || /\s/.test(p.rawCode.trim())))
      .map((p) => ({ row: p.r.row, msg: JSON.stringify(p.rawCode) })), "encarta upper-cases and trims it.");
    c.add("P17", "Batch isn't expired already", "warn", P.filter((p) => p.exp?.key && p.exp.key <= T).map((p) => ({ row: p.r.row, msg: p.exp.key })));
    c.add("P18", "Existing lots keep their price and dates", "warn", P.flatMap((p) => {
      const ex = live.prods.get(`${p.sku}|${p.parent}|${p.code}`); if (!ex) return [];
      const ch = [];
      if (p.price !== null && ex.price !== null && Number(ex.price) !== p.price) ch.push(`price ${ex.price} → ${p.price}`);
      if (p.mfg?.key && ex.mfg && ex.mfg !== p.mfg.key) ch.push(`packing ${ex.mfg} → ${p.mfg.key}`);
      if (p.exp?.key && ex.exp && ex.exp !== p.exp.key) ch.push(`expiry ${ex.exp} → ${p.exp.key}`);
      return ch.length ? [{ row: p.r.row, msg: ch.join(", ") }] : [];
    }), "These rows overwrite a lot already in encarta.");
    c.add("P19", "Active is TRUE or FALSE", "fail", P.filter((p) => p.active === "bad").map((p) => ({ row: p.r.row, msg: String(p.r.get("active")) })));
    // P21 one production code of one SKU has one expiry, under whichever parent batch: this file's rows,
    // plus encarta's lots of that code that this file doesn't overwrite
    const expBy = new Map(); // sku|code -> Map expiry -> where
    const note = (k, exp, where) => { if (!expBy.has(k)) expBy.set(k, new Map()); const m = expBy.get(k); if (!m.has(exp)) m.set(exp, []); m.get(exp).push(where); };
    const inFile = new Set(P.map((p) => `${p.sku}|${p.parent}|${p.code}`));
    for (const p of P) if (p.sku && p.code && p.exp?.key) note(`${p.sku}|${p.code}`, p.exp.key, `row ${p.r.row}`);
    const lotKeys = new Set(P.filter((p) => p.sku && p.code).map((p) => `${p.sku}|${p.code}`));
    for (const [k, l] of live.prods) {
      const sc = `${upper(l.sku_code)}|${l.code}`;
      if (lotKeys.has(sc) && !inFile.has(k) && l.exp) note(sc, l.exp, `encarta under ${l.parent}`);
    }
    c.add("P21", "One production code of an SKU has one expiry date", "fail", P.filter((p) => p.sku && p.code && expBy.get(`${p.sku}|${p.code}`)?.size > 1)
      .map((p) => ({ row: p.r.row, msg: `${p.sku} ${p.code}: ${[...expBy.get(`${p.sku}|${p.code}`)].map(([e, w]) => `${e} (${w.slice(0, 3).join(", ")}${w.length > 3 ? ", …" : ""})`).join(" vs ")}` })),
      "The same vendor lot can't expire on two dates. Pick the right one and use it on every row.");
    // P22 every active batch of the SKUs in this file needs a production batch, after this file goes in
    const hasLot = batchesWithLots(live, lotDefs);
    const skus = new Set(P.map((p) => p.sku).filter(Boolean));
    const parents = new Map(); // sku|code -> active?
    for (const b of live.batches.values()) if (skus.has(upper(b.sku_code))) parents.set(`${upper(b.sku_code)}|${b.code}`, b.active !== false);
    for (const [k, b] of batchDefs) if (skus.has(b.sku_code)) parents.set(k, b.active);
    c.list("P22", "Every batch of the SKUs in this file has a production batch", "fail",
      [...parents].filter(([k, on]) => on && !hasLot.has(k)).map(([k]) => k.replace("|", " ")).sort(),
      "These active batches (in encarta, or in a batch file dropped with this one) still have no production batch after this file:");
    const exist = P.filter((p) => live.prods.has(`${p.sku}|${p.parent}|${p.code}`)).length;
    c.info("P20", "New vs existing", `${P.length - exist} new lots, ${exist} already in encarta (they will be updated).`);
    return c.result();
  }

  // ---- annotated workbook ---------------------------------------------------------------------
  async function annotated(buffer, rowIssues) {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer);
    const ws = wb.worksheets[0];
    let width = 0;
    ws.getRow(1).eachCell({ includeEmpty: false }, (c, i) => { width = Math.max(width, i); });
    const cR = width + 1, cI = width + 2;
    ws.getCell(1, cR).value = "Check"; ws.getCell(1, cI).value = "Issues";
    ws.getCell(1, cR).font = ws.getCell(1, cI).font = { bold: true };
    ws.getColumn(cR).width = 8; ws.getColumn(cI).width = 90;
    const fill = (argb) => ({ type: "pattern", pattern: "solid", fgColor: { argb } });
    ws.eachRow((row, n) => {
      if (n === 1) return;
      const iss = rowIssues[n] || [];
      const hard = iss.some((i) => i.level === "fail");
      row.getCell(cR).value = !iss.length ? "OK" : hard ? "HARD" : "SOFT";
      row.getCell(cI).value = iss.map((i) => `[${i.level === "fail" ? "hard" : "soft"}] ${i.title}: ${i.msg}`).join("; ") || null;
      // a loaded workbook shares one style object between cells of the same format (all the
      // date cells, say), so copy the style before filling or every such cell turns red
      if (iss.length) for (let c = 1; c <= cI; c++) { const cell = row.getCell(c); cell.style = { ...cell.style, fill: fill(hard ? "FFF4C7C3" : "FFFFF0B3") }; }
    });
    return wb.xlsx.writeBuffer();
  }

  // the fix rows as an AddBatchTemplate workbook: Sheet1 uploads as it is, the rest explains
  async function fixBook(f) {
    const wb = new ExcelJS.Workbook(), H = TEMPLATES.batch;
    const sheet = (name, headers, rows, widths) => {
      const ws = wb.addWorksheet(name, { views: [{ state: "frozen", ySplit: 1 }] });
      ws.addRow(headers); ws.getRow(1).font = { bold: true };
      rows.forEach((r) => ws.addRow(headers.map((h) => r[h] ?? null)));
      headers.forEach((h, i) => { ws.getColumn(i + 1).width = widths?.[h] || Math.max(10, Math.min(30, h.length + 4)); });
      return ws;
    };
    sheet("Sheet1", H, f.rows, { "sku code": 16, code: 14 });
    sheet("Why", ["sku code", "code", "why"], f.rows.map((r) => ({ ...r, why: r._why })), { why: 90 });
    if (f.review.length) sheet("Review first", [...H, "was", "why"], f.review, { why: 110, was: 12 });
    if (f.skipped.length) sheet("Not fixed", ["sku", "code", "why"], f.skipped, { sku: 50, why: 90 });
    return wb.xlsx.writeBuffer();
  }

  // the batch checks over every batch encarta holds for a principal, as if it were an export;
  // the fix sheet is kept for /api/masters/fixes like a dropped file's
  async function liveBatchCheck(principal) {
    const live = await loadLive(principal);
    const cols = { "sku code": "sku_code", code: "code", price: "price", "case config": "case_config", "packing date": "mfg", "expiry date": "exp", active: "active" };
    const rows = [...live.batches.values()].map((b, i) => ({ row: i + 2, get: (h) => { const k = cols[norm(h)]; return k ? b[k] ?? null : null; } }));
    const v = checkBatch({ kind: "batch", isExport: true, headers: [], rows, sheetName: "encarta", sheets: [], stray: [] }, live, new Map());
    const token = crypto.randomBytes(8).toString("hex");
    checked.set(token, { buffer: null, name: `live_batches_${principal}`, rowIssues: v.rowIssues, fixes: v.fixes, at: Date.now() });
    return { token, checks: v.checks, fixes: { rows: v.fixes.rows.length, review: v.fixes.review.length, skipped: v.fixes.skipped.length } };
  }

  // every check each kind can run, read off a dry run over an empty sheet so the list can't
  // drift from the code. Plants given so S13 shows up.
  let catalogCache = null;
  function catalog() {
    if (catalogCache) return catalogCache;
    const live = { skus: new Map(), batches: new Map(), prods: new Map(), prodCodes: new Map(), products: new Set(), plants: new Set() };
    const book = (kind) => ({ kind, isExport: false, headers: TEMPLATES[kind], rows: [], sheetName: "", sheets: [], stray: [] });
    const run = { sku: () => checkSku(book("sku"), live), batch: () => checkBatch(book("batch"), live, new Map()),
      production: () => checkProduction(book("production"), live, new Map(), new Map()) };
    catalogCache = Object.entries(run).map(([kind, f]) => ({ kind, name: KIND_NAME[kind],
      checks: f().checks.map(({ id, title, level }) => ({ id, title, level })) }));
    return catalogCache;
  }

  // ---- routes --------------------------------------------------------------------------------
  const readBody = async (req) => { const chunks = []; for await (const ch of req) chunks.push(ch); return Buffer.concat(chunks); };

  async function handle(req, res, u, send) {
    if (!u.pathname.startsWith("/api/masters/")) return false;
    const route = `${req.method} ${u.pathname}`;
    if (route === "GET /api/masters/catalog") {
      send(res, 200, { kinds: catalog() });
    } else if (route === "POST /api/masters/check") {
      // body: {whId, principalId?, files: [{name, data(base64)}], skip?: {sku: [ids], batch: [ids], production: [ids]}}
      const body = JSON.parse((await readBody(req)).toString("utf8") || "{}");
      if (!/^\d+$/.test(String(body.whId || "")) && !body.principalId) { send(res, 400, { error: "Enter the warehouse id first." }); return true; }
      if (!body.files?.length) { send(res, 400, { error: "Drop at least one file." }); return true; }
      const principal = String(body.principalId || await principalOf(String(body.whId)));
      const live = await loadLive(principal);
      const books = [];
      for (const f of body.files) {
        try { books.push({ name: f.name, buffer: Buffer.from(f.data, "base64"), ...(await readBook(Buffer.from(f.data, "base64"), f.name)) }); }
        catch (e) { books.push({ name: f.name, error: e.message }); }
      }
      // files in the same drop count as existing for each other: SKUs for batches, batches for lots
      const skuDefs = new Map(), batchDefs = new Map();
      for (const b of books) if (b.kind === "sku") for (const [k, v] of skuDefsFrom(b)) skuDefs.set(k, v);
      for (const b of books) if (b.kind === "batch") for (const [k, v] of batchDefsFrom(b)) batchDefs.set(k, v);
      const lotDefs = books.filter((b) => b.kind === "production").flatMap(lotDefsFrom);
      const skipOf = (kind) => new Set(Array.isArray(body.skip?.[kind]) ? body.skip[kind].map(String) : []);
      const order = { sku: 0, batch: 1, production: 2 };
      books.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9));
      const results = books.map((b) => {
        if (b.error) return { name: b.name, error: b.error };
        const skip = skipOf(b.kind);
        const v = b.kind === "sku" ? checkSku(b, live, skip) : b.kind === "batch" ? checkBatch(b, live, skuDefs, skip, lotDefs) : checkProduction(b, live, skuDefs, batchDefs, skip, lotDefs);
        const token = crypto.randomBytes(8).toString("hex");
        checked.set(token, { buffer: b.buffer, name: b.name, rowIssues: v.rowIssues, fixes: v.fixes, at: Date.now() });
        const bad = Object.values(v.rowIssues);
        const fx = v.fixes && { rows: v.fixes.rows.length, review: v.fixes.review.length, skipped: v.fixes.skipped.length };
        return { name: b.name, kind: b.kind, kindName: KIND_NAME[b.kind], rows: b.rows.length, token, ...v, rowIssues: undefined, fixes: fx, checksOff: skip.size,
          rowsHard: bad.filter((l) => l.some((i) => i.level === "fail")).length, rowsSoft: bad.filter((l) => !l.some((i) => i.level === "fail")).length };
      });
      for (const [t, x] of checked) if (Date.now() - x.at > 2 * 3600000) checked.delete(t);
      send(res, 200, { principal, live: live.counts, results });
    } else if (route === "GET /api/masters/fixes") {
      const c = checked.get(u.searchParams.get("token"));
      if (!c?.fixes) { send(res, 404, { error: "That check has expired. Drop the files again." }); return true; }
      const buf = await fixBook(c.fixes);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Fix_${c.name.replace(/\.xlsx$/i, "").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 50)}.xlsx"`,
      });
      res.end(Buffer.from(buf));
    } else if (route === "GET /api/masters/download") {
      const c = checked.get(u.searchParams.get("token"));
      if (!c) { send(res, 404, { error: "That check has expired. Drop the files again." }); return true; }
      const buf = await annotated(c.buffer, c.rowIssues);
      res.writeHead(200, {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="Checked_${c.name.replace(/\.xlsx$/i, "").replace(/[^A-Za-z0-9_.-]+/g, "_").slice(0, 60)}.xlsx"`,
      });
      res.end(Buffer.from(buf));
    } else {
      send(res, 404, { error: "not found" });
    }
    return true;
  }
  handle.liveBatchCheck = liveBatchCheck;
  return handle;
};
