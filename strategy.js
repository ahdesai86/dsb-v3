/**
 * strategy.js — DSB v3 — Pure strategy logic (no I/O, fully testable)
 *
 * ═══════════════════════════════════════════════════════════════════
 * STRATEGY SOURCES (derived from actual video transcripts)
 * ═══════════════════════════════════════════════════════════════════
 *
 * VIDEO 1 — Sowmya (Orderflow + Supply & Demand)
 * ─────────────────────────────────────────────
 *  • Zones: impulse → rest candle(s) → impulse on 4H/1H/15m
 *    Uses BOTH wicks of rest candle for zone boundaries
 *  • Execution: 5m time-based chart (or range bars; we use 5m as proxy)
 *  • Delta: footprint order flow per bar
 *    - Positive delta = more buyers
 *    - Negative delta = more sellers
 *  • ONLY 4 setups:
 *    1. Demand zone + Bull candle + NEGATIVE delta  → CALL  (sellers trapped)
 *    2. Supply zone + Bear candle + POSITIVE delta  → PUT   (buyers trapped)
 *    3. Demand zone + B-shape (vol at lows)         → CALL  (limit at node)
 *    4. Supply zone + P-shape (vol at highs)        → PUT   (limit at node)
 *  • A+ = setup has BOTH delta confirmation AND B/P shape
 *  • SL = below/above footprint candle low/high (NOT the full zone)
 *  • ~3 trades per week max; avoid news events
 *  • Exit signal: opposite setup appears (e.g. in long, see bear+pos delta)
 *
 * VIDEO 2 — Dealer's Edge (GEX / VEX)
 * ────────────────────────────────────
 *  • 4 concepts: Anchor (magnet), Flip (regime), Defense walls, GEX rating
 *  • Positive GEX = controlled / mean-revert; Negative GEX = expansive/momentum
 *  • VEX = volatility pressure; NEVER use alone, pair with GEX
 *  • 7-step process: price → anchor → flip → GEX rating → walls → SPY/SPX/QQQ → reaction
 *  • Never enter mid-range; levels update dynamically
 *  • GEX + VEX disagree = reduce confidence, need stronger price action
 *  • Old support → resistance after SR flip
 *  • Avoid when GEX is very spread/concentrated (low conviction)
 *
 * ADDITIONAL CONFLUENCE (our enhancements)
 * ─────────────────────────────────────────
 *  • Prior day VWAP (explicitly cited in video 2 live demo)
 *  • Opposite-setup exit detector (Sowmya: exit when opposite trapped-participant appears)
 *  • GEX concentration check (video 2: spread GEX = low edge)
 *  • VEX conflict flag (video 2: GEX/VEX disagreement = wait for confirmation)
 *  • NY session timing gates: 9:30-11:30 AM and 1:30-3:30 PM ET
 */

'use strict';

// ─── MATH HELPERS ─────────────────────────────────────────────────────────────

function ema(prices, period) {
  if (!prices || prices.length < period) return null;
  const k = 2 / (period + 1);
  let e = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) e = prices[i] * k + e * (1 - k);
  return e;
}

function sma(arr, period) {
  if (!arr || arr.length < period) return null;
  return arr.slice(-period).reduce((a, b) => a + b, 0) / period;
}

function atr(highs, lows, closes, period = 14) {
  if (!closes || closes.length < period + 1) return null;
  const trs = [];
  for (let i = 1; i < closes.length; i++) {
    trs.push(Math.max(
      highs[i] - lows[i],
      Math.abs(highs[i] - closes[i - 1]),
      Math.abs(lows[i] - closes[i - 1])
    ));
  }
  return sma(trs, period);
}

function vwap(prices, volumes) {
  if (!prices || !volumes || prices.length !== volumes.length) return null;
  let pv = 0, v = 0;
  for (let i = 0; i < prices.length; i++) {
    pv += prices[i] * volumes[i];
    v  += volumes[i];
  }
  return v > 0 ? pv / v : null;
}

// ─── DELTA (approximated from OHLCV) ──────────────────────────────────────────
// Real footprint requires separate paid software (Sowmya is explicit about this).
// Best OHLCV approximation: proportional volume split based on candle structure.
//
// The key insight from Sowmya:
//   - Bull candle + NEGATIVE delta = more sell volume hit the tape, yet price closed up
//     → sellers got trapped (absorbed by demand)
//   - Bear candle + POSITIVE delta = more buy volume hit, yet price closed down
//     → buyers got trapped (absorbed by supply)
//
// Approximation logic:
//   buyFrac  = (close - low) / range  → how much of the range buyers "won"
//   sellFrac = (high - close) / range → how much of the range sellers "won"
//   delta    = (buyFrac - sellFrac) * volume
//
// This produces negative delta on a green candle when the upper wick is large
// (sellers pushed price back from high) and close is near open — consistent
// with a "large lower wick bullish candle at demand" which Sowmya targets.
function calcDelta(open, high, low, close, volume) {
  const range = high - low;
  if (range < 0.0001) return 0;
  const buyFrac  = (close - low)  / range;
  const sellFrac = (high - close) / range;
  return (buyFrac - sellFrac) * volume;
}

