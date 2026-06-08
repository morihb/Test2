// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  v5
//  Candle-close sync: fires signal check exactly when each TF candle closes,
//  not on a fixed timer. Works for any mix of timeframes (15m, 1h, 4h…).
//  Price watcher still runs every 30s for instant TP/SL alerts.
// ─────────────────────────────────────────────────────────────────────────────
import { broadcastSignal } from './bot-subscription.mjs'
import fs from 'fs'

const PRICE_CHECK_MS = (parseInt(process.env.PRICE_CHECK_SEC) || 30) * 1000
const CANDLE_DELAY_MS = 1500   // wait 1.5s after close for API to update

const TG_TOKEN       = process.env.TG_TOKEN        || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY  || 'dbf374976088424aa703db6034942e19'
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

  const wait = msUntilNextClose(mins)
  const closeAt = new Date(Date.now() + wait).toISOString()
  console.log(`[scheduler] ${tf} next candle close in ${(wait/1000).toFixed(1)}s (at ${closeAt})`)

  setTimeout(async () => {
    // Small delay so the API has the closed candle available
    await new Promise(r => setTimeout(r, CANDLE_DELAY_MS))
    await callback(tf)
    // Schedule the next one
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
  try {
    const res = await fetch(
      `https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${TWELVEDATA_KEY}`,
      { signal: AbortSignal.timeout(8000) }
    )
    const j = await res.json()
    if (j.price) return parseFloat(j.price)
  } catch {}
  try {
    const res = await fetch(
      `https://api.twelvedata.com/quote?symbol=XAU/USD&apikey=${TWELVEDATA_KEY}`,
      { signal: AbortSignal.timeout(8000) }
    )
    const j = await res.json()
    if (j.close) return parseFloat(j.close)
  } catch {}
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
async function runSignalCycle(tf) {
  const ts = new Date().toISOString()
  console.log(`[${ts}] 🕯️  Candle closed: ${tf} — running signal check`)

  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const exec = promisify(execFile)

    const env = {
      ...process.env,
      LIVE_TFS: tf,
      TWELVEDATA_KEY,
      TG_TOKEN: '',        // blank — launcher sends, not gold-ai.mjs
      GOLD_SOURCE: SOURCE,
      TG_CHAT,
    }

    const { stdout, stderr } = await exec('node', ['gold-ai.mjs', 'check'], {
      env, timeout: 60000,
    })

    if (stdout) console.log(`[${tf}]`, stdout.trim())
    if (stderr) console.error(`[${tf} err]`, stderr.trim())

    const lines = stdout.split('\n')
    for (const line of lines) {
      if (!line.includes('✅')) continue
      const isNew  = line.includes('NEW')
      const isHold = line.includes('KEEP HOLDING')
      if (!isNew && !isHold) continue

      const log = (() => { try { return JSON.parse(fs.readFileSync(TRADE_LOG, 'utf8')) } catch { return [] } })()
      const latest = log.filter(e => e.tframe === tf && !e.event).pop()
      if (!latest) continue
      if (Date.now() - new Date(latest.ts).getTime() > 5 * 60000) continue

      const sig = latest
      let msgText

      if (isHold) {
        msgText =
`${dirIcon(sig.direction)} <b>GOLD ${tf.toUpperCase()} — KEEP HOLDING ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
Confluence still active · live $${sig.live}
SL $${sig.sl} · TP1 $${sig.tp1} · TP2 $${sig.tp2} · TP3 $${sig.tp3}`
        const state = loadState()
        const replyId = state[tf]?.msgId || null
        await sendAll(msgText, replyId)
      } else {
        msgText =
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
        // Save msgId so TP/SL replies work
        const state = loadState()
        if (state[tf]) { state[tf].msgId = newMsgId; saveState(state) }
      }

      console.log(`[${tf}] 📡 Sent ${isHold ? 'KEEP HOLDING' : 'NEW'} signal`)
    }

    // ── Invalidation ──────────────────────────────────────────────────────────
    for (const line of lines) {
      if (!line.includes('invalidation') && !line.includes('SIGNAL INVALIDATED')) continue
      const state = loadState()
      const sig = state[tf]
      const livePrice = await fetchLivePrice()
      if (sig && sig.entry && livePrice) {
        const dir = sig.direction
        const pipDiff = dir === 'BUY' ? (livePrice - sig.entry) * 10 : (sig.entry - livePrice) * 10
        const profitable = pipDiff > 0
        const pipAbs = Math.round(Math.abs(pipDiff))
        const profitStr = profitable ? `+${pipAbs} pips in profit` : `-${pipAbs} pips at a loss`
        const msg =
`⚠️ <b>GOLD ${tf.toUpperCase()} — SIGNAL INVALIDATED</b>
Confluence has disappeared. Consider closing manually.

Current P&L: <b>${profitStr}</b>
Live $${livePrice.toFixed(2)} vs entry $${sig.entry}`
        await sendAll(msg, sig.msgId)
        addToDaily({ tf, dir, result: 'INVALIDATED', pips: pipAbs, sign: profitable ? +1 : -1 })
        state[tf] = null; saveState(state)
        console.log(`[${tf}] ⚠️ Invalidation (${profitStr})`)
      }
    }

  } catch (e) {
    console.error(`[${tf}] cycle error: ${e.message}`)
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

// Schedule each TF independently on its own candle close timing
for (const tf of LIVE_TFS) {
  scheduleCandle(tf, runSignalCycle)
}

// Price watcher: instant TP/SL
fastPriceCheck()
setInterval(fastPriceCheck, PRICE_CHECK_MS)
