'use strict';
/**
 * backtest.js — DSB v3 Backtester
 *
 * Fetches historical 5m/15m bars from Alpaca, runs the strategy's evaluateSignal()
 * on each 5-minute window, simulates entries/exits with the same stop/TP logic
 * as the live bot, and returns results as JSON (consumed by the HTML report generator).
 *
 * Usage: called via /api/backtest endpoint on the server, or `node backtest.js` CLI.
 */

const Alpaca = require('@alpacahq/alpaca-trade-api');
const { evaluateSignal, detectExitSignal } = require('./strategy');

const ENV = {
  ALPACA_KEY:    process.env.ALPACA_API_KEY    || process.env.APCA_API_KEY_ID,
  ALPACA_SECRET: process.env.ALPACA_SECRET_KEY || process.env.APCA_API_SECRET_KEY,
  PAPER:         true,
};

function getClient() {
  if (!ENV.ALPACA_KEY || !ENV.ALPACA_SECRET) return null;
  return new Alpaca({
    keyId:     ENV.ALPACA_KEY,
    secretKey: ENV.ALPACA_SECRET,
    paper:     true,
    feed:      'iex',
  });
}

async function fetchBars(client, symbol, timeframe, start, end) {
  const bars = [];
  const resp = client.getBarsV2(symbol, {
    timeframe, start, end, feed: 'iex', adjustment: 'raw', limit: 10000,
  });
  for await (const b of resp) {
    bars.push({ o: b.OpenPrice, h: b.HighPrice, l: b.LowPrice, c: b.ClosePrice, v: b.Volume, t: b.Timestamp });
  }
  return bars;
}

function toET(ts) {
  const d = new Date(ts);
  const et = new Date(d.toLocaleString('en-US', { timeZone: 'America/New_York' }));
  return { h: et.getHours(), m: et.getMinutes(), date: et.toISOString().split('T')[0], ts: d };
}

function isTradeWindow(h, m) {
  const mins = h * 60 + m;
  return (mins >= 570 && mins <= 690) || (mins >= 810 && mins <= 930); // 9:30-11:30, 13:30-15:30
}