function calcDeltaSeries(opens, highs, lows, closes, volumes) {
  return closes.map((c, i) => calcDelta(opens[i], highs[i], lows[i], c, volumes[i]));
}

// Delta magnitude as % of volume (how strong is the trapped-participant signal?)
function deltaMagnitudePct(delta, volume) {
  return volume > 0 ? Math.abs(delta) / volume : 0;
}

// ─── SUPPLY & DEMAND ZONE DETECTION (Sowmya method) ──────────────────────────
// Structure: impulse candle → rest candle(s) → impulse candle
// Zone = rest candle's full range INCLUDING wicks (Sowmya is explicit about wicks)
// Timeframe: 15m bars (proxy for 4H/1H multi-timeframe map condensed to 15m)
function detectSDZones(opens, highs, lows, closes, volumes, lookback = 40) {
  const demand = [], supply = [];
  const n = closes.length;
  const start = Math.max(2, n - lookback);

  for (let i = start; i < n - 1; i++) {
    const range = highs[i] - lows[i];
    const body  = Math.abs(closes[i] - opens[i]);
    if (range < 0.0001) continue;

    // Impulse: large body (>55% of range), strong directional
    const isBullImpulse = closes[i] > opens[i] && body / range > 0.55;
    const isBearImpulse = closes[i] < opens[i] && body / range > 0.55;

    // Rest candle: small body (<50% of range) — the "base" before impulse
    const isRestCandle = (idx) => {
      if (idx < 0 || idx >= n) return false;
      const r = highs[idx] - lows[idx];
      const b = Math.abs(closes[idx] - opens[idx]);
      return r > 0 && b / r < 0.50;
    };

    // DEMAND: rest → bull impulse (price launches up from base)
    if (isRestCandle(i - 1) && isBullImpulse) {
      // Zone = full range of rest candle (wicks included — Sowmya's rule)
      demand.push({
        top:      highs[i - 1],
        bottom:   lows[i - 1],
        midpoint: (highs[i - 1] + lows[i - 1]) / 2,
        formed:   i,
        impulseStrength: body / range,
        valid:    true,
        retests:  0,
        type:     'demand',
      });
    }

    // SUPPLY: rest → bear impulse (price drops from base)
    if (isRestCandle(i - 1) && isBearImpulse) {
      supply.push({
        top:      highs[i - 1],
        bottom:   lows[i - 1],
        midpoint: (highs[i - 1] + lows[i - 1]) / 2,
        formed:   i,
        impulseStrength: body / range,
        valid:    true,
        retests:  0,
        type:     'supply',
      });
    }
  }

  const last = closes[closes.length - 1];

  // Filter: demand must be below price, supply above price
  // Invalidate zones where price has closed fully through (mitigated)
  const validDemand = demand
    .filter(z => last >= z.bottom * 0.997 && last >= z.midpoint)
    .filter(z => z.valid)
    .slice(-5);

  const validSupply = supply
    .filter(z => last <= z.top * 1.003 && last <= z.midpoint)
    .filter(z => z.valid)
    .slice(-5);

  return { demand: validDemand, supply: validSupply };
}

// Is price currently AT a zone? (touching or inside)
// Returns the nearest zone if multiple candidates
function priceAtZone(price, zones) {
  const hits = [];

  for (const z of zones.demand) {
    // Price tapping into zone (allow wick cushion of 0.15%)
    if (price >= z.bottom * 0.9985 && price <= z.top * 1.002) {
      hits.push({ hit: true, type: 'demand', zone: z, dist: Math.abs(price - z.midpoint) });
    }
  }
  for (const z of zones.supply) {
    if (price >= z.bottom * 0.998 && price <= z.top * 1.0015) {
      hits.push({ hit: true, type: 'supply', zone: z, dist: Math.abs(price - z.midpoint) });
    }
  }

  if (!hits.length) return { hit: false, type: null, zone: null };

  // Return closest zone to current price
  hits.sort((a, b) => a.dist - b.dist);
  return hits[0];
}

