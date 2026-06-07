// ─────────────────────────────────────────────────────────────────────────────
//  GOLD.AI — Subscription Bot  (bot-subscription.mjs)
//  Handles: /start → package selection → payment → channel check → signals
//
//  Run alongside gold-ai.mjs:
//    node bot-subscription.mjs          ← keeps polling for user commands
//    node gold-ai.mjs check             ← sends signals (calls broadcastSignal)
//
//  Or run both from one process:
//    node launcher.mjs
//
//  ENV VARS NEEDED:
//    TG_TOKEN          — bot token from @BotFather
//    ADMIN_CHAT_ID     — your personal chat ID (you get admin commands)
//    CHANNEL_USERNAME  — e.g. @GoldAISignals  (members-only channel)
//    USDT_ADDRESS      — your TRC-20/ERC-20 USDT wallet
//    BTC_ADDRESS       — your Bitcoin address
//    NOWPAYMENTS_KEY   — (optional) NOWPayments API key for auto-confirm
//
//  Storage: ./subscribers.json   (one file, no DB needed)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs'

// ── ENV ───────────────────────────────────────────────────────────────────────
const TG_TOKEN        = process.env.TG_TOKEN        || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const ADMIN_ID        = process.env.ADMIN_CHAT_ID   || '1408577116'
const CHANNEL         = process.env.CHANNEL_USERNAME || '@MH_Signals'
const USDT_ADDRESS    = process.env.USDT_ADDRESS    || 'TEST_USDT_ADDRESS'
const BTC_ADDRESS     = process.env.BTC_ADDRESS     || 'TEST_BTC_ADDRESS'
const NOWPAY_KEY      = process.env.NOWPAYMENTS_KEY || ''
const SUB_FILE        = './subscribers.json'

if (!TG_TOKEN) { console.error('❌  TG_TOKEN not set'); process.exit(1) }

// ── PACKAGES ──────────────────────────────────────────────────────────────────
const PACKAGES = {
  p1: { id:'p1', label:'1 Month',  price:50,  days:30  },
  p2: { id:'p2', label:'3 Months', price:120, days:90  },
  p3: { id:'p3', label:'6 Months', price:200, days:180 },
}

// ── PAYMENT METHODS ───────────────────────────────────────────────────────────
const PAY_METHODS = {
  usdt: { label:'💵 USDT (TRC-20)', address: USDT_ADDRESS, coin:'USDT' },
  btc:  { label:'₿  Bitcoin',       address: BTC_ADDRESS,  coin:'BTC'  },
  // card: { label:'💳 Credit Card',  link: 'https://your-stripe-link.com' },  ← uncomment to add Stripe
}

// ── STORAGE ───────────────────────────────────────────────────────────────────
function loadSubs() {
  try { return JSON.parse(fs.readFileSync(SUB_FILE, 'utf8')) }
  catch { return {} }
}
function saveSubs(data) {
  fs.writeFileSync(SUB_FILE, JSON.stringify(data, null, 2))
}
function getSub(chatId) { return loadSubs()[String(chatId)] || null }
function upsertSub(chatId, patch) {
  const data = loadSubs()
  const key  = String(chatId)
  data[key]  = { ...data[key], ...patch, chatId: String(chatId), updatedAt: new Date().toISOString() }
  saveSubs(data)
  return data[key]
}
function isActive(sub) {
  if (!sub || sub.status !== 'active') return false
  return new Date(sub.expiresAt) > new Date()
}
function activeSubscribers() {
  const data = loadSubs()
  return Object.values(data).filter(s => isActive(s))
}

// ── TELEGRAM API ──────────────────────────────────────────────────────────────
const API = `https://api.telegram.org/bot${TG_TOKEN}`

