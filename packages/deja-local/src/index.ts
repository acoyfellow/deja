/**
 * deja-local — Local in-process vector memory for agents
 *
 * Zero network calls. Zero eventual consistency. Instant recall.
 *
 * @example
 * ```ts
 * import { dejaLocal } from 'deja-local'
 *
 * const mem = dejaLocal()
 *
 * // Immediately available — no waiting
 * await mem.learn('deploy failed', 'check wrangler.toml first')
 * const { learnings } = await mem.inject('deploying to production')
 * // learnings[0].learning === 'check wrangler.toml first'
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export interface Learning {
  id: string
  trigger: string
  learning: string
  reason?: string
  confidence: number
  source?: string
  scope: string
  createdAt: string
  recallCount: number
  lastRecalledAt?: string
}

export interface InjectResult {
  prompt: string
  learnings: Learning[]
}

export interface QueryResult {
  learnings: Learning[]
  scores: Map<string, number>
}

export interface Stats {
  totalLearnings: number
  scopes: Record<string, number>
  dimensions: number
}

export interface LearnOptions {
  confidence?: number
  scope?: string
  reason?: string
  source?: string
}

export interface InjectOptions {
  scopes?: string[]
  limit?: number
  threshold?: number
}

export interface QueryOptions {
  scopes?: string[]
  limit?: number
  threshold?: number
}

export interface ListOptions {
  scope?: string
  limit?: number
}

/** A function that turns text into a vector */
export type EmbedFn = (text: string) => number[] | Promise<number[]>

export interface DejaLocalOptions {
  /** Custom embedding function. Default: built-in character n-gram hasher (384 dims, no deps) */
  embed?: EmbedFn
  /** Path to persist memory as JSON. Default: in-memory only */
  persistPath?: string
  /** Auto-save after every learn/forget. Default: true (only if persistPath set) */
  autoSave?: boolean
  /** Minimum similarity threshold for recall. Default: 0.1 */
  threshold?: number
  /** Vector dimensions (only used for built-in embedder). Default: 384 */
  dimensions?: number
}

interface StoredEntry {
  learning: Learning
  embedding: number[]
}

// ============================================================================
// Built-in embedder: character n-gram hash projection
//
// No dependencies. No model loading. ~0.1ms per embed.
// Quality is "good enough" for short trigger/learning text.
// For better quality, pass in an OpenAI/Anthropic/local model embed function.
// ============================================================================

function builtinEmbed(dimensions: number): EmbedFn {
  return (text: string): number[] => {
    const vec = new Float64Array(dimensions)
    const lower = text.toLowerCase()

    // Character trigrams + bigrams + words
    const ngrams: string[] = []
    for (let i = 0; i < lower.length - 1; i++) {
      ngrams.push(lower.slice(i, i + 2)) // bigrams
      if (i < lower.length - 2) {
        ngrams.push(lower.slice(i, i + 3)) // trigrams
      }
    }
    // Word unigrams
    for (const word of lower.split(/\s+/)) {
      if (word.length > 0) ngrams.push(`w:${word}`)
    }

    // Hash each n-gram to a position and accumulate
    for (const ng of ngrams) {
      const h = fnv1a(ng)
      const idx = ((h >>> 0) % dimensions)
      // Use sign bit for +1/-1 projection (simulates random hyperplane)
      vec[idx] += (h & 1) ? 1 : -1
    }

    // L2 normalize
    let norm = 0
    for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm)
    if (norm > 0) {
      for (let i = 0; i < dimensions; i++) vec[i] /= norm
    }

    return Array.from(vec)
  }
}

/** FNV-1a hash for strings — fast, good distribution */
function fnv1a(str: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB)
  return denom === 0 ? 0 : dot / denom
}

function genId(): string {
  return Math.random().toString(36).slice(2) + Date.now().toString(36)
}

// ============================================================================
// Persistence helpers
// ============================================================================

interface Snapshot {
  version: 1
  entries: Array<{ learning: Learning; embedding: number[] }>
}

async function loadFromFile(path: string): Promise<StoredEntry[]> {
  try {
    const raw = await (await import('fs')).promises.readFile(path, 'utf-8')
    const snap: Snapshot = JSON.parse(raw)
    if (snap.version !== 1) return []
    return snap.entries
  } catch {
    return []
  }
}

async function saveToFile(path: string, entries: StoredEntry[]): Promise<void> {
  const snap: Snapshot = { version: 1, entries }
  const fs = await import('fs')
  await fs.promises.writeFile(path, JSON.stringify(snap), 'utf-8')
}