// ─── SOWMYA B-SHAPE DETECTION ─────────────────────────────────────────────────
// B-shape: volume concentrated at the BOTTOM of the candle
// Visual: footprint chart looks like a "B" — fat bottom, thin top
// Proxy signals: large lower wick, close above midpoint, volume spike
// Used at DEMAND zones → CALL signal
function detectBShape(opens, highs, lows, closes, volumes, idx) {
  if (idx < 1) return false;
  const c = closes[idx], o = opens[idx], h = highs[idx], l = lows[idx], v = volumes[idx];
  const range = h - l;
  if (range < 0.001) return false;

  const lowerWick = (Math.min(c, o) - l) / range;  // lower wick proportion
  const closePos  = (c - l) / range;                // where close sits in range (0=bottom, 1=top)

  const recent = volumes.slice(Math.max(0, idx - 10), idx);
  const avgVol  = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : v;

  // B-shape criteria (approximation):
  //  - Significant lower wick (activity at lows)
  //  - Close above midpoint (net bullish)
  //  - Volume at or above average (institutional participation)
  return lowerWick > 0.28 && closePos > 0.45 && v >= avgVol * 0.85;
}

// ─── SOWMYA P-SHAPE DETECTION ─────────────────────────────────────────────────
// P-shape: volume concentrated at the TOP of the candle
// Visual: fat top, thin bottom — activity clustered at highs then sold off
// Used at SUPPLY zones → PUT signal
function detectPShape(opens, highs, lows, closes, volumes, idx) {
  if (idx < 1) return false;
  const c = closes[idx], o = opens[idx], h = highs[idx], l = lows[idx], v = volumes[idx];
  const range = h - l;
  if (range < 0.001) return false;

  const upperWick = (h - Math.max(c, o)) / range;  // upper wick proportion
  const closePos  = (c - l) / range;

  const recent = volumes.slice(Math.max(0, idx - 10), idx);
  const avgVol  = recent.length > 0 ? recent.reduce((a, b) => a + b, 0) / recent.length : v;

  // P-shape criteria:
  //  - Significant upper wick (activity at highs, then rejected)
  //  - Close below midpoint (net bearish)
  //  - Volume at or above average
  return upperWick > 0.28 && closePos < 0.55 && v >= avgVol * 0.85;
}

// ─── SOWMYA EXIT SIGNAL DETECTOR ─────────────────────────────────────────────
// "When you're in a long trade and you see a red candle with positive delta,
//  the sellers are now getting trapped — exit or reduce"  — Sowmya
// This is the mirror of entry: the opposite trapped-participant signal
function detectExitSignal(opens, highs, lows, closes, volumes, currentDirection) {
  const last = closes.length - 1;
  if (last < 0) return { exit: false };

  const delta = calcDelta(opens[last], highs[last], lows[last], closes[last], volumes[last]);
  const isBull = closes[last] > opens[last];
  const isBear = closes[last] < opens[last];

  if (currentDirection === 'CALL') {
    // In a long: exit signal = bear candle + POSITIVE delta (buyers trapped going down)
    // OR: P-shape forming at current price (distribution overhead)
    const bearPosD = isBear && delta > 0;
    const pShape   = detectPShape(opens, highs, lows, closes, volumes, last);
    return { exit: bearPosD || pShape, reason: bearPosD ? 'Bear+PosDelta (buyers trapped)' : 'P-Shape (distribution)' };
  }

  if (currentDirection === 'PUT') {
    // In a short: exit signal = bull candle + NEGATIVE delta (sellers trapped going up)
    const bullNegD = isBull && delta < 0;
    const bShape   = detectBShape(opens, highs, lows, closes, volumes, last);
    return { exit: bullNegD || bShape, reason: bullNegD ? 'Bull+NegDelta (sellers trapped)' : 'B-Shape (absorption)' };
  }

  return { exit: false };
}

