
// ─────────────────────────────────────────────────────────────────────────────
//  GOLD.AI — Subscription Bot  v6.1 — ATR Calibration + Per-Symbol Spread +
//  /keepholding + /statistics
//
//  New in v6.1:
//   • 💱 PER-SYMBOL SPREAD — fixes forex pairs getting killed by
//     "TP1 too small vs spread". The engine's SPREAD env defaults to 0.30
//     (gold-tuned, i.e. 30 pips for a 4-decimal pair) — far too wide for
//     real forex spreads. Each symbol now stores an optional `spread`
//     (price units, same units as its `decimals`) in settings.json. The
//     launcher (v10.6) injects it as SPREAD env per run. Unset → engine
//     falls back to its own 0.30 default (gold behaviour unchanged).
//     - Asked when adding a new symbol (with pip examples).
//     - Editable any time via Symbol view → "💱 Edit Spread".
//     - Restart the launcher after editing to apply.
//
//  v6.0:
//   • 🎯 PER-SYMBOL ATR CALIBRATION — fixes the "low liquidity" false block
//     on forex pairs (EUR/USD, USD/JPY, EUR/JPY…). calibrateSymbol() fetches
//     ~500 bars per timeframe from TwelveData, computes the rolling 14-period
//     ATR% distribution, and stores p5/p95 as atr_bands[tf]={atrLow,atrHigh}
//     on the symbol in settings.json. The launcher injects these as
//     ATR_LOW/ATR_HIGH into the engine env per run, so each instrument is
//     judged against ITS OWN volatility profile instead of gold's.
//     - Auto-calibrates when a new symbol is added via admin.
//     - "🎯 Recalibrate ATR" button on each symbol's admin screen.
//     - Restart the launcher after (re)calibration to apply.
//   • 🔁 /keepholding (all users) — per-user toggle for "KEEP HOLDING"
//     updates. Default ON. When OFF, the user still receives everything
//     else (new signals with Entry/SL/TPs, TP hits, break-even, stop-loss)
//     but no longer gets the periodic KEEP HOLDING confirmations.
//     Stored in user_prefs.json. broadcastReply() filters by this pref
//     when the launcher marks a reply as keepHolding.
//   • 📅 /statistics (all users — subscribers or not) — opens a picker of
//     every active market + "All Markets", each leading to this week's live
//     performance (same public weekly stats view as the package screens).
//
//  v5.9: weekly-performance button on active single-market + bundle screens.
//  v5.8: main /start screen weekly-performance tab.
//  v5.7: public weekly stats from package-selection screens.
//  v5.6: no cross-market combined Net; TP1-only totals; global collapse.
//  v5.4: visitors.json lead tracking + broadcast targets.
//  v5.3: per-user subscriber management with revoke.
//  v5.1/5.0: threaded replies, bundles, monthly stats.
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs'

// ── BOOTSTRAP ─────────────────────────────────────────────────────────────
const TG_TOKEN = process.env.TG_TOKEN     || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const ADMIN_ID = process.env.ADMIN_CHAT_ID || '1408577116'
if (!TG_TOKEN) { console.error('❌  TG_TOKEN not set'); process.exit(1) }

// ── FILE PATHS ────────────────────────────────────────────────────────────
const SUB_FILE      = './subscribers.json'
const SETTINGS_FILE = './settings.json'
const DAILY_FILE    = './daily_report.json'
const VISITORS_FILE = './visitors.json'
const PREFS_FILE    = './user_prefs.json'

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
  symbols: [
    {
      id: 'gold', label: 'GOLD (XAU/USD)', emoji: '🥇',
      td_symbol: 'XAU/USD', oanda_symbol: 'XAU_USD', yahoo_symbol: 'XAUUSD=X', decimals: 2,
      timeframes: ['15m','1h'], active: true, spread: null,
      packages: [
        { id:'g1', label:'1 Month',  price:50,  days:30,  active:true },
        { id:'g2', label:'3 Months', price:120, days:90,  active:true },
        { id:'g3', label:'6 Months', price:200, days:180, active:true },
      ]
    },
  ],
  bundles: [],
  // 'live' = normal operation | 'coming_soon' = show teaser page to non-subscribers
  bot_mode: 'live',
  coming_soon_text: '🚀 <b>GOLD AI is launching soon!</b>\n\nWe\'re putting the finishing touches on the most precise gold trading signal service on Telegram.\n\n🔔 You\'ll be notified the moment we go live.\n\n<i>Stay tuned — something big is coming.</i>',
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
function nextSymbolId(label)  { return label.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,16) + Date.now().toString(36).slice(-4) }

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
  let i = 1; while (ids.includes(`p${i}`)) i++
  return `p${i}`
}

// ── BUNDLE HELPERS ────────────────────────────────────────────────────────
function getBundles()        { return getSetting('bundles') || [] }
function getActiveBundles()  { return getBundles().filter(b => b.active !== false) }
function getBundle(id)       { return getBundles().find(b => b.id === id) || null }
function saveBundles(arr)    { setSetting('bundles', arr) }
function nextBundleId(label) { return 'bnd_' + label.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,12) + Date.now().toString(36).slice(-3) }
function isBundleId(id)      { return String(id).startsWith('bnd_') }

function getBundlePackages(bid)       { return getBundle(bid)?.packages || [] }
function getBundlePackage(bid, pkgId) { return getBundlePackages(bid).find(p => p.id === pkgId) || null }
function saveBundlePackage(bid, pkg) {
  const arr=getBundles(), b=arr.find(x=>x.id===bid); if(!b) return
  b.packages = b.packages || []
  const i=b.packages.findIndex(p=>p.id===pkg.id)
  if(i>=0) b.packages[i]=pkg; else b.packages.push(pkg)
  saveBundles(arr)
}
function deleteBundlePackage(bid, pkgId) {
  const arr=getBundles(), b=arr.find(x=>x.id===bid); if(!b) return
  b.packages = (b.packages||[]).filter(p=>p.id!==pkgId); saveBundles(arr)
}
function nextBundlePkgId(bid) { const ids=getBundlePackages(bid).map(p=>p.id); let i=1; while(ids.includes(`bp${i}`)) i++; return `bp${i}` }

// ── API KEY / TF / PAYMENT HELPERS ────────────────────────────────────────
export function getActiveApiKeys()    { return (getSetting('twelvedata_keys')||[]).filter(k=>k.active).map(k=>k.key) }
export function getActiveTimeframes() { return getSetting('live_timeframes') || ['15m','1h'] }
export function getDataSource()       { return getSetting('data_source') || 'twelvedata' }
export function getAccountSize()      { return getSetting('account_size') || 10000 }
export function getRiskPct()          { return getSetting('risk_pct') || 1 }
export function getPriceCheckSec()    { return getSetting('price_check_sec') || 30 }
export function getOandaToken()       { return getSetting('oanda_token') || '' }
export function getOandaEnv()         { return getSetting('oanda_env') || 'practice' }
export function getSymbolsForLauncher() {
  return getActiveSymbols().map(s => ({
    id: s.id, label: s.label, emoji: s.emoji||'📊',
    td_symbol: s.td_symbol, oanda_symbol: s.oanda_symbol,
    yahoo_symbol: s.yahoo_symbol, decimals: s.decimals ?? 2,
    timeframes: s.timeframes || getActiveTimeframes(),
    atr_bands: s.atr_bands || {},
    spread: s.spread ?? null,   // price units; null = engine falls back to its own 0.30 default
  }))
}

function getPayMethods()    { return (getSetting('payment_methods')||[]).filter(m=>m.active!==false) }
function getAllPayMethods()  { return getSetting('payment_methods') || [] }
function savePayMethods(arr){ setSetting('payment_methods', arr) }
function nextPayId()        { const ids=getAllPayMethods().map(m=>m.id); let i=1; while(ids.includes(`pm${i}`)) i++; return `pm${i}` }

// ── DAILY REPORT (read-only here) ─────────────────────────────────────────
function loadDaily() { try { return JSON.parse(fs.readFileSync(DAILY_FILE,'utf8')) } catch { return {} } }

// ─────────────────────────────────────────────────────────────────────────────
//  USER PREFS — per-user notification preferences (v6.0)
//  { chatId: { keepHolding: true|false } }   keepHolding default = true (ON)
// ─────────────────────────────────────────────────────────────────────────────
function loadPrefs()  { try { return JSON.parse(fs.readFileSync(PREFS_FILE,'utf8')) } catch { return {} } }
function savePrefs(p) { fs.writeFileSync(PREFS_FILE, JSON.stringify(p, null, 2)) }

