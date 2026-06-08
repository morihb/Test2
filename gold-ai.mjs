// ─────────────────────────────────────────────────────────────
//  GOLD.AI — v4.0
//  Changes vs v3.1:
//   • Weekend blackout: no signals Saturday or Sunday (market closed).
//   • Signal lifecycle per timeframe:
//       – New signal fires → full alert sent, state saved.
//       – Same direction on next bar → "Keep Holding" update sent.
//       – Signal flips to WAIT → "Signal Invalidated – close manually" sent.
//       – TP1/TP2/TP3 hit (tracked via live price) → reply with pips.
//       – SL hit → reply with SL pips loss.
//   • Structure-based TPs (instead of fixed R multiples):
//       – BUY  → TP targets = recent swing highs / prior-session high.
//       – SELL → TP targets = recent swing lows  / prior-session low.
//       – Minimum 1.0R per TP; skip signal if no qualifying structure level.
//       – Falls back to R-multiple if no structural level qualifies.
//   All scoring, gates, sizing, costs, governor: UNCHANGED.
//
//  Run:  node gold-ai check                 (live: 15m + 1h)
//        TF=15m node gold-ai backtest       (backtest 15m)
//        TF=1h  node gold-ai report         (full report 1h)
// ─────────────────────────────────────────────────────────────
import fs from 'fs'

// ── CONFIG (secrets from env only) ───────────────────────────────
const TG_TOKEN=process.env.TG_TOKEN||'', TG_CHAT=process.env.TG_CHAT||''
const envNum=(k,d)=>process.env[k]!==undefined&&process.env[k]!==''?parseFloat(process.env[k]):d
const ACCT=parseFloat(process.env.ACCT)||10000, RISK=parseFloat(process.env.RISK)||1
const STATE_FILE='./bot_state.json', TRADE_LOG='./trade_log.json', REPORT_FILE='./report.json'

// which timeframes run together in LIVE check (override: LIVE_TFS="15m,1h")
const LIVE_TFS=(process.env.LIVE_TFS||'15m,1h').split(',').map(s=>s.trim()).filter(Boolean)

// cost model (tune to YOUR broker's actual fills)
const SPREAD_BASE=parseFloat(process.env.SPREAD)||0.30   // $ normal XAUUSD spread
const SPREAD_NEWS_MULT=8, SPREAD_ROLLOVER_MULT=5, SPREAD_VOL_MULT=2.5
const ENTRY_SLIP=parseFloat(process.env.ENTRY_SLIP)||0.10
const STOP_SLIP=parseFloat(process.env.STOP_SLIP)||0.20          // $ extra adverse on stop fills
const STOP_SLIP_FAST=parseFloat(process.env.STOP_SLIP_FAST)||2.0 // $ during news/volatile
const COMMISSION_USD=parseFloat(process.env.COMMISSION)||0       // round-trip $ per position

// risk governor (in R units) — set very high to disable for measurement runs
const DAILY_LOSS_LIMIT_R=envNum('DAILY_LOSS_R',3)
const MAX_CONSEC_LOSSES=envNum('MAX_CONSEC',4)
const KILL_DD_R=envNum('KILL_DD_R',10)
const MAX_CONCURRENT=1   // single-position system

// ── TIMEFRAME PRESETS (5m | 15m | 1h) — interval + sane defaults ──
const TF_PRESETS={
  '5m': {min:5,   td:'5min', oanda:'M5', trendMin:60,   structMin:15,  atrLow:0.04,atrHigh:0.55,window:1200,warmup:700,maxHold:24,target:30000},
  '15m':{min:15,  td:'15min',oanda:'M15',trendMin:240,  structMin:60,  atrLow:0.08,atrHigh:0.80,window:600, warmup:400,maxHold:24,target:25000},
  '1h': {min:60,  td:'1h',   oanda:'H1', trendMin:240,  structMin:60,  atrLow:0.15,atrHigh:1.20,window:400, warmup:300,maxHold:24,target:20000},
  '4h': {min:240, td:'4h',   oanda:'H4', trendMin:1440, structMin:240, atrLow:0.15,atrHigh:1.50,window:360, warmup:240,maxHold:24,target:15000},
  '1d': {min:1440,td:'1day', oanda:'D',  trendMin:10080,structMin:1440,atrLow:0.40,atrHigh:2.80,window:400, warmup:300,maxHold:20,target:8000},
}
// Backtest default TF (single-TF). Live ignores this and uses LIVE_TFS.
const TFRAME=process.env.TF||'5m'

// Build a per-timeframe config bundle. env overrides apply to whichever
// TF(s) run; for multi-TF live, prefer NOT setting TREND_MIN/ATR_* env so
// each timeframe keeps its own preset values.
function cfgFor(tframe){
  const p=TF_PRESETS[tframe]||TF_PRESETS['5m']
  return {
    tframe,
    min:p.min, td:p.td, oanda:p.oanda, target:p.target,
    trendMin:envNum('TREND_MIN',p.trendMin), structMin:envNum('STRUCT_MIN',p.structMin),
    atrLow:envNum('ATR_LOW',p.atrLow), atrHigh:envNum('ATR_HIGH',p.atrHigh),
    window:envNum('WINDOW',p.window), warmup:envNum('WARMUP',p.warmup), maxHold:envNum('MAXHOLD',p.maxHold),
  }
}

// scoring / gating — env-overridable so you can loosen for MEASUREMENT runs
const MIN_NET=envNum('MIN_NET',30), MIN_CONV=envNum('MIN_CONV',0.35), MAX_CONFLICT=envNum('MAX_CONFLICT',0.40)
const USE_MTF=process.env.USE_MTF!=='0'
const TP_PLAN=[{tp:'tp1',w:0.5},{tp:'tp2',w:0.3},{tp:'tp3',w:0.2}], MOVE_BE_AFTER_TP1=true
const NEWS_BLACKOUT_MIN={before:30,after:30}
const NEWS_EVENTS=[ /* {time:'2026-06-06T12:30:00Z',label:'NFP'} — keep current from a calendar */ ]
const TF={scalp:{slb:3}}

// ── MATH (unchanged) ─────────────────────────────────────────────
const ema=(p,n)=>{ if(p.length<n) return p.map(()=>null); const k=2/(n+1)
  let e=p.slice(0,n).reduce((a,b)=>a+b,0)/n; const o=new Array(n-1).fill(null); o.push(e)
  for(let i=n;i<p.length;i++){ e=p[i]*k+e*(1-k); o.push(e) } return o }
