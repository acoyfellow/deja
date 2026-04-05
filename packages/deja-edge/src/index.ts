/**
 * deja-edge — Edge memory for Cloudflare Durable Objects.
 *
 * FTS5-powered full-text search. No Vectorize. No embeddings. Pure text matching at the edge.
 *
 * ```ts
 * // In your Durable Object constructor:
 * import { createEdgeMemory } from 'deja-edge'
 *
 * export class MyDO extends DurableObject {
 *   private memory: EdgeMemoryStore
 *   constructor(ctx: DurableObjectState, env: Env) {
 *     super(ctx, env)
 *     this.memory = createEdgeMemory(ctx)
 *   }
 *
 *   async remember(text: string) { return this.memory.remember(text) }
 *   async recall(context: string) { return this.memory.recall(context) }
 * }
 * ```
 */

import { countTagOverlap, extractEntityTags } from './tagging'

// ============================================================================
// Types
// ============================================================================

export interface Memory {
  id: string
  text: string
  trigger?: string
  learning?: string
  reason?: string
  scope?: string
  tags?: string[]
  assets?: AssetPointer[]
  confidence: number
  supersedes?: string
  createdAt: string
  source?: string
  type: 'memory' | 'anti-pattern'
}

export interface AssetPointer {
  type: string
  ref: string
  label?: string
}

export interface RecallResult {
  id: string
  text: string
  score: number
  confidence: number
  createdAt: string
}

export interface RecallLogEntry {
  id: number
  context: string
  results: Array<{ memoryId: string; score: number }>
  timestamp: string
}

export interface LearningRecord {
  id: string
  text: string
  trigger: string
  learning: string
  tier?: 'trigger' | 'full'
  tags?: string[]
  assets?: AssetPointer[]
  confidence: number
  createdAt: string
  scope: string
  supersedes?: string
  source?: string
  reason?: string
  type: 'memory' | 'anti-pattern'
}

export interface LearnOptions {
  confidence?: number
  scope?: string
  reason?: string
  source?: string
  noveltyThreshold?: number
  assets?: AssetPointer[]
}

export interface InjectOptions extends RecallOptions {
  maxTokens?: number
  format?: 'prompt' | 'learnings'
  search?: 'text'
}

export interface InjectResult {
  prompt: string
  learnings: LearningRecord[]
}

export interface EdgeMemoryStore {
  /** Store a memory. Deduplicates automatically via FTS5 similarity. */
  remember(text: string, options?: { source?: string }): Memory

  /** Find relevant memories via FTS5 full-text search. */
  recall(context: string, options?: RecallOptions): RecallResult[]

  /** Retrieve structured learnings for injection. */
  inject(context: string, options?: InjectOptions): InjectResult

  /** Signal that a recalled memory was useful. Boosts its confidence. */
  confirm(id: string): boolean

  /** Signal that a recalled memory was wrong or outdated. Drops its confidence. */
  reject(id: string): boolean

  /** Remove a memory by id. */
  forget(id: string): boolean

  /** All memories, newest first. */
  list(options?: { limit?: number; offset?: number }): Memory[]

  /** View the recall audit log. */
  recallLog(options?: { limit?: number }): RecallLogEntry[]

  /** How many memories are stored. */
  readonly size: number

  /** @deprecated Use remember() for legacy text-only writes. */
  learn(
    triggerOrText: string,
    learningOrOptions?: string | LearnOptions | { source?: string },
    options?: LearnOptions,
  ): Memory | LearningRecord
}

export interface RecallOptions {
  limit?: number
  /** Minimum BM25 score (lower is better in raw BM25; we negate so higher = better). Default: 0 (return all matches) */
  threshold?: number
  minConfidence?: number
}

export interface CreateEdgeMemoryOptions {
  /** Minimum confidence to return in recall. Default: 0 */
  minConfidence?: number
  /** Similarity threshold for dedup (0-1 via trigram Jaccard). Default: 0.85 */
  dedupeThreshold?: number
  /** Similarity range for conflict detection. Default: 0.5 */
  conflictThreshold?: number
}

