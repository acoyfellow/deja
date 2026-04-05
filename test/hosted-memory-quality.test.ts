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
  const sql = {
    exec: jest.fn().mockReturnValue([]),
  };

  return {
    ctx: {
      env: { VECTORIZE: vectorize },
      initDB: jest.fn().mockResolvedValue(db),
      sql,
      createEmbedding,
      filterScopesByPriority: (scopes: string[]) => scopes,
      convertDbLearning,
    },
    spies: {
      createEmbedding,
      vectorize,
      sql,
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

  test('learnMemory merges a near-identical Vectorize neighbor and records proof ids', async () => {
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
    expect(ctxSpies.vectorize.insert).toHaveBeenCalledTimes(1);
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        confidence: 0.8,
        createdAt: expect.any(String),
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

  test('learnMemory keeps the higher-confidence wording and appends new reason/source', async () => {
    const existingRow = makeLearningRow({
      reason: 'Original incident',
      source: 'runbook',
      confidence: 0.6,
    });
    const { db, spies } = makeDb([existingRow]);
    const { ctx } = makeMemoryContext(db, [{ id: 'mem-1', score: 0.99 }]);

    const result = await learnMemory(
      ctx as any,
      'shared',
      'deploying auth service',
      'run smoke tests before switching traffic',
      0.9,
      'Validated during hotfix',
      'pager',
    );

    expect(result.id).toBe('mem-1');
    expect(result.trigger).toBe('deploying auth service');
    expect(result.learning).toBe('run smoke tests before switching traffic');
    expect(result.reason).toBe('Original incident\nValidated during hotfix');
    expect(result.source).toBe('runbook\npager');
    expect(result.confidence).toBe(0.9);
    expect(db.insert).not.toHaveBeenCalled();
    expect(spies.updateSet).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: 'deploying auth service',
        learning: 'run smoke tests before switching traffic',
        reason: 'Original incident\nValidated during hotfix',
        source: 'runbook\npager',
        confidence: 0.9,
      }),
    );
  });

  test('learnMemory inserts a new row when noveltyThreshold is disabled', async () => {
    const existingRow = makeLearningRow();
    const { db } = makeDb([existingRow]);
    const { ctx, spies: ctxSpies } = makeMemoryContext(db, [{ id: 'mem-1', score: 0.99 }]);

    const result = await learnMemory(
      ctx as any,
      'shared',
      'deploying auth service',
      'run smoke tests before switching traffic',
      0.8,
      undefined,
      undefined,
      undefined,
      0,
    );

    expect(result.id).not.toBe('mem-1');
    expect(db.insert).toHaveBeenCalled();
    expect(ctxSpies.vectorize.insert).toHaveBeenCalledTimes(1);
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

  test('injectMemories hybrid mode unions vector and text results and preserves vector order', async () => {
    const vectorFirst = makeLearningRow({ id: 'vec-1', trigger: 'semantic auth deploy' });
    const vectorSecond = makeLearningRow({ id: 'vec-2', trigger: 'semantic billing deploy' });
    const textOnly = makeLearningRow({ id: 'txt-1', trigger: 'keyword rollback checklist' });
    const allRows = [vectorFirst, vectorSecond, textOnly];
    const { db, spies } = makeDb(allRows);
    const { ctx, spies: ctxSpies } = makeMemoryContext(db, [
      { id: 'vec-1', score: 0.95 },
      { id: 'vec-2', score: 0.9 },
    ]);

    const sqlRows = [{ id: 'vec-2' }, { id: 'txt-1' }];
    ctxSpies.sql.exec.mockReturnValue(sqlRows);

    const result = await injectMemories(
      ctx as any,
      ['shared'],
      'deploy auth rollback',
      5,
      'learnings',
      'hybrid',
      undefined,
    );

    expect(ctxSpies.vectorize.query).toHaveBeenCalledTimes(1);
    expect(ctxSpies.sql.exec).toHaveBeenCalledTimes(1);
    expect(result.learnings.map((learning) => learning.id)).toEqual(['vec-1', 'vec-2', 'txt-1']);
    expect(spies.updateWhere).toHaveBeenCalledTimes(3);
  });

  test('injectMemories search modes return expected subsets', async () => {
    const vectorOnly = makeLearningRow({ id: 'vec-1', trigger: 'semantic auth deploy' });
    const textOnly = makeLearningRow({ id: 'txt-1', trigger: 'keyword rollback checklist' });
    const { db } = makeDb([vectorOnly, textOnly], [vectorOnly], [textOnly]);
    const { ctx, spies: ctxSpies } = makeMemoryContext(db, [{ id: 'vec-1', score: 0.95 }]);

    ctxSpies.sql.exec.mockReturnValue([{ id: 'txt-1' }]);

    const hybrid = await injectMemories(ctx as any, ['shared'], 'deploy auth rollback', 5, 'learnings', 'hybrid');
    const vector = await injectMemories(ctx as any, ['shared'], 'deploy auth rollback', 5, 'learnings', 'vector');
    const text = await injectMemories(ctx as any, ['shared'], 'deploy auth rollback', 5, 'learnings', 'text');

    expect(hybrid.learnings.map((learning) => learning.id)).toEqual(['vec-1', 'txt-1']);
    expect(vector.learnings.map((learning) => learning.id)).toEqual(['vec-1']);
    expect(text.learnings.map((learning) => learning.id)).toEqual(['txt-1']);
    expect(ctxSpies.vectorize.query).toHaveBeenCalledTimes(2);
  });

  test('injectMemories maxTokens keeps total estimated tokens within budget', async () => {
    const rows = [
      makeLearningRow({
        id: 'mem-1',
        trigger: 'deploy auth service',
        learning: 'x'.repeat(160),
        reason: 'r'.repeat(80),
        source: 's'.repeat(40),
      }),
      makeLearningRow({
        id: 'mem-2',
        trigger: 'rollback billing worker',
        learning: 'y'.repeat(120),
        reason: 'r2',
        source: 's2',
      }),
    ];
    const { db } = makeDb(rows);
    const { ctx } = makeMemoryContext(db, [
      { id: 'mem-1', score: 0.98 },
      { id: 'mem-2', score: 0.95 },
    ]);

    const result = await injectMemories(
      ctx as any,
      ['shared'],
      'deploy rollback',
      5,
      'learnings',
      'vector',
      undefined,
      100,
    );

    const estimatedTokens = result.learnings.reduce((total, learning) => {
      const text =
        learning.tier === 'full'
          ? `${learning.trigger}${learning.learning}${learning.confidence}${learning.reason ?? ''}${learning.source ?? ''}`
          : learning.trigger;
      return total + Math.ceil(text.length / 4);
    }, 0);

    expect(estimatedTokens).toBeLessThanOrEqual(100);
    expect(result.learnings[0].tier).toBe('full');
    expect(result.learnings[1].tier).toBe('trigger');
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
