// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  v7
//  Candle-close sync: fires signal check exactly when each TF candle closes.
//  Price watcher runs every 30s for instant TP alerts.
//
//  v7 fix (the important one):
//   • gold-ai.mjs writes its OWN string dedupe key into bot_state.json[tf],
//     which clobbers the launcher's trade OBJECT every candle. That made the
//     `isHold` check fail (object → string) so every repeat fired as a NEW
//     signal and KEEP HOLDING never triggered.
//   • Fix: snapshot the open trade BEFORE running gold-ai, decide NEW vs HOLD
//     from that snapshot, and re-write our object afterward (gold-ai's string
//     is always restored back to our object). KEEP HOLDING now works.
//
//  v6 carried over:
//   • SL confirmed ON CANDLE CLOSE (a wick through SL keeps the trade valid).
//   • TP1/TP2/TP3 fire instantly on the 30s watcher (reply + pips).
//   • NEW signals carry the SL-on-close disclaimer.
// ─────────────────────────────────────────────────────────────────────────────
import { broadcastSignal } from './bot-subscription.mjs'
import fs from 'fs'

const PRICE_CHECK_MS  = (parseInt(process.env.PRICE_CHECK_SEC) || 30) * 1000
const CANDLE_DELAY_MS = 2000
const RETRY_DELAY_MS  = 60000
const MAX_RETRIES     = 3
const TF_STAGGER_MS   = { '15m':0, '1h':4*60000, '4h':45000, '1d':60000 }

const TG_TOKEN       = process.env.TG_TOKEN        || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const TWELVEDATA_KEYS = [
  process.env.TWELVEDATA_KEY  || 'dbf374976088424aa703db6034942e19',  // key 1
  'da16adf775b04e31a6a33386689e38c8',                                   // key 2
  '34034261d78440e28ece3d43ddd64955',                                   // key 3
  'ef3ccaeaa4954935b193708cf86fa97d',                                   // key 4
  '9268e6afa5024f6a97ca03e44dcb59c0',                                   // key 5
  '78ce7374b05b4e33a3e1bd4c6311ff25',                                   // key 6
]
let activeKeyIndex = 0
let TWELVEDATA_KEY = TWELVEDATA_KEYS[0]

function switchToNextKey() {
  const next = (activeKeyIndex + 1) % TWELVEDATA_KEYS.length
  if (next === activeKeyIndex) {
    console.error('[API] No more fallback keys available!')
    return false
  }
  activeKeyIndex = next
  TWELVEDATA_KEY = TWELVEDATA_KEYS[activeKeyIndex]
  console.log(`[API] ⚠️ Switched to key #${activeKeyIndex + 1}: ${TWELVEDATA_KEY.slice(0,8)}…`)
  return true
}

const LIVE_TFS   = (process.env.LIVE_TFS || '15m,1h').split(',').map(s => s.trim()).filter(Boolean)
const SOURCE     = process.env.GOLD_SOURCE || (process.env.OANDA_TOKEN ? 'oanda' : 'twelvedata')
const TG_CHAT    = process.env.TG_CHAT || '1408577116'
const STATE_FILE = './bot_state.json'
const TRADE_LOG  = './trade_log.json'
const DAILY_FILE = './daily_report.json'

const TF_MINUTES = { '1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'2h':120,'4h':240,'1d':1440 }
const TD_INTERVAL = { '1m':'1min','3m':'3min','5m':'5min','15m':'15min','30m':'30min','1h':'1h','2h':'2h','4h':'4h','1d':'1day' }

const dirIcon = dir => dir === 'BUY' ? '🟢' : '🔴'
const toPips  = d => Math.round(Math.abs(d) * 10)

function openTrade(state, tf) {
  const s = state[tf]
  return (s && typeof s === 'object' && s.direction) ? s : null
}

// ── Candle close scheduler ────────────────────────────────────────────────────
function msUntilNextClose(tfMinutes) {
  const now = Date.now()
  const periodMs = tfMinutes * 60 * 1000
  return Math.ceil(now / periodMs) * periodMs - now
}

function scheduleCandle(tf, callback) {
  const mins = TF_MINUTES[tf]
  if (!mins) { console.error(`Unknown TF: ${tf}`); return }
  const stagger = TF_STAGGER_MS[tf] || 0
  const wait    = msUntilNextClose(mins) + stagger
  const closeAt = new Date(Date.now() + wait).toISOString()
  console.log(`[scheduler] ${tf} next candle close in ${(wait/1000).toFixed(1)}s (at ${closeAt})${stagger ? ` +${stagger/1000}s stagger` : ''}`)

  setTimeout(async () => {
    await new Promise(r => setTimeout(r, CANDLE_DELAY_MS))
    let success = false
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try { await callback(tf); success = true; break }
      catch (e) {
        const is429 = e.message?.includes('429') || e.message?.includes('rate')
        const isNet = e.message?.includes('fetch') || e.message?.includes('ECONNRESET')
        if ((is429 || isNet) && attempt < MAX_RETRIES) {
          if (is429) { console.log(`[scheduler] ${tf} rate limited — switching key, retrying in ${RETRY_DELAY_MS/1000}s`); switchToNextKey() }
          else console.log(`[scheduler] ${tf} attempt ${attempt} failed (${e.message}) — retrying in ${RETRY_DELAY_MS/1000}s`)
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
        } else { console.error(`[scheduler] ${tf} gave up after ${attempt} attempt(s): ${e.message}`); break }
      }
    }
    scheduleCandle(tf, callback)
  }, wait)
}

