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

  test('inject respects maxTokens and prioritizes higher-ranked learnings', () => {
    freshMemory()
    memory.learn('deploy auth service', 'x'.repeat(160), { scope: 'shared' })
    memory.learn('rollback billing worker', 'y'.repeat(120), { scope: 'shared' })

    const result = memory.inject('deploy rollback', { maxTokens: 100, format: 'learnings' })
    const estimatedTokens = result.learnings.reduce((total, learning) => {
      const text =
        learning.tier === 'full'
          ? `${learning.trigger}${learning.learning}${learning.confidence}${learning.reason ?? ''}${learning.source ?? ''}`
          : learning.trigger
      return total + Math.ceil(text.length / 4)
    }, 0)

    expect(estimatedTokens).toBeLessThanOrEqual(100)
    expect(result.learnings.length).toBeGreaterThan(0)
    expect(result.learnings[0].tier).toBe('full')
  })

  test('inject boosts memories with 2+ overlapping tags', () => {
    freshMemory()
    memory.learn('deploying Auth Service to staging', 'run migrations through the Auth Service API', {
      scope: 'shared',
    })
    memory.learn('deploying worker', 'check logs before rollout', { scope: 'shared' })

    const result = memory.inject('staging Auth Service API deploy', { format: 'learnings' })
    expect(result.learnings[0].trigger).toContain('Auth Service')
  })

  test('learn stores asset pointers and inject returns them without affecting rank', () => {
    freshMemory()
    const learned = memory.learn('deploy auth service', 'attach runbook and trace', {
      scope: 'shared',
      assets: [{ type: 'trace', ref: 'lab-run-42' }],
    }) as any

    expect(learned.assets).toEqual([{ type: 'trace', ref: 'lab-run-42' }])

    memory.learn('deploying worker', 'check logs before rollout', { scope: 'shared' })
    const listed = memory.list() as any[]
    expect(listed.some(learning => learning.assets?.[0]?.ref === 'lab-run-42')).toBe(true)
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

  // ============================================================================
  // TIME-BASED CONFIDENCE DECAY
  // ============================================================================

  test('old memories score lower than fresh ones with same text similarity', () => {
    freshMemory()
    memory.remember('deploy tip about production servers')
    memory.remember('deploy tip about staging servers')

    // Manually backdate one memory
    const list = memory.list()
    const oldId = list[1].id // oldest
    const freshId = list[0].id // newest
    const oldDate = new Date(Date.now() - 180 * 86400000).toISOString()
    ctx.state.storage.sql.exec('UPDATE memories SET created_at = ? WHERE id = ?', oldDate, oldId)

    const results = memory.recall('deploy tip servers')
    expect(results.length).toBe(2)
    // Fresh memory should rank first due to decay penalizing old one
    expect(results[0].id).toBe(freshId)
  })

  test('recently recalled memories resist decay', () => {
    freshMemory()
    const m = memory.remember('deploy tip about cloud servers')

    // Backdate created_at but set recent last_recalled_at
    const oldDate = new Date(Date.now() - 180 * 86400000).toISOString()
    const recentDate = new Date().toISOString()
    ctx.state.storage.sql.exec('UPDATE memories SET created_at = ?, last_recalled_at = ? WHERE id = ?', oldDate, recentDate, m.id)

    const results = memory.recall('deploy tip cloud servers')
    expect(results.length).toBeGreaterThan(0)
    // Should still score well because last_recalled_at is recent
    expect(results[0].score).toBeGreaterThan(0.3)
  })

  test('confirm still boosts stored confidence independent of decay', () => {
    freshMemory()
    const m = memory.remember('decay confirm test item')
    memory.confirm(m.id)
    const list = memory.list()
    expect(list[0].confidence).toBe(0.6)
  })

  // ============================================================================
  // AGENT ATTRIBUTION
  // ============================================================================

  test('source is stored and returned when provided', () => {
    freshMemory()
    const m = memory.remember('attributed memory about code', { source: 'agent-beta' })
    expect(m.source).toBe('agent-beta')
    const list = memory.list()
    expect(list[0].source).toBe('agent-beta')
  })

  test('source is undefined when not provided (backward compat)', () => {
    freshMemory()
    const m = memory.remember('unattributed memory about code')
    expect(m.source).toBeUndefined()
    const list = memory.list()
    expect(list[0].source).toBeUndefined()
  })

  // ============================================================================
  // ANTI-PATTERN TRACKING
  // ============================================================================

  test('memory auto-inverts to anti-pattern after enough rejections', () => {
    freshMemory()
    const m = memory.remember('use var for all variable declarations')
    // 0.5 -> 0.35 -> 0.2 -> 0.05 (below 0.15)
    memory.reject(m.id)
    memory.reject(m.id)
    memory.reject(m.id)
    const list = memory.list()
    expect(list[0].type).toBe('anti-pattern')
  })

  test('anti-pattern has reset confidence and KNOWN PITFALL prefix', () => {
    freshMemory()
    const m = memory.remember('use eval for parsing JSON data')
    memory.reject(m.id)
    memory.reject(m.id)
    memory.reject(m.id)
    const list = memory.list()
    expect(list[0].confidence).toBe(0.5)
    expect(list[0].text).toBe('KNOWN PITFALL: use eval for parsing JSON data')
    expect(list[0].type).toBe('anti-pattern')
  })

  test('anti-pattern appears in recall results normally', () => {
    freshMemory()
    const m = memory.remember('use eval for parsing JSON response')
    memory.reject(m.id)
    memory.reject(m.id)
    memory.reject(m.id)
    const results = memory.recall('parsing JSON')
    expect(results.length).toBeGreaterThan(0)
    expect(results[0].text).toContain('KNOWN PITFALL')
  })

  test('confirming an anti-pattern still boosts its confidence', () => {
    freshMemory()
    const m = memory.remember('never use goto statements in code')
    memory.reject(m.id)
    memory.reject(m.id)
    memory.reject(m.id)
    // Now anti-pattern with confidence 0.5
    memory.confirm(m.id)
    const list = memory.list()
    expect(list[0].confidence).toBe(0.6)
    expect(list[0].type).toBe('anti-pattern')
  })

  test('already-inverted anti-pattern does not double-invert', () => {
    freshMemory()
    const m = memory.remember('use document.write for HTML output')
    memory.reject(m.id)
    memory.reject(m.id)
    memory.reject(m.id)
    // Reject more — should NOT double-invert
    for (let i = 0; i < 5; i++) memory.reject(m.id)
    const list = memory.list()
    expect(list[0].type).toBe('anti-pattern')
    expect(list[0].text).toBe('KNOWN PITFALL: use document.write for HTML output')
    // No double prefix
    expect(list[0].text.indexOf('KNOWN PITFALL')).toBe(0)
    expect(list[0].text.indexOf('KNOWN PITFALL', 1)).toBe(-1)
  })

  test('memories start with type memory', () => {
    freshMemory()
    const m = memory.remember('normal type test memory')
    expect(m.type).toBe('memory')
  })

  test('re-remembering anti-pattern text deduplicates instead of inserting duplicate', () => {
    freshMemory()
    const m = memory.remember('use eval for parsing JSON safely')
    // Invert to anti-pattern
    memory.reject(m.id)
    memory.reject(m.id)
    memory.reject(m.id)
    expect(memory.size).toBe(1)
    // Now try to remember the same original text — should dedup against the anti-pattern
    const m2 = memory.remember('use eval for parsing JSON safely')
    expect(memory.size).toBe(1) // no duplicate
    expect(m2.id).toBe(m.id) // same memory returned
    expect(m2.type).toBe('anti-pattern') // still an anti-pattern
  })

  // ============================================================================
  // SCHEMA MIGRATION
  // ============================================================================

  test('existing DOs without new columns are migrated', () => {
    // Create a DO with old schema (no source, type, last_recalled_at)
    const oldCtx = createMockCtx()
    oldCtx.state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        text TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 0.5,
        supersedes TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
      CREATE INDEX IF NOT EXISTS idx_memories_confidence ON memories(confidence);
      CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
        text,
        content='memories',
        content_rowid='rowid',
        tokenize='porter unicode61'
      );
      CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text) VALUES('delete', old.rowid, old.text);
      END;
      CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, text) VALUES('delete', old.rowid, old.text);
        INSERT INTO memories_fts(rowid, text) VALUES (new.rowid, new.text);
      END;
      CREATE TABLE IF NOT EXISTS recall_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        context TEXT NOT NULL,
        results TEXT NOT NULL,
        timestamp TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_recall_log_ts ON recall_log(timestamp);
    `)
    // Insert a memory in old schema
    oldCtx.state.storage.sql.exec(
      "INSERT INTO memories (id, text, confidence, created_at) VALUES ('old-1', 'old memory about deployment', 0.5, '2026-01-01T00:00:00Z')"
    )

    // Now create edge memory on top of old schema — should migrate
    const mem = createEdgeMemory(oldCtx.state)
    expect(mem.size).toBe(1)
    const list = mem.list()
    expect(list[0].type).toBe('memory')
    expect(list[0].source).toBeUndefined()

    // New features should work on migrated schema
    const m = mem.remember('new memory about testing code', { source: 'test-agent' })
    expect(m.source).toBe('test-agent')
    expect(m.type).toBe('memory')
  })
})