// ─── FOOTPRINT SETUP DETECTION (Sowmya's 4 setups) ───────────────────────────
function detectFootprintSetup(opens, highs, lows, closes, volumes, zoneHit) {
  if (!zoneHit?.hit) return null;

  const last      = closes.length - 1;
  if (last < 1) return null;

  const delta     = calcDelta(opens[last], highs[last], lows[last], closes[last], volumes[last]);
  const deltaMag  = deltaMagnitudePct(delta, volumes[last]);  // strength 0-1

  const isBull    = closes[last] > opens[last];
  const isBear    = closes[last] < opens[last];
  const bShape    = detectBShape(opens, highs, lows, closes, volumes, last);
  const pShape    = detectPShape(opens, highs, lows, closes, volumes, last);

  const candidates = [];

  // ── SETUP 1: Demand + Bull candle + Negative delta ─────────────────────────
  // Sowmya: "green candle, negative delta at demand → sellers trapped → buy above high"
  if (zoneHit.type === 'demand' && isBull && delta < 0) {
    const grade = bShape ? 'A+' : 'A';  // A+ if ALSO has B-shape (both confirmations)
    candidates.push({
      type:      'SETUP_1',
      direction: 'CALL',
      grade,
      label:     `Bull+NegDelta${bShape ? '+BShape' : ''}@Demand`,
      desc:      'Bull candle with neg delta — sellers trapped at demand zone',
      delta,
      deltaMag,
      hasBShape: bShape,
      hasPShape: false,
      stopRef:   lows[last],          // SL below this candle's low (Sowmya)
      entryRef:  highs[last],         // enter above this candle's high
    });
  }

  // ── SETUP 2: Supply + Bear candle + Positive delta ─────────────────────────
  // Sowmya: "red candle, positive delta at supply → buyers trapped → sell below low"
  if (zoneHit.type === 'supply' && isBear && delta > 0) {
    const grade = pShape ? 'A+' : 'A';
    candidates.push({
      type:      'SETUP_2',
      direction: 'PUT',
      grade,
      label:     `Bear+PosDelta${pShape ? '+PShape' : ''}@Supply`,
      desc:      'Bear candle with pos delta — buyers trapped at supply zone',
      delta,
      deltaMag,
      hasBShape: false,
      hasPShape: pShape,
      stopRef:   highs[last],         // SL above this candle's high
      entryRef:  lows[last],          // enter below this candle's low
    });
  }

  // ── SETUP 3: Demand + B-shape ──────────────────────────────────────────────
  // Sowmya: "B-shape at support → limit order at high-vol node"
  if (zoneHit.type === 'demand' && bShape) {
    const grade = (delta < 0) ? 'A+' : 'B';  // upgrade to A+ if delta also confirms
    // Only add if not already captured in setup 1 (setup 1 is a superset when delta<0)
    if (!candidates.some(c => c.type === 'SETUP_1')) {
      candidates.push({
        type:      'SETUP_3',
        direction: 'CALL',
        grade,
        label:     `BShape${delta < 0 ? '+NegDelta' : ''}@Demand`,
        desc:      'B-shape (volume at lows) at demand zone — limit entry at vol node',
        delta,
        deltaMag,
        hasBShape: true,
        hasPShape: false,
        stopRef:   lows[last],
        entryRef:  highs[last],
      });
    }
  }

  // ── SETUP 4: Supply + P-shape ──────────────────────────────────────────────
  // Sowmya: "P-shape at resistance → limit short at high-vol node"
  if (zoneHit.type === 'supply' && pShape) {
    const grade = (delta > 0) ? 'A+' : 'B';
    if (!candidates.some(c => c.type === 'SETUP_2')) {
      candidates.push({
        type:      'SETUP_4',
        direction: 'PUT',
        grade,
        label:     `PShape${delta > 0 ? '+PosDelta' : ''}@Supply`,
        desc:      'P-shape (volume at highs) at supply zone — limit entry at vol node',
        delta,
        deltaMag,
        hasBShape: false,
        hasPShape: true,
        stopRef:   highs[last],
        entryRef:  lows[last],
      });
    }
  }

  if (!candidates.length) return null;

  // Return highest grade setup
  const gradeOrder = { 'A+': 3, A: 2, B: 1 };
  candidates.sort((a, b) => (gradeOrder[b.grade] || 0) - (gradeOrder[a.grade] || 0));
  return candidates[0];
}

