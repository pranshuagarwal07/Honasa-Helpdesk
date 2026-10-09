// IM cockpit Internal Movement upload files: rows.js turns a plan into upload rows, files.js splits
// them into files the uploader accepts (waves, WMS capacity hold-back) and writes Sheet1.
module.exports = { ...require("./files"), ...require("./rows") };
