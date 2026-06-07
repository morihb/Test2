// ─────────────────────────────────────────────────────────────
//  GOLD AI — WhatsApp Bot (Twilio)
//  Real interactive buttons — same flow as Telegram bot
//
//  Run:  node whatsapp-bot.mjs
//
//  How it works:
//   • Twilio receives WhatsApp messages and POSTs them to your webhook
//   • You need a public URL (use ngrok on Termux for testing)
//   • In production: deploy to any VPS or use ngrok permanently
//
//  Env vars (all baked in below):
//   TWILIO_SID      — Account SID
//   TWILIO_TOKEN    — Auth Token
//   TWILIO_FROM     — bot's WhatsApp number
//   ADMIN_WA        — your personal number (receives payment alerts)
//   USDT_ADDRESS    — TRC-20 wallet
//   BTC_ADDRESS     — Bitcoin wallet
//   PORT            — webhook server port (default 3000)
// ─────────────────────────────────────────────────────────────
import http from 'http'
import fs   from 'fs'

// ── CREDENTIALS (baked in) ────────────────────────────────────
const ENV = {
  TWILIO_SID:   'AC749a3893c6d15036e9fbaf7d6cdd9b56',
  TWILIO_TOKEN: '96d7b0fd0a68de1e4976ce51359eda5b',
  TWILIO_FROM:  'whatsapp:+14155238886',
  ADMIN_WA:     'whatsapp:+96181826800',
  USDT_ADDRESS: 'TEST_USDT_ADDRESS',
  BTC_ADDRESS:  'TEST_BTC_ADDRESS',
  PORT:         '3000',
}
for (const [k,v] of Object.entries(ENV)) if (!process.env[k]) process.env[k] = v

const SID       = process.env.TWILIO_SID
const TOKEN     = process.env.TWILIO_TOKEN
const FROM      = process.env.TWILIO_FROM
const ADMIN_WA  = process.env.ADMIN_WA
const PORT      = parseInt(process.env.PORT) || 3000

// ── FILES ─────────────────────────────────────────────────────
const SUBS_FILE     = './wa_subscribers.json'
const SETTINGS_FILE = './settings.json'

// ── PACKAGES ──────────────────────────────────────────────────
const PACKAGES = {
  p1: { id:'p1', label:'1 Month',  price:50,  days:30  },
  p2: { id:'p2', label:'3 Months', price:120, days:90  },
  p3: { id:'p3', label:'6 Months', price:200, days:180 },
}

// ── PAYMENT METHODS ───────────────────────────────────────────
function getWallets() {
  try { const s=JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8')); return { usdt:s.usdt||process.env.USDT_ADDRESS, btc:s.btc||process.env.BTC_ADDRESS } }
  catch { return { usdt:process.env.USDT_ADDRESS, btc:process.env.BTC_ADDRESS } }
}

// ── SUBSCRIBER STORE ──────────────────────────────────────────
function loadSubs() { try { return JSON.parse(fs.readFileSync(SUBS_FILE,'utf8')) } catch { return {} } }
function saveSubs(s) { fs.writeFileSync(SUBS_FILE, JSON.stringify(s,null,2)) }
function getSub(id)  { return loadSubs()[id] || null }
function upsertSub(id, patch) {
  const all=loadSubs(); all[id]={chatId:id,...all[id],...patch,updatedAt:new Date().toISOString()}; saveSubs(all); return all[id]
}
function activeSubs() { return Object.values(loadSubs()).filter(s=>s.status==='active') }

// ── TWILIO SEND ───────────────────────────────────────────────
async function sendMessage(to, body) {
  const creds = Buffer.from(`${SID}:${TOKEN}`).toString('base64')
  const params = new URLSearchParams({ To: to, From: FROM, Body: body })
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${creds}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  })
  if (!res.ok) console.error('Twilio error:', res.status, await res.text())
  return res.ok
}

// Twilio WhatsApp buttons via list message format
// Buttons: array of { id, title } (max 3 for quick reply buttons)
async function sendButtons(to, body, buttons) {
  // Twilio supports buttons via interactive messaging templates
  // For sandbox: we simulate with numbered list since templates need approval
  // Format: body text + numbered options (clean UX)
  const opts = buttons.map((b,i) => `${i+1}. ${b.title}`).join('\n')
  return sendMessage(to, `${body}\n\n${opts}`)
}