async function tgCall(method, body = {}) {
  const res = await fetch(`${API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const j = await res.json()
  if (!j.ok) console.error(`[TG] ${method} failed:`, j.description)
  return j
}

async function send(chatId, text, extra = {}) {
  return tgCall('sendMessage', { chat_id: chatId, text, parse_mode: 'HTML', ...extra })
}

async function sendInline(chatId, text, buttons) {
  // buttons = [[{text, callback_data}], [...]]  — 2D array = rows
  return send(chatId, text, {
    reply_markup: { inline_keyboard: buttons },
  })
}

async function editMsg(chatId, messageId, text, buttons = null) {
  const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' }
  if (buttons) body.reply_markup = { inline_keyboard: buttons }
  return tgCall('editMessageText', body)
}

async function answerCb(cbId, text = '') {
  return tgCall('answerCallbackQuery', { callback_query_id: cbId, text })
}

// Check if user is a member of the required channel
async function isMember(chatId) {
  try {
    const r = await tgCall('getChatMember', { chat_id: CHANNEL, user_id: chatId })
    return ['member','administrator','creator'].includes(r.result?.status)
  } catch { return false }
}

// ── FLOW SCREENS ──────────────────────────────────────────────────────────────

// /start — welcome + package picker
async function screenStart(chatId, firstName) {
  const sub = getSub(chatId)

  // Already active subscriber → show status
  if (isActive(sub)) {
    const exp = new Date(sub.expiresAt).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})
    return send(chatId,
`✅ <b>Welcome back, ${firstName}!</b>

Your subscription is <b>active</b> until <b>${exp}</b>.

You are receiving XAUUSD signals automatically. 🟡

/status — check subscription details
/help   — how to read signals`)
  }

  // Pending payment reminder
  if (sub?.status === 'pending_payment') {
    return screenPayment(chatId, sub.pendingPkg, sub.pendingMethod, sub.msgId)
  }

  const rows = Object.values(PACKAGES).map(p => [{
    text: `📦 ${p.label} — $${p.price}`,
    callback_data: `pkg_${p.id}`,
  }])

  return sendInline(chatId,
`🟡 <b>GOLD AI — Premium Signals</b>

Real-time XAUUSD trading signals powered by multi-timeframe analysis.

✅ 15m + 1h signals
✅ Entry, SL, TP1/TP2/TP3 included
✅ Score, regime & session context
✅ Instant Telegram delivery

<b>Choose your subscription plan:</b>`,
    rows
  )
}

// Package selected → show payment methods
async function screenPickPayment(chatId, pkgId, msgId) {
  const pkg = PACKAGES[pkgId]
  if (!pkg) return

  upsertSub(chatId, { status: 'pending_payment', pendingPkg: pkgId, msgId })

  const rows = Object.entries(PAY_METHODS).map(([key, m]) => [{
    text: m.label,
    callback_data: `pay_${pkgId}_${key}`,
  }])
  rows.push([{ text: '⬅️ Back', callback_data: 'back_packages' }])

  await editMsg(chatId, msgId,
`📦 <b>${pkg.label} Plan — $${pkg.price}</b>

Choose your payment method:`,
    rows
  )
}

// Payment method selected → show address + instructions
async function screenPayment(chatId, pkgId, methodKey, msgId) {
  const pkg = PACKAGES[pkgId]
  const method = PAY_METHODS[methodKey]
  if (!pkg || !method) return

  upsertSub(chatId, {
    status: 'pending_payment',
    pendingPkg: pkgId,
    pendingMethod: methodKey,
    msgId,
  })

  const rows = [
    [{ text: '✅ I Sent the Payment', callback_data: `confirm_${pkgId}_${methodKey}` }],
    [{ text: '⬅️ Back to Methods',   callback_data: `pkg_${pkgId}` }],
  ]

  await editMsg(chatId, msgId,
`💳 <b>Payment Instructions</b>

Plan: <b>${pkg.label} — $${pkg.price}</b>
Method: <b>${method.label}</b>

Send exactly <b>$${pkg.price} worth of ${method.coin}</b> to:

<code>${method.address}</code>

⚠️ <b>Important:</b>
• Send the exact amount — no partial payments
• Include your Telegram ID <code>${chatId}</code> in the memo/note if possible
• Payment confirms within 10–30 min
• Do NOT close this chat

After sending, press <b>"I Sent the Payment"</b> below.`,
    rows
  )
}

// User claims payment sent → ask them to join channel first
async function screenConfirmPending(chatId, pkgId, methodKey, msgId) {
  const pkg = PACKAGES[pkgId]

  upsertSub(chatId, {
    status: 'awaiting_admin',
    pendingPkg: pkgId,
    pendingMethod: methodKey,
    msgId,
    claimedAt: new Date().toISOString(),
  })

  // Notify admin
  const sub = getSub(chatId)
  if (ADMIN_ID) {
    await send(ADMIN_ID,
`🔔 <b>New Payment Claim</b>

User: <a href="tg://user?id=${chatId}">${chatId}</a>
Plan: ${pkg.label} — $${pkg.price}
Method: ${PAY_METHODS[methodKey]?.label}
Claimed: ${new Date().toLocaleString()}

Use: /approve ${chatId}  or  /deny ${chatId}`)
  }

  const rows = [
    [{ text: `✅ Join ${CHANNEL}`, url: `https://t.me/${CHANNEL.replace('@','')}` }],
    [{ text: '🔄 I Joined — Check My Status', callback_data: `checkjoin_${pkgId}_${methodKey}` }],
  ]

  await editMsg(chatId, msgId,
`⏳ <b>Payment Under Review</b>

Thank you! Your payment is being verified.

<b>While you wait, please join our signals channel:</b>
${CHANNEL}

You <b>must</b> be a member to receive signals.
Once you join and your payment is confirmed, signals start automatically.`,
    rows
  )
}

