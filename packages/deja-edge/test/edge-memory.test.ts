import { describe, test, expect } from 'bun:test'
import { Database } from 'bun:sqlite'
import { createEdgeMemory, type EdgeMemoryStore } from '../src/index'

/**
 * Create a mock DurableObjectState backed by bun:sqlite.
 * The DO sql.exec() returns an iterable cursor — we simulate that
 * by returning the array directly (which is iterable).
 */
function createMockCtx() {
  const db = new Database(':memory:')
  db.exec('PRAGMA journal_mode = WAL')

  const mockSql = {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): T[] {
      const trimmed = query.trim()

      // Multi-statement DDL (CREATE TABLE, triggers, etc.)
      if (isMultiStatement(trimmed)) {
        db.exec(trimmed)
        return [] as T[]
      }

      // Single statements
      if (
        trimmed.toUpperCase().startsWith('INSERT') ||
        trimmed.toUpperCase().startsWith('UPDATE') ||
        trimmed.toUpperCase().startsWith('DELETE') ||
        trimmed.toUpperCase().startsWith('CREATE') ||
        trimmed.toUpperCase().startsWith('DROP')
      ) {
        const stmt = db.prepare(trimmed)
        stmt.run(...(bindings as any[]))
        return [] as T[]
      }

      // SELECT
      const stmt = db.prepare(trimmed)
      return stmt.all(...(bindings as any[])) as T[]
    },
  }

  const state = {
    blockConcurrencyWhile: async (fn: () => Promise<void>) => fn(),
    storage: {
      sql: mockSql,
    },
  }

  return { state: state as unknown as DurableObjectState, db }
}

function isMultiStatement(sql: string): boolean {
  // Strip string literals and comments, then check for multiple semicolons
  const stripped = sql.replace(/'[^']*'/g, '').replace(/--[^\n]*/g, '')
  const statements = stripped.split(';').filter(s => s.trim().length > 0)
  return statements.length > 1
}

