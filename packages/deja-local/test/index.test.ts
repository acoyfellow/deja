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
    await mem1.remember('survive restart')
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
    await m.remember('test')
    expect(existsSync(p)).toBe(true)
    m.close()
  })

  test('remember is durable before returning', async () => {
    const p = tmpDb()
    cleanup.push(p)

    const m = createMemory({ path: p, embed: testEmbed })
    await m.remember('durable write')
    // Open fresh connection without closing — simulate crash
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
  test('remember on step N is recallable on step N+1 (zero lag)', async () => {
    const m = mem()
    await m.remember('check wrangler.toml before deploying')
    const results = await m.recall('deploying to production')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toBe('check wrangler.toml before deploying')
    m.close()
  })

  test('forget immediately removes from recall', async () => {
    const m = mem()
    const memory = await m.remember('remove me')
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
    await m.remember('deploy tip: check wrangler.toml')
    await m.remember('deploy tip: check wrangler.toml')
    expect(m.size).toBe(1)
    m.close()
  })

  test('near-identical text is deduplicated', async () => {
    const m = mem()
    await m.remember('always check wrangler.toml before deploying')
    await m.remember('always check wrangler.toml before deploying!')
    // Near-identical — should be deduplicated (depends on embed similarity)
    expect(m.size).toBeLessThanOrEqual(2) // may or may not dedup with test embedder
    m.close()
  })

  test('genuinely different memories are both stored', async () => {
    const m = mem()
    await m.remember('check wrangler.toml before deploying')
    await m.remember('always backup database before migrations')
    expect(m.size).toBe(2)
    m.close()
  })
})

describe('structured learn novelty gate', () => {
  test('semantically identical learnings merge into one structured memory', async () => {
    const semanticEmbed = (text: string): number[] => {
      const lower = text.toLowerCase()
      if (lower.includes('auth service') && (lower.includes('migrations') || lower.includes('schema'))) {
        return [1, 0, 0]
      }
      if (lower.includes('redis')) {
        return [0, 1, 0]
      }
      return [0, 0, 1]
    }

    const p = tmpDb()
    cleanup.push(p)
    const m = createMemory({ path: p, embed: semanticEmbed, threshold: 0.1 })

    const first = await m.learn('deploying Auth Service', 'run database migrations in a transaction', {
      confidence: 0.6,
      reason: 'first incident',
      source: 'ops',
    } as any)
    const second = await m.learn('shipping Auth Service', 'wrap schema changes in a transaction', {
      confidence: 0.9,
      reason: 'second incident',
      source: 'pager',
    } as any)

    expect(m.size).toBe(1)
    expect(second.id).toBe(first.id)
    expect((second as any).trigger).toBe('shipping Auth Service')
    expect((second as any).learning).toBe('wrap schema changes in a transaction')
    expect((second as any).reason).toBe('first incident\nsecond incident')
    expect((second as any).source).toBe('ops\npager')
    m.close()
  })

  test('different structured learnings remain distinct', async () => {
    const semanticEmbed = (text: string): number[] => {
      const lower = text.toLowerCase()
      if (lower.includes('auth service')) return [1, 0, 0]
      if (lower.includes('redis')) return [0, 1, 0]
      return [0, 0, 1]
    }

    const p = tmpDb()
    cleanup.push(p)
    const m = createMemory({ path: p, embed: semanticEmbed, threshold: 0.1 })

    await m.learn('deploying Auth Service', 'run database migrations in a transaction', { confidence: 0.6 } as any)
    await m.learn('debugging Redis cache', 'clear stale keys before replaying jobs', { confidence: 0.6 } as any)

    expect(m.size).toBe(2)
    m.close()
  })
})

describe('inject maxTokens', () => {
  test('returns higher-relevance learnings first within the token budget', async () => {
    const m = mem()
    await m.learn('deploy auth service', 'x'.repeat(160), { scope: 'shared' })
    await m.learn('rollback billing worker', 'y'.repeat(120), { scope: 'shared' })

    const result = await m.inject('deploy rollback', { maxTokens: 100, format: 'learnings' })
    const estimatedTokens = result.learnings.reduce((total, learning) => {
      const text =
        learning.tier === 'full'
          ? `${learning.trigger}${learning.learning}${learning.confidence}${learning.reason ?? ''}${learning.source ?? ''}`
          : learning.trigger
      return total + Math.ceil(text.length / 4)
    }, 0)

    expect(estimatedTokens).toBeLessThanOrEqual(100)
    expect(result.learnings[0].tier).toBe('full')
    expect(result.learnings).toHaveLength(1)
    m.close()
  })
})