// ============================================================================
// Stop words — filtered from FTS5 queries for better matching
// ============================================================================

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'is', 'it', 'as', 'be', 'was', 'are',
  'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did', 'will',
  'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that',
  'these', 'those', 'i', 'you', 'he', 'she', 'we', 'they', 'my', 'me',
  'what', 'how', 'when', 'where', 'which', 'who', 'all', 'about',
  'up', 'out', 'if', 'not', 'no', 'so', 'just', 'get', 'make',
  'full', 'before', 'after', 'every', 'any', 'some',
])

// ============================================================================
// Text utilities
// ============================================================================

/** Extract meaningful keywords from text, filtering stop words */
function extractKeywords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .split(/\s+/)
    .filter(w => w.length > 1 && !STOP_WORDS.has(w))
}

/** Build an FTS5 query from natural language context */
function buildFtsQuery(context: string): string {
  const keywords = extractKeywords(context)
  if (keywords.length === 0) return ''

  // Use OR to match any keyword — FTS5 ranks by relevance automatically
  return keywords.map(k => `"${k}"`).join(' OR ')
}

/** Simple trigram-based Jaccard similarity for dedup/conflict detection */
function trigramSimilarity(a: string, b: string): number {
  const trigramsOf = (s: string): Set<string> => {
    const t = new Set<string>()
    const lower = s.toLowerCase()
    for (let i = 0; i <= lower.length - 3; i++) t.add(lower.slice(i, i + 3))
    return t
  }
  const ta = trigramsOf(a)
  const tb = trigramsOf(b)
  if (ta.size === 0 && tb.size === 0) return 1
  let intersection = 0
  for (const t of ta) if (tb.has(t)) intersection++
  return intersection / (ta.size + tb.size - intersection)
}

// ============================================================================
// Confidence scoring
// ============================================================================

const CONFIDENCE_DEFAULT = 0.5
const CONFIDENCE_BOOST = 0.1
const CONFIDENCE_DECAY = 0.15
const CONFIDENCE_MIN = 0.01
const CONFIDENCE_MAX = 1.0
const HALF_LIFE_DAYS = 90
const ANTI_PATTERN_THRESHOLD = 0.15
const ANTI_PATTERN_PREFIX = 'KNOWN PITFALL: '

/** Strip anti-pattern prefix for dedup/conflict comparison */
function stripAntiPatternPrefix(text: string): string {
  return text.startsWith(ANTI_PATTERN_PREFIX) ? text.slice(ANTI_PATTERN_PREFIX.length) : text
}

function clampConfidence(c: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, Math.round(c * 1000) / 1000))
}

function buildLearningText(trigger: string, learning: string): string {
  return `When ${trigger}, ${stripAntiPatternPrefix(learning)}`
}

function appendDistinctValue(current: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) return current
  if (!current) return incoming
  const existing = current.split('\n').map(value => value.trim()).filter(Boolean)
  return existing.includes(incoming) ? current : `${current}\n${incoming}`
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

function buildLearningPayload(record: LearningRecord, tier: 'trigger' | 'full'): LearningRecord {
  if (tier === 'trigger') {
    return {
      ...record,
      tier,
      learning: '',
      reason: undefined,
      source: undefined,
    }
  }
  return {
    ...record,
    tier,
  }
}

