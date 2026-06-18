'use strict';
/**
 * server.js — DSB v3
 *
 * Fully self-contained — no TradingView, no Pine Script, no webhooks needed.
 * All signals derived from Alpaca live bar + option chain data.
 *
 * Data sources:
 *   Bars:         Alpaca getBarsV2 (SPY 5m + 15m)
 *   Option chain: Alpaca getOptionContracts (SPY + QQQ + SPX)
 *   GEX/VEX:      Self-calculated from option chain greeks (3 tickers)
 *   Prior day:    Alpaca daily bars
 *
 * Removed: TradingView webhook endpoint, Pine Script dependency
 * Added:   SQLite DB, multi-ticker GEX (SPY+QQQ+SPX), bar cache
 */

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
const DB = require('./db');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'client/build')));

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const ENV = {
  ALPACA_KEY:         process.env.ALPACA_API_KEY      || '',
  ALPACA_SECRET:      process.env.ALPACA_SECRET_KEY   || '',
  PAPER:              process.env.PAPER               !== 'false',
  PORT:               parseInt(process.env.PORT        || '3001'),
  RISK_DOLLARS:       parseFloat(process.env.RISK_DOLLARS       || '300'),
  ACCOUNT_SIZE:       parseFloat(process.env.ACCOUNT_SIZE       || '100000'),
  MAX_DAILY_LOSS:     parseFloat(process.env.MAX_DAILY_LOSS     || '0.04'),
  PREMIUM_STOP_PCT:   parseFloat(process.env.PREMIUM_STOP_PCT   || '0.45'),
  TP1_PCT:            parseFloat(process.env.TP1_PCT             || '0.50'),
  TP2_PCT:            parseFloat(process.env.TP2_PCT             || '1.00'),
  TP1_CLOSE_PCT:      parseFloat(process.env.TP1_CLOSE_PCT       || '0.50'),
  ATR_STOP_MULT:      parseFloat(process.env.ATR_STOP_MULT       || '1.5'),
  TRAIL_BREAKEVEN:    process.env.TRAIL_BREAKEVEN     !== 'false',
  TIERED_SIZING:      process.env.TIERED_SIZING       !== 'false',
  AUTO_TRADE:         process.env.AUTO_TRADE          === 'true',
  MIN_CONFIDENCE:     parseInt(process.env.MIN_CONFIDENCE       || '65'),
  FORCE_CLOSE_ET:     process.env.FORCE_CLOSE_ET                || '15:45',
  GEX_REFRESH_MINS:   parseInt(process.env.GEX_REFRESH_MINS     || '30'),
  SCAN_INTERVAL_MINS: parseInt(process.env.SCAN_INTERVAL_MINS   || '5'),
  MAX_POSITIONS:      parseInt(process.env.MAX_POSITIONS        || '1'),
};

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  config:        { ...ENV },
  positions:     {},
  lastSignal:    null,
  zones:         { demand: [], supply: [] },
  gexAll: {           // SPY + QQQ + SPX
    SPY: null, QQQ: null, SPX: null,
    multiAligned: false,
    lastFetch: null,
  },
  priorDayClose: null,
  cbTriggered:   false,
  stats: {
    totalTrades: 0, wins: 0, losses: 0, totalPnL: 0,
    biggestWin: 0, biggestLoss: 0,
    winStreak: 0, lossStreak: 0, currentStreak: 0,
    setupBreakdown: { SETUP_1: 0, SETUP_2: 0, SETUP_3: 0, SETUP_4: 0 },
    gradeBreakdown: { 'A+': 0, A: 0, B: 0 },
  },
};

// ─── ALPACA ───────────────────────────────────────────────────────────────────
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

