// ─────────────────────────────────────────────────────────────────────────────
//  launcher.mjs  —  v10.12 (Multi-Symbol + Multi-Timeframe + LEARNING LOG +
//  PER-SYMBOL SPREAD + CUSTOM TIMEFRAME DEPENDENCY GRAPH + CONFIRMED-
//  REVERSAL CASCADE CLOSE + PER-TF SEND TOGGLE + POST-TP3 COOLDOWN +
//  CROSS-TIMEFRAME DUPLICATE SUPPRESSION + SINGLE TRADE PER SYMBOL)
//
//  New in v10.12:
//   • SINGLE ACTIVE TRADE PER SYMBOL (default ON) — the main lock most
//     setups want: while ANY timeframe of a symbol holds an open trade, NO
//     other timeframe of that symbol may send a fresh signal, regardless of
//     direction, score, or timeframe hierarchy. E.g. if 1m holds a SELL,
//     5m and 1h are both blocked from sending ANYTHING (BUY or SELL) on
//     that symbol until the 1m trade closes (TP3/SL/BE) or gets confirmed-
//     reversal-closed. This is stricter than, and checked BEFORE, both the
//     dependency gate and the cross-timeframe duplicate suppression below —
//     with it ON (the default), those two rarely get a chance to fire at
//     all. Set SINGLE_TRADE_PER_SYMBOL=0 to fall back to the old behaviour
//     (multiple timeframes of one symbol can each hold their own trade,
//     governed by the dependency graph + duplicate suppression instead).
//
//   • CROSS-TIMEFRAME DUPLICATE SUPPRESSION — if a fresh signal fires on one
//     timeframe (e.g. 5m) while ANOTHER timeframe of the SAME symbol (e.g.
//     1m) already holds an open trade in the SAME direction opened within
//     the last DUPLICATE_WINDOW_MIN minutes (default 60), it's treated as
//     the same underlying move, not two independent trades. Only the BETTER
//     signal (higher score) is sent and tracked — the weaker one is dropped
//     silently: no message, no state entry, no daily/learning row. If the
//     NEW signal is the better one, the older, weaker duplicate is closed
//     out of state quietly (no "reversal"/"closed" message — it was never
//     meant to be two separate trades) and the new one sends normally.
//   • SILENT TP3 COOLDOWN — the post-TP3 cooldown still arms exactly as
//     before (POST_TP3_COOLDOWN_CANDLES real candle closes before a new
//     signal on that symbol|tf can send), but the TP3 alert message no
//     longer mentions the cooldown to subscribers — it's purely an internal
//     suppression, not a user-facing detail.
//
//  v10.10:
//   • CUSTOM TIMEFRAME DEPENDENCY GRAPH — replaces the old fixed "any
//     strictly-higher timeframe blocks any lower one" rule with an explicit,
//     admin-chosen list PER timeframe (admin → Symbols → 🔗 Dependencies):
//     "this timeframe depends on [these other timeframes]". Not restricted
//     to "higher" timeframes — e.g. 1m can depend on 5m + 15m + 1h, while 5m
//     on the SAME symbol depends on only 15m, or nothing at all — any
//     combination, per symbol. If ANY configured dependency holds an open
//     trade in the OPPOSITE direction, the timeframe is blocked from sending
//     until that dependency closes or gets confirmed-reversal-closed. The
//     confirmed-reversal cascade close (v10.8) now cascades to whichever
//     timeframes actually DEPEND on the one that reversed, instead of a
//     fixed "every faster timeframe" rule. Un-customised timeframes keep the
//     legacy default (depend on every higher timeframe) so nothing changes
//     until a symbol's dependencies are explicitly edited.
//
//  v10.9:
//   • PER-TIMEFRAME SEND TOGGLE — admin → Symbols → 📤 Signal Sending lets
//     you pick, among a symbol's analysed timeframes, which ones actually
//     broadcast to Telegram and get tracked for TP/SL. Timeframes left off
//     the send list are STILL fully analysed every cycle (so the HTF gate /
//     reversal-cascade logic elsewhere still sees whatever they compute) but
//     never message anyone and never get an open-trade state entry. Useful
//     to stop e.g. 5m + 15m + 1h all firing near-duplicate alerts for the
//     same underlying move.
//   • POST-TP3 COOLDOWN — after a symbol|tf trade hits TP3 (full target), a
//     new signal on that SAME symbol|tf is suppressed for
//     POST_TP3_COOLDOWN_CANDLES real candle closes (default 2), then resumes
//     normally. Stops immediately chasing the same instrument/timeframe
//     right after a win, when the move may already be exhausted.
//
//  v10.8:
//   • CONFIRMED-REVERSAL CASCADE CLOSE — a held trade is no longer just
//     suppressed-and-waited-out when the opposite direction shows up. If a
//     timeframe's own engine analysis independently produces a fresh,
//     fully-gated opposite-direction signal (same rigor as any new entry —
//     score/conviction floor, MTF alignment, candle confirmation, spread
//     feasibility) while it holds a trade, that's treated as a REAL
//     confirmed reversal, not noise. The held trade is closed immediately
//     at the current live price (real pips logged, win or small loss), and
//     any FASTER timeframe still holding the same OLD direction is cascaded
//     closed at that same live price too (price is shared across timeframes
//     of one symbol at any instant). The freed timeframe(s) can then fire
//     the new opposite-direction signal right away instead of waiting for
//     TP3/SL/BE. Toggle: REVERSAL_CASCADE=0 to disable (falls back to old
//     suppress-only behaviour). REVERSAL_MIN_SCORE (default 55) sets how
//     strong the opposite signal must be to count as confirmation.
//
//  v10.7:
//   • STRICT HTF DIRECTION GATE — the old "counter-trend scalp" exception
//     for 5m is removed. Now ANY timeframe opposing an open trade on ANY
//     higher timeframe (same symbol) is hard-blocked, no exceptions. If 1h
//     holds BUY, neither 15m nor 5m can send SELL — only BUY or WAIT — until
//     that 1h trade fully closes (TP3/SL/BE) or gets confirmed-reversal-
//     closed by v10.8's cascade above. (Superseded by v10.10: this "any
//     higher TF" rule is now just the DEFAULT for un-customised timeframes,
//     not a fixed rule — admin can override it per timeframe.)
//
//  v10.6:
//   • 💱 PER-SYMBOL SPREAD INJECTION — injects env.SPREAD from
//     symObj.spread (set via admin → Symbols → 💱 Edit Spread) the same
//     way ATR_LOW/ATR_HIGH are already injected. Fixes forex pairs
//     getting "TP1 too small vs spread" WAITs from gold's 0.30 default
//     spread (≈30 pips on a 4-decimal pair — 10x too wide for most FX).
//     Unset symbols keep the engine's own 0.30 default (gold unaffected).
//
//  v10.5:
//   • SAME-TF REVERSAL LOCK (superseded by v10.8's cascade close above, but
//     still the fallback when the opposite signal's score is too weak) —
//     while a timeframe holds an OPEN trade, an opposite-direction signal on
//     that SAME timeframe is suppressed until the open trade fully closes.
//   • CALIBRATED ATR BANDS — if the symbol has per-timeframe atr_bands in
//     settings.json (set via admin "🎯 Recalibrate ATR" or auto on symbol
//     add), the launcher injects ATR_LOW/ATR_HIGH into the engine env so
//     forex pairs stop being falsely blocked as "low liquidity" by gold's
//     default bands.
//   • KEEP-HOLDING OPT-OUT — "KEEP HOLDING" updates are now only sent to
//     users who have them enabled (/keepholding toggle in the bot, default
//     ON). TP/SL/BE alerts and new signals are always sent to everyone.
//
//  v10.4: logOutcome() learning log for signal-brain.mjs.
//  v10.2/10.3: signalId stamping, 15-bar TP/SL watcher, threading, HTF gate.
//
//  State keys are  symbol|tf  so Gold 15m and EURUSD 15m never collide.
// ─────────────────────────────────────────────────────────────────────────────
import {
  broadcastSignal,
  broadcastReply,
  keepHoldingEnabled,
  getActiveApiKeys,
  getDataSource,
  getAccountSize,
  getRiskPct,
  getOandaToken,
  getOandaEnv,
  getSymbolsForLauncher,
} from './bot-subscription.mjs'
import fs from 'fs'
import path from 'path'