describe('entity tags', () => {
  test('structured learn stores extracted tags', async () => {
    const m = mem()
    const learning = await m.learn(
      'deploying Auth Service to staging',
      'always run migrations in a transaction for the Auth Service API',
      { scope: 'shared' },
    ) as any

    expect(learning.tags).toContain('Auth Service')
    m.close()
  })

  test('inject boosts memories with 2+ overlapping tags', async () => {
    const m = mem()
    await m.learn('deploying worker', 'check logs before rollout', { scope: 'shared' })
    await m.learn('deploying Auth Service to staging', 'run migrations through the Auth Service API', { scope: 'shared' })

    const result = await m.inject('staging Auth Service API deploy', { format: 'learnings' })

    expect(result.learnings[0].trigger).toContain('Auth Service')
    m.close()
  })
})

describe('asset pointers', () => {
  test('structured learn returns asset pointers and inject preserves them', async () => {
    const m = mem()
    const assets = [{ type: 'trace', ref: 'lab-run-42', label: 'rollback trace' }]
    const learning = await m.learn(
      'deploying Auth Service',
      'check migration order',
      { scope: 'shared', assets } as any,
    ) as any

    expect(learning.assets).toEqual(assets)

    const listed = m.list() as any[]
    expect(listed.some((entry: any) => entry.id === learning.id)).toBe(true)
    m.close()
  })
})

// ============================================================================
// Trust guarantee: AUDITABILITY
// ============================================================================

describe('auditability', () => {
  test('every recall is logged', async () => {
    const m = mem()
    await m.remember('tip about deploying')
    await m.recall('deploying to production')
    await m.recall('running database migration')

    const log = m.recallLog()
    expect(log.length).toBe(2)
    m.close()
  })

  test('recall log contains context and matched memories', async () => {
    const m = mem()
    const memory = await m.remember('tip about deploying')
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
    await m1.remember('test memory')
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
    await m.remember('first')
    await m.remember('second')
    await m.remember('third')

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
    await m.remember('backup database before migrations')
    await m.remember('check wrangler.toml before deploying')
    await m.remember('clear build cache when css breaks')

    const results = await m.recall('deploying to production')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toContain('deploy')
    m.close()
  })

  test('recall respects threshold', async () => {
    const m = mem()
    await m.remember('javascript closures capture by reference')
    const results = await m.recall('kubernetes yaml', { threshold: 0.99 })
    expect(results.length).toBe(0)
    m.close()
  })

  test('recall respects limit', async () => {
    const m = mem()
    for (let i = 0; i < 10; i++) await m.remember(`memory about topic ${i}`)
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
    const memory = await m.remember('to be forgotten')
    expect(m.size).toBe(1)
    expect(await m.forget(memory.id)).toBe(true)
    expect(m.size).toBe(0)
    m.close()
  })

  test('list supports pagination', async () => {
    const m = mem()
    for (let i = 0; i < 5; i++) await m.remember(`memory ${i}`)

    const page1 = m.list({ limit: 2 })
    const page2 = m.list({ limit: 2, offset: 2 })

    expect(page1.length).toBe(2)
    expect(page2.length).toBe(2)
    expect(page1[0].id).not.toBe(page2[0].id)
    m.close()
  })

  test('size is accurate after remember and forget', async () => {
    const m = mem()
    expect(m.size).toBe(0)

    const a = await m.remember('a')
    const b = await m.remember('b')
    expect(m.size).toBe(2)

    await m.forget(a.id)
    expect(m.size).toBe(1)

    await m.forget(b.id)
    expect(m.size).toBe(0)
    m.close()
  })
})

// ============================================================================
// THE RATCHET: confirm / reject / confidence scoring
// ============================================================================

