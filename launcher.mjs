// ─────────────────────────────────────────────────────────────
//  GOLD AI — Master Launcher
//  Runs all services in ONE process:
//    1. Telegram subscription bot  (bot-subscription.mjs)
//    2. WhatsApp subscription bot  (whatsapp-bot.mjs) — Twilio
//    3. ngrok tunnel               (exposes WA webhook publicly)
//    4. Signal checker             (gold-ai.mjs — check mode)
//
//  Run:  node launcher.mjs
// ─────────────────────────────────────────────────────────────
import { spawn }        from 'child_process'
import path             from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── CREDENTIALS (baked in — real env vars always override) ───
const ENV = {
  // Telegram
  TG_TOKEN:         '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg',
  ADMIN_CHAT_ID:    '1408577116',
  CHANNEL_USERNAME: '@MH_Signals',

  // WhatsApp (Twilio)
  TWILIO_SID:       'AC749a3893c6d15036e9fbaf7d6cdd9b56',
  TWILIO_TOKEN:     '431e427643597a2521f2103a68300ee3',
  TWILIO_FROM:      'whatsapp:+14155238886',
  ADMIN_WA:         'whatsapp:+96181826800',
  WA_PORT:          '3000',

  // Signal data
  TWELVEDATA_KEY:   'dbf374976088424aa703db6034942e19',
  LIVE_TFS:         '15m,1h',

  // Payments (replace with your real wallet addresses)
  USDT_ADDRESS:     'TEST_USDT_ADDRESS',
  BTC_ADDRESS:      'TEST_BTC_ADDRESS',
}
for (const [k,v] of Object.entries(ENV)) if (!process.env[k]) process.env[k] = v

const CHECK_EVERY_MS = (parseInt(process.env.CHECK_MIN) || 15) * 60 * 1000
const WA_PORT        = process.env.WA_PORT || '3000'

// ── Colours ───────────────────────────────────────────────────
const C = { reset:'\x1b[0m', yellow:'\x1b[33m', cyan:'\x1b[36m', green:'\x1b[32m', red:'\x1b[31m', magenta:'\x1b[35m' }
const tag = (label, color) => `${color}[${label}]${C.reset}`

// ── Spawn a persistent service (auto-restarts on crash) ───────
function spawnService(label, color, file, args=[]) {
  const t = tag(label, color)
  const child = spawn(process.execPath, [file, ...args], {
    env: { ...process.env },
    stdio: ['ignore','pipe','pipe'],
  })
  child.stdout.on('data', d => process.stdout.write(`${t} ${d}`))
  child.stderr.on('data', d => process.stderr.write(`${t} ${C.red}${d}${C.reset}`))
  child.on('exit', (code, signal) => {
    console.log(`${t} exited (code=${code} signal=${signal}) — restarting in 5s…`)
    setTimeout(() => spawnService(label, color, file, args), 5000)
  })
  child.on('error', err => console.error(`${t} spawn error: ${err.message}`))
  console.log(`${t} started (pid ${child.pid})`)
  return child
}

// ── Spawn a one-shot process (signal checker) ─────────────────
function spawnOnce(label, color, file, args=[]) {
  const t = tag(label, color)
  const child = spawn(process.execPath, [file, ...args], {
    env: { ...process.env },
    stdio: ['ignore','pipe','pipe'],
  })
  child.stdout.on('data', d => process.stdout.write(`${t} ${d}`))
  child.stderr.on('data', d => process.stderr.write(`${t} ${C.red}${d}${C.reset}`))
  child.on('exit', code => { if(code!==0) console.log(`${t} finished (code ${code})`) })
  return child
}

