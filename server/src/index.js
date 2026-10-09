// LeoQuant server: independent strategy engine + REST API. Paper trading by default.
const http = require('http');
const C = require('./core'); const data = require('./data'); const db = require('./db'); const cryptoBox = require('./crypto'); const live = require('./live');
const PORT = +(process.env.PORT || 8080); const TOKEN = process.env.API_TOKEN || ''; const ORIGIN = process.env.CORS_ORIGIN || '*';
const TICK = +(process.env.TICK_MS || 4000); const INITIAL = +(process.env.INITIAL_BALANCE || 10000);

/* ---------- state persistence ---------- */
const insLog = db.prepare('INSERT INTO logs (t,lvl,msg) VALUES (?,?,?)');
const insOrder = db.prepare('INSERT OR REPLACE INTO orders (id,inst_id,symbol,strategy,pnl,win,open_time,close_time,live,data) VALUES (?,?,?,?,?,?,?,?,?,?)');
const insEval = db.prepare('INSERT INTO evaluations (inst_id,order_id,symbol,strategy,win_rate,expected,max_loss,rr,created,data) VALUES (?,?,?,?,?,?,?,?,?,?)');
function loadState() {
  const row = db.prepare("SELECT v FROM kv WHERE k='engine'").get();
  const s = row ? JSON.parse(row.v) : C.newState(INITIAL);
  s.orders = db.prepare('SELECT data FROM orders ORDER BY close_time DESC LIMIT 2000').all().map(r => JSON.parse(r.data));
  s.logs = db.prepare('SELECT t,lvl,msg FROM logs ORDER BY id DESC LIMIT 400').all(); s.maxOrders = 2000;
  return s;
}
function saveState() { const { orders, logs, ...rest } = eng.s; db.prepare("INSERT OR REPLACE INTO kv (k,v) VALUES ('engine',?)").run(JSON.stringify(rest)); }
const pending = [];
const hooks = {
  onLog: e => insLog.run(e.t, e.lvl, e.msg),
  onOpen: (pos, inst) => {
    if (pos.eval) insEval.run(inst.id, pos.id, pos.symbol, inst.cfg.type, pos.eval.winRate, pos.eval.expected, pos.eval.maxLoss, pos.eval.rr, Date.now(), JSON.stringify(pos.eval));
    if (inst.cfg.live && live.LIVE) pending.push(live.buy(inst, pos, pos.avg, pos.fills[0].margin, (m, l) => eng.log(m, l)).catch(e => eng.log('实盘下单失败：' + e.message, 'loss')));
  },
  onAdd: (pos, inst, px, m) => { if (inst.cfg.live && live.LIVE) pending.push(live.buy(inst, pos, px, m, (x, l) => eng.log(x, l)).catch(e => eng.log('实盘加仓失败：' + e.message, 'loss'))); },
  onOrder: (o, pos) => {
    o.live = !!(pos && pos.live); insOrder.run(o.id, o.instId, o.symbol, o.strategy, o.pnl, o.win ? 1 : 0, o.openTime, o.closeTime, o.live ? 1 : 0, JSON.stringify(o));
    if (pos && pos.live && live.LIVE) pending.push(live.sellAll(pos, (x, l) => eng.log(x, l)).catch(e => eng.log('实盘平仓失败（请手动处理）：' + e.message, 'loss')));
  },
};
let eng = new C.Engine(loadState(), hooks);
let PRICES = {}; const CANDLES = {}; let lastTickErr = null, lastTick = 0;

