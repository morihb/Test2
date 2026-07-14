// ─────────────────────────────────────────────────────────────
//  GOLD.AI — v4.4e  (multi-symbol · multi-timeframe · SPEED-AWARE +
//  ATR DIAGNOSTIC LOGGING + 1m PRESET FIX + S/R TP BUFFER FIX)
//
//  New in v4.4e:
//   • RESPECT SUPPORT/RESISTANCE ON TPs — placeTPs()'s scalp/intraday path
//     (used by every non-SWING timeframe) had a bug where, if a nearby
//     resistance/support/liquidity level was found "in path" toward a TP
//     but the buffered (pulled-back) point failed a minimum-distance sanity
//     check, the code abandoned the buffer ENTIRELY and fell back to the
//     raw, un-buffered R-multiple target — which is the same value that
//     made that level "in path" to begin with. Net effect: TP would land
//     almost exactly ON the level, and real trades would frequently miss it
//     by a few cents on the wick. Fixed by always applying the buffer once
//     a level is found, and relaxing the minimum-forward-progress floor
//     specifically for a level-snapped TP (R*0.15 instead of R*0.4) so it
//     can never get pushed back up past its own buffer and onto the level.
//     Also widened the buffer itself (~15-20% larger: 0.35/0.25/0.7×ATR for
//     normal/ranging/volatile regimes, was 0.3/0.2/0.6) for extra real-world
//     margin against ordinary spread/noise.
//
//  v4.4d: added the missing '1m' TF_PRESETS/TRADE_PROFILES entry — '1m' was
//  silently falling back to the 5m preset (fetching 5-minute candles while
//  labeled 1m).
//
//  v4.4c: WAIT logs now print actual ATR% + calibrated band for
//  low_liquidity / hard-band diagnostics.
//
//  v4.4b: brain gate removed. Everything else (adaptive ATR band,
//  trade profiles, scoring, TP/SL logic) unchanged from v4.4.
// ─────────────────────────────────────────────────────────────
import fs from 'fs'

// ── CONFIG ────────────────────────────────────────────────────
const TG_TOKEN=process.env.TG_TOKEN||'', TG_CHAT=process.env.TG_CHAT||''
const envNum=(k,d)=>process.env[k]!==undefined&&process.env[k]!==''?parseFloat(process.env[k]):d
const ACCT=parseFloat(process.env.ACCT)||10000, RISK=parseFloat(process.env.RISK)||1
const STATE_FILE='./bot_state.json', TRADE_LOG='./trade_log.json', REPORT_FILE='./report.json'

// ── SYMBOL (all injected by launcher per-symbol run) ─────────
const SYMBOL_LABEL   = process.env.SYMBOL_LABEL    || 'GOLD'
const SYMBOL_TD      = process.env.SYMBOL_TD       || 'XAU/USD'
const SYMBOL_OANDA   = process.env.SYMBOL_OANDA    || 'XAU_USD'
const SYMBOL_YAHOO   = process.env.SYMBOL_YAHOO    || 'XAUUSD=X'
const SYMBOL_DECIMALS= parseInt(process.env.SYMBOL_DECIMALS||'2')
const fmt = n => n!=null ? (+n).toFixed(SYMBOL_DECIMALS) : '—'

const LIVE_TFS=(process.env.LIVE_TFS||'15m,1h').split(',').map(s=>s.trim()).filter(Boolean)

// cost model
const SPREAD_BASE=parseFloat(process.env.SPREAD)||0.30
const SPREAD_NEWS_MULT=8, SPREAD_ROLLOVER_MULT=5, SPREAD_VOL_MULT=2.5
const ENTRY_SLIP=parseFloat(process.env.ENTRY_SLIP)||0.10
const STOP_SLIP=parseFloat(process.env.STOP_SLIP)||0.20
const STOP_SLIP_FAST=parseFloat(process.env.STOP_SLIP_FAST)||2.0
const COMMISSION_USD=parseFloat(process.env.COMMISSION)||0

// risk governor
const DAILY_LOSS_LIMIT_R=envNum('DAILY_LOSS_R',3)
const MAX_CONSEC_LOSSES=envNum('MAX_CONSEC',4)
const KILL_DD_R=envNum('KILL_DD_R',10)

// ── DECISION-QUALITY GATES (toggle via env) ──────────────────
const REQUIRE_CANDLE_CONFIRM = process.env.REQUIRE_CANDLE_CONFIRM!=='0'
const SPREAD_TP1_MIN_MULT    = parseFloat(process.env.SPREAD_TP1_MULT)||6
const SCALP_OFFHOURS_STRICT  = process.env.SCALP_OFFHOURS_STRICT!=='0'
const CONFLUENCE_MIN         = envNum('CONFLUENCE_MIN',0)

// ── TIMEFRAME PRESETS (data/interval/regime bands) ───────────
const TF_PRESETS={
  '1m': {min:1,   td:'1min', oanda:'M1', trendMin:15,   structMin:5,   atrLow:0.02,atrHigh:0.35,window:480, warmup:300,maxHold:20,target:40000},
  '5m': {min:5,   td:'5min', oanda:'M5', trendMin:60,   structMin:15,  atrLow:0.04,atrHigh:0.55,window:1200,warmup:700,maxHold:24,target:30000},
  '15m':{min:15,  td:'15min',oanda:'M15',trendMin:240,  structMin:60,  atrLow:0.08,atrHigh:0.80,window:600, warmup:400,maxHold:24,target:25000},
  '1h': {min:60,  td:'1h',   oanda:'H1', trendMin:240,  structMin:60,  atrLow:0.15,atrHigh:1.20,window:400, warmup:300,maxHold:24,target:20000},
  '4h': {min:240, td:'4h',   oanda:'H4', trendMin:1440, structMin:240, atrLow:0.15,atrHigh:1.50,window:360, warmup:240,maxHold:24,target:15000},
  '1d': {min:1440,td:'1day', oanda:'D',  trendMin:10080,structMin:1440,atrLow:0.40,atrHigh:2.80,window:400, warmup:300,maxHold:20,target:8000},
}

// ── TRADE PROFILES — the "speed" layer ───────────────────────
const TRADE_PROFILES={
  '1m' : {type:'SCALP',    maxHold:10, tpR:[1.0,1.5,2.0], tpCapAtr:3,  minStopAtr:0.5, liquidity:'off'},
  '5m' : {type:'SCALP',    maxHold:12, tpR:[1.0,1.5,2.0], tpCapAtr:3,  minStopAtr:0.6, liquidity:'off'},
  '15m': {type:'SCALP',    maxHold:12, tpR:[1.0,1.5,2.0], tpCapAtr:4,  minStopAtr:0.7, liquidity:'off'},
  '1h' : {type:'INTRADAY', maxHold:10, tpR:[1.0,1.6,2.5], tpCapAtr:6,  minStopAtr:0.8, liquidity:'light'},
  '4h' : {type:'SWING',    maxHold:18, tpR:[1.5,2.5,4.0], tpCapAtr:12, minStopAtr:1.0, liquidity:'on'},
  '1d' : {type:'SWING',    maxHold:16, tpR:[1.5,2.5,4.0], tpCapAtr:14, minStopAtr:1.0, liquidity:'on'},
}
function profileFor(tf){ return TRADE_PROFILES[tf] || TRADE_PROFILES['15m'] }

