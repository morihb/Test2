// ─────────────────────────────────────────────────────────────────────────────
//  GOLD.AI — Subscription Bot  (bot-subscription.mjs)  v2 — with Package Manager
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs'

// ── ENV ───────────────────────────────────────────────────────────────────────
const TG_TOKEN     = process.env.TG_TOKEN        || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const ADMIN_ID     = process.env.ADMIN_CHAT_ID   || '1408577116'
const CHANNEL      = process.env.CHANNEL_USERNAME || '@MH_Signals'
const SUB_FILE      = './subscribers.json'
const PKG_FILE      = './packages.json'
const SETTINGS_FILE = './settings.json'

// ── SETTINGS (wallets etc — editable from Telegram) ──────────────────────────
const DEFAULT_SETTINGS = {
  usdt_address: process.env.USDT_ADDRESS || 'TEST_USDT_ADDRESS',
  btc_address:  process.env.BTC_ADDRESS  || 'TEST_BTC_ADDRESS',
}
function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) } }
  catch { return DEFAULT_SETTINGS }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)) }
function getSetting(k) { return loadSettings()[k] }

if (!TG_TOKEN) { console.error('❌  TG_TOKEN not set'); process.exit(1) }

// ── PACKAGES (dynamic — saved to packages.json, editable from Telegram) ───────
const DEFAULT_PACKAGES = {
  p1: { id:'p1', label:'1 Month',  price:50,  days:30,  active:true },
  p2: { id:'p2', label:'3 Months', price:120, days:90,  active:true },
  p3: { id:'p3', label:'6 Months', price:200, days:180, active:true },
}