// ── BOOTSTRAP ─────────────────────────────────────────────────────────────
const TG_TOKEN    = process.env.TG_TOKEN || '8970765755:AAHexBHcEKLnnBsly5AIOUAPgftnEl6_9Hg'
const TG_CHAT     = process.env.TG_CHAT  || '1408577116'
const STATE_FILE  = './bot_state.json'
const DAILY_FILE  = './daily_report.json'

// Engine runs here so its ./bot_state.json + ./trade_log.json are ISOLATED
// from the launcher's authoritative bot_state.json (no corruption / collision).
const ENGINE_DIR       = './engine'
try { fs.mkdirSync(ENGINE_DIR, { recursive: true }) } catch {}
const ENGINE_TRADE_LOG = path.join(ENGINE_DIR, 'trade_log.json')
const ENGINE_SCRIPT    = path.resolve('gold-ai.mjs')

const CANDLE_DELAY_MS     = 2000
const KEY_SWITCH_DELAY_MS = 1000    // fast key-to-key rotation on 429 — try the NEXT key almost immediately
const RETRY_DELAY_MS      = 60000   // long fallback wait — only used once EVERY active key has been tried and is still capped
const WATCH_PERIOD_MS = 60 * 1000  // 1-minute TP/SL sweep
const WATCH_BAR_MS    = 60 * 1000  // 1-minute candle for TP/SL detection

// Stagger per TF so candle-close checks don't all fire at once
const TF_STAGGER_MS = { '15m':0, '1h':4*60000, '4h':45000, '1d':60000 }
const TF_MINUTES    = { '1m':1,'3m':3,'5m':5,'15m':15,'30m':30,'1h':60,'2h':120,'4h':240,'1d':1440 }

// ── DYNAMIC CONFIG ─────────────────────────────────────────────────────────
function getLiveApiKeys() { return getActiveApiKeys() }
function getLiveSymbols() { return getSymbolsForLauncher() }
function getLiveSource()  { return getDataSource() }

let activeKeyIndex = 0
function currentKey() { const k=getLiveApiKeys(); return k.length ? k[activeKeyIndex%k.length] : '' }
function switchToNextKey() {
  const k=getLiveApiKeys(); if(k.length<=1){console.error('[API] No fallback keys!');return false}
  activeKeyIndex=(activeKeyIndex+1)%k.length
  console.log(`[API] ⚠️ Switched to key slot #${activeKeyIndex+1}: ${currentKey().slice(0,8)}…`)
  return true
}

// ── HELPERS ───────────────────────────────────────────────────────────────
const dirIcon = dir => dir==='BUY'?'🟢':'🔴'
const toPips = (d, decimals) => decimals >= 4 ? Math.round(Math.abs(d)*10000) : Math.round(Math.abs(d)*10)
function openTrade(state, sym, tf) { const s=state[`${sym}|${tf}`]; return (s&&typeof s==='object'&&s.direction)?s:null }
const sleep = ms => new Promise(r=>setTimeout(r,ms))

// Stable id shared by every outcome row (TP1/TP2/TP3/SL/BE) of one signal.
// Used by the bot's monthly stats to collapse rows into a single trade.
function makeSignalId(symId, tf, sig) {
  return `${symId}|${tf}|${sig.direction}|${sig.ts||sig.signalMsgId||sig.entry}`
}

// ── CUSTOM TIMEFRAME DEPENDENCY GRAPH (v10.10) ──────────────────────────────
// Replaces the old fixed "any strictly-higher timeframe blocks any lower
// one" rule with an explicit, admin-chosen list PER timeframe (set via
// admin → Symbols → 🔗 Dependencies): "this timeframe depends on [these
// other timeframes]". Dependencies aren't restricted to "higher" timeframes
// — 1m could depend on 5m + 15m + 1h, while 5m on the SAME symbol depends on
// only 15m, or nothing at all. Any combination is allowed.
// Un-customised timeframes (symObj.depends has no array for that tf) fall
// back to the legacy default — every OTHER analysed timeframe with a
// strictly higher duration — so nothing changes until admin explicitly
// configures a given timeframe.
function defaultDependsOn(symObj, tf) {
  const myMin = TF_MINUTES[tf] || 0
  return (symObj.timeframes || []).filter(t => (TF_MINUTES[t] || 0) > myMin)
}
function getDependsOn(symObj, tf) {
  const cfg = symObj.depends || {}
  return Array.isArray(cfg[tf]) ? cfg[tf] : defaultDependsOn(symObj, tf)
}
// Returns the direction of the first dependency currently holding an open
// trade, or null. Generalizes the old higherTfDirection() to an arbitrary
// admin-configured list instead of an automatic "higher timeframe" rule.
function dependencyDirection(state, symId, dependsOn) {
  for (const other of dependsOn) {
    const t = openTrade(state, symId, other)
    if (t && t.direction) return { dir: t.direction, tf: other }
  }
  return null
}
// Reverse lookup — which OTHER timeframes of this symbol list `reversedTf`
// among their own dependencies? Used by the confirmed-reversal cascade close
// to know which held trades to close when `reversedTf` reverses (replaces
// the old "cascade to every faster timeframe" rule with "cascade to every
// timeframe that actually depends on this one").
function getDependents(symObj, reversedTf) {
  return (symObj.timeframes || []).filter(t => t !== reversedTf && getDependsOn(symObj, t).includes(reversedTf))
}

// ── PER-TIMEFRAME SEND TOGGLE (v10.9) ───────────────────────────────────────
// symObj.send_timeframes (null = send everything, back-compat default) is a
// subset of symObj.timeframes. Timeframes NOT in it are still analysed every
// cycle by runSignalCycle (so the HTF gate / reversal-cascade logic elsewhere
// keeps working normally for whatever THOSE timeframes compute), but never
// broadcast to Telegram and never get an open-trade state entry — i.e. never
// tracked for TP/SL. This is a pure "should I tell anyone" cut applied AFTER
// analysis, not a "stop analysing" toggle.
function isSendEnabled(symObj, tf) {
  if (!Array.isArray(symObj.send_timeframes)) return true   // not configured → send everything
  return symObj.send_timeframes.includes(tf)
}

// ── CROSS-TIMEFRAME DUPLICATE SUPPRESSION (v10.11) ──────────────────────────
// If a fresh signal fires on timeframe A while ANOTHER timeframe B of the
// SAME symbol already holds an open trade in the SAME direction, opened
// within the last DUPLICATE_WINDOW_MIN minutes, treat it as one underlying
// move rather than two independent trades. Only the BETTER signal (higher
// score) is sent/tracked:
//   • If the NEW signal (tf A) scores higher than the held one (tf B), the
//     held one is dropped from state silently (no message — it was never
//     really a separate trade) and the new one goes on to send normally.
//   • If the NEW signal scores lower or equal, IT is dropped instead — never
//     sent, never tracked, never logged. The caller should `return` in that
//     case without doing anything else.
// This runs only on the "brand-new signal" path — never on KEEP HOLDING or
// the confirmed-reversal path, which already have their own state handling.
const DUPLICATE_WINDOW_MIN = parseInt(process.env.DUPLICATE_WINDOW_MIN || '60')
function findDuplicateAcrossTimeframes(symObj, tf, direction) {
  const state = loadState(), now = Date.now()
  for (const otherTf of symObj.timeframes) {
    if (otherTf === tf) continue
    const t = openTrade(state, symObj.id, otherTf)
    if (t && t.direction === direction) {
      const openedAt = t.ts ? new Date(t.ts).getTime() : 0
      if (now - openedAt <= DUPLICATE_WINDOW_MIN * 60000) return { tf: otherTf, trade: t }
    }
  }
  return null
}

