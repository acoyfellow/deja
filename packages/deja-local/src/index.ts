/**
 * deja-local — Trusted vector memory for agents.
 *
 * SQLite-backed. Real embeddings. Audit trail. ACID durable.
 *
 * ```ts
 * const mem = await createMemory({ path: './agent-memory.db' })
 * await mem.learn("check wrangler.toml before deploying")
 * const results = await mem.recall("deploying to production")
 * // results[0] = { id, text, score, createdAt }
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
  createdAt: string
}

export interface RecallResult {
  id: string
  text: string
  score: number
  createdAt: string
}

export interface RecallLogEntry {
  id: number
  context: string
  results: Array<{ memoryId: string; score: number }>
  timestamp: string
}

export interface MemoryStore {
  /** Store a memory. Persisted to disk before returning. */
  learn(text: string): Promise<Memory>

  /** Find relevant memories. Every recall is logged for auditing. */
  recall(context: string, options?: { limit?: number; threshold?: number }): Promise<RecallResult[]>

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
// Schema
// ============================================================================

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS memories (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    embedding BLOB NOT NULL,
    created_at TEXT NOT NULL
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

// ============================================================================
// createMemory
// ============================================================================

export function createMemory(opts: CreateMemoryOptions): MemoryStore {
  const embed = opts.embed ?? createModelEmbed(opts.model ?? 'Xenova/all-MiniLM-L6-v2')
  const threshold = opts.threshold ?? 0.3
  const dedupeThreshold = opts.dedupeThreshold ?? 0.95

  // Open database, enable WAL mode, create schema
  const db = new Database(opts.path)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = NORMAL')
  db.exec(SCHEMA)

  // Prepared statements
  const insertMemory = db.prepare(
    'INSERT INTO memories (id, text, embedding, created_at) VALUES (?, ?, ?, ?)'
  )
  const deleteMemory = db.prepare('DELETE FROM memories WHERE id = ?')
  const selectAll = db.prepare('SELECT id, text, embedding, created_at FROM memories')
  const countMemories = db.prepare('SELECT COUNT(*) as count FROM memories')
  const insertRecall = db.prepare(
    'INSERT INTO recall_log (context, results, timestamp) VALUES (?, ?, ?)'
  )

  // In-memory vector index — loaded from DB on startup
  interface IndexEntry { id: string; text: string; vec: number[]; createdAt: string }
  const index: IndexEntry[] = []

  // Load existing memories into index
  for (const row of selectAll.all() as Array<{ id: string; text: string; embedding: Buffer; created_at: string }>) {
    index.push({
      id: row.id,
      text: row.text,
      vec: bufferToVec(row.embedding),
      createdAt: row.created_at,
    })
  }

  return {
    get size() { return (countMemories.get() as { count: number }).count },

    async learn(text) {
      const vec = await embed(text)

      // Deduplication: if a near-identical memory exists, skip
      for (const entry of index) {
        if (cosine(vec, entry.vec) >= dedupeThreshold) {
          return { id: entry.id, text: entry.text, createdAt: entry.createdAt }
        }
      }

      const id = crypto.randomUUID()
      const createdAt = new Date().toISOString()
      const buf = vecToBuffer(vec)

      insertMemory.run(id, text, buf, createdAt)
      index.push({ id, text, vec, createdAt })

      return { id, text, createdAt }
    },

    async recall(context, options = {}) {
      const qv = await embed(context)
      const limit = options.limit ?? 5
      const min = options.threshold ?? threshold

      const scored: RecallResult[] = []
      for (const entry of index) {
        const score = cosine(qv, entry.vec)
        if (score >= min) {
          scored.push({ id: entry.id, text: entry.text, score, createdAt: entry.createdAt })
        }
      }
      scored.sort((a, b) => b.score - a.score)
      const results = scored.slice(0, limit)

      // Audit: log every recall
      const now = new Date().toISOString()
      const logData = results.map(r => ({ memoryId: r.id, score: Math.round(r.score * 1000) / 1000 }))
      insertRecall.run(context, JSON.stringify(logData), now)

      return results
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
        'SELECT id, text, created_at FROM memories ORDER BY created_at DESC LIMIT ? OFFSET ?'
      ).all(limit, offset) as Array<{ id: string; text: string; created_at: string }>
      return rows.map(r => ({ id: r.id, text: r.text, createdAt: r.created_at }))
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
  }
}

export { createModelEmbed }
export default createMemory
