// ─────────────────────────────────────────────────────────────────────────────
//  signal-brain.mjs — v1.0  ADAPTIVE PATTERN FILTER (the "learning" layer)
//
//  What it does:
//   • Reads learning_log.json — one row per CLOSED trade (final outcome only),
//     written by launcher v10.4 when a trade hits TP3 / SL / BE.
//   • Builds bucket statistics:  sym|tf|regime|session  →  win rate, net pips.
//   • brainCheck() is called by gold-ai.mjs AFTER all normal gates pass.
//     It blocks a signal only when there is ENOUGH EVIDENCE (≥5 trades per
//     bucket) that this exact pattern loses money. FAIL-OPEN: no data = allow.
//   • Streak cooldown: 3 consecutive SL hits on the same symbol|tf → that
//     combo is paused for 12h (both tunable via env).
//
//  CLI:
//     node signal-brain.mjs report      → full bucket table + what's blocked
//     node signal-brain.mjs report gold → filter to one symbol id/label
//
//  Env knobs (all optional):
//     LEARNING_LOG        path to learning_log.json   (default ./learning_log.json)
//     BRAIN_MIN_TRADES    min trades before a bucket is trusted   (default 5)
//     BRAIN_MIN_WR        block if win rate (decided) below this  (default 35)
//     BRAIN_STREAK        consecutive losses to trigger cooldown  (default 3)
//     BRAIN_COOLDOWN_H    cooldown hours after a loss streak      (default 12)
// ─────────────────────────────────────────────────────────────────────────────
import fs from 'fs'

const LOG_PATH   = process.env.LEARNING_LOG || './learning_log.json'
const MIN_TRADES = parseInt(process.env.BRAIN_MIN_TRADES || '5')
const MIN_WR     = parseFloat(process.env.BRAIN_MIN_WR   || '35')
const STREAK_N   = parseInt(process.env.BRAIN_STREAK     || '3')
const COOLDOWN_H = parseFloat(process.env.BRAIN_COOLDOWN_H || '12')

// ── LOAD ─────────────────────────────────────────────────────────────────
function loadLog() {
  try {
    const a = JSON.parse(fs.readFileSync(LOG_PATH, 'utf8'))
    return Array.isArray(a) ? a.filter(r => r && r.result) : []
  } catch { return [] }
}

const signedPips = r => r.sign > 0 ? (r.pips || 0) : r.sign < 0 ? -(r.pips || 0) : 0
const scoreBucket = s => s == null ? 'na' : s >= 70 ? '70+' : s >= 55 ? '55-69' : '<55'

// ── BUCKET STATS ─────────────────────────────────────────────────────────
function statsFor(rows) {
  const wins   = rows.filter(r => r.sign > 0).length
  const losses = rows.filter(r => r.sign < 0).length
  const bes    = rows.length - wins - losses
  const decided = wins + losses
  return {
    n: rows.length, wins, losses, bes,
    winRate: decided ? +(wins / decided * 100).toFixed(1) : null,
    netPips: Math.round(rows.reduce((a, r) => a + signedPips(r), 0)),
  }
}

// Buckets checked from MOST specific to broadest. First one with enough
// data decides. This means: fine-grained evidence wins; if a fine bucket
// is thin, fall back to a coarser one before letting the trade through.
function bucketKeys(sig) {
  const sym = sig.sym || '?'
  return [
    { key: `${sym}|${sig.tf}|${sig.regime}|${sig.session}`, label: 'regime+session' },
    { key: `${sym}|${sig.tf}|${sig.regime}`,                label: 'regime'         },
    { key: `${sym}|${sig.tf}|${sig.session}`,               label: 'session'        },
    { key: `${sym}|${sig.tf}|score:${scoreBucket(sig.score)}`, label: 'score band'  },
  ]
}

function rowsForKey(log, key) {
  const parts = key.split('|')
  return log.filter(r => {
    if (r.sym !== parts[0] || r.tf !== parts[1]) return false
    for (let i = 2; i < parts.length; i++) {
      const p = parts[i]
      if (p.startsWith('score:')) { if (scoreBucket(r.score) !== p.slice(6)) return false }
      else if (r.regime !== p && r.session !== p) return false
    }
    return true
  })
}