// ── SINGLE ACTIVE TRADE PER SYMBOL (v10.12, default ON) ─────────────────────
// Stricter than the duplicate suppression above: while ANY timeframe of a
// symbol holds an open trade, NO other timeframe of that same symbol may
// send a fresh signal — regardless of direction, regardless of score, and
// regardless of whether the other timeframe is "higher" or "lower". Only
// one active trade per symbol, ever, across every timeframe. The blocked
// signal isn't sent, tracked, or logged — it's simply skipped, exactly like
// every other suppression in this file.
// Set SINGLE_TRADE_PER_SYMBOL=0 to go back to allowing multiple concurrent
// timeframes on the same symbol to each hold their own trade (in which case
// the dependency gate + duplicate suppression above still apply as before).
const SINGLE_TRADE_PER_SYMBOL = process.env.SINGLE_TRADE_PER_SYMBOL !== '0'
function anyOtherTfHoldingTrade(symObj, tf) {
  const state = loadState()
  for (const otherTf of symObj.timeframes) {
    if (otherTf === tf) continue
    const t = openTrade(state, symObj.id, otherTf)
    if (t) return { tf: otherTf, trade: t }
  }
  return null
}

// ── POST-TP3 COOLDOWN (v10.9) ───────────────────────────────────────────────
// After a symbol|tf trade hits TP3 (full target), suppress sending a brand
// new signal on that SAME symbol|tf for POST_TP3_COOLDOWN_CANDLES real
// candle closes, then resume normally. Prevents immediately re-entering the
// same instrument/timeframe right after a win chases a move that may already
// be exhausted. Stored as its OWN state key (`${symId}|${tf}|cooldown`) so it
// never collides with openTrade()'s trade-state lookups (which only ever
// read the bare `${symId}|${tf}` key) and survives independently of whether
// a new trade opens/closes in between.
const POST_TP3_COOLDOWN_CANDLES = parseInt(process.env.POST_TP3_COOLDOWN_CANDLES || '2')
const cooldownKey = (symId, tf) => `${symId}|${tf}|cooldown`

function getCooldownCandles(symId, tf) {
  const c = loadState()[cooldownKey(symId, tf)]
  return (c && typeof c === 'object' && typeof c.candlesLeft === 'number') ? c.candlesLeft : 0
}

// Directly mutates an ALREADY-LOADED state object (no separate load/save) —
// used from inside evalTradeAgainstBar, which builds up its own in-memory
// `state` across a batch of bars before the caller persists it once. Calling
// loadState()/saveState() independently here would race with and clobber
// those pending in-memory trade-state edits.
function armCooldown(state, symId, tf, n) {
  const key = cooldownKey(symId, tf)
  if (n > 0) state[key] = { candlesLeft: n }
  else delete state[key]
}

// Called once per real candle-close cycle for a symbol|tf (from
// runSignalCycle). Returns the cooldown count AS IT WAS BEFORE this tick —
// >0 means this cycle falls inside the cooldown window and sending should be
// suppressed; 0 means not cooling down, safe to send. Ticks the counter down
// by 1 as a side effect (own load/save — runSignalCycle isn't sharing an
// in-memory state object across calls the way the watcher does).
function tickCooldown(symId, tf) {
  const before = getCooldownCandles(symId, tf)
  if (before <= 0) return 0
  const state = loadState()
  armCooldown(state, symId, tf, before - 1)
  saveState(state)
  return before
}

// ── STATE (atomic writes) ──────────────────────────────────────────────────
function loadState()  { try{return JSON.parse(fs.readFileSync(STATE_FILE,'utf8'))}catch{return{}} }
function saveState(s) {
  s.at = new Date().toISOString()
  const tmp = STATE_FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2))
  fs.renameSync(tmp, STATE_FILE)
}

// ── DAILY REPORT ──────────────────────────────────────────────────────────
function todayKey()  { return new Date().toISOString().slice(0,10) }
function loadDaily() { try{return JSON.parse(fs.readFileSync(DAILY_FILE,'utf8'))}catch{return{}} }
function saveDaily(d){ const tmp=DAILY_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(d,null,2)); fs.renameSync(tmp,DAILY_FILE) }
// Each row carries a signalId so the bot can collapse all TP/SL rows of ONE
// signal into a single outcome. totalPips here stays a raw running log — the
// bot recomputes the correct net from collapsed rows, so it no longer matters.
function addToDaily(trade) {
  const key=todayKey(), daily=loadDaily()
  if(!daily[key]) daily[key]={trades:[],totalPips:0}
  daily[key].trades.push({...trade, ts:new Date().toISOString()})
  daily[key].totalPips += trade.sign*trade.pips
  saveDaily(daily)
}

// ── LEARNING LOG (feeds signal-brain.mjs, if/when re-enabled) ──────────────
// One row per CLOSED trade — the FINAL outcome only (furthest level reached).
// Kept as-is: harmless to write even with no brain gate consuming it, and
// preserves history in case the brain gate is re-enabled later.
const LEARN_FILE = './learning_log.json'
function logOutcome(symObj, tf, sig, result, pips, sign) {
  let a=[]; try{a=JSON.parse(fs.readFileSync(LEARN_FILE,'utf8'))}catch{}
  a.push({ ts:new Date().toISOString(), signalId:makeSignalId(symObj.id,tf,sig),
    sym:symObj.label, symId:symObj.id, tf, dir:sig.direction, result, pips, sign,
    score:sig.score??null, tier:sig.tier??null, regime:sig.regime??null, session:sig.session??null })
  const tmp=LEARN_FILE+'.tmp'; fs.writeFileSync(tmp,JSON.stringify(a,null,2)); fs.renameSync(tmp,LEARN_FILE)
}

// ── SEND A NEW SIGNAL ──────────────────────────────────────────────────────
// Admin (direct) + all subscribers. Captures EVERY message id so TP/SL alerts
// can thread under the original signal in each chat.
// Returns { adminMsgId, subMsgIds:{chatId:message_id} }.
async function sendNewSignal(text, symbolId) {
  let adminMsgId=null
  try {
    const res=await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:'HTML'})})
    const j=await res.json(); if(j.ok) adminMsgId=j.result.message_id
  }catch(e){console.error('[sendNewSignal admin]',e.message)}
  const result=await broadcastSignal(text, symbolId)
  console.log(`[newSignal][${symbolId}] adminMsgId=${adminMsgId} subs sent=${result.sent} failed=${result.failed}`)
  return { adminMsgId, subMsgIds: result.msgIds || {} }
}

