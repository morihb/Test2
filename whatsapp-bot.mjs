// ─────────────────────────────────────────────────────────────
//  GOLD AI — WhatsApp Subscription Bot (Green API)
//  Mirror of Telegram bot-subscription.mjs — same packages,
//  same flow, same admin controls — but on WhatsApp.
//
//  Flow: user messages bot → picks package → picks payment
//        method → sends crypto → presses "I paid" → admin
//        approves → user gets signals on WhatsApp.
//
//  Run:  node whatsapp-bot.mjs
//
//  Env vars (required):
//    WA_INSTANCE   — Green API instance ID   (e.g. 1101234567)
//    WA_TOKEN      — Green API instance token
//    ADMIN_WA      — admin WhatsApp chat ID  (e.g. 447911123456@c.us)
//
//  Env vars (optional — fall back to settings.json):
//    USDT_ADDRESS  — TRC-20 USDT wallet
//    BTC_ADDRESS   — Bitcoin wallet
//
//  Signals integration:
//    In gold-ai.mjs set WA_INSTANCE + WA_TOKEN + WA_CHAT_ID
//    (WA_CHAT_ID = subscriber's chatId) per active subscriber.
//    Or call broadcastSignal(text) from this file directly.
// ─────────────────────────────────────────────────────────────
import fs from 'fs'

// ── CONFIG ────────────────────────────────────────────────────
const INSTANCE  = process.env.WA_INSTANCE || ''
const TOKEN     = process.env.WA_TOKEN    || ''
const ADMIN_WA  = process.env.ADMIN_WA    || '' // e.g. 447911123456@c.us

const SUBS_FILE     = './wa_subscribers.json'
const SETTINGS_FILE = './settings.json'
const TRADE_LOG     = './wa_trade_log.json'

if (!INSTANCE || !TOKEN) {
  console.error('❌  Set WA_INSTANCE and WA_TOKEN env vars before running.')
  process.exit(1)
}

const BASE = `https://api.green-api.com/waInstance${INSTANCE}`

// ── PACKAGES (same as Telegram bot) ──────────────────────────
// These are the live packages; admin can edit settings.json to override.
let PACKAGES = {
  p1: { id:'p1', label:'1 Month',  price:50,  days:30,  enabled:true },
  p2: { id:'p2', label:'3 Months', price:120, days:90,  enabled:true },
  p3: { id:'p3', label:'6 Months', price:200, days:180, enabled:true },
}

// ── PAYMENT METHODS ──────────────────────────────────────────
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8')) } catch { return {} }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s,null,2)) }

function getWallets() {
  const s = loadSettings()
  return {
    usdt: s.usdt_address || process.env.USDT_ADDRESS || 'NOT_SET',
    btc:  s.btc_address  || process.env.BTC_ADDRESS  || 'NOT_SET',
  }
}

function payMethods() {
  const w = getWallets()
  return {
    usdt: { label:'💵 USDT (TRC-20)', coin:'USDT', address: w.usdt },
    btc:  { label:'₿ Bitcoin',        coin:'BTC',  address: w.btc  },
  }
}

// ── SUBSCRIBER STORE ─────────────────────────────────────────
function loadSubs() { try { return JSON.parse(fs.readFileSync(SUBS_FILE,'utf8')) } catch { return {} } }
function saveSubs(s) { fs.writeFileSync(SUBS_FILE, JSON.stringify(s,null,2)) }
function getSub(id)  { return loadSubs()[id] || null }
function upsertSub(id, patch) {
  const all = loadSubs()
  all[id] = { chatId:id, ...all[id], ...patch, updatedAt: new Date().toISOString() }
  saveSubs(all)
  return all[id]
}
function activeSubs() { return Object.values(loadSubs()).filter(s => s.status==='active') }

