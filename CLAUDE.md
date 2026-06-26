# DSB v3 — SPY 0DTE Options Trading Bot — Project Handoff

> **Status note:** The working code directory from prior sessions was lost (sandbox reset).
> This file reconstructs the full project state from conversation history so a fresh
> Claude Code session can either rebuild the files from spec below or pick up from
> whatever you last pushed to GitHub (`ahdesai86/dsb-v3`). Check git history first —
> it should have everything described here through the "confluence + exit strategy
> logging" commit.

---

## 1. Project Overview

A fully self-contained algorithmic options trading bot for SPY 0DTE, deployed on
Railway, using Alpaca for both market data and order execution (paper trading).
Dashboard is a React SPA served by the same Express server. No TradingView
dependency — all signals computed natively from Alpaca data.

**Stack:** Node.js + Express (backend), React (dashboard), SQLite via
`better-sqlite3` (trade/signal logging), Alpaca Trade API (`@alpacahq/alpaca-trade-api@3.1.3`).

**Repo:** `ahdesai86/dsb-v3` on GitHub, deployed to Railway at
`dsb-v3-production.up.railway.app`.

**Owner context:** Aayush (Eastern/NYC timezone), GitHub handle `ahdesai86`.
Alpaca paper account `ahdesai86`. Also holds IBKR, Webull, TOS, TradingView Essential,
active Unusual Whales subscription. Works iteratively: deploy → check logs → report
back with exact error output for targeted fixes.

---

## 2. Strategy — Derived From Two Source Videos

Two YouTube videos were used as the strategy source (full transcripts were reviewed
directly, not summarized from titles). The rules below are my own distillation of the
trading logic — not transcript excerpts — and are what's implemented in `strategy.js`.

### 2a. Layer 1 — Supply & Demand + Footprint Delta (source: an orderflow trader interview)

**Zone marking:** Zones are built from a "rest candle → impulse candle" structure.
A rest candle has a small body relative to its range (the "base"). When a strong
directional candle (large body, >55% of its range) follows a rest candle, the rest
candle's full range — **including both wicks** — becomes a demand zone (if the
impulse was bullish) or supply zone (if bearish). The source trader marks zones
top-down: 4H → 1H → 15m, then executes on a 5m or range-bar chart. Our implementation
uses 15m bars for zone detection and 5m bars for entry execution (no range bars).

**The delta concept:** A "footprint" chart shows buy-side vs sell-side volume inside
each candle, not just at the candle level. The key insight: a candle's color can
contradict its delta. A green (bullish) candle can have *negative* delta if more raw
sell-volume occurred inside it than buy-volume, yet buyers were still strong enough to
close the candle up — meaning sellers got trapped/absorbed. The mirror case: a red
candle with *positive* delta means buyers got trapped.

**The four valid entry setups (no others are used):**

| # | Location | Candle | Delta | Direction | Grade |
|---|----------|--------|-------|-----------|-------|
| 1 | Demand zone | Bullish | Negative | CALL | A (sellers trapped) |
| 2 | Supply zone | Bearish | Positive | PUT | A (buyers trapped) |
| 3 | Demand zone | — | — | CALL | B, or A+ if delta also confirms (B-shape: volume concentrated low in the candle, i.e. absorption at the lows) |
| 4 | Supply zone | — | — | PUT | B, or A+ if delta also confirms (P-shape: volume concentrated high in the candle, i.e. distribution at the highs) |

**A+ grade** = both the delta condition AND the shape condition are present together.
Source claims roughly 85% win rate on A+ setups specifically, with target R:R as high
as 1:5 on those.

**Stop loss placement:** below the low (for calls) or above the high (for puts) of
the *specific confirming candle* — not the whole zone. This is tighter than typical
S&D stop placement and is the source trader's explicit rule for avoiding the common
mistake of getting stopped out repeatedly inside a valid zone before the real
confirmation candle appears.

**Exit rule:** close/reduce when the *opposite* trapped-participant pattern appears
while in a position — i.e., if long (CALL) and a bearish candle with positive delta
appears, that signals buyers are now getting trapped on the way down; exit. Mirror
logic for short (PUT) positions.

**Trading cadence and filters:** roughly 3 trades/week by the source trader's own
account, only during the New York session (after the open), and explicitly avoiding
known news/event windows.

### 2b. Layer 2 — Dealer Positioning / GEX & VEX (source: a second educator's GEX/VEX walkthrough)