// User pressed "I Joined" → check membership
async function screenCheckJoin(chatId, pkgId, methodKey, msgId) {
  const joined = await isMember(chatId)
  const sub = getSub(chatId)

  if (!joined) {
    const rows = [
      [{ text: `✅ Join ${CHANNEL}`, url: `https://t.me/${CHANNEL.replace('@','')}` }],
      [{ text: '🔄 Check Again', callback_data: `checkjoin_${pkgId}_${methodKey}` }],
    ]
    return editMsg(chatId, msgId,
`❌ <b>Not joined yet</b>

We couldn't detect your membership in ${CHANNEL}.

Please tap the button below to join first, then check again.`,
      rows
    )
  }

  upsertSub(chatId, { joinedChannel: true })

  if (sub?.status === 'active') {
    return editMsg(chatId, msgId,
`🎉 <b>You're all set!</b>

✅ Channel joined
✅ Subscription active

Signals will arrive here automatically. Good luck! 🟡`)
  }

  return editMsg(chatId, msgId,
`✅ <b>Channel joined!</b>

Your payment is still being reviewed by our team.
You'll get a message here as soon as it's confirmed.

Usually takes 10–30 minutes.`)
}

// Admin: /approve <chatId>
async function adminApprove(adminChatId, targetId) {
  const sub = getSub(targetId)
  if (!sub) return send(adminChatId, `❌ User ${targetId} not found.`)

  // Debug: show current sub state
  console.log('[approve] sub record:', JSON.stringify(sub))

  // If already active, just confirm
  if (sub.status === 'active' && sub.expiresAt && new Date(sub.expiresAt) > new Date()) {
    return send(adminChatId, `ℹ️ User ${targetId} is already active until ${new Date(sub.expiresAt).toLocaleDateString()}`)
  }

  // Try pendingPkg first, fall back to last known plan, then default to p1
  const pkgId = sub.pendingPkg || sub.plan || 'p1'
  const pkg = PACKAGES[pkgId]
  if (!pkg) return send(adminChatId, `❌ No package found for ${targetId}. Sub: ${JSON.stringify(sub)}`)

  const now   = new Date()
  const exp   = new Date(now.getTime() + pkg.days * 86400000)
  upsertSub(targetId, {
    status: 'active',
    plan: pkg.id,
    planLabel: pkg.label,
    price: pkg.price,
    activatedAt: now.toISOString(),
    expiresAt: exp.toISOString(),
    pendingPkg: null,
    pendingMethod: null,
  })

  const expStr = exp.toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})

  await send(adminChatId, `✅ Approved ${targetId} — ${pkg.label} until ${expStr}`)

  await send(targetId,
`🎉 <b>Payment Confirmed!</b>

Your <b>${pkg.label}</b> subscription is now <b>ACTIVE</b>.

✅ Expires: <b>${expStr}</b>
✅ Signals are being sent to this chat
✅ Make sure you're in ${CHANNEL} too

Welcome to GOLD AI Premium! 🟡`)
}

// Admin: /deny <chatId>
async function adminDeny(adminChatId, targetId) {
  const sub = getSub(targetId)
  if (!sub) return send(adminChatId, `❌ User ${targetId} not found.`)

  upsertSub(targetId, { status: 'denied', pendingPkg: null, pendingMethod: null })

  await send(adminChatId, `✅ Denied & notified ${targetId}.`)
  await send(targetId,
`❌ <b>Payment Not Confirmed</b>

We could not verify your payment for the ${PACKAGES[sub.pendingPkg]?.label || ''} plan.

Common reasons:
• Wrong amount sent
• Wrong wallet/network used
• Transaction not yet broadcast

Please try again or contact support.

/start — try again`)
}

