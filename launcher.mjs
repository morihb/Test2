// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  runs subscription bot + signal checker in one process
//  Run: node launcher.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { broadcastSignal } from './bot-subscription.mjs'
import fs from 'fs'

// ── Signal checker interval (minutes) — must match your live TF ──────────────
const CHECK_EVERY_MS = (parseInt(process.env.CHECK_MIN) || 15) * 60 * 1000

// ── Import gold-ai logic ─────────────────────────────────────────────────────
// We inline the minimal fetch+analyse+sendSignal loop here so we don't need
// to modify gold-ai.mjs at all. It still works standalone too.

const TG_TOKEN   = process.env.TG_TOKEN || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const LIVE_TFS   = (process.env.LIVE_TFS || '15m,1h').split(',').map(s => s.trim()).filter(Boolean)
const SOURCE     = process.env.GOLD_SOURCE || (process.env.OANDA_TOKEN ? 'oanda' : process.env.TWELVEDATA_KEY ? 'twelvedata' : 'yahoo')
const STATE_FILE = './bot_state.json'
const TRADE_LOG  = './trade_log.json'

// Re-export the sendSignal hook — gold-ai's checkOne() will call this
// instead of (or in addition to) the plain Telegram message
// Patch: we monkey-patch the broadcast into the signal check cycle.
// Each time gold-ai.mjs finds a signal it calls broadcastSignal automatically.

// ── Patch: wrap gold-ai check() to also broadcast ────────────────────────────
// Since gold-ai.mjs is a standalone script, we replicate ONLY the live-check
// call here and wire broadcastSignal in. Strategy/analysis code untouched.

async function runSignalCycle() {
  const ts = new Date().toISOString()
  console.log(`[${ts}] 🔍 Running signal check for: ${LIVE_TFS.join(', ')}`)

  for (const tf of LIVE_TFS) {
    try {
      // Dynamically spawn gold-ai check for this TF and capture output
      // We use a child process so gold-ai.mjs is 100% untouched
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const exec = promisify(execFile)

      // Run gold-ai check — it sends its own Telegram message to TG_CHAT
      // broadcastSignal is called separately below if a signal fired
      const env = { ...process.env, LIVE_TFS: tf }
      const { stdout, stderr } = await exec('node', ['gold-ai.mjs', 'check'], {
        env,
        timeout: 60000,
      })

      if (stdout) console.log(`[${tf}]`, stdout.trim())
      if (stderr) console.error(`[${tf} err]`, stderr.trim())

      // If a signal was fired (gold-ai logs "✅ TF DIRECTION"), broadcast to subscribers
      if (stdout.includes('✅')) {
        // Parse the relevant line and read last logged signal from trade log
        const log = (() => {
          try { return JSON.parse(fs.readFileSync(TRADE_LOG, 'utf8')) } catch { return [] }
        })()
        const latest = log[log.length - 1]
        if (latest && latest.tframe === tf && Date.now() - new Date(latest.ts).getTime() < 5 * 60000) {
          const sig = latest
          const msgText =
`🟡 <b>GOLD ${tf.toUpperCase()} — ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
Net ${sig.net} · H1 ${sig.h1Trend} · ${sig.session}
Entry $${sig.entry} · SL $${sig.sl}
TP1 $${sig.tp1} · TP2 $${sig.tp2} · TP3 $${sig.tp3}
Size: ${sig.posSize}
⚠️ Manage risk. Not financial advice.`
          const result = await broadcastSignal(msgText)
          console.log(`[${tf}] 📡 Broadcast: sent=${result.sent} failed=${result.failed}`)
        }
      }
    } catch (e) {
      console.error(`[${tf}] cycle error: ${e.message}`)
    }
  }
}

// ── Start ─────────────────────────────────────────────────────────────────────
console.log('🚀 Launcher started')
console.log(`   Signal check every ${CHECK_EVERY_MS / 60000} min`)
console.log(`   Timeframes: ${LIVE_TFS.join(', ')}`)

// Run once immediately, then on interval
runSignalCycle()
setInterval(runSignalCycle, CHECK_EVERY_MS)