// ─── GEX SELF-CALCULATION (from Alpaca option chain) ─────────────────────────
// Calculates: anchor, flip, defense walls, regime, VEX proxy
function calcGEXLevels(optionChain, spotPrice) {
  if (!optionChain || !optionChain.length) return null;

  const strikeMap = {};

  for (const contract of optionChain) {
    const strike = contract.strike_price;
    const gamma  = contract.greeks?.gamma  || 0;
    const oi     = contract.open_interest  || 0;
    const vanna  = contract.greeks?.vanna  || 0;  // for VEX
    const type   = contract.type;

    if (!strikeMap[strike]) {
      strikeMap[strike] = { call: 0, put: 0, net: 0, vexNet: 0, oi: 0, strike };
    }

    const gexContrib = gamma * oi * 100 * spotPrice;
    const vexContrib = vanna * oi * 100;

    if (type === 'call') {
      strikeMap[strike].call += gexContrib;
      strikeMap[strike].net  += gexContrib;
      strikeMap[strike].vexNet += vexContrib;
    } else {
      strikeMap[strike].put  += gexContrib;
      strikeMap[strike].net  -= gexContrib;   // put GEX negative (hedging flips)
      strikeMap[strike].vexNet -= vexContrib;
    }
    strikeMap[strike].oi += oi;
  }

  const strikes  = Object.values(strikeMap).sort((a, b) => a.strike - b.strike);
  if (!strikes.length) return null;

  const totalGEX = strikes.reduce((s, x) => s + x.net, 0);
  const totalVEX = strikes.reduce((s, x) => s + x.vexNet, 0);

  // Anchor: highest absolute GEX magnitude (price magnet)
  const anchor = strikes.reduce((m, x) => Math.abs(x.net) > Math.abs(m.net) ? x : m, strikes[0]);

  // Flip: nearest strike to spot where GEX sign changes
  let flip = null;
  for (let i = 1; i < strikes.length; i++) {
    if (Math.sign(strikes[i].net) !== Math.sign(strikes[i - 1].net)) {
      const a = strikes[i - 1], b = strikes[i];
      flip = Math.abs(a.strike - spotPrice) < Math.abs(b.strike - spotPrice) ? a : b;
      break;
    }
  }

  // Defense walls: top 6 by absolute GEX magnitude
  const walls = [...strikes]
    .sort((a, b) => Math.abs(b.net) - Math.abs(a.net))
    .slice(0, 6);

  const wallAbove = walls.filter(w => w.strike > spotPrice).sort((a, b) => a.strike - b.strike)[0];
  const wallBelow = walls.filter(w => w.strike < spotPrice).sort((a, b) => b.strike - a.strike)[0];

  // GEX concentration: how concentrated vs spread out?
  // Video says: very spread GEX = low edge → avoid
  const nearStrikes = strikes.filter(s => Math.abs(s.strike - spotPrice) <= 10);
  const nearGEXAbs  = nearStrikes.reduce((a, s) => a + Math.abs(s.net), 0);
  const totalGEXAbs = strikes.reduce((a, s) => a + Math.abs(s.net), 0);
  const concentration = totalGEXAbs > 0 ? nearGEXAbs / totalGEXAbs : 0;

  // VEX / GEX agreement check
  // Both negative = full expansion mode (strong momentum context)
  // Both positive = full controlled mode (mean-revert context)
  // Disagreement = wait for stronger price action confirmation
  const gexNeg = totalGEX < 0;
  const vexNeg = totalVEX < 0;
  const gexVexAgreement = (gexNeg === vexNeg);  // true = aligned, false = disagreement

  return {
    totalGEX,
    totalVEX,
    isPositiveGEX:     totalGEX > 0,
    regime:            totalGEX > 0 ? 'CONTROLLED' : 'EXPANSIVE',
    gexVexAgreement,
    concentration,     // 0-1; below 0.3 = spread/low-edge environment
    anchor:            anchor.strike,
    flip:              flip?.strike || null,
    wallAbove:         wallAbove?.strike || null,
    wallBelow:         wallBelow?.strike || null,
    walls:             walls.map(w => ({ strike: w.strike, net: w.net })),
    strikes,
  };
}

