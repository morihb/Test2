// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  v9 (Multi-Symbol + Multi-Timeframe)
//
//  Reads active symbols from settings.json (via bot-subscription exports).
//  For each symbol × each of its timeframes, a separate candle-close
//  scheduler runs. The signal engine (gold-ai.mjs) receives the symbol
//  via env vars and knows nothing hardcoded.
//
//  State keys are  symbol|tf  so Gold 15m and EURUSD 15m never collide.
//  TP / SL watchers run per symbol across all their TFs.
// ─────────────────────────────────────────────────────────────────────────────
import {
  broadcastSignal,
  getActiveApiKeys,
  getDataSource,
  getAccountSize,
  getRiskPct,
  getPriceCheckSec,
  getOandaToken,
  getOandaEnv,
  getSymbolsForLauncher,
} from './bot-subscription.mjs'
import fs from 'fs'

// ── BOOTSTRAP ─────────────────────────────────────────────────────────────
const TG_TOKEN    = process.env.TG_TOKEN    || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const TG_CHAT     = process.env.TG_CHAT     || '1408577116'
const STATE_FILE  = './bot_state.json'
const TRADE_LOG   = './trade_log.json'
const DAILY_FILE  = './daily_report.json'
const CANDLE_DELAY_MS = 2000
const RETRY_DELAY_MS  = 60000
const MAX_RETRIES     = 3

// Stagger per TF so candle-close checks don't all fire at once
const TF_STAGGER_MS = { '15m':0, '1h':4*60000, '4h':45000, '1d':60000 }
const TF_MINUTES    = { '1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'2h':120,'4h':240,'1d':1440 }
const TD_INTERVAL   = { '1m':'1min','3m':'3min','5m':'5min','15m':'15min','30m':'30min','1h':'1h','2h':'2h','4h':'4h','1d':'1day' }

// ── DYNAMIC CONFIG ─────────────────────────────────────────────────────────
// All read fresh every cycle — no restart needed for most changes
function getLiveApiKeys() { return getActiveApiKeys() }
function getLiveSymbols() { return getSymbolsForLauncher() }   // [{id,label,emoji,td_symbol,oanda_symbol,yahoo_symbol,decimals,timeframes}]
function getLiveSource()  { return getDataSource() }

let activeKeyIndex = 0
function currentKey() { const k=getLiveApiKeys(); return k.length ? k[activeKeyIndex%k.length] : '' }
function switchToNextKey() {
  const k=getLiveApiKeys(); if(k.length<=1){console.error('[API] No fallback keys!');return false}
  activeKeyIndex=(activeKeyIndex+1)%k.length
  console.log(`[API] ⚠️ Switched to key slot #${activeKeyIndex+1}: ${currentKey().slice(0,8)}…`)
  return true
}

// ── HELPERS ───────────────────────────────────────────────────────────────
const dirIcon  = dir => dir==='BUY'?'🟢':'🔴'
const toPips   = (d, decimals) => decimals >= 4 ? Math.round(Math.abs(d)*10000) : Math.round(Math.abs(d)*10)
function openTrade(state, sym, tf) { const s=state[`${sym}|${tf}`]; return (s&&typeof s==='object'&&s.direction)?s:null }

// ── CANDLE CLOSE SCHEDULER ─────────────────────────────────────────────────
function msUntilNextClose(tfMinutes) {
  const now=Date.now(), periodMs=tfMinutes*60000
  return Math.ceil(now/periodMs)*periodMs - now
}
function scheduleCandle(symObj, tf, callback) {
  const mins=TF_MINUTES[tf]; if(!mins){console.error(`Unknown TF: ${tf}`);return}
  const stagger=TF_STAGGER_MS[tf]||0, wait=msUntilNextClose(mins)+stagger
  const closeAt=new Date(Date.now()+wait).toISOString()
  console.log(`[scheduler] ${symObj.label} ${tf} next close in ${(wait/1000).toFixed(1)}s (at ${closeAt})`)
  setTimeout(async()=>{
    await new Promise(r=>setTimeout(r,CANDLE_DELAY_MS))
    let success=false
    for(let attempt=1;attempt<=MAX_RETRIES;attempt++){
      try{await callback(symObj,tf);success=true;break}
      catch(e){
        const is429=e.message?.includes('429')||e.message?.includes('rate')
        const isNet=e.message?.includes('fetch')||e.message?.includes('ECONNRESET')
        if((is429||isNet)&&attempt<MAX_RETRIES){
          if(is429){console.log(`[scheduler] ${symObj.label} ${tf} rate limited — switching key`);switchToNextKey()}
          else console.log(`[scheduler] ${symObj.label} ${tf} attempt ${attempt} failed (${e.message})`)
          await new Promise(r=>setTimeout(r,RETRY_DELAY_MS))
        } else {console.error(`[scheduler] ${symObj.label} ${tf} gave up: ${e.message}`);break}
      }
    }
    scheduleCandle(symObj,tf,callback)
  },wait)
}

// ── STATE ─────────────────────────────────────────────────────────────────
function loadState()  { try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))}catch{return{}} }
function saveState(s) { s.at=new Date().toISOString(); fs.writeFileSync(STATE_FILE,JSON.stringify(s,null,2)) }