const last=a=>(a&&a.length?a[a.length-1]:null)
const rsiCalc=(p,n=14)=>{ if(p.length<n+1) return null; let g=0,l=0
  for(let i=1;i<=n;i++){ const d=p[i]-p[i-1]; d>0?g+=d:l-=d } let ag=g/n,al=l/n
  for(let i=n+1;i<p.length;i++){ const d=p[i]-p[i-1]
    if(d>0){ag=(ag*(n-1)+d)/n;al=al*(n-1)/n}else{ag=ag*(n-1)/n;al=(al*(n-1)-d)/n} }
  return +(100-100/(1+ag/(al||1e-9))).toFixed(2) }
const atrCalc=(c,n=14)=>{ if(c.length<n+1) return null
  const tr=c.slice(1).map((v,i)=>{ const pc=c[i].close; return Math.max(v.high-v.low,Math.abs(v.high-pc),Math.abs(v.low-pc)) })
  let a=tr.slice(0,n).reduce((x,y)=>x+y,0)/n; for(let i=n;i<tr.length;i++) a=(a*(n-1)+tr[i])/n; return a }
const macdCalc=(p)=>{ if(p.length<35) return {hist:null}; const e12=ema(p,12),e26=ema(p,26)
  const ml=p.map((_,i)=>(e12[i]!=null&&e26[i]!=null)?e12[i]-e26[i]:null).filter(v=>v!=null)
  const sig=ema(ml,9); const h=ml.map((m,i)=>sig[i]!=null?m-sig[i]:null).filter(v=>v!=null); return {hist:+last(h).toFixed(2)} }
const bbCalc=(p,n=20,m=2)=>{ if(p.length<n) return null; const sl=p.slice(-n),mn=sl.reduce((a,b)=>a+b,0)/n
  const sd=Math.sqrt(sl.reduce((a,b)=>a+(b-mn)**2,0)/n); return {upper:mn+m*sd,lower:mn-m*sd} }
const stochCalc=(c,n=14)=>{ if(c.length<n) return null; const w=c.slice(-n)
  const H=Math.max(...w.map(v=>v.high)),L=Math.min(...w.map(v=>v.low)); return +((c[c.length-1].close-L)/((H-L)||1e-9)*100).toFixed(2) }
const sma20=(c)=>c.length<20?null:+(c.slice(-20).reduce((a,b)=>a+b.close,0)/20).toFixed(2)

// ── calendar-aligned + COMPLETED-only HTF resample (unchanged) ───
function resampleTF(c, minutes){
  const ms=minutes*60000, map=new Map()
  for(const bar of c){ const k=Math.floor(bar.timestamp/ms)*ms
    const b=map.get(k)
    if(!b) map.set(k,{timestamp:k,open:bar.open,high:bar.high,low:bar.low,close:bar.close})
    else { b.high=Math.max(b.high,bar.high); b.low=Math.min(b.low,bar.low); b.close=bar.close } }
  const arr=[...map.values()].sort((a,b)=>a.timestamp-b.timestamp).map(b=>({...b,price:b.close}))
  return arr.slice(0,-1)   // drop forming HTF bar — completed bars only
}

// ── REGIME / structure / session ─────────────────────────────────
function adx(c,n=14){ if(c.length<2*n+1) return null
  const H=c.map(x=>x.high),L=c.map(x=>x.low),C=c.map(x=>x.close); const trs=[],pdm=[],mdm=[]
  for(let i=1;i<c.length;i++){ const up=H[i]-H[i-1],dn=L[i-1]-L[i]
    pdm.push(up>dn&&up>0?up:0); mdm.push(dn>up&&dn>0?dn:0)
    trs.push(Math.max(H[i]-L[i],Math.abs(H[i]-C[i-1]),Math.abs(L[i]-C[i-1]))) }
  const wild=a=>{ let s=a.slice(0,n).reduce((x,y)=>x+y,0); const o=[s]; for(let i=n;i<a.length;i++){s=s-s/n+a[i];o.push(s)} return o }
  const tr=wild(trs),pd=wild(pdm),md=wild(mdm)
  const pdi=pd.map((v,i)=>100*v/(tr[i]||1e-9)),mdi=md.map((v,i)=>100*v/(tr[i]||1e-9))
  const dx=pdi.map((v,i)=>100*Math.abs(v-mdi[i])/((v+mdi[i])||1e-9)); if(dx.length<n) return null
  let a=dx.slice(0,n).reduce((x,y)=>x+y,0)/n; for(let i=n;i<dx.length;i++) a=(a*(n-1)+dx[i])/n
  return {adx:+a.toFixed(1),pdi:+last(pdi).toFixed(1),mdi:+last(mdi).toFixed(1)} }
function marketRegime(c,price,cfg){ const d=adx(c),atr=atrCalc(c); const atrPct=atr?atr/price*100:null
  if(!d||atrPct==null) return {regime:'unknown',adx:null,atrPct,allowTrend:true,allowMR:true}
  if(atrPct<cfg.atrLow) return {regime:'low_liquidity',...d,atrPct,allowTrend:false,allowMR:false}
  if(atrPct>cfg.atrHigh) return {regime:'volatile_expansion',...d,atrPct,allowTrend:true,allowMR:false}
  if(d.adx>=25&&d.pdi>d.mdi) return {regime:'trending_bull',...d,atrPct,allowTrend:true,allowMR:false}
  if(d.adx>=25&&d.mdi>d.pdi) return {regime:'trending_bear',...d,atrPct,allowTrend:true,allowMR:false}
  if(d.adx<18) return {regime:'ranging',...d,atrPct,allowTrend:false,allowMR:true}
  return {regime:'transition',...d,atrPct,allowTrend:true,allowMR:true} }
function sessionOf(ts){ const d=new Date(ts), h=d.getUTCHours()+d.getUTCMinutes()/60
  if(h>=0&&h<7) return 'asian'; if(h>=7&&h<12) return 'london'; if(h>=13&&h<21) return 'ny'; return 'offhours' }
function detectStructure(c,lb=3){ const H=[],L=[]
  for(let i=lb;i<c.length-lb;i++){ const v=c[i].close
    const lf=c.slice(i-lb,i).map(d=>d.close), rt=c.slice(i+1,i+1+lb).map(d=>d.close)
    if(v>Math.max(...lf)&&v>Math.max(...rt)) H.push({...c[i],idx:i})
    if(v<Math.min(...lf)&&v<Math.min(...rt)) L.push({...c[i],idx:i}) }
  let bos='none',choch='none'
  if(H.length>=2&&L.length>=2){ const rH=H[H.length-1],pH=H[H.length-2],rL=L[L.length-1],pL=L[L.length-2]
    if(rH.close>pH.close&&rL.close>pL.close)bos='bullish'; if(rH.close<pH.close&&rL.close<pL.close)bos='bearish'
    if(bos==='bullish'&&last(c).close<rL.close)choch='bearish_choch'; if(bos==='bearish'&&last(c).close>rH.close)choch='bullish_choch' }
  return {H,L,rH:H.length?H[H.length-1]:null,rL:L.length?L[L.length-1]:null,bos,choch} }