// ── State helpers ─────────────────────────────────────────────────────────────
function loadState() { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} } }
function saveState(s) { s.at = new Date().toISOString(); fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)) }

// ── Daily report ──────────────────────────────────────────────────────────────
function todayKey() { return new Date().toISOString().slice(0, 10) }
function loadDaily() { try { return JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8')) } catch { return {} } }
function saveDaily(d) { fs.writeFileSync(DAILY_FILE, JSON.stringify(d, null, 2)) }
function addToDaily(trade) {
  const key = todayKey(), daily = loadDaily()
  if (!daily[key]) daily[key] = { trades: [], totalPips: 0 }
  daily[key].trades.push({ ...trade, ts: new Date().toISOString() })
  daily[key].totalPips += trade.sign * trade.pips
  saveDaily(daily)
}

// ── Send to admin + all subscribers ──────────────────────────────────────────
async function sendAll(text, replyToMsgId = null) {
  let adminMsgId = null
  try {
    const body = { chat_id: TG_CHAT, text, parse_mode: 'HTML' }
    if (replyToMsgId) body.reply_to_message_id = replyToMsgId
    const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    })
    const j = await res.json()
    if (j.ok) adminMsgId = j.result.message_id
  } catch (e) { console.error('[sendAll admin]', e.message) }
  const result = await broadcastSignal(text, replyToMsgId)
  console.log(`[sendAll] adminMsgId=${adminMsgId} subs sent=${result.sent} failed=${result.failed}`)
  return adminMsgId
}