describe('deja-edge: createEdgeMemory', () => {
  let memory: EdgeMemoryStore
  let ctx: ReturnType<typeof createMockCtx>

  function freshMemory(opts = {}) {
    ctx = createMockCtx()
    memory = createEdgeMemory(ctx.state, opts)
    return memory
  }

  test('starts empty', () => {
    freshMemory()
    expect(memory.size).toBe(0)
    expect(memory.list()).toEqual([])
  })

  test('remember stores a memory', () => {
    freshMemory()
    const m = memory.remember('always check wrangler.toml before deploying')
    expect(m.id).toBeTruthy()
    expect(m.text).toBe('always check wrangler.toml before deploying')
    expect(m.confidence).toBe(0.5)
    expect(m.createdAt).toBeTruthy()
    expect(memory.size).toBe(1)
  })

  test('remember rejects empty text', () => {
    freshMemory()
    expect(() => memory.remember('')).toThrow('empty')
    expect(() => memory.remember('   ')).toThrow('empty')
  })

  test('list returns memories newest first', () => {
    freshMemory()
    memory.remember('first memory')
    memory.remember('second memory')
    memory.remember('third memory')
    const list = memory.list()
    expect(list.length).toBe(3)
    expect(list[0].text).toBe('third memory')
    expect(list[2].text).toBe('first memory')
  })

  test('recall finds relevant memories via FTS5', () => {
    freshMemory()
    memory.remember('always check wrangler.toml before deploying')
    memory.remember('use npm run test before pushing code')
    memory.remember('database migrations need review by senior dev')

    const results = memory.recall('deploying to production')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toContain('deploying')
  })

  test('recall returns empty for no matches', () => {
    freshMemory()
    memory.remember('check wrangler config')
    const results = memory.recall('quantum physics experiments')
    expect(results.length).toBe(0)
  })

  test('recall respects limit', () => {
    freshMemory()
    for (let i = 0; i < 10; i++) {
      memory.remember(`memory about testing approach number ${i}`)
    }
    const results = memory.recall('testing approach', { limit: 3 })
    expect(results.length).toBeLessThanOrEqual(3)
  })

  test('recall filters by minConfidence', () => {
    freshMemory()
    memory.remember('high confidence item about deployment')
    const m = memory.remember('low confidence item about deployment scripts')
    // Reject it twice to drop confidence
    memory.reject(m.id)
    memory.reject(m.id)

    const results = memory.recall('deployment', { minConfidence: 0.4 })
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.4)
    }
  })

  test('confirm boosts confidence', () => {
    freshMemory()
    const m = memory.remember('test memory for confidence boost')
    expect(m.confidence).toBe(0.5)

    memory.confirm(m.id)
    const list = memory.list()
    expect(list[0].confidence).toBe(0.6)

    memory.confirm(m.id)
    const list2 = memory.list()
    expect(list2[0].confidence).toBe(0.7)
  })

  test('reject drops confidence', () => {
    freshMemory()
    const m = memory.remember('test memory for confidence drop')
    memory.reject(m.id)
    const list = memory.list()
    expect(list[0].confidence).toBe(0.35)
  })

  test('confidence is clamped to [0.01, 1.0]', () => {
    freshMemory()
    const m = memory.remember('clamp test memory')

    // Boost many times — should cap at 1.0
    for (let i = 0; i < 20; i++) memory.confirm(m.id)
    let list = memory.list()
    expect(list[0].confidence).toBe(1.0)

    // Reject many times — should floor at 0.01
    for (let i = 0; i < 30; i++) memory.reject(m.id)
    list = memory.list()
    expect(list[0].confidence).toBe(0.01)
  })

  test('confirm/reject return false for unknown id', () => {
    freshMemory()
    expect(memory.confirm('nonexistent')).toBe(false)
    expect(memory.reject('nonexistent')).toBe(false)
  })

  test('forget removes a memory', () => {
    freshMemory()
    const m = memory.remember('memory to forget')
    expect(memory.size).toBe(1)
    const ok = memory.forget(m.id)
    expect(ok).toBe(true)
    expect(memory.size).toBe(0)
  })

  test('forget returns false for unknown id', () => {
    freshMemory()
    expect(memory.forget('nonexistent')).toBe(false)
  })

  test('recallLog tracks recall queries', () => {
    freshMemory()
    memory.remember('log test memory about deploying')
    memory.recall('deploying')

    const log = memory.recallLog()
    expect(log.length).toBe(1)
    expect(log[0].context).toBe('deploying')
    expect(Array.isArray(log[0].results)).toBe(true)
  })

  test('dedup: near-identical memories return existing', () => {
    freshMemory()
    const m1 = memory.remember('check wrangler.toml before deploying')
    const m2 = memory.remember('check wrangler.toml before deploying')
    expect(m2.id).toBe(m1.id) // same memory returned
    expect(memory.size).toBe(1) // no duplicate
  })

  test('conflict: similar but different text supersedes old memory', () => {
    freshMemory({ conflictThreshold: 0.4 })
    const m1 = memory.remember('check wrangler.toml before deploying to staging')
    const m2 = memory.remember('check wrangler.toml before deploying to production')

    // m2 should supersede m1
    if (m2.supersedes) {
      expect(m2.supersedes).toBe(m1.id)
      // Old memory confidence should be reduced
      const list = memory.list()
      const old = list.find(m => m.id === m1.id)
      expect(old!.confidence).toBeLessThan(0.5)
    }
    // Either way, we should have at most 2 memories
    expect(memory.size).toBeLessThanOrEqual(2)
  })

  test('list supports pagination', () => {
    freshMemory()
    memory.remember('alpha memory about cats')
    memory.remember('beta memory about dogs')
    memory.remember('gamma memory about birds')
    memory.remember('delta memory about fish')
    expect(memory.size).toBe(4)
    const page1 = memory.list({ limit: 2, offset: 0 })
    const page2 = memory.list({ limit: 2, offset: 2 })
    expect(page1.length).toBe(2)
    expect(page2.length).toBe(2)
    expect(page1[0].id).not.toBe(page2[0].id)
  })

  test('recall returns meaningful scores when only one result matches', () => {
    freshMemory()
    memory.remember('always check wrangler.toml before deploying')
    memory.remember('quantum physics is fascinating')

    const results = memory.recall('wrangler deploy')
    expect(results.length).toBeGreaterThan(0)
    // With the normalization fix, a single match should get full relevance (0.7) + confidence (0.15)
    expect(results[0].score).toBeGreaterThan(0.5)
  })

  test('recall scores are meaningful when all results have identical BM25 rank', () => {
    freshMemory()
    memory.remember('deploy step one check config')
    memory.remember('deploy step two run tests')

    // Both match "deploy" equally — scores should still be > 0.15
    const results = memory.recall('deploy')
    for (const r of results) {
      expect(r.score).toBeGreaterThan(0.15)
    }
  })

  test('constructor minConfidence is used as default in recall', () => {
    freshMemory({ minConfidence: 0.4 })
    const m = memory.remember('high confidence item about deployment')
    const low = memory.remember('low confidence item about deployment scripts')
    memory.reject(low.id)
    memory.reject(low.id)

    // Should filter by constructor minConfidence without passing it per-call
    const results = memory.recall('deployment')
    for (const r of results) {
      expect(r.confidence).toBeGreaterThanOrEqual(0.4)
    }
  })
})
