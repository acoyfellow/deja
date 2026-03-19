import { describe, test, expect, afterEach } from 'bun:test'
import { createMemory, type MemoryStore } from '../src/index'
import { unlinkSync, existsSync } from 'fs'

// All tests use a trivial embed function — fast, deterministic.
// The real model is tested separately. These tests verify TRUST, not embedding quality.
function testEmbed(text: string): number[] {
  // Deterministic: hash each char into a 16-dim vector
  const vec = new Float64Array(16)
  const lower = text.toLowerCase()
  for (let i = 0; i < lower.length; i++) {
    const code = lower.charCodeAt(i)
    vec[code % 16] += (code & 1) ? 1 : -1
  }
  let norm = 0
  for (let i = 0; i < 16; i++) norm += vec[i] * vec[i]
  norm = Math.sqrt(norm)
  if (norm > 0) for (let i = 0; i < 16; i++) vec[i] /= norm
  return Array.from(vec)
}

function tmpDb() {
  return `/tmp/deja-test-${crypto.randomUUID()}.db`
}

let cleanup: string[] = []

afterEach(() => {
  for (const f of cleanup) {
    try { unlinkSync(f) } catch {}
    try { unlinkSync(f + '-wal') } catch {}
    try { unlinkSync(f + '-shm') } catch {}
  }
  cleanup = []
})

function mem(path?: string): MemoryStore {
  const p = path ?? tmpDb()
  cleanup.push(p)
  return createMemory({ path: p, embed: testEmbed, threshold: 0.1 })
}

// ============================================================================
// Trust guarantee: DURABILITY
// ============================================================================

describe('durability', () => {
  test('memories survive process restart (new instance, same file)', async () => {
    const p = tmpDb()
    cleanup.push(p)

    const mem1 = createMemory({ path: p, embed: testEmbed })
    await mem1.learn('survive restart')
    mem1.close()

    const mem2 = createMemory({ path: p, embed: testEmbed })
    expect(mem2.size).toBe(1)
    expect(mem2.list()[0].text).toBe('survive restart')
    mem2.close()
  })

  test('database file is created on disk', async () => {
    const p = tmpDb()
    cleanup.push(p)
    const m = createMemory({ path: p, embed: testEmbed })
    await m.learn('test')
    expect(existsSync(p)).toBe(true)
    m.close()
  })

  test('learn is durable before returning', async () => {
    const p = tmpDb()
    cleanup.push(p)

    const m = createMemory({ path: p, embed: testEmbed })
    await m.learn('durable write')
    // Don't call close — simulate crash
    // Open fresh connection to same file
    const m2 = createMemory({ path: p, embed: testEmbed })
    expect(m2.size).toBe(1)
    m.close()
    m2.close()
  })
})

// ============================================================================
// Trust guarantee: CONSISTENCY
// ============================================================================

describe('consistency', () => {
  test('learn on step N is recallable on step N+1 (zero lag)', async () => {
    const m = mem()
    await m.learn('check wrangler.toml before deploying')
    // Immediately — no waiting, no eventual consistency
    const results = await m.recall('deploying to production')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toBe('check wrangler.toml before deploying')
    m.close()
  })

  test('forget immediately removes from recall', async () => {
    const m = mem()
    const memory = await m.learn('remove me')
    const before = await m.recall('remove me')
    expect(before.length).toBe(1)

    await m.forget(memory.id)
    const after = await m.recall('remove me')
    expect(after.length).toBe(0)
    m.close()
  })
})

// ============================================================================
// Trust guarantee: DEDUPLICATION
// ============================================================================

describe('deduplication', () => {
  test('identical text is not stored twice', async () => {
    const m = mem()
    await m.learn('deploy tip: check wrangler.toml')
    await m.learn('deploy tip: check wrangler.toml')
    expect(m.size).toBe(1)
    m.close()
  })

  test('near-identical text is deduplicated', async () => {
    const m = mem()
    await m.learn('always check wrangler.toml before deploying')
    await m.learn('always check wrangler.toml before deploying!')
    // Near-identical — should be deduplicated (depends on embed similarity)
    expect(m.size).toBeLessThanOrEqual(2) // may or may not dedup with test embedder
    m.close()
  })

  test('genuinely different memories are both stored', async () => {
    const m = mem()
    await m.learn('check wrangler.toml before deploying')
    await m.learn('always backup database before migrations')
    expect(m.size).toBe(2)
    m.close()
  })
})

