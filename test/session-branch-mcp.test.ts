import worker from '../src/index';

// Follows the style of test/lean-mcp.test.ts — stub `stub.fetch` at the env
// level, fire a real Request through `worker.fetch`, then assert on which
// internal endpoint got hit and what the JSON-RPC result looks like.

interface StubResponder {
  match: (method: string, path: string) => boolean;
  respond: (path: string, body: any) => Promise<Response>;
}

function makeStubResponder(responders: StubResponder[]) {
  const calls: Array<{ method: string; path: string; body: any }> = [];
  const fetch = async (input: Request | string, init?: RequestInit) => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const bodyText = request.body ? await request.text() : '';
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    calls.push({ method, path: url.pathname, body });

    const match = responders.find((r) => r.match(method, url.pathname));
    if (!match) {
      return new Response(JSON.stringify({ error: `no stub for ${method} ${url.pathname}` }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return match.respond(url.pathname, body);
  };
  return { fetch, calls };
}

function makeEnv(stubFetch: any) {
  return {
    DEJA: {
      idFromName: () => 'durable-id',
      get: () => ({ fetch: stubFetch }),
    },
    API_KEY: 'test-key',
  } as any;
}

async function rpc(env: any, endpoint: string, body: any) {
  const request = new Request(`http://localhost${endpoint}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-key' },
    body: JSON.stringify(body),
  });
  const response = await worker.fetch(request, env);
  return response.json() as Promise<any>;
}

describe('lean-MCP session-branch dispatch', () => {
  it('execute({op:"bless"}) POSTs to /session/:id/bless', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'POST' && path === '/session/sess-abc/bless',
        respond: async () =>
          new Response(
            JSON.stringify({
              sessionId: 'sess-abc',
              blessedAt: '2026-04-23T12:00:00Z',
              promotedCount: 2,
              promotedIds: ['mem-1', 'mem-2'],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { op: 'bless', args: { session_id: 'sess-abc' } },
      },
    });

    expect(result.result).toBeTruthy();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe('POST');
    expect(stub.calls[0].path).toBe('/session/sess-abc/bless');
    // The blessing response round-trips through MCP content text.
    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(parsed?.promotedCount).toBe(2);
    expect(parsed?.promotedIds).toEqual(['mem-1', 'mem-2']);
  });

  it('execute({op:"bless"}) unwraps a "session:<id>" arg', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'POST' && path === '/session/sess-xyz/bless',
        respond: async () =>
          new Response(
            JSON.stringify({
              sessionId: 'sess-xyz',
              blessedAt: '2026-04-23T12:00:00Z',
              promotedCount: 0,
              promotedIds: [],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      },
    ]);
    const env = makeEnv(stub.fetch);

    await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { op: 'bless', args: { session_id: 'session:sess-xyz' } },
      },
    });

    expect(stub.calls[0].path).toBe('/session/sess-xyz/bless');
  });

  it('execute({op:"bless"}) forwards learning_ids when provided', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'POST' && path === '/session/sess-1/bless',
        respond: async () =>
          new Response(
            JSON.stringify({
              sessionId: 'sess-1',
              blessedAt: '2026-04-23T12:00:00Z',
              promotedCount: 1,
              promotedIds: ['mem-a'],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      },
    ]);
    const env = makeEnv(stub.fetch);

    await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: {
          op: 'bless',
          args: { session_id: 'sess-1', learning_ids: ['mem-a'] },
        },
      },
    });

    expect(stub.calls[0].body).toEqual({ learning_ids: ['mem-a'] });
  });

  it('execute({op:"discard"}) POSTs to /session/:id/discard', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'POST' && path === '/session/sess-2/discard',
        respond: async () =>
          new Response(
            JSON.stringify({
              sessionId: 'sess-2',
              discardedAt: '2026-04-23T12:00:00Z',
              deletedCount: 3,
              deletedIds: ['mem-x', 'mem-y', 'mem-z'],
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { op: 'discard', args: { session_id: 'sess-2' } },
      },
    });

    expect(stub.calls[0].path).toBe('/session/sess-2/discard');
    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(parsed?.deletedCount).toBe(3);
  });

  it('execute({op:"branch_status"}) GETs /session/:id/status', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'GET' && path === '/session/sess-3/status',
        respond: async () =>
          new Response(
            JSON.stringify({
              sessionId: 'sess-3',
              status: 'open',
              createdAt: '2026-04-23T10:00:00Z',
              expiresAt: '2026-04-24T10:00:00Z',
              blessedAt: null,
              discardedAt: null,
              sessionCount: 5,
              blessedCount: 0,
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { op: 'branch_status', args: { session_id: 'sess-3' } },
      },
    });

    expect(stub.calls[0].method).toBe('GET');
    expect(stub.calls[0].path).toBe('/session/sess-3/status');
    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(parsed?.status).toBe('open');
    expect(parsed?.sessionCount).toBe(5);
  });

  it('execute({op:"list_branches"}) GETs /sessions', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'GET' && path === '/sessions',
        respond: async () =>
          new Response(
            JSON.stringify([
              {
                sessionId: 'sess-newer',
                status: 'open',
                createdAt: '2026-04-23T10:00:00Z',
                expiresAt: '2026-04-24T10:00:00Z',
                blessedAt: null,
                discardedAt: null,
                sessionCount: 2,
                blessedCount: 0,
              },
            ]),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: { name: 'execute', arguments: { op: 'list_branches', args: {} } },
    });

    expect(stub.calls[0].method).toBe('GET');
    expect(stub.calls[0].path).toBe('/sessions');
    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed?.[0]?.sessionId).toBe('sess-newer');
  });

  it('execute({op:"bless"}) with missing session_id returns a helpful error', async () => {
    const stub = makeStubResponder([
      {
        match: () => true,
        respond: async () => new Response('{}'),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: { name: 'execute', arguments: { op: 'bless', args: {} } },
    });

    // JSON-RPC error envelope.
    expect(result.error || result.result?.isError).toBeTruthy();
    const message =
      result.error?.message ??
      result.result?.content?.[0]?.text ??
      '';
    expect(message).toMatch(/session_id/i);
  });

  it('lean search passes branch_state through on every hit', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'POST' && path === '/inject/trace',
        respond: async () =>
          new Response(
            JSON.stringify({
              input_context: 'ctx',
              embedding_generated: [],
              candidates: [
                {
                  id: 'mem-1',
                  trigger: 't',
                  learning: 'body',
                  similarity_score: 0.9,
                  passed_threshold: true,
                  confidence: 0.8,
                  scope: 'shared',
                  recall_count: 3,
                  created_at: '2026-04-20T00:00:00Z',
                  last_recalled_at: null,
                  anti_pattern: false,
                  supersedes: null,
                  suspect_score: 0.1,
                  branch_state: 'main',
                },
                {
                  id: 'mem-2',
                  trigger: 't2',
                  learning: 'body2',
                  similarity_score: 0.7,
                  passed_threshold: true,
                  confidence: 0.5,
                  scope: 'session:abc',
                  recall_count: 0,
                  created_at: '2026-04-23T10:00:00Z',
                  last_recalled_at: null,
                  anti_pattern: false,
                  supersedes: null,
                  suspect_score: 0.2,
                  branch_state: 'session',
                },
              ],
              threshold_applied: 0,
              injected: [],
              duration_ms: 5,
              metadata: { total_candidates: 2, above_threshold: 2, below_threshold: 0 },
            }),
            { headers: { 'Content-Type': 'application/json' } },
          ),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/call',
      params: {
        name: 'search',
        arguments: { query: 'anything', scopes: ['session:abc', 'shared'] },
      },
    });

    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(Array.isArray(parsed?.hits)).toBe(true);
    // Bodies stripped, but branch_state is surfaced so agents can triage
    // session vs main vs blessed hits without pulling the body.
    const [firstHit, secondHit] = parsed?.hits ?? [];
    expect(firstHit).toBeTruthy();
    expect(firstHit).not.toHaveProperty('learning');
    expect(firstHit).toHaveProperty('suspect_score');
    expect(firstHit).toHaveProperty('branch_state', 'main');
    expect(secondHit).toHaveProperty('branch_state', 'session');
  });
});
