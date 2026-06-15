/**
 * server.js — DSB v3 Trading Engine
 *
 * Changes from v2:
 *  - priorDayClose passed to evaluateSignal (video 2 prior day VWAP)
 *  - Exit signal detection from strategy.js closes positions proactively
 *  - News event filter: skips entries during known high-impact windows
 *  - GEX refresh at 9:25 AM + 10:30 AM + 12:00 PM + 2:00 PM ET (4 times/day)
 *  - ATM strike uses ±1 of spot (nearest dollar strike for SPY)
 *  - Webhook supports grade passthrough from TradingView
 */

'use strict';

const express  = require('express');
const path     = require('path');
const Alpaca   = require('@alpacahq/alpaca-trade-api');
const {
  evaluateSignal,
  detectSDZones,
  calcGEXLevels,
  detectExitSignal,
  isValidTradingTime,
} = require('./strategy');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client/build')));

// ─── CONFIGURATION ─────────────────────────────────────────────────────────
const ENV = {
  ALPACA_KEY:          process.env.ALPACA_API_KEY       || '',
  ALPACA_SECRET:       process.env.ALPACA_SECRET_KEY    || '',
  PAPER:               process.env.PAPER                !== 'false',
  PORT:                parseInt(process.env.PORT         || '3001'),
  RISK_DOLLARS:        parseFloat(process.env.RISK_DOLLARS       || '300'),
  ACCOUNT_SIZE:        parseFloat(process.env.ACCOUNT_SIZE       || '100000'),
  MAX_DAILY_LOSS:      parseFloat(process.env.MAX_DAILY_LOSS     || '0.04'),
  PREMIUM_STOP_PCT:    parseFloat(process.env.PREMIUM_STOP_PCT   || '0.45'),
  TP1_PCT:             parseFloat(process.env.TP1_PCT             || '0.50'),
  TP2_PCT:             parseFloat(process.env.TP2_PCT             || '1.00'),
  TP1_CLOSE_PCT:       parseFloat(process.env.TP1_CLOSE_PCT       || '0.50'),
  ATR_STOP_MULT:       parseFloat(process.env.ATR_STOP_MULT       || '1.5'),
  TRAIL_BREAKEVEN:     process.env.TRAIL_BREAKEVEN      !== 'false',
  TIERED_SIZING:       process.env.TIERED_SIZING        !== 'false',
  AUTO_TRADE:          process.env.AUTO_TRADE           === 'true',
  MIN_CONFIDENCE:      parseInt(process.env.MIN_CONFIDENCE       || '65'),
  FORCE_CLOSE_ET:      process.env.FORCE_CLOSE_ET                || '15:45',
  GEX_REFRESH_MINS:    parseInt(process.env.GEX_REFRESH_MINS     || '30'),
  SCAN_INTERVAL_MINS:  parseInt(process.env.SCAN_INTERVAL_MINS   || '5'),
  MAX_POSITIONS:       parseInt(process.env.MAX_POSITIONS        || '1'),
};

// ─── STATE ─────────────────────────────────────────────────────────────────
const state = {
  config:       { ...ENV },
  positions:    {},
  trades:       [],
  dailyPnL:     0,
  cbTriggered:  false,
  lastSignal:   null,
  zones:        { demand: [], supply: [] },
  gexData:      null,
  gexLastFetch: null,
  priorDayClose: null,
  stats: {
    totalTrades: 0, wins: 0, losses: 0,
    totalPnL: 0, biggestWin: 0, biggestLoss: 0,
    winStreak: 0, lossStreak: 0, currentStreak: 0,
    setupBreakdown: { SETUP_1: 0, SETUP_2: 0, SETUP_3: 0, SETUP_4: 0, WEBHOOK: 0 },
    gradeBreakdown: { 'A+': 0, A: 0, B: 0 },
  },
};

// ─── ALPACA CLIENT ────────────────────────────────────────────────────────
let _alpaca = null;
function getAlpaca() {
  if (!_alpaca && state.config.ALPACA_KEY) {
    _alpaca = new Alpaca({
      keyId:     state.config.ALPACA_KEY,
      secretKey: state.config.ALPACA_SECRET,
      paper:     state.config.PAPER,
    });
  }
  return _alpaca;
}