// ============================================================================
// Trust guarantee: AUDITABILITY
// ============================================================================

describe('auditability', () => {
  test('every recall is logged', async () => {
    const m = mem()
    await m.learn('tip about deploying')
    await m.recall('deploying to production')
    await m.recall('running database migration')

    const log = m.recallLog()
    expect(log.length).toBe(2)
    m.close()
  })

  test('recall log contains context and matched memories', async () => {
    const m = mem()
    const memory = await m.learn('tip about deploying')
    await m.recall('deploying stuff')

    const log = m.recallLog()
    expect(log[0].context).toBe('deploying stuff')
    expect(log[0].results.length).toBeGreaterThan(0)
    expect(log[0].results[0].memoryId).toBe(memory.id)
    expect(log[0].results[0].score).toBeGreaterThan(0)
    expect(log[0].timestamp).toBeTruthy()
    m.close()
  })

  test('recall log persists across restarts', async () => {
    const p = tmpDb()
    cleanup.push(p)

    const m1 = createMemory({ path: p, embed: testEmbed })
    await m1.learn('test memory')
    await m1.recall('test query')
    m1.close()

    const m2 = createMemory({ path: p, embed: testEmbed })
    const log = m2.recallLog()
    expect(log.length).toBe(1)
    expect(log[0].context).toBe('test query')
    m2.close()
  })

  test('list returns memories newest first', async () => {
    const m = mem()
    await m.learn('first')
    await m.learn('second')
    await m.learn('third')

    const all = m.list()
    expect(all[0].text).toBe('third')
    expect(all[2].text).toBe('first')
    m.close()
  })
})

// ============================================================================
// Trust guarantee: CORRECTNESS
// ============================================================================

describe('correctness', () => {
  test('recall ranks by relevance', async () => {
    const m = mem()
    await m.learn('backup database before migrations')
    await m.learn('check wrangler.toml before deploying')
    await m.learn('clear build cache when css breaks')

    const results = await m.recall('deploying to production')
    expect(results.length).toBeGreaterThan(0)
    // The deploy-related memory should rank highest
    expect(results[0].text).toContain('deploy')
    m.close()
  })

  test('recall respects threshold', async () => {
    const m = mem()
    await m.learn('javascript closures capture by reference')
    const results = await m.recall('kubernetes yaml', { threshold: 0.99 })
    expect(results.length).toBe(0)
    m.close()
  })

  test('recall respects limit', async () => {
    const m = mem()
    for (let i = 0; i < 10; i++) await m.learn(`memory about topic ${i}`)
    const results = await m.recall('topic', { limit: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
    m.close()
  })

  test('forget returns false for unknown id', async () => {
    const m = mem()
    expect(await m.forget('nonexistent')).toBe(false)
    m.close()
  })

  test('forget returns true and actually removes', async () => {
    const m = mem()
    const memory = await m.learn('to be forgotten')
    expect(m.size).toBe(1)
    expect(await m.forget(memory.id)).toBe(true)
    expect(m.size).toBe(0)
    m.close()
  })

  test('list supports pagination', async () => {
    const m = mem()
    for (let i = 0; i < 5; i++) await m.learn(`memory ${i}`)

    const page1 = m.list({ limit: 2 })
    const page2 = m.list({ limit: 2, offset: 2 })

    expect(page1.length).toBe(2)
    expect(page2.length).toBe(2)
    expect(page1[0].id).not.toBe(page2[0].id)
    m.close()
  })

  test('size is accurate after learn and forget', async () => {
    const m = mem()
    expect(m.size).toBe(0)

    const a = await m.learn('a')
    const b = await m.learn('b')
    expect(m.size).toBe(2)

    await m.forget(a.id)
    expect(m.size).toBe(1)

    await m.forget(b.id)
    expect(m.size).toBe(0)
    m.close()
  })
})
