// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  v10 (Multi-Symbol + Multi-Timeframe)
//
//  Changes vs v9:
//   1. HTF DIRECTION GATE — a lower TF signal that OPPOSES an open higher-TF
//      trade (same symbol) is suppressed. e.g. 1h holds BUY → 15m SELL is dropped.
//   2. SL PIPS shown in the signal message.
//   3. NO MORE 30s PRICE POLLING. A single watcher fires on each 5-min candle
//      close and reads that candle's HIGH/LOW/CLOSE to detect TP (wick touch)
//      and SL (close beyond). One API call per symbol every 5 minutes.
//   4. ALL TP/SL alerts now REPLY TO THE ORIGINAL SIGNAL MESSAGE (stable
//      signalMsgId that is never overwritten by alert message ids).
//   5. RELIABILITY: the signal engine runs in an isolated working dir (./engine)
//      so it can never corrupt or clobber the launcher's bot_state.json. State
//      writes are atomic (temp file + rename). This fixes "sometimes doesn't send".
//   6. 1-MINUTE RETRY when the per-minute API capacity is exhausted (429).
//
//  State keys are  symbol|tf  so Gold 15m and EURUSD 15m never collide.
// ─────────────────────────────────────────────────────────────────────────────
import {
  broadcastSignal,
  getActiveApiKeys,
  getDataSource,
  getAccountSize,
  getRiskPct,
  getOandaToken,
  getOandaEnv,
  getSymbolsForLauncher,
} from './bot-subscription.mjs'
import fs from 'fs'
import path from 'path'

// ── BOOTSTRAP ─────────────────────────────────────────────────────────────
const TG_TOKEN    = process.env.TG_TOKEN || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const TG_CHAT     = process.env.TG_CHAT  || '1408577116'
const STATE_FILE  = './bot_state.json'
const DAILY_FILE  = './daily_report.json'

// Engine runs here so its ./bot_state.json + ./trade_log.json are ISOLATED
// from the launcher's authoritative bot_state.json (no corruption / collision).
const ENGINE_DIR       = './engine'
try { fs.mkdirSync(ENGINE_DIR, { recursive: true }) } catch {}
const ENGINE_TRADE_LOG = path.join(ENGINE_DIR, 'trade_log.json')
const ENGINE_SCRIPT    = path.resolve('gold-ai.mjs')

const CANDLE_DELAY_MS = 2000
const RETRY_DELAY_MS  = 60000      // 1 minute — used for per-minute API capacity (429)
const MAX_RETRIES     = 3
const WATCH_PERIOD_MS = 5 * 60000  // 5-minute OHLC sweep

// Stagger per TF so candle-close checks don't all fire at once
const TF_STAGGER_MS = { '15m':0, '1h':4*60000, '4h':45000, '1d':60000 }
const TF_MINUTES    = { '1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'2h':120,'4h':240,'1d':1440 }

// ── DYNAMIC CONFIG ─────────────────────────────────────────────────────────
function getLiveApiKeys() { return getActiveApiKeys() }
function getLiveSymbols() { return getSymbolsForLauncher() }
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
const dirIcon = dir => dir==='BUY'?'🟢':'🔴'
const toPips  = (d, decimals) => decimals >= 4 ? Math.round(Math.abs(d)*10000) : Math.round(Math.abs(d)*10)
function openTrade(state, sym, tf) { const s=state[`${sym}|${tf}`]; return (s&&typeof s==='object'&&s.direction)?s:null }
const sleep = ms => new Promise(r=>setTimeout(r,ms))

// HTF GATE: returns the direction of any OPEN higher-timeframe trade for this
// symbol, or null. A higher TF = more minutes than the TF being evaluated.
function higherTfDirection(state, symId, tf, timeframes) {
  const myMin = TF_MINUTES[tf] || 0
  for (const other of timeframes) {
    if ((TF_MINUTES[other] || 0) <= myMin) continue
    const t = openTrade(state, symId, other)
    if (t && t.direction) return { dir: t.direction, tf: other }
  }
  return null
}

// ── STATE (atomic writes) ──────────────────────────────────────────────────
function loadState()  { try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))}catch{return{}} }
function saveState(s) {
  s.at = new Date().toISOString()
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

// ── DAILY REPORT ──────────────────────────────────────────────────────────
function todayKey()  { return new Date().toISOString().slice(0,10) }
function loadDaily() { try{return JSON.parse(fs.readFileSync(DAILY_FILE,'utf8'))}catch{return{}} }
function saveDaily(d){ const tmp=DAILY_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(d,null,2)); fs.renameSync(tmp,DAILY_FILE) }
function addToDaily(trade) {
  const key=todayKey(), daily=loadDaily()
  if(!daily[key]) daily[key]={trades:[],totalPips:0}
  daily[key].trades.push({...trade, ts:new Date().toISOString()})
  daily[key].totalPips += trade.sign*trade.pips
  saveDaily(daily)
}