// ─── GEX CONFLUENCE SCORER (Video 2 — 7-step process) ───────────────────────
function scoreGEXConfluence(gex, price, direction) {
  if (!gex) return { score: 0, details: [], flags: [] };

  let score = 0;
  const details = [];
  const flags   = [];

  // STEP 3 — Flip regime check (most important per video 2)
  if (gex.flip !== null) {
    const aboveFlip = price > gex.flip;
    if (direction === 'CALL' && aboveFlip) {
      score += 25;
      details.push({ label: `Above Flip ${gex.flip}`, color: 'green', weight: 25 });
    } else if (direction === 'PUT' && !aboveFlip) {
      score += 25;
      details.push({ label: `Below Flip ${gex.flip}`, color: 'green', weight: 25 });
    } else {
      // Counter-regime trade — heavy penalty, video 2 says don't ignore flip
      score -= 10;
      flags.push('COUNTER_REGIME');
      details.push({ label: 'Counter Flip (counter-regime)', color: 'red', weight: -10 });
    }
  }

  // STEP 2 — Anchor direction (is trade heading toward the magnet?)
  if (gex.anchor) {
    const towardAnchor = direction === 'CALL' ? price <= gex.anchor : price >= gex.anchor;
    if (towardAnchor) {
      score += 15;
      details.push({ label: `Toward Anchor ${gex.anchor}`, color: 'green', weight: 15 });
    } else {
      details.push({ label: `Away from Anchor ${gex.anchor}`, color: 'yellow', weight: 0 });
    }
  }

  // STEP 4 — GEX rating / regime
  if (gex.regime === 'EXPANSIVE') {
    // Negative GEX: momentum carries → directional options plays work well
    score += 20;
    details.push({ label: 'Negative GEX (Expansive — momentum)', color: 'green', weight: 20 });
  } else {
    // Positive GEX: mean-revert → still valid at walls/extremes, but lower score
    score += 8;
    details.push({ label: 'Positive GEX (Controlled — mean-revert)', color: 'yellow', weight: 8 });
  }

  // STEP 5 — Defense wall proximity (near a reaction wall = high edge per video 2)
  const reactionWall = direction === 'CALL' ? gex.wallBelow : gex.wallAbove;
  if (reactionWall) {
    const dist = Math.abs(reactionWall - price) / price;
    if (dist < 0.003) {
      score += 20;
      details.push({ label: `AT Wall ${reactionWall} (<0.3%)`, color: 'green', weight: 20 });
    } else if (dist < 0.01) {
      score += 12;
      details.push({ label: `Near Wall ${reactionWall} (<1%)`, color: 'yellow', weight: 12 });
    } else {
      details.push({ label: `Far from Wall ${reactionWall}`, color: 'gray', weight: 0 });
    }
  }

  // STEP 6 — Multi-ticker alignment (SPY + SPX + QQQ)
  if (gex.multiTickerAligned === true) {
    score += 15;
    details.push({ label: 'SPY/SPX/QQQ Aligned', color: 'green', weight: 15 });
  }

  // VEX / GEX agreement check (video 2: disagreement = need stronger confirmation)
  if (gex.gexVexAgreement === false) {
    score -= 8;
    flags.push('GEX_VEX_DISAGREE');
    details.push({ label: 'GEX/VEX Disagreement (↓ confidence)', color: 'orange', weight: -8 });
  } else if (gex.gexVexAgreement === true) {
    score += 5;
    details.push({ label: 'GEX+VEX Aligned', color: 'green', weight: 5 });
  }

  // Concentration check (video 2: spread GEX = low edge → avoid)
  if (gex.concentration < 0.25) {
    score -= 10;
    flags.push('LOW_GEX_CONCENTRATION');
    details.push({ label: 'GEX Spread/Diluted (low conviction)', color: 'red', weight: -10 });
  }

  // Mid-range penalty (video 2: mistake #2 = chasing in middle of range)
  if (gex.anchor && gex.wallAbove && gex.wallBelow) {
    const midRange = (gex.wallAbove + gex.wallBelow) / 2;
    const fromMid  = Math.abs(price - midRange) / (gex.wallAbove - gex.wallBelow);
    if (fromMid < 0.2) {   // within 20% of mid-range
      score -= 5;
      flags.push('MID_RANGE');
      details.push({ label: 'Price mid-range (low GEX edge)', color: 'orange', weight: -5 });
    }
  }

  return { score: Math.max(0, Math.min(score, 100)), details, flags, regime: gex.regime };
}

