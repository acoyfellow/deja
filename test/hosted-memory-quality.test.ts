import worker from '../src/index';
import { cleanup } from '../src/cleanup';
import { convertDbLearning } from '../src/do/helpers';
import { DejaDO } from '../src/do/DejaDO';
import {
  confirmMemory,
  injectMemories,
  learnMemory,
  rejectMemory,
} from '../src/do/memory';

function makeLearningRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mem-1',
    trigger: 'deploying to production',
    learning: 'check wrangler.toml first',
    reason: null,
    confidence: 0.5,
    source: null,
    scope: 'shared',
    supersedes: null,
    type: 'memory',
    embedding: JSON.stringify([0.11, 0.22, 0.33]),
    createdAt: '2026-03-01T00:00:00.000Z',
    lastRecalledAt: null,
    recallCount: 0,
    traceId: null,
    workspaceId: null,
    conversationId: null,
    runId: null,
    proofRunId: null,
    proofIterationId: null,
    ...overrides,
  };
}

function makeAwaitableQuery(rows: any[]) {
  const promise = Promise.resolve(rows);
  return {
    limit: jest.fn().mockResolvedValue(rows),
    orderBy: jest.fn().mockResolvedValue(rows),
    then: promise.then.bind(promise),
    catch: promise.catch.bind(promise),
    finally: promise.finally.bind(promise),
  };
}

function makeSelectMock(...rowsByCall: any[][]) {
  const calls = rowsByCall.map((rows) => {
    const query = makeAwaitableQuery(rows);
    return {
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue(query),
        limit: query.limit,
        orderBy: query.orderBy,
        then: query.then,
        catch: query.catch,
        finally: query.finally,
      }),
    };
  });

  return jest.fn().mockImplementation(() => {
    const next = calls.shift();
    if (!next) {
      throw new Error('Unexpected select call');
    }
    return next;
  });
}

function makeDb(...rowsBySelectCall: any[][]) {
  const insertValues = jest.fn().mockResolvedValue(undefined);
  const updateWhere = jest.fn().mockResolvedValue(undefined);
  const updateSet = jest.fn().mockReturnValue({ where: updateWhere });

  return {
    db: {
      select: makeSelectMock(...rowsBySelectCall),
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      update: jest.fn().mockReturnValue({ set: updateSet }),
    },
    spies: {
      insertValues,
      updateSet,
      updateWhere,
    },
  };
}

function makeMemoryContext(db: any, matches: Array<{ id: string; score: number }> = []) {
  const createEmbedding = jest.fn().mockResolvedValue([0.12, 0.34, 0.56]);
  const vectorize = {
    query: jest.fn().mockResolvedValue({ matches }),
    insert: jest.fn().mockResolvedValue(undefined),
    deleteByIds: jest.fn().mockResolvedValue(undefined),
  };

  return {
    ctx: {
      env: { VECTORIZE: vectorize },
      initDB: jest.fn().mockResolvedValue(db),
      createEmbedding,
      filterScopesByPriority: (scopes: string[]) => scopes,
      convertDbLearning,
    },
    spies: {
      createEmbedding,
      vectorize,
    },
  };
}

function createMockState() {
  return {
    blockConcurrencyWhile: jest.fn(async (fn: () => Promise<void>) => fn()),
    storage: {
      sql: {
        exec: jest.fn(),
      },
    },
  };
}

