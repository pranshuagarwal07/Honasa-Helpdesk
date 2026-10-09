// Small HTTP helpers shared by the server and the feature modules.

// JSON by default; anything else (a page, a script, a file) is sent as it is
const send = (res, code, body, type = "application/json") => {
  const data = type === "application/json" ? JSON.stringify(body) : body;
  res.writeHead(code, { "Content-Type": type });
  res.end(data);
};

// the whole request body as a Buffer
const readBody = async (req) => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); };

// warehouse ids are numbers, sent as text
const isWh = (v) => /^\d+$/.test(String(v ?? ""));

// an .xlsx download; buf is what ExcelJS's writeBuffer() returns
const sendXlsx = (res, filename, buf) => {
  res.writeHead(200, {
    "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "Content-Disposition": `attachment; filename="${filename}"`,
  });
  res.end(Buffer.from(buf));
};

module.exports = { send, readBody, isWh, sendXlsx };
