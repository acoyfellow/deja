/**
 * deja-client - Thin client for deja persistent memory
 *
 * @example
 * ```ts
 * import deja from 'deja-client'
 *
 * const mem = deja('https://deja.your-subdomain.workers.dev')
 *
 * await mem.learn('deploy failed', 'check wrangler.toml first')
 * const { learnings } = await mem.inject('deploying to production')
 * ```
 */

// ============================================================================
// Types
// ============================================================================

export interface SharedRunIdentity {
  traceId?: string | null
  workspaceId?: string | null
  conversationId?: string | null
  runId?: string | null
  proofRunId?: string | null
  proofIterationId?: string | null
}

export interface Learning {
  id: string
  trigger: string
  learning: string
  reason?: string
  confidence: number
  source?: string
  scope: string
  supersedes?: string
  type: 'memory' | 'anti-pattern'
  createdAt: string
  lastRecalledAt?: string
  recallCount: number
  tier?: 'trigger' | 'full'
  identity?: SharedRunIdentity
}

export interface WorkingStateDecision {
  id?: string
  text: string
  status?: string
}

export interface WorkingStatePayload {
  goal?: string
  assumptions?: string[]
  decisions?: WorkingStateDecision[]
  openQuestions?: string[]
  nextActions?: string[]
  confidence?: number
}

export interface WorkingStateResponse {
  runId: string
  revision: number
  status: string
  state: WorkingStatePayload
  updatedBy?: string
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  identity?: SharedRunIdentity
}

export interface InjectResult {
  prompt: string
  learnings: Learning[]
  state?: WorkingStateResponse
}

export interface QueryResult {
  learnings: Learning[]
  hits: Record<string, number>
}

export interface LearningNeighbor extends Learning {
  similarityScore: number
}

export interface InjectTraceCandidate {
  id: string
  trigger: string
  learning: string
  similarityScore: number
  passedThreshold: boolean
}

export interface InjectTraceResult {
  inputContext: string
  embeddingGenerated: number[]
  candidates: InjectTraceCandidate[]
  thresholdApplied: number
  injected: Learning[]
  durationMs: number
  metadata: {
    totalCandidates: number
    aboveThreshold: number
    belowThreshold: number
  }
}

export interface Secret {
  name: string
  value: string
  scope: string
  createdAt: string
  updatedAt: string
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
  noveltyThreshold?: number
  identity?: SharedRunIdentity
}

export interface InjectOptions {
  scopes?: string[]
  limit?: number
  format?: 'prompt' | 'learnings'
  search?: 'vector' | 'text' | 'hybrid'
  maxTokens?: number
  includeState?: boolean
  runId?: string
  identity?: SharedRunIdentity
}

export interface InjectTraceOptions {
  scopes?: string[]
  limit?: number
  threshold?: number
  identity?: SharedRunIdentity
}

export interface QueryOptions {
  scopes?: string[]
  limit?: number
  identity?: SharedRunIdentity
}

export interface ListOptions {
  scope?: string
  limit?: number
}

export interface LearningNeighborsOptions {
  threshold?: number
  limit?: number
}

export interface ForgetBulkFilters {
  confidenceLt?: number
  notRecalledInDays?: number
  scope?: string
}

export interface ConfirmOptions {
  identity?: SharedRunIdentity
}

export interface RejectOptions {
  identity?: SharedRunIdentity
}

export interface PutStateOptions {
  updatedBy?: string
  changeSummary?: string
  identity?: SharedRunIdentity
}

export interface PatchStateOptions {
  updatedBy?: string
  identity?: SharedRunIdentity
}

export interface AddStateEventOptions {
  createdBy?: string
  identity?: SharedRunIdentity
}

export interface ResolveStateOptions {
  persistToLearn?: boolean
  scope?: string
  summaryStyle?: 'compact' | 'full'
  updatedBy?: string
  identity?: SharedRunIdentity
}

export interface SetSecretOptions {
  scope?: string
}

export interface GetSecretOptions {
  scopes?: string[]
}

export interface DeleteSecretOptions {
  scope?: string
}

export interface ListSecretsOptions {
  scope?: string
}

export interface ForgetResult {
  success: boolean
  error?: string
}

export interface ForgetBulkResult {
  deleted: number
  ids: string[]
}

export interface CleanupResult {
  deleted: number
  reasons: string[]
}

