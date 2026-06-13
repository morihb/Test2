// ─────────────────────────────────────────────────────────────────────────────
//  GOLD.AI — Subscription Bot  v4 — Multi-Symbol + Fully Dynamic Admin
//
//  Each symbol (Gold, EUR/USD, BTC, etc.) is an independent product.
//  A user can subscribe to any combination — paying separately for each.
//  Signals are only delivered to subscribers of that specific symbol.
//
//  settings.json drives everything:
//    symbols[]         — all tradeable symbols (id, label, tickers, packages, active)
//    twelvedata_keys[] — API key pool with rotation
//    live_timeframes[] — default TFs (can be overridden per-symbol)
//    payment_methods[] — all payment methods (coin/network/address)
//    account_size, risk_pct, price_check_sec, data_source, channel, etc.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs'

// ── BOOTSTRAP (only these are truly hardcoded) ────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN     || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const ADMIN_ID = process.env.ADMIN_CHAT_ID || '1408577116'
if (!TG_TOKEN) { console.error('❌  TG_TOKEN not set'); process.exit(1) }

// ── FILE PATHS ────────────────────────────────────────────────────────────
const SUB_FILE      = './subscribers.json'
const SETTINGS_FILE = './settings.json'

// ─────────────────────────────────────────────────────────────────────────────
//  SETTINGS STORE
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_SETTINGS = {
  channel:         process.env.CHANNEL_USERNAME || '@MH_Signals',
  account_size:    10000,
  risk_pct:        1,
  price_check_sec: 30,
  data_source:     'twelvedata',
  oanda_token:     process.env.OANDA_TOKEN || '',
  oanda_env:       'practice',
  twelvedata_keys: [
    { key: process.env.TWELVEDATA_KEY || 'dbf374976088424aa703db6034942e19', label:'Key 1', active:true },
    { key: 'da16adf775b04e31a6a33386689e38c8', label:'Key 2', active:true },
    { key: '34034261d78440e28ece3d43ddd64955', label:'Key 3', active:true },
    { key: 'ef3ccaeaa4954935b193708cf86fa97d', label:'Key 4', active:true },
    { key: '9268e6afa5024f6a97ca03e44dcb59c0', label:'Key 5', active:true },
    { key: '78ce7374b05b4e33a3e1bd4c6311ff25', label:'Key 6', active:true },
  ],
  live_timeframes: ['15m','1h'],
  payment_methods: [
    { id:'usdt', label:'💵 USDT (TRC-20)', coin:'USDT', network:'TRC-20', address: process.env.USDT_ADDRESS||'TEST_USDT_ADDRESS', active:true },
    { id:'btc',  label:'₿ Bitcoin',        coin:'BTC',  network:'Bitcoin', address: process.env.BTC_ADDRESS||'TEST_BTC_ADDRESS',  active:true },
  ],
  // Each symbol has its own packages array and TF list
  // id must be a safe identifier (letters/numbers/underscore)
  symbols: [
    {
      id: 'gold', label: 'GOLD (XAU/USD)', emoji: '🥇',
      td_symbol: 'XAU/USD', oanda_symbol: 'XAU_USD', yahoo_symbol: 'XAUUSD=X', decimals: 2,
      timeframes: ['15m','1h'], active: true,
      packages: [
        { id:'g1', label:'1 Month',  price:50,  days:30,  active:true },
        { id:'g2', label:'3 Months', price:120, days:90,  active:true },
        { id:'g3', label:'6 Months', price:200, days:180, active:true },
      ]
    },
  ],
}

function loadSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE,'utf8')) } }
  catch { return { ...DEFAULT_SETTINGS } }
}
function saveSettings(s) { fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2)) }
function getSetting(k)    { return loadSettings()[k] }
function setSetting(k, v) { const s=loadSettings(); s[k]=v; saveSettings(s) }

// ── SYMBOL HELPERS ────────────────────────────────────────────────────────
function getSymbols()         { return getSetting('symbols') || [] }
function getActiveSymbols()   { return getSymbols().filter(s => s.active !== false) }
function getSymbol(id)        { return getSymbols().find(s => s.id === id) || null }
function saveSymbols(arr)     { setSetting('symbols', arr) }
function nextSymbolId(label)  { return label.toLowerCase().replace(/[^a-z0-9]/g,'_').slice(0,20) + '_' + Date.now().toString(36).slice(-4) }

function getSymbolPackages(symId) { return getSymbol(symId)?.packages || [] }
function getSymbolPackage(symId, pkgId) { return getSymbolPackages(symId).find(p => p.id === pkgId) || null }
function saveSymbolPackage(symId, pkg) {
  const syms = getSymbols(), s = syms.find(x => x.id === symId); if (!s) return
  const idx = s.packages.findIndex(p => p.id === pkg.id)
  if (idx >= 0) s.packages[idx] = pkg; else s.packages.push(pkg)
  saveSymbols(syms)
}
function deleteSymbolPackage(symId, pkgId) {
  const syms = getSymbols(), s = syms.find(x => x.id === symId); if (!s) return
  s.packages = s.packages.filter(p => p.id !== pkgId); saveSymbols(syms)
}
function nextPkgId(symId) {
  const ids = getSymbolPackages(symId).map(p => p.id)
  let i = 1; while (ids.includes(`${symId}_p${i}`)) i++
  return `${symId}_p${i}`
}

// ── API KEY / TF / PAYMENT HELPERS ────────────────────────────────────────
export function getActiveApiKeys()    { return (getSetting('twelvedata_keys')||[]).filter(k=>k.active).map(k=>k.key) }
export function getActiveTimeframes() { return getSetting('live_timeframes') || ['15m','1h'] }
export function getDataSource()       { return getSetting('data_source') || 'twelvedata' }
export function getAccountSize()      { return getSetting('account_size') || 10000 }
export function getRiskPct()          { return getSetting('risk_pct') || 1 }
export function getPriceCheckSec()    { return getSetting('price_check_sec') || 30 }
export function getOandaToken()       { return getSetting('oanda_token') || '' }
export function getOandaEnv()         { return getSetting('oanda_env') || 'practice' }
// Returns all active symbols with their TF lists for the launcher
export function getSymbolsForLauncher() {
  return getActiveSymbols().map(s => ({
    id: s.id, label: s.label, emoji: s.emoji||'📊',
    td_symbol: s.td_symbol, oanda_symbol: s.oanda_symbol,
    yahoo_symbol: s.yahoo_symbol, decimals: s.decimals||2,
    timeframes: s.timeframes || getActiveTimeframes(),
  }))
}

function getPayMethods()    { return (getSetting('payment_methods')||[]).filter(m=>m.active!==false) }
function getAllPayMethods()  { return getSetting('payment_methods') || [] }
function savePayMethods(arr){ setSetting('payment_methods', arr) }
function nextPayId()        { const ids=getAllPayMethods().map(m=>m.id); let i=1; while(ids.includes(`pm${i}`)) i++; return `pm${i}` }

// ─────────────────────────────────────────────────────────────────────────────
//  SUBSCRIBERS
//  Sub key: `${chatId}::${symbolId}`  — each symbol is independent
// ─────────────────────────────────────────────────────────────────────────────
function loadSubs()   { try { return JSON.parse(fs.readFileSync(SUB_FILE,'utf8')) } catch { return {} } }
function saveSubs(d)  { fs.writeFileSync(SUB_FILE, JSON.stringify(d, null, 2)) }

function subKey(chatId, symbolId) { return `${chatId}::${symbolId}` }
function getSub(chatId, symbolId) { return loadSubs()[subKey(chatId, symbolId)] || null }
function getAllSubsForUser(chatId) {
  const data = loadSubs()
  return Object.values(data).filter(s => s.chatId === String(chatId))
}
function upsertSub(chatId, symbolId, patch) {
  const data = loadSubs(), key = subKey(chatId, symbolId)
  data[key] = { ...data[key], ...patch, chatId:String(chatId), symbolId, updatedAt:new Date().toISOString() }
  saveSubs(data); return data[key]
}
function isActive(sub) {
  if (!sub || sub.status !== 'active') return false
  return new Date(sub.expiresAt) > new Date()
}
function activeSubscribersForSymbol(symbolId) {
  return Object.values(loadSubs()).filter(s => s.symbolId === symbolId && isActive(s))
}
function allActiveSubscribers() {
  return Object.values(loadSubs()).filter(s => isActive(s))
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROADCAST — per symbol
// ─────────────────────────────────────────────────────────────────────────────
export async function broadcastSignal(sigText, symbolId) {
  // If symbolId given: only that symbol's subscribers. Otherwise: all active subs.
  const subs = symbolId ? activeSubscribersForSymbol(symbolId) : allActiveSubscribers()
  let sent=0, failed=0
  for (const sub of subs) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chat_id:sub.chatId, text:sigText, parse_mode:'HTML' })
      })
      const j = await res.json()
      if (j.ok) sent++
      else { failed++; if (['blocked','kicked','deactivated','not_found'].some(w=>j.description?.toLowerCase().includes(w))) upsertSub(sub.chatId,sub.symbolId,{status:'bot_blocked'}) }
    } catch { failed++ }
    await new Promise(r=>setTimeout(r,50))
  }
  console.log(`[broadcast][${symbolId||'ALL'}] sent=${sent} failed=${failed}`)
  return { sent, failed }
}