// ── SEND A THREADED REPLY ──────────────────────────────────────────────────
// TP/SL/KEEP-HOLDING alert that replies UNDER the original signal in every chat:
// admin replies to adminReplyId, each subscriber replies to their stored id.
// (allow_sending_without_reply means it still delivers if the original is gone.)
// opts.keepHolding=true → only delivered to users with /keepholding enabled
// (TP/SL/BE alerts never set this flag and always go to everyone).
async function sendReply(text, symbolId, adminReplyId=null, subMsgIds={}, opts={}) {
  const isKeep = !!opts.keepHolding
  if (!isKeep || keepHoldingEnabled(TG_CHAT)) {
    try {
      const body={chat_id:TG_CHAT,text,parse_mode:'HTML'}
      if(adminReplyId){ body.reply_to_message_id=adminReplyId; body.allow_sending_without_reply=true }
      await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    }catch(e){console.error('[sendReply admin]',e.message)}
  }
  const result=await broadcastReply(text, symbolId, subMsgIds, { keepHolding: isKeep })
  console.log(`[reply][${symbolId}]${isKeep?' (keep-holding)':''} subs sent=${result.sent} failed=${result.failed} skipped=${result.skipped||0}`)
}

// ── RECENT CLOSED 1-MIN BARS (catch-up; reports 429 exhaustion) ─────────────
// Checks every minute — returns { bars:[{ts,high,low,close}], rateLimited }
// with ONLY closed bars, sorted oldest→newest. The forming bar is excluded.
async function fetchRecentBars(symObj) {
  const interval='1min'
  const nowBoundary=Math.floor(Date.now()/WATCH_BAR_MS)*WATCH_BAR_MS   // start of the FORMING bar
  const keys=getLiveApiKeys(); let saw429=false
  for(let attempt=0; attempt<Math.max(keys.length,1); attempt++){
    const key=currentKey(); if(!key) break
    try{
      const res=await fetch(`https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symObj.td_symbol)}&interval=${interval}&outputsize=15&timezone=UTC&apikey=${key}`,{signal:AbortSignal.timeout(8000)})
      if(res.status===429){ saw429=true; switchToNextKey(); continue }
      const j=await res.json()
      if(j.code===429 || /run out|api credits|minute|limit/i.test(j.message||'')){ saw429=true; switchToNextKey(); continue }
      if(j.status==='error' || !j.values?.length) return { bars:[] }
      const bars=j.values
        .map(v=>({ts:new Date(v.datetime.replace(' ','T')+'Z').getTime(),high:parseFloat(v.high),low:parseFloat(v.low),close:parseFloat(v.close)}))
        .filter(b=>Number.isFinite(b.ts)&&b.ts<nowBoundary)   // CLOSED bars only
        .sort((a,b)=>a.ts-b.ts)                                // oldest → newest
      return { bars }
    }catch{ /* network error — try next key */ }
  }
  return { rateLimited:saw429, bars:[] }
}

// ── CONFIRMED-REVERSAL CASCADE CLOSE (v10.8) ───────────────────────────────
// A "reversal" is ONLY recognized when a timeframe's own engine analysis
// independently produces a fresh, fully-gated signal in the OPPOSITE
// direction to a trade it's currently holding — i.e. it passed every filter
// a brand-new entry needs (score/conviction floor, MTF alignment, candle
// confirmation, spread feasibility, etc). This is deliberately NOT a
// separate lightweight "did the trend flip" check — reusing the exact same
// rigorous gate as normal entries is what makes it a REAL confirmed reversal
// rather than a noisy per-candle guess.
//
// REVERSAL_CASCADE=0     → disable this feature entirely (old suppress-only
//                          behaviour: reversal signals just get blocked until
//                          the held trade naturally hits TP3/SL/BE)
// REVERSAL_MIN_SCORE     → the fresh opposite signal must meet this score to
//                          count as confirmation (default 55 = tier B+, i.e.
//                          a bare tier-C flip alone won't trigger closures)
const REVERSAL_CASCADE   = process.env.REVERSAL_CASCADE !== '0'
const REVERSAL_MIN_SCORE = parseInt(process.env.REVERSAL_MIN_SCORE || '55')

// Closes one held trade RIGHT NOW at the given live price (not waiting for
// TP/SL), logs the real outcome (pips + win/loss from entry vs. live), sends
// a threaded alert under the original signal, and frees that symbol|tf slot.
async function closeHeldTrade(symObj, tf, direction, entry, livePrice, reason) {
  const dp = symObj.decimals ?? 2
  const state = loadState()
  const held = openTrade(state, symObj.id, tf)
  if (!held) return   // already closed by something else (watcher TP/SL, etc.) — nothing to do

  const diff = direction==='BUY' ? (livePrice-entry) : (entry-livePrice)
  const pips = toPips(diff, dp)
  const sign = diff > 0 ? +1 : diff < 0 ? -1 : 0
  const icon = sign>0 ? '✅' : sign<0 ? '❌' : '🟦'
  const label = sign>0 ? `+${pips} pips` : sign<0 ? `-${pips} pips` : 'break-even'

  const adminReplyId = held.signalMsgId || held.msgId || null
  const subMsgIds = held.subMsgIds || {}
  await sendReply(
`${dirIcon(direction)} <b>${symObj.label} ${tf.toUpperCase()} — TREND REVERSED ${icon}</b>
${reason}
Closed early at ${livePrice.toFixed(dp)} (entry ${entry.toFixed(dp)}) → <b>${label}</b>`,
    symObj.id, adminReplyId, subMsgIds)

  const signalId = makeSignalId(symObj.id, tf, held)
  addToDaily({ sym:symObj.id, tf, dir:direction, result:'REV', pips, sign, signalId })
  logOutcome(symObj, tf, held, 'REV', pips, sign)

  state[`${symObj.id}|${tf}`] = null
  saveState(state)
  console.log(`[${symObj.label} ${tf}] 🔄 Reversal close: ${label}`)
}