// ─── LOGGING ──────────────────────────────────────────────────────────────
const logs = [];
function log(msg, level = 'INFO') {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  logs.unshift({ ts, level, msg, line });
  if (logs.length > 600) logs.pop();
}

// ─── BAR DATA ──────────────────────────────────────────────────────────────
async function getBars(symbol, timeframe, limit) {
  const client = getAlpaca();
  if (!client) return null;
  try {
    const resp = await client.getBarsV2(symbol, {
      timeframe, limit, feed: 'iex', adjustment: 'raw',
    });
    const bars = [];
    for await (const b of resp) {
      bars.push({ o: b.OpenPrice, h: b.HighPrice, l: b.LowPrice, c: b.ClosePrice, v: b.Volume, t: b.Timestamp });
    }
    return bars.length ? bars : null;
  } catch (e) {
    log(`getBars(${symbol},${timeframe}) error: ${e.message}`, 'ERROR');
    return null;
  }
}

// Fetch prior day close for prior-day VWAP level (cited in video 2 live demo)
async function fetchPriorDayClose(symbol) {
  try {
    const bars = await getBars(symbol, '1Day', 3);
    if (bars && bars.length >= 2) {
      state.priorDayClose = bars[bars.length - 2].c;
      log(`Prior day close: $${state.priorDayClose.toFixed(2)}`);
    }
  } catch (e) {
    log(`Prior day close fetch failed: ${e.message}`, 'WARN');
  }
}

// ─── OPTION EXPIRY ──────────────────────────────────────────────────────────
function getNextFriday() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// ─── GEX REFRESH ──────────────────────────────────────────────────────────
// Refreshes at 9:25 AM, 10:30 AM, 12:00 PM, 2:00 PM ET (following market cycle)
const GEX_REFRESH_TIMES = ['09:25', '10:30', '12:00', '14:00'];
let lastGEXRefreshMinute = '';

async function refreshGEX(symbol = 'SPY') {
  const client = getAlpaca();
  if (!client) return;
  try {
    const snap = await client.getLatestTrade(symbol);
    const spot = snap.Price;
    if (!spot) { log('GEX: no spot price', 'WARN'); return; }

    const expiry = getNextFriday();
    const chain  = await client.getOptionContracts({
      underlying_symbols: symbol,
      expiration_date:    expiry,
      limit:              300,
    });

    const contracts = [];
    if (chain?.option_contracts) {
      for (const c of chain.option_contracts) {
        contracts.push({
          strike_price:   c.strike_price,
          type:           c.type,
          open_interest:  c.open_interest  || 0,
          greeks: {
            gamma: c.greeks?.gamma || 0,
            vanna: c.greeks?.vanna || 0,
          },
        });
      }
    }

    if (contracts.length > 5) {
      state.gexData      = calcGEXLevels(contracts, spot);
      state.gexLastFetch = new Date().toISOString();
      log(`GEX refresh: anchor=${state.gexData?.anchor} flip=${state.gexData?.flip} regime=${state.gexData?.regime} conc=${(state.gexData?.concentration * 100).toFixed(0)}% vexAgree=${state.gexData?.gexVexAgreement}`);
    } else {
      log('GEX: insufficient chain data, keeping prior levels', 'WARN');
    }
  } catch (e) {
    log(`GEX refresh failed: ${e.message}`, 'WARN');
  }
}

// ─── NEWS EVENT FILTER ──────────────────────────────────────────────────────
// Sowmya explicitly avoids trading around news events.
// We block entries 5 min before and 15 min after known high-impact times.
// Times in ET: FOMC (2:00 PM), CPI (usually 8:30 AM — pre-market so irrelevant),
// NFP (8:30 AM Friday — pre-market). Runtime news requires external feed;
// we do a simple time-of-day block for the FOMC window.
function isNewsBlacklist(etHour, etMinute) {
  const mins = etHour * 60 + etMinute;
  // FOMC announcement window: 2:00 PM ET (block 1:55–2:20 PM)
  const fomcBlock = mins >= 13 * 60 + 55 && mins <= 14 * 60 + 20;
  return fomcBlock;
}

