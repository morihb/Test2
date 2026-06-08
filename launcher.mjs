// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  v4
//  Fixes & features:
//  • ONE signal message only (admin gets same as subscribers, no duplicate)
//  • TP/SL alerts reply to the original signal message
//  • SL alert shows pips lost
//  • 🟢 BUY / 🔴 SELL color icons
//  • Daily summary at midnight: total pips won/lost, trade breakdown
//  • Invalidation alert shows if trade was profitable or at a loss + adds to daily report
// ─────────────────────────────────────────────────────────────────────────────
import { broadcastSignal } from './bot-subscription.mjs'
import fs from 'fs'

const CHECK_EVERY_MS = (parseInt(process.env.CHECK_MIN) || 15) * 60 * 1000
const PRICE_CHECK_MS = (parseInt(process.env.PRICE_CHECK_SEC) || 30) * 1000

const TG_TOKEN       = process.env.TG_TOKEN        || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY  || 'dbf374976088424aa703db6034942e19'
const LIVE_TFS       = (process.env.LIVE_TFS || '15m,1h').split(',').map(s => s.trim()).filter(Boolean)
const SOURCE         = process.env.GOLD_SOURCE || (process.env.OANDA_TOKEN ? 'oanda' : 'twelvedata')
const TG_CHAT        = process.env.TG_CHAT || '1408577116'
const STATE_FILE     = './bot_state.json'
const TRADE_LOG      = './trade_log.json'
const DAILY_FILE     = './daily_report.json'

const dirIcon   = dir => dir === 'BUY' ? '🟢' : '🔴'
const toPips    = d => Math.round(Math.abs(d) * 10)
const signedPips = (d, dir, level) =>
  dir === 'BUY' ? toPips(level - d) : toPips(d - level)

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
  // trade = { tf, dir, result: 'TP1'|'TP2'|'TP3'|'SL'|'INVALIDATED', pips, sign: +/- }
  const key = todayKey()
  const daily = loadDaily()
  if (!daily[key]) daily[key] = { trades: [], totalPips: 0 }
  daily[key].trades.push({ ...trade, ts: new Date().toISOString() })
  daily[key].totalPips += trade.sign * trade.pips
  saveDaily(daily)
}

// ── Telegram: send to EVERYONE (admin + all subscribers) ─────────────────────
// Returns the message_id from admin chat (used as reply anchor for subscribers too)
async function sendAll(text, replyToMsgId = null) {
  // 1. Send to admin chat — get message_id back
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

  // 2. Broadcast to all active subscribers
  const result = await broadcastSignal(text, replyToMsgId)
  console.log(`[sendAll] admin msgId=${adminMsgId} · subs sent=${result.sent} failed=${result.failed}`)
  return adminMsgId
}

// ── Live price fetch (lightweight — no candles) ───────────────────────────────
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

// ── FAST PRICE WATCHER — every 30s, instant TP/SL detection ──────────────────
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
      console.log(`[${ts}] [${tf}] 🔴 SL hit`)
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
      changed = true
      sig.tp1Hit = true; sig.sl = entry
      console.log(`[${ts}] [${tf}] ✅ TP1 hit`)
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
      console.log(`[${ts}] [${tf}] ✅ TP2 hit`)
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
      console.log(`[${ts}] [${tf}] 🏆 TP3 hit`)
    }
  }

  if (changed) saveState(state)
}

