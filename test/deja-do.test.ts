/**
 * Unit tests for DejaDO (Durable Object implementation)
 * These tests focus on the logic rather than the Cloudflare integration
 */

import { DejaDO } from '../src/do/DejaDO';

// Mock Cloudflare bindings
const mockEnv = {
  VECTORIZE: {
    query: jest.fn(),
    insert: jest.fn(),
    deleteByIds: jest.fn()
  },
  AI: {
    run: jest.fn()
  },
  API_KEY: 'test-key'
};

// Mock DurableObjectState
const mockState = {
  storage: {
    sql: {}
  }
};

describe('DejaDO', () => {
  let dejaDO: DejaDO;
  
  beforeEach(() => {
    // Reset mocks
    jest.clearAllMocks();
    
    // Create new instance
    // @ts-ignore - ignoring type issues for mocks
    dejaDO = new DejaDO(mockState, mockEnv);
    
    // Mock database initialization
    (dejaDO as any).initDB = jest.fn().mockResolvedValue({
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      desc: jest.fn(),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn(),
      and: jest.fn(),
      inArray: jest.fn(),
      groupBy: jest.fn().mockReturnThis()
    });
  });

  test('should create DejaDO class', () => {
    expect(DejaDO).toBeDefined();
    expect(dejaDO).toBeInstanceOf(DejaDO);
  });

  test('should have required RPC methods', () => {
    const methods = [
      'inject',
      'learn',
      'query',
      'getLearnings',
      'deleteLearning',
      'getSecret',
      'setSecret',
      'deleteSecret',
      'getStats'
    ];
    
    methods.forEach(method => {
      expect(typeof (dejaDO as any)[method]).toBe('function');
    });
  });

  test('should filter scopes by priority', async () => {
    // Test session scope priority
    const sessionScopes = (dejaDO as any).filterScopesByPriority(['shared', 'agent:123', 'session:456']);
    expect(sessionScopes).toEqual(['session:456']);
    
    // Test agent scope priority
    const agentScopes = (dejaDO as any).filterScopesByPriority(['shared', 'agent:123']);
    expect(agentScopes).toEqual(['agent:123']);
    
    // Test shared scope
    const sharedScopes = (dejaDO as any).filterScopesByPriority(['shared']);
    expect(sharedScopes).toEqual(['shared']);
    
    // Test empty scopes
    const emptyScopes = (dejaDO as any).filterScopesByPriority([]);
    expect(emptyScopes).toEqual([]);
  });

  test('should create embedding', async () => {
    // Mock AI response
    mockEnv.AI.run.mockResolvedValue([0.1, 0.2, 0.3]);
    
    const embedding = await (dejaDO as any).createEmbedding('test text');
    expect(embedding).toEqual([0.1, 0.2, 0.3]);
    expect(mockEnv.AI.run).toHaveBeenCalledWith('@cf/baai/bge-large-en-v1.5', { text: 'test text' });
  });

  test('should learn new memory', async () => {
    // Mock dependencies
    mockEnv.AI.run.mockResolvedValue([0.1, 0.2, 0.3]);
    mockEnv.VECTORIZE.insert.mockResolvedValue(undefined);
    
    const result = await dejaDO.learn('shared', 'testing', 'do this', 0.8, 'test reason', 'test source');
    
    expect(result).toHaveProperty('id');
    expect(result.trigger).toBe('testing');
    expect(result.learning).toBe('do this');
    expect(result.scope).toBe('shared');
    expect(result.confidence).toBe(0.8);
    expect(result.reason).toBe('test reason');
    expect(result.source).toBe('test source');
    expect(result.embedding).toEqual([0.1, 0.2, 0.3]);
    expect(mockEnv.VECTORIZE.insert).toHaveBeenCalled();
  });

  test('should query for learnings', async () => {
    // Mock dependencies
    mockEnv.AI.run.mockResolvedValue([0.1, 0.2, 0.3]);
    mockEnv.VECTORIZE.query.mockResolvedValue({
      matches: [
        { id: '1', score: 0.9 },
        { id: '2', score: 0.8 }
      ]
    });
    
    // Mock database response
    const mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([
        { id: '1', trigger: 'test', learning: 'do this', scope: 'shared', confidence: 0.9, createdAt: '2023-01-01' },
        { id: '2', trigger: 'test2', learning: 'do that', scope: 'shared', confidence: 0.8, createdAt: '2023-01-02' }
      ])
    };
    (dejaDO as any).initDB.mockResolvedValue(mockDb);
    
    const result = await dejaDO.query(['shared'], 'test query', 5);
    
    expect(result.learnings).toHaveLength(2);
    expect(result.hits).toEqual({ shared: 2 });
    expect(mockEnv.VECTORIZE.query).toHaveBeenCalled();
  });

  test('should inject memories', async () => {
    // Mock dependencies
    mockEnv.AI.run.mockResolvedValue([0.1, 0.2, 0.3]);
    mockEnv.VECTORIZE.query.mockResolvedValue({
      matches: [
        { id: '1', score: 0.9 }
      ]
    });
    
    // Mock database response
    const mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([
        { id: '1', trigger: 'test', learning: 'do this', scope: 'shared', confidence: 0.9, createdAt: '2023-01-01' }
      ]),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      eq: jest.fn()
    };
    (dejaDO as any).initDB.mockResolvedValue(mockDb);
    
    const result = await dejaDO.inject(['shared'], 'test context', 5, 'prompt');
    
    expect(result.prompt).toBe('When test, do this');
    expect(result.learnings).toHaveLength(1);
  });

  test('should handle secrets', async () => {
    // Mock database response for getSecret
    const mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockResolvedValue([
        { name: 'test-secret', value: 'secret-value', scope: 'shared', createdAt: '2023-01-01', updatedAt: '2023-01-01' }
      ]),
      insert: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      update: jest.fn().mockReturnThis(),
      set: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      eq: jest.fn(),
      and: jest.fn()
    };
    (dejaDO as any).initDB.mockResolvedValue(mockDb);
    
    // Test setSecret
    const setResult = await dejaDO.setSecret('shared', 'test-secret', 'secret-value');
    expect(setResult.success).toBe(true);
    
    // Test getSecret
    const getResult = await dejaDO.getSecret(['shared'], 'test-secret');
    expect(getResult).toBe('secret-value');
    
    // Test deleteSecret
    const deleteResult = await dejaDO.deleteSecret('shared', 'test-secret');
    expect(deleteResult.success).toBe(true);
  });

  test('should get stats', async () => {
    // Mock database responses
    const mockDb = {
      select: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      limit: jest.fn().mockReturnThis(),
      groupBy: jest.fn().mockReturnThis(),
      eq: jest.fn(),
      and: jest.fn(),
      sql: jest.fn()
    };
    
    // Mock count queries to return proper results
    mockDb.select.mockImplementation(() => ({
      from: () => [{
        count: 5
      }]
    }));
    
    (dejaDO as any).initDB.mockResolvedValue(mockDb);
    
    const result = await dejaDO.getStats();
    
    expect(result.totalLearnings).toBe(5);
    expect(result.totalSecrets).toBe(5);
  });
});