// ─── OPTION CONTRACT FINDER ─────────────────────────────────────────────────
async function findOption(symbol, direction) {
  const client = getAlpaca();
  if (!client) return null;
  try {
    const snap   = await client.getLatestTrade(symbol);
    const spot   = snap.Price;
    const expiry = getNextFriday();

    // SPY: $1 strike spacing; find ATM ±0
    const strike  = Math.round(spot);
    const expStr  = expiry.replace(/-/g, '').slice(2);   // YYMMDD
    const strStr  = (strike * 1000).toString().padStart(8, '0');
    const optType = direction === 'CALL' ? 'C' : 'P';
    const optSymbol = `${symbol}${expStr}${optType}${strStr}`;

    return { symbol: optSymbol, strike, expiry, type: optType, spot };
  } catch (e) {
    log(`findOption failed: ${e.message}`, 'ERROR');
    return null;
  }
}

// ─── CONTRACT SIZING ───────────────────────────────────────────────────────
// Risk = RISK_DOLLARS; position size driven by premium × stop loss %
// Tiered by grade: A+=1.5×, A=1×, B=0.75× (Sowmya: A+ is high-conviction)
function sizeContracts(premium, grade, cfg) {
  if (!premium || premium <= 0) return 1;
  const maxRisk = premium * 100 * cfg.PREMIUM_STOP_PCT;
  let base = Math.max(1, Math.floor(cfg.RISK_DOLLARS / maxRisk));
  if (cfg.TIERED_SIZING) {
    const mult = grade === 'A+' ? 1.5 : grade === 'A' ? 1.0 : 0.75;
    base = Math.max(1, Math.round(base * mult));
  }
  return base;
}

// ─── ENTRY ─────────────────────────────────────────────────────────────────
async function placeEntry(signal) {
  const cfg = state.config;

  if (!cfg.AUTO_TRADE) {
    log(`[PAPER-SIGNAL] ${signal.direction} ${signal.confidence}% grade=${signal.grade} setup=${signal.setup?.type} — AUTO_TRADE OFF`);
    return null;
  }
  if (state.cbTriggered) { log('Circuit breaker active — no entry', 'WARN'); return null; }
  if (signal.confidence < cfg.MIN_CONFIDENCE) { log(`Conf ${signal.confidence}% < min ${cfg.MIN_CONFIDENCE}% — skip`); return null; }
  if (!signal.tradeable) { log(`Not tradeable: ${signal.rejectReasons.join(' | ')}`); return null; }

  const activeSPY = Object.values(state.positions).filter(p => p.underlying === 'SPY');
  if (activeSPY.length >= cfg.MAX_POSITIONS) { log(`Max positions (${cfg.MAX_POSITIONS}) reached`); return null; }

  const client = getAlpaca();
  if (!client) return null;

  const opt = await findOption('SPY', signal.direction);
  if (!opt) return null;

  let premium;
  try {
    const q = await client.getLatestOptionQuote(opt.symbol);
    premium = (q.AskPrice + q.BidPrice) / 2;
    if (!premium || premium <= 0) throw new Error('zero premium');
  } catch (e) {
    // Fallback: ATR-based premium estimate
    premium = (signal.meta.atr || opt.spot * 0.003) * 0.8;
    log(`Premium fallback to $${premium.toFixed(2)}`, 'WARN');
  }

  const contracts   = sizeContracts(premium, signal.grade, cfg);
  const limitPrice  = parseFloat((premium * 1.01).toFixed(2));
  const premStop    = parseFloat((limitPrice * (1 - cfg.PREMIUM_STOP_PCT)).toFixed(2));
  const atrStop     = parseFloat((limitPrice - (signal.meta.atr || limitPrice * 0.1) * cfg.ATR_STOP_MULT).toFixed(2));
  const tp1Price    = parseFloat((limitPrice * (1 + cfg.TP1_PCT)).toFixed(2));
  const tp2Price    = parseFloat((limitPrice * (1 + cfg.TP2_PCT)).toFixed(2));
  // GEX wall as additional TP target (video 2: walls are price magnets)
  const gexTP1      = signal.direction === 'CALL' ? state.gexData?.wallAbove : state.gexData?.wallBelow;

  try {
    const order = await client.createOrder({
      symbol:          opt.symbol,
      qty:             contracts,
      side:            'buy',
      type:            'limit',
      time_in_force:   'day',
      limit_price:     limitPrice,
      client_order_id: `DSB3_ENTRY_${signal.setup?.type}_${Date.now()}`,
    });

    const pos = {
      id:            order.id,
      clientOrderId: order.client_order_id,
      symbol:        opt.symbol,
      underlying:    'SPY',
      direction:     signal.direction,
      contracts,
      entryPremium:  limitPrice,
      currentPrice:  limitPrice,
      strike:        opt.strike,
      expiry:        opt.expiry,
      spot:          opt.spot,
      atr:           signal.meta.atr,
      stopPrice:     premStop,
      atrStop,
      tp1Price,
      tp2Price,
      gexTP1,
      setupType:     signal.setup?.type,
      grade:         signal.grade,
      confidence:    signal.confidence,
      setupDesc:     signal.setup?.desc,
      delta:         signal.meta.delta,
      deltaMag:      signal.meta.deltaMag,
      hasBShape:     signal.meta.hasBShape,
      hasPShape:     signal.meta.hasPShape,
      zoneHit:       signal.zoneHit,
      gexRegime:     signal.meta.gexRegime,
      gexFlags:      signal.meta.gexFlags,
      tp1Hit:        false,
      status:        'PENDING',
      entryTime:     new Date().toISOString(),
      unrealizedPnL: 0,
      pnlPct:        0,
    };

    state.positions[opt.symbol] = pos;
    addTrade({ ...pos, event: 'ENTRY', price: limitPrice });
    log(`ENTRY: ${signal.direction} ${contracts}x ${opt.symbol} @ $${limitPrice} | ${signal.grade} ${signal.confidence}% | Stop:$${premStop} TP1:$${tp1Price} TP2:$${tp2Price}${gexTP1 ? ` GEX-Wall:$${gexTP1}` : ''}`);
    return pos;
  } catch (e) {
    log(`createOrder failed: ${e.message}`, 'ERROR');
    return null;
  }
}