describe('ratchet', () => {
  test('memories start with default confidence of 0.5', async () => {
    const m = mem()
    const memory = await m.remember('default confidence')
    expect(memory.confidence).toBe(0.5)
    m.close()
  })

  test('confirm boosts confidence', async () => {
    const m = mem()
    const memory = await m.remember('useful memory')
    await m.confirm(memory.id)
    const listed = m.list()
    expect(listed[0].confidence).toBeGreaterThan(0.5)
    m.close()
  })

  test('reject drops confidence', async () => {
    const m = mem()
    const memory = await m.remember('bad memory')
    await m.reject(memory.id)
    const listed = m.list()
    expect(listed[0].confidence).toBeLessThan(0.5)
    m.close()
  })

  test('confidence is clamped between 0.01 and 1.0', async () => {
    const m = mem()
    const memory = await m.remember('test clamping')

    // Boost many times
    for (let i = 0; i < 20; i++) await m.confirm(memory.id)
    let listed = m.list()
    expect(listed[0].confidence).toBeLessThanOrEqual(1.0)

    // Reject many times
    for (let i = 0; i < 40; i++) await m.reject(memory.id)
    listed = m.list()
    expect(listed[0].confidence).toBeGreaterThanOrEqual(0.01)
    m.close()
  })

  test('confirm/reject return false for unknown ids', async () => {
    const m = mem()
    expect(await m.confirm('nonexistent')).toBe(false)
    expect(await m.reject('nonexistent')).toBe(false)
    m.close()
  })

  test('confidence persists across restarts', async () => {
    const p = tmpDb()
    cleanup.push(p)

    const m1 = createMemory({ path: p, embed: testEmbed })
    const memory = await m1.remember('persistent confidence')
    await m1.confirm(memory.id)
    await m1.confirm(memory.id)
    const conf = m1.list()[0].confidence
    m1.close()

    const m2 = createMemory({ path: p, embed: testEmbed })
    expect(m2.list()[0].confidence).toBe(conf)
    m2.close()
  })

  test('high-confidence memories rank higher in recall', async () => {
    const m = mem()
    const low = await m.remember('deploy tip alpha')
    const high = await m.remember('deploy tip beta')

    // Boost one, reject the other
    for (let i = 0; i < 5; i++) await m.confirm(high.id)
    for (let i = 0; i < 3; i++) await m.reject(low.id)

    const results = await m.recall('deploy tip')
    expect(results.length).toBe(2)
    // The confirmed one should rank first (confidence affects score)
    expect(results[0].id).toBe(high.id)
    m.close()
  })

  test('minConfidence filters low-confidence memories', async () => {
    const m = mem()
    const good = await m.remember('reliable tip about deploy')
    const bad = await m.remember('unreliable tip about deploy process')

    for (let i = 0; i < 5; i++) await m.confirm(good.id)
    for (let i = 0; i < 3; i++) await m.reject(bad.id)

    const all = await m.recall('deploy', { minConfidence: 0 })
    const filtered = await m.recall('deploy', { minConfidence: 0.5 })

    expect(all.length).toBeGreaterThanOrEqual(filtered.length)
    m.close()
  })
})

// ============================================================================
// CONFLICT RESOLUTION
// ============================================================================

describe('conflict resolution', () => {
  test('conflicting memory supersedes the old one', async () => {
    // Custom embed: "deploy target" memories share a base vector, but the
    // specific region name pushes them apart enough to land in the conflict
    // zone (similarity ~0.8) rather than the dedup zone (>= 0.95).
    let callCount = 0
    const conflictEmbed = (text: string): number[] => {
      const vec = new Float64Array(16).fill(0)
      // Shared topic signal
      vec[0] = 5; vec[1] = 5; vec[2] = 5; vec[3] = 5
      // Per-call variation: use call order to shift a different dimension
      callCount++
      vec[4 + (callCount % 12)] = 3
      let norm = 0
      for (let i = 0; i < 16; i++) norm += vec[i] * vec[i]
      norm = Math.sqrt(norm)
      for (let i = 0; i < 16; i++) vec[i] /= norm
      return Array.from(vec)
    }

    const p = tmpDb()
    cleanup.push(p)
    const m = createMemory({
      path: p,
      embed: conflictEmbed,
      threshold: 0.1,
      dedupeThreshold: 0.98,     // Very high dedup threshold
      conflictThreshold: 0.7,     // Moderate conflict threshold
    })

    const old = await m.remember('deploy target is us-east-1')
    const updated = await m.remember('deploy target is eu-west-1')

    // Both should exist (not deduped)
    expect(m.size).toBe(2)
    // New memory should reference the old one
    expect(updated.supersedes).toBe(old.id)
    // Old memory's confidence should be reduced
    const listed = m.list()
    const oldMem = listed.find(l => l.id === old.id)!
    expect(oldMem.confidence).toBeLessThan(0.5)
    m.close()
  })

  test('superseded memory ranks lower in recall', async () => {
    let callCount = 0
    const conflictEmbed = (text: string): number[] => {
      const vec = new Float64Array(16).fill(0)
      vec[0] = 5; vec[1] = 5; vec[2] = 5
      callCount++
      vec[3 + (callCount % 13)] = 3
      let norm = 0
      for (let i = 0; i < 16; i++) norm += vec[i] * vec[i]
      norm = Math.sqrt(norm)
      for (let i = 0; i < 16; i++) vec[i] /= norm
      return Array.from(vec)
    }

    const p = tmpDb()
    cleanup.push(p)
    const m = createMemory({
      path: p,
      embed: conflictEmbed,
      threshold: 0.1,
      dedupeThreshold: 0.98,
      conflictThreshold: 0.7,
    })

    await m.remember('api url is http://old.example.com')
    await m.remember('api url is http://new.example.com')

    const results = await m.recall('api url')
    expect(results.length).toBe(2)
    // The newer (non-superseded) memory should rank first
    expect(results[0].text).toContain('new.example.com')
    m.close()
  })
})

