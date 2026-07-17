// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  v10.15 (PENDING LIMIT ORDERS on top of v10.14)
//
//  New in v10.15:
//   • PENDING LIMIT ORDERS — the engine (gold-ai.mjs v4.5) now emits limit
//     entries (SELL_LIMIT / BUY_LIMIT) at a level instead of market fills.
//     A fresh signal with orderType != 'MARKET' is stored as PENDING: it does
//     NOT track TP/SL yet. The 1-min watcher instead waits for price to trade
//     INTO the limit:
//       – FILL  : price touches entry → "ORDER FILLED", TP/SL tracking begins.
//       – EXPIRE: not filled within PENDING_EXPIRY_BARS of its own candles →
//                 "ORDER CANCELLED", no trade taken.
//     A pending order still occupies the symbol (single-trade-per-symbol,
//     dependency gate, duplicate suppression all see it), so nothing stacks
//     on top of it. KEEP HOLDING is suppressed while an order is still pending.
//
//  v10.14: per-timeframe cooldown (incl. break-even) + single trade per symbol
//  + cross-TF duplicate suppression + custom TF dependency graph + per-TF send
//  toggle + confirmed-reversal cascade + per-symbol spread + calibrated ATR.
//
//  State keys are  symbol|tf  so Gold 15m and EURUSD 15m never collide.
// ─────────────────────────────────────────────────────────────────────────────
import {
  broadcastSignal,
  broadcastReply,
  keepHoldingEnabled,
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

const ENGINE_DIR       = './engine'
try { fs.mkdirSync(ENGINE_DIR, { recursive: true }) } catch {}
const ENGINE_TRADE_LOG = path.join(ENGINE_DIR, 'trade_log.json')
const ENGINE_SCRIPT    = path.resolve('gold-ai.mjs')

const CANDLE_DELAY_MS     = 2000
const KEY_SWITCH_DELAY_MS = 1000
const RETRY_DELAY_MS      = 60000
const WATCH_PERIOD_MS = 60 * 1000
const WATCH_BAR_MS    = 60 * 1000

// How many of THIS timeframe's candles a pending limit waits to fill before
// it's cancelled unfilled.
const PENDING_EXPIRY_BARS = parseInt(process.env.PENDING_EXPIRY_BARS || '8')

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
const toPips = (d, decimals) => decimals >= 4 ? Math.round(Math.abs(d)*10000) : Math.round(Math.abs(d)*10)
function openTrade(state, sym, tf) { const s=state[`${sym}|${tf}`]; return (s&&typeof s==='object'&&s.direction)?s:null }
const sleep = ms => new Promise(r=>setTimeout(r,ms))

function makeSignalId(symId, tf, sig) {
  return `${symId}|${tf}|${sig.direction}|${sig.ts||sig.signalMsgId||sig.entry}`
}

// ── CUSTOM TIMEFRAME DEPENDENCY GRAPH ───────────────────────────────────────
function defaultDependsOn(symObj, tf) {
  const myMin = TF_MINUTES[tf] || 0
  return (symObj.timeframes || []).filter(t => (TF_MINUTES[t] || 0) > myMin)
}
function getDependsOn(symObj, tf) {
  const cfg = symObj.depends || {}
  return Array.isArray(cfg[tf]) ? cfg[tf] : defaultDependsOn(symObj, tf)
}
function dependencyDirection(state, symId, dependsOn) {
  for (const other of dependsOn) {
    const t = openTrade(state, symId, other)
    if (t && t.direction) return { dir: t.direction, tf: other }
  }
  return null
}
function getDependents(symObj, reversedTf) {
  return (symObj.timeframes || []).filter(t => t !== reversedTf && getDependsOn(symObj, t).includes(reversedTf))
}

// ── PER-TIMEFRAME SEND TOGGLE ───────────────────────────────────────────────
function isSendEnabled(symObj, tf) {
  if (!Array.isArray(symObj.send_timeframes)) return true
  return symObj.send_timeframes.includes(tf)
}

// ── CROSS-TIMEFRAME DUPLICATE SUPPRESSION ───────────────────────────────────
const DUPLICATE_WINDOW_MIN = parseInt(process.env.DUPLICATE_WINDOW_MIN || '60')
function findDuplicateAcrossTimeframes(symObj, tf, direction) {
  const state = loadState(), now = Date.now()
  for (const otherTf of symObj.timeframes) {
    if (otherTf === tf) continue
    const t = openTrade(state, symObj.id, otherTf)
    if (t && t.direction === direction) {
      const openedAt = t.ts ? new Date(t.ts).getTime() : 0
      if (now - openedAt <= DUPLICATE_WINDOW_MIN * 60000) return { tf: otherTf, trade: t }
    }
  }
  return null
}

// ── SINGLE ACTIVE TRADE PER SYMBOL (default ON) ─────────────────────────────
const SINGLE_TRADE_PER_SYMBOL = process.env.SINGLE_TRADE_PER_SYMBOL !== '0'
function anyOtherTfHoldingTrade(symObj, tf) {
  const state = loadState()
  for (const otherTf of symObj.timeframes) {
    if (otherTf === tf) continue
    const t = openTrade(state, symObj.id, otherTf)
    if (t) return { tf: otherTf, trade: t }
  }
  return null
}

// ── POST-TRADE COOLDOWN (per-timeframe) ─────────────────────────────────────
const COOLDOWN_CANDLES_DEFAULT = parseInt(process.env.COOLDOWN_CANDLES_DEFAULT || '2')
const COOLDOWN_CANDLES_1M      = parseInt(process.env.COOLDOWN_CANDLES_1M      || '5')
function cooldownCandlesFor(tf) { return tf === '1m' ? COOLDOWN_CANDLES_1M : COOLDOWN_CANDLES_DEFAULT }
const cooldownKey = (symId, tf) => `${symId}|${tf}|cooldown`

function getCooldownCandles(symId, tf) {
  const c = loadState()[cooldownKey(symId, tf)]
  return (c && typeof c === 'object' && typeof c.candlesLeft === 'number') ? c.candlesLeft : 0
}
function armCooldown(state, symId, tf, n) {
  const key = cooldownKey(symId, tf)
  if (n > 0) state[key] = { candlesLeft: n }
  else delete state[key]
}
function tickCooldown(symId, tf) {
  const before = getCooldownCandles(symId, tf)
  if (before <= 0) return 0
  const state = loadState()
  armCooldown(state, symId, tf, before - 1)
  saveState(state)
  return before
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

// ── LEARNING LOG ───────────────────────────────────────────────────────────
const LEARN_FILE = './learning_log.json'
function logOutcome(symObj, tf, sig, result, pips, sign) {
  let a=[]; try{a=JSON.parse(fs.readFileSync(LEARN_FILE,'utf8'))}catch{}
  a.push({ ts:new Date().toISOString(), signalId:makeSignalId(symObj.id,tf,sig),
    sym:symObj.label, symId:symObj.id, tf, dir:sig.direction, result, pips, sign,
    score:sig.score??null, tier:sig.tier??null, regime:sig.regime??null, session:sig.session??null })
  const tmp=LEARN_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(a,null,2)); fs.renameSync(tmp,LEARN_FILE)
}

// ── SEND A NEW SIGNAL ──────────────────────────────────────────────────────
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
async function sendReply(text, symbolId, adminReplyId=null, subMsgIds={}, opts={}) {
  const isKeep = !!opts.keepHolding
  if (!isKeep || keepHoldingEnabled(TG_CHAT)) {
    try {
      const body={chat_id:TG_CHAT,text,parse_mode:'HTML'}
      if(adminReplyId){ body.reply_to_message_id=adminReplyId; body.allow_sending_without_reply=true }
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    }catch(e){console.error('[sendReply admin]',e.message)}
  }
  const result=await broadcastReply(text, symbolId, subMsgIds, { keepHolding: isKeep })
  console.log(`[reply][${symbolId}]${isKeep?' (keep-holding)':''} subs sent=${result.sent} failed=${result.failed} skipped=${result.skipped||0}`)
}

// ── RECENT CLOSED 1-MIN BARS ────────────────────────────────────────────────
async function fetchRecentBars(symObj) {
  const interval='1min'
  const nowBoundary=Math.floor(Date.now()/WATCH_BAR_MS)*WATCH_BAR_MS
  const keys=getLiveApiKeys(); let saw429=false
  for(let attempt=0; attempt<Math.max(keys.length,1); attempt++){
    const key=currentKey(); if(!key) break
    try{
      const res=await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symObj.td_symbol)}&interval=${interval}&outputsize=15&timezone=UTC&apikey=${key}`,{signal:AbortSignal.timeout(8000)})
      if(res.status===429){ saw429=true; switchToNextKey(); continue }
      const j=await res.json()
      if(j.code===429 || /run out|api credits|minute|limit/i.test(j.message||'')){ saw429=true; switchToNextKey(); continue }
      if(j.status==='error' || !j.values?.length) return { bars:[] }
      const bars=j.values
        .map(v=>({ts:new Date(v.datetime.replace(' ','T')+'Z').getTime(),high:parseFloat(v.high),low:parseFloat(v.low),close:parseFloat(v.close)}))
        .filter(b=>Number.isFinite(b.ts)&&b.ts<nowBoundary)
        .sort((a,b)=>a.ts-b.ts)
      return { bars }
    }catch{ /* network error — try next key */ }
  }
  return { rateLimited:saw429, bars:[] }
}

// ── CONFIRMED-REVERSAL CASCADE CLOSE ───────────────────────────────────────
const REVERSAL_CASCADE   = process.env.REVERSAL_CASCADE !== '0'
const REVERSAL_MIN_SCORE = parseInt(process.env.REVERSAL_MIN_SCORE || '55')

async function closeHeldTrade(symObj, tf, direction, entry, livePrice, reason) {
  const dp = symObj.decimals ?? 2
  const state = loadState()
  const held = openTrade(state, symObj.id, tf)
  if (!held) return

  const diff = direction==='BUY' ? (livePrice-entry) : (entry-livePrice)
  const pips = toPips(diff, dp)
  const sign = diff > 0 ? +1 : diff < 0 ? -1 : 0
  const icon = sign>0 ? '✅' : sign<0 ? '❌' : '🟦'
  const label = sign>0 ? `+${pips} pips` : sign<0 ? `-${pips} pips` : 'break-even'

  const adminReplyId = held.signalMsgId || held.msgId || null
  const subMsgIds = held.subMsgIds || {}
  await sendReply(
`${dirIcon(direction)} <b>${symObj.label} ${tf.toUpperCase()} — TREND REVERSED ${icon}</b>
${reason}
Closed early at ${livePrice.toFixed(dp)} (entry ${entry.toFixed(dp)}) → <b>${label}</b>`,
    symObj.id, adminReplyId, subMsgIds)

  const signalId = makeSignalId(symObj.id, tf, held)
  addToDaily({ sym:symObj.id, tf, dir:direction, result:'REV', pips, sign, signalId })
  logOutcome(symObj, tf, held, 'REV', pips, sign)

  state[`${symObj.id}|${tf}`] = null
  saveState(state)
  console.log(`[${symObj.label} ${tf}] 🔄 Reversal close: ${label}`)
}

// ── PENDING LIMIT ORDER — fill / expire against one closed 1-min bar ─────────
// Runs while a signal is still PENDING (unfilled limit). Fills it when price
// trades into the entry, or cancels it when its window expires. Mutates
// `state`. Returns { filled, cancelled, changed }.
async function handlePendingAgainstBar(state, symObj, tf, sig, bar){
  const key=`${symObj.id}|${tf}`, dp=symObj.decimals ?? 2
  const dir=sig.direction, entry=sig.entry
  const adminReplyId=sig.signalMsgId||sig.msgId||null, subMsgIds=sig.subMsgIds||{}

  // FILL — SELL limit fills when price rallies up into it; BUY when it dips in.
  const filled = dir==='SELL' ? bar.high>=entry : bar.low<=entry
  if(filled){
    sig.pending=false; sig.filledAt=bar.ts; sig.lastBarTs=bar.ts   // TP/SL starts NEXT bar
    state[key]={...sig}
    await sendReply(
`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — ORDER FILLED ✅</b>
Limit ${dir==='SELL'?'sell':'buy'} filled @ ${entry.toFixed(dp)}
SL ${sig.sl.toFixed(dp)} · TP1 ${sig.tp1.toFixed(dp)} — trade is now live.`,
      symObj.id, adminReplyId, subMsgIds)
    console.log(`[${symObj.label} ${tf}] ✅ Limit filled @ ${entry.toFixed(dp)}`)
    return {filled:true, changed:true}
  }

  // EXPIRE — never filled inside the window.
  if(sig.pendingExpiryTs && bar.ts>=sig.pendingExpiryTs){
    state[key]=null
    await sendReply(
`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — ORDER CANCELLED ⌛</b>
Pending ${dir==='SELL'?'sell':'buy'} limit @ ${entry.toFixed(dp)} wasn't filled in time — cancelled, no trade taken.`,
      symObj.id, adminReplyId, subMsgIds)
    console.log(`[${symObj.label} ${tf}] ⌛ Pending limit expired unfilled`)
    return {cancelled:true, changed:true}
  }

  return {changed:false}
}