async function evaluate(cfg) {
  cfg = Object.assign({ interval: '15m', bars: 1500, market: 'spot' }, cfg);
  if (!/^[A-Z0-9]{2,20}USDT$/.test(cfg.symbol || '')) throw new Error('交易对格式错误');
  const k = await data.histKlines(cfg.symbol, cfg.interval, Math.min(+cfg.bars || 1500, 1500), cfg.market);
  if (k.length < 120) throw new Error('K线数据不足');
  const ev = C.evaluate(k, cfg, C.backtest(k, cfg)); ev.cfg = cfg; return ev;
}
function priceMap() { const p = {}; eng.s.instances.concat(eng.s.positions).forEach(x => { const mk = x.market || (x.cfg && x.cfg.market) || 'spot'; const v = PRICES[mk] && PRICES[mk][x.symbol]; if (v) p[x.symbol] = v; }); return p; }
let ticking = false;
async function tick() {
  if (ticking) return; ticking = true;
  try {
    const act = eng.s.instances.filter(i => i.running);
    const need = { spot: new Set(), fut: new Set() };
    act.concat(eng.s.positions).forEach(x => need[(x.market || (x.cfg && x.cfg.market)) === 'fut' ? 'fut' : 'spot'].add(x.symbol));
    if (!need.spot.size && !need.fut.size) { lastTick = Date.now(); return; }
    PRICES = await data.prices([...need.spot], [...need.fut]);
    const candles = {};
    for (const inst of act) {
      const key = inst.symbol + inst.market + inst.cfg.interval; const c = CANDLES[key];
      if (!c || Date.now() - c.t > 60000) { try { CANDLES[key] = { t: Date.now(), k: await data.klines(inst.symbol, inst.cfg.interval || '15m', 120, inst.market) }; } catch {} }
      if (CANDLES[key]) candles[inst.symbol] = CANDLES[key].k;
      if (Date.now() - (inst.eval ? inst.eval.t : 0) > 15 * 60000) { try { inst.eval = await evaluate(inst.cfg); } catch (e) { eng.log(`${inst.id} 评估刷新失败：${e.message}`, 'warn'); } }
    }
    eng.tick({ prices: priceMap(), candles }); saveState(); lastTickErr = null; lastTick = Date.now();
    if (pending.length) await Promise.allSettled(pending.splice(0)); saveState();
  } catch (e) { lastTickErr = e.message; } finally { ticking = false; }
}
setInterval(tick, TICK);

