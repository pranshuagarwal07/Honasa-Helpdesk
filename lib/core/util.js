// Text, day and number helpers used across the inventory tools.
// Days are "YYYY-MM-DD" keys, compared as text.

const upper = (s) => String(s ?? "").trim().toUpperCase();

const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const todayKey = () => { const d = new Date(); return ymd(d.getFullYear(), d.getMonth() + 1, d.getDate()); };
const addDays = (key, n) => { const [y, m, d] = key.split("-").map(Number); const t = new Date(Date.UTC(y, m - 1, d + n)); return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate()); };
const daysBetween = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// Excel cells arrive as Date (UTC midnight), serial numbers or text
function dayKeyOf(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v instanceof Date) return isNaN(v) ? null : ymd(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
  if (typeof v === "number") return dayKeyOf(new Date(Math.round((v - 25569) * 86400000)));
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (m) return ymd(+m[3], +m[2], +m[1]);
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? ymd(+m[1], +m[2], +m[3]) : null;
}
const utcDate = (key) => { const [y, m, d] = key.split("-").map(Number); return new Date(Date.UTC(y, m - 1, d)); };

// 1234.5 -> "1,234.5" (Indian grouping); 0.42 -> "42%"; cc -> litres to 2 places
const fmtN = (n) => Number(n.toFixed(2)).toLocaleString("en-IN");
const pct = (x) => `${Math.round(x * 100)}%`;
const litres = (cc) => (cc === null || cc === undefined ? null : +(cc / 1000).toFixed(2));

module.exports = { upper, ymd, todayKey, addDays, daysBetween, dayKeyOf, utcDate, fmtN, pct, litres };
