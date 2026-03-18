/**
 * deja-client - Thin client for deja persistent memory
 *
 * @example
 * ```ts
 * import deja from 'deja-client'
 *
 * const mem = deja('https://deja.your-subdomain.workers.dev')
 *
 * // Store a learning
 * await mem.learn('deploy failed', 'check wrangler.toml first')
 *
 * // Get relevant memories before a task
 * const memories = await mem.inject('deploying to production')
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
}

export interface InjectResult {
  prompt: string
  learnings: Learning[]
}

export interface QueryResult {
  learnings: Learning[]
  hits: Record<string, number>
}

export interface Stats {
  totalLearnings: number
  totalSecrets: number
  scopes: Record<string, { learnings: number; secrets: number }>
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
  format?: 'prompt' | 'learnings'
}

export interface QueryOptions {
  scopes?: string[]
  limit?: number
}

export interface ListOptions {
  scope?: string
  limit?: number
}

export interface LoopRun {
  id: string
  scope: string
  outcome: 'pass' | 'fail' | 'exhausted'
  attempts: number
  code?: string
  error?: string
  createdAt: string
}

export interface RecordRunOptions {
  scope?: string
  code?: string
  error?: string
}

export type RunTrend = 'improving' | 'regressing' | 'stable' | 'insufficient_data'

export interface RunsResult {
  runs: LoopRun[]
  stats: {
    total: number
    pass: number
    fail: number
    exhausted: number
    mean_attempts: number
    best_attempts: number
    trend: RunTrend
  }
}

export interface RunsOptions {
  scope?: string
  limit?: number
}

export interface ClientOptions {
  apiKey?: string
  fetch?: typeof fetch
}

// ============================================================================
// Client
// ============================================================================

export interface DejaClient {
  /**
   * Store a learning for future recall
   *
   * @param trigger - When this learning applies (e.g., "deploying to production")
   * @param learning - What was learned (e.g., "always run dry-run first")
   * @param options - Optional: confidence, scope, reason, source
   */
  learn(trigger: string, learning: string, options?: LearnOptions): Promise<Learning>

  /**
   * Get relevant memories for current context
   *
   * @param context - Current task or situation
   * @param options - Optional: scopes, limit, format
   */
  inject(context: string, options?: InjectOptions): Promise<InjectResult>

  /**
   * Search memories semantically
   *
   * @param text - Search query
   * @param options - Optional: scopes, limit
   */
  query(text: string, options?: QueryOptions): Promise<QueryResult>

  /**
   * List all memories
   *
   * @param options - Optional: scope filter, limit
   */
  list(options?: ListOptions): Promise<Learning[]>

  /**
   * Delete a specific memory by ID
   *
   * @param id - Learning ID to delete
   */
  forget(id: string): Promise<{ success: boolean; error?: string }>

  /**
   * Get memory statistics
   */
  stats(): Promise<Stats>

  /**
   * Record the outcome of an optimization loop run
   *
   * @param outcome - 'pass', 'fail', or 'exhausted'
   * @param attempts - Number of attempts taken
   * @param options - Optional: scope, code, error
   */
  recordRun(outcome: LoopRun['outcome'], attempts: number, options?: RecordRunOptions): Promise<LoopRun>

  /**
   * Get run history and convergence stats
   *
   * @param options - Optional: scope filter, limit
   */
  getRuns(options?: RunsOptions): Promise<RunsResult>
}

/**
 * Create a deja client
 *
 * @param url - Your deja instance URL (e.g., https://deja.your-subdomain.workers.dev)
 * @param options - Optional: apiKey for authenticated endpoints, custom fetch
 */
export function deja(url: string, options: ClientOptions = {}): DejaClient {
  const baseUrl = url.replace(/\/$/, '')
  const { apiKey, fetch: customFetch = fetch } = options

  const headers = (): Record<string, string> => {
    const h: Record<string, string> = { 'Content-Type': 'application/json' }
    if (apiKey) h['Authorization'] = `Bearer ${apiKey}`
    return h
  }

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const res = await customFetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error((err as { error?: string }).error || `HTTP ${res.status}`)
    }
    return res.json() as Promise<T>
  }

  const get = async <T>(path: string): Promise<T> => {
    const res = await customFetch(`${baseUrl}${path}`, {
      method: 'GET',
      headers: headers(),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error((err as { error?: string }).error || `HTTP ${res.status}`)
    }
    return res.json() as Promise<T>
  }

  const del = async <T>(path: string): Promise<T> => {
    const res = await customFetch(`${baseUrl}${path}`, {
      method: 'DELETE',
      headers: headers(),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error((err as { error?: string }).error || `HTTP ${res.status}`)
    }
    return res.json() as Promise<T>
  }

  return {
    async learn(trigger, learning, opts = {}) {
      return post<Learning>('/learn', {
        trigger,
        learning,
        confidence: opts.confidence ?? 0.8,
        scope: opts.scope ?? 'shared',
        reason: opts.reason,
        source: opts.source,
      })
    },

    async inject(context, opts = {}) {
      return post<InjectResult>('/inject', {
        context,
        scopes: opts.scopes ?? ['shared'],
        limit: opts.limit ?? 5,
        format: opts.format ?? 'prompt',
      })
    },

    async query(text, opts = {}) {
      return post<QueryResult>('/query', {
        text,
        scopes: opts.scopes ?? ['shared'],
        limit: opts.limit ?? 10,
      })
    },

    async list(opts = {}) {
      const params = new URLSearchParams()
      if (opts.scope) params.set('scope', opts.scope)
      if (opts.limit) params.set('limit', String(opts.limit))
      const qs = params.toString()
      return get<Learning[]>(`/learnings${qs ? `?${qs}` : ''}`)
    },

    async forget(id) {
      return del<{ success: boolean; error?: string }>(`/learning/${id}`)
    },

    async stats() {
      return get<Stats>('/stats')
    },

    async recordRun(outcome, attempts, opts = {}) {
      return post<LoopRun>('/run', {
        outcome,
        attempts,
        scope: opts.scope ?? 'shared',
        code: opts.code,
        error: opts.error,
      })
    },

    async getRuns(opts = {}) {
      const params = new URLSearchParams()
      if (opts.scope) params.set('scope', opts.scope)
      if (opts.limit) params.set('limit', String(opts.limit))
      const qs = params.toString()
      return get<RunsResult>(`/runs${qs ? `?${qs}` : ''}`)
    },
  }
}

export default deja
