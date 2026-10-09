/* LeoQuant core: indicators, backtest, pre-trade evaluation, paper engine.
   Shared by the H5 (browser) and the /server Node engine. No mock data: all inputs are real klines/prices. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.LQCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  const FEE = 0.0005; // taker fee per side (0.05%)

  function parseBinanceKlines(rows) {
    return rows.map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[5], qv: +r[7] }));
  }
  function parseOkxCandles(rows) {
    return rows.slice().reverse().map(r => ({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], v: +r[6] || +r[5], qv: +r[7] || (+r[6] * +r[4]) }));
  }
  function ema(vals, n) {
    const k = 2 / (n + 1); const out = []; let e = vals[0];
    for (let i = 0; i < vals.length; i++) { e = i === 0 ? vals[0] : vals[i] * k + e * (1 - k); out.push(e); }
    return out;
  }
  function rsi(vals, n = 14) {
    const out = new Array(vals.length).fill(50); let g = 0, l = 0;
    for (let i = 1; i < vals.length; i++) {
      const d = vals[i] - vals[i - 1]; const up = Math.max(d, 0), dn = Math.max(-d, 0);
      if (i <= n) { g += up / n; l += dn / n; if (i === n) out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
      else { g = (g * (n - 1) + up) / n; l = (l * (n - 1) + dn) / n; out[i] = l === 0 ? 100 : 100 - 100 / (1 + g / l); }
    }
    return out;
  }
  function rsiBucket(r) { return r < 30 ? '超卖(<30)' : r < 50 ? '偏弱(30-50)' : r < 70 ? '偏强(50-70)' : '超买(>70)'; }
  function features(c, i, ind) {
    const vols = c.slice(Math.max(0, i - 48), i).map(x => x.qv);
    const avg = vols.length ? vols.reduce((a, b) => a + b, 0) / vols.length : 0;
    return { rsi: ind.rsi[i], rsiB: rsiBucket(ind.rsi[i]), trend: c[i].c >= ind.ema50[i] ? 'up' : 'down', volRatio: avg ? c[i].qv / avg : 1 };
  }
  function defaults(cfg) {
    return Object.assign({ type: 'grid', margin: 100, lev: 3, tp: 1.5, sl: 3, trail: 0, gridRange: 6, gridN: 6,
      martTrigger: 1.5, martStep: 1.5, martMult: 1.5, martMaxAdds: 3, martLookback: 20 }, cfg || {});
  }

  /* Position exit logic shared by backtest (candle hi/lo) and paper engine (live price -> hi=lo=price). */
  function checkExit(pos, hi, lo, cfg) {
    const avg = pos.avg;
    const liqPx = avg * (1 - 0.95 / cfg.lev);
    const slPx = (pos.firstEntry || avg) * (1 - cfg.sl / 100);
    if (lo <= liqPx && liqPx >= slPx) return { px: liqPx, reason: '强平(模拟)' };
    if (cfg.sl > 0 && lo <= slPx) return { px: slPx, reason: '止损' };
    const tpPx = avg * (1 + cfg.tp / 100);
    if (cfg.trail > 0) {
      if (!pos.trailOn && hi >= tpPx) { pos.trailOn = true; pos.peak = hi; }
      if (pos.trailOn) {
        pos.peak = Math.max(pos.peak, hi);
        const stop = pos.peak * (1 - cfg.trail / 100);
        if (lo <= stop) return { px: Math.max(stop, Math.min(lo, stop)), reason: '移动止盈' };
      }
      return null;
    }
    if (hi >= tpPx) return { px: tpPx, reason: '止盈' };
    return null;
  }
  function posPnl(pos, px, cfg) {
    let notional = 0, qty = 0;
    pos.fills.forEach(f => { notional += f.margin * cfg.lev; qty += f.margin * cfg.lev / f.px; });
    const gross = qty * px - notional;
    const fee = (notional + qty * px) * FEE;
    return { gross, fee, net: gross - fee, notional };
  }
  function mkPos(px, margin, i) { return { fills: [{ px, margin, i }], avg: px, firstEntry: px, trailOn: false, peak: px }; }
  function addFill(pos, px, margin, i) {
    pos.fills.push({ px, margin, i });
    let n = 0, q = 0; pos.fills.forEach(f => { n += f.margin; q += f.margin / f.px; }); pos.avg = n / q;
  }

  function backtest(candles, cfgIn) {
    const cfg = defaults(cfgIn); const c = candles; const closes = c.map(x => x.c);
    const ind = { rsi: rsi(closes), ema50: ema(closes, 50) };
    const trades = []; const start = 60;
    let equity = 0, peakEq = 0, maxDD = 0;
    const close = (pos, ex, i) => {
      const p = posPnl(pos, ex.px, cfg);
      const margin = pos.fills.reduce((a, f) => a + f.margin, 0);
      const net = ex.reason === '强平(模拟)' ? -margin : p.net;
      trades.push({ entryT: c[pos.fills[0].i].t, exitT: c[i].t, entry: pos.fills[0].px, avg: pos.avg, exit: ex.px, adds: pos.fills.length - 1,
        pnl: net, win: net > 0, reason: ex.reason, feat: pos.feat });
      equity += net; peakEq = Math.max(peakEq, equity); maxDD = Math.max(maxDD, peakEq - equity);
    };
    if (cfg.type === 'grid') {
      const step = cfg.gridRange / cfg.gridN / 100; let ref = c[start].c; let open = [];
      for (let i = start + 1; i < c.length; i++) {
        const k = c[i];
        open = open.filter(pos => { const ex = checkExit(pos, k.h, k.l, cfg); if (ex) { close(pos, ex, i); return false; } return true; });
        let lvl = ref * (1 - step);
        while (k.l <= lvl && open.length < cfg.gridN) {
          const pos = mkPos(lvl, cfg.margin, i); pos.feat = features(c, i, ind); open.push(pos); ref = lvl; lvl = ref * (1 - step);
        }
        if (!open.length && k.c >= ref * (1 + step)) ref = k.c;
      }
    } else {
      let pos = null;
      for (let i = start + 1; i < c.length; i++) {
        const k = c[i];
        if (pos) {
          const last = pos.fills[pos.fills.length - 1];
          if (pos.fills.length - 1 < cfg.martMaxAdds && k.l <= last.px * (1 - cfg.martStep / 100)) {
            addFill(pos, last.px * (1 - cfg.martStep / 100), last.margin * cfg.martMult, i);
          }
          const ex = checkExit(pos, k.h, k.l, cfg); if (ex) { close(pos, ex, i); pos = null; }
          continue;
        }
        const hi = Math.max(...c.slice(i - cfg.martLookback, i).map(x => x.h));
        const trig = hi * (1 - cfg.martTrigger / 100);
        if (k.l <= trig) { pos = mkPos(Math.min(trig, k.o), cfg.margin, i); pos.feat = features(c, i, ind); }
      }
    }
    const wins = trades.filter(t => t.win), losses = trades.filter(t => !t.win);
    const sum = a => a.reduce((s, t) => s + t.pnl, 0);
    return { cfg, trades, ind, n: trades.length, winRate: trades.length ? wins.length / trades.length : 0,
      avgWin: wins.length ? sum(wins) / wins.length : 0, avgLoss: losses.length ? -sum(losses) / losses.length : 0,
      total: sum(trades), maxDD, from: c[0] && c[0].t, to: c[c.length - 1] && c[c.length - 1].t, bars: c.length };
  }

  function evaluate(candles, cfgIn, bt) {
    const cfg = defaults(cfgIn); bt = bt || backtest(candles, cfg);
    const i = candles.length - 1; const f = features(candles, i, bt.ind); const px = candles[i].c;
    const similar = bt.trades.filter(t => t.feat && t.feat.rsiB === f.rsiB && t.feat.trend === f.trend);
    const useSim = similar.length >= 8; const set = useSim ? similar : bt.trades;
    const wins = set.filter(t => t.win), losses = set.filter(t => !t.win);
    const wr = set.length ? wins.length / set.length : 0;
    const avgWin = wins.length ? wins.reduce((a, t) => a + t.pnl, 0) / wins.length : 0;
    const avgLoss = losses.length ? -losses.reduce((a, t) => a + t.pnl, 0) / losses.length : 0;
    // worst-case loss at stop-loss for one signal
    let maxLoss;
    if (cfg.type === 'grid') maxLoss = cfg.margin * cfg.lev * (cfg.sl / 100) + cfg.margin * cfg.lev * 2 * FEE;
    else {
      const slPx = px * (1 - cfg.sl / 100); let m = cfg.margin, fpx = px; maxLoss = 0;
      for (let a = 0; a <= cfg.martMaxAdds; a++) { if (a > 0) { fpx = fpx * (1 - cfg.martStep / 100); if (fpx <= slPx) break; m *= cfg.martMult; }
        maxLoss += m * cfg.lev * (1 - slPx / fpx) + m * cfg.lev * 2 * FEE; }
    }
    maxLoss = Math.min(maxLoss, cfg.type === 'grid' ? cfg.margin : Infinity);
    let signal, sigText;
    if (cfg.type === 'grid') { signal = true; sigText = `网格按 ${(cfg.gridRange / cfg.gridN).toFixed(2)}% 间距逐格挂单，价格触及下方格位即开多`; }
    else {
      const hi = Math.max(...candles.slice(-cfg.martLookback - 1, -1).map(x => x.h)); const dd = (1 - px / hi) * 100;
      signal = dd >= cfg.martTrigger; sigText = `距近 ${cfg.martLookback} 根K线高点回撤 ${dd.toFixed(2)}%（触发阈值 ${cfg.martTrigger}%）`;
    }
    const reason = [sigText, `RSI14=${f.rsi.toFixed(1)}（${f.rsiB}）`, `趋势：价格${f.trend === 'up' ? '在' : '低于'} EMA50 ${f.trend === 'up' ? '之上' : ''}`,
      `量比 ${f.volRatio.toFixed(2)}${f.volRatio >= 3 ? '（爆量）' : ''}`,
      useSim ? `相似条件历史样本 ${similar.length} 笔` : `相似条件样本不足（${similar.length} 笔），改用全部 ${bt.trades.length} 笔回测样本`].join('；');
    return { t: Date.now(), symbol: cfgIn.symbol, type: cfg.type, price: px, winRate: wr, samples: set.length, similarOnly: useSim,
      expected: wr * avgWin - (1 - wr) * avgLoss, avgWin, avgLoss, maxLoss, rr: avgLoss > 0 ? avgWin / avgLoss : (cfg.sl ? cfg.tp / cfg.sl : 0),
      signal, reason, feat: { rsi: f.rsi, rsiB: f.rsiB, trend: f.trend, volRatio: f.volRatio },
      bt: { n: bt.n, winRate: bt.winRate, total: bt.total, maxDD: bt.maxDD, from: bt.from, to: bt.to, bars: bt.bars } };
  }

  /* ---------- Paper trading engine (live prices) ---------- */
  function newState(initial) { return { v: 1, initial: initial || 10000, balance: initial || 10000, instances: [], positions: [], orders: [], logs: [], seq: 1 }; }
  function Engine(state, hooks) { this.s = state; this.h = hooks || {}; }
  Engine.prototype.log = function (msg, lvl) {
    const e = { t: Date.now(), msg, lvl: lvl || 'info' }; this.s.logs.unshift(e); if (this.s.logs.length > 400) this.s.logs.length = 400;
    this.h.onLog && this.h.onLog(e);
  };
  Engine.prototype.marginUsed = function () { return this.s.positions.reduce((a, p) => a + p.fills.reduce((b, f) => b + f.margin, 0), 0); };
  Engine.prototype.unrealized = function (prices) {
    return this.s.positions.reduce((a, p) => { const px = prices[p.symbol]; if (!px) return a; const inst = this.inst(p.instId); return a + posPnl(p, px, (inst && inst.cfg) || p.cfg).net; }, 0);
  };
  Engine.prototype.summary = function (prices) {
    const mu = this.marginUsed(), ur = this.unrealized(prices || {});
    return { initial: this.s.initial, balance: this.s.balance, equity: this.s.balance + ur, available: this.s.balance - mu, marginUsed: mu, unrealized: ur,
      ret: (this.s.balance + ur) / this.s.initial - 1 };
  };
  Engine.prototype.inst = function (id) { return this.s.instances.find(x => x.id === id); };
  Engine.prototype.start = function (cfg, evaluation, opts) {
    const id = 'S' + (this.s.seq++);
    const inst = { id, cfg: defaults(cfg), symbol: cfg.symbol, market: cfg.market || 'spot', running: true, created: Date.now(), eval: evaluation,
      gate: opts && opts.gate ? { on: true, min: opts.minWin } : { on: false, min: 0 }, ref: null, lastSkip: 0 };
    this.s.instances.push(inst);
    this.log(`启动策略 ${id} ${cfg.type === 'grid' ? '网格' : '马丁'} ${cfg.symbol}（保证金 ${cfg.margin}U × ${cfg.lev}x）`);
    return inst;
  };
  Engine.prototype.stop = function (id) { const i = this.inst(id); if (i && i.running) { i.running = false; this.log(`停止策略 ${id}（持仓保留，可一键平仓）`); } };
  Engine.prototype.stopAll = function () { this.s.instances.forEach(i => { if (i.running) i.running = false; }); this.log('⚠️ 紧急：已停止全部策略', 'warn'); };
  Engine.prototype.closePos = function (pos, px, reason) {
    const inst = this.inst(pos.instId); const cfg = (inst && inst.cfg) || pos.cfg;
    const p = posPnl(pos, px, cfg); const margin = pos.fills.reduce((a, f) => a + f.margin, 0);
    const net = reason === '强平(模拟)' ? -margin : p.net;
    if (net < 0 && (reason === '止盈' || reason === '移动止盈')) reason += '(扣费后亏损)';
    this.s.balance += net; this.s.positions = this.s.positions.filter(x => x !== pos);
    const o = { id: pos.id, instId: pos.instId, symbol: pos.symbol, strategy: cfg.type, side: 'long', lev: cfg.lev, margin, adds: pos.fills.length - 1,
      entry: pos.fills[0].px, avg: pos.avg, exit: px, openTime: pos.openTime, closeTime: Date.now(), reason, pnl: net, fee: p.fee, win: net > 0,
      est: pos.eval ? { winRate: pos.eval.winRate, expected: pos.eval.expected, maxLoss: pos.eval.maxLoss, rr: pos.eval.rr, reason: pos.eval.reason, samples: pos.eval.samples } : null };
    this.s.orders.unshift(o); if (this.s.orders.length > (this.s.maxOrders || 5000)) this.s.orders.length = this.s.maxOrders || 5000; this.h.onOrder && this.h.onOrder(o, pos);
    this.log(`平仓 ${pos.symbol} ${reason} @${fmtPx(px)} 盈亏 ${net >= 0 ? '+' : ''}${net.toFixed(2)}U`, net >= 0 ? 'win' : 'loss');
  };
  Engine.prototype.closeAll = function (prices, why) {
    this.s.positions.slice().forEach(p => { const px = prices[p.symbol]; if (px) this.closePos(p, px, why || '手动全平'); else this.log(`${p.symbol} 无最新价，暂未平仓`, 'warn'); });
  };
  Engine.prototype.open = function (inst, px, margin) {
    const s = this.summary({});
    if (s.available < margin) { this.log(`${inst.id} 可用余额不足（需 ${margin.toFixed(2)}U），跳过开仓`, 'warn'); return null; }
    const pos = mkPos(px, margin, 0); pos.id = 'O' + (this.s.seq++); pos.instId = inst.id; pos.symbol = inst.symbol; pos.openTime = Date.now(); pos.cfg = inst.cfg;
    pos.eval = inst.eval; this.s.positions.push(pos);
    this.h.onOpen && this.h.onOpen(pos, inst);
    this.log(`开仓 ${inst.symbol} 多 @${fmtPx(px)} 保证金 ${margin.toFixed(2)}U ×${inst.cfg.lev}（预估胜率 ${inst.eval ? (inst.eval.winRate * 100).toFixed(1) + '%' : '-'}）`);
    return pos;
  };
  Engine.prototype.gateOk = function (inst) {
    if (!inst.gate.on || !inst.eval) return true;
    if (inst.eval.winRate * 100 >= inst.gate.min) return true;
    if (Date.now() - inst.lastSkip > 60000) { inst.lastSkip = Date.now(); this.log(`${inst.id} 胜率 ${(inst.eval.winRate * 100).toFixed(1)}% 低于 ${inst.gate.min}%，放弃开仓`, 'warn'); }
    return false;
  };
  /* ctx: { prices: {SYM: px}, candles: {SYM: [..5m/backtest-interval candles..]} } */
  Engine.prototype.tick = function (ctx) {
    const prices = ctx.prices;
    // exits
    this.s.positions.slice().forEach(pos => {
      const px = prices[pos.symbol]; if (!px) return; const inst = this.inst(pos.instId); const cfg = (inst && inst.cfg) || pos.cfg;
      if (inst && inst.cfg.type === 'martingale' && inst.running) {
        const last = pos.fills[pos.fills.length - 1];
        if (pos.fills.length - 1 < cfg.martMaxAdds && px <= last.px * (1 - cfg.martStep / 100)) {
          const m = last.margin * cfg.martMult;
          if (this.summary({}).available >= m) { addFill(pos, px, m, 0); this.h.onAdd && this.h.onAdd(pos, inst, px, m); this.log(`${inst.id} 马丁加仓 #${pos.fills.length - 1} @${fmtPx(px)} 保证金 ${m.toFixed(2)}U，均价 ${fmtPx(pos.avg)}`); }
        }
      }
      const ex = checkExit(pos, px, px, cfg); if (ex) this.closePos(pos, px, ex.reason);
    });
    // entries
    this.s.instances.filter(i => i.running).forEach(inst => {
      const px = prices[inst.symbol]; if (!px) return; const cfg = inst.cfg;
      const mine = this.s.positions.filter(p => p.instId === inst.id);
      if (cfg.type === 'grid') {
        const step = cfg.gridRange / cfg.gridN / 100;
        if (inst.ref == null) { inst.ref = px; this.log(`${inst.id} 网格基准价 ${fmtPx(px)}，格距 ${(step * 100).toFixed(2)}%`); return; }
        if (px <= inst.ref * (1 - step) && mine.length < cfg.gridN) {
          inst.ref = inst.ref * (1 - step);
          if (this.gateOk(inst)) this.open(inst, px, cfg.margin);
        } else if (!mine.length && px >= inst.ref * (1 + step)) inst.ref = px;
      } else if (!mine.length) {
        const cs = ctx.candles && ctx.candles[inst.symbol]; if (!cs || cs.length < cfg.martLookback + 1) return;
        const hi = Math.max(...cs.slice(-cfg.martLookback - 1, -1).map(x => x.h), px);
        if (px <= hi * (1 - cfg.martTrigger / 100) && this.gateOk(inst)) this.open(inst, px, cfg.margin);
      }
    });
  };

  function fmtPx(p) { return p >= 100 ? p.toFixed(2) : p >= 1 ? p.toFixed(4) : p.toPrecision(4); }

  function stats(orders, since) {
    const o = orders.filter(x => !since || x.closeTime >= since); const w = o.filter(x => x.win);
    const gp = w.reduce((a, x) => a + x.pnl, 0), gl = o.filter(x => !x.win).reduce((a, x) => a + x.pnl, 0);
    return { n: o.length, wins: w.length, losses: o.length - w.length, winRate: o.length ? w.length / o.length : 0, gp, gl, net: gp + gl };
  }
  return { FEE, parseBinanceKlines, parseOkxCandles, ema, rsi, backtest, evaluate, defaults, newState, Engine, stats, fmtPx, posPnl };
});
