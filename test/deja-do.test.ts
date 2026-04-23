/**
 * Unit tests for DejaDO (Durable Object implementation)
 * These tests focus on hermetic behavior rather than Cloudflare integration.
 */

import { DejaDO } from '../src/do/DejaDO';
import { filterScopesByPriority, normalizeRunIdentityPayload } from '../src/do/helpers';
import { recordLoopRun, queryLoopRuns } from '../src/do/loopRuns';

const mockEnv = {
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

function createMockState() {
  const sqlExec = jest.fn();
  return {
    blockConcurrencyWhile: jest.fn(async (fn: () => Promise<void>) => fn()),
    storage: {
      sql: {
        exec: sqlExec,
      },
    },
  };
}

function createSecretsDb(rowsAffected = 0) {
  const insertValues = jest.fn().mockResolvedValue(undefined);
  const updateWhere = jest.fn().mockResolvedValue({ rowsAffected });
  const deleteWhere = jest.fn().mockResolvedValue({ rowsAffected: 1 });
  const selectLimit = jest.fn().mockResolvedValue([
    {
      name: 'test-secret',
      value: 'secret-value',
      scope: 'shared',
      createdAt: '2023-01-01T00:00:00.000Z',
      updatedAt: '2023-01-01T00:00:00.000Z',
    },
  ]);

  return {
    select: jest.fn().mockReturnValue({
      from: jest.fn().mockReturnValue({
        where: jest.fn().mockReturnValue({
          limit: selectLimit,
        }),
      }),
    }),
    insert: jest.fn().mockReturnValue({
      values: insertValues,
    }),
    update: jest.fn().mockReturnValue({
      set: jest.fn().mockReturnValue({
        where: updateWhere,
      }),
    }),
    delete: jest.fn().mockReturnValue({
      where: deleteWhere,
    }),
    __spies: {
      insertValues,
      updateWhere,
      deleteWhere,
      selectLimit,
    },
  };
}

describe('loopRuns', () => {
  function makeCtx(rows: any[] = []) {
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const learnFn = jest.fn().mockResolvedValue({});
    const mockDb = {
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
          }),
          orderBy: jest.fn().mockReturnValue({ limit: jest.fn().mockResolvedValue(rows) }),
        }),
      }),
    };
    return { ctx: { initDB: jest.fn().mockResolvedValue(mockDb), learn: learnFn }, insertValues, learnFn, mockDb };
  }

  test('recordLoopRun returns a run with correct fields and fires learn', async () => {
    const { ctx, insertValues, learnFn } = makeCtx();
    const run = await recordLoopRun(ctx, { outcome: 'pass', attempts: 1, scope: 'test', code: 'x = 1' });
    expect(run.outcome).toBe('pass');
    expect(run.attempts).toBe(1);
    expect(run.scope).toBe('test');
    expect(run.id).toMatch(/^run-/);
    expect(insertValues).toHaveBeenCalledTimes(1);
    // learn fires async; give it a tick
    await Promise.resolve();
    expect(learnFn).toHaveBeenCalledWith('test', 'loop run: test', expect.stringContaining('passed'), expect.any(Number), undefined, expect.stringContaining('loop_run:'));
  });

  test('confidence is 1.0 on first-attempt pass and 0.6 on fail', async () => {
    const { ctx, learnFn } = makeCtx();
    await recordLoopRun(ctx, { outcome: 'pass', attempts: 1 });
    await Promise.resolve();
    expect(learnFn).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.any(String), 1.0, undefined, expect.any(String));

    await recordLoopRun(ctx, { outcome: 'fail', attempts: 3 });
    await Promise.resolve();
    expect(learnFn).toHaveBeenLastCalledWith(expect.any(String), expect.any(String), expect.any(String), 0.6, undefined, expect.any(String));
  });

  test('queryLoopRuns returns insufficient_data when fewer than 4 runs', async () => {
    const rows = [{ id: 'r1', scope: 'shared', outcome: 'pass', attempts: 2, code: null, error: null, createdAt: '2024-01-01T00:00:00.000Z' }];
    const { ctx } = makeCtx(rows);
    const result = await queryLoopRuns(ctx, 'shared');
    expect(result.stats.total).toBe(1);
    expect(result.stats.trend).toBe('insufficient_data');
    expect(result.stats.best_attempts).toBe(2);
    expect(result.stats.pass).toBe(1);
  });

  test('queryLoopRuns detects improving trend', async () => {
    // newer (first half, index 0-1) has fewer attempts than older (second half, index 2-3)
    const rows = [
      { id: 'r4', scope: 'shared', outcome: 'pass', attempts: 1, code: null, error: null, createdAt: '2024-01-04T00:00:00.000Z' },
      { id: 'r3', scope: 'shared', outcome: 'pass', attempts: 1, code: null, error: null, createdAt: '2024-01-03T00:00:00.000Z' },
      { id: 'r2', scope: 'shared', outcome: 'pass', attempts: 5, code: null, error: null, createdAt: '2024-01-02T00:00:00.000Z' },
      { id: 'r1', scope: 'shared', outcome: 'pass', attempts: 5, code: null, error: null, createdAt: '2024-01-01T00:00:00.000Z' },
    ];
    const { ctx } = makeCtx(rows);
    const result = await queryLoopRuns(ctx, 'shared');
    expect(result.stats.trend).toBe('improving');
  });
});