// ─── EXIT ──────────────────────────────────────────────────────────────────
async function closePosition(symbol, reason, partial = false, partialPct = 1.0) {
  const client = getAlpaca();
  const pos    = state.positions[symbol];
  if (!pos || !client) return;

  const qty = partial
    ? Math.max(1, Math.floor(pos.contracts * partialPct))
    : pos.contracts;

  try {
    await client.createOrder({
      symbol, qty, side: 'sell', type: 'market', time_in_force: 'day',
      client_order_id: `DSB3_EXIT_${reason}_${Date.now()}`,
    });

    let exitP = pos.currentPrice || pos.entryPremium;
    try {
      const q = await client.getLatestOptionQuote(symbol);
      exitP   = (q.AskPrice + q.BidPrice) / 2;
    } catch (_) {}

    const pnl = (exitP - pos.entryPremium) * qty * 100;
    state.dailyPnL += pnl;
    updateStats(pnl, pos.setupType, pos.grade);
    addTrade({ ...pos, event: 'EXIT', price: exitP, pnl, reason, contracts: qty });
    log(`EXIT [${reason}]: ${qty}x ${symbol} @ ~$${exitP.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}`);

    if (partial && qty < pos.contracts) {
      pos.contracts -= qty;
      pos.tp1Hit     = true;
      if (state.config.TRAIL_BREAKEVEN) {
        pos.stopPrice = pos.entryPremium;
        log(`Trail stop → Breakeven: ${symbol} @ $${pos.entryPremium}`);
      }
    } else {
      delete state.positions[symbol];
    }

    // Daily circuit breaker check
    const maxLoss = state.config.ACCOUNT_SIZE * state.config.MAX_DAILY_LOSS;
    if (state.dailyPnL < -maxLoss && !state.cbTriggered) {
      state.cbTriggered = true;
      log(`CIRCUIT BREAKER: daily P&L $${state.dailyPnL.toFixed(2)} exceeds max loss $${maxLoss.toFixed(2)}`, 'WARN');
    }
  } catch (e) {
    log(`closePosition [${reason}] ${symbol}: ${e.message}`, 'ERROR');
  }
}

