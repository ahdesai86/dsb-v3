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
const FlashAlpha = require('./flashalpha');

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
  FORCE_CLOSE_ET:     process.env.FORCE_CLOSE_ET                || '15:25',
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

// Surface FlashAlpha's internal activity (especially failures) into the same
// dashboard-visible log feed instead of only the raw Railway console — without
// this, FlashAlpha errors were invisible from /api/logs and silently fell
// back to Alpaca with no trace of why.
FlashAlpha.setExternalLogger(log);

// ─── SLEEP HELPER ─────────────────────────────────────────────────────────────
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ─── BLACK-SCHOLES GAMMA (fallback when API doesn't provide greeks) ──────────
function bsGamma(spot, strike, tte, iv) {
  if (!iv || iv <= 0 || tte <= 0) return 0;
  const sqrtT = Math.sqrt(tte);
  const d1 = (Math.log(spot / strike) + (0.5 * iv * iv) * tte) / (iv * sqrtT);
  const pdf = Math.exp(-0.5 * d1 * d1) / Math.sqrt(2 * Math.PI);
  return pdf / (spot * iv * sqrtT);
}

function bsPrice(spot, strike, tte, iv, isCall) {
  if (tte <= 0 || iv <= 0) return Math.max(0, isCall ? spot - strike : strike - spot);
  const sqrtT = Math.sqrt(tte);
  const d1 = (Math.log(spot / strike) + 0.5 * iv * iv * tte) / (iv * sqrtT);
  const d2 = d1 - iv * sqrtT;
  const Nd1 = 0.5 * (1 + erf(d1 / Math.SQRT2));
  const Nd2 = 0.5 * (1 + erf(d2 / Math.SQRT2));
  if (isCall) return spot * Nd1 - strike * Nd2;
  return strike * (1 - Nd2) - spot * (1 - Nd1);
}

function erf(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x);
  const t = 1 / (1 + p * x);
  return sign * (1 - (((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t * Math.exp(-x*x));
}

function impliedVol(spot, strike, tte, marketPrice, isCall) {
  let lo = 0.01, hi = 5.0;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const p = bsPrice(spot, strike, tte, mid, isCall);
    if (p > marketPrice) hi = mid; else lo = mid;
    if (hi - lo < 0.001) break;
  }
  return (lo + hi) / 2;
}

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

// Next valid SPY/QQQ expiry AFTER today (Mon/Wed/Fri schedule).
// Used for 1DTE entries at 14:30+ ET to avoid theta decay on 0DTE contracts.
function get1DTEExpiry(ticker) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
  d.setDate(d.getDate() + 1); // start from tomorrow
  if (ticker === 'SPX' || ticker === 'SPXW') {
    // SPXW expires every weekday
    while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  } else {
    // SPY/QQQ: Mon(1), Wed(3), Fri(5)
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
  // Use 'indicative' feed directly — 'opra' requires a paid subscription and
  // always 403s on paper accounts, generating noise on every GEX refresh cycle.
  let chainData;
  try {
    chainData = await withRetry(
      () => client.getOptionChain(underlying, {
        expiration_date: expiry,
        feed: 'indicative',
        totalLimit: 500,
      }),
      `getOptionChain(${underlying}, feed=indicative)`
    );
    if (chainData && chainData.length >= 5) {
      const sample = chainData[0];
      const hasGreeks = !!(sample?.Greeks || sample?.greeks || sample?.ImpliedVolatility);
      log(`GEX ${ticker}: feed=indicative returned ${chainData.length} snaps, hasGreeks=${hasGreeks}`);
    }
  } catch (e) {
    log(`GEX ${ticker}: feed=indicative failed: ${e.message}`, 'WARN');
  }

  if (!chainData || chainData.length < 5) {
    throw new Error(`insufficient chain snapshots: ${chainData?.length || 0}`);
  }

  // Merge: walk the contracts metadata (ground truth) and attach greeks
  // from the matching snapshot symbol, if present.
  // Support both SDK casing: Greeks.gamma (v3) or greeks.gamma
  // Fallback: compute gamma via Black-Scholes from bid/ask mid price
  const snapBySymbol = new Map(chainData.map(s => [s.Symbol || s.symbol, s]));

  const now = new Date();
  const expiryDate = new Date(expiry + 'T16:00:00-04:00');
  const tte = Math.max((expiryDate - now) / (365.25 * 24 * 3600 * 1000), 1 / (365.25 * 24));

  const contracts = [];
  for (const [symbol, meta] of oiMap.entries()) {
    if (!meta.strike || meta.strike <= 0) continue;
    const snap = snapBySymbol.get(symbol);
    const g = snap?.Greeks || snap?.greeks || {};
    let gamma = g.gamma || g.Gamma || 0;
    let vanna = g.vanna || g.Vanna || 0;

    if (gamma === 0 && snap) {
      const q = snap.LatestQuote || snap.latestQuote || {};
      const bid = q.BidPrice || q.bp || q.bid_price || 0;
      const ask = q.AskPrice || q.ap || q.ask_price || 0;
      const mid = (bid + ask) / 2;
      if (mid > 0.01 && spot > 0) {
        const isCall = meta.type === 'call';
        const iv = impliedVol(spot, meta.strike, tte, mid, isCall);
        gamma = bsGamma(spot, meta.strike, tte, iv);
      }
    }

    contracts.push({
      strike_price:  meta.strike,
      type:          meta.type,
      open_interest: meta.open_interest,
      greeks: { gamma, vanna },
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

// Reentrancy guard: without this, an in-flight refresh (slowed by retries on
// a bad network day) can overlap with the next scheduled or stale-triggered
// refresh, doubling API calls to both FlashAlpha and Alpaca and contributing
// to 429s on unrelated calls (e.g. bar fetches) sharing the same rate budget.
let gexRefreshInFlight = null;

async function refreshGEXAll() {
  if (gexRefreshInFlight) {
    log('GEX refresh already in progress — joining existing call instead of starting a new one', 'WARN');
    return gexRefreshInFlight;
  }
  gexRefreshInFlight = doRefreshGEXAll().finally(() => { gexRefreshInFlight = null; });
  return gexRefreshInFlight;
}

async function doRefreshGEXAll() {
  const tickers = ['SPY', 'QQQ', 'SPX'];
  const useFlashAlpha = FlashAlpha.isAvailable();
  if (useFlashAlpha) {
    log(`Refreshing GEX for ${tickers.join(', ')}... source=FlashAlpha→Alpaca (${FlashAlpha.getCallsRemainingToday()} FlashAlpha calls left today)`);
  } else {
    log(`Refreshing GEX for ${tickers.join(', ')}... source=Alpaca only`);
  }

  const sourcesUsed = {};

  for (const ticker of tickers) {
    let result = null;

    // Try FlashAlpha first (production-grade GEX with accurate gamma_flip/walls)
    if (useFlashAlpha) {
      try {
        const expiry = get0DTEExpiry(ticker);
        const knownSpot = await getSpotPrice(ticker).catch(() => null);
        const faResult = await FlashAlpha.fetchGEXForTicker(ticker, expiry, knownSpot);
        if (faResult && faResult.gex && !faResult.gex.degenerate) {
          result = faResult;
          sourcesUsed[ticker] = 'flashalpha';
          log(`GEX ${ticker} [FlashAlpha]: flip=${result.gex.flip} regime=${result.gex.regime} callWall=${result.gex.callWall} putWall=${result.gex.putWall} magnet=${result.gex.zeroDteMagnet}`);
        }
      } catch (e) {
        log(`GEX ${ticker} FlashAlpha failed: ${e.message}`, 'WARN');
      }
    }

    // Fall back to Alpaca self-calc
    if (!result) {
      try {
        result = await fetchGEXForTicker(ticker);
        if (result?.gex) result.gex.source = 'alpaca';
        sourcesUsed[ticker] = 'alpaca';
        if (result?.gex?.degenerate) {
          log(`GEX ${ticker} [Alpaca]: DEGENERATE — ${result.gex.degenerateReason}`, 'WARN');
        } else {
          log(`GEX ${ticker} [Alpaca]: anchor=${result?.gex?.anchor} flip=${result?.gex?.flip} regime=${result?.gex?.regime}`);
        }
      } catch (e) {
        log(`GEX ${ticker} Alpaca failed: ${e.message}`, 'WARN');
      }
    }

    if (result?.gex) {
      state.gexAll[ticker] = result.gex;
      DB.saveGEXSnap(ticker, result.gex, result.spot);
    }

    await sleep(1500);
  }

  // Multi-ticker alignment (video 2: step 6)
  const regimes = tickers.map(t => state.gexAll[t]?.regime).filter(Boolean);
  state.gexAll.multiAligned = regimes.length >= 2 && new Set(regimes).size === 1;
  state.gexAll.lastFetch    = new Date().toISOString();
  state.gexAll.sources      = sourcesUsed; // per-ticker actual source, not just "was attempted"
  state.gexAll.source       = Object.values(sourcesUsed).some(s => s === 'flashalpha') ? 'flashalpha' : 'alpaca';

  const srcStr = tickers.map(t => `${t}:${sourcesUsed[t] || 'none'}`).join(' ');
  log(`GEX complete — SPY:${state.gexAll.SPY?.regime || '?'} QQQ:${state.gexAll.QQQ?.regime || '?'} SPX:${state.gexAll.SPX?.regime || '?'} aligned:${state.gexAll.multiAligned} sources=[${srcStr}]`);
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
// expiryOverride: pass get1DTEExpiry() result for late-session entries to avoid
// theta decay — a 1DTE contract retains meaningful premium overnight.
async function findOption(symbol, direction, expiryOverride) {
  const client = getAlpaca();
  if (!client) return null;
  try {
    const spot   = await getSpotPrice(symbol);
    const expiry = expiryOverride || get0DTEExpiry(symbol);
    // For 1DTE, pick a strike slightly OTM using GEX anchor when available,
    // otherwise ATM. The anchor is the highest-gamma strike — the most likely
    // price magnet by next expiry, so it's a natural target strike.
    const gexAnchor = state.gexAll?.SPY?.anchor;
    const strike = expiryOverride && gexAnchor
      ? (direction === 'CALL'
          ? Math.ceil(Math.max(Math.round(spot), gexAnchor))
          : Math.floor(Math.min(Math.round(spot), gexAnchor)))
      : Math.round(spot);
    const expStr = expiry.replace(/-/g, '').slice(2);  // YYMMDD
    const strStr = (strike * 1000).toString().padStart(8, '0');
    const optType = direction === 'CALL' ? 'C' : 'P';
    const optSymbol = `${symbol}${expStr}${optType}${strStr}`;
    return { symbol: optSymbol, strike, expiry, type: optType, spot, is1DTE: !!expiryOverride };
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
async function placeEntry(signal, signalId, use1DTE = false) {
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

  const expiryOverride = use1DTE ? get1DTEExpiry('SPY') : undefined;
  if (use1DTE) log(`1DTE mode — using expiry ${expiryOverride} (signal at 14:30+ ET, protecting against theta decay)`);
  const opt = await findOption('SPY', signal.direction, expiryOverride);
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

  // Dynamic TP: use FlashAlpha wall levels when available
  // Wall-based TP estimates premium gain from underlying moving to the wall
  // using a rough delta approximation (ATM 0DTE delta ~0.50)
  const gexData = state.gexAll.SPY;
  const targetWall = signal.direction === 'CALL' ? gexData?.callWall || gexData?.wallAbove : gexData?.putWall || gexData?.wallBelow;
  let tp1Price, tp2Price;
  if (targetWall && opt.spot) {
    const underlyingMove = Math.abs(targetWall - opt.spot);
    const estDelta = 0.45;
    const wallPremiumGain = underlyingMove * estDelta;
    // TP1 = 60% of move to wall, TP2 = full wall
    tp1Price = parseFloat((limitPrice + wallPremiumGain * 0.6).toFixed(2));
    tp2Price = parseFloat((limitPrice + wallPremiumGain).toFixed(2));
    // Floor: never below the fixed % targets
    tp1Price = Math.max(tp1Price, parseFloat((limitPrice * (1 + cfg.TP1_PCT)).toFixed(2)));
    tp2Price = Math.max(tp2Price, parseFloat((limitPrice * (1 + cfg.TP2_PCT)).toFixed(2)));
    log(`  ↳ Wall-based TP: wall=${targetWall} move=$${underlyingMove.toFixed(2)} → TP1=$${tp1Price} TP2=$${tp2Price}`);
  } else {
    tp1Price = parseFloat((limitPrice * (1 + cfg.TP1_PCT)).toFixed(2));
    tp2Price = parseFloat((limitPrice * (1 + cfg.TP2_PCT)).toFixed(2));
  }
  const gexTP1 = targetWall || null;
  const zeroDteMagnet = gexData?.zeroDteMagnet || null;

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
      atr: signal.meta.atr, stopPrice: premStop, atrStop, tp1Price, tp2Price, gexTP1, zeroDteMagnet,
      setupType: signal.setup?.type, grade: signal.grade, confidence: signal.confidence,
      setupDesc: signal.setup?.desc, delta: signal.meta.delta,
      deltaMag: signal.meta.deltaMag, hasBShape: signal.meta.hasBShape,
      hasPShape: signal.meta.hasPShape, zoneHit: signal.zoneHit,
      gexRegime: signal.meta.gexRegime, gexFlags: signal.meta.gexFlags,
      tp1Hit: false, status: 'OPEN', entryTime: new Date().toISOString(),
      unrealizedPnL: 0, pnlPct: 0, signalId,
      is1DTE: opt.is1DTE || false,
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
    // 403 = Alpaca rejected the order (contract expired / halted / no longer tradeable).
    // Mark the position as EXPIRED in the DB so it doesn't sit open forever and
    // doesn't get restored as a live position on next startup.
    const isExpired = e.message?.includes('403') || e.message?.toLowerCase().includes('expired');
    if (isExpired) {
      const pnl = (0 - pos.entryPremium) * pos.contracts * 100;
      const label = getExitStrategyLabel('EXPIRED');
      DB.saveTradeExit(pos.clientOrderId, 0, pos.entryPremium, 'EXPIRED', pos.entryTime, pos.contracts, pos.maxPremium, pos.minPremium, label);
      delete state.positions[symbol];
      log(`EXPIRED [${reason}] ${symbol}: wrote DB record — full premium loss $${Math.abs(pnl).toFixed(2)}`, 'WARN');
    }
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
      // 6. 0DTE magnet pin exit — in the last 90 min, if price reached the
      // magnet strike and we're in profit, take it. Price pins near the magnet
      // into close, so further upside is unlikely and theta accelerates.
      if (pos.zeroDteMagnet && pos.pnlPct > 5) {
        const et = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
        const mins = et.getHours() * 60 + et.getMinutes();
        if (mins >= 14 * 60 + 30) { // after 2:30 PM ET
          try {
            const spotNow = await getSpotPrice('SPY');
            const distToMagnet = Math.abs(spotNow - pos.zeroDteMagnet) / spotNow;
            if (distToMagnet < 0.002) { // within 0.2% of magnet
              await closePosition(symbol, 'MAGNET_PIN'); continue;
            }
          } catch (_) {}
        }
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
    let bars5m  = await getBars('SPY', '5Min', 65);

    // Fix 5: on 429 or empty live bars, fall back to DB cache rather than
    // skipping the scan entirely — cached bars are slightly stale but still
    // valid for zone detection and most signal conditions.
    if (!bars5m || bars5m.length < 10) {
      const cached = DB.getRecentBars('SPY', '5Min', 65);
      if (cached && cached.length >= 10) {
        bars5m = cached.map(b => ({ o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume, t: b.ts }));
        log('5m bar fetch failed — using DB cache for this scan', 'WARN');
      } else {
        log('Insufficient 5m bar data (live + cache) — skipping scan', 'WARN'); return;
      }
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

    if (signal.tradeable) {
      // Signals at 14:30 ET or later use 1DTE contracts to avoid theta decay.
      // A 0DTE option entered at 14:30 has ~75 minutes to expiry — near-zero
      // extrinsic value and prone to expiring worthless on any pause in momentum.
      // 1DTE retains meaningful premium overnight and can be managed next session.
      const use1DTE = etH > 14 || (etH === 14 && etM >= 30);
      await placeEntry(signal, signalId, use1DTE);
    }

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
      const syms = Object.keys(state.positions);
      const zeroDTE = syms.filter(s => !state.positions[s].is1DTE);
      const oneDTE  = syms.filter(s =>  state.positions[s].is1DTE);
      if (zeroDTE.length) {
        log(`FORCE CLOSE ${zeroDTE.length} 0DTE position(s) at ${state.config.FORCE_CLOSE_ET} ET`);
        zeroDTE.forEach(sym => closePosition(sym, 'FORCE_CLOSE_EOD'));
      }
      if (oneDTE.length) {
        log(`Skipping FORCE CLOSE for ${oneDTE.length} 1DTE position(s) — they expire tomorrow: ${oneDTE.join(', ')}`);
      }
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
app.get('/api/signals',        (req, res) => res.json(DB.getRecentSignals(parseInt(req.query.limit) || 50)));
app.get('/api/stats',          (req, res) => res.json({ summary: DB.getStats(), bySetup: DB.getSetupBreakdown(), daily: DB.getDailyStats(30) }));
app.get('/api/gex-history',    (req, res) => res.json(DB.getGEXHistory(req.query.ticker || 'SPY', 48)));
app.get('/api/bars', async (req, res) => {
  const ticker    = req.query.ticker || 'SPY';
  const timeframe = req.query.timeframe || '5Min';
  const limit     = parseInt(req.query.limit) || 100;
  let bars = DB.getRecentBars(ticker, timeframe, limit);
  // Cache only fills during live scans (market hours). Right after a deploy,
  // on weekends, or pre-market, fall back to a direct live fetch so the chart
  // isn't empty. Unlike the shared getBars() used by the live scan loop
  // (which omits start/end and can return zero rows pre-market since it has
  // no completed "today" session to anchor to), this explicitly requests the
  // last 5 calendar days so it always lands on the most recent session.
  if (!bars.length) {
    try {
      const client = getAlpaca();
      if (client) {
        const end = new Date();
        const start = new Date(end.getTime() - 5 * 24 * 60 * 60 * 1000);
        const resp = client.getBarsV2(ticker, {
          timeframe, limit, feed: 'iex', adjustment: 'raw',
          start: start.toISOString(), end: end.toISOString(),
        });
        const live = [];
        for await (const b of resp) {
          live.push({ ts: b.Timestamp, open: b.OpenPrice, high: b.HighPrice, low: b.LowPrice, close: b.ClosePrice, volume: b.Volume });
        }
        bars = live.slice(-limit);
        if (bars.length) DB.saveBars(bars.map(b => ({ t: b.ts, o: b.open, h: b.high, l: b.low, c: b.close, v: b.volume })), ticker, timeframe);
      }
    } catch (e) {
      log(`/api/bars live fallback failed: ${e.message}`, 'WARN');
      bars = [];
    }
  }
  res.json(bars);
});

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

// ─── BACKTEST ─────────────────────────────────────────────────────────────────
const { runBacktest, generateReport } = require('./backtest');

app.get('/api/backtest', async (req, res) => {
  try {
    const opts = {
      days:           parseInt(req.query.days) || 20,
      minConfidence:  parseInt(req.query.minConfidence) || 55,
      premiumStopPct: parseFloat(req.query.premiumStopPct) || 0.45,
      tp1Pct:         parseFloat(req.query.tp1Pct) || 0.50,
      tp2Pct:         parseFloat(req.query.tp2Pct) || 1.00,
      riskDollars:    parseInt(req.query.riskDollars) || 300,
    };
    log(`Backtest started: ${JSON.stringify(opts)}`);
    const results = await runBacktest(opts);
    log(`Backtest done: ${results.summary.totalTrades} trades, P/L: $${results.summary.totalPnl.toFixed(0)}, WR: ${results.summary.winRate}%`);
    res.json(results);
  } catch (e) {
    log(`Backtest error: ${e.message}`, 'ERROR');
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/backtest/report', async (req, res) => {
  try {
    const opts = {
      days:           parseInt(req.query.days) || 20,
      minConfidence:  parseInt(req.query.minConfidence) || 55,
      premiumStopPct: parseFloat(req.query.premiumStopPct) || 0.45,
      tp1Pct:         parseFloat(req.query.tp1Pct) || 0.50,
      tp2Pct:         parseFloat(req.query.tp2Pct) || 1.00,
      riskDollars:    parseInt(req.query.riskDollars) || 300,
    };
    const results = await runBacktest(opts);
    const html = generateReport(results);
    res.type('html').send(html);
  } catch (e) {
    res.status(500).send(`<h1>Backtest Error</h1><pre>${e.message}</pre>`);
  }
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

  // Restore any open positions from the DB into in-memory state.
  // Without this, a redeploy during a live trade orphans the position —
  // the DB still shows it OPEN but the monitor loop never sees it.
  const todayET = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })).toISOString().split('T')[0];
  const openTrades = DB.getOpenTrades();
  if (openTrades.length) {
    openTrades.forEach(t => {
      // Any position whose option already expired should be marked EXPIRED in DB
      // and NOT restored to the live monitor — it can't be closed or priced.
      if (t.expiry && t.expiry < todayET) {
        const pnl = (0 - t.premium) * t.contracts * 100;
        const label = getExitStrategyLabel('EXPIRED');
        DB.saveTradeExit(t.trade_id, 0, t.premium, 'EXPIRED', t.ts, t.contracts, t.max_premium || t.premium, t.min_premium || t.premium, label);
        log(`Startup: marked expired position ${t.option_symbol} (expiry ${t.expiry}) as EXPIRED — $${Math.abs(pnl).toFixed(2)} loss`, 'WARN');
        return;
      }
      state.positions[t.option_symbol] = {
        id: t.trade_id, clientOrderId: t.trade_id,
        symbol: t.option_symbol, underlying: 'SPY',
        direction: t.direction, contracts: t.contracts,
        entryPremium: t.premium, currentPrice: t.premium,
        strike: t.strike, expiry: t.expiry, spot: t.spot_at_entry,
        stopPrice: t.stop_price, atrStop: t.atr_stop,
        tp1Price: t.tp1_price, tp2Price: t.tp2_price,
        gexTP1: t.gex_tp1, zeroDteMagnet: null,
        setupType: t.setup_type, grade: t.grade, confidence: t.confidence,
        setupDesc: t.setup_desc, delta: t.delta,
        gexRegime: t.gex_regime, gexFlags: JSON.parse(t.gex_flags || '[]'),
        tp1Hit: false, status: 'OPEN', entryTime: t.ts,
        unrealizedPnL: 0, pnlPct: 0, signalId: t.signal_id,
        maxPremium: t.max_premium || t.premium,
        minPremium: t.min_premium || t.premium,
        confluenceSummary: t.confluence_summary || '',
        is1DTE: t.expiry > todayET,
        restoredFromDB: true,
      };
    });
    log(`Restored ${openTrades.length} open position(s) from DB: ${openTrades.map(t=>t.option_symbol).join(', ')}`);
  }

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