// ── DAILY REPORT ──────────────────────────────────────────────────────────
function todayKey()  { return new Date().toISOString().slice(0,10) }
function loadDaily() { try{return JSON.parse(fs.readFileSync(DAILY_FILE,'utf8'))}catch{return{}} }
function saveDaily(d){ fs.writeFileSync(DAILY_FILE,JSON.stringify(d,null,2)) }
function addToDaily(trade) {
  const key=todayKey(),daily=loadDaily()
  if(!daily[key]) daily[key]={trades:[],totalPips:0}
  daily[key].trades.push({...trade,ts:new Date().toISOString()})
  daily[key].totalPips+=trade.sign*trade.pips
  saveDaily(daily)
}

// ── SEND ──────────────────────────────────────────────────────────────────
async function sendAll(text, symbolId, replyToMsgId=null) {
  let adminMsgId=null
  try {
    const body={chat_id:TG_CHAT,text,parse_mode:'HTML'}
    if(replyToMsgId) body.reply_to_message_id=replyToMsgId
    const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    const j=await res.json(); if(j.ok) adminMsgId=j.result.message_id
  }catch(e){console.error('[sendAll admin]',e.message)}
  // Only broadcast to subscribers of this symbol
  const result=await broadcastSignal(text, symbolId)
  console.log(`[sendAll][${symbolId}] adminMsgId=${adminMsgId} subs sent=${result.sent} failed=${result.failed}`)
  return adminMsgId
}

// ── LIVE PRICE ────────────────────────────────────────────────────────────
async function fetchLivePrice(symObj) {
  const keys=getLiveApiKeys()
  for(let attempt=0;attempt<Math.max(keys.length,1);attempt++){
    const key=currentKey(); if(!key) break
    try{
      const res=await fetch(`https://api.twelvedata.com/price?symbol=${encodeURIComponent(symObj.td_symbol)}&apikey=${key}`,{signal:AbortSignal.timeout(8000)})
      if(res.status===429){switchToNextKey();continue}
      const j=await res.json(); if(j.price) return parseFloat(j.price); if(j.code===429){switchToNextKey();continue}
    }catch{}
    try{
      const res=await fetch(`https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symObj.td_symbol)}&apikey=${key}`,{signal:AbortSignal.timeout(8000)})
      if(res.status===429){switchToNextKey();continue}
      const j=await res.json(); if(j.close) return parseFloat(j.close)
    }catch{}
  }
  return null
}