function detectLiquiditySweep(c){ const last5=c.slice(-5),prev=c.slice(-20,-5)
  if(!prev.length) return {sweepBull:false,sweepBear:false}
  const pH=Math.max(...prev.map(x=>x.high)),pL=Math.min(...prev.map(x=>x.low)); let sb=false,ss=false
  for(const x of last5){ if(x.high>pH&&x.close<pH)ss=true; if(x.low<pL&&x.close>pL)sb=true }
  return {sweepBull:sb,sweepBear:ss,prevHigh:pH,prevLow:pL} }
function htfTrend(h1){ if(h1.length<50) return 'neutral'
  const p=h1.map(x=>x.close),e20=last(ema(p,20)),e50=last(ema(p,50)),price=last(p)
  if(e20&&e50&&price>e50&&e20>e50) return 'bullish'; if(e20&&e50&&price<e50&&e20<e50) return 'bearish'; return 'neutral' }

// ── cost model helpers (unchanged) ───────────────────────────────
function inNewsBlackout(ts){ for(const e of NEWS_EVENTS){ const et=new Date(e.time).getTime()
  if(ts>=et-NEWS_BLACKOUT_MIN.before*60000 && ts<=et+NEWS_BLACKOUT_MIN.after*60000) return e.label } return null }
function isRollover(ts){ return new Date(ts).getUTCHours()===21 } // ~OANDA 21:00 UTC daily rollover
// Weekend blackout: Saturday (day 6) all day, Sunday (day 0) all day — market closed
function isWeekend(ts){ const d=new Date(ts).getUTCDay(); return d===0||d===6 }
// Pip value for XAUUSD: 1 pip = $0.10 (i.e. price in dollars, 1 decimal = 1 pip)
const toPips=dollars=>Math.round(Math.abs(dollars)*10)
function spreadAt(ts,regime){ let s=SPREAD_BASE
  if(inNewsBlackout(ts)) s*=SPREAD_NEWS_MULT
  else if(isRollover(ts)) s*=SPREAD_ROLLOVER_MULT
  else if(regime==='volatile_expansion') s*=SPREAD_VOL_MULT
  return s }
function stopSlipAt(ts,regime){ return (inNewsBlackout(ts)||regime==='volatile_expansion')?STOP_SLIP_FAST:STOP_SLIP }

