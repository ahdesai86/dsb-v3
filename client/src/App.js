import { useState, useEffect, useCallback } from "react";

const C = {
  bg:"#04070e",panel:"#080f1a",panelB:"#0b1422",border:"#112030",borderHi:"#1a3a5a",
  accent:"#00b8ff",accentD:"#005588",green:"#00e87a",greenD:"#004422",
  red:"#ff2244",redD:"#550011",yellow:"#f5c000",orange:"#ff7700",
  purple:"#9944ff",muted:"#1e3a55",text:"#c8ddf0",dim:"#4a6a88",faint:"#253a50",
};

const api = {
  get:  p     => fetch(p).then(r=>r.json()),
  post: (p,b) => fetch(p,{method:'POST',headers:{'Content-Type':'application/json'},body:b?JSON.stringify(b):undefined}).then(r=>r.json()),
};

function Pill({color,children,sm}) {
  return <span style={{display:'inline-block',padding:sm?'1px 5px':'2px 8px',borderRadius:3,fontSize:sm?9:10,fontWeight:700,background:color+'1a',border:`1px solid ${color}44`,color,letterSpacing:0.5,whiteSpace:'nowrap'}}>{children}</span>;
}

function Card({label,value,color,sub,small}) {
  return (
    <div style={{padding:'10px 14px',background:C.panel,border:`1px solid ${C.border}`,borderRadius:6}}>
      <div style={{fontSize:9,color:C.dim,textTransform:'uppercase',letterSpacing:1.5,marginBottom:3}}>{label}</div>
      <div style={{fontSize:small?16:22,fontWeight:800,color:color||C.text,lineHeight:1}}>{value}</div>
      {sub&&<div style={{fontSize:9,color:C.faint,marginTop:2}}>{sub}</div>}
    </div>
  );
}

function Toggle({label,checked,onChange}) {
  return (
    <label style={{display:'flex',alignItems:'center',gap:8,cursor:'pointer',userSelect:'none'}}>
      <div onClick={onChange} style={{width:34,height:18,borderRadius:9,position:'relative',background:checked?C.green:C.muted,transition:'background 0.2s',cursor:'pointer',border:`1px solid ${checked?C.green:C.border}`}}>
        <div style={{position:'absolute',top:2,left:checked?16:2,width:12,height:12,borderRadius:'50%',background:checked?'#fff':C.dim,transition:'left 0.2s'}}/>
      </div>
      <span style={{fontSize:11,color:checked?C.text:C.dim}}>{label}</span>
    </label>
  );
}

