// Database pools and the two query helpers every module gets.
// q(db, sql, params) returns the rows; tryQ returns [rows, error] instead of throwing, for
// columns or tables that differ between schema versions.
const { Pool } = require("pg");

// an idle connection dropping (VPN reconnect, DB restart) emits "error" on the pool;
// unhandled, that kills the whole server, so log it and let the next query reconnect
const keepAlive = (p, label) => { p.on("error", (e) => console.error(`${label}: idle database connection dropped (${e.message})`)); return p; };

// conn = { host, port, user, password }. Self-signed internal cert: same default the wms repo uses.
const makePool = (conn, database, { statementTimeout = 120000, label = database } = {}) => keepAlive(new Pool({ ...conn, database,
  ssl: { rejectUnauthorized: false }, max: 4, connectionTimeoutMillis: 10000, statement_timeout: statementTimeout }), label);

const q = async (db, sql, params = []) => (await db.query(sql, params)).rows;
const tryQ = async (db, sql, params) => {
  try { return [await q(db, sql, params), null]; }
  catch (e) { return [[], e.message]; } // column/table differs on this schema version
};

module.exports = { keepAlive, makePool, q, tryQ };