// Evaluate one OPEN (filled) trade against a single closed 1-min bar.
async function evalTradeAgainstBar(state, symObj, tf, sig, bar) {
  const key=`${symObj.id}|${tf}`,dp = symObj.decimals ?? 2
  const dir=sig.direction, entry=sig.entry
  const signalId = makeSignalId(symObj.id, tf, sig)
  const adminReplyId = sig.signalMsgId || sig.msgId || null
  const subMsgIds = sig.subMsgIds || {}
  let changed=false

  // ── TP1 ──
  if(!sig.tp1Hit && (dir==='BUY' ? bar.high>=sig.tp1 : bar.low<=sig.tp1)){
    const pips=toPips(sig.tp1-entry,dp)
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP1 HIT ✅</b>\n+${pips} pips @ ${sig.tp1.toFixed(dp)}\nSL moved to break-even (${entry.toFixed(dp)}) — trade is now risk-free.\n→ Targeting TP2 ${sig.tp2.toFixed(dp)}`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:'TP1',pips,sign:+1,signalId})
    sig.tp1Hit=true; sig.sl=entry; state[key]={...sig}; changed=true
    console.log(`[${symObj.label} ${tf}] ✅ TP1 +${pips} pips`)
  }
  // ── TP2 ──
  if(sig.tp1Hit && !sig.tp2Hit && (dir==='BUY' ? bar.high>=sig.tp2 : bar.low<=sig.tp2)){
    const pips=toPips(sig.tp2-entry,dp)
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP2 HIT ✅</b>\n+${pips} pips @ ${sig.tp2.toFixed(dp)}\n→ Targeting TP3 ${sig.tp3.toFixed(dp)}`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:'TP2',pips,sign:+1,signalId})
    sig.tp2Hit=true; state[key]={...sig}; changed=true
    console.log(`[${symObj.label} ${tf}] ✅ TP2 +${pips} pips`)
  }
  // ── TP3 (full target → close) ──
  if(sig.tp2Hit && !sig.tp3Hit && (dir==='BUY' ? bar.high>=sig.tp3 : bar.low<=sig.tp3)){
    const pips=toPips(sig.tp3-entry,dp)
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP3 HIT 🏆 FULL TARGET</b>\n+${pips} pips @ ${sig.tp3.toFixed(dp)}\nAll targets reached! 🎯`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:'TP3',pips,sign:+1,signalId})
    logOutcome(symObj,tf,sig,'TP3',pips,+1)
    state[key]=null
    const tp3Cooldown = cooldownCandlesFor(tf)
    armCooldown(state, symObj.id, tf, tp3Cooldown)
    changed=true
    console.log(`[${symObj.label} ${tf}] 🏆 TP3 +${pips} pips${tp3Cooldown>0?` — cooldown armed silently (${tp3Cooldown} candles)`:''}`)
    return changed
  }

  // ── SL (wick touch) ──
  const sl=sig.sl
  const wickedBeyond = dir==='BUY' ? bar.low<=sl : bar.high>=sl
  if(wickedBeyond){
    const isBE = Math.abs(sl-entry) < Math.pow(10,-dp)/2
    const pips = toPips(sl-entry,dp)
    const label = isBE ? 'Break-even (0 pips)' : `-${pips} pips`
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — ${isBE?'CLOSED AT BREAK-EVEN 🟦':'STOP LOSS ❌'}</b>\n${label} @ ${sl.toFixed(dp)}\nPrice touched the stop — stopped out immediately.`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:isBE?'BE':'SL',pips,sign:isBE?0:-1,signalId})
    let armedCooldownCandles=0
    {
      const finalRes  = sig.tp2Hit ? 'TP2' : sig.tp1Hit ? 'TP1' : (isBE ? 'BE' : 'SL')
      const finalSign = (sig.tp2Hit||sig.tp1Hit) ? +1 : (isBE ? 0 : -1)
      const finalPips = sig.tp2Hit ? toPips(sig.tp2-entry,dp) : sig.tp1Hit ? toPips(sig.tp1-entry,dp) : pips
      logOutcome(symObj,tf,sig,finalRes,finalPips,finalSign)
      if(finalSign<=0){
        armedCooldownCandles = cooldownCandlesFor(tf)
        armCooldown(state, symObj.id, tf, armedCooldownCandles)
      }
    }
    state[key]=null; changed=true
    console.log(`[${symObj.label} ${tf}] ${isBE?'🟦 BE':'🔴 SL'} (${label})${armedCooldownCandles>0?` — cooldown armed silently (${armedCooldownCandles} candles)`:''}`)
  }
  return changed
}