const TFRAME=process.env.TF||'5m'
function cfgFor(tframe){
  const p=TF_PRESETS[tframe]||TF_PRESETS['5m']
  return { tframe, min:p.min, td:p.td, oanda:p.oanda, target:p.target,
    trendMin:envNum('TREND_MIN',p.trendMin), structMin:envNum('STRUCT_MIN',p.structMin),
    atrLow:envNum('ATR_LOW',p.atrLow), atrHigh:envNum('ATR_HIGH',p.atrHigh),
    window:envNum('WINDOW',p.window), warmup:envNum('WARMUP',p.warmup), maxHold:envNum('MAXHOLD',p.maxHold) }
}

const MIN_NET=envNum('MIN_NET',30), MIN_CONV=envNum('MIN_CONV',0.35), MAX_CONFLICT=envNum('MAX_CONFLICT',0.40)
const USE_MTF=process.env.USE_MTF!=='0'
const TP_PLAN=[{tp:'tp1',w:0.5},{tp:'tp2',w:0.3},{tp:'tp3',w:0.2}]
const BE_LOCK_R   = parseFloat(process.env.BE_LOCK_R)   || 0.2
const BE_FULL_AT_R= parseFloat(process.env.BE_FULL_AT_R)|| 1.5
const NEWS_BLACKOUT_MIN={before:30,after:30}
function loadNewsEvents(){
  try{
    const raw=JSON.parse(fs.readFileSync('./news_events.json','utf8'))
    const arr=Array.isArray(raw)?raw:(raw.events||[])
    return arr.filter(e=>e&&e.time&&!isNaN(new Date(e.time).getTime()))
  }catch{ return [] }
}
const NEWS_EVENTS=loadNewsEvents()
const TF={scalp:{slb:3}}

function holdText(bars,minPerBar){
  const mins=bars*minPerBar
  if(mins<60) return `${mins}m`
  const h=mins/60
  if(h<24) return `${h%1===0?h:h.toFixed(1)}h`
  return `${(h/24).toFixed(1)}d`
}

// ── MATH ────────────────────────────────────────────────────
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

function resampleTF(c,minutes){
  const ms=minutes*60000,map=new Map()
  for(const bar of c){ const k=Math.floor(bar.timestamp/ms)*ms
    const b=map.get(k)
    if(!b) map.set(k,{timestamp:k,open:bar.open,high:bar.high,low:bar.low,close:bar.close})
    else{b.high=Math.max(b.high,bar.high);b.low=Math.min(b.low,bar.low);b.close=bar.close} }
  return [...map.values()].sort((a,b)=>a.timestamp-b.timestamp).map(b=>({...b,price:b.close})).slice(0,-1)
}

// ── REGIME / STRUCTURE / SESSION ────────────────────────────
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

function sessionOf(ts){ const d=new Date(ts),h=d.getUTCHours()+d.getUTCMinutes()/60
  if(h>=0&&h<10) return 'asian'; if(h>=10&&h<14) return 'london'
  if(h>=14&&h<19) return 'london_ny'; if(h>=19&&h<23) return 'ny'; return 'offhours' }
const SESSION_LABEL={asian:'🌏 Asian',london:'🇬🇧 London',london_ny:'🌍🗽 London+NY',ny:'🗽 New York',offhours:'🌙 Off-hours'}

function detectStructure(c,lb=3){ const H=[],L=[]
  for(let i=lb;i<c.length-lb;i++){ const v=c[i].close
    const lf=c.slice(i-lb,i).map(d=>d.close),rt=c.slice(i+1,i+1+lb).map(d=>d.close)
    if(v>Math.max(...lf)&&v>Math.max(...rt)){
      const rev=v-Math.min(...rt); H.push({...c[i],idx:i,reversal:rev}) }
    if(v<Math.min(...lf)&&v<Math.min(...rt)){
      const rev=Math.max(...rt)-v; L.push({...c[i],idx:i,reversal:rev}) } }
  let bos='none',choch='none'
  if(H.length>=2&&L.length>=2){ const rH=H[H.length-1],pH=H[H.length-2],rL=L[L.length-1],pL=L[L.length-2]
    if(rH.close>pH.close&&rL.close>pL.close) bos='bullish'
    if(rH.close<pH.close&&rL.close<pL.close) bos='bearish'
    if(bos==='bullish'&&last(c).close<rL.close) choch='bearish_choch'
    if(bos==='bearish'&&last(c).close>rH.close) choch='bullish_choch' }
  return {H,L,rH:H.length?H[H.length-1]:null,rL:L.length?L[L.length-1]:null,bos,choch} }

// ── SWING QUALITY SCORING (no look-ahead) ────────────────────
function scoreSwings(swings, allSwings, atr, lastIdx, price){
  if(!atr||atr<=0) return swings.map(s=>({...s,strength:0,touches:0}))
  const tol = atr*0.15
  return swings.map(s=>{
    const touches = allSwings.filter(o => Math.abs((o.high??o.low) - (s.high??s.low)) <= tol).length
    const reversalSize = s.reversal != null ? s.reversal : 0
    const age = Math.max(0, lastIdx - s.idx)
    const ageFactor = Math.min(age / 20, 5)
    const distAtr = Math.abs((s.high??s.low) - price)/atr
    const distFactor = distAtr<=8 ? 1 : Math.max(0, 1 - (distAtr-8)/8)
    const strength = (touches*3) + (reversalSize*2) + ageFactor + distFactor
    return {...s, strength:+strength.toFixed(2), touches}
  })
}

// ── EQUAL HIGHS / EQUAL LOWS (liquidity magnets) ─────────────
function detectEqualLevels(swingHighs, swingLows, atr){
  if(!atr||atr<=0) return {equalHighs:[],equalLows:[]}
  const tol = atr*0.15
  const cluster = (arr, key, pickExtreme) => {
    const used=new Array(arr.length).fill(false), out=[]
    for(let i=0;i<arr.length;i++){ if(used[i]) continue
      const group=[arr[i]]; used[i]=true
      for(let j=i+1;j<arr.length;j++){ if(used[j]) continue
        if(Math.abs(arr[j][key]-arr[i][key])<=tol){ group.push(arr[j]); used[j]=true } }
      if(group.length>=2){
        const level = pickExtreme(group.map(g=>g[key]))
        out.push({ level, count:group.length, idx:Math.max(...group.map(g=>g.idx)) })
      }
    }
    return out
  }
  return {
    equalHighs: cluster(swingHighs,'high',vals=>Math.max(...vals)),
    equalLows:  cluster(swingLows, 'low', vals=>Math.min(...vals)),
  }
}

function detectLiquiditySweep(c){ const last5=c.slice(-5),prev=c.slice(-20,-5)
  if(!prev.length) return {sweepBull:false,sweepBear:false}
  const pH=Math.max(...prev.map(x=>x.high)),pL=Math.min(...prev.map(x=>x.low)); let sb=false,ss=false
  for(const x of last5){ if(x.high>pH&&x.close<pH)ss=true; if(x.low<pL&&x.close>pL)sb=true }
  return {sweepBull:sb,sweepBear:ss,prevHigh:pH,prevLow:pL} }