// ─── POSITION MONITOR ──────────────────────────────────────────────────────
async function monitorPositions(bars5m) {
  const client = getAlpaca();
  if (!client) return;

  for (const [symbol, pos] of Object.entries(state.positions)) {
    try {
      // Update current price
      let cur = pos.currentPrice;
      try {
        const q = await client.getLatestOptionQuote(symbol);
        cur = (q.AskPrice + q.BidPrice) / 2;
        if (cur && cur > 0) {
          pos.currentPrice   = cur;
          pos.unrealizedPnL  = (cur - pos.entryPremium) * pos.contracts * 100;
          pos.pnlPct         = ((cur - pos.entryPremium) / pos.entryPremium) * 100;
          pos.status         = 'OPEN';
        }
      } catch (_) {}

      // Exit conditions (in order of priority)

      // 1. Premium stop (hard stop)
      if (cur <= pos.stopPrice) {
        await closePosition(symbol, 'PREMIUM_STOP');
        continue;
      }

      // 2. ATR stop (only before TP1)
      if (!pos.tp1Hit && cur <= pos.atrStop) {
        await closePosition(symbol, 'ATR_STOP');
        continue;
      }

      // 3. Sowmya exit signal: opposite trapped-participant formation
      if (bars5m) {
        const o5 = bars5m.map(b => b.o), h5 = bars5m.map(b => b.h);
        const l5 = bars5m.map(b => b.l), c5 = bars5m.map(b => b.c), v5 = bars5m.map(b => b.v);
        const exitSig = detectExitSignal(o5, h5, l5, c5, v5, pos.direction);
        if (exitSig.exit && pos.tp1Hit) {
          // Only auto-exit on signal if TP1 already hit (protect gains)
          await closePosition(symbol, `SOWMYA_EXIT_${exitSig.reason.replace(/\s/g,'_').toUpperCase()}`);
          continue;
        }
        if (exitSig.exit && !pos.tp1Hit) {
          log(`Exit signal: ${exitSig.reason} on ${symbol} — monitoring (TP1 not yet hit)`, 'WARN');
        }
      }

      // 4. TP1 (partial close + trail to breakeven)
      if (!pos.tp1Hit && cur >= pos.tp1Price) {
        await closePosition(symbol, 'TP1', true, state.config.TP1_CLOSE_PCT);
        continue;
      }

      // 5. TP2 (full close after TP1)
      if (pos.tp1Hit && cur >= pos.tp2Price) {
        await closePosition(symbol, 'TP2');
        continue;
      }
    } catch (e) {
      log(`Monitor ${symbol}: ${e.message}`, 'ERROR');
    }
  }
}

