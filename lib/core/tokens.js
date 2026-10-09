// Results kept for a later download, behind a random token. Entries older than ttlMs are
// dropped each time a new one is stored.
const crypto = require("crypto");

function tokenStore(ttlMs) {
  const items = new Map(); // token -> value (each value carries its own `at`)
  return {
    // value must have at: Date.now()
    put(value) {
      const token = crypto.randomBytes(8).toString("hex");
      items.set(token, value);
      for (const [t, x] of items) if (Date.now() - x.at > ttlMs) items.delete(t);
      return token;
    },
    get: (token) => items.get(token),
  };
}

module.exports = { tokenStore };