// ── LAST CLOSED CANDLE ────────────────────────────────────────────────────
async function fetchClosedBar(symObj, tf) {
  const interval=TD_INTERVAL[tf]; if(!interval) return null
  const periodMs=TF_MINUTES[tf]*60000, boundary=Math.floor(Date.now()/periodMs)*periodMs
  const expectedOpen=boundary-periodMs, keys=getLiveApiKeys()
  for(let attempt=0;attempt<Math.max(keys.length,1);attempt++){
    const key=currentKey(); if(!key) break
    try{
      const res=await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symObj.td_symbol)}&interval=${interval}&outputsize=3&apikey=${key}`,{signal:AbortSignal.timeout(8000)})
      if(res.status===429){switchToNextKey();continue}
      const j=await res.json(); if(j.code===429){switchToNextKey();continue}
      if(j.status==='error'||!j.values?.length) return null
      const bars=j.values.map(v=>({ts:new Date(v.datetime.replace(' ','T')+'Z').getTime(),open:parseFloat(v.open),high:parseFloat(v.high),low:parseFloat(v.low),close:parseFloat(v.close)}))
      return bars.find(b=>b.ts===expectedOpen)||bars.filter(b=>b.ts+periodMs<=Date.now()).sort((a,b)=>b.ts-a.ts)[0]||null
    }catch{}
  }
  return null
}

// ── SL ON CANDLE CLOSE ────────────────────────────────────────────────────
async function checkStopOnClose(symObj, tf) {
  const state=loadState(), sig=openTrade(state,symObj.id,tf)
  if(!sig||sig.sl==null) return
  const bar=await fetchClosedBar(symObj,tf)
  if(!bar){console.log(`[${symObj.label} ${tf}] SL-on-close: no closed bar`);return}
  const {direction:dir,entry,sl,msgId}=sig
  const closedBeyond=dir==='BUY'?bar.close<=sl:bar.close>=sl
  if(!closedBeyond){
    if(dir==='BUY'?bar.low<=sl:bar.high>=sl) console.log(`[${symObj.label} ${tf}] SL wick @ ${sl} but closed at ${bar.close.toFixed(symObj.decimals)} — still valid`)
    return
  }
  const pips=toPips(Math.abs(sl-entry),symObj.decimals), isBE=sl===entry
  const pnlLabel=isBE?'0 pips (break-even)':`-${pips} pips`
  await sendAll(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — STOP LOSS HIT</b>\n${pnlLabel} @ ${sl.toFixed(symObj.decimals)}\nCandle closed at ${bar.close.toFixed(symObj.decimals)} — confirmed on close. ❌`, symObj.id, msgId)
  addToDaily({sym:symObj.id,tf,dir,result:isBE?'BE':'SL',pips,sign:isBE?0:-1})
  const s=loadState(); s[`${symObj.id}|${tf}`]=null; saveState(s)
  console.log(`[${symObj.label} ${tf}] 🔴 SL confirmed (${pnlLabel})`)
}