export interface StateEventResult {
  success: true
  id: string
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
// Internal wire types
// ============================================================================

interface RawWorkingStatePayload {
  goal?: string
  assumptions?: string[]
  decisions?: WorkingStateDecision[]
  open_questions?: string[]
  next_actions?: string[]
  confidence?: number
}

interface RawWorkingStateResponse {
  runId: string
  revision: number
  status: string
  state: RawWorkingStatePayload
  updatedBy?: string
  createdAt: string
  updatedAt: string
  resolvedAt?: string
  identity?: SharedRunIdentity
}

interface RawInjectResult {
  prompt: string
  learnings: Learning[]
  state?: RawWorkingStateResponse
}

interface RawInjectTraceResult {
  input_context: string
  embedding_generated: number[]
  candidates: Array<{
    id: string
    trigger: string
    learning: string
    similarity_score: number
    passed_threshold: boolean
  }>
  threshold_applied: number
  injected: Learning[]
  duration_ms: number
  metadata: {
    total_candidates: number
    above_threshold: number
    below_threshold: number
  }
}

type RawLearningNeighbor = Learning & { similarity_score: number }

// ============================================================================
// Mapping helpers
// ============================================================================

function mapLearning(raw: Learning): Learning {
  const mapped: Learning = {
    id: raw.id,
    trigger: raw.trigger,
    learning: raw.learning,
    confidence: raw.confidence,
    scope: raw.scope,
    type: raw.type ?? 'memory',
    createdAt: raw.createdAt,
    recallCount: raw.recallCount ?? 0,
  }
  if (raw.reason !== undefined) mapped.reason = raw.reason
  if (raw.source !== undefined) mapped.source = raw.source
  if (raw.supersedes !== undefined) mapped.supersedes = raw.supersedes
  if (raw.lastRecalledAt !== undefined) mapped.lastRecalledAt = raw.lastRecalledAt
  if (raw.tier !== undefined) mapped.tier = raw.tier
  if (raw.identity !== undefined) mapped.identity = raw.identity
  return mapped
}

function toWireStatePayload(payload: Partial<WorkingStatePayload>): RawWorkingStatePayload {
  return {
    goal: payload.goal,
    assumptions: payload.assumptions,
    decisions: payload.decisions,
    open_questions: payload.openQuestions,
    next_actions: payload.nextActions,
    confidence: payload.confidence,
  }
}

function mapWorkingStatePayload(raw: RawWorkingStatePayload = {}): WorkingStatePayload {
  return {
    goal: raw.goal,
    assumptions: raw.assumptions,
    decisions: raw.decisions,
    openQuestions: raw.open_questions,
    nextActions: raw.next_actions,
    confidence: raw.confidence,
  }
}

function mapWorkingStateResponse(raw: RawWorkingStateResponse): WorkingStateResponse {
  return {
    runId: raw.runId,
    revision: raw.revision,
    status: raw.status,
    state: mapWorkingStatePayload(raw.state),
    updatedBy: raw.updatedBy ?? undefined,
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    resolvedAt: raw.resolvedAt ?? undefined,
    identity: raw.identity ?? undefined,
  }
}

function mapInjectResult(raw: RawInjectResult): InjectResult {
  return {
    prompt: raw.prompt,
    learnings: raw.learnings.map(mapLearning),
    state: raw.state ? mapWorkingStateResponse(raw.state) : undefined,
  }
}

function mapInjectTraceResult(raw: RawInjectTraceResult): InjectTraceResult {
  return {
    inputContext: raw.input_context,
    embeddingGenerated: raw.embedding_generated,
    candidates: raw.candidates.map((candidate) => ({
      id: candidate.id,
      trigger: candidate.trigger,
      learning: candidate.learning,
      similarityScore: candidate.similarity_score,
      passedThreshold: candidate.passed_threshold,
    })),
    thresholdApplied: raw.threshold_applied,
    injected: raw.injected.map(mapLearning),
    durationMs: raw.duration_ms,
    metadata: {
      totalCandidates: raw.metadata.total_candidates,
      aboveThreshold: raw.metadata.above_threshold,
      belowThreshold: raw.metadata.below_threshold,
    },
  }
}

function mapLearningNeighbor(raw: RawLearningNeighbor): LearningNeighbor {
  return {
    ...mapLearning(raw),
    similarityScore: raw.similarity_score,
  }
}

function withIdentity<T extends Record<string, unknown>>(body: T, identity?: SharedRunIdentity): T & { identity?: SharedRunIdentity } {
  return identity ? { ...body, identity } : body
}

function withQuery(path: string, entries: Array<[string, string | number | undefined]>): string {
  const params = new URLSearchParams()
  for (const [key, value] of entries) {
    if (value === undefined || value === null || value === '') continue
    params.set(key, String(value))
  }
  const qs = params.toString()
  return qs ? `${path}?${qs}` : path
}

// ============================================================================
// Client
// ============================================================================

export interface DejaClient {
  learn(trigger: string, learning: string, options?: LearnOptions): Promise<Learning>
  confirm(id: string, options?: ConfirmOptions): Promise<Learning>
  reject(id: string, options?: RejectOptions): Promise<Learning>
  inject(context: string, options?: InjectOptions): Promise<InjectResult>
  injectTrace(context: string, options?: InjectTraceOptions): Promise<InjectTraceResult>
  query(text: string, options?: QueryOptions): Promise<QueryResult>
  list(options?: ListOptions): Promise<Learning[]>
  learningNeighbors(id: string, options?: LearningNeighborsOptions): Promise<LearningNeighbor[]>
  forget(id: string): Promise<ForgetResult>
  forgetBulk(filters: ForgetBulkFilters): Promise<ForgetBulkResult>
  cleanup(): Promise<CleanupResult>
  getState(runId: string): Promise<WorkingStateResponse>
  putState(runId: string, payload: WorkingStatePayload, options?: PutStateOptions): Promise<WorkingStateResponse>
  patchState(runId: string, patch: Partial<WorkingStatePayload>, options?: PatchStateOptions): Promise<WorkingStateResponse>
  addStateEvent(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
    options?: AddStateEventOptions,
  ): Promise<StateEventResult>
  resolveState(runId: string, options?: ResolveStateOptions): Promise<WorkingStateResponse>
  setSecret(name: string, value: string, options?: SetSecretOptions): Promise<ForgetResult>
  getSecret(name: string, options?: GetSecretOptions): Promise<string>
  deleteSecret(name: string, options?: DeleteSecretOptions): Promise<ForgetResult>
  listSecrets(options?: ListSecretsOptions): Promise<Secret[]>
  stats(): Promise<Stats>
  recordRun(outcome: LoopRun['outcome'], attempts: number, options?: RecordRunOptions): Promise<LoopRun>
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
    if (apiKey) h.Authorization = `Bearer ${apiKey}`
    return h
  }

