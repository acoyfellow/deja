/**
 * deja-local example — In-process vector memory for agents.
 *
 * Run:  bun run examples/local/index.ts
 *
 * This demo walks through the full memory lifecycle:
 *   remember → recall → confirm/reject → forget
 *
 * Uses SQLite + real embeddings (all-MiniLM-L6-v2).
 * First run downloads the model (~23MB, cached after that).
 */

import { createMemory } from '../../packages/deja-local/src/index'

const mem = await createMemory({ path: './demo-memory.db' })

console.log('--- deja-local demo ---\n')

// 1. Remember — store some memories
console.log('1. Remembering things...')
const m1 = await mem.remember('Always run tests before deploying to production')
const m2 = await mem.remember('The API rate limit is 100 requests per minute')
const m3 = await mem.remember('Use wrangler.toml for Cloudflare Workers config')
console.log(`   Stored ${mem.size} memories\n`)

// 2. Recall — semantic search finds relevant memories
console.log('2. Recalling "how to deploy safely"...')
const results = await mem.recall('how to deploy safely')
for (const r of results) {
  console.log(`   [score=${r.score.toFixed(3)}] ${r.text}`)
}

// 3. Confirm — boost confidence of useful memories
console.log('\n3. Confirming the top result was helpful...')
if (results.length > 0) {
  mem.confirm(results[0].id)
  console.log(`   Confirmed: "${results[0].text}"`)
}

// 4. Reject — lower confidence of unhelpful memories
console.log('\n4. Rejecting the last result...')
if (results.length > 1) {
  const last = results[results.length - 1]
  mem.reject(last.id)
  console.log(`   Rejected: "${last.text}"`)
}

// 5. Deduplication — similar memories are merged, not duplicated
console.log('\n5. Testing deduplication...')
const sizeBefore = mem.size
await mem.remember('Always run tests before deploying to production!')
console.log(`   Size before: ${sizeBefore}, after: ${mem.size} (deduped: ${sizeBefore === mem.size})`)

// 6. Forget — remove a memory entirely
console.log('\n6. Forgetting a memory...')
mem.forget(m3.id)
console.log(`   Forgot: "${m3.text}"`)
console.log(`   Memories remaining: ${mem.size}`)

// 7. Audit log — see what the agent recalled and when
console.log('\n7. Recall audit log:')
const log = mem.recallLog({ limit: 3 })
for (const entry of log) {
  console.log(`   [${entry.timestamp}] query="${entry.context}" → ${entry.results.length} results`)
}

// Cleanup
mem.close()
console.log('\n--- done ---')
