// Public market data with fallbacks (no API key). Binance spot -> data-api.binance.vision; Binance USDT-M -> OKX swaps.
const C = require('./core');
const SPOT_HOSTS = (process.env.SPOT_HOSTS || 'https://api.binance.com,https://data-api.binance.vision').split(',');
const state = { spot: null, fut: null };
async function getJSON(url, ms = 8000) {
  const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url); return await r.json(); }
  finally { clearTimeout(t); }
}
async function spot(path) {
  const hosts = state.spot ? [state.spot, ...SPOT_HOSTS.filter(h => h !== state.spot)] : SPOT_HOSTS; let err;
  for (const h of hosts) { try { const d = await getJSON(h + path); state.spot = h; return d; } catch (e) { err = e; } }
  throw err;
}
async function fut() {
  if (state.fut) return state.fut;
  try { await getJSON('https://fapi.binance.com/fapi/v1/ping', 5000); state.fut = 'binance'; }
  catch { try { await getJSON('https://www.okx.com/api/v5/public/time', 5000); state.fut = 'okx'; } catch { state.fut = 'none'; } }
  return state.fut;
}
const okxId = s => s.replace(/USDT$/, '') + '-USDT-SWAP';
async function klines(sym, interval, limit = 500, market = 'spot', endTime) {
  if (market !== 'fut') return C.parseBinanceKlines(await spot(`/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${Math.min(limit, 1000)}${endTime ? '&endTime=' + endTime : ''}`));
  const src = await fut();
  if (src === 'binance') return C.parseBinanceKlines(await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${Math.min(limit, 1500)}`));
  if (src === 'okx') { const bar = { '1h': '1H', '4h': '4H', '1d': '1D' }[interval] || interval; return C.parseOkxCandles((await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${okxId(sym)}&bar=${bar}&limit=300`)).data); }
  throw new Error('数据源不可用');
}
async function histKlines(sym, interval, total, market) {
  let all = await klines(sym, interval, Math.min(total, 1000), market);
  if (market !== 'fut' && total > 1000 && all.length) all = (await klines(sym, interval, total - all.length, market, all[0].t - 1)).concat(all);
  return all;
}
async function prices(spotSyms, futSyms) {
  const out = { spot: {}, fut: {} };
  if (spotSyms.length) { const d = await spot(`/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify(spotSyms))}`); d.forEach(x => out.spot[x.symbol] = +x.price); }
  if (futSyms.length) {
    const src = await fut();
    if (src === 'binance') { const d = await getJSON('https://fapi.binance.com/fapi/v1/ticker/price'); d.forEach(x => { if (futSyms.includes(x.symbol)) out.fut[x.symbol] = +x.price; }); }
    else if (src === 'okx') { const d = await getJSON('https://www.okx.com/api/v5/market/tickers?instType=SWAP'); d.data.forEach(x => { const s = x.instId.replace('-USDT-SWAP', 'USDT'); if (futSyms.includes(s)) out.fut[s] = +x.last; }); }
  }
  return out;
}
module.exports = { klines, histKlines, prices, sources: () => ({ spot: state.spot, fut: state.fut }) };