// ── FAST PRICE WATCHER — TP ONLY ──────────────────────────────────────────
async function fastPriceCheck() {
  const symbols=getLiveSymbols()
  for(const symObj of symbols){
    const livePrice=await fetchLivePrice(symObj); if(!livePrice) continue
    const state=loadState(); let changed=false
    const ts=new Date().toISOString()
    for(const tf of symObj.timeframes){
      const sig=openTrade(state,symObj.id,tf); if(!sig?.entry) continue
      const stateKey=`${symObj.id}|${tf}`
      const {direction:dir,entry,tp1,tp2,tp3,tp1Hit=false,tp2Hit=false,tp3Hit=false,msgId=null}=sig
      const dp=symObj.decimals

      const tp1Cross=dir==='BUY'?livePrice>=tp1:livePrice<=tp1
      if(tp1Cross&&!tp1Hit){
        const pips=toPips(Math.abs(tp1-entry),dp)
        const newMsgId=await sendAll(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP1 HIT ✅</b>\n+${pips} pips @ ${tp1.toFixed(dp)}\nLive: ${livePrice.toFixed(dp)}\n→ Ride to TP2 ${tp2.toFixed(dp)} · SL moved to BE ${entry.toFixed(dp)}`, symObj.id, msgId)
        addToDaily({sym:symObj.id,tf,dir,result:'TP1',pips,sign:+1})
        state[stateKey]={...sig,tp1Hit:true,sl:entry,msgId:newMsgId||msgId}; changed=true; sig.tp1Hit=true; sig.sl=entry
        console.log(`[${ts}] [${symObj.label} ${tf}] ✅ TP1 +${pips} pips`)
      }
      const tp2Cross=dir==='BUY'?livePrice>=tp2:livePrice<=tp2
      if(tp2Cross&&sig.tp1Hit&&!tp2Hit){
        const pips=toPips(Math.abs(tp2-entry),dp)
        const newMsgId=await sendAll(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP2 HIT ✅</b>\n+${pips} pips @ ${tp2.toFixed(dp)}\nLive: ${livePrice.toFixed(dp)}\n→ Ride to TP3 ${tp3.toFixed(dp)}`, symObj.id, msgId)
        addToDaily({sym:symObj.id,tf,dir,result:'TP2',pips,sign:+1})
        state[stateKey]={...state[stateKey],tp2Hit:true,msgId:newMsgId||msgId}; changed=true; sig.tp2Hit=true
        console.log(`[${ts}] [${symObj.label} ${tf}] ✅ TP2 +${pips} pips`)
      }
      const tp3Cross=dir==='BUY'?livePrice>=tp3:livePrice<=tp3
      if(tp3Cross&&sig.tp2Hit&&!tp3Hit){
        const pips=toPips(Math.abs(tp3-entry),dp)
        await sendAll(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP3 HIT 🏆 FULL TARGET</b>\n+${pips} pips @ ${tp3.toFixed(dp)}\nAll targets reached! 🎯`, symObj.id, msgId)
        addToDaily({sym:symObj.id,tf,dir,result:'TP3',pips,sign:+1})
        state[stateKey]=null; changed=true
        console.log(`[${ts}] [${symObj.label} ${tf}] 🏆 TP3 +${pips} pips`)
      }
    }
    if(changed) saveState(state)
  }
}

// ── SIGNAL CYCLE ──────────────────────────────────────────────────────────
async function runSignalCycle(symObj, tf, isStartup=false) {
  const ts=new Date().toISOString()
  console.log(`[${ts}] 🕯️  ${symObj.label} ${tf} candle closed${isStartup?' (startup)':''}`)

  await checkStopOnClose(symObj, tf)

  const heldBefore=openTrade(loadState(), symObj.id, tf)

  const {execFile}=await import('child_process')
  const {promisify}=await import('util')
  const exec=promisify(execFile)

  const env={
    ...process.env,
    LIVE_TFS:       tf,
    TWELVEDATA_KEY: currentKey(),
    TG_TOKEN:       '',                     // gold-ai must NOT send TG msgs directly
    GOLD_SOURCE:    getLiveSource(),
    TG_CHAT,
    ACCT:           String(getAccountSize()),
    RISK:           String(getRiskPct()),
    OANDA_TOKEN:    getOandaToken(),
    OANDA_ENV:      getOandaEnv(),
    // Symbol env vars — these make gold-ai.mjs fully symbol-agnostic
    SYMBOL_LABEL:    symObj.label,
    SYMBOL_TD:       symObj.td_symbol,
    SYMBOL_OANDA:    symObj.oanda_symbol || '',
    SYMBOL_YAHOO:    symObj.yahoo_symbol || '',
    SYMBOL_DECIMALS: String(symObj.decimals || 2),
  }

  const {stdout,stderr}=await exec('node',['gold-ai.mjs','check'],{env,timeout:60000})
  if(stdout) console.log(`[${symObj.label} ${tf}]`,stdout.trim())
  if(stderr) console.error(`[${symObj.label} ${tf} err]`,stderr.trim())
  if(stderr&&(stderr.includes('429')||stderr.includes('fetch failed'))) throw new Error(stderr.trim().slice(0,120))

  const lines=stdout.split('\n')
  const log=(()=>{try{return JSON.parse(fs.readFileSync(TRADE_LOG,'utf8'))}catch{return[]}})()
  const entries=log.filter(e=>e.tframe===tf&&e.symbol===symObj.label&&!e.event)
  const latest=entries[entries.length-1]

  const alreadyAlerted=lines.some(l=>l.includes('already alerted'))
  const isWait=lines.some(l=>l.includes('WAIT')||l.includes('SKIP'))
  const hasSignal=lines.some(l=>l.includes('✅'))
  const freshnessMs=isStartup?2*60*60000:5*60000
  const fresh=latest&&(Date.now()-new Date(latest.ts).getTime()<freshnessMs)
  const shouldSend=fresh&&!isWait&&(hasSignal||(isStartup&&latest))&&(!alreadyAlerted||isStartup)

  console.log(`[${symObj.label} ${tf}] signal=${hasSignal} wait=${isWait} fresh=${fresh} held=${heldBefore?.direction||'none'} → send=${shouldSend}`)

  const stateKey=`${symObj.id}|${tf}`
  const dp=symObj.decimals||2

  if(shouldSend){
    const sig=latest
    const isHold=heldBefore&&heldBefore.direction===sig.direction
    if(isHold){
      const held=heldBefore
      const tp1L=`${held.tp1Hit?'✅ ':''}TP1 ${held.tp1?.toFixed(dp)}`
      const tp2L=`${held.tp2Hit?'✅ ':''}TP2 ${held.tp2?.toFixed(dp)}`
      const tp3L=`${held.tp3Hit?'✅ ':''}TP3 ${held.tp3?.toFixed(dp)}`
      await sendAll(`${dirIcon(held.direction)} <b>${symObj.label} ${tf.toUpperCase()} — KEEP HOLDING ${held.direction}</b>\nConfluence still active — original trade stays open.\nEntry ${held.entry?.toFixed(dp)} · SL ${held.sl?.toFixed(dp)}\n${tp1L}\n${tp2L}\n${tp3L}`, symObj.id, held.msgId)
      const s=loadState(); s[stateKey]=held; saveState(s)
      console.log(`[${symObj.label} ${tf}] 📡 KEEP HOLDING`)
    } else {
      const entry=parseFloat(sig.entry), sl=parseFloat(sig.sl)
      const tp1=parseFloat(sig.tp1), tp2=parseFloat(sig.tp2), tp3=parseFloat(sig.tp3)
      const msgText=
`${dirIcon(sig.direction)} <b>${symObj.label} ${tf.toUpperCase()} — ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
H1 ${sig.h1Trend} · ${sig.session}
🔰 Entry ${entry.toFixed(dp)} · live ${parseFloat(sig.live).toFixed(dp)}
❌ SL ${sl.toFixed(dp)}
✅ TP1 ${tp1.toFixed(dp)} (+${toPips(tp1-entry,dp)} pips)
✅ TP2 ${tp2.toFixed(dp)} (+${toPips(tp2-entry,dp)} pips)
✅ TP3 ${tp3.toFixed(dp)} (+${toPips(tp3-entry,dp)} pips)
🛡️ SL triggers on candle CLOSE beyond ${sl.toFixed(dp)} — wick touch keeps trade valid.
⚠️ Manage risk. Not financial advice.`
      const newMsgId=await sendAll(msgText, symObj.id)
      const sNow=loadState()
      sNow[stateKey]={direction:sig.direction,entry,sl,tp1,tp2,tp3,tp1Hit:false,tp2Hit:false,tp3Hit:false,msgId:newMsgId,ts:sig.ts}
      saveState(sNow)
      console.log(`[${symObj.label} ${tf}] 📡 NEW signal msgId=${newMsgId}`)
    }
  } else if(!hasSignal&&!fresh){
    console.log(`[${symObj.label} ${tf}] No signal this candle`)
  }
}

// ── DAILY SUMMARY ─────────────────────────────────────────────────────────
function scheduleDailySummary(){
  function msUntilMidnight(){const now=new Date();return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1))-now}
  async function sendDailySummary(){
    const key=todayKey(),daily=loadDaily(),day=daily[key]
    if(day?.trades?.length>0){
      const trades=day.trades,totalPips=Math.round(day.totalPips)
      const wins=trades.filter(t=>t.sign>0),losses=trades.filter(t=>t.sign<0)
      const lines=trades.map(t=>`${t.sign>0?'✅':t.sign<0?'❌':'➖'} ${(t.sym||'').toUpperCase()} ${t.tf?.toUpperCase()} ${t.dir} → ${t.result}: ${t.sign>0?'+':t.sign<0?'-':''}${t.pips} pips`)
      const summaryLine=totalPips>=0?`+${totalPips} pips profit`:`${totalPips} pips loss`
      // Send daily summary to all subscribers (all symbols)
      const text=`${totalPips>=0?'📈':'📉'} <b>GOLD AI — Daily Summary (${key})</b>\n\n${lines.join('\n')}\n\n──────────────\nTrades: ${trades.length} | Wins: ${wins.length} | Losses: ${losses.length}\n<b>Total: ${summaryLine}</b>`
      try{await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:'HTML'})})}catch{}
      await broadcastSignal(text, null)   // null = all symbols
      console.log(`[daily] Summary sent: ${summaryLine}`)
    }
    setTimeout(sendDailySummary,msUntilMidnight()+1000)
  }
  setTimeout(sendDailySummary,msUntilMidnight()+1000)
  console.log(`   📅 Daily summary in ${Math.round(msUntilMidnight()/60000)} min`)
}

// ── STARTUP ───────────────────────────────────────────────────────────────
const symbols=getLiveSymbols()
const PRICE_CHECK_MS=getPriceCheckSec()*1000

console.log('🚀 Gold AI Launcher v9 — Multi-Symbol + Multi-Timeframe')
console.log(`   Symbols: ${symbols.map(s=>`${s.emoji}${s.label}[${s.timeframes.join(',')}]`).join('  ')}`)
console.log(`   ⚡ Price watcher: every ${PRICE_CHECK_MS/1000}s`)
console.log(`   🔑 API keys: ${getLiveApiKeys().length} active`)
console.log(`   💰 Account: $${getAccountSize()} · Risk ${getRiskPct()}%`)

scheduleDailySummary()

// Sanitise stale state
;(()=>{
  const state=loadState(); let changed=false
  for(const key of Object.keys(state)){
    if(key==='at') continue
    if(typeof state[key]==='string'||(state[key]&&typeof state[key]!=='object')){
      console.log(`[startup] Clearing stale state for ${key}`); state[key]=null; changed=true
    }
  }
  if(changed) saveState(state)
  console.log('[startup] State OK')
})()

// Initial check for every symbol × every TF
;(async()=>{
  for(const symObj of symbols){
    for(const tf of symObj.timeframes){
      console.log(`[startup] Initial check: ${symObj.label} ${tf}…`)
      for(let attempt=1;attempt<=MAX_RETRIES;attempt++){
        try{await runSignalCycle(symObj,tf,true);break}
        catch(e){
          const is429=e.message?.includes('429')||e.message?.includes('fetch failed')
          if(is429&&attempt<MAX_RETRIES){switchToNextKey();console.log(`[startup] ${symObj.label} ${tf} 429 — waiting 65s…`);await new Promise(r=>setTimeout(r,65000))}
          else{console.error(`[startup] ${symObj.label} ${tf} gave up: ${e.message}`);break}
        }
      }
      await new Promise(r=>setTimeout(r,3000))   // 3s between each startup check
    }
  }
  // Schedule recurring candle cycles for all symbol×TF pairs
  for(const symObj of symbols){
    for(const tf of symObj.timeframes){
      scheduleCandle(symObj,tf,runSignalCycle)
    }
  }
})()

fastPriceCheck()
setInterval(fastPriceCheck, PRICE_CHECK_MS)