// Send a list menu (for more than 3 options)
async function sendList(to, header, body, items) {
  const opts = items.map((item,i) => `${i+1}. ${item.title}${item.desc ? '\n    '+item.desc : ''}`).join('\n')
  return sendMessage(to, `*${header}*\n\n${body}\n\n${opts}`)
}

// ── SESSION (in-memory) ───────────────────────────────────────
const session = {}
function setScreen(id, screen, extra={}) { session[id] = { screen, ...extra } }
function getScreen(id) { return session[id] || { screen:'home' } }

// ── MENUS ─────────────────────────────────────────────────────
async function showHome(to) {
  setScreen(to, 'packages')
  return sendList(to,
    '🟡 GOLD AI — Premium Signals',
    `Real-time XAUUSD trading signals\n\n✅ 15m + 1h timeframes\n✅ Entry, SL, TP1/TP2/TP3\n✅ Score & regime context\n✅ Instant WhatsApp delivery\n\n*Choose your plan:*`,
    [
      { title:'1 Month — $50',   desc:'30 days of premium signals' },
      { title:'3 Months — $120', desc:'90 days · save $30'         },
      { title:'6 Months — $200', desc:'180 days · best value'      },
      { title:'My Status',       desc:'Check current subscription'  },
    ]
  )
}

async function showPaymentMethods(to, pkgId) {
  const pkg = PACKAGES[pkgId]
  setScreen(to, 'payment_method', { pkgId })
  return sendButtons(to,
    `📦 *${pkg.label} — $${pkg.price}*\n\nChoose payment method:`,
    [
      { id:'usdt', title:'💵 USDT (TRC-20)' },
      { id:'btc',  title:'₿  Bitcoin'       },
      { id:'back', title:'← Back to plans'  },
    ]
  )
}

async function showPaymentDetails(to, pkgId, method) {
  const pkg = PACKAGES[pkgId]
  const w   = getWallets()
  const addr = method==='usdt' ? w.usdt : w.btc
  const coin = method==='usdt' ? 'USDT (TRC-20)' : 'Bitcoin'
  upsertSub(to, { status:'pending_payment', pendingPkg:pkgId, pendingMethod:method })
  setScreen(to, 'awaiting_payment', { pkgId, method })
  return sendButtons(to,
    `💳 *Payment Instructions*\n\nPlan: *${pkg.label} — $${pkg.price}*\nMethod: *${coin}*\n\nSend exactly *$${pkg.price} worth of ${coin}* to:\n\n${addr}\n\n⚠️ Send exact amount · use correct network`,
    [
      { id:'paid', title:'✅ I Sent the Payment' },
      { id:'back', title:'← Back to methods'     },
    ]
  )
}

