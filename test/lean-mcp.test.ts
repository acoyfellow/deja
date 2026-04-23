/**
 * Integration tests for the lean MCP surface (/mcp/lean).
 *
 * The lean variant must:
 *   - advertise exactly 3 top-level tools (search, execute, inject) via tools/list
 *   - dispatch `search` to inject_trace under the hood, stripping learning bodies
 *   - dispatch `execute(op=...)` to the matching legacy handler
 *   - reject unknown execute ops
 *   - surface suspect_score metadata on search hits
 *
 * We exercise the public `fetch` handler by stubbing the DO stub at the env
 * level and asserting which internal endpoint got hit.
 */

import worker from '../src/index';

function makeStubResponder(
  responders: Array<{ match: (url: string, method: string) => boolean; respond: (url: string, init?: RequestInit) => any }>,
) {
  const calls: Array<{ url: string; method: string }> = [];
  const fetch = jest.fn(async (request: Request) => {
    calls.push({ url: request.url, method: request.method });
    for (const { match, respond } of responders) {
      if (match(request.url, request.method)) {
        const body = await respond(request.url, { method: request.method });
        return new Response(JSON.stringify(body), {
          headers: { 'Content-Type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({ error: `unhandled: ${request.method} ${request.url}` }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  return { fetch, calls };
}

function makeEnv(stubFetch: jest.Mock) {
  return {
    DEJA: {
      idFromName: jest.fn().mockReturnValue({ toString: () => 'mock-id' }),
      get: jest.fn().mockReturnValue({ fetch: stubFetch }),
    } as any,
    VECTORIZE: {} as any,
    AI: {} as any,
    API_KEY: undefined, // no auth for simplicity
  };
}

async function rpc(env: any, endpoint: string, body: Record<string, unknown>) {
  const request = new Request(`https://api.example.com${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, ...body }),
  });
  const response = await (worker as any).fetch(request, env);
  return response.json();
}

describe('lean MCP', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('tools/list returns exactly 3 lean tools', async () => {
    const { fetch } = makeStubResponder([]);
    const env = makeEnv(fetch);

    const result = await rpc(env, '/mcp/lean', { method: 'tools/list', params: {} });
    expect(result.result.tools).toHaveLength(3);
    expect(result.result.tools.map((tool: any) => tool.name).sort()).toEqual(['execute', 'inject', 'search']);
  });

  test('full /mcp surface is unchanged (>10 tools)', async () => {
    const { fetch } = makeStubResponder([]);
    const env = makeEnv(fetch);

    const result = await rpc(env, '/mcp', { method: 'tools/list', params: {} });
    expect(result.result.tools.length).toBeGreaterThan(10);
  });

  test('lean search dispatches to inject/trace and surfaces suspect_score', async () => {
    const { fetch, calls } = makeStubResponder([
      {
        match: (url, method) => url.includes('/inject/trace') && method === 'POST',
        respond: async () => ({
          candidates: [
            {
              id: 'mem-1',
              trigger: 'deploying to production',
              learning: 'full body we should NOT leak in a search hit',
              similarity_score: 0.88,
              passed_threshold: true,
              confidence: 0.9,
              scope: 'shared',
              recall_count: 3,
              created_at: '2026-04-23T00:00:00.000Z',
              last_recalled_at: null,
              anti_pattern: false,
              supersedes: null,
              suspect_score: 0.05,
            },
          ],
          threshold_applied: 0,
          metadata: { total_candidates: 1, above_threshold: 1, below_threshold: 0 },
        }),
      },
    ]);
    const env = makeEnv(fetch);

    const rpcResult = await rpc(env, '/mcp/lean', {
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: { query: 'deploy safely' },
      },
    });

    expect(calls.some((call) => call.url.includes('/inject/trace'))).toBe(true);
    const payload = JSON.parse(rpcResult.result.content[0].text);
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0].suspect_score).toBe(0.05);
    // Verify learning body is stripped from search hits.
    expect(payload.hits[0]).not.toHaveProperty('learning');
    expect(payload.hits[0].id).toBe('mem-1');
    expect(payload.hits[0].similarity_score).toBe(0.88);
  });

  test('lean execute(op=learn) dispatches to /learn', async () => {
    const { fetch, calls } = makeStubResponder([
      {
        match: (url, method) => url.includes('/learn') && !url.includes('neighbors') && method === 'POST',
        respond: async () => ({ id: 'mem-new', learning: 'stored' }),
      },
    ]);
    const env = makeEnv(fetch);

    const rpcResult = await rpc(env, '/mcp/lean', {
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: {
          op: 'learn',
          args: { trigger: 'ci', learning: 'rerun flaky tests twice before reporting' },
        },
      },
    });

    expect(calls.some((call) => call.url.endsWith('/learn'))).toBe(true);
    const payload = JSON.parse(rpcResult.result.content[0].text);
    expect(payload.id).toBe('mem-new');
  });

  test('lean execute(op=inject) dispatches to /inject', async () => {
    const { fetch, calls } = makeStubResponder([
      {
        match: (url, method) => url.endsWith('/inject') && method === 'POST',
        respond: async () => ({ prompt: 'When deploying, run dry-run.', learnings: [] }),
      },
    ]);
    const env = makeEnv(fetch);

    const rpcResult = await rpc(env, '/mcp/lean', {
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { op: 'inject', args: { context: 'deploying staging' } },
      },
    });

    expect(calls.some((call) => call.url.endsWith('/inject'))).toBe(true);
    const payload = JSON.parse(rpcResult.result.content[0].text);
    expect(payload.prompt).toContain('dry-run');
  });

  test('lean execute(op=read) looks up a learning by id via /learnings', async () => {
    const { fetch, calls } = makeStubResponder([
      {
        match: (url, method) => url.includes('/learnings') && method === 'GET',
        respond: async () => ([
          { id: 'mem-1', trigger: 'deploy', learning: 'full body', confidence: 0.9 },
          { id: 'mem-2', trigger: 'test', learning: 'other', confidence: 0.5 },
        ]),
      },
    ]);
    const env = makeEnv(fetch);

    const rpcResult = await rpc(env, '/mcp/lean', {
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { op: 'read', args: { id: 'mem-1' } },
      },
    });

    expect(calls.some((call) => call.url.includes('/learnings'))).toBe(true);
    const payload = JSON.parse(rpcResult.result.content[0].text);
    expect(payload.found).toBe(true);
    expect(payload.learning.id).toBe('mem-1');
  });

  test('lean execute rejects unknown ops with a helpful message', async () => {
    const { fetch } = makeStubResponder([]);
    const env = makeEnv(fetch);

    const rpcResult = await rpc(env, '/mcp/lean', {
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { op: 'yolo', args: {} },
      },
    });

    expect(rpcResult.error).toBeDefined();
    expect(rpcResult.error.message).toMatch(/unknown op.*yolo/i);
  });

  test('GET /mcp/lean returns discovery metadata', async () => {
    const { fetch } = makeStubResponder([]);
    const env = makeEnv(fetch);

    const request = new Request('https://api.example.com/mcp/lean');
    const response = await (worker as any).fetch(request, env);
    const body = await response.json();

    expect(body.name).toBe('deja-lean');
    expect(body.tools.sort()).toEqual(['execute', 'inject', 'search']);
    expect(Array.isArray(body.execute_ops)).toBe(true);
    expect(body.execute_ops).toContain('learn');
    expect(body.execute_ops).toContain('trace');
  });
});
