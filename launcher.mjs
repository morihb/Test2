// ─────────────────────────────────────────────────────────────
//  GOLD AI — Master Launcher
//  Runs all services in ONE process:
//    1. Telegram subscription bot  (bot-subscription.mjs)
//    2. WhatsApp subscription bot  (whatsapp-bot.mjs) — Twilio
//    3. cloudflared tunnel         (exposes WA webhook publicly)
//    4. Signal checker             (gold-ai.mjs — check mode)
//
//  Run:  node launcher.mjs
// ─────────────────────────────────────────────────────────────
import { spawn }         from 'child_process'
import path              from 'path'
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

// ── Start cloudflared tunnel ──────────────────────────────────
function startTunnel() {
  const t = tag('TUNNEL', C.magenta)
  console.log(`${t} starting cloudflared tunnel on port ${WA_PORT}…`)

  const child = spawn('cloudflared', ['tunnel', '--url', `http://localhost:${WA_PORT}`, '--no-autoupdate'], {
    env: { ...process.env },
    stdio: ['ignore','pipe','pipe'],
  })

  // cloudflared prints the public URL to stderr
  const onData = async (d) => {
    const line = d.toString()
    process.stdout.write(`${t} ${line}`)

    // Detect the public URL
    const match = line.match(/(https:\/\/[a-z0-9\-]+\.trycloudflare\.com)/i)
    if (match) {
      const url = `${match[1]}/webhook`
      console.log(`\n${t} ${C.green}✅ Public webhook URL: ${url}${C.reset}\n`)
      await registerTwilioWebhook(url)
    }
  }

  child.stdout.on('data', onData)
  child.stderr.on('data', onData)

  child.on('exit', (code, signal) => {
    console.log(`${t} exited — restarting in 10s…`)
    setTimeout(startTunnel, 10000)
  })
  child.on('error', err => {
    console.error(`${t} ${C.red}cloudflared error: ${err.message}${C.reset}`)
  })
}

// ── Auto-register webhook URL in Twilio sandbox ───────────────
// Twilio sandbox webhook must be set via the WhatsApp Sandbox resource
async function registerTwilioWebhook(webhookUrl) {
  const t = tag('TUNNEL', C.magenta)
  try {
    const creds  = Buffer.from(`${process.env.TWILIO_SID}:${process.env.TWILIO_TOKEN}`).toString('base64')

    // Correct endpoint: update the sandbox inbound webhook URL
    const params = new URLSearchParams({
      InboundRequestUrl: webhookUrl,
      InboundMethod:     'POST',
    })
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${process.env.TWILIO_SID}/IncomingPhoneNumbers/Sandbox/WhatsApp.json`,
      { method:'POST', headers:{ Authorization:`Basic ${creds}`, 'Content-Type':'application/x-www-form-urlencoded' }, body:params.toString() }
    )

    if (res.ok) {
      console.log(`${t} ${C.green}✅ Twilio webhook registered automatically${C.reset}`)
    } else {
      // Fallback: print the URL clearly so user can paste it manually (takes 5 seconds)
      console.log(`${t} ${C.yellow}⚠️  Could not auto-register (${res.status})${C.reset}`)
      console.log(`${t} ${C.yellow}👉 Paste this URL in Twilio Sandbox settings manually:${C.reset}`)
      console.log(`${t} ${C.green}   ${webhookUrl}${C.reset}`)
      console.log(`${t} ${C.yellow}   twilio.com/console → Messaging → Try it out → Send a WhatsApp message → Sandbox Settings${C.reset}`)
    }
  } catch(e) {
    console.log(`${t} ${C.yellow}⚠️  Could not auto-register: ${e.message}${C.reset}`)
    console.log(`${t} ${C.green}👉 Webhook URL: ${webhookUrl}${C.reset}`)
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
  Tunnel       : ${C.magenta}✅ cloudflared${C.reset}
  Signal data  : ${C.green}✅ TwelveData${C.reset}
  Check every  : ${CHECK_EVERY_MS/60000} min
`)

// ── 1. Telegram bot ───────────────────────────────────────────
spawnService('TG-BOT',  C.cyan,   resolve('bot-subscription.mjs'))

// ── 2. WhatsApp bot (Twilio webhook server) ───────────────────
spawnService('WA-BOT',  C.yellow, resolve('whatsapp-bot.mjs'))

// ── 3. cloudflared tunnel (starts 3s after WA-BOT is up) ─────
setTimeout(startTunnel, 3000)

// ── 4. Signal checker every CHECK_EVERY_MS ───────────────────
function runSignalCheck() {
  spawnOnce('SIGNALS', C.green, resolve('gold-ai.mjs'), ['check'])
}
console.log(`${tag('SIGNALS', C.green)} first check in 15s, then every ${CHECK_EVERY_MS/60000} min`)
setTimeout(() => { runSignalCheck(); setInterval(runSignalCheck, CHECK_EVERY_MS) }, 15000)

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGINT',  () => { console.log('\n🛑  Shutting down…'); process.exit(0) })
process.on('SIGTERM', () => { console.log('\n🛑  Shutting down…'); process.exit(0) })