// ── SCORING + gates (strategy unchanged; now takes cfg) ──────────
const WEIGHTS={regime:25,liquidity:20,structure:20,ema:12,macd:8,osc:10,sma:5}
const TOTAL=Object.values(WEIGHTS).reduce((a,b)=>a+b,0)
function analyse(candles, nowMs, cfg){
  const price=last(candles).close, prices=candles.map(c=>c.close)
  const reg=marketRegime(candles,price,cfg), str=detectStructure(candles,TF.scalp.slb), liq=detectLiquiditySweep(candles)
  const e20=last(ema(prices,20)),e50=last(ema(prices,50))
  const rsi=rsiCalc(prices),macd=macdCalc(prices),bb=bbCalc(prices),st=stochCalc(candles),s20=sma20(candles),atr=atrCalc(candles)
  if(!atr||reg.regime==='low_liquidity') return wait('low liquidity / no ATR',reg,cfg)
  if(reg.atrPct<0.03||reg.atrPct>3.0) return wait(`ATR ${reg.atrPct?.toFixed(3)}% outside band`,reg,cfg)
  if(isWeekend(nowMs)) return wait('weekend — market closed',reg,cfg)
  const news=inNewsBlackout(nowMs); if(news) return wait(`news blackout: ${news}`,reg,cfg)
  // completed, calendar-aligned HTF
  let h1Trend='neutral',m15Bos='none'
  if(USE_MTF){ const h1=resampleTF(candles,cfg.trendMin), m15=resampleTF(candles,cfg.structMin)
    h1Trend=htfTrend(h1); if(m15.length>20) m15Bos=detectStructure(m15,3).bos }
  let bull=0,bear=0; const reasons=[]
  if(reg.regime==='trending_bull'){bull+=WEIGHTS.regime;reasons.push('Regime bull')} else if(reg.regime==='trending_bear'){bear+=WEIGHTS.regime;reasons.push('Regime bear')}
  if(liq.sweepBull){bull+=WEIGHTS.liquidity;reasons.push('Sell-side liq swept')} if(liq.sweepBear){bear+=WEIGHTS.liquidity;reasons.push('Buy-side liq swept')}
  if(str.bos==='bullish'||str.choch==='bullish_choch'){bull+=WEIGHTS.structure;reasons.push('Bullish BOS/CHoCH')} if(str.bos==='bearish'||str.choch==='bearish_choch'){bear+=WEIGHTS.structure;reasons.push('Bearish BOS/CHoCH')}
  if(reg.allowTrend){ if(e20&&e50&&e20>e50&&price>e20)bull+=WEIGHTS.ema; if(e20&&e50&&e20<e50&&price<e20)bear+=WEIGHTS.ema
    if(macd.hist!=null&&macd.hist>0)bull+=WEIGHTS.macd; if(macd.hist!=null&&macd.hist<0)bear+=WEIGHTS.macd
    if(s20&&price>s20)bull+=WEIGHTS.sma; else if(s20&&price<s20)bear+=WEIGHTS.sma }
  if(reg.allowMR&&rsi!=null&&st!=null&&bb){ if(price<=bb.lower&&rsi<35&&st<25){bull+=WEIGHTS.osc;reasons.push('Oversold reclaim')} if(price>=bb.upper&&rsi>65&&st>75){bear+=WEIGHTS.osc;reasons.push('Overbought reject')} }
  const dominant=Math.max(bull,bear),opposing=Math.min(bull,bear),net=dominant-opposing,conv=net/TOTAL,conflict=dominant?opposing/dominant:0
  const dir0=bull===bear?'WAIT':(bull>bear?'BUY':'SELL')
  if(dir0==='WAIT'||net<MIN_NET||conv<MIN_CONV) return wait(`net ${net} conv ${conv.toFixed(2)} below floor`,reg,cfg,{net,bull,bear})
  if(conflict>MAX_CONFLICT) return wait(`conflict ${(conflict*100|0)}%`,reg,cfg,{net,bull,bear})
  if(USE_MTF){ const oppH1=(dir0==='BUY'&&h1Trend==='bearish')||(dir0==='SELL'&&h1Trend==='bullish')
    if(oppH1) return wait(`opposes H1 (${h1Trend})`,reg,cfg,{net,bull,bear})
    const oppM15=(dir0==='BUY'&&m15Bos==='bearish')||(dir0==='SELL'&&m15Bos==='bullish')
    if(oppM15&&conv<MIN_CONV+0.15) return wait('opposes M15 & weak',reg,cfg,{net,bull,bear}) }
  const dir=dir0, score=Math.round(conv*100), tier=score>=70?'A':score>=55?'B':'C'
  const stopMult=reg.regime==='volatile_expansion'?2.2:1.5
  // Minimum R ratio: each TP must be at least this far in R terms
  const MIN_TP_R=1.0
  let entry=price,sl,tp1,tp2,tp3

  if(dir==='BUY'){
    // --- Stop loss ---
    let base=liq.sweepBull&&liq.prevLow?liq.prevLow-atr*0.3:str.rL?str.rL.close-atr*0.3:price-atr*stopMult
    if(base>=entry)base=price-atr*stopMult; sl=+Math.max(base,price-atr*5).toFixed(2)
    const R=entry-sl
    // --- Structure-based TPs for BUY: target swing highs above entry ---
    // Collect swing highs above entry+MIN_TP_R, sorted ascending
    const upTargets=[
      ...str.H.map(h=>h.close).filter(p=>p>entry+R*MIN_TP_R),  // recent swing highs
      liq.prevHigh && liq.prevHigh>entry+R*MIN_TP_R ? liq.prevHigh : null,  // prior-session high (liquidity)
    ].filter(Boolean).sort((a,b)=>a-b)
    // Fill TP slots from structural levels; fall back to R-multiple if not enough
    tp1=upTargets[0]??+(entry+R*1.5).toFixed(2)
    tp2=upTargets[1]??+(entry+R*2.5).toFixed(2)
    tp3=upTargets[2]??+(entry+R*4.0).toFixed(2)
    // Enforce ascending order and minimum R distance
    if(tp2<=tp1) tp2=+(tp1+(entry+R*2.5-tp1)*0.5||entry+R*2.5).toFixed(2)
    if(tp3<=tp2) tp3=+(tp2+(entry+R*4.0-tp2)*0.5||entry+R*4.0).toFixed(2)
    // If TP1 is less than MIN_TP_R away, skip — no valid structure
    if((tp1-entry)<R*MIN_TP_R) return wait('no qualifying structure TP (BUY)',reg,cfg,{net,bull,bear})
    tp1=+tp1.toFixed(2); tp2=+tp2.toFixed(2); tp3=+tp3.toFixed(2)
  } else {
    // --- Stop loss ---
    let base=liq.sweepBear&&liq.prevHigh?liq.prevHigh+atr*0.3:str.rH?str.rH.close+atr*0.3:price+atr*stopMult
    if(base<=entry)base=price+atr*stopMult; sl=+Math.min(base,price+atr*5).toFixed(2)
    const R=sl-entry
    // --- Structure-based TPs for SELL: target swing lows below entry ---
    const downTargets=[
      ...str.L.map(l=>l.close).filter(p=>p<entry-R*MIN_TP_R),  // recent swing lows
      liq.prevLow && liq.prevLow<entry-R*MIN_TP_R ? liq.prevLow : null,  // prior-session low
    ].filter(Boolean).sort((a,b)=>b-a)  // descending — closest first
    tp1=downTargets[0]??+(entry-R*1.5).toFixed(2)
    tp2=downTargets[1]??+(entry-R*2.5).toFixed(2)
    tp3=downTargets[2]??+(entry-R*4.0).toFixed(2)
    if(tp2>=tp1) tp2=+(tp1-(tp1-(entry-R*2.5))*0.5||entry-R*2.5).toFixed(2)
    if(tp3>=tp2) tp3=+(tp2-(tp2-(entry-R*4.0))*0.5||entry-R*4.0).toFixed(2)
    if((entry-tp1)<R*MIN_TP_R) return wait('no qualifying structure TP (SELL)',reg,cfg,{net,bull,bear})
    tp1=+tp1.toFixed(2); tp2=+tp2.toFixed(2); tp3=+tp3.toFixed(2)
  }
  // OANDA XAU_USD is priced in UNITS (ounces). $1 move = $1/unit.
  const riskUSD=ACCT*(RISK/100), units=riskUSD/Math.abs(entry-sl)
  return { tframe:cfg.tframe, direction:dir,score,tier,net,bull,bear,conflict:+conflict.toFixed(2),
    regime:reg.regime,adx:reg.adx,atrPct:+reg.atrPct.toFixed(3),session:sessionOf(nowMs),h1Trend,m15Bos,
    entry:+entry.toFixed(2),sl,tp1,tp2,tp3,rr:`1:${Math.abs((tp2-entry)/(entry-sl)).toFixed(1)}`,
    units:+units.toFixed(2), posSize:`${units.toFixed(2)} units(oz) · OANDA order≈${Math.round(units)} · $${riskUSD.toFixed(0)} risk`,
    inv:dir==='BUY'?`${cfg.tframe} close below $${sl}`:`${cfg.tframe} close above $${sl}`,reasons,skipped:false }
}
function wait(why,reg,cfg,extra={}){ return {direction:'WAIT',skipped:true,why,tframe:cfg?.tframe,regime:reg?.regime,...extra} }

// ── data-quality validation (now takes cfg.min) ──────────────────
function validateData(c,cfg){
  const issues={dups:0,badTs:0,outliers:0,midGaps:0,weekendGaps:0}
  const sorted=c.slice().sort((a,b)=>a.timestamp-b.timestamp)
  const ranges=sorted.map(x=>x.high-x.low).filter(r=>r>0).sort((a,b)=>a-b)
  const med=ranges.length?ranges[ranges.length>>1]:1
  const out=[]; let prev=null
  for(const bar of sorted){
    if(prev&&bar.timestamp===prev.timestamp){ issues.dups++; continue }
    if(prev&&bar.timestamp<prev.timestamp){ issues.badTs++; continue }
    const jump=prev?Math.abs(bar.open-prev.close):0
    if((bar.high-bar.low)>med*25 || jump>med*25){ issues.outliers++; continue }   // bad print
    if(prev){ const gap=bar.timestamp-prev.timestamp
      if(gap>cfg.min*60000*1.5){ if(gap>20*3600000) issues.weekendGaps++; else issues.midGaps++ } }
    out.push(bar); prev=bar
  }
  return { clean:out, issues, medianRange:+med.toFixed(2) }
}