function htfTrend(h1){ if(h1.length<50) return 'neutral'
  const p=h1.map(x=>x.close),e20=last(ema(p,20)),e50=last(ema(p,50)),price=last(p)
  if(e20&&e50&&price>e50&&e20>e50) return 'bullish'
  if(e20&&e50&&price<e50&&e20<e50) return 'bearish'; return 'neutral' }

function candleConfirms(dir, bar){
  if(!bar) return true
  const range=bar.high-bar.low; if(range<=0) return true
  const closePos=(bar.close-bar.low)/range
  if(dir==='BUY')  return closePos>=0.40
  if(dir==='SELL') return closePos<=0.60
  return true
}

// ── COST MODEL ───────────────────────────────────────────────
function inNewsBlackout(ts){ for(const e of NEWS_EVENTS){ const et=new Date(e.time).getTime()
  if(ts>=et-NEWS_BLACKOUT_MIN.before*60000&&ts<=et+NEWS_BLACKOUT_MIN.after*60000) return e.label } return null }
function isRollover(ts){ return new Date(ts).getUTCHours()===21 }
function spreadAt(ts,regime){ let s=SPREAD_BASE
  if(inNewsBlackout(ts)) s*=SPREAD_NEWS_MULT
  else if(isRollover(ts)) s*=SPREAD_ROLLOVER_MULT
  else if(regime==='volatile_expansion') s*=SPREAD_VOL_MULT
  return s }
function stopSlipAt(ts,regime){ return (inNewsBlackout(ts)||regime==='volatile_expansion')?STOP_SLIP_FAST:STOP_SLIP }

// ── TP PLACEMENT (shared by scalp + swing paths) ─────────────
function placeTPs(dir, entry, sl, atr, profile, allTargets, tpBuf){
  const R = Math.abs(entry - sl)

  if(profile.liquidity==='on'){
    const cands = allTargets
      .filter(t => dir==='BUY' ? (t.level > entry + R*0.8 && t.level <= entry + atr*12)
                               : (t.level < entry - R*0.8 && t.level >= entry - atr*12))
      .map(t => ({ ...t, dist:Math.abs(t.level-entry), score:t.base + t.strength*2 + t.tfWeight*5 }))
    cands.sort((a,b)=> b.score - a.score || a.dist - b.dist)
    const picked=[]
    for(const c of cands){
      const ok = picked.length===0 ||
        (dir==='BUY' ? c.level > picked[picked.length-1].level + R*0.4
                     : c.level < picked[picked.length-1].level - R*0.4)
      if(ok){ picked.push(c); if(picked.length===3) break }
    }
    const fb=[R*1.5,R*2.5,R*4.0]
    const cap = dir==='BUY' ? entry + Math.max(atr*12, R*5) : entry - Math.max(atr*12, R*5)
    const place=(i,prevTp)=>{
      const bound = dir==='BUY' ? (prevTp??entry)+R*0.5 : (prevTp??entry)-R*0.5
      let lvl = picked[i] ? (dir==='BUY'? picked[i].level - tpBuf : picked[i].level + tpBuf)
                          : (dir==='BUY'? entry+fb[i] : entry-fb[i])
      lvl = dir==='BUY' ? Math.max(lvl,bound) : Math.min(lvl,bound)
      lvl = dir==='BUY' ? Math.min(lvl,cap)  : Math.max(lvl,cap)
      if(dir==='BUY' ? lvl<bound : lvl>bound) lvl = dir==='BUY' ? Math.min(bound,cap) : Math.max(bound,cap)
      return +lvl.toFixed(SYMBOL_DECIMALS)
    }
    const tp1=place(0,null), tp2=place(1,tp1), tp3=place(2,tp2)
    return { tp1,tp2,tp3, tpInfo:picked.map(p=>p.kind) }
  }

  const cap = profile.tpCapAtr*atr
  const levels = allTargets
    .filter(t => dir==='BUY' ? t.level>entry : t.level<entry)
    .sort((a,b)=> Math.abs(a.level-entry) - Math.abs(b.level-entry))
  const tps=[]; let prev=entry
  for(let k=0;k<3;k++){
    let target = dir==='BUY' ? entry + R*profile.tpR[k] : entry - R*profile.tpR[k]
    target = dir==='BUY' ? Math.min(target, entry+cap) : Math.max(target, entry-cap)
    let kind = `${profile.tpR[k]}R`
    let snappedToLevel = false
    for(const lv of levels){
      const inPath = dir==='BUY' ? (lv.level > prev + R*0.3 && lv.level <= target)
                                 : (lv.level < prev - R*0.3 && lv.level >= target)
      if(inPath){
        // Respect the level — ALWAYS take profit before it, never on top of
        // it. Previously, if this buffered point failed a minimum-distance
        // sanity check, the code fell all the way back to the raw,
        // un-buffered R-multiple target — which is the same value that made
        // this level "in path" in the first place, so TP would land almost
        // exactly ON the resistance/support and miss by cents. Now the
        // buffer is applied unconditionally; the minimum-progress floor
        // below is relaxed for a snapped TP specifically so it can never
        // push the target back into the level it was just pulled off of.
        target = dir==='BUY' ? lv.level - tpBuf : lv.level + tpBuf
        kind = lv.kind
        snappedToLevel = true
        break
      }
    }
    // Minimum forward progress from the previous TP. A level-snapped TP
    // only needs enough separation to stay meaningfully distinct from the
    // previous TP (R*0.15) — enforcing the full R*0.4 here would risk
    // shoving it back up past the buffer and onto the level itself. A
    // plain R-multiple TP (no level found nearby) keeps the original R*0.4.
    const minProgress = snappedToLevel ? R*0.15 : R*0.4
    target = dir==='BUY' ? Math.max(target, prev + minProgress) : Math.min(target, prev - minProgress)
    tps.push({lvl:+target.toFixed(SYMBOL_DECIMALS), kind}); prev=target
  }
  return { tp1:tps[0].lvl, tp2:tps[1].lvl, tp3:tps[2].lvl, tpInfo:tps.map(t=>t.kind) }
}

// ── SCORING ──────────────────────────────────────────────────
const WEIGHTS={regime:25,liquidity:20,structure:20,ema:12,macd:8,osc:10,sma:5}
const TOTAL=Object.values(WEIGHTS).reduce((a,b)=>a+b,0)