function applyInjectBudget(learnings: LearningRecord[], maxTokens?: number): LearningRecord[] {
  if (!maxTokens || maxTokens <= 0) {
    return learnings.map(learning => buildLearningPayload(learning, 'full'))
  }

  const triggerBudget = Math.floor(maxTokens * 0.3)
  const results = new Map<string, LearningRecord>()
  let triggerTokensUsed = 0

  for (const learning of learnings) {
    const triggerTokens = estimateTokens(learning.trigger)
    if (results.size > 0 && triggerTokensUsed + triggerTokens > triggerBudget) break
    results.set(learning.id, buildLearningPayload(learning, 'trigger'))
    triggerTokensUsed += triggerTokens
  }

  let remainingTokens = maxTokens - triggerTokensUsed
  for (const learning of learnings) {
    if (!results.has(learning.id)) continue
    const fullText = [learning.trigger, learning.learning, learning.reason, learning.source]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n')
    const expansionCost = Math.max(estimateTokens(fullText) - estimateTokens(learning.trigger), 0)
    if (expansionCost > remainingTokens) continue
    results.set(learning.id, buildLearningPayload(learning, 'full'))
    remainingTokens -= expansionCost
  }

  return learnings
    .filter(learning => results.has(learning.id))
    .map(learning => results.get(learning.id) as LearningRecord)
}

// ============================================================================
// ID generation
// ============================================================================

function createId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
}

// ============================================================================
// Schema
// ============================================================================