// ── DATA SOURCES (now take cfg for interval/granularity) ─────────
const SOURCE=process.env.GOLD_SOURCE||(process.env.OANDA_TOKEN?'oanda':process.env.TWELVEDATA_KEY?'twelvedata':'yahoo')
async function fetchCandles(count=500,cfg){ if(SOURCE==='oanda')return fetchOanda(count,cfg); if(SOURCE==='twelvedata')return fetchTwelveData(count,cfg); return fetchYahooSpot(cfg) }
async function fetchOanda(count,cfg){ const host=process.env.OANDA_ENV==='live'?'api-fxtrade.oanda.com':'api-fxpractice.oanda.com'
  const res=await fetch(`https://${host}/v3/instruments/XAU_USD/candles?granularity=${cfg.oanda}&count=${Math.min(count,5000)}&price=M`,{headers:{Authorization:`Bearer ${process.env.OANDA_TOKEN}`}})
  if(!res.ok) throw new Error(`OANDA ${res.status}: ${await res.text()}`)
  const {candles=[]}=await res.json()
  const out=candles.map(c=>({timestamp:new Date(c.time).getTime(),open:+(+c.mid.o).toFixed(2),high:+(+c.mid.h).toFixed(2),low:+(+c.mid.l).toFixed(2),close:+(+c.mid.c).toFixed(2),price:+(+c.mid.c).toFixed(2),complete:c.complete}))
  if(out.length<200) throw new Error('OANDA: too few candles'); return out }
async function fetchTwelveData(count,cfg){ const res=await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${cfg.td}&outputsize=${Math.min(count,5000)}&apikey=${process.env.TWELVEDATA_KEY}`)
  if(!res.ok) throw new Error(`TwelveData ${res.status}`); const j=await res.json()
  if(j.status==='error'||!j.values) throw new Error(`TwelveData: ${j.message||'no data'}`)
  const out=j.values.map(v=>({timestamp:new Date(v.datetime.replace(' ','T')+'Z').getTime(),open:+(+v.open).toFixed(2),high:+(+v.high).toFixed(2),low:+(+v.low).toFixed(2),close:+(+v.close).toFixed(2),price:+(+v.close).toFixed(2)})).reverse()
  if(out.length<200) throw new Error('TwelveData: too few candles'); return out }
// Paginated history: stacks 5000-bar requests backward via end_date.
async function fetchTwelveDataPaged(target=30000,cfg){
  const key=process.env.TWELVEDATA_KEY, all=new Map(); let endDate=null
  const maxPages=Math.ceil(target/5000)+3
  for(let page=0;page<maxPages;page++){
    let url=`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${cfg.td}&outputsize=5000&apikey=${key}`
    if(endDate) url+=`&end_date=${encodeURIComponent(endDate)}`
    const res=await fetch(url); if(!res.ok){ console.error(`  TwelveData page ${page+1}: HTTP ${res.status} — stopping`); break }
    const j=await res.json()
    if(j.status==='error'||!j.values||!j.values.length){ console.error(`  TwelveData: ${j.message||'no more history'} — stopping`); break }
    let added=0
    for(const v of j.values){ const ts=new Date(v.datetime.replace(' ','T')+'Z').getTime()
      if(!all.has(ts)){ all.set(ts,{timestamp:ts,open:+(+v.open).toFixed(2),high:+(+v.high).toFixed(2),low:+(+v.low).toFixed(2),close:+(+v.close).toFixed(2),price:+(+v.close).toFixed(2)}); added++ } }
    const oldest=j.values[j.values.length-1].datetime
    console.log(`  page ${page+1}: +${added} bars (total ${all.size}) back to ${oldest}`)
    if(added===0||endDate===oldest||all.size>=target) break
    endDate=oldest
    await new Promise(r=>setTimeout(r,8500)) // stay under 8 req/min
  }
  const arr=[...all.values()].sort((a,b)=>a.timestamp-b.timestamp)
  if(arr.length<200) throw new Error('TwelveData paged: too few candles')
  return arr }
function parseYahoo(j){ const r=j.chart?.result?.[0]; if(!r?.timestamp) return []; const q=r.indicators.quote[0]
  return r.timestamp.map((t,i)=>{ const o=q.open?.[i],h=q.high?.[i],l=q.low?.[i],c=q.close?.[i]; if([o,h,l,c].some(v=>v==null||isNaN(v)))return null
    return {timestamp:t*1000,open:+o.toFixed(2),high:+h.toFixed(2),low:+l.toFixed(2),close:+c.toFixed(2),price:+c.toFixed(2)} }).filter(Boolean) }
async function fetchYahooSpot(cfg){ const iv=cfg.min>=1440?'1d':cfg.min===60?'1h':cfg.min===15?'15m':'5m', range=cfg.min>=1440?'5y':cfg.min>=60?'730d':'60d'
  for(const q of ['query1','query2']){ try{ const res=await fetch(`https://${q}.finance.yahoo.com/v8/finance/chart/XAUUSD=X?interval=${iv}&range=${range}`,{headers:{'User-Agent':'Mozilla/5.0'}})
  if(res.ok){ const a=parseYahoo(await res.json()); if(a.length>200) return a } }catch(_){} }
  throw new Error('No Yahoo spot data — set OANDA_TOKEN or TWELVEDATA_KEY') }

// ── next-open fills + realistic costs (unchanged) ────────────────
function simulateTrade(candles,i,sig,maxHold=24){
  if(i+1>=candles.length) return null
  const dir=sig.direction, eb=candles[i+1]
  const sEntry=spreadAt(eb.timestamp,sig.regime)
  const fill = dir==='BUY' ? eb.open+sEntry/2+ENTRY_SLIP : eb.open-sEntry/2-ENTRY_SLIP   // fill at NEXT-bar open
  const SL=sig.sl
  if((dir==='BUY'&&fill<=SL)||(dir==='SELL'&&fill>=SL)) return {skip:true,reason:'gap_past_stop'}
  const Rd=Math.abs(fill-SL); if(Rd<=1e-9) return {skip:true,reason:'zero_risk'}
  const riskUSD=ACCT*(RISK/100), commR=COMMISSION_USD/(riskUSD||1)
  const tps=TP_PLAN.map(t=>({px:sig[t.tp],w:t.w,taken:false}))
  let stop=SL, realized=-commR, remaining=1, mae=0, mfe=0, exitIdx=i+1
  for(let j=i+1;j<Math.min(i+1+maxHold,candles.length);j++){
    const bar=candles[j]; exitIdx=j
    const fav=dir==='BUY'?(bar.high-fill)/Rd:(fill-bar.low)/Rd, adv=dir==='BUY'?(fill-bar.low)/Rd:(bar.high-fill)/Rd
    mfe=Math.max(mfe,fav); mae=Math.max(mae,adv)
    const sx=spreadAt(bar.timestamp,sig.regime), ssl=stopSlipAt(bar.timestamp,sig.regime)
    if(dir==='BUY'?bar.low<=stop:bar.high>=stop){   // stop first (conservative)
      const px=dir==='BUY'?stop-sx/2-ssl:stop+sx/2+ssl
      realized+=remaining*((dir==='BUY'?px-fill:fill-px)/Rd); remaining=0; break }
    for(const t of tps){ if(t.taken) continue
      if(dir==='BUY'?bar.high>=t.px:bar.low<=t.px){ const px=dir==='BUY'?t.px-sx/2:t.px+sx/2
        realized+=t.w*((dir==='BUY'?px-fill:fill-px)/Rd); t.taken=true; remaining-=t.w; if(MOVE_BE_AFTER_TP1) stop=fill } }
    if(remaining<=1e-9) break
  }
  if(remaining>1e-9){ const bar=candles[exitIdx], sx=spreadAt(bar.timestamp,sig.regime)
    const px=dir==='BUY'?bar.close-sx/2:bar.close+sx/2; realized+=remaining*((dir==='BUY'?px-fill:fill-px)/Rd) }
  return { R:+realized.toFixed(3), bars:exitIdx-(i+1), mae:+mae.toFixed(2), mfe:+mfe.toFixed(2),
    session:sessionOf(eb.timestamp), regime:sig.regime, tier:sig.tier, score:sig.score, dir,
    day:new Date(eb.timestamp).toISOString().slice(0,10) }
}

