'use strict';
/**
 * db.js — SQLite persistence layer (crash-proof)
 *
 * Tables:
 *   signals   — every evaluated signal with all scores (even rejected ones)
 *   trades    — every entry and exit with full metadata
 *   gex_snaps — GEX snapshot per refresh for SPY, QQQ, SPX
 *   bars      — recent OHLCV bar cache for replay and data mining
 *
 * CRITICAL FIX: better-sqlite3 requires native compilation (node-gyp).
 * If that build fails on the deploy host — missing build tools, ABI
 * mismatch, read-only filesystem, etc. — requiring this module used to
 * throw at import time and crash the ENTIRE process before server.js
 * could start listening on its port. Railway would then report the
 * service as "crashed" with no useful application logs.
 *
 * Now: every failure point (require, file open, schema exec, each
 * prepared statement, every exported function) is wrapped so a broken
 * DB degrades to "no persistence" instead of killing the trading engine.
 * The bot will keep scanning, signaling, and trading — it just won't
 * log to SQLite until the underlying issue is fixed.
 */

const path = require('path');
const fs   = require('fs');

let Database    = null;
let dbAvailable = false;

try {
  Database = require('better-sqlite3');
  dbAvailable = true;
} catch (e) {
  console.error('[DB] better-sqlite3 require() failed — persistence disabled:', e.message);
}

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'dsb.db');
let db = null;

if (dbAvailable) {
  try {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    db = new Database(DB_PATH);
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = NORMAL');
    db.pragma('cache_size = -16000');
    console.log(`[DB] SQLite ready at ${DB_PATH}`);
  } catch (e) {
    console.error('[DB] Failed to open database file — persistence disabled:', e.message);
    db = null;
    dbAvailable = false;
  }
}