// ── Live price ────────────────────────────────────────────────────────────────
async function fetchLivePrice() {
  for (let attempt = 0; attempt < TWELVEDATA_KEYS.length; attempt++) {
    try {
      const res = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TWELVEDATA_KEY}`, { signal: AbortSignal.timeout(8000) })
      if (res.status === 429) { switchToNextKey(); continue }
      const j = await res.json()
      if (j.price) return parseFloat(j.price)
      if (j.code === 429) { switchToNextKey(); continue }
    } catch {}
    try {
      const res = await fetch(`https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${TWELVEDATA_KEY}`, { signal: AbortSignal.timeout(8000) })
      if (res.status === 429) { switchToNextKey(); continue }
      const j = await res.json()
      if (j.close) return parseFloat(j.close)
    } catch {}
  }
  return null
}

// ── Fetch last closed candle ──────────────────────────────────────────────────
async function fetchClosedBar(tf) {
  const interval = TD_INTERVAL[tf]; if (!interval) return null
  const periodMs = TF_MINUTES[tf] * 60000
  const boundary = Math.floor(Date.now() / periodMs) * periodMs
  const expectedOpen = boundary - periodMs
  for (let attempt = 0; attempt < TWELVEDATA_KEYS.length; attempt++) {
    try {
      const res = await fetch(`https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=3&apikey=${TWELVEDATA_KEY}`, { signal: AbortSignal.timeout(8000) })
      if (res.status === 429) { switchToNextKey(); continue }
      const j = await res.json()
      if (j.code === 429) { switchToNextKey(); continue }
      if (j.status === 'error' || !j.values?.length) return null
      const bars = j.values.map(v => ({ ts: new Date(v.datetime.replace(' ','T')+'Z').getTime(), open:parseFloat(v.open), high:parseFloat(v.high), low:parseFloat(v.low), close:parseFloat(v.close) }))
      return bars.find(b => b.ts === expectedOpen) || bars.filter(b => b.ts + periodMs <= Date.now()).sort((a,b) => b.ts - a.ts)[0] || null
    } catch {}
  }
  return null
}

// ── SL on candle close ────────────────────────────────────────────────────────
async function checkStopOnClose(tf) {
  const state = loadState(), sig = openTrade(state, tf)
  if (!sig || sig.sl == null) return
  const bar = await fetchClosedBar(tf)
  if (!bar) { console.log(`[${tf}] SL-on-close: no closed bar, skipping`); return }
  const { direction: dir, entry, sl, msgId } = sig
  const closedBeyond = dir === 'BUY' ? bar.close <= sl : bar.close >= sl
  if (!closedBeyond) {
    if (dir === 'BUY' ? bar.low <= sl : bar.high >= sl)
      console.log(`[${tf}] SL wick @ $${sl} but closed at $${bar.close} — trade still valid`)
    return
  }
  const pips = toPips(Math.abs(sl - entry)), isBE = sl === entry
  const pnlLabel = isBE ? '0 pips (break-even)' : `-${pips} pips`
  await sendAll(`${dirIcon(dir)} <b>GOLD ${tf.toUpperCase()} — STOP LOSS HIT</b>\n${pnlLabel} @ $${sl}\nCandle closed at $${bar.close.toFixed(2)} — confirmed on close.\nTrade closed. ❌`, msgId)
  addToDaily({ tf, dir, result: isBE ? 'BE' : 'SL', pips, sign: isBE ? 0 : -1 })
  const s = loadState(); s[tf] = null; saveState(s)
  console.log(`[${tf}] 🔴 SL confirmed on close (${pnlLabel})`)
}

// ── Fast price watcher — TP only ──────────────────────────────────────────────
async function fastPriceCheck() {
  const livePrice = await fetchLivePrice(); if (!livePrice) return
  const state = loadState(); let changed = false
  const ts = new Date().toISOString()
  for (const tf of LIVE_TFS) {
    const sig = openTrade(state, tf); if (!sig?.entry) continue
    const { direction: dir, entry, tp1, tp2, tp3, tp1Hit=false, tp2Hit=false, tp3Hit=false, msgId=null } = sig

    const tp1Cross = dir==='BUY' ? livePrice>=tp1 : livePrice<=tp1
    if (tp1Cross && !tp1Hit) {
      const pips = toPips(Math.abs(tp1-entry))
      const newMsgId = await sendAll(`${dirIcon(dir)} <b>GOLD ${tf.toUpperCase()} — TP1 HIT ✅</b>\n+${pips} pips @ $${tp1}\nLive: $${livePrice.toFixed(2)}\n→ Ride to TP2 $${tp2} · SL moved to BE $${entry}`, msgId)
      addToDaily({ tf, dir, result:'TP1', pips, sign:+1 })
      state[tf] = { ...sig, tp1Hit:true, sl:entry, msgId:newMsgId||msgId }
      changed=true; sig.tp1Hit=true; sig.sl=entry
      console.log(`[${ts}] [${tf}] ✅ TP1 +${pips} pips`)
    }

    const tp2Cross = dir==='BUY' ? livePrice>=tp2 : livePrice<=tp2
    if (tp2Cross && sig.tp1Hit && !tp2Hit) {
      const pips = toPips(Math.abs(tp2-entry))
      const newMsgId = await sendAll(`${dirIcon(dir)} <b>GOLD ${tf.toUpperCase()} — TP2 HIT ✅</b>\n+${pips} pips @ $${tp2}\nLive: $${livePrice.toFixed(2)}\n→ Ride remainder to TP3 $${tp3}`, msgId)
      addToDaily({ tf, dir, result:'TP2', pips, sign:+1 })
      state[tf] = { ...state[tf], tp2Hit:true, msgId:newMsgId||msgId }
      changed=true; sig.tp2Hit=true
      console.log(`[${ts}] [${tf}] ✅ TP2 +${pips} pips`)
    }

    const tp3Cross = dir==='BUY' ? livePrice>=tp3 : livePrice<=tp3
    if (tp3Cross && sig.tp2Hit && !tp3Hit) {
      const pips = toPips(Math.abs(tp3-entry))
      await sendAll(`${dirIcon(dir)} <b>GOLD ${tf.toUpperCase()} — TP3 HIT 🏆 FULL TARGET</b>\n+${pips} pips @ $${tp3}\nLive: $${livePrice.toFixed(2)}\nAll targets reached! 🎯`, msgId)
      addToDaily({ tf, dir, result:'TP3', pips, sign:+1 })
      state[tf]=null; changed=true
      console.log(`[${ts}] [${tf}] 🏆 TP3 +${pips} pips`)
    }
  }
  if (changed) saveState(state)
}

// ── Signal cycle ──────────────────────────────────────────────────────────────
async function runSignalCycle(tf, isStartup = false) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] 🕯️  Candle closed: ${tf} — running signal check${isStartup ? ' (startup)' : ''}`)

  await checkStopOnClose(tf)

  const heldBefore = openTrade(loadState(), tf)

  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)

  const env = { ...process.env, LIVE_TFS: tf, TWELVEDATA_KEY, TG_TOKEN: '', GOLD_SOURCE: SOURCE, TG_CHAT }
  const { stdout, stderr } = await exec('node', ['gold-ai.mjs', 'check'], { env, timeout: 60000 })

  if (stdout) console.log(`[${tf}]`, stdout.trim())
  if (stderr) console.error(`[${tf} err]`, stderr.trim())
  if (stderr && (stderr.includes('429') || stderr.includes('fetch failed'))) throw new Error(stderr.trim().slice(0, 120))

  const lines = stdout.split('\n')
  const log     = (() => { try { return JSON.parse(fs.readFileSync(TRADE_LOG, 'utf8')) } catch { return [] } })()
  const entries = log.filter(e => e.tframe === tf && !e.event)
  const latest  = entries[entries.length - 1]

  const alreadyAlerted = lines.some(l => l.includes('already alerted'))
  const isWait         = lines.some(l => l.includes('WAIT') || l.includes('SKIP'))
  const hasSignal      = lines.some(l => l.includes('✅'))
  const freshnessMs    = isStartup ? 2 * 60 * 60000 : 5 * 60000
  const fresh          = latest && (Date.now() - new Date(latest.ts).getTime() < freshnessMs)
  const shouldSend     = fresh && !isWait && (hasSignal || (isStartup && latest)) && (!alreadyAlerted || isStartup)

  console.log(`[${tf}] markers: signal=${hasSignal} already=${alreadyAlerted} wait=${isWait} fresh=${fresh} startup=${isStartup} held=${heldBefore?.direction||'none'} → send=${shouldSend}`)

  if (shouldSend) {
    const sig = latest
    const isHold = heldBefore && heldBefore.direction === sig.direction

    if (isHold) {
      const held = heldBefore
      const tp1L = `${held.tp1Hit?'✅ ':''}TP1 $${held.tp1}`
      const tp2L = `${held.tp2Hit?'✅ ':''}TP2 $${held.tp2}`
      const tp3L = `${held.tp3Hit?'✅ ':''}TP3 $${held.tp3}`
      await sendAll(`${dirIcon(held.direction)} <b>GOLD ${tf.toUpperCase()} — KEEP HOLDING ${held.direction}</b>\nConfluence still active — original trade stays open.\nEntry $${held.entry} · SL $${held.sl}\n${tp1L} · ${tp2L} · ${tp3L}`, held.msgId)
      const s = loadState(); s[tf] = held; saveState(s)
      console.log(`[${tf}] 📡 Sent KEEP HOLDING (reply to msgId=${held.msgId})`)
    } else {
      const msgText =
`${dirIcon(sig.direction)} <b>GOLD ${tf.toUpperCase()} — ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
Net ${sig.net} · H1 ${sig.h1Trend} · ${sig.session}
Entry $${sig.entry} · live $${sig.live}
SL $${sig.sl}
TP1 $${sig.tp1} (+${toPips(sig.tp1 - sig.entry)} pips)
TP2 $${sig.tp2} (+${toPips(sig.tp2 - sig.entry)} pips)
TP3 $${sig.tp3} (+${toPips(sig.tp3 - sig.entry)} pips)
Size: ${sig.posSize}
🛡️ SL triggers on candle CLOSE beyond $${sig.sl} — a wick touch keeps the trade valid.
⚠️ Manage risk. Not financial advice.`
      const newMsgId = await sendAll(msgText)
      const stateNow = loadState()
      stateNow[tf] = { direction:sig.direction, entry:sig.entry, sl:sig.sl, tp1:sig.tp1, tp2:sig.tp2, tp3:sig.tp3, tp1Hit:false, tp2Hit:false, tp3Hit:false, msgId:newMsgId, ts:sig.ts }
      saveState(stateNow)
      console.log(`[${tf}] 📡 Sent NEW signal msgId=${newMsgId}`)
    }
  } else if (!hasSignal && !fresh) {
    console.log(`[${tf}] No signal this candle`)
  }

  const hasInvalid = lines.some(l => l.includes('invalidation') || l.includes('SIGNAL INVALIDATED'))
  if (hasInvalid) {
    const state = loadState(), sig = openTrade(state, tf)
    const livePrice = await fetchLivePrice()
    if (sig && sig.entry && livePrice) {
      const dir = sig.direction
      const pipDiff = dir==='BUY' ? (livePrice-sig.entry)*10 : (sig.entry-livePrice)*10
      const profitable = pipDiff > 0, pipAbs = Math.round(Math.abs(pipDiff))
      const profitStr = profitable ? `+${pipAbs} pips in profit` : `-${pipAbs} pips at a loss`
      await sendAll(`⚠️ <b>GOLD ${tf.toUpperCase()} — SIGNAL INVALIDATED</b>\nConfluence has disappeared. Consider closing manually.\n\nCurrent P&L: <b>${profitStr}</b>\nLive $${livePrice.toFixed(2)} vs entry $${sig.entry}`, sig.msgId)
      addToDaily({ tf, dir, result:'INVALIDATED', pips:pipAbs, sign:profitable?+1:-1 })
      state[tf]=null; saveState(state)
      console.log(`[${tf}] ⚠️ Invalidation sent (${profitStr})`)
    }
  }
}