// Admin: /revoke <chatId>
async function adminRevoke(adminChatId, targetId) {
  upsertSub(targetId, { status: 'revoked', expiresAt: new Date().toISOString() })
  await send(adminChatId, `✅ Revoked ${targetId}.`)
  await send(targetId,
`⚠️ Your GOLD AI subscription has been revoked.
Contact support if you think this is an error.`)
}

// Admin: /subs — list all active
async function adminListSubs(adminChatId) {
  const subs = activeSubscribers()
  if (!subs.length) return send(adminChatId, 'No active subscribers.')
  const lines = subs.map(s => {
    const exp = new Date(s.expiresAt).toLocaleDateString()
    return `• <code>${s.chatId}</code> — ${s.planLabel || s.plan} — expires ${exp}`
  })
  return send(adminChatId, `<b>Active Subscribers (${subs.length})</b>\n\n${lines.join('\n')}`)
}

// /status command
async function screenStatus(chatId) {
  const sub = getSub(chatId)
  if (!sub || sub.status === 'denied' || !sub.status) {
    return send(chatId, 'You don\'t have an active subscription.\n\n/start — view plans')
  }
  if (sub.status === 'awaiting_admin') {
    return send(chatId, '⏳ Your payment is still under review. We\'ll notify you shortly.')
  }
  if (sub.status === 'pending_payment') {
    return send(chatId, '⚠️ You have an incomplete payment.\n\n/start — resume checkout')
  }
  if (isActive(sub)) {
    const exp = new Date(sub.expiresAt).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})
    const daysLeft = Math.ceil((new Date(sub.expiresAt) - new Date()) / 86400000)
    return send(chatId,
`📊 <b>Your Subscription</b>

Plan: <b>${sub.planLabel || sub.plan}</b>
Status: ✅ Active
Expires: <b>${exp}</b> (${daysLeft} days left)

Signals are being delivered to this chat.`)
  }
  return send(chatId, '❌ Your subscription has expired.\n\n/start — renew')
}