function analyse(candles,nowMs,cfg){
  const profile=profileFor(cfg.tframe)
  const price=last(candles).close,prices=candles.map(c=>c.close)
  const reg=marketRegime(candles,price,cfg),str=detectStructure(candles,TF.scalp.slb),liq=detectLiquiditySweep(candles)
  const e20=last(ema(prices,20)),e50=last(ema(prices,50))
  const rsi=rsiCalc(prices),macd=macdCalc(prices),bb=bbCalc(prices),st=stochCalc(candles),s20=sma20(candles),atr=atrCalc(candles)
  if(!atr||reg.regime==='low_liquidity') return wait('low liquidity / no ATR',reg,cfg)
  // adaptive hard sanity band scales with the per-symbol calibrated band
  // (forex ATR% is far below gold's — a fixed 0.03% floor blocked pairs)
  const hardLow=Math.min(0.03,cfg.atrLow*0.5), hardHigh=Math.max(3.0,cfg.atrHigh*2)
  if(reg.atrPct<hardLow||reg.atrPct>hardHigh) return wait(`ATR ${reg.atrPct?.toFixed(3)}% outside band`,reg,cfg)
  const news=inNewsBlackout(nowMs); if(news) return wait(`news blackout: ${news}`,reg,cfg)
  let h1Trend='neutral',m15Bos='none'
  if(USE_MTF){ const h1=resampleTF(candles,cfg.trendMin),m15=resampleTF(candles,cfg.structMin)
    h1Trend=htfTrend(h1); if(m15.length>20) m15Bos=detectStructure(m15,3).bos }
  let bull=0,bear=0; const reasons=[]
  if(reg.regime==='trending_bull'){bull+=WEIGHTS.regime;reasons.push('Regime bull')}
  else if(reg.regime==='trending_bear'){bear+=WEIGHTS.regime;reasons.push('Regime bear')}
  if(liq.sweepBull){bull+=WEIGHTS.liquidity;reasons.push('Sell-side liq swept')}
  if(liq.sweepBear){bear+=WEIGHTS.liquidity;reasons.push('Buy-side liq swept')}
  if(str.bos==='bullish'||str.choch==='bullish_choch'){bull+=WEIGHTS.structure;reasons.push('Bullish BOS/CHoCH')}
  if(str.bos==='bearish'||str.choch==='bearish_choch'){bear+=WEIGHTS.structure;reasons.push('Bearish BOS/CHoCH')}
  if(reg.allowTrend){
    if(e20&&e50&&e20>e50&&price>e20) bull+=WEIGHTS.ema
    if(e20&&e50&&e20<e50&&price<e20) bear+=WEIGHTS.ema
    if(macd.hist!=null&&macd.hist>0) bull+=WEIGHTS.macd
    if(macd.hist!=null&&macd.hist<0) bear+=WEIGHTS.macd
    if(s20&&price>s20) bull+=WEIGHTS.sma; else if(s20&&price<s20) bear+=WEIGHTS.sma }
  if(reg.allowMR&&rsi!=null&&st!=null&&bb){
    if(price<=bb.lower&&rsi<35&&st<25){bull+=WEIGHTS.osc;reasons.push('Oversold reclaim')}
    if(price>=bb.upper&&rsi>65&&st>75){bear+=WEIGHTS.osc;reasons.push('Overbought reject')} }
  const dominant=Math.max(bull,bear),opposing=Math.min(bull,bear),net=dominant-opposing
  const conv=net/TOTAL,conflict=dominant?opposing/dominant:0
  const dir0=bull===bear?'WAIT':(bull>bear?'BUY':'SELL')
  if(dir0==='WAIT'||net<MIN_NET||conv<MIN_CONV) return wait(`net ${net} conv ${conv.toFixed(2)} below floor`,reg,cfg,{net,bull,bear})
  if(conflict>MAX_CONFLICT) return wait(`conflict ${(conflict*100|0)}%`,reg,cfg,{net,bull,bear})
  if(USE_MTF){
    const oppH1=(dir0==='BUY'&&h1Trend==='bearish')||(dir0==='SELL'&&h1Trend==='bullish')
    if(oppH1) return wait(`opposes H1 (${h1Trend})`,reg,cfg,{net,bull,bear})
    const oppM15=(dir0==='BUY'&&m15Bos==='bearish')||(dir0==='SELL'&&m15Bos==='bullish')
    if(oppM15&&conv<MIN_CONV+0.15) return wait('opposes M15 & weak',reg,cfg,{net,bull,bear}) }
  const dir=dir0,score=Math.round(conv*100),tier=score>=70?'A':score>=55?'B':'C'

  // ── confluence count (transparency + optional gate) ──────────
  const confl=[
    (dir==='BUY'&&reg.regime==='trending_bull')||(dir==='SELL'&&reg.regime==='trending_bear'),
    (dir==='BUY'&&(str.bos==='bullish'||str.choch==='bullish_choch'))||(dir==='SELL'&&(str.bos==='bearish'||str.choch==='bearish_choch')),
    (dir==='BUY'&&liq.sweepBull)||(dir==='SELL'&&liq.sweepBear),
    (dir==='BUY'&&e20&&e50&&e20>e50&&price>e20)||(dir==='SELL'&&e20&&e50&&e20<e50&&price<e20),
    (dir==='BUY'&&macd.hist>0)||(dir==='SELL'&&macd.hist<0),
    (dir==='BUY'&&h1Trend==='bullish')||(dir==='SELL'&&h1Trend==='bearish'),
  ].filter(Boolean).length
  if(CONFLUENCE_MIN>0 && confl<CONFLUENCE_MIN) return wait(`confluence ${confl}/<${CONFLUENCE_MIN}`,reg,cfg,{net,bull,bear})

  if(REQUIRE_CANDLE_CONFIRM && profile.type!=='SWING' && !candleConfirms(dir,last(candles)))
    return wait('candle not confirming',reg,cfg,{net,bull,bear})

  if(SCALP_OFFHOURS_STRICT && profile.type!=='SWING' && sessionOf(nowMs)==='offhours' && conv<MIN_CONV+0.10)
    return wait('off-hours scalp & weak',reg,cfg,{net,bull,bear})

  const buf = reg.regime==='volatile_expansion' ? atr*0.8 : atr*0.5
  const stopMult = reg.regime==='volatile_expansion' ? 2.5 : 1.8

  const barsPerDay  = Math.max(1, Math.round(1440 / cfg.min))
  const dayCandles  = candles.slice(-Math.min(candles.length, barsPerDay))
  const prevDayLow  = Math.min(...dayCandles.map(c=>c.low))
  const prevDayHigh = Math.max(...dayCandles.map(c=>c.high))
  const barsPerWeek = Math.max(1, barsPerDay*7)
  const weekCandles = candles.slice(-Math.min(candles.length, barsPerWeek))
  const weekLow     = Math.min(...weekCandles.map(c=>c.low))
  const weekHigh    = Math.max(...weekCandles.map(c=>c.high))

  const htfDefs=[{mins:cfg.min,weight:1},{mins:15,weight:2},{mins:60,weight:3},{mins:240,weight:4}]
  const pooledHighs=[], pooledLows=[]
  for(const def of htfDefs){
    if(def.mins<cfg.min) continue
    const series = def.mins===cfg.min ? candles : resampleTF(candles,def.mins)
    if(series.length<30) continue
    const s=detectStructure(series,3), lastIdx=series.length-1, sp=last(series).close
    pooledHighs.push(...scoreSwings(s.H,s.H,atr,lastIdx,sp).map(h=>({...h,tfWeight:def.weight})))
    pooledLows .push(...scoreSwings(s.L,s.L,atr,lastIdx,sp).map(l=>({...l,tfWeight:def.weight})))
  }
  const { equalHighs, equalLows } = detectEqualLevels(str.H, str.L, atr)
  // Buffer kept BEFORE any resistance/support/liquidity level when placing
  // TPs — widened slightly (was 0.6/0.2/0.3×ATR) so a TP doesn't sit close
  // enough to the level that ordinary spread/noise stops it a few cents
  // short. See placeTPs() for how this is applied.
  const tpBuf = reg.regime==='volatile_expansion' ? atr*0.7
              : reg.regime==='ranging'            ? atr*0.25
              :                                      atr*0.35

  const buildTargets=(d)=>{
    const t=[]
    if(d==='BUY'){
      for(const e of equalHighs) t.push({level:e.level,kind:'EqualHigh',base:100,strength:e.count*3,tfWeight:1})
      t.push({level:prevDayHigh,kind:'PDH',base:80,strength:2,tfWeight:1})
      t.push({level:weekHigh,   kind:'WeekHigh',base:70,strength:2,tfWeight:1})
      for(const h of pooledHighs) t.push({level:h.high,kind:'Swing',base:40,strength:h.strength,tfWeight:h.tfWeight})
    }else{
      for(const e of equalLows) t.push({level:e.level,kind:'EqualLow',base:100,strength:e.count*3,tfWeight:1})
      t.push({level:prevDayLow,kind:'PDL',base:80,strength:2,tfWeight:1})
      t.push({level:weekLow,   kind:'WeekLow',base:70,strength:2,tfWeight:1})
      for(const l of pooledLows) t.push({level:l.low,kind:'Swing',base:40,strength:l.strength,tfWeight:l.tfWeight})
    }
    return t
  }

  let entry=price, sl
  if(dir==='BUY'){
    const sweepWickLow  = liq.sweepBull && liq.prevLow ? liq.prevLow : null
    const structWickLow = str.rL ? str.rL.low : null
    const dayLow        = prevDayLow < price ? prevDayLow : null
    let anchor=null
    if(sweepWickLow  && sweepWickLow  < entry) anchor=sweepWickLow
    else if(structWickLow && structWickLow < entry) anchor=structWickLow
    else if(dayLow        && dayLow        < entry) anchor=dayLow
    let slRaw = anchor ? anchor - buf : entry - atr*stopMult
    if(slRaw >= entry) slRaw = entry - atr*stopMult
    sl = +Math.max(slRaw, entry - atr*5).toFixed(SYMBOL_DECIMALS)
    if(entry - sl < profile.minStopAtr*atr)
      sl = +Math.max(entry - profile.minStopAtr*atr, entry - atr*5).toFixed(SYMBOL_DECIMALS)
  }else{
    const sweepWickHigh  = liq.sweepBear && liq.prevHigh ? liq.prevHigh : null
    const structWickHigh = str.rH ? str.rH.high : null
    const dayHigh        = prevDayHigh > price ? prevDayHigh : null
    let anchor=null
    if(sweepWickHigh  && sweepWickHigh  > entry) anchor=sweepWickHigh
    else if(structWickHigh && structWickHigh > entry) anchor=structWickHigh
    else if(dayHigh        && dayHigh        > entry) anchor=dayHigh
    let slRaw = anchor ? anchor + buf : entry + atr*stopMult
    if(slRaw <= entry) slRaw = entry + atr*stopMult
    sl = +Math.min(slRaw, entry + atr*5).toFixed(SYMBOL_DECIMALS)
    if(sl - entry < profile.minStopAtr*atr)
      sl = +Math.min(entry + profile.minStopAtr*atr, entry + atr*5).toFixed(SYMBOL_DECIMALS)
  }

  const { tp1, tp2, tp3, tpInfo } = placeTPs(dir, entry, sl, atr, profile, buildTargets(dir), tpBuf)

  const spr = spreadAt(nowMs, reg.regime)
  if(Math.abs(tp1-entry) < SPREAD_TP1_MIN_MULT*spr)
    return wait('TP1 too small vs spread',reg,cfg,{net,bull,bear})

  const riskUSD=ACCT*(RISK/100),units=riskUSD/Math.abs(entry-sl)
  return { symbol:SYMBOL_LABEL, tframe:cfg.tframe, tradeType:profile.type, maxHoldBars:profile.maxHold,
    direction:dir, score, tier, net, bull, bear, confluence:confl,
    conflict:+conflict.toFixed(2), regime:reg.regime, adx:reg.adx, atrPct:+reg.atrPct.toFixed(3),
    session:sessionOf(nowMs), h1Trend, m15Bos,
    entry:+entry.toFixed(SYMBOL_DECIMALS), sl, tp1, tp2, tp3, tpInfo,
    rr:`1:${Math.abs((tp2-entry)/(entry-sl)).toFixed(1)}`,
    units:+units.toFixed(2), posSize:`${units.toFixed(2)} units · $${riskUSD.toFixed(0)} risk`,
    inv:dir==='BUY'?`${cfg.tframe} close below ${fmt(sl)}`:`${cfg.tframe} close above ${fmt(sl)}`,
    reasons, skipped:false }
}
// ── DIAGNOSTIC-ENRICHED WAIT (v4.4c) ──────────────────────────
// Every WAIT now carries the actual measured atrPct plus the exact
// atrLow/atrHigh band it was judged against (cfg's calibrated values —
// the SAME numbers marketRegime() and the hard-band check above just
// used), so the console log can show real numbers instead of just a
// regime label. Costs nothing extra to compute — reg already has atrPct.
function wait(why,reg,cfg,extra={}){
  return { direction:'WAIT', skipped:true, why, symbol:SYMBOL_LABEL, tframe:cfg?.tframe,
    regime:reg?.regime, atrPct:reg?.atrPct??null, atrLow:cfg?.atrLow??null, atrHigh:cfg?.atrHigh??null,
    ...extra }
}

