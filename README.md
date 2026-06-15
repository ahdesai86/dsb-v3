# DSB v3 — Demand/Supply Bot (Sowmya + Dealer's Edge)

## What This Actually Does

Derived from two YouTube transcripts (provided and verified):

### Layer 1: Sowmya — Supply & Demand + Orderflow (Video 1)
Marks S&D zones on **15m bars** (proxy for her 4H→1H→15m multi-TF map).
Executes only when price taps a zone AND a **footprint setup** confirms.

**The 4 setups (nothing else is taken):**

| # | Zone | Candle | Delta | Shape | Grade | Action |
|---|------|--------|-------|-------|-------|--------|
| 1 | Demand | Bull (green) | **Negative** | — | A | Buy above candle high |
| 2 | Supply | Bear (red) | **Positive** | — | A | Sell below candle low |
| 3 | Demand | Bull (green) | Optional | **B-shape** | A/A+ | Limit at vol node |
| 4 | Supply | Bear (red) | Optional | **P-shape** | A/A+ | Limit at vol node |

> **A+ = both delta AND B/P shape** → ~85% win rate, 1:5 RR per Sowmya
> **SL = below/above the confirming footprint candle** (NOT the full zone)

**Exit signal (Sowmya):** When the opposite trapped-participant pattern appears
(e.g., in a long: bear candle + positive delta = buyers now trapped going down → reduce)

**Note on footprint data:** Sowmya uses separate paid software (ATAS/similar).
This bot approximates delta via wick-proportion × volume. Directionally correct
but not tick-accurate. Upgrade path: Databento L2 feed (~$150/mo).

### Layer 2: Dealer's Edge — GEX/VEX (Video 2)
7-step process before every trade:
1. Current price
2. **Anchor** = price magnet (session center of gravity)
3. **Flip** = regime boundary (above=controlled, below=expansive)
4. **GEX rating** = positive (mean-revert) vs negative (momentum/expand)
5. **Largest walls** = defense reaction zones
6. **SPY + SPX + QQQ** alignment (stronger when all three agree)
7. **Wait for price reaction** at level (never enter just because price is near)

**Key rules from video:**
- Never enter mid-range (between anchor and wall)
- GEX + VEX disagreement = wait for stronger price action
- Spread/diluted GEX = low edge environment, avoid
- SR flip: old support becomes resistance after price loses it
- Levels update dynamically — check before every entry

### Additional Confluence (Our Enhancements)
- **Prior Day VWAP** — cited in video 2 live demo
- **Session VWAP + EMA 9/21 stack**
- **ATR expansion** (confirms negative GEX momentum environment)
- **Volume spike** (institutional participation at zone)
- **News event filter** — Sowmya explicitly avoids trading around news

---

## Confidence Scoring

| Layer | Max Points | Notes |
|-------|-----------|-------|
| Setup grade (A+/A/B) | 22–40 | Primary signal quality |
| GEX confluence × 0.40 | 0–40 | Flip, anchor, walls, regime |
| Additional conf × 0.50 | 0–26 | VWAP, EMA, ATR, volume |
| **Total** | **~100** | |

**Tradeable if:** confidence ≥ MIN_CONFIDENCE (default 65%) AND zone hit AND setup confirmed

---

## Deployment

### 1. Push to GitHub
```
Push all files in this folder to: github.com/ahdesai86/dsb-v3
```
Files needed:
- `server.js`
- `strategy.js`
- `package.json`
- `railway.json`
- `client/` directory (full React app)

### 2. Railway Setup
1. Go to railway.app → New Project → Deploy from GitHub
2. Select `ahdesai86/dsb-v3`, branch `main`
3. Railway auto-detects nixpacks, runs `npm run build` then `npm start`

### 3. Required Environment Variables
Set in Railway → Variables tab:

```
ALPACA_API_KEY=<your paper trading key>
ALPACA_SECRET_KEY=<your paper trading secret>
PAPER=true
AUTO_TRADE=false
PORT=3001
```

### 4. Optional Config Variables (Railway → Variables)
```
RISK_DOLLARS=300          # Max risk per trade in $
ACCOUNT_SIZE=100000       # Paper account size
MAX_DAILY_LOSS=0.04       # 4% daily loss circuit breaker
PREMIUM_STOP_PCT=0.45     # Stop at 45% premium loss
TP1_PCT=0.50              # TP1 at +50% premium gain
TP2_PCT=1.00              # TP2 at +100% premium gain
TP1_CLOSE_PCT=0.50        # Close 50% at TP1
ATR_STOP_MULT=1.5         # ATR multiplier for soft stop
TRAIL_BREAKEVEN=true      # Trail stop to BE after TP1
TIERED_SIZING=true        # A+=1.5x, A=1x, B=0.75x contracts
MIN_CONFIDENCE=65         # Minimum confidence to trade (%)
FORCE_CLOSE_ET=15:45      # Force close all positions at this time ET
GEX_REFRESH_MINS=30       # Max minutes before GEX refresh
SCAN_INTERVAL_MINS=5      # How often to scan (minutes)
MAX_POSITIONS=1           # Max concurrent SPY positions
```

### 5. Validation Process (DO THIS BEFORE AUTO_TRADE=true)
```
Week 1-2: AUTO_TRADE=false
  → Observe signals on dashboard
  → Check: are zones sensible on chart?
  → Check: do setups fire at actual S&D levels?
  → Check: is GEX regime consistent with SPY price action?

Week 3: If signals look valid, set AUTO_TRADE=true (paper still)
  → Monitor fills, stops, exits
  → Track per-setup win rate in the dashboard

Week 4+: If paper P&L is positive, consider live with PAPER=false
```

---

## TradingView Pine Script (Optional)
The file `tradingview_SPY_5m.pine` adds visual S&D zones and GEX level overlays
to your TradingView SPY 5m chart. Webhook alerts fire to `https://<your-railway-url>/webhook`.

Webhook payload format:
```json
{"action":"BUY_CALL","confidence":78,"close":{{close}},"atr":{{plot("ATR")}},"zone":"demand","grade":"A"}
```

---

## What's NOT Implemented (Honest Limitations)
1. **Real footprint/tick data** — requires Databento or ATAS. Current delta is OHLCV proxy.
2. **SPX + QQQ GEX comparison** — logged but not auto-fetched (Alpaca rate limits). Verify manually in Dealer's Edge.
3. **Dealer's Edge data directly** — we self-calculate GEX from Alpaca's option chain. Reasonably accurate but not identical to Dealer's Edge UI.
4. **Range bars** — Sowmya uses 20R range bars for execution. We use 5m time bars. Functionally similar in most sessions.
5. **News calendar** — only FOMC window is blocked by time-of-day. For CPI/NFP/FOMC dates: manually set AUTO_TRADE=false morning of.

---

## File Reference
| File | Purpose |
|------|---------|
| `strategy.js` | All strategy logic: zone detection, delta, B/P shapes, GEX scoring, signal evaluation |
| `server.js` | Express server: Alpaca integration, scan loop, entry/exit, force close, webhooks |
| `client/src/App.js` | React dashboard |
| `railway.json` | Railway deployment config |
| `package.json` | Node dependencies |
| `.env.example` | Environment variable template |