  const request = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await customFetch(`${baseUrl}${path}`, {
      method,
      headers: headers(),
      body: body === undefined ? undefined : JSON.stringify(body),
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }))
      throw new Error((err as { error?: string }).error || `HTTP ${res.status}`)
    }

    return res.json() as Promise<T>
  }

  const get = <T>(path: string) => request<T>('GET', path)
  const post = <T>(path: string, body: unknown) => request<T>('POST', path, body)
  const put = <T>(path: string, body: unknown) => request<T>('PUT', path, body)
  const patch = <T>(path: string, body: unknown) => request<T>('PATCH', path, body)
  const del = <T>(path: string) => request<T>('DELETE', path)

  return {
    async learn(trigger, learning, opts = {}) {
      const raw = await post<Learning>(
        '/learn',
        withIdentity(
          {
            trigger,
            learning,
            confidence: opts.confidence ?? 0.8,
            scope: opts.scope ?? 'shared',
            reason: opts.reason,
            source: opts.source,
            noveltyThreshold: opts.noveltyThreshold,
          },
          opts.identity,
        ),
      )
      return mapLearning(raw)
    },

    async confirm(id, opts = {}) {
      const raw = await post<Learning>(`/learning/${id}/confirm`, withIdentity({}, opts.identity))
      return mapLearning(raw)
    },

    async reject(id, opts = {}) {
      const raw = await post<Learning>(`/learning/${id}/reject`, withIdentity({}, opts.identity))
      return mapLearning(raw)
    },

    async inject(context, opts = {}) {
      const raw = await post<RawInjectResult>(
        '/inject',
        withIdentity(
          {
            context,
            scopes: opts.scopes ?? ['shared'],
            limit: opts.limit ?? 5,
            format: opts.format ?? 'prompt',
            search: opts.search,
            maxTokens: opts.maxTokens,
            includeState: opts.includeState,
            runId: opts.runId,
          },
          opts.identity,
        ),
      )
      return mapInjectResult(raw)
    },

    async injectTrace(context, opts = {}) {
      const raw = await post<RawInjectTraceResult>(
        '/inject/trace',
        withIdentity(
          {
            context,
            scopes: opts.scopes ?? ['shared'],
            limit: opts.limit ?? 5,
            threshold: opts.threshold,
          },
          opts.identity,
        ),
      )
      return mapInjectTraceResult(raw)
    },

    async query(text, opts = {}) {
      const raw = await post<QueryResult>(
        '/query',
        withIdentity(
          {
            text,
            scopes: opts.scopes ?? ['shared'],
            limit: opts.limit ?? 10,
          },
          opts.identity,
        ),
      )
      return {
        learnings: raw.learnings.map(mapLearning),
        hits: raw.hits,
      }
    },

    async list(opts = {}) {
      const raw = await get<Learning[]>(
        withQuery('/learnings', [
          ['scope', opts.scope],
          ['limit', opts.limit],
        ]),
      )
      return raw.map(mapLearning)
    },

    async learningNeighbors(id, opts = {}) {
      const raw = await get<RawLearningNeighbor[]>(
        withQuery(`/learning/${id}/neighbors`, [
          ['threshold', opts.threshold],
          ['limit', opts.limit],
        ]),
      )
      return raw.map(mapLearningNeighbor)
    },

    async forget(id) {
      return del<ForgetResult>(`/learning/${id}`)
    },

    async forgetBulk(filters) {
      return del<ForgetBulkResult>(
        withQuery('/learnings', [
          ['confidence_lt', filters.confidenceLt],
          ['not_recalled_in_days', filters.notRecalledInDays],
          ['scope', filters.scope],
        ]),
      )
    },

    async cleanup() {
      return post<CleanupResult>('/cleanup', {})
    },

    async getState(runId) {
      const raw = await get<RawWorkingStateResponse>(`/state/${runId}`)
      return mapWorkingStateResponse(raw)
    },

    async putState(runId, payload, opts = {}) {
      const raw = await put<RawWorkingStateResponse>(
        `/state/${runId}`,
        withIdentity(
          {
            ...toWireStatePayload(payload),
            updatedBy: opts.updatedBy,
            changeSummary: opts.changeSummary,
          },
          opts.identity,
        ),
      )
      return mapWorkingStateResponse(raw)
    },

    async patchState(runId, patchPayload, opts = {}) {
      const raw = await patch<RawWorkingStateResponse>(
        `/state/${runId}`,
        withIdentity(
          {
            ...toWireStatePayload(patchPayload),
            updatedBy: opts.updatedBy,
          },
          opts.identity,
        ),
      )
      return mapWorkingStateResponse(raw)
    },

    async addStateEvent(runId, eventType, payload, opts = {}) {
      return post<StateEventResult>(
        `/state/${runId}/events`,
        withIdentity(
          {
            eventType,
            payload,
            createdBy: opts.createdBy,
          },
          opts.identity,
        ),
      )
    },

    async resolveState(runId, opts = {}) {
      const raw = await post<RawWorkingStateResponse>(
        `/state/${runId}/resolve`,
        withIdentity(
          {
            persistToLearn: opts.persistToLearn,
            scope: opts.scope,
            summaryStyle: opts.summaryStyle,
            updatedBy: opts.updatedBy,
          },
          opts.identity,
        ),
      )
      return mapWorkingStateResponse(raw)
    },

    async setSecret(name, value, opts = {}) {
      return post<ForgetResult>('/secret', {
        name,
        value,
        scope: opts.scope ?? 'shared',
      })
    },

    async getSecret(name, opts = {}) {
      const raw = await get<{ value: string }>(
        withQuery(`/secret/${name}`, [['scopes', opts.scopes?.join(',')]]),
      )
      return raw.value
    },

    async deleteSecret(name, opts = {}) {
      return del<ForgetResult>(
        withQuery(`/secret/${name}`, [['scope', opts.scope ?? 'shared']]),
      )
    },

    async listSecrets(opts = {}) {
      return get<Secret[]>(
        withQuery('/secrets', [['scope', opts.scope]]),
      )
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
      return get<RunsResult>(
        withQuery('/runs', [
          ['scope', opts.scope],
          ['limit', opts.limit],
        ]),
      )
    },
  }
}

export default deja
