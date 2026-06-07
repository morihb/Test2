// ─────────────────────────────────────────────────────────────
//  GOLD AI — Master Launcher
//  Runs all three services in ONE process:
//    1. Telegram subscription bot  (bot-subscription.mjs)
//    2. WhatsApp subscription bot  (whatsapp-bot.mjs)
//    3. Signal checker             (gold-ai.mjs — check mode)
//
//  Run:  node launcher.mjs
// ─────────────────────────────────────────────────────────────
import { spawn } from 'child_process'
import path from 'path'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ── CREDENTIALS (baked in — real env vars override if set) ───
const ENV = {
  // Telegram
  TG_TOKEN:         '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg',
  ADMIN_CHAT_ID:    '1408577116',
  CHANNEL_USERNAME: '@MH_Signals',

  // WhatsApp (Green API)
  WA_INSTANCE:      '7107645470',
  WA_TOKEN:         '37e51f5f69794180acf390f80ee89bcac29ceb0748b148f1a4',
  ADMIN_WA:         '96181826800@c.us',

  // Signal data
  TWELVEDATA_KEY:   'dbf374976088424aa703db6034942e19',
  LIVE_TFS:         '15m,1h',

  // Payments (replace with real wallet addresses)
  USDT_ADDRESS:     'TEST_USDT_ADDRESS',
  BTC_ADDRESS:      'TEST_BTC_ADDRESS',
}

// Merge: baked-in values are defaults; real env vars always win
for (const [k, v] of Object.entries(ENV)) {
  if (!process.env[k]) process.env[k] = v
}

const CHECK_EVERY_MS = (parseInt(process.env.CHECK_MIN) || 15) * 60 * 1000

// ── Colour helpers ────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  yellow: '\x1b[33m',
  cyan:   '\x1b[36m',
  green:  '\x1b[32m',
  red:    '\x1b[31m',
}
const tag = (label, color) => `${color}[${label}]${C.reset}`

// ── Spawn a long-running service with auto-restart ────────────
function spawnService(label, color, file, args = []) {
  const t = tag(label, color)
  const child = spawn(process.execPath, [file, ...args], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
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

// ── Spawn a one-shot child (signal checker) ───────────────────
function spawnOnce(label, color, file, args = []) {
  const t = tag(label, color)
  const child = spawn(process.execPath, [file, ...args], {
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.on('data', d => process.stdout.write(`${t} ${d}`))
  child.stderr.on('data', d => process.stderr.write(`${t} ${C.red}${d}${C.reset}`))
  child.on('exit', code => { if (code !== 0) console.log(`${t} finished (code ${code})`) })
  return child
}

const resolve = f => path.join(__dirname, f)

// ── Startup banner ────────────────────────────────────────────
console.log(`
╔══════════════════════════════════════╗
║   🟡  GOLD AI — Master Launcher      ║
╚══════════════════════════════════════╝
  Telegram bot : ${C.green}✅ ${process.env.TG_TOKEN.slice(0,12)}…${C.reset}
  WhatsApp bot : ${C.green}✅ instance ${process.env.WA_INSTANCE}${C.reset}
  Admin WA     : ${process.env.ADMIN_WA}
  Signal data  : ${C.green}✅ TwelveData${C.reset}
  Check every  : ${CHECK_EVERY_MS / 60000} min
`)

// ── 1. Telegram subscription bot ─────────────────────────────
spawnService('TG-BOT', C.cyan, resolve('bot-subscription.mjs'))

// ── 2. WhatsApp subscription bot ─────────────────────────────
spawnService('WA-BOT', C.yellow, resolve('whatsapp-bot.mjs'))

// ── 3. Signal checker — runs every CHECK_EVERY_MS ────────────
function runSignalCheck() {
  spawnOnce('SIGNALS', C.green, resolve('gold-ai.mjs'), ['check'])
}

console.log(`${tag('SIGNALS', C.green)} first check in 10s, then every ${CHECK_EVERY_MS / 60000} min`)
setTimeout(() => {
  runSignalCheck()
  setInterval(runSignalCheck, CHECK_EVERY_MS)
}, 10_000)

// ── Graceful shutdown ─────────────────────────────────────────
process.on('SIGINT',  () => { console.log('\n🛑  Shutting down…'); process.exit(0) })
process.on('SIGTERM', () => { console.log('\n🛑  Shutting down…'); process.exit(0) })