// ── GREEN API HELPERS ─────────────────────────────────────────
async function apiPost(method, body) {
  try {
    const res = await fetch(`${BASE}/${method}/${TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!res.ok) { console.error(`Green API ${method} ${res.status}`, await res.text()); return null }
    return res.json()
  } catch(e) { console.error(`Green API ${method} error:`, e.message); return null }
}

async function apiGet(method) {
  try {
    const res = await fetch(`${BASE}/${method}/${TOKEN}`)
    if (!res.ok) { console.error(`Green API GET ${method} ${res.status}`); return null }
    return res.json()
  } catch(e) { console.error(`Green API GET ${method} error:`, e.message); return null }
}

// Send a plain-text WhatsApp message
async function send(chatId, text) {
  return apiPost('sendMessage', { chatId, message: text })
}

// Receive one pending notification (long-poll style)
async function receiveOne() {
  return apiGet('receiveNotification')
}

// Delete notification after processing (required by Green API)
async function deleteNotification(receiptId) {
  try {
    const res = await fetch(`${BASE}/deleteNotification/${TOKEN}/${receiptId}`, { method:'DELETE' })
    return res.ok
  } catch { return false }
}

// ── SESSION STATE (in-memory, survives only while bot runs) ──
// Tracks what menu screen each user is currently on.
const session = {} // chatId → { screen, pkgId, methodKey }
function setScreen(id, screen, extra={}) { session[id] = { screen, ...extra } }
function getScreen(id) { return session[id] || { screen:'home' } }

// ── MENUS ─────────────────────────────────────────────────────

function packagesMenu() {
  const pkgs = Object.values(PACKAGES).filter(p=>p.enabled)
  const lines = pkgs.map((p,i) => `  ${i+1}. ${p.label} — $${p.price}`)
  return `🟡 *GOLD AI — Premium Signals*

Real-time XAUUSD trading signals powered by multi-timeframe analysis.

✅ 15m + 1h signals
✅ Entry, SL, TP1/TP2/TP3 included
✅ Score, regime & session context
✅ Instant WhatsApp delivery

*Choose your subscription plan* (reply with number):

${lines.join('\n')}

  0. Cancel`
}

function paymentMenu(pkg) {
  const methods = Object.values(payMethods())
  const lines = methods.map((m,i) => `  ${i+1}. ${m.label}`)
  return `📦 *${pkg.label} Plan — $${pkg.price}*

Choose your payment method (reply with number):

${lines.join('\n')}

  0. ← Back to plans`
}

function paymentDetails(pkg, method, chatId) {
  return `💳 *Payment Instructions*

Plan: *${pkg.label} — $${pkg.price}*
Method: *${method.label}*

Send exactly *$${pkg.price} worth of ${method.coin}* to:

\`${method.address}\`

⚠️ *Important:*
• Send the exact amount — no partial payments
• Note your WhatsApp number in the memo if possible
• Payment confirms within 10–30 min

After sending, reply:
  1. ✅ I Sent the Payment
  0. ← Back to methods`
}

function statusMsg(sub) {
  if (!sub || sub.status === 'none') return `You have no active subscription.\n\nReply *hi* or *menu* to browse plans.`
  if (sub.status === 'pending_payment') return `⏳ You have a pending payment awaiting admin review.\n\nReply *status* to check again.`
  if (sub.status === 'awaiting_admin') return `⏳ Payment submitted — awaiting admin approval.\n\nUsually 10–30 min. We'll message you here when confirmed.`
  if (sub.status === 'active') {
    const exp = new Date(sub.expiresAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
    return `✅ *Subscription Active*\n\nPlan: *${sub.planLabel}*\nExpires: *${exp}*\n\nSignals are sent directly to this chat. 🟡`
  }
  if (sub.status === 'expired') return `❌ Your subscription has expired.\n\nReply *menu* to renew.`
  if (sub.status === 'denied')  return `❌ Your last payment was not confirmed.\n\nReply *menu* to try again or contact support.`
  return `Reply *menu* to get started.`
}

// ── MESSAGE HANDLER ───────────────────────────────────────────
async function handleMessage(chatId, text) {
  const t     = (text||'').trim().toLowerCase()
  const sub   = getSub(chatId)
  const scr   = getScreen(chatId)
  const isAdmin = chatId === ADMIN_WA

  // ── ADMIN COMMANDS ────────────────────────────────────────
  if (isAdmin) {
    // /subs or subs
    if (t==='subs'||t==='/subs') {
      const active = activeSubs()
      if (!active.length) return send(chatId, 'No active subscribers.')
      const lines = active.map(s => {
        const exp = s.expiresAt ? new Date(s.expiresAt).toLocaleDateString() : '?'
        return `• ${s.chatId} — ${s.planLabel||'?'} → ${exp}`
      })
      return send(chatId, `📋 *Active Subscribers (${active.length})*\n\n${lines.join('\n')}`)
    }

    // approve <chatId>
    const approveM = text.match(/^\/?(approve)\s+(\S+)/i)
    if (approveM) return adminApprove(chatId, approveM[2])

    // deny <chatId>
    const denyM = text.match(/^\/?(deny)\s+(\S+)/i)
    if (denyM) return adminDeny(chatId, denyM[2])

    // revoke <chatId>
    const revokeM = text.match(/^\/?(revoke)\s+(\S+)/i)
    if (revokeM) return adminRevoke(chatId, revokeM[2])

    // broadcast <message>
    const bcM = text.match(/^\/?(broadcast)\s+(.+)/is)
    if (bcM) return adminBroadcast(chatId, bcM[2])

    // setwallet usdt <address>  or  setwallet btc <address>
    const walletM = text.match(/^\/?(setwallet)\s+(usdt|btc)\s+(\S+)/i)
    if (walletM) {
      const s = loadSettings()
      const key = walletM[2].toLowerCase()==='usdt' ? 'usdt_address' : 'btc_address'
      s[key] = walletM[3]
      saveSettings(s)
      return send(chatId, `✅ ${walletM[2].toUpperCase()} wallet updated to:\n${walletM[3]}`)
    }

    // pending — list awaiting admin
    if (t==='pending'||t==='/pending') {
      const all = Object.values(loadSubs()).filter(s=>s.status==='awaiting_admin')
      if (!all.length) return send(chatId, 'No pending approvals.')
      const lines = all.map(s=>`• ${s.chatId} — ${PACKAGES[s.pendingPkg]?.label||'?'} via ${s.pendingMethod||'?'}\n  Claimed: ${s.claimedAt||'?'}\n  → approve ${s.chatId}  or  deny ${s.chatId}`)
      return send(chatId, `🔔 *Pending Approvals (${all.length})*\n\n${lines.join('\n\n')}`)
    }

    // admin help
    if (t==='admin'||t==='/admin'||t==='/help') {
      return send(chatId, `🔧 *Admin Commands*

subs              — list active subscribers
pending           — list awaiting approval
approve <id>      — confirm payment & activate
deny <id>         — reject payment
revoke <id>       — cancel subscription
broadcast <msg>   — send message to all active subs
setwallet usdt <addr>  — update USDT address
setwallet btc <addr>   — update BTC address`)
    }
  }

  // ── USER: global shortcuts ────────────────────────────────
  if (t==='hi'||t==='hello'||t==='start'||t==='menu'||t==='/'||t==='') {
    // Check expiry first
    if (sub?.status==='active' && new Date(sub.expiresAt)<new Date()) {
      upsertSub(chatId,{status:'expired'})
    }
    const freshSub = getSub(chatId)
    if (freshSub?.status==='active') {
      setScreen(chatId,'home')
      return send(chatId, `🟡 *GOLD AI*\n\n${statusMsg(freshSub)}\n\nReply *status* anytime to check your plan.`)
    }
    setScreen(chatId,'packages')
    return send(chatId, packagesMenu())
  }

  if (t==='status'||t==='/status') {
    if (sub?.status==='active' && new Date(sub.expiresAt)<new Date()) upsertSub(chatId,{status:'expired'})
    return send(chatId, statusMsg(getSub(chatId)))
  }

  if (t==='help'||t==='/help') {
    return send(chatId,
`🟡 *GOLD AI Help*

*How to subscribe:*
1. Reply *menu* to see plans
2. Pick a plan (send the number)
3. Pick payment method
4. Send crypto to the shown address
5. Reply 1 when done
6. Admin confirms → signals start

*Commands:*
  menu    — show subscription plans
  status  — check your subscription
  help    — this message

*Signal format explained:*
  BUY/SELL + Entry + SL + TP1/TP2/TP3
  Score = signal strength (higher = better)
  Tier A/B/C = confidence level`)
  }

  // ── PACKAGE SELECTION SCREEN ──────────────────────────────
  if (scr.screen==='packages') {
    const pkgs = Object.values(PACKAGES).filter(p=>p.enabled)
    const n = parseInt(t)
    if (t==='0') { setScreen(chatId,'home'); return send(chatId,'Cancelled. Reply *menu* anytime.') }
    if (isNaN(n)||n<1||n>pkgs.length) return send(chatId,`Please reply with a number 1–${pkgs.length} (or 0 to cancel).`)
    const pkg = pkgs[n-1]
    upsertSub(chatId,{ status:'pending_payment', pendingPkg:pkg.id })
    setScreen(chatId,'payment_method', { pkgId:pkg.id })
    return send(chatId, paymentMenu(pkg))
  }

  // ── PAYMENT METHOD SCREEN ─────────────────────────────────
  if (scr.screen==='payment_method') {
    const methods = Object.entries(payMethods())
    const n = parseInt(t)
    if (t==='0') { setScreen(chatId,'packages'); return send(chatId, packagesMenu()) }
    if (isNaN(n)||n<1||n>methods.length) return send(chatId,`Please reply with a number 1–${methods.length} (or 0 to go back).`)
    const [methodKey, method] = methods[n-1]
    const pkg = PACKAGES[scr.pkgId]
    upsertSub(chatId,{ pendingMethod:methodKey })
    setScreen(chatId,'awaiting_payment', { pkgId:scr.pkgId, methodKey })
    return send(chatId, paymentDetails(pkg, method, chatId))
  }

  // ── AWAITING PAYMENT CONFIRMATION SCREEN ─────────────────
  if (scr.screen==='awaiting_payment') {
    if (t==='0') {
      setScreen(chatId,'payment_method',{ pkgId:scr.pkgId })
      return send(chatId, paymentMenu(PACKAGES[scr.pkgId]))
    }
    if (t==='1') {
      const pkg = PACKAGES[scr.pkgId]
      upsertSub(chatId,{ status:'awaiting_admin', claimedAt: new Date().toISOString() })
      setScreen(chatId,'home')

      // Notify admin
      if (ADMIN_WA) {
        await send(ADMIN_WA,
`🔔 *New Payment Claim*

User: ${chatId}
Plan: ${pkg.label} — $${pkg.price}
Method: ${payMethods()[scr.methodKey]?.label||scr.methodKey}
Claimed: ${new Date().toLocaleString()}

Reply:
  approve ${chatId}
  deny ${chatId}`)
      }

      return send(chatId,
`⏳ *Payment Under Review*

Thank you! Our team will verify your payment and activate your account within 10–30 minutes.

You'll receive a message here when confirmed. 🟡`)
    }
    return send(chatId,'Reply *1* after you have sent payment, or *0* to go back.')
  }

  // ── FALLBACK ──────────────────────────────────────────────
  return send(chatId, `Reply *menu* to see subscription plans, or *status* to check your account.`)
}

// ── ADMIN ACTIONS ─────────────────────────────────────────────
async function adminApprove(adminId, targetId) {
  const sub = getSub(targetId)
  if (!sub) return send(adminId, `❌ User ${targetId} not found.`)
  const pkg = PACKAGES[sub.pendingPkg]
  if (!pkg) return send(adminId, `❌ No pending package for ${targetId}.`)

  const now = new Date(), exp = new Date(now.getTime() + pkg.days*86400000)
  upsertSub(targetId, {
    status:'active', plan:pkg.id, planLabel:pkg.label, price:pkg.price,
    activatedAt:now.toISOString(), expiresAt:exp.toISOString(),
    pendingPkg:null, pendingMethod:null,
  })
  const expStr = exp.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
  await send(adminId, `✅ Approved ${targetId} — ${pkg.label} until ${expStr}`)
  await send(targetId,
`🎉 *Payment Confirmed!*

Your *${pkg.label}* subscription is now *ACTIVE*.

✅ Expires: *${expStr}*
✅ Signals will be sent directly to this chat

Welcome to GOLD AI Premium! 🟡`)
}

async function adminDeny(adminId, targetId) {
  const sub = getSub(targetId)
  if (!sub) return send(adminId, `❌ User ${targetId} not found.`)
  const pkg = PACKAGES[sub.pendingPkg]
  upsertSub(targetId, { status:'denied', pendingPkg:null, pendingMethod:null })
  await send(adminId, `✅ Denied & notified ${targetId}.`)
  await send(targetId,
`❌ *Payment Not Confirmed*

We could not verify your payment for the ${pkg?.label||''} plan.

Common reasons:
• Wrong amount sent
• Wrong wallet/network used
• Transaction not yet broadcast

Reply *menu* to try again or contact support.`)
}

async function adminRevoke(adminId, targetId) {
  const sub = getSub(targetId)
  if (!sub) return send(adminId, `❌ User ${targetId} not found.`)
  upsertSub(targetId, { status:'expired' })
  await send(adminId, `✅ Revoked subscription for ${targetId}.`)
  await send(targetId, `❌ Your GOLD AI subscription has been cancelled by admin.\n\nReply *menu* if you believe this is an error.`)
}

async function adminBroadcast(adminId, message) {
  const subs = activeSubs()
  if (!subs.length) return send(adminId, 'No active subscribers to broadcast to.')
  let ok=0, fail=0
  for (const s of subs) {
    const r = await send(s.chatId, `📢 *GOLD AI Update*\n\n${message}`)
    r ? ok++ : fail++
    await new Promise(r=>setTimeout(r,500)) // rate-limit friendly
  }
  return send(adminId, `✅ Broadcast sent: ${ok} delivered, ${fail} failed.`)
}

// ── SIGNAL BROADCAST (called by gold-ai.mjs or externally) ───
export async function broadcastSignal(text) {
  const subs = activeSubs()
  // Check expiry on each send
  for (const s of subs) {
    if (new Date(s.expiresAt) < new Date()) { upsertSub(s.chatId,{status:'expired'}); continue }
    await send(s.chatId, text)
    await new Promise(r=>setTimeout(r,400))
  }
  console.log(`[whatsapp] signal sent to ${subs.length} subscriber(s)`)
}

// ── EXPIRY CHECK (run daily) ──────────────────────────────────
function checkExpiries() {
  const all = loadSubs()
  const now = new Date()
  for (const [id, sub] of Object.entries(all)) {
    if (sub.status==='active' && new Date(sub.expiresAt)<now) {
      upsertSub(id,{status:'expired'})
      send(id,
`⚠️ *Subscription Expired*

Your GOLD AI subscription has ended.

Reply *menu* to renew and keep receiving signals. 🟡`)
    }
  }
}

// ── POLLING LOOP ─────────────────────────────────────────────
async function poll() {
  console.log(`[${new Date().toISOString()}] WhatsApp bot polling… (instance ${INSTANCE})`)
  let lastExpiry = Date.now()

  while (true) {
    try {
      const notif = await receiveOne()

      if (!notif) {
        await new Promise(r=>setTimeout(r,1500))
      } else {
        const { receiptId, body } = notif

        // Only handle inbound text messages
        if (body?.typeWebhook === 'incomingMessageReceived' &&
            body?.messageData?.typeMessage === 'textMessage') {
          const chatId  = body.senderData?.chatId  || ''
          const text    = body.messageData?.textMessageData?.textMessage || ''
          console.log(`[msg] ${chatId}: ${text.slice(0,80)}`)
          await handleMessage(chatId, text)
        }

        await deleteNotification(receiptId)
        await new Promise(r=>setTimeout(r,300))
      }

      // Check expiries every hour
      if (Date.now()-lastExpiry > 3600000) { checkExpiries(); lastExpiry=Date.now() }

    } catch(e) {
      console.error('Poll error:', e.message)
      await new Promise(r=>setTimeout(r,5000))
    }
  }
}

// ── ENTRY POINT ───────────────────────────────────────────────
console.log('🟡 GOLD AI WhatsApp Bot starting…')
console.log(`   Instance : ${INSTANCE}`)
console.log(`   Admin WA : ${ADMIN_WA||'(not set)'}`)
console.log(`   Packages : ${Object.values(PACKAGES).filter(p=>p.enabled).map(p=>p.label).join(', ')}`)
if (!ADMIN_WA) console.warn('⚠️  ADMIN_WA not set — payment claim notifications will not be sent to admin.')

poll()