function NumInput({label,value,onChange,min,max,step,pre,suf}) {
  const [v,setV]=useState(String(value));
  useEffect(()=>setV(String(value)),[value]);
  return (
    <div style={{display:'flex',flexDirection:'column',gap:3}}>
      <label style={{fontSize:9,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>{label}</label>
      <div style={{display:'flex',alignItems:'center',gap:4}}>
        {pre&&<span style={{fontSize:10,color:C.dim}}>{pre}</span>}
        <input type="number" value={v} min={min} max={max} step={step||1}
          onChange={e=>setV(e.target.value)}
          onBlur={()=>{const n=parseFloat(v);if(!isNaN(n))onChange(n);else setV(String(value));}}
          style={{width:76,padding:'4px 7px',background:C.bg,border:`1px solid ${C.border}`,color:C.text,borderRadius:4,fontSize:11,fontFamily:'inherit',outline:'none'}}/>
        {suf&&<span style={{fontSize:10,color:C.dim}}>{suf}</span>}
      </div>
    </div>
  );
}

function GEXPanel({gex,lastFetch,onRefresh}) {
  if (!gex) return (
    <div style={{padding:20,color:C.dim,fontSize:11,textAlign:'center'}}>
      <div style={{marginBottom:12}}>GEX not loaded — market hours only</div>
      <button onClick={onRefresh} style={{padding:'6px 16px',background:C.accentD,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:5,cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>Fetch GEX</button>
    </div>
  );
  const rC=gex.regime==='EXPANSIVE'?C.red:C.green;
  return (
    <div style={{padding:'14px 16px',display:'flex',flexDirection:'column',gap:12}}>
      <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}>
        {[['Regime',gex.regime,rC],['Anchor',gex.anchor,C.accent],['Flip',gex.flip||'—',C.yellow],['Wall ↑',gex.wallAbove||'—',C.red],['Wall ↓',gex.wallBelow||'—',C.green]].map(([l,v,c])=>(
          <div key={l}><div style={{fontSize:9,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>{l}</div><div style={{fontSize:l==='Regime'?18:16,fontWeight:800,color:c}}>{v}</div></div>
        ))}
        <button onClick={onRefresh} style={{marginLeft:'auto',padding:'5px 12px',background:C.accentD,border:`1px solid ${C.accent}44`,color:C.accent,borderRadius:4,cursor:'pointer',fontSize:9,fontFamily:'inherit'}}>↻ Refresh</button>
      </div>
      <div style={{fontSize:9,color:C.dim}}>
        {gex.regime==='EXPANSIVE'?'⚡ Negative GEX — momentum follows through. Respect direction, don\'t fade.':'🔒 Positive GEX — controlled tape, mean-reversion favored. Fade extremes at walls.'}
      </div>
      {gex.walls?.length>0&&(
        <div style={{display:'flex',flexWrap:'wrap',gap:5}}>
          {gex.walls.slice(0,6).map((w,i)=>(
            <div key={i} style={{padding:'2px 7px',background:w.net>0?C.greenD:C.redD,border:`1px solid ${w.net>0?C.green:C.red}44`,borderRadius:3,fontSize:10}}>
              <span style={{color:C.text,fontWeight:700}}>${w.strike}</span>
              <span style={{color:w.net>0?C.green:C.red,fontSize:8,marginLeft:3}}>{w.net>0?'+':''}{(w.net/1e6).toFixed(1)}M</span>
            </div>
          ))}
        </div>
      )}
      {lastFetch&&<div style={{fontSize:8,color:C.faint}}>Updated: {new Date(lastFetch).toLocaleTimeString()}</div>}
    </div>
  );
}

function ZoneViz({zones,price,gex}) {
  if (!zones) return null;
  const all=[...(zones.supply||[]).map(z=>({...z,t:'supply'})),...(zones.demand||[]).map(z=>({...z,t:'demand'}))];
  const pts=[...all.flatMap(z=>[z.top,z.bottom])];
  if (price) pts.push(price);
  if (gex?.anchor) pts.push(gex.anchor);
  if (gex?.flip)   pts.push(gex.flip);
  if (!pts.length) return <div style={{padding:20,color:C.dim,fontSize:11,textAlign:'center'}}>No zones detected yet</div>;
  const mn=Math.min(...pts)*0.9994,mx=Math.max(...pts)*1.0006,rng=mx-mn||1;
  const toY=p=>((mx-p)/rng)*180;
  return (
    <svg width="100%" height={200} style={{overflow:'visible'}}>
      {all.map((z,i)=>{
        const c=z.t==='supply'?C.red:C.green;
        return(<g key={i}>
          <rect x="2%" y={toY(z.top)} width="78%" height={Math.max(toY(z.bottom)-toY(z.top),2)} fill={c+'13'} stroke={c+'44'} strokeWidth={1}/>
          <text x="82%" y={(toY(z.top)+toY(z.bottom))/2+4} fill={c} fontSize={9} fontFamily="monospace">{z.t==='supply'?'▼':'▲'}</text>
          <text x="2%" y={toY(z.top)-2} fill={c+'88'} fontSize={8} fontFamily="monospace">${z.top?.toFixed(2)}</text>
        </g>);
      })}
      {gex?.anchor&&<><line x1="2%" y1={toY(gex.anchor)} x2="80%" y2={toY(gex.anchor)} stroke={C.accent} strokeWidth={1} strokeDasharray="3 3"/><text x="81%" y={toY(gex.anchor)+4} fill={C.accent} fontSize={8} fontFamily="monospace">A</text></>}
      {gex?.flip&&<><line x1="2%" y1={toY(gex.flip)} x2="80%" y2={toY(gex.flip)} stroke={C.yellow} strokeWidth={1} strokeDasharray="2 2"/><text x="81%" y={toY(gex.flip)+4} fill={C.yellow} fontSize={8} fontFamily="monospace">F</text></>}
      {price&&<><line x1="2%" y1={toY(price)} x2="80%" y2={toY(price)} stroke={C.text} strokeWidth={1.5} strokeDasharray="5 2"/><text x="81%" y={toY(price)+4} fill={C.text} fontSize={9} fontFamily="monospace">${price?.toFixed(2)}</text></>}
    </svg>
  );
}

function SignalPanel({signal}) {
  if (!signal) return <div style={{padding:24,color:C.dim,fontSize:11,textAlign:'center'}}>Waiting for first scan...</div>;
  const dC=signal.direction==='CALL'?C.green:signal.direction==='PUT'?C.red:C.muted;
  const cC=signal.confidence>=75?C.green:signal.confidence>=60?C.yellow:C.dim;
  const gC={'A+':C.green,A:C.accent,B:C.yellow}[signal.grade]||C.dim;
  return (
    <div style={{padding:'14px 16px',display:'flex',flexDirection:'column',gap:10}}>
      <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
        <div style={{fontSize:34,fontWeight:900,color:dC,letterSpacing:-1}}>{signal.direction}</div>
        {signal.grade&&<Pill color={gC}>Grade {signal.grade}</Pill>}
        <div><div style={{fontSize:9,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>Confidence</div><div style={{fontSize:20,fontWeight:800,color:cC}}>{signal.confidence}%</div></div>
        <div style={{marginLeft:'auto',textAlign:'right'}}><div style={{fontSize:9,color:C.dim}}>SPY</div><div style={{fontSize:16,fontWeight:700,color:C.text}}>${signal.meta?.lastPrice?.toFixed(2)||'—'}</div></div>
      </div>
      <div style={{height:4,background:C.border,borderRadius:2}}><div style={{width:`${signal.confidence}%`,height:'100%',background:`linear-gradient(90deg,${cC},${cC}66)`,borderRadius:2,transition:'width 0.5s'}}/></div>
      {signal.setup&&(
        <div style={{padding:'8px 10px',background:C.panelB,borderRadius:5,border:`1px solid ${C.border}`}}>
          <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap',marginBottom:4}}>
            <Pill color={dC} sm>{signal.setup.type}</Pill>
            <span style={{fontSize:10,color:C.dim}}>{signal.setup.desc}</span>
          </div>
          {signal.meta?.delta!==undefined&&<div style={{fontSize:10}}>Delta: <span style={{color:signal.meta.delta<0?C.red:C.green,fontWeight:700}}>{signal.meta.delta?.toFixed(0)}</span><span style={{color:C.dim,fontSize:9,marginLeft:5}}>{signal.meta.delta<0?'sellers trapped at demand (bull)':'buyers trapped at supply (bear)'}</span></div>}
        </div>
      )}
      {signal.zoneHit?.hit&&<div style={{display:'flex',alignItems:'center',gap:8}}><Pill color={signal.zoneHit.type==='demand'?C.green:C.red}>{signal.zoneHit.type==='demand'?'▲ AT DEMAND':'▼ AT SUPPLY'}</Pill>{signal.zoneHit.zone&&<span style={{fontSize:10,color:C.dim}}>${signal.zoneHit.zone.bottom?.toFixed(2)} – ${signal.zoneHit.zone.top?.toFixed(2)}</span>}</div>}
      <div style={{display:'flex',gap:12,flexWrap:'wrap',fontSize:10,color:C.dim}}>
        {signal.meta?.sessionVWAP&&<span>VWAP: <span style={{color:C.yellow}}>${signal.meta.sessionVWAP?.toFixed(2)}</span></span>}
        {signal.meta?.ema9&&<span>EMA9: <span style={{color:C.accent}}>${signal.meta.ema9?.toFixed(2)}</span></span>}
        {signal.meta?.atr&&<span>ATR: <span style={{color:C.orange}}>${signal.meta.atr?.toFixed(2)}</span></span>}
        {signal.meta?.gexRegime&&<span>GEX: <span style={{color:signal.meta.gexRegime==='EXPANSIVE'?C.red:C.green}}>{signal.meta.gexRegime}</span></span>}
        <span style={{marginLeft:'auto',fontSize:8}}>{signal.timestamp&&new Date(signal.timestamp).toLocaleTimeString()}</span>
      </div>
      {(signal.gexAnalysis?.details?.length>0||signal.addlConf?.details?.length>0)&&(
        <div style={{display:'flex',flexWrap:'wrap',gap:4}}>
          {[...(signal.gexAnalysis?.details||[]),...(signal.addlConf?.details||[])].map((d,i)=>(
            <Pill key={i} color={d.color==='green'?C.green:d.color==='red'?C.red:C.yellow} sm>{d.label}</Pill>
          ))}
        </div>
      )}
      {signal.rejectReasons?.length>0&&<div style={{padding:'5px 10px',background:C.redD,border:`1px solid ${C.red}33`,borderRadius:4,fontSize:10,color:C.red}}>✗ {signal.rejectReasons[0]}</div>}
    </div>
  );
}

function Positions({positions,onClose}) {
  const pos=Object.values(positions||{});
  if (!pos.length) return <div style={{padding:24,color:C.dim,fontSize:11,textAlign:'center'}}>No open positions</div>;
  return (
    <div style={{overflowX:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:10}}>
        <thead><tr style={{borderBottom:`1px solid ${C.border}`}}>
          {['Symbol','Dir','Grade','Qty','Entry','Current','P/L','Stop','TP1','TP2','Setup',''].map(h=><th key={h} style={{padding:'5px 8px',color:C.dim,textAlign:'left',fontSize:8,textTransform:'uppercase',letterSpacing:0.8,whiteSpace:'nowrap'}}>{h}</th>)}
        </tr></thead>
        <tbody>{pos.map(p=>{
          const pC=(p.unrealizedPnL||0)>0?C.green:(p.unrealizedPnL||0)<0?C.red:C.dim;
          return (<tr key={p.symbol} style={{borderBottom:`1px solid ${C.border}18`}}>
            <td style={{padding:'6px 8px',color:C.accent,fontWeight:700,fontSize:9}}>{p.symbol?.slice(-14)}</td>
            <td style={{padding:'6px 8px'}}><Pill color={p.direction==='CALL'?C.green:C.red} sm>{p.direction}</Pill></td>
            <td style={{padding:'6px 8px'}}><Pill color={p.grade==='A+'?C.green:p.grade==='A'?C.accent:C.yellow} sm>{p.grade}</Pill></td>
            <td style={{padding:'6px 8px',color:C.text}}>{p.contracts}x</td>
            <td style={{padding:'6px 8px',color:C.text}}>${p.entryPremium?.toFixed(2)}</td>
            <td style={{padding:'6px 8px',color:C.text}}>{p.currentPrice?`$${p.currentPrice.toFixed(2)}`:'—'}</td>
            <td style={{padding:'6px 8px',color:pC,fontWeight:700}}>
              {p.pnlPct!==undefined?`${p.pnlPct>0?'+':''}${p.pnlPct.toFixed(1)}%`:'—'}
              {p.unrealizedPnL!==undefined&&<span style={{fontSize:8,marginLeft:3}}>({p.unrealizedPnL>0?'+':''}${p.unrealizedPnL.toFixed(0)})</span>}
            </td>
            <td style={{padding:'6px 8px',color:C.red,fontSize:9}}>${p.stopPrice?.toFixed(2)}</td>
            <td style={{padding:'6px 8px',color:C.yellow,fontSize:9}}>${p.tp1Price?.toFixed(2)}</td>
            <td style={{padding:'6px 8px',color:C.green,fontSize:9}}>${p.tp2Price?.toFixed(2)}</td>
            <td style={{padding:'6px 8px',color:C.dim,fontSize:9}}>{p.setupType}</td>
            <td style={{padding:'6px 8px'}}><button onClick={()=>onClose(p.symbol)} style={{padding:'2px 8px',fontSize:9,background:C.redD,border:`1px solid ${C.red}44`,color:C.red,borderRadius:3,cursor:'pointer',fontFamily:'inherit'}}>✕</button></td>
          </tr>);
        })}</tbody>
      </table>
    </div>
  );
}

function Trades({trades}) {
  if (!trades?.length) return <div style={{padding:24,color:C.dim,fontSize:11,textAlign:'center'}}>No trades yet</div>;
  return (
    <div style={{maxHeight:300,overflowY:'auto'}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:10}}>
        <thead style={{position:'sticky',top:0,background:C.panel}}>
          <tr style={{borderBottom:`1px solid ${C.border}`}}>
            {['Time','Symbol','Event','Dir','Grade','Setup','Qty','Price','P/L','Reason'].map(h=><th key={h} style={{padding:'4px 7px',color:C.dim,textAlign:'left',fontSize:8,textTransform:'uppercase',letterSpacing:0.8}}>{h}</th>)}
          </tr>
        </thead>
        <tbody>{trades.map(t=>{
          const pC=(t.pnl||0)>0?C.green:(t.pnl||0)<0?C.red:C.dim;
          return (<tr key={t.id} style={{borderBottom:`1px solid ${C.border}14`}}>
            <td style={{padding:'4px 7px',color:C.dim,whiteSpace:'nowrap',fontSize:9}}>{new Date(t.entryTime).toLocaleTimeString()}</td>
            <td style={{padding:'4px 7px',color:C.accent,fontSize:8}}>{t.symbol?.slice(-12)}</td>
            <td style={{padding:'4px 7px'}}><Pill color={t.event==='ENTRY'?C.accent:C.yellow} sm>{t.event}</Pill></td>
            <td style={{padding:'4px 7px'}}><Pill color={t.direction==='CALL'?C.green:C.red} sm>{t.direction}</Pill></td>
            <td style={{padding:'4px 7px'}}><Pill color={t.grade==='A+'?C.green:t.grade==='A'?C.accent:C.yellow} sm>{t.grade||'—'}</Pill></td>
            <td style={{padding:'4px 7px',color:C.dim,fontSize:9}}>{t.setupType||'—'}</td>
            <td style={{padding:'4px 7px',color:C.text}}>{t.contracts}x</td>
            <td style={{padding:'4px 7px',color:C.text}}>${t.price?.toFixed(2)}</td>
            <td style={{padding:'4px 7px',color:pC,fontWeight:700}}>{t.pnl!=null?`${t.pnl>0?'+':''}$${t.pnl.toFixed(0)}`:'—'}</td>
            <td style={{padding:'4px 7px',color:C.dim,fontSize:8}}>{t.reason||'—'}</td>
          </tr>);
        })}</tbody>
      </table>
    </div>
  );
}

function PerfMatrix({stats,dailyPnL,acct}) {
  const wr=stats.totalTrades>0?((stats.wins/stats.totalTrades)*100).toFixed(1):'—';
  const avgW=stats.wins>0?stats.totalPnL/stats.wins:0;
  const avgL=stats.losses>0?Math.abs(stats.biggestLoss):0;
  const rr=avgL>0?(avgW/avgL).toFixed(2):'—';
  const dPct=acct>0?((dailyPnL/acct)*100).toFixed(2):'0';
  return (
    <div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,padding:'12px 16px'}}>
        <Card label="Win Rate"    value={`${wr}%`} color={parseFloat(wr)>=50?C.green:C.red} sub={`${stats.wins}W / ${stats.losses}L`}/>
        <Card label="Daily P/L"  value={`${dailyPnL>=0?'+':''}$${dailyPnL.toFixed(0)}`} color={dailyPnL>=0?C.green:C.red} sub={`${dPct}%`}/>
        <Card label="Total P/L"  value={`${stats.totalPnL>=0?'+':''}$${stats.totalPnL.toFixed(0)}`} color={stats.totalPnL>=0?C.green:C.red} sub={`${stats.totalTrades} trades`}/>
        <Card label="R:R"        value={rr} color={parseFloat(rr)>=1.5?C.green:C.yellow} sub={`Avg W $${avgW.toFixed(0)}`}/>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:8,padding:'0 16px 12px'}}>
        <Card label="Best"   value={`+$${stats.biggestWin.toFixed(0)}`} color={C.green} small/>
        <Card label="Worst"  value={`$${stats.biggestLoss.toFixed(0)}`} color={C.red} small/>
        <Card label="W Streak" value={stats.winStreak} color={C.accent} sub="max" small/>
        <Card label="L Streak" value={Math.abs(stats.lossStreak)} color={C.orange} sub="max" small/>
      </div>
      {stats.setupBreakdown&&(
        <div style={{padding:'0 16px 10px',display:'flex',gap:16,flexWrap:'wrap',fontSize:10}}>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <span style={{fontSize:8,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>Setups:</span>
            {Object.entries(stats.setupBreakdown).map(([k,v])=><span key={k} style={{color:C.dim}}>{k}:<span style={{color:C.text}}>{v}</span></span>)}
          </div>
          <div style={{display:'flex',gap:8,alignItems:'center'}}>
            <span style={{fontSize:8,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>Grades:</span>
            {Object.entries(stats.gradeBreakdown).map(([k,v])=><span key={k} style={{color:k==='A+'?C.green:k==='A'?C.accent:C.yellow}}>{k}:{v}</span>)}
          </div>
        </div>
      )}
    </div>
  );
}

function ConfigPanel({config,onSave}) {
  const [cfg,setCfg]=useState({...config});
  const [saved,setSaved]=useState(false);
  useEffect(()=>setCfg({...config}),[config]);
  const s=(k,v)=>setCfg(p=>({...p,[k]:v}));
  const save=async()=>{ await onSave(cfg); setSaved(true); setTimeout(()=>setSaved(false),2000); };
  return (
    <div style={{padding:16}}>
      {cfg.AUTO_TRADE&&<div style={{padding:'8px 14px',background:C.redD,border:`1px solid ${C.red}44`,borderRadius:5,marginBottom:14,fontSize:10,color:C.red}}>⚠️ AUTO TRADE ON — live orders will be placed on Alpaca paper account</div>}
      <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:20}}>
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div style={{fontSize:8,color:C.accent,textTransform:'uppercase',letterSpacing:2,marginBottom:2}}>Risk</div>
          <NumInput label="Risk/Trade ($)"  value={cfg.RISK_DOLLARS}   onChange={v=>s('RISK_DOLLARS',v)}   min={50}   max={5000} step={50}   pre="$"/>
          <NumInput label="Account Size ($)" value={cfg.ACCOUNT_SIZE} onChange={v=>s('ACCOUNT_SIZE',v)}   min={1000} max={1e6}  step={1000} pre="$"/>
          <NumInput label="Max Daily Loss %" value={(cfg.MAX_DAILY_LOSS*100).toFixed(1)} onChange={v=>s('MAX_DAILY_LOSS',v/100)} min={1} max={20} step={0.5} suf="%"/>
          <NumInput label="Premium Stop %"  value={(cfg.PREMIUM_STOP_PCT*100).toFixed(0)} onChange={v=>s('PREMIUM_STOP_PCT',v/100)} min={10} max={100} step={5} suf="%"/>
          <NumInput label="Min Confidence %" value={cfg.MIN_CONFIDENCE} onChange={v=>s('MIN_CONFIDENCE',v)} min={50} max={95} step={5} suf="%"/>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:12}}>
          <div style={{fontSize:8,color:C.accent,textTransform:'uppercase',letterSpacing:2,marginBottom:2}}>Exits</div>
          <NumInput label="TP1 Gain %"       value={(cfg.TP1_PCT*100).toFixed(0)}       onChange={v=>s('TP1_PCT',v/100)}       min={10}  max={200} step={5}    suf="%"/>
          <NumInput label="TP2 Gain %"       value={(cfg.TP2_PCT*100).toFixed(0)}       onChange={v=>s('TP2_PCT',v/100)}       min={20}  max={500} step={10}   suf="%"/>
          <NumInput label="TP1 Close Size %" value={(cfg.TP1_CLOSE_PCT*100).toFixed(0)} onChange={v=>s('TP1_CLOSE_PCT',v/100)} min={10}  max={100} step={10}   suf="%"/>
          <NumInput label="ATR Multiplier"   value={cfg.ATR_STOP_MULT}                  onChange={v=>s('ATR_STOP_MULT',v)}     min={0.5} max={5}   step={0.25}/>
          <div style={{display:'flex',flexDirection:'column',gap:3}}>
            <label style={{fontSize:9,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>Force Close (ET)</label>
            <input value={cfg.FORCE_CLOSE_ET} onChange={e=>s('FORCE_CLOSE_ET',e.target.value)}
              style={{width:90,padding:'4px 7px',background:C.bg,border:`1px solid ${C.border}`,color:C.text,borderRadius:4,fontSize:11,fontFamily:'inherit'}}/>
          </div>
        </div>
        <div style={{display:'flex',flexDirection:'column',gap:14}}>
          <div style={{fontSize:8,color:C.accent,textTransform:'uppercase',letterSpacing:2,marginBottom:2}}>Strategy</div>
          <Toggle label="Auto Trade (Live Orders)" checked={!!cfg.AUTO_TRADE}      onChange={()=>s('AUTO_TRADE',!cfg.AUTO_TRADE)}/>
          <Toggle label="Tiered Sizing by Grade"  checked={!!cfg.TIERED_SIZING}   onChange={()=>s('TIERED_SIZING',!cfg.TIERED_SIZING)}/>
          <Toggle label="Trail Stop to BE @ TP1" checked={!!cfg.TRAIL_BREAKEVEN} onChange={()=>s('TRAIL_BREAKEVEN',!cfg.TRAIL_BREAKEVEN)}/>
          <div style={{marginTop:4,padding:'10px 12px',background:C.panelB,border:`1px solid ${C.border}`,borderRadius:5,fontSize:10,color:C.dim,lineHeight:1.8}}>
            <div style={{color:C.text,fontWeight:700,marginBottom:4}}>Current Levels</div>
            <div>Stop: <span style={{color:C.red}}>−{(cfg.PREMIUM_STOP_PCT*100).toFixed(0)}%</span></div>
            <div>TP1: <span style={{color:C.yellow}}>+{(cfg.TP1_PCT*100).toFixed(0)}% → close {(cfg.TP1_CLOSE_PCT*100).toFixed(0)}%</span></div>
            <div>TP2: <span style={{color:C.green}}>+{(cfg.TP2_PCT*100).toFixed(0)}%</span></div>
            <div>Risk: <span style={{color:C.accent}}>${cfg.RISK_DOLLARS}/trade</span></div>
            <div>Sizing: <span style={{color:C.accent}}>{cfg.TIERED_SIZING?'A+:1.5× A:1× B:0.75×':'Flat'}</span></div>
          </div>
        </div>
      </div>
      <div style={{marginTop:16,display:'flex',gap:10,alignItems:'center'}}>
        <button onClick={save} style={{padding:'7px 22px',background:`linear-gradient(135deg,${C.accent},${C.accentD})`,color:C.bg,border:'none',borderRadius:5,cursor:'pointer',fontSize:11,fontWeight:700,fontFamily:'inherit'}}>{saved?'✓ Saved':'Save Config'}</button>
        <span style={{fontSize:9,color:C.dim}}>Changes apply immediately</span>
      </div>
    </div>
  );
}

function Logs({logs}) {
  return (
    <div style={{padding:'10px 14px',height:250,overflowY:'auto',fontFamily:'monospace',fontSize:9}}>
      {!logs?.length?<div style={{color:C.dim}}>No logs...</div>:logs.map((l,i)=>{
        const line=typeof l==='string'?l:l.line;
        const lvl=typeof l==='string'?'INFO':l.level;
        const c=lvl==='ERROR'?C.red:lvl==='WARN'?C.yellow:line?.includes('ENTRY')||line?.includes('TP')||line?.includes('EXIT')?C.green:C.dim;
        return <div key={i} style={{color:c,marginBottom:2,lineHeight:1.4}}>{line}</div>;
      })}
    </div>
  );
}

function StratRef() {
  return (
    <div style={{padding:'14px 18px',display:'grid',gridTemplateColumns:'1fr 1fr',gap:20,fontSize:11}}>
      <div>
        <div style={{fontSize:9,color:C.accent,textTransform:'uppercase',letterSpacing:2,marginBottom:10}}>Sowmya's 4 Setups (Video 1)</div>
        {[
          ['SETUP 1 — A Grade','Demand + Bullish candle + Negative delta','Sellers trapped = strong bull. Enter above high, SL below low.'],
          ['SETUP 2 — A Grade','Supply + Bearish candle + Positive delta','Buyers trapped = strong bear. Enter below low, SL above high.'],
          ['SETUP 3 — B/A+ Grade','Demand + B-shape volume (vol at lows)','Absorption at demand. Limit order at high-vol node.'],
          ['SETUP 4 — B/A+ Grade','Supply + P-shape volume (vol at highs)','Distribution at supply. Limit order at high-vol node.'],
          ['A+ Upgrade','Setup 1+3 or 2+4 together (delta AND shape)','~85% win rate per Sowmya. Size up 1.5×. TP 1:5.'],
        ].map(([k,v,d])=>(
          <div key={k} style={{marginBottom:8,padding:'6px 10px',background:C.panelB,borderRadius:4,border:`1px solid ${C.border}`}}>
            <div style={{color:C.yellow,fontWeight:700,fontSize:10,marginBottom:2}}>{k}</div>
            <div style={{color:C.text,fontSize:10}}>{v}</div>
            <div style={{color:C.dim,fontSize:9,marginTop:1}}>{d}</div>
          </div>
        ))}
      </div>
      <div>
        <div style={{fontSize:9,color:C.accent,textTransform:'uppercase',letterSpacing:2,marginBottom:10}}>GEX Framework (Video 2 — 7 Steps)</div>
        {[['1. Price','Where is SPY right now'],['2. Anchor','Center of gravity — price magnet for session'],['3. Flip','Above=controlled, Below=expansive/accelerating'],['4. GEX Rating','+ = mean revert, − = respect momentum'],['5. Walls','Defense zones: stall/reject/bounce/accelerate'],['6. SPY/SPX/QQQ','All three must align — stronger confirmation'],['7. Reaction','NEVER enter blind — wait for price to confirm']].map(([k,v])=>(
          <div key={k} style={{marginBottom:6,display:'flex',gap:8}}><span style={{color:C.yellow,fontWeight:700,minWidth:80,fontSize:10}}>{k}:</span><span style={{color:C.dim,fontSize:10}}>{v}</span></div>
        ))}
        <div style={{marginTop:12,padding:'8px 10px',background:C.panelB,borderRadius:4,border:`1px solid ${C.border}`,fontSize:10,color:C.dim,lineHeight:1.7}}>
          <div style={{color:C.text,fontWeight:700,marginBottom:4}}>Our Confluence Additions</div>
          <div>Session VWAP — both videos use VWAP as key directional filter</div>
          <div>EMA 9/21 stack — structural trend alignment</div>
          <div>ATR expansion — confirms expansive GEX tape</div>
          <div>Volume filter — above-avg vol = institutional at zone</div>
          <div>NY time gates — 9:30–11:30 AM + 1:30–3:30 PM ET</div>
        </div>
      </div>
    </div>
  );
}

function Sec({title,badge,children,collapsible=false,defaultOpen=true}) {
  const [open,setOpen]=useState(defaultOpen);
  return (
    <div style={{background:C.panel,border:`1px solid ${C.border}`,borderRadius:7,overflow:'hidden',marginBottom:10}}>
      <div onClick={()=>collapsible&&setOpen(p=>!p)} style={{padding:'9px 16px',borderBottom:open?`1px solid ${C.border}`:'none',display:'flex',alignItems:'center',gap:8,cursor:collapsible?'pointer':'default',background:C.panelB}}>
        <span style={{fontSize:10,fontWeight:700,color:C.text,textTransform:'uppercase',letterSpacing:1.5}}>{title}</span>
        {badge&&badge}
        {collapsible&&<span style={{marginLeft:'auto',color:C.dim,fontSize:11}}>{open?'▾':'▸'}</span>}
      </div>
      {open&&children}
    </div>
  );
}

export default function App() {
  const [data,setData]=useState(null);
  const [logs,setLogs]=useState([]);
  const [trades,setTrades]=useState([]);
  const [tab,setTab]=useState('dashboard');
  const [scanning,setScanning]=useState(false);
  const [err,setErr]=useState(null);

  const refresh=useCallback(async()=>{
    try { const [s,l,t]=await Promise.all([api.get('/api/state'),api.get('/api/logs'),api.get('/api/trades')]); setData(s);setLogs(l);setTrades(t);setErr(null); }
    catch(e){ setErr('Server unreachable'); }
  },[]);

  useEffect(()=>{ refresh(); const t=setInterval(refresh,7000); return ()=>clearInterval(t); },[refresh]);

  const close=async sym=>{ if(!window.confirm(`Close ${sym.slice(-14)}?`))return; await api.post(`/api/close/${encodeURIComponent(sym)}`); refresh(); };
  const scan =async()=>{ setScanning(true); await api.post('/api/scan'); await refresh(); setScanning(false); };
  const gexR =async()=>{ await api.post('/api/gex-refresh'); refresh(); };
  const saveC=async cfg=>{ await api.post('/api/config',cfg); refresh(); };
  const reset=async()=>{ if(!window.confirm('Reset daily P/L and circuit breaker?'))return; await api.post('/api/reset-daily'); refresh(); };

  const posCount=data?Object.keys(data.positions||{}).length:0;
  const isAuto=data?.config?.AUTO_TRADE;
  const mkt=data?.marketOpen;
  const cb=data?.cbTriggered;

  return (
    <div style={{minHeight:'100vh',background:C.bg,color:C.text,fontFamily:"'JetBrains Mono','Fira Code','Courier New',monospace"}}>
      <div style={{background:C.panel,borderBottom:`1px solid ${C.border}`,padding:'11px 20px',display:'flex',alignItems:'center',gap:12,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:14,fontWeight:900,color:C.accent,letterSpacing:-0.3}}>◈ S&D + GEX OPTIONS BOT</div>
          <div style={{fontSize:8,color:C.dim,letterSpacing:1.5,marginTop:1}}>DELTA · B/P SHAPE · GEX ANCHOR/FLIP/WALLS · VWAP · ATR</div>
        </div>
        <div style={{display:'flex',gap:5,flexWrap:'wrap',marginLeft:8}}>
          <Pill color={mkt?C.green:C.muted}>{mkt?'● OPEN':'● CLOSED'}</Pill>
          <Pill color={isAuto?C.green:C.yellow}>{isAuto?'⚡ AUTO':'◎ MANUAL'}</Pill>
          {cb&&<Pill color={C.red}>⛔ LOSS CB</Pill>}
          {data?.config?.PAPER!==false&&<Pill color={C.purple}>PAPER</Pill>}
          {posCount>0&&<Pill color={C.accent}>{posCount} OPEN</Pill>}
          {data?.gexData&&<Pill color={data.gexData.regime==='EXPANSIVE'?C.red:C.green}>{data.gexData.regime}</Pill>}
        </div>
        {data&&<div style={{marginLeft:'auto',textAlign:'right'}}><div style={{fontSize:8,color:C.dim,textTransform:'uppercase',letterSpacing:1}}>Daily P/L</div><div style={{fontSize:16,fontWeight:800,color:data.dailyPnL>=0?C.green:C.red}}>{data.dailyPnL>=0?'+':''}${data.dailyPnL.toFixed(2)}</div></div>}
        <div style={{display:'flex',gap:6}}>
          <button onClick={scan} disabled={scanning||!data} style={{padding:'6px 14px',background:scanning?C.muted:`linear-gradient(135deg,${C.accent},${C.accentD})`,color:C.bg,border:'none',borderRadius:5,cursor:'pointer',fontSize:10,fontWeight:700,fontFamily:'inherit'}}>{scanning?'⏳':'▶ Scan'}</button>
          {cb&&<button onClick={reset} style={{padding:'6px 11px',background:C.redD,border:`1px solid ${C.red}44`,color:C.red,borderRadius:5,cursor:'pointer',fontSize:10,fontFamily:'inherit'}}>Reset CB</button>}
        </div>
      </div>
      {err&&<div style={{padding:'7px 20px',background:C.redD,color:C.red,fontSize:10}}>⚠ {err}</div>}
      <div style={{display:'flex',background:C.panel,borderBottom:`1px solid ${C.border}`}}>
        {[['dashboard','Dashboard'],['config','Config'],['strategy','Strategy']].map(([id,l])=>(
          <button key={id} onClick={()=>setTab(id)} style={{padding:'9px 18px',fontSize:10,background:'transparent',color:tab===id?C.accent:C.dim,borderBottom:tab===id?`2px solid ${C.accent}`:'2px solid transparent',border:'none',cursor:'pointer',fontFamily:'inherit',fontWeight:tab===id?700:400}}>{l}</button>
        ))}
      </div>

      <div style={{padding:'14px 20px',maxWidth:1400}}>
        {tab==='dashboard'&&(<>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <Sec title="Latest Signal" badge={data?.lastSignal&&<Pill color={data.lastSignal.direction==='CALL'?C.green:data.lastSignal.direction==='PUT'?C.red:C.muted} sm>{data.lastSignal.direction}</Pill>}>
              <SignalPanel signal={data?.lastSignal}/>
            </Sec>
            <Sec title="GEX — Dealer Positioning">
              <GEXPanel gex={data?.gexData} lastFetch={data?.gexLastFetch} onRefresh={gexR}/>
            </Sec>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:10,marginBottom:10}}>
            <Sec title="S&D Zone Map (15m) + GEX Levels" collapsible>
              <div style={{padding:'8px 14px'}}>
                <ZoneViz zones={data?.zones} price={data?.lastSignal?.meta?.lastPrice} gex={data?.gexData}/>
                <div style={{display:'flex',gap:14,marginTop:5,fontSize:9,color:C.dim}}>
                  <span><span style={{color:C.green}}>▲</span> Demand: {data?.zones?.demand?.length||0}</span>
                  <span><span style={{color:C.red}}>▼</span> Supply: {data?.zones?.supply?.length||0}</span>
                  <span>A=Anchor F=Flip</span>
                </div>
              </div>
            </Sec>
            <Sec title="Performance Matrix" collapsible>
              {data&&<PerfMatrix stats={data.stats} dailyPnL={data.dailyPnL} acct={data.config?.ACCOUNT_SIZE||100000}/>}
            </Sec>
          </div>
          <Sec title="Open Positions" badge={posCount>0&&<Pill color={C.accent} sm>{posCount}</Pill>}><Positions positions={data?.positions} onClose={close}/></Sec>
          <Sec title="Trade History" badge={trades.length>0&&<Pill color={C.dim} sm>{trades.length}</Pill>} collapsible defaultOpen={false}><Trades trades={trades}/></Sec>
          <Sec title="System Logs" collapsible defaultOpen={false}><Logs logs={logs}/></Sec>
        </>)}
        {tab==='config'&&(<Sec title="Live Configuration"><ConfigPanel config={data?.config||{}} onSave={saveC}/></Sec>)}
        {tab==='strategy'&&(<>
          <Sec title="Strategy Reference — Sowmya + Dealer's Edge"><StratRef/></Sec>
          <Sec title="Railway Env Variables" collapsible defaultOpen={false}>
            <div style={{padding:'12px 18px'}}>
              <div style={{fontFamily:'monospace',fontSize:10,lineHeight:2,background:C.bg,padding:14,borderRadius:5,border:`1px solid ${C.border}`}}>
                {['ALPACA_API_KEY=your_paper_key','ALPACA_SECRET_KEY=your_paper_secret','PAPER=true','AUTO_TRADE=false','RISK_DOLLARS=300','ACCOUNT_SIZE=100000','MAX_DAILY_LOSS=0.04','PREMIUM_STOP_PCT=0.45','TP1_PCT=0.50','TP2_PCT=1.00','TP1_CLOSE_PCT=0.50','ATR_STOP_MULT=1.5','MIN_CONFIDENCE=65','TIERED_SIZING=true','TRAIL_BREAKEVEN=true','FORCE_CLOSE_ET=15:45','GEX_REFRESH_MINS=30','SCAN_INTERVAL_MINS=5','PORT=3001'].map(line=>(
                  <div key={line}><span style={{color:C.yellow}}>{line.split('=')[0]}</span><span style={{color:C.dim}}>=</span><span style={{color:C.green}}>{line.split('=')[1]}</span></div>
                ))}
              </div>
            </div>
          </Sec>
        </>)}
      </div>
      <div style={{padding:'8px 20px',borderTop:`1px solid ${C.border}`,background:C.panel,fontSize:8,color:C.faint,textAlign:'center'}}>⚠ PAPER TRADING — Educational purposes only · Options involve significant risk · Always validate before live trading · Refreshes every 7s</div>
    </div>
  );
}