// Exported — the launcher checks this before sending KEEP HOLDING updates
// (to the admin directly, and per subscriber via broadcastReply's filter).
export function keepHoldingEnabled(chatId) {
  const p = loadPrefs()[String(chatId)]
  return p?.keepHolding !== false          // default ON
}
function setKeepHolding(chatId, on) {
  const p = loadPrefs(), k = String(chatId)
  p[k] = { ...(p[k]||{}), keepHolding: !!on }
  savePrefs(p)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ATR CALIBRATION (v6.0) — per-symbol, per-timeframe regime bands
//  Fetches ~500 bars per timeframe from TwelveData, computes the rolling
//  14-period ATR% distribution, and stores p5/p95 as the low-liquidity /
//  volatile-expansion thresholds. This is what makes forex pairs work —
//  gold's default bands (e.g. 0.08–0.80% on 15m) sit far above typical
//  forex ATR%, so every pair was blocked as "low_liquidity".
// ─────────────────────────────────────────────────────────────────────────────
const TF_TO_TD = { '1m':'1min','3m':'3min','5m':'5min','15m':'15min','30m':'30min','1h':'1h','2h':'2h','4h':'4h','1d':'1day' }

async function fetchBarsForCalibration(tdSymbol, tf) {
  const interval = TF_TO_TD[tf] || '15min'
  const keys = getActiveApiKeys()
  for (let i = 0; i < Math.max(keys.length, 1); i++) {
    const key = keys[i % keys.length]; if (!key) break
    try {
      const res = await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(tdSymbol)}&interval=${interval}&outputsize=500&timezone=UTC&apikey=${key}`, { signal: AbortSignal.timeout(15000) })
      const j = await res.json()
      if (j.code === 429 || /run out|api credits|minute|limit/i.test(j.message||'')) { await new Promise(r=>setTimeout(r,1500)); continue }   // rotate to next key
      if (j.status === 'error' || !j.values?.length) return null
      return j.values.map(v => ({ high:+v.high, low:+v.low, close:+v.close })).reverse()   // oldest → newest
    } catch { /* network error — try next key */ }
  }
  return null
}

// Rolling Wilder ATR% distribution → { p5, p95 } or null if not enough data
function atrPctDistribution(bars, n = 14) {
  if (!bars || bars.length < n + 20) return null
  const tr = []
  for (let i = 1; i < bars.length; i++) {
    const pc = bars[i-1].close
    tr.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - pc), Math.abs(bars[i].low - pc)))
  }
  let atr = tr.slice(0, n).reduce((a,b)=>a+b,0) / n
  const pcts = []
  for (let i = n; i < tr.length; i++) {
    atr = (atr * (n-1) + tr[i]) / n
    const close = bars[i+1]?.close
    if (close > 0) pcts.push(atr / close * 100)
  }
  if (pcts.length < 30) return null
  pcts.sort((a,b)=>a-b)
  const q = p => pcts[Math.min(pcts.length-1, Math.floor(p * pcts.length))]
  return { p5:+q(0.05).toFixed(5), p95:+q(0.95).toFixed(5) }
}

// Calibrate every active timeframe of one symbol; persists atr_bands into
// settings.json. Returns { ok, msg, bands }. Restart the launcher to apply.
export async function calibrateSymbol(symId) {
  const sym = getSymbol(symId); if (!sym) return { ok:false, msg:'Symbol not found.', bands:{} }
  const tfs = sym.timeframes?.length ? sym.timeframes : ['15m','1h']
  const bands = {}, details = []
  for (const tf of tfs) {
    const bars = await fetchBarsForCalibration(sym.td_symbol, tf)
    const dist = bars ? atrPctDistribution(bars) : null
    if (dist) {
      const atrLow  = Math.max(dist.p5, 0.0005)                 // sanity floor
      const atrHigh = Math.max(dist.p95, atrLow * 3)            // band must have width
      bands[tf] = { atrLow:+atrLow.toFixed(5), atrHigh:+atrHigh.toFixed(5), calibratedAt:new Date().toISOString(), bars:bars.length }
      details.push(`• ${tf}: ${bands[tf].atrLow}% – ${bands[tf].atrHigh}%  (${bars.length} bars)`)
    } else {
      details.push(`• ${tf}: ❌ not enough data — keeping current band`)
    }
    await new Promise(r=>setTimeout(r,1200))   // stay friendly with per-minute limits
  }
  const syms = getSymbols(), s = syms.find(x => x.id === symId)
  if (s && Object.keys(bands).length) { s.atr_bands = { ...(s.atr_bands||{}), ...bands }; saveSymbols(syms) }
  return { ok:Object.keys(bands).length > 0, msg:details.join('\n'), bands }
}

// ─────────────────────────────────────────────────────────────────────────────
//  VISITORS — everyone who has ever pressed /start
//  { chatId: { chatId, firstName, username, firstSeen, lastSeen, status } }
//  status: 'visitor' | 'subscriber' | 'expired'
// ─────────────────────────────────────────────────────────────────────────────
function loadVisitors() { try { return JSON.parse(fs.readFileSync(VISITORS_FILE,'utf8')) } catch { return {} } }
function saveVisitors(v) { fs.writeFileSync(VISITORS_FILE, JSON.stringify(v, null, 2)) }

function recordVisitor(chatId, from={}) {
  const v = loadVisitors()
  const now = new Date().toISOString()
  const existing = v[chatId]
  v[chatId] = {
    chatId: String(chatId),
    firstName: from.first_name || existing?.firstName || '',
    username:  from.username   || existing?.username  || '',
    firstSeen: existing?.firstSeen || now,
    lastSeen:  now,
    // Preserve subscriber/expired status if already set; default to visitor
    status: existing?.status === 'subscriber' ? 'subscriber'
          : existing?.status === 'expired'    ? 'expired'
          : 'visitor',
  }
  saveVisitors(v)
}

// Upgrade a visitor to subscriber status (called on approval)
function markVisitorSubscriber(chatId) {
  const v = loadVisitors()
  if (v[chatId]) { v[chatId].status = 'subscriber'; saveVisitors(v) }
}
// Downgrade to expired (called when subscription lapses)
function markVisitorExpired(chatId) {
  const v = loadVisitors()
  if (v[chatId] && v[chatId].status === 'subscriber') { v[chatId].status = 'expired'; saveVisitors(v) }
}

// All visitors who have NO active subscription (leads + expired)
function getNonSubscriberVisitors() {
  const activeChatIds = new Set(allActiveSubscribers().map(s => s.chatId))
  return Object.values(loadVisitors()).filter(v => !activeChatIds.has(v.chatId))
}
// All unique chatIds across visitors + active subscribers (deduped)
function getAllKnownChatIds() {
  const ids = new Set(Object.keys(loadVisitors()))
  for (const s of allActiveSubscribers()) ids.add(s.chatId)
  return [...ids]
}

// ─────────────────────────────────────────────────────────────────────────────
//  SUBSCRIBERS
// ─────────────────────────────────────────────────────────────────────────────
function loadSubs()   { try { return JSON.parse(fs.readFileSync(SUB_FILE,'utf8')) } catch { return {} } }
function saveSubs(d)  { fs.writeFileSync(SUB_FILE, JSON.stringify(d, null, 2)) }

function subKey(chatId, productId) { return `${chatId}::${productId}` }
function getSub(chatId, productId) { return loadSubs()[subKey(chatId, productId)] || null }
function getAllSubsForUser(chatId) {
  return Object.values(loadSubs()).filter(s => s.chatId === String(chatId))
}
function upsertSub(chatId, productId, patch) {
  const data = loadSubs(), key = subKey(chatId, productId)
  data[key] = { ...data[key], ...patch, chatId:String(chatId), symbolId:productId, updatedAt:new Date().toISOString() }
  saveSubs(data); return data[key]
}
function isActive(sub) {
  if (!sub || sub.status !== 'active') return false
  return new Date(sub.expiresAt) > new Date()
}
function isBundleSub(s) { return isBundleId(s.symbolId) }
function activeSubscribersForSymbol(symbolId) {
  return Object.values(loadSubs()).filter(s => s.symbolId === symbolId && isActive(s))
}
function allActiveSubscribers() {
  return Object.values(loadSubs()).filter(s => isActive(s))
}

// ─────────────────────────────────────────────────────────────────────────────
//  BROADCAST
// ─────────────────────────────────────────────────────────────────────────────
export async function broadcastSignal(sigText, symbolId) {
  let subs = symbolId ? activeSubscribersForSymbol(symbolId) : allActiveSubscribers()
  subs = subs.filter(s => !isBundleSub(s))
  const seen = new Set(), uniq = []
  for (const s of subs) { if (seen.has(s.chatId)) continue; seen.add(s.chatId); uniq.push(s) }
  let sent=0, failed=0
  const msgIds = {}
  for (const sub of uniq) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chat_id:sub.chatId, text:sigText, parse_mode:'HTML' })
      })
      const j = await res.json()
      if (j.ok) { sent++; msgIds[sub.chatId] = j.result.message_id }
      else { failed++; if (['blocked','kicked','deactivated','not_found'].some(w=>j.description?.toLowerCase().includes(w))) upsertSub(sub.chatId,sub.symbolId,{status:'bot_blocked'}) }
    } catch { failed++ }
    await new Promise(r=>setTimeout(r,50))
  }
  console.log(`[broadcast][${symbolId||'ALL'}] sent=${sent} failed=${failed}`)
  return { sent, failed, msgIds }
}

// opts.keepHolding=true → skip subscribers who turned KEEP HOLDING updates
// off via /keepholding. TP/SL/BE alerts never set this flag → always sent.
export async function broadcastReply(alertText, symbolId, msgIds = {}, opts = {}) {
  let subs = symbolId ? activeSubscribersForSymbol(symbolId) : allActiveSubscribers()
  subs = subs.filter(s => !isBundleSub(s))
  let skipped = 0
  if (opts.keepHolding) {
    const before = subs.length
    subs = subs.filter(s => keepHoldingEnabled(s.chatId))
    skipped = before - subs.length
  }
  const seen = new Set(), uniq = []
  for (const s of subs) { if (seen.has(s.chatId)) continue; seen.add(s.chatId); uniq.push(s) }
  let sent=0, failed=0
  for (const sub of uniq) {
    const body = { chat_id:sub.chatId, text:alertText, parse_mode:'HTML' }
    const rid = msgIds[sub.chatId]
    if (rid) { body.reply_to_message_id = rid; body.allow_sending_without_reply = true }
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(body)
      })
      const j = await res.json()
      if (j.ok) sent++; else failed++
    } catch { failed++ }
    await new Promise(r=>setTimeout(r,50))
  }
  console.log(`[reply][${symbolId||'ALL'}]${opts.keepHolding?' (keep-holding)':''} sent=${sent} failed=${failed} skipped=${skipped}`)
  return { sent, failed, skipped }
}

// Send a message to an arbitrary list of chatIds (used for visitor broadcasts)
async function broadcastToList(text, chatIds=[]) {
  let sent=0, failed=0
  for (const cid of chatIds) {
    try {
      const res = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
        method:'POST', headers:{'Content-Type':'application/json'},
        body: JSON.stringify({ chat_id:cid, text, parse_mode:'HTML' })
      })
      const j = await res.json()
      if (j.ok) sent++; else failed++
    } catch { failed++ }
    await new Promise(r=>setTimeout(r,50))
  }
  console.log(`[broadcastToList] sent=${sent} failed=${failed}`)
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

// ── DISPLAY HELPER ────────────────────────────────────────────────────────
function productLabel(productId) {
  if (isBundleId(productId)) { const b=getBundle(productId); return `🎁 ${b?.label||productId}` }
  const s=getSymbol(productId); return `${s?.emoji||''} ${s?.label||productId}`
}

// ─────────────────────────────────────────────────────────────────────────────
//  USER FLOW
// ─────────────────────────────────────────────────────────────────────────────
async function screenStart(chatId, firstName, from={}) {
  // Record every /start press — builds the leads/visitor list
  recordVisitor(chatId, from)

  // ── COMING SOON MODE ──────────────────────────────────────────────────────
  // Show the teaser page to everyone EXCEPT users who already have an active
  // subscription (they still get full access — their signals keep working).
  const botMode = getSetting('bot_mode') || 'live'
  if (botMode === 'coming_soon') {
    const activeSubs = getAllSubsForUser(chatId).filter(s => isActive(s))
    if (!activeSubs.length) {
      // Non-subscriber → teaser screen
      const csText = getSetting('coming_soon_text') || '🚀 <b>Coming Soon!</b>'
      return send(chatId, csText)
    }
    // Active subscriber → fall through to normal flow
  }

  const subs = getAllSubsForUser(chatId).filter(s => isActive(s))
  const activeIds = subs.map(s => s.symbolId)
  const symbols = getActiveSymbols(), bundles = getActiveBundles()

  let welcome = `🟡 <b>GOLD AI — Premium Signals</b>\n\nMulti-asset trading signals powered by AI analysis.\n\n`
  const activeNames = activeIds.map(id => isBundleId(id) ? getBundle(id)?.label : getSymbol(id)?.label).filter(Boolean)
  if (activeNames.length) welcome += `✅ Active: <b>${activeNames.join(', ')}</b>\n\n`
  welcome += `📈 Curious how we're doing? Check this week's live results below, then pick a market to subscribe.\n\n`
  welcome += `<b>Select a market or bundle:</b>`

  const rows = symbols.map(s => {
    const active = activeIds.includes(s.id)
    return [{ text:`${active?'✅ ':''}${s.emoji||'📊'} ${s.label}${active?' (Active)':''}`, callback_data:`sym_${s.id}` }]
  })
  for (const b of bundles) {
    const active = activeIds.includes(b.id)
    rows.push([{ text:`${active?'✅ ':''}🎁 ${b.emoji||''} ${b.label}${active?' (Active)':''}`, callback_data:`bun_${b.id}` }])
  }
  rows.push([{ text:"📅 This Week's Performance — All Markets", callback_data:'pwk_all_back_home' }])
  rows.push([{ text:'📊 My Subscriptions', callback_data:'my_subs' }])
  return sendInline(chatId, welcome, rows)
}

async function screenSymbol(chatId, symId, msgId) {
  const sym = getSymbol(symId); if (!sym) return
  const sub = getSub(chatId, symId)
  if (isActive(sub)) {
    const exp = new Date(sub.expiresAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
    const daysLeft = Math.ceil((new Date(sub.expiresAt)-new Date())/86400000)
    const via = sub.viaBundle ? `\n(via bundle: ${getBundle(sub.viaBundle)?.label||sub.viaBundle})` : ''
    return editMsg(chatId, msgId,
`${sym.emoji||'📊'} <b>${sym.label}</b>\n\n✅ <b>Subscription Active</b>\nExpires: <b>${exp}</b> (${daysLeft} days left)${via}\n\nSignals for ${sym.label} are delivered to this chat.`,
      [[{ text:"📅 This Week's Performance", callback_data:`pwk_${symId}_sym_${symId}` }], [{ text:'⬅️ Back to Markets', callback_data:'back_home' }]])
  }
  if (sub?.status === 'pending_payment') return screenPayment(chatId, symId, sub.pendingPkg, sub.pendingMethod, msgId)

  const pkgs = sym.packages?.filter(p=>p.active!==false) || []
  if (!pkgs.length) return editMsg(chatId, msgId, `⚠️ No plans available for ${sym.label} right now.`, [[{text:'⬅️ Back',callback_data:'back_home'}]])
  const rows = pkgs.map(p => [{ text:`📦 ${p.label} — $${p.price}`, callback_data:`pkg_${symId}_${p.id}` }])
  rows.push([{ text:"📅 See This Week's Performance", callback_data:`pwk_${symId}_sym_${symId}` }])
  rows.push([{ text:'⬅️ Back to Markets', callback_data:'back_home' }])
  return editMsg(chatId, msgId,
`${sym.emoji||'📊'} <b>${sym.label}</b>\n\nTimeframes: <b>${(sym.timeframes||['15m','1h']).join(', ')}</b>\nData: <b>${sym.td_symbol}</b>\n\n📈 Want proof before you commit? Tap below to see this week's live results.\n\n<b>Choose your subscription plan:</b>`, rows)
}

async function screenBundle(chatId, bid, msgId) {
  const b = getBundle(bid); if (!b) return
  const sub = getSub(chatId, bid)
  const members = (b.symbols||[]).map(id => getSymbol(id)).filter(Boolean)
  const memberList = members.map(s=>`• ${s.emoji||''} ${s.label}`).join('\n') || '• (no markets configured yet)'

  if (isActive(sub)) {
    const exp = new Date(sub.expiresAt).toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
    const daysLeft = Math.ceil((new Date(sub.expiresAt)-new Date())/86400000)
    return editMsg(chatId, msgId,
`🎁 <b>${b.label}</b>\n\n✅ <b>Bundle Active</b>\nExpires: <b>${exp}</b> (${daysLeft} days left)\n\nIncluded markets:\n${memberList}`,
      [[{ text:"📅 This Week's Performance", callback_data:`pwk_all_bun_${bid}` }], [{ text:'⬅️ Back to Markets', callback_data:'back_home' }]])
  }
  if (sub?.status === 'pending_payment') return screenBundlePayment(chatId, bid, sub.pendingPkg, sub.pendingMethod, msgId)

  const pkgs = (b.packages||[]).filter(p=>p.active!==false)
  if (!pkgs.length) return editMsg(chatId, msgId, `⚠️ No plans available for ${b.label} right now.`, [[{text:'⬅️ Back',callback_data:'back_home'}]])
  const rows = pkgs.map(p => [{ text:`📦 ${p.label} — $${p.price}`, callback_data:`bpkg_${bid}_${p.id}` }])
  rows.push([{ text:"📅 See This Week's Performance", callback_data:`pwk_all_bun_${bid}` }])
  rows.push([{ text:'⬅️ Back to Markets', callback_data:'back_home' }])
  return editMsg(chatId, msgId,
`🎁 <b>${b.label}</b>\n\nOne subscription, all of these markets:\n${memberList}\n\n📈 Want proof before you commit? Tap below to see this week's live results across all markets.\n\n<b>Choose your plan:</b>`, rows)
}

async function screenPickPayment(chatId, symId, pkgId, msgId) {
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId, pkgId); if (!sym || !pkg) return
  upsertSub(chatId, symId, { status:'pending_payment', pendingPkg:pkgId, msgId })
  const methods = getPayMethods()
  if (!methods.length) return send(chatId, '⚠️ No payment methods available.')
  const rows = methods.map(m => [{ text:m.label, callback_data:`pay_${symId}_${pkgId}_${m.id}` }])
  rows.push([{ text:'⬅️ Back', callback_data:`sym_${symId}` }])
  await editMsg(chatId, msgId, `${sym.emoji||'📊'} <b>${sym.label} — ${pkg.label} ($${pkg.price})</b>\n\nChoose your payment method:`, rows)
}
async function screenPayment(chatId, symId, pkgId, methodId, msgId) {
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId, pkgId), method = getAllPayMethods().find(m=>m.id===methodId)
  if (!sym || !pkg || !method) return
  upsertSub(chatId, symId, { status:'pending_payment', pendingPkg:pkgId, pendingMethod:methodId, msgId })
  const rows = [
    [{ text:'✅ I Sent the Payment', callback_data:`confirm_${symId}_${pkgId}_${methodId}` }],
    [{ text:'⬅️ Back to Methods',   callback_data:`pkg_${symId}_${pkgId}` }],
  ]
  await editMsg(chatId, msgId,
`💳 <b>Payment Instructions</b>\n\nMarket: <b>${sym.label}</b>\nPlan: <b>${pkg.label} — $${pkg.price}</b>\nMethod: <b>${method.label}</b>\n\nSend exactly <b>$${pkg.price} worth of ${method.coin}</b>${method.network?` (${method.network})`:''} to:\n\n<code>${method.address}</code>\n\n⚠️ Include your Telegram ID <code>${chatId}</code> in memo if possible.\n\nAfter sending, press <b>"I Sent the Payment"</b>.`, rows)
}
async function screenConfirmPending(chatId, symId, pkgId, methodId, msgId) {
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId, pkgId), method = getAllPayMethods().find(m=>m.id===methodId)
  upsertSub(chatId, symId, { status:'awaiting_admin', pendingPkg:pkgId, pendingMethod:methodId, msgId, claimedAt:new Date().toISOString() })
  if (ADMIN_ID) {
    await send(ADMIN_ID,
`🔔 <b>New Payment Claim</b>\n\nUser: <a href="tg://user?id=${chatId}">${chatId}</a>\nMarket: ${sym?.label}\nPlan: ${pkg?.label} — $${pkg?.price}\nMethod: ${method?.label}\n\n/approve ${chatId} ${symId}  or  /deny ${chatId} ${symId}`)
  }
  const channel = getSetting('channel')
  const rows = [
    [{ text:`✅ Join ${channel}`, url:`https://t.me/${channel.replace('@','')}` }],
    [{ text:'🔄 I Joined — Check Status', callback_data:`checkjoin_${symId}_${pkgId}_${methodId}` }],
  ]
  await editMsg(chatId, msgId, `⏳ <b>Payment Under Review</b>\n\nThank you! Your payment is being verified.\n\nJoin our channel while you wait:\n${channel}`, rows)
}
async function screenCheckJoin(chatId, symId, pkgId, methodId, msgId) {
  const joined = await isMember(chatId), sub = getSub(chatId, symId), channel = getSetting('channel')
  if (!joined) return editMsg(chatId, msgId, `❌ <b>Not joined yet</b>\n\nJoin ${channel} first then check again.`,
    [[{ text:`✅ Join ${channel}`, url:`https://t.me/${channel.replace('@','')}` }],[{ text:'🔄 Check Again', callback_data:`checkjoin_${symId}_${pkgId}_${methodId}` }]])
  upsertSub(chatId, symId, { joinedChannel:true })
  if (isActive(sub)) return editMsg(chatId, msgId, `🎉 <b>You're all set!</b>\n\n✅ Channel joined\n✅ Subscription active\n\nSignals will arrive here. 🟡`)
  return editMsg(chatId, msgId, `✅ <b>Channel joined!</b>\n\nPayment still under review. Usually 10–30 minutes.`)
}

