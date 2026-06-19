// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  v10.1 (Multi-Symbol + Multi-Timeframe)
//
//  Changes vs v10:
//   A. TP/SL RELIABILITY FIX — the old watcher fetched ONE last-closed 5m bar
//      and required an EXACT timestamp match (bar.ts===expectedOpen). When the
//      bar timestamp didn't line up, or a 5m sweep was skipped (429 / restart),
//      that candle was never re-checked and the TP/SL was silently lost — for
//      ADMIN too. The watcher now fetches the last ~12 closed 5m bars and
//      evaluates EVERY bar newer than the trade's lastBarTs, in order. Missed
//      sweeps self-heal on the next sweep. This is the real "not sending" fix.
//   B. SUBSCRIBER THREADING — TP/SL/KEEP-HOLDING alerts now reply UNDER the
//      original signal in every SUBSCRIBER chat, not just the admin chat. The
//      signal's per-subscriber message_id map (subMsgIds) is stored on the trade
//      and used as reply_to for each recipient.
//
//  Carried over from v10: HTF direction gate, SL pips in message, engine run in
//  isolated ./engine dir, atomic state writes, 1-min retry on 429.
//
//  State keys are  symbol|tf  so Gold 15m and EURUSD 15m never collide.
// ─────────────────────────────────────────────────────────────────────────────
import {
  broadcastSignal,
  broadcastReply,
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
const WATCH_PERIOD_MS = 60 * 1000  // 1-minute TP/SL sweep
const WATCH_BAR_MS    = 60 * 1000  // 1-minute candle for TP/SL detection

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

// ── SEND A NEW SIGNAL ──────────────────────────────────────────────────────
// Admin (direct) + all subscribers. Captures EVERY message id so TP/SL alerts
// can thread under the original signal in each chat.
// Returns { adminMsgId, subMsgIds:{chatId:message_id} }.
async function sendNewSignal(text, symbolId) {
  let adminMsgId=null
  try {
    const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:'HTML'})})
    const j=await res.json(); if(j.ok) adminMsgId=j.result.message_id
  }catch(e){console.error('[sendNewSignal admin]',e.message)}
  const result=await broadcastSignal(text, symbolId)
  console.log(`[newSignal][${symbolId}] adminMsgId=${adminMsgId} subs sent=${result.sent} failed=${result.failed}`)
  return { adminMsgId, subMsgIds: result.msgIds || {} }
}

// ── SEND A THREADED REPLY ──────────────────────────────────────────────────
// TP/SL/KEEP-HOLDING alert that replies UNDER the original signal in every chat:
// admin replies to adminReplyId, each subscriber replies to their stored id.
// (allow_sending_without_reply means it still delivers if the original is gone.)
async function sendReply(text, symbolId, adminReplyId=null, subMsgIds={}) {
  try {
    const body={chat_id:TG_CHAT,text,parse_mode:'HTML'}
    if(adminReplyId){ body.reply_to_message_id=adminReplyId; body.allow_sending_without_reply=true }
    await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  }catch(e){console.error('[sendReply admin]',e.message)}
  const result=await broadcastReply(text, symbolId, subMsgIds)
  console.log(`[reply][${symbolId}] subs sent=${result.sent} failed=${result.failed}`)
}