// ── BROADCAST SIGNAL (called from gold-ai.mjs or launcher) ───────────────────
export async function broadcastSignal(sigText) {
  const subs = activeSubscribers()
  let sent = 0, failed = 0
  for (const sub of subs) {
    try {
      const res = await fetch(`${API}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: sub.chatId, text: sigText, parse_mode: 'HTML' }),
      })
      const j = await res.json()
      if (j.ok) sent++
      else {
        failed++
        // If bot was blocked or user doesn't exist → deactivate
        if (['blocked','kicked','deactivated','not_found'].some(w => j.description?.toLowerCase().includes(w))) {
          upsertSub(sub.chatId, { status: 'bot_blocked' })
        }
      }
    } catch { failed++ }
    await new Promise(r => setTimeout(r, 50)) // 50ms between sends = ~20/s, well under TG limits
  }
  console.log(`[broadcast] sent=${sent} failed=${failed} total=${subs.length}`)
  return { sent, failed }
}

// ── UPDATE ROUTER ─────────────────────────────────────────────────────────────
async function handleUpdate(upd) {

  // ── TEXT MESSAGES / COMMANDS ──
  if (upd.message) {
    const msg      = upd.message
    const chatId   = String(msg.chat.id)
    const text     = msg.text || ''
    const isAdmin  = chatId === String(ADMIN_ID)
    const firstName= msg.from?.first_name || 'there'

    if (text === '/start')  return screenStart(chatId, firstName)
    if (text === '/status') return screenStatus(chatId)
    if (text === '/help')   return send(chatId,
`📖 <b>How to read GOLD AI signals</b>

When you get a signal it looks like:
<code>🟡 GOLD 15M — BUY (score 72/100 A)
Entry $2340.50 · SL $2332.00
TP1 $2353 · TP2 $2362 · TP3 $2374
Size: 1.23 units · $100 risk</code>

• <b>Entry</b> — open near this price
• <b>SL</b> — stop loss (your max risk)
• <b>TP1/TP2/TP3</b> — take profits in thirds
• <b>Score</b> — signal confidence 45–100
• <b>A/B/C tier</b> — A is strongest

Always use a broker with tight XAUUSD spreads.`)

    // ── ADMIN COMMANDS ──
    if (isAdmin) {
      const parts = text.split(' ')
      if (parts[0] === '/approve' && parts[1]) return adminApprove(chatId, parts[1])
      if (parts[0] === '/deny'    && parts[1]) return adminDeny(chatId, parts[1])
      if (parts[0] === '/revoke'  && parts[1]) return adminRevoke(chatId, parts[1])
      if (parts[0] === '/check'   && parts[1]) {
        const s = getSub(parts[1])
        return send(chatId, s ? `<pre>${JSON.stringify(s,null,2)}</pre>` : `❌ Not found: ${parts[1]}`)
      }
      if (text === '/subs')                    return adminListSubs(chatId)
      if (text === '/admin') return send(chatId,
`🔧 <b>Admin Commands</b>

/subs              — list active subscribers
/approve &lt;id&gt;      — activate a user
/deny &lt;id&gt;         — deny & notify user
/revoke &lt;id&gt;       — cancel subscription`)
    }

    return // ignore unknown commands
  }

  // ── CALLBACK QUERIES (inline button taps) ──
  if (upd.callback_query) {
    const cb     = upd.callback_query
    const chatId = String(cb.message.chat.id)
    const msgId  = cb.message.message_id
    const data   = cb.data || ''
    await answerCb(cb.id)

    if (data === 'back_packages') return screenStart(chatId, '')

    // pkg_p1 / pkg_p2 / pkg_p3
    const pkgMatch = data.match(/^pkg_(\w+)$/)
    if (pkgMatch) return screenPickPayment(chatId, pkgMatch[1], msgId)

    // pay_p1_usdt / pay_p2_btc etc.
    const payMatch = data.match(/^pay_(\w+)_(\w+)$/)
    if (payMatch) return screenPayment(chatId, payMatch[1], payMatch[2], msgId)

    // confirm_p1_usdt
    const confMatch = data.match(/^confirm_(\w+)_(\w+)$/)
    if (confMatch) return screenConfirmPending(chatId, confMatch[1], confMatch[2], msgId)

    // checkjoin_p1_usdt
    const joinMatch = data.match(/^checkjoin_(\w+)_(\w+)$/)
    if (joinMatch) return screenCheckJoin(chatId, joinMatch[1], joinMatch[2], msgId)
  }
}

// ── LONG POLLING LOOP ─────────────────────────────────────────────────────────
async function startPolling() {
  console.log('🤖 Gold AI Subscription Bot started')
  console.log(`   Channel: ${CHANNEL}`)
  console.log(`   Admin:   ${ADMIN_ID || '(not set)'}`)
  console.log(`   Plans:   ${Object.values(PACKAGES).map(p=>`${p.label}=$${p.price}`).join(', ')}`)
  console.log(`   USDT:    ${USDT_ADDRESS.slice(0,12)}…`)

  let offset = 0
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=30&allowed_updates=["message","callback_query"]`)
      const j   = await res.json()
      if (!j.ok) { await sleep(5000); continue }
      for (const upd of j.result || []) {
        offset = upd.update_id + 1
        handleUpdate(upd).catch(e => console.error('[update error]', e.message))
      }
    } catch (e) {
      console.error('[poll error]', e.message)
      await sleep(5000)
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── EXPIRY CHECKER (runs every hour, warns users 3 days before) ──────────────
async function runExpiryChecker() {
  setInterval(async () => {
    const data = loadSubs()
    const now  = new Date()
    for (const sub of Object.values(data)) {
      if (sub.status !== 'active') continue
      const exp  = new Date(sub.expiresAt)
      const days = Math.ceil((exp - now) / 86400000)

      // 3-day warning (fire once)
      if (days === 3 && !sub.warned3d) {
        upsertSub(sub.chatId, { warned3d: true })
        await send(sub.chatId,
`⚠️ <b>Subscription Expiring Soon</b>

Your <b>${sub.planLabel}</b> plan expires in <b>3 days</b>.

Renew now to keep receiving signals:
/start — view renewal plans`).catch(()=>{})
      }

      // Expired → deactivate
      if (exp <= now && sub.status === 'active') {
        upsertSub(sub.chatId, { status: 'expired' })
        await send(sub.chatId,
`❌ <b>Subscription Expired</b>

Your access to GOLD AI signals has ended.

/start — renew your subscription`).catch(()=>{})
      }
    }
  }, 60 * 60 * 1000) // every hour
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
runExpiryChecker()
startPolling()