// ── backtest WITH risk governor (now takes cfg) ──────────────────
function backtest(candles,cfg,{maxHold=cfg.maxHold,warmup=cfg.warmup,window=cfg.window}={}){
  const trades=[]; const skipped={governor_kill:0,governor_day:0,governor_consec:0,gap_past_stop:0,zero_risk:0}
  let i=warmup, equityR=0, peakR=0, consec=0, killed=false, curDay=null, dayR=0, dayHalted=false, lastBeat=warmup
  while(i<candles.length-2){
    if(i-lastBeat>=5000){ console.error(`  …bar ${i}/${candles.length} · trades ${trades.length}`); lastBeat=i }
    const from=Math.max(0,i-window+1)
    const sig=analyse(candles.slice(from,i+1),candles[i].timestamp,cfg)
    if(sig.skipped){ i++; continue }
    if(candles[i+1].timestamp-candles[i].timestamp>cfg.min*60000*1.5){ i++; continue }
    const day=new Date(candles[i+1].timestamp).toISOString().slice(0,10)
    if(day!==curDay){ curDay=day; dayR=0; dayHalted=false }
    if(killed){ skipped.governor_kill++; i++; continue }
    if(dayHalted){ skipped.governor_day++; i++; continue }
    if(consec>=MAX_CONSEC_LOSSES){ skipped.governor_consec++; dayHalted=true; i++; continue }
    const t=simulateTrade(candles,i,sig,maxHold)
    if(!t){ i++; continue }
    if(t.skip){ skipped[t.reason]=(skipped[t.reason]||0)+1; i++; continue }
    trades.push(t)
    equityR+=t.R; peakR=Math.max(peakR,equityR); if(peakR-equityR>=KILL_DD_R) killed=true
    dayR+=t.R; if(dayR<=-DAILY_LOSS_LIMIT_R) dayHalted=true
    consec=t.R<=0?consec+1:0
    i=i+1+t.bars+1
  }
  return { trades, skipped, killed, finalEquityR:+equityR.toFixed(2) }
}

// ── stats / analytics / bootstrap + Monte-Carlo (unchanged) ──────
function agg(Rs){ if(!Rs.length) return {n:0}; const w=Rs.filter(r=>r>0),l=Rs.filter(r=>r<=0)
  const gw=w.reduce((a,b)=>a+b,0),gl=Math.abs(l.reduce((a,b)=>a+b,0))
  return {n:Rs.length,winRate:+(w.length/Rs.length*100).toFixed(1),exp:+(Rs.reduce((a,b)=>a+b,0)/Rs.length).toFixed(3),pf:gl?+(gw/gl).toFixed(2):(gw>0?99.99:0),totalR:+Rs.reduce((a,b)=>a+b,0).toFixed(2)} }
function group(trades,key){ const m={}; for(const t of trades){ (m[t[key]]??=[]).push(t.R) }; return Object.fromEntries(Object.entries(m).map(([k,v])=>[k,agg(v)])) }
const scoreBucket=s=>s>=70?'70-100':s>=60?'60-69':s>=50?'50-59':'45-49'
function bootstrapExpectancy(Rs,B=3000){ if(Rs.length<10) return {note:'need >=10 trades'}
  const means=[]; for(let b=0;b<B;b++){ let s=0; for(let k=0;k<Rs.length;k++) s+=Rs[(Math.random()*Rs.length)|0]; means.push(s/Rs.length) }
  means.sort((a,b)=>a-b); const q=p=>+means[Math.floor(p*B)].toFixed(3)
  return { meanR:+(Rs.reduce((a,b)=>a+b,0)/Rs.length).toFixed(3), ci90:[q(0.05),q(0.95)], probPositive:+(means.filter(m=>m>0).length/B).toFixed(3) } }
function monteCarlo(Rs,B=3000){ if(Rs.length<10) return {note:'need >=10 trades'}
  const finals=[],dds=[]; const N=Rs.length
  for(let b=0;b<B;b++){ let eq=0,peak=0,mdd=0
    for(let k=0;k<N;k++){ eq+=Rs[(Math.random()*N)|0]; peak=Math.max(peak,eq); mdd=Math.min(mdd,eq-peak) } // resample WITH REPLACEMENT
    finals.push(eq); dds.push(mdd) }
  finals.sort((a,b)=>a-b); dds.sort((a,b)=>a-b); const q=(a,p)=>+a[Math.floor(p*a.length)].toFixed(2)
  return { finalR:{p5:q(finals,0.05),p50:q(finals,0.5),p95:q(finals,0.95)},
    maxDrawdownR:{p5:q(dds,0.05),p50:q(dds,0.5),p95:q(dds,0.95)},
    probNegative:+(finals.filter(f=>f<0).length/B).toFixed(3), probBlowupBelow_neg10R:+(finals.filter(f=>f<-10).length/B).toFixed(3) } }

