import React, { useState, useEffect, useCallback } from "react";

const C = {
  bg:"#060a14", panel:"#0c1524", panelB:"#101c30", border:"#1a3050",
  accent:"#22ccff", accentD:"#0077aa", green:"#00ff88", greenD:"#003d1a",
  red:"#ff3355", redD:"#3d0011", yellow:"#ffd000", orange:"#ff8822",
  purple:"#aa55ff", muted:"#2a4a6a", text:"#e0ecf8", dim:"#7a9ab8", faint:"#3d5a78",
};
const api = {
  get: p => fetch(p).then(r => r.json()),
  post: (p, b) => fetch(p, { method:'POST', headers:{'Content-Type':'application/json'}, body: b ? JSON.stringify(b) : undefined }).then(r => r.json()),
};
const fmt = {
  pct: v => v != null ? `${v > 0 ? '+' : ''}${Number(v).toFixed(1)}%` : '—',
  usd: v => v != null ? `${v >= 0 ? '+' : ''}$${Math.abs(Number(v)).toFixed(0)}` : '—',
  price: v => v != null ? `$${Number(v).toFixed(2)}` : '—',
  time: ts => ts ? new Date(ts).toLocaleTimeString() : '—',
  date: ts => ts ? new Date(ts).toLocaleDateString() : '—',
};

function Pill({color, children, sm}) {
  return <span style={{display:'inline-block',padding:sm?'2px 6px':'3px 10px',borderRadius:4,fontSize:sm?10:12,fontWeight:700,background:color+'22',border:`1px solid ${color}55`,color,letterSpacing:0.5,whiteSpace:'nowrap'}}>{children}</span>;
}
function Card({label, value, color, sub, small}) {
  return (
    <div style={{padding:'12px 16px',background:C.panel,border:`1px solid ${C.border}`,borderRadius:6}}>
      <div style={{fontSize:11,color:C.dim,textTransform:'uppercase',letterSpacing:1.5,marginBottom:4}}>{label}</div>
      <div style={{fontSize:small?18:24,fontWeight:800,color:color||C.text,lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:11,color:C.faint,marginTop:3}}>{sub}</div>}
    </div>
  );
}
function Sec({title,badge,children,collapsible=false,defaultOpen=true}) {
  const [open,setOpen]=useState(defaultOpen);
  return (
    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:7,overflow:'hidden',marginBottom:10}}>
      <div onClick={()=>collapsible&&setOpen(p=>!p)} style={{padding:'10px 16px',borderBottom:open?`1px solid ${C.border}`:'none',display:'flex',alignItems:'center',gap:8,cursor:collapsible?'pointer':'default',background:C.panelB}}>
        <span style={{fontSize:12,fontWeight:700,color:C.text,textTransform:'uppercase',letterSpacing:1.5}}>{title}</span>
        {badge}
        {collapsible&&<span style={{marginLeft:'auto',color:C.dim,fontSize:13}}>{open?'▾':'▸'}</span>}
      </div>
      {open&&children}
    </div>
  );
}
function Toggle({label,checked,onChange}) {
  return (
    <label style={{display:'flex',alignItems:'center',gap:10,cursor:'pointer'}}>
      <div onClick={onChange} style={{width:38,height:20,borderRadius:10,position:'relative',background:checked?C.green:C.muted,transition:'background 0.2s',border:`1px solid ${checked?C.green:C.border}`,cursor:'pointer'}}>
        <div style={{position:'absolute',top:2,left:checked?18:2,width:14,height:14,borderRadius:'50%',background:checked?'#fff':C.dim,transition:'left 0.2s'}}/>
      </div>
      <span style={{fontSize:13,color:checked?C.text:C.dim}}>{label}</span>
    </label>
  );
}
function NumInput({label,value,onChange,min,max,step,pre,suf}) {
  const [v,setV]=useState(String(value));
  useEffect(()=>setV(String(value)),[value]);
  return (
    <div style={{display:'flex',flexDirection:'column',gap:4}}>
      <label style={{fontSize:11,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>{label}</label>
      <div style={{display:'flex',alignItems:'center',gap:5}}>
        {pre&&<span style={{fontSize:12,color:C.dim}}>{pre}</span>}
        <input type="number" value={v} min={min} max={max} step={step||1} onChange={e=>setV(e.target.value)} onBlur={()=>{const n=parseFloat(v);if(!isNaN(n))onChange(n);else setV(String(value));}}
          style={{width:82,padding:'5px 8px',background:C.bg,border:`1px solid ${C.border}`,color:C.text,borderRadius:4,fontSize:13,fontFamily:'inherit',outline:'none'}}/>
        {suf&&<span style={{fontSize:12,color:C.dim}}>{suf}</span>}
      </div>
    </div>
  );
}

// ── GEX Panel (3 tickers) ─────────────────────────────────────────────────────
function GEXPanel({gexAll, onRefresh}) {
  if (!gexAll?.SPY) return (
    <div style={{padding:20,color:C.dim,fontSize:13,textAlign:'center'}}>
      <div style={{marginBottom:10}}>GEX not loaded — market hours only</div>
      <button onClick={onRefresh} style={{padding:'7px 18px',background:C.accentD,border:`1px solid ${C.accent}55`,color:C.accent,borderRadius:5,cursor:'pointer',fontSize:12,fontFamily:'inherit'}}>Fetch GEX</button>
    </div>
  );
  const tickers = ['SPY','QQQ','SPX'];
  return (
    <div style={{padding:'14px 16px',display:'flex',flexDirection:'column',gap:12}}>
      <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
        {gexAll.multiAligned
          ? <Pill color={C.green}>✓ ALL 3 ALIGNED — STRONGEST SIGNAL</Pill>
          : <Pill color={C.yellow}>⚡ MIXED REGIMES — WAIT FOR CONFIRMATION</Pill>}
        <button onClick={onRefresh} style={{marginLeft:'auto',padding:'6px 14px',background:C.accentD,border:`1px solid ${C.accent}55`,color:C.accent,borderRadius:4,cursor:'pointer',fontSize:11,fontFamily:'inherit'}}>↻ Refresh</button>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:8}}>
        {tickers.map(t => {
          const g = gexAll[t];
          if (!g) return <div key={t} style={{padding:'10px 12px',background:C.panelB,borderRadius:5,border:`1px solid ${C.border}`,fontSize:12,color:C.dim}}>{t}: —</div>;
          const rC = g.regime==='EXPANSIVE' ? C.red : C.green;
          return (
            <div key={t} style={{padding:'10px 12px',background:C.panelB,borderRadius:5,border:`1px solid ${C.border}`}}>
              <div style={{display:'flex',alignItems:'center',gap:6,marginBottom:6}}>
                <span style={{fontSize:14,fontWeight:800,color:C.accent}}>{t}</span>
                <Pill color={rC} sm>{g.regime}</Pill>
              </div>
              {[['Anchor',g.anchor,C.accent],['Flip',g.flip,C.yellow],['Call Wall',g.callWall||g.wallAbove,C.red],['Put Wall',g.putWall||g.wallBelow,C.green],['0DTE Magnet',g.zeroDteMagnet,C.purple]].filter(([,,v])=>v!==undefined).map(([l,v,c])=>(
                <div key={l} style={{display:'flex',justifyContent:'space-between',fontSize:11,marginBottom:3}}>
                  <span style={{color:C.dim}}>{l}</span>
                  <span style={{color:c,fontWeight:700}}>{v?`$${v}`:' —'}</span>
                </div>
              ))}
              {g.source==='flashalpha'&&<Pill color={C.purple} sm>FlashAlpha</Pill>}
              {g.gexVexAgreement===false&&<div style={{fontSize:10,color:C.orange,marginTop:4}}>⚠ GEX/VEX disagree</div>}
            </div>
          );
        })}
      </div>
      {gexAll.lastFetch&&<div style={{fontSize:10,color:C.faint}}>Updated: {fmt.time(gexAll.lastFetch)}</div>}
    </div>
  );
}

