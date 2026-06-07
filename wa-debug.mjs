// ── Green API Debug Tool ──────────────────────────────────────
// Run: node wa-debug.mjs
// Then send a message to the bot number from your phone.
// This will print EXACTLY what Green API returns so we can fix it.

const INSTANCE = '7107645470'
const TOKEN    = '37e51f5f69794180acf390f80ee89bcac29ceb0748b148f1a4'
const BASE     = `https://api.green-api.com/waInstance${INSTANCE}`

console.log('🔍 Green API Debug — polling for notifications...')
console.log('   Send a message to the bot number NOW from your phone.\n')

let count = 0

while (true) {
  try {
    // 1. Receive one notification
    const res = await fetch(`${BASE}/receiveNotification/${TOKEN}`)
    const text = await res.text()

    if (!res.ok) {
      console.error(`❌ HTTP ${res.status}: ${text}`)
      await new Promise(r => setTimeout(r, 3000))
      continue
    }

    // 2. Parse it
    let notif
    try { notif = JSON.parse(text) } catch { notif = null }

    // 3. null = queue empty
    if (!notif) {
      process.stdout.write('.')  // dot every empty poll
      await new Promise(r => setTimeout(r, 1500))
      continue
    }

    count++
    console.log(`\n\n📨 Notification #${count} received!`)
    console.log('─────────────────────────────────────────')
    console.log(JSON.stringify(notif, null, 2))
    console.log('─────────────────────────────────────────')

    // 4. Log the key fields we care about
    const body = notif.body || {}
    console.log('\n🔑 Key fields:')
    console.log('  typeWebhook     :', body.typeWebhook)
    console.log('  senderData      :', JSON.stringify(body.senderData))
    console.log('  messageData     :', JSON.stringify(body.messageData))
    console.log('  typeMessage     :', body.messageData?.typeMessage)
    console.log('  textMessage     :', body.messageData?.textMessageData?.textMessage)

    // 5. Delete the notification so it doesn't pile up
    const receiptId = notif.receiptId
    if (receiptId) {
      const del = await fetch(`${BASE}/deleteNotification/${TOKEN}/${receiptId}`, { method: 'DELETE' })
      console.log(`\n🗑  Deleted notification ${receiptId} — status ${del.status}`)
    }

  } catch (e) {
    console.error('\n❌ Error:', e.message)
    await new Promise(r => setTimeout(r, 3000))
  }
}