async function screenBundlePickPayment(chatId, bid, pkgId, msgId) {
  const b = getBundle(bid), pkg = getBundlePackage(bid, pkgId); if (!b || !pkg) return
  upsertSub(chatId, bid, { status:'pending_payment', pendingPkg:pkgId, isBundle:true, msgId })
  const methods = getPayMethods()
  if (!methods.length) return send(chatId, '⚠️ No payment methods available.')
  const rows = methods.map(m => [{ text:m.label, callback_data:`bpay_${bid}_${pkgId}_${m.id}` }])
  rows.push([{ text:'⬅️ Back', callback_data:`bun_${bid}` }])
  await editMsg(chatId, msgId, `🎁 <b>${b.label} — ${pkg.label} ($${pkg.price})</b>\n\nChoose your payment method:`, rows)
}
async function screenBundlePayment(chatId, bid, pkgId, methodId, msgId) {
  const b = getBundle(bid), pkg = getBundlePackage(bid, pkgId), method = getAllPayMethods().find(m=>m.id===methodId)
  if (!b || !pkg || !method) return
  upsertSub(chatId, bid, { status:'pending_payment', pendingPkg:pkgId, pendingMethod:methodId, isBundle:true, msgId })
  const rows = [
    [{ text:'✅ I Sent the Payment', callback_data:`bconfirm_${bid}_${pkgId}_${methodId}` }],
    [{ text:'⬅️ Back to Methods',   callback_data:`bpkg_${bid}_${pkgId}` }],
  ]
  await editMsg(chatId, msgId,
`💳 <b>Payment Instructions</b>\n\nBundle: <b>🎁 ${b.label}</b>\nPlan: <b>${pkg.label} — $${pkg.price}</b>\nMethod: <b>${method.label}</b>\n\nSend exactly <b>$${pkg.price} worth of ${method.coin}</b>${method.network?` (${method.network})`:''} to:\n\n<code>${method.address}</code>\n\n⚠️ Include your Telegram ID <code>${chatId}</code> in memo if possible.\n\nAfter sending, press <b>"I Sent the Payment"</b>.`, rows)
}
async function screenBundleConfirmPending(chatId, bid, pkgId, methodId, msgId) {
  const b = getBundle(bid), pkg = getBundlePackage(bid, pkgId), method = getAllPayMethods().find(m=>m.id===methodId)
  upsertSub(chatId, bid, { status:'awaiting_admin', pendingPkg:pkgId, pendingMethod:methodId, isBundle:true, msgId, claimedAt:new Date().toISOString() })
  if (ADMIN_ID) {
    await send(ADMIN_ID,
`🔔 <b>New Bundle Payment Claim</b>\n\nUser: <a href="tg://user?id=${chatId}">${chatId}</a>\nBundle: 🎁 ${b?.label}\nPlan: ${pkg?.label} — $${pkg?.price}\nMethod: ${method?.label}\n\n/approve ${chatId} ${bid}  or  /deny ${chatId} ${bid}`)
  }
  const channel = getSetting('channel')
  const rows = [
    [{ text:`✅ Join ${channel}`, url:`https://t.me/${channel.replace('@','')}` }],
    [{ text:'🔄 I Joined — Check Status', callback_data:`bcheckjoin_${bid}_${pkgId}_${methodId}` }],
  ]
  await editMsg(chatId, msgId, `⏳ <b>Payment Under Review</b>\n\nThank you! Your bundle payment is being verified.\n\nJoin our channel while you wait:\n${channel}`, rows)
}
async function screenBundleCheckJoin(chatId, bid, pkgId, methodId, msgId) {
  const joined = await isMember(chatId), sub = getSub(chatId, bid), channel = getSetting('channel')
  if (!joined) return editMsg(chatId, msgId, `❌ <b>Not joined yet</b>\n\nJoin ${channel} first then check again.`,
    [[{ text:`✅ Join ${channel}`, url:`https://t.me/${channel.replace('@','')}` }],[{ text:'🔄 Check Again', callback_data:`bcheckjoin_${bid}_${pkgId}_${methodId}` }]])
  upsertSub(chatId, bid, { joinedChannel:true })
  if (isActive(sub)) return editMsg(chatId, msgId, `🎉 <b>You're all set!</b>\n\n✅ Channel joined\n✅ Bundle active`)
  return editMsg(chatId, msgId, `✅ <b>Channel joined!</b>\n\nPayment still under review. Usually 10–30 minutes.`)
}

async function screenMySubs(chatId, msgId) {
  const subs = getAllSubsForUser(chatId)
  if (!subs.length) return editMsg(chatId, msgId, '📊 You have no subscriptions yet.\n\nUse the market list to subscribe.', [[{ text:'⬅️ Back', callback_data:'back_home' }]])
  const lines = subs.map(s => {
    const name = productLabel(s.symbolId)
    if (isActive(s)) {
      const exp = new Date(s.expiresAt).toLocaleDateString()
      const days = Math.ceil((new Date(s.expiresAt)-new Date())/86400000)
      const via = s.viaBundle ? ' (bundle)' : ''
      return `✅ ${name}${via} — expires ${exp} (${days}d)`
    }
    if (s.status==='awaiting_admin') return `⏳ ${name} — payment under review`
    if (s.status==='expired')        return `❌ ${name} — expired`
    return `${name} — ${s.status}`
  })
  await editMsg(chatId, msgId, `📊 <b>My Subscriptions</b>\n\n${lines.join('\n')}`, [[{ text:'⬅️ Back', callback_data:'back_home' }]])
}