// ── ADMIN SESSION ─────────────────────────────────────────────────────────
const adminSession = {}
function setSession(chatId, step, data={}) { adminSession[chatId]={step,data} }
function getSession(chatId) { return adminSession[chatId]||null }
function clearSession(chatId) { delete adminSession[chatId] }

// ── TELEGRAM API ──────────────────────────────────────────────────────────
const API = `https://api.telegram.org/bot${TG_TOKEN}`
async function tgCall(method, body={}) {
  const res=await fetch(`${API}/${method}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
  const j=await res.json(); if(!j.ok) console.error(`[TG] ${method}:`,j.description); return j
}
async function send(chatId, text, extra={})      { return tgCall('sendMessage',{chat_id:chatId,text,parse_mode:'HTML',...extra}) }
async function sendInline(chatId, text, buttons) { return send(chatId,text,{reply_markup:{inline_keyboard:buttons}}) }
async function editMsg(chatId, msgId, text, btns=null) {
  const body={chat_id:chatId,message_id:msgId,text,parse_mode:'HTML'}
  if(btns) body.reply_markup={inline_keyboard:btns}
  return tgCall('editMessageText',body)
}
async function answerCb(id,text='') { return tgCall('answerCallbackQuery',{callback_query_id:id,text}) }
async function isMember(chatId) {
  try { const r=await tgCall('getChatMember',{chat_id:getSetting('channel'),user_id:chatId}); return ['member','administrator','creator'].includes(r.result?.status) }
  catch { return false }
}

// ─────────────────────────────────────────────────────────────────────────────
//  USER FLOW
// ─────────────────────────────────────────────────────────────────────────────

// Main menu — shows all available symbols
async function screenStart(chatId, firstName) {
  const subs = getAllSubsForUser(chatId).filter(s => isActive(s))
  const activeSymIds = subs.map(s => s.symbolId)
  const symbols = getActiveSymbols()

  let welcome = `🟡 <b>GOLD AI — Premium Signals</b>\n\nMulti-asset trading signals powered by AI analysis.\n\n`
  if (activeSymIds.length) {
    welcome += `✅ Your active subscriptions: <b>${activeSymIds.map(id => getSymbol(id)?.label||id).join(', ')}</b>\n\n`
  }
  welcome += `<b>Select a market to subscribe or view details:</b>`

  const rows = symbols.map(s => {
    const active = activeSymIds.includes(s.id)
    return [{ text:`${active?'✅ ':''} ${s.emoji||'📊'} ${s.label}${active?' (Active)':''}`, callback_data:`sym_${s.id}` }]
  })
  rows.push([{ text:'📊 My Subscriptions', callback_data:'my_subs' }])
  return sendInline(chatId, welcome, rows)
}

// Symbol detail + packages
async function screenSymbol(chatId, symId, msgId) {
  const sym = getSymbol(symId); if (!sym) return
  const sub = getSub(chatId, symId)
  const active = isActive(sub)

  if (active) {
    const exp = new Date(sub.expiresAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
    const daysLeft = Math.ceil((new Date(sub.expiresAt)-new Date())/86400000)
    const rows = [[{ text:'⬅️ Back to Markets', callback_data:'back_home' }]]
    return editMsg(chatId, msgId,
`${sym.emoji||'📊'} <b>${sym.label}</b>

✅ <b>Subscription Active</b>
Expires: <b>${exp}</b> (${daysLeft} days left)

Signals for ${sym.label} are being delivered to this chat.`, rows)
  }

  if (sub?.status === 'pending_payment') return screenPayment(chatId, symId, sub.pendingPkg, sub.pendingMethod, msgId)

  const pkgs = sym.packages?.filter(p=>p.active!==false) || []
  if (!pkgs.length) return editMsg(chatId, msgId, `⚠️ No plans available for ${sym.label} right now.`, [[{text:'⬅️ Back',callback_data:'back_home'}]])

  const rows = pkgs.map(p => [{ text:`📦 ${p.label} — $${p.price}`, callback_data:`pkg_${symId}_${p.id}` }])
  rows.push([{ text:'⬅️ Back to Markets', callback_data:'back_home' }])
  return editMsg(chatId, msgId,
`${sym.emoji||'📊'} <b>${sym.label}</b>

Timeframes: <b>${(sym.timeframes||['15m','1h']).join(', ')}</b>
Data: <b>${sym.td_symbol}</b>

<b>Choose your subscription plan:</b>`, rows)
}

async function screenPickPayment(chatId, symId, pkgId, msgId) {
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId, pkgId)
  if (!sym || !pkg) return
  upsertSub(chatId, symId, { status:'pending_payment', pendingPkg:pkgId, msgId })
  const methods = getPayMethods()
  if (!methods.length) return send(chatId, '⚠️ No payment methods available.')
  const rows = methods.map(m => [{ text:m.label, callback_data:`pay_${symId}_${pkgId}_${m.id}` }])
  rows.push([{ text:'⬅️ Back', callback_data:`sym_${symId}` }])
  await editMsg(chatId, msgId, `${sym.emoji||'📊'} <b>${sym.label} — ${pkg.label} ($${pkg.price})</b>\n\nChoose your payment method:`, rows)
}

async function screenPayment(chatId, symId, pkgId, methodId, msgId) {
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId, pkgId)
  const method = getAllPayMethods().find(m=>m.id===methodId)
  if (!sym || !pkg || !method) return
  upsertSub(chatId, symId, { status:'pending_payment', pendingPkg:pkgId, pendingMethod:methodId, msgId })
  const rows = [
    [{ text:'✅ I Sent the Payment', callback_data:`confirm_${symId}_${pkgId}_${methodId}` }],
    [{ text:'⬅️ Back to Methods',   callback_data:`pkg_${symId}_${pkgId}` }],
  ]
  await editMsg(chatId, msgId,
`💳 <b>Payment Instructions</b>

Market: <b>${sym.label}</b>
Plan: <b>${pkg.label} — $${pkg.price}</b>
Method: <b>${method.label}</b>

Send exactly <b>$${pkg.price} worth of ${method.coin}</b>${method.network?` (${method.network})`:''} to:

<code>${method.address}</code>

⚠️ Include your Telegram ID <code>${chatId}</code> in memo if possible.

After sending, press <b>"I Sent the Payment"</b> below.`, rows)
}

async function screenConfirmPending(chatId, symId, pkgId, methodId, msgId) {
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId, pkgId)
  const method = getAllPayMethods().find(m=>m.id===methodId)
  upsertSub(chatId, symId, { status:'awaiting_admin', pendingPkg:pkgId, pendingMethod:methodId, msgId, claimedAt:new Date().toISOString() })
  if (ADMIN_ID) {
    await send(ADMIN_ID,
`🔔 <b>New Payment Claim</b>

User: <a href="tg://user?id=${chatId}">${chatId}</a>
Market: ${sym?.label}
Plan: ${pkg?.label} — $${pkg?.price}
Method: ${method?.label}
Claimed: ${new Date().toLocaleString()}

/approve ${chatId} ${symId}  or  /deny ${chatId} ${symId}`)
  }
  const channel = getSetting('channel')
  const rows = [
    [{ text:`✅ Join ${channel}`, url:`https://t.me/${channel.replace('@','')}` }],
    [{ text:'🔄 I Joined — Check Status', callback_data:`checkjoin_${symId}_${pkgId}_${methodId}` }],
  ]
  await editMsg(chatId, msgId,
`⏳ <b>Payment Under Review</b>

Thank you! Your payment is being verified.

Join our channel while you wait:
${channel}`, rows)
}

async function screenCheckJoin(chatId, symId, pkgId, methodId, msgId) {
  const joined = await isMember(chatId), sub = getSub(chatId, symId), channel = getSetting('channel')
  if (!joined) {
    const rows = [
      [{ text:`✅ Join ${channel}`, url:`https://t.me/${channel.replace('@','')}` }],
      [{ text:'🔄 Check Again', callback_data:`checkjoin_${symId}_${pkgId}_${methodId}` }],
    ]
    return editMsg(chatId, msgId, `❌ <b>Not joined yet</b>\n\nJoin ${channel} first then check again.`, rows)
  }
  upsertSub(chatId, symId, { joinedChannel:true })
  if (isActive(sub)) return editMsg(chatId, msgId, `🎉 <b>You're all set!</b>\n\n✅ Channel joined\n✅ Subscription active\n\nSignals will arrive here. 🟡`)
  return editMsg(chatId, msgId, `✅ <b>Channel joined!</b>\n\nPayment still under review. Usually 10–30 minutes.`)
}

