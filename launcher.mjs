// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  v5
//  Candle-close sync: fires signal check exactly when each TF candle closes,
//  not on a fixed timer. Works for any mix of timeframes (15m, 1h, 4h…).
//  Price watcher still runs every 30s for instant TP/SL alerts.
// ─────────────────────────────────────────────────────────────────────────────
import { broadcastSignal } from './bot-subscription.mjs'
import fs from 'fs'

const PRICE_CHECK_MS  = (parseInt(process.env.PRICE_CHECK_SEC) || 30) * 1000
const CANDLE_DELAY_MS = 2000   // wait 2s after close for API to finalize bar
const RETRY_DELAY_MS  = 60000  // retry after 60s on 429 / fetch failure
const MAX_RETRIES     = 3      // max retries per candle before giving up
// Stagger: offset each TF so they never fire at the same second → avoids 429
const TF_STAGGER_MS   = { '15m':0, '1h':30000, '4h':45000, '1d':60000 }

const TG_TOKEN       = process.env.TG_TOKEN        || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
// Primary and fallback TwelveData API keys
// Fallback activates automatically when primary hits rate limit (429)
const TWELVEDATA_KEYS = [
  process.env.TWELVEDATA_KEY  || 'dbf374976088424aa703db6034942e19',  // key 1
  'da16adf775b04e31a6a33386689e38c8',                                   // key 2
  '34034261d78440e28ece3d43ddd64955',                                   // key 3
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
const LIVE_TFS       = (process.env.LIVE_TFS || '15m,1h').split(',').map(s => s.trim()).filter(Boolean)
const SOURCE         = process.env.GOLD_SOURCE || (process.env.OANDA_TOKEN ? 'oanda' : 'twelvedata')
const TG_CHAT        = process.env.TG_CHAT || '1408577116'
const STATE_FILE     = './bot_state.json'
const TRADE_LOG      = './trade_log.json'
const DAILY_FILE     = './daily_report.json'

// TF minutes map
const TF_MINUTES = { '1m':1, '3m':3, '5m':5, '15m':15, '30m':30, '1h':60, '2h':120, '4h':240, '1d':1440 }

const dirIcon  = dir => dir === 'BUY' ? '🟢' : '🔴'
const toPips   = d => Math.round(Math.abs(d) * 10)

// ── Candle close scheduler ────────────────────────────────────────────────────
// For a given TF, calculates exactly how many ms until the NEXT candle closes.
// Example: for 15m, candles close at :00, :15, :30, :45 of every hour.
// We schedule a one-shot setTimeout for each close, then reschedule the next.

function msUntilNextClose(tfMinutes) {
  const now = Date.now()
  const periodMs = tfMinutes * 60 * 1000
  const nextClose = Math.ceil(now / periodMs) * periodMs
  return nextClose - now
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

    // Retry loop — on 429 or fetch error, wait 60s and try again (up to MAX_RETRIES)
    let success = false
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await callback(tf)
        success = true
        break
      } catch (e) {
        const is429 = e.message?.includes('429') || e.message?.includes('rate')
        const isNet = e.message?.includes('fetch') || e.message?.includes('ECONNRESET')
        if ((is429 || isNet) && attempt < MAX_RETRIES) {
          if (is429) {
            console.log(`[scheduler] ${tf} rate limited — switching API key and retrying in ${RETRY_DELAY_MS/1000}s`)
            switchToNextKey()
          } else {
            console.log(`[scheduler] ${tf} attempt ${attempt} failed (${e.message}) — retrying in ${RETRY_DELAY_MS/1000}s`)
          }
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS))
        } else {
          console.error(`[scheduler] ${tf} gave up after ${attempt} attempt(s): ${e.message}`)
          break
        }
      }
    }

    // Schedule next candle regardless of success
    scheduleCandle(tf, callback)
  }, wait)
}

// ── State helpers ─────────────────────────────────────────────────────────────
function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) } catch { return {} }
}
function saveState(s) {
  s.at = new Date().toISOString()
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2))
}

// ── Daily report helpers ──────────────────────────────────────────────────────
function todayKey() { return new Date().toISOString().slice(0, 10) }
function loadDaily() {
  try { return JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8')) } catch { return {} }
}
function saveDaily(d) { fs.writeFileSync(DAILY_FILE, JSON.stringify(d, null, 2)) }
function addToDaily(trade) {
  const key = todayKey()
  const daily = loadDaily()
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
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    })
    const j = await res.json()
    if (j.ok) adminMsgId = j.result.message_id
  } catch (e) { console.error('[sendAll admin]', e.message) }

  const result = await broadcastSignal(text, replyToMsgId)
  console.log(`[sendAll] adminMsgId=${adminMsgId} subs sent=${result.sent} failed=${result.failed}`)
  return adminMsgId
}

