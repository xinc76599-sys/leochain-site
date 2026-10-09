// Real order placement via ccxt. Disabled unless LIVE_TRADING=true. Keys are decrypted in-memory only, never returned to clients.
const db = require('./db'); const { decrypt } = require('./crypto');
const LIVE = process.env.LIVE_TRADING === 'true';
const MAX_NOTIONAL = +(process.env.MAX_LIVE_NOTIONAL || 50);
let ccxt = null; function lib() { if (!ccxt) ccxt = require('ccxt'); return ccxt; }
const cache = {};
function exchange(name, market) {
  const k = name + ':' + market; if (cache[k]) return cache[k];
  const row = db.prepare('SELECT * FROM api_keys WHERE exchange=?').get(name); if (!row) throw new Error(`未配置 ${name} API Key`);
  const cred = decrypt(row); const Cls = lib()[name]; if (!Cls) throw new Error('ccxt 不支持交易所 ' + name);
  return (cache[k] = new Cls({ apiKey: cred.apiKey, secret: cred.secret, password: cred.password, enableRateLimit: true, options: { defaultType: market === 'fut' ? 'swap' : 'spot' } }));
}
function clearCache() { Object.keys(cache).forEach(k => delete cache[k]); }
const ccxtSym = (s, market) => s.replace(/USDT$/, '') + '/USDT' + (market === 'fut' ? ':USDT' : '');
async function buy(inst, pos, px, margin, log) {
  const cfg = inst.cfg; const market = inst.market; const name = cfg.liveExchange || process.env.LIVE_EXCHANGE || 'binance';
  let notional = market === 'fut' ? margin * cfg.lev : margin;
  if (notional > MAX_NOTIONAL) { log(`实盘单名义价值 ${notional.toFixed(2)}U 超过上限 MAX_LIVE_NOTIONAL=${MAX_NOTIONAL}，按上限下单`, 'warn'); notional = MAX_NOTIONAL; }
  const ex = exchange(name, market); const sym = ccxtSym(inst.symbol, market);
  if (market === 'fut') { try { await ex.setLeverage(cfg.lev, sym); } catch (e) { log('设置杠杆失败：' + e.message, 'warn'); } }
  const amount = +ex.amountToPrecision(sym, notional / px);
  const o = await ex.createOrder(sym, 'market', 'buy', amount);
  pos.live = pos.live || { exchange: name, market, qty: 0, orders: [] }; pos.live.qty += +(o.filled || amount); pos.live.orders.push(o.id);
  log(`🔴 实盘买入 ${sym} 数量 ${amount} 订单 ${o.id}`, 'warn');
}
async function sellAll(pos, log) {
  if (!pos.live || !pos.live.qty) return;
  const ex = exchange(pos.live.exchange, pos.live.market); const sym = ccxtSym(pos.symbol, pos.live.market);
  const o = await ex.createOrder(sym, 'market', 'sell', +ex.amountToPrecision(sym, pos.live.qty), undefined, pos.live.market === 'fut' ? { reduceOnly: true } : {});
  log(`🔴 实盘卖出 ${sym} 数量 ${pos.live.qty} 订单 ${o.id}`, 'warn');
}
module.exports = { LIVE, MAX_NOTIONAL, buy, sellAll, clearCache };
