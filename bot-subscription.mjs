// ─────────────────────────────────────────────────────────────────────────────
//  GOLD.AI — Subscription Bot  v3 — Fully Dynamic Admin
//
//  Everything that was hardcoded is now editable live from Telegram:
//    • API keys (TwelveData — add/remove/rotate, test live)
//    • Active timeframes (15m, 1h, 4h, 1d — toggle on/off per TF)
//    • Payment methods (add any coin/network, edit label/address, toggle)
//    • Subscription packages (add/edit/delete/toggle)
//    • Bot settings (channel, risk %, account size, price-check interval)
//    • Wallet addresses
//    • Broadcast to subscribers
//
//  All config persists in settings.json (never committed to git).
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs'

// ── HARD-WIRED BOOTSTRAP (only these two can't be changed via bot) ─────────
const TG_TOKEN   = process.env.TG_TOKEN        || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const ADMIN_ID   = process.env.ADMIN_CHAT_ID   || '1408577116'
if (!TG_TOKEN) { console.error('❌  TG_TOKEN not set'); process.exit(1) }

// ── FILE PATHS ─────────────────────────────────────────────────────────────
const SUB_FILE      = './subscribers.json'
const PKG_FILE      = './packages.json'
const SETTINGS_FILE = './settings.json'

// ─────────────────────────────────────────────────────────────────────────────
//  SETTINGS — full dynamic config store
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  // Bot identity
  channel:          process.env.CHANNEL_USERNAME || '@MH_Signals',
  // Risk / sizing
  account_size:     10000,
  risk_pct:         1,
  // Price watcher
  price_check_sec:  30,
  // Data source: 'twelvedata' | 'oanda'
  data_source:      'twelvedata',
  // TwelveData API keys — array of { key, label, active }
  twelvedata_keys: [
    { key: process.env.TWELVEDATA_KEY || 'dbf374976088424aa703db6034942e19', label: 'Key 1', active: true },
    { key: 'da16adf775b04e31a6a33386689e38c8', label: 'Key 2', active: true },
    { key: '34034261d78440e28ece3d43ddd64955', label: 'Key 3', active: true },
    { key: 'ef3ccaeaa4954935b193708cf86fa97d', label: 'Key 4', active: true },
    { key: '9268e6afa5024f6a97ca03e44dcb59c0', label: 'Key 5', active: true },
    { key: '78ce7374b05b4e33a3e1bd4c6311ff25', label: 'Key 6', active: true },
  ],
  // OANDA (optional)
  oanda_token:      process.env.OANDA_TOKEN || '',
  oanda_env:        'practice',  // 'practice' | 'live'
  // Active timeframes — array of tf strings
  live_timeframes:  ['15m', '1h'],
  // Payment methods — dynamic array of { id, label, coin, network, address, active }
  payment_methods: [
    { id: 'usdt', label: '💵 USDT (TRC-20)', coin: 'USDT', network: 'TRC-20', address: process.env.USDT_ADDRESS || 'TEST_USDT_ADDRESS', active: true },
    { id: 'btc',  label: '₿ Bitcoin',        coin: 'BTC',  network: 'Bitcoin', address: process.env.BTC_ADDRESS  || 'TEST_BTC_ADDRESS',  active: true },
  ],
}

function loadSettings() {
  try {
    const saved = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'))
    // Deep merge: top-level keys from saved override defaults
    return { ...DEFAULT_SETTINGS, ...saved }
  } catch { return { ...DEFAULT_SETTINGS } }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)) }
function getSetting(k)    { return loadSettings()[k] }
function setSetting(k, v) { const s = loadSettings(); s[k] = v; saveSettings(s) }

// Convenience exports consumed by launcher.mjs
export function getActiveApiKeys()    { return (getSetting('twelvedata_keys') || []).filter(k => k.active).map(k => k.key) }
export function getActiveTimeframes() { return getSetting('live_timeframes') || ['15m','1h'] }
export function getDataSource()       { return getSetting('data_source') || 'twelvedata' }
export function getAccountSize()      { return getSetting('account_size') || 10000 }
export function getRiskPct()          { return getSetting('risk_pct') || 1 }
export function getPriceCheckSec()    { return getSetting('price_check_sec') || 30 }
export function getOandaToken()       { return getSetting('oanda_token') || '' }
export function getOandaEnv()         { return getSetting('oanda_env') || 'practice' }

// ── PACKAGES ───────────────────────────────────────────────────────────────
const DEFAULT_PACKAGES = {
  p1: { id:'p1', label:'1 Month',  price:50,  days:30,  active:true },
  p2: { id:'p2', label:'3 Months', price:120, days:90,  active:true },
  p3: { id:'p3', label:'6 Months', price:200, days:180, active:true },
}
function loadPackages()      { try { return JSON.parse(fs.readFileSync(PKG_FILE, 'utf8')) } catch { savePackages(DEFAULT_PACKAGES); return DEFAULT_PACKAGES } }
function savePackages(pkgs)  { fs.writeFileSync(PKG_FILE, JSON.stringify(pkgs, null, 2)) }
function getActivePackages() { return Object.values(loadPackages()).filter(p => p.active !== false) }
function getPackage(id)      { return loadPackages()[id] || null }
function nextPkgId()         { const ids = Object.keys(loadPackages()).map(k => parseInt(k.replace('p',''))).filter(n => !isNaN(n)); return `p${ids.length ? Math.max(...ids)+1 : 1}` }

// ── PAYMENT METHODS helpers ────────────────────────────────────────────────
function getPayMethods()       { return (getSetting('payment_methods') || []).filter(m => m.active !== false) }
function getAllPayMethods()     { return getSetting('payment_methods') || [] }
function savePayMethods(arr)   { setSetting('payment_methods', arr) }
function nextPayId()           { const ids = getAllPayMethods().map(m => m.id); let i=1; while(ids.includes(`pm${i}`)) i++; return `pm${i}` }

// ── SUBSCRIBERS ────────────────────────────────────────────────────────────
function loadSubs()  { try { return JSON.parse(fs.readFileSync(SUB_FILE, 'utf8')) } catch { return {} } }
function saveSubs(d) { fs.writeFileSync(SUB_FILE, JSON.stringify(d, null, 2)) }
function getSub(chatId)        { return loadSubs()[String(chatId)] || null }
function upsertSub(chatId, patch) {
  const data = loadSubs(), key = String(chatId)
  data[key] = { ...data[key], ...patch, chatId: String(chatId), updatedAt: new Date().toISOString() }
  saveSubs(data); return data[key]
}
function isActive(sub)         { if (!sub || sub.status !== 'active') return false; return new Date(sub.expiresAt) > new Date() }
function activeSubscribers()   { return Object.values(loadSubs()).filter(s => isActive(s)) }