// ─── ADDITIONAL CONFLUENCE LAYER ─────────────────────────────────────────────
// From both videos and industry-standard enhancements
function scoreAdditionalConfluence(opens, highs, lows, closes, volumes, direction, priorDayClose) {
  const last = closes.length - 1;
  if (last < 0) return { score: 0, details: [] };

  let score = 0;
  const details = [];

  // 1. Session VWAP (video 2 live: "stayed below NY VWAP the whole time")
  const sessionVWAP = vwap(closes, volumes);
  if (sessionVWAP) {
    const aboveVWAP = closes[last] > sessionVWAP;
    if (direction === 'CALL' && aboveVWAP) {
      score += 15;
      details.push({ label: `Above Session VWAP (${sessionVWAP.toFixed(2)})`, color: 'green', weight: 15 });
    } else if (direction === 'PUT' && !aboveVWAP) {
      score += 15;
      details.push({ label: `Below Session VWAP (${sessionVWAP.toFixed(2)})`, color: 'green', weight: 15 });
    } else {
      details.push({ label: `Counter Session VWAP`, color: 'red', weight: 0 });
    }
  }

  // 2. Prior Day VWAP (explicitly cited in video 2 live demo: "prior day VWAP")
  if (priorDayClose) {
    const abovePDVWAP = closes[last] > priorDayClose;
    if (direction === 'CALL' && abovePDVWAP) {
      score += 10;
      details.push({ label: `Above Prior Day VWAP (${priorDayClose.toFixed(2)})`, color: 'green', weight: 10 });
    } else if (direction === 'PUT' && !abovePDVWAP) {
      score += 10;
      details.push({ label: `Below Prior Day VWAP (${priorDayClose.toFixed(2)})`, color: 'green', weight: 10 });
    }
  }

  // 3. EMA 9/21 stack (standard trend confirmation)
  const ema9  = ema(closes, 9);
  const ema21 = ema(closes, 21);
  if (ema9 && ema21) {
    if (direction === 'CALL' && ema9 > ema21 && closes[last] > ema9) {
      score += 8;
      details.push({ label: 'EMA9 > EMA21, price > EMA9 (bull stack)', color: 'green', weight: 8 });
    } else if (direction === 'PUT' && ema9 < ema21 && closes[last] < ema9) {
      score += 8;
      details.push({ label: 'EMA9 < EMA21, price < EMA9 (bear stack)', color: 'green', weight: 8 });
    }
  }

  // 4. ATR expansion (negative GEX context: momentum environment)
  const atrVal = atr(highs, lows, closes, 14);
  if (atrVal) {
    const prevATRs = [];
    for (let i = Math.max(5, last - 10); i < last; i++) {
      const a = atr(highs.slice(0, i + 1), lows.slice(0, i + 1), closes.slice(0, i + 1), 14);
      if (a) prevATRs.push(a);
    }
    const avgATR = prevATRs.length > 0 ? prevATRs.reduce((a, b) => a + b) / prevATRs.length : atrVal;
    if (atrVal > avgATR * 1.15) {
      score += 8;
      details.push({ label: 'ATR Expanding (momentum environment)', color: 'green', weight: 8 });
    }
  }

  // 5. Volume confirmation (institutional = above average)
  const recentVols = volumes.slice(Math.max(0, last - 15), last);
  const avgVol = recentVols.length > 0 ? recentVols.reduce((a, b) => a + b) / recentVols.length : 0;
  if (avgVol > 0 && volumes[last] > avgVol * 1.25) {
    score += 6;
    details.push({ label: 'Volume Spike (≥1.25× avg)', color: 'green', weight: 6 });
  }

  // 6. Candle structure (avoid entering after large expansion candles)
  const prevRange = highs[last - 1] - lows[last - 1];
  const curRange  = highs[last]     - lows[last];
  if (prevRange > 0 && curRange < prevRange * 0.75) {
    score += 4;
    details.push({ label: 'Candle contracting (clean entry)', color: 'yellow', weight: 4 });
  }

  return {
    score:       Math.min(score, 51),  // cap addl at 51
    details,
    sessionVWAP: sessionVWAP,
    ema9,
    ema21,
    atr:         atrVal,
  };
}

// ─── NY SESSION TIMING FILTER ─────────────────────────────────────────────────
// Sowmya: trade after NY open; video 2: intraday live during NY session
// Primary: 9:30–11:30 AM ET | Secondary: 1:30–3:30 PM ET
// Avoid: pre-market, lunch chop, last 30 min
function isValidTradingTime(etHour, etMinute) {
  const mins = etHour * 60 + etMinute;
  const w1   = mins >= 9 * 60 + 30  && mins < 11 * 60 + 30;
  const w2   = mins >= 13 * 60 + 30 && mins < 15 * 60 + 30;
  return w1 || w2;
}