// ── SIGNAL CYCLE — every 15m ──────────────────────────────────────────────────
async function runSignalCycle() {
  const ts = new Date().toISOString()
  console.log(`[${ts}] 🔍 Signal cycle: ${LIVE_TFS.join(', ')}`)

  for (const tf of LIVE_TFS) {
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const exec = promisify(execFile)

      const env = {
        ...process.env,
        LIVE_TFS: tf,
        TWELVEDATA_KEY,
        TG_TOKEN: '',           // ← BLANK: stop gold-ai.mjs from sending its own message
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

        // Read latest signal from trade_log (written by gold-ai.mjs)
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

          // Reply to original signal message
          const state = loadState()
          const replyId = state[tf]?.msgId || null
          await sendAll(msgText, replyId)

        } else {
          // NEW signal
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

          // Save msgId into state so replies work for TP/SL
          const state = loadState()
          if (state[tf]) {
            state[tf].msgId = newMsgId
            saveState(state)
          }
        }

        console.log(`[${tf}] 📡 Sent ${isHold ? 'KEEP HOLDING' : 'NEW'} signal`)
      }

      // ── Invalidation detection ─────────────────────────────────────────────
      for (const line of lines) {
        if (!line.includes('invalidation') && !line.includes('SIGNAL INVALIDATED')) continue

        const state = loadState()
        const sig = state[tf]
        const livePrice = await fetchLivePrice()

        if (sig && sig.entry && livePrice) {
          const dir = sig.direction
          const pipDiff = dir === 'BUY'
            ? (livePrice - sig.entry) * 10
            : (sig.entry - livePrice) * 10
          const profitable = pipDiff > 0
          const pipAbs = Math.round(Math.abs(pipDiff))
          const profitStr = profitable
            ? `+${pipAbs} pips in profit`
            : `-${pipAbs} pips at a loss`

          const msg =
`⚠️ <b>GOLD ${tf.toUpperCase()} — SIGNAL INVALIDATED</b>
Confluence has disappeared.
→ Consider closing manually.

Current P&L: <b>${profitStr}</b> (live $${livePrice.toFixed(2)} vs entry $${sig.entry})`

          await sendAll(msg, sig.msgId)
          addToDaily({ tf, dir, result: 'INVALIDATED', pips: pipAbs, sign: profitable ? +1 : -1 })
          state[tf] = null
          saveState(state)
          console.log(`[${tf}] ⚠️ Invalidation sent (${profitStr})`)
        }
      }

    } catch (e) {
      console.error(`[${tf}] cycle error: ${e.message}`)
    }
  }
}

// ── DAILY SUMMARY — sent at midnight UTC ─────────────────────────────────────
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

    if (!day || !day.trades || day.trades.length === 0) {
      // Schedule next midnight
      setTimeout(() => { sendDailySummary(); scheduleDailySummary() }, 86400000)
      return
    }

    const trades = day.trades
    const totalPips = Math.round(day.totalPips)
    const wins = trades.filter(t => t.sign > 0)
    const losses = trades.filter(t => t.sign < 0)

    // Build per-trade lines
    const lines = trades.map(t => {
      const icon = t.sign > 0 ? '✅' : '❌'
      const sign = t.sign > 0 ? '+' : '-'
      return `${icon} ${t.tf.toUpperCase()} ${t.dir} → ${t.result}: ${sign}${t.pips} pips`
    })

    const summaryIcon = totalPips >= 0 ? '📈' : '📉'
    const summaryLine = totalPips >= 0
      ? `+${totalPips} pips profit`
      : `${totalPips} pips loss`

    const msg =
`${summaryIcon} <b>GOLD AI — Daily Summary (${key})</b>

${lines.join('\n')}

──────────────────
Trades: ${trades.length} | Wins: ${wins.length} | Losses: ${losses.length}
<b>Total: ${summaryLine}</b>`

    await sendAll(msg)
    console.log(`[daily] Summary sent for ${key}: ${summaryLine}`)

    // Schedule next day
    setTimeout(() => { sendDailySummary(); }, msUntilMidnight() + 1000)
  }

  setTimeout(sendDailySummary, msUntilMidnight() + 1000)
  console.log(`   📅 Daily summary: scheduled at UTC midnight (in ${Math.round(msUntilMidnight()/60000)} min)`)
}

// ── START ─────────────────────────────────────────────────────────────────────
console.log('🚀 Gold AI Launcher v4 started')
console.log(`   📊 Signal cycle:  every ${CHECK_EVERY_MS / 60000} min`)
console.log(`   ⚡ Price watcher: every ${PRICE_CHECK_MS / 1000}s (instant TP/SL)`)
console.log(`   📈 Timeframes:    ${LIVE_TFS.join(', ')}`)
console.log(`   🔌 Data source:   ${SOURCE}`)

scheduleDailySummary()
runSignalCycle()
setInterval(runSignalCycle, CHECK_EVERY_MS)
fastPriceCheck()
setInterval(fastPriceCheck, PRICE_CHECK_MS)
