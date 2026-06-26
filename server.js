'use strict';
/**
 * server.js — DSB v3 — Fixed version
 *
 * Fixes applied (all verified against @alpacahq/alpaca-trade-api@3.1.3 source):
 *
 * FIX 1: getOptionContracts does NOT exist → use getOptionChain(symbol, options)
 *         Returns array of snapshot objects with .Greeks.{delta,gamma,theta,vega,rho}
 *         and .LatestQuote.{AskPrice, BidPrice}
 *
 * FIX 2: getLatestOptionQuote does NOT exist → use getOptionLatestQuotes([symbol])
 *         Returns a Map keyed by symbol with .LatestQuote.{AskPrice, BidPrice}
 *
 * FIX 3: SPX is an index, getLatestTrade('SPX') fails → use getSnapshot('SPY') for
 *         spot price; use 'SPXW' underlying for option chain
 *
 * FIX 4: 429 rate limiting → stagger GEX fetches (SPY → delay → QQQ → delay → SPX)
 *         instead of simultaneous Promise.allSettled; add retry with backoff
 *
 * FIX 5: "Insufficient bar data" at open → lower min bar threshold to 20 bars for
 *         15m (need ~1.5 hrs of history) and fix strategy.js minimum check
 *
 * FIX 6: Exit signal blocking B-Shape@Demand entry → B-Shape at demand is an ENTRY
 *         signal (SETUP_3), not an exit signal. Fixed detectExitSignal in strategy.js
 *         to only fire on OPPOSING zone context, not same-direction shapes
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
  getExitStrategyLabel,
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
  config:       { ...ENV },
  positions:    {},
  lastSignal:   null,
  zones:        { demand: [], supply: [] },
  gexAll: { SPY: null, QQQ: null, SPX: null, multiAligned: false, lastFetch: null },
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

// ─── ALPACA CLIENT ────────────────────────────────────────────────────────────
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

// ─── SLEEP HELPER ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── RETRY WRAPPER ────────────────────────────────────────────────────────────
// Handles 429 rate limit with exponential backoff
async function withRetry(fn, label, retries = 3, baseDelayMs = 2000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (e) {
      const is429 = e.message?.includes('429') || e.statusCode === 429;
      if (is429 && i < retries - 1) {
        const delay = baseDelayMs * Math.pow(2, i);
        log(`${label}: 429 rate limit — retry ${i + 1}/${retries - 1} in ${delay}ms`, 'WARN');
        await sleep(delay);
      } else {
        throw e;
      }
    }
  }
}

// ─── BAR DATA ─────────────────────────────────────────────────────────────────
async function getBars(symbol, timeframe, limit) {
  const client = getAlpaca();
  if (!client) return null;
  try {
    const resp = await withRetry(
      () => client.getBarsV2(symbol, { timeframe, limit, feed: 'iex', adjustment: 'raw' }),
      `getBars(${symbol},${timeframe})`
    );
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
    const bars = await getBars(symbol, '1Day', 5);
    if (bars?.length >= 2) {
      state.priorDayClose = bars[bars.length - 2].c;
      log(`Prior day close: $${state.priorDayClose?.toFixed(2)}`);
    }
  } catch (e) {
    log(`Prior day close: ${e.message}`, 'WARN');
  }
}

// ─── SPOT PRICE ───────────────────────────────────────────────────────────────
// FIX 3: SPX is an index — use getSnapshot for price, returns DailyBar.ClosePrice
async function getSpotPrice(ticker) {
  const client = getAlpaca();
  if (!client) throw new Error('no client');
  // For SPX (index), use SPY as spot proxy since SPX has no direct trade feed
  const priceSymbol = ticker === 'SPX' ? 'SPY' : ticker;
  const trade = await client.getLatestTrade(priceSymbol);
  const price = trade?.Price;
  if (!price) throw new Error(`no price for ${priceSymbol}`);
  // Scale SPY→SPX approximation (SPX ≈ SPY × 10)
  return ticker === 'SPX' ? price * 10 : price;
}

// ─── OPTION EXPIRY ────────────────────────────────────────────────────────────
function get0DTEExpiry(ticker) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  const day = d.getDay(); // 0=Sun..6=Sat

  if (ticker === 'SPX' || ticker === 'SPXW') {
    // SPXW has 0DTE every weekday
    if (day === 0) d.setDate(d.getDate() + 1);
    else if (day === 6) d.setDate(d.getDate() + 2);
  } else {
    // SPY/QQQ: 0DTE on Mon(1), Wed(3), Fri(5)
    const valid = [1, 3, 5];
    while (!valid.includes(d.getDay())) d.setDate(d.getDate() + 1);
  }
  return d.toISOString().split('T')[0];
}

// ─── GEX FETCH — CORRECT API CALL ─────────────────────────────────────────────
// FIX 1: Use getOptionChain(symbol, options) NOT getOptionContracts()
// getOptionChain returns array of AlpacaOptionSnapshotV1Beta1 objects:
//   { Symbol, LatestTrade, LatestQuote, ImpliedVolatility, Greeks: {delta,gamma,theta,vega,rho} }
// We also need open_interest — it comes from the raw data as 'open_interest' field
// Use feed:'indicative' for greeks (more reliable than 'opra' for paper accounts)

// FIX (root cause of flip=null + bogus anchor): the options SNAPSHOT endpoint
// (getOptionChain → /v1beta1/options/snapshots/{symbol}) returns greeks but
// per Alpaca's own docs it does NOT include open_interest at all. Open
// interest only exists on the separate CONTRACTS metadata endpoint
// (/v2/options/contracts), which has no SDK method in this package version.
// We were reading c.open_interest off the snapshot response, which is always
// undefined → defaulted to 0 → every gexContrib = gamma * 0 * 100 * spot = 0
// for every single contract. That makes ALL GEX values zero: no sign changes
// ever occur (flip stays null forever) and 'anchor' just becomes whichever
// strike happens to be first when every |net| ties at 0 — explaining the
// suspiciously low, static anchor values (425, 400, 2800) we saw in prod.
//
// Fix: fetch BOTH endpoints and merge by symbol —
//   1) /v2/options/contracts  → open_interest, strike_price, type (ground truth)
//   2) /v1beta1/options/snapshots/{symbol} → greeks (gamma, vanna)
// via client.httpRequest() (trading API) and client.getOptionChain() (data API).
async function fetchGEXForTicker(ticker) {
  const client = getAlpaca();
  if (!client) throw new Error('no client');

  const spot   = await getSpotPrice(ticker);
  const expiry = get0DTEExpiry(ticker);
  const underlying = ticker === 'SPX' ? 'SPXW' : ticker;

  // 1) Contracts metadata — ground truth for open_interest, strike, type
  const contractsResp = await withRetry(
    () => client.httpRequest('/options/contracts', {
      underlying_symbols: underlying,
      expiration_date:    expiry,
      limit:              500,
      status:             'active',
    }),
    `httpRequest(/options/contracts, ${underlying})`
  );

  const rawContracts = contractsResp?.data?.option_contracts || [];
  if (rawContracts.length < 5) {
    throw new Error(`insufficient contracts metadata: ${rawContracts.length}`);
  }

  // Build a lookup: symbol → { strike, type, open_interest }
  const oiMap = new Map();
  for (const c of rawContracts) {
    oiMap.set(c.symbol, {
      strike:        parseFloat(c.strike_price),
      type:          c.type,                       // 'call' | 'put'
      open_interest: parseInt(c.open_interest, 10) || 0,
    });
  }

  // 2) Snapshots — greeks (gamma, vanna) per symbol
  // Try 'opra' feed first (has greeks), fall back to 'indicative'
  let chainData;
  for (const feed of ['opra', 'indicative']) {
    try {
      chainData = await withRetry(
        () => client.getOptionChain(underlying, {
          expiration_date: expiry,
          feed,
          totalLimit:      500,
        }),
        `getOptionChain(${underlying}, feed=${feed})`
      );
      if (chainData && chainData.length >= 5) {
        const sample = chainData[0];
        const hasGreeks = !!(sample?.Greeks || sample?.greeks || sample?.ImpliedVolatility);
        log(`GEX ${ticker}: feed=${feed} returned ${chainData.length} snaps, hasGreeks=${hasGreeks}`);
        if (hasGreeks) break;
      }
    } catch (e) {
      log(`GEX ${ticker}: feed=${feed} failed: ${e.message}`, 'WARN');
    }
  }

  if (!chainData || chainData.length < 5) {
    throw new Error(`insufficient chain snapshots: ${chainData?.length || 0}`);
  }

  // Merge: walk the contracts metadata (ground truth) and attach greeks
  // from the matching snapshot symbol, if present.
  // Support both SDK casing: Greeks.gamma (v3) or greeks.gamma
  const snapBySymbol = new Map(chainData.map(s => [s.Symbol || s.symbol, s]));

  const contracts = [];
  for (const [symbol, meta] of oiMap.entries()) {
    if (!meta.strike || meta.strike <= 0) continue;
    const snap = snapBySymbol.get(symbol);
    const g = snap?.Greeks || snap?.greeks || {};
    contracts.push({
      strike_price:  meta.strike,
      type:          meta.type,
      open_interest: meta.open_interest,
      greeks: {
        gamma: g.gamma || g.Gamma || 0,
        vanna: g.vanna || g.Vanna || 0,
      },
    });
  }

  if (contracts.length < 5) {
    throw new Error(`merged contract count too low: ${contracts.length}`);
  }

  const withOI = contracts.filter(c => c.open_interest > 0).length;
  const withGamma = contracts.filter(c => c.greeks.gamma !== 0).length;
  const sampleSnap = chainData[0];
  log(`GEX ${ticker}: ${contracts.length} merged, ${withOI} w/OI, ${withGamma} w/gamma, expiry=${expiry}, snap sample=${JSON.stringify(Object.keys(sampleSnap||{}))}, IV=${sampleSnap?.ImpliedVolatility ?? sampleSnap?.impliedVolatility ?? 'none'}`);
  if (withOI === 0) {
    throw new Error('all contracts have zero open_interest — GEX would be all-zero');
  }

  const gex = calcGEXLevels(contracts, spot);
  if (gex) gex.multiTickerAligned = state.gexAll.multiAligned;
  return { gex, spot };
}

// ─── MULTI-TICKER GEX REFRESH ─────────────────────────────────────────────────
// FIX 4: Stagger requests to avoid 429 — sequential with 1.5s gap between tickers
const GEX_REFRESH_TIMES = ['09:25', '10:30', '12:00', '14:00'];
let lastGEXMinute = '';

async function refreshGEXAll() {
  const tickers = ['SPY', 'QQQ', 'SPX'];
  log(`Refreshing GEX for ${tickers.join(', ')}...`);

  for (const ticker of tickers) {
    try {
      const result = await fetchGEXForTicker(ticker);
      state.gexAll[ticker] = result.gex;
      DB.saveGEXSnap(ticker, result.gex, result.spot);
      if (result.gex?.degenerate) {
        log(`GEX ${ticker}: DEGENERATE — ${result.gex.degenerateReason}`, 'WARN');
      } else {
        log(`GEX ${ticker}: anchor=${result.gex?.anchor} flip=${result.gex?.flip} regime=${result.gex?.regime} contracts=${result.gex?.strikes?.length || 0}`);
      }
    } catch (e) {
      log(`GEX ${ticker} failed: ${e.message}`, 'WARN');
      // Keep prior GEX data if refresh fails — don't null it out
    }
    // Stagger: wait 1.5s between tickers to avoid rate limits
    await sleep(1500);
  }

  // Multi-ticker alignment (video 2: step 6)
  // Require at least 2 tickers with matching regime (SPX may fail on some days)
  const regimes = tickers.map(t => state.gexAll[t]?.regime).filter(Boolean);
  state.gexAll.multiAligned = regimes.length >= 2 && new Set(regimes).size === 1;
  state.gexAll.lastFetch    = new Date().toISOString();

  log(`GEX complete — SPY:${state.gexAll.SPY?.regime || '?'} QQQ:${state.gexAll.QQQ?.regime || '?'} SPX:${state.gexAll.SPX?.regime || '?'} aligned:${state.gexAll.multiAligned}`);
}

// ─── OPTION QUOTE — CORRECT METHOD ────────────────────────────────────────────
// FIX 2: getLatestOptionQuote does NOT exist → use getOptionLatestQuotes([symbol])
// Returns a Map<symbol, {LatestQuote: {AskPrice, BidPrice, ...}}>
async function getOptionMidPrice(optionSymbol) {
  const client = getAlpaca();
  if (!client) throw new Error('no client');
  const result = await withRetry(
    () => client.getOptionLatestQuotes([optionSymbol]),
    `getOptionLatestQuotes(${optionSymbol})`
  );
  // result is a Map
  const snap = result?.get ? result.get(optionSymbol) : result?.[optionSymbol];
  const ask  = snap?.LatestQuote?.AskPrice || snap?.ask_price || 0;
  const bid  = snap?.LatestQuote?.BidPrice || snap?.bid_price || 0;
  if (!ask && !bid) throw new Error('zero bid/ask');
  return (ask + bid) / 2;
}

// ─── OPTION FINDER ────────────────────────────────────────────────────────────
async function findOption(symbol, direction) {
  const client = getAlpaca();
  if (!client) return null;
  try {
    const spot   = await getSpotPrice(symbol);
    const expiry = get0DTEExpiry(symbol);
    const strike = Math.round(spot);
    const expStr = expiry.replace(/-/g, '').slice(2);  // YYMMDD
    const strStr = (strike * 1000).toString().padStart(8, '0');
    const optType = direction === 'CALL' ? 'C' : 'P';
    const optSymbol = `${symbol}${expStr}${optType}${strStr}`;
    return { symbol: optSymbol, strike, expiry, type: optType, spot };
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
  if (state.cbTriggered)    { log('CB active — skip', 'WARN'); return null; }
  if (signal.confidence < cfg.MIN_CONFIDENCE) { log(`Conf ${signal.confidence}% < ${cfg.MIN_CONFIDENCE}%`); return null; }
  if (!signal.tradeable)    { log(`Not tradeable: ${signal.rejectReasons[0]}`); return null; }

  const active = Object.values(state.positions).filter(p => p.underlying === 'SPY');
  if (active.length >= cfg.MAX_POSITIONS) { log(`Max positions reached`); return null; }

  const client = getAlpaca();
  if (!client) return null;

  const opt = await findOption('SPY', signal.direction);
  if (!opt) return null;

  let premium;
  try {
    // FIX 2: use getOptionLatestQuotes not getLatestOptionQuote
    premium = await getOptionMidPrice(opt.symbol);
  } catch (e) {
    premium = (signal.meta.atr || opt.spot * 0.003) * 0.8;
    log(`Premium fallback: $${premium.toFixed(2)} (${e.message})`, 'WARN');
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

    const confluenceSummary = signal.meta?.confluenceSummary || signal.setup?.desc || '(no confluence summary available)';

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
      // Running high/low watermark on the option premium while held —
      // tracks the best and worst price seen so far, independent of where
      // it currently sits. Updated every monitor poll (every 30 seconds).
      maxPremium: limitPrice,
      minPremium: limitPrice,
      // Plain-English explanation of WHY this trade fired — zone + setup +
      // every positive-weight confluence factor (GEX regime/flip/walls,
      // VWAP, EMA, ATR, volume). Persisted to DB and shown in the dashboard
      // so every entry is self-explanatory without reading the strategy code.
      confluenceSummary,
    };

    state.positions[opt.symbol] = pos;
    DB.saveTradeEntry(pos, signalId);
    log(`ENTRY: ${signal.direction} ${contracts}x ${opt.symbol} @ $${limitPrice} | ${signal.grade} ${signal.confidence}% | Stop:$${premStop} TP1:$${tp1Price} TP2:$${tp2Price}`);
    log(`  ↳ Confluence: ${confluenceSummary}`);
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
      // FIX 2: use getOptionLatestQuotes not getLatestOptionQuote
      exitP = await getOptionMidPrice(symbol);
    } catch (_) {}

    const pnl = (exitP - pos.entryPremium) * qty * 100;
    const exitStrategyLabel = getExitStrategyLabel(reason);
    DB.saveTradeExit(pos.clientOrderId, exitP, pos.entryPremium, reason, pos.entryTime, qty, pos.maxPremium, pos.minPremium, exitStrategyLabel);
    updateStats(pnl, pos.setupType, pos.grade);

    const todayPnL = DB.getTodayPnL();
    log(`EXIT [${reason}]: ${qty}x ${symbol} @ ~$${exitP.toFixed(2)} | PnL: ${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)} | Daily: $${todayPnL.toFixed(2)}`);
    log(`  ↳ Exit strategy: ${exitStrategyLabel}`);

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

    const maxLoss = state.config.ACCOUNT_SIZE * state.config.MAX_DAILY_LOSS;
    if (DB.getTodayPnL() < -maxLoss && !state.cbTriggered) {
      state.cbTriggered = true;
      log(`CIRCUIT BREAKER triggered: daily P&L < -$${maxLoss.toFixed(0)}`, 'WARN');
    }
  } catch (e) {
    log(`closePosition [${reason}] ${symbol}: ${e.message}`, 'ERROR');
  }
}

// ─── POSITION MONITOR ─────────────────────────────────────────────────────────
// FIX: position monitoring decoupled from the 5-min signal-scan cadence.
// Runs on its own 1-minute interval (POSITION_POLL_SECS) so stops/TPs/exit
// signals are checked far more often than new entries are evaluated.
// bars5m is optional here — only needed for the Sowmya opposing-signal exit
// check; when called from the dedicated 1-min poller (no fresh bars handy)
// that check is simply skipped for that cycle and re-checked next poll.
async function monitorPositions(bars5m) {
  for (const [symbol, pos] of Object.entries(state.positions)) {
    try {
      // Update current price using FIX 2
      try {
        const cur = await getOptionMidPrice(symbol);
        if (cur > 0) {
          pos.currentPrice   = cur;
          pos.unrealizedPnL  = (cur - pos.entryPremium) * pos.contracts * 100;
          pos.pnlPct         = ((cur - pos.entryPremium) / pos.entryPremium) * 100;
          pos.status         = 'OPEN';
          // Running watermark — highest/lowest premium seen while held
          pos.maxPremium = Math.max(pos.maxPremium ?? cur, cur);
          pos.minPremium = Math.min(pos.minPremium ?? cur, cur);
          DB.updateTradeWatermark(pos.clientOrderId, pos.maxPremium, pos.minPremium);
        }
      } catch (_) {}

      const cur = pos.currentPrice;

      // 1. Hard stop
      if (cur <= pos.stopPrice) { await closePosition(symbol, 'PREMIUM_STOP'); continue; }
      // 2. ATR stop (pre-TP1 only)
      if (!pos.tp1Hit && cur <= pos.atrStop) { await closePosition(symbol, 'ATR_STOP'); continue; }
      // 3. Sowmya exit signal (only use when in profit / TP1 already hit)
      if (bars5m && pos.tp1Hit) {
        const o5 = bars5m.map(b => b.o), h5 = bars5m.map(b => b.h);
        const l5 = bars5m.map(b => b.l), c5 = bars5m.map(b => b.c), v5 = bars5m.map(b => b.v);
        const exitSig = detectExitSignal(o5, h5, l5, c5, v5, pos.direction);
        if (exitSig.exit) { await closePosition(symbol, `SOWMYA_EXIT`); continue; }
      }
      // 4. TP1 partial close
      if (!pos.tp1Hit && cur >= pos.tp1Price) {
        await closePosition(symbol, 'TP1', true, state.config.TP1_CLOSE_PCT); continue;
      }
      // 5. TP2 full close
      if (pos.tp1Hit && cur >= pos.tp2Price) {
        await closePosition(symbol, 'TP2'); continue;
      }
    } catch (e) {
      log(`Monitor ${symbol}: ${e.message}`, 'ERROR');
    }
  }
}

// ─── NEWS BLACKOUT ─────────────────────────────────────────────────────────────
function isNewsBlacklist(h, m) {
  const mins = h * 60 + m;
  return mins >= 13 * 60 + 55 && mins <= 14 * 60 + 20;
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
    // Stale GEX refresh
    const gexAge = state.gexAll.lastFetch
      ? (Date.now() - new Date(state.gexAll.lastFetch)) / 60000 : Infinity;
    if (gexAge > state.config.GEX_REFRESH_MINS) await refreshGEXAll();

    // FIX 4: Fetch bars with retry (staggered — 15m first, then 5m)
    const bars15m = await getBars('SPY', '15Min', 55);
    await sleep(500);  // small gap to avoid concurrent rate limit
    const bars5m  = await getBars('SPY', '5Min', 65);

    if (!bars5m || bars5m.length < 10) {
      log('Insufficient 5m bar data — skipping scan', 'WARN'); return;
    }

    // FIX 5: Lower minimum bar threshold — 15m bars may be sparse at open
    // Use whatever 15m bars we have (minimum 8 for zone detection)
    const use15m = bars15m && bars15m.length >= 8 ? bars15m : null;

    // Update zone map if we have enough 15m bars
    if (use15m) {
      state.zones = detectSDZones(
        use15m.map(b => b.o), use15m.map(b => b.h),
        use15m.map(b => b.l), use15m.map(b => b.c), use15m.map(b => b.v)
      );
    }

    // Position monitoring now runs on its own dedicated 1-minute interval
    // (see schedulePositionPoll below) — no longer tied to the 5-min scan.
    // Still pass bars5m here too in case a position needs the Sowmya exit
    // check immediately rather than waiting up to a minute for the next poll.
    await monitorPositions(bars5m);

    // News blackout
    if (isNewsBlacklist(etH, etM)) {
      log(`News blackout (${etStr} ET) — no new entries`); return;
    }

    // Merge GEX context
    const gexForSignal = state.gexAll.SPY
      ? { ...state.gexAll.SPY, multiTickerAligned: state.gexAll.multiAligned }
      : null;

    // Evaluate signal
    const signal = evaluateSignal({
      bars15m: use15m || bars5m,  // fallback to 5m for zone if no 15m
      bars5m,
      gexData:       gexForSignal,
      etHour:        etH,
      etMinute:      etM,
      priorDayClose: state.priorDayClose,
      minConfidence: state.config.MIN_CONFIDENCE,
    });
    state.lastSignal = signal;

    // Save ALL signals to DB for data mining (including rejected)
    const signalId = DB.saveSignal(signal, state.gexAll);

    const rejectStr = signal.rejectReasons.length ? ` REJECT: ${signal.rejectReasons[0]}` : '';
    log(`SCAN ${etStr} → ${signal.direction} ${signal.confidence}% ${signal.grade || '-'} setup=${signal.setup?.type || 'none'} zone=${signal.zoneHit?.type || 'miss'} multi=${state.gexAll.multiAligned}${rejectStr}`);
    if (signal.meta?.confluenceSummary) {
      log(`  ↳ Confluence: ${signal.meta.confluenceSummary}`);
    }

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
      log(`FORCE CLOSE all positions at ${state.config.FORCE_CLOSE_ET} ET`);
      Object.keys(state.positions).forEach(sym => closePosition(sym, 'FORCE_CLOSE_EOD'));
    }
  }, 60000);
}

function scheduleDailyReset() {
  setInterval(() => {
    const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
    if (et.getHours() === 9 && et.getMinutes() === 25) {
      state.cbTriggered = false;
      log('Daily CB reset at 9:25 AM ET');
      fetchPriorDayClose('SPY');
    }
  }, 60000);
}

// Position monitoring on its own 30-second cadence — independent of
// SCAN_INTERVAL_MINS (5 min by default for new-signal evaluation). Stops,
// TPs, and the Sowmya exit signal need much tighter polling than that, or a
// position can blow through a stop and sit unclosed for minutes.
const POSITION_POLL_MS = 30 * 1000;
function schedulePositionPoll() {
  setInterval(async () => {
    if (!isMarketHours()) return;
    if (Object.keys(state.positions).length === 0) return;  // nothing to poll
    try {
      await monitorPositions(null);  // no fresh 5m bars on this cadence; stop/TP checks don't need them
    } catch (e) {
      log(`Position poll error: ${e.message}`, 'ERROR');
    }
  }, POSITION_POLL_MS);
}

function isMarketHours() {
  const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  if (et.getDay() === 0 || et.getDay() === 6) return false;
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
  if (grade && s.gradeBreakdown[grade] !== undefined) s.gradeBreakdown[grade]++;
}

// ─── API ROUTES ───────────────────────────────────────────────────────────────
app.get('/api/state', (req, res) => {
  const { ALPACA_KEY, ALPACA_SECRET, ...safeConfig } = state.config;
  res.json({
    positions: state.positions, zones: state.zones, lastSignal: state.lastSignal,
    gexAll: state.gexAll, cbTriggered: state.cbTriggered,
    marketOpen: isMarketHours(), config: safeConfig, stats: state.stats,
    priorDayClose: state.priorDayClose, dailyPnL: DB.getTodayPnL(),
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

app.get('/api/mining/signals', (req, res) => {
  const { grade, direction, tradeable, limit = 200 } = req.query;
  let q = 'SELECT * FROM signals WHERE 1=1';
  const p = [];
  if (grade)     { q += ' AND grade = ?';     p.push(grade); }
  if (direction) { q += ' AND direction = ?'; p.push(direction); }
  if (tradeable) { q += ' AND tradeable = ?'; p.push(parseInt(tradeable)); }
  q += ' ORDER BY ts DESC LIMIT ?'; p.push(parseInt(limit));
  res.json(DB.db.prepare(q).all(...p));
});

app.get('/api/mining/trades', (req, res) => {
  const { setup_type, grade, exit_reason, limit = 200 } = req.query;
  let q = "SELECT * FROM trades WHERE status = 'CLOSED'";
  const p = [];
  if (setup_type)  { q += ' AND setup_type = ?';  p.push(setup_type); }
  if (grade)       { q += ' AND grade = ?';        p.push(grade); }
  if (exit_reason) { q += ' AND exit_reason = ?';  p.push(exit_reason); }
  q += ' ORDER BY ts DESC LIMIT ?'; p.push(parseInt(limit));
  res.json(DB.db.prepare(q).all(...p));
});

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
// MUST be registered BEFORE the catch-all '*' route below — Express matches
// routes in registration order, and a wildcard route placed first will
// swallow every request including this one, hiding healthcheck failures
// behind a generic 404/500 from the static-file fallback.
app.get('/healthz', (req, res) => {
  res.status(200).json({
    ok: true,
    uptime_s: Math.round(process.uptime()),
    marketOpen: isMarketHours(),
    dbAvailable: DB.isAvailable(),
    alpacaConfigured: !!state.config.ALPACA_KEY,
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'client/build/index.html')));

// ─── PROCESS-LEVEL SAFETY NET ─────────────────────────────────────────────────
// If anything throws outside of a try/catch (a bug we haven't anticipated),
// log it loudly to stdout/stderr BEFORE the process dies, so it shows up in
// Railway's deploy logs / CLI logs instead of vanishing silently. We do NOT
// swallow the error — Node will still exit on uncaughtException, which is
// correct (the alternative, continuing in an unknown state, is worse) — but
// at least the cause will be visible. Railway's restart policy (ON_FAILURE,
// max 3 retries) will restart the container after this.
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.stack || err.message);
  process.exit(1);
});
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled promise rejection:', reason?.stack || reason);
  process.exit(1);
});

// ─── STARTUP ──────────────────────────────────────────────────────────────────
// Bind the port FIRST, synchronously, before any async work (GEX fetch,
// prior-day-close fetch). This is what lets Railway's health check pass
// immediately even if Alpaca is slow or briefly unreachable on cold start.
app.listen(ENV.PORT, () => {
  log(`DSB v3 | port=${ENV.PORT} paper=${ENV.PAPER} autoTrade=${ENV.AUTO_TRADE} dbAvailable=${DB.isAvailable()}`);
  scheduleForceClose();
  scheduleDailyReset();
  schedulePositionPoll();

  // Run startup data fetches async, AFTER the port is already listening.
  // Wrapped in its own try/catch so a slow/broken Alpaca connection at
  // boot cannot prevent the health check from passing.
  (async () => {
    try {
      if (isMarketHours()) {
        await fetchPriorDayClose('SPY');
        await sleep(2000);
        await refreshGEXAll();
      }
    } catch (e) {
      log(`Startup data fetch failed (non-fatal): ${e.message}`, 'ERROR');
    }
  })();

  const ms = ENV.SCAN_INTERVAL_MINS * 60 * 1000;
  setInterval(runScan, ms);
  setTimeout(runScan, 5000);
});

module.exports = app;
