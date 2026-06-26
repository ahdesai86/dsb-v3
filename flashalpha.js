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

const cache = {};
const DEFAULT_CACHE_TTL_MS = 25 * 60 * 1000; // 25 min (inside a 30-min GEX refresh cycle)

function log(msg, level = 'INFO') {
  const ts = new Date().toISOString();
  console.log(`[${ts}] [${level}] [FlashAlpha] ${msg}`);
}

function httpGet(path) {
  return new Promise((resolve, reject) => {
    if (!API_KEY) return reject(new Error('FLASHALPHA_API_KEY not set'));
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
  log(`levels ${symbol}: flip=${data.gamma_flip} callWall=${data.call_wall} putWall=${data.put_wall} magnet=${data.zero_dte_magnet}`);
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
function levelsToGEXFormat(levels, gexData) {
  const netGex = gexData?.net_gex || 0;
  const isPositive = (gexData?.net_gex_label === 'positive') || netGex > 0;
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
// Fetches both levels and GEX strike data, merges into DSB format.
// If FlashAlpha fails, returns null (caller should fall back to Alpaca).
async function fetchGEXForTicker(ticker, expiration) {
  try {
    const [levels, gexData] = await Promise.all([
      getLevels(ticker),
      getGEX(ticker, expiration).catch(() => null),
    ]);
    if (!levels || !levels.gamma_flip) {
      log(`${ticker}: no levels data`, 'WARN');
      return null;
    }
    const gex = levelsToGEXFormat(levels, gexData);
    const spot = gexData?.underlying_price || null;
    return { gex, spot, levels };
  } catch (e) {
    log(`${ticker}: ${e.message}`, 'WARN');
    return null;
  }
}

function isAvailable() {
  return !!API_KEY;
}

module.exports = {
  fetchGEXForTicker,
  getLevels,
  getGEX,
  getVIXState,
  getQuote,
  levelsToGEXFormat,
  isAvailable,
};