// ── DATA VALIDATION ──────────────────────────────────────────
function validateData(c,cfg){
  const issues={dups:0,badTs:0,outliers:0,midGaps:0,weekendGaps:0}
  const sorted=c.slice().sort((a,b)=>a.timestamp-b.timestamp)
  const ranges=sorted.map(x=>x.high-x.low).filter(r=>r>0).sort((a,b)=>a-b)
  const med=ranges.length?ranges[ranges.length>>1]:1
  const out=[]; let prev=null
  for(const bar of sorted){
    if(prev&&bar.timestamp===prev.timestamp){issues.dups++;continue}
    if(prev&&bar.timestamp<prev.timestamp){issues.badTs++;continue}
    const jump=prev?Math.abs(bar.open-prev.close):0
    if((bar.high-bar.low)>med*25||jump>med*25){issues.outliers++;continue}
    if(prev){ const gap=bar.timestamp-prev.timestamp
      if(gap>cfg.min*60000*1.5){ if(gap>20*3600000) issues.weekendGaps++; else issues.midGaps++ } }
    out.push(bar); prev=bar }
  return {clean:out,issues,medianRange:+med.toFixed(2)} }

// ── DATA SOURCES (symbol-aware via env vars) ─────────────────
const SOURCE=process.env.GOLD_SOURCE||(process.env.OANDA_TOKEN?'oanda':process.env.TWELVEDATA_KEY?'twelvedata':'yahoo')

async function fetchCandles(count=500,cfg){
  if(SOURCE==='oanda')      return fetchOanda(count,cfg)
  if(SOURCE==='twelvedata') return fetchTwelveData(count,cfg)
  return fetchYahooSpot(cfg)
}

