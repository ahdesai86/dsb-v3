// ─── FLASHALPHA API CLIENT ───────────────────────────────────────────────────
// Provides production-grade GEX levels, greeks, and exposure data.
// Free tier: 5 requests/day — cache aggressively.
// Basic tier ($63/mo): 100/day — refresh every 30 min across 3 tickers.
//
// Base URL: https://lab.flashalpha.com
// Auth: X-Api-Key header
// Docs: https://flashalpha.com/docs/api

const https = require('https');

const BASE_URL = 'https://lab.flashalpha.com';
const API_KEY = process.env.FLASHALPHA_API_KEY || '';
// Free tier = 5 req/day. Set FLASHALPHA_DAILY_LIMIT env var higher if on a paid tier.
const DAILY_LIMIT = parseInt(process.env.FLASHALPHA_DAILY_LIMIT, 10) || 5;

const cache = {};
const DEFAULT_CACHE_TTL_MS = 25 * 60 * 1000; // 25 min (inside a 30-min GEX refresh cycle)

// ─── DAILY CALL BUDGET ────────────────────────────────────────────────────────
// Free tier allows only 5 req/day total. Without a local guard, every refresh
// cycle (every ~30 min during market hours) keeps hitting the API and burning
// through 429s for the rest of the day after the budget is gone — wasted
// latency and noisy logs. Track usage locally and short-circuit once the
// budget is spent, so callers fall back to Alpaca immediately instead of
// waiting on a doomed HTTP round-trip.
let callCount = 0;
let budgetResetDay = null;
let budgetWarned = false;

