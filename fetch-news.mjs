// ─────────────────────────────────────────────────────────────
//  fetch-news.mjs — populate news_events.json for the trading week
//
//  Pulls this week's HIGH-impact USD events (the ones that move XAUUSD)
//  from the free Forex Factory weekly JSON feed and writes them in the
//  exact { time, label } shape the engine's inNewsBlackout() expects.
//
//  Run weekly (e.g. Sunday before the open), or let the launcher spawn it:
//      node fetch-news.mjs
//
//  Fails SAFE: on any error it keeps the existing news_events.json and
//  exits non-zero, so a bad fetch never wipes your blackout list.
// ─────────────────────────────────────────────────────────────
import fs from 'fs'

const URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json'
const OUT = './news_events.json'

// XAUUSD is driven mainly by USD high-impact prints (NFP, CPI, FOMC, PCE…).
// Add 'Medium' or more countries if you want a wider blackout net.
const KEEP_COUNTRIES = new Set(['USD'])
const KEEP_IMPACT    = new Set(['High'])

try {
  const res = await fetch(URL, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const data = await res.json()
  if (!Array.isArray(data)) throw new Error('unexpected payload (not an array)')

  const events = data
    .filter(e => KEEP_COUNTRIES.has(e.country) && KEEP_IMPACT.has(e.impact))
    .map(e => ({ time: new Date(e.date).toISOString(), label: `${e.country} ${e.title}` }))
    .filter(e => !isNaN(new Date(e.time).getTime()))
    .sort((a, b) => new Date(a.time) - new Date(b.time))

  if (!events.length) throw new Error('feed returned 0 matching events — leaving old file intact')

  fs.writeFileSync(OUT, JSON.stringify(events, null, 2))
  console.log(`✅ Wrote ${events.length} high-impact USD events → ${OUT}`)
  for (const e of events) console.log(`   ${e.time}  ${e.label}`)
} catch (err) {
  console.error(`❌ News fetch failed: ${err.message}`)
  console.error('   Kept existing news_events.json (if any). Engine fails safe to no-blackout.')
  process.exit(1)
}