// ── Start ngrok + auto-register webhook URL in Twilio ─────────
function startNgrok() {
  const t = tag('NGROK', C.magenta)
  console.log(`${t} starting tunnel on port ${WA_PORT}…`)

  const child = spawn('ngrok', ['http', WA_PORT, '--log=stdout'], {
    env: { ...process.env },
    stdio: ['ignore','pipe','pipe'],
  })

  child.stdout.on('data', async d => {
    const line = d.toString()
    process.stdout.write(`${t} ${line}`)

    // Detect the public URL from ngrok output
    const match = line.match(/url=(https:\/\/[a-z0-9\-]+\.ngrok[a-z.]*\.io)/i)
              || line.match(/(https:\/\/[a-z0-9\-]+\.ngrok[a-z.]*\.io)/i)
    if (match) {
      const url = `${match[1]}/webhook`
      console.log(`${t} ${C.green}Public webhook: ${url}${C.reset}`)
      await registerTwilioWebhook(url)
    }
  })

  child.stderr.on('data', d => process.stderr.write(`${t} ${C.red}${d}${C.reset}`))
  child.on('exit', (code, signal) => {
    console.log(`${t} exited — restarting in 10s…`)
    setTimeout(startNgrok, 10000)
  })
  child.on('error', err => {
    console.error(`${t} ${C.red}ngrok not found — install it: pkg install ngrok${C.reset}`)
    console.error(`${t} ${C.yellow}You can manually paste the webhook URL in Twilio sandbox settings${C.reset}`)
  })
}

// ── Auto-register webhook URL in Twilio sandbox ───────────────
async function registerTwilioWebhook(webhookUrl) {
  const t = tag('NGROK', C.magenta)
  try {
    const creds = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64')
    const params = new URLSearchParams({
      SandboxWebhookUrl: webhookUrl,
      Method: 'POST',
    })
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/Sandbox.json`,
      { method:'POST', headers:{ Authorization:`Basic ${creds}`, 'Content-Type':'application/x-www-form-urlencoded' }, body:params.toString() }
    )
    if (res.ok) console.log(`${t} ${C.green}✅ Twilio webhook registered automatically${C.reset}`)
    else console.log(`${t} ${C.yellow}⚠️  Auto-register failed (${res.status}) — paste URL manually in Twilio sandbox settings${C.reset}`)
  } catch(e) {
    console.log(`${t} ${C.yellow}⚠️  Could not auto-register webhook: ${e.message}${C.reset}`)
  }
}

const resolve = f => path.join(__dirname, f)

// ── Banner ────────────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════════╗
║   🟡  GOLD AI — Master Launcher          ║
╚══════════════════════════════════════════╝
  Telegram bot : ${C.cyan}✅ ${ENV.TG_TOKEN.slice(0,12)}…${C.reset}
  WhatsApp bot : ${C.yellow}✅ Twilio ${ENV.TWILIO_FROM}${C.reset}
  Admin WA     : ${ENV.ADMIN_WA}
  Signal data  : ${C.green}✅ TwelveData${C.reset}
  Check every  : ${CHECK_EVERY_MS/60000} min
  WA Webhook   : http://localhost:${WA_PORT}/webhook
`)

// ── 1. Telegram bot ───────────────────────────────────────────
spawnService('TG-BOT',  C.cyan,    resolve('bot-subscription.mjs'))

// ── 2. WhatsApp bot (Twilio webhook server) ───────────────────
spawnService('WA-BOT',  C.yellow,  resolve('whatsapp-bot.mjs'))

// ── 3. ngrok tunnel (exposes WA webhook to internet) ──────────
setTimeout(startNgrok, 3000) // wait 3s for WA-BOT to start first

// ── 4. Signal checker every CHECK_EVERY_MS ───────────────────
function runSignalCheck() {
  spawnOnce('SIGNALS', C.green, resolve('gold-ai.mjs'), ['check'])
}
console.log(`${tag('SIGNALS',C.green)} first check in 15s, then every ${CHECK_EVERY_MS/60000} min`)
setTimeout(() => { runSignalCheck(); setInterval(runSignalCheck, CHECK_EVERY_MS) }, 15000)

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGINT',  () => { console.log('\n🛑  Shutting down…'); process.exit(0) })
process.on('SIGTERM', () => { console.log('\n🛑  Shutting down…'); process.exit(0) })
