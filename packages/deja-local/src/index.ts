/**
 * deja-local — Trusted vector memory for agents.
 *
 * SQLite-backed. Real embeddings. Audit trail. ACID durable.
 *
 * ```ts
 * const mem = await createMemory({ path: './agent-memory.db' })
 * await mem.remember("check wrangler.toml before deploying")
 * const results = await mem.recall("deploying to production")
 * // results[0] = { id, text, score, confidence, createdAt }
 * ```
 */

import { Database } from 'bun:sqlite'
import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

// ============================================================================
// Types
// ============================================================================

export type EmbedFn = (text: string) => number[] | Promise<number[]>

export interface Memory {
  id: string
  text: string
  confidence: number
  createdAt: string
  supersedes?: string
  source?: string
  type: 'memory' | 'anti-pattern'
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

export interface MemoryStore {
  /** Store a memory. Deduplicates and resolves conflicts automatically. */
  remember(text: string, options?: { source?: string }): Promise<Memory>

  /** Find relevant memories. Decomposes complex queries for better recall. */
  recall(context: string, options?: { limit?: number; threshold?: number; minConfidence?: number }): Promise<RecallResult[]>

  /** Signal that a recalled memory was useful. Boosts its confidence. */
  confirm(id: string): Promise<boolean>

  /** Signal that a recalled memory was wrong or outdated. Drops its confidence. */
  reject(id: string): Promise<boolean>

  /** Remove a memory by id. */
  forget(id: string): Promise<boolean>

  /** All memories, newest first. */
  list(options?: { limit?: number; offset?: number }): Memory[]

  /** View the recall audit log. See what the agent recalled and when. */
  recallLog(options?: { limit?: number }): RecallLogEntry[]

  /** How many memories are stored. */
  readonly size: number

  /** Close the database connection. */
  close(): void

  // Backward compat
  /** @deprecated Use remember() */
  learn(text: string, options?: { source?: string }): Promise<Memory>
}

export interface CreateMemoryOptions {
  /** Path to SQLite database file. Required — memory is always durable. */
  path: string
  /** Embedding function. Default: all-MiniLM-L6-v2 via ONNX (~23MB, cached locally). */
  embed?: EmbedFn
  /** HuggingFace model ID. Default: 'Xenova/all-MiniLM-L6-v2' */
  model?: string
  /** Minimum similarity score for recall. Default: 0.3 */
  threshold?: number
  /** Similarity threshold for deduplication. Default: 0.95 */
  dedupeThreshold?: number
  /** Similarity range for conflict detection. Default: [0.6, 0.95) */
  conflictThreshold?: number
}

// ============================================================================
// Embeddings
// ============================================================================

function createModelEmbed(modelId: string): EmbedFn {
  let extractor: FeatureExtractionPipeline | null = null
  return async (text: string): Promise<number[]> => {
    if (!extractor) {
      // @ts-expect-error - pipeline() union type too complex for TS, runtime works fine
      extractor = await pipeline('feature-extraction', modelId, { dtype: 'fp32' })
    }
    const output = await extractor!(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data as Float32Array)
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

// ============================================================================
// Vector serialization — Float32Array ↔ Buffer
// ============================================================================

function vecToBuffer(vec: number[]): Buffer {
  const f32 = new Float32Array(vec)
  return Buffer.from(f32.buffer)
}

function bufferToVec(buf: Buffer): number[] {
  const f32 = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4)
  return Array.from(f32)
}

// ============================================================================
// Recall decomposition — extract meaningful sub-queries from a complex query
// ============================================================================

/** Stop words to filter out when extracting keywords */
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

/**
 * Extract keyword sub-queries from a complex query.
 * Returns the original query plus sub-queries if the query is complex enough.
 */
function decomposeQuery(context: string): string[] {
  const queries = [context]

  // Split into words, filter stop words, keep meaningful terms
  const words = context.toLowerCase().replace(/[^a-z0-9\s-]/g, '').split(/\s+/)
  const keywords = words.filter(w => w.length > 2 && !STOP_WORDS.has(w))

  // Only decompose if there are enough distinct keywords
  if (keywords.length >= 3) {
    // Build 2-word phrases from adjacent keywords
    for (let i = 0; i < keywords.length - 1; i++) {
      queries.push(`${keywords[i]} ${keywords[i + 1]}`)
    }
    // Also add individual keywords as sub-queries
    for (const kw of keywords) {
      queries.push(kw)
    }
  }

  return queries
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

function clampConfidence(c: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, Math.round(c * 1000) / 1000))
}

// ============================================================================
// Schema
// ============================================================================

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    confidence REAL NOT NULL DEFAULT 0.5,
    supersedes TEXT,
    created_at TEXT NOT NULL,
    last_recalled_at TEXT,
    source TEXT,
    type TEXT NOT NULL DEFAULT 'memory'
  );

  CREATE TABLE IF NOT EXISTS recall_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    context TEXT NOT NULL,
    results TEXT NOT NULL,
    timestamp TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_memories_created ON memories(created_at);
  CREATE INDEX IF NOT EXISTS idx_recall_log_ts ON recall_log(timestamp);
