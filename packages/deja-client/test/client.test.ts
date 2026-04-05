import { describe, test, expect, mock } from 'bun:test'
import {
  deja,
  type CleanupResult,
  type InjectResult,
  type InjectTraceResult,
  type Learning,
  type LearningNeighbor,
  type QueryResult,
  type Secret,
  type SharedRunIdentity,
  type StateEventResult,
  type Stats,
  type WorkingStateResponse,
} from '../src/index'

const mockResponse = <T>(data: T, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })

const sampleIdentity: SharedRunIdentity = {
  traceId: 'trace-1',
  workspaceId: 'workspace-1',
  conversationId: 'conversation-1',
  runId: 'run-1',
  proofRunId: 'proof-run-1',
  proofIterationId: 'proof-run-1:1',
}

const sampleLearning: Learning = {
  id: '1234567890-abc123def',
  trigger: 'deploy failed',
  learning: 'check wrangler.toml first',
  confidence: 0.8,
  scope: 'shared',
  supersedes: 'older-memory',
  type: 'memory',
  tier: 'full',
  createdAt: '2026-02-04T12:00:00.000Z',
  lastRecalledAt: '2026-02-05T12:00:00.000Z',
  recallCount: 4,
  identity: sampleIdentity,
}

const sampleRawStateResponse = {
  runId: 'run-1',
  revision: 2,
  status: 'active',
  state: {
    goal: 'Ship hotfix',
    assumptions: ['traffic is low'],
    decisions: [{ id: 'd-1', text: 'use canary', status: 'accepted' }],
    open_questions: ['need rollback plan?'],
    next_actions: ['run canary deploy'],
    confidence: 0.72,
  },
  updatedBy: 'ops-bot',
  createdAt: '2026-02-04T12:00:00.000Z',
  updatedAt: '2026-02-04T12:05:00.000Z',
  resolvedAt: undefined,
  identity: sampleIdentity,
}

const sampleStateResponse: WorkingStateResponse = {
  runId: 'run-1',
  revision: 2,
  status: 'active',
  state: {
    goal: 'Ship hotfix',
    assumptions: ['traffic is low'],
    decisions: [{ id: 'd-1', text: 'use canary', status: 'accepted' }],
    openQuestions: ['need rollback plan?'],
    nextActions: ['run canary deploy'],
    confidence: 0.72,
  },
  updatedBy: 'ops-bot',
  createdAt: '2026-02-04T12:00:00.000Z',
  updatedAt: '2026-02-04T12:05:00.000Z',
  resolvedAt: undefined,
  identity: sampleIdentity,
}