// ── ADMIN SESSION ──────────────────────────────────────────────────────────
const adminSession = {}
function setSession(chatId, step, data={}) { adminSession[chatId] = { step, data } }
function getSession(chatId)  { return adminSession[chatId] || null }
function clearSession(chatId){ delete adminSession[chatId] }

// ── TELEGRAM API ───────────────────────────────────────────────────────────
const API = `https://api.telegram.org/bot${TG_TOKEN}`
async function tgCall(method, body={}) {
  const res = await fetch(`${API}/${method}`, { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) })
  const j = await res.json()
  if (!j.ok) console.error(`[TG] ${method} failed:`, j.description)
  return j
}
async function send(chatId, text, extra={})          { return tgCall('sendMessage', { chat_id:chatId, text, parse_mode:'HTML', ...extra }) }
async function sendInline(chatId, text, buttons)     { return send(chatId, text, { reply_markup:{ inline_keyboard:buttons } }) }
async function editMsg(chatId, msgId, text, buttons=null) {
  const body = { chat_id:chatId, message_id:msgId, text, parse_mode:'HTML' }
  if (buttons) body.reply_markup = { inline_keyboard:buttons }
  return tgCall('editMessageText', body)
}
async function answerCb(cbId, text='') { return tgCall('answerCallbackQuery', { callback_query_id:cbId, text }) }
async function isMember(chatId) {
  try {
    const r = await tgCall('getChatMember', { chat_id: getSetting('channel'), user_id: chatId })
    return ['member','administrator','creator'].includes(r.result?.status)
  } catch { return false }
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROADCAST
// ─────────────────────────────────────────────────────────────────────────────
export async function broadcastSignal(sigText) {
  const subs = activeSubscribers(); let sent=0, failed=0
  for (const sub of subs) {
    try {
      const res = await fetch(`${API}/sendMessage`, { method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({ chat_id:sub.chatId, text:sigText, parse_mode:'HTML' }) })
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
//  USER FLOW SCREENS
// ─────────────────────────────────────────────────────────────────────────────
async function screenStart(chatId, firstName) {
  const sub = getSub(chatId), channel = getSetting('channel')
  if (isActive(sub)) {
    const exp = new Date(sub.expiresAt).toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})
    return send(chatId, `✅ <b>Welcome back, ${firstName}!</b>\n\nYour subscription is <b>active</b> until <b>${exp}</b>.\nSignals are being sent to this chat 🟡\n\n/status — subscription details\n/help   — how to read signals`)
  }
  if (sub?.status === 'pending_payment') return screenPayment(chatId, sub.pendingPkg, sub.pendingMethod, sub.msgId)
  const pkgs = getActivePackages()
  if (!pkgs.length) return send(chatId, '⚠️ No plans available right now. Please check back soon.')
  const rows = pkgs.map(p => [{ text:`📦 ${p.label} — $${p.price}`, callback_data:`pkg_${p.id}` }])
  return sendInline(chatId,
`🟡 <b>GOLD AI — Premium Signals</b>

Real-time XAUUSD trading signals powered by multi-timeframe analysis.

✅ Multi-timeframe signals (${(getSetting('live_timeframes')||['15m','1h']).join(' + ')})
✅ Entry, SL, TP1 / TP2 / TP3 included
✅ Score, regime & session context
✅ Instant Telegram delivery

<b>Choose your subscription plan:</b>`, rows)
}

async function screenPickPayment(chatId, pkgId, msgId) {
  const pkg = getPackage(pkgId); if (!pkg) return
  upsertSub(chatId, { status:'pending_payment', pendingPkg:pkgId, msgId })
  const methods = getPayMethods()
  if (!methods.length) return send(chatId, '⚠️ No payment methods available. Contact support.')
  const rows = methods.map(m => [{ text:m.label, callback_data:`pay_${pkgId}_${m.id}` }])
  rows.push([{ text:'⬅️ Back', callback_data:'back_packages' }])
  await editMsg(chatId, msgId, `📦 <b>${pkg.label} Plan — $${pkg.price}</b>\n\nChoose your payment method:`, rows)
}

async function screenPayment(chatId, pkgId, methodId, msgId) {
  const pkg = getPackage(pkgId), method = getAllPayMethods().find(m => m.id === methodId)
  if (!pkg || !method) return
  upsertSub(chatId, { status:'pending_payment', pendingPkg:pkgId, pendingMethod:methodId, msgId })
  const rows = [
    [{ text:'✅ I Sent the Payment',  callback_data:`confirm_${pkgId}_${methodId}` }],
    [{ text:'⬅️ Back to Methods',    callback_data:`pkg_${pkgId}` }],
  ]
  await editMsg(chatId, msgId,
`💳 <b>Payment Instructions</b>

Plan: <b>${pkg.label} — $${pkg.price}</b>
Method: <b>${method.label}</b>

Send exactly <b>$${pkg.price} worth of ${method.coin}</b>${method.network ? ` (${method.network})` : ''} to:

<code>${method.address}</code>

⚠️ <b>Important:</b>
• Send the exact amount
• Include your Telegram ID <code>${chatId}</code> in memo if possible
• Payment confirms within 10–30 min

After sending, press <b>"I Sent the Payment"</b> below.`, rows)
}

async function screenConfirmPending(chatId, pkgId, methodId, msgId) {
  const pkg = getPackage(pkgId), method = getAllPayMethods().find(m => m.id === methodId)
  upsertSub(chatId, { status:'awaiting_admin', pendingPkg:pkgId, pendingMethod:methodId, msgId, claimedAt:new Date().toISOString() })
  if (ADMIN_ID) {
    await send(ADMIN_ID,
`🔔 <b>New Payment Claim</b>

User: <a href="tg://user?id=${chatId}">${chatId}</a>
Plan: ${pkg?.label} — $${pkg?.price}
Method: ${method?.label}
Claimed: ${new Date().toLocaleString()}

/approve ${chatId}  or  /deny ${chatId}`)
  }
  const channel = getSetting('channel')
  const rows = [
    [{ text:`✅ Join ${channel}`, url:`https://t.me/${channel.replace('@','')}` }],
    [{ text:'🔄 I Joined — Check My Status', callback_data:`checkjoin_${pkgId}_${methodId}` }],
  ]
  await editMsg(chatId, msgId,
`⏳ <b>Payment Under Review</b>

Thank you! Your payment is being verified.

<b>While you wait, please join our signals channel:</b>
${channel}

You <b>must</b> be a member to receive signals.`, rows)
}

async function screenCheckJoin(chatId, pkgId, methodId, msgId) {
  const joined = await isMember(chatId), sub = getSub(chatId), channel = getSetting('channel')
  if (!joined) {
    const rows = [
      [{ text:`✅ Join ${channel}`, url:`https://t.me/${channel.replace('@','')}` }],
      [{ text:'🔄 Check Again', callback_data:`checkjoin_${pkgId}_${methodId}` }],
    ]
    return editMsg(chatId, msgId, `❌ <b>Not joined yet</b>\n\nWe couldn't detect your membership in ${channel}.\nPlease join first then check again.`, rows)
  }
  upsertSub(chatId, { joinedChannel:true })
  if (sub?.status === 'active') return editMsg(chatId, msgId, `🎉 <b>You're all set!</b>\n\n✅ Channel joined\n✅ Subscription active\n\nSignals will arrive here automatically. 🟡`)
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
    return send(chatId, `📊 <b>Your Subscription</b>\n\nPlan: <b>${sub.planLabel || sub.plan}</b>\nStatus: ✅ Active\nExpires: <b>${exp}</b> (${daysLeft} days left)\n\nSignals are being delivered to this chat.`)
  }
  return send(chatId, '❌ Your subscription has expired.\n\n/start — renew')
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — HOME
// ─────────────────────────────────────────────────────────────────────────────
async function screenAdminHome(chatId) {
  const subs = activeSubscribers(), allData = Object.values(loadSubs())
  const pending = allData.filter(s => s.status === 'awaiting_admin').length
  const pkgs = getActivePackages(), tfs = getSetting('live_timeframes') || []
  const keys = (getSetting('twelvedata_keys') || []).filter(k => k.active).length
  const rows = [
    [{ text:`👥 Subscribers (${subs.length} active)`,    callback_data:'adm_subs'      }],
    [{ text:`📦 Packages (${pkgs.length} active)`,       callback_data:'adm_pkg_list'  }],
    [{ text:`⏳ Pending Approvals (${pending})`,          callback_data:'adm_pending'   }],
    [{ text:`📊 Timeframes (${tfs.join(', ')})`,         callback_data:'adm_timeframes'}],
    [{ text:`🔑 API Keys (${keys} active)`,              callback_data:'adm_keys'      }],
    [{ text:'💳 Payment Methods',                         callback_data:'adm_payments'  }],
    [{ text:'⚙️ Bot Settings',                           callback_data:'adm_botsettings'}],
    [{ text:'📢 Broadcast Message',                       callback_data:'adm_broadcast' }],
  ]
  return sendInline(chatId,
`🔧 <b>GOLD AI Admin Panel</b>

Active subscribers: <b>${subs.length}</b>
Pending approvals: <b>${pending}</b>
Active packages: <b>${pkgs.length}</b>
Timeframes: <b>${tfs.join(', ') || 'none'}</b>
API keys: <b>${keys} active</b>

Choose an action:`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — TIMEFRAMES
// ─────────────────────────────────────────────────────────────────────────────
const ALL_TF_OPTIONS = ['1m','3m','5m','15m','30m','1h','2h','4h','1d']

async function screenTimeframes(chatId, msgId) {
  const active = getSetting('live_timeframes') || []
  const rows = ALL_TF_OPTIONS.map(tf => [{
    text: `${active.includes(tf) ? '✅' : '⬜'} ${tf}`,
    callback_data: `adm_tf_toggle_${tf}`
  }])
  rows.push([{ text:'⬅️ Back to Admin', callback_data:'adm_home' }])
  const fn = msgId ? editMsg : sendInline
  const text = `📊 <b>Active Timeframes</b>\n\nToggle which timeframes run live.\nCurrently active: <b>${active.join(', ') || 'none'}</b>\n\n⚠️ Changes take effect on next candle cycle.\n(Restart launcher to apply immediately)`
  return msgId ? editMsg(chatId, msgId, text, rows) : sendInline(chatId, text, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — API KEYS
// ─────────────────────────────────────────────────────────────────────────────
async function screenApiKeys(chatId, msgId) {
  const keys = getSetting('twelvedata_keys') || []
  const rows = keys.map((k, i) => [{
    text: `${k.active ? '✅' : '❌'} ${k.label} — ${k.key.slice(0,8)}…`,
    callback_data: `adm_key_view_${i}`
  }])
  rows.push([{ text:'➕ Add New API Key', callback_data:'adm_key_add' }])
  rows.push([{ text:'⬅️ Back to Admin',  callback_data:'adm_home'    }])
  const text = `🔑 <b>TwelveData API Keys</b>\n\nKeys rotate automatically on 429 errors.\nActive: <b>${keys.filter(k=>k.active).length}/${keys.length}</b>\n\nTap a key to view/edit/test:`
  return msgId ? editMsg(chatId, msgId, text, rows) : sendInline(chatId, text, rows)
}

async function screenApiKeyView(chatId, msgId, idx) {
  const keys = getSetting('twelvedata_keys') || [], k = keys[idx]
  if (!k) return
  const rows = [
    [{ text:'✏️ Edit Label',                  callback_data:`adm_key_edit_label_${idx}` },
     { text:'🔑 Replace Key',                 callback_data:`adm_key_edit_key_${idx}`   }],
    [{ text:'🧪 Test Key Live',               callback_data:`adm_key_test_${idx}`       }],
    [{ text: k.active ? '🚫 Disable' : '✅ Enable', callback_data:`adm_key_toggle_${idx}` }],
    [{ text:'🗑️ Delete Key',                  callback_data:`adm_key_delete_${idx}`     }],
    [{ text:'⬅️ Back',                        callback_data:'adm_keys'                  }],
  ]
  await editMsg(chatId, msgId,
`🔑 <b>${k.label}</b>

Key: <code>${k.key}</code>
Status: ${k.active ? '✅ Active' : '❌ Disabled'}
Position: slot #${idx+1} of ${keys.length}`, rows)
}

async function testApiKey(key) {
  try {
    const res = await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${key}`, { signal: AbortSignal.timeout(8000) })
    const j = await res.json()
    if (j.price) return { ok:true, price:j.price }
    if (j.code === 429) return { ok:false, reason:'Rate limited (429)' }
    return { ok:false, reason: j.message || JSON.stringify(j) }
  } catch(e) { return { ok:false, reason: e.message } }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — PAYMENT METHODS
// ─────────────────────────────────────────────────────────────────────────────
async function screenPayments(chatId, msgId) {
  const methods = getAllPayMethods()
  const rows = methods.map(m => [{
    text: `${m.active !== false ? '✅' : '❌'} ${m.label} (${m.coin})`,
    callback_data: `adm_pay_view_${m.id}`
  }])
  rows.push([{ text:'➕ Add Payment Method', callback_data:'adm_pay_add' }])
  rows.push([{ text:'⬅️ Back to Admin',      callback_data:'adm_home'   }])
  const text = `💳 <b>Payment Methods</b>\n\nActive: <b>${methods.filter(m=>m.active!==false).length}/${methods.length}</b>\n\nTap a method to edit:`
  return msgId ? editMsg(chatId, msgId, text, rows) : sendInline(chatId, text, rows)
}

async function screenPaymentView(chatId, msgId, payId) {
  const methods = getAllPayMethods(), m = methods.find(x => x.id === payId)
  if (!m) return
  const rows = [
    [{ text:'✏️ Edit Label',   callback_data:`adm_pay_edit_label_${payId}`   },
     { text:'🪙 Edit Coin',    callback_data:`adm_pay_edit_coin_${payId}`    }],
    [{ text:'🌐 Edit Network', callback_data:`adm_pay_edit_network_${payId}` },
     { text:'📋 Edit Address', callback_data:`adm_pay_edit_address_${payId}` }],
    [{ text: m.active !== false ? '🚫 Disable' : '✅ Enable', callback_data:`adm_pay_toggle_${payId}` }],
    [{ text:'🗑️ Delete Method', callback_data:`adm_pay_delete_${payId}` }],
    [{ text:'⬅️ Back',         callback_data:'adm_payments' }],
  ]
  await editMsg(chatId, msgId,
`💳 <b>${m.label}</b>

ID: <code>${m.id}</code>
Coin: <b>${m.coin}</b>
Network: <b>${m.network || '—'}</b>
Address: <code>${m.address}</code>
Status: ${m.active !== false ? '✅ Active' : '❌ Hidden'}`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — BOT SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
async function screenBotSettings(chatId, msgId) {
  const s = loadSettings()
  const rows = [
    [{ text:'📡 Channel Username',    callback_data:'adm_cfg_channel'      }],
    [{ text:'💰 Account Size',        callback_data:'adm_cfg_account_size' }],
    [{ text:'⚖️ Risk % per Trade',   callback_data:'adm_cfg_risk_pct'     }],
    [{ text:'⏱️ Price-Check Interval',callback_data:'adm_cfg_price_check'  }],
    [{ text:'🔌 Data Source',         callback_data:'adm_cfg_datasource'   }],
    [{ text:'🔐 OANDA Token',         callback_data:'adm_cfg_oanda_token'  }],
    [{ text:'🌐 OANDA Environment',   callback_data:'adm_cfg_oanda_env'    }],
    [{ text:'⬅️ Back to Admin',       callback_data:'adm_home'             }],
  ]
  const text =
`⚙️ <b>Bot Settings</b>

📡 Channel: <b>${s.channel}</b>
💰 Account size: <b>$${s.account_size.toLocaleString()}</b>
⚖️ Risk/trade: <b>${s.risk_pct}%</b>
⏱️ Price check: <b>every ${s.price_check_sec}s</b>
🔌 Data source: <b>${s.data_source}</b>
🌐 OANDA env: <b>${s.oanda_env}</b>

Tap to edit any setting:`
  return msgId ? editMsg(chatId, msgId, text, rows) : sendInline(chatId, text, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — SUBSCRIBERS / PENDING
// ─────────────────────────────────────────────────────────────────────────────
async function screenAdminSubs(chatId, msgId) {
  const subs = activeSubscribers()
  if (!subs.length) return editMsg(chatId, msgId, 'No active subscribers.', [[{ text:'⬅️ Back', callback_data:'adm_home' }]])
  const lines = subs.map(s => `• <code>${s.chatId}</code> — ${s.planLabel||s.plan} — ${new Date(s.expiresAt).toLocaleDateString()}`)
  await editMsg(chatId, msgId, `👥 <b>Active Subscribers (${subs.length})</b>\n\n${lines.join('\n')}`, [[{ text:'⬅️ Back', callback_data:'adm_home' }]])
}

async function screenAdminPending(chatId, msgId) {
  const pending = Object.values(loadSubs()).filter(s => s.status === 'awaiting_admin')
  if (!pending.length) return editMsg(chatId, msgId, '✅ No pending approvals.', [[{ text:'⬅️ Back', callback_data:'adm_home' }]])
  const rows = pending.map(s => ([
    { text:`✅ Approve ${s.chatId}`, callback_data:`adm_approve_${s.chatId}` },
    { text:`❌ Deny`,                callback_data:`adm_deny_${s.chatId}`    },
  ]))
  rows.push([{ text:'⬅️ Back', callback_data:'adm_home' }])
  const lines = pending.map(s => `• <code>${s.chatId}</code> — ${getPackage(s.pendingPkg)?.label||s.pendingPkg} — ${s.pendingMethod?.toUpperCase()||''} — ${new Date(s.claimedAt||s.updatedAt).toLocaleString()}`)
  await editMsg(chatId, msgId, `⏳ <b>Pending Approvals (${pending.length})</b>\n\n${lines.join('\n')}`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — PACKAGE MANAGER
// ─────────────────────────────────────────────────────────────────────────────
async function screenPackageManager(chatId, msgId) {
  const pkgs = Object.values(loadPackages())
  const rows = pkgs.map(p => [{
    text: `${p.active !== false ? '✅' : '❌'} ${p.label} — $${p.price} (${p.days}d)`,
    callback_data: `adm_pkg_view_${p.id}`
  }])
  rows.push([{ text:'➕ Add New Package', callback_data:'adm_pkg_add'  }])
  rows.push([{ text:'⬅️ Back to Admin',  callback_data:'adm_home'     }])
  const text = `📦 <b>Package Manager</b>\n\nTap a package to edit or toggle it:`
  return msgId ? editMsg(chatId, msgId, text, rows) : sendInline(chatId, text, rows)
}

async function screenPackageView(chatId, pkgId, msgId) {
  const pkg = getPackage(pkgId); if (!pkg) return
  const status = pkg.active !== false ? '✅ Active' : '❌ Hidden'
  const rows = [
    [{ text:'✏️ Edit Label', callback_data:`adm_pkg_edit_label_${pkgId}` },
     { text:'💰 Edit Price', callback_data:`adm_pkg_edit_price_${pkgId}` }],
    [{ text:'📅 Edit Days',  callback_data:`adm_pkg_edit_days_${pkgId}`  },
     { text: pkg.active !== false ? '🚫 Disable' : '✅ Enable', callback_data:`adm_pkg_toggle_${pkgId}` }],
    [{ text:'🗑️ Delete',     callback_data:`adm_pkg_delete_${pkgId}`     }],
    [{ text:'⬅️ Back',       callback_data:'adm_pkg_list'                }],
  ]
  await editMsg(chatId, msgId, `📦 <b>${pkg.label}</b>\n\nPrice: <b>$${pkg.price}</b>\nDuration: <b>${pkg.days} days</b>\nStatus: ${status}`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
async function adminApprove(adminChatId, targetId) {
  const sub = getSub(targetId)
  if (!sub) return send(adminChatId, `❌ User ${targetId} not found.`)
  if (isActive(sub)) return send(adminChatId, `ℹ️ User ${targetId} already active until ${new Date(sub.expiresAt).toLocaleDateString()}`)
  const pkgId = sub.pendingPkg || sub.plan || 'p1', pkg = getPackage(pkgId)
  if (!pkg) return send(adminChatId, `❌ Package "${pkgId}" not found.`)
  const now = new Date(), exp = new Date(now.getTime() + pkg.days*86400000)
  upsertSub(targetId, { status:'active', plan:pkg.id, planLabel:pkg.label, price:pkg.price, activatedAt:now.toISOString(), expiresAt:exp.toISOString(), pendingPkg:null, pendingMethod:null })
  const expStr = exp.toLocaleDateString('en-US', {year:'numeric',month:'long',day:'numeric'})
  const channel = getSetting('channel')
  await send(adminChatId, `✅ Approved ${targetId} — ${pkg.label} until ${expStr}`)
  await send(targetId, `🎉 <b>Payment Confirmed!</b>\n\nYour <b>${pkg.label}</b> subscription is now <b>ACTIVE</b>.\n\n✅ Expires: <b>${expStr}</b>\n✅ Signals are being sent to this chat\n✅ Make sure you're in ${channel}\n\nWelcome to GOLD AI Premium! 🟡`)
}

async function adminDeny(adminChatId, targetId) {
  const sub = getSub(targetId)
  if (!sub) return send(adminChatId, `❌ User ${targetId} not found.`)
  upsertSub(targetId, { status:'denied', pendingPkg:null, pendingMethod:null })
  await send(adminChatId, `✅ Denied & notified ${targetId}.`)
  await send(targetId, `❌ <b>Payment Not Confirmed</b>\n\nWe could not verify your payment for the ${getPackage(sub.pendingPkg)?.label||''} plan.\n\nPlease try again or contact support.\n/start — try again`)
}

async function adminRevoke(adminChatId, targetId) {
  upsertSub(targetId, { status:'revoked', expiresAt:new Date().toISOString() })
  await send(adminChatId, `✅ Revoked ${targetId}.`)
  await send(targetId, `⚠️ Your GOLD AI subscription has been revoked.\nContact support if you think this is an error.`)
}

// ─────────────────────────────────────────────────────────────────────────────
//  UPDATE ROUTER
// ─────────────────────────────────────────────────────────────────────────────
async function handleUpdate(upd) {

  // ── TEXT / COMMANDS ─────────────────────────────────────────────────────────
  if (upd.message) {
    const msg = upd.message, chatId = String(msg.chat.id), text = msg.text||''
    const isAdmin = chatId === String(ADMIN_ID), firstName = msg.from?.first_name||'there'
    const sess = getSession(chatId)

    // ── Multi-step admin input ──────────────────────────────────────────────
    if (isAdmin && sess) {
      const { step, data } = sess

      // ─ Package add ─
      if (step === 'add_label') { setSession(chatId,'add_price',{label:text}); return send(chatId,`💰 Enter <b>price in USD</b> for "<b>${text}</b>":`) }
      if (step === 'add_price') { const p=parseFloat(text); if(isNaN(p)||p<=0) return send(chatId,'❌ Invalid price. Enter a number like 50:'); setSession(chatId,'add_days',{...data,price:p}); return send(chatId,`📅 Enter <b>duration in days</b>:`) }
      if (step === 'add_days') {
        const d=parseInt(text); if(isNaN(d)||d<=0) return send(chatId,'❌ Invalid days:')
        const id=nextPkgId(), pkgs=loadPackages(); pkgs[id]={id,label:data.label,price:data.price,days:d,active:true}; savePackages(pkgs); clearSession(chatId)
        return send(chatId,`✅ <b>Package Created!</b>\n\nID: <code>${id}</code>\nLabel: ${data.label}\nPrice: $${data.price}\nDuration: ${d} days\n\n/admin — back to panel`)
      }
      // ─ Package edit ─
      if (step==='edit_label') { const pkgs=loadPackages(); pkgs[data.pkgId].label=text; savePackages(pkgs); clearSession(chatId); return send(chatId,`✅ Label updated to "<b>${text}</b>"\n\n/admin`) }
      if (step==='edit_price') { const p=parseFloat(text); if(isNaN(p)||p<=0) return send(chatId,'❌ Invalid price:'); const pkgs=loadPackages(); pkgs[data.pkgId].price=p; savePackages(pkgs); clearSession(chatId); return send(chatId,`✅ Price updated to <b>$${p}</b>\n\n/admin`) }
      if (step==='edit_days')  { const d=parseInt(text);  if(isNaN(d)||d<=0)  return send(chatId,'❌ Invalid days:');  const pkgs=loadPackages(); pkgs[data.pkgId].days=d;  savePackages(pkgs); clearSession(chatId); return send(chatId,`✅ Duration updated to <b>${d} days</b>\n\n/admin`) }

      // ─ API key steps ─
      if (step==='add_key_label') { setSession(chatId,'add_key_value',{label:text}); return send(chatId,`🔑 Now send the <b>API key string</b> for "<b>${text}</b>":`) }
      if (step==='add_key_value') {
        const keys=getSetting('twelvedata_keys')||[]; keys.push({key:text.trim(),label:data.label,active:true}); setSetting('twelvedata_keys',keys); clearSession(chatId)
        return send(chatId,`✅ <b>API Key Added!</b>\n\nLabel: ${data.label}\nKey: <code>${text.trim().slice(0,12)}…</code>\nStatus: ✅ Active\n\n/admin`)
      }
      if (step==='edit_key_label') { const keys=getSetting('twelvedata_keys')||[]; keys[data.idx].label=text.trim(); setSetting('twelvedata_keys',keys); clearSession(chatId); return send(chatId,`✅ Key label updated to "<b>${text.trim()}</b>"\n\n/admin`) }
      if (step==='edit_key_value') { const keys=getSetting('twelvedata_keys')||[]; keys[data.idx].key=text.trim(); setSetting('twelvedata_keys',keys); clearSession(chatId); return send(chatId,`✅ API key replaced.\nNew key: <code>${text.trim().slice(0,12)}…</code>\n\n/admin`) }

      // ─ Payment method steps ─
      if (step==='pay_add_label')   { setSession(chatId,'pay_add_coin',{label:text});         return send(chatId,`🪙 Enter <b>coin symbol</b> (e.g. USDT, BTC, ETH):`) }
      if (step==='pay_add_coin')    { setSession(chatId,'pay_add_network',{...data,coin:text.toUpperCase()}); return send(chatId,`🌐 Enter <b>network/blockchain</b> (e.g. TRC-20, ERC-20, Bitcoin) or send <code>none</code>:`) }
      if (step==='pay_add_network') { setSession(chatId,'pay_add_address',{...data,network:text==='none'?'':text}); return send(chatId,`📋 Enter the <b>wallet address</b>:`) }
      if (step==='pay_add_address') {
        const methods=getAllPayMethods(), id=nextPayId()
        methods.push({id,label:data.label,coin:data.coin,network:data.network,address:text.trim(),active:true})
        savePayMethods(methods); clearSession(chatId)
        return send(chatId,`✅ <b>Payment Method Added!</b>\n\nID: <code>${id}</code>\nLabel: ${data.label}\nCoin: ${data.coin}${data.network?` (${data.network})`:''}\nAddress: <code>${text.trim()}</code>\n\n/admin`)
      }
      if (step==='pay_edit_label')   { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].label=text.trim();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Label updated to "<b>${text.trim()}</b>"\n\n/admin`) }
      if (step==='pay_edit_coin')    { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].coin=text.trim().toUpperCase();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Coin updated to <b>${text.trim().toUpperCase()}</b>\n\n/admin`) }
      if (step==='pay_edit_network') { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].network=text==='none'?'':text.trim();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Network updated.\n\n/admin`) }
      if (step==='pay_edit_address') { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].address=text.trim();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Address updated:\n<code>${text.trim()}</code>\n\n/admin`) }

      // ─ Bot settings steps ─
      if (step==='cfg_channel')      { setSetting('channel',text.trim()); clearSession(chatId); return send(chatId,`✅ Channel set to <b>${text.trim()}</b>\n\n/admin`) }
      if (step==='cfg_account_size') { const v=parseFloat(text); if(isNaN(v)||v<=0) return send(chatId,'❌ Invalid number:'); setSetting('account_size',v); clearSession(chatId); return send(chatId,`✅ Account size set to <b>$${v.toLocaleString()}</b>\n\n/admin`) }
      if (step==='cfg_risk_pct')     { const v=parseFloat(text); if(isNaN(v)||v<=0||v>100) return send(chatId,'❌ Invalid %:'); setSetting('risk_pct',v); clearSession(chatId); return send(chatId,`✅ Risk set to <b>${v}%</b> per trade\n\n/admin`) }
      if (step==='cfg_price_check')  { const v=parseInt(text); if(isNaN(v)||v<5) return send(chatId,'❌ Min 5 seconds:'); setSetting('price_check_sec',v); clearSession(chatId); return send(chatId,`✅ Price check interval set to <b>${v}s</b>\n\n⚠️ Restart launcher to apply.\n\n/admin`) }
      if (step==='cfg_oanda_token')  { setSetting('oanda_token',text.trim()); clearSession(chatId); return send(chatId,`✅ OANDA token saved.\n\n/admin`) }

      // ─ Broadcast ─
      if (step==='broadcast_msg') { clearSession(chatId); const r=await broadcastSignal(text); return send(chatId,`📢 Broadcast sent!\n\n✅ Delivered: ${r.sent}\n❌ Failed: ${r.failed}`) }

      if (text.startsWith('/')) clearSession(chatId)
    }

    // ── Regular commands ─────────────────────────────────────────────────────
    if (text==='/start')  return screenStart(chatId, firstName)
    if (text==='/status') return screenStatus(chatId)
    if (text==='/help')   return send(chatId,
`📖 <b>How to read GOLD AI signals</b>

<code>🟢 GOLD 15M — BUY (score 72/100 A)
Entry $2340.50 · SL $2332.00
TP1 $2353 · TP2 $2362 · TP3 $2374</code>

• <b>Entry</b> — open near this price
• <b>SL</b> — stop loss (your max risk)
• <b>TP1/TP2/TP3</b> — take profits in thirds
• <b>Score</b> — signal confidence (45–100)
• <b>A/B/C tier</b> — A is strongest

Always use a broker with tight XAUUSD spreads.`)

    if (!isAdmin) return

    // ── Admin commands ───────────────────────────────────────────────────────
    const parts = text.split(' ')
    if (text==='/admin')    return screenAdminHome(chatId)
    if (text==='/packages') return screenPackageManager(chatId, null)
    if (text==='/keys')     return screenApiKeys(chatId, null)
    if (text==='/payments') return screenPayments(chatId, null)
    if (text==='/tfs')      return screenTimeframes(chatId, null)
    if (text==='/settings') return screenBotSettings(chatId, null)
    if (text==='/subs')     { const subs=activeSubscribers(); if(!subs.length) return send(chatId,'No active subscribers.'); const lines=subs.map(s=>`• <code>${s.chatId}</code> — ${s.planLabel||s.plan} — expires ${new Date(s.expiresAt).toLocaleDateString()}`); return send(chatId,`<b>Active Subscribers (${subs.length})</b>\n\n${lines.join('\n')}`) }
    if (parts[0]==='/approve' && parts[1]) return adminApprove(chatId, parts[1])
    if (parts[0]==='/deny'    && parts[1]) return adminDeny(chatId, parts[1])
    if (parts[0]==='/revoke'  && parts[1]) return adminRevoke(chatId, parts[1])
    if (parts[0]==='/check'   && parts[1]) { const s=getSub(parts[1]); return send(chatId, s?`<pre>${JSON.stringify(s,null,2)}</pre>`:`❌ Not found: ${parts[1]}`) }
    return
  }

  // ── CALLBACK QUERIES ─────────────────────────────────────────────────────
  if (upd.callback_query) {
    const cb = upd.callback_query, chatId = String(cb.message.chat.id)
    const msgId = cb.message.message_id, data = cb.data||'', isAdmin = chatId===String(ADMIN_ID)
    await answerCb(cb.id)

    // ── User flow ────────────────────────────────────────────────────────────
    if (data==='back_packages')                return screenStart(chatId, '')
    const pkgMatch  = data.match(/^pkg_(\w+)$/)
    if (pkgMatch) return screenPickPayment(chatId, pkgMatch[1], msgId)
    const payMatch  = data.match(/^pay_(\w+)_(\w+)$/)
    if (payMatch) return screenPayment(chatId, payMatch[1], payMatch[2], msgId)
    const confMatch = data.match(/^confirm_(\w+)_(\w+)$/)
    if (confMatch) return screenConfirmPending(chatId, confMatch[1], confMatch[2], msgId)
    const joinMatch = data.match(/^checkjoin_(\w+)_(\w+)$/)
    if (joinMatch) return screenCheckJoin(chatId, joinMatch[1], joinMatch[2], msgId)

    if (!isAdmin) return

    // ── Admin nav ────────────────────────────────────────────────────────────
    if (data==='adm_home')        return screenAdminHome(chatId)
    if (data==='adm_subs')        return screenAdminSubs(chatId, msgId)
    if (data==='adm_pending')     return screenAdminPending(chatId, msgId)
    if (data==='adm_pkg_list')    return screenPackageManager(chatId, msgId)
    if (data==='adm_keys')        return screenApiKeys(chatId, msgId)
    if (data==='adm_payments')    return screenPayments(chatId, msgId)
    if (data==='adm_timeframes')  return screenTimeframes(chatId, msgId)
    if (data==='adm_botsettings') return screenBotSettings(chatId, msgId)

    // ── Timeframe toggles ────────────────────────────────────────────────────
    const tfToggle = data.match(/^adm_tf_toggle_(.+)$/)
    if (tfToggle) {
      const tf = tfToggle[1], tfs = getSetting('live_timeframes')||[]
      const idx = tfs.indexOf(tf)
      if (idx>=0) tfs.splice(idx,1); else tfs.push(tf)
      tfs.sort((a,b)=>{ const order=['1m','3m','5m','15m','30m','1h','2h','4h','1d']; return order.indexOf(a)-order.indexOf(b) })
      setSetting('live_timeframes', tfs)
      return screenTimeframes(chatId, msgId)
    }

    // ── API Key management ───────────────────────────────────────────────────
    const keyView = data.match(/^adm_key_view_(\d+)$/)
    if (keyView) return screenApiKeyView(chatId, msgId, parseInt(keyView[1]))

    const keyToggle = data.match(/^adm_key_toggle_(\d+)$/)
    if (keyToggle) {
      const keys=getSetting('twelvedata_keys')||[], i=parseInt(keyToggle[1])
      if(keys[i]) keys[i].active=!keys[i].active; setSetting('twelvedata_keys',keys)
      return screenApiKeyView(chatId, msgId, i)
    }
    const keyDel = data.match(/^adm_key_delete_(\d+)$/)
    if (keyDel) {
      const keys=getSetting('twelvedata_keys')||[], i=parseInt(keyDel[1]), label=keys[i]?.label
      keys.splice(i,1); setSetting('twelvedata_keys',keys)
      return editMsg(chatId, msgId, `🗑️ Key "<b>${label}</b>" deleted.`, [[{ text:'⬅️ Back to Keys', callback_data:'adm_keys' }]])
    }
    const keyTest = data.match(/^adm_key_test_(\d+)$/)
    if (keyTest) {
      const keys=getSetting('twelvedata_keys')||[], i=parseInt(keyTest[1]), k=keys[i]
      if (!k) return
      await editMsg(chatId, msgId, `🧪 Testing key <b>${k.label}</b>…`)
      const result = await testApiKey(k.key)
      const txt = result.ok ? `✅ <b>Key works!</b>\nXAU/USD live price: <b>$${result.price}</b>` : `❌ <b>Key failed:</b>\n${result.reason}`
      return editMsg(chatId, msgId, txt, [[{ text:'⬅️ Back', callback_data:`adm_key_view_${i}` }]])
    }
    if (data==='adm_key_add') {
      setSession(chatId,'add_key_label',{})
      return editMsg(chatId, msgId, `➕ <b>Add API Key</b>\n\nStep 1/2 — Send a <b>label</b> for this key:\n(e.g. "Key 7", "Backup Key")`, [[{ text:'❌ Cancel', callback_data:'adm_keys' }]])
    }
    const editKeyLabel = data.match(/^adm_key_edit_label_(\d+)$/)
    if (editKeyLabel) { setSession(chatId,'edit_key_label',{idx:parseInt(editKeyLabel[1])}); return editMsg(chatId,msgId,`✏️ Send the <b>new label</b> for this key:`,[[{text:'❌ Cancel',callback_data:`adm_key_view_${editKeyLabel[1]}`}]]) }
    const editKeyVal = data.match(/^adm_key_edit_key_(\d+)$/)
    if (editKeyVal) { setSession(chatId,'edit_key_value',{idx:parseInt(editKeyVal[1])}); return editMsg(chatId,msgId,`🔑 Send the <b>new API key string</b>:\n⚠️ This replaces the existing key immediately.`,[[{text:'❌ Cancel',callback_data:`adm_key_view_${editKeyVal[1]}`}]]) }

    // ── Payment method management ────────────────────────────────────────────
    const payView = data.match(/^adm_pay_view_(\w+)$/)
    if (payView) return screenPaymentView(chatId, msgId, payView[1])

    const payToggle = data.match(/^adm_pay_toggle_(\w+)$/)
    if (payToggle) {
      const methods=getAllPayMethods(), m=methods.find(x=>x.id===payToggle[1])
      if (m) m.active=m.active===false?true:false; savePayMethods(methods)
      return screenPaymentView(chatId, msgId, payToggle[1])
    }
    const payDel = data.match(/^adm_pay_delete_(\w+)$/)
    if (payDel) {
      const methods=getAllPayMethods().filter(x=>x.id!==payDel[1]); savePayMethods(methods)
      return editMsg(chatId, msgId, `🗑️ Payment method deleted.`, [[{ text:'⬅️ Back', callback_data:'adm_payments' }]])
    }
    if (data==='adm_pay_add') {
      setSession(chatId,'pay_add_label',{})
      return editMsg(chatId, msgId, `➕ <b>Add Payment Method</b>\n\nStep 1/4 — Send a <b>display label</b>:\n(e.g. "💎 ETH (ERC-20)", "🔵 USDC (BEP-20)")`, [[{ text:'❌ Cancel', callback_data:'adm_payments' }]])
    }
    const payEditLabel   = data.match(/^adm_pay_edit_label_(\w+)$/)
    if (payEditLabel)   { setSession(chatId,'pay_edit_label',{payId:payEditLabel[1]});   return editMsg(chatId,msgId,`✏️ Send new <b>display label</b>:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${payEditLabel[1]}`}]]) }
    const payEditCoin    = data.match(/^adm_pay_edit_coin_(\w+)$/)
    if (payEditCoin)    { setSession(chatId,'pay_edit_coin',{payId:payEditCoin[1]});     return editMsg(chatId,msgId,`🪙 Send new <b>coin symbol</b> (e.g. USDT, ETH, BNB):`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${payEditCoin[1]}`}]]) }
    const payEditNet     = data.match(/^adm_pay_edit_network_(\w+)$/)
    if (payEditNet)     { setSession(chatId,'pay_edit_network',{payId:payEditNet[1]});   return editMsg(chatId,msgId,`🌐 Send new <b>network</b> (e.g. TRC-20, ERC-20) or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${payEditNet[1]}`}]]) }
    const payEditAddr    = data.match(/^adm_pay_edit_address_(\w+)$/)
    if (payEditAddr)    { setSession(chatId,'pay_edit_address',{payId:payEditAddr[1]}); return editMsg(chatId,msgId,`📋 Send the new <b>wallet address</b>:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${payEditAddr[1]}`}]]) }

    // ── Bot settings buttons ─────────────────────────────────────────────────
    if (data==='adm_cfg_channel')      { setSession(chatId,'cfg_channel',{});      return editMsg(chatId,msgId,`📡 Send the <b>new channel username</b>:\n(e.g. @MyChannel)`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]]) }
    if (data==='adm_cfg_account_size') { setSession(chatId,'cfg_account_size',{}); return editMsg(chatId,msgId,`💰 Send <b>account size in USD</b>:\n(e.g. 10000)`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]]) }
    if (data==='adm_cfg_risk_pct')     { setSession(chatId,'cfg_risk_pct',{});     return editMsg(chatId,msgId,`⚖️ Send <b>risk % per trade</b>:\n(e.g. 1 for 1%)`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]]) }
    if (data==='adm_cfg_price_check')  { setSession(chatId,'cfg_price_check',{});  return editMsg(chatId,msgId,`⏱️ Send <b>price-check interval in seconds</b>:\n(minimum 5, recommended 30)`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]]) }
    if (data==='adm_cfg_oanda_token')  { setSession(chatId,'cfg_oanda_token',{});  return editMsg(chatId,msgId,`🔐 Send your <b>OANDA API token</b>:\n(Leave blank/send <code>none</code> to clear)`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]]) }
    if (data==='adm_cfg_oanda_env')    {
      const cur = getSetting('oanda_env')||'practice'
      const next = cur==='practice'?'live':'practice'
      setSetting('oanda_env',next)
      return screenBotSettings(chatId, msgId)
    }
    if (data==='adm_cfg_datasource')   {
      const cur = getSetting('data_source')||'twelvedata'
      const next = cur==='twelvedata'?'oanda':'twelvedata'
      setSetting('data_source',next)
      return screenBotSettings(chatId, msgId)
    }

    // ── Package management ───────────────────────────────────────────────────
    const pkgView   = data.match(/^adm_pkg_view_(\w+)$/)
    if (pkgView) return screenPackageView(chatId, pkgView[1], msgId)
    const pkgToggle = data.match(/^adm_pkg_toggle_(\w+)$/)
    if (pkgToggle) { const pkgs=loadPackages(),id=pkgToggle[1]; pkgs[id].active=!pkgs[id].active; savePackages(pkgs); return screenPackageView(chatId,id,msgId) }
    const pkgDel    = data.match(/^adm_pkg_delete_(\w+)$/)
    if (pkgDel) { const pkgs=loadPackages(),id=pkgDel[1],label=pkgs[id]?.label; delete pkgs[id]; savePackages(pkgs); return editMsg(chatId,msgId,`🗑️ Package "<b>${label}</b>" deleted.`,[[{text:'⬅️ Back',callback_data:'adm_pkg_list'}]]) }
    const editLabel = data.match(/^adm_pkg_edit_label_(\w+)$/)
    if (editLabel) { setSession(chatId,'edit_label',{pkgId:editLabel[1]}); return editMsg(chatId,msgId,`✏️ Send the <b>new label</b>:`,[[{text:'❌ Cancel',callback_data:`adm_pkg_view_${editLabel[1]}`}]]) }
    const editPrice = data.match(/^adm_pkg_edit_price_(\w+)$/)
    if (editPrice) { setSession(chatId,'edit_price',{pkgId:editPrice[1]}); return editMsg(chatId,msgId,`💰 Send the <b>new price in USD</b>:`,[[{text:'❌ Cancel',callback_data:`adm_pkg_view_${editPrice[1]}`}]]) }
    const editDays  = data.match(/^adm_pkg_edit_days_(\w+)$/)
    if (editDays)  { setSession(chatId,'edit_days',{pkgId:editDays[1]});  return editMsg(chatId,msgId,`📅 Send the <b>new duration in days</b>:`,[[{text:'❌ Cancel',callback_data:`adm_pkg_view_${editDays[1]}`}]]) }
    if (data==='adm_pkg_add') { setSession(chatId,'add_label',{}); return editMsg(chatId,msgId,`➕ <b>New Package</b>\n\nStep 1/3 — Send the <b>package name</b>:`,[[{text:'❌ Cancel',callback_data:'adm_pkg_list'}]]) }

    // ── Approve/deny from pending panel ─────────────────────────────────────
    const admApprove = data.match(/^adm_approve_(\d+)$/)
    if (admApprove) { await adminApprove(chatId, admApprove[1]); return screenAdminPending(chatId, msgId) }
    const admDeny    = data.match(/^adm_deny_(\d+)$/)
    if (admDeny)    { await adminDeny(chatId, admDeny[1]);       return screenAdminPending(chatId, msgId) }

    // ── Broadcast ────────────────────────────────────────────────────────────
    if (data==='adm_broadcast') {
      setSession(chatId,'broadcast_msg',{})
      return editMsg(chatId, msgId, `📢 <b>Broadcast to all subscribers</b>\n\nType your message and send it.\nSupports HTML formatting.\n\n⚠️ Sends to ALL active subscribers.`, [[{ text:'❌ Cancel', callback_data:'adm_home' }]])
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  LONG POLLING
// ─────────────────────────────────────────────────────────────────────────────
async function startPolling() {
  const s = loadSettings()
  console.log('🤖 Gold AI Subscription Bot v3 — Fully Dynamic')
  console.log(`   Channel:    ${s.channel}`)
  console.log(`   Admin:      ${ADMIN_ID}`)
  console.log(`   Plans:      ${getActivePackages().map(p=>`${p.label}=$${p.price}`).join(', ')}`)
  console.log(`   Timeframes: ${(s.live_timeframes||[]).join(', ')}`)
  console.log(`   API Keys:   ${(s.twelvedata_keys||[]).filter(k=>k.active).length} active`)
  console.log(`   Payments:   ${(s.payment_methods||[]).filter(m=>m.active!==false).map(m=>m.coin).join(', ')}`)
  let offset = 0
  while (true) {
    try {
      const res = await fetch(`${API}/getUpdates?offset=${offset}&timeout=1&allowed_updates=["message","callback_query"]`)
      const j = await res.json()
      if (!j.ok) { await sleep(3000); continue }
      const updates = j.result||[]
      for (const upd of updates) { offset=upd.update_id+1; handleUpdate(upd).catch(e=>console.error('[update error]',e.message)) }
      if (!updates.length) await sleep(300)
    } catch(e) { console.error('[poll error]',e.message); await sleep(3000) }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
//  EXPIRY CHECKER
// ─────────────────────────────────────────────────────────────────────────────
async function runExpiryChecker() {
  setInterval(async () => {
    const data=loadSubs(), now=new Date()
    for (const sub of Object.values(data)) {
      if (sub.status!=='active') continue
      const exp=new Date(sub.expiresAt), days=Math.ceil((exp-now)/86400000)
      if (days===3 && !sub.warned3d) { upsertSub(sub.chatId,{warned3d:true}); await send(sub.chatId,`⚠️ <b>Subscription Expiring Soon</b>\n\nYour <b>${sub.planLabel}</b> plan expires in <b>3 days</b>.\n\nRenew now:\n/start`).catch(()=>{}) }
      if (exp<=now) { upsertSub(sub.chatId,{status:'expired'}); await send(sub.chatId,`❌ <b>Subscription Expired</b>\n\nYour access has ended.\n\n/start — renew`).catch(()=>{}) }
    }
  }, 60*60*1000)
}

const sleep = ms => new Promise(r => setTimeout(r, ms))
runExpiryChecker()
startPolling()