**Core concepts:**
- **Anchor** — the strike with the largest gamma exposure magnitude; acts as a price
  magnet toward which price tends to gravitate during the session.
- **Flip** — the nearest strike to current price where net GEX changes sign. Above
  the flip, the regime is "controlled" (positive GEX, dealers hedge in a way that
  dampens moves, favoring mean-reversion). Below the flip, the regime is "expansive"
  (negative GEX, dealer hedging amplifies moves, favoring momentum continuation).
- **Defense walls** — strikes with large absolute GEX magnitude that tend to act as
  reaction zones: price often stalls, reverses, or accelerates through them.
- **VEX (vanna exposure)** — a volatility-pressure overlay on top of GEX. The
  source's explicit rule: never read VEX in isolation; it should agree or disagree
  with the GEX read, and disagreement means "wait for stronger price confirmation"
  rather than trade through the ambiguity.

**The 7-step process before any trade (source's own checklist):**
1. Note current price.
2. Identify the anchor.
3. Identify the flip.
4. Read the GEX regime (controlled vs expansive).
5. Identify the nearest defense walls.
6. Cross-check SPY, SPX, and QQQ — agreement across all three strengthens the read.
7. **Wait for price to actually react** at the level before entering — proximity to a
   level is not itself a signal.

**Explicit anti-patterns the source calls out:**
- Don't treat GEX/VEX as a standalone buy/sell signal — it's confluence only.
- Don't enter in the middle of the range between anchor and a wall — low-conviction zone.
- Don't ignore the flip — losing it can mean a regime change, not just noise.
- Don't trade a single ticker in isolation — cross-check SPY/SPX/QQQ.
- Don't forget that levels are dynamic — recheck before every entry, not just once
  per session.
- Avoid trading when GEX is very diluted/spread across many strikes with no
  concentration — low edge environment.

### 2c. Our own confluence additions (not from either source video)

- Session VWAP and prior-day VWAP as directional filters (the GEX-video source
  mentioned VWAP informally in a live walkthrough; we formalized it as a scored factor).
- EMA 9/21 stack for trend confirmation.
- ATR expansion as a proxy confirmation for "expansive" GEX regimes.
- Volume-above-average filter at the zone (institutional participation proxy).
- Hard time-of-day gating: 9:30–11:30 AM ET and 1:30–3:30 PM ET only.
- A semi-manual FOMC-window news blackout (1:55–2:20 PM ET) — not a full economic
  calendar integration.

---

## 3. Architecture

```
dsb-v3/
├── server.js          # Express app, Alpaca integration, scan loop, order placement,
│                       # position monitor, GEX refresh, healthcheck, API routes
├── strategy.js         # Pure functions: zone detection, delta calc, B/P shape,
│                       # GEX scoring, confluence scoring, master evaluateSignal()
├── db.js               # SQLite layer — signals, trades, gex_snaps, bars tables.
│                       # Crash-proof: every DB call wrapped so a broken/missing
│                       # SQLite native binary degrades to no-persistence instead
│                       # of killing the process.
├── package.json
├── railway.json         # Nixpacks build config + /healthz healthcheck wiring
├── .env.example
└── client/
    ├── package.json
    ├── public/index.html
    └── src/
        ├── index.js
        └── App.js       # Single-file React dashboard, dark terminal aesthetic
```

### Key design decisions worth knowing before touching the code

- **No TradingView, no Pine Script, no webhooks.** Earlier version used a Pine Script
  indicator + webhook signal path; this was fully removed in favor of native
  Alpaca-data signal computation, per explicit instruction to eliminate the
  TradingView dependency.
- **Multi-ticker GEX (SPY + QQQ + SPX)** computed in sequence (not parallel) with a
  1.5s stagger between tickers specifically to avoid Alpaca 429 rate limits that were
  observed in production logs.
- **better-sqlite3 is wrapped defensively everywhere.** A real production crash was
  traced to this native module failing to load (it requires compilation), which
  previously killed the entire Node process at import time before the server could
  even bind its port. Fixed by wrapping every DB operation in a `safe()` helper that
  returns sensible defaults instead of throwing.
- **`/healthz` must be registered before the React catch-all route.** A real bug was
  found and fixed where `app.get('*', ...)` (serving the React build) was registered
  before `/healthz`, so Express matched the wildcard first and the healthcheck never
  actually executed. Order matters here.
- **Position monitoring runs on its own 1-minute interval**, decoupled from the
  5-minute signal-scan loop (`SCAN_INTERVAL_MINS`). This was a deliberate fix —
  previously a position could blow through a stop and sit unclosed for up to 5
  minutes because monitoring only ran inside the scan loop.
- **GEX requires merging two separate Alpaca endpoints.** This was a major bug found
  in production: Alpaca's options *snapshot* endpoint (`getOptionChain`) returns
  greeks (gamma, vanna) but has **no open-interest field**. Open interest only exists
  on the separate contracts-metadata endpoint (`/v2/options/contracts`, called via
  `client.httpRequest()` since no SDK method wraps it in this package version). The
  bug caused `open_interest` to silently default to 0 for every contract, making all
  GEX values compute to exactly zero — which is why `flip` was always `null` and
  `anchor` showed nonsensical static values in early production logs. Fixed by
  fetching both endpoints and merging by option symbol.
- **A `degenerate` flag exists in `calcGEXLevels()`** specifically to catch this class
  of bug recurring: if every contract nets to zero GEX, the function now returns
  `regime: 'UNKNOWN', anchor: null` explicitly rather than a fake-looking anchor value,
  and logs a clear warning.

---

## 4. Database Schema (SQLite)

Four tables, all in `db.js`:

- **`signals`** — every evaluated signal, including rejected ones (for data mining),
  ~35 columns covering direction, confidence, grade, setup type/desc, delta, zone,
  GEX state (regime/anchor/flip/walls), multi-ticker alignment, reject reasons, and
  a full `raw_signal` JSON dump.
- **`trades`** — one row per trade lifecycle (entry through exit, same row updated in
  place via `trade_id`, not two separate rows). Includes: entry premium, stop/TP
  levels, exit price/reason, PnL, hold time, **`max_premium`/`min_premium`** (running
  watermark of the option's best/worst price while held, updated every 1-minute poll),
  **`confluence_summary`** (plain-English string of why the trade fired), and
  **`exit_strategy_label`** (plain-English explanation of the exit reason code).
- **`gex_snaps`** — one row per GEX refresh per ticker (SPY/QQQ/SPX), for historical
  GEX tracking.
- **`bars`** — rolling 5-day OHLCV cache per ticker/timeframe.

---

## 5. Current Config (env vars)

```
ALPACA_API_KEY=
ALPACA_SECRET_KEY=
PAPER=true
AUTO_TRADE=false          # keep false until validated on a live trading day
PORT=3001                 # Railway overrides this automatically — fine
RISK_DOLLARS=300
ACCOUNT_SIZE=100000
MAX_DAILY_LOSS=0.04
PREMIUM_STOP_PCT=0.45
TP1_PCT=0.50
TP2_PCT=1.00
TP1_CLOSE_PCT=0.50
ATR_STOP_MULT=1.5
TRAIL_BREAKEVEN=true
TIERED_SIZING=true        # A+ = 1.5x size, A = 1x, B = 0.75x
MIN_CONFIDENCE=65
FORCE_CLOSE_ET=15:45
GEX_REFRESH_MINS=30
SCAN_INTERVAL_MINS=5
MAX_POSITIONS=1
```

`railway.json` build command is `npm install && npm run build` (explicit root
install added after discovering Nixpacks wasn't reliably installing root deps before
the client build step). `healthcheckPath` is `/healthz`.

---

## 6. Confidence Scoring Model (in `evaluateSignal`)

```
Setup grade base:    A+ = 40, A = 32, B = 22
GEX confluence:      score (0-100) × 0.40
Additional confluence: score (0-100) × 0.50
Counter-regime penalty: ×0.80 if trading against the GEX flip direction
Tradeable threshold:  confidence >= MIN_CONFIDENCE (default 65) AND zone hit
                      AND setup confirmed AND no opposing exit signal active
```

GEX confluence scoring includes: flip alignment (+25 or −10 if counter-regime),
anchor-direction alignment (+15), regime type (+20 expansive / +8 controlled),
wall proximity (+20/+12), multi-ticker alignment (+15), GEX/VEX agreement (+5/−8),
low-concentration penalty (−10), mid-range penalty (−5).

---

## 7. Known Limitations (be honest about these — already disclosed to the user)

1. **Delta is an OHLCV approximation, not real tick-level footprint data.** The
   source trader's actual method requires dedicated paid orderflow software
   (e.g. Bookmap/ATAS/Sierra Chart-class tools) reading real bid/ask-classified
   tick data. Our delta is computed from candle wick proportions × volume — a
   reasonable directional proxy, not a faithful reproduction.
2. **GEX is self-calculated from Alpaca's option chain**, not pulled from a
   dedicated GEX service like the source video's platform. Formula is standard
   (`gamma × open_interest × 100 × spot`) but won't match a proprietary tool exactly.
3. **SPX has no direct equity-style trade feed on Alpaca** — spot price is
   approximated as `SPY price × 10`, which is a reasonable but imperfect proxy.
4. **News blackout is time-of-day only** (FOMC announcement window), not a real
   economic calendar feed. CPI/NFP and other ad-hoc events are not auto-detected.
5. **Webull was investigated as an alternative/supplemental data source — found
   not viable for options data.** Full research trail below in section 8.

---

## 8. Webull Research — Why It Was Rejected (do not re-litigate without new evidence)

Two rounds of research were done, directly against Webull's official OpenAPI docs
and GitHub SDK (not just marketing pages):

**Round 1 — General OpenAPI feasibility.** Confirmed by reading the actual Market
Data API reference, Trading API reference, and Instrument endpoint list: Webull's
Market Data API has exactly five categories (Stock, Futures, Crypto, Event,
Streaming) — **no Options category exists anywhere**. The Trading API's Instrument
module (9 endpoints) covers Stock/Crypto/Futures/Event instrument lookups — again,
**no option-chain/contract-lookup endpoint exists**. This means no path to pull
option greeks or open interest from Webull at all.

**Round 2 — Connect API re-check (user correctly flagged this as unexamined).**
Connect API was initially listed but not opened. On inspection: Connect API is
OAuth-based access to the *same* Trading API modules (Account/Assets/Orders) — not
a separate, larger API surface. It does support placing/modifying/canceling **option
orders** and querying option **positions** (confirmed via Order Replace/Cancel docs
explicitly mentioning options), but still has zero option **market data** capability
(no chain, no greeks, no OI, no premium quotes). This doesn't change the original
conclusion for the bot's use case since orders were always staying on Alpaca.

**Round 3 — Orderflow paid subscription ($16.99/mo) re-check.** Confirmed this is a
**desktop/web chart visualization product** (Footprint, TPO, Delta Volume Profile
modules), sold and accessed entirely through the Webull app UI — there is no
mention of API/developer access anywhere on its product page. It is a *different*
thing from the free OpenAPI Stock Footprint endpoint, which does exist in the
Market Data API and is the only Webull artifact actually worth testing for our
purposes — and it's free with an approved OpenAPI account, not the $16.99/mo product.

**Net conclusion across all three rounds:** Do not subscribe to the $16.99/mo
Orderflow product for bot purposes — it has no programmatic access. If pursuing
Webull further, the only thing worth testing is the free OpenAPI Stock Footprint
endpoint as a potential upgrade to the delta-approximation layer (Sowmya-style logic
only) — GEX/VEX must stay on Alpaca regardless, since Webull has no options data
path at all. This was not yet implemented or tested against a live response; the
endpoint's exact JSON schema is undocumented in static docs and would need to be
inspected directly via the UAT sandbox before committing any engineering time.

---

## 9. Suggested Next Steps for This Claude Code Session

1. **First, check `git log` / `git status` in the actual repo clone** — the file
   tree above should already exist there from prior pushes. This document is a
   fallback spec, not a replacement for the real commit history.
2. If files are genuinely missing, reconstruct `strategy.js`, `server.js`, `db.js`,
   and `client/src/App.js` from the architecture/logic described above — the
   conversation history (if accessible) has full working code for all of these.
3. Verify the GEX merge fix (`fetchGEXForTicker` pulling from both
   `/v2/options/contracts` for open interest and `getOptionChain` for greeks) is
   present — this was the single highest-impact bug fixed in the project.
4. Verify `/healthz` is registered before the catch-all `app.get('*', ...)` route.
5. Confirm `db.js`'s `safe()` wrapper pattern is intact around every SQLite call.
6. If picking up the Webull Footprint investigation: apply for free Webull OpenAPI
   access, hit the Footprint endpoint in the UAT/sandbox environment, and inspect a
   real JSON response before writing any integration code.
