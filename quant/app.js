/* LeoQuant H5 V1 — all market data is fetched live from public exchange APIs. */
(() => {
const C = window.LQCore;
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt = (n, d = 2) => n == null || isNaN(n) ? '--' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
const fpx = p => p == null || isNaN(p) ? '--' : C.fmtPx(+p);
const fvol = v => v >= 1e9 ? (v / 1e9).toFixed(2) + 'B' : v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : fmt(v, 0);
const fpct = (p, d = 2) => p == null || isNaN(p) ? '--' : (p >= 0 ? '+' : '') + p.toFixed(d) + '%';
const cls = v => v > 0 ? 'up' : v < 0 ? 'down' : '';
const ftime = t => { const d = new Date(t); return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
const fdate = t => { const d = new Date(t); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
function toast(m) { const t = $('#toast'); t.textContent = m; t.classList.add('on'); clearTimeout(toast.h); toast.h = setTimeout(() => t.classList.remove('on'), 2200); }

/* ---------------- Data layer with fallbacks ---------------- */
const SRC = { spot: null, fut: null, status: {} };
async function getJSON(url, ms = 6000) {
  const ctl = new AbortController(); const tm = setTimeout(() => ctl.abort(), ms);
  try { const r = await fetch(url, { signal: ctl.signal }); if (!r.ok) throw new Error('HTTP ' + r.status); return await r.json(); }
  finally { clearTimeout(tm); }
}
const SPOT_HOSTS = ['https://api.binance.com', 'https://data-api.binance.vision'];
async function spot(path) {
  const hosts = SRC.spot ? [SRC.spot, ...SPOT_HOSTS.filter(h => h !== SRC.spot)] : SPOT_HOSTS;
  let err;
  for (const h of hosts) { try { const d = await getJSON(h + path); const ch = SRC.spot !== h || !SRC.status.spot; SRC.spot = h; SRC.status.spot = h; if (ch) renderSrc(); return d; } catch (e) { err = e; } }
  SRC.status.spot = null; renderSrc(); throw err;
}
// futures: Binance USDT-M first, OKX USDT swaps as fallback
async function detectFut() {
  if (SRC.fut) return SRC.fut;
  try { await getJSON('https://fapi.binance.com/fapi/v1/ping', 4000); SRC.fut = 'binance'; }
  catch { try { await getJSON('https://www.okx.com/api/v5/public/time', 5000); SRC.fut = 'okx'; } catch { SRC.fut = 'none'; } }
  renderSrc(); return SRC.fut;
}
const okxId = s => s.replace(/USDT$/, '') + '-USDT-SWAP';
const fromOkx = id => id.replace('-USDT-SWAP', 'USDT');
function renderSrc() {
  const d = $('#srcDot'); d.className = 'src-dot ' + (SRC.status.spot ? 'ok' : (SRC.status.spot === null ? 'bad' : ''));
  d.title = `现货: ${SRC.spot || '不可用'} / 合约: ${SRC.fut || '检测中'}`;
}

let SPOT_INFO = null; // symbol -> {base}
async function spotInfo() {
  if (SPOT_INFO) return SPOT_INFO;
  const d = await spot('/api/v3/exchangeInfo?symbolStatus=TRADING');
  SPOT_INFO = {}; d.symbols.filter(s => s.quoteAsset === 'USDT').forEach(s => SPOT_INFO[s.symbol] = { base: s.baseAsset });
  return SPOT_INFO;
}
const isLev = b => /(UP|DOWN|BULL|BEAR)$/.test(b) && b.length > 4;
async function spotTickers() {
  const [info, d] = await Promise.all([spotInfo(), spot('/api/v3/ticker/24hr')]);
  return d.filter(t => info[t.symbol] && !isLev(info[t.symbol].base) && +t.lastPrice > 0).map(t => ({ sym: t.symbol, base: info[t.symbol].base, price: +t.lastPrice,
    chg: +t.priceChangePercent, qv: +t.quoteVolume, hi: +t.highPrice, lo: +t.lowPrice, firstId: t.firstId, count: t.count }));
}
async function futTickers() {
  const src = await detectFut();
  if (src === 'binance') {
    const [t, p] = await Promise.all([getJSON('https://fapi.binance.com/fapi/v1/ticker/24hr'), getJSON('https://fapi.binance.com/fapi/v1/premiumIndex')]);
    const fr = {}; p.forEach(x => fr[x.symbol] = { f: +x.lastFundingRate, next: x.nextFundingTime, mark: +x.markPrice });
    return t.filter(x => x.symbol.endsWith('USDT')).map(x => ({ sym: x.symbol, base: x.symbol.replace(/USDT$/, ''), price: +x.lastPrice, chg: +x.priceChangePercent, qv: +x.quoteVolume,
      funding: fr[x.symbol] && fr[x.symbol].f, nextFunding: fr[x.symbol] && fr[x.symbol].next, mark: fr[x.symbol] && fr[x.symbol].mark }));
  }
  if (src === 'okx') {
    const [t, f] = await Promise.all([getJSON('https://www.okx.com/api/v5/market/tickers?instType=SWAP'), getJSON('https://www.okx.com/api/v5/public/funding-rate?instId=ANY').catch(() => ({ data: [] }))]);
    const fr = {}; (f.data || []).forEach(x => fr[x.instId] = { f: +x.fundingRate, next: +x.fundingTime });
    return t.data.filter(x => x.instId.endsWith('-USDT-SWAP')).map(x => ({ sym: fromOkx(x.instId), base: x.instId.split('-')[0], price: +x.last,
      chg: +x.open24h ? (x.last / x.open24h - 1) * 100 : 0, qv: +x.volCcy24h * +x.last, funding: fr[x.instId] && fr[x.instId].f, nextFunding: fr[x.instId] && fr[x.instId].next }));
  }
  throw new Error('数据源不可用');
}
async function futOI(sym) {
  const src = await detectFut();
  if (src === 'binance') { const d = await getJSON('https://fapi.binance.com/fapi/v1/openInterest?symbol=' + sym); return { oi: +d.openInterest }; }
  if (src === 'okx') { const d = await getJSON('https://www.okx.com/api/v5/public/open-interest?instType=SWAP&instId=' + okxId(sym)); const x = d.data[0]; return x ? { oi: +x.oiCcy, oiUsd: +x.oiUsd } : null; }
  return null;
}
async function klines(sym, interval, limit = 500, market = 'spot', endTime) {
  if (market === 'spot') return C.parseBinanceKlines(await spot(`/api/v3/klines?symbol=${sym}&interval=${interval}&limit=${Math.min(limit, 1000)}${endTime ? '&endTime=' + endTime : ''}`));
  const src = await detectFut();
  if (src === 'binance') return C.parseBinanceKlines(await getJSON(`https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${interval}&limit=${Math.min(limit, 1500)}`));
  if (src === 'okx') { const bar = { '1h': '1H', '4h': '4H', '1d': '1D' }[interval] || interval; return C.parseOkxCandles((await getJSON(`https://www.okx.com/api/v5/market/candles?instId=${okxId(sym)}&bar=${bar}&limit=300`)).data); }
  throw new Error('数据源不可用');
}
async function histKlines(sym, interval, total, market) {
  let all = await klines(sym, interval, Math.min(total, 1000), market);
  if (market === 'spot' && total > 1000 && all.length) {
    const older = await klines(sym, interval, total - all.length, market, all[0].t - 1);
    all = older.concat(all);
  }
  return all;
}
async function rolling(syms, win) {
  const out = {};
  for (let i = 0; i < syms.length; i += 100) {
    const d = await spot(`/api/v3/ticker?windowSize=${win}&type=MINI&symbols=${encodeURIComponent(JSON.stringify(syms.slice(i, i + 100)))}`);
    d.forEach(x => out[x.symbol] = { chg: (x.lastPrice / x.openPrice - 1) * 100, qv: +x.quoteVolume, price: +x.lastPrice });
  }
  return out;
}

/* ---------------- Ripple & navigation ---------------- */
document.addEventListener('pointerdown', e => {
  const el = e.target.closest('.rip,.row,.btn,.chip,.tab'); if (!el) return;
  const r = el.getBoundingClientRect(); const s = Math.max(r.width, r.height); const sp = document.createElement('span');
  sp.className = 'ripple'; sp.style.cssText = `width:${s}px;height:${s}px;left:${e.clientX - r.left - s / 2}px;top:${e.clientY - r.top - s / 2}px`;
  if (getComputedStyle(el).position === 'static') el.style.position = 'relative'; el.style.overflow = 'hidden';
  el.appendChild(sp); setTimeout(() => sp.remove(), 600);
});
let PAGE = 'market';
function go(p) {
  PAGE = p; document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.p === p));
  document.querySelectorAll('.page').forEach(x => x.classList.toggle('active', x.id === 'p-' + p));
  window.scrollTo({ top: 0, behavior: 'smooth' }); render[p] && render[p]();
}
document.querySelectorAll('.tab').forEach(t => t.onclick = () => go(t.dataset.p));
function openSheet(html) { $('#sheetBody').innerHTML = html; $('#sheet').scrollTop = 0; $('#mask').classList.add('on'); $('#sheet').classList.add('on'); }
function closeSheet() { $('#mask').classList.remove('on'); $('#sheet').classList.remove('on'); DETAIL.sym = null; }
$('#mask').onclick = closeSheet; $('#sheetX').onclick = closeSheet;
let sy0 = null; $('#sheet').addEventListener('touchstart', e => { if ($('#sheet').scrollTop <= 0) sy0 = e.touches[0].clientY; });
$('#sheet').addEventListener('touchend', e => { if (sy0 != null && e.changedTouches[0].clientY - sy0 > 90) closeSheet(); sy0 = null; });

/* ---------------- 行情 ---------------- */
const M = { mode: 'spot', sort: 'qv', spot: [], fut: [], err: null, prev: {}, last: 0 };
async function pollMarket() {
  try {
    const list = M.mode === 'spot' ? await spotTickers() : await futTickers();
    M[M.mode] = list; M.err = null; M.last = Date.now();
    list.forEach(t => PRICES[M.mode][t.sym] = t.price);
  } catch (e) { M.err = e.message || '数据源不可用'; }
  if (PAGE === 'market') renderMarketList();
}
function renderMarket() {
  $('#p-market').innerHTML = `
    <div class="seg" id="mseg"><button data-m="spot" class="${M.mode === 'spot' ? 'on' : ''}">现货 USDT</button><button data-m="fut" class="${M.mode === 'fut' ? 'on' : ''}">U本位合约</button></div>
    <div class="chips" id="msort">${[['qv', '成交额'], ['up', '涨幅榜'], ['down', '跌幅榜'], ['fund', '资金费率']].map(([k, n]) => `<button class="chip ${M.sort === k ? 'on' : ''}" data-s="${k}">${n}</button>`).join('')}</div>
    <div class="card list" style="padding:0" id="mlist">${'<div class="row"><div class="skel" style="width:100%"></div></div>'.repeat(8)}</div>
    <div class="muted" id="mfoot" style="text-align:center"></div>`;
  $('#mseg').onclick = e => { const b = e.target.closest('button'); if (!b) return; M.mode = b.dataset.m; renderMarket(); pollMarket(); };
  $('#msort').onclick = e => { const b = e.target.closest('button'); if (!b) return; M.sort = b.dataset.s; renderMarket(); renderMarketList(); };
  renderMarketList();
}
function renderMarketList() {
  const el = $('#mlist'); if (!el) return;
  let list = M[M.mode].slice();
  if (!list.length) { el.innerHTML = M.err ? `<div class="empty">数据源不可用（${esc(M.err)}）<br>将自动重试</div>` : el.innerHTML; return; }
  list = list.filter(t => t.qv > 0);
  const s = M.sort;
  list.sort((a, b) => s === 'qv' ? b.qv - a.qv : s === 'up' ? b.chg - a.chg : s === 'down' ? a.chg - b.chg : Math.abs(b.funding || 0) - Math.abs(a.funding || 0));
  list = list.slice(0, 80);
  el.innerHTML = list.map(t => {
    const pv = M.prev[M.mode + t.sym]; const fl = pv && pv !== t.price ? (t.price > pv ? 'flash-up' : 'flash-down') : ''; M.prev[M.mode + t.sym] = t.price;
    return `<div class="row ${fl}" data-sym="${t.sym}" data-mk="${M.mode}"><div class="l"><div class="sym">${esc(t.base)}<small>/USDT${M.mode === 'fut' ? ' 永续' : ''}</small></div>
    <div class="sub">额 ${fvol(t.qv)}${M.mode === 'fut' && t.funding != null ? ` · 费率 <span class="${cls(t.funding)}">${(t.funding * 100).toFixed(4)}%</span>` : ''}</div></div>
    <div class="px">${fpx(t.price)}</div><div class="pill ${t.chg > 0 ? 'bg-up' : t.chg < 0 ? 'bg-down' : 'bg-flat'}">${fpct(t.chg)}</div></div>`;
  }).join('');
  $('#mfoot').textContent = `数据源：${M.mode === 'spot' ? (SRC.spot || '').replace('https://', '') : SRC.fut === 'okx' ? 'OKX 永续（币安合约接口在当前网络不可用，已自动切换）' : 'Binance USDT-M'} · ${new Date(M.last).toLocaleTimeString()} 更新 · 4秒刷新`;
}
document.addEventListener('click', e => { const r = e.target.closest('.row[data-sym]'); if (r) openDetail(r.dataset.sym, r.dataset.mk || 'spot'); });

/* ---------------- 币种详情 ---------------- */
const DETAIL = { sym: null, mk: 'spot' };
async function openDetail(sym, mk) {
  DETAIL.sym = sym; DETAIL.mk = mk;
  const base = sym.replace(/USDT$/, '');
  openSheet(`<div style="display:flex;justify-content:space-between;align-items:center"><div><div style="font-weight:800;font-size:20px">${esc(base)}<span class="muted">/USDT</span><span class="tag ${mk === 'fut' ? 'blue' : ''}">${mk === 'fut' ? '永续合约' : '现货'}</span></div></div>
    <button class="chip" id="toQuant">🤖 用此币量化</button></div>
    <div id="dHead" style="margin:8px 0"><div class="skel" style="width:50%;height:30px"></div></div>
    <div class="card" style="padding:10px"><div class="chips" id="dIv" style="margin:0 0 6px">${['15m', '1h', '4h', '1d'].map(i => `<button class="chip ${i === '1h' ? 'on' : ''}" data-i="${i}">${i}</button>`).join('')}</div><canvas id="dChart" height="170"></canvas></div>
    <div class="h">多周期统计</div><div class="card" id="dStats"><div class="skel"></div></div>
    <div id="dFut"></div>`);
  $('#toQuant').onclick = () => { Q.form.symbol = sym; Q.form.market = mk; closeSheet(); go('quant'); };
  $('#dIv').onclick = e => { const b = e.target.closest('button'); if (!b) return; document.querySelectorAll('#dIv .chip').forEach(x => x.classList.toggle('on', x === b)); drawDetailChart(sym, mk, b.dataset.i); };
  drawDetailChart(sym, mk, '1h');
  loadDetail(sym, mk);
}
async function drawDetailChart(sym, mk, iv) {
  try { const k = await klines(sym, iv, 120, mk); if (DETAIL.sym === sym) lineChart($('#dChart'), k.map(x => x.c), k.map(x => x.t)); }
  catch { const c = $('#dChart'); if (c) c.getContext('2d').fillText('K线数据源不可用', 10, 20); }
}
async function loadDetail(sym, mk) {
  try {
    const periods = [['1m', '1m'], ['5m', '5m'], ['15m', '15m'], ['1h', '1h'], ['4h', '4h'], ['24h', '1d']];
    let rows;
    if (mk === 'spot') {
      const res = await Promise.all(periods.map(p => rolling([sym], p[1]).then(r => r[sym])));
      rows = periods.map((p, i) => ({ p: p[0], chg: res[i].chg, qv: res[i].qv })); rows.price = res[5].price;
    } else {
      const [m1, h1] = await Promise.all([klines(sym, '1m', 60, mk), klines(sym, '1h', 25, mk)]);
      const last = m1[m1.length - 1].c; const ch = (arr, n) => { const a = arr.slice(-n); return { chg: (last / a[0].o - 1) * 100, qv: a.reduce((s, x) => s + x.qv, 0) }; };
      rows = [['1m', m1, 1], ['5m', m1, 5], ['15m', m1, 15], ['1h', m1, 60], ['4h', h1, 4], ['24h', h1, 24]].map(([p, a, n]) => Object.assign({ p }, ch(a, n))); rows.price = last;
    }
    const k5 = await klines(sym, '5m', 289, mk);
    const lastV = k5[k5.length - 1].qv, prevV = k5[k5.length - 2] ? k5[k5.length - 2].qv : 0;
    const base = k5.slice(-50, -2); const avg = base.reduce((s, x) => s + x.qv, 0) / Math.max(base.length, 1);
    const ratio = avg ? Math.max(lastV, prevV) / avg : 0;
    const d24 = rows[5];
    if (DETAIL.sym !== sym) return;
    $('#dHead').innerHTML = `<div class="big ${cls(d24.chg)}">${fpx(rows.price)}</div><div class="${cls(d24.chg)}" style="font-weight:600">${fpct(d24.chg)} <span class="muted">24h</span>
      ${ratio >= 3 ? '<span class="tag down">🔥 爆量</span>' : ratio >= 1.8 ? '<span class="tag warn">放量</span>' : ''}</div>`;
    $('#dStats').innerHTML = `<table class="t"><tr><th>周期</th><th>涨跌幅</th><th>成交额(USDT)</th></tr>${rows.map(r => `<tr><td>${r.p}</td><td class="${cls(r.chg)}">${fpct(r.chg)}</td><td>${fvol(r.qv)}</td></tr>`).join('')}</table>
      <div class="kv" style="margin-top:10px"><div><span>量比（近5m / 前4h均值）</span><b class="${ratio >= 3 ? 'down' : ''}">${ratio.toFixed(2)}</b></div><div><span>爆量判定（≥3）</span><b>${ratio >= 3 ? '是 🔥' : '否'}</b></div></div>`;
    if (mk === 'fut') {
      const t = M.fut.find(x => x.sym === sym) || {}; const oi = await futOI(sym).catch(() => null);
      $('#dFut').innerHTML = `<div class="h">合约数据 <span class="muted">${SRC.fut === 'okx' ? 'OKX' : 'Binance'}</span></div><div class="card kv">
        <div><span>资金费率</span><b class="${cls(t.funding)}">${t.funding != null ? (t.funding * 100).toFixed(4) + '%' : '--'}</b></div>
        <div><span>下次结算</span><b>${t.nextFunding ? ftime(+t.nextFunding) : '--'}</b></div>
        <div><span>持仓量(币)</span><b>${oi ? fvol(oi.oi) : '--'}</b></div><div><span>持仓价值(USDT)</span><b>${oi ? fvol(oi.oiUsd || oi.oi * rows.price) : '--'}</b></div></div>`;
    }
  } catch (e) { if (DETAIL.sym === sym) $('#dStats').innerHTML = `<div class="empty">数据源不可用（${esc(e.message)}）</div>`; }
}

/* ---------------- 搜索 ---------------- */
$('#searchBtn').onclick = async () => {
  openSheet(`<input class="sinput" id="sIn" placeholder="输入币种，如 BTC、PEPE" autocomplete="off"><div class="card list" style="padding:0;margin-top:12px" id="sRes"><div class="empty">输入关键字搜索现货与合约</div></div>`);
  setTimeout(() => $('#sIn').focus(), 350);
  if (!M.spot.length) spotTickers().then(l => M.spot = l).catch(() => {});
  if (!M.fut.length) futTickers().then(l => M.fut = l).catch(() => {});
  $('#sIn').oninput = () => {
    const q = $('#sIn').value.trim().toUpperCase(); if (!q) return;
    const res = [...M.spot.map(t => [t, 'spot']), ...M.fut.map(t => [t, 'fut'])].filter(([t]) => t.base.includes(q)).sort((a, b) => (a[0].base === q ? -1 : 0) - (b[0].base === q ? -1 : 0) || b[0].qv - a[0].qv).slice(0, 30);
    $('#sRes').innerHTML = res.length ? res.map(([t, mk]) => `<div class="row" data-sym="${t.sym}" data-mk="${mk}"><div class="l"><div class="sym">${esc(t.base)}<small>/USDT</small><span class="tag ${mk === 'fut' ? 'blue' : ''}">${mk === 'fut' ? '永续' : '现货'}</span></div><div class="sub">额 ${fvol(t.qv)}</div></div><div class="px">${fpx(t.price)}</div><div class="pill ${t.chg >= 0 ? 'bg-up' : 'bg-down'}">${fpct(t.chg)}</div></div>`).join('') : '<div class="empty">无匹配币种</div>';
  };
};

/* ---------------- 热点异动 + 上新 ---------------- */
const H = { th1: 1, th5: 2.5, pulse: null, err: null, newFut: null, newSpot: null, last: 0 };
async function pollPulse() {
  try {
    if (!M.spot.length) M.spot = await spotTickers();
    const top = M.spot.slice().sort((a, b) => b.qv - a.qv).slice(0, 100).map(t => t.sym);
    const [r1, r5, r15] = await Promise.all([rolling(top, '1m'), rolling(top, '5m'), rolling(top, '15m')]);
    H.pulse = top.map(s => ({ sym: s, base: s.replace(/USDT$/, ''), c1: r1[s] && r1[s].chg, c5: r5[s] && r5[s].chg, c15: r15[s] && r15[s].chg, q5: r5[s] && r5[s].qv, q15: r15[s] && r15[s].qv, price: r1[s] && r1[s].price }))
      .filter(x => x.c1 != null && x.c5 != null);
    H.err = null; H.last = Date.now();
  } catch (e) { H.err = e.message; }
  if (PAGE === 'hot') renderHotLists();
}
async function loadNew() {
  try {
    const src = await detectFut();
    if (src === 'binance') {
      const d = await getJSON('https://fapi.binance.com/fapi/v1/exchangeInfo');
      H.newFut = d.symbols.filter(s => s.quoteAsset === 'USDT' && s.contractType === 'PERPETUAL').sort((a, b) => b.onboardDate - a.onboardDate).slice(0, 10).map(s => ({ sym: s.symbol, base: s.baseAsset, t: s.onboardDate, st: s.status, src: 'Binance' }));
    } else if (src === 'okx') {
      const d = await getJSON('https://www.okx.com/api/v5/public/instruments?instType=SWAP');
      H.newFut = d.data.filter(s => s.settleCcy === 'USDT').sort((a, b) => b.listTime - a.listTime).slice(0, 10).map(s => ({ sym: fromOkx(s.instId), base: s.instId.split('-')[0], t: +s.listTime, st: s.state, src: 'OKX' }));
    } else H.newFut = [];
  } catch { H.newFut = []; }
  try {
    if (!M.spot.length) M.spot = await spotTickers();
    // newest spot pairs have the lowest cumulative trade ids; confirm listing date with the first daily candle
    const cand = M.spot.filter(t => t.firstId >= 0 && t.count > 0).sort((a, b) => a.firstId - b.firstId).slice(0, 14);
    const firsts = await Promise.all(cand.map(t => spot(`/api/v3/klines?symbol=${t.sym}&interval=1d&startTime=0&limit=1`).then(k => k[0] ? +k[0][0] : null).catch(() => null)));
    H.newSpot = cand.map((t, i) => Object.assign({}, t, { t: firsts[i] })).filter(x => x.t).sort((a, b) => b.t - a.t).slice(0, 10);
  } catch { H.newSpot = []; }
  if (PAGE === 'hot') renderHotLists();
}
function renderHot() {
  $('#p-hot').innerHTML = `<div class="card"><div style="font-weight:700;margin-bottom:8px">⚡ 实时异动阈值 <span class="muted">（成交额前100现货，滚动窗口）</span></div>
    <div class="form"><div class="f"><label>1分钟涨跌 ≥ %</label><input type="number" step="0.1" id="th1" value="${H.th1}"></div><div class="f"><label>5分钟涨跌 ≥ %</label><input type="number" step="0.1" id="th5" value="${H.th5}"></div></div></div>
    <div class="h">异动信号 <span id="hTime"></span></div><div class="card list" style="padding:0" id="hPulse"><div class="empty">正在扫描…</div></div>
    <div class="h">5分钟涨跌幅榜</div><div class="card list" style="padding:0" id="hTop"></div>
    <div class="h">🆕 合约上新 <span class="muted" id="nfSrc"></span></div><div class="card list" style="padding:0" id="hNewF"><div class="empty">加载中…</div></div>
    <div class="h">🆕 现货新币</div><div class="card list" style="padding:0" id="hNewS"><div class="empty">加载中…</div></div>
    <div class="muted" style="padding:0 4px">现货上新依据：成交序号最小的交易对 + 首根日K时间确认（币安现货接口无上架时间字段）。</div>`;
  $('#th1').onchange = e => { H.th1 = +e.target.value; renderHotLists(); };
  $('#th5').onchange = e => { H.th5 = +e.target.value; renderHotLists(); };
  renderHotLists(); if (!H.pulse) pollPulse(); if (!H.newFut) loadNew();
}
function renderHotLists() {
  const p = $('#hPulse'); if (!p) return;
  if (H.err && !H.pulse) { p.innerHTML = `<div class="empty">数据源不可用（${esc(H.err)}）</div>`; }
  if (H.pulse) {
    const sig = H.pulse.filter(x => Math.abs(x.c1) >= H.th1 || Math.abs(x.c5) >= H.th5).map(x => {
      const ratio = x.q15 ? (x.q5 / (x.q15 / 3)) : 0;
      return Object.assign(x, { kind: (Math.abs(x.c1) >= H.th1 ? (x.c1 > 0 ? '1分钟急拉' : '1分钟急跌') : (x.c5 > 0 ? '5分钟拉升' : '5分钟下砸')), ratio });
    }).sort((a, b) => Math.abs(b.c5) - Math.abs(a.c5));
    p.innerHTML = sig.length ? sig.map(x => `<div class="row" data-sym="${x.sym}" data-mk="spot"><div class="l"><div class="sym">${esc(x.base)}<span class="tag ${x.c5 >= 0 ? 'up' : 'down'}">${x.kind}</span>${x.ratio >= 2 ? '<span class="tag warn">放量</span>' : ''}</div>
      <div class="sub">1m <span class="${cls(x.c1)}">${fpct(x.c1)}</span> · 5m <span class="${cls(x.c5)}">${fpct(x.c5)}</span> · 15m <span class="${cls(x.c15)}">${fpct(x.c15)}</span></div></div><div class="px">${fpx(x.price)}</div></div>`).join('')
      : `<div class="empty">当前无达到阈值的异动（1m≥${H.th1}% 或 5m≥${H.th5}%）<br>每 15 秒自动扫描</div>`;
    const top = H.pulse.slice().sort((a, b) => Math.abs(b.c5) - Math.abs(a.c5)).slice(0, 10);
    $('#hTop').innerHTML = top.map(x => `<div class="row" data-sym="${x.sym}" data-mk="spot"><div class="l"><div class="sym">${esc(x.base)}</div><div class="sub">1m ${fpct(x.c1)} · 5m额 ${fvol(x.q5)}</div></div><div class="px">${fpx(x.price)}</div><div class="pill ${x.c5 >= 0 ? 'bg-up' : 'bg-down'}">${fpct(x.c5)}</div></div>`).join('');
    $('#hTime').textContent = new Date(H.last).toLocaleTimeString();
  }
  if (H.newFut) {
    $('#nfSrc').textContent = H.newFut[0] ? '来源 ' + H.newFut[0].src : '';
    $('#hNewF').innerHTML = H.newFut.length ? H.newFut.map(x => `<div class="row" data-sym="${x.sym}" data-mk="fut"><div class="l"><div class="sym">${esc(x.base)}<small>/USDT 永续</small></div><div class="sub">上线 ${ftime(x.t)}</div></div><span class="tag ${x.t > Date.now() ? 'warn' : 'blue'}">${x.t > Date.now() ? '即将上线' : esc(x.st)}</span></div>`).join('') : '<div class="empty">数据源不可用</div>';
  }
  if (H.newSpot) $('#hNewS').innerHTML = H.newSpot.length ? H.newSpot.map(x => `<div class="row" data-sym="${x.sym}" data-mk="spot"><div class="l"><div class="sym">${esc(x.base)}<small>/USDT</small></div><div class="sub">首根K线 ${fdate(x.t)} · 额 ${fvol(x.qv)}</div></div><div class="px">${fpx(x.price)}</div><div class="pill ${x.chg >= 0 ? 'bg-up' : 'bg-down'}">${fpct(x.chg)}</div></div>`).join('') : '<div class="empty">数据源不可用</div>';
}

/* ---------------- Paper engine adapters (local / backend) ---------------- */
const PRICES = { spot: {}, fut: {} };
const LS = 'lq_paper_v1';
const Local = {
  mode: 'local',
  load() { try { this.state = JSON.parse(localStorage.getItem(LS)) || C.newState(10000); } catch { this.state = C.newState(10000); } this.eng = new C.Engine(this.state); },
  save() { localStorage.setItem(LS, JSON.stringify(this.state)); },
  async evaluate(cfg) { const k = await histKlines(cfg.symbol, cfg.interval, cfg.bars, cfg.market); if (k.length < 120) throw new Error('K线数据不足'); const bt = C.backtest(k, cfg); return C.evaluate(k, cfg, bt); },
  async start(cfg, ev, gate) { this.eng.start(cfg, ev, gate); this.save(); },
  async stop(id) { this.eng.stop(id); this.save(); },
  async stopAll() { this.eng.stopAll(); this.save(); },
  async closeAll() { await refreshPaperPrices(); this.eng.closeAll(this.prices(), '一键平仓'); this.save(); },
  async reset(n) { this.state = C.newState(n); this.eng = new C.Engine(this.state); this.eng.log(`模拟账户已重置，初始资金 ${n} USDT`); this.save(); },
  prices() { const p = {}; this.state.instances.concat(this.state.positions).forEach(x => { const mk = (x.market || (x.cfg && x.cfg.market) || 'spot'); const v = PRICES[mk][x.symbol]; if (v) p[x.symbol] = v; }); return p; },
  async snapshot() { return { state: this.state, summary: this.eng.summary(this.prices()), prices: this.prices() }; },
};
const Remote = {
  mode: 'remote', url: '',
  async call(path, body) { const r = await fetch(this.url + path, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json', ...(Remote.token ? { Authorization: 'Bearer ' + Remote.token } : {}) }, body: body ? JSON.stringify(body) : undefined }); const d = await r.json(); if (!r.ok) throw new Error(d.error || r.status); return d; },
  evaluate(cfg) { return this.call('/api/evaluate', cfg); },
  start(cfg, ev, gate) { return this.call('/api/strategies', { cfg, gate }); },
  stop(id) { return this.call(`/api/strategies/${id}/stop`, {}); },
  stopAll() { return this.call('/api/stop-all', {}); },
  closeAll() { return this.call('/api/close-all', {}); },
  reset(n) { return this.call('/api/reset', { initial: n }); },
  snapshot() { return this.call('/api/state'); },
};
let ENG = Local; Local.load();
async function initBackend() {
  const url = (localStorage.getItem('lq_backend') || '').replace(/\/$/, ''); Remote.token = localStorage.getItem('lq_backend_token') || '';
  if (!url) return;
  try { Remote.url = url; await Remote.call('/api/health'); ENG = Remote; toast('已连接后端策略引擎'); }
  catch { ENG = Local; toast('后端不可用，已回退到浏览器内模拟'); }
}
async function refreshPaperPrices() {
  const st = Local.state; const need = { spot: new Set(), fut: new Set() };
  st.instances.filter(i => i.running).concat(st.positions).forEach(x => need[x.market || (x.cfg && x.cfg.market) || 'spot'].add(x.symbol));
  if (need.spot.size) { try { const d = await spot(`/api/v3/ticker/price?symbols=${encodeURIComponent(JSON.stringify([...need.spot]))}`); d.forEach(x => PRICES.spot[x.symbol] = +x.price); } catch {} }
  if (need.fut.size) { try { (await futTickers()).forEach(t => PRICES.fut[t.sym] = t.price); } catch {} }
}
const CANDLE_CACHE = {};
async function paperTick() {
  if (ENG !== Local) { if (PAGE === 'quant' || PAGE === 'board') render[PAGE](true); return; }
  const st = Local.state; if (!st.instances.some(i => i.running) && !st.positions.length) return;
  await refreshPaperPrices();
  const candles = {};
  for (const inst of st.instances.filter(i => i.running)) {
    const key = inst.symbol + inst.cfg.interval; const c = CANDLE_CACHE[key];
    if (!c || Date.now() - c.t > 60000) { try { CANDLE_CACHE[key] = { t: Date.now(), k: await klines(inst.symbol, inst.cfg.interval || '15m', 120, inst.market) }; } catch {} }
    if (CANDLE_CACHE[key]) candles[inst.symbol] = CANDLE_CACHE[key].k;
    // refresh archived evaluation every 15 min so new orders carry a current estimate
    if (Date.now() - (inst.eval ? inst.eval.t : 0) > 15 * 60000) { try { inst.eval = await Local.evaluate(inst.cfg); } catch {} }
  }
  Local.eng.tick({ prices: Local.prices(), candles }); Local.save();
  if (PAGE === 'quant' || PAGE === 'board') render[PAGE](true);
}

/* ---------------- 量化 ---------------- */
const Q = { form: Object.assign({ symbol: 'BTCUSDT', market: 'spot', type: 'grid', interval: '15m', bars: 1500, margin: 100, lev: 3, tp: 1.5, sl: 3, trail: 0, gridRange: 6, gridN: 6, martTrigger: 1.5, martStep: 1.5, martMult: 1.5, martMaxAdds: 3, martLookback: 20 }, JSON.parse(localStorage.getItem('lq_form') || '{}')),
  gate: JSON.parse(localStorage.getItem('lq_gate') || '{"on":true,"min":55}'), ev: null, busy: false };
const fld = (k, label, step = 'any') => `<div class="f"><label>${label}</label><input data-k="${k}" type="number" step="${step}" value="${Q.form[k]}"></div>`;
function renderQuant(soft) {
  if (soft && document.activeElement && document.activeElement.closest('#p-quant')) { renderRunning(); return; }
  if (soft) { renderRunning(); return; }
  const f = Q.form;
  $('#p-quant').innerHTML = `
  <div class="card">
    <div class="seg" id="qType"><button data-t="grid" class="${f.type === 'grid' ? 'on' : ''}">网格策略</button><button data-t="martingale" class="${f.type === 'martingale' ? 'on' : ''}">马丁策略</button></div>
    <div class="form" style="margin-top:12px">
      <div class="f"><label>交易对</label><input data-k="symbol" data-s="1" value="${esc(f.symbol)}"></div>
      <div class="f"><label>市场</label><select data-k="market" data-s="1"><option value="spot" ${f.market === 'spot' ? 'selected' : ''}>现货K线/价格</option><option value="fut" ${f.market === 'fut' ? 'selected' : ''}>合约K线/价格</option></select></div>
      <div class="f"><label>回测周期</label><select data-k="interval" data-s="1">${['5m', '15m', '1h', '4h'].map(i => `<option ${f.interval === i ? 'selected' : ''}>${i}</option>`).join('')}</select></div>
      <div class="f"><label>回测K线数</label><select data-k="bars">${[500, 1000, 1500].map(i => `<option ${+f.bars === i ? 'selected' : ''}>${i}</option>`).join('')}</select></div>
      ${fld('margin', '每单保证金 (USDT)')}${fld('lev', '杠杆 (x)', '1')}
      ${fld('tp', '止盈 %')}${fld('sl', '止损 %')}
      ${fld('trail', '移动止盈回撤 %（0=关闭）')}
      ${f.type === 'grid' ? fld('gridRange', '网格区间 %') + fld('gridN', '网格数量', '1') : fld('martTrigger', '触发回撤 %') + fld('martStep', '加仓间距 %') + fld('martMult', '加仓倍数') + fld('martMaxAdds', '最大加仓次数', '1') + fld('martLookback', '高点回看K线数', '1')}
    </div>
    <button class="btn blue rip" id="qEval">${Q.busy ? '回测中…' : '📐 回测 + 开仓前评估'}</button>
    <div class="muted" style="margin-top:6px">回测使用币安真实历史K线（最多1500根），含 0.05% 单边手续费；同一根K线同时触及止盈/止损按止损计（保守）。</div>
  </div>
  <div id="qEvalCard"></div>
  <div class="card"><div class="switch"><div><b>低于 <input id="gMin" type="number" value="${Q.gate.min}" style="width:54px;border:1px solid var(--line);border-radius:8px;padding:3px 6px;font-size:15px"> % 胜率放弃开仓</b><div class="muted">开启后，评估胜率低于阈值时策略只记录、不下单</div></div><div class="sw ${Q.gate.on ? 'on' : ''}" id="gSw"></div></div>
    <button class="btn rip" id="qStart">▶️ 启动模拟盘策略</button>
    <div class="muted" style="margin-top:6px">模式：${ENG === Remote ? '🟢 后端策略引擎（页面关闭后持续运行）' : '浏览器内模拟（需保持页面打开；数据存于本机 localStorage）'}</div></div>
  <div class="btns2" style="margin-bottom:12px"><button class="btn red rip" id="qStopAll">⛔ 一键停止全部</button><button class="btn red rip" id="qCloseAll" style="background:#ff6b6b">💥 一键平仓全部</button></div>
  <div class="h">运行中的策略</div><div class="card" id="qRun"></div>
  <div class="h">当前持仓</div><div class="card" id="qPos"></div>
  <div class="h">运行日志</div><div class="card"><div class="log" id="qLog"></div></div>`;
  document.querySelectorAll('#p-quant [data-k]').forEach(i => i.onchange = () => {
    let v = i.value; if (i.dataset.k === 'symbol') { v = v.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (!v.endsWith('USDT')) v += 'USDT'; i.value = v; } else if (!i.dataset.s) v = +v;
    Q.form[i.dataset.k] = v; localStorage.setItem('lq_form', JSON.stringify(Q.form)); Q.ev = null; $('#qEvalCard').innerHTML = '';
  });
  $('#qType').onclick = e => { const b = e.target.closest('button'); if (!b) return; Q.form.type = b.dataset.t; Q.ev = null; localStorage.setItem('lq_form', JSON.stringify(Q.form)); renderQuant(); };
  $('#gSw').onclick = () => { Q.gate.on = !Q.gate.on; $('#gSw').classList.toggle('on', Q.gate.on); saveGate(); };
  $('#gMin').onchange = e => { Q.gate.min = +e.target.value; saveGate(); renderEval(); };
  $('#qEval').onclick = runEval;
  $('#qStart').onclick = async () => {
    if (!Q.ev || JSON.stringify(Q.ev.cfg) !== JSON.stringify(Q.form)) { await runEval(); if (!Q.ev) return; }
    if (Q.gate.on && Q.ev.winRate * 100 < Q.gate.min) toast(`当前胜率 ${(Q.ev.winRate * 100).toFixed(1)}% 低于阈值，策略将等待更优评估后再开仓`);
    try { await ENG.start(Object.assign({}, Q.form), Q.ev, { gate: Q.gate.on, minWin: Q.gate.min }); toast('模拟策略已启动'); renderRunning(); paperTick(); } catch (e) { toast('启动失败：' + e.message); }
  };
  $('#qStopAll').onclick = async () => { if (!confirm('确认停止全部策略？（持仓保留）')) return; await ENG.stopAll(); toast('已停止全部策略'); renderRunning(); };
  $('#qCloseAll').onclick = async () => { if (!confirm('确认按最新价平掉全部模拟持仓？')) return; await ENG.closeAll(); toast('已平仓全部'); renderRunning(); };
  renderEval(); renderRunning();
}
function saveGate() { localStorage.setItem('lq_gate', JSON.stringify(Q.gate)); }
async function runEval() {
  if (Q.busy) return; Q.busy = true; $('#qEval').textContent = '回测中…（拉取真实历史K线）';
  try { Q.ev = await ENG.evaluate(Object.assign({}, Q.form)); Q.ev.cfg = Object.assign({}, Q.form); renderEval(); setTimeout(() => $('#qEvalCard').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50); }
  catch (e) { $('#qEvalCard').innerHTML = `<div class="card empty">评估失败：数据源不可用或交易对不存在（${esc(e.message)}）</div>`; }
  Q.busy = false; const b = $('#qEval'); if (b) b.textContent = '📐 回测 + 开仓前评估';
}
function renderEval() {
  const e = Q.ev, el = $('#qEvalCard'); if (!el) return; if (!e) { el.innerHTML = ''; return; }
  const pass = !Q.gate.on || e.winRate * 100 >= Q.gate.min;
  el.innerHTML = `<div class="card eval"><div style="display:flex;justify-content:space-between;align-items:flex-start">
    <div><div class="muted">开仓前评估 · ${esc(e.symbol)} · ${e.type === 'grid' ? '网格' : '马丁'}</div><div class="wr ${e.winRate >= .5 ? 'up' : 'down'}">${(e.winRate * 100).toFixed(1)}%</div><div class="muted">${e.similarOnly ? '相似条件' : '全部'}历史胜率 · 样本 ${e.samples} 笔</div></div>
    <div style="text-align:right"><span class="tag ${pass ? 'up' : 'down'}">${pass ? '✅ 允许开仓' : '🚫 低于阈值 放弃开仓'}</span><br><span class="tag ${e.signal ? 'blue' : ''}" style="margin-top:6px">${e.signal ? '当前满足入场信号' : '当前未触发入场'}</span></div></div>
    <div class="kv" style="margin-top:12px">
      <div><span>单笔预期收益</span><b class="${cls(e.expected)}">${e.expected >= 0 ? '+' : ''}${fmt(e.expected)} U</b></div>
      <div><span>止损最大亏损</span><b class="down">-${fmt(e.maxLoss)} U</b></div>
      <div><span>盈亏比（均盈/均亏）</span><b>${e.rr ? e.rr.toFixed(2) : '--'}</b></div>
      <div><span>平均盈利 / 亏损</span><b><span class="up">+${fmt(e.avgWin)}</span> / <span class="down">-${fmt(e.avgLoss)}</span></b></div>
      <div><span>回测总盈亏（${e.bt.n} 笔）</span><b class="${cls(e.bt.total)}">${fmt(e.bt.total)} U</b></div>
      <div><span>回测最大回撤</span><b class="down">-${fmt(e.bt.maxDD)} U</b></div></div>
    ${e.samples < 10 ? '<div class="reason" style="background:rgba(255,149,0,.1);color:#8a4b00">⚠️ 回测样本仅 ' + e.samples + ' 笔，胜率统计参考意义有限。</div>' : ''}
    ${e.expected < 0 ? '<div class="reason" style="background:rgba(229,56,59,.08);color:#9b1c1f">⚠️ 该参数在回测中单笔期望为负，即使胜率较高，长期大概率亏损，建议调整参数。</div>' : ''}
    ${Q.form.tp <= 0.1 ? '<div class="reason" style="background:rgba(255,149,0,.1);color:#8a4b00">⚠️ 止盈幅度 ≤ 双边手续费 0.1%，触发止盈也会亏损。</div>' : ''}
    <div class="reason">📝 信号理由：${esc(e.reason)}</div>
    <div class="muted" style="margin-top:8px">回测区间 ${fdate(e.bt.from)} ~ ${fdate(e.bt.to)} · ${e.bt.bars} 根K线 · 当前价 ${fpx(e.price)}<br>⚠️ 胜率/预估为历史回测估算，不代表未来，不保证盈利。</div></div>`;
}
async function renderRunning() {
  if (!$('#qRun')) return;
  let snap; try { snap = await ENG.snapshot(); } catch (e) { $('#qRun').innerHTML = `<div class="empty">后端不可用：${esc(e.message)}</div>`; return; }
  const st = snap.state, px = snap.prices || {};
  const ins = st.instances.slice().reverse();
  $('#qRun').innerHTML = ins.length ? ins.map(i => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--line)">
    <div><b>${i.id}</b> ${esc(i.symbol)} <span class="tag">${i.cfg.type === 'grid' ? '网格' : '马丁'}</span><span class="tag ${i.running ? 'up' : ''}">${i.running ? '运行中' : '已停止'}</span>${i.gate.on ? `<span class="tag warn">≥${i.gate.min}%</span>` : ''}
    <div class="muted">${i.cfg.margin}U×${i.cfg.lev}x · TP ${i.cfg.tp}% · SL ${i.cfg.sl}%${i.cfg.trail ? ' · 移动 ' + i.cfg.trail + '%' : ''} · 评估胜率 ${i.eval ? (i.eval.winRate * 100).toFixed(1) + '%' : '-'}</div></div>
    ${i.running ? `<button class="chip" data-stop="${i.id}">停止</button>` : ''}</div>`).join('') : '<div class="empty">暂无策略，先回测评估再启动</div>';
  document.querySelectorAll('[data-stop]').forEach(b => b.onclick = async () => { await ENG.stop(b.dataset.stop); renderRunning(); });
  $('#qPos').innerHTML = st.positions.length ? `<table class="t"><tr><th>币种</th><th>均价</th><th>现价</th><th>浮盈</th></tr>${st.positions.map(p => {
    const cur = px[p.symbol]; const u = cur ? C.posPnl(p, cur, p.cfg).net : null;
    return `<tr><td>${esc(p.symbol.replace('USDT', ''))}<span class="tag">${p.fills.length > 1 ? '加仓' + (p.fills.length - 1) : p.cfg.lev + 'x'}</span></td><td>${fpx(p.avg)}</td><td>${fpx(cur)}</td><td class="${cls(u)}">${u == null ? '--' : fmt(u)}</td></tr>`; }).join('')}</table>` : '<div class="empty">无持仓</div>';
  $('#qLog').innerHTML = st.logs.length ? st.logs.slice(0, 120).map(l => `<div class="${l.lvl}">${ftime(l.t)} ${esc(l.msg)}</div>`).join('') : '<div class="empty">暂无日志</div>';
}

/* ---------------- 看板 ---------------- */
const B = { period: 'today' };
async function renderBoard() {
  let snap; try { snap = await ENG.snapshot(); } catch (e) { $('#p-board').innerHTML = `<div class="card empty">后端不可用：${esc(e.message)}</div>`; return; }
  const st = snap.state, s = snap.summary, orders = st.orders;
  const now = new Date(); const day0 = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const since = { today: day0, '7d': Date.now() - 7 * 864e5, '30d': Date.now() - 30 * 864e5, all: 0 }[B.period];
  const ps = C.stats(orders, since);
  const strat = {}; orders.forEach(o => { const k = o.strategy; (strat[k] = strat[k] || []).push(o); });
  $('#p-board').innerHTML = `
  <div class="card"><div class="muted">模拟账户总资产 (USDT)${ENG === Remote ? ' · 后端' : ''}</div><div class="big">${fmt(s.equity)}</div>
    <div class="${cls(s.ret)}" style="font-weight:600">总收益 ${fpct(s.ret * 100)}（${s.equity - s.initial >= 0 ? '+' : ''}${fmt(s.equity - s.initial)} U）</div>
    <div class="kv kv3" style="margin-top:12px"><div><span>可用</span><b>${fmt(s.available)}</b></div><div><span>占用保证金</span><b>${fmt(s.marginUsed)}</b></div><div><span>未实现盈亏</span><b class="${cls(s.unrealized)}">${fmt(s.unrealized)}</b></div></div></div>
  <div class="seg" id="bSeg">${[['today', '今日'], ['7d', '7天'], ['30d', '30天'], ['all', '全部']].map(([k, n]) => `<button data-k="${k}" class="${B.period === k ? 'on' : ''}">${n}</button>`).join('')}</div>
  <div class="card kv kv3" style="margin-top:12px">
    <div><span>订单数</span><b>${ps.n}</b></div><div><span>盈利单</span><b class="up">${ps.wins}</b></div><div><span>亏损单</span><b class="down">${ps.losses}</b></div>
    <div><span>总盈利</span><b class="up">+${fmt(ps.gp)}</b></div><div><span>总亏损</span><b class="down">${fmt(ps.gl)}</b></div><div><span>净盈亏</span><b class="${cls(ps.net)}">${fmt(ps.net)}</b></div></div>
  <div class="h">资金曲线</div><div class="card">${orders.length ? '<canvas id="eqC" height="150"></canvas>' : '<div class="empty">暂无已平仓订单，启动模拟策略后自动生成</div>'}</div>
  <div class="h">每日盈亏</div><div class="card">${orders.length ? '<canvas id="dayC" height="130"></canvas>' : '<div class="empty">暂无数据</div>'}</div>
  <div class="h">分策略统计</div><div class="card">${Object.keys(strat).length ? `<table class="t"><tr><th>策略</th><th>笔数</th><th>胜率</th><th>累计盈亏</th></tr>${Object.entries(strat).map(([k, os]) => { const x = C.stats(os); return `<tr><td>${k === 'grid' ? '网格' : '马丁'}</td><td>${x.n}</td><td>${(x.winRate * 100).toFixed(1)}%</td><td class="${cls(x.net)}">${fmt(x.net)}</td></tr>`; }).join('')}</table>` : '<div class="empty">暂无数据</div>'}</div>
  <div class="h">订单记录（预估 vs 实际）</div><div class="card">${orders.length ? orders.slice(0, 50).map(o => `<div style="padding:9px 0;border-bottom:1px solid var(--line)">
    <div style="display:flex;justify-content:space-between"><b>${esc(o.symbol)} <span class="tag">${o.strategy === 'grid' ? '网格' : '马丁'}</span><span class="tag ${o.win ? 'up' : 'down'}">${esc(o.reason)}</span></b><b class="${cls(o.pnl)}">${o.pnl >= 0 ? '+' : ''}${fmt(o.pnl)} U</b></div>
    <div class="muted">${ftime(o.openTime)} → ${ftime(o.closeTime)} · 均价 ${fpx(o.avg)} → ${fpx(o.exit)} · ${o.lev}x${o.adds ? ' · 加仓' + o.adds : ''}</div>
    ${o.est ? `<div class="muted">开仓前预估：胜率 ${(o.est.winRate * 100).toFixed(1)}% · 预期 ${fmt(o.est.expected)}U · 最大亏损 -${fmt(o.est.maxLoss)}U · 盈亏比 ${o.est.rr ? o.est.rr.toFixed(2) : '--'} ｜ 实际 <span class="${cls(o.pnl)}">${fmt(o.pnl)}U</span></div>` : ''}</div>`).join('') : '<div class="empty">暂无订单</div>'}</div>
  <div class="muted" style="text-align:center;margin:8px 0">以上全部由模拟盘真实成交记录计算 · 不构成投资建议</div>`;
  $('#bSeg').onclick = e => { const b = e.target.closest('button'); if (!b) return; B.period = b.dataset.k; renderBoard(); };
  if (orders.length) {
    const asc = orders.slice().sort((a, b) => a.closeTime - b.closeTime); let eq = st.initial; const pts = [st.initial], ts = [asc[0].openTime];
    asc.forEach(o => { eq += o.pnl; pts.push(eq); ts.push(o.closeTime); }); lineChart($('#eqC'), pts, ts);
    const days = {}; asc.forEach(o => { const d = fdate(o.closeTime); days[d] = (days[d] || 0) + o.pnl; }); const keys = Object.keys(days).slice(-30);
    barChart($('#dayC'), keys.map(k => days[k]), keys.map(k => k.slice(5)));
  }
}

/* ---------------- 更多 ---------------- */
function renderMore() {
  $('#p-more').innerHTML = `
  <div class="card"><b>🐋 链上鲸鱼监控</b><span class="tag warn">即将上线</span><div class="soon" style="margin-top:6px">即将上线（需要数据源Key，如 Arkham / Whale Alert / Nansen）</div></div>
  <div class="card"><b>🗣 KOL 动态</b><span class="tag warn">即将上线</span><div class="soon" style="margin-top:6px">即将上线（需要数据源Key，如 X API）</div></div>
  <div class="card"><b>🔌 后端策略引擎</b><div class="muted" style="margin:6px 0">填写自建后端地址（见仓库 /server），策略将在服务器上 24 小时运行，页面关闭也不中断。留空则使用浏览器内模拟。</div>
    <div class="f"><input id="beUrl" placeholder="https://your-vps.example.com" value="${esc(localStorage.getItem('lq_backend') || '')}"></div>
    <div class="f" style="margin-top:8px"><input id="beTok" placeholder="访问令牌 API_TOKEN（可选）" value="${esc(localStorage.getItem('lq_backend_token') || '')}"></div>
    <button class="btn ghost rip" id="beSave">保存并连接</button><div class="muted" style="margin-top:6px">当前：${ENG === Remote ? '🟢 已连接 ' + esc(Remote.url) : '浏览器内模式'}</div></div>
  <div class="card"><b>🔐 实盘交易（交易所 API）</b><span class="tag">V1 已禁用</span><div class="muted" style="margin-top:6px;line-height:1.7">
    出于安全考虑，H5 页面<b>不会</b>在浏览器中保存任何交易所 API Key，也不会直接下实盘单。<br>
    实盘功能仅在自建后端提供：API Key 在服务器端 AES-256-GCM 加密存储、永不回传前端，且必须设置环境变量 <code>LIVE_TRADING=true</code> 才会启用。<br>
    建议：API Key 仅开启「交易」权限，<b>关闭提现</b>，并绑定服务器 IP 白名单。</div></div>
  <div class="card"><b>🧪 模拟账户</b><div class="form" style="margin-top:8px"><div class="f full"><label>初始资金 (USDT)</label><input id="rsN" type="number" value="10000"></div></div>
    <button class="btn ghost rip" id="rsBtn">重置模拟账户（清空订单与日志）</button></div>
  <div class="card"><b>📡 数据源状态</b><div class="muted" style="margin-top:6px;line-height:1.8">现货：${esc(SRC.spot || '不可用')}<br>合约：${SRC.fut === 'binance' ? 'Binance USDT-M (fapi)' : SRC.fut === 'okx' ? 'OKX 永续（币安合约不可用时自动切换）' : SRC.fut === 'none' ? '不可用' : '检测中'}<br>所有行情均为交易所公开接口实时数据，无任何模拟数字。</div></div>
  <div class="card" style="background:rgba(229,56,59,.06)"><b class="down">⚠️ 风险提示</b><div class="small" style="margin-top:6px;line-height:1.7">胜率/预估为历史回测估算，不代表未来，不保证盈利。加密资产波动剧烈，合约与杠杆可能导致本金全部损失。本工具仅供学习研究，不构成任何投资建议。</div></div>`;
  $('#beSave').onclick = async () => { localStorage.setItem('lq_backend', $('#beUrl').value.trim()); localStorage.setItem('lq_backend_token', $('#beTok').value.trim()); ENG = Local; await initBackend(); renderMore(); };
  $('#rsBtn').onclick = async () => { if (!confirm('确认重置模拟账户？所有模拟订单与日志将清空')) return; await ENG.reset(+$('#rsN').value || 10000); toast('已重置'); };
}

/* ---------------- Canvas charts ---------------- */
function setupCanvas(cv) { const dpr = window.devicePixelRatio || 1; const w = cv.clientWidth || 340, h = +cv.getAttribute('height'); cv.width = w * dpr; cv.height = h * dpr; cv.style.height = h + 'px'; const x = cv.getContext('2d'); x.scale(dpr, dpr); return { x, w, h }; }
function lineChart(cv, vals, ts) {
  if (!cv || vals.length < 2) return; const { x, w, h } = setupCanvas(cv); const pad = 6;
  const mn = Math.min(...vals), mx = Math.max(...vals), rg = mx - mn || 1; const up = vals[vals.length - 1] >= vals[0]; const col = up ? '#16a34a' : '#e5383b';
  const X = i => pad + i / (vals.length - 1) * (w - pad * 2), Y = v => pad + (1 - (v - mn) / rg) * (h - pad * 2 - 14);
  const g = x.createLinearGradient(0, 0, 0, h); g.addColorStop(0, up ? 'rgba(22,163,74,.22)' : 'rgba(229,56,59,.22)'); g.addColorStop(1, 'rgba(255,255,255,0)');
  x.beginPath(); vals.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v))); x.lineTo(X(vals.length - 1), h - 14); x.lineTo(X(0), h - 14); x.fillStyle = g; x.fill();
  x.beginPath(); vals.forEach((v, i) => i ? x.lineTo(X(i), Y(v)) : x.moveTo(X(i), Y(v))); x.strokeStyle = col; x.lineWidth = 2; x.lineJoin = 'round'; x.stroke();
  x.fillStyle = '#8e8e93'; x.font = '10px -apple-system,sans-serif'; x.fillText(fpx(mx), pad, 12); x.fillText(fpx(mn), pad, h - 18);
  if (ts) { x.fillText(ftime(ts[0]), pad, h - 2); const e = ftime(ts[ts.length - 1]); x.fillText(e, w - pad - x.measureText(e).width, h - 2); }
}
function barChart(cv, vals, labels) {
  if (!cv || !vals.length) return; const { x, w, h } = setupCanvas(cv); const mx = Math.max(...vals.map(Math.abs)) || 1; const mid = (h - 14) / 2; const bw = (w - 10) / vals.length;
  x.strokeStyle = '#e5e5ea'; x.beginPath(); x.moveTo(0, mid); x.lineTo(w, mid); x.stroke();
  vals.forEach((v, i) => { const bh = Math.abs(v) / mx * (mid - 4); x.fillStyle = v >= 0 ? '#16a34a' : '#e5383b'; const bx = 5 + i * bw + bw * .15; x.beginPath(); x.roundRect ? x.roundRect(bx, v >= 0 ? mid - bh : mid, bw * .7, Math.max(bh, 1), 3) : x.rect(bx, v >= 0 ? mid - bh : mid, bw * .7, Math.max(bh, 1)); x.fill(); });
  x.fillStyle = '#8e8e93'; x.font = '10px -apple-system,sans-serif'; x.fillText(labels[0], 4, h - 2); const l = labels[labels.length - 1]; x.fillText(l, w - x.measureText(l).width - 4, h - 2);
}

/* ---------------- boot ---------------- */
const render = { market: renderMarket, hot: renderHot, quant: renderQuant, board: renderBoard, more: renderMore };
window.LQ = { go, state: () => Local.state, Q, M, H, SRC };
(async () => {
  renderMarket(); detectFut();
  await initBackend();
  pollMarket(); setInterval(() => { if (PAGE === 'market' && !document.hidden) pollMarket(); }, 4000);
  setInterval(() => { if (PAGE === 'hot' && !document.hidden) pollPulse(); }, 15000);
  setInterval(paperTick, 4000);
  const hp = location.hash.slice(1); if (render[hp]) go(hp);
})();
})();