// ── Zone Viz ──────────────────────────────────────────────────────────────────
function ZoneViz({zones, price, gex}) {
  const all=[...(zones?.supply||[]).map(z=>({...z,t:'supply'})),...(zones?.demand||[]).map(z=>({...z,t:'demand'}))];
  const pts=[...all.flatMap(z=>[z.top,z.bottom])];
  if (price) pts.push(price);
  if (gex?.anchor) pts.push(gex.anchor);
  if (gex?.flip)   pts.push(gex.flip);
  if (!pts.length) return <div style={{padding:20,color:C.dim,fontSize:11,textAlign:'center'}}>No zones detected</div>;
  const mn=Math.min(...pts)*0.9994,mx=Math.max(...pts)*1.0006,rng=mx-mn||1;
  const toY=p=>((mx-p)/rng)*180;
  return (
    <svg width="100%" height={200} style={{overflow:'visible'}}>
      {all.map((z,i)=>{
        const c=z.t==='supply'?C.red:C.green;
        return <g key={i}><rect x="2%" y={toY(z.top)} width="78%" height={Math.max(toY(z.bottom)-toY(z.top),2)} fill={c+'13'} stroke={c+'44'} strokeWidth={1}/><text x="82%" y={(toY(z.top)+toY(z.bottom))/2+4} fill={c} fontSize={9} fontFamily="monospace">{z.t==='supply'?'▼':'▲'}</text><text x="2%" y={toY(z.top)-2} fill={c+'88'} fontSize={8} fontFamily="monospace">${z.top?.toFixed(2)}</text></g>;
      })}
      {gex?.anchor&&<><line x1="2%" y1={toY(gex.anchor)} x2="80%" y2={toY(gex.anchor)} stroke={C.accent} strokeWidth={1} strokeDasharray="3 3"/><text x="81%" y={toY(gex.anchor)+4} fill={C.accent} fontSize={8} fontFamily="monospace">A</text></>}
      {gex?.flip&&<><line x1="2%" y1={toY(gex.flip)} x2="80%" y2={toY(gex.flip)} stroke={C.yellow} strokeWidth={1} strokeDasharray="2 2"/><text x="81%" y={toY(gex.flip)+4} fill={C.yellow} fontSize={8} fontFamily="monospace">F</text></>}
      {price&&<><line x1="2%" y1={toY(price)} x2="80%" y2={toY(price)} stroke={C.text} strokeWidth={1.5} strokeDasharray="5 2"/><text x="81%" y={toY(price)+4} fill={C.text} fontSize={9} fontFamily="monospace">${price?.toFixed(2)}</text></>}
    </svg>
  );
}