async function runBacktest(options = {}) {
  const {
    days = 20,
    minConfidence = 55,
    premiumStopPct = 0.45,
    tp1Pct = 0.50,
    tp2Pct = 1.00,
    tp1ClosePct = 0.50,
    atrStopMult = 1.5,
    trailBreakeven = true,
    riskDollars = 300,
  } = options;

  const client = getClient();
  if (!client) throw new Error('No Alpaca API keys configured');

  const endDate = new Date();
  const startDate = new Date();
  startDate.setDate(startDate.getDate() - (days * 1.5 + 5)); // extra buffer for weekends

  const startStr = startDate.toISOString().split('T')[0];
  const endStr = endDate.toISOString().split('T')[0];

  console.log(`[BT] Fetching SPY bars from ${startStr} to ${endStr}...`);

  const [bars5m, bars15m] = await Promise.all([
    fetchBars(client, 'SPY', '5Min', startStr, endStr),
    fetchBars(client, 'SPY', '15Min', startStr, endStr),
  ]);

  console.log(`[BT] Loaded ${bars5m.length} 5m bars, ${bars15m.length} 15m bars`);

  if (bars5m.length < 50) throw new Error(`Insufficient data: ${bars5m.length} 5m bars`);

  // Group bars by trading day
  const dayMap = new Map();
  for (const b of bars5m) {
    const { date } = toET(b.t);
    if (!dayMap.has(date)) dayMap.set(date, []);
    dayMap.get(date).push(b);
  }
  const dayMap15 = new Map();
  for (const b of bars15m) {
    const { date } = toET(b.t);
    if (!dayMap15.has(date)) dayMap15.set(date, []);
    dayMap15.get(date).push(b);
  }

  const tradingDays = [...dayMap.keys()].sort().slice(-days);
  console.log(`[BT] Processing ${tradingDays.length} trading days`);

  // Simulated GEX (use price-derived levels since we don't have historical GEX)
  function synthGEX(price) {
    const round5 = s => Math.round(s / 5) * 5;
    return {
      regime: price % 2 < 1 ? 'EXPANSIVE' : 'CONTROLLED',
      anchor: round5(price + 2),
      flip: round5(price - 1),
      wallAbove: round5(price + 3),
      wallBelow: round5(price - 3),
      concentration: 0.4,
      gexVexAgreement: true,
      multiTickerAligned: true,
    };
  }

  const trades = [];
  const signals = [];
  const equityCurve = [];
  let equity = 10000;
  let position = null;
  let priorDayClose = null;
  let tradeId = 0;

  for (const day of tradingDays) {
    const dayBars5 = dayMap.get(day) || [];
    const dayBars15 = dayMap15.get(day) || [];
    if (dayBars5.length < 10) continue;

    // Prior day close
    const prevDayIdx = tradingDays.indexOf(day) - 1;
    if (prevDayIdx >= 0) {
      const prevBars = dayMap.get(tradingDays[prevDayIdx]);
      if (prevBars?.length) priorDayClose = prevBars[prevBars.length - 1].c;
    }

    const dayStart = equity;

    for (let i = 12; i < dayBars5.length; i++) {
      const { h, m, ts } = toET(dayBars5[i].t);
      const curPrice = dayBars5[i].c;

      // Position monitoring (every bar = every 5 min)
      if (position) {
        const cur = curPrice;
        position.maxPrice = Math.max(position.maxPrice, cur);
        position.minPrice = Math.min(position.minPrice, cur);

        // Premium proxy: use price change from entry as premium change %
        const pricePctChange = (cur - position.entrySpot) / position.entrySpot;
        const premiumMove = position.direction === 'CALL' ? pricePctChange : -pricePctChange;
        const curPremium = position.entryPremium * (1 + premiumMove * 3); // 3x leverage proxy for ATM 0DTE

        position.currentPremium = curPremium;
        position.maxPremium = Math.max(position.maxPremium, curPremium);
        position.minPremium = Math.min(position.minPremium, curPremium);

        let exitReason = null;

        // Hard stop
        if (curPremium <= position.stopPrice) exitReason = 'PREMIUM_STOP';
        // ATR stop (pre-TP1)
        else if (!position.tp1Hit && curPremium <= position.atrStop) exitReason = 'ATR_STOP';
        // TP1 partial
        else if (!position.tp1Hit && curPremium >= position.tp1Price) {
          position.tp1Hit = true;
          if (trailBreakeven) position.stopPrice = position.entryPremium;
          // Simulate partial close: half contracts at TP1
          const partialPnl = (curPremium - position.entryPremium) * position.contracts * tp1ClosePct * 100;
          position.contracts = Math.max(1, Math.round(position.contracts * (1 - tp1ClosePct)));
          position.realizedPartial = partialPnl;
        }
        // TP2 full
        else if (position.tp1Hit && curPremium >= position.tp2Price) exitReason = 'TP2';
        // Sowmya exit (after TP1, check for opposing signal)
        else if (position.tp1Hit && i >= 2) {
          const o5 = dayBars5.slice(i-2, i+1).map(b => b.o);
          const h5 = dayBars5.slice(i-2, i+1).map(b => b.h);
          const l5 = dayBars5.slice(i-2, i+1).map(b => b.l);
          const c5 = dayBars5.slice(i-2, i+1).map(b => b.c);
          const v5 = dayBars5.slice(i-2, i+1).map(b => b.v);
          const exitSig = detectExitSignal(o5, h5, l5, c5, v5, position.direction);
          if (exitSig.exit) exitReason = 'SOWMYA_EXIT';
        }
        // Force close EOD
        if (h >= 15 && m >= 45) exitReason = 'FORCE_CLOSE_EOD';

        if (exitReason) {
          const pnl = (curPremium - position.entryPremium) * position.contracts * 100 + (position.realizedPartial || 0);
          equity += pnl;
          trades.push({
            id: position.tradeId,
            day, entryTime: position.entryTime, exitTime: ts.toISOString(),
            direction: position.direction, grade: position.grade,
            setupType: position.setupType, confidence: position.confidence,
            entrySpot: position.entrySpot, exitSpot: curPrice,
            entryPremium: position.entryPremium, exitPremium: curPremium,
            maxPremium: position.maxPremium, minPremium: position.minPremium,
            contracts: position.contracts, pnl: Math.round(pnl * 100) / 100,
            exitReason, holdBars: i - position.entryBarIdx,
            holdMins: (i - position.entryBarIdx) * 5,
            confluenceSummary: position.confluenceSummary,
          });
          position = null;
        }
      }

      // Signal evaluation (only when no position open)
      if (!position && isTradeWindow(h, m)) {
        const windowBars5 = dayBars5.slice(0, i + 1);
        const windowBars15 = dayBars15.filter(b => new Date(b.t) <= ts);

        if (windowBars5.length >= 10 && windowBars15.length >= 4) {
          const gex = synthGEX(curPrice);
          const signal = evaluateSignal({
            bars15m: windowBars15.slice(-30),
            bars5m: windowBars5.slice(-30),
            gexData: gex,
            etHour: h,
            etMinute: m,
            priorDayClose,
            minConfidence,
          });

          signals.push({
            ts: ts.toISOString(), day, time: `${h}:${String(m).padStart(2,'0')}`,
            direction: signal.direction, confidence: signal.confidence,
            grade: signal.grade, setupType: signal.setup?.type || 'none',
            tradeable: signal.tradeable,
            rejectReason: signal.rejectReasons?.[0] || null,
            zoneType: signal.zoneHit?.type || 'miss',
            confluenceSummary: signal.meta?.confluenceSummary || '',
          });

          if (signal.tradeable && signal.confidence >= minConfidence) {
            const atr = signal.meta?.atr || curPrice * 0.003;
            const estPremium = atr * 0.8;
            const limitPrice = estPremium * 1.01;
            const contracts = Math.max(1, Math.floor(riskDollars / (limitPrice * 100 * premiumStopPct)));

            position = {
              tradeId: ++tradeId,
              direction: signal.direction,
              grade: signal.grade,
              setupType: signal.setup?.type,
              confidence: signal.confidence,
              entrySpot: curPrice,
              entryPremium: limitPrice,
              currentPremium: limitPrice,
              maxPremium: limitPrice,
              minPremium: limitPrice,
              maxPrice: curPrice,
              minPrice: curPrice,
              stopPrice: limitPrice * (1 - premiumStopPct),
              atrStop: limitPrice - atr * atrStopMult,
              tp1Price: limitPrice * (1 + tp1Pct),
              tp2Price: limitPrice * (1 + tp2Pct),
              contracts,
              tp1Hit: false,
              entryTime: ts.toISOString(),
              entryBarIdx: i,
              realizedPartial: 0,
              confluenceSummary: signal.meta?.confluenceSummary || '',
            };
          }
        }
      }
    }

    // Force close any open position at EOD
    if (position) {
      const lastBar = dayBars5[dayBars5.length - 1];
      const pricePctChange = (lastBar.c - position.entrySpot) / position.entrySpot;
      const premiumMove = position.direction === 'CALL' ? pricePctChange : -pricePctChange;
      const curPremium = position.entryPremium * (1 + premiumMove * 3);
      const pnl = (curPremium - position.entryPremium) * position.contracts * 100 + (position.realizedPartial || 0);
      equity += pnl;
      trades.push({
        id: position.tradeId, day, entryTime: position.entryTime,
        exitTime: new Date(lastBar.t).toISOString(),
        direction: position.direction, grade: position.grade,
        setupType: position.setupType, confidence: position.confidence,
        entrySpot: position.entrySpot, exitSpot: lastBar.c,
        entryPremium: position.entryPremium, exitPremium: curPremium,
        maxPremium: position.maxPremium, minPremium: position.minPremium,
        contracts: position.contracts, pnl: Math.round(pnl * 100) / 100,
        exitReason: 'FORCE_CLOSE_EOD', holdBars: dayBars5.length - position.entryBarIdx,
        holdMins: (dayBars5.length - position.entryBarIdx) * 5,
        confluenceSummary: position.confluenceSummary,
      });
      position = null;
    }

    equityCurve.push({ day, equity: Math.round(equity * 100) / 100, dayPnl: Math.round((equity - dayStart) * 100) / 100 });
  }

  // Compute stats
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;

  let maxDD = 0, peak = 10000;
  for (const e of equityCurve) {
    peak = Math.max(peak, e.equity);
    maxDD = Math.min(maxDD, e.equity - peak);
  }

  const bySetup = {};
  for (const t of trades) {
    const k = `${t.setupType}/${t.grade}`;
    if (!bySetup[k]) bySetup[k] = { setup: t.setupType, grade: t.grade, trades: 0, wins: 0, pnl: 0, avgHold: 0 };
    bySetup[k].trades++;
    if (t.pnl > 0) bySetup[k].wins++;
    bySetup[k].pnl += t.pnl;
    bySetup[k].avgHold += t.holdMins;
  }
  for (const v of Object.values(bySetup)) v.avgHold = Math.round(v.avgHold / v.trades);

  const byExit = {};
  for (const t of trades) {
    if (!byExit[t.exitReason]) byExit[t.exitReason] = { count: 0, pnl: 0 };
    byExit[t.exitReason].count++;
    byExit[t.exitReason].pnl += t.pnl;
  }

  return {
    config: { days, minConfidence, premiumStopPct, tp1Pct, tp2Pct, tp1ClosePct, atrStopMult, trailBreakeven, riskDollars },
    period: { start: tradingDays[0], end: tradingDays[tradingDays.length - 1], tradingDays: tradingDays.length },
    bars: { bars5m: bars5m.length, bars15m: bars15m.length },
    summary: {
      totalTrades: trades.length,
      wins: wins.length,
      losses: losses.length,
      winRate: trades.length ? Math.round(wins.length / trades.length * 1000) / 10 : 0,
      totalPnl: Math.round(totalPnl * 100) / 100,
      avgWin: Math.round(avgWin * 100) / 100,
      avgLoss: Math.round(avgLoss * 100) / 100,
      rr: avgLoss !== 0 ? Math.round(Math.abs(avgWin / avgLoss) * 100) / 100 : 0,
      maxDrawdown: Math.round(maxDD * 100) / 100,
      avgHoldMins: trades.length ? Math.round(trades.reduce((s,t) => s + t.holdMins, 0) / trades.length) : 0,
      profitFactor: losses.length && avgLoss !== 0 ? Math.round(Math.abs(wins.reduce((s,t)=>s+t.pnl,0) / losses.reduce((s,t)=>s+t.pnl,0)) * 100) / 100 : 0,
    },
    totalSignals: signals.length,
    tradeableSignals: signals.filter(s => s.tradeable).length,
    equityCurve,
    trades,
    bySetup: Object.values(bySetup),
    byExit,
    signals: signals.filter(s => s.direction !== 'NEUTRAL').slice(0, 200),
  };
}

