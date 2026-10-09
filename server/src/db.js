const Database = require('better-sqlite3'); const path = require('path'); const fs = require('fs');
const dir = process.env.DATA_DIR || path.join(__dirname, '../data'); fs.mkdirSync(dir, { recursive: true });
const db = new Database(path.join(dir, 'leoquant.db')); db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, inst_id TEXT, symbol TEXT, strategy TEXT, pnl REAL, win INTEGER, open_time INTEGER, close_time INTEGER, live INTEGER DEFAULT 0, data TEXT);
CREATE TABLE IF NOT EXISTS evaluations (id INTEGER PRIMARY KEY AUTOINCREMENT, inst_id TEXT, order_id TEXT, symbol TEXT, strategy TEXT, win_rate REAL, expected REAL, max_loss REAL, rr REAL, created INTEGER, data TEXT);
CREATE TABLE IF NOT EXISTS logs (id INTEGER PRIMARY KEY AUTOINCREMENT, t INTEGER, lvl TEXT, msg TEXT);
CREATE TABLE IF NOT EXISTS api_keys (exchange TEXT PRIMARY KEY, label TEXT, masked TEXT, iv TEXT, tag TEXT, data TEXT, created INTEGER);
CREATE INDEX IF NOT EXISTS idx_orders_close ON orders(close_time);
`);
module.exports = db;