function fullReport(bt){
  const trades=bt.trades
  if(trades.length<1) return { trades:0, governor:bt.skipped, note:'No trades taken — window too short or gates/governor too strict.' }
  const Rs=trades.map(t=>t.R)
  let peak=0,cum=0,mdd=0; for(const r of Rs){ cum+=r; peak=Math.max(peak,cum); mdd=Math.min(mdd,cum-peak) }
  const overall={...agg(Rs),maxDrawdownR:+mdd.toFixed(2),avgMAE:+(trades.reduce((a,t)=>a+t.mae,0)/trades.length).toFixed(2),avgMFE:+(trades.reduce((a,t)=>a+t.mfe,0)/trades.length).toFixed(2),avgBars:+(trades.reduce((a,t)=>a+t.bars,0)/trades.length).toFixed(1)}
  const K=5,folds=[],fs=Math.floor(trades.length/K)
  for(let k=0;k<K&&fs>0;k++) folds.push({fold:k+1,...agg(trades.slice(k*fs,(k+1)*fs).map(t=>t.R))})
  const cut=Math.floor(trades.length*0.7)
  const byRegime=group(trades,'regime'),bySession=group(trades,'session'),byTier=group(trades,'tier'),byScore=group(trades.map(t=>({...t,bucket:scoreBucket(t.score)})),'bucket')
  const pick=(o,best)=>{ const e=Object.entries(o).filter(([,v])=>v.n>=5); if(!e.length) return null; e.sort((a,b)=>best?b[1].exp-a[1].exp:a[1].exp-b[1].exp); return {key:e[0][0],...e[0][1]} }
  return { overall, governor:{...bt.skipped,killSwitchFired:bt.killed,finalEquityR:bt.finalEquityR},
    inSample:agg(trades.slice(0,cut).map(t=>t.R)), outSample:agg(trades.slice(cut).map(t=>t.R)),
    walkForwardFolds:folds, bootstrap:bootstrapExpectancy(Rs), monteCarlo:monteCarlo(Rs),
    byRegime,bySession,byTier,byScore,
    report:{ bestRegime:pick(byRegime,1),worstRegime:pick(byRegime,0),bestSession:pick(bySession,1),worstSession:pick(bySession,0),bestScoreBucket:pick(byScore,1),worstScoreBucket:pick(byScore,0) } }
}

// ── TELEGRAM / live check (multi-TF + full signal lifecycle) ─────

async function sendTelegram(text,replyToMsgId=null){
  if(!TG_TOKEN||!TG_CHAT){ console.log('[telegram disabled]\n'+text); return null }
  const body={chat_id:TG_CHAT,text,parse_mode:'HTML'}
  if(replyToMsgId) body.reply_to_message_id=replyToMsgId
  const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  if(!res.ok){ console.error('Telegram error',res.status,await res.text()); return null }
  const j=await res.json(); return j.result?.message_id||null
}

// ── Per-TF state: active signal tracking ─────────────────────────
// State shape per TF key in bot_state.json:
// { barKey, direction, entry, sl, tp1, tp2, tp3,
//   tp1Hit, tp2Hit, tp3Hit, msgId, live }
function loadState(tf){ try{ return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))[tf]||null }catch{ return null } }
function saveState(tf,obj){ let o={}; try{o=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))}catch{}; o[tf]=obj; o.at=new Date().toISOString(); try{fs.writeFileSync(STATE_FILE,JSON.stringify(o,null,2))}catch(e){console.error(e)} }
const logTrade=o=>{ let a=[];try{a=JSON.parse(fs.readFileSync(TRADE_LOG,'utf8'))}catch{};a.push(o);fs.writeFileSync(TRADE_LOG,JSON.stringify(a,null,2)) }