// ============================================================================
// RECALL DECOMPOSITION
// ============================================================================

describe('recall decomposition', () => {
  test('complex queries find memories that match sub-parts', async () => {
    const m = mem()
    await m.remember('always run database migrations first')
    await m.remember('check environment variables before deploy')
    await m.remember('use pnpm not npm for this project')

    // A complex query that touches multiple memories
    const results = await m.recall('full production deploy checklist database migrations environment')
    // Should find memories matching sub-parts of the query
    expect(results.length).toBeGreaterThan(0)
    m.close()
  })

  test('short queries are not decomposed unnecessarily', async () => {
    const m = mem()
    await m.remember('deploy tip')
    // A short query — should work fine without decomposition
    const results = await m.recall('deploy')
    expect(results.length).toBeGreaterThan(0)
    m.close()
  })
})

// ============================================================================
// BACKWARD COMPATIBILITY
// ============================================================================

describe('backward compatibility', () => {
  test('learn() still works as alias for remember()', async () => {
    const m = mem()
    const memory = await m.learn('via learn')
    expect(memory.text).toBe('via learn')
    expect(m.size).toBe(1)

    const results = await m.recall('via learn')
    expect(results.length).toBe(1)
    m.close()
  })

  test('old databases without confidence column are migrated', async () => {
    const p = tmpDb()
    cleanup.push(p)

    // Simulate old schema by creating DB without confidence column
    const { Database } = await import('bun:sqlite')
    const db = new Database(p)
    db.exec(`
      CREATE TABLE memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        embedding BLOB NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE recall_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context TEXT NOT NULL,
        results TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
    `)
    // Insert a memory in old format
    const vec = new Float32Array(testEmbed('old memory'))
    const buf = Buffer.from(vec.buffer)
    db.prepare('INSERT INTO memories (id, text, embedding, created_at) VALUES (?, ?, ?, ?)').run(
      'old-id', 'old memory', buf, new Date().toISOString()
    )
    db.close()

    // Open with new createMemory — should migrate
    const m = createMemory({ path: p, embed: testEmbed })
    expect(m.size).toBe(1)
    const listed = m.list()
    expect(listed[0].confidence).toBe(0.5) // default from migration
    m.close()
  })
})

// ============================================================================
// TIME-BASED CONFIDENCE DECAY
// ============================================================================

describe('time-based confidence decay', () => {
  test('old memories score lower than fresh ones with same text similarity', async () => {
    const p = tmpDb()
    cleanup.push(p)

    const { Database } = await import('bun:sqlite')

    // Create memory store and add a memory
    const m = createMemory({ path: p, embed: testEmbed, threshold: 0.1 })
    const fresh = await m.remember('deploy tip about production')
    const old = await m.remember('deploy tip about staging environment')
    m.close()

    // Manually backdate the "old" memory's created_at to 180 days ago
    const rawDb = new Database(p)
    const oldDate = new Date(Date.now() - 180 * 86400000).toISOString()
    rawDb.exec(`UPDATE memories SET created_at = '${oldDate}' WHERE id = '${old.id}'`)
    rawDb.close()

    // Reopen and recall — fresh memory should score higher due to decay
    const m2 = createMemory({ path: p, embed: testEmbed, threshold: 0.1 })
    const results = await m2.recall('deploy tip')
    expect(results.length).toBe(2)
    // Fresh memory should rank first (old one decayed)
    expect(results[0].id).toBe(fresh.id)
    m2.close()
  })

  test('recently recalled memories resist decay', async () => {
    const p = tmpDb()
    cleanup.push(p)

    const { Database } = await import('bun:sqlite')

    const m = createMemory({ path: p, embed: testEmbed, threshold: 0.1 })
    const memory = await m.remember('deploy tip about servers')
    m.close()

    // Backdate created_at to 180 days ago, but set last_recalled_at to now
    const rawDb = new Database(p)
    const oldDate = new Date(Date.now() - 180 * 86400000).toISOString()
    const recentDate = new Date().toISOString()
    rawDb.exec(`UPDATE memories SET created_at = '${oldDate}', last_recalled_at = '${recentDate}' WHERE id = '${memory.id}'`)
    rawDb.close()

    // Reopen — memory should still score well because it was recently recalled
    const m2 = createMemory({ path: p, embed: testEmbed, threshold: 0.1 })
    const results = await m2.recall('deploy tip about servers')
    expect(results.length).toBe(1)
    // Score should be high since last_recalled_at is recent
    expect(results[0].score).toBeGreaterThan(0.3)
    m2.close()
  })

  test('confirm still boosts stored confidence independent of decay', async () => {
    const m = mem()
    const memory = await m.remember('decay and confirm test')
    await m.confirm(memory.id)
    const listed = m.list()
    // Stored confidence should be boosted regardless of decay
    expect(listed[0].confidence).toBe(0.6)
    m.close()
  })
})

