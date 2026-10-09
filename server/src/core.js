// Shared engine (same file the H5 uses). Docker copies quant/core.js next to server.
const path = require('path'); const fs = require('fs');
const cands = [process.env.CORE_PATH, path.join(__dirname, '../../quant/core.js'), path.join(__dirname, 'core.shared.js')].filter(Boolean);
module.exports = require(cands.find(p => fs.existsSync(p)));