// run ONE timeframe's live check — full lifecycle
async function checkOne(tframe){
  const cfg=cfgFor(tframe), ts=new Date().toISOString(), nowMs=Date.now()

  // ── 1. Weekend blackout ──────────────────────────────────────
  if(isWeekend(nowMs)){
    console.log(`[${ts}] ${tframe} SKIP: weekend — market closed`); return
  }

  // ── 2. Fetch + validate ──────────────────────────────────────
  let candles
  try{ candles=await fetchCandles(500,cfg) }
  catch(e){ console.error(`[${ts}] ${tframe} fetch failed: ${e.message}`); return }
  const v=validateData(candles,cfg); candles=v.clean
  if(candles.length<50){ console.log(`[${ts}] ${tframe} too few bars`); return }

  const closed=candles.slice(0,-1)
  const forming=candles[candles.length-1]
  const live=forming.close
  const lastClosedBar=closed[closed.length-1]
  const barKey=`${tframe}|${lastClosedBar.timestamp}`

  // ── 3. Load prior state for this TF ─────────────────────────
  let state=loadState(tframe)  // null or prior active signal

  // ── 4. If there IS an active signal — check TP/SL hits first ─
  if(state){
    const {direction:aDir,entry:aEntry,sl:aSL,tp1:aTp1,tp2:aTp2,tp3:aTp3,msgId,
           tp1Hit=false,tp2Hit=false,tp3Hit=false}=state
    const R=Math.abs(aEntry-aSL)

    // Check TP & SL hits using the FORMING bar's high/low (live)
    const barHigh=forming.high, barLow=forming.low
    let updated=false

    if(!tp1Hit&&(aDir==='BUY'?barHigh>=aTp1:barLow<=aTp1)){
      const pips=toPips(aTp1-aEntry)*(aDir==='BUY'?1:-1)
      await sendTelegram(`✅ <b>GOLD ${tframe.toUpperCase()} — TP1 HIT</b>\n+${Math.abs(pips)} pips @ $${aTp1}\nRemaining position: ride to TP2 $${aTp2} · SL moved to BE`,msgId)
      state={...state,tp1Hit:true}; updated=true
    }
    if(!tp2Hit&&(state.tp1Hit)&&(aDir==='BUY'?barHigh>=aTp2:barLow<=aTp2)){
      const pips=toPips(aTp2-aEntry)*(aDir==='BUY'?1:-1)
      await sendTelegram(`✅ <b>GOLD ${tframe.toUpperCase()} — TP2 HIT</b>\n+${Math.abs(pips)} pips @ $${aTp2}\nRemainder riding to TP3 $${aTp3}`,msgId)
      state={...state,tp2Hit:true}; updated=true
    }
    if(!tp3Hit&&(state.tp2Hit)&&(aDir==='BUY'?barHigh>=aTp3:barLow<=aTp3)){
      const pips=toPips(aTp3-aEntry)*(aDir==='BUY'?1:-1)
      await sendTelegram(`🏆 <b>GOLD ${tframe.toUpperCase()} — TP3 HIT — FULL TARGET</b>\n+${Math.abs(pips)} pips @ $${aTp3}\nTrade complete.`,msgId)
      state=null; saveState(tframe,null); logTrade({ts,tframe,event:'TP3',live,...state}); return
    }
    // SL hit
    if((aDir==='BUY'?barLow<=aSL:barHigh>=aSL)){
      const pips=toPips(aSL-aEntry)*(aDir==='BUY'?-1:1)
      await sendTelegram(`🔴 <b>GOLD ${tframe.toUpperCase()} — STOP LOSS HIT</b>\n${pips} pips @ $${aSL}\nSignal closed.`,msgId)
      state=null; saveState(tframe,null); logTrade({ts,tframe,event:'SL',live}); return
    }
    if(updated) saveState(tframe,state)
  }

  // ── 5. Analyse the latest completed bar ─────────────────────
  const sig=analyse(closed,lastClosedBar.timestamp,cfg)

  // ── 6. If signal is WAIT/skipped ────────────────────────────
  if(sig.skipped){
    // If there was an active signal and it just turned WAIT → invalidation
    if(state){
      const {direction:aDir,msgId,entry:aEntry,sl:aSL}=state
      // Only invalidate if the signal direction has genuinely flipped/disappeared
      console.log(`[${ts}] ${tframe} WAIT while active ${aDir} — sending invalidation`)
      await sendTelegram(
`⚠️ <b>GOLD ${tframe.toUpperCase()} — SIGNAL INVALIDATED</b>
The ${aDir} confluence has disappeared (${sig.why}).
→ Consider closing manually if not at BE. SL $${aSL}`,msgId)
      state=null; saveState(tframe,null)
    } else {
      console.log(`[${ts}] ${tframe} WAIT · ${sig.regime} · ${sig.why}`)
    }
    return
  }

  // ── 7. Live price sanity checks ─────────────────────────────
  const R=Math.abs(sig.entry-sig.sl)
  if((sig.direction==='BUY'?live<=sig.sl:live>=sig.sl)){
    console.log(`[${ts}] ${tframe} SKIP: live past stop`); return
  }
  if((sig.direction==='BUY'?sig.entry-live:live-sig.entry)>0.5*R){
    console.log(`[${ts}] ${tframe} SKIP: stale (>0.5R drift)`); return
  }
  const slip=+(live-sig.entry).toFixed(2)

  // ── 8. Is this the SAME bar we already alerted? ─────────────
  if(state&&state.barKey===barKey){
    console.log(`[${ts}] ${tframe} already alerted this bar`); return
  }

  // ── 9. Is this a "keep holding" update? ─────────────────────
  // Same direction as active signal, different bar
  if(state&&state.direction===sig.direction){
    await sendTelegram(
`🔄 <b>GOLD ${tframe.toUpperCase()} — KEEP HOLDING ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
Confluence still active · live $${live}
SL $${sig.sl} · TP1 $${sig.tp1} · TP2 $${sig.tp2} · TP3 $${sig.tp3}`,state.msgId)
    saveState(tframe,{...state,barKey,live})
    console.log(`[${ts}] ✅ ${tframe} KEEP HOLDING ${sig.direction} · live $${live}`)
    return
  }

  // ── 10. NEW signal (or direction flip) ──────────────────────
  // If there was an opposite active signal, send a close notice first
  if(state&&state.direction!==sig.direction){
    await sendTelegram(
`⚠️ <b>GOLD ${tframe.toUpperCase()} — DIRECTION FLIP</b>
Previous ${state.direction} signal superseded.
→ Close prior trade before entering new ${sig.direction}.`,state.msgId)
  }

  const msgId=await sendTelegram(
`🟡 <b>GOLD ${tframe.toUpperCase()} — ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
Net ${sig.net} (bull ${sig.bull}/bear ${sig.bear}) · H1 ${sig.h1Trend} · ${sig.session}
Planned $${sig.entry} · live $${live} (drift ${slip>=0?'+':''}${slip})
SL $${sig.sl}
TP1 $${sig.tp1} (+${toPips(sig.tp1-sig.entry)} pips)
TP2 $${sig.tp2} (+${toPips(sig.tp2-sig.entry)} pips)
TP3 $${sig.tp3} (+${toPips(sig.tp3-sig.entry)} pips)
Size ${sig.posSize}
⚠️ Source ${SOURCE} — trust the report, not this tier.`)

  const newState={
    barKey, direction:sig.direction,
    entry:sig.entry, sl:sig.sl, tp1:sig.tp1, tp2:sig.tp2, tp3:sig.tp3,
    tp1Hit:false, tp2Hit:false, tp3Hit:false,
    msgId, live, ts
  }
  saveState(tframe,newState)
  logTrade({ts,tframe,live,slip,...sig})
  console.log(`[${ts}] ✅ ${tframe} NEW ${sig.direction} net ${sig.net} · live $${live}`)
}

// run ALL live timeframes (15m + 1h) one after another
async function check(){
  for(const tf of LIVE_TFS){ await checkOne(tf) }
}

// ── ENTRY POINT ─────────────────────────────────────────────────
const mode=process.argv[2]||'check'
if(mode==='backtest'||mode==='report'){
  const cfg=cfgFor(TFRAME)
  console.log(`Timeframe: ${TFRAME} (${cfg.td}) · trend filter ${cfg.trendMin}m · ATR band ${cfg.atrLow}–${cfg.atrHigh}%`)
  console.log(`⚠️  BACKTEST SOURCE = ${SOURCE}. This MUST be the same venue you trade live, or the results are invalid.`)
  if(SOURCE==='yahoo') console.log('    Yahoo spot is patchy intraday — use OANDA for both backtest and live.')
  const raw = SOURCE==='twelvedata'
    ? await fetchTwelveDataPaged(parseInt(process.env.BARS)||cfg.target,cfg)
    : await fetchCandles(5000,cfg)
  const v=validateData(raw.filter(x=>x.complete!==false),cfg)
  console.log(`Data: ${v.clean.length} clean ${TFRAME} bars (~${(v.clean.length*cfg.min/60/24).toFixed(1)}d) · validation:`, JSON.stringify(v.issues))
  console.log(`Costs: base spread $${SPREAD_BASE} (×${SPREAD_NEWS_MULT} news, ×${SPREAD_ROLLOVER_MULT} rollover, ×${SPREAD_VOL_MULT} volatile), entry slip $${ENTRY_SLIP}, stop slip $${STOP_SLIP}/$${STOP_SLIP_FAST} fast, commission $${COMMISSION_USD}`)
  console.log(`Governor: daily ${DAILY_LOSS_LIMIT_R}R · consec ${MAX_CONSEC_LOSSES} · kill ${KILL_DD_R}R DD\n`)
  const bt=backtest(v.clean,cfg)
  const rep=fullReport(bt)
  if(mode==='report'){ fs.writeFileSync(REPORT_FILE,JSON.stringify({generated:new Date().toISOString(),timeframe:TFRAME,source:SOURCE,dataIssues:v.issues,...bt,report:rep},null,2)); console.log(`Full report → ${REPORT_FILE}\n`) }
  console.log(JSON.stringify(mode==='report'?rep:{overall:rep.overall,governor:rep.governor,bootstrap:rep.bootstrap,outSample:rep.outSample},null,2))
} else { await check() }