function initSchema(sql: DurableObjectState['storage']['sql']) {
  sql.exec(`
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      text TEXT NOT NULL,
      trigger TEXT,
      learning TEXT,
      reason TEXT,
      scope TEXT NOT NULL DEFAULT 'shared',
      tags TEXT,
      assets TEXT,
      confidence REAL NOT NULL DEFAULT 0.5,
      supersedes TEXT,
      created_at TEXT NOT NULL,
      last_recalled_at TEXT,
      source TEXT,
      type TEXT NOT NULL DEFAULT 'memory'
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

  // Migration: add missing columns for DOs created before this version
  migrateSchema(sql)
}

function migrateSchema(sql: DurableObjectState['storage']['sql']) {
  // Check which columns exist on the memories table
  const cols = [...sql.exec<{ name: string }>('PRAGMA table_info(memories)')]
  const colNames = new Set(cols.map(c => c.name))
  if (!colNames.has('last_recalled_at')) {
    sql.exec('ALTER TABLE memories ADD COLUMN last_recalled_at TEXT')
  }
  if (!colNames.has('source')) {
    sql.exec('ALTER TABLE memories ADD COLUMN source TEXT')
  }
  if (!colNames.has('type')) {
    sql.exec("ALTER TABLE memories ADD COLUMN type TEXT NOT NULL DEFAULT 'memory'")
  }
  if (!colNames.has('trigger')) {
    sql.exec('ALTER TABLE memories ADD COLUMN trigger TEXT')
  }
  if (!colNames.has('learning')) {
    sql.exec('ALTER TABLE memories ADD COLUMN learning TEXT')
  }
  if (!colNames.has('reason')) {
    sql.exec('ALTER TABLE memories ADD COLUMN reason TEXT')
  }
  if (!colNames.has('scope')) {
    sql.exec("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'shared'")
  }
  if (!colNames.has('assets')) {
    sql.exec('ALTER TABLE memories ADD COLUMN assets TEXT')
  }
  if (!colNames.has('tags')) {
    sql.exec('ALTER TABLE memories ADD COLUMN tags TEXT')
  }
}

// ============================================================================
// createEdgeMemory
// ============================================================================

export function createEdgeMemory(
  ctx: DurableObjectState,
  opts: CreateEdgeMemoryOptions = {},
): EdgeMemoryStore {
  const dedupeThreshold = opts.dedupeThreshold ?? 0.85
  const conflictThreshold = opts.conflictThreshold ?? 0.5
  const defaultMinConfidence = opts.minConfidence ?? 0

  const sql = ctx.storage.sql

  // Initialize schema (idempotent)
  initSchema(sql)

  function toLearningRecord(row: {
    id: string
    text: string
    trigger: string | null
    learning: string | null
    reason: string | null
    scope: string | null
    tags?: string | null
    confidence: number
    supersedes?: string | null
    created_at: string
    source?: string | null
    type: string
  }): LearningRecord {
    return {
      id: row.id,
      text: row.text,
      trigger: row.trigger ?? row.text,
      learning: row.learning ?? row.text,
      confidence: row.confidence,
      createdAt: row.created_at,
      scope: row.scope ?? 'shared',
      tags: row.tags ? JSON.parse(row.tags) : [],
      assets: row.assets ? JSON.parse(row.assets) : [],
      supersedes: row.supersedes ?? undefined,
      source: row.source ?? undefined,
      reason: row.reason ?? undefined,
      type: (row.type as 'memory' | 'anti-pattern') ?? 'memory',
    }
  }

  function remember(text: string, options?: { source?: string }): Memory {
    const trimmed = text.trim()
    if (!trimmed) throw new Error('Memory text cannot be empty')
    const source = options?.source

    // Check for dedup/conflict against existing memories via FTS5
    const keywords = extractKeywords(trimmed)
    if (keywords.length > 0) {
      const ftsQuery = keywords.map(k => `"${k}"`).join(' OR ')
      const candidates = [
        ...sql.exec<{ id: string; text: string; confidence: number; supersedes: string | null; created_at: string; source: string | null; type: string }>(
          `SELECT m.id, m.text, m.confidence, m.supersedes, m.created_at, m.source, m.type
           FROM memories m
           JOIN memories_fts ON memories_fts.rowid = m.rowid
           WHERE memories_fts MATCH ?
           LIMIT 10`,
          ftsQuery,
        ),
      ]

      let bestSim = 0
      let bestCandidate: typeof candidates[0] | null = null
      for (const c of candidates) {
        // Strip anti-pattern prefix so "KNOWN PITFALL: X" still deduplicates against "X"
        const sim = trigramSimilarity(trimmed, stripAntiPatternPrefix(c.text))
        if (sim > bestSim) {
          bestSim = sim
          bestCandidate = c
        }
      }

      // Dedup: near-identical (including anti-pattern matches)
      if (bestCandidate && bestSim >= dedupeThreshold) {
        return {
          id: bestCandidate.id,
          text: bestCandidate.text,
          assets: bestCandidate.assets ? JSON.parse(bestCandidate.assets) : [],
          confidence: bestCandidate.confidence,
          createdAt: bestCandidate.created_at,
          supersedes: bestCandidate.supersedes ?? undefined,
          source: bestCandidate.source ?? undefined,
          type: (bestCandidate.type as 'memory' | 'anti-pattern') ?? 'memory',
        }
      }

      // Conflict: same topic, different content — supersede
      if (bestCandidate && bestSim >= conflictThreshold) {
        const newConf = clampConfidence(bestCandidate.confidence * 0.3)
        sql.exec(`UPDATE memories SET confidence = ? WHERE id = ?`, newConf, bestCandidate.id)

        const id = createId()
        const createdAt = new Date().toISOString()
        const type: 'memory' | 'anti-pattern' = 'memory'
        sql.exec(
          `INSERT INTO memories (id, text, confidence, supersedes, created_at, source, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          id, trimmed, CONFIDENCE_DEFAULT, bestCandidate.id, createdAt, source ?? null, type,
        )
        return { id, text: trimmed, assets: [], confidence: CONFIDENCE_DEFAULT, supersedes: bestCandidate.id, createdAt, source, type }
      }
    }

    // New memory — no dedup or conflict
    const id = createId()
    const createdAt = new Date().toISOString()
    const type: 'memory' | 'anti-pattern' = 'memory'
    sql.exec(
      `INSERT INTO memories (id, text, confidence, supersedes, created_at, source, type) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      id, trimmed, CONFIDENCE_DEFAULT, null, createdAt, source ?? null, type,
    )
    return { id, text: trimmed, assets: [], confidence: CONFIDENCE_DEFAULT, createdAt, source, type }
  }

  function learnStructured(
    trigger: string,
    learning: string,
    options: LearnOptions = {},
  ): LearningRecord {
    const normalizedTrigger = trigger.trim()
    const normalizedLearning = learning.trim()
    const scope = options.scope ?? 'shared'
    const reason = options.reason?.trim() || undefined
    const source = options.source?.trim() || undefined
    const assets = options.assets
    const noveltyThreshold = options.noveltyThreshold ?? 0.95
    const nextConfidence = clampConfidence(options.confidence ?? CONFIDENCE_DEFAULT)
    const text = buildLearningText(normalizedTrigger, normalizedLearning)
    const tags = extractEntityTags(normalizedTrigger, normalizedLearning)
    const keywords = extractKeywords(text)

    if (keywords.length > 0) {
      const ftsQuery = keywords.map(k => `"${k}"`).join(' OR ')
      const candidates = [
        ...sql.exec<{
          id: string
          text: string
          trigger: string | null
          learning: string | null
          reason: string | null
          scope: string | null
          tags: string | null
          confidence: number
          supersedes: string | null
          created_at: string
          source: string | null
          type: string
        }>(
          `SELECT m.id, m.text, m.trigger, m.learning, m.reason, m.scope, m.tags, m.confidence, m.supersedes, m.created_at, m.source, m.type
           FROM memories m
           JOIN memories_fts ON memories_fts.rowid = m.rowid
           WHERE memories_fts MATCH ?
           AND m.scope = ?
           LIMIT 10`,
          ftsQuery,
          scope,
        ),
      ]

      let bestSim = 0
      let bestCandidate: typeof candidates[number] | null = null
      for (const candidate of candidates) {
        const similarity = trigramSimilarity(text, stripAntiPatternPrefix(candidate.text))
        if (similarity > bestSim) {
          bestSim = similarity
          bestCandidate = candidate
        }
      }

      if (
        noveltyThreshold > 0 &&
        bestCandidate &&
        bestCandidate.trigger &&
        bestCandidate.learning &&
        bestSim >= noveltyThreshold
      ) {
        const keepIncomingVersion = nextConfidence > bestCandidate.confidence
        const createdAt = new Date().toISOString()
        const mergedTrigger = keepIncomingVersion ? normalizedTrigger : bestCandidate.trigger
        const mergedLearning = keepIncomingVersion ? normalizedLearning : bestCandidate.learning
        const mergedText = keepIncomingVersion ? text : bestCandidate.text
        const mergedReason = appendDistinctValue(bestCandidate.reason ?? undefined, reason)
        const mergedSource = appendDistinctValue(bestCandidate.source ?? undefined, source)
        const mergedConfidence = Math.max(bestCandidate.confidence, nextConfidence)
        const mergedTags = Array.from(
          new Set([...(bestCandidate.tags ? JSON.parse(bestCandidate.tags) : []), ...tags]),
        )

        sql.exec(
          `UPDATE memories
           SET text = ?, trigger = ?, learning = ?, reason = ?, scope = ?, tags = ?, assets = ?, confidence = ?, created_at = ?, source = ?
           WHERE id = ?`,
          mergedText,
          mergedTrigger,
          mergedLearning,
          mergedReason ?? null,
          scope,
          JSON.stringify(mergedTags),
          JSON.stringify(assets),
          mergedConfidence,
          createdAt,
          mergedSource ?? null,
          bestCandidate.id,
        )

        return {
          id: bestCandidate.id,
          text: mergedText,
          trigger: mergedTrigger,
          learning: mergedLearning,
          confidence: mergedConfidence,
          createdAt,
          scope,
          tags: mergedTags,
          assets,
          supersedes: bestCandidate.supersedes ?? undefined,
          source: mergedSource,
          reason: mergedReason,
          type: (bestCandidate.type as 'memory' | 'anti-pattern') ?? 'memory',
        }
      }

      if (bestCandidate && bestSim >= conflictThreshold) {
        const newConf = clampConfidence(bestCandidate.confidence * 0.3)
        sql.exec(`UPDATE memories SET confidence = ? WHERE id = ?`, newConf, bestCandidate.id)

        const id = createId()
        const createdAt = new Date().toISOString()
        const type: 'memory' | 'anti-pattern' = 'memory'
        sql.exec(
          `INSERT INTO memories (id, text, trigger, learning, reason, scope, tags, assets, confidence, supersedes, created_at, source, type)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id,
          text,
          normalizedTrigger,
          normalizedLearning,
          reason ?? null,
          scope,
          JSON.stringify(tags),
          JSON.stringify(assets),
          nextConfidence,
          bestCandidate.id,
          createdAt,
          source ?? null,
          type,
        )
        return {
          id,
          text,
          trigger: normalizedTrigger,
          learning: normalizedLearning,
          confidence: nextConfidence,
          createdAt,
          scope,
          tags,
          assets,
          supersedes: bestCandidate.id,
          source,
          reason,
          type,
        }
      }
    }

    const id = createId()
    const createdAt = new Date().toISOString()
    const type: 'memory' | 'anti-pattern' = 'memory'
    sql.exec(
      `INSERT INTO memories (id, text, trigger, learning, reason, scope, tags, assets, confidence, supersedes, created_at, source, type)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      text,
      normalizedTrigger,
      normalizedLearning,
      reason ?? null,
      scope,
      JSON.stringify(tags),
      JSON.stringify(assets),
      nextConfidence,
      null,
      createdAt,
      source ?? null,
      type,
    )
    return {
      id,
      text,
      trigger: normalizedTrigger,
      learning: normalizedLearning,
      confidence: nextConfidence,
      createdAt,
      scope,
      tags,
      assets,
      source,
      reason,
      type,
    }
  }

  function recall(context: string, options: RecallOptions = {}): RecallResult[] {
    const limit = options.limit ?? 5
    const minConf = options.minConfidence ?? defaultMinConfidence
    const threshold = options.threshold ?? 0
    const now = new Date().toISOString()
    const nowMs = Date.now()

    const ftsQuery = buildFtsQuery(context)
    if (!ftsQuery) return []

    // FTS5 bm25() returns negative scores (lower = more relevant)
    // We negate to make higher = better, then blend with confidence
    const rows = [
      ...sql.exec<{
        id: string
        text: string
        confidence: number
        created_at: string
        last_recalled_at: string | null
        rank: number
      }>(
        `SELECT m.id, m.text, m.confidence, m.created_at, m.last_recalled_at, bm25(memories_fts) as rank
         FROM memories_fts
         JOIN memories m ON memories_fts.rowid = m.rowid
         WHERE memories_fts MATCH ?
         AND m.confidence >= ?
         ORDER BY rank
         LIMIT ?`,
        ftsQuery, minConf, limit * 3,  // over-fetch then re-rank with confidence
      ),
    ]

    if (rows.length === 0) return []

    // Normalize BM25 scores to 0-1 range, then blend with decayed confidence
    const maxRank = Math.max(...rows.map(r => -r.rank))
    const minRank = Math.min(...rows.map(r => -r.rank))
    const range = maxRank - minRank

    const results: RecallResult[] = rows.map(r => {
      // When all ranks are identical (single result or tied scores), treat as full relevance
      const normalizedRelevance = range === 0 ? 1.0 : (-r.rank - minRank) / range

      // Apply time-based confidence decay at recall time
      const lastActiveAt = r.last_recalled_at ?? r.created_at
      const daysSince = (nowMs - new Date(lastActiveAt).getTime()) / 86400000
      const decayedConfidence = r.confidence * Math.pow(0.5, daysSince / HALF_LIFE_DAYS)

      const blended = normalizedRelevance * 0.7 + decayedConfidence * 0.3
      return {
        id: r.id,
        text: r.text,
        score: Math.round(blended * 1000) / 1000,
        confidence: r.confidence,
        createdAt: r.created_at,
      }
    })

    results.sort((a, b) => b.score - a.score)
    const topResults = results.filter(r => r.score >= threshold).slice(0, limit)

    // Update last_recalled_at for returned results
    for (const r of topResults) {
      sql.exec('UPDATE memories SET last_recalled_at = ? WHERE id = ?', now, r.id)
    }

    // Audit log
    const logData = topResults.map(r => ({ memoryId: r.id, score: r.score }))
    sql.exec(
      `INSERT INTO recall_log (context, results, timestamp) VALUES (?, ?, ?)`,
      context, JSON.stringify(logData), now,
    )

    return topResults
  }

  function inject(context: string, options: InjectOptions = {}): InjectResult {
    const search = options.search ?? 'text'
    if (search !== 'text') {
      throw new Error(`Unsupported edge inject search mode: ${search}`)
    }

    const limit = options.limit ?? 5
    const minConf = options.minConfidence ?? defaultMinConfidence
    const threshold = options.threshold ?? 0
    const now = new Date().toISOString()
    const nowMs = Date.now()
    const ftsQuery = buildFtsQuery(context)
    if (!ftsQuery) return { prompt: '', learnings: [] }

    const rows = [
      ...sql.exec<{
        id: string
        text: string
        trigger: string | null
        learning: string | null
        reason: string | null
        scope: string | null
        tags: string | null
        assets: string | null
        confidence: number
        supersedes: string | null
        created_at: string
        last_recalled_at: string | null
        source: string | null
        type: string
        rank: number
      }>(
        `SELECT m.id, m.text, m.trigger, m.learning, m.reason, m.scope, m.tags, m.assets, m.confidence, m.supersedes, m.created_at, m.last_recalled_at, m.source, m.type, bm25(memories_fts) as rank
         FROM memories_fts
         JOIN memories m ON memories_fts.rowid = m.rowid
         WHERE memories_fts MATCH ?
         AND m.confidence >= ?
         ORDER BY rank
         LIMIT ?`,
        ftsQuery,
        minConf,
        limit * 3,
      ),
    ]

    if (rows.length === 0) return { prompt: '', learnings: [] }

    const maxRank = Math.max(...rows.map(r => -r.rank))
    const minRank = Math.min(...rows.map(r => -r.rank))
    const range = maxRank - minRank

    const scored = rows.map((row) => {
      const normalizedRelevance = range === 0 ? 1.0 : (-row.rank - minRank) / range
      const lastActiveAt = row.last_recalled_at ?? row.created_at
      const daysSince = (nowMs - new Date(lastActiveAt).getTime()) / 86400000
      const decayedConfidence = row.confidence * Math.pow(0.5, daysSince / HALF_LIFE_DAYS)
      const score = normalizedRelevance * 0.7 + decayedConfidence * 0.3
      return {
        ...toLearningRecord(row),
        score: Math.round(score * 1000) / 1000,
      }
    })

    scored.sort((a, b) => b.score - a.score)
    const ranked = scored.filter(row => row.score >= threshold).slice(0, limit)

    for (const learning of ranked) {
      sql.exec('UPDATE memories SET last_recalled_at = ? WHERE id = ?', now, learning.id)
    }

    const payloadLearnings = applyInjectBudget(
      ranked.map(({ score: _, ...learning }) => learning),
      options.maxTokens,
    )
    return {
      prompt: payloadLearnings.map(learning => `When ${learning.trigger}, ${learning.learning}`).join('\n'),
      learnings: payloadLearnings,
    }
  }

  const store: EdgeMemoryStore = {
    get size(): number {
      const row = [...sql.exec<{ count: number }>('SELECT COUNT(*) as count FROM memories')]
      return row[0]?.count ?? 0
    },

    remember,
    recall,
    inject,

    confirm(id: string): boolean {
      const rows = [...sql.exec<{ confidence: number }>('SELECT confidence FROM memories WHERE id = ?', id)]
      if (rows.length === 0) return false
      const newConf = clampConfidence(rows[0].confidence + CONFIDENCE_BOOST)
      sql.exec('UPDATE memories SET confidence = ? WHERE id = ?', newConf, id)
      return true
    },

    reject(id: string): boolean {
      const rows = [...sql.exec<{ confidence: number; type: string }>('SELECT confidence, type FROM memories WHERE id = ?', id)]
      if (rows.length === 0) return false
      let newConf = clampConfidence(rows[0].confidence - CONFIDENCE_DECAY)
      sql.exec('UPDATE memories SET confidence = ? WHERE id = ?', newConf, id)

      // Auto-invert to anti-pattern when confidence drops below threshold
      if (newConf < ANTI_PATTERN_THRESHOLD && rows[0].type !== 'anti-pattern') {
        const textRows = [...sql.exec<{ text: string }>('SELECT text FROM memories WHERE id = ?', id)]
        if (textRows.length > 0) {
          const newText = ANTI_PATTERN_PREFIX + textRows[0].text
          sql.exec('UPDATE memories SET text = ?, type = ?, confidence = ? WHERE id = ?', newText, 'anti-pattern', CONFIDENCE_DEFAULT, id)
        }
      }

      return true
    },

    forget(id: string): boolean {
      const before = store.size
      sql.exec('DELETE FROM memories WHERE id = ?', id)
      return store.size < before
    },

    list(options = {}): Memory[] {
      const limit = options.limit ?? 1000
      const offset = options.offset ?? 0
      return [
        ...sql.exec<{ id: string; text: string; assets: string | null; confidence: number; supersedes: string | null; created_at: string; source: string | null; type: string }>(
          'SELECT id, text, assets, confidence, supersedes, created_at, source, type FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?',
          limit, offset,
        ),
      ].map(r => ({
        id: r.id,
        text: r.text,
        assets: r.assets ? JSON.parse(r.assets) : [],
        confidence: r.confidence,
        supersedes: r.supersedes ?? undefined,
        createdAt: r.created_at,
        source: r.source ?? undefined,
        type: (r.type as 'memory' | 'anti-pattern') ?? 'memory',
      }))
    },

    recallLog(options = {}): RecallLogEntry[] {
      const limit = options.limit ?? 50
      return [
        ...sql.exec<{ id: number; context: string; results: string; timestamp: string }>(
          'SELECT id, context, results, timestamp FROM recall_log ORDER BY timestamp DESC LIMIT ?',
          limit,
        ),
      ].map(r => ({
        id: r.id,
        context: r.context,
        results: JSON.parse(r.results),
        timestamp: r.timestamp,
      }))
    },

    learn(triggerOrText, learningOrOptions, options) {
      if (typeof learningOrOptions === 'string') {
        return learnStructured(triggerOrText, learningOrOptions, options)
      }
      return remember(triggerOrText, learningOrOptions as { source?: string } | undefined)
    },
  }

  return store
}

// ============================================================================
// DejaEdge — class wrapper matching the homepage API
// ============================================================================

type SqlStorage = DurableObjectState['storage']['sql']

/**
 * Class-based API for deja-edge.
 *
 * ```ts
 * import { DejaEdge } from 'deja-edge'
 * // Inside your Durable Object:
 * const mem = new DejaEdge(this.ctx.storage.sql)
 *
 * mem.remember("node 20 breaks esbuild")
 * const hits = mem.recall("deploying")
 * ```
 */
export class DejaEdge implements EdgeMemoryStore {
  private store: EdgeMemoryStore

  constructor(sql: SqlStorage, opts: CreateEdgeMemoryOptions = {}) {
    // Wrap the sql handle in a minimal DurableObjectState shape
    const ctx = { storage: { sql } } as unknown as DurableObjectState
    this.store = createEdgeMemory(ctx, opts)
  }

  remember(text: string, options?: { source?: string }) { return this.store.remember(text, options) }
  recall(context: string, options?: RecallOptions) { return this.store.recall(context, options) }
  confirm(id: string) { return this.store.confirm(id) }
  reject(id: string) { return this.store.reject(id) }
  forget(id: string) { return this.store.forget(id) }
  list(options?: { limit?: number; offset?: number }) { return this.store.list(options) }
  recallLog(options?: { limit?: number }) { return this.store.recallLog(options) }
  get size() { return this.store.size }
}

export default createEdgeMemory
