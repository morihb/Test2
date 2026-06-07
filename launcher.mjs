// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  runs subscription bot + signal checker in one process
//  Run: node launcher.mjs
// ─────────────────────────────────────────────────────────────────────────────
import { broadcastSignal } from './bot-subscription.mjs'
import fs from 'fs'

// ── Signal checker interval (minutes) — must match your live TF ──────────────
const CHECK_EVERY_MS = (parseInt(process.env.CHECK_MIN) || 15) * 60 * 1000

// ── Credentials (env overrides these defaults) ────────────────────────────────
const TG_TOKEN       = process.env.TG_TOKEN        || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const TWELVEDATA_KEY = process.env.TWELVEDATA_KEY  || 'dbf374976088424aa703db6034942e19'
const LIVE_TFS       = (process.env.LIVE_TFS || '15m,1h').split(',').map(s => s.trim()).filter(Boolean)
const SOURCE         = process.env.GOLD_SOURCE || (process.env.OANDA_TOKEN ? 'oanda' : 'twelvedata')
const TG_CHAT        = process.env.TG_CHAT || '1408577116'
const STATE_FILE     = './bot_state.json'
const TRADE_LOG      = './trade_log.json'

// ── Signal cycle: spawn gold-ai.mjs check with correct env ───────────────────
async function runSignalCycle() {
  const ts = new Date().toISOString()
  console.log(`[${ts}] 🔍 Running signal check for: ${LIVE_TFS.join(', ')}`)

  for (const tf of LIVE_TFS) {
    try {
      const { execFile } = await import('child_process')
      const { promisify } = await import('util')
      const exec = promisify(execFile)

      // Pass all credentials into the child process env
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

      // If a signal fired, broadcast to all active subscribers
      if (stdout.includes('✅')) {
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
console.log(`   Data source: ${SOURCE} (TwelveData key: ${TWELVEDATA_KEY.slice(0,8)}…)`)

runSignalCycle()
setInterval(runSignalCycle, CHECK_EVERY_MS)