// ─── MASTER SIGNAL EVALUATOR ──────────────────────────────────────────────────
// Combines all layers: time → zones → footprint → GEX → additional
//
// CONFIDENCE WEIGHTING:
//   Setup grade:  A+=40, A=32, B=22  (Sowmya's primary signal quality)
//   GEX score:    ×0.40              (regime, flip, walls — from video 2)
//   Additional:   ×0.50              (VWAP, EMA, ATR, volume)
//   Max:          ~100
//
// TRADEABLE THRESHOLD: confidence >= MIN_CONFIDENCE (default 65%)
function evaluateSignal({ bars15m, bars5m, gexData, etHour, etMinute, priorDayClose }) {
  const result = {
    direction:     'NEUTRAL',
    confidence:    0,
    grade:         null,
    setup:         null,
    zoneHit:       null,
    zones:         null,
    gexAnalysis:   null,
    addlConf:      null,
    exitSignal:    null,
    meta:          {},
    timestamp:     new Date().toISOString(),
    tradeable:     false,
    rejectReasons: [],
  };

  // ── Layer 0: Time filter ──────────────────────────────────────────────────
  if (!isValidTradingTime(etHour, etMinute)) {
    result.rejectReasons.push(`Outside trading windows (9:30-11:30, 13:30-15:30 ET) — now ${etHour}:${String(etMinute).padStart(2,'0')}`);
    return result;
  }

  if (!bars15m?.length || !bars5m?.length || bars5m.length < 20) {
    result.rejectReasons.push('Insufficient bar data');
    return result;
  }

  const o15 = bars15m.map(b => b.o), h15 = bars15m.map(b => b.h);
  const l15 = bars15m.map(b => b.l), c15 = bars15m.map(b => b.c), v15 = bars15m.map(b => b.v);

  const o5  = bars5m.map(b => b.o), h5  = bars5m.map(b => b.h);
  const l5  = bars5m.map(b => b.l), c5  = bars5m.map(b => b.c), v5  = bars5m.map(b => b.v);

  const lastPrice = c5[c5.length - 1];
  const atrVal    = atr(h5, l5, c5) || lastPrice * 0.003;

  // ── Layer 1: S&D Zone map (15m) ───────────────────────────────────────────
  const zones  = detectSDZones(o15, h15, l15, c15, v15);
  result.zones = zones;

  const zoneHit    = priceAtZone(lastPrice, zones);
  result.zoneHit   = zoneHit;

  if (!zoneHit.hit) {
    result.rejectReasons.push('No zone hit — price not at a S&D level');
    // Still run GEX scan for dashboard context even without zone
  }

  // ── Layer 2: Footprint setup (5m) ─────────────────────────────────────────
  const setup = detectFootprintSetup(o5, h5, l5, c5, v5, zoneHit);
  result.setup = setup;

  if (!setup) {
    result.rejectReasons.push('No footprint setup — no trapped participants at zone');
    return result;  // Can't score without a directional signal
  }

  const direction  = setup.direction;
  result.direction = direction;

  // ── Layer 2b: Exit signal check (Sowmya: exit on opposite trapped setup) ──
  result.exitSignal = detectExitSignal(o5, h5, l5, c5, v5, direction);

  // ── Layer 3: GEX confluence (Video 2 — 7-step process) ───────────────────
  const gexScore   = scoreGEXConfluence(gexData, lastPrice, direction);
  result.gexAnalysis = { ...gexData, ...gexScore };

  // ── Layer 4: Additional confluence ───────────────────────────────────────
  const addlConf   = scoreAdditionalConfluence(o5, h5, l5, c5, v5, direction, priorDayClose);
  result.addlConf  = addlConf;

  // ── Final confidence ──────────────────────────────────────────────────────
  const gradeBase  = setup.grade === 'A+' ? 40 : setup.grade === 'A' ? 32 : 22;
  const gexW       = gexScore.score  * 0.40;
  const addlW      = addlConf.score  * 0.50;
  const raw        = gradeBase + gexW + addlW;

  // Penalty flags from GEX scorer
  const hasCritical = gexScore.flags.includes('COUNTER_REGIME');
  const penaltyAdj  = hasCritical ? 0.80 : 1.0;  // 20% penalty for counter-regime trades

  result.confidence = Math.min(Math.round(raw * penaltyAdj), 100);
  result.grade      = setup.grade;

  result.meta = {
    lastPrice,
    atr:          atrVal,
    setupLabel:   setup.label,
    setupDesc:    setup.desc,
    delta:        setup.delta,
    deltaMag:     setup.deltaMag,
    hasBShape:    setup.hasBShape,
    hasPShape:    setup.hasPShape,
    stopRef:      setup.stopRef,
    entryRef:     setup.entryRef,
    sessionVWAP:  addlConf.sessionVWAP,
    priorDayClose,
    ema9:         addlConf.ema9,
    ema21:        addlConf.ema21,
    gexRegime:    gexData?.regime || 'UNKNOWN',
    gexFlags:     gexScore.flags,
    anchor:       gexData?.anchor,
    flip:         gexData?.flip,
    wallAbove:    gexData?.wallAbove,
    wallBelow:    gexData?.wallBelow,
    concentration: gexData?.concentration,
  };

  // ── Tradeable threshold ───────────────────────────────────────────────────
  result.tradeable = (
    zoneHit.hit   &&
    setup !== null &&
    !result.exitSignal?.exit &&            // don't enter if exit signal is firing
    result.confidence >= 65               // configurable
  );

  if (!zoneHit.hit)         result.rejectReasons.push('Zone miss — no S&D zone present');
  if (result.exitSignal?.exit) result.rejectReasons.push(`Exit signal active: ${result.exitSignal.reason}`);

  return result;
}

module.exports = {
  // Main evaluator
  evaluateSignal,
  // Sub-functions (for testing and server use)
  detectSDZones,
  calcGEXLevels,
  detectFootprintSetup,
  detectExitSignal,
  scoreGEXConfluence,
  scoreAdditionalConfluence,
  isValidTradingTime,
  // Math helpers
  vwap, ema, atr, sma,
  calcDelta, calcDeltaSeries,
  detectBShape, detectPShape,
};