// ============================================================================
// DejaLocal client
// ============================================================================

export interface DejaLocalClient {
  learn(trigger: string, learning: string, options?: LearnOptions): Promise<Learning>
  inject(context: string, options?: InjectOptions): Promise<InjectResult>
  query(text: string, options?: QueryOptions): Promise<QueryResult>
  list(options?: ListOptions): Promise<Learning[]>
  forget(id: string): Promise<{ success: boolean }>
  stats(): Promise<Stats>

  /** Save to disk (only if persistPath was set) */
  save(): Promise<void>
  /** Load from disk (only if persistPath was set) */
  load(): Promise<void>
  /** Clear all memories */
  clear(): void

  /** Number of stored memories */
  readonly size: number
}

export function dejaLocal(opts: DejaLocalOptions = {}): DejaLocalClient {
  const dimensions = opts.dimensions ?? 384
  const embedFn = opts.embed ?? builtinEmbed(dimensions)
  const defaultThreshold = opts.threshold ?? 0.1
  const persistPath = opts.persistPath
  const autoSave = opts.autoSave ?? true

  let entries: StoredEntry[] = []

  const maybeSave = async () => {
    if (persistPath && autoSave) await saveToFile(persistPath, entries)
  }

  return {
    get size() {
      return entries.length
    },

    async learn(trigger, learning, options = {}) {
      const embedding = await embedFn(`${trigger} ${learning}`)
      const entry: Learning = {
        id: genId(),
        trigger,
        learning,
        reason: options.reason,
        confidence: options.confidence ?? 0.8,
        source: options.source,
        scope: options.scope ?? 'shared',
        createdAt: new Date().toISOString(),
        recallCount: 0,
      }
      entries.push({ learning: entry, embedding })
      await maybeSave()
      return entry
    },

    async inject(context, options = {}) {
      const limit = options.limit ?? 5
      const threshold = options.threshold ?? defaultThreshold
      const scopes = options.scopes

      const queryVec = await embedFn(context)
      const scored: Array<{ entry: StoredEntry; score: number }> = []

      for (const entry of entries) {
        if (scopes && scopes.length > 0 && !scopes.includes(entry.learning.scope)) continue
        const score = cosine(queryVec, entry.embedding)
        if (score >= threshold) {
          scored.push({ entry, score })
        }
      }

      scored.sort((a, b) => b.score - a.score)
      const top = scored.slice(0, limit)

      // Update recall stats
      const now = new Date().toISOString()
      for (const { entry } of top) {
        entry.learning.recallCount++
        entry.learning.lastRecalledAt = now
      }

      const learnings = top.map(s => s.entry.learning)
      const prompt = learnings.length > 0
        ? learnings.map(l => `When ${l.trigger}, ${l.learning}`).join('\n')
        : ''

      return { prompt, learnings }
    },

    async query(text, options = {}) {
      const limit = options.limit ?? 10
      const threshold = options.threshold ?? defaultThreshold
      const scopes = options.scopes

      const queryVec = await embedFn(text)
      const scored: Array<{ entry: StoredEntry; score: number }> = []

      for (const entry of entries) {
        if (scopes && scopes.length > 0 && !scopes.includes(entry.learning.scope)) continue
        const score = cosine(queryVec, entry.embedding)
        if (score >= threshold) {
          scored.push({ entry, score })
        }
      }

      scored.sort((a, b) => b.score - a.score)
      const top = scored.slice(0, limit)
      const learnings = top.map(s => s.entry.learning)
      const scores = new Map(top.map(s => [s.entry.learning.id, s.score]))

      return { learnings, scores }
    },

    async list(options = {}) {
      let result = entries.map(e => e.learning)
      if (options.scope) {
        result = result.filter(l => l.scope === options.scope)
      }
      if (options.limit) {
        result = result.slice(0, options.limit)
      }
      return result
    },

    async forget(id) {
      const before = entries.length
      entries = entries.filter(e => e.learning.id !== id)
      if (entries.length < before) {
        await maybeSave()
        return { success: true }
      }
      return { success: false }
    },

    async stats() {
      const scopes: Record<string, number> = {}
      for (const entry of entries) {
        scopes[entry.learning.scope] = (scopes[entry.learning.scope] ?? 0) + 1
      }
      return {
        totalLearnings: entries.length,
        scopes,
        dimensions,
      }
    },

    async save() {
      if (persistPath) await saveToFile(persistPath, entries)
    },

    async load() {
      if (persistPath) entries = await loadFromFile(persistPath)
    },

    clear() {
      entries = []
    },
  }
}

export default dejaLocal