// Evaluate one open trade against a single closed 1-min bar. Mutates `state`,
// sends threaded alerts. Returns true if state changed.
async function evalTradeAgainstBar(state, symObj, tf, sig, bar) {
  const key=`${symObj.id}|${tf}`,dp = symObj.decimals ?? 2
  const dir=sig.direction, entry=sig.entry
  const signalId = makeSignalId(symObj.id, tf, sig)             // shared across all outcome rows
  const adminReplyId = sig.signalMsgId || sig.msgId || null     // reply to ORIGINAL signal (admin)
  const subMsgIds = sig.subMsgIds || {}                         // per-subscriber original message ids
  let changed=false

  // ── TP1 (wick touch) ──
  if(!sig.tp1Hit && (dir==='BUY' ? bar.high>=sig.tp1 : bar.low<=sig.tp1)){
    const pips=toPips(sig.tp1-entry,dp)
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP1 HIT ✅</b>\n+${pips} pips @ ${sig.tp1.toFixed(dp)}\nSL moved to break-even (${entry.toFixed(dp)}) — trade is now risk-free.\n→ Targeting TP2 ${sig.tp2.toFixed(dp)}`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:'TP1',pips,sign:+1,signalId})
    sig.tp1Hit=true; sig.sl=entry; state[key]={...sig}; changed=true
    console.log(`[${symObj.label} ${tf}] ✅ TP1 +${pips} pips`)
  }
  // ── TP2 ──
  if(sig.tp1Hit && !sig.tp2Hit && (dir==='BUY' ? bar.high>=sig.tp2 : bar.low<=sig.tp2)){
    const pips=toPips(sig.tp2-entry,dp)
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP2 HIT ✅</b>\n+${pips} pips @ ${sig.tp2.toFixed(dp)}\n→ Targeting TP3 ${sig.tp3.toFixed(dp)}`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:'TP2',pips,sign:+1,signalId})
    sig.tp2Hit=true; state[key]={...sig}; changed=true
    console.log(`[${symObj.label} ${tf}] ✅ TP2 +${pips} pips`)
  }
  // ── TP3 (full target → close) ──
  if(sig.tp2Hit && !sig.tp3Hit && (dir==='BUY' ? bar.high>=sig.tp3 : bar.low<=sig.tp3)){
    const pips=toPips(sig.tp3-entry,dp)
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — TP3 HIT 🏆 FULL TARGET</b>\n+${pips} pips @ ${sig.tp3.toFixed(dp)}\nAll targets reached! 🎯`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:'TP3',pips,sign:+1,signalId})
    logOutcome(symObj,tf,sig,'TP3',pips,+1)
    state[key]=null
    armCooldown(state, symObj.id, tf, POST_TP3_COOLDOWN_CANDLES)   // mutate SAME in-memory state — no separate I/O, avoids clobbering this batch's pending writes; cooldown is silent, never mentioned in the user-facing message
    changed=true
    console.log(`[${symObj.label} ${tf}] 🏆 TP3 +${pips} pips${POST_TP3_COOLDOWN_CANDLES>0?` — cooldown armed silently (${POST_TP3_COOLDOWN_CANDLES} candles)`:''}`)
    return changed   // trade fully closed
  }

  // ── SL (wick touch — immediate, same as TP) ──────────────────────────────
  const sl=sig.sl
  const wickedBeyond = dir==='BUY' ? bar.low<=sl : bar.high>=sl
  if(wickedBeyond){
    const isBE = Math.abs(sl-entry) < Math.pow(10,-dp)/2
    const pips = toPips(sl-entry,dp)
    const label = isBE ? 'Break-even (0 pips)' : `-${pips} pips`
    await sendReply(`${dirIcon(dir)} <b>${symObj.label} ${tf.toUpperCase()} — ${isBE?'CLOSED AT BREAK-EVEN 🟦':'STOP LOSS ❌'}</b>\n${label} @ ${sl.toFixed(dp)}\nPrice touched the stop — stopped out immediately.`, symObj.id, adminReplyId, subMsgIds)
    addToDaily({sym:symObj.id,tf,dir,result:isBE?'BE':'SL',pips,sign:isBE?0:-1,signalId})
    {
      // Learning row = FINAL outcome (furthest level reached), not the raw stop.
      // A trade that hit TP1 then stopped at break-even was a WIN for the brain.
      const finalRes  = sig.tp2Hit ? 'TP2' : sig.tp1Hit ? 'TP1' : (isBE ? 'BE' : 'SL')
      const finalSign = (sig.tp2Hit||sig.tp1Hit) ? +1 : (isBE ? 0 : -1)
      const finalPips = sig.tp2Hit ? toPips(sig.tp2-entry,dp) : sig.tp1Hit ? toPips(sig.tp1-entry,dp) : pips
      logOutcome(symObj,tf,sig,finalRes,finalPips,finalSign)
    }
    state[key]=null; changed=true
    console.log(`[${symObj.label} ${tf}] ${isBE?'🟦 BE':'🔴 SL'} (${label})`)
  }
  return changed
}

// Watch one symbol's open trades against ALL closed 1-min bars since last checked.
async function watchSymbol(symObj, isRetry=false) {
  const probe=loadState()
  const hasOpen=symObj.timeframes.some(tf=>openTrade(probe,symObj.id,tf))
  if(!hasOpen) return   // nothing open → no API call needed

  const res=await fetchRecentBars(symObj)
  if(res.rateLimited){
    if(!isRetry){ console.log(`[watch ${symObj.label}] per-minute API capacity full — retrying in 60s`); setTimeout(()=>watchSymbol(symObj,true).catch(()=>{}), RETRY_DELAY_MS) }
    else console.error(`[watch ${symObj.label}] still rate-limited after retry — next 1m sweep will catch it`)
    return
  }
  const bars=res.bars; if(!bars.length) return

  const state=loadState(); let changed=false
  for(const tf of symObj.timeframes){
    let sig=openTrade(state,symObj.id,tf); if(!sig?.entry) continue
    const lastBarTs=sig.lastBarTs||0
    // Only bars that CLOSED after the signal was sent, and never re-check a bar.
    const newBars=bars.filter(b=>b.ts>lastBarTs)
    for(const bar of newBars){
      sig=openTrade(state,symObj.id,tf); if(!sig?.entry) break    // closed mid-loop (TP3/SL)
      const c=await evalTradeAgainstBar(state, symObj, tf, sig, bar)
      changed = changed || c
      const cur=openTrade(state,symObj.id,tf)                     // advance progress marker
      if(cur){ cur.lastBarTs=bar.ts; state[`${symObj.id}|${tf}`]=cur; changed=true }
    }
  }
  if(changed) saveState(state)
}

async function watchAllTrades() {
  for(const symObj of getLiveSymbols()){
    try{ await watchSymbol(symObj) }catch(e){ console.error(`[watch ${symObj.label}]`, e.message) }
  }
}

// 1-minute aligned watcher loop
function scheduleWatcher() {
  const wait = (Math.ceil(Date.now()/WATCH_PERIOD_MS)*WATCH_PERIOD_MS - Date.now()) + CANDLE_DELAY_MS
  console.log(`[watch] next TP/SL sweep in ${(wait/1000).toFixed(0)}s`)
  setTimeout(async()=>{
    try{ await watchAllTrades() }catch(e){ console.error('[watch sweep]', e.message) }
    scheduleWatcher()
  }, wait)
}

// ── CANDLE CLOSE SCHEDULER (signal generation) ─────────────────────────────
function msUntilNextClose(tfMinutes) {
  const now=Date.now(), periodMs=tfMinutes*60000
  return Math.ceil(now/periodMs)*periodMs - now
}

// Runs `callback(symObj, tf)` with fast key rotation on 429 (per-minute cap
// hit): switches to the next key and retries after just KEY_SWITCH_DELAY_MS
// (1s), cycling through every active key. Only if an ENTIRE pass through all
// keys still comes back 429 does it fall back to the long RETRY_DELAY_MS
// (60s) wait — then tries one more full pass. Non-rate-limit errors (network
// hiccups) also get the fast 1s retry, same key. Gives up after 2 full
// cycles through all keys (bounded — never loops forever).
async function tryWithKeyRotation(symObj, tf, callback) {
  const totalKeys = Math.max(getLiveApiKeys().length, 1)
  for(let cycle=1; cycle<=2; cycle++){
    for(let i=1; i<=totalKeys; i++){
      try{ await callback(symObj,tf); return true }
      catch(e){
        const is429=e.message?.includes('429')||e.message?.includes('rate')||e.message?.includes('minute')
        const isNet=!is429 && (e.message?.includes('fetch')||e.message?.includes('ECONNRESET'))
        if(is429){
          console.log(`[scheduler] ${symObj.label} ${tf} key rate-limited — switching key (${i}/${totalKeys}, cycle ${cycle}/2), retry in 1s`)
          switchToNextKey()
          await sleep(KEY_SWITCH_DELAY_MS)
        } else if(isNet){
          console.log(`[scheduler] ${symObj.label} ${tf} network hiccup (${i}/${totalKeys}, cycle ${cycle}/2): ${e.message} — retry in 1s`)
          await sleep(KEY_SWITCH_DELAY_MS)
        } else {
          console.error(`[scheduler] ${symObj.label} ${tf} gave up: ${e.message}`)
          return false
        }
      }
    }
    if(cycle===1){
      console.log(`[scheduler] ${symObj.label} ${tf} all ${totalKeys} keys still rate-limited after quick rotation — waiting 60s before one more pass`)
      await sleep(RETRY_DELAY_MS)
    }
  }
  console.error(`[scheduler] ${symObj.label} ${tf} gave up — all ${totalKeys} keys rate-limited across both passes`)
  return false
}

function scheduleCandle(symObj, tf, callback) {
  const mins=TF_MINUTES[tf]; if(!mins){console.error(`Unknown TF: ${tf}`);return}
  const stagger=TF_STAGGER_MS[tf]||0, wait=msUntilNextClose(mins)+stagger
  console.log(`[scheduler] ${symObj.label} ${tf} next close in ${(wait/1000).toFixed(1)}s`)
  setTimeout(async()=>{
    await sleep(CANDLE_DELAY_MS)
    await tryWithKeyRotation(symObj, tf, callback)
    scheduleCandle(symObj,tf,callback)
  },wait)
}

// ── SIGNAL CYCLE ──────────────────────────────────────────────────────────
async function runSignalCycle(symObj, tf, isStartup=false) {
  const ts=new Date().toISOString()
  console.log(`[${ts}] 🕯️  ${symObj.label} ${tf} candle closed${isStartup?' (startup)':''}`)

  const heldBefore=openTrade(loadState(), symObj.id, tf)

  const {execFile}=await import('child_process')
  const {promisify}=await import('util')
  const exec=promisify(execFile)

  const env={
    ...process.env,
    LIVE_TFS:       tf,
    TWELVEDATA_KEY: currentKey(),
    TG_TOKEN:       '',                 // engine must NOT send TG msgs directly
    GOLD_SOURCE:    getLiveSource(),
    TG_CHAT,
    ACCT:           String(getAccountSize()),
    RISK:           String(getRiskPct()),
    OANDA_TOKEN:    getOandaToken(),
    OANDA_ENV:      getOandaEnv(),
    SYMBOL_LABEL:    symObj.label,
    SYMBOL_TD:       symObj.td_symbol,
    SYMBOL_OANDA:    symObj.oanda_symbol || '',
    SYMBOL_YAHOO:    symObj.yahoo_symbol || '',
    SYMBOL_DECIMALS: String(symObj.decimals ?? 2),
    LEARNING_LOG:    path.resolve('./learning_log.json'),
  }

  // Per-symbol CALIBRATED ATR bands (v10.5) — set via admin "🎯 Recalibrate
  // ATR" (or auto-calibrated when the symbol is added). Without this, forex
  // pairs are judged against GOLD's ATR% bands and blocked as low_liquidity.
  const band = symObj.atr_bands?.[tf]
  if (band && band.atrLow != null && band.atrHigh != null) {
    env.ATR_LOW  = String(band.atrLow)
    env.ATR_HIGH = String(band.atrHigh)
  }

  // Per-symbol SPREAD (v10.6) — set via admin "💱 Edit Spread" (in price
  // units, same units as the symbol's decimals). Without this, every symbol
  // uses the engine's 0.30 default, which is gold-tuned and far too wide for
  // most forex pairs — it silently fails the "TP1 vs spread" feasibility
  // gate and turns every otherwise-valid signal into a WAIT. Unset symbols
  // (spread === null) fall through to the engine's own 0.30 default exactly
  // as before, so gold's behaviour is unchanged.
  if (symObj.spread != null) {
    env.SPREAD = String(symObj.spread)
  }

  // Run engine in ISOLATED dir so it can't touch the launcher's bot_state.json
  const {stdout,stderr}=await exec('node',[ENGINE_SCRIPT,'check'],{env,timeout:60000,cwd:path.resolve(ENGINE_DIR)})
  if(stdout) console.log(`[${symObj.label} ${tf}]`,stdout.trim())
  if(stderr) console.error(`[${symObj.label} ${tf} err]`,stderr.trim())
  if(stderr&&(stderr.includes('429')||stderr.includes('fetch failed')||/minute/i.test(stderr))) throw new Error(stderr.trim().slice(0,120))

  const lines=stdout.split('\n')
  const log=(()=>{try{return JSON.parse(fs.readFileSync(ENGINE_TRADE_LOG,'utf8'))}catch{return[]}})()
  const entries=log.filter(e=>e.tframe===tf&&e.symbol===symObj.label&&!e.event)
  const latest=entries[entries.length-1]

  const alreadyAlerted=lines.some(l=>l.includes('already alerted'))
  const isWait=lines.some(l=>l.includes('WAIT')||l.includes('SKIP'))
  const hasSignal=lines.some(l=>l.includes('✅'))
  const freshnessMs=isStartup?2*60*60000:5*60000
  const fresh=latest&&(Date.now()-new Date(latest.ts).getTime()<freshnessMs)
  const shouldSend=fresh&&!isWait&&(hasSignal||(isStartup&&latest))&&(!alreadyAlerted||isStartup)

  console.log(`[${symObj.label} ${tf}] signal=${hasSignal} wait=${isWait} fresh=${fresh} held=${heldBefore?.direction||'none'} → send=${shouldSend}`)

  const stateKey=`${symObj.id}|${tf}`
  const dp=symObj.decimals ?? 2

  // Tick the post-TP3 cooldown once per real candle-close cycle for this
  // symbol|tf, regardless of whether a signal was found — it counts real
  // candles, not signal attempts. `coolingCandlesLeft` is the count AS OF
  // THIS cycle (before the tick) — >0 means this cycle is still suppressed.
  const coolingCandlesLeft = tickCooldown(symObj.id, tf)

  if(shouldSend){
    const sig=latest

    // ── PER-TIMEFRAME SEND TOGGLE (v10.9) ──────────────────────────────────
    // This timeframe is still fully analysed (everything above ran normally,
    // feeding the HTF gate / reversal-cascade logic for whoever reads it) —
    // it's just never broadcast or tracked when disabled via admin → Symbols
    // → 📤 Signal Sending.
    if(!isSendEnabled(symObj, tf)){
      console.log(`[${symObj.label} ${tf}] 🔇 ${sig.direction} computed (score ${sig.score}) but sending is DISABLED for this timeframe — analysed silently, not tracked`)
      return
    }

    // ── POST-TP3 COOLDOWN (v10.9) ──────────────────────────────────────────
    if(coolingCandlesLeft > 0){
      console.log(`[${symObj.label} ${tf}] 🧊 ${sig.direction} suppressed — cooling down after TP3 (${coolingCandlesLeft} candle(s) left)`)
      return
    }

    const isHold=heldBefore&&heldBefore.direction===sig.direction

    if(isHold){
      // Re-read state AFTER engine exec — the watcher may have run during the await and
      // updated tp1Hit/sl (or set trade=null on TP3/SL). Using stale heldBefore here
      // would clobber those updates or resurrect a closed trade.
      const current=openTrade(loadState(), symObj.id, tf)
      if(!current){
        // Watcher already closed this trade during exec (TP3 or SL) — do not send
        // KEEP HOLDING and do NOT re-save the old snapshot (that would resurrect it).
        console.log(`[${symObj.label} ${tf}] KEEP HOLDING skipped — trade already closed by watcher`)
        return
      }
      const adminReplyId=current.signalMsgId||current.msgId||null
      const subMsgIds=current.subMsgIds||{}
      const tp1L=`${current.tp1Hit?'✅ ':''}TP1 ${current.tp1?.toFixed(dp)}`
      const tp2L=`${current.tp2Hit?'✅ ':''}TP2 ${current.tp2?.toFixed(dp)}`
      const tp3L=`${current.tp3Hit?'✅ ':''}TP3 ${current.tp3?.toFixed(dp)}`
      await sendReply(`${dirIcon(current.direction)} <b>${symObj.label} ${tf.toUpperCase()} — KEEP HOLDING ${current.direction}</b>\nConfluence still active — original trade stays open.\nEntry ${current.entry?.toFixed(dp)} · SL ${current.sl?.toFixed(dp)}\n${tp1L}\n${tp2L}\n${tp3L}`, symObj.id, adminReplyId, subMsgIds, { keepHolding:true })
      // DO NOT saveState here — the watcher owns tp1Hit/sl/lastBarTs.
      // Saving the old snapshot would clobber those updates.
      console.log(`[${symObj.label} ${tf}] 📡 KEEP HOLDING`)
    } else {
      // ── CONFIRMED-REVERSAL CASCADE CLOSE (v10.8) ─────────────────────────
      // `sig` here already passed every entry gate (score/conviction floor,
      // MTF alignment, candle confirmation, spread feasibility, etc) — so if
      // its direction opposes what THIS timeframe is currently holding, that
      // is real, gate-confirmed evidence of a reversal, not noise.
      // (Re-read fresh state — the trade may have already closed naturally
      // during engine exec via the watcher, in which case there's nothing to
      // reverse and we just fall through to a normal fresh entry below.)
      const stillOpen = openTrade(loadState(), symObj.id, tf)
      const isConfirmedReversal = REVERSAL_CASCADE && stillOpen && stillOpen.direction
        && stillOpen.direction !== sig.direction && sig.score >= REVERSAL_MIN_SCORE

      if (isConfirmedReversal) {
        const oldDir = stillOpen.direction
        const livePrice = parseFloat(sig.live)
        console.log(`[${symObj.label} ${tf}] 🔄 CONFIRMED reversal — fresh ${sig.direction} signal (score ${sig.score}) passed all entry gates while ${tf} held ${oldDir}. Closing ${tf} and any dependent ${oldDir} trades at live ${livePrice}.`)

        // Close this timeframe's own trade at current live price.
        await closeHeldTrade(symObj, tf, oldDir, stillOpen.entry, livePrice,
          `${tf.toUpperCase()} trend reversed to ${sig.direction} — confirmed by a fresh ${sig.tier}-tier signal (score ${sig.score}) passing every entry filter.`)

        // Cascade to every timeframe whose CUSTOM dependency list actually
        // includes this one (admin → Symbols → 🔗 Dependencies) — not just
        // "faster" timeframes. Price is one shared value across all
        // timeframes of a symbol at any given instant — no need to re-fetch.
        const dependents = getDependents(symObj, tf)
        for (const otherTf of dependents) {
          const otherHeld = openTrade(loadState(), symObj.id, otherTf)
          if (otherHeld && otherHeld.direction === oldDir) {
            await closeHeldTrade(symObj, otherTf, oldDir, otherHeld.entry, livePrice,
              `${tf.toUpperCase()} (a dependency of ${otherTf.toUpperCase()}) reversed to ${sig.direction} — closing this ${otherTf.toUpperCase()} ${oldDir} early rather than let it fight the new trend.`)
          }
        }
        // Fall through — do NOT return. The old trade(s) are now closed, so
        // the checks below will find nothing blocking, and the fresh
        // opposite-direction signal sends immediately instead of waiting.
      } else if (stillOpen && stillOpen.direction && stillOpen.direction !== sig.direction) {
        // Opposite signal exists but didn't meet REVERSAL_MIN_SCORE (or the
        // feature is disabled) — fall back to the old suppress-only
        // behaviour: wait for the held trade to close naturally.
        console.log(`[${symObj.label} ${tf}] ⛔ ${sig.direction} suppressed — ${tf} still holds an open ${stillOpen.direction} (score ${sig.score} below reversal threshold ${REVERSAL_MIN_SCORE}, waiting for TP3/SL/BE)`)
        return
      }

      // ── SINGLE ACTIVE TRADE PER SYMBOL (v10.12) ──────────────────────────
      // Default ON. If ANY other timeframe of this symbol already holds an
      // open trade — any direction — this fresh signal is dropped outright,
      // before the dependency gate or duplicate check even run. This is the
      // main lock most setups want: only one active trade per symbol, ever.
      if (SINGLE_TRADE_PER_SYMBOL) {
        const other = anyOtherTfHoldingTrade(symObj, tf)
        if (other) {
          console.log(`[${symObj.label} ${tf}] ⛔ ${sig.direction} suppressed — ${other.tf} already holds an active ${other.trade.direction} trade on this symbol (single-trade-per-symbol; set SINGLE_TRADE_PER_SYMBOL=0 to allow concurrent timeframes)`)
          return
        }
      }

      // TIMEFRAME DEPENDENCY GATE (v10.10) — HARD block, no exceptions.
      // Only reached when SINGLE_TRADE_PER_SYMBOL=0 finds nothing above, or
      // the symbol has multiple trades allowed.
      // Any timeframe opposing an open trade on ANY of ITS configured
      // dependencies (admin → Symbols → 🔗 Dependencies; defaults to every
      // higher timeframe if never customised) is suppressed outright. E.g.
      // if 1m depends on 5m/15m/1h and 1h holds BUY, 1m can't send SELL —
      // only BUY (or WAIT) — until that dependency closes (TP3/SL/BE) OR
      // gets confirmed-reversal-closed above.
      const dependsOn = getDependsOn(symObj, tf)
      const dep = dependencyDirection(loadState(), symObj.id, dependsOn)
      if(dep && dep.dir!==sig.direction){
        console.log(`[${symObj.label} ${tf}] ⛔ ${sig.direction} suppressed — depends on ${dep.tf} which holds ${dep.dir} (blocked until it closes or reverses)`)
        return
      }

      // ── CROSS-TIMEFRAME DUPLICATE SUPPRESSION (v10.11) ───────────────────
      // Another timeframe of this SAME symbol may already be holding a fresh
      // trade in the SAME direction (e.g. 1m fired, now 5m fires too on the
      // same move). Only the better-scoring signal is kept — the weaker one
      // never sends and never gets tracked. Runs AFTER the dependency gate
      // so a genuinely blocked signal is reported as blocked, not as a
      // duplicate.
      const dup = findDuplicateAcrossTimeframes(symObj, tf, sig.direction)
      if (dup) {
        if (sig.score > (dup.trade.score ?? 0)) {
          const s = loadState()
          s[`${symObj.id}|${dup.tf}`] = null
          saveState(s)
          console.log(`[${symObj.label} ${tf}] 🔁 Duplicate ${sig.direction} across timeframes — ${dup.tf} (score ${dup.trade.score}) dropped silently in favor of this ${tf} signal (score ${sig.score})`)
        } else {
          console.log(`[${symObj.label} ${tf}] 🔁 Duplicate ${sig.direction} suppressed — ${dup.tf} already holds an equal/better signal (score ${dup.trade.score} vs ${sig.score})`)
          return
        }
      }

      const entry=parseFloat(sig.entry), sl=parseFloat(sig.sl)
      const tp1=parseFloat(sig.tp1), tp2=parseFloat(sig.tp2), tp3=parseFloat(sig.tp3)
      const msgText=
`${dirIcon(sig.direction)} <b>${symObj.label} ${tf.toUpperCase()} — ${sig.direction}</b> (score ${sig.score}/100 ${sig.tier})
H1 ${sig.h1Trend} · ${sig.session}
🔰 Entry ${entry.toFixed(dp)} · live ${parseFloat(sig.live).toFixed(dp)}
❌ SL ${sl.toFixed(dp)} (-${toPips(entry-sl,dp)} pips)
✅ TP1 ${tp1.toFixed(dp)} (+${toPips(tp1-entry,dp)} pips)
✅ TP2 ${tp2.toFixed(dp)} (+${toPips(tp2-entry,dp)} pips)
✅ TP3 ${tp3.toFixed(dp)} (+${toPips(tp3-entry,dp)} pips)
🛡️ SL triggers immediately if price touches ${sl.toFixed(dp)}.
⚠️ Manage risk. Not financial advice.`
      // lastBarTs = signal bar's open (1-min). Filter is b.ts > lastBarTs so the NEXT
      // 1-min bar is the first one evaluated. Catches TP/SL within seconds of touch.
      const nowBar1m=Math.floor(Date.now()/WATCH_BAR_MS)*WATCH_BAR_MS - WATCH_BAR_MS
      const r=await sendNewSignal(msgText, symObj.id)
      const sNow=loadState()
      sNow[stateKey]={direction:sig.direction,entry,sl,tp1,tp2,tp3,tp1Hit:false,tp2Hit:false,tp3Hit:false,signalMsgId:r.adminMsgId,subMsgIds:r.subMsgIds,lastBarTs:nowBar1m,ts:sig.ts,score:sig.score,tier:sig.tier,regime:sig.regime,session:sig.session}
      saveState(sNow)
      console.log(`[${symObj.label} ${tf}] 📡 NEW signal adminMsgId=${r.adminMsgId} subs=${Object.keys(r.subMsgIds).length}`)
    }
  } else if(!hasSignal&&!fresh){
    console.log(`[${symObj.label} ${tf}] No signal this candle`)
  }
}

// ── DAILY SUMMARY ─────────────────────────────────────────────────────────
// Collapses each signal's TP1/TP2/TP3/SL/BE rows into a single furthest-outcome
// row (matched by signalId) before summing — so a trade that hit TP1+TP2 counts
// once as TP2, not TP1+TP2. Mirrors the bot's monthly-stats collapse.
const SUMMARY_RANK = { SL:0, BE:0, TP1:1, TP2:2, TP3:3 }
function collapseRows(rows) {
  const byId=new Map(); let auto=0
  for(const t of rows){
    const id=t.signalId||`__solo_${auto++}`
    const rank=SUMMARY_RANK[t.result] ?? -1
    const cur=byId.get(id)
    if(!cur || rank > (SUMMARY_RANK[cur.result] ?? -1)) byId.set(id,t)
  }
  return [...byId.values()]
}
function scheduleDailySummary(){
  function msUntilMidnight(){const now=new Date();return new Date(Date.UTC(now.getUTCFullYear(),now.getUTCMonth(),now.getUTCDate()+1))-now}
  async function sendDailySummary(){
    const key=todayKey(),daily=loadDaily(),day=daily[key]
    if(day?.trades?.length>0){
      const trades=collapseRows(day.trades)                 // ← furthest TP only
      const signedPips=t=>t.sign>0?t.pips:t.sign<0?-t.pips:0
      const totalPips=Math.round(trades.reduce((a,t)=>a+signedPips(t),0))
      const wins=trades.filter(t=>t.sign>0),losses=trades.filter(t=>t.sign<0)
      const lines=trades.map(t=>{
        const nm=(t.sym||'').toUpperCase()
        const icon=t.sign>0?'✅':t.sign<0?'❌':'🟦'
        const sign=t.sign>0?'+':t.sign<0?'-':''
        return `${icon} ${nm} ${t.tf?.toUpperCase()} ${t.dir} → ${t.result}: ${sign}${t.pips} pips`
      })
      const summaryLine=totalPips>=0?`+${totalPips} pips profit`:`${totalPips} pips loss`
      const text=`${totalPips>=0?'📈':'📉'} <b>GOLD AI — Daily Summary (${key})</b>\n\n${lines.join('\n')}\n\n──────────────\nTrades: ${trades.length} | Wins: ${wins.length} | Losses: ${losses.length}\n<b>Total: ${summaryLine}</b>`
      try{await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({chat_id:TG_CHAT,text,parse_mode:'HTML'})})}catch{}
      await broadcastSignal(text, null)
      console.log(`[daily] Summary sent: ${summaryLine}`)
    }
    setTimeout(sendDailySummary,msUntilMidnight()+1000)
  }
  setTimeout(sendDailySummary,msUntilMidnight()+1000)
  console.log(`   📅 Daily summary in ${Math.round(msUntilMidnight()/60000)} min`)
}

// ── STARTUP ───────────────────────────────────────────────────────────────
const symbols=getLiveSymbols()

console.log('🚀 Gold AI Launcher v10.12 — Single Trade Per Symbol + Cross-TF Duplicate Suppression + Silent TP3 Cooldown + Custom TF Dependency Graph + Per-TF Send Toggle + Confirmed-Reversal Cascade + Per-Symbol Spread + Calibrated ATR')
console.log(`   Symbols: ${symbols.map(s=>`${s.emoji}${s.label}[${s.timeframes.join(',')}]`).join('  ')}`)
console.log(`   ⚡ TP/SL watcher: every 1 min — TP & SL both trigger on wick touch`)
console.log(`   🔒 Single trade per symbol: ${SINGLE_TRADE_PER_SYMBOL?'ON':'OFF'} — only one active trade per symbol across all timeframes (SINGLE_TRADE_PER_SYMBOL=0 to allow concurrent timeframes)`)
console.log(`   🔗 Custom TF dependency graph: each timeframe blocked only by its OWN configured dependencies (default = every higher TF) — set via admin → Symbols → Dependencies`)
console.log(`   📤 Per-TF send toggle: silent timeframes are still analysed (feeds dependency/reversal logic) but never sent or tracked — set via admin → Symbols → Signal Sending`)
console.log(`   🔁 Cross-TF duplicate suppression: only the better-scoring signal across timeframes (within ${DUPLICATE_WINDOW_MIN} min) is sent/tracked — DUPLICATE_WINDOW_MIN to change`)
console.log(`   🧊 Post-TP3 cooldown: ${POST_TP3_COOLDOWN_CANDLES} candle(s) suppressed silently on a symbol|tf right after it hits TP3 (POST_TP3_COOLDOWN_CANDLES to change, not shown in the TP3 message)`)
console.log(`   🔄 Confirmed-reversal cascade: fresh gated opposite signal (score≥${REVERSAL_MIN_SCORE}) closes held trade + dependent-TF same-direction trades at live price (REVERSAL_CASCADE=0 to disable)`)
console.log(`   💱 Per-symbol spread: injected from admin config, falls back to engine's 0.30 default`)
console.log(`   🔁 KEEP HOLDING updates respect the /keepholding user toggle`)
console.log(`   🔑 API keys: ${getLiveApiKeys().length} active`)
console.log(`   💰 Account: $${getAccountSize()} · Risk ${getRiskPct()}%`)

scheduleDailySummary()

// Sanitise stale state (clear any string/garbage entries left behind)
;(()=>{
  const state=loadState(); let changed=false
  for(const key of Object.keys(state)){
    if(key==='at') continue
    if(typeof state[key]==='string'||(state[key]&&typeof state[key]!=='object')){
      console.log(`[startup] Clearing stale state for ${key}`); state[key]=null; changed=true
    }
  }
  if(changed) saveState(state)
  console.log('[startup] State OK')
})()

// Initial check for every symbol × every TF, then schedule everything
;(async()=>{
  for(const symObj of symbols){
    for(const tf of symObj.timeframes){
      console.log(`[startup] Initial check: ${symObj.label} ${tf}…`)
      await tryWithKeyRotation(symObj, tf, (s,t)=>runSignalCycle(s,t,true))
      await sleep(3000)
    }
  }
  for(const symObj of symbols){
    for(const tf of symObj.timeframes){
      scheduleCandle(symObj,tf,runSignalCycle)
    }
  }
})()

// First sweep soon, then aligned to 1-minute closes
watchAllTrades().catch(e=>console.error('[watch initial]',e.message))
scheduleWatcher()
