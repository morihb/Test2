// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  runs subscription bot + signal checker in one process
//  v2 FIX: ALL signal messages (new, keep holding, TP hits, SL, invalidation)
//  are now broadcast to ALL active subscribers — not just your admin chat.
//  Run: node launcher.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { broadcastSignal } from './bot-subscription.mjs'
import fs from 'fs'

// ── Signal checker interval (minutes) ────────────────────────────────────────
const CHECK_EVERY_MS = (parseInt(process.env.CHECK_MIN) || 15) * 60 * 1000

// ── Credentials ───────────────────────────────────────────────────────────────
const TG_TOKEN       = process.env.TG_TOKEN        || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY  || 'dbf374976088424aa703db6034942e19'
const LIVE_TFS       = (process.env.LIVE_TFS || '15m,1h').split(',').map(s => s.trim()).filter(Boolean)
const SOURCE         = process.env.GOLD_SOURCE || (process.env.OANDA_TOKEN ? 'oanda' : 'twelvedata')
const TG_CHAT        = process.env.TG_CHAT || '1408577116'
const TRADE_LOG      = './trade_log.json'

// ── Helper: send to YOUR admin chat only (for debug/errors) ──────────────────
async function sendAdmin(text) {
  if (!TG_TOKEN || !TG_CHAT) return
  await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text, parse_mode: 'HTML' })
  }).catch(() => {})
}

// ── Signal cycle ──────────────────────────────────────────────────────────────
// Strategy: run gold-ai.mjs as a child process (so it handles state/dedupe),
// but intercept STDOUT to detect what kind of message was sent and re-broadcast
// that same message to all subscribers via broadcastSignal().
//
// gold-ai.mjs already sends to TG_CHAT via sendTelegram().
// We parse stdout to know what happened, then broadcast the same text ourselves.
// This avoids duplicating logic and keeps gold-ai.mjs as the source of truth.