function loadPackages() {
  try { return JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')) }
  catch { savePackages(DEFAULT_PACKAGES); return DEFAULT_PACKAGES }
}
function savePackages(pkgs) {
  fs.writeFileSync(PKG_FILE, JSON.stringify(pkgs, null, 2))
}
function getActivePackages() {
  return Object.values(loadPackages()).filter(p => p.active !== false)
}
function getPackage(id) {
  return loadPackages()[id] || null
}
function nextPkgId() {
  const ids = Object.keys(loadPackages()).map(k => parseInt(k.replace('p',''))).filter(n => !isNaN(n))
  return `p${ids.length ? Math.max(...ids) + 1 : 1}`
}

// ── PAYMENT METHODS (dynamic — reads from settings.json) ──────────────────────
function getPayMethods() {
  const s = loadSettings()
  return {
    usdt: { label:'💵 USDT (TRC-20)', address: s.usdt_address, coin:'USDT' },
    btc:  { label:'₿  Bitcoin',       address: s.btc_address,  coin:'BTC'  },
  }
}

// ── STORAGE ───────────────────────────────────────────────────────────────────
function loadSubs() {
  try { return JSON.parse(fs.readFileSync(SUB_FILE, 'utf8')) }
  catch { return {} }
}
function saveSubs(data) { fs.writeFileSync(SUB_FILE, JSON.stringify(data, null, 2)) }
function getSub(chatId) { return loadSubs()[String(chatId)] || null }
function upsertSub(chatId, patch) {
  const data = loadSubs(), key = String(chatId)
  data[key] = { ...data[key], ...patch, chatId: String(chatId), updatedAt: new Date().toISOString() }
  saveSubs(data); return data[key]
}
function isActive(sub) {
  if (!sub || sub.status !== 'active') return false
  return new Date(sub.expiresAt) > new Date()
}
function activeSubscribers() {
  return Object.values(loadSubs()).filter(s => isActive(s))
}

// ── ADMIN SESSION (tracks multi-step input state per admin) ───────────────────
const adminSession = {}   // { chatId: { step, data } }
function setSession(chatId, step, data = {}) { adminSession[chatId] = { step, data } }
function getSession(chatId) { return adminSession[chatId] || null }
function clearSession(chatId) { delete adminSession[chatId] }

// ── TELEGRAM API ──────────────────────────────────────────────────────────────
const API = `https://api.telegram.org/bot${TG_TOKEN}`
async function tgCall(method, body = {}) {
  const res = await fetch(`${API}/${method}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })
  const j = await res.json()
  if (!j.ok) console.error(`[TG] ${method} failed:`, j.description)
  return j
}
async function send(chatId, text, extra = {}) {
  return tgCall('sendMessage', { chat_id:chatId, text, parse_mode:'HTML', ...extra })
}
async function sendInline(chatId, text, buttons) {
  return send(chatId, text, { reply_markup:{ inline_keyboard:buttons } })
}
async function editMsg(chatId, messageId, text, buttons = null) {
  const body = { chat_id:chatId, message_id:messageId, text, parse_mode:'HTML' }
  if (buttons) body.reply_markup = { inline_keyboard:buttons }
  return tgCall('editMessageText', body)
}
async function answerCb(cbId, text = '') {
  return tgCall('answerCallbackQuery', { callback_query_id:cbId, text })
}
async function isMember(chatId) {
  try {
    const r = await tgCall('getChatMember', { chat_id:CHANNEL, user_id:chatId })
    return ['member','administrator','creator'].includes(r.result?.status)
  } catch { return false }
}

// ─────────────────────────────────────────────────────────────────────────────
//  USER FLOW SCREENS
// ─────────────────────────────────────────────────────────────────────────────

async function screenStart(chatId, firstName) {
  const sub = getSub(chatId)
  if (isActive(sub)) {
    const exp = new Date(sub.expiresAt).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})
    return send(chatId,
`✅ <b>Welcome back, ${firstName}!</b>

Your subscription is <b>active</b> until <b>${exp}</b>.
Signals are being sent to this chat 🟡

/status — subscription details
/help   — how to read signals`)
  }
  if (sub?.status === 'pending_payment') {
    return screenPayment(chatId, sub.pendingPkg, sub.pendingMethod, sub.msgId)
  }
  const pkgs = getActivePackages()
  if (!pkgs.length) return send(chatId, '⚠️ No plans available right now. Please check back soon.')
  const rows = pkgs.map(p => [{ text:`📦 ${p.label} — $${p.price}`, callback_data:`pkg_${p.id}` }])
  return sendInline(chatId,
`🟡 <b>GOLD AI — Premium Signals</b>

Real-time XAUUSD trading signals powered by multi-timeframe analysis.

✅ 15m + 1h signals
✅ Entry, SL, TP1 / TP2 / TP3 included
✅ Score, regime & session context
✅ Instant Telegram delivery

<b>Choose your subscription plan:</b>`, rows)
}

async function screenPickPayment(chatId, pkgId, msgId) {
  const pkg = getPackage(pkgId)
  if (!pkg) return
  upsertSub(chatId, { status:'pending_payment', pendingPkg:pkgId, msgId })
  const rows = Object.entries(getPayMethods()).map(([key, m]) => [{ text:m.label, callback_data:`pay_${pkgId}_${key}` }])
  rows.push([{ text:'⬅️ Back', callback_data:'back_packages' }])
  await editMsg(chatId, msgId, `📦 <b>${pkg.label} Plan — $${pkg.price}</b>\n\nChoose your payment method:`, rows)
}

async function screenPayment(chatId, pkgId, methodKey, msgId) {
  const pkg = getPackage(pkgId), method = getPayMethods()[methodKey]
  if (!pkg || !method) return
  upsertSub(chatId, { status:'pending_payment', pendingPkg:pkgId, pendingMethod:methodKey, msgId })
  const rows = [
    [{ text:'✅ I Sent the Payment', callback_data:`confirm_${pkgId}_${methodKey}` }],
    [{ text:'⬅️ Back to Methods',   callback_data:`pkg_${pkgId}` }],
  ]
  await editMsg(chatId, msgId,
`💳 <b>Payment Instructions</b>

Plan: <b>${pkg.label} — $${pkg.price}</b>
Method: <b>${method.label}</b>

Send exactly <b>$${pkg.price} worth of ${method.coin}</b> to:

<code>${method.address}</code>

⚠️ <b>Important:</b>
• Send the exact amount
• Include your Telegram ID <code>${chatId}</code> in memo if possible
• Payment confirms within 10–30 min

After sending, press <b>"I Sent the Payment"</b> below.`, rows)
}

async function screenConfirmPending(chatId, pkgId, methodKey, msgId) {
  const pkg = getPackage(pkgId)
  upsertSub(chatId, { status:'awaiting_admin', pendingPkg:pkgId, pendingMethod:methodKey, msgId, claimedAt:new Date().toISOString() })
  if (ADMIN_ID) {
    await send(ADMIN_ID,
`🔔 <b>New Payment Claim</b>

User: <a href="tg://user?id=${chatId}">${chatId}</a>
Plan: ${pkg?.label} — $${pkg?.price}
Method: ${getPayMethods()[methodKey]?.label}
Claimed: ${new Date().toLocaleString()}

/approve ${chatId}  or  /deny ${chatId}`)
  }
  const rows = [
    [{ text:`✅ Join ${CHANNEL}`, url:`https://t.me/${CHANNEL.replace('@','')}` }],
    [{ text:'🔄 I Joined — Check My Status', callback_data:`checkjoin_${pkgId}_${methodKey}` }],
  ]
  await editMsg(chatId, msgId,
`⏳ <b>Payment Under Review</b>

Thank you! Your payment is being verified.

<b>While you wait, please join our signals channel:</b>
${CHANNEL}

You <b>must</b> be a member to receive signals.`, rows)
}

async function screenCheckJoin(chatId, pkgId, methodKey, msgId) {
  const joined = await isMember(chatId), sub = getSub(chatId)
  if (!joined) {
    const rows = [
      [{ text:`✅ Join ${CHANNEL}`, url:`https://t.me/${CHANNEL.replace('@','')}` }],
      [{ text:'🔄 Check Again', callback_data:`checkjoin_${pkgId}_${methodKey}` }],
    ]
    return editMsg(chatId, msgId,
`❌ <b>Not joined yet</b>

We couldn't detect your membership in ${CHANNEL}.
Please join first then check again.`, rows)
  }
  upsertSub(chatId, { joinedChannel:true })
  if (sub?.status === 'active') {
    return editMsg(chatId, msgId, `🎉 <b>You're all set!</b>\n\n✅ Channel joined\n✅ Subscription active\n\nSignals will arrive here automatically. 🟡`)
  }
  return editMsg(chatId, msgId, `✅ <b>Channel joined!</b>\n\nYour payment is still being reviewed.\nYou'll get a message here as soon as it's confirmed.\n\nUsually takes 10–30 minutes.`)
}

async function screenStatus(chatId) {
  const sub = getSub(chatId)
  if (!sub || sub.status === 'denied' || !sub.status) return send(chatId, 'You don\'t have an active subscription.\n\n/start — view plans')
  if (sub.status === 'awaiting_admin') return send(chatId, '⏳ Your payment is still under review. We\'ll notify you shortly.')
  if (sub.status === 'pending_payment') return send(chatId, '⚠️ You have an incomplete payment.\n\n/start — resume checkout')
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

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — PACKAGE MANAGER
// ─────────────────────────────────────────────────────────────────────────────

async function screenPackageManager(chatId) {
  const pkgs = Object.values(loadPackages())
  const rows = pkgs.map(p => [{
    text: `${p.active !== false ? '✅' : '❌'} ${p.label} — $${p.price} (${p.days}d)`,
    callback_data: `adm_pkg_view_${p.id}`
  }])
  rows.push([{ text:'➕ Add New Package', callback_data:'adm_pkg_add' }])
  rows.push([{ text:'⬅️ Back to Admin',   callback_data:'adm_home'   }])
  return sendInline(chatId, `📦 <b>Package Manager</b>\n\nTap a package to edit or toggle it:`, rows)
}

async function screenPackageView(chatId, pkgId, msgId) {
  const pkg = getPackage(pkgId)
  if (!pkg) return
  const status = pkg.active !== false ? '✅ Active (users can see it)' : '❌ Hidden (users cannot see it)'
  const rows = [
    [{ text:'✏️ Edit Label',  callback_data:`adm_pkg_edit_label_${pkgId}` },
     { text:'💰 Edit Price',  callback_data:`adm_pkg_edit_price_${pkgId}` }],
    [{ text:'📅 Edit Days',   callback_data:`adm_pkg_edit_days_${pkgId}` },
     { text: pkg.active !== false ? '🚫 Disable' : '✅ Enable', callback_data:`adm_pkg_toggle_${pkgId}` }],
    [{ text:'🗑️ Delete Package', callback_data:`adm_pkg_delete_${pkgId}` }],
    [{ text:'⬅️ Back',          callback_data:'adm_pkg_list'              }],
  ]
  await editMsg(chatId, msgId,
`📦 <b>Package: ${pkg.label}</b>

ID: <code>${pkg.id}</code>
Price: <b>$${pkg.price}</b>
Duration: <b>${pkg.days} days</b>
Status: ${status}`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — HOME PANEL
// ─────────────────────────────────────────────────────────────────────────────

async function screenAdminHome(chatId) {
  const subs   = activeSubscribers()
  const allData = Object.values(loadSubs())
  const pending = allData.filter(s => s.status === 'awaiting_admin').length
  const pkgs   = getActivePackages()
  const rows = [
    [{ text:`👥 Subscribers (${subs.length} active)`, callback_data:'adm_subs'     }],
    [{ text:`📦 Packages (${pkgs.length} active)`,    callback_data:'adm_pkg_list' }],
    [{ text:`⏳ Pending Approvals (${pending})`,       callback_data:'adm_pending'  }],
    [{ text:'📢 Broadcast Message',                    callback_data:'adm_broadcast'}],
    [{ text:'💳 Payment Addresses',                    callback_data:'adm_wallets'  }],
  ]
  return sendInline(chatId,
`🔧 <b>GOLD AI Admin Panel</b>

Active subscribers: <b>${subs.length}</b>
Pending approvals: <b>${pending}</b>
Active packages: <b>${pkgs.length}</b>

Choose an action:`, rows)
}

async function screenAdminSubs(chatId, msgId) {
  const subs = activeSubscribers()
  if (!subs.length) return editMsg(chatId, msgId, 'No active subscribers.', [[{ text:'⬅️ Back', callback_data:'adm_home' }]])
  const lines = subs.map(s => {
    const exp = new Date(s.expiresAt).toLocaleDateString()
    return `• <code>${s.chatId}</code> — ${s.planLabel || s.plan} — ${exp}`
  })
  await editMsg(chatId, msgId,
`👥 <b>Active Subscribers (${subs.length})</b>\n\n${lines.join('\n')}`,
    [[{ text:'⬅️ Back', callback_data:'adm_home' }]])
}

async function screenAdminPending(chatId, msgId) {
  const pending = Object.values(loadSubs()).filter(s => s.status === 'awaiting_admin')
  if (!pending.length) return editMsg(chatId, msgId, '✅ No pending approvals.', [[{ text:'⬅️ Back', callback_data:'adm_home' }]])
  const rows = pending.map(s => ([
    { text:`✅ Approve ${s.chatId}`, callback_data:`adm_approve_${s.chatId}` },
    { text:`❌ Deny`,                callback_data:`adm_deny_${s.chatId}`    },
  ]))
  rows.push([{ text:'⬅️ Back', callback_data:'adm_home' }])
  const lines = pending.map(s => `• <code>${s.chatId}</code> — ${getPackage(s.pendingPkg)?.label || s.pendingPkg} — ${s.pendingMethod?.toUpperCase()} — ${new Date(s.claimedAt || s.updatedAt).toLocaleString()}`)
  await editMsg(chatId, msgId, `⏳ <b>Pending Approvals (${pending.length})</b>\n\n${lines.join('\n')}`, rows)
}

async function screenAdminWallets(chatId, msgId) {
  const s = loadSettings()
  const rows = [
    [{ text:'✏️ Edit USDT Address', callback_data:'adm_wallet_edit_usdt' }],
    [{ text:'✏️ Edit BTC Address',  callback_data:'adm_wallet_edit_btc'  }],
    [{ text:'⬅️ Back',              callback_data:'adm_home'             }],
  ]
  await editMsg(chatId, msgId,
`💳 <b>Payment Addresses</b>

💵 USDT (TRC-20):
<code>${s.usdt_address}</code>

₿ Bitcoin:
<code>${s.btc_address}</code>

Tap a button below to update an address.`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN ACTIONS
// ─────────────────────────────────────────────────────────────────────────────

async function adminApprove(adminChatId, targetId) {
  const sub = getSub(targetId)
  if (!sub) return send(adminChatId, `❌ User ${targetId} not found.`)
  console.log('[approve] sub record:', JSON.stringify(sub))
  if (isActive(sub)) return send(adminChatId, `ℹ️ User ${targetId} is already active until ${new Date(sub.expiresAt).toLocaleDateString()}`)
  const pkgId = sub.pendingPkg || sub.plan || 'p1'
  const pkg = getPackage(pkgId)
  if (!pkg) return send(adminChatId, `❌ Package "${pkgId}" not found. Use /check ${targetId} to inspect.`)
  const now = new Date(), exp = new Date(now.getTime() + pkg.days * 86400000)
  upsertSub(targetId, { status:'active', plan:pkg.id, planLabel:pkg.label, price:pkg.price, activatedAt:now.toISOString(), expiresAt:exp.toISOString(), pendingPkg:null, pendingMethod:null })
  const expStr = exp.toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})
  await send(adminChatId, `✅ Approved ${targetId} — ${pkg.label} until ${expStr}`)
  await send(targetId,
`🎉 <b>Payment Confirmed!</b>

Your <b>${pkg.label}</b> subscription is now <b>ACTIVE</b>.

✅ Expires: <b>${expStr}</b>
✅ Signals are being sent to this chat
✅ Make sure you're in ${CHANNEL}

Welcome to GOLD AI Premium! 🟡`)
}

async function adminDeny(adminChatId, targetId) {
  const sub = getSub(targetId)
  if (!sub) return send(adminChatId, `❌ User ${targetId} not found.`)
  upsertSub(targetId, { status:'denied', pendingPkg:null, pendingMethod:null })
  await send(adminChatId, `✅ Denied & notified ${targetId}.`)
  await send(targetId,
`❌ <b>Payment Not Confirmed</b>

We could not verify your payment for the ${getPackage(sub.pendingPkg)?.label || ''} plan.

Please try again or contact support.
/start — try again`)
}

async function adminRevoke(adminChatId, targetId) {
  upsertSub(targetId, { status:'revoked', expiresAt:new Date().toISOString() })
  await send(adminChatId, `✅ Revoked ${targetId}.`)
  await send(targetId, `⚠️ Your GOLD AI subscription has been revoked.\nContact support if you think this is an error.`)
}

async function adminListSubs(adminChatId) {
  const subs = activeSubscribers()
  if (!subs.length) return send(adminChatId, 'No active subscribers.')
  const lines = subs.map(s => {
    const exp = new Date(s.expiresAt).toLocaleDateString()
    return `• <code>${s.chatId}</code> — ${s.planLabel || s.plan} — expires ${exp}`
  })
  return send(adminChatId, `<b>Active Subscribers (${subs.length})</b>\n\n${lines.join('\n')}`)
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROADCAST SIGNAL
// ─────────────────────────────────────────────────────────────────────────────

export async function broadcastSignal(sigText) {
  const subs = activeSubscribers()
  let sent = 0, failed = 0
  for (const sub of subs) {
    try {
      const res = await fetch(`${API}/sendMessage`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({ chat_id:sub.chatId, text:sigText, parse_mode:'HTML' }) })
      const j = await res.json()
      if (j.ok) sent++
      else { failed++; if (['blocked','kicked','deactivated','not_found'].some(w => j.description?.toLowerCase().includes(w))) upsertSub(sub.chatId, { status:'bot_blocked' }) }
    } catch { failed++ }
    await new Promise(r => setTimeout(r, 50))
  }
  console.log(`[broadcast] sent=${sent} failed=${failed} total=${subs.length}`)
  return { sent, failed }
}

// ─────────────────────────────────────────────────────────────────────────────
//  UPDATE ROUTER
// ─────────────────────────────────────────────────────────────────────────────

async function handleUpdate(upd) {

  // ── TEXT / COMMANDS ──────────────────────────────────────────────────────────
  if (upd.message) {
    const msg       = upd.message
    const chatId    = String(msg.chat.id)
    const text      = msg.text || ''
    const isAdmin   = chatId === String(ADMIN_ID)
    const firstName = msg.from?.first_name || 'there'
    const sess      = getSession(chatId)

    // ── Multi-step admin input handler ──
    if (isAdmin && sess) {
      const { step, data } = sess

      // ── ADD PACKAGE steps ──
      if (step === 'add_label') {
        setSession(chatId, 'add_price', { label: text })
        return send(chatId, `💰 Enter the <b>price in USD</b> for "<b>${text}</b>":`)
      }
      if (step === 'add_price') {
        const price = parseFloat(text)
        if (isNaN(price) || price <= 0) return send(chatId, '❌ Invalid price. Enter a number like 50:')
        setSession(chatId, 'add_days', { ...data, price })
        return send(chatId, `📅 Enter the <b>duration in days</b> (e.g. 30, 90, 180):`)
      }
      if (step === 'add_days') {
        const days = parseInt(text)
        if (isNaN(days) || days <= 0) return send(chatId, '❌ Invalid days. Enter a number like 30:')
        const id = nextPkgId()
        const pkgs = loadPackages()
        pkgs[id] = { id, label: data.label, price: data.price, days, active: true }
        savePackages(pkgs)
        clearSession(chatId)
        return send(chatId,
`✅ <b>Package Created!</b>

ID: <code>${id}</code>
Label: ${data.label}
Price: $${data.price}
Duration: ${days} days

Users will see it immediately on /start.

/packages — manage packages`)
      }

      // ── EDIT steps ──
      if (step === 'edit_label') {
        const pkgs = loadPackages()
        pkgs[data.pkgId].label = text
        savePackages(pkgs)
        clearSession(chatId)
        return send(chatId, `✅ Label updated to "<b>${text}</b>"\n\n/packages — back to packages`)
      }
      if (step === 'edit_price') {
        const price = parseFloat(text)
        if (isNaN(price) || price <= 0) return send(chatId, '❌ Invalid price. Enter a number:')
        const pkgs = loadPackages()
        pkgs[data.pkgId].price = price
        savePackages(pkgs)
        clearSession(chatId)
        return send(chatId, `✅ Price updated to <b>$${price}</b>\n\n/packages — back to packages`)
      }
      if (step === 'edit_days') {
        const days = parseInt(text)
        if (isNaN(days) || days <= 0) return send(chatId, '❌ Invalid days. Enter a number:')
        const pkgs = loadPackages()
        pkgs[data.pkgId].days = days
        savePackages(pkgs)
        clearSession(chatId)
        return send(chatId, `✅ Duration updated to <b>${days} days</b>\n\n/packages — back to packages`)
      }

      // ── BROADCAST step ──
      if (step === 'broadcast_msg') {
        clearSession(chatId)
        const result = await broadcastSignal(text)
        return send(chatId, `📢 Broadcast sent!\n\n✅ Delivered: ${result.sent}\n❌ Failed: ${result.failed}`)
      }

      // ── WALLET EDIT steps ──
      if (step === 'edit_usdt') {
        const s = loadSettings()
        s.usdt_address = text.trim()
        saveSettings(s)
        clearSession(chatId)
        return send(chatId, `✅ <b>USDT address updated!</b>\n\n<code>${text.trim()}</code>\n\n/admin — back to panel`)
      }
      if (step === 'edit_btc') {
        const s = loadSettings()
        s.btc_address = text.trim()
        saveSettings(s)
        clearSession(chatId)
        return send(chatId, `✅ <b>BTC address updated!</b>\n\n<code>${text.trim()}</code>\n\n/admin — back to panel`)
      }

      // Cancel session if user sends a command
      if (text.startsWith('/')) clearSession(chatId)
    }

    // ── Regular commands ──
    if (text === '/start')    return screenStart(chatId, firstName)
    if (text === '/status')   return screenStatus(chatId)
    if (text === '/help') return send(chatId,
`📖 <b>How to read GOLD AI signals</b>

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

    // ── Admin-only commands ──
    if (isAdmin) {
      const parts = text.split(' ')
      if (text === '/admin')    return screenAdminHome(chatId)
      if (text === '/packages') return screenPackageManager(chatId)
      if (text === '/subs')     return adminListSubs(chatId)
      if (parts[0] === '/approve' && parts[1]) return adminApprove(chatId, parts[1])
      if (parts[0] === '/deny'    && parts[1]) return adminDeny(chatId, parts[1])
      if (parts[0] === '/revoke'  && parts[1]) return adminRevoke(chatId, parts[1])
      if (parts[0] === '/check'   && parts[1]) {
        const s = getSub(parts[1])
        return send(chatId, s ? `<pre>${JSON.stringify(s,null,2)}</pre>` : `❌ Not found: ${parts[1]}`)
      }
    }
    return
  }

  // ── CALLBACK QUERIES ──────────────────────────────────────────────────────────
  if (upd.callback_query) {
    const cb     = upd.callback_query
    const chatId = String(cb.message.chat.id)
    const msgId  = cb.message.message_id
    const data   = cb.data || ''
    const isAdmin = chatId === String(ADMIN_ID)
    await answerCb(cb.id)

    // ── User flow ──
    if (data === 'back_packages') return screenStart(chatId, '')

    const pkgMatch  = data.match(/^pkg_(\w+)$/)
    if (pkgMatch) return screenPickPayment(chatId, pkgMatch[1], msgId)

    const payMatch  = data.match(/^pay_(\w+)_(\w+)$/)
    if (payMatch) return screenPayment(chatId, payMatch[1], payMatch[2], msgId)

    const confMatch = data.match(/^confirm_(\w+)_(\w+)$/)
    if (confMatch) return screenConfirmPending(chatId, confMatch[1], confMatch[2], msgId)

    const joinMatch = data.match(/^checkjoin_(\w+)_(\w+)$/)
    if (joinMatch) return screenCheckJoin(chatId, joinMatch[1], joinMatch[2], msgId)

    // ── Admin panel (button taps) ──
    if (!isAdmin) return

    if (data === 'adm_home')     return editMsg(chatId, msgId, '🔧 Loading…').then(() => screenAdminHome(chatId))
    if (data === 'adm_subs')     return screenAdminSubs(chatId, msgId)
    if (data === 'adm_pending')  return screenAdminPending(chatId, msgId)
    if (data === 'adm_wallets')  return screenAdminWallets(chatId, msgId)
    if (data === 'adm_pkg_list') return editMsg(chatId, msgId, '📦 Loading…').then(() => screenPackageManager(chatId))

    // View single package
    const pkgView = data.match(/^adm_pkg_view_(\w+)$/)
    if (pkgView) return screenPackageView(chatId, pkgView[1], msgId)

    // Toggle package active/hidden
    const pkgToggle = data.match(/^adm_pkg_toggle_(\w+)$/)
    if (pkgToggle) {
      const pkgs = loadPackages(), id = pkgToggle[1]
      pkgs[id].active = !pkgs[id].active
      savePackages(pkgs)
      return screenPackageView(chatId, id, msgId)
    }

    // Delete package
    const pkgDel = data.match(/^adm_pkg_delete_(\w+)$/)
    if (pkgDel) {
      const pkgs = loadPackages(), id = pkgDel[1], label = pkgs[id]?.label
      delete pkgs[id]
      savePackages(pkgs)
      return editMsg(chatId, msgId, `🗑️ Package "<b>${label}</b>" deleted.`, [[{ text:'⬅️ Back to Packages', callback_data:'adm_pkg_list' }]])
    }

    // Edit label
    const editLabel = data.match(/^adm_pkg_edit_label_(\w+)$/)
    if (editLabel) {
      setSession(chatId, 'edit_label', { pkgId: editLabel[1] })
      return editMsg(chatId, msgId, `✏️ Send the <b>new label</b> for this package:\n(e.g. "1 Month VIP")`, [[{ text:'❌ Cancel', callback_data:`adm_pkg_view_${editLabel[1]}` }]])
    }

    // Edit price
    const editPrice = data.match(/^adm_pkg_edit_price_(\w+)$/)
    if (editPrice) {
      setSession(chatId, 'edit_price', { pkgId: editPrice[1] })
      return editMsg(chatId, msgId, `💰 Send the <b>new price in USD</b>:\n(e.g. 75)`, [[{ text:'❌ Cancel', callback_data:`adm_pkg_view_${editPrice[1]}` }]])
    }

    // Edit days
    const editDays = data.match(/^adm_pkg_edit_days_(\w+)$/)
    if (editDays) {
      setSession(chatId, 'edit_days', { pkgId: editDays[1] })
      return editMsg(chatId, msgId, `📅 Send the <b>new duration in days</b>:\n(e.g. 30)`, [[{ text:'❌ Cancel', callback_data:`adm_pkg_view_${editDays[1]}` }]])
    }

    // Add new package
    if (data === 'adm_pkg_add') {
      setSession(chatId, 'add_label', {})
      return editMsg(chatId, msgId, `➕ <b>New Package</b>\n\nStep 1/3 — Send the <b>package name</b>:\n(e.g. "1 Month", "VIP Weekly")`, [[{ text:'❌ Cancel', callback_data:'adm_pkg_list' }]])
    }

    // Approve/deny from pending panel
    const admApprove = data.match(/^adm_approve_(\d+)$/)
    if (admApprove) { await adminApprove(chatId, admApprove[1]); return screenAdminPending(chatId, msgId) }

    const admDeny = data.match(/^adm_deny_(\d+)$/)
    if (admDeny) { await adminDeny(chatId, admDeny[1]); return screenAdminPending(chatId, msgId) }

    // Wallet edit buttons
    if (data === 'adm_wallet_edit_usdt') {
      setSession(chatId, 'edit_usdt', {})
      return editMsg(chatId, msgId, `✏️ <b>Update USDT (TRC-20) Address</b>\n\nSend your new USDT wallet address:`, [[{ text:'❌ Cancel', callback_data:'adm_wallets' }]])
    }
    if (data === 'adm_wallet_edit_btc') {
      setSession(chatId, 'edit_btc', {})
      return editMsg(chatId, msgId, `✏️ <b>Update Bitcoin Address</b>\n\nSend your new BTC wallet address:`, [[{ text:'❌ Cancel', callback_data:'adm_wallets' }]])
    }

    // Broadcast
    if (data === 'adm_broadcast') {
      setSession(chatId, 'broadcast_msg', {})
      return editMsg(chatId, msgId, `📢 <b>Broadcast to all subscribers</b>\n\nType your message and send it.\nSupports HTML formatting.\n\n⚠️ This sends to ALL active subscribers.`, [[{ text:'❌ Cancel', callback_data:'adm_home' }]])
    }
  }
}

// ── LONG POLLING ──────────────────────────────────────────────────────────────
async function startPolling() {
  console.log('🤖 Gold AI Subscription Bot started')
  console.log(`   Channel: ${CHANNEL}`)
  console.log(`   Admin:   ${ADMIN_ID}`)
  console.log(`   Plans:   ${getActivePackages().map(p=>`${p.label}=$${p.price}`).join(', ')}`)
  let offset = 0
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=1&allowed_updates=["message","callback_query"]`)
      const j   = await res.json()
      if (!j.ok) { await sleep(3000); continue }
      const updates = j.result || []
      for (const upd of updates) {
        offset = upd.update_id + 1
        handleUpdate(upd).catch(e => console.error('[update error]', e.message))
      }
      // Small pause only when idle to avoid hammering Telegram
      if (!updates.length) await sleep(300)
    } catch (e) { console.error('[poll error]', e.message); await sleep(3000) }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── EXPIRY CHECKER ────────────────────────────────────────────────────────────
async function runExpiryChecker() {
  setInterval(async () => {
    const data = loadSubs(), now = new Date()
    for (const sub of Object.values(data)) {
      if (sub.status !== 'active') continue
      const exp = new Date(sub.expiresAt), days = Math.ceil((exp - now) / 86400000)
      if (days === 3 && !sub.warned3d) {
        upsertSub(sub.chatId, { warned3d:true })
        await send(sub.chatId, `⚠️ <b>Subscription Expiring Soon</b>\n\nYour <b>${sub.planLabel}</b> plan expires in <b>3 days</b>.\n\nRenew now:\n/start`).catch(()=>{})
      }
      if (exp <= now) {
        upsertSub(sub.chatId, { status:'expired' })
        await send(sub.chatId, `❌ <b>Subscription Expired</b>\n\nYour access has ended.\n\n/start — renew`).catch(()=>{})
      }
    }
  }, 60 * 60 * 1000)
}

runExpiryChecker()
startPolling()