// ── Daily summary ─────────────────────────────────────────────────────────────
function scheduleDailySummary() {
  function msUntilMidnight() {
    const now = new Date()
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()+1)) - now
  }
  async function sendDailySummary() {
    const key = todayKey(), daily = loadDaily(), day = daily[key]
    if (day?.trades?.length > 0) {
      const trades = day.trades, totalPips = Math.round(day.totalPips)
      const wins = trades.filter(t=>t.sign>0), losses = trades.filter(t=>t.sign<0)
      const lines = trades.map(t => `${t.sign>0?'✅':t.sign<0?'❌':'➖'} ${t.tf.toUpperCase()} ${t.dir} → ${t.result}: ${t.sign>0?'+':t.sign<0?'-':''}${t.pips} pips`)
      const summaryLine = totalPips>=0 ? `+${totalPips} pips profit` : `${totalPips} pips loss`
      await sendAll(`${totalPips>=0?'📈':'📉'} <b>GOLD AI — Daily Summary (${key})</b>\n\n${lines.join('\n')}\n\n──────────────\nTrades: ${trades.length} | Wins: ${wins.length} | Losses: ${losses.length}\n<b>Total: ${summaryLine}</b>`)
      console.log(`[daily] Summary sent: ${summaryLine}`)
    }
    setTimeout(sendDailySummary, msUntilMidnight() + 1000)
  }
  setTimeout(sendDailySummary, msUntilMidnight() + 1000)
  console.log(`   📅 Daily summary: in ${Math.round(msUntilMidnight()/60000)} min`)
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log('🚀 Gold AI Launcher v7 — candle-sync (SL on close · KEEP HOLDING fixed)')
console.log(`   📈 Timeframes:    ${LIVE_TFS.join(', ')}`)
console.log(`   ⚡ Price watcher: every ${PRICE_CHECK_MS / 1000}s (TP only)`)
console.log(`   🛡️  SL:           confirmed on candle close`)
console.log(`   🔌 Data source:   ${SOURCE}`)
console.log(`   🔑 API keys:      ${TWELVEDATA_KEYS.length} keys loaded`)
console.log(`   ⏱️  Candle delay:  ${CANDLE_DELAY_MS}ms after close`)