// Generate self-contained HTML report
function generateReport(results) {
  const R = results;
  const S = R.summary;
  const pc = v => v >= 0 ? '#00ff88' : '#ff3355';
  const pill = (text, bg, fg) => '<span class="pill" style="background:' + bg + ';color:' + fg + '">' + text + '</span>';
  const gradeColor = g => g === 'A+' ? '#00ff88' : g === 'A' ? '#22ccff' : '#ffd000';
  const gradeBg = g => gradeColor(g) + '18';

  function buildEquitySvg(pts) {
    if (!pts.length) return '<div class="dim">No data</div>';
    var w = 760, h = 200, pad = 40;
    var vals = pts.map(function(p) { return p.equity; });
    var mn = Math.min.apply(null, vals) * 0.998, mx = Math.max.apply(null, vals) * 1.002;
    var toX = function(i) { return pad + (i / (pts.length - 1 || 1)) * (w - pad * 2); };
    var toY = function(v) { return h - pad - ((v - mn) / (mx - mn || 1)) * (h - pad * 2); };
    var pathD = pts.map(function(p, i) { return (i === 0 ? 'M' : 'L') + toX(i).toFixed(1) + ',' + toY(p.equity).toFixed(1); }).join(' ');
    var baseLine = toY(10000);
    var strokeColor = vals[vals.length - 1] >= 10000 ? '#00ff88' : '#ff3355';
    var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">';
    svg += '<line x1="' + pad + '" y1="' + baseLine + '" x2="' + (w-pad) + '" y2="' + baseLine + '" stroke="#7a9ab833" stroke-dasharray="4 4"/>';
    svg += '<text x="' + (w-pad+4) + '" y="' + (baseLine+4) + '" fill="#7a9ab8" font-size="8">$10k</text>';
    svg += '<path d="' + pathD + '" fill="none" stroke="' + strokeColor + '" stroke-width="2"/>';
    var step = Math.max(1, Math.floor(pts.length / 10));
    pts.forEach(function(p, i) { if (i % step === 0) svg += '<text x="' + toX(i) + '" y="' + (h-8) + '" fill="#3d5a78" font-size="7" text-anchor="middle">' + p.day.slice(5) + '</text>'; });
    svg += '<text x="' + (pad-4) + '" y="' + (toY(mx)+4) + '" fill="#7a9ab8" font-size="8" text-anchor="end">$' + Math.round(mx) + '</text>';
    svg += '<text x="' + (pad-4) + '" y="' + (toY(mn)+4) + '" fill="#7a9ab8" font-size="8" text-anchor="end">$' + Math.round(mn) + '</text>';
    svg += '</svg>';
    return svg;
  }

  function buildDailyPnlSvg(pts) {
    if (!pts.length) return '<div class="dim">No data</div>';
    var w = 760, h = 140, pad = 40;
    var vals = pts.map(function(p) { return p.dayPnl; });
    var mx = Math.max.apply(null, vals.map(Math.abs).concat([1]));
    var barW = Math.max(4, (w - pad * 2) / pts.length - 2);
    var mid = h / 2;
    var svg = '<svg viewBox="0 0 ' + w + ' ' + h + '" width="100%" height="' + h + '">';
    svg += '<line x1="' + pad + '" y1="' + mid + '" x2="' + (w-pad) + '" y2="' + mid + '" stroke="#7a9ab833"/>';
    var step = Math.max(1, Math.floor(pts.length / 12));
    pts.forEach(function(p, i) {
      var x = pad + i * ((w - pad * 2) / pts.length);
      var barH = Math.abs(p.dayPnl) / mx * (mid - 10);
      var y = p.dayPnl >= 0 ? mid - barH : mid;
      var fill = p.dayPnl >= 0 ? '#00ff8888' : '#ff335588';
      svg += '<rect x="' + x + '" y="' + y + '" width="' + barW + '" height="' + (barH || 1) + '" fill="' + fill + '" rx="1"/>';
      if (i % step === 0) svg += '<text x="' + (x + barW/2) + '" y="' + (h-4) + '" fill="#3d5a78" font-size="7" text-anchor="middle">' + p.day.slice(5) + '</text>';
    });
    svg += '</svg>';
    return svg;
  }

  var setupRows = R.bySetup.map(function(s) {
    var wr = (s.wins / s.trades * 100).toFixed(0);
    return '<tr><td class="accent">' + s.setup + '</td><td>' + pill(s.grade, gradeBg(s.grade), gradeColor(s.grade)) + '</td><td>' + s.trades + '</td><td class="green">' + s.wins + '</td><td style="color:' + (s.wins/s.trades >= 0.5 ? '#00ff88' : '#ff3355') + '">' + wr + '%</td><td style="color:' + pc(s.pnl) + ';font-weight:700">' + (s.pnl >= 0 ? '+' : '') + '$' + s.pnl.toFixed(0) + '</td><td class="dim">' + s.avgHold + 'm</td></tr>';
  }).join('');

  var exitRows = Object.entries(R.byExit).map(function(e) {
    var reason = e[0], d = e[1], avg = d.pnl / d.count;
    return '<tr><td class="dim">' + reason + '</td><td>' + d.count + '</td><td style="color:' + pc(d.pnl) + ';font-weight:700">' + (d.pnl >= 0 ? '+' : '') + '$' + d.pnl.toFixed(0) + '</td><td style="color:' + pc(avg) + '">' + (avg >= 0 ? '+' : '') + '$' + avg.toFixed(0) + '</td></tr>';
  }).join('');

  var tradeRows = R.trades.map(function(t) {
    return '<tr class="trade-row ' + (t.pnl > 0 ? 'win-bg' : 'loss-bg') + '"><td class="dim">' + t.id + '</td><td class="dim">' + t.day + '</td><td>' + pill(t.direction, t.direction === 'CALL' ? '#00ff8818' : '#ff335518', t.direction === 'CALL' ? '#00ff88' : '#ff3355') + '</td><td>' + pill(t.grade, gradeBg(t.grade), gradeColor(t.grade)) + '</td><td class="dim">' + t.setupType + '</td><td style="color:' + (t.confidence >= 65 ? '#00ff88' : t.confidence >= 55 ? '#ffd000' : '#7a9ab8') + '">' + t.confidence + '%</td><td>$' + t.entrySpot.toFixed(2) + '</td><td>$' + t.exitSpot.toFixed(2) + '</td><td class="green">$' + t.maxPremium.toFixed(2) + '</td><td class="dim">' + t.holdMins + 'm</td><td style="color:' + pc(t.pnl) + ';font-weight:700">' + (t.pnl >= 0 ? '+' : '') + '$' + t.pnl.toFixed(0) + '</td><td class="dim">' + t.exitReason + '</td></tr>';
  }).join('');

  var finalEquity = R.equityCurve.length ? R.equityCurve[R.equityCurve.length - 1].equity : 10000;

  var html = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">';
  html += '<title>DSB v3 Backtest Report — ' + R.period.start + ' to ' + R.period.end + '</title>';
  html += '<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#060a14;color:#e0ecf8;font-family:"JetBrains Mono","Fira Code",monospace;padding:20px}h1{font-size:20px;color:#22ccff;margin-bottom:4px}.sub{font-size:11px;color:#7a9ab8;margin-bottom:20px}.grid{display:grid;gap:10px;margin-bottom:16px}.g4{grid-template-columns:repeat(4,1fr)}.card{background:#0c1524;border:1px solid #1a3050;border-radius:6px;padding:14px}.card .label{font-size:10px;color:#7a9ab8;text-transform:uppercase;letter-spacing:1px;margin-bottom:4px}.card .val{font-size:22px;font-weight:800}.card .sub2{font-size:10px;color:#3d5a78;margin-top:2px}table{width:100%;border-collapse:collapse;font-size:11px}th{padding:6px 10px;text-align:left;color:#7a9ab8;font-size:9px;text-transform:uppercase;border-bottom:1px solid #1a3050}td{padding:5px 10px;border-bottom:1px solid #1a305022}.pill{display:inline-block;padding:2px 7px;border-radius:3px;font-size:10px;font-weight:700}.green{color:#00ff88}.red{color:#ff3355}.yellow{color:#ffd000}.accent{color:#22ccff}.dim{color:#7a9ab8}.chart-container{background:#0c1524;border:1px solid #1a3050;border-radius:6px;padding:16px;margin-bottom:16px}svg text{font-family:"JetBrains Mono",monospace}.section{background:#0c1524;border:1px solid #1a3050;border-radius:6px;overflow:hidden;margin-bottom:16px}.section-header{padding:10px 16px;background:#101c30;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:1.5px;border-bottom:1px solid #1a3050}.section-body{padding:14px 16px}.trade-row:hover{background:#101c3044}.win-bg{background:#00ff8808}.loss-bg{background:#ff335508}.config-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(180px,1fr));gap:8px}.config-item{font-size:11px}.config-item span{color:#22ccff;font-weight:700}</style></head><body>';

  html += '<h1>◈ DSB v3 — Backtest Report</h1>';
  html += '<div class="sub">' + R.period.start + ' → ' + R.period.end + ' · ' + R.period.tradingDays + ' trading days · ' + R.bars.bars5m + ' bars (5m) · ' + R.bars.bars15m + ' bars (15m) · Min confidence: ' + R.config.minConfidence + '%</div>';

  // Summary cards
  html += '<div class="grid g4">';
  html += '<div class="card"><div class="label">Total P/L</div><div class="val" style="color:' + pc(S.totalPnl) + '">' + (S.totalPnl >= 0 ? '+' : '') + '$' + S.totalPnl.toFixed(0) + '</div><div class="sub2">' + S.totalTrades + ' trades</div></div>';
  html += '<div class="card"><div class="label">Win Rate</div><div class="val" style="color:' + (S.winRate >= 50 ? '#00ff88' : '#ff3355') + '">' + S.winRate + '%</div><div class="sub2">' + S.wins + 'W / ' + S.losses + 'L</div></div>';
  html += '<div class="card"><div class="label">Risk:Reward</div><div class="val" style="color:' + (S.rr >= 1.5 ? '#00ff88' : '#ffd000') + '">' + S.rr + '</div><div class="sub2">Avg W: $' + S.avgWin.toFixed(0) + ' / Avg L: $' + S.avgLoss.toFixed(0) + '</div></div>';
  html += '<div class="card"><div class="label">Max Drawdown</div><div class="val red">$' + Math.abs(S.maxDrawdown).toFixed(0) + '</div><div class="sub2">Profit factor: ' + S.profitFactor + '</div></div>';
  html += '</div>';
  html += '<div class="grid g4">';
  html += '<div class="card"><div class="label">Avg Hold Time</div><div class="val accent">' + S.avgHoldMins + 'm</div></div>';
  html += '<div class="card"><div class="label">Signals Evaluated</div><div class="val accent">' + R.totalSignals + '</div><div class="sub2">' + R.tradeableSignals + ' tradeable</div></div>';
  html += '<div class="card"><div class="label">Starting Equity</div><div class="val dim">$10,000</div></div>';
  html += '<div class="card"><div class="label">Final Equity</div><div class="val" style="color:' + pc(finalEquity - 10000) + '">$' + finalEquity.toFixed(0) + '</div></div>';
  html += '</div>';

  // Equity curve
  html += '<div class="chart-container"><div style="font-size:12px;font-weight:700;color:#e0ecf8;margin-bottom:10px;text-transform:uppercase;letter-spacing:1.5px">Equity Curve</div>' + buildEquitySvg(R.equityCurve) + '</div>';

  // Daily P&L
  html += '<div class="chart-container"><div style="font-size:12px;font-weight:700;color:#e0ecf8;margin-bottom:10px;text-transform:uppercase;letter-spacing:1.5px">Daily P&L</div>' + buildDailyPnlSvg(R.equityCurve) + '</div>';

  // By setup
  html += '<div class="section"><div class="section-header">Performance by Setup</div><div class="section-body"><table><thead><tr><th>Setup</th><th>Grade</th><th>Trades</th><th>Wins</th><th>Win Rate</th><th>Total P/L</th><th>Avg Hold</th></tr></thead><tbody>' + setupRows + '</tbody></table></div></div>';

  // By exit
  html += '<div class="section"><div class="section-header">Exit Breakdown</div><div class="section-body"><table><thead><tr><th>Exit Reason</th><th>Count</th><th>Total P/L</th><th>Avg P/L</th></tr></thead><tbody>' + exitRows + '</tbody></table></div></div>';

  // Trade log
  html += '<div class="section"><div class="section-header">Trade Log (' + R.trades.length + ' trades)</div><div class="section-body" style="max-height:500px;overflow-y:auto"><table><thead><tr><th>#</th><th>Date</th><th>Dir</th><th>Grade</th><th>Setup</th><th>Conf</th><th>Entry</th><th>Exit</th><th>Max</th><th>Hold</th><th>P/L</th><th>Exit Reason</th></tr></thead><tbody>' + tradeRows + '</tbody></table></div></div>';

  // Config
  html += '<div class="section"><div class="section-header">Backtest Configuration</div><div class="section-body"><div class="config-grid">';
  html += '<div class="config-item">Min Confidence: <span>' + R.config.minConfidence + '%</span></div>';
  html += '<div class="config-item">Premium Stop: <span>' + (R.config.premiumStopPct * 100).toFixed(0) + '%</span></div>';
  html += '<div class="config-item">TP1: <span>+' + (R.config.tp1Pct * 100).toFixed(0) + '%</span></div>';
  html += '<div class="config-item">TP2: <span>+' + (R.config.tp2Pct * 100).toFixed(0) + '%</span></div>';
  html += '<div class="config-item">TP1 Close: <span>' + (R.config.tp1ClosePct * 100).toFixed(0) + '%</span></div>';
  html += '<div class="config-item">ATR Mult: <span>' + R.config.atrStopMult + '</span></div>';
  html += '<div class="config-item">Trail BE: <span>' + (R.config.trailBreakeven ? 'Yes' : 'No') + '</span></div>';
  html += '<div class="config-item">Risk/Trade: <span>$' + R.config.riskDollars + '</span></div>';
  html += '</div></div></div>';

  html += '<div style="padding:12px 0;text-align:center;font-size:9px;color:#3d5a78">Generated ' + new Date().toISOString() + ' · DSB v3 Backtester · Strategy: S&D + Delta + GEX · Synthetic GEX (no historical FlashAlpha data)</div>';
  html += '</body></html>';
  return html;
}

// Export for use as module or run as CLI
module.exports = { runBacktest, generateReport };

if (require.main === module) {
  runBacktest({ days: 20, minConfidence: 55 })
    .then(results => {
      const html = generateReport(results);
      const fs = require('fs');
      const outPath = 'backtest-report.html';
      fs.writeFileSync(outPath, html);
      console.log(`\n[BT] Report written to ${outPath}`);
      console.log(`[BT] ${results.summary.totalTrades} trades | Win rate: ${results.summary.winRate}% | P/L: $${results.summary.totalPnl.toFixed(0)} | Max DD: $${results.summary.maxDrawdown.toFixed(0)}`);
    })
    .catch(e => { console.error('[BT] Error:', e.message); process.exit(1); });
}