// Watch one symbol's open/pending trades against ALL closed 1-min bars.
async function watchSymbol(symObj, isRetry=false) {
  const probe=loadState()
  const hasOpen=symObj.timeframes.some(tf=>openTrade(probe,symObj.id,tf))
  if(!hasOpen) return

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
    const newBars=bars.filter(b=>b.ts>lastBarTs)
    for(const bar of newBars){
      sig=openTrade(state,symObj.id,tf); if(!sig?.entry) break    // closed mid-loop

      // ── PENDING limit: fill / expire BEFORE any TP/SL tracking ──
      if(sig.pending){
        const p=await handlePendingAgainstBar(state, symObj, tf, sig, bar)
        changed = changed || p.changed
        if(p.cancelled) break
        // whether it just filled or is still waiting, advance the marker so we
        // never re-check this bar; TP/SL begins on the NEXT bar.
        const cur=openTrade(state,symObj.id,tf)
        if(cur){ cur.lastBarTs=bar.ts; state[`${symObj.id}|${tf}`]=cur; changed=true }
        continue
      }

      const c=await evalTradeAgainstBar(state, symObj, tf, sig, bar)
      changed = changed || c
      const cur=openTrade(state,symObj.id,tf)
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

function scheduleWatcher() {
  const wait = (Math.ceil(Date.now()/WATCH_PERIOD_MS)*WATCH_PERIOD_MS - Date.now()) + CANDLE_DELAY_MS
  console.log(`[watch] next TP/SL sweep in ${(wait/1000).toFixed(0)}s`)
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

async function tryWithKeyRotation(symObj, tf, callback) {
  const totalKeys = Math.max(getLiveApiKeys().length, 1)
  for(let cycle=1; cycle<=2; cycle++){
    for(let i=1; i<=totalKeys; i++){
      try{ await callback(symObj,tf); return true }
      catch(e){
        const is429=e.message?.includes('429')||e.message?.includes('rate')||e.message?.includes('minute')
        const isNet=!is429 && (e.message?.includes('fetch')||e.message?.includes('ECONNRESET'))
        if(is429){
          console.log(`[scheduler] ${symObj.label} ${tf} key rate-limited — switching key (${i}/${totalKeys}, cycle ${cycle}/2), retry in 1s`)
          switchToNextKey()
          await sleep(KEY_SWITCH_DELAY_MS)
        } else if(isNet){
          console.log(`[scheduler] ${symObj.label} ${tf} network hiccup (${i}/${totalKeys}, cycle ${cycle}/2): ${e.message} — retry in 1s`)
          await sleep(KEY_SWITCH_DELAY_MS)
        } else {
          console.error(`[scheduler] ${symObj.label} ${tf} gave up: ${e.message}`)
          return false
        }
      }
    }
    if(cycle===1){
      console.log(`[scheduler] ${symObj.label} ${tf} all ${totalKeys} keys still rate-limited after quick rotation — waiting 60s before one more pass`)
      await sleep(RETRY_DELAY_MS)
    }
  }
  console.error(`[scheduler] ${symObj.label} ${tf} gave up — all ${totalKeys} keys rate-limited across both passes`)
  return false
}

function scheduleCandle(symObj, tf, callback) {
  const mins=TF_MINUTES[tf]; if(!mins){console.error(`Unknown TF: ${tf}`);return}
  const stagger=TF_STAGGER_MS[tf]||0, wait=msUntilNextClose(mins)+stagger
  console.log(`[scheduler] ${symObj.label} ${tf} next close in ${(wait/1000).toFixed(1)}s`)
  setTimeout(async()=>{
    await sleep(CANDLE_DELAY_MS)
    await tryWithKeyRotation(symObj, tf, callback)
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
    TG_TOKEN:       '',
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
    SYMBOL_DECIMALS: String(symObj.decimals ?? 2),
    LEARNING_LOG:    path.resolve('./learning_log.json'),
  }

  const band = symObj.atr_bands?.[tf]
  if (band && band.atrLow != null && band.atrHigh != null) {
    env.ATR_LOW  = String(band.atrLow)
    env.ATR_HIGH = String(band.atrHigh)
  }
  if (symObj.spread != null) {
    env.SPREAD = String(symObj.spread)
  }

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
  const dp=symObj.decimals ?? 2

  const coolingCandlesLeft = tickCooldown(symObj.id, tf)

  if(shouldSend){
    const sig=latest

    // ── PER-TIMEFRAME SEND TOGGLE ──
    if(!isSendEnabled(symObj, tf)){
      console.log(`[${symObj.label} ${tf}] 🔇 ${sig.direction} computed (score ${sig.score}) but sending is DISABLED for this timeframe — analysed silently, not tracked`)
      return
    }

    // ── POST-TP3 COOLDOWN ──
    if(coolingCandlesLeft > 0){
      console.log(`[${symObj.label} ${tf}] 🧊 ${sig.direction} suppressed — cooling down after TP3/SL/BE (${coolingCandlesLeft} candle(s) left)`)
      return
    }

    const isHold=heldBefore&&heldBefore.direction===sig.direction

    if(isHold){
      const current=openTrade(loadState(), symObj.id, tf)
      if(!current){
        console.log(`[${symObj.label} ${tf}] KEEP HOLDING skipped — trade already closed by watcher`)
        return
      }
      // Don't send KEEP HOLDING for an order that hasn't even filled yet.
      if(current.pending){
        console.log(`[${symObj.label} ${tf}] KEEP HOLDING skipped — order still pending (unfilled)`)
        return
      }
      const adminReplyId=current.signalMsgId||current.msgId||null
      const subMsgIds=current.subMsgIds||{}
      const tp1L=`${current.tp1Hit?'✅ ':''}TP1 ${current.tp1?.toFixed(dp)}`
      const tp2L=`${current.tp2Hit?'✅ ':''}TP2 ${current.tp2?.toFixed(dp)}`
      const tp3L=`${current.tp3Hit?'✅ ':''}TP3 ${current.tp3?.toFixed(dp)}`
      await sendReply(`${dirIcon(current.direction)} <b>${symObj.label} ${tf.toUpperCase()} — KEEP HOLDING ${current.direction}</b>\nConfluence still active — original trade stays open.\nEntry ${current.entry?.toFixed(dp)} · SL ${current.sl?.toFixed(dp)}\n${tp1L}\n${tp2L}\n${tp3L}`, symObj.id, adminReplyId, subMsgIds, { keepHolding:true })
      console.log(`[${symObj.label} ${tf}] 📡 KEEP HOLDING`)
    } else {
      // ── CONFIRMED-REVERSAL CASCADE CLOSE ──
      const stillOpen = openTrade(loadState(), symObj.id, tf)
      const isConfirmedReversal = REVERSAL_CASCADE && stillOpen && stillOpen.direction
        && stillOpen.direction !== sig.direction && sig.score >= REVERSAL_MIN_SCORE

      if (isConfirmedReversal) {
        const oldDir = stillOpen.direction
        const livePrice = parseFloat(sig.live)
        console.log(`[${symObj.label} ${tf}] 🔄 CONFIRMED reversal — fresh ${sig.direction} (score ${sig.score}) while ${tf} held ${oldDir}. Closing ${tf} + dependents at live ${livePrice}.`)

        await closeHeldTrade(symObj, tf, oldDir, stillOpen.entry, livePrice,
          `${tf.toUpperCase()} trend reversed to ${sig.direction} — confirmed by a fresh ${sig.tier}-tier signal (score ${sig.score}).`)

        const dependents = getDependents(symObj, tf)
        for (const otherTf of dependents) {
          const otherHeld = openTrade(loadState(), symObj.id, otherTf)
          if (otherHeld && otherHeld.direction === oldDir) {
            await closeHeldTrade(symObj, otherTf, oldDir, otherHeld.entry, livePrice,
              `${tf.toUpperCase()} (a dependency of ${otherTf.toUpperCase()}) reversed to ${sig.direction} — closing this ${otherTf.toUpperCase()} ${oldDir} early.`)
          }
        }
      } else if (stillOpen && stillOpen.direction && stillOpen.direction !== sig.direction) {
        console.log(`[${symObj.label} ${tf}] ⛔ ${sig.direction} suppressed — ${tf} still holds ${stillOpen.direction} (score ${sig.score} below reversal threshold ${REVERSAL_MIN_SCORE})`)
        return
      }

      // ── SINGLE ACTIVE TRADE PER SYMBOL ──
      if (SINGLE_TRADE_PER_SYMBOL) {
        const other = anyOtherTfHoldingTrade(symObj, tf)
        if (other) {
          console.log(`[${symObj.label} ${tf}] ⛔ ${sig.direction} suppressed — ${other.tf} already holds an active ${other.trade.direction} trade on this symbol`)
          return
        }
      }

      // ── TIMEFRAME DEPENDENCY GATE ──
      const dependsOn = getDependsOn(symObj, tf)
      const dep = dependencyDirection(loadState(), symObj.id, dependsOn)
      if(dep && dep.dir!==sig.direction){
        console.log(`[${symObj.label} ${tf}] ⛔ ${sig.direction} suppressed — depends on ${dep.tf} which holds ${dep.dir}`)
        return
      }

      // ── CROSS-TIMEFRAME DUPLICATE SUPPRESSION ──
      const dup = findDuplicateAcrossTimeframes(symObj, tf, sig.direction)
      if (dup) {
        if (sig.score > (dup.trade.score ?? 0)) {
          const s = loadState()
          s[`${symObj.id}|${dup.tf}`] = null
          saveState(s)
          console.log(`[${symObj.label} ${tf}] 🔁 Duplicate ${sig.direction} — ${dup.tf} (score ${dup.trade.score}) dropped for this ${tf} (score ${sig.score})`)
        } else {
          console.log(`[${symObj.label} ${tf}] 🔁 Duplicate ${sig.direction} suppressed — ${dup.tf} holds equal/better (score ${dup.trade.score} vs ${sig.score})`)
          return
        }
      }

      const entry=parseFloat(sig.entry), sl=parseFloat(sig.sl)
      const tp1=parseFloat(sig.tp1), tp2=parseFloat(sig.tp2), tp3=parseFloat(sig.tp3)

      // ── LIMIT vs MARKET presentation + pending stamp ──
      const isLimit = sig.orderType && sig.orderType!=='MARKET'
      const otLabel = sig.orderType==='SELL_LIMIT' ? 'SELL LIMIT'
                    : sig.orderType==='BUY_LIMIT'  ? 'BUY LIMIT'
                    : sig.direction
      const kindLabel = { retest_up:'break→retest ⬆', retest_down:'break→retest ⬇',
                          fade_high:'fade resistance', fade_low:'fade support' }[sig.setupKind] || ''
      const entryLine = isLimit
        ? `🎯 <b>${otLabel} @ ${entry.toFixed(dp)}</b> · live ${parseFloat(sig.live).toFixed(dp)}\n⏳ Pending — fills when price ${sig.direction==='SELL'?'rises into':'drops into'} ${entry.toFixed(dp)}`
        : `🔰 Entry ${entry.toFixed(dp)} · live ${parseFloat(sig.live).toFixed(dp)}`

      const msgText=
`${dirIcon(sig.direction)} <b>${symObj.label} ${tf.toUpperCase()} — ${otLabel}</b> (score ${sig.score}/100 ${sig.tier})${kindLabel?` · ${kindLabel}`:''}
H1 ${sig.h1Trend} · ${sig.session}
${entryLine}
❌ SL ${sl.toFixed(dp)} (-${toPips(entry-sl,dp)} pips)
✅ TP1 ${tp1.toFixed(dp)} (+${toPips(tp1-entry,dp)} pips)
✅ TP2 ${tp2.toFixed(dp)} (+${toPips(tp2-entry,dp)} pips)
✅ TP3 ${tp3.toFixed(dp)} (+${toPips(tp3-entry,dp)} pips)
🛡️ SL triggers immediately if price touches ${sl.toFixed(dp)}.
⚠️ Manage risk. Not financial advice.`

      const nowBar1m=Math.floor(Date.now()/WATCH_BAR_MS)*WATCH_BAR_MS - WATCH_BAR_MS
      const pendingExpiryTs = isLimit ? Date.now() + PENDING_EXPIRY_BARS*(TF_MINUTES[tf]||15)*60000 : null
      const r=await sendNewSignal(msgText, symObj.id)
      const sNow=loadState()
      sNow[stateKey]={direction:sig.direction,orderType:sig.orderType||'MARKET',setupKind:sig.setupKind||'none',pending:isLimit,pendingExpiryTs,entry,sl,tp1,tp2,tp3,tp1Hit:false,tp2Hit:false,tp3Hit:false,signalMsgId:r.adminMsgId,subMsgIds:r.subMsgIds,lastBarTs:nowBar1m,ts:sig.ts,score:sig.score,tier:sig.tier,regime:sig.regime,session:sig.session}
      saveState(sNow)
      console.log(`[${symObj.label} ${tf}] 📡 NEW ${sig.orderType} (${sig.setupKind}) ${isLimit?'PENDING':'market'} adminMsgId=${r.adminMsgId} subs=${Object.keys(r.subMsgIds).length}`)
    }
  } else if(!hasSignal&&!fresh){
    console.log(`[${symObj.label} ${tf}] No signal this candle`)
  }
}

// ── DAILY SUMMARY ─────────────────────────────────────────────────────────
const SUMMARY_RANK = { SL:0, BE:0, TP1:1, TP2:2, TP3:3 }
function collapseRows(rows) {
  const byId=new Map(); let auto=0
  for(const t of rows){
    const id=t.signalId||`__solo_${auto++}`
    const rank=SUMMARY_RANK[t.result] ?? -1
    const cur=byId.get(id)
    if(!cur || rank > (SUMMARY_RANK[cur.result] ?? -1)) byId.set(id,t)
  }
  return [...byId.values()]
}
function scheduleDailySummary(){
  function msUntilMidnight(){const now=new Date();return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1))-now}
  async function sendDailySummary(){
    const key=todayKey(),daily=loadDaily(),day=daily[key]
    if(day?.trades?.length>0){
      const trades=collapseRows(day.trades)
      const signedPips=t=>t.sign>0?t.pips:t.sign<0?-t.pips:0
      const totalPips=Math.round(trades.reduce((a,t)=>a+signedPips(t),0))
      const wins=trades.filter(t=>t.sign>0),losses=trades.filter(t=>t.sign<0)
      const lines=trades.map(t=>{
        const nm=(t.sym||'').toUpperCase()
        const icon=t.sign>0?'✅':t.sign<0?'❌':'🟦'
        const sign=t.sign>0?'+':t.sign<0?'-':''
        return `${icon} ${nm} ${t.tf?.toUpperCase()} ${t.dir} → ${t.result}: ${sign}${t.pips} pips`
      })
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

console.log('🚀 Gold AI Launcher v10.15 — Pending Limit Orders (fill/expire) + Per-Timeframe Cooldown + Single Trade Per Symbol + Cross-TF Duplicate Suppression + Custom TF Dependency Graph + Per-TF Send Toggle + Confirmed-Reversal Cascade + Per-Symbol Spread + Calibrated ATR')
console.log(`   Symbols: ${symbols.map(s=>`${s.emoji}${s.label}[${s.timeframes.join(',')}]`).join('  ')}`)
console.log(`   ⚡ TP/SL watcher: every 1 min — TP & SL trigger on wick touch`)
console.log(`   🎯 Entries: pending LIMIT at level (engine v4.5). Fills on touch, cancels after ${PENDING_EXPIRY_BARS} of the TF's candles unfilled (PENDING_EXPIRY_BARS to change)`)
console.log(`   🔒 Single trade per symbol: ${SINGLE_TRADE_PER_SYMBOL?'ON':'OFF'}`)
console.log(`   🔄 Confirmed-reversal cascade: score≥${REVERSAL_MIN_SCORE} (REVERSAL_CASCADE=0 to disable)`)
console.log(`   🧊 Cooldown after TP3/SL/BE: 1m → ${COOLDOWN_CANDLES_1M}, others → ${COOLDOWN_CANDLES_DEFAULT}`)
console.log(`   🔑 API keys: ${getLiveApiKeys().length} active · 💰 Account: $${getAccountSize()} · Risk ${getRiskPct()}%`)

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

// Initial check for every symbol × every TF, then schedule everything
;(async()=>{
  for(const symObj of symbols){
    for(const tf of symObj.timeframes){
      console.log(`[startup] Initial check: ${symObj.label} ${tf}…`)
      await tryWithKeyRotation(symObj, tf, (s,t)=>runSignalCycle(s,t,true))
      await sleep(3000)
    }
  }
  for(const symObj of symbols){
    for(const tf of symObj.timeframes){
      scheduleCandle(symObj,tf,runSignalCycle)
    }
  }
})()

watchAllTrades().catch(e=>console.error('[watch initial]',e.message))
scheduleWatcher()