// ── PUBLIC STATISTICS PICKER (v6.0 — /statistics, all users) ─────────────
// Pick any active market (or all markets) → this week's live performance.
async function screenStatsPicker(chatId, msgId) {
  const syms = getActiveSymbols()
  const rows = syms.map(s => [{ text:`${s.emoji||'📊'} ${s.label}`, callback_data:`pwk_${s.id}_stats_menu` }])
  rows.push([{ text:'🌐 All Markets', callback_data:'pwk_all_stats_menu' }])
  rows.push([{ text:'⬅️ Back to Menu', callback_data:'back_home' }])
  const text = `📅 <b>This Week's Performance</b>\n\nPick a market to see this week's live results, or view all markets combined.`
  return msgId ? editMsg(chatId, msgId, text, rows) : sendInline(chatId, text, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — HOME
// ─────────────────────────────────────────────────────────────────────────────
async function screenAdminHome(chatId) {
  const total = allActiveSubscribers().filter(s=>!isBundleSub(s)).length
  const pending = Object.values(loadSubs()).filter(s=>s.status==='awaiting_admin').length
  const syms = getActiveSymbols(), bundles = getActiveBundles(), keys = (getSetting('twelvedata_keys')||[]).filter(k=>k.active).length
  const uniqueUsers = new Set(allActiveSubscribers().map(s=>s.chatId)).size
  const totalVisitors = Object.keys(loadVisitors()).length
  const nonSubVisitors = getNonSubscriberVisitors().length
  const rows = [
    [{ text:`📊 Symbols (${syms.length} active)`,     callback_data:'adm_symbols' }],
    [{ text:`🎁 Bundles (${bundles.length})`,          callback_data:'adm_bundles' }],
    [{ text:`📈 Monthly Statistics`,                   callback_data:'adm_stats'   }],
    [{ text:`📅 Weekly Statistics`,                    callback_data:'adm_weekly'  }],
    [{ text:`👥 Subscribers (${uniqueUsers} users)`,   callback_data:'adm_subs'    }],
    [{ text:`👁 Visitors / Leads (${totalVisitors})`,  callback_data:'adm_visitors'}],
    [{ text:`⏳ Pending Approvals (${pending})`,        callback_data:'adm_pending' }],
    [{ text:`🔑 API Keys (${keys} active)`,            callback_data:'adm_keys'    }],
    [{ text:'💳 Payment Methods',                       callback_data:'adm_payments'}],
    [{ text:'⚙️ Bot Settings',                         callback_data:'adm_botsettings'}],
    [{ text:'📢 Broadcast',                             callback_data:'adm_broadcast_pick'}],
  ]
  return sendInline(chatId,
`🔧 <b>GOLD AI Admin Panel</b>\n\nActive users: <b>${uniqueUsers}</b> · Subscriptions: <b>${total}</b>\nPending approvals: <b>${pending}</b>\nVisitors (total): <b>${totalVisitors}</b> · Non-subscribers: <b>${nonSubVisitors}</b>\nActive symbols: <b>${syms.length}</b> · Bundles: <b>${bundles.length}</b>\nAPI keys: <b>${keys} active</b>`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — VISITORS / LEADS
// ─────────────────────────────────────────────────────────────────────────────
async function screenVisitors(chatId, msgId, page=0) {
  const all = Object.values(loadVisitors()).sort((a,b) => new Date(b.lastSeen) - new Date(a.lastSeen))
  const PAGE = 25
  const total = all.length
  const slice = all.slice(page*PAGE, (page+1)*PAGE)

  const statusIcon = s => s==='subscriber'?'✅':s==='expired'?'🔴':'👁'
  const lines = slice.map(v => {
    const name = [v.firstName, v.username ? `@${v.username}` : ''].filter(Boolean).join(' ')
    const seen = new Date(v.firstSeen).toLocaleDateString('en-GB',{day:'2-digit',month:'short',year:'numeric'})
    return `${statusIcon(v.status)} <code>${v.chatId}</code> ${name ? `— ${name}` : ''} <i>(${seen})</i>`
  })

  const nonSubs = all.filter(v => v.status !== 'subscriber').length
  const subs    = all.filter(v => v.status === 'subscriber').length
  const expired = all.filter(v => v.status === 'expired').length

  const header = `👁 <b>All Visitors / Leads</b>\n\nTotal: <b>${total}</b>  ✅ ${subs} subscribers  🔴 ${expired} expired  👁 ${nonSubs} leads\n\n`

  const rows = []
  // Pagination
  const navRow = []
  if (page > 0) navRow.push({ text:'⬅️ Prev', callback_data:`adm_visitors_${page-1}` })
  if ((page+1)*PAGE < total) navRow.push({ text:'Next ➡️', callback_data:`adm_visitors_${page+1}` })
  if (navRow.length) rows.push(navRow)
  rows.push([{ text:'📢 Message non-subscribers', callback_data:'adm_broadcast_pick' }])
  rows.push([{ text:'⬅️ Back', callback_data:'adm_home' }])

  const text = header + (lines.join('\n') || 'No visitors yet.')
  return msgId ? editMsg(chatId,msgId,text,rows) : sendInline(chatId,text,rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — MONTHLY STATISTICS
// ─────────────────────────────────────────────────────────────────────────────
function ymNow()              { return new Date().toISOString().slice(0,7) }
function ymNav(ym, delta)     { const [y,m]=ym.split('-').map(Number); return new Date(Date.UTC(y,m-1+delta,1)).toISOString().slice(0,7) }
function ymLabel(ym)          { const [y,m]=ym.split('-').map(Number); return new Date(Date.UTC(y,m-1,1)).toLocaleString('en-US',{month:'long',year:'numeric',timeZone:'UTC'}) }
function signedPips(t)        { return t.sign>0 ? t.pips : t.sign<0 ? -t.pips : 0 }

const OUTCOME_RANK = { SL:0, BE:0, TP1:1, TP2:2, TP3:3 }
function collapseDaily(rows) {
  const byId = new Map()
  let auto = 0
  for (const t of rows) {
    const id = t.signalId || `__solo_${auto++}`
    const rank = OUTCOME_RANK[t.result] ?? -1
    const cur = byId.get(id)
    if (!cur || rank > (OUTCOME_RANK[cur.result] ?? -1)) byId.set(id, t)
  }
  return [...byId.values()]
}

// Build signalId → TP1 pips lookup from RAW (uncollapsed) rows in the range.
// Used to compute the "if I only ever took TP1" scenario per market.
function buildTp1Map(rawRows) {
  const m = new Map()
  for (const t of rawRows) if (t.result === 'TP1') m.set(t.signalId, t.pips)
  return m
}

// Shared renderer for Monthly + Weekly stats. `entries` = [{date, trades:[...]}]
// of RAW (uncollapsed) daily rows already filtered to the desired date range.
// Collapses GLOBALLY across the whole range (not per-day) so a trade whose
// TP1 hit one day and TP2/TP3 hit the next isn't double-counted.
// No combined cross-currency "Net" — gold pips and crypto pips aren't
// comparable, so each market keeps its own totals only.
function renderStatsBlock(entries, titleLine, emptyNote) {
  let allRaw = []
  for (const { date, trades } of entries) for (const t of trades) allRaw.push({ ...t, date })

  const tp1Map = buildTp1Map(allRaw)
  const trades = collapseDaily(allRaw)
  trades.sort((a,b)=> new Date(a.ts||a.date) - new Date(b.ts||b.date))

  const wins   = trades.filter(t=>t.sign>0)
  const losses = trades.filter(t=>t.sign<0)
  const bes    = trades.filter(t=>!t.sign)
  const decided = wins.length + losses.length
  const wr = decided ? (wins.length/decided*100).toFixed(1) : '0.0'

  // Per-market: "All TPs" = furthest outcome actually reached (as before).
  // "TP1-only" = what every trade would have made if closed right at TP1
  // (losses/BE unaffected — they never got there).
  const bySym = {}
  for (const t of trades) {
    const k = t.sym || '?'
    bySym[k] ??= { allTps:0, tp1Only:0, n:0, w:0, l:0 }
    bySym[k].n++
    bySym[k].allTps += signedPips(t)
    if (t.sign>0) bySym[k].w++; else if (t.sign<0) bySym[k].l++
    const tp1Val = (t.result==='SL'||t.result==='BE') ? signedPips(t) : (tp1Map.get(t.signalId) ?? t.pips)
    bySym[k].tp1Only += tp1Val
  }
  const symLines = Object.entries(bySym).map(([k,v])=>{
    const nm    = getSymbol(k)?.label?.split(' ')[0] || (k||'?').toUpperCase()
    const emoji = getSymbol(k)?.emoji || '•'
    const allStr = `${v.allTps>=0?'+':''}${Math.round(v.allTps)}p`
    const tp1Str = `${v.tp1Only>=0?'+':''}${Math.round(v.tp1Only)}p`
    return `   ${emoji} ${nm}: ${allStr}  (${v.w}W/${v.l}L)\n      TP1-only: ${tp1Str} · All TPs: ${allStr}`
  })

  const todayStr = new Date().toISOString().slice(0,10)
  const dateLabel = d => d===todayStr ? 'Today' : (()=>{ const [Y,M,D]=d.split('-'); return `${+D}-${+M}` })()
  const fmtLine = t => {
    const nm   = getSymbol(t.sym)?.label?.split(' ')[0] || (t.sym||'').toUpperCase()
    const icon = t.sign>0?'✅':t.sign<0?'❌':'🟦'
    const sign = t.sign>0?'+':t.sign<0?'-':''
    const tpL  = t.result==='SL'?'SL':t.result==='BE'?'BE':t.result
    return `${icon} ${nm} - ${t.dir} - ${tpL} --> ${sign}${t.pips}pips`
  }
  const days = {}
  for (const t of trades) (days[t.date] ??= []).push(t)
  const dayBlocks = Object.keys(days).sort().reverse().map(d =>
    `<b>${dateLabel(d)}:</b>\n` + days[d].slice().reverse().map(fmtLine).join('\n')
  )

  const header =
`${titleLine}\n\n`+
`Trades taken: <b>${trades.length}</b>\n`+
`✅ ${wins.length}  ❌ ${losses.length}${bes.length?`  🟦 ${bes.length}`:''}\n`+
`Win rate: <b>${wr}%</b>\n\n`+
`<b>By market:</b>\n${symLines.join('\n')||'   —'}\n\n`+
`<b>Trades (newest first):</b>\n`

  let body = dayBlocks.join('\n\n') || (emptyNote || 'No trades recorded in this period yet.')
  let text = header + body
  if (text.length > 3800) {
    const keep=[]; let len=header.length
    for (const blk of dayBlocks) { if (len+blk.length+2 > 3600) { keep.push('… (older days trimmed)'); break } keep.push(blk); len+=blk.length+2 }
    text = header + keep.join('\n\n')
  }
  return text
}

async function screenMonthlyStats(chatId, msgId, ym) {
  ym = ym || ymNow()
  const daily = loadDaily()
  const entries = Object.entries(daily)
    .filter(([date]) => date.startsWith(ym))
    .map(([date, day]) => ({ date, trades: day.trades || [] }))

  const text = renderStatsBlock(entries, `📈 <b>Monthly Stats — ${ymLabel(ym)}</b>`, 'No trades recorded this month yet.')

  const prev=ymNav(ym,-1), next=ymNav(ym,1)
  const rows = [
    [{ text:`⬅️ ${ymLabel(prev)}`, callback_data:`adm_stats_${prev}` }, { text:`${ymLabel(next)} ➡️`, callback_data:`adm_stats_${next}` }],
    [{ text:'🔄 Refresh', callback_data:`adm_stats_${ym}` }],
    [{ text:'🏠 Admin Home', callback_data:'adm_home' }],
  ]
  return msgId ? editMsg(chatId,msgId,text,rows) : sendInline(chatId,text,rows)
}

// ── Current week (Mon–Sun, UTC) — no history, always "this week" ───────────
function currentWeekRange() {
  const now = new Date()
  const utcDay = now.getUTCDay() // 0=Sun..6=Sat
  const diffToMonday = utcDay === 0 ? 6 : utcDay - 1
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMonday))
  const sunday = new Date(Date.UTC(monday.getUTCFullYear(), monday.getUTCMonth(), monday.getUTCDate() + 6))
  const mondayStr = monday.toISOString().slice(0,10)
  const sundayStr = sunday.toISOString().slice(0,10)
  const label = `${monday.toLocaleDateString('en-US',{month:'short',day:'numeric',timeZone:'UTC'})} – ${sunday.toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric',timeZone:'UTC'})}`
  return { mondayStr, sundayStr, label }
}

async function screenWeeklyStats(chatId, msgId) {
  const { mondayStr, sundayStr, label } = currentWeekRange()
  const daily = loadDaily()
  const entries = Object.entries(daily)
    .filter(([date]) => date >= mondayStr && date <= sundayStr)
    .map(([date, day]) => ({ date, trades: day.trades || [] }))

  const text = renderStatsBlock(entries, `📅 <b>Weekly Stats — ${label}</b>`, 'No trades recorded this week yet.')

  const rows = [
    [{ text:'🔄 Refresh', callback_data:'adm_weekly' }],
    [{ text:'🏠 Admin Home', callback_data:'adm_home' }],
  ]
  return msgId ? editMsg(chatId,msgId,text,rows) : sendInline(chatId,text,rows)
}

// ── PUBLIC weekly stats — shown to subscribers browsing packages, as social
// proof before they buy. Optionally scoped to one market; falls back to a
// combined "All Markets" view (used from bundle package screens). `backTarget`
// is the callback_data to return to (e.g. `sym_gold` or `bun_bnd_xxx`).
async function screenPublicWeeklyStats(chatId, msgId, symId, backTarget) {
  const { mondayStr, sundayStr, label } = currentWeekRange()
  const daily = loadDaily()
  const entries = Object.entries(daily)
    .filter(([date]) => date >= mondayStr && date <= sundayStr)
    .map(([date, day]) => ({ date, trades: symId ? (day.trades||[]).filter(t=>t.sym===symId) : (day.trades||[]) }))

  const scopeLabel = symId ? (getSymbol(symId)?.label || symId) : 'All Markets'
  const emptyNote = symId
    ? `No ${getSymbol(symId)?.label || symId} signals have closed yet this week — check back soon!`
    : 'No signals have closed yet this week — check back soon!'
  const text = renderStatsBlock(entries, `📅 <b>This Week's Performance — ${scopeLabel}</b>\n<i>${label}</i>`, emptyNote)

  const rows = [[{ text:'⬅️ Back', callback_data: backTarget || 'back_home' }]]
  return msgId ? editMsg(chatId,msgId,text,rows) : sendInline(chatId,text,rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — SUBSCRIBERS (v5.3: grouped by user, tappable, with revoke)
// ─────────────────────────────────────────────────────────────────────────────

// Build a Map<chatId, sub[]> of all active subs grouped by user
function groupSubsByUser() {
  const all = Object.values(loadSubs()).filter(s => isActive(s))
  const byUser = new Map()
  for (const s of all) {
    if (!byUser.has(s.chatId)) byUser.set(s.chatId, [])
    byUser.get(s.chatId).push(s)
  }
  return byUser
}

// Main subscriber list — one button per unique user
async function screenAdminSubs(chatId, msgId) {
  const byUser = groupSubsByUser()

  if (!byUser.size) {
    const text = '👥 No active subscribers.'
    return msgId
      ? editMsg(chatId, msgId, text, [[{ text:'⬅️ Back', callback_data:'adm_home' }]])
      : sendInline(chatId, text, [[{ text:'⬅️ Back', callback_data:'adm_home' }]])
  }

  const rows = []
  for (const [uid, subs] of byUser) {
    // Build a compact label of what they hold.
    // If a bundle wrapper is present, skip its individual member subs to avoid clutter.
    const bundleIds = new Set(subs.filter(s => isBundleSub(s)).map(s => s.symbolId))
    const labels = []
    for (const s of subs) {
      if (!isBundleSub(s) && s.viaBundle && bundleIds.has(s.viaBundle)) continue
      if (isBundleId(s.symbolId)) {
        labels.push(`🎁 ${getBundle(s.symbolId)?.label || s.symbolId}`)
      } else {
        labels.push((getSymbol(s.symbolId)?.emoji || '') + ' ' + (getSymbol(s.symbolId)?.label || s.symbolId))
      }
    }
    const daysLeft = Math.min(...subs.map(s => Math.ceil((new Date(s.expiresAt) - new Date()) / 86400000)))
    rows.push([{ text: `👤 ${uid} — ${labels.join(', ')} · ${daysLeft}d`, callback_data: `adm_sub_user_${uid}` }])
  }
  rows.push([{ text: '⬅️ Back', callback_data: 'adm_home' }])

  const uniqueUsers = byUser.size
  const totalSubs   = [...byUser.values()].flat().filter(s => !isBundleSub(s)).length
  const text = `👥 <b>Active Subscribers — ${uniqueUsers} users · ${totalSubs} subscriptions</b>\n\nTap a user to view details or revoke access.`

  return msgId
    ? editMsg(chatId, msgId, text, rows)
    : sendInline(chatId, text, rows)
}

// Per-user detail screen — full sub list + individual Revoke buttons
async function screenSubUser(adminChatId, msgId, targetChatId) {
  const allSubs  = getAllSubsForUser(targetChatId)
  const active   = allSubs.filter(s => isActive(s))
  const inactive = allSubs.filter(s => !isActive(s))

  if (!allSubs.length) {
    return editMsg(adminChatId, msgId,
      `❌ No subscriptions found for <code>${targetChatId}</code>.`,
      [[{ text: '⬅️ Back', callback_data: 'adm_subs' }]]
    )
  }

  const lines = [`👤 <b>Subscriber: <code>${targetChatId}</code></b>\n`]
  const rows  = []

  if (active.length) {
    lines.push('<b>✅ Active subscriptions:</b>')

    // Figure out which bundle wrappers are present so we can hide their member subs
    const bundleIds = new Set(active.filter(s => isBundleSub(s)).map(s => s.symbolId))

    for (const s of active) {
      // Skip member-level subs covered by a visible bundle wrapper
      if (!isBundleSub(s) && s.viaBundle && bundleIds.has(s.viaBundle)) continue

      const name    = productLabel(s.symbolId)
      const exp     = new Date(s.expiresAt).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
      const daysLeft = Math.ceil((new Date(s.expiresAt) - new Date()) / 86400000)
      const plan    = s.planLabel || s.plan || '—'
      lines.push(`${name}\nPlan: ${plan}\nExpires: ${exp} (${daysLeft}d left)\n`)

      // Revoke button uses a safe callback — productId is the symbolId or bundleId
      rows.push([{ text: `🚫 Revoke — ${name}`, callback_data: `adm_revoke_${targetChatId}_${s.symbolId}` }])
    }
  }

  if (inactive.length) {
    lines.push('<b>🕓 Inactive / expired:</b>')
    for (const s of inactive) {
      const name        = productLabel(s.symbolId)
      const statusLabel = s.status === 'expired' ? 'Expired'
                        : s.status === 'revoked'  ? 'Revoked'
                        : s.status === 'denied'   ? 'Denied'
                        : s.status
      lines.push(`${name} — ${statusLabel}`)
    }
  }

  rows.push([{ text: '⬅️ Back to Subscribers', callback_data: 'adm_subs' }])

  await (msgId
    ? editMsg(adminChatId, msgId, lines.join('\n'), rows)
    : sendInline(adminChatId, lines.join('\n'), rows))
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — SYMBOLS MANAGER
// ─────────────────────────────────────────────────────────────────────────────
async function screenSymbolsManager(chatId, msgId) {
  const syms = getSymbols()
  const rows = syms.map(s => [{ text:`${s.active!==false?'✅':'❌'} ${s.emoji||'📊'} ${s.label}`, callback_data:`adm_sym_view_${s.id}` }])
  rows.push([{ text:'➕ Add New Symbol', callback_data:'adm_sym_add' }])
  rows.push([{ text:'⬅️ Back',           callback_data:'adm_home'   }])
  const text=`📊 <b>Symbols Manager</b>\n\nActive: <b>${syms.filter(s=>s.active!==false).length}/${syms.length}</b>`
  return msgId ? editMsg(chatId,msgId,text,rows) : sendInline(chatId,text,rows)
}
async function screenSymbolView(chatId, msgId, symId) {
  const sym = getSymbol(symId); if (!sym) return
  const subsCount = activeSubscribersForSymbol(symId).length
  // ATR calibration summary (v6.0)
  const bands = sym.atr_bands || {}
  const bandLines = Object.keys(bands).length
    ? Object.entries(bands).map(([tf,b]) => `   ${tf}: ${b.atrLow}%–${b.atrHigh}%`).join('\n')
    : '   (not calibrated — using default gold bands)'
  const spreadLine = sym.spread != null ? `${sym.spread}` : '0.30 (default/gold)'
  const rows = [
    [{ text:'✏️ Edit Label', callback_data:`adm_sym_edit_label_${symId}` }, { text:'🪙 Edit TD Symbol', callback_data:`adm_sym_edit_td_${symId}` }],
    [{ text:'🔌 Edit OANDA Sym', callback_data:`adm_sym_edit_oanda_${symId}` }, { text:'📈 Edit Yahoo Sym', callback_data:`adm_sym_edit_yahoo_${symId}` }],
    [{ text:'🔢 Edit Decimals', callback_data:`adm_sym_edit_dec_${symId}` }, { text:'😀 Edit Emoji', callback_data:`adm_sym_edit_emoji_${symId}` }],
    [{ text:'📊 Timeframes', callback_data:`adm_sym_tfs_${symId}` }],
    [{ text:'🎯 Recalibrate ATR', callback_data:`adm_sym_cal_${symId}` }, { text:'💱 Edit Spread', callback_data:`adm_sym_edit_spread_${symId}` }],
    [{ text:'📦 Packages', callback_data:`adm_sym_pkgs_${symId}` }],
    [{ text:'👥 Subscribers', callback_data:`adm_sym_subs_${symId}` }],
    [{ text: sym.active!==false ? '🚫 Disable Symbol' : '✅ Enable Symbol', callback_data:`adm_sym_toggle_${symId}` }],
    [{ text:'🗑️ Delete Symbol', callback_data:`adm_sym_delete_${symId}` }],
    [{ text:'⬅️ Back', callback_data:'adm_symbols' }],
  ]
  await editMsg(chatId,msgId,
`📊 <b>${sym.emoji||''} ${sym.label}</b>\n\nTwelveData: <code>${sym.td_symbol}</code>\nOANDA: <code>${sym.oanda_symbol}</code>\nYahoo: <code>${sym.yahoo_symbol}</code>\nDecimals: <b>${sym.decimals}</b>\nTimeframes: <b>${(sym.timeframes||[]).join(', ')}</b>\n🎯 ATR bands:\n${bandLines}\n💱 Spread: <b>${spreadLine}</b>\nActive subscribers: <b>${subsCount}</b>\nStatus: ${sym.active!==false?'✅ Active':'❌ Disabled'}`, rows)
}
async function screenSymbolTFs(chatId, msgId, symId) {
  const sym = getSymbol(symId); if (!sym) return
  const active = sym.timeframes || [], ALL_TF = ['1m','3m','5m','15m','30m','1h','2h','4h','1d']
  const rows = ALL_TF.map(tf => [{ text:`${active.includes(tf)?'✅':'⬜'} ${tf}`, callback_data:`adm_sym_tf_toggle_${symId}_${tf}` }])
  rows.push([{ text:'⬅️ Back', callback_data:`adm_sym_view_${symId}` }])
  await editMsg(chatId,msgId,`📊 <b>${sym.label} — Timeframes</b>\n\nActive: <b>${active.join(', ')||'none'}</b>\n\n💡 After changing timeframes, run 🎯 Recalibrate ATR so the new TF gets its own band.`, rows)
}
async function screenSymbolPackages(chatId, msgId, symId) {
  const sym = getSymbol(symId); if (!sym) return
  const pkgs = sym.packages || []
  const rows = pkgs.map(p => [{ text:`${p.active!==false?'✅':'❌'} ${p.label} — $${p.price} (${p.days}d)`, callback_data:`adm_sym_pkg_view_${symId}_${p.id}` }])
  rows.push([{ text:'➕ Add Package', callback_data:`adm_sym_pkg_add_${symId}` }])
  rows.push([{ text:'⬅️ Back', callback_data:`adm_sym_view_${symId}` }])
  await editMsg(chatId,msgId,`📦 <b>${sym.label} — Packages</b>`, rows)
}
async function screenSymbolPackageView(chatId, msgId, symId, pkgId) {
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId,pkgId); if(!sym||!pkg) return
  const rows = [
    [{ text:'✏️ Edit Label', callback_data:`adm_sym_pkg_label_${symId}_${pkgId}` }, { text:'💰 Edit Price', callback_data:`adm_sym_pkg_price_${symId}_${pkgId}` }],
    [{ text:'📅 Edit Days', callback_data:`adm_sym_pkg_days_${symId}_${pkgId}` }, { text: pkg.active!==false?'🚫 Disable':'✅ Enable', callback_data:`adm_sym_pkg_toggle_${symId}_${pkgId}` }],
    [{ text:'🗑️ Delete', callback_data:`adm_sym_pkg_del_${symId}_${pkgId}` }],
    [{ text:'⬅️ Back', callback_data:`adm_sym_pkgs_${symId}` }],
  ]
  await editMsg(chatId,msgId,`📦 <b>${sym.label} — ${pkg.label}</b>\n\nPrice: $${pkg.price}\nDuration: ${pkg.days} days\nStatus: ${pkg.active!==false?'✅ Active':'❌ Hidden'}`, rows)
}
async function screenSymbolSubs(chatId, msgId, symId) {
  const sym = getSymbol(symId), subs = activeSubscribersForSymbol(symId)
  if (!subs.length) return editMsg(chatId,msgId,`No active subscribers for ${sym?.label}.`,[[{text:'⬅️ Back',callback_data:`adm_sym_view_${symId}`}]])
  const lines = subs.map(s=>`• <code>${s.chatId}</code> — ${s.planLabel||s.plan} — ${new Date(s.expiresAt).toLocaleDateString()}${s.viaBundle?' (bundle)':''}`)
  await editMsg(chatId,msgId,`👥 <b>${sym?.label} Subscribers (${subs.length})</b>\n\n${lines.join('\n')}`,[[{text:'⬅️ Back',callback_data:`adm_sym_view_${symId}`}]])
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — BUNDLES MANAGER
// ─────────────────────────────────────────────────────────────────────────────
async function screenBundlesManager(chatId, msgId) {
  const bundles = getBundles()
  const rows = bundles.map(b => [{ text:`${b.active!==false?'✅':'❌'} 🎁 ${b.label} (${(b.symbols||[]).length} markets)`, callback_data:`adm_bun_view_${b.id}` }])
  rows.push([{ text:'➕ Add New Bundle', callback_data:'adm_bun_add' }])
  rows.push([{ text:'⬅️ Back',          callback_data:'adm_home'   }])
  const text=`🎁 <b>Bundles Manager</b>\n\nBundles: <b>${bundles.length}</b>`
  return msgId ? editMsg(chatId,msgId,text,rows) : sendInline(chatId,text,rows)
}
async function screenBundleView(chatId, msgId, bid) {
  const b = getBundle(bid); if (!b) return
  const members = (b.symbols||[]).map(id=>getSymbol(id)).filter(Boolean)
  const subsCount = activeSubscribersForSymbol(bid).length
  const rows = [
    [{ text:'✏️ Edit Label', callback_data:`adm_bun_edit_label_${bid}` }, { text:'😀 Edit Emoji', callback_data:`adm_bun_edit_emoji_${bid}` }],
    [{ text:'🧩 Markets', callback_data:`adm_bun_members_${bid}` }],
    [{ text:'📦 Packages', callback_data:`adm_bun_pkgs_${bid}` }],
    [{ text: b.active!==false ? '🚫 Disable Bundle' : '✅ Enable Bundle', callback_data:`adm_bun_toggle_${bid}` }],
    [{ text:'🗑️ Delete Bundle', callback_data:`adm_bun_delete_${bid}` }],
    [{ text:'⬅️ Back', callback_data:'adm_bundles' }],
  ]
  await editMsg(chatId,msgId,
`🎁 <b>${b.emoji||''} ${b.label}</b>\n\nMarkets: <b>${members.map(s=>s.label).join(', ')||'(none)'}</b>\nPackages: <b>${(b.packages||[]).length}</b>\nActive bundle subs: <b>${subsCount}</b>\nStatus: ${b.active!==false?'✅ Active':'❌ Disabled'}`, rows)
}
async function screenBundleMembers(chatId, msgId, bid) {
  const b = getBundle(bid); if (!b) return
  const inSet = new Set(b.symbols||[])
  const rows = getSymbols().map(s => [{ text:`${inSet.has(s.id)?'✅':'⬜'} ${s.emoji||'📊'} ${s.label}`, callback_data:`adm_bun_mem_toggle_${bid}_${s.id}` }])
  rows.push([{ text:'⬅️ Back', callback_data:`adm_bun_view_${bid}` }])
  await editMsg(chatId,msgId,`🧩 <b>${b.label} — Included Markets</b>\n\nCurrently: <b>${(b.symbols||[]).map(id=>getSymbol(id)?.label||id).join(', ')||'none'}</b>`, rows)
}
async function screenBundlePackages(chatId, msgId, bid) {
  const b = getBundle(bid); if (!b) return
  const pkgs = b.packages || []
  const rows = pkgs.map(p => [{ text:`${p.active!==false?'✅':'❌'} ${p.label} — $${p.price} (${p.days}d)`, callback_data:`adm_bun_pkg_view_${bid}_${p.id}` }])
  rows.push([{ text:'➕ Add Package', callback_data:`adm_bun_pkg_add_${bid}` }])
  rows.push([{ text:'⬅️ Back', callback_data:`adm_bun_view_${bid}` }])
  await editMsg(chatId,msgId,`📦 <b>${b.label} — Packages</b>`, rows)
}
async function screenBundlePackageView(chatId, msgId, bid, pkgId) {
  const b = getBundle(bid), pkg = getBundlePackage(bid,pkgId); if(!b||!pkg) return
  const rows = [
    [{ text:'✏️ Edit Label', callback_data:`adm_bun_pkg_label_${bid}_${pkgId}` }, { text:'💰 Edit Price', callback_data:`adm_bun_pkg_price_${bid}_${pkgId}` }],
    [{ text:'📅 Edit Days', callback_data:`adm_bun_pkg_days_${bid}_${pkgId}` }, { text: pkg.active!==false?'🚫 Disable':'✅ Enable', callback_data:`adm_bun_pkg_toggle_${bid}_${pkgId}` }],
    [{ text:'🗑️ Delete', callback_data:`adm_bun_pkg_del_${bid}_${pkgId}` }],
    [{ text:'⬅️ Back', callback_data:`adm_bun_pkgs_${bid}` }],
  ]
  await editMsg(chatId,msgId,`📦 <b>${b.label} — ${pkg.label}</b>\n\nPrice: $${pkg.price}\nDuration: ${pkg.days} days\nStatus: ${pkg.active!==false?'✅ Active':'❌ Hidden'}`, rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN — PENDING APPROVALS
// ─────────────────────────────────────────────────────────────────────────────
async function screenAdminPending(chatId, msgId) {
  const pending = Object.values(loadSubs()).filter(s=>s.status==='awaiting_admin')
  if (!pending.length) return editMsg(chatId,msgId,'✅ No pending approvals.',[[{text:'⬅️ Back',callback_data:'adm_home'}]])
  const rows = pending.map(s=>{
    const bundle = isBundleSub(s)
    const aCb = bundle ? `adm_approveb_${s.chatId}_${s.symbolId}` : `adm_approve_${s.chatId}_${s.symbolId}`
    const dCb = bundle ? `adm_denyb_${s.chatId}_${s.symbolId}`    : `adm_deny_${s.chatId}_${s.symbolId}`
    return [{ text:`✅ Approve ${s.chatId} (${bundle?getBundle(s.symbolId)?.label:getSymbol(s.symbolId)?.label||s.symbolId})`, callback_data:aCb }, { text:'❌ Deny', callback_data:dCb }]
  })
  rows.push([{text:'⬅️ Back',callback_data:'adm_home'}])
  const lines = pending.map(s=>{
    const pkg = isBundleSub(s) ? getBundlePackage(s.symbolId,s.pendingPkg) : getSymbolPackage(s.symbolId,s.pendingPkg)
    return `• <code>${s.chatId}</code> — ${productLabel(s.symbolId)} — ${pkg?.label||s.pendingPkg} — ${s.pendingMethod?.toUpperCase()||''}`
  })
  await editMsg(chatId,msgId,`⏳ <b>Pending Approvals (${pending.length})</b>\n\n${lines.join('\n')}`,rows)
}

// ── BROADCAST PICK ──
async function screenBroadcastPick(chatId, msgId) {
  const syms = getActiveSymbols()
  const activeSubs   = new Set(allActiveSubscribers().map(s=>s.chatId)).size
  const nonSubCount  = getNonSubscriberVisitors().length
  const everyoneCount = getAllKnownChatIds().length

  const rows = []
  // Per-symbol targets
  for (const s of syms) rows.push([{text:`${s.emoji||'📊'} ${s.label} subscribers`, callback_data:`adm_broadcast_sym_${s.id}`}])
  // Audience-wide targets
  rows.push([{ text:`📢 Active subscribers only (${activeSubs})`,              callback_data:'adm_broadcast_all'      }])
  rows.push([{ text:`📣 Non-subscribers / leads (${nonSubCount})`,             callback_data:'adm_broadcast_nonsub'   }])
  rows.push([{ text:`🌐 Everyone — visitors + subscribers (${everyoneCount})`, callback_data:'adm_broadcast_everyone' }])
  rows.push([{ text:'⬅️ Back', callback_data:'adm_home' }])

  const text = `📢 <b>Choose broadcast target:</b>\n\n📢 = active paying subscribers\n📣 = visitors who never paid (or expired)\n🌐 = everyone who has ever pressed /start`
  return msgId ? editMsg(chatId,msgId,text,rows) : sendInline(chatId,text,rows)
}

// ── API KEYS ──
async function screenApiKeys(chatId, msgId) {
  const keys=getSetting('twelvedata_keys')||[]
  const rows=keys.map((k,i)=>[{text:`${k.active?'✅':'❌'} ${k.label} — ${k.key.slice(0,8)}…`,callback_data:`adm_key_view_${i}`}])
  rows.push([{text:'➕ Add API Key',callback_data:'adm_key_add'}]); rows.push([{text:'⬅️ Back',callback_data:'adm_home'}])
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

// ── PAYMENT METHODS ──
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

// ── BOT SETTINGS ──
async function screenBotSettings(chatId,msgId) {
  const s=loadSettings()
  const mode = s.bot_mode || 'live'
  const modeLabel = mode === 'coming_soon' ? '🚧 Coming Soon (tap to go Live)' : '✅ Live (tap to set Coming Soon)'
  const rows=[
    [{text:'📡 Channel',callback_data:'adm_cfg_channel'},{text:'💰 Account Size',callback_data:'adm_cfg_account_size'}],
    [{text:'⚖️ Risk %',callback_data:'adm_cfg_risk_pct'},{text:'⏱️ Price Check',callback_data:'adm_cfg_price_check'}],
    [{text:'🔌 Data Source ('+s.data_source+')',callback_data:'adm_cfg_datasource'},{text:'🌐 OANDA Env ('+s.oanda_env+')',callback_data:'adm_cfg_oanda_env'}],
    [{text:'🔐 OANDA Token',callback_data:'adm_cfg_oanda_token'}],
    [{text:modeLabel, callback_data:'adm_cfg_toggle_mode'}],
    [{text:'✏️ Edit Coming Soon message', callback_data:'adm_cfg_coming_soon_text'}],
    [{text:'⬅️ Back',callback_data:'adm_home'}],
  ]
  const text=`⚙️ <b>Bot Settings</b>\n\n📡 Channel: <b>${s.channel}</b>\n💰 Account: <b>$${s.account_size.toLocaleString()}</b>\n⚖️ Risk: <b>${s.risk_pct}%</b>\n⏱️ Price check: <b>${s.price_check_sec}s</b>\n🔌 Source: <b>${s.data_source}</b>\n🌐 OANDA: <b>${s.oanda_env}</b>\n\n🤖 Bot mode: <b>${mode === 'coming_soon' ? '🚧 Coming Soon' : '✅ Live'}</b>`
  return msgId?editMsg(chatId,msgId,text,rows):sendInline(chatId,text,rows)
}

// ─────────────────────────────────────────────────────────────────────────────
//  ADMIN ACTIONS — approvals + revoke
// ─────────────────────────────────────────────────────────────────────────────
async function adminApprove(adminChatId, targetChatId, symId) {
  const sub = getSub(targetChatId, symId)
  if (!sub) return send(adminChatId,`❌ No pending sub for ${targetChatId} / ${symId}`)
  if (isActive(sub)) return send(adminChatId,`ℹ️ Already active until ${new Date(sub.expiresAt).toLocaleDateString()}`)
  const sym = getSymbol(symId), pkg = getSymbolPackage(symId, sub.pendingPkg)
  if (!pkg) return send(adminChatId,`❌ Package ${sub.pendingPkg} not found`)
  const now=new Date(), exp=new Date(now.getTime()+pkg.days*86400000)
  upsertSub(targetChatId, symId, { status:'active', plan:pkg.id, planLabel:pkg.label, price:pkg.price, activatedAt:now.toISOString(), expiresAt:exp.toISOString(), pendingPkg:null, pendingMethod:null })
  markVisitorSubscriber(targetChatId)
  const expStr=exp.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
  await send(adminChatId,`✅ Approved ${targetChatId} for ${sym?.label} — ${pkg.label} until ${expStr}`)
  await send(targetChatId,`🎉 <b>Payment Confirmed!</b>\n\nMarket: <b>${sym?.emoji||''} ${sym?.label}</b>\nPlan: <b>${pkg.label}</b> — Active until <b>${expStr}</b>\n\nSignals will be sent here automatically. 🟡\n\n💡 Tip: use /keepholding to turn "KEEP HOLDING" updates on/off, and /statistics to see this week's live results.`)
}
async function adminDeny(adminChatId, targetChatId, symId) {
  const sub = getSub(targetChatId, symId); if (!sub) return send(adminChatId,`❌ Not found`)
  const sym=getSymbol(symId), pkg=getSymbolPackage(symId,sub.pendingPkg)
  upsertSub(targetChatId,symId,{status:'denied',pendingPkg:null,pendingMethod:null})
  await send(adminChatId,`✅ Denied ${targetChatId} for ${sym?.label}.`)
  await send(targetChatId,`❌ <b>Payment Not Confirmed</b>\n\nCould not verify your payment for ${sym?.label} — ${pkg?.label||''}.\n\nPlease try again.\n/start`)
}
async function adminApproveBundle(adminChatId, targetChatId, bid) {
  const sub = getSub(targetChatId, bid)
  if (!sub) return send(adminChatId,`❌ No pending bundle sub for ${targetChatId} / ${bid}`)
  const bundle = getBundle(bid); if (!bundle) return send(adminChatId,`❌ Bundle ${bid} not found`)
  const pkg = getBundlePackage(bid, sub.pendingPkg); if (!pkg) return send(adminChatId,`❌ Bundle package ${sub.pendingPkg} not found`)
  const now=new Date(), exp=new Date(now.getTime()+pkg.days*86400000), expStr=exp.toLocaleDateString('en-US',{year:'numeric',month:'long',day:'numeric'})
  upsertSub(targetChatId, bid, { status:'active', plan:pkg.id, planLabel:`${bundle.label} — ${pkg.label}`, price:pkg.price, activatedAt:now.toISOString(), expiresAt:exp.toISOString(), isBundle:true, pendingPkg:null, pendingMethod:null })
  markVisitorSubscriber(targetChatId)
  const granted=[]
  for (const symId of (bundle.symbols||[])) {
    const sym=getSymbol(symId); if(!sym) continue
    upsertSub(targetChatId, symId, { status:'active', plan:`bundle:${bid}`, planLabel:`${bundle.label} (bundle)`, price:0, activatedAt:now.toISOString(), expiresAt:exp.toISOString(), viaBundle:bid, pendingPkg:null, pendingMethod:null })
    granted.push(`${sym.emoji||''} ${sym.label}`)
  }
  await send(adminChatId,`✅ Approved bundle "${bundle.label}" for ${targetChatId} until ${expStr}\nGranted: ${granted.join(', ')||'(no markets!)'}`)
  await send(targetChatId,`🎉 <b>Bundle Activated!</b>\n\n🎁 <b>${bundle.label}</b> — ${pkg.label}\nActive until <b>${expStr}</b>\n\nIncluded markets:\n${granted.map(g=>'• '+g).join('\n')}\n\nSignals for all included markets will arrive here. 🟡\n\n💡 Tip: use /keepholding to turn "KEEP HOLDING" updates on/off, and /statistics to see this week's live results.`)
}
async function adminDenyBundle(adminChatId, targetChatId, bid) {
  const sub = getSub(targetChatId, bid); if (!sub) return send(adminChatId,`❌ Not found`)
  const bundle=getBundle(bid)
  upsertSub(targetChatId,bid,{status:'denied',pendingPkg:null,pendingMethod:null})
  await send(adminChatId,`✅ Denied bundle ${bundle?.label} for ${targetChatId}.`)
  await send(targetChatId,`❌ <b>Payment Not Confirmed</b>\n\nCould not verify your payment for 🎁 ${bundle?.label||bid}.\n\nPlease try again.\n/start`)
}
async function adminRevoke(adminChatId, targetChatId, productId) {
  if (isBundleId(productId)) {
    const bundle=getBundle(productId)
    upsertSub(targetChatId,productId,{status:'revoked',expiresAt:new Date().toISOString()})
    const data=loadSubs()
    for (const s of Object.values(data)) {
      if (s.chatId===String(targetChatId) && s.viaBundle===productId) upsertSub(targetChatId,s.symbolId,{status:'revoked',expiresAt:new Date().toISOString()})
    }
    await send(adminChatId,`✅ Revoked bundle ${bundle?.label} (and its markets) from ${targetChatId}.`)
    await send(targetChatId,`⚠️ Your 🎁 ${bundle?.label||productId} bundle has been revoked.`)
    return
  }
  upsertSub(targetChatId,productId,{status:'revoked',expiresAt:new Date().toISOString()})
  const sym=getSymbol(productId)
  await send(adminChatId,`✅ Revoked ${targetChatId} from ${sym?.label||productId}.`)
  await send(targetChatId,`⚠️ Your ${sym?.label||productId} subscription has been revoked.`)
}

// ─────────────────────────────────────────────────────────────────────────────
//  UPDATE ROUTER
// ─────────────────────────────────────────────────────────────────────────────
async function handleUpdate(upd) {
  // ── MESSAGES ──
  if (upd.message) {
    const msg=upd.message, chatId=String(msg.chat.id), text=msg.text||''
    const isAdmin=chatId===String(ADMIN_ID), firstName=msg.from?.first_name||'there'
    const sess=getSession(chatId)

    if (isAdmin && sess) {
      const {step,data}=sess

      if(step==='sym_add_label')   { setSession(chatId,'sym_add_td',{label:text});        return send(chatId,`📡 TwelveData symbol for "<b>${text}</b>":\n(e.g. EUR/USD, BTC/USD, AAPL)`) }
      if(step==='sym_add_td')      { setSession(chatId,'sym_add_oanda',{...data,td:text.trim()});   return send(chatId,`🔌 OANDA instrument:\n(e.g. EUR_USD — or send <code>none</code>)`) }
      if(step==='sym_add_oanda')   { setSession(chatId,'sym_add_yahoo',{...data,oanda:text==='none'?'':text.trim()}); return send(chatId,`📈 Yahoo Finance ticker:\n(e.g. EURUSD=X — or <code>none</code>)`) }
      if(step==='sym_add_yahoo')   { setSession(chatId,'sym_add_dec',{...data,yahoo:text==='none'?'':text.trim()});   return send(chatId,`🔢 Decimal places:\n(2 for gold/forex, 5 for pairs, 0 for indices)`) }
      if(step==='sym_add_dec')     { const n=parseInt(text); setSession(chatId,'sym_add_emoji',{...data,dec:isNaN(n)?2:n}); return send(chatId,`😀 Emoji (e.g. 💶 🪙 📈) or <code>none</code>:`) }
      if(step==='sym_add_emoji') {
        setSession(chatId,'sym_add_spread',{...data,emoji:text==='none'?'📊':text.trim()})
        return send(chatId,
`💱 <b>Typical spread</b> for "<b>${data.label}</b>" — in <b>price units</b>, not pips:

Examples:
• Gold (XAU/USD): <code>0.30</code>
• EUR/USD: <code>0.00015</code>  (~1.5 pip)
• GBP/USD: <code>0.0002</code>   (~2 pip)
• USD/JPY: <code>0.02</code>     (~2 pip)
• GBP/JPY: <code>0.03</code>     (~3 pip)

💡 How to find this: check your broker's spread for this pair (in pips), then convert:
• 4-decimal pairs (most majors, e.g. EUR/USD): spread ÷ 10000
• 2-decimal pairs (JPY pairs, gold): spread ÷ 100

Send <code>default</code> to use gold's spread (0.30) — only correct if this instrument's price units resemble gold's.`)
      }
      if(step==='sym_add_spread') {
        const raw=text.trim().toLowerCase()
        const v = raw==='default' ? null : parseFloat(text)
        const spreadVal = (v!=null && !isNaN(v) && v>0) ? v : null
        const syms=getSymbols(), id=nextSymbolId(data.label)
        syms.push({ id, label:data.label, emoji:data.emoji, td_symbol:data.td, oanda_symbol:data.oanda, yahoo_symbol:data.yahoo, decimals:data.dec, timeframes:['15m','1h'], active:true, packages:[], spread:spreadVal })
        saveSymbols(syms); clearSession(chatId)
        // Auto-calibrate ATR bands in the background (v6.0) — this is what
        // makes forex pairs work instead of being blocked as low_liquidity.
        calibrateSymbol(id)
          .then(r => send(chatId, `${r.ok?'🎯':'⚠️'} <b>ATR calibration for ${data.label}</b>\n\n${r.msg}\n\n⚠️ Restart the launcher to apply.`))
          .catch(e => send(chatId, `⚠️ ATR calibration failed for ${data.label}: ${e.message}\nYou can retry via /admin → Symbols → ${data.label} → 🎯 Recalibrate ATR`))
        return send(chatId,`✅ <b>Symbol Added!</b>\n\nID: <code>${id}</code>\nSpread: <b>${spreadVal ?? '0.30 (default/gold)'}</b>\n\n🎯 Auto-calibrating ATR bands now (takes ~10–30s, result will arrive here)…\n\nAdd packages via /admin → Symbols → ${data.label} → Packages`)
      }

      if(step==='sym_edit_label') { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.label=text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ Label updated.\n\n/admin`) }
      if(step==='sym_edit_td')    { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.td_symbol=text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ TwelveData symbol updated.\n\n💡 Run 🎯 Recalibrate ATR for this symbol — the data feed changed.\n\n/admin`) }
      if(step==='sym_edit_oanda') { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.oanda_symbol=text==='none'?'':text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ OANDA symbol updated.\n\n/admin`) }
      if(step==='sym_edit_yahoo') { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.yahoo_symbol=text==='none'?'':text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ Yahoo symbol updated.\n\n/admin`) }
      if(step==='sym_edit_dec')   { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s){const n=parseInt(text); s.decimals=isNaN(n)?2:n;} saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ Decimals updated.\n\n/admin`) }
      if(step==='sym_edit_emoji') { const syms=getSymbols(),s=syms.find(x=>x.id===data.symId); if(s)s.emoji=text==='none'?'📊':text.trim(); saveSymbols(syms); clearSession(chatId); return send(chatId,`✅ Emoji updated.\n\n/admin`) }
      if(step==='sym_edit_spread') {
        const raw=text.trim().toLowerCase()
        const syms=getSymbols(),s=syms.find(x=>x.id===data.symId)
        if(s){ const v = raw==='default' ? null : parseFloat(text); s.spread = (v!=null && !isNaN(v) && v>0) ? v : null }
        saveSymbols(syms); clearSession(chatId)
        return send(chatId,`✅ Spread updated.\n\n⚠️ Restart the launcher to apply.\n\n/admin`)
      }

      if(step==='sym_pkg_add_label') { setSession(chatId,'sym_pkg_add_price',{...data,label:text}); return send(chatId,`💰 Price in USD for "<b>${text}</b>":`) }
      if(step==='sym_pkg_add_price') { const p=parseFloat(text); if(isNaN(p)||p<=0) return send(chatId,'❌ Invalid price:'); setSession(chatId,'sym_pkg_add_days',{...data,price:p}); return send(chatId,`📅 Duration in days:`) }
      if(step==='sym_pkg_add_days') {
        const d=parseInt(text); if(isNaN(d)||d<=0) return send(chatId,'❌ Invalid days:')
        const id=nextPkgId(data.symId); saveSymbolPackage(data.symId,{id,label:data.label,price:data.price,days:d,active:true}); clearSession(chatId)
        return send(chatId,`✅ <b>Package Added!</b>\n\n${data.label} — $${data.price} / ${d} days\n\n/admin`)
      }
      if(step==='sym_pkg_label') { const pkg=getSymbolPackage(data.symId,data.pkgId); if(pkg){pkg.label=text.trim();saveSymbolPackage(data.symId,pkg);} clearSession(chatId); return send(chatId,`✅ Label updated.\n\n/admin`) }
      if(step==='sym_pkg_price') { const p=parseFloat(text); if(isNaN(p)||p<=0) return send(chatId,'❌ Invalid:'); const pkg=getSymbolPackage(data.symId,data.pkgId); if(pkg){pkg.price=p;saveSymbolPackage(data.symId,pkg);} clearSession(chatId); return send(chatId,`✅ Price updated.\n\n/admin`) }
      if(step==='sym_pkg_days')  { const d=parseInt(text); if(isNaN(d)||d<=0) return send(chatId,'❌ Invalid:'); const pkg=getSymbolPackage(data.symId,data.pkgId); if(pkg){pkg.days=d;saveSymbolPackage(data.symId,pkg);} clearSession(chatId); return send(chatId,`✅ Duration updated.\n\n/admin`) }

      if(step==='bun_add_label') { setSession(chatId,'bun_add_emoji',{label:text.trim()}); return send(chatId,`😀 Emoji for the bundle (e.g. 🎁 💼 ⭐) or <code>none</code>:`) }
      if(step==='bun_add_emoji') {
        const arr=getBundles(), id=nextBundleId(data.label)
        arr.push({ id, label:data.label, emoji:text==='none'?'🎁':text.trim(), symbols:[], packages:[], active:true })
        saveBundles(arr); clearSession(chatId)
        return send(chatId,`✅ <b>Bundle Created!</b>\n\n${data.label}\nID: <code>${id}</code>\n\n/admin → 🎁 Bundles → ${data.label}`)
      }
      if(step==='bun_edit_label') { const arr=getBundles(),b=arr.find(x=>x.id===data.bid); if(b)b.label=text.trim(); saveBundles(arr); clearSession(chatId); return send(chatId,`✅ Bundle label updated.\n\n/admin`) }
      if(step==='bun_edit_emoji') { const arr=getBundles(),b=arr.find(x=>x.id===data.bid); if(b)b.emoji=text==='none'?'🎁':text.trim(); saveBundles(arr); clearSession(chatId); return send(chatId,`✅ Bundle emoji updated.\n\n/admin`) }
      if(step==='bun_pkg_add_label') { setSession(chatId,'bun_pkg_add_price',{...data,label:text}); return send(chatId,`💰 Price in USD for "<b>${text}</b>":`) }
      if(step==='bun_pkg_add_price') { const p=parseFloat(text); if(isNaN(p)||p<=0) return send(chatId,'❌ Invalid price:'); setSession(chatId,'bun_pkg_add_days',{...data,price:p}); return send(chatId,`📅 Duration in days:`) }
      if(step==='bun_pkg_add_days') {
        const d=parseInt(text); if(isNaN(d)||d<=0) return send(chatId,'❌ Invalid days:')
        const id=nextBundlePkgId(data.bid); saveBundlePackage(data.bid,{id,label:data.label,price:data.price,days:d,active:true}); clearSession(chatId)
        return send(chatId,`✅ <b>Bundle Package Added!</b>\n\n${data.label} — $${data.price} / ${d} days\n\n/admin`)
      }
      if(step==='bun_pkg_label') { const pkg=getBundlePackage(data.bid,data.pkgId); if(pkg){pkg.label=text.trim();saveBundlePackage(data.bid,pkg);} clearSession(chatId); return send(chatId,`✅ Label updated.\n\n/admin`) }
      if(step==='bun_pkg_price') { const p=parseFloat(text); if(isNaN(p)||p<=0) return send(chatId,'❌ Invalid:'); const pkg=getBundlePackage(data.bid,data.pkgId); if(pkg){pkg.price=p;saveBundlePackage(data.bid,pkg);} clearSession(chatId); return send(chatId,`✅ Price updated.\n\n/admin`) }
      if(step==='bun_pkg_days')  { const d=parseInt(text); if(isNaN(d)||d<=0) return send(chatId,'❌ Invalid:'); const pkg=getBundlePackage(data.bid,data.pkgId); if(pkg){pkg.days=d;saveBundlePackage(data.bid,pkg);} clearSession(chatId); return send(chatId,`✅ Duration updated.\n\n/admin`) }

      if(step==='add_key_label') { setSession(chatId,'add_key_value',{label:text}); return send(chatId,`🔑 Send the <b>API key string</b> for "<b>${text}</b>":`) }
      if(step==='add_key_value') { const keys=getSetting('twelvedata_keys')||[]; keys.push({key:text.trim(),label:data.label,active:true}); setSetting('twelvedata_keys',keys); clearSession(chatId); return send(chatId,`✅ Key "<b>${data.label}</b>" added.\n\n/admin`) }
      if(step==='edit_key_label') { const keys=getSetting('twelvedata_keys')||[]; keys[data.idx].label=text.trim(); setSetting('twelvedata_keys',keys); clearSession(chatId); return send(chatId,`✅ Key label updated.\n\n/admin`) }
      if(step==='edit_key_value') { const keys=getSetting('twelvedata_keys')||[]; keys[data.idx].key=text.trim(); setSetting('twelvedata_keys',keys); clearSession(chatId); return send(chatId,`✅ API key replaced.\n\n/admin`) }

      if(step==='pay_add_label')   { setSession(chatId,'pay_add_coin',{label:text}); return send(chatId,`🪙 Coin symbol (e.g. USDT, BTC, ETH):`) }
      if(step==='pay_add_coin')    { setSession(chatId,'pay_add_network',{...data,coin:text.toUpperCase()}); return send(chatId,`🌐 Network (e.g. TRC-20) or <code>none</code>:`) }
      if(step==='pay_add_network') { setSession(chatId,'pay_add_address',{...data,network:text==='none'?'':text}); return send(chatId,`📋 Wallet address:`) }
      if(step==='pay_add_address') { const m=getAllPayMethods(),id=nextPayId(); m.push({id,label:data.label,coin:data.coin,network:data.network,address:text.trim(),active:true}); savePayMethods(m); clearSession(chatId); return send(chatId,`✅ Payment method "<b>${data.label}</b>" added.\n\n/admin`) }
      if(step==='pay_edit_label')   { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].label=text.trim();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Updated.\n\n/admin`) }
      if(step==='pay_edit_coin')    { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].coin=text.trim().toUpperCase();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Updated.\n\n/admin`) }
      if(step==='pay_edit_network') { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].network=text==='none'?'':text.trim();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Updated.\n\n/admin`) }
      if(step==='pay_edit_address') { const m=getAllPayMethods(),i=m.findIndex(x=>x.id===data.payId); if(i>=0){m[i].address=text.trim();savePayMethods(m);} clearSession(chatId); return send(chatId,`✅ Address updated.\n\n/admin`) }

      if(step==='cfg_channel')      { setSetting('channel',text.trim()); clearSession(chatId); return send(chatId,`✅ Channel → <b>${text.trim()}</b>\n\n/admin`) }
      if(step==='cfg_account_size') { const v=parseFloat(text); if(isNaN(v)||v<=0) return send(chatId,'❌ Invalid:'); setSetting('account_size',v); clearSession(chatId); return send(chatId,`✅ Account size → $${v.toLocaleString()}\n\n/admin`) }
      if(step==='cfg_risk_pct')     { const v=parseFloat(text); if(isNaN(v)||v<=0) return send(chatId,'❌ Invalid:'); setSetting('risk_pct',v); clearSession(chatId); return send(chatId,`✅ Risk → ${v}%\n\n/admin`) }
      if(step==='cfg_price_check')  { const v=parseInt(text); if(isNaN(v)||v<5) return send(chatId,'❌ Min 5s:'); setSetting('price_check_sec',v); clearSession(chatId); return send(chatId,`✅ Price check → ${v}s\n\n⚠️ Restart launcher to apply.\n\n/admin`) }
      if(step==='cfg_oanda_token')  { setSetting('oanda_token',text.trim()==='none'?'':text.trim()); clearSession(chatId); return send(chatId,`✅ OANDA token saved.\n\n/admin`) }
      if(step==='cfg_coming_soon_text') { setSetting('coming_soon_text',text.trim()); clearSession(chatId); return send(chatId,`✅ Coming Soon message updated.\n\nPreview:\n\n${text.trim()}\n\n/admin`) }

      if(step==='broadcast_msg') {
        const { symId, target } = data
        clearSession(chatId)
        let r, targetLabel
        if (target === 'nonsub') {
          const ids = getNonSubscriberVisitors().map(v => v.chatId)
          r = await broadcastToList(text, ids)
          targetLabel = 'non-subscribers / leads'
        } else if (target === 'everyone') {
          const ids = getAllKnownChatIds()
          r = await broadcastToList(text, ids)
          targetLabel = 'everyone (all visitors + subscribers)'
        } else if (symId) {
          r = await broadcastSignal(text, symId)
          targetLabel = getSymbol(symId)?.label || symId
        } else {
          r = await broadcastSignal(text, null)
          targetLabel = 'all active subscribers'
        }
        return send(chatId, `📢 Broadcast sent to <b>${targetLabel}</b>!\n\n✅ Delivered: ${r.sent}\n❌ Failed: ${r.failed}`)
      }

      if(text.startsWith('/')) clearSession(chatId)
    }

    // ── Regular commands ──
    if(text==='/start')  return screenStart(chatId, firstName, msg.from||{})
    if(text==='/status') {
      const subs=getAllSubsForUser(chatId).filter(s=>isActive(s))
      if(!subs.length) return send(chatId,'No active subscriptions.\n\n/start — view markets')
      const lines=subs.map(s=>{const exp=new Date(s.expiresAt).toLocaleDateString(),d=Math.ceil((new Date(s.expiresAt)-new Date())/86400000);return `${productLabel(s.symbolId)} — ${s.planLabel} — ${exp} (${d}d)`})
      return send(chatId,`📊 <b>Your Active Subscriptions</b>\n\n${lines.join('\n')}`)
    }
    // ── /keepholding — per-user toggle for KEEP HOLDING updates (v6.0) ──
    if(text==='/keepholding' || text==='/keep_holding') {
      const next = !keepHoldingEnabled(chatId)
      setKeepHolding(chatId, next)
      return send(chatId,
`🔁 <b>Keep-Holding Updates: ${next ? 'ON ✅' : 'OFF 🚫'}</b>\n\n`+
`<b>What is this?</b>\nWhen a new candle closes and your open trade is still valid, the bot sends a "KEEP HOLDING" message confirming the trade stays open (with its current SL and TP progress).\n\n`+
(next
  ? `You will now <b>receive</b> these updates.`
  : `You will <b>no longer receive</b> these updates.\n\nYou still get everything else as normal:\n• New signals (Entry / SL / TP1 / TP2 / TP3)\n• ✅ TP hit alerts\n• 🟦 Break-even alerts\n• ❌ Stop-loss alerts\n• 📈 Daily summaries`)+
`\n\nSend /keepholding again anytime to switch it back.`)
    }
    // ── /statistics — weekly performance picker, open to EVERYONE (v6.0) ──
    if(text==='/statistics') return screenStatsPicker(chatId, null)
    if(text==='/help') return send(chatId,`📖 <b>GOLD AI — How It Works</b>\n\n/start — view & subscribe\n/status — your subscriptions\n/statistics — this week's live performance (any market)\n/keepholding — turn "KEEP HOLDING" updates on/off`)

    if(!isAdmin) return

    const parts=text.split(' ')
    if(text==='/admin')    return screenAdminHome(chatId)
    if(text==='/symbols')  return screenSymbolsManager(chatId,null)
    if(text==='/bundles')  return screenBundlesManager(chatId,null)
    if(text==='/stats')    return screenMonthlyStats(chatId,null)
    if(text==='/weekstats')return screenWeeklyStats(chatId,null)
    if(text==='/keys')     return screenApiKeys(chatId,null)
    if(text==='/payments') return screenPayments(chatId,null)
    if(text==='/settings') return screenBotSettings(chatId,null)
    if(text==='/subs')     {
      const subs=allActiveSubscribers().filter(s=>!isBundleSub(s))
      if(!subs.length) return send(chatId,'No active subscribers.')
      const lines=subs.map(s=>`• <code>${s.chatId}</code> — ${productLabel(s.symbolId)} — ${s.planLabel} — ${new Date(s.expiresAt).toLocaleDateString()}`)
      return send(chatId,`<b>All Active Subscriptions (${subs.length})</b>\n\n${lines.join('\n')}`)
    }
    if(parts[0]==='/calibrate' && parts[1]) {
      await send(chatId, `🎯 Calibrating ATR bands for <code>${parts[1]}</code>… (takes ~10–30s)`)
      const r = await calibrateSymbol(parts[1])
      return send(chatId, `${r.ok?'✅':'⚠️'} <b>ATR Calibration ${r.ok?'Complete':'Failed'}</b>\n\n${r.msg}\n\n⚠️ Restart the launcher to apply.`)
    }
    if(parts[0]==='/approve' && parts[1] && parts[2]) return isBundleId(parts[2]) ? adminApproveBundle(chatId,parts[1],parts[2]) : adminApprove(chatId,parts[1],parts[2])
    if(parts[0]==='/deny'    && parts[1] && parts[2]) return isBundleId(parts[2]) ? adminDenyBundle(chatId,parts[1],parts[2])    : adminDeny(chatId,parts[1],parts[2])
    if(parts[0]==='/revoke'  && parts[1] && parts[2]) return adminRevoke(chatId,parts[1],parts[2])
    if(parts[0]==='/check'   && parts[1]) { const subs=getAllSubsForUser(parts[1]); return send(chatId,subs.length?`<pre>${JSON.stringify(subs,null,2)}</pre>`:`❌ Not found: ${parts[1]}`) }
    return
  }

  // ── CALLBACKS ──
  if (upd.callback_query) {
    const cb=upd.callback_query,chatId=String(cb.message.chat.id)
    const msgId=cb.message.message_id,data=cb.data||'',isAdmin=chatId===String(ADMIN_ID)
    await answerCb(cb.id)

    // ── User flow ──
    if(data==='back_home')  return screenStart(chatId, '', cb.from||{})
    if(data==='my_subs')    return screenMySubs(chatId,msgId)
    if(data==='stats_menu') return screenStatsPicker(chatId,msgId)
    const symM=data.match(/^sym_(\w+)$/);   if(symM) return screenSymbol(chatId,symM[1],msgId)
    const pkgM=data.match(/^pkg_(\w+)_(\w+)$/);  if(pkgM) return screenPickPayment(chatId,pkgM[1],pkgM[2],msgId)
    const payM=data.match(/^pay_(\w+)_(\w+)_(\w+)$/);  if(payM) return screenPayment(chatId,payM[1],payM[2],payM[3],msgId)
    const confM=data.match(/^confirm_(\w+)_(\w+)_(\w+)$/);  if(confM) return screenConfirmPending(chatId,confM[1],confM[2],confM[3],msgId)
    const joinM=data.match(/^checkjoin_(\w+)_(\w+)_(\w+)$/);  if(joinM) return screenCheckJoin(chatId,joinM[1],joinM[2],joinM[3],msgId)
    const bunM=data.match(/^bun_(\w+)$/);    if(bunM) return screenBundle(chatId,bunM[1],msgId)
    const bpkgM=data.match(/^bpkg_(\w+)_(\w+)$/);  if(bpkgM) return screenBundlePickPayment(chatId,bpkgM[1],bpkgM[2],msgId)
    const bpayM=data.match(/^bpay_(\w+)_(\w+)_(\w+)$/);  if(bpayM) return screenBundlePayment(chatId,bpayM[1],bpayM[2],bpayM[3],msgId)
    const bconfM=data.match(/^bconfirm_(\w+)_(\w+)_(\w+)$/);  if(bconfM) return screenBundleConfirmPending(chatId,bconfM[1],bconfM[2],bconfM[3],msgId)
    const bjoinM=data.match(/^bcheckjoin_(\w+)_(\w+)_(\w+)$/);  if(bjoinM) return screenBundleCheckJoin(chatId,bjoinM[1],bjoinM[2],bjoinM[3],msgId)

    // Public weekly-performance teaser (shown from package selection screens,
    // the main menu, and the /statistics picker)
    // pwk_<symId|all>_<backTarget>  — backTarget is itself a callback_data string
    const pwkM=data.match(/^pwk_([a-z0-9]+)_(.+)$/)
    if(pwkM) return screenPublicWeeklyStats(chatId, msgId, pwkM[1]==='all'?null:pwkM[1], pwkM[2])

    if(!isAdmin) return

    // ── Admin nav ──
    if(data==='adm_home')          return screenAdminHome(chatId)
    if(data==='adm_symbols')       return screenSymbolsManager(chatId,msgId)
    if(data==='adm_bundles')       return screenBundlesManager(chatId,msgId)
    if(data==='adm_stats')         return screenMonthlyStats(chatId,msgId)
    if(data==='adm_weekly')        return screenWeeklyStats(chatId,msgId)
    if(data==='adm_subs')          return screenAdminSubs(chatId,msgId)
    if(data==='adm_pending')       return screenAdminPending(chatId,msgId)
    if(data==='adm_keys')          return screenApiKeys(chatId,msgId)
    if(data==='adm_payments')      return screenPayments(chatId,msgId)
    if(data==='adm_botsettings')   return screenBotSettings(chatId,msgId)
    if(data==='adm_broadcast_pick')return screenBroadcastPick(chatId,msgId)
    const statsM=data.match(/^adm_stats_(\d{4}-\d{2})$/); if(statsM) return screenMonthlyStats(chatId,msgId,statsM[1])

    // ── v5.3: per-user subscriber view + revoke ──
    // adm_sub_user_<chatId>  — chatId is all digits
    const subUserM = data.match(/^adm_sub_user_(\d+)$/)
    if (subUserM) return screenSubUser(chatId, msgId, subUserM[1])

    // adm_revoke_<chatId>_<productId>
    // productId may contain underscores (e.g. bnd_xxx) — use a greedy split:
    // everything after the first _ following the chatId digits is the productId.
    const revokeM = data.match(/^adm_revoke_(\d+)_(.+)$/)
    if (revokeM) {
      await adminRevoke(chatId, revokeM[1], revokeM[2])
      return screenSubUser(chatId, msgId, revokeM[1])   // refresh the user's profile
    }

    // ── Symbol management ──
    const symView=data.match(/^adm_sym_view_(\w+)$/);   if(symView) return screenSymbolView(chatId,msgId,symView[1])
    const symToggle=data.match(/^adm_sym_toggle_(\w+)$/);  if(symToggle){const syms=getSymbols(),s=syms.find(x=>x.id===symToggle[1]);if(s)s.active=!s.active;saveSymbols(syms);return screenSymbolView(chatId,msgId,symToggle[1])}
    const symDel=data.match(/^adm_sym_delete_(\w+)$/);  if(symDel){saveSymbols(getSymbols().filter(x=>x.id!==symDel[1]));return editMsg(chatId,msgId,`🗑️ Symbol deleted.`,[[{text:'⬅️ Back',callback_data:'adm_symbols'}]])}
    if(data==='adm_sym_add'){setSession(chatId,'sym_add_label',{});return editMsg(chatId,msgId,`➕ <b>Add Symbol — Step 1/7</b>\n\nSend the <b>display name</b>:`,[[{text:'❌ Cancel',callback_data:'adm_symbols'}]])}
    // 🎯 Recalibrate ATR (v6.0) — refits the low-liquidity/volatile bands to
    // THIS symbol's real volatility, per timeframe. Restart launcher to apply.
    const symCal=data.match(/^adm_sym_cal_(\w+)$/)
    if(symCal){
      const sym=getSymbol(symCal[1]); if(!sym) return
      await editMsg(chatId,msgId,`🎯 <b>Calibrating ATR bands for ${sym.label}…</b>\n\nFetching ~500 candles per timeframe from TwelveData — this takes about 10–30 seconds. Result will arrive as a new message.`)
      try {
        const r=await calibrateSymbol(symCal[1])
        await send(chatId, `${r.ok?'✅':'⚠️'} <b>ATR Calibration ${r.ok?'Complete':'Failed'} — ${sym.label}</b>\n\n${r.msg}\n\n⚠️ <b>Restart the launcher</b> to apply the new bands.`)
      } catch(e) {
        await send(chatId, `⚠️ Calibration error for ${sym.label}: ${e.message}`)
      }
      return screenSymbolView(chatId,msgId,symCal[1])
    }
    // 💱 Edit Spread (v6.1)
    const symESpr=data.match(/^adm_sym_edit_spread_(\w+)$/)
    if(symESpr){
      const sym=getSymbol(symESpr[1]); if(!sym) return
      setSession(chatId,'sym_edit_spread',{symId:symESpr[1]})
      return editMsg(chatId,msgId,
`💱 <b>Edit Spread — ${sym.label}</b>\n\nCurrent: <b>${sym.spread ?? '0.30 (default/gold)'}</b>\n\nSend the new spread in <b>price units</b> (not pips), or <code>default</code> to reset to gold's 0.30:\n\nExamples: EUR/USD ≈ <code>0.00015</code> · GBP/JPY ≈ <code>0.03</code>`,
        [[{text:'❌ Cancel',callback_data:`adm_sym_view_${symESpr[1]}`}]])
    }
    const symEL=data.match(/^adm_sym_edit_label_(\w+)$/); if(symEL){setSession(chatId,'sym_edit_label',{symId:symEL[1]});return editMsg(chatId,msgId,`✏️ Send new <b>display label</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEL[1]}`}]])}
    const symET=data.match(/^adm_sym_edit_td_(\w+)$/);    if(symET){setSession(chatId,'sym_edit_td',{symId:symET[1]});return editMsg(chatId,msgId,`📡 Send new <b>TwelveData symbol</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symET[1]}`}]])}
    const symEO=data.match(/^adm_sym_edit_oanda_(\w+)$/); if(symEO){setSession(chatId,'sym_edit_oanda',{symId:symEO[1]});return editMsg(chatId,msgId,`🔌 Send new <b>OANDA instrument</b> or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEO[1]}`}]])}
    const symEY=data.match(/^adm_sym_edit_yahoo_(\w+)$/); if(symEY){setSession(chatId,'sym_edit_yahoo',{symId:symEY[1]});return editMsg(chatId,msgId,`📈 Send new <b>Yahoo ticker</b> or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEY[1]}`}]])}
    const symED=data.match(/^adm_sym_edit_dec_(\w+)$/);   if(symED){setSession(chatId,'sym_edit_dec',{symId:symED[1]});return editMsg(chatId,msgId,`🔢 Send <b>decimal places</b> (0-8):`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symED[1]}`}]])}
    const symEE=data.match(/^adm_sym_edit_emoji_(\w+)$/); if(symEE){setSession(chatId,'sym_edit_emoji',{symId:symEE[1]});return editMsg(chatId,msgId,`😀 Send new <b>emoji</b> or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_view_${symEE[1]}`}]])}
    const symTFs=data.match(/^adm_sym_tfs_(\w+)$/); if(symTFs) return screenSymbolTFs(chatId,msgId,symTFs[1])
    const symTfT=data.match(/^adm_sym_tf_toggle_(\w+)_(.+)$/)
    if(symTfT){const syms=getSymbols(),s=syms.find(x=>x.id===symTfT[1]);if(!s)return;const tfs=s.timeframes||[],i=tfs.indexOf(symTfT[2]);if(i>=0)tfs.splice(i,1);else tfs.push(symTfT[2]);tfs.sort((a,b)=>{const o=['1m','3m','5m','15m','30m','1h','2h','4h','1d'];return o.indexOf(a)-o.indexOf(b)});s.timeframes=tfs;saveSymbols(syms);return screenSymbolTFs(chatId,msgId,symTfT[1])}
    const symPkgs=data.match(/^adm_sym_pkgs_(\w+)$/); if(symPkgs) return screenSymbolPackages(chatId,msgId,symPkgs[1])
    const symSubs=data.match(/^adm_sym_subs_(\w+)$/); if(symSubs) return screenSymbolSubs(chatId,msgId,symSubs[1])
    const symPV=data.match(/^adm_sym_pkg_view_(\w+)_(\w+)$/);   if(symPV) return screenSymbolPackageView(chatId,msgId,symPV[1],symPV[2])
    const symPT=data.match(/^adm_sym_pkg_toggle_(\w+)_(\w+)$/); if(symPT){const pkg=getSymbolPackage(symPT[1],symPT[2]);if(pkg){pkg.active=!pkg.active;saveSymbolPackage(symPT[1],pkg);}return screenSymbolPackageView(chatId,msgId,symPT[1],symPT[2])}
    const symPD=data.match(/^adm_sym_pkg_del_(\w+)_(\w+)$/);    if(symPD){deleteSymbolPackage(symPD[1],symPD[2]);return editMsg(chatId,msgId,`🗑️ Package deleted.`,[[{text:'⬅️ Back',callback_data:`adm_sym_pkgs_${symPD[1]}`}]])}
    const symPA=data.match(/^adm_sym_pkg_add_(\w+)$/);   if(symPA){setSession(chatId,'sym_pkg_add_label',{symId:symPA[1]});return editMsg(chatId,msgId,`➕ <b>New Package</b>\n\nSend the <b>package name</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_pkgs_${symPA[1]}`}]])}
    const symPL=data.match(/^adm_sym_pkg_label_(\w+)_(\w+)$/); if(symPL){setSession(chatId,'sym_pkg_label',{symId:symPL[1],pkgId:symPL[2]});return editMsg(chatId,msgId,`✏️ Send new <b>label</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_pkg_view_${symPL[1]}_${symPL[2]}`}]])}
    const symPP=data.match(/^adm_sym_pkg_price_(\w+)_(\w+)$/); if(symPP){setSession(chatId,'sym_pkg_price',{symId:symPP[1],pkgId:symPP[2]});return editMsg(chatId,msgId,`💰 Send new <b>price in USD</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_pkg_view_${symPP[1]}_${symPP[2]}`}]])}
    const symPDy=data.match(/^adm_sym_pkg_days_(\w+)_(\w+)$/); if(symPDy){setSession(chatId,'sym_pkg_days',{symId:symPDy[1],pkgId:symPDy[2]});return editMsg(chatId,msgId,`📅 Send new <b>duration in days</b>:`,[[{text:'❌ Cancel',callback_data:`adm_sym_pkg_view_${symPDy[1]}_${symPDy[2]}`}]])}

    // ── Bundle management ──
    const bunView=data.match(/^adm_bun_view_(\w+)$/);   if(bunView) return screenBundleView(chatId,msgId,bunView[1])
    if(data==='adm_bun_add'){setSession(chatId,'bun_add_label',{});return editMsg(chatId,msgId,`➕ <b>Add Bundle</b>\n\nSend the <b>bundle name</b>:`,[[{text:'❌ Cancel',callback_data:'adm_bundles'}]])}
    const bunTog=data.match(/^adm_bun_toggle_(\w+)$/);  if(bunTog){const arr=getBundles(),b=arr.find(x=>x.id===bunTog[1]);if(b)b.active=b.active===false?true:false;saveBundles(arr);return screenBundleView(chatId,msgId,bunTog[1])}
    const bunDel=data.match(/^adm_bun_delete_(\w+)$/);  if(bunDel){saveBundles(getBundles().filter(x=>x.id!==bunDel[1]));return editMsg(chatId,msgId,`🗑️ Bundle deleted.`,[[{text:'⬅️ Back',callback_data:'adm_bundles'}]])}
    const bunEL=data.match(/^adm_bun_edit_label_(\w+)$/); if(bunEL){setSession(chatId,'bun_edit_label',{bid:bunEL[1]});return editMsg(chatId,msgId,`✏️ Send new <b>bundle label</b>:`,[[{text:'❌ Cancel',callback_data:`adm_bun_view_${bunEL[1]}`}]])}
    const bunEE=data.match(/^adm_bun_edit_emoji_(\w+)$/); if(bunEE){setSession(chatId,'bun_edit_emoji',{bid:bunEE[1]});return editMsg(chatId,msgId,`😀 Send new <b>emoji</b> or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:`adm_bun_view_${bunEE[1]}`}]])}
    const bunMem=data.match(/^adm_bun_members_(\w+)$/); if(bunMem) return screenBundleMembers(chatId,msgId,bunMem[1])
    const bunMT=data.match(/^adm_bun_mem_toggle_(\w+)_(\w+)$/)
    if(bunMT){const arr=getBundles(),b=arr.find(x=>x.id===bunMT[1]);if(!b)return;b.symbols=b.symbols||[];const i=b.symbols.indexOf(bunMT[2]);if(i>=0)b.symbols.splice(i,1);else b.symbols.push(bunMT[2]);saveBundles(arr);return screenBundleMembers(chatId,msgId,bunMT[1])}
    const bunPkgs=data.match(/^adm_bun_pkgs_(\w+)$/);  if(bunPkgs) return screenBundlePackages(chatId,msgId,bunPkgs[1])
    const bunPV=data.match(/^adm_bun_pkg_view_(\w+)_(\w+)$/);   if(bunPV) return screenBundlePackageView(chatId,msgId,bunPV[1],bunPV[2])
    const bunPT=data.match(/^adm_bun_pkg_toggle_(\w+)_(\w+)$/); if(bunPT){const pkg=getBundlePackage(bunPT[1],bunPT[2]);if(pkg){pkg.active=!pkg.active;saveBundlePackage(bunPT[1],pkg);}return screenBundlePackageView(chatId,msgId,bunPT[1],bunPT[2])}
    const bunPD=data.match(/^adm_bun_pkg_del_(\w+)_(\w+)$/);    if(bunPD){deleteBundlePackage(bunPD[1],bunPD[2]);return editMsg(chatId,msgId,`🗑️ Package deleted.`,[[{text:'⬅️ Back',callback_data:`adm_bun_pkgs_${bunPD[1]}`}]])}
    const bunPA=data.match(/^adm_bun_pkg_add_(\w+)$/);  if(bunPA){setSession(chatId,'bun_pkg_add_label',{bid:bunPA[1]});return editMsg(chatId,msgId,`➕ <b>New Bundle Package</b>\n\nSend the <b>package name</b>:`,[[{text:'❌ Cancel',callback_data:`adm_bun_pkgs_${bunPA[1]}`}]])}
    const bunPL=data.match(/^adm_bun_pkg_label_(\w+)_(\w+)$/); if(bunPL){setSession(chatId,'bun_pkg_label',{bid:bunPL[1],pkgId:bunPL[2]});return editMsg(chatId,msgId,`✏️ Send new <b>label</b>:`,[[{text:'❌ Cancel',callback_data:`adm_bun_pkg_view_${bunPL[1]}_${bunPL[2]}`}]])}
    const bunPP=data.match(/^adm_bun_pkg_price_(\w+)_(\w+)$/); if(bunPP){setSession(chatId,'bun_pkg_price',{bid:bunPP[1],pkgId:bunPP[2]});return editMsg(chatId,msgId,`💰 Send new <b>price in USD</b>:`,[[{text:'❌ Cancel',callback_data:`adm_bun_pkg_view_${bunPP[1]}_${bunPP[2]}`}]])}
    const bunPDy=data.match(/^adm_bun_pkg_days_(\w+)_(\w+)$/); if(bunPDy){setSession(chatId,'bun_pkg_days',{bid:bunPDy[1],pkgId:bunPDy[2]});return editMsg(chatId,msgId,`📅 Send new <b>duration in days</b>:`,[[{text:'❌ Cancel',callback_data:`adm_bun_pkg_view_${bunPDy[1]}_${bunPDy[2]}`}]])}

    // ── Approve / deny ──
    const admAp=data.match(/^adm_approve_(\d+)_(\w+)$/);   if(admAp){await adminApprove(chatId,admAp[1],admAp[2]);return screenAdminPending(chatId,msgId)}
    const admDn=data.match(/^adm_deny_(\d+)_(\w+)$/);      if(admDn){await adminDeny(chatId,admDn[1],admDn[2]);return screenAdminPending(chatId,msgId)}
    const admApB=data.match(/^adm_approveb_(\d+)_(\w+)$/); if(admApB){await adminApproveBundle(chatId,admApB[1],admApB[2]);return screenAdminPending(chatId,msgId)}
    const admDnB=data.match(/^adm_denyb_(\d+)_(\w+)$/);    if(admDnB){await adminDenyBundle(chatId,admDnB[1],admDnB[2]);return screenAdminPending(chatId,msgId)}

    // ── API keys ──
    const keyView=data.match(/^adm_key_view_(\d+)$/); if(keyView) return screenApiKeyView(chatId,msgId,parseInt(keyView[1]))
    const keyTog=data.match(/^adm_key_toggle_(\d+)$/); if(keyTog){const keys=getSetting('twelvedata_keys')||[],i=parseInt(keyTog[1]);if(keys[i])keys[i].active=!keys[i].active;setSetting('twelvedata_keys',keys);return screenApiKeyView(chatId,msgId,i)}
    const keyDel=data.match(/^adm_key_delete_(\d+)$/); if(keyDel){const keys=getSetting('twelvedata_keys')||[],i=parseInt(keyDel[1]),lbl=keys[i]?.label;keys.splice(i,1);setSetting('twelvedata_keys',keys);return editMsg(chatId,msgId,`🗑️ Key "<b>${lbl}</b>" deleted.`,[[{text:'⬅️ Back',callback_data:'adm_keys'}]])}
    const keyTest=data.match(/^adm_key_test_(\d+)$/); if(keyTest){const keys=getSetting('twelvedata_keys')||[],i=parseInt(keyTest[1]),k=keys[i];if(!k)return;await editMsg(chatId,msgId,`🧪 Testing <b>${k.label}</b>…`);const r=await testApiKey(k.key);return editMsg(chatId,msgId,r.ok?`✅ <b>Works!</b>\nXAU/USD: <b>$${r.price}</b>`:`❌ <b>Failed:</b>\n${r.reason}`,[[{text:'⬅️ Back',callback_data:`adm_key_view_${i}`}]])}
    if(data==='adm_key_add'){setSession(chatId,'add_key_label',{});return editMsg(chatId,msgId,`➕ Send a <b>label</b> for this key:`,[[{text:'❌ Cancel',callback_data:'adm_keys'}]])}
    const eKL=data.match(/^adm_key_edit_label_(\d+)$/); if(eKL){setSession(chatId,'edit_key_label',{idx:parseInt(eKL[1])});return editMsg(chatId,msgId,`✏️ Send new label:`,[[{text:'❌ Cancel',callback_data:`adm_key_view_${eKL[1]}`}]])}
    const eKV=data.match(/^adm_key_edit_key_(\d+)$/); if(eKV){setSession(chatId,'edit_key_value',{idx:parseInt(eKV[1])});return editMsg(chatId,msgId,`🔑 Send the new API key string:`,[[{text:'❌ Cancel',callback_data:`adm_key_view_${eKV[1]}`}]])}

    // ── Payments ──
    const payView=data.match(/^adm_pay_view_(\w+)$/); if(payView) return screenPaymentView(chatId,msgId,payView[1])
    const payTog=data.match(/^adm_pay_toggle_(\w+)$/); if(payTog){const m=getAllPayMethods(),x=m.find(p=>p.id===payTog[1]);if(x)x.active=x.active===false?true:false;savePayMethods(m);return screenPaymentView(chatId,msgId,payTog[1])}
    const payDel=data.match(/^adm_pay_delete_(\w+)$/); if(payDel){savePayMethods(getAllPayMethods().filter(x=>x.id!==payDel[1]));return editMsg(chatId,msgId,`🗑️ Deleted.`,[[{text:'⬅️ Back',callback_data:'adm_payments'}]])}
    if(data==='adm_pay_add'){setSession(chatId,'pay_add_label',{});return editMsg(chatId,msgId,`➕ <b>Add Payment Method</b>\n\nSend a <b>display label</b>:`,[[{text:'❌ Cancel',callback_data:'adm_payments'}]])}
    const pEL=data.match(/^adm_pay_edit_label_(\w+)$/);   if(pEL){setSession(chatId,'pay_edit_label',{payId:pEL[1]});return editMsg(chatId,msgId,`✏️ Send new label:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${pEL[1]}`}]])}
    const pEC=data.match(/^adm_pay_edit_coin_(\w+)$/);    if(pEC){setSession(chatId,'pay_edit_coin',{payId:pEC[1]});return editMsg(chatId,msgId,`🪙 Send new coin symbol:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${pEC[1]}`}]])}
    const pEN=data.match(/^adm_pay_edit_network_(\w+)$/); if(pEN){setSession(chatId,'pay_edit_network',{payId:pEN[1]});return editMsg(chatId,msgId,`🌐 Send new network or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${pEN[1]}`}]])}
    const pEA=data.match(/^adm_pay_edit_address_(\w+)$/); if(pEA){setSession(chatId,'pay_edit_address',{payId:pEA[1]});return editMsg(chatId,msgId,`📋 Send new wallet address:`,[[{text:'❌ Cancel',callback_data:`adm_pay_view_${pEA[1]}`}]])}

    // ── Bot settings ──
    if(data==='adm_cfg_channel')      {setSession(chatId,'cfg_channel',{});      return editMsg(chatId,msgId,`📡 Send new <b>channel username</b>:`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_account_size') {setSession(chatId,'cfg_account_size',{}); return editMsg(chatId,msgId,`💰 Send <b>account size in USD</b>:`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_risk_pct')     {setSession(chatId,'cfg_risk_pct',{});     return editMsg(chatId,msgId,`⚖️ Send <b>risk % per trade</b>:`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_price_check')  {setSession(chatId,'cfg_price_check',{});  return editMsg(chatId,msgId,`⏱️ Send <b>price check interval in seconds</b> (min 5):`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_oanda_token')  {setSession(chatId,'cfg_oanda_token',{});  return editMsg(chatId,msgId,`🔐 Send <b>OANDA API token</b> or <code>none</code>:`,[[{text:'❌ Cancel',callback_data:'adm_botsettings'}]])}
    if(data==='adm_cfg_datasource')   {setSetting('data_source',getSetting('data_source')==='twelvedata'?'oanda':'twelvedata');return screenBotSettings(chatId,msgId)}
    if(data==='adm_cfg_oanda_env')    {setSetting('oanda_env',getSetting('oanda_env')==='practice'?'live':'practice');return screenBotSettings(chatId,msgId)}
    if(data==='adm_cfg_toggle_mode') {
      const cur = getSetting('bot_mode') || 'live'
      const next = cur === 'coming_soon' ? 'live' : 'coming_soon'
      setSetting('bot_mode', next)
      const label = next === 'coming_soon' ? '🚧 Coming Soon' : '✅ Live'
      await answerCb(cb.id, `Bot mode → ${label}`)
      return screenBotSettings(chatId, msgId)
    }
    if(data==='adm_cfg_coming_soon_text') {
      const cur = getSetting('coming_soon_text') || ''
      setSession(chatId,'cfg_coming_soon_text',{})
      return editMsg(chatId, msgId,
        `✏️ <b>Edit Coming Soon message</b>\n\nCurrent message:\n\n${cur}\n\nSend the new message text (HTML formatting supported — <b>bold</b>, <i>italic</i>, <code>code</code>):`,
        [[{text:'❌ Cancel', callback_data:'adm_botsettings'}]])
    }

    // ── Broadcast ──
    const bSym=data.match(/^adm_broadcast_sym_(\w+)$/)
    if(bSym) { setSession(chatId,'broadcast_msg',{symId:bSym[1],target:'sym'}); return editMsg(chatId,msgId,`📢 <b>Broadcast to ${getSymbol(bSym[1])?.label} subscribers</b>\n\nType your message:`,[[{text:'❌ Cancel',callback_data:'adm_broadcast_pick'}]]) }
    if(data==='adm_broadcast_all')      { setSession(chatId,'broadcast_msg',{symId:null,target:'all'});      return editMsg(chatId,msgId,`📢 <b>Broadcast to all active subscribers</b>\n\nType your message:`,[[{text:'❌ Cancel',callback_data:'adm_broadcast_pick'}]]) }
    if(data==='adm_broadcast_nonsub')   { setSession(chatId,'broadcast_msg',{symId:null,target:'nonsub'});   return editMsg(chatId,msgId,`📣 <b>Broadcast to non-subscribers / leads</b>\n\nThese are people who pressed /start but never paid (or whose subscription expired).\n\nType your message:`,[[{text:'❌ Cancel',callback_data:'adm_broadcast_pick'}]]) }
    if(data==='adm_broadcast_everyone') { setSession(chatId,'broadcast_msg',{symId:null,target:'everyone'}); return editMsg(chatId,msgId,`🌐 <b>Broadcast to everyone</b>\n\nThis will message ALL visitors + subscribers.\n\nType your message:`,[[{text:'❌ Cancel',callback_data:'adm_broadcast_pick'}]]) }

    // ── Visitors ──
    const visitorsM = data.match(/^adm_visitors(?:_(\d+))?$/)
    if(visitorsM || data==='adm_visitors') return screenVisitors(chatId, msgId, visitorsM?.[1] ? parseInt(visitorsM[1]) : 0)
  }
}