// ─── MAIN SCAN LOOP ────────────────────────────────────────────────────────
async function runScan() {
  if (!isMarketHours()) return;
  if (state.cbTriggered) { log('CB active — scan skipped', 'WARN'); return; }

  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etH = now.getHours(), etM = now.getMinutes();

    // Scheduled GEX refresh at specific times
    const etTimeStr = `${String(etH).padStart(2,'0')}:${String(etM).padStart(2,'0')}`;
    if (GEX_REFRESH_TIMES.includes(etTimeStr) && etTimeStr !== lastGEXRefreshMinute) {
      await refreshGEX('SPY');
      lastGEXRefreshMinute = etTimeStr;
    }
    // Also refresh if stale
    const gexAge = state.gexLastFetch
      ? (Date.now() - new Date(state.gexLastFetch)) / 60000
      : Infinity;
    if (gexAge > state.config.GEX_REFRESH_MINS) await refreshGEX('SPY');

    // Fetch bars
    const [bars15m, bars5m] = await Promise.all([
      getBars('SPY', '15Min', 55),
      getBars('SPY', '5Min',  65),
    ]);

    if (!bars15m || !bars5m) { log('Bar fetch failed — skipping scan', 'WARN'); return; }

    // Update zone map
    if (bars15m.length >= 15) {
      state.zones = detectSDZones(
        bars15m.map(b => b.o), bars15m.map(b => b.h),
        bars15m.map(b => b.l), bars15m.map(b => b.c), bars15m.map(b => b.v)
      );
    }

    // Monitor existing positions with latest bars
    await monitorPositions(bars5m);

    // News blackout check (Sowmya: avoid news)
    if (isNewsBlacklist(etH, etM)) {
      log(`News blackout window (${etH}:${String(etM).padStart(2,'0')} ET) — no new entries`);
      return;
    }

    // Evaluate signal
    const signal = evaluateSignal({
      bars15m,
      bars5m,
      gexData:       state.gexData,
      etHour:        etH,
      etMinute:      etM,
      priorDayClose: state.priorDayClose,
    });
    state.lastSignal = signal;

    const rejectStr = signal.rejectReasons.length ? ` | REJECT: ${signal.rejectReasons[0]}` : '';
    log(`SCAN ${etTimeStr} → ${signal.direction} ${signal.confidence}% grade=${signal.grade || '-'} setup=${signal.setup?.type || 'none'} zone=${signal.zoneHit?.type || 'miss'}${rejectStr}`);

    if (signal.tradeable) {
      await placeEntry(signal);
    }
  } catch (e) {
    log(`Scan error: ${e.message}`, 'ERROR');
  }
}

// ─── SCHEDULED TASKS ──────────────────────────────────────────────────────
function scheduleForceClose() {
  const [h, m] = state.config.FORCE_CLOSE_ET.split(':').map(Number);
  setInterval(() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (et.getHours() === h && et.getMinutes() === m) {
      log(`FORCE CLOSE all positions at ${state.config.FORCE_CLOSE_ET} ET`);
      Object.keys(state.positions).forEach(sym => closePosition(sym, 'FORCE_CLOSE_EOD'));
    }
  }, 60000);
}

function scheduleDailyReset() {
  setInterval(() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    // Reset at 9:25 AM ET (before market open)
    if (et.getHours() === 9 && et.getMinutes() === 25) {
      state.dailyPnL    = 0;
      state.cbTriggered = false;
      log('Daily P&L and circuit breaker reset at 9:25 AM ET');
      fetchPriorDayClose('SPY');
    }
  }, 60000);
}

// ─── HELPERS ──────────────────────────────────────────────────────────────
function isMarketHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d  = et.getDay();
  if (d === 0 || d === 6) return false;
  const m  = et.getHours() * 60 + et.getMinutes();
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

function addTrade(data) {
  state.trades.unshift({ ...data, id: `T${Date.now()}` });
  if (state.trades.length > 300) state.trades.pop();
}

function updateStats(pnl, setupType, grade) {
  const s = state.stats;
  s.totalTrades++;
  s.totalPnL += pnl;
  if (pnl > 0) {
    s.wins++;
    s.biggestWin     = Math.max(s.biggestWin, pnl);
    s.currentStreak  = s.currentStreak >= 0 ? s.currentStreak + 1 : 1;
    s.winStreak      = Math.max(s.winStreak, s.currentStreak);
  } else {
    s.losses++;
    s.biggestLoss    = Math.min(s.biggestLoss, pnl);
    s.currentStreak  = s.currentStreak <= 0 ? s.currentStreak - 1 : -1;
    s.lossStreak     = Math.min(s.lossStreak, s.currentStreak);
  }
  if (setupType && s.setupBreakdown[setupType] !== undefined) s.setupBreakdown[setupType]++;
  if (grade     && s.gradeBreakdown[grade]     !== undefined) s.gradeBreakdown[grade]++;
}

// ─── API ROUTES ────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  const { ALPACA_KEY, ALPACA_SECRET, ...safeConfig } = state.config;
  res.json({
    positions:     state.positions,
    zones:         state.zones,
    lastSignal:    state.lastSignal,
    gexData:       state.gexData,
    gexLastFetch:  state.gexLastFetch,
    dailyPnL:      state.dailyPnL,
    cbTriggered:   state.cbTriggered,
    marketOpen:    isMarketHours(),
    config:        safeConfig,
    stats:         state.stats,
    priorDayClose: state.priorDayClose,
  });
});