// ─── SCHEMA (only runs if db opened successfully) ────────────────────────────
if (db) {
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS signals (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        ts            TEXT    NOT NULL,
        ticker        TEXT    NOT NULL DEFAULT 'SPY',
        direction     TEXT    NOT NULL,
        confidence    REAL    NOT NULL DEFAULT 0,
        grade         TEXT,
        tradeable     INTEGER NOT NULL DEFAULT 0,
        setup_type    TEXT,
        setup_desc    TEXT,
        delta         REAL,
        delta_mag     REAL,
        has_bshape    INTEGER DEFAULT 0,
        has_pshape    INTEGER DEFAULT 0,
        zone_type     TEXT,
        zone_top      REAL,
        zone_bottom   REAL,
        last_price    REAL,
        atr           REAL,
        session_vwap  REAL,
        prior_day_close REAL,
        ema9          REAL,
        ema21         REAL,
        gex_regime    TEXT,
        gex_anchor    REAL,
        gex_flip      REAL,
        gex_wall_above REAL,
        gex_wall_below REAL,
        gex_score     REAL,
        gex_flags     TEXT,
        addl_score    REAL,
        reject_reasons TEXT,
        spy_regime    TEXT,
        qqq_regime    TEXT,
        spx_regime    TEXT,
        multi_aligned INTEGER DEFAULT 0,
        raw_signal    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_signals_ts        ON signals(ts);
      CREATE INDEX IF NOT EXISTS idx_signals_direction ON signals(direction);
      CREATE INDEX IF NOT EXISTS idx_signals_grade     ON signals(grade);
      CREATE INDEX IF NOT EXISTS idx_signals_tradeable ON signals(tradeable);

      CREATE TABLE IF NOT EXISTS trades (
        id              INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id        TEXT    UNIQUE NOT NULL,
        ts              TEXT    NOT NULL,
        event           TEXT    NOT NULL,
        ticker          TEXT    NOT NULL DEFAULT 'SPY',
        option_symbol   TEXT,
        direction       TEXT    NOT NULL,
        contracts       INTEGER NOT NULL DEFAULT 1,
        strike          REAL,
        expiry          TEXT,
        spot_at_entry   REAL,
        premium         REAL,
        limit_price     REAL,
        stop_price      REAL,
        atr_stop        REAL,
        tp1_price       REAL,
        tp2_price       REAL,
        gex_tp1         REAL,
        grade           TEXT,
        confidence      REAL,
        setup_type      TEXT,
        setup_desc      TEXT,
        delta           REAL,
        has_bshape      INTEGER DEFAULT 0,
        has_pshape      INTEGER DEFAULT 0,
        zone_type       TEXT,
        gex_regime      TEXT,
        gex_flags       TEXT,
        exit_ts         TEXT,
        exit_price      REAL,
        exit_reason     TEXT,
        exit_strategy_label TEXT,  -- plain-English exit explanation (e.g. 'Take-profit 1...')
        pnl             REAL,
        pnl_pct         REAL,
        hold_minutes    REAL,
        max_premium     REAL,   -- highest option premium observed while held
        min_premium     REAL,   -- lowest option premium observed while held
        confluence_summary TEXT, -- plain-English WHY this trade fired (zone + setup + confluence factors)
        status          TEXT    DEFAULT 'PENDING',
        signal_id       INTEGER,
        FOREIGN KEY (signal_id) REFERENCES signals(id)
      );
      CREATE INDEX IF NOT EXISTS idx_trades_ts        ON trades(ts);
      CREATE INDEX IF NOT EXISTS idx_trades_direction ON trades(direction);
      CREATE INDEX IF NOT EXISTS idx_trades_grade     ON trades(grade);
      CREATE INDEX IF NOT EXISTS idx_trades_setup     ON trades(setup_type);
      CREATE INDEX IF NOT EXISTS idx_trades_status    ON trades(status);

      CREATE TABLE IF NOT EXISTS gex_snaps (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        ts          TEXT    NOT NULL,
        ticker      TEXT    NOT NULL,
        spot        REAL,
        anchor      REAL,
        flip        REAL,
        wall_above  REAL,
        wall_below  REAL,
        regime      TEXT,
        total_gex   REAL,
        total_vex   REAL,
        gex_vex_agree INTEGER DEFAULT 0,
        concentration REAL,
        walls_json  TEXT,
        raw_json    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_gex_ts     ON gex_snaps(ts);
      CREATE INDEX IF NOT EXISTS idx_gex_ticker ON gex_snaps(ticker);

      CREATE TABLE IF NOT EXISTS bars (
        id        INTEGER PRIMARY KEY AUTOINCREMENT,
        ts        TEXT NOT NULL,
        ticker    TEXT NOT NULL,
        timeframe TEXT NOT NULL,
        open      REAL,
        high      REAL,
        low       REAL,
        close     REAL,
        volume    REAL,
        UNIQUE(ts, ticker, timeframe)
      );
      CREATE INDEX IF NOT EXISTS idx_bars_ts     ON bars(ts);
      CREATE INDEX IF NOT EXISTS idx_bars_ticker ON bars(ticker, timeframe);
    `);
  } catch (e) {
    console.error('[DB] Schema creation failed — persistence disabled:', e.message);
    db = null;
    dbAvailable = false;
  }
}

// ─── PREPARED STATEMENTS (only created if db is healthy) ─────────────────────
let stmts = {};

if (db) {
  try {
    stmts.insertSignal = db.prepare(`
      INSERT INTO signals (
        ts, ticker, direction, confidence, grade, tradeable,
        setup_type, setup_desc, delta, delta_mag, has_bshape, has_pshape,
        zone_type, zone_top, zone_bottom, last_price, atr,
        session_vwap, prior_day_close, ema9, ema21,
        gex_regime, gex_anchor, gex_flip, gex_wall_above, gex_wall_below,
        gex_score, gex_flags, addl_score, reject_reasons,
        spy_regime, qqq_regime, spx_regime, multi_aligned, raw_signal
      ) VALUES (
        @ts, @ticker, @direction, @confidence, @grade, @tradeable,
        @setup_type, @setup_desc, @delta, @delta_mag, @has_bshape, @has_pshape,
        @zone_type, @zone_top, @zone_bottom, @last_price, @atr,
        @session_vwap, @prior_day_close, @ema9, @ema21,
        @gex_regime, @gex_anchor, @gex_flip, @gex_wall_above, @gex_wall_below,
        @gex_score, @gex_flags, @addl_score, @reject_reasons,
        @spy_regime, @qqq_regime, @spx_regime, @multi_aligned, @raw_signal
      )
    `);

    stmts.insertTrade = db.prepare(`
      INSERT OR REPLACE INTO trades (
        trade_id, ts, event, ticker, option_symbol, direction, contracts,
        strike, expiry, spot_at_entry, premium, limit_price, stop_price,
        atr_stop, tp1_price, tp2_price, gex_tp1, grade, confidence,
        setup_type, setup_desc, delta, has_bshape, has_pshape,
        zone_type, gex_regime, gex_flags, status, signal_id,
        max_premium, min_premium, confluence_summary
      ) VALUES (
        @trade_id, @ts, @event, @ticker, @option_symbol, @direction, @contracts,
        @strike, @expiry, @spot_at_entry, @premium, @limit_price, @stop_price,
        @atr_stop, @tp1_price, @tp2_price, @gex_tp1, @grade, @confidence,
        @setup_type, @setup_desc, @delta, @has_bshape, @has_pshape,
        @zone_type, @gex_regime, @gex_flags, @status, @signal_id,
        @max_premium, @min_premium, @confluence_summary
      )
    `);

    // Updates the running watermark on an OPEN trade row without touching
    // exit fields — called on every 1-min position poll, not just on close.
    stmts.updateTradeWatermark = db.prepare(`
      UPDATE trades SET max_premium = @max_premium, min_premium = @min_premium
      WHERE trade_id = @trade_id
    `);

    stmts.updateTradeExit = db.prepare(`
      UPDATE trades SET
        exit_ts             = @exit_ts,
        exit_price          = @exit_price,
        exit_reason         = @exit_reason,
        exit_strategy_label = @exit_strategy_label,
        pnl                 = @pnl,
        pnl_pct             = @pnl_pct,
        hold_minutes        = @hold_minutes,
        max_premium         = @max_premium,
        min_premium         = @min_premium,
        status              = 'CLOSED'
      WHERE trade_id = @trade_id
    `);

    stmts.insertGEX = db.prepare(`
      INSERT INTO gex_snaps (
        ts, ticker, spot, anchor, flip, wall_above, wall_below,
        regime, total_gex, total_vex, gex_vex_agree, concentration,
        walls_json, raw_json
      ) VALUES (
        @ts, @ticker, @spot, @anchor, @flip, @wall_above, @wall_below,
        @regime, @total_gex, @total_vex, @gex_vex_agree, @concentration,
        @walls_json, @raw_json
      )
    `);

    stmts.insertBar = db.prepare(`
      INSERT OR IGNORE INTO bars (ts, ticker, timeframe, open, high, low, close, volume)
      VALUES (@ts, @ticker, @timeframe, @open, @high, @low, @close, @volume)
    `);

    stmts.insertBarBatch = db.transaction((bars, ticker, timeframe) => {
      for (const b of bars) {
        stmts.insertBar.run({ ts: b.t, ticker, timeframe, open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v });
      }
    });
  } catch (e) {
    console.error('[DB] Prepared statement creation failed — persistence disabled:', e.message);
    db = null;
    dbAvailable = false;
    stmts = {};
  }
}

// ─── SAFE WRAPPER — every exported function goes through this ───────────────
// If db is unavailable, functions become no-ops (writes) or return empty
// defaults (reads) instead of throwing and taking down the trading loop.
function safe(fn, fallback) {
  return (...args) => {
    if (!dbAvailable || !db) return fallback;
    try {
      return fn(...args);
    } catch (e) {
      console.error('[DB] operation failed:', e.message);
      return fallback;
    }
  };
}

// ─── SIGNAL OPERATIONS ────────────────────────────────────────────────────────

const saveSignal = safe((signal, gexAll) => {
  const m     = signal.meta || {};
  const z     = signal.zoneHit || {};
  const gex   = signal.gexAnalysis || {};
  const addl  = signal.addlConf || {};
  const multi = gexAll?.multiAligned || false;

  const row = {
    ts:              signal.timestamp,
    ticker:          'SPY',
    direction:       signal.direction,
    confidence:      signal.confidence,
    grade:           signal.grade || null,
    tradeable:       signal.tradeable ? 1 : 0,
    setup_type:      signal.setup?.type || null,
    setup_desc:      signal.setup?.desc || null,
    delta:           m.delta ?? null,
    delta_mag:       m.deltaMag ?? null,
    has_bshape:      m.hasBShape ? 1 : 0,
    has_pshape:      m.hasPShape ? 1 : 0,
    zone_type:       z.type || null,
    zone_top:        z.zone?.top || null,
    zone_bottom:     z.zone?.bottom || null,
    last_price:      m.lastPrice || null,
    atr:             m.atr || null,
    session_vwap:    m.sessionVWAP || null,
    prior_day_close: m.priorDayClose || null,
    ema9:            m.ema9 || null,
    ema21:           m.ema21 || null,
    gex_regime:      m.gexRegime || null,
    gex_anchor:      m.anchor || null,
    gex_flip:        m.flip || null,
    gex_wall_above:  m.wallAbove || null,
    gex_wall_below:  m.wallBelow || null,
    gex_score:       gex.score || null,
    gex_flags:       JSON.stringify(m.gexFlags || []),
    addl_score:      addl.score || null,
    reject_reasons:  JSON.stringify(signal.rejectReasons || []),
    spy_regime:      gexAll?.SPY?.regime || null,
    qqq_regime:      gexAll?.QQQ?.regime || null,
    spx_regime:      gexAll?.SPX?.regime || null,
    multi_aligned:   multi ? 1 : 0,
    raw_signal:      JSON.stringify(signal),
  };

  const result = stmts.insertSignal.run(row);
  return result.lastInsertRowid;
}, null);

// ─── TRADE OPERATIONS ─────────────────────────────────────────────────────────

const saveTradeEntry = safe((pos, signalId) => {
  stmts.insertTrade.run({
    trade_id:      pos.clientOrderId,
    ts:            pos.entryTime,
    event:         'ENTRY',
    ticker:        'SPY',
    option_symbol: pos.symbol,
    direction:     pos.direction,
    contracts:     pos.contracts,
    strike:        pos.strike,
    expiry:        pos.expiry,
    spot_at_entry: pos.spot,
    premium:       pos.entryPremium,
    limit_price:   pos.entryPremium,
    stop_price:    pos.stopPrice,
    atr_stop:      pos.atrStop,
    tp1_price:     pos.tp1Price,
    tp2_price:     pos.tp2Price,
    gex_tp1:       pos.gexTP1 || null,
    grade:         pos.grade,
    confidence:    pos.confidence,
    setup_type:    pos.setupType,
    setup_desc:    pos.setupDesc || null,
    delta:         pos.delta || null,
    has_bshape:    pos.hasBShape ? 1 : 0,
    has_pshape:    pos.hasPShape ? 1 : 0,
    zone_type:     pos.zoneHit?.type || null,
    gex_regime:    pos.gexRegime || null,
    gex_flags:     JSON.stringify(pos.gexFlags || []),
    status:        'OPEN',
    signal_id:     signalId || null,
    max_premium:   pos.maxPremium ?? pos.entryPremium,
    min_premium:   pos.minPremium ?? pos.entryPremium,
    confluence_summary: pos.confluenceSummary || pos.setupDesc || null,
  });
}, undefined);

// Called every 1-min position poll to persist the running high/low so it
// survives a server restart while the position is still open.
const updateTradeWatermark = safe((tradeId, maxPremium, minPremium) => {
  stmts.updateTradeWatermark.run({
    trade_id:    tradeId,
    max_premium: maxPremium,
    min_premium: minPremium,
  });
}, undefined);

const saveTradeExit = safe((tradeId, exitPrice, entryPrice, reason, entryTime, contracts, maxPremium, minPremium, exitStrategyLabel) => {
  const pnl      = (exitPrice - entryPrice) * contracts * 100;
  const pnlPct   = ((exitPrice - entryPrice) / entryPrice) * 100;
  const holdMins = (Date.now() - new Date(entryTime).getTime()) / 60000;
  stmts.updateTradeExit.run({
    trade_id:            tradeId,
    exit_ts:             new Date().toISOString(),
    exit_price:          exitPrice,
    exit_reason:         reason,
    exit_strategy_label: exitStrategyLabel || reason || null,
    pnl,
    pnl_pct:      pnlPct,
    hold_minutes: holdMins,
    max_premium:  Math.max(maxPremium ?? exitPrice, exitPrice),
    min_premium:  Math.min(minPremium ?? exitPrice, exitPrice),
  });
}, undefined);

// ─── GEX SNAPSHOT ─────────────────────────────────────────────────────────────

const saveGEXSnap = safe((ticker, gex, spot) => {
  if (!gex) return;
  stmts.insertGEX.run({
    ts:            new Date().toISOString(),
    ticker,
    spot:          spot || null,
    anchor:        gex.anchor || null,
    flip:          gex.flip || null,
    wall_above:    gex.wallAbove || null,
    wall_below:    gex.wallBelow || null,
    regime:        gex.regime || null,
    total_gex:     gex.totalGEX || null,
    total_vex:     gex.totalVEX || null,
    gex_vex_agree: gex.gexVexAgreement ? 1 : 0,
    concentration: gex.concentration || null,
    walls_json:    JSON.stringify(gex.walls?.slice(0, 6) || []),
    raw_json:      JSON.stringify(gex),
  });
}, undefined);

// ─── BAR CACHE ────────────────────────────────────────────────────────────────

const saveBars = safe((bars, ticker, timeframe) => {
  stmts.insertBarBatch(bars, ticker, timeframe);
  db.prepare(`
    DELETE FROM bars WHERE ticker = ? AND timeframe = ? AND ts < datetime('now', '-5 days')
  `).run(ticker, timeframe);
}, undefined);

// ─── QUERY HELPERS ────────────────────────────────────────────────────────────

const getRecentSignals = safe(
  (limit = 50) => db.prepare(`SELECT * FROM signals ORDER BY ts DESC LIMIT ?`).all(limit),
  []
);

const getRecentTrades = safe(
  (limit = 100) => db.prepare(`SELECT * FROM trades ORDER BY ts DESC LIMIT ?`).all(limit),
  []
);

const getOpenTrades = safe(
  () => db.prepare(`SELECT * FROM trades WHERE status = 'OPEN' ORDER BY ts DESC`).all(),
  []
);

const getStats = safe(
  () => db.prepare(`
    SELECT
      COUNT(*)                                    AS total_trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)  AS wins,
      SUM(CASE WHEN pnl < 0 THEN 1 ELSE 0 END)  AS losses,
      ROUND(SUM(COALESCE(pnl, 0)), 2)            AS total_pnl,
      ROUND(AVG(CASE WHEN pnl > 0 THEN pnl END), 2) AS avg_win,
      ROUND(AVG(CASE WHEN pnl < 0 THEN pnl END), 2) AS avg_loss,
      ROUND(MAX(COALESCE(pnl, 0)), 2)            AS biggest_win,
      ROUND(MIN(COALESCE(pnl, 0)), 2)            AS biggest_loss,
      ROUND(AVG(COALESCE(hold_minutes, 0)), 1)   AS avg_hold_mins,
      COUNT(DISTINCT date(ts))                   AS trading_days
    FROM trades WHERE status = 'CLOSED'
  `).get(),
  { total_trades: 0, wins: 0, losses: 0, total_pnl: 0, avg_win: 0, avg_loss: 0, biggest_win: 0, biggest_loss: 0, avg_hold_mins: 0, trading_days: 0 }
);

const getSetupBreakdown = safe(
  () => db.prepare(`
    SELECT
      setup_type, grade,
      COUNT(*)                                    AS total,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END)  AS wins,
      ROUND(SUM(COALESCE(pnl, 0)), 2)            AS total_pnl,
      ROUND(AVG(COALESCE(pnl, 0)), 2)            AS avg_pnl,
      ROUND(AVG(COALESCE(hold_minutes, 0)), 1)   AS avg_hold
    FROM trades WHERE status = 'CLOSED' AND setup_type IS NOT NULL
    GROUP BY setup_type, grade
    ORDER BY setup_type, grade
  `).all(),
  []
);

const getDailyStats = safe(
  (days = 30) => db.prepare(`
    SELECT
      date(ts)  AS day,
      COUNT(*)  AS trades,
      SUM(CASE WHEN pnl > 0 THEN 1 ELSE 0 END) AS wins,
      ROUND(SUM(COALESCE(pnl, 0)), 2) AS daily_pnl
    FROM trades WHERE status = 'CLOSED' AND ts >= datetime('now', '-' || ? || ' days')
    GROUP BY date(ts)
    ORDER BY day DESC
  `).all(days),
  []
);

const getGEXHistory = safe(
  (ticker = 'SPY', limit = 48) => db.prepare(`
    SELECT ts, ticker, spot, anchor, flip, regime, wall_above, wall_below, concentration
    FROM gex_snaps WHERE ticker = ? ORDER BY ts DESC LIMIT ?
  `).all(ticker, limit),
  []
);

const getTodayPnL = safe(() => {
  const row = db.prepare(`
    SELECT ROUND(SUM(COALESCE(pnl, 0)), 2) AS daily_pnl
    FROM trades WHERE status = 'CLOSED' AND date(ts) = date('now')
  `).get();
  return row?.daily_pnl || 0;
}, 0);

// db.prepare exposed directly for the /api/mining/* routes in server.js —
// guard those call sites too since db may be null
const safeDb = {
  prepare: (sql) => {
    if (!dbAvailable || !db) {
      return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
    }
    try {
      return db.prepare(sql);
    } catch (e) {
      console.error('[DB] prepare failed:', e.message);
      return { all: () => [], get: () => null, run: () => ({ changes: 0 }) };
    }
  },
  get name() { return dbAvailable ? DB_PATH : '(disabled)'; },
};

module.exports = {
  db: safeDb,
  isAvailable: () => dbAvailable,
  saveSignal,
  saveTradeEntry,
  saveTradeExit,
  updateTradeWatermark,
  saveGEXSnap,
  saveBars,
  getRecentSignals,
  getRecentTrades,
  getOpenTrades,
  getStats,
  getSetupBreakdown,
  getDailyStats,
  getGEXHistory,
  getTodayPnL,
};
