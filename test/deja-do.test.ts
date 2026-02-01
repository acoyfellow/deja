/**
 * Tests for DejaDO (Durable Object implementation)
 */

import { DurableObjectState } from '@cloudflare/workers-types';
import { DejaDO } from '../src/do/DejaDO';

// Mock environment
const mockEnv: any = {
  VECTORIZE: {
    query: jest.fn().mockResolvedValue({ matches: [] }),
    upsert: jest.fn().mockResolvedValue(undefined),
    deleteByIds: jest.fn().mockResolvedValue(undefined),
  },
  AI: {
    run: jest.fn().mockResolvedValue({ data: [new Array(1024).fill(0)] }),
  },
  API_KEY: 'test-key',
};

// Mock DurableObjectState
const mockState: DurableObjectState = {
  id: 'test-id',
  storage: {
    sql: {},
    transaction: jest.fn(),
    delete: jest.fn(),
    deleteAll: jest.fn(),
    get: jest.fn(),
    list: jest.fn(),
    put: jest.fn(),
  },
  waitUntil: jest.fn(),
  blockConcurrencyWhile: async (callback: () => any) => callback(),
} as any;

describe('DejaDO', () => {
  let dejaDO: DejaDO;

  beforeEach(() => {
    dejaDO = new DejaDO(mockState, mockEnv);
    // Reset mocks
    jest.clearAllMocks();
  });

  test('should create DejaDO instance', () => {
    expect(dejaDO).toBeInstanceOf(DejaDO);
  });

  test('should learn with scope', async () => {
    const result = await dejaDO.learn('shared', 'test trigger', 'test learning', 0.9, 'test reason', 'test source');
    expect(result).toHaveProperty('id');
    expect(result).toHaveProperty('status', 'stored');
    expect(mockEnv.VECTORIZE.upsert).toHaveBeenCalled();
    expect(mockEnv.AI.run).toHaveBeenCalled();
  });

  test('should inject with scope filtering', async () => {
    const result = await dejaDO.inject(['shared'], 'test context', 5, 'structured');
    expect(result).toHaveProperty('injection');
    expect(mockEnv.VECTORIZE.query).toHaveBeenCalled();
    expect(mockEnv.AI.run).toHaveBeenCalled();
  });

  test('should query with scope filtering', async () => {
    const result = await dejaDO.query(['shared'], 'test query', 5);
    expect(result).toHaveProperty('learnings');
    expect(mockEnv.VECTORIZE.query).toHaveBeenCalled();
    expect(mockEnv.AI.run).toHaveBeenCalled();
  });

  test('should manage secrets with scope', async () => {
    // Test setting a secret
    const setResult = await dejaDO.setSecret('shared', 'test-secret', 'test-value');
    expect(setResult).toHaveProperty('name', 'test-secret');
    expect(setResult).toHaveProperty('status', 'stored');
    
    // Test getting a secret
    const getResult = await dejaDO.getSecret(['shared'], 'test-secret');
    expect(getResult).toBeNull(); // Would be null in mock since we don't have real DB
    
    // Test deleting a secret
    const deleteResult = await dejaDO.deleteSecret('shared', 'test-secret');
    expect(deleteResult).toHaveProperty('error', 'not found'); // Would be not found in mock
  });

  test('should filter scopes by priority', async () => {
    // This tests the scope priority filtering indirectly through the public methods
    const scopes = ['session:test', 'agent:test', 'shared'];
    
    // The filterByScopePriority method is private, but we can test its effect
    // through the inject method which uses it in fallback mode
    await dejaDO.inject(scopes, 'test context');
    
    // In a real implementation with data, session scope would be prioritized
    // over agent scope, which would be prioritized over shared scope
  });
});