// ─── LOGGING ─────────────────────────────────────────────────────────────────
const logs = [];
function log(msg, level = 'INFO') {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [${level}] ${msg}`;
  console.log(line);
  logs.unshift({ ts, level, msg, line });
  if (logs.length > 800) logs.pop();
}

// ─── BAR DATA ─────────────────────────────────────────────────────────────────
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
    if (bars.length) DB.saveBars(bars, symbol, timeframe);
    return bars.length ? bars : null;
  } catch (e) {
    log(`getBars(${symbol},${timeframe}) error: ${e.message}`, 'ERROR');
    return null;
  }
}

async function fetchPriorDayClose(symbol = 'SPY') {
  try {
    const bars = await getBars(symbol, '1Day', 3);
    if (bars?.length >= 2) {
      state.priorDayClose = bars[bars.length - 2].c;
      log(`Prior day close: $${state.priorDayClose?.toFixed(2)}`);
    }
  } catch (e) {
    log(`Prior day close: ${e.message}`, 'WARN');
  }
}

// ─── OPTION EXPIRY ────────────────────────────────────────────────────────────
function getNextFriday() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
  return d.toISOString().split('T')[0];
}

// ─── MULTI-TICKER GEX ─────────────────────────────────────────────────────────
// Fetches SPY, QQQ, SPX option chains simultaneously
// Checks if all three agree on regime (video 2: step 6 — compare all three)
const GEX_REFRESH_TIMES = ['09:25', '10:30', '12:00', '14:00'];
let lastGEXMinute = '';

async function refreshGEXAll() {
  const tickers = ['SPY', 'QQQ', 'SPX'];
  const expiry  = getNextFriday();
  log(`Refreshing GEX for ${tickers.join(', ')}...`);

  const results = await Promise.allSettled(tickers.map(t => fetchGEXForTicker(t, expiry)));

  for (let i = 0; i < tickers.length; i++) {
    const t = tickers[i];
    if (results[i].status === 'fulfilled' && results[i].value) {
      state.gexAll[t] = results[i].value.gex;
      DB.saveGEXSnap(t, results[i].value.gex, results[i].value.spot);
      log(`GEX ${t}: anchor=${results[i].value.gex?.anchor} flip=${results[i].value.gex?.flip} regime=${results[i].value.gex?.regime}`);
    } else {
      log(`GEX ${t} failed: ${results[i].reason?.message || 'unknown'}`, 'WARN');
    }
  }

  // Multi-ticker alignment check (video 2: all 3 agree = stronger signal)
  const regimes = tickers
    .map(t => state.gexAll[t]?.regime)
    .filter(Boolean);
  state.gexAll.multiAligned = regimes.length === 3 && new Set(regimes).size === 1;
  state.gexAll.lastFetch    = new Date().toISOString();

  log(`GEX multi-aligned: ${state.gexAll.multiAligned} | SPY:${state.gexAll.SPY?.regime} QQQ:${state.gexAll.QQQ?.regime} SPX:${state.gexAll.SPX?.regime}`);
}

async function fetchGEXForTicker(ticker, expiry) {
  const client = getAlpaca();
  if (!client) return null;

  // Get spot price
  const snap = await client.getLatestTrade(ticker === 'SPX' ? 'SPY' : ticker);
  const spot = snap.Price;
  if (!spot) throw new Error(`no spot for ${ticker}`);

  // Fetch option chain
  const chain = await client.getOptionContracts({
    underlying_symbols: ticker === 'SPX' ? 'SPXW' : ticker,
    expiration_date:    expiry,
    limit:              300,
  });

  const contracts = [];
  if (chain?.option_contracts) {
    for (const c of chain.option_contracts) {
      contracts.push({
        strike_price:  c.strike_price,
        type:          c.type,
        open_interest: c.open_interest || 0,
        greeks: {
          gamma: c.greeks?.gamma || 0,
          vanna: c.greeks?.vanna || 0,
        },
      });
    }
  }

  if (contracts.length < 5) throw new Error(`insufficient chain (${contracts.length} contracts)`);

  const gex = calcGEXLevels(contracts, spot);

  // Inject multi-ticker context so GEX scorer can use it
  if (gex) gex.multiTickerAligned = state.gexAll.multiAligned;

  return { gex, spot };
}

// ─── OPTION FINDER ────────────────────────────────────────────────────────────
async function findOption(symbol, direction) {
  const client = getAlpaca();
  if (!client) return null;
  try {
    const snap   = await client.getLatestTrade(symbol);
    const spot   = snap.Price;
    const expiry = getNextFriday();
    const strike = Math.round(spot);
    const expStr = expiry.replace(/-/g, '').slice(2);
    const strStr = (strike * 1000).toString().padStart(8, '0');
    const optType = direction === 'CALL' ? 'C' : 'P';
    return { symbol: `${symbol}${expStr}${optType}${strStr}`, strike, expiry, type: optType, spot };
  } catch (e) {
    log(`findOption: ${e.message}`, 'ERROR');
    return null;
  }
}

// ─── SIZING ───────────────────────────────────────────────────────────────────
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

// ─── ENTRY ────────────────────────────────────────────────────────────────────
async function placeEntry(signal, signalId) {
  const cfg = state.config;
  if (!cfg.AUTO_TRADE) {
    log(`[SIGNAL] ${signal.direction} ${signal.confidence}% ${signal.grade} ${signal.setup?.type} — AUTO_TRADE OFF`);
    return null;
  }
  if (state.cbTriggered) { log('CB active — skip entry', 'WARN'); return null; }
  if (signal.confidence < cfg.MIN_CONFIDENCE) { log(`Conf ${signal.confidence}% < ${cfg.MIN_CONFIDENCE}%`); return null; }
  if (!signal.tradeable) { log(`Not tradeable: ${signal.rejectReasons[0]}`); return null; }

  const active = Object.values(state.positions).filter(p => p.underlying === 'SPY');
  if (active.length >= cfg.MAX_POSITIONS) { log(`Max positions (${cfg.MAX_POSITIONS}) reached`); return null; }

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
    premium = (signal.meta.atr || opt.spot * 0.003) * 0.8;
    log(`Premium fallback: $${premium.toFixed(2)}`, 'WARN');
  }

  const contracts  = sizeContracts(premium, signal.grade, cfg);
  const limitPrice = parseFloat((premium * 1.01).toFixed(2));
  const premStop   = parseFloat((limitPrice * (1 - cfg.PREMIUM_STOP_PCT)).toFixed(2));
  const atrStop    = parseFloat((limitPrice - (signal.meta.atr || limitPrice * 0.1) * cfg.ATR_STOP_MULT).toFixed(2));
  const tp1Price   = parseFloat((limitPrice * (1 + cfg.TP1_PCT)).toFixed(2));
  const tp2Price   = parseFloat((limitPrice * (1 + cfg.TP2_PCT)).toFixed(2));
  const gexTP1     = signal.direction === 'CALL' ? state.gexAll.SPY?.wallAbove : state.gexAll.SPY?.wallBelow;

  try {
    const order = await client.createOrder({
      symbol: opt.symbol, qty: contracts, side: 'buy',
      type: 'limit', time_in_force: 'day', limit_price: limitPrice,
      client_order_id: `DSB3_ENTRY_${signal.setup?.type}_${Date.now()}`,
    });

    const pos = {
      id: order.id, clientOrderId: order.client_order_id,
      symbol: opt.symbol, underlying: 'SPY', direction: signal.direction,
      contracts, entryPremium: limitPrice, currentPrice: limitPrice,
      strike: opt.strike, expiry: opt.expiry, spot: opt.spot,
      atr: signal.meta.atr, stopPrice: premStop, atrStop, tp1Price, tp2Price, gexTP1,
      setupType: signal.setup?.type, grade: signal.grade, confidence: signal.confidence,
      setupDesc: signal.setup?.desc, delta: signal.meta.delta,
      deltaMag: signal.meta.deltaMag, hasBShape: signal.meta.hasBShape,
      hasPShape: signal.meta.hasPShape, zoneHit: signal.zoneHit,
      gexRegime: signal.meta.gexRegime, gexFlags: signal.meta.gexFlags,
      tp1Hit: false, status: 'OPEN', entryTime: new Date().toISOString(),
      unrealizedPnL: 0, pnlPct: 0, signalId,
    };

    state.positions[opt.symbol] = pos;
    DB.saveTradeEntry(pos, signalId);
    log(`ENTRY: ${signal.direction} ${contracts}x ${opt.symbol} @ $${limitPrice} | ${signal.grade} ${signal.confidence}% | Stop:$${premStop} TP1:$${tp1Price} TP2:$${tp2Price}`);
    return pos;
  } catch (e) {
    log(`createOrder: ${e.message}`, 'ERROR');
    return null;
  }
}

// ─── EXIT ─────────────────────────────────────────────────────────────────────
async function closePosition(symbol, reason, partial = false, partialPct = 1.0) {
  const client = getAlpaca();
  const pos    = state.positions[symbol];
  if (!pos || !client) return;

  const qty = partial ? Math.max(1, Math.floor(pos.contracts * partialPct)) : pos.contracts;
  try {
    await client.createOrder({
      symbol, qty, side: 'sell', type: 'market', time_in_force: 'day',
      client_order_id: `DSB3_EXIT_${reason}_${Date.now()}`,
    });

    let exitP = pos.currentPrice || pos.entryPremium;
    try {
      const q = await client.getLatestOptionQuote(symbol);
      exitP = (q.AskPrice + q.BidPrice) / 2;
    } catch (_) {}

    const pnl = (exitP - pos.entryPremium) * qty * 100;
    DB.saveTradeExit(pos.clientOrderId, exitP, pos.entryPremium, reason, pos.entryTime, qty);
    updateStats(pnl, pos.setupType, pos.grade);

    // Update daily P&L from DB
    const daily = DB.getTodayPnL();
    log(`EXIT [${reason}]: ${qty}x ${symbol} @ ~$${exitP.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Daily: $${daily.toFixed(2)}`);

    if (partial && qty < pos.contracts) {
      pos.contracts -= qty;
      pos.tp1Hit     = true;
      if (state.config.TRAIL_BREAKEVEN) {
        pos.stopPrice = pos.entryPremium;
        log(`Trail stop → BE: ${symbol} @ $${pos.entryPremium}`);
      }
    } else {
      delete state.positions[symbol];
    }

    // Circuit breaker check
    const todayPnL = DB.getTodayPnL();
    const maxLoss  = state.config.ACCOUNT_SIZE * state.config.MAX_DAILY_LOSS;
    if (todayPnL < -maxLoss && !state.cbTriggered) {
      state.cbTriggered = true;
      log(`CIRCUIT BREAKER: daily P&L $${todayPnL.toFixed(2)} exceeds max -$${maxLoss.toFixed(2)}`, 'WARN');
    }
  } catch (e) {
    log(`closePosition [${reason}] ${symbol}: ${e.message}`, 'ERROR');
  }
}

// ─── POSITION MONITOR ────────────────────────────────────────────────────────
async function monitorPositions(bars5m) {
  const client = getAlpaca();
  if (!client) return;

  for (const [symbol, pos] of Object.entries(state.positions)) {
    try {
      let cur = pos.currentPrice;
      try {
        const q = await client.getLatestOptionQuote(symbol);
        cur = (q.AskPrice + q.BidPrice) / 2;
        if (cur > 0) {
          pos.currentPrice   = cur;
          pos.unrealizedPnL  = (cur - pos.entryPremium) * pos.contracts * 100;
          pos.pnlPct         = ((cur - pos.entryPremium) / pos.entryPremium) * 100;
        }
      } catch (_) {}

      // 1. Hard stop
      if (cur <= pos.stopPrice) { await closePosition(symbol, 'PREMIUM_STOP'); continue; }
      // 2. ATR stop (pre-TP1)
      if (!pos.tp1Hit && cur <= pos.atrStop) { await closePosition(symbol, 'ATR_STOP'); continue; }
      // 3. Sowmya exit signal (opposite trapped participant)
      if (bars5m) {
        const o5 = bars5m.map(b => b.o), h5 = bars5m.map(b => b.h);
        const l5 = bars5m.map(b => b.l), c5 = bars5m.map(b => b.c), v5 = bars5m.map(b => b.v);
        const exitSig = detectExitSignal(o5, h5, l5, c5, v5, pos.direction);
        if (exitSig.exit && pos.tp1Hit) {
          await closePosition(symbol, `SOWMYA_EXIT`); continue;
        }
        if (exitSig.exit) log(`Sowmya exit signal: ${exitSig.reason} on ${symbol} (TP1 not hit — monitoring)`, 'WARN');
      }
      // 4. TP1 partial
      if (!pos.tp1Hit && cur >= pos.tp1Price) {
        await closePosition(symbol, 'TP1', true, state.config.TP1_CLOSE_PCT); continue;
      }
      // 5. TP2 full
      if (pos.tp1Hit && cur >= pos.tp2Price) {
        await closePosition(symbol, 'TP2'); continue;
      }
    } catch (e) {
      log(`Monitor ${symbol}: ${e.message}`, 'ERROR');
    }
  }
}

// ─── NEWS BLACKOUT ────────────────────────────────────────────────────────────
function isNewsBlacklist(h, m) {
  const mins = h * 60 + m;
  return mins >= 13 * 60 + 55 && mins <= 14 * 60 + 20;  // FOMC window
}

// ─── MAIN SCAN LOOP ───────────────────────────────────────────────────────────
async function runScan() {
  if (!isMarketHours()) return;
  if (state.cbTriggered) { log('CB active — scan skipped', 'WARN'); return; }

  try {
    const now = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    const etH = now.getHours(), etM = now.getMinutes();
    const etStr = `${String(etH).padStart(2,'0')}:${String(etM).padStart(2,'0')}`;

    // Scheduled GEX refresh
    if (GEX_REFRESH_TIMES.includes(etStr) && etStr !== lastGEXMinute) {
      await refreshGEXAll();
      lastGEXMinute = etStr;
    }
    const gexAge = state.gexAll.lastFetch
      ? (Date.now() - new Date(state.gexAll.lastFetch)) / 60000 : Infinity;
    if (gexAge > state.config.GEX_REFRESH_MINS) await refreshGEXAll();

    // Fetch bars
    const [bars15m, bars5m] = await Promise.all([
      getBars('SPY', '15Min', 55),
      getBars('SPY', '5Min', 65),
    ]);
    if (!bars15m || !bars5m) { log('Bar fetch failed', 'WARN'); return; }

    // Update zone map
    if (bars15m.length >= 15) {
      state.zones = detectSDZones(
        bars15m.map(b => b.o), bars15m.map(b => b.h),
        bars15m.map(b => b.l), bars15m.map(b => b.c), bars15m.map(b => b.v)
      );
    }

    // Monitor open positions first
    await monitorPositions(bars5m);

    // News blackout
    if (isNewsBlacklist(etH, etM)) {
      log(`News blackout (${etStr} ET) — no new entries`); return;
    }

    // Build merged GEX for evaluateSignal (SPY with multi-ticker context)
    const gexForSignal = state.gexAll.SPY
      ? { ...state.gexAll.SPY, multiTickerAligned: state.gexAll.multiAligned }
      : null;

    // Evaluate signal
    const signal = evaluateSignal({
      bars15m, bars5m,
      gexData:       gexForSignal,
      etHour:        etH,
      etMinute:      etM,
      priorDayClose: state.priorDayClose,
    });
    state.lastSignal = signal;

    // Save every signal to DB (even rejected — valuable for data mining)
    const signalId = DB.saveSignal(signal, state.gexAll);

    const rejectStr = signal.rejectReasons.length ? ` REJECT: ${signal.rejectReasons[0]}` : '';
    log(`SCAN ${etStr} → ${signal.direction} ${signal.confidence}% ${signal.grade || '-'} setup=${signal.setup?.type || 'none'} zone=${signal.zoneHit?.type || 'miss'} multi=${state.gexAll.multiAligned}${rejectStr}`);

    if (signal.tradeable) await placeEntry(signal, signalId);

  } catch (e) {
    log(`Scan error: ${e.message}`, 'ERROR');
  }
}

// ─── SCHEDULED TASKS ─────────────────────────────────────────────────────────
function scheduleForceClose() {
  const [h, m] = state.config.FORCE_CLOSE_ET.split(':').map(Number);
  setInterval(() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (et.getHours() === h && et.getMinutes() === m) {
      log(`FORCE CLOSE all at ${state.config.FORCE_CLOSE_ET} ET`);
      Object.keys(state.positions).forEach(sym => closePosition(sym, 'FORCE_CLOSE_EOD'));
    }
  }, 60000);
}

function scheduleDailyReset() {
  setInterval(() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (et.getHours() === 9 && et.getMinutes() === 25) {
      state.cbTriggered = false;
      log('Daily circuit breaker reset at 9:25 AM ET');
      fetchPriorDayClose('SPY');
    }
  }, 60000);
}

function isMarketHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const d  = et.getDay();
  if (d === 0 || d === 6) return false;
  const m = et.getHours() * 60 + et.getMinutes();
  return m >= 9 * 60 + 30 && m < 16 * 60;
}

function updateStats(pnl, setupType, grade) {
  const s = state.stats;
  s.totalTrades++; s.totalPnL += pnl;
  if (pnl > 0) {
    s.wins++; s.biggestWin = Math.max(s.biggestWin, pnl);
    s.currentStreak = s.currentStreak >= 0 ? s.currentStreak + 1 : 1;
    s.winStreak = Math.max(s.winStreak, s.currentStreak);
  } else {
    s.losses++; s.biggestLoss = Math.min(s.biggestLoss, pnl);
    s.currentStreak = s.currentStreak <= 0 ? s.currentStreak - 1 : -1;
    s.lossStreak = Math.min(s.lossStreak, s.currentStreak);
  }
  if (setupType && s.setupBreakdown[setupType] !== undefined) s.setupBreakdown[setupType]++;
  if (grade     && s.gradeBreakdown[grade]     !== undefined) s.gradeBreakdown[grade]++;
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  const { ALPACA_KEY, ALPACA_SECRET, ...safeConfig } = state.config;
  res.json({
    positions:     state.positions,
    zones:         state.zones,
    lastSignal:    state.lastSignal,
    gexAll:        state.gexAll,
    cbTriggered:   state.cbTriggered,
    marketOpen:    isMarketHours(),
    config:        safeConfig,
    stats:         state.stats,
    priorDayClose: state.priorDayClose,
    dailyPnL:      DB.getTodayPnL(),
  });
});

app.get('/api/logs',           (req, res) => res.json(logs.slice(0, 200)));
app.get('/api/trades',         (req, res) => res.json(DB.getRecentTrades(100)));
app.get('/api/signals',        (req, res) => res.json(DB.getRecentSignals(50)));
app.get('/api/stats',          (req, res) => res.json({ summary: DB.getStats(), bySetup: DB.getSetupBreakdown(), daily: DB.getDailyStats(30) }));
app.get('/api/gex-history',    (req, res) => res.json(DB.getGEXHistory(req.query.ticker || 'SPY', 48)));

app.post('/api/scan',          async (req, res) => { await runScan(); res.json({ ok: true, signal: state.lastSignal }); });
app.post('/api/gex-refresh',   async (req, res) => { await refreshGEXAll(); res.json({ ok: true, gex: state.gexAll }); });
app.post('/api/close/:symbol', async (req, res) => { await closePosition(decodeURIComponent(req.params.symbol), 'MANUAL'); res.json({ ok: true }); });
app.post('/api/reset-daily',   (req, res) => { state.cbTriggered = false; log('Daily CB reset'); res.json({ ok: true }); });

app.post('/api/config', (req, res) => {
  const allowed = ['RISK_DOLLARS','ACCOUNT_SIZE','MAX_DAILY_LOSS','PREMIUM_STOP_PCT',
    'TP1_PCT','TP2_PCT','TP1_CLOSE_PCT','ATR_STOP_MULT','TRAIL_BREAKEVEN',
    'TIERED_SIZING','AUTO_TRADE','MIN_CONFIDENCE','FORCE_CLOSE_ET',
    'GEX_REFRESH_MINS','SCAN_INTERVAL_MINS','MAX_POSITIONS'];
  for (const [k,v] of Object.entries(req.body)) if (allowed.includes(k)) state.config[k] = v;
  if (req.body.ALPACA_KEY || req.body.ALPACA_SECRET) _alpaca = null;
  log(`Config: ${JSON.stringify(req.body)}`);
  res.json({ ok: true, config: state.config });
});

// Data mining endpoints
app.get('/api/mining/signals', (req, res) => {
  const { grade, direction, tradeable, limit = 200 } = req.query;
  let q = 'SELECT * FROM signals WHERE 1=1';
  const params = [];
  if (grade)     { q += ' AND grade = ?';     params.push(grade); }
  if (direction) { q += ' AND direction = ?'; params.push(direction); }
  if (tradeable) { q += ' AND tradeable = ?'; params.push(parseInt(tradeable)); }
  q += ' ORDER BY ts DESC LIMIT ?';
  params.push(parseInt(limit));
  res.json(DB.db.prepare(q).all(...params));
});

app.get('/api/mining/trades', (req, res) => {
  const { setup_type, grade, exit_reason, limit = 200 } = req.query;
  let q = 'SELECT * FROM trades WHERE status = \'CLOSED\'';
  const params = [];
  if (setup_type)  { q += ' AND setup_type = ?';  params.push(setup_type); }
  if (grade)       { q += ' AND grade = ?';        params.push(grade); }
  if (exit_reason) { q += ' AND exit_reason = ?';  params.push(exit_reason); }
  q += ' ORDER BY ts DESC LIMIT ?';
  params.push(parseInt(limit));
  res.json(DB.db.prepare(q).all(...params));
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'client/build/index.html')));

// ─── STARTUP ──────────────────────────────────────────────────────────────────
app.listen(ENV.PORT, async () => {
  log(`DSB v3 | port=${ENV.PORT} paper=${ENV.PAPER} autoTrade=${ENV.AUTO_TRADE} db=${require('./db').db.name}`);
  scheduleForceClose();
  scheduleDailyReset();
  if (isMarketHours()) {
    await Promise.all([refreshGEXAll(), fetchPriorDayClose('SPY')]);
  }
  const ms = ENV.SCAN_INTERVAL_MINS * 60 * 1000;
  setInterval(runScan, ms);
  setTimeout(runScan, 5000);
});

module.exports = app;
