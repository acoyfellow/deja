import worker from '../src/index';

// Same dispatch pattern as test/session-branch-mcp.test.ts: stub the DO
// fetch at the env level, fire a JSON-RPC Request through worker.fetch,
// assert on which internal endpoint got hit.

interface StubResponder {
  match: (method: string, path: string) => boolean;
  respond: (path: string, body: any) => Promise<Response>;
}

function makeStubResponder(responders: StubResponder[]) {
  const calls: Array<{ method: string; path: string; body: any; search: string }> = [];
  const fetch = async (input: Request | string, init?: RequestInit) => {
    const request = typeof input === 'string' ? new Request(input, init) : input;
    const url = new URL(request.url);
    const method = request.method.toUpperCase();
    const bodyText = request.body ? await request.text() : '';
    const body = bodyText ? JSON.parse(bodyText) : undefined;
    calls.push({ method, path: url.pathname, body, search: url.search });

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

const SAMPLE_PACKET = {
  sessionId: 'sess-h1',
  createdAt: '2026-04-23T10:00:00.000Z',
  authoredBy: 'claude-opus-4-7',
  summary: 'Landed handoff-packet.',
  whatShipped: ['schema', 'routes'],
  whatBlessed: [{ learningId: 'mem-42', note: 'blessed-visibility fix' }],
  whatRemains: ['auto-inject behavior'],
};

describe('lean-MCP handoff dispatch', () => {
  it('execute({op:"handoff_create"}) POSTs to /handoff with the full body', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'POST' && path === '/handoff',
        respond: async () =>
          new Response(JSON.stringify(SAMPLE_PACKET), {
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: {
          op: 'handoff_create',
          args: {
            sessionId: 'sess-h1',
            authoredBy: 'claude-opus-4-7',
            summary: 'Landed handoff-packet.',
            whatShipped: ['schema', 'routes'],
            whatBlessed: [{ learningId: 'mem-42', note: 'blessed-visibility fix' }],
            whatRemains: ['auto-inject behavior'],
          },
        },
      },
    });

    expect(result.result).toBeTruthy();
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0].method).toBe('POST');
    expect(stub.calls[0].path).toBe('/handoff');
    // Body forwarded with sessionId present.
    expect(stub.calls[0].body?.sessionId).toBe('sess-h1');
    expect(stub.calls[0].body?.summary).toBe('Landed handoff-packet.');
    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(parsed?.sessionId).toBe('sess-h1');
  });

  it('execute({op:"handoff_create"}) without sessionId returns a helpful error', async () => {
    const stub = makeStubResponder([
      { match: () => true, respond: async () => new Response('{}') },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'execute', arguments: { op: 'handoff_create', args: { summary: 's' } } },
    });

    const message =
      result.error?.message ??
      result.result?.content?.[0]?.text ??
      '';
    expect(result.error || result.result?.isError).toBeTruthy();
    expect(message).toMatch(/sessionId/i);
  });

  it('execute({op:"handoff_get"}) GETs /handoff/:id and wraps the response', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'GET' && path === '/handoff/sess-h1',
        respond: async () =>
          new Response(JSON.stringify(SAMPLE_PACKET), {
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 3,
      method: 'tools/call',
      params: { name: 'execute', arguments: { op: 'handoff_get', args: { sessionId: 'sess-h1' } } },
    });

    expect(stub.calls[0].path).toBe('/handoff/sess-h1');
    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(parsed?.found).toBe(true);
    expect(parsed?.packet?.sessionId).toBe('sess-h1');
  });

  it('execute({op:"handoff_get"}) returns {found:false} on 404', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'GET' && path === '/handoff/sess-ghost',
        respond: async () =>
          new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 4,
      method: 'tools/call',
      params: { name: 'execute', arguments: { op: 'handoff_get', args: { sessionId: 'sess-ghost' } } },
    });

    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(parsed?.found).toBe(false);
    expect(parsed?.sessionId).toBe('sess-ghost');
  });

  it('execute({op:"handoff_list"}) GETs /handoffs with optional ?limit', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'GET' && path === '/handoffs',
        respond: async () =>
          new Response(JSON.stringify([SAMPLE_PACKET]), {
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 5,
      method: 'tools/call',
      params: { name: 'execute', arguments: { op: 'handoff_list', args: { limit: 5 } } },
    });

    expect(stub.calls[0].method).toBe('GET');
    expect(stub.calls[0].path).toBe('/handoffs');
    expect(stub.calls[0].search).toBe('?limit=5');
    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed?.[0]?.sessionId).toBe('sess-h1');
  });

  it('execute({op:"handoff_read"}) fetches ?format=markdown and returns the rendered body', async () => {
    const markdown =
      '# Session handoff — sess-h1\n\n**Created:** 2026-04-23T10:00:00.000Z  **By:** claude-opus-4-7\n\nLanded handoff-packet.\n\n## What shipped\n- schema\n- routes';
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'GET' && path === '/handoff/sess-h1',
        respond: async () =>
          new Response(markdown, {
            headers: { 'Content-Type': 'text/markdown; charset=utf-8' },
          }),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 6,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { op: 'handoff_read', args: { sessionId: 'sess-h1' } },
      },
    });

    expect(stub.calls[0].method).toBe('GET');
    expect(stub.calls[0].path).toBe('/handoff/sess-h1');
    expect(stub.calls[0].search).toBe('?format=markdown');
    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(parsed?.found).toBe(true);
    expect(parsed?.markdown).toContain('# Session handoff — sess-h1');
    expect(parsed?.markdown).toContain('## What shipped');
  });

  it('execute({op:"handoff_read"}) returns {found:false} on 404', async () => {
    const stub = makeStubResponder([
      {
        match: (method, path) => method === 'GET' && path === '/handoff/sess-ghost',
        respond: async () =>
          new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: { 'Content-Type': 'application/json' },
          }),
      },
    ]);
    const env = makeEnv(stub.fetch);

    const result = await rpc(env, '/mcp/lean', {
      jsonrpc: '2.0',
      id: 7,
      method: 'tools/call',
      params: {
        name: 'execute',
        arguments: { op: 'handoff_read', args: { sessionId: 'sess-ghost' } },
      },
    });

    const text = result.result?.content?.[0]?.text;
    const parsed = text ? JSON.parse(text) : null;
    expect(parsed?.found).toBe(false);
  });

  it('full /mcp surface advertises handoff_create / handoff_get / handoff_list', async () => {
    const stub = makeStubResponder([]);
    const env = makeEnv(stub.fetch);
    const response = await rpc(env, '/mcp', {
      jsonrpc: '2.0',
      id: 8,
      method: 'tools/list',
      params: {},
    });
    const names = response.result.tools.map((t: any) => t.name);
    expect(names).toContain('handoff_create');
    expect(names).toContain('handoff_get');
    expect(names).toContain('handoff_list');
  });
});