// ── STREAK COOLDOWN ──────────────────────────────────────────────────────
function streakBlocked(log, sig, nowMs) {
  const rows = log
    .filter(r => r.sym === sig.sym && r.tf === sig.tf)
    .sort((a, b) => new Date(a.ts) - new Date(b.ts))
  if (rows.length < STREAK_N) return null
  const lastN = rows.slice(-STREAK_N)
  if (!lastN.every(r => r.sign < 0)) return null
  const lastTs = new Date(lastN[lastN.length - 1].ts).getTime()
  const hoursSince = (nowMs - lastTs) / 3600000
  if (hoursSince < COOLDOWN_H) {
    return `${STREAK_N} consecutive SL on ${sig.tf} — cooldown ${(COOLDOWN_H - hoursSince).toFixed(1)}h left`
  }
  return null
}

// ── MAIN GATE ────────────────────────────────────────────────────────────
// sig = { sym, tf, regime, session, score }   →   { allow, why, stats }
export function brainCheck(sig, nowMs = Date.now()) {
  let log
  try { log = loadLog() } catch { return { allow: true, why: 'brain: log unreadable — fail-open' } }
  if (!log.length) return { allow: true, why: 'no history yet' }

  // 1) loss-streak cooldown (symbol|tf level)
  const streak = streakBlocked(log, sig, nowMs)
  if (streak) return { allow: false, why: streak }

  // 2) pattern buckets — first bucket with enough evidence decides
  for (const b of bucketKeys(sig)) {
    const rows = rowsForKey(log, b.key)
    if (rows.length < MIN_TRADES) continue
    const st = statsFor(rows)
    if (st.winRate !== null && st.winRate < MIN_WR && st.netPips < 0) {
      return { allow: false, why: `${b.label} bucket losing (${st.wins}W/${st.losses}L, ${st.netPips}p over ${st.n})`, stats: st }
    }
    return { allow: true, why: `${b.label} bucket OK (${st.winRate}% WR, ${st.netPips >= 0 ? '+' : ''}${st.netPips}p)`, stats: st }
  }
  return { allow: true, why: 'insufficient bucket data — allow' }
}

// ── CLI REPORT ───────────────────────────────────────────────────────────
function report(filter) {
  const log = loadLog()
  if (!log.length) { console.log(`No learning data yet at ${LOG_PATH}. The brain fails open until trades close.`); return }
  const rows = filter ? log.filter(r => (r.sym || '').toLowerCase().includes(filter) || (r.symId || '').toLowerCase().includes(filter)) : log

  const groups = {}
  for (const r of rows) {
    const keys = [
      `${r.sym}|${r.tf}`,
      `${r.sym}|${r.tf}|${r.regime}`,
      `${r.sym}|${r.tf}|${r.session}`,
      `${r.sym}|${r.tf}|${r.regime}|${r.session}`,
      `${r.sym}|${r.tf}|score:${scoreBucket(r.score)}`,
    ]
    for (const k of keys) (groups[k] ??= []).push(r)
  }

  console.log(`🧠 Signal Brain report — ${rows.length} closed trades · min ${MIN_TRADES}/bucket · block if WR<${MIN_WR}% and net<0\n`)
  const entries = Object.entries(groups).map(([k, v]) => [k, statsFor(v)]).sort((a, b) => b[1].n - a[1].n)
  for (const [k, st] of entries) {
    const trusted = st.n >= MIN_TRADES
    const blocked = trusted && st.winRate !== null && st.winRate < MIN_WR && st.netPips < 0
    const flag = blocked ? '⛔ BLOCKED' : trusted ? '✅' : `… (${st.n}/${MIN_TRADES})`
    console.log(`${flag.padEnd(12)} ${k.padEnd(55)} n=${String(st.n).padEnd(4)} WR=${st.winRate == null ? ' —  ' : (st.winRate + '%').padEnd(6)} net=${st.netPips >= 0 ? '+' : ''}${st.netPips}p  (${st.wins}W/${st.losses}L/${st.bes}BE)`)
  }
  console.log('\n⛔ buckets are auto-skipped by the engine. Delete learning_log.json to reset the brain.')
}

// entry point when run directly
if (process.argv[1] && process.argv[1].endsWith('signal-brain.mjs')) {
  const mode = process.argv[2]
  if (mode === 'report') report((process.argv[3] || '').toLowerCase())
  else console.log('Usage: node signal-brain.mjs report [symbolFilter]')
}