// ── SEND (admin + subscribers, optional threaded reply) ─────────────────────
async function sendAll(text, symbolId, replyToMsgId=null) {
  let adminMsgId=null
  try {
    const body={chat_id:TG_CHAT,text,parse_mode:'HTML'}
    if(replyToMsgId) body.reply_to_message_id=replyToMsgId
    const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    const j=await res.json(); if(j.ok) adminMsgId=j.result.message_id
  }catch(e){console.error('[sendAll admin]',e.message)}
  const result=await broadcastSignal(text, symbolId)
  console.log(`[sendAll][${symbolId}] adminMsgId=${adminMsgId} subs sent=${result.sent} failed=${result.failed}`)
  return adminMsgId
}

// ── LAST CLOSED 5-MIN BAR (one call per symbol; reports 429 exhaustion) ─────
async function fetchClosed5mBar(symObj) {
  const interval='5min', periodMs=5*60000
  const boundary=Math.floor(Date.now()/periodMs)*periodMs
  const expectedOpen=boundary-periodMs
  const keys=getLiveApiKeys(); let saw429=false
  for(let attempt=0; attempt<Math.max(keys.length,1); attempt++){
    const key=currentKey(); if(!key) break
    try{
      const res=await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symObj.td_symbol)}&interval=${interval}&outputsize=3&apikey=${key}`,{signal:AbortSignal.timeout(8000)})
      if(res.status===429){ saw429=true; switchToNextKey(); continue }
      const j=await res.json()
      if(j.code===429 || /run out|api credits|minute|limit/i.test(j.message||'')){ saw429=true; switchToNextKey(); continue }
      if(j.status==='error' || !j.values?.length) return { bar:null }
      const bars=j.values.map(v=>({ts:new Date(v.datetime.replace(' ','T')+'Z').getTime(),high:parseFloat(v.high),low:parseFloat(v.low),close:parseFloat(v.close)}))
      const bar=bars.find(b=>b.ts===expectedOpen) || bars.filter(b=>b.ts+periodMs<=Date.now()).sort((a,b)=>b.ts-a.ts)[0] || null
      return { bar }
    }catch{ /* network error — try next key */ }
  }
  return { rateLimited:saw429, bar:null }
}

// Evaluate one open trade against a closed 5-min bar. Mutates `state`, sends
// threaded alerts. Returns true if state changed.
async function evalTradeAgainstBar(state, symObj, tf, sig, bar) {
  const key=`${symObj.id}|${tf}`, dp=symObj.decimals||2
  const dir=sig.direction, entry=sig.entry
  const sigMsgId = sig.signalMsgId || sig.msgId || null   // always reply to ORIGINAL signal
  let changed=false

  // ── TP1 (wick touch) ──
  if(!sig.tp1Hit && (dir==='BUY' ? bar.high>=sig.tp1 : bar.low<=sig.tp1)){
    const pips=toPips(sig.tp1-entry,dp)
    await sendAll(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP1 HIT ✅</b>\n+${pips} pips @ ${sig.tp1.toFixed(dp)}\nSL moved to break-even (${entry.toFixed(dp)}) — trade is now risk-free.\n→ Targeting TP2 ${sig.tp2.toFixed(dp)}`, symObj.id, sigMsgId)
    addToDaily({sym:symObj.id,tf,dir,result:'TP1',pips,sign:+1})
    sig.tp1Hit=true; sig.sl=entry; state[key]={...sig}; changed=true
    console.log(`[${symObj.label} ${tf}] ✅ TP1 +${pips} pips`)
  }
  // ── TP2 ──
  if(sig.tp1Hit && !sig.tp2Hit && (dir==='BUY' ? bar.high>=sig.tp2 : bar.low<=sig.tp2)){
    const pips=toPips(sig.tp2-entry,dp)
    await sendAll(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP2 HIT ✅</b>\n+${pips} pips @ ${sig.tp2.toFixed(dp)}\n→ Targeting TP3 ${sig.tp3.toFixed(dp)}`, symObj.id, sigMsgId)
    addToDaily({sym:symObj.id,tf,dir,result:'TP2',pips,sign:+1})
    sig.tp2Hit=true; state[key]={...sig}; changed=true
    console.log(`[${symObj.label} ${tf}] ✅ TP2 +${pips} pips`)
  }
  // ── TP3 (full target → close) ──
  if(sig.tp2Hit && !sig.tp3Hit && (dir==='BUY' ? bar.high>=sig.tp3 : bar.low<=sig.tp3)){
    const pips=toPips(sig.tp3-entry,dp)
    await sendAll(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP3 HIT 🏆 FULL TARGET</b>\n+${pips} pips @ ${sig.tp3.toFixed(dp)}\nAll targets reached! 🎯`, symObj.id, sigMsgId)
    addToDaily({sym:symObj.id,tf,dir,result:'TP3',pips,sign:+1})
    state[key]=null; changed=true
    console.log(`[${symObj.label} ${tf}] 🏆 TP3 +${pips} pips`)
    return changed   // trade fully closed
  }

  // ── SL (candle CLOSE beyond — wick alone keeps it valid) ──
  const sl=sig.sl
  const closedBeyond = dir==='BUY' ? bar.close<=sl : bar.close>=sl
  if(closedBeyond){
    const isBE = Math.abs(sl-entry) < Math.pow(10,-dp)/2
    const pips = toPips(sl-entry,dp)
    const label = isBE ? 'Break-even (0 pips)' : `-${pips} pips`
    await sendAll(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — ${isBE?'CLOSED AT BREAK-EVEN 🟦':'STOP LOSS ❌'}</b>\n${label} @ ${sl.toFixed(dp)}\n5-min candle closed at ${bar.close.toFixed(dp)} beyond the stop — confirmed on close.`, symObj.id, sigMsgId)
    addToDaily({sym:symObj.id,tf,dir,result:isBE?'BE':'SL',pips,sign:isBE?0:-1})
    state[key]=null; changed=true
    console.log(`[${symObj.label} ${tf}] ${isBE?'🟦 BE':'🔴 SL'} (${label})`)
  }
  return changed
}

// Watch one symbol's open trades against the last closed 5m candle.
async function watchSymbol(symObj, isRetry=false) {
  const probe=loadState()
  const hasOpen=symObj.timeframes.some(tf=>openTrade(probe,symObj.id,tf))
  if(!hasOpen) return   // nothing open → no API call needed

  const res=await fetchClosed5mBar(symObj)
  if(res.rateLimited){
    if(!isRetry){ console.log(`[watch ${symObj.label}] per-minute API capacity full — retrying in 60s`); setTimeout(()=>watchSymbol(symObj,true).catch(()=>{}), RETRY_DELAY_MS) }
    else console.error(`[watch ${symObj.label}] still rate-limited after retry — next 5m sweep will catch it`)
    return
  }
  const bar=res.bar; if(!bar) return

  const state=loadState(); let changed=false
  for(const tf of symObj.timeframes){
    const sig=openTrade(state,symObj.id,tf); if(!sig?.entry) continue
    const c=await evalTradeAgainstBar(state, symObj, tf, sig, bar)
    changed = changed || c
  }
  if(changed) saveState(state)
}

async function watchAllTrades() {
  for(const symObj of getLiveSymbols()){
    try{ await watchSymbol(symObj) }catch(e){ console.error(`[watch ${symObj.label}]`, e.message) }
  }
}

// 5-minute aligned watcher loop
function scheduleWatcher() {
  const wait = (Math.ceil(Date.now()/WATCH_PERIOD_MS)*WATCH_PERIOD_MS - Date.now()) + CANDLE_DELAY_MS
  console.log(`[watch] next 5-min TP/SL sweep in ${(wait/1000).toFixed(0)}s`)
  setTimeout(async()=>{
    try{ await watchAllTrades() }catch(e){ console.error('[watch sweep]', e.message) }
    scheduleWatcher()
  }, wait)
}

// ── CANDLE CLOSE SCHEDULER (signal generation) ─────────────────────────────
function msUntilNextClose(tfMinutes) {
  const now=Date.now(), periodMs=tfMinutes*60000
  return Math.ceil(now/periodMs)*periodMs - now
}
function scheduleCandle(symObj, tf, callback) {
  const mins=TF_MINUTES[tf]; if(!mins){console.error(`Unknown TF: ${tf}`);return}
  const stagger=TF_STAGGER_MS[tf]||0, wait=msUntilNextClose(mins)+stagger
  console.log(`[scheduler] ${symObj.label} ${tf} next close in ${(wait/1000).toFixed(1)}s`)
  setTimeout(async()=>{
    await sleep(CANDLE_DELAY_MS)
    for(let attempt=1;attempt<=MAX_RETRIES;attempt++){
      try{ await callback(symObj,tf); break }
      catch(e){
        const is429=e.message?.includes('429')||e.message?.includes('rate')||e.message?.includes('minute')
        const isNet=e.message?.includes('fetch')||e.message?.includes('ECONNRESET')
        if((is429||isNet)&&attempt<MAX_RETRIES){
          if(is429){console.log(`[scheduler] ${symObj.label} ${tf} per-minute capacity full — switching key, retry in 60s`);switchToNextKey()}
          else console.log(`[scheduler] ${symObj.label} ${tf} attempt ${attempt} failed (${e.message})`)
          await sleep(RETRY_DELAY_MS)   // wait one minute then retry
        } else {console.error(`[scheduler] ${symObj.label} ${tf} gave up: ${e.message}`);break}
      }
    }
    scheduleCandle(symObj,tf,callback)
  },wait)
}

// ── SIGNAL CYCLE ──────────────────────────────────────────────────────────
async function runSignalCycle(symObj, tf, isStartup=false) {
  const ts=new Date().toISOString()
  console.log(`[${ts}] 🕯️  ${symObj.label} ${tf} candle closed${isStartup?' (startup)':''}`)

  const heldBefore=openTrade(loadState(), symObj.id, tf)

  const {execFile}=await import('child_process')
  const {promisify}=await import('util')
  const exec=promisify(execFile)

  const env={
    ...process.env,
    LIVE_TFS:       tf,
    TWELVEDATA_KEY: currentKey(),
    TG_TOKEN:       '',                 // engine must NOT send TG msgs directly
    GOLD_SOURCE:    getLiveSource(),
    TG_CHAT,
    ACCT:           String(getAccountSize()),
    RISK:           String(getRiskPct()),
    OANDA_TOKEN:    getOandaToken(),
    OANDA_ENV:      getOandaEnv(),
    SYMBOL_LABEL:    symObj.label,
    SYMBOL_TD:       symObj.td_symbol,
    SYMBOL_OANDA:    symObj.oanda_symbol || '',
    SYMBOL_YAHOO:    symObj.yahoo_symbol || '',
    SYMBOL_DECIMALS: String(symObj.decimals || 2),
  }

  // Run engine in ISOLATED dir so it can't touch the launcher's bot_state.json
  const {stdout,stderr}=await exec('node',[ENGINE_SCRIPT,'check'],{env,timeout:60000,cwd:path.resolve(ENGINE_DIR)})
  if(stdout) console.log(`[${symObj.label} ${tf}]`,stdout.trim())
  if(stderr) console.error(`[${symObj.label} ${tf} err]`,stderr.trim())
  if(stderr&&(stderr.includes('429')||stderr.includes('fetch failed')||/minute/i.test(stderr))) throw new Error(stderr.trim().slice(0,120))

  const lines=stdout.split('\n')
  const log=(()=>{try{return JSON.parse(fs.readFileSync(ENGINE_TRADE_LOG,'utf8'))}catch{return[]}})()
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
      const sigMsgId=held.signalMsgId||held.msgId
      const tp1L=`${held.tp1Hit?'✅ ':''}TP1 ${held.tp1?.toFixed(dp)}`
      const tp2L=`${held.tp2Hit?'✅ ':''}TP2 ${held.tp2?.toFixed(dp)}`
      const tp3L=`${held.tp3Hit?'✅ ':''}TP3 ${held.tp3?.toFixed(dp)}`
      await sendAll(`${dirIcon(held.direction)} <b>${symObj.label} ${tf.toUpperCase()} — KEEP HOLDING ${held.direction}</b>\nConfluence still active — original trade stays open.\nEntry ${held.entry?.toFixed(dp)} · SL ${held.sl?.toFixed(dp)}\n${tp1L}\n${tp2L}\n${tp3L}`, symObj.id, sigMsgId)
      const s=loadState(); s[stateKey]={...held}; saveState(s)   // signalMsgId preserved
      console.log(`[${symObj.label} ${tf}] 📡 KEEP HOLDING`)
    } else {
      // HTF DIRECTION GATE — drop a new signal that opposes an open higher-TF trade
      const htf=higherTfDirection(loadState(), symObj.id, tf, symObj.timeframes)
      if(htf && htf.dir!==sig.direction){
        console.log(`[${symObj.label} ${tf}] ⛔ ${sig.direction} suppressed — higher TF ${htf.tf} holds ${htf.dir}`)
        return
      }

      const entry=parseFloat(sig.entry), sl=parseFloat(sig.sl)
      const tp1=parseFloat(sig.tp1), tp2=parseFloat(sig.tp2), tp3=parseFloat(sig.tp3)
      const msgText=
`${dirIcon(sig.direction)} <b>${symObj.label} ${tf.toUpperCase()} — ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
H1 ${sig.h1Trend} · ${sig.session}
🔰 Entry ${entry.toFixed(dp)} · live ${parseFloat(sig.live).toFixed(dp)}
❌ SL ${sl.toFixed(dp)} (-${toPips(entry-sl,dp)} pips)
✅ TP1 ${tp1.toFixed(dp)} (+${toPips(tp1-entry,dp)} pips)
✅ TP2 ${tp2.toFixed(dp)} (+${toPips(tp2-entry,dp)} pips)
✅ TP3 ${tp3.toFixed(dp)} (+${toPips(tp3-entry,dp)} pips)
🛡️ SL confirms only when a 5-min candle CLOSES beyond ${sl.toFixed(dp)} — a wick touch keeps the trade valid.
⚠️ Manage risk. Not financial advice.`
      const newMsgId=await sendAll(msgText, symObj.id)
      const sNow=loadState()
      sNow[stateKey]={direction:sig.direction,entry,sl,tp1,tp2,tp3,tp1Hit:false,tp2Hit:false,tp3Hit:false,signalMsgId:newMsgId,ts:sig.ts}
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
      const text=`${totalPips>=0?'📈':'📉'} <b>GOLD AI — Daily Summary (${key})</b>\n\n${lines.join('\n')}\n\n──────────────\nTrades: ${trades.length} | Wins: ${wins.length} | Losses: ${losses.length}\n<b>Total: ${summaryLine}</b>`
      try{await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:'HTML'})})}catch{}
      await broadcastSignal(text, null)
      console.log(`[daily] Summary sent: ${summaryLine}`)
    }
    setTimeout(sendDailySummary,msUntilMidnight()+1000)
  }
  setTimeout(sendDailySummary,msUntilMidnight()+1000)
  console.log(`   📅 Daily summary in ${Math.round(msUntilMidnight()/60000)} min`)
}

// ── STARTUP ───────────────────────────────────────────────────────────────
const symbols=getLiveSymbols()

console.log('🚀 Gold AI Launcher v10 — Multi-Symbol + Multi-Timeframe')
console.log(`   Symbols: ${symbols.map(s=>`${s.emoji}${s.label}[${s.timeframes.join(',')}]`).join('  ')}`)
console.log(`   ⚡ TP/SL watcher: every 5 min on candle close (no more 30s polling)`)
console.log(`   🔑 API keys: ${getLiveApiKeys().length} active`)
console.log(`   💰 Account: $${getAccountSize()} · Risk ${getRiskPct()}%`)

scheduleDailySummary()

// Sanitise stale state (clear any string/garbage entries left behind)
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

// Initial check for every symbol × every TF, then schedule everything
;(async()=>{
  for(const symObj of symbols){
    for(const tf of symObj.timeframes){
      console.log(`[startup] Initial check: ${symObj.label} ${tf}…`)
      for(let attempt=1;attempt<=MAX_RETRIES;attempt++){
        try{await runSignalCycle(symObj,tf,true);break}
        catch(e){
          const is429=e.message?.includes('429')||e.message?.includes('fetch failed')||/minute/i.test(e.message)
          if(is429&&attempt<MAX_RETRIES){switchToNextKey();console.log(`[startup] ${symObj.label} ${tf} capacity full — waiting 60s…`);await sleep(RETRY_DELAY_MS)}
          else{console.error(`[startup] ${symObj.label} ${tf} gave up: ${e.message}`);break}
        }
      }
      await sleep(3000)
    }
  }
  for(const symObj of symbols){
    for(const tf of symObj.timeframes){
      scheduleCandle(symObj,tf,runSignalCycle)
    }
  }
})()

// First sweep soon, then aligned to 5-minute closes
watchAllTrades().catch(e=>console.error('[watch initial]',e.message))
scheduleWatcher()
