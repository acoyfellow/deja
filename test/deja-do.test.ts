/**
 * Unit tests for DejaDO (Durable Object implementation)
 * These tests focus on hermetic behavior rather than Cloudflare integration.
 */

import { DejaDO } from '../src/do/DejaDO';
import { filterScopesByPriority, normalizeRunIdentityPayload } from '../src/do/helpers';

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

  test('filters scopes by priority', () => {
    const sessionScopes = filterScopesByPriority(['shared', 'agent:123', 'session:456']);
    expect(sessionScopes).toEqual(['session:456']);

    const agentScopes = filterScopesByPriority(['shared', 'agent:123']);
    expect(agentScopes).toEqual(['agent:123']);

    const sharedScopes = filterScopesByPriority(['shared']);
    expect(sharedScopes).toEqual(['shared']);

    const emptyScopes = filterScopesByPriority([]);
    expect(emptyScopes).toEqual([]);
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