`

// Migration: add missing columns for DBs created before this version
function migrateSchema(db: Database) {
  const cols = db.prepare("PRAGMA table_info(memories)").all() as Array<{ name: string }>
  const colNames = new Set(cols.map(c => c.name))
  if (!colNames.has('confidence')) {
    db.exec(`ALTER TABLE memories ADD COLUMN confidence REAL NOT NULL DEFAULT ${CONFIDENCE_DEFAULT}`)
  }
  if (!colNames.has('supersedes')) {
    db.exec('ALTER TABLE memories ADD COLUMN supersedes TEXT')
  }
  if (!colNames.has('last_recalled_at')) {
    db.exec('ALTER TABLE memories ADD COLUMN last_recalled_at TEXT')
  }
  if (!colNames.has('source')) {
    db.exec('ALTER TABLE memories ADD COLUMN source TEXT')
  }
  if (!colNames.has('type')) {
    db.exec("ALTER TABLE memories ADD COLUMN type TEXT NOT NULL DEFAULT 'memory'")
  }
}

// ============================================================================
// createMemory
// ============================================================================

export function createMemory(opts: CreateMemoryOptions): MemoryStore {
  const embed = opts.embed ?? createModelEmbed(opts.model ?? 'Xenova/all-MiniLM-L6-v2')
  const threshold = opts.threshold ?? 0.3
  const dedupeThreshold = opts.dedupeThreshold ?? 0.95
  const conflictThreshold = opts.conflictThreshold ?? 0.6

  // Open database, enable WAL mode, create schema
  const db = new Database(opts.path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec(SCHEMA)
  migrateSchema(db)

  // Prepared statements
  const insertMemory = db.prepare(
    'INSERT INTO memories (id, text, embedding, confidence, supersedes, created_at, source, type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  )
  const deleteMemory = db.prepare('DELETE FROM memories WHERE id = ?')
  const updateConfidence = db.prepare('UPDATE memories SET confidence = ? WHERE id = ?')
  const updateLastRecalledAt = db.prepare('UPDATE memories SET last_recalled_at = ? WHERE id = ?')
  const updateMemoryTextAndType = db.prepare('UPDATE memories SET text = ?, type = ?, confidence = ? WHERE id = ?')
  const selectAll = db.prepare('SELECT id, text, embedding, confidence, supersedes, created_at, last_recalled_at, source, type FROM memories')
  const countMemories = db.prepare('SELECT COUNT(*) as count FROM memories')
  const insertRecall = db.prepare(
    'INSERT INTO recall_log (context, results, timestamp) VALUES (?, ?, ?)'
  )

  // In-memory vector index — loaded from DB on startup
  interface IndexEntry { id: string; text: string; vec: number[]; confidence: number; supersedes?: string; createdAt: string; lastRecalledAt?: string; source?: string; type: 'memory' | 'anti-pattern' }
  const index: IndexEntry[] = []

  // Load existing memories into index
  for (const row of selectAll.all() as Array<{ id: string; text: string; embedding: Buffer; confidence: number; supersedes: string | null; created_at: string; last_recalled_at: string | null; source: string | null; type: string }>) {
    index.push({
      id: row.id,
      text: row.text,
      vec: bufferToVec(row.embedding),
      confidence: row.confidence,
      supersedes: row.supersedes ?? undefined,
      createdAt: row.created_at,
      lastRecalledAt: row.last_recalled_at ?? undefined,
      source: row.source ?? undefined,
      type: (row.type as 'memory' | 'anti-pattern') ?? 'memory',
    })
  }

  async function remember(text: string, options?: { source?: string }): Promise<Memory> {
    const vec = await embed(text)
    const source = options?.source

    // Scan for dedup or conflict
    let bestSimilarity = 0
    let bestEntry: IndexEntry | null = null

    for (const entry of index) {
      const sim = cosine(vec, entry.vec)
      if (sim > bestSimilarity) {
        bestSimilarity = sim
        bestEntry = entry
      }
    }

    // Dedup: near-identical memory exists, skip
    if (bestEntry && bestSimilarity >= dedupeThreshold) {
      return { id: bestEntry.id, text: bestEntry.text, confidence: bestEntry.confidence, createdAt: bestEntry.createdAt, source: bestEntry.source, type: bestEntry.type }
    }

    // Conflict: same topic, different content — supersede the old memory
    let supersedes: string | undefined
    if (bestEntry && bestSimilarity >= conflictThreshold) {
      supersedes = bestEntry.id
      // Drop the old memory's confidence — it's been superseded
      const newConf = clampConfidence(bestEntry.confidence * 0.3)
      updateConfidence.run(newConf, bestEntry.id)
      bestEntry.confidence = newConf
    }

    const id = crypto.randomUUID()
    const createdAt = new Date().toISOString()
    const confidence = CONFIDENCE_DEFAULT
    const buf = vecToBuffer(vec)
    const type: 'memory' | 'anti-pattern' = 'memory'

    insertMemory.run(id, text, buf, confidence, supersedes ?? null, createdAt, source ?? null, type)
    index.push({ id, text, vec, confidence, supersedes, createdAt, source, type })

    return { id, text, confidence, createdAt, supersedes, source, type }
  }

  async function recall(context: string, options: { limit?: number; threshold?: number; minConfidence?: number } = {}): Promise<RecallResult[]> {
    const limit = options.limit ?? 5
    const min = options.threshold ?? threshold
    const minConf = options.minConfidence ?? 0
    const now = new Date().toISOString()
    const nowMs = Date.now()

    // Decompose complex queries into sub-queries
    const subQueries = decomposeQuery(context)
    const subVecs = await Promise.all(subQueries.map(q => embed(q)))

    // Score each memory against all sub-queries, take best match
    const scoreMap = new Map<string, RecallResult>()

    for (const entry of index) {
      if (entry.confidence < minConf) continue

      let bestScore = 0
      for (const qv of subVecs) {
        const sim = cosine(qv, entry.vec)
        if (sim > bestScore) bestScore = sim
      }

      if (bestScore >= min) {
        // Apply time-based confidence decay at recall time
        const lastActiveAt = entry.lastRecalledAt ?? entry.createdAt
        const daysSince = (nowMs - new Date(lastActiveAt).getTime()) / 86400000
        const decayedConfidence = entry.confidence * Math.pow(0.5, daysSince / HALF_LIFE_DAYS)

        // Blend relevance with decayed confidence: 70% relevance, 30% confidence
        const blended = bestScore * 0.7 + decayedConfidence * 0.3
        const existing = scoreMap.get(entry.id)
        if (!existing || existing.score < blended) {
          scoreMap.set(entry.id, {
            id: entry.id,
            text: entry.text,
            score: Math.round(blended * 1000) / 1000,
            confidence: entry.confidence,
            createdAt: entry.createdAt,
          })
        }
      }
    }

    const results = Array.from(scoreMap.values())
    results.sort((a, b) => b.score - a.score)
    const topResults = results.slice(0, limit)

    // Update last_recalled_at for returned results
    for (const r of topResults) {
      updateLastRecalledAt.run(now, r.id)
      const entry = index.find(e => e.id === r.id)
      if (entry) entry.lastRecalledAt = now
    }

    // Audit: log every recall
    const logData = topResults.map(r => ({ memoryId: r.id, score: r.score }))
    insertRecall.run(context, JSON.stringify(logData), now)

    return topResults
  }

  const store: MemoryStore = {
    get size() { return (countMemories.get() as { count: number }).count },

    remember,

    recall,

    async confirm(id) {
      const entry = index.find(e => e.id === id)
      if (!entry) return false
      entry.confidence = clampConfidence(entry.confidence + CONFIDENCE_BOOST)
      updateConfidence.run(entry.confidence, id)
      return true
    },

    async reject(id) {
      const entry = index.find(e => e.id === id)
      if (!entry) return false
      entry.confidence = clampConfidence(entry.confidence - CONFIDENCE_DECAY)
      updateConfidence.run(entry.confidence, id)

      // Auto-invert to anti-pattern when confidence drops below threshold
      if (entry.confidence < ANTI_PATTERN_THRESHOLD && entry.type !== 'anti-pattern') {
        entry.type = 'anti-pattern'
        entry.confidence = CONFIDENCE_DEFAULT
        entry.text = 'KNOWN PITFALL: ' + entry.text
        updateMemoryTextAndType.run(entry.text, entry.type, entry.confidence, id)
      }

      return true
    },

    async forget(id) {
      const changes = deleteMemory.run(id).changes
      if (changes > 0) {
        const idx = index.findIndex(e => e.id === id)
        if (idx >= 0) index.splice(idx, 1)
        return true
      }
      return false
    },

    list(options = {}) {
      const limit = options.limit ?? 1000
      const offset = options.offset ?? 0
      const rows = db.prepare(
        'SELECT id, text, confidence, supersedes, created_at, source, type FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(limit, offset) as Array<{ id: string; text: string; confidence: number; supersedes: string | null; created_at: string; source: string | null; type: string }>
      return rows.map(r => ({ id: r.id, text: r.text, confidence: r.confidence, supersedes: r.supersedes ?? undefined, createdAt: r.created_at, source: r.source ?? undefined, type: (r.type as 'memory' | 'anti-pattern') ?? 'memory' }))
    },

    recallLog(options = {}) {
      const limit = options.limit ?? 50
      const rows = db.prepare(
        'SELECT id, context, results, timestamp FROM recall_log ORDER BY timestamp DESC LIMIT ?'
      ).all(limit) as Array<{ id: number; context: string; results: string; timestamp: string }>
      return rows.map(r => ({
        id: r.id,
        context: r.context,
        results: JSON.parse(r.results),
        timestamp: r.timestamp,
      }))
    },

    close() { db.close() },

    // Backward compat
    learn: remember,
  }

  return store
}

// ============================================================================
// DejaLocal — class wrapper matching the homepage API
// ============================================================================

/**
 * Class-based API for deja-local.
 *
 * ```ts
 * import { DejaLocal } from 'deja-local'
 * const mem = new DejaLocal('./memories.db')
 *
 * await mem.remember("node 20 breaks esbuild")
 * const hits = await mem.recall("deploying")
 * ```
 */
export class DejaLocal implements MemoryStore {
  private store: MemoryStore

  constructor(path: string, opts: Omit<CreateMemoryOptions, 'path'> = {}) {
    this.store = createMemory({ ...opts, path })
  }

  remember(text: string, options?: { source?: string }) { return this.store.remember(text, options) }
  recall(context: string, options?: Parameters<MemoryStore['recall']>[1]) { return this.store.recall(context, options) }
  confirm(id: string) { return this.store.confirm(id) }
  reject(id: string) { return this.store.reject(id) }
  forget(id: string) { return this.store.forget(id) }
  list(options?: Parameters<MemoryStore['list']>[0]) { return this.store.list(options) }
  recallLog(options?: Parameters<MemoryStore['recallLog']>[0]) { return this.store.recallLog(options) }
  get size() { return this.store.size }
  close() { return this.store.close() }
  /** @deprecated Use remember() */
  learn(text: string, options?: { source?: string }) { return this.store.learn(text, options) }
}

export { createModelEmbed }
export default createMemory