describe('DejaDO', () => {
  let dejaDO: DejaDO;
  let mockState: ReturnType<typeof createMockState>;

  beforeEach(() => {
    jest.clearAllMocks();

    mockState = createMockState();
    dejaDO = new DejaDO(mockState as any, mockEnv as any);
  });

  test('initializes storage safely in the constructor', () => {
    expect(DejaDO).toBeDefined();
    expect(dejaDO).toBeInstanceOf(DejaDO);
    expect(mockState.blockConcurrencyWhile).toHaveBeenCalledTimes(1);
    expect(mockState.storage.sql.exec).toHaveBeenCalled();
  });

  test('filterScopesByPriority preserves explicitly-listed scopes (widens instead of dropping)', () => {
    // Behavior change (see helpers.ts docstring): previously this function
    // dropped lower-priority scopes when any higher-priority scope was
    // present, creating a recall hole for main-state shared rows when
    // ['session:x', 'shared'] was requested. The new contract is
    // "widen to include everything the caller listed" with a single
    // narrow collapse: if BOTH session AND agent are present, drop shared.

    // Three-tier mix: the single collapse case — shared dropped because
    // session+agent together already narrow aggressively.
    expect(
      filterScopesByPriority(['shared', 'agent:123', 'session:456']).sort(),
    ).toEqual(['agent:123', 'session:456']);

    // Agent + shared: both preserved (was previously just agent).
    expect(filterScopesByPriority(['shared', 'agent:123']).sort()).toEqual(
      ['agent:123', 'shared'],
    );

    // Session + shared: both preserved (the bug case this change fixes).
    expect(filterScopesByPriority(['session:abc', 'shared']).sort()).toEqual(
      ['session:abc', 'shared'],
    );

    // Session + agent (no shared): both preserved (previously only session).
    expect(filterScopesByPriority(['session:abc', 'agent:x']).sort()).toEqual(
      ['agent:x', 'session:abc'],
    );

    // Single scopes: unchanged.
    expect(filterScopesByPriority(['shared'])).toEqual(['shared']);
    expect(filterScopesByPriority([])).toEqual([]);
  });

  test('normalizes shared run identity payloads from snake and camel keys', () => {
    expect(
      normalizeRunIdentityPayload({
        trace_id: 'trace-1',
        workspaceId: 'workspace-1',
        conversation_id: 'conversation-1',
        runId: 'run-1',
        proof_run_id: 'proof-run-1',
        proofIterationId: 'proof-run-1:1',
      }),
    ).toEqual({
      traceId: 'trace-1',
      workspaceId: 'workspace-1',
      conversationId: 'conversation-1',
      runId: 'run-1',
      proofRunId: 'proof-run-1',
      proofIterationId: 'proof-run-1:1',
    });
  });

  test('serves a JSON health response on root', async () => {
    const response = await dejaDO.fetch(new Request('http://localhost/'));
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: 'ok', service: 'deja' });
  });

  test('exposes recordRun and getRuns via HTTP routes', async () => {
    const insertValues = jest.fn().mockResolvedValue(undefined);
    const selectRows = jest.fn().mockResolvedValue([]);
    const mockDb = {
      insert: jest.fn().mockReturnValue({ values: insertValues }),
      select: jest.fn().mockReturnValue({
        from: jest.fn().mockReturnValue({
          where: jest.fn().mockReturnValue({
            orderBy: jest.fn().mockReturnValue({
              limit: selectRows,
            }),
          }),
          orderBy: jest.fn().mockReturnValue({
            limit: selectRows,
          }),
        }),
      }),
    };
    (dejaDO as any).initDB = jest.fn().mockResolvedValue(mockDb);
    (dejaDO as any).learn = jest.fn().mockResolvedValue({});

    const postResp = await dejaDO.fetch(
      new Request('http://localhost/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ outcome: 'pass', attempts: 2, scope: 'shared', code: 'console.log("hi")' }),
      }),
    );
    expect(postResp.status).toBe(201);
    const postBody = await postResp.json() as any;
    expect(postBody.outcome).toBe('pass');
    expect(postBody.attempts).toBe(2);
    expect(postBody.id).toBeDefined();

    const getResp = await dejaDO.fetch(new Request('http://localhost/runs?scope=shared'));
    expect(getResp.status).toBe(200);
    const getBody = await getResp.json() as any;
    expect(Array.isArray(getBody.runs)).toBe(true);
    expect(getBody.stats).toBeDefined();
    expect(getBody.stats.total).toBe(0); // mocked to return []
  });

  test('handles secret CRUD operations through the current methods', async () => {
    const db = createSecretsDb(0);
    (dejaDO as any).initDB = jest.fn().mockResolvedValue(db);

    const setResult = await dejaDO.setSecret('shared', 'test-secret', 'secret-value');
    expect(setResult.success).toBe(true);
    expect(db.__spies.insertValues).toHaveBeenCalled();

    const getResult = await dejaDO.getSecret(['shared'], 'test-secret');
    expect(getResult).toBe('secret-value');

    const deleteResult = await dejaDO.deleteSecret('shared', 'test-secret');
    expect(deleteResult.success).toBe(true);
    expect(db.__spies.deleteWhere).toHaveBeenCalled();
  });
});