/* ---------- HTTP ---------- */
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': ORIGIN, 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS' }); res.end(JSON.stringify(obj)); }
function body(req) { return new Promise((ok, no) => { let b = ''; req.on('data', c => { b += c; if (b.length > 1e5) req.destroy(); }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new Error('JSON 格式错误')); } }); }); }
const authed = req => !TOKEN || req.headers.authorization === 'Bearer ' + TOKEN;
function snapshot() {
  const s = eng.s; return { state: { initial: s.initial, balance: s.balance, instances: s.instances, positions: s.positions, orders: s.orders.slice(0, 500), logs: s.logs.slice(0, 200) },
    summary: eng.summary(priceMap()), prices: priceMap(), sources: data.sources(), lastTick, lastTickErr, live: live.LIVE };
}
const routes = {
  'GET /api/health': () => ({ ok: true, version: '1.0.0', live: live.LIVE, keyStorage: cryptoBox.hasKey(), sources: data.sources(), lastTick, lastTickErr }),
  'GET /api/state': () => snapshot(),
  'POST /api/evaluate': async b => { const ev = await evaluate(b); insEval.run(null, null, ev.symbol, ev.type, ev.winRate, ev.expected, ev.maxLoss, ev.rr, Date.now(), JSON.stringify(ev)); return ev; },
  'POST /api/strategies': async b => {
    const cfg = Object.assign({}, b.cfg); const gate = b.gate || {};
    if (cfg.live && !live.LIVE) throw new Error('实盘未启用（需要 LIVE_TRADING=true）');
    if (cfg.live && !TOKEN) throw new Error('实盘模式必须设置 API_TOKEN');
    const ev = await evaluate(cfg); const inst = eng.start(cfg, ev, { gate: !!gate.gate, minWin: +gate.minWin || 0 }); saveState(); tick(); return { ok: true, id: inst.id, eval: ev };
  },
  'POST /api/stop-all': () => { eng.stopAll(); saveState(); return { ok: true }; },
  'POST /api/close-all': async () => { await data.prices([...new Set(eng.s.positions.filter(p => p.cfg.market !== 'fut').map(p => p.symbol))], [...new Set(eng.s.positions.filter(p => p.cfg.market === 'fut').map(p => p.symbol))]).then(p => { PRICES = p; }).catch(() => {});
    eng.closeAll(priceMap(), '一键平仓'); await Promise.allSettled(pending.splice(0)); saveState(); return { ok: true }; },
  'POST /api/reset': b => { if (eng.s.positions.some(p => p.live)) throw new Error('存在实盘持仓，禁止重置'); db.exec('DELETE FROM orders; DELETE FROM logs; DELETE FROM evaluations;');
    eng = new C.Engine(Object.assign(C.newState(+b.initial || INITIAL), { maxOrders: 2000 }), hooks); eng.log(`模拟账户已重置，初始资金 ${eng.s.initial} USDT`); saveState(); return { ok: true }; },
  'GET /api/orders': (b, q) => db.prepare('SELECT data FROM orders ORDER BY close_time DESC LIMIT ?').all(Math.min(+q.get('limit') || 200, 5000)).map(r => JSON.parse(r.data)),
  'GET /api/evaluations': (b, q) => db.prepare('SELECT id,inst_id,order_id,symbol,strategy,win_rate,expected,max_loss,rr,created FROM evaluations ORDER BY id DESC LIMIT ?').all(Math.min(+q.get('limit') || 200, 2000)),
  'GET /api/logs': (b, q) => db.prepare('SELECT t,lvl,msg FROM logs ORDER BY id DESC LIMIT ?').all(Math.min(+q.get('limit') || 200, 5000)),
  // API keys: write-only. Responses never include secrets.
  'GET /api/keys': () => db.prepare('SELECT exchange,label,masked,created FROM api_keys').all(),
  'POST /api/keys': b => {
    if (!TOKEN) throw new Error('必须先设置 API_TOKEN 才能存储交易所密钥');
    if (!b.exchange || !b.apiKey || !b.secret) throw new Error('缺少 exchange/apiKey/secret');
    const enc = cryptoBox.encrypt({ apiKey: b.apiKey, secret: b.secret, password: b.password });
    db.prepare('INSERT OR REPLACE INTO api_keys (exchange,label,masked,iv,tag,data,created) VALUES (?,?,?,?,?,?,?)').run(b.exchange, b.label || '', '****' + String(b.apiKey).slice(-4), enc.iv, enc.tag, enc.data, Date.now());
    live.clearCache(); return { ok: true, exchange: b.exchange, masked: '****' + String(b.apiKey).slice(-4) };
  },
};
http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const u = new URL(req.url, 'http://x'); let key = req.method + ' ' + u.pathname; let fn = routes[key]; let b = {};
  const m = u.pathname.match(/^\/api\/strategies\/(S\d+)\/stop$/); const dk = u.pathname.match(/^\/api\/keys\/([a-z0-9]+)$/);
  if (!fn && req.method === 'POST' && m) fn = () => { eng.stop(m[1]); saveState(); return { ok: true }; };
  if (!fn && req.method === 'DELETE' && dk) fn = () => { db.prepare('DELETE FROM api_keys WHERE exchange=?').run(dk[1]); live.clearCache(); return { ok: true }; };
  if (!fn) return send(res, 404, { error: 'not found' });
  if (key !== 'GET /api/health' && !authed(req)) return send(res, 401, { error: '未授权（API_TOKEN 不匹配）' });
  try { if (req.method === 'POST') b = await body(req); send(res, 200, await fn(b, u.searchParams)); }
  catch (e) { send(res, 400, { error: e.message }); }
}).listen(PORT, () => {
  console.log(`LeoQuant server :${PORT} | LIVE_TRADING=${live.LIVE} | MASTER_KEY=${cryptoBox.hasKey() ? 'set' : 'missing'} | API_TOKEN=${TOKEN ? 'set' : 'NOT SET (open API!)'}`);
  if (!TOKEN) console.warn('⚠️  未设置 API_TOKEN：任何人都可调用模拟盘接口。公网部署务必设置。');
  tick();
});
process.on('SIGTERM', () => { saveState(); process.exit(0); });