async function runSignalCycle() {
  const ts = new Date().toISOString()
  console.log(`[${ts}] 🔍 Running signal check for: ${LIVE_TFS.join(', ')}`)

  for (const tf of LIVE_TFS) {
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const exec = promisify(execFile)

      const env = {
        ...process.env,
        LIVE_TFS: tf,
        TWELVEDATA_KEY,
        TG_TOKEN,
        GOLD_SOURCE: SOURCE,
        TG_CHAT,
      }

      const { stdout, stderr } = await exec('node', ['gold-ai.mjs', 'check'], {
        env,
        timeout: 60000,
      })

      if (stdout) console.log(`[${tf}]`, stdout.trim())
      if (stderr) console.error(`[${tf} err]`, stderr.trim())

      // ── Detect what gold-ai.mjs just sent ────────────────────────────────
      // gold-ai.mjs logs these markers to stdout:
      //   "✅ {tf} NEW …"         → new signal
      //   "✅ {tf} KEEP HOLDING …" → keep holding
      //   TP/SL hits are tracked internally; we detect via trade_log.json

      const lines = stdout.split('\n')
      for (const line of lines) {

        // ── NEW signal or KEEP HOLDING ────────────────────────────────────
        if (line.includes(`✅`) && (line.includes('NEW') || line.includes('KEEP HOLDING'))) {
          // Read the latest trade_log entry for this TF (written by gold-ai.mjs)
          const log = (() => { try { return JSON.parse(fs.readFileSync(TRADE_LOG, 'utf8')) } catch { return [] } })()
          const latest = log.filter(e => e.tframe === tf).pop()

          if (!latest) continue
          const age = Date.now() - new Date(latest.ts).getTime()
          if (age > 5 * 60000) continue  // stale — skip

          const isKeepHolding = line.includes('KEEP HOLDING')
          const sig = latest

          let msgText
          if (isKeepHolding) {
            msgText =
`🔄 <b>GOLD ${tf.toUpperCase()} — KEEP HOLDING ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
Confluence still active · live $${sig.live}
SL $${sig.sl} · TP1 $${sig.tp1} · TP2 $${sig.tp2} · TP3 $${sig.tp3}`
          } else {
            const toPips = d => Math.round(Math.abs(d) * 10)
            msgText =
`🟡 <b>GOLD ${tf.toUpperCase()} — ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
Net ${sig.net} · H1 ${sig.h1Trend} · ${sig.session}
Entry $${sig.entry} · live $${sig.live}
SL $${sig.sl}
TP1 $${sig.tp1} (+${toPips(sig.tp1 - sig.entry)} pips)
TP2 $${sig.tp2} (+${toPips(sig.tp2 - sig.entry)} pips)
TP3 $${sig.tp3} (+${toPips(sig.tp3 - sig.entry)} pips)
Size: ${sig.posSize}
⚠️ Manage risk. Not financial advice.`
          }

          const result = await broadcastSignal(msgText)
          console.log(`[${tf}] 📡 Broadcast ${isKeepHolding ? 'KEEP HOLDING' : 'NEW'}: sent=${result.sent} failed=${result.failed}`)
        }

        // ── TP1 HIT ───────────────────────────────────────────────────────
        if (line.includes('TP1 HIT') || line.includes('tp1Hit')) {
          // gold-ai.mjs already sent this to your chat — now broadcast to subs
          // We reconstruct from bot_state.json
          const state = (() => { try { return JSON.parse(fs.readFileSync('./bot_state.json', 'utf8'))[tf] } catch { return null } })()
          if (state) {
            const toPips = d => Math.round(Math.abs(d) * 10)
            const pips = toPips(state.tp1 - state.entry) * (state.direction === 'BUY' ? 1 : -1)
            const msgText =
`✅ <b>GOLD ${tf.toUpperCase()} — TP1 HIT</b>
+${Math.abs(pips)} pips @ $${state.tp1}
Remaining: ride to TP2 $${state.tp2} · SL moved to breakeven`
            const result = await broadcastSignal(msgText)
            console.log(`[${tf}] 📡 Broadcast TP1: sent=${result.sent} failed=${result.failed}`)
          }
        }

        // ── TP2 HIT ───────────────────────────────────────────────────────
        if (line.includes('TP2 HIT')) {
          const state = (() => { try { return JSON.parse(fs.readFileSync('./bot_state.json', 'utf8'))[tf] } catch { return null } })()
          if (state) {
            const toPips = d => Math.round(Math.abs(d) * 10)
            const pips = toPips(state.tp2 - state.entry) * (state.direction === 'BUY' ? 1 : -1)
            const msgText =
`✅ <b>GOLD ${tf.toUpperCase()} — TP2 HIT</b>
+${Math.abs(pips)} pips @ $${state.tp2}
Remainder riding to TP3 $${state.tp3}`
            const result = await broadcastSignal(msgText)
            console.log(`[${tf}] 📡 Broadcast TP2: sent=${result.sent} failed=${result.failed}`)
          }
        }

        // ── TP3 HIT ───────────────────────────────────────────────────────
        if (line.includes('TP3 HIT') || line.includes('FULL TARGET')) {
          const state = (() => { try { return JSON.parse(fs.readFileSync('./bot_state.json', 'utf8'))[tf] } catch { return null } })()
          if (state) {
            const toPips = d => Math.round(Math.abs(d) * 10)
            const pips = toPips(state.tp3 - state.entry) * (state.direction === 'BUY' ? 1 : -1)
            const msgText =
`🏆 <b>GOLD ${tf.toUpperCase()} — TP3 HIT — FULL TARGET</b>
+${Math.abs(pips)} pips @ $${state.tp3}
Trade complete. Well done! 🎯`
            const result = await broadcastSignal(msgText)
            console.log(`[${tf}] 📡 Broadcast TP3: sent=${result.sent} failed=${result.failed}`)
          }
        }

        // ── STOP LOSS HIT ─────────────────────────────────────────────────
        if (line.includes('STOP LOSS HIT') || line.includes('SL HIT') || line.includes("event:'SL'")) {
          const state = (() => { try { return JSON.parse(fs.readFileSync('./bot_state.json', 'utf8'))[tf] } catch { return null } })()
          if (state) {
            const toPips = d => Math.round(Math.abs(d) * 10)
            const pips = toPips(state.sl - state.entry) * (state.direction === 'BUY' ? -1 : 1)
            const msgText =
`🔴 <b>GOLD ${tf.toUpperCase()} — STOP LOSS HIT</b>
${pips} pips @ $${state.sl}
Signal closed. Risk was managed. ✅`
            const result = await broadcastSignal(msgText)
            console.log(`[${tf}] 📡 Broadcast SL: sent=${result.sent} failed=${result.failed}`)
          }
        }

        // ── SIGNAL INVALIDATED ────────────────────────────────────────────
        if (line.includes('SIGNAL INVALIDATED') || line.includes('invalidation')) {
          const msgText =
`⚠️ <b>GOLD ${tf.toUpperCase()} — SIGNAL INVALIDATED</b>
Confluence disappeared. Consider closing manually if not at breakeven.`
          const result = await broadcastSignal(msgText)
          console.log(`[${tf}] 📡 Broadcast INVALIDATED: sent=${result.sent} failed=${result.failed}`)
        }

        // ── DIRECTION FLIP ────────────────────────────────────────────────
        if (line.includes('DIRECTION FLIP')) {
          const log = (() => { try { return JSON.parse(fs.readFileSync(TRADE_LOG, 'utf8')) } catch { return [] } })()
          const latest = log.filter(e => e.tframe === tf).pop()
          if (latest) {
            const msgText =
`⚠️ <b>GOLD ${tf.toUpperCase()} — DIRECTION FLIP</b>
Signal has reversed to <b>${latest.direction}</b>.
→ Close prior trade before entering new ${latest.direction}.`
            const result = await broadcastSignal(msgText)
            console.log(`[${tf}] 📡 Broadcast FLIP: sent=${result.sent} failed=${result.failed}`)
          }
        }
      }

    } catch (e) {
      console.error(`[${tf}] cycle error: ${e.message}`)
      await sendAdmin(`⚠️ Gold AI cycle error (${tf}): ${e.message}`)
    }
  }
}