async function fetchOanda(count,cfg){
  const host=process.env.OANDA_ENV==='live'?'api-fxtrade.oanda.com':'api-fxpractice.oanda.com'
  const res=await fetch(`https://${host}/v3/instruments/${SYMBOL_OANDA}/candles?granularity=${cfg.oanda}&count=${Math.min(count,5000)}&price=M`,
    {headers:{Authorization:`Bearer ${process.env.OANDA_TOKEN}`}})
  if(!res.ok) throw new Error(`OANDA ${res.status}: ${await res.text()}`)
  const {candles=[]}=await res.json()
  const out=candles.map(c=>({timestamp:new Date(c.time).getTime(),open:+(+c.mid.o).toFixed(SYMBOL_DECIMALS),high:+(+c.mid.h).toFixed(SYMBOL_DECIMALS),low:+(+c.mid.l).toFixed(SYMBOL_DECIMALS),close:+(+c.mid.c).toFixed(SYMBOL_DECIMALS),price:+(+c.mid.c).toFixed(SYMBOL_DECIMALS),complete:c.complete}))
  if(out.length<200) throw new Error('OANDA: too few candles'); return out }

async function fetchTwelveData(count,cfg){
  const res=await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL_TD)}&interval=${cfg.td}&outputsize=${Math.min(count,5000)}&timezone=UTC&apikey=${process.env.TWELVEDATA_KEY}`)
  if(!res.ok) throw new Error(`TwelveData ${res.status}`)
  const j=await res.json()
  if(j.status==='error'||!j.values) throw new Error(`TwelveData: ${j.message||'no data'}`)
  const out=j.values.map(v=>({timestamp:new Date(v.datetime.replace(' ','T')+'Z').getTime(),open:+(+v.open).toFixed(SYMBOL_DECIMALS),high:+(+v.high).toFixed(SYMBOL_DECIMALS),low:+(+v.low).toFixed(SYMBOL_DECIMALS),close:+(+v.close).toFixed(SYMBOL_DECIMALS),price:+(+v.close).toFixed(SYMBOL_DECIMALS)})).reverse()
  if(out.length<200) throw new Error('TwelveData: too few candles'); return out }

async function fetchTwelveDataPaged(target=30000,cfg){
  const key=process.env.TWELVEDATA_KEY,all=new Map(); let endDate=null
  const maxPages=Math.ceil(target/5000)+3
  for(let page=0;page<maxPages;page++){
    let url=`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(SYMBOL_TD)}&interval=${cfg.td}&outputsize=5000&timezone=UTC&apikey=${key}`
    if(endDate) url+=`&end_date=${encodeURIComponent(endDate)}`
    const res=await fetch(url); if(!res.ok){console.error(`  TwelveData page ${page+1}: HTTP ${res.status} — stopping`);break}
    const j=await res.json()
    if(j.status==='error'||!j.values||!j.values.length){console.error(`  TwelveData: ${j.message||'no more history'} — stopping`);break}
    let added=0
    for(const v of j.values){ const ts=new Date(v.datetime.replace(' ','T')+'Z').getTime()
      if(!all.has(ts)){all.set(ts,{timestamp:ts,open:+(+v.open).toFixed(SYMBOL_DECIMALS),high:+(+v.high).toFixed(SYMBOL_DECIMALS),low:+(+v.low).toFixed(SYMBOL_DECIMALS),close:+(+v.close).toFixed(SYMBOL_DECIMALS),price:+(+v.close).toFixed(SYMBOL_DECIMALS)});added++} }
    const oldest=j.values[j.values.length-1].datetime
    console.log(`  page ${page+1}: +${added} bars (total ${all.size}) back to ${oldest}`)
    if(added===0||endDate===oldest||all.size>=target) break
    endDate=oldest
    await new Promise(r=>setTimeout(r,8500)) }
  const arr=[...all.values()].sort((a,b)=>a.timestamp-b.timestamp)
  if(arr.length<200) throw new Error('TwelveData paged: too few candles')
  return arr }

function parseYahoo(j){ const r=j.chart?.result?.[0]; if(!r?.timestamp) return []; const q=r.indicators.quote[0]
  return r.timestamp.map((t,i)=>{ const o=q.open?.[i],h=q.high?.[i],l=q.low?.[i],c=q.close?.[i]
    if([o,h,l,c].some(v=>v==null||isNaN(v))) return null
    return {timestamp:t*1000,open:+o.toFixed(SYMBOL_DECIMALS),high:+h.toFixed(SYMBOL_DECIMALS),low:+l.toFixed(SYMBOL_DECIMALS),close:+c.toFixed(SYMBOL_DECIMALS),price:+c.toFixed(SYMBOL_DECIMALS)}}).filter(Boolean) }

async function fetchYahooSpot(cfg){
  const iv=cfg.min>=1440?'1d':cfg.min===60?'1h':cfg.min===15?'15m':'5m'
  const range=cfg.min>=1440?'5y':cfg.min>=60?'730d':'60d'
  for(const q of ['query1','query2']){
    try{ const res=await fetch(`https://${q}.finance.yahoo.com/v8/finance/chart/${SYMBOL_YAHOO}?interval=${iv}&range=${range}`,{headers:{'User-Agent':'Mozilla/5.0'}})
      if(res.ok){ const a=parseYahoo(await res.json()); if(a.length>200) return a } }catch(_){} }
  throw new Error(`No Yahoo data for ${SYMBOL_YAHOO} — set OANDA_TOKEN or TWELVEDATA_KEY`) }

// ── SIMULATE TRADE ───────────────────────────────────────────
function simulateTrade(candles,i,sig,maxHold=24){
  if(i+1>=candles.length) return null
  const dir=sig.direction,eb=candles[i+1]
  const sEntry=spreadAt(eb.timestamp,sig.regime)
  const fill=dir==='BUY'?eb.open+sEntry/2+ENTRY_SLIP:eb.open-sEntry/2-ENTRY_SLIP
  const SL=sig.sl
  if((dir==='BUY'&&fill<=SL)||(dir==='SELL'&&fill>=SL)) return {skip:true,reason:'gap_past_stop'}
  const Rd=Math.abs(fill-SL); if(Rd<=1e-9) return {skip:true,reason:'zero_risk'}
  const riskUSD=ACCT*(RISK/100),commR=COMMISSION_USD/(riskUSD||1)
  const tps=TP_PLAN.map(t=>({px:sig[t.tp],w:t.w,taken:false}))
  let stop=SL,realized=-commR,remaining=1,mae=0,mfe=0,exitIdx=i+1,tp1Done=false
  for(let j=i+1;j<Math.min(i+1+maxHold,candles.length);j++){
    const bar=candles[j]; exitIdx=j
    const fav=dir==='BUY'?(bar.high-fill)/Rd:(fill-bar.low)/Rd
    const adv=dir==='BUY'?(fill-bar.low)/Rd:(bar.high-fill)/Rd
    mfe=Math.max(mfe,fav); mae=Math.max(mae,adv)
    const sx=spreadAt(bar.timestamp,sig.regime),ssl=stopSlipAt(bar.timestamp,sig.regime)
    if(tp1Done && mfe>=BE_FULL_AT_R){ stop = dir==='BUY' ? Math.max(stop,fill) : Math.min(stop,fill) }
    if(dir==='BUY'?bar.low<=stop:bar.high>=stop){
      const px=dir==='BUY'?stop-sx/2-ssl:stop+sx/2+ssl
      realized+=remaining*((dir==='BUY'?px-fill:fill-px)/Rd); remaining=0; break }
    for(const t of tps){ if(t.taken) continue
      if(dir==='BUY'?bar.high>=t.px:bar.low<=t.px){ const px=dir==='BUY'?t.px-sx/2:t.px+sx/2
        realized+=t.w*((dir==='BUY'?px-fill:fill-px)/Rd); t.taken=true; remaining-=t.w
        if(t.px===sig.tp1 && !tp1Done){ tp1Done=true
          stop = dir==='BUY' ? fill + Rd*BE_LOCK_R : fill - Rd*BE_LOCK_R } } }
    if(remaining<=1e-9) break }
  if(remaining>1e-9){ const bar=candles[exitIdx],sx=spreadAt(bar.timestamp,sig.regime)
    const px=dir==='BUY'?bar.close-sx/2:bar.close+sx/2; realized+=remaining*((dir==='BUY'?px-fill:fill-px)/Rd) }
  return {R:+realized.toFixed(3),bars:exitIdx-(i+1),mae:+mae.toFixed(2),mfe:+mfe.toFixed(2),
    session:sessionOf(eb.timestamp),regime:sig.regime,tier:sig.tier,score:sig.score,dir,
    day:new Date(eb.timestamp).toISOString().slice(0,10)} }