function currentETDay() {
  return new Date().toLocaleString('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
}

function checkBudget() {
  const today = currentETDay();
  if (budgetResetDay !== today) {
    budgetResetDay = today;
    callCount = 0;
    budgetWarned = false;
  }
  if (callCount >= DAILY_LIMIT) {
    if (!budgetWarned) {
      log(`Daily call budget (${DAILY_LIMIT}) reached — falling back to Alpaca for the rest of ${today} ET. Set FLASHALPHA_DAILY_LIMIT or upgrade tier to raise this.`, 'WARN');
      budgetWarned = true;
    }
    return false;
  }
  return true;
}

// External logger hook — server.js calls setExternalLogger(log) at startup so
// FlashAlpha activity (especially failures) shows up in the dashboard's
// /api/logs feed instead of only the raw Railway console, which nobody but
// this process can see in real time.
let externalLogger = null;
function setExternalLogger(fn) { externalLogger = fn; }

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [FlashAlpha] ${msg}`);
  if (externalLogger) externalLogger(`[FlashAlpha] ${msg}`, level);
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) return reject(new Error('FLASHALPHA_API_KEY not set'));
    if (!checkBudget()) return reject(new Error(`daily call budget (${DAILY_LIMIT}) exhausted`));
    callCount++;
    const url = `${BASE_URL}${path}`;
    const opts = {
      headers: { 'X-Api-Key': API_KEY, 'Accept': 'application/json' },
    };
    https.get(url, opts, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 429) {
          return reject(new Error(`rate limited (429) — ${res.headers['retry-after'] || 'unknown'}`));
        }
        if (res.statusCode === 403) {
          return reject(new Error(`HTTP 403 — endpoint requires a higher plan tier: ${body.slice(0, 150)}`));
        }
        if (res.statusCode !== 200) {
          return reject(new Error(`HTTP ${res.statusCode}: ${body.slice(0, 200)}`));
        }
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error(`JSON parse: ${e.message}`)); }
      });
      res.on('error', reject);
    }).on('error', reject);
  });
}

function getCached(key, ttlMs = DEFAULT_CACHE_TTL_MS) {
  const entry = cache[key];
  if (!entry) return null;
  if (Date.now() - entry.ts > ttlMs) { delete cache[key]; return null; }
  return entry.data;
}

function setCache(key, data) {
  cache[key] = { data, ts: Date.now() };
}

// ─── KEY LEVELS (Free tier) ──────────────────────────────────────────────────
// Returns: gamma_flip, call_wall, put_wall, max_positive_gamma,
//          max_negative_gamma, highest_oi_strike, zero_dte_magnet
async function getLevels(symbol) {
  const cacheKey = `levels:${symbol}`;
  const cached = getCached(cacheKey);
  if (cached) { log(`levels ${symbol}: cache hit`); return cached; }

  const data = await httpGet(`/v1/exposure/levels/${symbol}`);
  setCache(cacheKey, data);
  if (data.gamma_flip == null) {
    // Unexpected shape — dump top-level keys (and one level deep if nested)
    // so we can see how the real payload differs from the documented schema
    // instead of guessing blind.
    log(`levels ${symbol}: unexpected shape, keys=[${Object.keys(data).join(',')}] raw=${JSON.stringify(data).slice(0, 400)}`, 'WARN');
  } else {
    log(`levels ${symbol}: flip=${data.gamma_flip} callWall=${data.call_wall} putWall=${data.put_wall} magnet=${data.zero_dte_magnet}`);
  }
  return data;
}

// ─── GEX BY STRIKE (Free tier with single expiry) ───────────────────────────
// Returns: symbol, underlying_price, gamma_flip, net_gex, net_gex_label,
//          strikes[] with per-strike call/put GEX, OI, volume, OI changes
async function getGEX(symbol, expiration) {
  const cacheKey = `gex:${symbol}:${expiration || 'all'}`;
  const cached = getCached(cacheKey);
  if (cached) { log(`gex ${symbol}: cache hit`); return cached; }

  let path = `/v1/exposure/gex/${symbol}`;
  if (expiration) path += `?expiration=${expiration}`;
  const data = await httpGet(path);
  setCache(cacheKey, data);
  log(`gex ${symbol}: net=${data.net_gex_label} flip=${data.gamma_flip} strikes=${data.strikes?.length}`);
  return data;
}

// ─── VIX STATE (Free tier) ──────────────────────────────────────────────────
async function getVIXState() {
  const cached = getCached('vix');
  if (cached) return cached;

  const data = await httpGet('/v1/macro/vix-state');
  setCache('vix', data);
  return data;
}

// ─── STOCK QUOTE (Free tier) ────────────────────────────────────────────────
async function getQuote(ticker) {
  const cached = getCached(`quote:${ticker}`, 60 * 1000); // 1 min cache
  if (cached) return cached;

  const data = await httpGet(`/stockquote/${ticker}`);
  setCache(`quote:${ticker}`, data);
  return data;
}

// ─── CONVERT FLASHALPHA LEVELS TO DSB GEX FORMAT ─────────────────────────────
// Bridges FlashAlpha's levels response into the format that strategy.js expects,
// so the rest of the codebase doesn't need to know the data source.
// `spot` is used to derive regime from flip distance when the full GEX chain
// (net_gex_label) wasn't fetched — on free tier that's the common case, since
// the GEX chain endpoint requires Basic+ for ETFs/indexes.
function levelsToGEXFormat(levels, gexData, spot) {
  let isPositive;
  if (gexData?.net_gex_label) {
    isPositive = gexData.net_gex_label === 'positive' || (gexData.net_gex || 0) > 0;
  } else if (spot != null && levels.gamma_flip != null) {
    // Video 2 convention: above flip = dealers long gamma = controlled/positive.
    isPositive = spot > levels.gamma_flip;
  } else {
    isPositive = true; // neutral default, avoids false EXPANSIVE bias
  }
  const netGex = gexData?.net_gex || 0;
  const regime = isPositive ? 'CONTROLLED' : 'EXPANSIVE';

  // Find walls from GEX strike data if available
  let wallAbove = levels.call_wall || null;
  let wallBelow = levels.put_wall || null;

  // Concentration: ratio of top-2 strikes' GEX to total
  let concentration = 0.5; // default moderate
  if (gexData?.strikes?.length > 0) {
    const sorted = [...gexData.strikes].sort((a, b) => Math.abs(b.net_gex) - Math.abs(a.net_gex));
    const totalAbs = sorted.reduce((s, st) => s + Math.abs(st.net_gex), 0);
    if (totalAbs > 0 && sorted.length >= 2) {
      concentration = (Math.abs(sorted[0].net_gex) + Math.abs(sorted[1].net_gex)) / totalAbs;
    }
  }

  return {
    totalGEX: netGex,
    totalVEX: 0,
    isPositiveGEX: isPositive,
    regime,
    gexVexAgreement: true, // FlashAlpha data is authoritative
    concentration,
    anchor: levels.max_positive_gamma || levels.highest_oi_strike || null,
    flip: levels.gamma_flip || null,
    wallAbove,
    wallBelow,
    walls: [wallAbove, wallBelow].filter(Boolean),
    zeroDteMagnet: levels.zero_dte_magnet || null,
    maxPain: levels.highest_oi_strike || null,
    callWall: levels.call_wall || null,
    putWall: levels.put_wall || null,
    degenerate: false,
    source: 'flashalpha',
  };
}

// ─── FETCH FULL GEX FOR TICKER (primary entry point) ────────────────────────
// Free tier is 5 req/day total, so this makes exactly ONE call (levels only)
// per ticker instead of two (levels + full GEX chain) — the GEX strike chain
// also requires Basic+ tier for ETFs/indexes (SPY/QQQ/SPX), so calling it on
// free tier was burning budget on a request that would 403 anyway.
// `knownSpot` (optional) lets the caller pass a spot price it already fetched
// elsewhere (e.g. from Alpaca) so regime can be derived without an extra call.
// Throws on failure — caller is responsible for catching and falling back.
async function fetchGEXForTicker(ticker, expiration, knownSpot) {
  const levels = await getLevels(ticker);
  if (!levels || !levels.gamma_flip) {
    throw new Error(`${ticker}: no levels data in response`);
  }

  // Optional: try the full GEX chain for per-strike concentration data, but
  // only if budget allows — never let this block the primary levels result.
  let gexData = null;
  if (checkBudget()) {
    gexData = await getGEX(ticker, expiration).catch(() => null);
  }

  const spot = gexData?.underlying_price || knownSpot || null;
  const gex = levelsToGEXFormat(levels, gexData, spot);
  return { gex, spot, levels };
}

function isAvailable() {
  return !!API_KEY;
}

function getCallsRemainingToday() {
  checkBudget(); // ensures the day-rollover check runs even if no call has happened yet today
  return Math.max(0, DAILY_LIMIT - callCount);
}

module.exports = {
  fetchGEXForTicker,
  getLevels,
  getGEX,
  getVIXState,
  getQuote,
  levelsToGEXFormat,
  isAvailable,
  setExternalLogger,
  getCallsRemainingToday,
};