// ── LONG POLLING ──────────────────────────────────────────────────────────
async function startPolling() {
  const s=loadSettings()
  console.log('🤖 Gold AI Subscription Bot v6.1 — ATR Calibration + Per-Symbol Spread + /keepholding + /statistics')
  console.log(`   Channel: ${s.channel} | Admin: ${ADMIN_ID}`)
  console.log(`   Symbols: ${getActiveSymbols().map(x=>`${x.emoji||''}${x.label}`).join(', ')}`)
  console.log(`   Bundles: ${getActiveBundles().map(x=>x.label).join(', ')||'none'}`)
  console.log(`   API Keys: ${(s.twelvedata_keys||[]).filter(k=>k.active).length} active`)
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
      const exp=new Date(sub.expiresAt),days=Math.ceil((exp-now)/86400000)
      const name=productLabel(sub.symbolId)
      if(days===3&&!sub.warned3d){
        upsertSub(sub.chatId,sub.symbolId,{warned3d:true})
        await send(sub.chatId,`⚠️ <b>Subscription Expiring Soon</b>\n\n${name} expires in <b>3 days</b>.\n\nRenew: /start`).catch(()=>{})
      }
      if(exp<=now){
        upsertSub(sub.chatId,sub.symbolId,{status:'expired'})
        markVisitorExpired(sub.chatId)
        await send(sub.chatId,`❌ <b>Subscription Expired</b>\n\n${name} access has ended.\n\n/start — renew`).catch(()=>{})
      }
    }
  },60*60*1000)
}

const sleep=ms=>new Promise(r=>setTimeout(r,ms))
runExpiryChecker()
startPolling()