// ── BACKTEST (uses the profile's maxHold for the active TF) ──
function backtest(candles,cfg,opts={}){
  const profile=profileFor(cfg.tframe)
  const maxHold=opts.maxHold ?? profile.maxHold ?? cfg.maxHold
  const warmup=opts.warmup ?? cfg.warmup, window=opts.window ?? cfg.window
  const trades=[]; const skipped={governor_kill:0,governor_day:0,governor_consec:0,gap_past_stop:0,zero_risk:0}
  let i=warmup,equityR=0,peakR=0,consec=0,killed=false,curDay=null,dayR=0,dayHalted=false,lastBeat=warmup
  while(i<candles.length-2){
    if(i-lastBeat>=5000){console.error(`  …bar ${i}/${candles.length} · trades ${trades.length}`);lastBeat=i}
    const from=Math.max(0,i-window+1)
    const sig=analyse(candles.slice(from,i+1),candles[i].timestamp,cfg)
    if(sig.skipped){i++;continue}
    if(candles[i+1].timestamp-candles[i].timestamp>cfg.min*60000*1.5){i++;continue}
    const day=new Date(candles[i+1].timestamp).toISOString().slice(0,10)
    if(day!==curDay){curDay=day;dayR=0;dayHalted=false}
    if(killed){skipped.governor_kill++;i++;continue}
    if(dayHalted){skipped.governor_day++;i++;continue}
    if(consec>=MAX_CONSEC_LOSSES){skipped.governor_consec++;dayHalted=true;i++;continue}
    const t=simulateTrade(candles,i,sig,maxHold)
    if(!t){i++;continue}
    if(t.skip){skipped[t.reason]=(skipped[t.reason]||0)+1;i++;continue}
    trades.push(t)
    equityR+=t.R; peakR=Math.max(peakR,equityR); if(peakR-equityR>=KILL_DD_R) killed=true
    dayR+=t.R; if(dayR<=-DAILY_LOSS_LIMIT_R) dayHalted=true
    consec=t.R<=0?consec+1:0
    i=i+1+t.bars+1 }
  return {trades,skipped,killed,finalEquityR:+equityR.toFixed(2),maxHold} }

// ── STATS / REPORT ───────────────────────────────────────────
function agg(Rs){ if(!Rs.length) return {n:0}; const w=Rs.filter(r=>r>0),l=Rs.filter(r=>r<=0)
  const gw=w.reduce((a,b)=>a+b,0),gl=Math.abs(l.reduce((a,b)=>a+b,0))
  return {n:Rs.length,winRate:+(w.length/Rs.length*100).toFixed(1),exp:+(Rs.reduce((a,b)=>a+b,0)/Rs.length).toFixed(3),pf:gl?+(gw/gl).toFixed(2):(gw>0?99.99:0),totalR:+Rs.reduce((a,b)=>a+b,0).toFixed(2)} }
function group(trades,key){ const m={}; for(const t of trades){(m[t[key]]??=[]).push(t.R)}; return Object.fromEntries(Object.entries(m).map(([k,v])=>[k,agg(v)])) }
const scoreBucket=s=>s>=70?'70-100':s>=60?'60-69':s>=50?'50-59':'45-49'
function bootstrapExpectancy(Rs,B=3000){ if(Rs.length<10) return {note:'need >=10 trades'}
  const means=[]; for(let b=0;b<B;b++){let s=0;for(let k=0;k<Rs.length;k++) s+=Rs[(Math.random()*Rs.length)|0];means.push(s/Rs.length)}
  means.sort((a,b)=>a-b); const q=p=>+means[Math.floor(p*B)].toFixed(3)
  return {meanR:+(Rs.reduce((a,b)=>a+b,0)/Rs.length).toFixed(3),ci90:[q(0.05),q(0.95)],probPositive:+(means.filter(m=>m>0).length/B).toFixed(3)} }
function monteCarlo(Rs,B=3000){ if(Rs.length<10) return {note:'need >=10 trades'}
  const finals=[],dds=[]; const N=Rs.length
  for(let b=0;b<B;b++){let eq=0,peak=0,mdd=0; for(let k=0;k<N;k++){eq+=Rs[(Math.random()*N)|0];peak=Math.max(peak,eq);mdd=Math.min(mdd,eq-peak)} finals.push(eq);dds.push(mdd)}
  finals.sort((a,b)=>a-b);dds.sort((a,b)=>a-b); const q=(a,p)=>+a[Math.floor(p*a.length)].toFixed(2)
  return {finalR:{p5:q(finals,0.05),p50:q(finals,0.5),p95:q(finals,0.95)},maxDrawdownR:{p5:q(dds,0.05),p50:q(dds,0.5),p95:q(dds,0.95)},probNegative:+(finals.filter(f=>f<0).length/B).toFixed(3),probBlowupBelow_neg10R:+(finals.filter(f=>f<-10).length/B).toFixed(3)} }

function fullReport(bt){
  const trades=bt.trades
  if(trades.length<1) return {trades:0,governor:bt.skipped,note:'No trades taken.'}
  const Rs=trades.map(t=>t.R)
  let peak=0,cum=0,mdd=0; for(const r of Rs){cum+=r;peak=Math.max(peak,cum);mdd=Math.min(mdd,cum-peak)}
  const overall={...agg(Rs),maxDrawdownR:+mdd.toFixed(2),avgMAE:+(trades.reduce((a,t)=>a+t.mae,0)/trades.length).toFixed(2),avgMFE:+(trades.reduce((a,t)=>a+t.mfe,0)/trades.length).toFixed(2),avgBars:+(trades.reduce((a,t)=>a+t.bars,0)/trades.length).toFixed(1)}
  const K=5,folds=[],fs=Math.floor(trades.length/K)
  for(let k=0;k<K&&fs>0;k++) folds.push({fold:k+1,...agg(trades.slice(k*fs,(k+1)*fs).map(t=>t.R))})
  const cut=Math.floor(trades.length*0.7)
  const byRegime=group(trades,'regime'),bySession=group(trades,'session'),byTier=group(trades,'tier'),byScore=group(trades.map(t=>({...t,bucket:scoreBucket(t.score)})),'bucket')
  const pick=(o,best)=>{const e=Object.entries(o).filter(([,v])=>v.n>=5);if(!e.length) return null;e.sort((a,b)=>best?b[1].exp-a[1].exp:a[1].exp-b[1].exp);return{key:e[0][0],...e[0][1]}}
  return {overall,governor:{...bt.skipped,killSwitchFired:bt.killed,finalEquityR:bt.finalEquityR,maxHold:bt.maxHold},
    inSample:agg(trades.slice(0,cut).map(t=>t.R)),outSample:agg(trades.slice(cut).map(t=>t.R)),
    walkForwardFolds:folds,bootstrap:bootstrapExpectancy(Rs),monteCarlo:monteCarlo(Rs),
    byRegime,bySession,byTier,byScore,
    report:{bestRegime:pick(byRegime,1),worstRegime:pick(byRegime,0),bestSession:pick(bySession,1),worstSession:pick(bySession,0),bestScoreBucket:pick(byScore,1),worstScoreBucket:pick(byScore,0)}} }