// ── Live price (lightweight, no candles) ─────────────────────────────────────
async function fetchLivePrice() {
  for (let attempt = 0; attempt < TWELVEDATA_KEYS.length; attempt++) {
    try {
      const res = await fetch(
        `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TWELVEDATA_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      )
      if (res.status === 429) { switchToNextKey(); continue }
      const j = await res.json()
      if (j.price) return parseFloat(j.price)
      if (j.code === 429) { switchToNextKey(); continue }
    } catch {}
    try {
      const res = await fetch(
        `https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${TWELVEDATA_KEY}`,
        { signal: AbortSignal.timeout(8000) }
      )
      if (res.status === 429) { switchToNextKey(); continue }
      const j = await res.json()
      if (j.close) return parseFloat(j.close)
    } catch {}
  }
  return null
}

// ── FAST PRICE WATCHER — every 30s, instant TP/SL ───────────────────────────
async function fastPriceCheck() {
  const livePrice = await fetchLivePrice()
  if (!livePrice) return

  const state = loadState()
  let changed = false
  const ts = new Date().toISOString()

  for (const tf of LIVE_TFS) {
    const sig = state[tf]
    if (!sig || !sig.direction || !sig.entry) continue

    const { direction: dir, entry, sl, tp1, tp2, tp3,
            tp1Hit = false, tp2Hit = false, tp3Hit = false,
            msgId = null } = sig

    // ── SL ────────────────────────────────────────────────────────────────────
    const slHit = dir === 'BUY' ? livePrice <= sl : livePrice >= sl
    if (slHit) {
      const pips = toPips(Math.abs(sl - entry))
      const msg =
`${dirIcon(dir)} <b>GOLD ${tf.toUpperCase()} — STOP LOSS HIT</b>
-${pips} pips @ $${sl}
Live: $${livePrice.toFixed(2)}
Trade closed. ✅`
      await sendAll(msg, msgId)
      addToDaily({ tf, dir, result: 'SL', pips, sign: -1 })
      state[tf] = null; changed = true
      console.log(`[${ts}] [${tf}] 🔴 SL hit -${pips} pips`)
      continue
    }

    // ── TP1 ───────────────────────────────────────────────────────────────────
    const tp1Cross = dir === 'BUY' ? livePrice >= tp1 : livePrice <= tp1
    if (tp1Cross && !tp1Hit) {
      const pips = toPips(Math.abs(tp1 - entry))
      const msg =
`${dirIcon(dir)} <b>GOLD ${tf.toUpperCase()} — TP1 HIT ✅</b>
+${pips} pips @ $${tp1}
Live: $${livePrice.toFixed(2)}
→ Ride to TP2 $${tp2} · SL moved to BE $${entry}`
      const newMsgId = await sendAll(msg, msgId)
      addToDaily({ tf, dir, result: 'TP1', pips, sign: +1 })
      state[tf] = { ...sig, tp1Hit: true, sl: entry, msgId: newMsgId || msgId }
      changed = true; sig.tp1Hit = true; sig.sl = entry
      console.log(`[${ts}] [${tf}] ✅ TP1 hit +${pips} pips`)
    }

    // ── TP2 ───────────────────────────────────────────────────────────────────
    const tp2Cross = dir === 'BUY' ? livePrice >= tp2 : livePrice <= tp2
    if (tp2Cross && sig.tp1Hit && !tp2Hit) {
      const pips = toPips(Math.abs(tp2 - entry))
      const msg =
`${dirIcon(dir)} <b>GOLD ${tf.toUpperCase()} — TP2 HIT ✅</b>
+${pips} pips @ $${tp2}
Live: $${livePrice.toFixed(2)}
→ Ride remainder to TP3 $${tp3}`
      const newMsgId = await sendAll(msg, msgId)
      addToDaily({ tf, dir, result: 'TP2', pips, sign: +1 })
      state[tf] = { ...state[tf], tp2Hit: true, msgId: newMsgId || msgId }
      changed = true; sig.tp2Hit = true
      console.log(`[${ts}] [${tf}] ✅ TP2 hit +${pips} pips`)
    }

    // ── TP3 ───────────────────────────────────────────────────────────────────
    const tp3Cross = dir === 'BUY' ? livePrice >= tp3 : livePrice <= tp3
    if (tp3Cross && sig.tp2Hit && !tp3Hit) {
      const pips = toPips(Math.abs(tp3 - entry))
      const msg =
`${dirIcon(dir)} <b>GOLD ${tf.toUpperCase()} — TP3 HIT 🏆 FULL TARGET</b>
+${pips} pips @ $${tp3}
Live: $${livePrice.toFixed(2)}
All targets reached! 🎯`
      await sendAll(msg, msgId)
      addToDaily({ tf, dir, result: 'TP3', pips, sign: +1 })
      state[tf] = null; changed = true
      console.log(`[${ts}] [${tf}] 🏆 TP3 hit +${pips} pips`)
    }
  }

  if (changed) saveState(state)
}

// ── SIGNAL CYCLE — runs on candle close ──────────────────────────────────────
async function runSignalCycle(tf, isStartup = false) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] 🕯️  Candle closed: ${tf} — running signal check${isStartup ? ' (startup)' : ''}`)

  const { execFile } = await import('child_process')
  const { promisify } = await import('util')
  const exec = promisify(execFile)

  const env = {
    ...process.env,
    LIVE_TFS: tf,
    TWELVEDATA_KEY,   // always uses currently active key (may have switched after 429)
    TG_TOKEN: '',        // blank — launcher sends, not gold-ai.mjs
    GOLD_SOURCE: SOURCE,
    TG_CHAT,
  }

  const { stdout, stderr } = await exec('node', ['gold-ai.mjs', 'check'], {
    env, timeout: 60000,
  })

  if (stdout) console.log(`[${tf}]`, stdout.trim())
  if (stderr) console.error(`[${tf} err]`, stderr.trim())

  // Throw on rate limit or fetch failure so retry loop in scheduleCandle kicks in
  if (stderr && (stderr.includes('429') || stderr.includes('fetch failed'))) {
    throw new Error(stderr.trim().slice(0, 120))
  }

  const lines = stdout.split('\n')

  // ── Detect signal from trade_log — no keyword matching needed ────────────────
  // gold-ai.mjs (v3.1) always writes to trade_log.json BEFORE printing stdout.
  // Strategy: compare the latest entry timestamp to what we had BEFORE the run.
  // If it's newer → new signal fired. No fragile string matching.

  const log     = (() => { try { return JSON.parse(fs.readFileSync(TRADE_LOG, 'utf8')) } catch { return [] } })()
  const entries = log.filter(e => e.tframe === tf && !e.event)
  const latest  = entries[entries.length - 1]

  // Also check if stdout has a "already alerted" or "WAIT" to detect hold vs new
  const alreadyAlerted = lines.some(l => l.includes('already alerted'))
  const isWait         = lines.some(l => l.includes('WAIT') || l.includes('SKIP'))
  const hasSignal      = lines.some(l => l.includes('✅'))

  // On startup: extend freshness to 2h and ignore alreadyAlerted
  // (signal may have fired before launcher started)
  const freshnessMs = isStartup ? 2 * 60 * 60000 : 5 * 60000
  const fresh       = latest && (Date.now() - new Date(latest.ts).getTime() < freshnessMs)
  // isWait ALWAYS blocks — never send a WAIT signal regardless of startup
  // isStartup only overrides the alreadyAlerted dedupe check
  const shouldSend = fresh && !isWait && (hasSignal || (isStartup && latest)) && (!alreadyAlerted || isStartup)

  console.log(`[${tf}] markers: signal=${hasSignal} already=${alreadyAlerted} wait=${isWait} fresh=${fresh} startup=${isStartup} → send=${shouldSend}`)

  if (shouldSend) {
    const sig = latest

    // Is this a keep-holding (same direction already in state)?
    const state   = loadState()
    const current = state[tf]
    const isHold  = current && current.direction === sig.direction && current.msgId

    if (isHold) {
      const msgText =
`${dirIcon(sig.direction)} <b>GOLD ${tf.toUpperCase()} — KEEP HOLDING ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
Confluence still active · live $${sig.live}
SL $${sig.sl} · TP1 $${sig.tp1} · TP2 $${sig.tp2} · TP3 $${sig.tp3}`
      await sendAll(msgText, current.msgId)
      console.log(`[${tf}] 📡 Sent KEEP HOLDING`)

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
⚠️ Manage risk. Not financial advice.`
      const newMsgId = await sendAll(msgText)
      // Save msgId into state so TP/SL alerts can reply to this message
      const stateNow = loadState()
      if (stateNow[tf] && typeof stateNow[tf] === 'object') {
        stateNow[tf].msgId = newMsgId
        saveState(stateNow)
      }
      console.log(`[${tf}] 📡 Sent NEW signal msgId=${newMsgId}`)
    }
  } else if (!hasSignal && !fresh) {
    console.log(`[${tf}] No signal this candle`)
  }

  // ── Invalidation ─────────────────────────────────────────────────────────────
  const hasInvalid = lines.some(l => l.includes('invalidation') || l.includes('SIGNAL INVALIDATED'))
  if (hasInvalid) {
    const state = loadState()
    const sig   = state[tf]
    const livePrice = await fetchLivePrice()
    if (sig && sig.entry && livePrice) {
      const dir       = sig.direction
      const pipDiff   = dir === 'BUY' ? (livePrice - sig.entry) * 10 : (sig.entry - livePrice) * 10
      const profitable = pipDiff > 0
      const pipAbs    = Math.round(Math.abs(pipDiff))
      const profitStr = profitable ? `+${pipAbs} pips in profit` : `-${pipAbs} pips at a loss`
      const msg =
`⚠️ <b>GOLD ${tf.toUpperCase()} — SIGNAL INVALIDATED</b>
Confluence has disappeared. Consider closing manually.

Current P&L: <b>${profitStr}</b>
Live $${livePrice.toFixed(2)} vs entry $${sig.entry}`
      await sendAll(msg, sig.msgId)
      addToDaily({ tf, dir, result: 'INVALIDATED', pips: pipAbs, sign: profitable ? +1 : -1 })
      state[tf] = null; saveState(state)
      console.log(`[${tf}] ⚠️ Invalidation sent (${profitStr})`)
    }
  }
}

// ── DAILY SUMMARY — sent at UTC midnight ─────────────────────────────────────
function scheduleDailySummary() {
  function msUntilMidnight() {
    const now = new Date()
    const midnight = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
    return midnight - now
  }

  async function sendDailySummary() {
    const key = todayKey()
    const daily = loadDaily()
    const day = daily[key]

    if (day && day.trades && day.trades.length > 0) {
      const trades = day.trades
      const totalPips = Math.round(day.totalPips)
      const wins = trades.filter(t => t.sign > 0)
      const losses = trades.filter(t => t.sign < 0)
      const lines = trades.map(t => {
        const icon = t.sign > 0 ? '✅' : '❌'
        const sign = t.sign > 0 ? '+' : '-'
        return `${icon} ${t.tf.toUpperCase()} ${t.dir} → ${t.result}: ${sign}${t.pips} pips`
      })
      const summaryIcon = totalPips >= 0 ? '📈' : '📉'
      const summaryLine = totalPips >= 0 ? `+${totalPips} pips profit` : `${totalPips} pips loss`
      const msg =
`${summaryIcon} <b>GOLD AI — Daily Summary (${key})</b>

${lines.join('\n')}

──────────────
Trades: ${trades.length} | Wins: ${wins.length} | Losses: ${losses.length}
<b>Total: ${summaryLine}</b>`
      await sendAll(msg)
      console.log(`[daily] Summary sent: ${summaryLine}`)
    }

    setTimeout(sendDailySummary, msUntilMidnight() + 1000)
  }

  setTimeout(sendDailySummary, msUntilMidnight() + 1000)
  console.log(`   📅 Daily summary: in ${Math.round(msUntilMidnight()/60000)} min`)
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log('🚀 Gold AI Launcher v5 — candle-sync mode')
console.log(`   📈 Timeframes:    ${LIVE_TFS.join(', ')}`)
console.log(`   ⚡ Price watcher: every ${PRICE_CHECK_MS / 1000}s`)
console.log(`   🔌 Data source:   ${SOURCE}`)
console.log(`   ⏱️  Candle delay:  ${CANDLE_DELAY_MS}ms after close`)

scheduleDailySummary()

// ── Migrate old bot_state.json (v3.1 stored strings, v4+ needs objects) ──────
;(()=>{
  const state = loadState()
  let changed = false
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
    // Retry on 429 at startup — both keys may need a moment to reset
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        await runSignalCycle(tf, true)  // isStartup=true
        break
      } catch (e) {
        const is429 = e.message?.includes('429') || e.message?.includes('fetch failed')
        if (is429 && attempt < MAX_RETRIES) {
          switchToNextKey()
          console.log(`[startup] ${tf} 429 on attempt ${attempt} — waiting 65s then retrying…`)
          await new Promise(r => setTimeout(r, 65000))
        } else {
          console.error(`[startup] ${tf} gave up: ${e.message}`)
          break
        }
      }
    }
    // Small gap between TFs to avoid simultaneous API calls
    if (LIVE_TFS.indexOf(tf) < LIVE_TFS.length - 1) {
      await new Promise(r => setTimeout(r, 5000))
    }
  }
  // Now schedule all TFs on candle-close timing
  for (const tf of LIVE_TFS) {
    scheduleCandle(tf, runSignalCycle)
  }
})()

// Price watcher: instant TP/SL
fastPriceCheck()
setInterval(fastPriceCheck, PRICE_CHECK_MS)
