/**
 * deja-local — Vector memory for agents. That's it.
 *
 * ```ts
 * const mem = createMemory()
 * await mem.learn("check wrangler.toml before deploying")
 * const results = await mem.recall("deploying to production")
 * ```
 */

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
  memory: Memory
  score: number
}

export interface MemoryStore {
  /** Store a memory. Immediately available for recall. */
  learn(text: string): Promise<Memory>

  /** Find relevant memories for the given context. */
  recall(context: string, options?: { limit?: number; threshold?: number }): Promise<RecallResult[]>

  /** Remove a memory by id. */
  forget(id: string): Promise<boolean>

  /** Dump all memories (for debugging / export). */
  list(): Memory[]

  /** Persist to disk (only if path was configured). */
  save(): Promise<void>

  /** Load from disk (only if path was configured). */
  load(): Promise<void>

  /** Wipe everything. */
  clear(): void

  /** How many memories are stored. */
  readonly size: number
}

export interface CreateMemoryOptions {
  /** Embedding function. Default: all-MiniLM-L6-v2 via ONNX (~23MB, cached locally). */
  embed?: EmbedFn | 'ngram'
  /** HuggingFace model ID. Default: 'Xenova/all-MiniLM-L6-v2' */
  model?: string
  /** File path to persist memories as JSON. Default: in-memory only. */
  path?: string
  /** Auto-save after learn/forget. Default: true when path is set. */
  autoSave?: boolean
  /** Minimum similarity score for recall. Default: 0.3 */
  threshold?: number
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

function createNgramEmbed(dims = 384): EmbedFn {
  return (text: string): number[] => {
    const vec = new Float64Array(dims)
    const lower = text.toLowerCase()
    const tokens: string[] = []
    for (let i = 0; i < lower.length - 1; i++) {
      tokens.push(lower.slice(i, i + 2))
      if (i < lower.length - 2) tokens.push(lower.slice(i, i + 3))
    }
    for (const w of lower.split(/\s+/)) if (w) tokens.push(`w:${w}`)
    for (const t of tokens) {
      let h = 0x811c9dc5
      for (let i = 0; i < t.length; i++) { h ^= t.charCodeAt(i); h = Math.imul(h, 0x01000193) }
      vec[(h >>> 0) % dims] += (h & 1) ? 1 : -1
    }
    let norm = 0
    for (let i = 0; i < dims; i++) norm += vec[i] * vec[i]
    norm = Math.sqrt(norm)
    if (norm > 0) for (let i = 0; i < dims; i++) vec[i] /= norm
    return Array.from(vec)
  }
}

function cosine(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  const d = Math.sqrt(na) * Math.sqrt(nb)
  return d === 0 ? 0 : dot / d
}

// ============================================================================
// Persistence
// ============================================================================

interface Entry { memory: Memory; vec: number[] }
interface Snapshot { v: 1; entries: Entry[] }

async function loadFile(path: string): Promise<Entry[]> {
  try {
    const raw = await (await import('fs')).promises.readFile(path, 'utf-8')
    const snap: Snapshot = JSON.parse(raw)
    return snap.v === 1 ? snap.entries : []
  } catch { return [] }
}

async function saveFile(path: string, entries: Entry[]): Promise<void> {
  const fs = await import('fs')
  await fs.promises.writeFile(path, JSON.stringify({ v: 1, entries } satisfies Snapshot), 'utf-8')
}

// ============================================================================
// createMemory
// ============================================================================

export function createMemory(opts: CreateMemoryOptions = {}): MemoryStore {
  const embed: EmbedFn =
    opts.embed === 'ngram' ? createNgramEmbed() :
    typeof opts.embed === 'function' ? opts.embed :
    createModelEmbed(opts.model ?? 'Xenova/all-MiniLM-L6-v2')

  const threshold = opts.threshold ?? 0.3
  const path = opts.path
  const autoSave = opts.autoSave ?? true
  let entries: Entry[] = []

  const persist = async () => { if (path && autoSave) await saveFile(path, entries) }

  return {
    get size() { return entries.length },

    async learn(text) {
      const vec = await embed(text)
      const memory: Memory = {
        id: Math.random().toString(36).slice(2) + Date.now().toString(36),
        text,
        createdAt: new Date().toISOString(),
      }
      entries.push({ memory, vec })
      await persist()
      return memory
    },

    async recall(context, options = {}) {
      const qv = await embed(context)
      const limit = options.limit ?? 5
      const min = options.threshold ?? threshold

      const scored: RecallResult[] = []
      for (const e of entries) {
        const score = cosine(qv, e.vec)
        if (score >= min) scored.push({ memory: e.memory, score })
      }
      scored.sort((a, b) => b.score - a.score)
      return scored.slice(0, limit)
    },

    async forget(id) {
      const before = entries.length
      entries = entries.filter(e => e.memory.id !== id)
      if (entries.length < before) { await persist(); return true }
      return false
    },

    list() { return entries.map(e => e.memory) },

    async save() { if (path) await saveFile(path, entries) },
    async load() { if (path) entries = await loadFile(path) },
    clear() { entries = [] },
  }
}

export { createModelEmbed, createNgramEmbed }
export default createMemory