app.get('/api/logs',   (req, res) => res.json(logs.slice(0, 200)));
app.get('/api/trades', (req, res) => res.json(state.trades));

app.post('/api/close/:symbol', async (req, res) => {
  await closePosition(decodeURIComponent(req.params.symbol), req.body?.reason || 'MANUAL');
  res.json({ ok: true });
});

app.post('/api/scan', async (req, res) => {
  await runScan();
  res.json({ ok: true, signal: state.lastSignal });
});

app.post('/api/gex-refresh', async (req, res) => {
  await refreshGEX('SPY');
  res.json({ ok: true, gex: state.gexData });
});

app.post('/api/config', (req, res) => {
  const allowed = [
    'RISK_DOLLARS','ACCOUNT_SIZE','MAX_DAILY_LOSS','PREMIUM_STOP_PCT',
    'TP1_PCT','TP2_PCT','TP1_CLOSE_PCT','ATR_STOP_MULT','TRAIL_BREAKEVEN',
    'TIERED_SIZING','AUTO_TRADE','MIN_CONFIDENCE','FORCE_CLOSE_ET',
    'GEX_REFRESH_MINS','SCAN_INTERVAL_MINS','MAX_POSITIONS',
  ];
  for (const [k, v] of Object.entries(req.body)) {
    if (allowed.includes(k)) state.config[k] = v;
  }
  // Reset Alpaca client if keys changed
  if (req.body.ALPACA_KEY || req.body.ALPACA_SECRET) _alpaca = null;
  log(`Config updated: ${JSON.stringify(req.body)}`);
  res.json({ ok: true, config: state.config });
});

app.post('/api/reset-daily', (req, res) => {
  state.dailyPnL    = 0;
  state.cbTriggered = false;
  log('Daily P&L manually reset');
  res.json({ ok: true });
});

// TradingView webhook — accepts signals from Pine Script alert
app.post('/webhook', async (req, res) => {
  const { action, confidence, close: closeP, atr: atrV, zone, grade } = req.body;
  log(`Webhook received: ${JSON.stringify(req.body)}`);
  if (!['BUY_CALL', 'BUY_PUT'].includes(action)) {
    res.json({ ok: false, reason: 'unknown action' });
    return;
  }
  const sig = {
    direction:     action === 'BUY_CALL' ? 'CALL' : 'PUT',
    confidence:    confidence || 70,
    grade:         grade      || 'A',
    tradeable:     true,
    rejectReasons: [],
    setup: { type: 'WEBHOOK', desc: 'TradingView Pine Script alert', grade: grade || 'A' },
    zoneHit:  { hit: !!zone, type: zone || null, zone: null },
    exitSignal: { exit: false },
    meta: {
      lastPrice:  closeP || 0,
      atr:        atrV   || 0,
      delta:      0,
      deltaMag:   0,
      hasBShape:  false,
      hasPShape:  false,
      gexRegime:  state.gexData?.regime || 'UNKNOWN',
      gexFlags:   [],
      anchor:     state.gexData?.anchor,
      flip:       state.gexData?.flip,
    },
  };
  state.lastSignal = sig;
  if (state.config.AUTO_TRADE) await placeEntry(sig);
  res.json({ ok: true, signal: sig });
});

// Catch-all → React SPA
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'client/build/index.html'));
});

// ─── STARTUP ───────────────────────────────────────────────────────────────
app.listen(ENV.PORT, async () => {
  log(`DSB v3 | port=${ENV.PORT} paper=${ENV.PAPER} autoTrade=${ENV.AUTO_TRADE} minConf=${ENV.MIN_CONFIDENCE}%`);
  scheduleForceClose();
  scheduleDailyReset();
  if (isMarketHours()) {
    await refreshGEX('SPY');
    await fetchPriorDayClose('SPY');
  }
  const intervalMs = ENV.SCAN_INTERVAL_MINS * 60 * 1000;
  setInterval(runScan, intervalMs);
  setTimeout(runScan, 5000);   // initial scan after 5s warmup
});

module.exports = app;
