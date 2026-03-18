/**
 * deja-local — Local in-process vector memory for agents
 *
 * Real semantic embeddings (all-MiniLM-L6-v2 via ONNX). No network after first model download.
 * Zero eventual consistency. Instant recall.
 *
 * @example
 * ```ts
 * import { dejaLocal } from 'deja-local'
 *
 * const mem = await dejaLocal()
 *
 * await mem.learn('deploy failed', 'check wrangler.toml first')
 * const { learnings } = await mem.inject('deploying to production')
 * // learnings[0].learning === 'check wrangler.toml first'
 * ```
 */

import { pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers'

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
  /**
   * Custom embedding function. Default: all-MiniLM-L6-v2 via ONNX (384 dims).
   * First call downloads ~23MB model, cached locally after that.
   * Pass 'ngram' for zero-dep fallback (fast but lower quality).
   */
  embed?: EmbedFn | 'ngram'
  /** HuggingFace model ID for embeddings. Default: 'Xenova/all-MiniLM-L6-v2' */
  model?: string
  /** Path to persist memory as JSON. Default: in-memory only */
  persistPath?: string
  /** Auto-save after every learn/forget. Default: true (only if persistPath set) */
  autoSave?: boolean
  /** Minimum similarity threshold for recall. Default: 0.3 */
  threshold?: number
}

interface StoredEntry {
  learning: Learning
  embedding: number[]
}

// ============================================================================
// Embedding: real model via transformers.js (default)
// ============================================================================

function createModelEmbed(modelId: string): EmbedFn {
  let extractor: FeatureExtractionPipeline | null = null

  return async (text: string): Promise<number[]> => {
    if (!extractor) {
      // @ts-expect-error - pipeline() union type too complex for TS, runtime works fine
      extractor = await pipeline('feature-extraction', modelId, {
        dtype: 'fp32',
      })
    }
    const output = await extractor!(text, { pooling: 'mean', normalize: true })
    return Array.from(output.data as Float32Array)
  }
}

// ============================================================================
// Embedding: n-gram hash fallback (zero deps, ~0.1ms, lower quality)
// ============================================================================

function createNgramEmbed(dimensions = 384): EmbedFn {
  return (text: string): number[] => {
    const vec = new Float64Array(dimensions)
    const lower = text.toLowerCase()

    const ngrams: string[] = []
    for (let i = 0; i < lower.length - 1; i++) {
      ngrams.push(lower.slice(i, i + 2))
      if (i < lower.length - 2) ngrams.push(lower.slice(i, i + 3))
    }
    for (const word of lower.split(/\s+/)) {
      if (word.length > 0) ngrams.push(`w:${word}`)
    }

    for (const ng of ngrams) {
      let h = 0x811c9dc5
      for (let i = 0; i < ng.length; i++) {
        h ^= ng.charCodeAt(i)
        h = Math.imul(h, 0x01000193)
      }
      vec[((h >>> 0) % dimensions)] += (h & 1) ? 1 : -1
    }

    let norm = 0
    for (let i = 0; i < dimensions; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm)
    if (norm > 0) for (let i = 0; i < dimensions; i++) vec[i] /= norm

    return Array.from(vec)
  }
}

// ============================================================================
// Shared math
// ============================================================================

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
// Persistence
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
// DejaLocal
// ============================================================================

export interface DejaLocalClient {
  learn(trigger: string, learning: string, options?: LearnOptions): Promise<Learning>
  inject(context: string, options?: InjectOptions): Promise<InjectResult>
  query(text: string, options?: QueryOptions): Promise<QueryResult>
  list(options?: ListOptions): Promise<Learning[]>
  forget(id: string): Promise<{ success: boolean }>
  stats(): Promise<Stats>
  save(): Promise<void>
  load(): Promise<void>
  clear(): void
  readonly size: number
}

/**
 * Create a local vector memory instance.
 *
 * Default: uses all-MiniLM-L6-v2 for real semantic embeddings (~23MB, cached after first run).
 * Pass embed: 'ngram' for zero-dep mode (faster, lower quality).
 * Pass embed: yourFn for custom embeddings (OpenAI, etc).
 */
export function dejaLocal(opts: DejaLocalOptions = {}): DejaLocalClient {
  const embedFn: EmbedFn =
    opts.embed === 'ngram' ? createNgramEmbed() :
    typeof opts.embed === 'function' ? opts.embed :
    createModelEmbed(opts.model ?? 'Xenova/all-MiniLM-L6-v2')

  const defaultThreshold = opts.threshold ?? 0.3
  const persistPath = opts.persistPath
  const autoSave = opts.autoSave ?? true

  let entries: StoredEntry[] = []

  const maybeSave = async () => {
    if (persistPath && autoSave) await saveToFile(persistPath, entries)
  }

  const search = async (
    text: string,
    scopes: string[] | undefined,
    limit: number,
    threshold: number,
  ) => {
    const queryVec = await embedFn(text)
    const scored: Array<{ entry: StoredEntry; score: number }> = []

    for (const entry of entries) {
      if (scopes && scopes.length > 0 && !scopes.includes(entry.learning.scope)) continue
      const score = cosine(queryVec, entry.embedding)
      if (score >= threshold) scored.push({ entry, score })
    }

    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, limit)
  }

  return {
    get size() { return entries.length },

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
      const top = await search(
        context,
        options.scopes,
        options.limit ?? 5,
        options.threshold ?? defaultThreshold,
      )

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
      const top = await search(
        text,
        options.scopes,
        options.limit ?? 10,
        options.threshold ?? defaultThreshold,
      )
      return {
        learnings: top.map(s => s.entry.learning),
        scores: new Map(top.map(s => [s.entry.learning.id, s.score])),
      }
    },

    async list(options = {}) {
      let result = entries.map(e => e.learning)
      if (options.scope) result = result.filter(l => l.scope === options.scope)
      if (options.limit) result = result.slice(0, options.limit)
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
      return { totalLearnings: entries.length, scopes }
    },

    async save() {
      if (persistPath) await saveToFile(persistPath, entries)
    },

    async load() {
      if (persistPath) entries = await loadFromFile(persistPath)
    },

    clear() { entries = [] },
  }
}

export { createModelEmbed, createNgramEmbed }
export default dejaLocal