// ── Signal Panel ──────────────────────────────────────────────────────────────
function SignalPanel({signal}) {
  if (!signal) return <div style={{padding:24,color:C.dim,fontSize:13,textAlign:'center'}}>Waiting for first scan...</div>;
  const dC=signal.direction==='CALL'?C.green:signal.direction==='PUT'?C.red:C.muted;
  const cC=signal.confidence>=75?C.green:signal.confidence>=60?C.yellow:C.dim;
  return (
    <div style={{padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
      <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
        <div style={{fontSize:36,fontWeight:900,color:dC,letterSpacing:-1}}>{signal.direction}</div>
        {signal.grade&&<Pill color={{'A+':C.green,A:C.accent,B:C.yellow}[signal.grade]||C.dim}>Grade {signal.grade}</Pill>}
        <div><div style={{fontSize:11,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>Confidence</div><div style={{fontSize:24,fontWeight:800,color:cC}}>{signal.confidence}%</div></div>
        <div style={{marginLeft:'auto',textAlign:'right'}}><div style={{fontSize:11,color:C.dim}}>SPY</div><div style={{fontSize:18,fontWeight:700,color:C.text}}>{fmt.price(signal.meta?.lastPrice)}</div></div>
      </div>
      <div style={{height:5,background:C.border,borderRadius:3}}><div style={{width:`${signal.confidence}%`,height:'100%',background:`linear-gradient(90deg,${cC},${cC}66)`,borderRadius:3,transition:'width 0.5s'}}/></div>
      {signal.setup&&(
        <div style={{padding:'8px 12px',background:C.panelB,borderRadius:5,border:`1px solid ${C.border}`}}>
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:4}}>
            <Pill color={dC} sm>{signal.setup.type}</Pill>
            <span style={{fontSize:12,color:C.dim}}>{signal.setup.desc}</span>
          </div>
          {signal.meta?.delta!=null&&<div style={{fontSize:12}}>Delta: <span style={{color:signal.meta.delta<0?C.red:C.green,fontWeight:700}}>{signal.meta.delta?.toFixed(0)}</span> <span style={{color:C.dim,fontSize:11}}>{signal.meta.delta<0?'(sellers trapped — bull confirmation)':'(buyers trapped — bear confirmation)'}</span></div>}
        </div>
      )}
      {signal.zoneHit?.hit&&<div style={{display:'flex',alignItems:'center',gap:8}}><Pill color={signal.zoneHit.type==='demand'?C.green:C.red}>{signal.zoneHit.type==='demand'?'▲ AT DEMAND':'▼ AT SUPPLY'}</Pill>{signal.zoneHit.zone&&<span style={{fontSize:12,color:C.dim}}>${signal.zoneHit.zone.bottom?.toFixed(2)} – ${signal.zoneHit.zone.top?.toFixed(2)}</span>}</div>}
      {signal.meta?.confluenceSummary&&(
        <div style={{padding:'8px 12px',background:C.panelB,borderRadius:5,border:`1px solid ${C.accent}44`,fontSize:12,color:C.text,lineHeight:1.5}}>
          <span style={{color:C.accent,fontWeight:700,fontSize:11,textTransform:'uppercase',letterSpacing:0.8}}>Why this fired: </span>
          {signal.meta.confluenceSummary}
        </div>
      )}
      <div style={{display:'flex',gap:14,flexWrap:'wrap',fontSize:12,color:C.dim}}>
        {signal.meta?.sessionVWAP&&<span>VWAP: <span style={{color:C.yellow}}>{fmt.price(signal.meta.sessionVWAP)}</span></span>}
        {signal.meta?.ema9&&<span>EMA9: <span style={{color:C.accent}}>{fmt.price(signal.meta.ema9)}</span></span>}
        {signal.meta?.atr&&<span>ATR: <span style={{color:C.orange}}>{fmt.price(signal.meta.atr)}</span></span>}
        {signal.meta?.gexRegime&&<span>GEX: <span style={{color:signal.meta.gexRegime==='EXPANSIVE'?C.red:C.green}}>{signal.meta.gexRegime}</span></span>}
        <span style={{marginLeft:'auto',fontSize:10}}>{fmt.time(signal.timestamp)}</span>
      </div>
      {([...(signal.gexAnalysis?.details||[]),...(signal.addlConf?.details||[])]).length>0&&(
        <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
          {[...(signal.gexAnalysis?.details||[]),...(signal.addlConf?.details||[])].map((d,i)=>(
            <Pill key={i} color={d.color==='green'?C.green:d.color==='red'?C.red:C.yellow} sm>{d.label}</Pill>
          ))}
        </div>
      )}
      {signal.rejectReasons?.length>0&&<div style={{padding:'6px 12px',background:C.redD,border:`1px solid ${C.red}44`,borderRadius:4,fontSize:12,color:C.red}}>✗ {signal.rejectReasons[0]}</div>}
    </div>
  );
}

// ── Positions ────────────────────────────────────────────────────────────────
// Click a row to expand/collapse the full confluence explanation — keeps the
// main table compact while still surfacing the WHY behind every open trade.
function Positions({positions, onClose}) {
  const pos=Object.values(positions||{});
  const [expanded, setExpanded] = useState(null);
  if (!pos.length) return <div style={{padding:24,color:C.dim,fontSize:13,textAlign:'center'}}>No open positions</div>;
  return (
    <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
        <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>{['Symbol','Dir','Grade','Qty','Entry','Current','Max','Min','P/L','Stop','TP1','TP2','Setup',''].map(h=><th key={h} style={{padding:'6px 10px',color:C.dim,textAlign:'left',fontSize:10,textTransform:'uppercase',letterSpacing:0.8,whiteSpace:'nowrap'}}>{h}</th>)}</tr></thead>
        <tbody>{pos.map(p=>{
          const pC=(p.unrealizedPnL||0)>0?C.green:(p.unrealizedPnL||0)<0?C.red:C.dim;
          const isOpen = expanded === p.symbol;
          return <React.Fragment key={p.symbol}>
            <tr onClick={()=>setExpanded(isOpen?null:p.symbol)} style={{borderBottom:isOpen?'none':`1px solid ${C.border}22`,cursor:'pointer'}}>
              <td style={{padding:'7px 10px',color:C.accent,fontWeight:700,fontSize:11}}>{isOpen?'▾ ':'▸ '}{p.symbol?.slice(-14)}</td>
              <td style={{padding:'7px 10px'}}><Pill color={p.direction==='CALL'?C.green:C.red} sm>{p.direction}</Pill></td>
              <td style={{padding:'7px 10px'}}><Pill color={p.grade==='A+'?C.green:p.grade==='A'?C.accent:C.yellow} sm>{p.grade}</Pill></td>
              <td style={{padding:'7px 10px',color:C.text}}>{p.contracts}x</td>
              <td style={{padding:'7px 10px',color:C.text,fontWeight:600}}>{fmt.price(p.entryPremium)}</td>
              <td style={{padding:'7px 10px',color:C.text,fontWeight:600}}>{fmt.price(p.currentPrice)}</td>
              <td style={{padding:'7px 10px',color:C.green,fontSize:11,fontWeight:600}} title='Highest premium seen while held'>{fmt.price(p.maxPremium)}</td>
              <td style={{padding:'7px 10px',color:C.red,fontSize:11,fontWeight:600}} title='Lowest premium seen while held'>{fmt.price(p.minPremium)}</td>
              <td style={{padding:'7px 10px',color:pC,fontWeight:700}}>{fmt.pct(p.pnlPct)}<span style={{fontSize:10,marginLeft:4}}>({fmt.usd(p.unrealizedPnL)})</span></td>
              <td style={{padding:'7px 10px',color:C.red,fontSize:11}}>{fmt.price(p.stopPrice)}</td>
              <td style={{padding:'7px 10px',color:C.yellow,fontSize:11}}>{fmt.price(p.tp1Price)}</td>
              <td style={{padding:'7px 10px',color:C.green,fontSize:11}}>{fmt.price(p.tp2Price)}</td>
              <td style={{padding:'7px 10px',color:C.dim,fontSize:11}}>{p.setupType}</td>
              <td style={{padding:'7px 10px'}}><button onClick={(e)=>{e.stopPropagation();onClose(p.symbol);}} style={{padding:'3px 10px',fontSize:11,background:C.redD,border:`1px solid ${C.red}55`,color:C.red,borderRadius:3,cursor:'pointer',fontFamily:'inherit'}}>✕</button></td>
            </tr>
            {isOpen&&(
              <tr style={{borderBottom:`1px solid ${C.border}22`}}>
                <td colSpan={14} style={{padding:'10px 16px',background:C.panelB}}>
                  <div style={{fontSize:11,color:C.accent,fontWeight:700,textTransform:'uppercase',letterSpacing:0.8,marginBottom:4}}>Entry confluence</div>
                  <div style={{fontSize:12,color:C.text,lineHeight:1.6}}>{p.confluenceSummary || p.setupDesc || 'No confluence summary recorded'}</div>
                </td>
              </tr>
            )}
          </React.Fragment>;
        })}</tbody>
      </table>
    </div>
  );
}

// ── Trades ───────────────────────────────────────────────────────────────────
// trades comes from /api/trades as one row per DB record (ENTRY and EXIT are
// the SAME row — updated in place — since saveTradeEntry inserts and
// saveTradeExit UPDATEs the same trade_id row rather than adding a new one).
// So each item already has both entry (premium/limit_price) and exit
// (exit_price) fields plus max/min watermark and pnl on a single record.
function Trades({trades}) {
  const [expanded, setExpanded] = useState(null);
  if (!trades?.length) return <div style={{padding:24,color:C.dim,fontSize:13,textAlign:'center'}}>No trades yet</div>;
  return (
    <div style={{maxHeight:380,overflowY:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
        <thead style={{position:'sticky',top:0,background:C.panel}}><tr style={{borderBottom:`1px solid ${C.border}`}}>{['Time','Symbol','Status','Dir','Grade','Setup','Qty','Entry','Exit','Max','Min','P/L','Exit Reason'].map(h=><th key={h} style={{padding:'6px 10px',color:C.dim,textAlign:'left',fontSize:10,textTransform:'uppercase',letterSpacing:0.8,whiteSpace:'nowrap'}}>{h}</th>)}</tr></thead>
        <tbody>{trades.map(t=>{
          const pC=(t.pnl||0)>0?C.green:(t.pnl||0)<0?C.red:C.dim;
          const entryVal = t.limit_price ?? t.premium;
          const isOpen = expanded === t.id;
          const hasDetail = !!(t.confluence_summary || t.exit_strategy_label);
          return <React.Fragment key={t.id}>
            <tr onClick={()=>hasDetail&&setExpanded(isOpen?null:t.id)} style={{borderBottom:isOpen?'none':`1px solid ${C.border}22`,cursor:hasDetail?'pointer':'default'}}>
              <td style={{padding:'6px 10px',color:C.dim,whiteSpace:'nowrap',fontSize:11}}>{hasDetail?(isOpen?'▾ ':'▸ '):''}{fmt.time(t.ts)}</td>
              <td style={{padding:'6px 10px',color:C.accent,fontSize:10,fontWeight:600}}>{t.option_symbol?.slice(-12)||t.ticker}</td>
              <td style={{padding:'6px 10px'}}><Pill color={t.status==='CLOSED'?C.dim:C.green} sm>{t.status||'—'}</Pill></td>
              <td style={{padding:'6px 10px'}}><Pill color={t.direction==='CALL'?C.green:C.red} sm>{t.direction}</Pill></td>
              <td style={{padding:'6px 10px'}}><Pill color={t.grade==='A+'?C.green:t.grade==='A'?C.accent:C.yellow} sm>{t.grade||'—'}</Pill></td>
              <td style={{padding:'6px 10px',color:C.dim,fontSize:11}}>{t.setup_type||'—'}</td>
              <td style={{padding:'6px 10px',color:C.text}}>{t.contracts}x</td>
              <td style={{padding:'6px 10px',color:C.text,fontWeight:700}}>{fmt.price(entryVal)}</td>
              <td style={{padding:'6px 10px',color:t.exit_price!=null?C.text:C.faint,fontWeight:700}}>{t.exit_price!=null?fmt.price(t.exit_price):'open'}</td>
              <td style={{padding:'6px 10px',color:C.green,fontSize:11,fontWeight:600}} title='Highest premium seen while held'>{fmt.price(t.max_premium)}</td>
              <td style={{padding:'6px 10px',color:C.red,fontSize:11,fontWeight:600}} title='Lowest premium seen while held'>{fmt.price(t.min_premium)}</td>
              <td style={{padding:'6px 10px',color:pC,fontWeight:700}}>{t.pnl!=null?fmt.usd(t.pnl):'—'}{t.pnl_pct!=null&&<span style={{fontSize:10,marginLeft:4,opacity:0.9}}>({fmt.pct(t.pnl_pct)})</span>}</td>
              <td style={{padding:'6px 10px',color:C.dim,fontSize:10}} title={t.exit_strategy_label||''}>{t.exit_reason||'—'}</td>
            </tr>
            {isOpen&&hasDetail&&(
              <tr style={{borderBottom:`1px solid ${C.border}22`}}>
                <td colSpan={13} style={{padding:'10px 16px',background:C.panelB}}>
                  {t.confluence_summary&&(
                    <div style={{marginBottom:t.exit_strategy_label?8:0}}>
                      <div style={{fontSize:11,color:C.accent,fontWeight:700,textTransform:'uppercase',letterSpacing:0.8,marginBottom:3}}>Entry confluence</div>
                      <div style={{fontSize:12,color:C.text,lineHeight:1.6}}>{t.confluence_summary}</div>
                    </div>
                  )}
                  {t.exit_strategy_label&&(
                    <div>
                      <div style={{fontSize:11,color:C.yellow,fontWeight:700,textTransform:'uppercase',letterSpacing:0.8,marginBottom:3}}>Exit strategy</div>
                      <div style={{fontSize:12,color:C.text,lineHeight:1.6}}>{t.exit_strategy_label}</div>
                    </div>
                  )}
                </td>
              </tr>
            )}
          </React.Fragment>;
        })}</tbody>
      </table>
    </div>
  );
}

// ── Performance Matrix ────────────────────────────────────────────────────────
function PerfMatrix({stats, dailyPnL, acct, setupBreakdown}) {
  const s = stats || {};
  const wr = s.total_trades>0?((s.wins/s.total_trades)*100).toFixed(1):'—';
  const rr = s.avg_loss&&s.avg_loss<0?(Math.abs(s.avg_win||0)/Math.abs(s.avg_loss)).toFixed(2):'—';
  const dPct = acct>0?((dailyPnL/acct)*100).toFixed(2):'0';
  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:10,padding:'14px 16px'}}>
        <Card label="Win Rate"    value={`${wr}%`} color={parseFloat(wr)>=50?C.green:C.red} sub={`${s.wins||0}W / ${s.losses||0}L`}/>
        <Card label="Daily P/L"  value={`${dailyPnL>=0?'+':''}$${(dailyPnL||0).toFixed(0)}`} color={dailyPnL>=0?C.green:C.red} sub={`${dPct}%`}/>
        <Card label="Total P/L"  value={`${(s.total_pnl||0)>=0?'+':''}$${(s.total_pnl||0).toFixed(0)}`} color={(s.total_pnl||0)>=0?C.green:C.red} sub={`${s.total_trades||0} trades`}/>
        <Card label="R:R"        value={rr} color={parseFloat(rr)>=1.5?C.green:C.yellow} sub={`Avg hold ${(s.avg_hold_mins||0).toFixed(0)}m`}/>
      </div>
      {setupBreakdown?.length>0&&(
        <div style={{padding:'0 16px 14px',overflowX:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
            <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>{['Setup','Grade','Trades','Wins','Total P/L','Avg P/L','Avg Hold'].map(h=><th key={h} style={{padding:'6px 10px',color:C.dim,textAlign:'left',fontSize:10,textTransform:'uppercase'}}>{h}</th>)}</tr></thead>
            <tbody>{setupBreakdown.map((r,i)=>(
              <tr key={i} style={{borderBottom:`1px solid ${C.border}22`}}>
                <td style={{padding:'6px 10px',color:C.accent,fontSize:11}}>{r.setup_type}</td>
                <td style={{padding:'6px 10px'}}><Pill color={r.grade==='A+'?C.green:r.grade==='A'?C.accent:C.yellow} sm>{r.grade}</Pill></td>
                <td style={{padding:'6px 10px',color:C.text}}>{r.total}</td>
                <td style={{padding:'6px 10px',color:C.green}}>{r.wins}</td>
                <td style={{padding:'6px 10px',color:(r.total_pnl||0)>=0?C.green:C.red,fontWeight:700}}>{fmt.usd(r.total_pnl)}</td>
                <td style={{padding:'6px 10px',color:(r.avg_pnl||0)>=0?C.green:C.red}}>{fmt.usd(r.avg_pnl)}</td>
                <td style={{padding:'6px 10px',color:C.dim}}>{(r.avg_hold||0).toFixed(0)}m</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Analytics Tab (DB data mining) ───────────────────────────────────────────
function Analytics({dbStats, signals}) {
  const [filter, setFilter] = useState({ grade:'', direction:'', tradeable:'' });
  const filteredSigs = (signals||[]).filter(s =>
    (!filter.grade     || s.grade===filter.grade) &&
    (!filter.direction || s.direction===filter.direction) &&
    (!filter.tradeable || String(s.tradeable)===filter.tradeable)
  );
  const daily = dbStats?.daily||[];
  return (
    <div style={{display:'flex',flexDirection:'column',gap:10}}>
      <Sec title="Daily P&L History (30 Days)">
        <div style={{padding:'12px 16px',overflowX:'auto'}}>
          {daily.length===0?<div style={{color:C.dim,fontSize:13}}>No closed trades yet</div>:(
            <div style={{display:'flex',gap:4,alignItems:'flex-end',height:90}}>
              {daily.slice(0,30).reverse().map((d,i)=>{
                const pnl=d.daily_pnl||0;
                const h=Math.min(Math.abs(pnl)/10,80);
                return <div key={i} title={`${d.day}: ${fmt.usd(pnl)}`} style={{display:'flex',flexDirection:'column',alignItems:'center',gap:3,minWidth:16}}>
                  <div style={{width:12,height:h||3,background:pnl>=0?C.green:C.red,borderRadius:2,opacity:0.9}}/>
                  <div style={{fontSize:8,color:C.faint,transform:'rotate(-45deg)',whiteSpace:'nowrap'}}>{d.day?.slice(5)}</div>
                </div>;
              })}
            </div>
          )}
        </div>
      </Sec>
      <Sec title="Signal Log — All Evaluated Signals">
        <div style={{padding:'10px 16px',display:'flex',gap:12,flexWrap:'wrap',borderBottom:`1px solid ${C.border}`}}>
          {[['grade',['','A+','A','B']],['direction',['','CALL','PUT','NEUTRAL']],['tradeable',['','1','0']]].map(([key,opts])=>(
            <select key={key} value={filter[key]} onChange={e=>setFilter(p=>({...p,[key]:e.target.value}))}
              style={{padding:'4px 10px',background:C.bg,border:`1px solid ${C.border}`,color:C.text,borderRadius:4,fontSize:12,fontFamily:'inherit'}}>
              {opts.map(o=><option key={o} value={o}>{key}: {o||'all'}</option>)}
            </select>
          ))}
          <span style={{fontSize:11,color:C.dim,alignSelf:'center'}}>{filteredSigs.length} signals</span>
        </div>
        <div style={{maxHeight:360,overflowY:'auto'}}>
          <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
            <thead style={{position:'sticky',top:0,background:C.panel}}><tr style={{borderBottom:`1px solid ${C.border}`}}>{['Time','Dir','Conf','Grade','Setup','Zone','VWAP pos','GEX','SPY/QQQ/SPX','Tradeable','Reject'].map(h=><th key={h} style={{padding:'5px 8px',color:C.dim,textAlign:'left',fontSize:9,textTransform:'uppercase'}}>{h}</th>)}</tr></thead>
            <tbody>{filteredSigs.map(s=>(
              <tr key={s.id} style={{borderBottom:`1px solid ${C.border}18`,background:s.tradeable?C.greenD+'22':'transparent'}}>
                <td style={{padding:'5px 8px',color:C.dim,whiteSpace:'nowrap'}}>{fmt.time(s.ts)}</td>
                <td style={{padding:'5px 8px'}}><Pill color={s.direction==='CALL'?C.green:s.direction==='PUT'?C.red:C.muted} sm>{s.direction}</Pill></td>
                <td style={{padding:'5px 8px',color:s.confidence>=75?C.green:s.confidence>=60?C.yellow:C.dim,fontWeight:700}}>{s.confidence}%</td>
                <td style={{padding:'5px 8px'}}>{s.grade?<Pill color={s.grade==='A+'?C.green:s.grade==='A'?C.accent:C.yellow} sm>{s.grade}</Pill>:'—'}</td>
                <td style={{padding:'5px 8px',color:C.dim}}>{s.setup_type||'—'}</td>
                <td style={{padding:'5px 8px',color:s.zone_type==='demand'?C.green:s.zone_type==='supply'?C.red:C.faint}}>{s.zone_type||'—'}</td>
                <td style={{padding:'5px 8px',color:C.dim}}>{s.session_vwap?fmt.price(s.session_vwap):'—'}</td>
                <td style={{padding:'5px 8px',color:s.gex_regime==='EXPANSIVE'?C.red:s.gex_regime==='CONTROLLED'?C.green:C.faint,fontSize:10}}>{s.gex_regime||'—'}</td>
                <td style={{padding:'5px 8px',fontSize:10}}>
                  {[['S',s.spy_regime],['Q',s.qqq_regime],['X',s.spx_regime]].map(([l,r])=>(
                    <span key={l} style={{color:r==='EXPANSIVE'?C.red:r==='CONTROLLED'?C.green:C.faint,marginRight:4}}>{l}:{r?r[0]:'?'}</span>
                  ))}
                  {s.multi_aligned?<Pill color={C.green} sm>✓</Pill>:''}
                </td>
                <td style={{padding:'5px 8px'}}><Pill color={s.tradeable?C.green:C.muted} sm>{s.tradeable?'YES':'NO'}</Pill></td>
                <td style={{padding:'5px 8px',color:C.faint,fontSize:10,maxWidth:140,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>
                  {s.reject_reasons?JSON.parse(s.reject_reasons||'[]')[0]||'—':'—'}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Sec>
    </div>
  );
}

// ── Config ────────────────────────────────────────────────────────────────────
function ConfigPanel({config, onSave}) {
  const [cfg,setCfg]=useState({...config});
  const [saved,setSaved]=useState(false);
  useEffect(()=>setCfg({...config}),[config]);
  const s=(k,v)=>setCfg(p=>({...p,[k]:v}));
  const save=async()=>{await onSave(cfg);setSaved(true);setTimeout(()=>setSaved(false),2000);};
  return (
    <div style={{padding:16}}>
      {cfg.AUTO_TRADE&&<div style={{padding:'10px 16px',background:C.redD,border:`1px solid ${C.red}55`,borderRadius:5,marginBottom:14,fontSize:12,color:C.red}}>⚠️ AUTO TRADE ON — live orders on Alpaca paper account</div>}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:20}}>
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div style={{fontSize:10,color:C.accent,textTransform:'uppercase',letterSpacing:2,fontWeight:700}}>Risk</div>
          <NumInput label="Risk/Trade ($)" value={cfg.RISK_DOLLARS} onChange={v=>s('RISK_DOLLARS',v)} min={50} max={5000} step={50} pre="$"/>
          <NumInput label="Account Size ($)" value={cfg.ACCOUNT_SIZE} onChange={v=>s('ACCOUNT_SIZE',v)} min={1000} max={1e6} step={1000} pre="$"/>
          <NumInput label="Max Daily Loss %" value={(cfg.MAX_DAILY_LOSS*100).toFixed(1)} onChange={v=>s('MAX_DAILY_LOSS',v/100)} min={1} max={20} step={0.5} suf="%"/>
          <NumInput label="Premium Stop %" value={(cfg.PREMIUM_STOP_PCT*100).toFixed(0)} onChange={v=>s('PREMIUM_STOP_PCT',v/100)} min={10} max={100} step={5} suf="%"/>
          <NumInput label="Min Confidence %" value={cfg.MIN_CONFIDENCE} onChange={v=>s('MIN_CONFIDENCE',v)} min={50} max={95} step={5} suf="%"/>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div style={{fontSize:10,color:C.accent,textTransform:'uppercase',letterSpacing:2,fontWeight:700}}>Exits</div>
          <NumInput label="TP1 %" value={(cfg.TP1_PCT*100).toFixed(0)} onChange={v=>s('TP1_PCT',v/100)} min={10} max={200} step={5} suf="%"/>
          <NumInput label="TP2 %" value={(cfg.TP2_PCT*100).toFixed(0)} onChange={v=>s('TP2_PCT',v/100)} min={20} max={500} step={10} suf="%"/>
          <NumInput label="TP1 Close Size %" value={(cfg.TP1_CLOSE_PCT*100).toFixed(0)} onChange={v=>s('TP1_CLOSE_PCT',v/100)} min={10} max={100} step={10} suf="%"/>
          <NumInput label="ATR Multiplier" value={cfg.ATR_STOP_MULT} onChange={v=>s('ATR_STOP_MULT',v)} min={0.5} max={5} step={0.25}/>
          <div style={{display:'flex',flexDirection:'column',gap:4}}>
            <label style={{fontSize:11,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>Force Close (ET)</label>
            <input value={cfg.FORCE_CLOSE_ET} onChange={e=>s('FORCE_CLOSE_ET',e.target.value)} style={{width:100,padding:'5px 8px',background:C.bg,border:`1px solid ${C.border}`,color:C.text,borderRadius:4,fontSize:13,fontFamily:'inherit'}}/>
          </div>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          <div style={{fontSize:10,color:C.accent,textTransform:'uppercase',letterSpacing:2,fontWeight:700}}>Strategy</div>
          <Toggle label="Auto Trade" checked={!!cfg.AUTO_TRADE} onChange={()=>s('AUTO_TRADE',!cfg.AUTO_TRADE)}/>
          <Toggle label="Tiered Sizing (A+:1.5× A:1× B:0.75×)" checked={!!cfg.TIERED_SIZING} onChange={()=>s('TIERED_SIZING',!cfg.TIERED_SIZING)}/>
          <Toggle label="Trail Stop to BE @ TP1" checked={!!cfg.TRAIL_BREAKEVEN} onChange={()=>s('TRAIL_BREAKEVEN',!cfg.TRAIL_BREAKEVEN)}/>
          <div style={{padding:'10px 12px',background:C.panelB,border:`1px solid ${C.border}`,borderRadius:4,fontSize:12,color:C.dim,lineHeight:1.8}}>
            <div style={{color:C.text,fontWeight:700,marginBottom:4}}>Active Levels</div>
            <div>Stop: <span style={{color:C.red}}>−{(cfg.PREMIUM_STOP_PCT*100).toFixed(0)}%</span></div>
            <div>TP1: <span style={{color:C.yellow}}>+{(cfg.TP1_PCT*100).toFixed(0)}% → close {(cfg.TP1_CLOSE_PCT*100).toFixed(0)}%</span></div>
            <div>TP2: <span style={{color:C.green}}>+{(cfg.TP2_PCT*100).toFixed(0)}%</span></div>
          </div>
        </div>
      </div>
      <div style={{marginTop:16,display:'flex',gap:10,alignItems:'center'}}>
        <button onClick={save} style={{padding:'8px 24px',background:`linear-gradient(135deg,${C.accent},${C.accentD})`,color:C.bg,border:'none',borderRadius:5,cursor:'pointer',fontSize:13,fontWeight:700,fontFamily:'inherit'}}>{saved?'✓ Saved':'Save Config'}</button>
        <span style={{fontSize:11,color:C.dim}}>Changes apply immediately — no restart</span>
      </div>
    </div>
  );
}

function Logs({logs}) {
  return (
    <div style={{padding:'10px 14px',height:280,overflowY:'auto',fontFamily:'monospace',fontSize:11}}>
      {!logs?.length?<div style={{color:C.dim}}>No logs...</div>:logs.map((l,i)=>{
        const line=typeof l==='string'?l:l.line;
        const lvl=typeof l==='string'?'INFO':l.level;
        const c=lvl==='ERROR'?C.red:lvl==='WARN'?C.yellow:line?.includes('ENTRY')||line?.includes('EXIT')||line?.includes('TP')?C.green:C.dim;
        return <div key={i} style={{color:c,marginBottom:3,lineHeight:1.5}}>{line}</div>;
      })}
    </div>
  );
}

// ── Quick Controls (dashboard inline) ─────────────────────────────────────────
function QuickControls({config, onSave}) {
  const [cfg,setCfg]=useState({...config});
  const [dirty,setDirty]=useState(false);
  const [saved,setSaved]=useState(false);
  useEffect(()=>{setCfg({...config});setDirty(false);},[config]);
  const s=(k,v)=>{setCfg(p=>({...p,[k]:v}));setDirty(true);};
  const save=async()=>{await onSave(cfg);setDirty(false);setSaved(true);setTimeout(()=>setSaved(false),1500);};
  return (
    <div style={{padding:'12px 16px',display:'flex',flexDirection:'column',gap:10}}>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:16}}>
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          <div style={{fontSize:10,color:C.accent,textTransform:'uppercase',letterSpacing:2,fontWeight:700}}>Entry</div>
          <NumInput label="Min Confidence %" value={cfg.MIN_CONFIDENCE} onChange={v=>s('MIN_CONFIDENCE',v)} min={30} max={95} step={5} suf="%"/>
          <div style={{height:5,background:C.border,borderRadius:3,marginTop:2}}>
            <div style={{width:`${((cfg.MIN_CONFIDENCE-30)/65)*100}%`,height:'100%',background:cfg.MIN_CONFIDENCE>70?C.red:cfg.MIN_CONFIDENCE>55?C.yellow:C.green,borderRadius:3,transition:'width 0.3s'}}/>
          </div>
          <div style={{fontSize:10,color:C.faint}}>{cfg.MIN_CONFIDENCE>70?'Strict — few trades':''}
            {cfg.MIN_CONFIDENCE<=70&&cfg.MIN_CONFIDENCE>55?'Moderate — balanced':''}
            {cfg.MIN_CONFIDENCE<=55?'Loose — more signals fire':''}</div>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          <div style={{fontSize:10,color:C.red,textTransform:'uppercase',letterSpacing:2,fontWeight:700}}>Stop Loss</div>
          <NumInput label="Premium Stop %" value={(cfg.PREMIUM_STOP_PCT*100).toFixed(0)} onChange={v=>s('PREMIUM_STOP_PCT',v/100)} min={10} max={80} step={5} suf="%"/>
          <NumInput label="ATR Multiplier" value={cfg.ATR_STOP_MULT} onChange={v=>s('ATR_STOP_MULT',v)} min={0.5} max={5} step={0.25}/>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          <div style={{fontSize:10,color:C.green,textTransform:'uppercase',letterSpacing:2,fontWeight:700}}>Take Profit</div>
          <NumInput label="TP1 %" value={(cfg.TP1_PCT*100).toFixed(0)} onChange={v=>s('TP1_PCT',v/100)} min={10} max={200} step={5} suf="%"/>
          <NumInput label="TP2 %" value={(cfg.TP2_PCT*100).toFixed(0)} onChange={v=>s('TP2_PCT',v/100)} min={20} max={500} step={10} suf="%"/>
          <NumInput label="TP1 Close %" value={(cfg.TP1_CLOSE_PCT*100).toFixed(0)} onChange={v=>s('TP1_CLOSE_PCT',v/100)} min={10} max={100} step={10} suf="%"/>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:10}}>
          <div style={{fontSize:10,color:C.yellow,textTransform:'uppercase',letterSpacing:2,fontWeight:700}}>Toggles</div>
          <Toggle label="Trail Stop → BE at TP1" checked={!!cfg.TRAIL_BREAKEVEN} onChange={()=>s('TRAIL_BREAKEVEN',!cfg.TRAIL_BREAKEVEN)}/>
          <Toggle label="Auto Trade" checked={!!cfg.AUTO_TRADE} onChange={()=>s('AUTO_TRADE',!cfg.AUTO_TRADE)}/>
          <Toggle label="Tiered Sizing" checked={!!cfg.TIERED_SIZING} onChange={()=>s('TIERED_SIZING',!cfg.TIERED_SIZING)}/>
          <div style={{padding:'8px 10px',background:C.panelB,border:`1px solid ${C.border}`,borderRadius:4,fontSize:11,color:C.dim,lineHeight:1.7}}>
            Stop: <span style={{color:C.red}}>−{(cfg.PREMIUM_STOP_PCT*100).toFixed(0)}%</span>{' · '}
            TP1: <span style={{color:C.yellow}}>+{(cfg.TP1_PCT*100).toFixed(0)}%</span>{' · '}
            TP2: <span style={{color:C.green}}>+{(cfg.TP2_PCT*100).toFixed(0)}%</span>
          </div>
        </div>
      </div>
      {dirty&&<div style={{display:'flex',gap:10,alignItems:'center'}}>
        <button onClick={save} style={{padding:'6px 18px',background:`linear-gradient(135deg,${C.accent},${C.accentD})`,color:C.bg,border:'none',borderRadius:4,cursor:'pointer',fontSize:12,fontWeight:700,fontFamily:'inherit'}}>Apply Changes</button>
        <span style={{fontSize:11,color:C.yellow}}>Unsaved changes</span>
      </div>}
      {saved&&<span style={{fontSize:11,color:C.green}}>✓ Applied — takes effect next scan cycle</span>}
    </div>
  );
}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [data,setData]=useState(null);
  const [logs,setLogs]=useState([]);
  const [trades,setTrades]=useState([]);
  const [signals,setSignals]=useState([]);
  const [dbStats,setDbStats]=useState(null);
  const [tab,setTab]=useState('dashboard');
  const [scanning,setScanning]=useState(false);
  const [err,setErr]=useState(null);

  const refresh=useCallback(async()=>{
    try {
      const [s,l,t] = await Promise.all([api.get('/api/state'),api.get('/api/logs'),api.get('/api/trades')]);
      setData(s); setLogs(l); setTrades(t); setErr(null);
    } catch(e){ setErr('Server unreachable'); }
  },[]);

  const loadAnalytics=useCallback(async()=>{
    try {
      const [st,si]=await Promise.all([api.get('/api/stats'),api.get('/api/signals')]);
      setDbStats(st); setSignals(si);
    } catch(_){}
  },[]);

  useEffect(()=>{ refresh(); const t=setInterval(refresh,7000); return ()=>clearInterval(t); },[refresh]);
  useEffect(()=>{ if(tab==='analytics'){ loadAnalytics(); const t=setInterval(loadAnalytics,30000); return ()=>clearInterval(t); } },[tab,loadAnalytics]);

  const close=async sym=>{if(!window.confirm(`Close ${sym.slice(-14)}?`))return;await api.post(`/api/close/${encodeURIComponent(sym)}`);refresh();};
  const scan=async()=>{setScanning(true);await api.post('/api/scan');await refresh();setScanning(false);};
  const gexR=async()=>{await api.post('/api/gex-refresh');refresh();};
  const saveC=async cfg=>{await api.post('/api/config',cfg);refresh();};
  const reset=async()=>{if(!window.confirm('Reset circuit breaker?'))return;await api.post('/api/reset-daily');refresh();};

  const posCount=data?Object.keys(data.positions||{}).length:0;
  const isAuto=data?.config?.AUTO_TRADE;
  const mkt=data?.marketOpen;
  const cb=data?.cbTriggered;
  const dailyPnL=data?.dailyPnL||0;
  const gexAll=data?.gexAll;

  // Faster polling when positions are open
  const pollMs = posCount > 0 ? 3000 : 7000;
  useEffect(()=>{ const t=setInterval(refresh,pollMs); return ()=>clearInterval(t); },[refresh,pollMs]);

  const TABS=[['dashboard','Dashboard'],['analytics','Analytics'],['config','Config']];

  return (
    <div style={{minHeight:'100vh',background:C.bg,color:C.text,fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace"}}>
      {/* Header */}
      <div style={{background:C.panel,borderBottom:`1px solid ${C.border}`,padding:'12px 20px',display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:16,fontWeight:900,color:C.accent,letterSpacing:-0.3}}>◈ DSB v3 — S&D + DELTA + GEX <span style={{fontSize:11,color:C.purple,fontWeight:700,marginLeft:6,padding:'1px 8px',background:C.purple+'18',border:`1px solid ${C.purple}44`,borderRadius:4}}>FlashAlpha Branch</span></div>
          <div style={{fontSize:9,color:C.dim,letterSpacing:1.5,marginTop:2}}>ALPACA NATIVE · FLASHALPHA GEX · SPY+QQQ+SPX · SQLITE</div>
        </div>
        <div style={{display:'flex',gap:6,flexWrap:'wrap',marginLeft:8}}>
          <Pill color={mkt?C.green:C.muted}>{mkt?'● MARKET OPEN':'● CLOSED'}</Pill>
          <Pill color={isAuto?C.green:C.yellow}>{isAuto?'⚡ AUTO TRADE':'◎ SIGNAL ONLY'}</Pill>
          {cb&&<Pill color={C.red}>⛔ CIRCUIT BREAKER</Pill>}
          {data?.config?.PAPER!==false&&<Pill color={C.purple}>PAPER</Pill>}
          {posCount>0&&<Pill color={C.accent}>{posCount} OPEN</Pill>}
          {gexAll?.multiAligned&&<Pill color={C.green}>3-TICKER ALIGNED</Pill>}
          {gexAll?.source==='flashalpha'&&<Pill color={C.purple}>FlashAlpha</Pill>}
        </div>
        {data&&<div style={{marginLeft:'auto',textAlign:'right'}}>
          <div style={{fontSize:9,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>Daily P/L</div>
          <div style={{fontSize:20,fontWeight:800,color:dailyPnL>=0?C.green:C.red}}>{dailyPnL>=0?'+':''}${dailyPnL.toFixed(2)}</div>
        </div>}
        <div style={{display:'flex',gap:8}}>
          <button onClick={scan} disabled={scanning||!data} style={{padding:'7px 16px',background:scanning?C.muted:`linear-gradient(135deg,${C.accent},${C.accentD})`,color:C.bg,border:'none',borderRadius:5,cursor:'pointer',fontSize:12,fontWeight:700,fontFamily:'inherit'}}>{scanning?'⏳':'▶ Scan'}</button>
          {cb&&<button onClick={reset} style={{padding:'7px 14px',background:C.redD,border:`1px solid ${C.red}55`,color:C.red,borderRadius:5,cursor:'pointer',fontSize:12,fontFamily:'inherit'}}>Reset CB</button>}
        </div>
      </div>
      {err&&<div style={{padding:'8px 20px',background:C.redD,color:C.red,fontSize:12}}>⚠ {err}</div>}

      {/* Tabs */}
      <div style={{display:'flex',background:C.panel,borderBottom:`1px solid ${C.border}`}}>
        {TABS.map(([id,lbl])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:'10px 20px',fontSize:12,background:'transparent',color:tab===id?C.accent:C.dim,borderBottom:tab===id?`2px solid ${C.accent}`:'2px solid transparent',border:'none',cursor:'pointer',fontFamily:'inherit',fontWeight:tab===id?700:400}}>{lbl}</button>
        ))}
      </div>

      <div style={{padding:'14px 20px',maxWidth:1400}}>
        {tab==='dashboard'&&(<>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <Sec title="Latest Signal" badge={data?.lastSignal&&<Pill color={data.lastSignal.direction==='CALL'?C.green:data.lastSignal.direction==='PUT'?C.red:C.muted} sm>{data.lastSignal.direction}</Pill>}>
              <SignalPanel signal={data?.lastSignal}/>
            </Sec>
            <Sec title="GEX — SPY · QQQ · SPX (Dealer Positioning)">
              <GEXPanel gexAll={gexAll} onRefresh={gexR}/>
            </Sec>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <Sec title="S&D Zone Map (15m) + GEX Levels" collapsible>
              <div style={{padding:'8px 14px'}}>
                <ZoneViz zones={data?.zones} price={data?.lastSignal?.meta?.lastPrice} gex={data?.gexAll?.SPY}/>
                <div style={{display:'flex',gap:14,marginTop:6,fontSize:11,color:C.dim}}>
                  <span><span style={{color:C.green}}>▲</span> Demand: {data?.zones?.demand?.length||0}</span>
                  <span><span style={{color:C.red}}>▼</span> Supply: {data?.zones?.supply?.length||0}</span>
                  <span>A=Anchor F=Flip (SPY)</span>
                </div>
              </div>
            </Sec>
            <Sec title="Performance (from DB)" collapsible>
              {data&&<PerfMatrix stats={dbStats?.summary} dailyPnL={dailyPnL} acct={data.config?.ACCOUNT_SIZE||100000} setupBreakdown={dbStats?.bySetup}/>}
            </Sec>
          </div>
          <Sec title="Trading Controls — Entry · Stop · TP" collapsible>
            {data?.config&&<QuickControls config={data.config} onSave={saveC}/>}
          </Sec>
          <Sec title="Open Positions" badge={posCount>0&&<Pill color={C.accent} sm>{posCount}</Pill>}><Positions positions={data?.positions} onClose={close}/></Sec>
          <Sec title="Trade History (DB)" badge={trades.length>0&&<Pill color={C.dim} sm>{trades.length}</Pill>} collapsible defaultOpen={false}><Trades trades={trades}/></Sec>
          <Sec title="System Logs" collapsible defaultOpen={false}><Logs logs={logs}/></Sec>
        </>)}

        {tab==='analytics'&&(
          <Analytics dbStats={dbStats} signals={signals}/>
        )}

        {tab==='config'&&(
          <Sec title="Live Configuration">
            {data?.config&&<ConfigPanel config={data.config} onSave={saveC}/>}
          </Sec>
        )}
      </div>
      <div style={{padding:'10px 20px',borderTop:`1px solid ${C.border}`,background:C.panel,fontSize:10,color:C.faint,textAlign:'center'}}>
        ⚠ PAPER TRADING — All signals from Alpaca live data · No TradingView dependency · SQLite logging enabled · Auto-refreshes {posCount > 0 ? '3s' : '7s'}
      </div>
    </div>
  );
}