// ── TELEGRAM SEND ────────────────────────────────────────────
async function sendTelegram(text){
  if(!TG_TOKEN||!TG_CHAT){console.log('[telegram disabled]\n'+text);return}
  const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:'HTML'})})
  if(!res.ok) console.error('Telegram error',res.status,await res.text()) }

const stateKey = tf => `${SYMBOL_LABEL}|${tf}`
const loadKey=(tf)=>{ try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))[stateKey(tf)]||null}catch{return null} }
const saveKey=(tf,k)=>{ let o={}; try{o=JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))}catch{}; o[stateKey(tf)]=k; o.at=new Date().toISOString(); try{fs.writeFileSync(STATE_FILE,JSON.stringify(o))}catch(e){console.error(e)} }
const logTrade=o=>{ let a=[];try{a=JSON.parse(fs.readFileSync(TRADE_LOG,'utf8'))}catch{};a.push(o);fs.writeFileSync(TRADE_LOG,JSON.stringify(a,null,2)) }

async function checkOne(tframe){
  const cfg=cfgFor(tframe),ts=new Date().toISOString()
  let candles
  try{candles=await fetchCandles(500,cfg)}
  catch(e){console.error(`[${ts}] ${SYMBOL_LABEL} ${tframe} fetch failed: ${e.message}`);return}
  const v=validateData(candles,cfg); candles=v.clean
  if(candles.length<50){console.log(`[${ts}] ${SYMBOL_LABEL} ${tframe} too few bars`);return}
  const closed=candles.slice(0,-1),forming=candles[candles.length-1]
  const sig=analyse(closed,closed[closed.length-1].timestamp,cfg)
  if(sig.skipped){
    // ── DIAGNOSTIC LOGGING (v4.4c) ─────────────────────────────
    // Print the actual measured ATR% and the exact band it was judged
    // against whenever we have them (low-liquidity / hard-band WAITs),
    // so it's immediately obvious whether a WAIT is a real quiet market
    // or a bad calibration — no separate manual check needed.
    const atrInfo = sig.atrPct!=null
      ? ` · ATR ${sig.atrPct.toFixed(4)}% (band ${sig.atrLow}–${sig.atrHigh}%)`
      : ''
    console.log(`[${ts}] ${SYMBOL_LABEL} ${tframe} WAIT · ${sig.regime} · ${sig.why}${atrInfo}`)
    return
  }
  const live=forming.close,R=Math.abs(sig.entry-sig.sl)
  if((sig.direction==='BUY'?live<=sig.sl:live>=sig.sl)){console.log(`[${ts}] ${SYMBOL_LABEL} ${tframe} SKIP: live past stop`);return}
  if((sig.direction==='BUY'?sig.entry-live:live-sig.entry)>0.5*R){console.log(`[${ts}] ${SYMBOL_LABEL} ${tframe} SKIP: stale (>0.5R drift)`);return}
  const slip=+(live-sig.entry).toFixed(SYMBOL_DECIMALS)
  const barTs=closed[closed.length-1].timestamp,key=`${SYMBOL_LABEL}|${tframe}|${sig.direction}|${barTs}`
  if(key===loadKey(tframe)){console.log(`[${ts}] ${SYMBOL_LABEL} ${tframe} already alerted this bar`);return}
  saveKey(tframe,key); logTrade({ts,symbol:SYMBOL_LABEL,tframe,live,slip,...sig})
  const tpLabel=(p,k)=>`${fmt(p)}${k?` (${k})`:''}`
  const hold=holdText(sig.maxHoldBars||profileFor(tframe).maxHold, cfg.min)
  await sendTelegram(
`🟡 <b>${SYMBOL_LABEL} ${tframe.toUpperCase()} — ${sig.direction}</b> · ${sig.tradeType} (score ${sig.score}/100 ${sig.tier})
Net ${sig.net} (bull ${sig.bull}/bear ${sig.bear}) · confluence ${sig.confluence}/6 · H1 ${sig.h1Trend}
${SESSION_LABEL[sig.session]||sig.session} · ⏱ target ≤ ${hold}
Planned ${fmt(sig.entry)} · live ${fmt(live)} (drift ${slip>=0?'+':''}${slip})
SL ${fmt(sig.sl)}  (RR ${sig.rr})
TP1 ${tpLabel(sig.tp1,sig.tpInfo?.[0])}
TP2 ${tpLabel(sig.tp2,sig.tpInfo?.[1])}
TP3 ${tpLabel(sig.tp3,sig.tpInfo?.[2])}
Size ${sig.posSize}
⚠️ Source ${SOURCE} — must equal your execution venue.`)
  console.log(`[${ts}] ✅ ${SYMBOL_LABEL} ${tframe} ${sig.direction} ${sig.tradeType} net ${sig.net} · live ${fmt(live)}`)
}

async function check(){ for(const tf of LIVE_TFS){ await checkOne(tf) } }

// ── ENTRY POINT ──────────────────────────────────────────────
const mode=process.argv[2]||'check'
if(mode==='backtest'||mode==='report'){
  const cfg=cfgFor(TFRAME), profile=profileFor(TFRAME)
  console.log(`Symbol: ${SYMBOL_LABEL} (TD: ${SYMBOL_TD}) · Timeframe: ${TFRAME} · Profile: ${profile.type} (maxHold ${profile.maxHold} bars ≈ ${holdText(profile.maxHold,cfg.min)}, TPs ${profile.tpR.join('/')}R)`)
  console.log(`⚠️  BACKTEST SOURCE = ${SOURCE}.`)
  const raw=SOURCE==='twelvedata'
    ?await fetchTwelveDataPaged(parseInt(process.env.BARS)||cfg.target,cfg)
    :await fetchCandles(5000,cfg)
  const v=validateData(raw.filter(x=>x.complete!==false),cfg)
  console.log(`Data: ${v.clean.length} clean ${TFRAME} bars (~${(v.clean.length*cfg.min/60/24).toFixed(1)}d)`)
  const bt=backtest(v.clean,cfg),rep=fullReport(bt)
  if(mode==='report'){fs.writeFileSync(REPORT_FILE,JSON.stringify({generated:new Date().toISOString(),symbol:SYMBOL_LABEL,timeframe:TFRAME,profile,source:SOURCE,...bt,report:rep},null,2));console.log(`Full report → ${REPORT_FILE}\n`)}
  console.log(JSON.stringify(mode==='report'?rep:{overall:rep.overall,governor:rep.governor,bootstrap:rep.bootstrap,outSample:rep.outSample},null,2))
} else { await check() }