async function screenMySubs(chatId, msgId) {
  const subs = getAllSubsForUser(chatId)
  if (!subs.length) {
    const rows = [[{ text:'⬅️ Back', callback_data:'back_home' }]]
    return editMsg(chatId, msgId, '📊 You have no subscriptions yet.\n\nUse the market list to subscribe.', rows)
  }
  const lines = subs.map(s => {
    const sym = getSymbol(s.symbolId)
    if (isActive(s)) {
      const exp = new Date(s.expiresAt).toLocaleDateString()
      const days = Math.ceil((new Date(s.expiresAt)-new Date())/86400000)
      return `✅ ${sym?.emoji||''} <b>${sym?.label||s.symbolId}</b> — expires ${exp} (${days}d)`
    }
    if (s.status==='awaiting_admin') return `⏳ ${sym?.label||s.symbolId} — payment under review`
    if (s.status==='expired') return `❌ ${sym?.label||s.symbolId} — expired`
    return `${sym?.label||s.symbolId} — ${s.status}`
  })
  const rows = [[{ text:'⬅️ Back', callback_data:'back_home' }]]
  await editMsg(chatId, msgId, `📊 <b>My Subscriptions</b>\n\n${lines.join('\n')}`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — HOME
// ─────────────────────────────────────────────────────────────────────────────
async function screenAdminHome(chatId) {
  const total = allActiveSubscribers().length
  const pending = Object.values(loadSubs()).filter(s=>s.status==='awaiting_admin').length
  const syms = getActiveSymbols(), keys = (getSetting('twelvedata_keys')||[]).filter(k=>k.active).length
  const rows = [
    [{ text:`📊 Symbols (${syms.length} active)`,        callback_data:'adm_symbols'   }],
    [{ text:`👥 All Subscribers (${total})`,             callback_data:'adm_subs'      }],
    [{ text:`⏳ Pending Approvals (${pending})`,          callback_data:'adm_pending'   }],
    [{ text:`🔑 API Keys (${keys} active)`,              callback_data:'adm_keys'      }],
    [{ text:'💳 Payment Methods',                         callback_data:'adm_payments'  }],
    [{ text:'⚙️ Bot Settings',                           callback_data:'adm_botsettings'}],
    [{ text:'📢 Broadcast',                               callback_data:'adm_broadcast_pick'}],
  ]
  return sendInline(chatId,
`🔧 <b>GOLD AI Admin Panel</b>

Active subscribers: <b>${total}</b>
Pending approvals: <b>${pending}</b>
Active symbols: <b>${syms.length}</b>
API keys: <b>${keys} active</b>`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — SYMBOLS MANAGER
// ─────────────────────────────────────────────────────────────────────────────
async function screenSymbolsManager(chatId, msgId) {
  const syms = getSymbols()
  const rows = syms.map(s => [{
    text:`${s.active!==false?'✅':'❌'} ${s.emoji||'📊'} ${s.label}`,
    callback_data:`adm_sym_view_${s.id}`
  }])
  rows.push([{ text:'➕ Add New Symbol', callback_data:'adm_sym_add' }])
  rows.push([{ text:'⬅️ Back',           callback_data:'adm_home'   }])
  const text=`📊 <b>Symbols Manager</b>\n\nEach symbol is a separate product with its own packages and subscribers.\n\nActive: <b>${syms.filter(s=>s.active!==false).length}/${syms.length}</b>`
  return msgId ? editMsg(chatId,msgId,text,rows) : sendInline(chatId,text,rows)
}

async function screenSymbolView(chatId, msgId, symId) {
  const sym = getSymbol(symId); if (!sym) return
  const subsCount = activeSubscribersForSymbol(symId).length
  const rows = [
    [{ text:'✏️ Edit Label',      callback_data:`adm_sym_edit_label_${symId}`      },
     { text:'🪙 Edit TD Symbol',  callback_data:`adm_sym_edit_td_${symId}`         }],
    [{ text:'🔌 Edit OANDA Sym',  callback_data:`adm_sym_edit_oanda_${symId}`      },
     { text:'📈 Edit Yahoo Sym',  callback_data:`adm_sym_edit_yahoo_${symId}`      }],
    [{ text:'🔢 Edit Decimals',   callback_data:`adm_sym_edit_dec_${symId}`        },
     { text:'😀 Edit Emoji',      callback_data:`adm_sym_edit_emoji_${symId}`      }],
    [{ text:'📊 Timeframes',      callback_data:`adm_sym_tfs_${symId}`             }],
    [{ text:'📦 Packages',        callback_data:`adm_sym_pkgs_${symId}`            }],
    [{ text:'👥 Subscribers',     callback_data:`adm_sym_subs_${symId}`            }],
    [{ text: sym.active!==false ? '🚫 Disable Symbol' : '✅ Enable Symbol', callback_data:`adm_sym_toggle_${symId}` }],
    [{ text:'🗑️ Delete Symbol',   callback_data:`adm_sym_delete_${symId}`         }],
    [{ text:'⬅️ Back',            callback_data:'adm_symbols'                      }],
  ]
  await editMsg(chatId,msgId,
`📊 <b>${sym.emoji||''} ${sym.label}</b>

TwelveData: <code>${sym.td_symbol}</code>
OANDA: <code>${sym.oanda_symbol}</code>
Yahoo: <code>${sym.yahoo_symbol}</code>
Decimals: <b>${sym.decimals}</b>
Timeframes: <b>${(sym.timeframes||[]).join(', ')}</b>
Active subscribers: <b>${subsCount}</b>
Status: ${sym.active!==false?'✅ Active':'❌ Disabled'}`, rows)
}

// Per-symbol TF toggling
async function screenSymbolTFs(chatId, msgId, symId) {
  const sym = getSymbol(symId); if (!sym) return
  const active = sym.timeframes || []
  const ALL_TF = ['1m','3m','5m','15m','30m','1h','2h','4h','1d']
  const rows = ALL_TF.map(tf => [{ text:`${active.includes(tf)?'✅':'⬜'} ${tf}`, callback_data:`adm_sym_tf_toggle_${symId}_${tf}` }])
  rows.push([{ text:'⬅️ Back', callback_data:`adm_sym_view_${symId}` }])
  await editMsg(chatId,msgId,`📊 <b>${sym.label} — Timeframes</b>\n\nActive: <b>${active.join(', ')||'none'}</b>`, rows)
}

// Per-symbol packages
async function screenSymbolPackages(chatId, msgId, symId) {
  const sym = getSymbol(symId); if (!sym) return
  const pkgs = sym.packages || []
  const rows = pkgs.map(p => [{
    text:`${p.active!==false?'✅':'❌'} ${p.label} — $${p.price} (${p.days}d)`,
    callback_data:`adm_sym_pkg_view_${symId}_${p.id}`
  }])
  rows.push([{ text:'➕ Add Package', callback_data:`adm_sym_pkg_add_${symId}` }])
  rows.push([{ text:'⬅️ Back',       callback_data:`adm_sym_view_${symId}`    }])
  await editMsg(chatId,msgId,`📦 <b>${sym.label} — Packages</b>`, rows)
}

async function screenSymbolPackageView(chatId, msgId, symId, pkgId) {
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId,pkgId); if(!sym||!pkg) return
  const rows = [
    [{ text:'✏️ Edit Label', callback_data:`adm_sym_pkg_label_${symId}_${pkgId}` },
     { text:'💰 Edit Price', callback_data:`adm_sym_pkg_price_${symId}_${pkgId}` }],
    [{ text:'📅 Edit Days',  callback_data:`adm_sym_pkg_days_${symId}_${pkgId}`  },
     { text: pkg.active!==false?'🚫 Disable':'✅ Enable', callback_data:`adm_sym_pkg_toggle_${symId}_${pkgId}` }],
    [{ text:'🗑️ Delete',    callback_data:`adm_sym_pkg_del_${symId}_${pkgId}`   }],
    [{ text:'⬅️ Back',      callback_data:`adm_sym_pkgs_${symId}`               }],
  ]
  await editMsg(chatId,msgId,`📦 <b>${sym.label} — ${pkg.label}</b>\n\nPrice: $${pkg.price}\nDuration: ${pkg.days} days\nStatus: ${pkg.active!==false?'✅ Active':'❌ Hidden'}`, rows)
}

async function screenSymbolSubs(chatId, msgId, symId) {
  const sym = getSymbol(symId), subs = activeSubscribersForSymbol(symId)
  if (!subs.length) return editMsg(chatId,msgId,`No active subscribers for ${sym?.label}.`,[[{text:'⬅️ Back',callback_data:`adm_sym_view_${symId}`}]])
  const lines = subs.map(s=>`• <code>${s.chatId}</code> — ${s.planLabel||s.plan} — ${new Date(s.expiresAt).toLocaleDateString()}`)
  await editMsg(chatId,msgId,`👥 <b>${sym?.label} Subscribers (${subs.length})</b>\n\n${lines.join('\n')}`,[[{text:'⬅️ Back',callback_data:`adm_sym_view_${symId}`}]])
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — GLOBAL SUBSCRIBERS / PENDING
// ─────────────────────────────────────────────────────────────────────────────
async function screenAdminSubs(chatId, msgId) {
  const subs = allActiveSubscribers()
  if (!subs.length) return editMsg(chatId,msgId,'No active subscribers.',[[{text:'⬅️ Back',callback_data:'adm_home'}]])
  const lines = subs.map(s=>{
    const sym=getSymbol(s.symbolId); return `• <code>${s.chatId}</code> — ${sym?.emoji||''} ${sym?.label||s.symbolId} — ${s.planLabel||s.plan} — ${new Date(s.expiresAt).toLocaleDateString()}`
  })
  await editMsg(chatId,msgId,`👥 <b>All Active Subscribers (${subs.length})</b>\n\n${lines.join('\n')}`,[[{text:'⬅️ Back',callback_data:'adm_home'}]])
}

async function screenAdminPending(chatId, msgId) {
  const pending = Object.values(loadSubs()).filter(s=>s.status==='awaiting_admin')
  if (!pending.length) return editMsg(chatId,msgId,'✅ No pending approvals.',[[{text:'⬅️ Back',callback_data:'adm_home'}]])
  const rows = pending.map(s=>{
    const sym=getSymbol(s.symbolId)
    return [
      { text:`✅ Approve ${s.chatId} (${sym?.label||s.symbolId})`, callback_data:`adm_approve_${s.chatId}_${s.symbolId}` },
      { text:'❌ Deny', callback_data:`adm_deny_${s.chatId}_${s.symbolId}` },
    ]
  })
  rows.push([{text:'⬅️ Back',callback_data:'adm_home'}])
  const lines = pending.map(s=>{
    const sym=getSymbol(s.symbolId), pkg=getSymbolPackage(s.symbolId,s.pendingPkg)
    return `• <code>${s.chatId}</code> — ${sym?.emoji||''} ${sym?.label||s.symbolId} — ${pkg?.label||s.pendingPkg} — ${s.pendingMethod?.toUpperCase()||''}`
  })
  await editMsg(chatId,msgId,`⏳ <b>Pending Approvals (${pending.length})</b>\n\n${lines.join('\n')}`,rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — BROADCAST PICK SYMBOL
// ─────────────────────────────────────────────────────────────────────────────
async function screenBroadcastPick(chatId, msgId) {
  const syms = getActiveSymbols()
  const rows = syms.map(s=>[{text:`${s.emoji||'📊'} ${s.label}`, callback_data:`adm_broadcast_sym_${s.id}`}])
  rows.push([{ text:'📢 Broadcast to ALL subscribers', callback_data:'adm_broadcast_all' }])
  rows.push([{ text:'⬅️ Back', callback_data:'adm_home' }])
  return msgId ? editMsg(chatId,msgId,'📢 <b>Choose broadcast target:</b>',rows) : sendInline(chatId,'📢 <b>Choose broadcast target:</b>',rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — API KEYS
// ─────────────────────────────────────────────────────────────────────────────
async function screenApiKeys(chatId, msgId) {
  const keys=getSetting('twelvedata_keys')||[]
  const rows=keys.map((k,i)=>[{text:`${k.active?'✅':'❌'} ${k.label} — ${k.key.slice(0,8)}…`,callback_data:`adm_key_view_${i}`}])
  rows.push([{text:'➕ Add API Key',callback_data:'adm_key_add'}])
  rows.push([{text:'⬅️ Back',callback_data:'adm_home'}])
  const text=`🔑 <b>TwelveData API Keys</b>\n\nActive: <b>${keys.filter(k=>k.active).length}/${keys.length}</b>`
  return msgId?editMsg(chatId,msgId,text,rows):sendInline(chatId,text,rows)
}
async function screenApiKeyView(chatId,msgId,idx) {
  const keys=getSetting('twelvedata_keys')||[],k=keys[idx]; if(!k) return
  const rows=[[{text:'✏️ Edit Label',callback_data:`adm_key_edit_label_${idx}`},{text:'🔑 Replace Key',callback_data:`adm_key_edit_key_${idx}`}],[{text:'🧪 Test Key',callback_data:`adm_key_test_${idx}`}],[{text:k.active?'🚫 Disable':'✅ Enable',callback_data:`adm_key_toggle_${idx}`},{text:'🗑️ Delete',callback_data:`adm_key_delete_${idx}`}],[{text:'⬅️ Back',callback_data:'adm_keys'}]]
  await editMsg(chatId,msgId,`🔑 <b>${k.label}</b>\n\nKey: <code>${k.key}</code>\nStatus: ${k.active?'✅ Active':'❌ Disabled'}`,rows)
}
async function testApiKey(key) {
  try { const res=await fetch(`https://api.twelvedata.com/price?symbol=XAU/USD&apikey=${key}`,{signal:AbortSignal.timeout(8000)}); const j=await res.json(); if(j.price) return {ok:true,price:j.price}; return {ok:false,reason:j.message||JSON.stringify(j)} }
  catch(e) { return {ok:false,reason:e.message} }
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — PAYMENT METHODS
// ─────────────────────────────────────────────────────────────────────────────
async function screenPayments(chatId,msgId) {
  const methods=getAllPayMethods()
  const rows=methods.map(m=>[{text:`${m.active!==false?'✅':'❌'} ${m.label} (${m.coin})`,callback_data:`adm_pay_view_${m.id}`}])
  rows.push([{text:'➕ Add Method',callback_data:'adm_pay_add'},{text:'⬅️ Back',callback_data:'adm_home'}])
  const text=`💳 <b>Payment Methods</b>\n\nActive: <b>${methods.filter(m=>m.active!==false).length}/${methods.length}</b>`
  return msgId?editMsg(chatId,msgId,text,rows):sendInline(chatId,text,rows)
}
async function screenPaymentView(chatId,msgId,payId) {
  const m=getAllPayMethods().find(x=>x.id===payId); if(!m) return
  const rows=[[{text:'✏️ Label',callback_data:`adm_pay_edit_label_${payId}`},{text:'🪙 Coin',callback_data:`adm_pay_edit_coin_${payId}`}],[{text:'🌐 Network',callback_data:`adm_pay_edit_network_${payId}`},{text:'📋 Address',callback_data:`adm_pay_edit_address_${payId}`}],[{text:m.active!==false?'🚫 Disable':'✅ Enable',callback_data:`adm_pay_toggle_${payId}`},{text:'🗑️ Delete',callback_data:`adm_pay_delete_${payId}`}],[{text:'⬅️ Back',callback_data:'adm_payments'}]]
  await editMsg(chatId,msgId,`💳 <b>${m.label}</b>\n\nCoin: <b>${m.coin}</b>\nNetwork: <b>${m.network||'—'}</b>\nAddress: <code>${m.address}</code>\nStatus: ${m.active!==false?'✅':'❌'}`,rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — BOT SETTINGS
// ─────────────────────────────────────────────────────────────────────────────
async function screenBotSettings(chatId,msgId) {
  const s=loadSettings()
  const rows=[[{text:'📡 Channel',callback_data:'adm_cfg_channel'},{text:'💰 Account Size',callback_data:'adm_cfg_account_size'}],[{text:'⚖️ Risk %',callback_data:'adm_cfg_risk_pct'},{text:'⏱️ Price Check',callback_data:'adm_cfg_price_check'}],[{text:'🔌 Data Source ('+s.data_source+')',callback_data:'adm_cfg_datasource'},{text:'🌐 OANDA Env ('+s.oanda_env+')',callback_data:'adm_cfg_oanda_env'}],[{text:'🔐 OANDA Token',callback_data:'adm_cfg_oanda_token'}],[{text:'⬅️ Back',callback_data:'adm_home'}]]
  const text=`⚙️ <b>Bot Settings</b>\n\n📡 Channel: <b>${s.channel}</b>\n💰 Account: <b>$${s.account_size.toLocaleString()}</b>\n⚖️ Risk: <b>${s.risk_pct}%</b>\n⏱️ Price check: <b>${s.price_check_sec}s</b>\n🔌 Source: <b>${s.data_source}</b>\n🌐 OANDA: <b>${s.oanda_env}</b>`
  return msgId?editMsg(chatId,msgId,text,rows):sendInline(chatId,text,rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN ACTIONS
// ─────────────────────────────────────────────────────────────────────────────
async function adminApprove(adminChatId, targetChatId, symId) {
  const sub = getSub(targetChatId, symId)
  if (!sub) return send(adminChatId,`❌ No pending sub for ${targetChatId} / ${symId}`)
  if (isActive(sub)) return send(adminChatId,`ℹ️ Already active until ${new Date(sub.expiresAt).toLocaleDateString()}`)
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId, sub.pendingPkg)
  if (!pkg) return send(adminChatId,`❌ Package ${sub.pendingPkg} not found`)
  const now=new Date(), exp=new Date(now.getTime()+pkg.days*86400000)
  upsertSub(targetChatId, symId, { status:'active', plan:pkg.id, planLabel:pkg.label, price:pkg.price, activatedAt:now.toISOString(), expiresAt:exp.toISOString(), pendingPkg:null, pendingMethod:null })
  const expStr=exp.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
  await send(adminChatId,`✅ Approved ${targetChatId} for ${sym?.label} — ${pkg.label} until ${expStr}`)
  await send(targetChatId,`🎉 <b>Payment Confirmed!</b>\n\nMarket: <b>${sym?.emoji||''} ${sym?.label}</b>\nPlan: <b>${pkg.label}</b> — Active until <b>${expStr}</b>\n\nSignals will be sent here automatically. 🟡`)
}

async function adminDeny(adminChatId, targetChatId, symId) {
  const sub = getSub(targetChatId, symId); if (!sub) return send(adminChatId,`❌ Not found`)
  const sym=getSymbol(symId), pkg=getSymbolPackage(symId,sub.pendingPkg)
  upsertSub(targetChatId,symId,{status:'denied',pendingPkg:null,pendingMethod:null})
  await send(adminChatId,`✅ Denied ${targetChatId} for ${sym?.label}.`)
  await send(targetChatId,`❌ <b>Payment Not Confirmed</b>\n\nCould not verify your payment for ${sym?.label} — ${pkg?.label||''}.\n\nPlease try again.\n/start`)
}

async function adminRevoke(adminChatId, targetChatId, symId) {
  upsertSub(targetChatId,symId,{status:'revoked',expiresAt:new Date().toISOString()})
  const sym=getSymbol(symId)
  await send(adminChatId,`✅ Revoked ${targetChatId} from ${sym?.label}.`)
  await send(targetChatId,`⚠️ Your ${sym?.label||symId} subscription has been revoked.`)
}

// ─────────────────────────────────────────────────────────────────────────────
//  UPDATE ROUTER
// ─────────────────────────────────────────────────────────────────────────────
async function handleUpdate(upd) {
  // ── MESSAGES ──────────────────────────────────────────────────────────────
  if (upd.message) {
    const msg=upd.message, chatId=String(msg.chat.id), text=msg.text||''
    const isAdmin=chatId===String(ADMIN_ID), firstName=msg.from?.first_name||'there'
    const sess=getSession(chatId)

    if (isAdmin && sess) {
      const {step,data}=sess

      // Symbol add steps
      if(step==='sym_add_label')   { setSession(chatId,'sym_add_td',{label:text});        return send(chatId,`📡 TwelveData symbol for "<b>${text}</b>":\n(e.g. EUR/USD, BTC/USD, AAPL, NAS100)`) }
      if(step==='sym_add_td')      { setSession(chatId,'sym_add_oanda',{...data,td:text.trim()});   return send(chatId,`🔌 OANDA instrument:\n(e.g. EUR_USD, BTC_USD — or send <code>none</code>)`) }
      if(step==='sym_add_oanda')   { setSession(chatId,'sym_add_yahoo',{...data,oanda:text==='none'?'':text.trim()}); return send(chatId,`📈 Yahoo Finance ticker:\n(e.g. EURUSD=X, BTC-USD — or <code>none</code>)`) }
      if(step==='sym_add_yahoo')   { setSession(chatId,'sym_add_dec',{...data,yahoo:text==='none'?'':text.trim()});   return send(chatId,`🔢 Decimal places for price display:\n(2 for forex/gold, 5 for pairs like EURUSD, 0 for indices)`) }
      if(step==='sym_add_dec')     { setSession(chatId,'sym_add_emoji',{...data,dec:parseInt(text)||2}); return send(chatId,`😀 Emoji for this market (e.g. 💶 🪙 📈 💹) or send <code>none</code>:`) }
      if(step==='sym_add_emoji') {
        const syms=getSymbols(), id=nextSymbolId(data.label)
        syms.push({ id, label:data.label, emoji:text==='none'?'📊':text.trim(), td_symbol:data.td, oanda_symbol:data.oanda, yahoo_symbol:data.yahoo, decimals:data.dec, timeframes:['15m','1h'], active:true, packages:[] })
        saveSymbols(syms); clearSession(chatId)
        return send(chatId,`✅ <b>Symbol Added!</b>\n\nLabel: ${data.label}\nTwelveData: <code>${data.td}</code>\nOANDA: <code>${data.oanda||'—'}</code>\nYahoo: <code>${data.yahoo||'—'}</code>\nDecimals: ${data.dec}\nID: <code>${id}</code>\n\nNow add packages via /admin → Symbols → ${data.label} → Packages`)
      }

      // Symbol edit steps
      if(step==='sym_edit_label') { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.label=text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ Label updated to "<b>${text.trim()}</b>"\n\n/admin`) }
      if(step==='sym_edit_td')    { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.td_symbol=text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ TwelveData symbol updated to <code>${text.trim()}</code>\n\n/admin`) }
      if(step==='sym_edit_oanda') { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.oanda_symbol=text==='none'?'':text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ OANDA symbol updated.\n\n/admin`) }
      if(step==='sym_edit_yahoo') { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.yahoo_symbol=text==='none'?'':text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ Yahoo symbol updated.\n\n/admin`) }
      if(step==='sym_edit_dec')   { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.decimals=parseInt(text)||2; saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ Decimals updated to <b>${parseInt(text)||2}</b>\n\n/admin`) }
      if(step==='sym_edit_emoji') { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.emoji=text==='none'?'📊':text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ Emoji updated.\n\n/admin`) }

      // Symbol package steps
      if(step==='sym_pkg_add_label') { setSession(chatId,'sym_pkg_add_price',{...data,label:text}); return send(chatId,`💰 Price in USD for "<b>${text}</b>":`) }
      if(step==='sym_pkg_add_price') { const p=parseFloat(text); if(isNaN(p)||p<=0) return send(chatId,'❌ Invalid price:'); setSession(chatId,'sym_pkg_add_days',{...data,price:p}); return send(chatId,`📅 Duration in days:`) }
      if(step==='sym_pkg_add_days') {
        const d=parseInt(text); if(isNaN(d)||d<=0) return send(chatId,'❌ Invalid days:')
        const id=nextPkgId(data.symId); saveSymbolPackage(data.symId,{id,label:data.label,price:data.price,days:d,active:true}); clearSession(chatId)
        return send(chatId,`✅ <b>Package Added!</b>\n\n${data.label} — $${data.price} / ${d} days\n\n/admin`)
      }
      if(step==='sym_pkg_label') { const pkg=getSymbolPackage(data.symId,data.pkgId); if(pkg){pkg.label=text.trim();saveSymbolPackage(data.symId,pkg);} clearSession(chatId); return send(chatId,`✅ Label updated.\n\n/admin`) }
      if(step==='sym_pkg_price') { const p=parseFloat(text); if(isNaN(p)||p<=0) return send(chatId,'❌ Invalid:'); const pkg=getSymbolPackage(data.symId,data.pkgId); if(pkg){pkg.price=p;saveSymbolPackage(data.symId,pkg);} clearSession(chatId); return send(chatId,`✅ Price updated to $${p}\n\n/admin`) }
      if(step==='sym_pkg_days')  { const d=parseInt(text); if(isNaN(d)||d<=0) return send(chatId,'❌ Invalid:'); const pkg=getSymbolPackage(data.symId,data.pkgId); if(pkg){pkg.days=d;saveSymbolPackage(data.symId,pkg);} clearSession(chatId); return send(chatId,`✅ Duration updated to ${d} days\n\n/admin`) }

      // API key steps
      if(step==='add_key_label') { setSession(chatId,'add_key_value',{label:text}); return send(chatId,`🔑 Send the <b>API key string</b> for "<b>${text}</b>":`) }
      if(step==='add_key_value') { const keys=getSetting('twelvedata_keys')||[]; keys.push({key:text.trim(),label:data.label,active:true}); setSetting('twelvedata_keys',keys); clearSession(chatId); return send(chatId,`✅ Key "<b>${data.label}</b>" added.\n\n/admin`) }
      if(step==='edit_key_label') { const keys=getSetting('twelvedata_keys')||[]; keys[data.idx].label=text.trim(); setSetting('twelvedata_keys',keys); clearSession(chatId); return send(chatId,`✅ Key label updated.\n\n/admin`) }
      if(step==='edit_key_value') { const keys=getSetting('twelvedata_keys')||[]; keys[data.idx].key=text.trim(); setSetting('twelvedata_keys',keys); clearSession(chatId); return send(chatId,`✅ API key replaced.\n\n/admin`) }

      // Payment method steps
      if(step==='pay_add_label')   { setSession(chatId,'pay_add_coin',{label:text}); return send(chatId,`🪙 Coin symbol (e.g. USDT, BTC, ETH):`) }
      if(step==='pay_add_coin')    { setSession(chatId,'pay_add_network',{...data,coin:text.toUpperCase()}); return send(chatId,`🌐 Network (e.g. TRC-20, ERC-20) or <code>none</code>:`) }
      if(step==='pay_add_network') { setSession(chatId,'pay_add_address',{...data,network:text==='none'?'':text}); return send(chatId,`📋 Wallet address:`) }
      if(step==='pay_add_address') { const m=getAllPayMethods(),id=nextPayId(); m.push({id,label:data.label,coin:data.coin,network:data.network,address:text.trim(),active:true}); savePayMethods(m); clearSession(chatId); return send(chatId,`✅ Payment method "<b>${data.label}</b>" added.\n\n/admin`) }
      if(step==='pay_edit_label')   { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].label=text.trim();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Updated.\n\n/admin`) }
      if(step==='pay_edit_coin')    { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].coin=text.trim().toUpperCase();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Updated.\n\n/admin`) }
      if(step==='pay_edit_network') { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].network=text==='none'?'':text.trim();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Updated.\n\n/admin`) }
      if(step==='pay_edit_address') { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].address=text.trim();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Address updated:\n<code>${text.trim()}</code>\n\n/admin`) }

      // Bot settings
      if(step==='cfg_channel')      { setSetting('channel',text.trim()); clearSession(chatId); return send(chatId,`✅ Channel → <b>${text.trim()}</b>\n\n/admin`) }
      if(step==='cfg_account_size') { const v=parseFloat(text); if(isNaN(v)||v<=0) return send(chatId,'❌ Invalid:'); setSetting('account_size',v); clearSession(chatId); return send(chatId,`✅ Account size → $${v.toLocaleString()}\n\n/admin`) }
      if(step==='cfg_risk_pct')     { const v=parseFloat(text); if(isNaN(v)||v<=0) return send(chatId,'❌ Invalid:'); setSetting('risk_pct',v); clearSession(chatId); return send(chatId,`✅ Risk → ${v}%\n\n/admin`) }
      if(step==='cfg_price_check')  { const v=parseInt(text); if(isNaN(v)||v<5) return send(chatId,'❌ Min 5s:'); setSetting('price_check_sec',v); clearSession(chatId); return send(chatId,`✅ Price check → ${v}s\n\n⚠️ Restart launcher to apply.\n\n/admin`) }
      if(step==='cfg_oanda_token')  { setSetting('oanda_token',text.trim()==='none'?'':text.trim()); clearSession(chatId); return send(chatId,`✅ OANDA token saved.\n\n/admin`) }

      // Broadcast
      if(step==='broadcast_msg') {
        const symId=data.symId||null; clearSession(chatId)
        const r=await broadcastSignal(text,symId)
        const target=symId?getSymbol(symId)?.label:'ALL subscribers'
        return send(chatId,`📢 Broadcast sent to <b>${target}</b>!\n\n✅ Delivered: ${r.sent}\n❌ Failed: ${r.failed}`)
      }

      if(text.startsWith('/')) clearSession(chatId)
    }

    // ── Regular commands ────────────────────────────────────────────────────
    if(text==='/start')  return screenStart(chatId,firstName)
    if(text==='/status') {
      const subs=getAllSubsForUser(chatId)
      if(!subs.length) return send(chatId,'No subscriptions found.\n\n/start — view markets')
      const active=subs.filter(s=>isActive(s))
      if(!active.length) return send(chatId,'No active subscriptions.\n\n/start — renew or subscribe to a market')
      const lines=active.map(s=>{const sym=getSymbol(s.symbolId),exp=new Date(s.expiresAt).toLocaleDateString(),d=Math.ceil((new Date(s.expiresAt)-new Date())/86400000);return `${sym?.emoji||''} <b>${sym?.label||s.symbolId}</b> — ${s.planLabel} — ${exp} (${d}d)`})
      return send(chatId,`📊 <b>Your Active Subscriptions</b>\n\n${lines.join('\n')}`)
    }
    if(text==='/help') return send(chatId,`📖 <b>GOLD AI — How It Works</b>\n\nEach market (Gold, EUR/USD, BTC, etc.) is a separate subscription.\nYou only receive signals for markets you've subscribed to.\n\n<b>Signal format:</b>\n<code>🟢 GOLD 15M — BUY (score 72/100 A)\nEntry $2340 · SL $2332\nTP1 $2353 · TP2 $2362 · TP3 $2374</code>\n\n• <b>Entry</b> — open near this price\n• <b>SL</b> — your maximum risk level\n• <b>TP1/TP2/TP3</b> — partial profit targets\n\n/start — view & subscribe to markets\n/status — your active subscriptions`)

    if(!isAdmin) return

    // Admin commands
    const parts=text.split(' ')
    if(text==='/admin')    return screenAdminHome(chatId)
    if(text==='/symbols')  return screenSymbolsManager(chatId,null)
    if(text==='/keys')     return screenApiKeys(chatId,null)
    if(text==='/payments') return screenPayments(chatId,null)
    if(text==='/settings') return screenBotSettings(chatId,null)
    if(text==='/subs')     {
      const subs=allActiveSubscribers()
      if(!subs.length) return send(chatId,'No active subscribers.')
      const lines=subs.map(s=>{const sym=getSymbol(s.symbolId);return `• <code>${s.chatId}</code> — ${sym?.emoji||''} ${sym?.label||s.symbolId} — ${s.planLabel} — ${new Date(s.expiresAt).toLocaleDateString()}`})
      return send(chatId,`<b>All Active Subscribers (${subs.length})</b>\n\n${lines.join('\n')}`)
    }
    // /approve 123456 gold  OR  /deny 123456 gold
    if(parts[0]==='/approve' && parts[1] && parts[2]) return adminApprove(chatId,parts[1],parts[2])
    if(parts[0]==='/deny'    && parts[1] && parts[2]) return adminDeny(chatId,parts[1],parts[2])
    if(parts[0]==='/revoke'  && parts[1] && parts[2]) return adminRevoke(chatId,parts[1],parts[2])
    if(parts[0]==='/check'   && parts[1]) {
      const subs=getAllSubsForUser(parts[1])
      return send(chatId,subs.length?`<pre>${JSON.stringify(subs,null,2)}</pre>`:`❌ Not found: ${parts[1]}`)
    }
    return
  }

  // ── CALLBACKS ──────────────────────────────────────────────────────────────
  if (upd.callback_query) {
    const cb=upd.callback_query,chatId=String(cb.message.chat.id)
    const msgId=cb.message.message_id,data=cb.data||'',isAdmin=chatId===String(ADMIN_ID)
    await answerCb(cb.id)

    // ── User flow ────────────────────────────────────────────────────────────
    if(data==='back_home')  return screenStart(chatId,'')
    if(data==='my_subs')    return screenMySubs(chatId,msgId)
    const symM=data.match(/^sym_(\w+)$/)
    if(symM) return screenSymbol(chatId,symM[1],msgId)
    const pkgM=data.match(/^pkg_(\w+)_([\w]+)$/)
    if(pkgM) return screenPickPayment(chatId,pkgM[1],pkgM[2],msgId)
    const payM=data.match(/^pay_(\w+)_([\w]+)_(\w+)$/)
    if(payM) return screenPayment(chatId,payM[1],payM[2],payM[3],msgId)
    const confM=data.match(/^confirm_(\w+)_([\w]+)_(\w+)$/)
    if(confM) return screenConfirmPending(chatId,confM[1],confM[2],confM[3],msgId)
    const joinM=data.match(/^checkjoin_(\w+)_([\w]+)_(\w+)$/)
    if(joinM) return screenCheckJoin(chatId,joinM[1],joinM[2],joinM[3],msgId)

    if(!isAdmin) return

    // ── Admin nav ────────────────────────────────────────────────────────────
    if(data==='adm_home')          return screenAdminHome(chatId)
    if(data==='adm_symbols')       return screenSymbolsManager(chatId,msgId)
    if(data==='adm_subs')          return screenAdminSubs(chatId,msgId)
    if(data==='adm_pending')       return screenAdminPending(chatId,msgId)
    if(data==='adm_keys')          return screenApiKeys(chatId,msgId)
    if(data==='adm_payments')      return screenPayments(chatId,msgId)
    if(data==='adm_botsettings')   return screenBotSettings(chatId,msgId)
    if(data==='adm_broadcast_pick')return screenBroadcastPick(chatId,msgId)

    // ── Symbol management ─────────────────────────────────────────────────────
    const symView=data.match(/^adm_sym_view_(\w+)$/)
    if(symView) return screenSymbolView(chatId,msgId,symView[1])
    const symToggle=data.match(/^adm_sym_toggle_(\w+)$/)
    if(symToggle) { const syms=getSymbols(),s=syms.find(x=>x.id===symToggle[1]); if(s)s.active=!s.active; saveSymbols(syms); return screenSymbolView(chatId,msgId,symToggle[1]) }
    const symDel=data.match(/^adm_sym_delete_(\w+)$/)
    if(symDel) { const syms=getSymbols().filter(x=>x.id!==symDel[1]); saveSymbols(syms); return editMsg(chatId,msgId,`🗑️ Symbol deleted.`,[[{text:'⬅️ Back',callback_data:'adm_symbols'}]]) }
    if(data==='adm_sym_add') { setSession(chatId,'sym_add_label',{}); return editMsg(chatId,msgId,`➕ <b>Add Symbol — Step 1/5</b>\n\nSend the <b>display name</b>:\n(e.g. "EUR/USD", "Bitcoin", "NASDAQ 100")`,[[{text:'❌ Cancel',callback_data:'adm_symbols'}]]) }
    const symEditLabel=data.match(/^adm_sym_edit_label_(\w+)$/); if(symEditLabel){setSession(chatId,'sym_edit_label',{symId:symEditLabel[1]});return editMsg(chatId,msgId,`✏️ Send new <b>display label</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEditLabel[1]}`}]])}
    const symEditTd=data.match(/^adm_sym_edit_td_(\w+)$/);       if(symEditTd)   {setSession(chatId,'sym_edit_td',{symId:symEditTd[1]});return editMsg(chatId,msgId,`📡 Send new <b>TwelveData symbol</b>:\n(e.g. EUR/USD, BTC/USD, NAS100)`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEditTd[1]}`}]])}
    const symEditOanda=data.match(/^adm_sym_edit_oanda_(\w+)$/); if(symEditOanda){setSession(chatId,'sym_edit_oanda',{symId:symEditOanda[1]});return editMsg(chatId,msgId,`🔌 Send new <b>OANDA instrument</b>:\n(e.g. EUR_USD or <code>none</code>)`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEditOanda[1]}`}]])}
    const symEditYahoo=data.match(/^adm_sym_edit_yahoo_(\w+)$/); if(symEditYahoo){setSession(chatId,'sym_edit_yahoo',{symId:symEditYahoo[1]});return editMsg(chatId,msgId,`📈 Send new <b>Yahoo ticker</b>:\n(e.g. EURUSD=X or <code>none</code>)`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEditYahoo[1]}`}]])}
    const symEditDec=data.match(/^adm_sym_edit_dec_(\w+)$/);     if(symEditDec)  {setSession(chatId,'sym_edit_dec',{symId:symEditDec[1]});return editMsg(chatId,msgId,`🔢 Send <b>decimal places</b> (0-8):`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEditDec[1]}`}]])}
    const symEditEmoji=data.match(/^adm_sym_edit_emoji_(\w+)$/); if(symEditEmoji){setSession(chatId,'sym_edit_emoji',{symId:symEditEmoji[1]});return editMsg(chatId,msgId,`😀 Send new <b>emoji</b> or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEditEmoji[1]}`}]])}

    // Symbol TF toggles
    const symTFs=data.match(/^adm_sym_tfs_(\w+)$/)
    if(symTFs) return screenSymbolTFs(chatId,msgId,symTFs[1])
    const symTfToggle=data.match(/^adm_sym_tf_toggle_(\w+)_(.+)$/)
    if(symTfToggle) {
      const syms=getSymbols(),s=syms.find(x=>x.id===symTfToggle[1]); if(!s) return
      const tfs=s.timeframes||[],idx=tfs.indexOf(symTfToggle[2])
      if(idx>=0) tfs.splice(idx,1); else tfs.push(symTfToggle[2])
      tfs.sort((a,b)=>{ const o=['1m','3m','5m','15m','30m','1h','2h','4h','1d']; return o.indexOf(a)-o.indexOf(b) })
      s.timeframes=tfs; saveSymbols(syms); return screenSymbolTFs(chatId,msgId,symTfToggle[1])
    }

    // Symbol packages
    const symPkgs=data.match(/^adm_sym_pkgs_(\w+)$/)
    if(symPkgs) return screenSymbolPackages(chatId,msgId,symPkgs[1])
    const symSubs=data.match(/^adm_sym_subs_(\w+)$/)
    if(symSubs) return screenSymbolSubs(chatId,msgId,symSubs[1])
    const symPkgView=data.match(/^adm_sym_pkg_view_(\w+)_([\w]+)$/)
    if(symPkgView) return screenSymbolPackageView(chatId,msgId,symPkgView[1],symPkgView[2])
    const symPkgToggle=data.match(/^adm_sym_pkg_toggle_(\w+)_([\w]+)$/)
    if(symPkgToggle) { const pkg=getSymbolPackage(symPkgToggle[1],symPkgToggle[2]); if(pkg){pkg.active=!pkg.active;saveSymbolPackage(symPkgToggle[1],pkg);} return screenSymbolPackageView(chatId,msgId,symPkgToggle[1],symPkgToggle[2]) }
    const symPkgDel=data.match(/^adm_sym_pkg_del_(\w+)_([\w]+)$/)
    if(symPkgDel) { deleteSymbolPackage(symPkgDel[1],symPkgDel[2]); return editMsg(chatId,msgId,`🗑️ Package deleted.`,[[{text:'⬅️ Back',callback_data:`adm_sym_pkgs_${symPkgDel[1]}`}]]) }
    const symPkgAdd=data.match(/^adm_sym_pkg_add_(\w+)$/)
    if(symPkgAdd) { setSession(chatId,'sym_pkg_add_label',{symId:symPkgAdd[1]}); return editMsg(chatId,msgId,`➕ <b>New Package for ${getSymbol(symPkgAdd[1])?.label}</b>\n\nSend the <b>package name</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_pkgs_${symPkgAdd[1]}`}]]) }
    const symPkgLabel=data.match(/^adm_sym_pkg_label_(\w+)_([\w]+)$/)
    if(symPkgLabel) { setSession(chatId,'sym_pkg_label',{symId:symPkgLabel[1],pkgId:symPkgLabel[2]}); return editMsg(chatId,msgId,`✏️ Send new <b>label</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_pkg_view_${symPkgLabel[1]}_${symPkgLabel[2]}`}]]) }
    const symPkgPrice=data.match(/^adm_sym_pkg_price_(\w+)_([\w]+)$/)
    if(symPkgPrice) { setSession(chatId,'sym_pkg_price',{symId:symPkgPrice[1],pkgId:symPkgPrice[2]}); return editMsg(chatId,msgId,`💰 Send new <b>price in USD</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_pkg_view_${symPkgPrice[1]}_${symPkgPrice[2]}`}]]) }
    const symPkgDays=data.match(/^adm_sym_pkg_days_(\w+)_([\w]+)$/)
    if(symPkgDays) { setSession(chatId,'sym_pkg_days',{symId:symPkgDays[1],pkgId:symPkgDays[2]}); return editMsg(chatId,msgId,`📅 Send new <b>duration in days</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_pkg_view_${symPkgDays[1]}_${symPkgDays[2]}`}]]) }

    // Approve / deny
    const admApprove=data.match(/^adm_approve_(\d+)_(\w+)$/)
    if(admApprove) { await adminApprove(chatId,admApprove[1],admApprove[2]); return screenAdminPending(chatId,msgId) }
    const admDeny=data.match(/^adm_deny_(\d+)_(\w+)$/)
    if(admDeny) { await adminDeny(chatId,admDeny[1],admDeny[2]); return screenAdminPending(chatId,msgId) }

    // API keys
    const keyView=data.match(/^adm_key_view_(\d+)$/); if(keyView) return screenApiKeyView(chatId,msgId,parseInt(keyView[1]))
    const keyToggle=data.match(/^adm_key_toggle_(\d+)$/); if(keyToggle){const keys=getSetting('twelvedata_keys')||[],i=parseInt(keyToggle[1]);if(keys[i])keys[i].active=!keys[i].active;setSetting('twelvedata_keys',keys);return screenApiKeyView(chatId,msgId,i)}
    const keyDel=data.match(/^adm_key_delete_(\d+)$/); if(keyDel){const keys=getSetting('twelvedata_keys')||[],i=parseInt(keyDel[1]),lbl=keys[i]?.label;keys.splice(i,1);setSetting('twelvedata_keys',keys);return editMsg(chatId,msgId,`🗑️ Key "<b>${lbl}</b>" deleted.`,[[{text:'⬅️ Back',callback_data:'adm_keys'}]])}
    const keyTest=data.match(/^adm_key_test_(\d+)$/); if(keyTest){const keys=getSetting('twelvedata_keys')||[],i=parseInt(keyTest[1]),k=keys[i];if(!k)return;await editMsg(chatId,msgId,`🧪 Testing <b>${k.label}</b>…`);const r=await testApiKey(k.key);return editMsg(chatId,msgId,r.ok?`✅ <b>Works!</b>\nXAU/USD: <b>$${r.price}</b>`:`❌ <b>Failed:</b>\n${r.reason}`,[[{text:'⬅️ Back',callback_data:`adm_key_view_${i}`}]])}
    if(data==='adm_key_add'){setSession(chatId,'add_key_label',{});return editMsg(chatId,msgId,`➕ Send a <b>label</b> for this key:`,[[{text:'❌ Cancel',callback_data:'adm_keys'}]])}
    const editKeyLabel=data.match(/^adm_key_edit_label_(\d+)$/); if(editKeyLabel){setSession(chatId,'edit_key_label',{idx:parseInt(editKeyLabel[1])});return editMsg(chatId,msgId,`✏️ Send new label:`,[[{text:'❌ Cancel',callback_data:`adm_key_view_${editKeyLabel[1]}`}]])}
    const editKeyVal=data.match(/^adm_key_edit_key_(\d+)$/); if(editKeyVal){setSession(chatId,'edit_key_value',{idx:parseInt(editKeyVal[1])});return editMsg(chatId,msgId,`🔑 Send the new API key string:`,[[{text:'❌ Cancel',callback_data:`adm_key_view_${editKeyVal[1]}`}]])}

    // Payments
    const payView=data.match(/^adm_pay_view_(\w+)$/); if(payView) return screenPaymentView(chatId,msgId,payView[1])
    const payToggle=data.match(/^adm_pay_toggle_(\w+)$/); if(payToggle){const m=getAllPayMethods(),x=m.find(p=>p.id===payToggle[1]);if(x)x.active=x.active===false?true:false;savePayMethods(m);return screenPaymentView(chatId,msgId,payToggle[1])}
    const payDel=data.match(/^adm_pay_delete_(\w+)$/); if(payDel){savePayMethods(getAllPayMethods().filter(x=>x.id!==payDel[1]));return editMsg(chatId,msgId,`🗑️ Deleted.`,[[{text:'⬅️ Back',callback_data:'adm_payments'}]])}
    if(data==='adm_pay_add'){setSession(chatId,'pay_add_label',{});return editMsg(chatId,msgId,`➕ <b>Add Payment Method</b>\n\nSend a <b>display label</b>:\n(e.g. "💎 ETH (ERC-20)")`,[[{text:'❌ Cancel',callback_data:'adm_payments'}]])}
    const payEditLabel=data.match(/^adm_pay_edit_label_(\w+)$/);   if(payEditLabel)  {setSession(chatId,'pay_edit_label',{payId:payEditLabel[1]});return editMsg(chatId,msgId,`✏️ Send new label:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${payEditLabel[1]}`}]])}
    const payEditCoin=data.match(/^adm_pay_edit_coin_(\w+)$/);     if(payEditCoin)   {setSession(chatId,'pay_edit_coin',{payId:payEditCoin[1]});return editMsg(chatId,msgId,`🪙 Send new coin symbol:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${payEditCoin[1]}`}]])}
    const payEditNet=data.match(/^adm_pay_edit_network_(\w+)$/);   if(payEditNet)    {setSession(chatId,'pay_edit_network',{payId:payEditNet[1]});return editMsg(chatId,msgId,`🌐 Send new network or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${payEditNet[1]}`}]])}
    const payEditAddr=data.match(/^adm_pay_edit_address_(\w+)$/);  if(payEditAddr)   {setSession(chatId,'pay_edit_address',{payId:payEditAddr[1]});return editMsg(chatId,msgId,`📋 Send new wallet address:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${payEditAddr[1]}`}]])}

    // Bot settings
    if(data==='adm_cfg_channel')      {setSession(chatId,'cfg_channel',{});      return editMsg(chatId,msgId,`📡 Send new <b>channel username</b>:`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_account_size') {setSession(chatId,'cfg_account_size',{}); return editMsg(chatId,msgId,`💰 Send <b>account size in USD</b>:`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_risk_pct')     {setSession(chatId,'cfg_risk_pct',{});     return editMsg(chatId,msgId,`⚖️ Send <b>risk % per trade</b> (e.g. 1):`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_price_check')  {setSession(chatId,'cfg_price_check',{});  return editMsg(chatId,msgId,`⏱️ Send <b>price check interval in seconds</b> (min 5):`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_oanda_token')  {setSession(chatId,'cfg_oanda_token',{});  return editMsg(chatId,msgId,`🔐 Send <b>OANDA API token</b> or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_datasource')   {setSetting('data_source',getSetting('data_source')==='twelvedata'?'oanda':'twelvedata');return screenBotSettings(chatId,msgId)}
    if(data==='adm_cfg_oanda_env')    {setSetting('oanda_env',getSetting('oanda_env')==='practice'?'live':'practice');return screenBotSettings(chatId,msgId)}

    // Broadcast
    const broadcastSym=data.match(/^adm_broadcast_sym_(\w+)$/)
    if(broadcastSym) { setSession(chatId,'broadcast_msg',{symId:broadcastSym[1]}); return editMsg(chatId,msgId,`📢 <b>Broadcast to ${getSymbol(broadcastSym[1])?.label} subscribers</b>\n\nType your message:`,[[{text:'❌ Cancel',callback_data:'adm_broadcast_pick'}]]) }
    if(data==='adm_broadcast_all') { setSession(chatId,'broadcast_msg',{symId:null}); return editMsg(chatId,msgId,`📢 <b>Broadcast to ALL subscribers</b>\n\nType your message:`,[[{text:'❌ Cancel',callback_data:'adm_broadcast_pick'}]]) }
  }
}

// ── LONG POLLING ──────────────────────────────────────────────────────────
async function startPolling() {
  const s=loadSettings()
  console.log('🤖 Gold AI Subscription Bot v4 — Multi-Symbol')
  console.log(`   Channel: ${s.channel} | Admin: ${ADMIN_ID}`)
  console.log(`   Symbols: ${getActiveSymbols().map(x=>`${x.emoji||''}${x.label}`).join(', ')}`)
  console.log(`   API Keys: ${(s.twelvedata_keys||[]).filter(k=>k.active).length} active`)
  console.log(`   Payments: ${(s.payment_methods||[]).filter(m=>m.active!==false).map(m=>m.coin).join(', ')}`)
  let offset=0
  while(true){
    try{
      const res=await fetch(`${API}/getUpdates?offset=${offset}&timeout=1&allowed_updates=["message","callback_query"]`)
      const j=await res.json()
      if(!j.ok){await sleep(3000);continue}
      const updates=j.result||[]
      for(const upd of updates){offset=upd.update_id+1;handleUpdate(upd).catch(e=>console.error('[update error]',e.message))}
      if(!updates.length) await sleep(300)
    }catch(e){console.error('[poll error]',e.message);await sleep(3000)}
  }
}

// ── EXPIRY CHECKER ────────────────────────────────────────────────────────
async function runExpiryChecker(){
  setInterval(async()=>{
    const data=loadSubs(),now=new Date()
    for(const sub of Object.values(data)){
      if(sub.status!=='active') continue
      const sym=getSymbol(sub.symbolId),exp=new Date(sub.expiresAt),days=Math.ceil((exp-now)/86400000)
      if(days===3&&!sub.warned3d){
        upsertSub(sub.chatId,sub.symbolId,{warned3d:true})
        await send(sub.chatId,`\u26a0\ufe0f <b>Subscription Expiring Soon</b>\n\n${sym?.emoji||''} <b>${sym?.label||sub.symbolId}</b> expires in <b>3 days</b>.\n\nRenew: /start`).catch(()=>{})
      }
      if(exp<=now){
        upsertSub(sub.chatId,sub.symbolId,{status:'expired'})
        await send(sub.chatId,`\u274c <b>Subscription Expired</b>\n\n${sym?.emoji||''} ${sym?.label||sub.symbolId} access has ended.\n\n/start \u2014 renew`).catch(()=>{})
      }
    }
  },60*60*1000)
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms))
runExpiryChecker()
startPolling()