// ── BUT WAIT — gold-ai.mjs sends TP/SL hits via Telegram DIRECTLY ────────────
// Those messages go to TG_CHAT silently — stdout only says "already alerted"
// or nothing. So we need a SECOND approach for TP/SL: watch trade_log.json
// for new entries with event fields, and broadcast those too.

const seenLogEvents = new Set()
function watchTradeLog() {
  setInterval(() => {
    try {
      const log = JSON.parse(fs.readFileSync(TRADE_LOG, 'utf8'))
      for (const entry of log) {
        const id = `${entry.ts}-${entry.event || 'signal'}-${entry.tframe}`
        if (seenLogEvents.has(id)) continue
        seenLogEvents.add(id)

        // Only broadcast events that aren't new signals (those are handled above)
        if (!entry.event) continue  // new signals handled in cycle loop

        const tf = entry.tframe || '?'
        let msgText = null

        if (entry.event === 'TP1') {
          msgText = `✅ <b>GOLD ${tf.toUpperCase()} — TP1 HIT</b>\nTarget 1 reached. SL moved to breakeven.`
        } else if (entry.event === 'TP2') {
          msgText = `✅ <b>GOLD ${tf.toUpperCase()} — TP2 HIT</b>\nTarget 2 reached. Riding to TP3.`
        } else if (entry.event === 'TP3') {
          msgText = `🏆 <b>GOLD ${tf.toUpperCase()} — TP3 HIT — FULL TARGET</b>\nAll targets hit. Trade complete! 🎯`
        } else if (entry.event === 'SL') {
          msgText = `🔴 <b>GOLD ${tf.toUpperCase()} — STOP LOSS HIT</b>\nTrade closed at stop. Risk was managed.`
        }

        if (msgText) {
          broadcastSignal(msgText)
            .then(r => console.log(`[tradeLog] 📡 Broadcast ${entry.event} (${tf}): sent=${r.sent} failed=${r.failed}`))
            .catch(e => console.error(`[tradeLog] broadcast error: ${e.message}`))
        }
      }
    } catch { /* file may not exist yet */ }
  }, 10000)  // check every 10 seconds
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('🚀 Launcher started')
console.log(`   Signal check every ${CHECK_EVERY_MS / 60000} min`)
console.log(`   Timeframes: ${LIVE_TFS.join(', ')}`)
console.log(`   Data source: ${SOURCE} (TwelveData key: ${TWELVEDATA_KEY.slice(0,8)}…)`)
console.log(`   Trade log watcher: active (10s poll)`)

watchTradeLog()   // catch TP/SL events from gold-ai.mjs lifecycle
runSignalCycle()
setInterval(runSignalCycle, CHECK_EVERY_MS)