// ── RECENT CLOSED 1-MIN BARS (catch-up; reports 429 exhaustion) ─────────────
// Checks every minute — returns { bars:[{ts,high,low,close}], rateLimited }
// with ONLY closed bars, sorted oldest→newest. The forming bar is excluded.
async function fetchRecentBars(symObj) {
  const interval='1min'
  const nowBoundary=Math.floor(Date.now()/WATCH_BAR_MS)*WATCH_BAR_MS   // start of the FORMING bar
  const keys=getLiveApiKeys(); let saw429=false
  for(let attempt=0; attempt<Math.max(keys.length,1); attempt++){
    const key=currentKey(); if(!key) break
    try{
      const res=await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symObj.td_symbol)}&interval=${interval}&outputsize=15&apikey=${key}`,{signal:AbortSignal.timeout(8000)})
      if(res.status===429){ saw429=true; switchToNextKey(); continue }
      const j=await res.json()
      if(j.code===429 || /run out|api credits|minute|limit/i.test(j.message||'')){ saw429=true; switchToNextKey(); continue }
      if(j.status==='error' || !j.values?.length) return { bars:[] }
      const bars=j.values
        .map(v=>({ts:new Date(v.datetime.replace(' ','T')+'Z').getTime(),high:parseFloat(v.high),low:parseFloat(v.low),close:parseFloat(v.close)}))
        .filter(b=>Number.isFinite(b.ts)&&b.ts<nowBoundary)   // CLOSED bars only
        .sort((a,b)=>a.ts-b.ts)                                // oldest → newest
      return { bars }
    }catch{ /* network error — try next key */ }
  }
  return { rateLimited:saw429, bars:[] }
}

// Evaluate one open trade against a single closed 5-min bar. Mutates `state`,
// sends threaded alerts. Returns true if state changed.
async function evalTradeAgainstBar(state, symObj, tf, sig, bar) {
  const key=`${symObj.id}|${tf}`, dp=symObj.decimals||2
  const dir=sig.direction, entry=sig.entry
  const adminReplyId = sig.signalMsgId || sig.msgId || null   // reply to ORIGINAL signal (admin)
  const subMsgIds = sig.subMsgIds || {}                        // per-subscriber original message ids
  let changed=false

  // ── TP1 (wick touch) ──
  if(!sig.tp1Hit && (dir==='BUY' ? bar.high>=sig.tp1 : bar.low<=sig.tp1)){
    const pips=toPips(sig.tp1-entry,dp)
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP1 HIT ✅</b>\n+${pips} pips @ ${sig.tp1.toFixed(dp)}\nSL moved to break-even (${entry.toFixed(dp)}) — trade is now risk-free.\n→ Targeting TP2 ${sig.tp2.toFixed(dp)}`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:'TP1',pips,sign:+1})
    sig.tp1Hit=true; sig.sl=entry; state[key]={...sig}; changed=true
    console.log(`[${symObj.label} ${tf}] ✅ TP1 +${pips} pips`)
  }
  // ── TP2 ──
  if(sig.tp1Hit && !sig.tp2Hit && (dir==='BUY' ? bar.high>=sig.tp2 : bar.low<=sig.tp2)){
    const pips=toPips(sig.tp2-entry,dp)
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP2 HIT ✅</b>\n+${pips} pips @ ${sig.tp2.toFixed(dp)}\n→ Targeting TP3 ${sig.tp3.toFixed(dp)}`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:'TP2',pips,sign:+1})
    sig.tp2Hit=true; state[key]={...sig}; changed=true
    console.log(`[${symObj.label} ${tf}] ✅ TP2 +${pips} pips`)
  }
  // ── TP3 (full target → close) ──
  if(sig.tp2Hit && !sig.tp3Hit && (dir==='BUY' ? bar.high>=sig.tp3 : bar.low<=sig.tp3)){
    const pips=toPips(sig.tp3-entry,dp)
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP3 HIT 🏆 FULL TARGET</b>\n+${pips} pips @ ${sig.tp3.toFixed(dp)}\nAll targets reached! 🎯`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:'TP3',pips,sign:+1})
    state[key]=null; changed=true
    console.log(`[${symObj.label} ${tf}] 🏆 TP3 +${pips} pips`)
    return changed   // trade fully closed
  }

  // ── SL (wick touch — immediate, same as TP) ──────────────────────────────
  const sl=sig.sl
  const wickedBeyond = dir==='BUY' ? bar.low<=sl : bar.high>=sl
  if(wickedBeyond){
    const isBE = Math.abs(sl-entry) < Math.pow(10,-dp)/2
    const pips = toPips(sl-entry,dp)
    const label = isBE ? 'Break-even (0 pips)' : `-${pips} pips`
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — ${isBE?'CLOSED AT BREAK-EVEN 🟦':'STOP LOSS ❌'}</b>\n${label} @ ${sl.toFixed(dp)}\nPrice touched the stop — stopped out immediately.`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:isBE?'BE':'SL',pips,sign:isBE?0:-1})
    state[key]=null; changed=true
    console.log(`[${symObj.label} ${tf}] ${isBE?'🟦 BE':'🔴 SL'} (${label})`)
  }
  return changed
}

// Watch one symbol's open trades against ALL closed 5m bars since last checked.
async function watchSymbol(symObj, isRetry=false) {
  const probe=loadState()
  const hasOpen=symObj.timeframes.some(tf=>openTrade(probe,symObj.id,tf))
  if(!hasOpen) return   // nothing open → no API call needed

  const res=await fetchRecentBars(symObj)
  if(res.rateLimited){
    if(!isRetry){ console.log(`[watch ${symObj.label}] per-minute API capacity full — retrying in 60s`); setTimeout(()=>watchSymbol(symObj,true).catch(()=>{}), RETRY_DELAY_MS) }
    else console.error(`[watch ${symObj.label}] still rate-limited after retry — next 1m sweep will catch it`)
    return
  }
  const bars=res.bars; if(!bars.length) return

  const state=loadState(); let changed=false
  for(const tf of symObj.timeframes){
    let sig=openTrade(state,symObj.id,tf); if(!sig?.entry) continue
    const lastBarTs=sig.lastBarTs||0
    // Only bars that CLOSED after the signal was sent, and never re-check a bar.
    const newBars=bars.filter(b=>b.ts>lastBarTs)
    for(const bar of newBars){
      sig=openTrade(state,symObj.id,tf); if(!sig?.entry) break    // closed mid-loop (TP3/SL)
      const c=await evalTradeAgainstBar(state, symObj, tf, sig, bar)
      changed = changed || c
      const cur=openTrade(state,symObj.id,tf)                     // advance progress marker
      if(cur){ cur.lastBarTs=bar.ts; state[`${symObj.id}|${tf}`]=cur; changed=true }
    }
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
      // Re-read state AFTER engine exec — the watcher may have run during the await and
      // updated tp1Hit/sl (or set trade=null on TP3/SL). Using stale heldBefore here
      // would clobber those updates or resurrect a closed trade.
      const current=openTrade(loadState(), symObj.id, tf)
      if(!current){
        // Watcher already closed this trade during exec (TP3 or SL) — do not send
        // KEEP HOLDING and do NOT re-save the old snapshot (that would resurrect it).
        console.log(`[${symObj.label} ${tf}] KEEP HOLDING skipped — trade already closed by watcher`)
        return
      }
      const adminReplyId=current.signalMsgId||current.msgId||null
      const subMsgIds=current.subMsgIds||{}
      const tp1L=`${current.tp1Hit?'✅ ':''}TP1 ${current.tp1?.toFixed(dp)}`
      const tp2L=`${current.tp2Hit?'✅ ':''}TP2 ${current.tp2?.toFixed(dp)}`
      const tp3L=`${current.tp3Hit?'✅ ':''}TP3 ${current.tp3?.toFixed(dp)}`
      await sendReply(`${dirIcon(current.direction)} <b>${symObj.label} ${tf.toUpperCase()} — KEEP HOLDING ${current.direction}</b>\nConfluence still active — original trade stays open.\nEntry ${current.entry?.toFixed(dp)} · SL ${current.sl?.toFixed(dp)}\n${tp1L}\n${tp2L}\n${tp3L}`, symObj.id, adminReplyId, subMsgIds)
      // DO NOT saveState here — the watcher owns tp1Hit/sl/lastBarTs.
      // Saving the old snapshot would clobber those updates.
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
🛡️ SL triggers immediately if price touches ${sl.toFixed(dp)}.
⚠️ Manage risk. Not financial advice.`
      // lastBarTs = signal bar's open (1-min). Filter is b.ts > lastBarTs so the NEXT
      // 1-min bar is the first one evaluated. Catches TP/SL within seconds of touch.
      const nowBar5m=Math.floor(Date.now()/WATCH_BAR_MS)*WATCH_BAR_MS - WATCH_BAR_MS
      const r=await sendNewSignal(msgText, symObj.id)
      const sNow=loadState()
      sNow[stateKey]={direction:sig.direction,entry,sl,tp1,tp2,tp3,tp1Hit:false,tp2Hit:false,tp3Hit:false,signalMsgId:r.adminMsgId,subMsgIds:r.subMsgIds,lastBarTs:nowBar5m,ts:sig.ts}
      saveState(sNow)
      console.log(`[${symObj.label} ${tf}] 📡 NEW signal adminMsgId=${r.adminMsgId} subs=${Object.keys(r.subMsgIds).length}`)
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

console.log('🚀 Gold AI Launcher v10.1 — Multi-Symbol + Multi-Timeframe')
console.log(`   Symbols: ${symbols.map(s=>`${s.emoji}${s.label}[${s.timeframes.join(',')}]`).join('  ')}`)
console.log(`   ⚡ TP/SL watcher: every 1 min — TP & SL both trigger on wick touch`)
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