async function showStatus(to) {
  const sub = getSub(to)
  if (!sub || sub.status==='none') return sendMessage(to, '📭 No active subscription.\n\nReply *menu* to see plans.')
  if (sub.status==='pending_payment') return sendMessage(to, '⏳ Pending payment — awaiting your confirmation.\n\nReply *menu* to restart.')
  if (sub.status==='awaiting_admin')  return sendMessage(to, '⏳ Payment submitted — admin reviewing.\n\nUsually confirmed within 10–30 min. We will message you here.')
  if (sub.status==='active') {
    const exp = new Date(sub.expiresAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
    return sendMessage(to, `✅ *Subscription Active*\n\nPlan: *${sub.planLabel}*\nExpires: *${exp}*\n\nSignals are sent directly here. 🟡`)
  }
  if (sub.status==='expired') return sendMessage(to, '❌ Subscription expired.\n\nReply *menu* to renew.')
  if (sub.status==='denied')  return sendMessage(to, '❌ Payment not confirmed.\n\nReply *menu* to try again or contact support.')
}

// ── MESSAGE HANDLER ───────────────────────────────────────────
async function handleMessage(from, body) {
  const t   = (body||'').trim().toLowerCase()
  const sub = getSub(from)
  const scr = getScreen(from)
  const isAdmin = from === ADMIN_WA

  // ── ADMIN COMMANDS ──────────────────────────────────────────
  if (isAdmin) {
    const approveM = t.match(/^approve\s+(\S+)/)
    if (approveM) return adminApprove(from, approveM[1])

    const denyM = t.match(/^deny\s+(\S+)/)
    if (denyM) return adminDeny(from, denyM[1])

    const revokeM = t.match(/^revoke\s+(\S+)/)
    if (revokeM) return adminRevoke(from, revokeM[1])

    const bcM = body.match(/^broadcast\s+(.+)/is)
    if (bcM) return adminBroadcast(from, bcM[1])

    if (t==='subs') {
      const active = activeSubs()
      if (!active.length) return sendMessage(from, 'No active subscribers.')
      const lines = active.map(s=>`• ${s.chatId}\n  ${s.planLabel} → ${new Date(s.expiresAt).toLocaleDateString()}`)
      return sendMessage(from, `📋 *Active Subscribers (${active.length})*\n\n${lines.join('\n\n')}`)
    }

    if (t==='pending') {
      const all = Object.values(loadSubs()).filter(s=>s.status==='awaiting_admin')
      if (!all.length) return sendMessage(from, 'No pending approvals.')
      const lines = all.map(s=>`• ${s.chatId}\n  ${PACKAGES[s.pendingPkg]?.label} via ${s.pendingMethod}\n  → approve ${s.chatId}\n  → deny ${s.chatId}`)
      return sendMessage(from, `🔔 *Pending (${all.length})*\n\n${lines.join('\n\n')}`)
    }

    if (t==='admin') return sendMessage(from,
      `🔧 *Admin Commands*\n\nsubs — active subscribers\npending — awaiting approval\napprove <number> — activate\ndeny <number> — reject\nrevoke <number> — cancel\nbroadcast <msg> — send to all`)
  }

  // ── GLOBAL SHORTCUTS ────────────────────────────────────────
  if (['hi','hello','start','menu','hey',''].includes(t)) {
    if (sub?.status==='active' && new Date(sub.expiresAt)<new Date()) upsertSub(from,{status:'expired'})
    return showHome(from)
  }
  if (t==='status') return showStatus(from)

  // ── PACKAGE SELECTION ────────────────────────────────────────
  if (scr.screen==='packages') {
    if (t==='1') return showPaymentMethods(from, 'p1')
    if (t==='2') return showPaymentMethods(from, 'p2')
    if (t==='3') return showPaymentMethods(from, 'p3')
    if (t==='4') return showStatus(from)
    return showHome(from)
  }

  // ── PAYMENT METHOD ───────────────────────────────────────────
  if (scr.screen==='payment_method') {
    if (t==='1') return showPaymentDetails(from, scr.pkgId, 'usdt')
    if (t==='2') return showPaymentDetails(from, scr.pkgId, 'btc')
    if (t==='3') return showHome(from)
    return showPaymentMethods(from, scr.pkgId)
  }

  // ── AWAITING PAYMENT ─────────────────────────────────────────
  if (scr.screen==='awaiting_payment') {
    if (t==='2') return showPaymentMethods(from, scr.pkgId)
    if (t==='1') {
      const pkg = PACKAGES[scr.pkgId]
      upsertSub(from, { status:'awaiting_admin', claimedAt:new Date().toISOString() })
      setScreen(from, 'home')
      if (ADMIN_WA) {
        await sendMessage(ADMIN_WA,
`🔔 *New Payment Claim*\n\nUser: ${from}\nPlan: ${pkg.label} — $${pkg.price}\nMethod: ${scr.method==='usdt'?'USDT':'Bitcoin'}\n\nReply:\napprove ${from.replace('whatsapp:','')}\ndeny ${from.replace('whatsapp:','')}`)
      }
      return sendMessage(from, '⏳ *Payment Under Review*\n\nThank you! We will verify and activate your account within 10–30 minutes.\n\nYou will receive a message here when confirmed. 🟡')
    }
    return sendMessage(from, 'Reply *1* after sending payment, or *2* to go back.')
  }

  // ── FALLBACK ─────────────────────────────────────────────────
  return sendMessage(from, 'Reply *menu* to see plans or *status* to check your subscription.')
}

// ── ADMIN ACTIONS ─────────────────────────────────────────────
async function adminApprove(adminId, target) {
  const to = target.includes('@') ? `whatsapp:+${target.replace(/\D/g,'')}` : `whatsapp:+${target.replace(/\D/g,'')}`
  const sub = getSub(to)
  if (!sub) return sendMessage(adminId, `❌ User ${to} not found.`)
  const pkg = PACKAGES[sub.pendingPkg]
  if (!pkg) return sendMessage(adminId, `❌ No pending package for ${to}.`)
  const now=new Date(), exp=new Date(now.getTime()+pkg.days*86400000)
  upsertSub(to, { status:'active', plan:pkg.id, planLabel:pkg.label, price:pkg.price, activatedAt:now.toISOString(), expiresAt:exp.toISOString(), pendingPkg:null, pendingMethod:null })
  const expStr = exp.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
  await sendMessage(adminId, `✅ Approved ${to} — ${pkg.label} until ${expStr}`)
  await sendMessage(to, `🎉 *Payment Confirmed!*\n\nYour *${pkg.label}* subscription is now *ACTIVE*.\n\n✅ Expires: *${expStr}*\n\nWelcome to GOLD AI Premium! Signals will be sent directly here. 🟡`)
}

async function adminDeny(adminId, target) {
  const to = `whatsapp:+${target.replace(/\D/g,'')}`
  const sub = getSub(to)
  if (!sub) return sendMessage(adminId, `❌ User ${to} not found.`)
  const pkg = PACKAGES[sub.pendingPkg]
  upsertSub(to, { status:'denied', pendingPkg:null, pendingMethod:null })
  await sendMessage(adminId, `✅ Denied ${to}.`)
  await sendMessage(to, `❌ *Payment Not Confirmed*\n\nWe could not verify your ${pkg?.label||''} payment.\n\nCommon reasons:\n• Wrong amount\n• Wrong network\n• Not yet broadcast\n\nReply *menu* to try again.`)
}

async function adminRevoke(adminId, target) {
  const to = `whatsapp:+${target.replace(/\D/g,'')}`
  upsertSub(to, { status:'expired' })
  await sendMessage(adminId, `✅ Revoked ${to}.`)
  await sendMessage(to, `❌ Your GOLD AI subscription has been cancelled.\n\nReply *menu* if you think this is an error.`)
}

async function adminBroadcast(adminId, message) {
  const subs = activeSubs()
  if (!subs.length) return sendMessage(adminId, 'No active subscribers.')
  let ok=0, fail=0
  for (const s of subs) {
    const r = await sendMessage(s.chatId, `📢 *GOLD AI Update*\n\n${message}`)
    r ? ok++ : fail++
    await new Promise(r=>setTimeout(r,1000))
  }
  return sendMessage(adminId, `✅ Broadcast: ${ok} sent, ${fail} failed.`)
}

// ── SIGNAL BROADCAST (call from gold-ai.mjs) ─────────────────
export async function broadcastSignal(text) {
  const subs = activeSubs()
  for (const s of subs) {
    if (new Date(s.expiresAt)<new Date()) { upsertSub(s.chatId,{status:'expired'}); continue }
    await sendMessage(s.chatId, text)
    await new Promise(r=>setTimeout(r,500))
  }
  console.log(`[whatsapp] signal sent to ${subs.length} subscriber(s)`)
}

// ── WEBHOOK SERVER ────────────────────────────────────────────
// Twilio sends incoming messages as POST to this server
function parseForm(body) {
  return Object.fromEntries(new URLSearchParams(body))
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'POST' && req.url === '/webhook') {
    let raw = ''
    req.on('data', chunk => raw += chunk)
    req.on('end', async () => {
      try {
        const data = parseForm(raw)
        const from = data.From || ''
        const body = data.Body || ''
        console.log(`[msg] ${from}: ${body.slice(0,80)}`)
        await handleMessage(from, body)
      } catch(e) { console.error('Webhook error:', e.message) }
      res.writeHead(200, {'Content-Type':'text/plain'})
      res.end('OK')
    })
  } else if (req.method === 'GET' && req.url === '/health') {
    res.writeHead(200); res.end('🟡 GOLD AI WhatsApp Bot running')
  } else {
    res.writeHead(404); res.end('Not found')
  }
})

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════╗
║   🟡  GOLD AI WhatsApp Bot (Twilio)  ║
╚══════════════════════════════════════╝
  From     : ${FROM}
  Admin    : ${ADMIN_WA}
  Webhook  : http://localhost:${PORT}/webhook
  Health   : http://localhost:${PORT}/health

  ⚠️  Expose this port publicly so Twilio can reach it:
      npx ngrok http ${PORT}
  Then paste the ngrok URL into Twilio sandbox settings.
`)
})