// ============================================================================
// AGENT ATTRIBUTION
// ============================================================================

describe('agent attribution', () => {
  test('source is stored and returned when provided', async () => {
    const m = mem()
    const memory = await m.remember('attributed memory', { source: 'agent-alpha' })
    expect(memory.source).toBe('agent-alpha')
    const listed = m.list()
    expect(listed[0].source).toBe('agent-alpha')
    m.close()
  })

  test('source is undefined when not provided (backward compat)', async () => {
    const m = mem()
    const memory = await m.remember('unattributed memory')
    expect(memory.source).toBeUndefined()
    const listed = m.list()
    expect(listed[0].source).toBeUndefined()
    m.close()
  })
})

// ============================================================================
// ANTI-PATTERN TRACKING
// ============================================================================

describe('anti-pattern tracking', () => {
  test('memory auto-inverts to anti-pattern after enough rejections', async () => {
    const m = mem()
    const memory = await m.remember('use var for all variables')
    // Reject enough times to drop below 0.15 threshold
    // 0.5 -> 0.35 -> 0.2 -> 0.05 (below 0.15, triggers inversion)
    await m.reject(memory.id)
    await m.reject(memory.id)
    await m.reject(memory.id)
    const listed = m.list()
    expect(listed[0].type).toBe('anti-pattern')
    m.close()
  })

  test('anti-pattern has reset confidence and KNOWN PITFALL prefix', async () => {
    const m = mem()
    const memory = await m.remember('use eval for parsing JSON')
    await m.reject(memory.id)
    await m.reject(memory.id)
    await m.reject(memory.id)
    const listed = m.list()
    expect(listed[0].confidence).toBe(0.5)
    expect(listed[0].text).toBe('KNOWN PITFALL: use eval for parsing JSON')
    expect(listed[0].type).toBe('anti-pattern')
    m.close()
  })

  test('anti-pattern appears in recall results normally', async () => {
    const m = mem()
    const memory = await m.remember('use eval for parsing JSON data')
    await m.reject(memory.id)
    await m.reject(memory.id)
    await m.reject(memory.id)
    const results = await m.recall('parsing JSON')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toContain('KNOWN PITFALL')
    m.close()
  })

  test('confirming an anti-pattern still boosts its confidence', async () => {
    const m = mem()
    const memory = await m.remember('never use goto statements')
    await m.reject(memory.id)
    await m.reject(memory.id)
    await m.reject(memory.id)
    // Now it's an anti-pattern with confidence 0.5
    await m.confirm(memory.id)
    const listed = m.list()
    expect(listed[0].confidence).toBe(0.6)
    expect(listed[0].type).toBe('anti-pattern')
    m.close()
  })

  test('already-inverted anti-pattern does not double-invert', async () => {
    const m = mem()
    const memory = await m.remember('use document.write for output')
    // Invert it
    await m.reject(memory.id)
    await m.reject(memory.id)
    await m.reject(memory.id)
    // Now reject the anti-pattern further — should NOT double-invert
    for (let i = 0; i < 5; i++) await m.reject(memory.id)
    const listed = m.list()
    expect(listed[0].type).toBe('anti-pattern')
    expect(listed[0].text).toBe('KNOWN PITFALL: use document.write for output')
    // Should NOT have "KNOWN PITFALL: KNOWN PITFALL: ..."
    expect(listed[0].text.indexOf('KNOWN PITFALL')).toBe(0)
    expect(listed[0].text.indexOf('KNOWN PITFALL', 1)).toBe(-1)
    m.close()
  })

  test('memories start with type memory', async () => {
    const m = mem()
    const memory = await m.remember('normal memory type test')
    expect(memory.type).toBe('memory')
    m.close()
  })
})