describe('deja-client', () => {
  describe('learn', () => {
    test('sends correct POST request with minimal args', async () => {
      let capturedRequest: { url: string; method: string; body: unknown } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = {
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        }
        return mockResponse(sampleLearning)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.learn('deploy failed', 'check wrangler.toml first')

      expect(capturedRequest?.url).toBe('https://deja.example.com/learn')
      expect(capturedRequest?.method).toBe('POST')
      expect(capturedRequest?.body).toEqual({
        trigger: 'deploy failed',
        learning: 'check wrangler.toml first',
        confidence: 0.8,
        scope: 'shared',
        reason: undefined,
        source: undefined,
        noveltyThreshold: undefined,
      })
      expect(result).toEqual(sampleLearning)
    })

    test('sends correct POST request with all options and identity', async () => {
      let capturedBody: unknown = null

      const mockFetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null
        return mockResponse(sampleLearning)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      await mem.learn('migration failed', 'check foreign keys', {
        confidence: 0.95,
        scope: 'agent:deployer',
        reason: 'Learned from production incident',
        source: 'ops-runbook',
        identity: sampleIdentity,
      })

      expect(capturedBody).toEqual({
        trigger: 'migration failed',
        learning: 'check foreign keys',
        confidence: 0.95,
        scope: 'agent:deployer',
        reason: 'Learned from production incident',
        source: 'ops-runbook',
        noveltyThreshold: undefined,
        identity: sampleIdentity,
      })
    })

    test('includes noveltyThreshold when provided', async () => {
      let capturedBody: unknown = null

      const mockFetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null
        return mockResponse(sampleLearning)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      await mem.learn('auth deploy', 'run smoke tests first', { noveltyThreshold: 0.91 })

      expect(capturedBody).toEqual({
        trigger: 'auth deploy',
        learning: 'run smoke tests first',
        confidence: 0.8,
        scope: 'shared',
        reason: undefined,
        source: undefined,
        noveltyThreshold: 0.91,
      })
    })

    test('includes API key in Authorization header', async () => {
      let capturedHeaders: Record<string, string> = {}

      const mockFetch = mock(async (_url: string, init?: RequestInit) => {
        capturedHeaders = Object.fromEntries(Object.entries(init?.headers || {}))
        return mockResponse(sampleLearning)
      })

      const mem = deja('https://deja.example.com', {
        apiKey: 'secret-key-123',
        fetch: mockFetch as typeof fetch,
      })
      await mem.learn('test', 'test')

      expect(capturedHeaders.Authorization).toBe('Bearer secret-key-123')
    })
  })

  describe('confirm and reject', () => {
    test('confirm sends identity and returns the updated learning', async () => {
      let capturedRequest: { url: string; method: string; body: unknown } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = {
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        }
        return mockResponse({ ...sampleLearning, confidence: 0.9 })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.confirm('1234567890-abc123def', { identity: sampleIdentity })

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/learning/1234567890-abc123def/confirm',
        method: 'POST',
        body: { identity: sampleIdentity },
      })
      expect(result.confidence).toBe(0.9)
    })

    test('reject sends identity and returns the updated learning', async () => {
      let capturedRequest: { url: string; method: string; body: unknown } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = {
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        }
        return mockResponse({ ...sampleLearning, confidence: 0.65, type: 'anti-pattern' as const })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.reject('1234567890-abc123def', { identity: sampleIdentity })

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/learning/1234567890-abc123def/reject',
        method: 'POST',
        body: { identity: sampleIdentity },
      })
      expect(result.type).toBe('anti-pattern')
    })
  })

  describe('inject', () => {
    const sampleInjectResult: InjectResult = {
      prompt: 'When deploy failed, check wrangler.toml first',
      learnings: [sampleLearning],
      state: sampleStateResponse,
    }

    test('sends correct POST request with defaults', async () => {
      let capturedBody: unknown = null

      const mockFetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null
        return mockResponse({
          prompt: sampleInjectResult.prompt,
          learnings: [sampleLearning],
        })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.inject('deploying to production')

      expect(capturedBody).toEqual({
        context: 'deploying to production',
        scopes: ['shared'],
        limit: 5,
        format: 'prompt',
        search: undefined,
        maxTokens: undefined,
        includeState: undefined,
        runId: undefined,
      })
      expect(result.prompt).toContain('check wrangler.toml')
      expect(result.learnings).toHaveLength(1)
    })

    test('sends correct POST request with custom options and maps state payload to camelCase', async () => {
      let capturedBody: unknown = null

      const mockFetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null
        return mockResponse({
          prompt: sampleInjectResult.prompt,
          learnings: [sampleLearning],
          state: sampleRawStateResponse,
        })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.inject('deploying', {
        scopes: ['agent:deployer', 'shared'],
        limit: 10,
        format: 'learnings',
        includeState: true,
        runId: 'run-1',
        identity: sampleIdentity,
      })

      expect(capturedBody).toEqual({
        context: 'deploying',
        scopes: ['agent:deployer', 'shared'],
        limit: 10,
        format: 'learnings',
        search: undefined,
        maxTokens: undefined,
        includeState: true,
        runId: 'run-1',
        identity: sampleIdentity,
      })
      expect(result).toEqual(sampleInjectResult)
    })

    test('sends maxTokens and maps tier on learnings', async () => {
      let capturedBody: unknown = null

      const mockFetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null
        return mockResponse({
          prompt: 'Auth Service',
          learnings: [
            { ...sampleLearning, tier: 'trigger', learning: '', reason: undefined, source: undefined },
          ],
        })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.inject('auth deploy', { maxTokens: 100 })

      expect(capturedBody).toEqual({
        context: 'auth deploy',
        scopes: ['shared'],
        limit: 5,
        format: 'prompt',
        search: undefined,
        maxTokens: 100,
        includeState: undefined,
        runId: undefined,
      })
      expect(result.learnings[0].tier).toBe('trigger')
    })
  })

  describe('injectTrace', () => {
    test('sends correct request and maps snake_case response fields to camelCase', async () => {
      let capturedBody: unknown = null
      const rawTraceResult = {
        input_context: 'deploying auth service',
        embedding_generated: [0.1, 0.2, 0.3],
        candidates: [
          {
            id: '1234567890-abc123def',
            trigger: 'deploy failed',
            learning: 'check wrangler.toml first',
            similarity_score: 0.94,
            passed_threshold: true,
          },
        ],
        threshold_applied: 0.8,
        injected: [sampleLearning],
        duration_ms: 18,
        metadata: {
          total_candidates: 1,
          above_threshold: 1,
          below_threshold: 0,
        },
      }

      const expected: InjectTraceResult = {
        inputContext: 'deploying auth service',
        embeddingGenerated: [0.1, 0.2, 0.3],
        candidates: [
          {
            id: '1234567890-abc123def',
            trigger: 'deploy failed',
            learning: 'check wrangler.toml first',
            similarityScore: 0.94,
            passedThreshold: true,
          },
        ],
        thresholdApplied: 0.8,
        injected: [sampleLearning],
        durationMs: 18,
        metadata: {
          totalCandidates: 1,
          aboveThreshold: 1,
          belowThreshold: 0,
        },
      }

      const mockFetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null
        return mockResponse(rawTraceResult)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.injectTrace('deploying auth service', {
        scopes: ['shared'],
        limit: 7,
        threshold: 0.8,
        identity: sampleIdentity,
      })

      expect(capturedBody).toEqual({
        context: 'deploying auth service',
        scopes: ['shared'],
        limit: 7,
        threshold: 0.8,
        identity: sampleIdentity,
      })
      expect(result).toEqual(expected)
    })
  })

  describe('query', () => {
    const sampleQueryResult: QueryResult = {
      learnings: [sampleLearning],
      hits: { shared: 1 },
    }

    test('sends correct POST request with identity', async () => {
      let capturedBody: unknown = null

      const mockFetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null
        return mockResponse(sampleQueryResult)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.query('wrangler', { identity: sampleIdentity })

      expect(capturedBody).toEqual({
        text: 'wrangler',
        scopes: ['shared'],
        limit: 10,
        identity: sampleIdentity,
      })
      expect(result.learnings).toHaveLength(1)
      expect(result.hits.shared).toBe(1)
    })
  })

  describe('list and neighbors', () => {
    test('list sends GET request without params', async () => {
      let capturedUrl = ''

      const mockFetch = mock(async (url: string) => {
        capturedUrl = url
        return mockResponse([sampleLearning])
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.list()

      expect(capturedUrl).toBe('https://deja.example.com/learnings')
      expect(result).toEqual([sampleLearning])
    })

    test('list sends GET request with query params', async () => {
      let capturedUrl = ''

      const mockFetch = mock(async (url: string) => {
        capturedUrl = url
        return mockResponse([sampleLearning])
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      await mem.list({ scope: 'agent:deployer', limit: 5 })

      expect(capturedUrl).toBe('https://deja.example.com/learnings?scope=agent%3Adeployer&limit=5')
    })

    test('learningNeighbors encodes query params and maps similarity score to camelCase', async () => {
      let capturedUrl = ''
      const rawNeighbor = { ...sampleLearning, similarity_score: 0.97 }
      const expected: LearningNeighbor = { ...sampleLearning, similarityScore: 0.97 }

      const mockFetch = mock(async (url: string) => {
        capturedUrl = url
        return mockResponse([rawNeighbor])
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.learningNeighbors('1234567890-abc123def', {
        threshold: 0.91,
        limit: 4,
      })

      expect(capturedUrl).toBe(
        'https://deja.example.com/learning/1234567890-abc123def/neighbors?threshold=0.91&limit=4',
      )
      expect(result).toEqual([expected])
    })
  })

  describe('forget and cleanup', () => {
    test('forget sends DELETE request with ID', async () => {
      let capturedRequest: { url: string; method: string } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = { url, method: init?.method || 'GET' }
        return mockResponse({ success: true })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.forget('1234567890-abc123def')

      expect(capturedRequest?.url).toBe('https://deja.example.com/learning/1234567890-abc123def')
      expect(capturedRequest?.method).toBe('DELETE')
      expect(result.success).toBe(true)
    })

    test('forgetBulk encodes the hosted filter params', async () => {
      let capturedRequest: { url: string; method: string } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = { url, method: init?.method || 'GET' }
        return mockResponse({ deleted: 2, ids: ['a', 'b'] })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.forgetBulk({
        confidenceLt: 0.3,
        notRecalledInDays: 45,
        scope: 'shared',
      })

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/learnings?confidence_lt=0.3&not_recalled_in_days=45&scope=shared',
        method: 'DELETE',
      })
      expect(result.deleted).toBe(2)
      expect(result.ids).toEqual(['a', 'b'])
    })

    test('cleanup calls the hosted cleanup route', async () => {
      let capturedRequest: { url: string; method: string; body: unknown } | null = null
      const sampleCleanup: CleanupResult = { deleted: 3, reasons: ['stale', 'empty'] }

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = {
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        }
        return mockResponse(sampleCleanup)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.cleanup()

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/cleanup',
        method: 'POST',
        body: {},
      })
      expect(result).toEqual(sampleCleanup)
    })
  })

  describe('working state', () => {
    test('getState maps snake_case state keys to camelCase', async () => {
      let capturedUrl = ''

      const mockFetch = mock(async (url: string) => {
        capturedUrl = url
        return mockResponse(sampleRawStateResponse)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.getState('run-1')

      expect(capturedUrl).toBe('https://deja.example.com/state/run-1')
      expect(result).toEqual(sampleStateResponse)
    })

    test('putState sends hosted wire shape and maps the response', async () => {
      let capturedRequest: { url: string; method: string; body: unknown } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = {
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        }
        return mockResponse(sampleRawStateResponse)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.putState(
        'run-1',
        {
          goal: 'Ship hotfix',
          assumptions: ['traffic is low'],
          decisions: [{ id: 'd-1', text: 'use canary', status: 'accepted' }],
          openQuestions: ['need rollback plan?'],
          nextActions: ['run canary deploy'],
          confidence: 0.72,
        },
        {
          updatedBy: 'ops-bot',
          changeSummary: 'initial state',
          identity: sampleIdentity,
        },
      )

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/state/run-1',
        method: 'PUT',
        body: {
          goal: 'Ship hotfix',
          assumptions: ['traffic is low'],
          decisions: [{ id: 'd-1', text: 'use canary', status: 'accepted' }],
          open_questions: ['need rollback plan?'],
          next_actions: ['run canary deploy'],
          confidence: 0.72,
          updatedBy: 'ops-bot',
          changeSummary: 'initial state',
          identity: sampleIdentity,
        },
      })
      expect(result).toEqual(sampleStateResponse)
    })

    test('patchState sends partial hosted wire shape', async () => {
      let capturedRequest: { url: string; method: string; body: unknown } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = {
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        }
        return mockResponse(sampleRawStateResponse)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      await mem.patchState(
        'run-1',
        {
          openQuestions: ['is rollback script tested?'],
        },
        {
          updatedBy: 'ops-bot',
          identity: sampleIdentity,
        },
      )

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/state/run-1',
        method: 'PATCH',
        body: {
          goal: undefined,
          assumptions: undefined,
          decisions: undefined,
          open_questions: ['is rollback script tested?'],
          next_actions: undefined,
          confidence: undefined,
          updatedBy: 'ops-bot',
          identity: sampleIdentity,
        },
      })
    })

    test('addStateEvent sends event payload and identity', async () => {
      let capturedRequest: { url: string; method: string; body: unknown } | null = null
      const sampleEvent: StateEventResult = { success: true, id: 'evt-1' }

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = {
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        }
        return mockResponse(sampleEvent)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.addStateEvent(
        'run-1',
        'note',
        { message: 'rollback ready' },
        { createdBy: 'ops-bot', identity: sampleIdentity },
      )

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/state/run-1/events',
        method: 'POST',
        body: {
          eventType: 'note',
          payload: { message: 'rollback ready' },
          createdBy: 'ops-bot',
          identity: sampleIdentity,
        },
      })
      expect(result).toEqual(sampleEvent)
    })

    test('resolveState sends resolve options and maps the response', async () => {
      let capturedRequest: { url: string; method: string; body: unknown } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = {
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        }
        return mockResponse({ ...sampleRawStateResponse, status: 'resolved' })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.resolveState('run-1', {
        persistToLearn: true,
        scope: 'shared',
        summaryStyle: 'compact',
        updatedBy: 'ops-bot',
        identity: sampleIdentity,
      })

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/state/run-1/resolve',
        method: 'POST',
        body: {
          persistToLearn: true,
          scope: 'shared',
          summaryStyle: 'compact',
          updatedBy: 'ops-bot',
          identity: sampleIdentity,
        },
      })
      expect(result.status).toBe('resolved')
      expect(result.state.openQuestions).toEqual(['need rollback plan?'])
    })
  })

  describe('secrets', () => {
    const sampleSecrets: Secret[] = [
      {
        name: 'api-token',
        value: 'secret',
        scope: 'shared',
        createdAt: '2026-02-04T12:00:00.000Z',
        updatedAt: '2026-02-04T12:01:00.000Z',
      },
    ]

    test('setSecret posts the secret payload', async () => {
      let capturedRequest: { url: string; method: string; body: unknown } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = {
          url,
          method: init?.method || 'GET',
          body: init?.body ? JSON.parse(init.body as string) : null,
        }
        return mockResponse({ success: true })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.setSecret('api-token', 'secret', { scope: 'agent:deployer' })

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/secret',
        method: 'POST',
        body: {
          name: 'api-token',
          value: 'secret',
          scope: 'agent:deployer',
        },
      })
      expect(result.success).toBe(true)
    })

    test('getSecret encodes scopes and unwraps the value', async () => {
      let capturedUrl = ''

      const mockFetch = mock(async (url: string) => {
        capturedUrl = url
        return mockResponse({ value: 'secret' })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.getSecret('api-token', { scopes: ['agent:deployer', 'shared'] })

      expect(capturedUrl).toBe('https://deja.example.com/secret/api-token?scopes=agent%3Adeployer%2Cshared')
      expect(result).toBe('secret')
    })

    test('deleteSecret encodes the scope param', async () => {
      let capturedRequest: { url: string; method: string } | null = null

      const mockFetch = mock(async (url: string, init?: RequestInit) => {
        capturedRequest = { url, method: init?.method || 'GET' }
        return mockResponse({ success: true })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.deleteSecret('api-token', { scope: 'agent:deployer' })

      expect(capturedRequest).toEqual({
        url: 'https://deja.example.com/secret/api-token?scope=agent%3Adeployer',
        method: 'DELETE',
      })
      expect(result.success).toBe(true)
    })

    test('listSecrets sends the scope filter', async () => {
      let capturedUrl = ''

      const mockFetch = mock(async (url: string) => {
        capturedUrl = url
        return mockResponse(sampleSecrets)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.listSecrets({ scope: 'shared' })

      expect(capturedUrl).toBe('https://deja.example.com/secrets?scope=shared')
      expect(result).toEqual(sampleSecrets)
    })
  })

  describe('stats and runs', () => {
    const sampleStats: Stats = {
      totalLearnings: 42,
      totalSecrets: 3,
      scopes: {
        shared: { learnings: 30, secrets: 2 },
        'agent:deployer': { learnings: 12, secrets: 1 },
      },
    }

    test('stats sends GET request and returns stats', async () => {
      let capturedUrl = ''

      const mockFetch = mock(async (url: string) => {
        capturedUrl = url
        return mockResponse(sampleStats)
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.stats()

      expect(capturedUrl).toBe('https://deja.example.com/stats')
      expect(result.totalLearnings).toBe(42)
      expect(result.scopes.shared.learnings).toBe(30)
    })

    test('recordRun posts loop outcome data', async () => {
      let capturedBody: unknown = null

      const mockFetch = mock(async (_url: string, init?: RequestInit) => {
        capturedBody = init?.body ? JSON.parse(init.body as string) : null
        return mockResponse({
          id: 'run-1',
          scope: 'shared',
          outcome: 'pass',
          attempts: 3,
          code: 'console.log("ok")',
          createdAt: '2026-02-04T12:00:00.000Z',
        })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.recordRun('pass', 3, { scope: 'shared', code: 'console.log("ok")' })

      expect(capturedBody).toEqual({
        outcome: 'pass',
        attempts: 3,
        scope: 'shared',
        code: 'console.log("ok")',
        error: undefined,
      })
      expect(result.outcome).toBe('pass')
    })

    test('getRuns sends scope and limit query params', async () => {
      let capturedUrl = ''

      const mockFetch = mock(async (url: string) => {
        capturedUrl = url
        return mockResponse({
          runs: [],
          stats: {
            total: 0,
            pass: 0,
            fail: 0,
            exhausted: 0,
            mean_attempts: 0,
            best_attempts: 0,
            trend: 'insufficient_data',
          },
        })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      const result = await mem.getRuns({ scope: 'shared', limit: 25 })

      expect(capturedUrl).toBe('https://deja.example.com/runs?scope=shared&limit=25')
      expect(result.stats.trend).toBe('insufficient_data')
    })
  })

  describe('error handling', () => {
    test('throws on HTTP error with message from response', async () => {
      const mockFetch = mock(async () => {
        return new Response(JSON.stringify({ error: 'unauthorized - API key required' }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })

      await expect(mem.learn('test', 'test')).rejects.toThrow('unauthorized - API key required')
    })

    test('throws on HTTP error with status fallback when JSON parse fails', async () => {
      const mockFetch = mock(async () => {
        return new Response('Internal Server Error', {
          status: 500,
          statusText: 'Internal Server Error',
        })
      })

      const mem = deja('https://deja.example.com', { fetch: mockFetch as typeof fetch })
      await expect(mem.stats()).rejects.toThrow('Internal Server Error')
    })
  })

  describe('URL handling', () => {
    test('strips trailing slash from base URL', async () => {
      let capturedUrl = ''

      const mockFetch = mock(async (url: string) => {
        capturedUrl = url
        return mockResponse(sampleLearning)
      })

      const mem = deja('https://deja.example.com/', { fetch: mockFetch as typeof fetch })
      await mem.learn('test', 'test')

      expect(capturedUrl).toBe('https://deja.example.com/learn')
    })
  })
})