describe('hosted memory quality', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('learnMemory deduplicates a near-identical Vectorize neighbor and records proof ids', async () => {
    const existingRow = makeLearningRow();
    const { db, spies } = makeDb([existingRow]);
    const { ctx, spies: ctxSpies } = makeMemoryContext(db, [{ id: 'mem-1', score: 0.97 }]);

    const result = await learnMemory(
      ctx as any,
      'shared',
      'deploying to production',
      'check wrangler.toml first',
      0.8,
      undefined,
      undefined,
      { proofRunId: 'proof-run-1', proofIterationId: 'proof-run-1:1' },
    );

    expect(result.id).toBe('mem-1');
    expect(db.insert).not.toHaveBeenCalled();
    expect(ctxSpies.vectorize.insert).not.toHaveBeenCalled();
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        proofRunId: 'proof-run-1',
        proofIterationId: 'proof-run-1:1',
      }),
    );
    expect(result.identity).toEqual({
      traceId: null,
      workspaceId: null,
      conversationId: null,
      runId: null,
      proofRunId: 'proof-run-1',
      proofIterationId: 'proof-run-1:1',
    });
  });

  test('learnMemory inserts conflicting memories with supersedes and crushes the old confidence', async () => {
    const existingRow = makeLearningRow({ id: 'old-1', confidence: 0.5 });
    const { db, spies } = makeDb([existingRow]);
    const { ctx, spies: ctxSpies } = makeMemoryContext(db, [{ id: 'old-1', score: 0.72 }]);

    const result = await learnMemory(
      ctx as any,
      'shared',
      'deploying to production',
      'run a dry-run before deploying to production',
    );

    expect(result.supersedes).toBe('old-1');
    expect(result.type).toBe('memory');
    expect(spies.updateSet).toHaveBeenCalledWith({ confidence: 0.15 });
    expect(spies.insertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        supersedes: 'old-1',
        type: 'memory',
      }),
    );
    expect(ctxSpies.vectorize.insert).toHaveBeenCalledTimes(1);
  });

  test('confirmMemory boosts confidence and stores proof metadata', async () => {
    const { db, spies } = makeDb([makeLearningRow()]);
    const { ctx, spies: ctxSpies } = makeMemoryContext(db);

    const result = await confirmMemory(ctx as any, 'mem-1', {
      proofRunId: 'proof-run-2',
      proofIterationId: 'proof-run-2:4',
    });

    expect(result?.confidence).toBe(0.6);
    expect(result?.identity?.proofRunId).toBe('proof-run-2');
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        confidence: 0.6,
        proofRunId: 'proof-run-2',
        proofIterationId: 'proof-run-2:4',
      }),
    );
    expect(ctxSpies.vectorize.insert).not.toHaveBeenCalled();
  });

  test('rejectMemory inverts low-confidence memories into anti-patterns and updates Vectorize', async () => {
    const { db, spies } = makeDb([
      makeLearningRow({
        trigger: 'parsing JSON responses',
        learning: 'use eval for parsing JSON',
        confidence: 0.2,
      }),
    ]);
    const { ctx, spies: ctxSpies } = makeMemoryContext(db);

    const result = await rejectMemory(ctx as any, 'mem-1', {
      proofRunId: 'proof-run-3',
      proofIterationId: 'proof-run-3:9',
    });

    expect(result?.type).toBe('anti-pattern');
    expect(result?.confidence).toBe(0.5);
    expect(result?.learning).toBe('KNOWN PITFALL: use eval for parsing JSON');
    expect(ctxSpies.createEmbedding).toHaveBeenCalledWith(
      'When parsing JSON responses, use eval for parsing JSON',
    );
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        learning: 'KNOWN PITFALL: use eval for parsing JSON',
        confidence: 0.5,
        type: 'anti-pattern',
        proofRunId: 'proof-run-3',
        proofIterationId: 'proof-run-3:9',
      }),
    );
    expect(ctxSpies.vectorize.insert).toHaveBeenCalledTimes(1);
  });

  test('learnMemory without sync returns no `synced` field and skips VECTORIZE.query for polling', async () => {
    const { db } = makeDb([]); // no dedupe hit
    const { ctx, spies: ctxSpies } = makeMemoryContext(db, []);

    const result = await learnMemory(
      ctx as any,
      'shared',
      'deploying',
      'check wrangler.toml',
    );

    expect(result.id).toBeDefined();
    expect(result).not.toHaveProperty('synced');
    // The only VECTORIZE.query call should be the dedupe lookup inside
    // getNearestLearningMatches (1 call). No additional polling.
    expect(ctxSpies.vectorize.query).toHaveBeenCalledTimes(1);
    expect(ctxSpies.vectorize.insert).toHaveBeenCalledTimes(1);
  });

  test('learnMemory with sync:true returns synced:true when VECTORIZE.query reports the new id', async () => {
    const { db } = makeDb([]); // no dedupe hit
    const { ctx, spies: ctxSpies } = makeMemoryContext(db, []);

    // First query call = dedupe lookup (no matches). Subsequent calls =
    // the sync-wait polling: make it succeed immediately by returning the
    // freshly-inserted id.
    let call = 0;
    ctxSpies.vectorize.query.mockImplementation(async () => {
      call += 1;
      if (call === 1) return { matches: [] }; // dedupe pass
      // Polling: grab the id that was just inserted.
      const insertedId = ctxSpies.vectorize.insert.mock.calls[0]?.[0]?.[0]?.id;
      return { matches: insertedId ? [{ id: insertedId, score: 1 }] : [] };
    });

    const result = await learnMemory(
      ctx as any,
      'shared',
      'deploying',
      'check wrangler.toml',
      0.5,
      undefined,
      undefined,
      undefined,
      { sync: true },
    );

    expect(result.synced).toBe(true);
    // dedupe query + at least one poll query.
    expect(ctxSpies.vectorize.query.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('learnMemory with sync:true returns synced:false when Vectorize never reports the id', async () => {
    const { db } = makeDb([]); // no dedupe hit
    const { ctx, spies: ctxSpies } = makeMemoryContext(db, []);

    // Use fake timers + a guaranteed-never-sync mock: dedupe query returns
    // empty, poll queries return empty forever. We tick past the 30s
    // budget to force the wait function to bail with synced:false.
    // fake-timers also makes the setTimeout-based backoff instant.
    jest.useFakeTimers();

    try {
      const promise = learnMemory(
        ctx as any,
        'shared',
        'deploying',
        'check wrangler.toml',
        0.5,
        undefined,
        undefined,
        undefined,
        { sync: true },
      );

      // Flush microtasks + timers repeatedly until we've pushed past the
      // 30s budget. Each tick advances enough to clear the 2s cap-interval.
      for (let i = 0; i < 40; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await Promise.resolve();
        jest.advanceTimersByTime(2_000);
      }

      const result = await promise;

      expect(result.synced).toBe(false);
      // At least dedupe + one poll attempt before timeout bail.
      expect(ctxSpies.vectorize.query.mock.calls.length).toBeGreaterThanOrEqual(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test('injectMemories returns proof citations on the recalled learning objects', async () => {
    const recalledRow = makeLearningRow({
      id: 'mem-proof',
      learning: 'KNOWN PITFALL: use eval for parsing JSON',
      type: 'anti-pattern',
      proofRunId: 'proof-run-9',
      proofIterationId: 'proof-run-9:2',
    });
    const { db } = makeDb([recalledRow]);
    const { ctx } = makeMemoryContext(db, [{ id: 'mem-proof', score: 0.91 }]);

    const result = await injectMemories(
      ctx as any,
      ['shared'],
      'parsing JSON in production',
      5,
      'learnings',
    );

    expect(result.learnings).toHaveLength(1);
    expect(result.learnings[0].type).toBe('anti-pattern');
    expect(result.learnings[0].identity?.proofRunId).toBe('proof-run-9');
    expect(result.learnings[0].identity?.proofIterationId).toBe('proof-run-9:2');
  });
});

describe('hosted routes and worker entrypoints', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('DejaDO exposes the confirm route and normalizes top-level proof ids', async () => {
    const env = {
      VECTORIZE: {
        query: jest.fn(),
        insert: jest.fn(),
        deleteByIds: jest.fn(),
      },
      AI: {
        run: jest.fn(),
      },
      API_KEY: 'test-key',
    };
    const state = createMockState();
    const dejaDO = new DejaDO(state as any, env as any);
    const confirm = jest.fn().mockResolvedValue(makeLearningRow({ confidence: 0.6 }));
    (dejaDO as any).confirm = confirm;

    const response = await dejaDO.fetch(
      new Request('http://localhost/learning/mem-1/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proof_run_id: 'proof-run-http',
          proof_iteration_id: 'proof-run-http:7',
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(confirm).toHaveBeenCalledWith('mem-1', {
      traceId: null,
      workspaceId: null,
      conversationId: null,
      runId: null,
      proofRunId: 'proof-run-http',
      proofIterationId: 'proof-run-http:7',
    });
  });

  test('cleanup targets the live API-key tenant instead of a fake cleanup tenant', async () => {
    const stub = {
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ deleted: 2, reasons: ['ok'] }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    };
    const env = {
      API_KEY: 'live-api-key',
      DEJA: {
        idFromName: jest.fn().mockReturnValue('do-id'),
        get: jest.fn().mockReturnValue(stub),
      },
      VECTORIZE: {},
      AI: {},
    };

    const result = await cleanup(env as any);

    expect(env.DEJA.idFromName).toHaveBeenCalledWith('live-api-key');
    expect(result.deleted).toBe(2);
  });

  test('worker MCP tool list includes confirm/reject and confirm routes through the DO stub', async () => {
    const stub = {
      fetch: jest.fn().mockResolvedValue(
        new Response(JSON.stringify({ id: 'mem-1', confidence: 0.6 }), {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    };
    const env = {
      API_KEY: 'secret-key',
      DEJA: {
        idFromName: jest.fn().mockReturnValue('do-id'),
        get: jest.fn().mockReturnValue(stub),
      },
      VECTORIZE: {},
      AI: {},
    };

    const listResponse = await worker.fetch(
      new Request('https://deja.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-key',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/list',
          params: {},
        }),
      }),
      env as any,
    );
    const listBody = await listResponse.json() as any;
    const toolNames = listBody.result.tools.map((tool: any) => tool.name);

    expect(toolNames).toContain('confirm');
    expect(toolNames).toContain('reject');

    const callResponse = await worker.fetch(
      new Request('https://deja.example.com/mcp', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Bearer secret-key',
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 2,
          method: 'tools/call',
          params: {
            name: 'confirm',
            arguments: {
              id: 'mem-1',
              proof_run_id: 'proof-run-mcp',
              proof_iteration_id: 'proof-run-mcp:5',
            },
          },
        }),
      }),
      env as any,
    );

    expect(callResponse.status).toBe(200);
    expect(stub.fetch).toHaveBeenCalledTimes(1);
    const internalRequest = stub.fetch.mock.calls[0][0] as Request;
    expect(internalRequest.method).toBe('POST');
    expect(new URL(internalRequest.url).pathname).toBe('/learning/mem-1/confirm');
    await expect(internalRequest.json()).resolves.toEqual({
      proof_run_id: 'proof-run-mcp',
      proof_iteration_id: 'proof-run-mcp:5',
    });
  });
});