scheduleDailySummary()

;(()=>{
  const state = loadState(); let changed = false
  for (const key of Object.keys(state)) {
    if (key === 'at') continue
    if (typeof state[key] === 'string' || (state[key] && typeof state[key] !== 'object')) {
      console.log(`[startup] Clearing old state for ${key}: ${state[key]}`)
      state[key] = null; changed = true
    }
  }
  if (changed) saveState(state)
  console.log('[startup] State OK:', JSON.stringify(state))
})()

;(async () => {
  for (const tf of LIVE_TFS) {
    console.log(`[startup] Running initial check for ${tf}…`)
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try { await runSignalCycle(tf, true); break }
      catch (e) {
        const is429 = e.message?.includes('429') || e.message?.includes('fetch failed')
        if (is429 && attempt < MAX_RETRIES) {
          switchToNextKey()
          console.log(`[startup] ${tf} 429 on attempt ${attempt} — waiting 65s…`)
          await new Promise(r => setTimeout(r, 65000))
        } else { console.error(`[startup] ${tf} gave up: ${e.message}`); break }
      }
    }
    if (LIVE_TFS.indexOf(tf) < LIVE_TFS.length - 1) await new Promise(r => setTimeout(r, 5000))
  }
  for (const tf of LIVE_TFS) scheduleCandle(tf, runSignalCycle)
})()

fastPriceCheck()
setInterval(fastPriceCheck, PRICE_CHECK_MS)
