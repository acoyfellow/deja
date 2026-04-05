/**
 * DejaDO - Durable Object implementation for deja
 *
 * Each user gets their own isolated DejaDO instance with SQLite storage.
 */
import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { Hono } from 'hono';
import { cleanupLearnings, confirmMemory, deleteLearningById, deleteLearningsByFilter, getLearningNeighbors, injectMemories, injectMemoriesWithTrace, learnMemory, listLearnings, queryLearnings, rejectMemory } from './memory';
import { convertDbLearning, filterScopesByPriority, initializeStorage, normalizeRunIdentityPayload, normalizeWorkingStatePayload } from './helpers';
import { recordLoopRun, queryLoopRuns } from './loopRuns';
import { createDejaApp } from './routes';
import { deleteSecretValue, getSecretValue, listSecrets, setSecretValue } from './secrets';
import { getStatsSnapshot } from './stats';
import type { Env, InjectResult, InjectTraceResult, Learning, LoopRun, QueryResult, RecordRunPayload, ResolveStateOptions, RunsQueryResult, Secret, SharedRunIdentity, Stats, WorkingStatePayload, WorkingStateResponse } from './types';
import { addWorkingStateEvent, getStateByRunId, patchWorkingState, resolveWorkingState, upsertWorkingState } from './workingState';

export class DejaDO extends DurableObject<Env> {
  private db: ReturnType<typeof drizzle> | null = null;
  private app: Hono<{ Bindings: Env }> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    initializeStorage(state);
  }

  /**
   * Initialize the database connection
   */
  private async initDB() {
    if (this.db) return this.db;

    try {
      this.db = drizzle(this.ctx.storage);
      return this.db;
    } catch (error) {
      console.error('Database initialization error:', error);
      throw error;
    }
  }

  /**
   * Create embedding for text using Workers AI
   */
  private async createEmbedding(text: string): Promise<number[]> {
    try {
      const response: any = await this.env.AI.run('@cf/baai/bge-small-en-v1.5', { text });
      if (response.data && response.data[0]) {
        return response.data[0];
      }
      return response;
    } catch (error) {
      console.error('Embedding creation error:', error);
      throw error;
    }
  }

  private getMemoryContext() {
    return {
      env: this.env,
      initDB: () => this.initDB(),
      createEmbedding: (text: string) => this.createEmbedding(text),
      filterScopesByPriority,
      convertDbLearning,
      sql: this.ctx.storage.sql,
    };
  }

  private getSecretsContext() {
    return {
      initDB: () => this.initDB(),
      filterScopesByPriority,
    };
  }

  private getStatsContext() {
    return {
      initDB: () => this.initDB(),
    };
  }

  private getLoopRunsContext() {
    return {
      initDB: () => this.initDB(),
      learn: this.learn.bind(this),
    };
  }

  private getWorkingStateContext() {
    return {
      initDB: () => this.initDB(),
      normalizeWorkingStatePayload,
      normalizeRunIdentityPayload,
      learn: this.learn.bind(this),
    };
  }

  async cleanup(): Promise<{ deleted: number; reasons: string[] }> {
    return cleanupLearnings(this.getMemoryContext());
  }

  async inject(
    scopes: string[],
    context: string,
    limit: number = 5,
    format: 'prompt' | 'learnings' = 'prompt',
    search: 'vector' | 'text' | 'hybrid' = 'hybrid',
    identity?: SharedRunIdentity,
  ): Promise<InjectResult> {
    return injectMemories(this.getMemoryContext(), scopes, context, limit, format, search, identity);
  }

  async injectTrace(
    scopes: string[],
    context: string,
    limit: number = 5,
    threshold: number = 0,
    identity?: SharedRunIdentity,
  ): Promise<InjectTraceResult> {
    return injectMemoriesWithTrace(this.getMemoryContext(), scopes, context, limit, threshold, identity);
  }

  async learn(
    scope: string,
    trigger: string,
    learning: string,
    confidence: number = 0.5,
    reason?: string,
    source?: string,
    identity?: SharedRunIdentity,
    noveltyThreshold?: number,
  ): Promise<Learning> {
    return learnMemory(
      this.getMemoryContext(),
      scope,
      trigger,
      learning,
      confidence,
      reason,
      source,
      identity,
      noveltyThreshold,
    );
  }

  async confirm(id: string, identity?: SharedRunIdentity): Promise<Learning | null> {
    return confirmMemory(this.getMemoryContext(), id, identity);
  }

  async reject(id: string, identity?: SharedRunIdentity): Promise<Learning | null> {
    return rejectMemory(this.getMemoryContext(), id, identity);
  }

  async getLearningNeighbors(id: string, threshold: number = 0.85, limit: number = 10): Promise<Array<Learning & { similarity_score: number }>> {
    return getLearningNeighbors(this.getMemoryContext(), id, threshold, limit);
  }

  async query(scopes: string[], text: string, limit: number = 10, identity?: SharedRunIdentity): Promise<QueryResult> {
    return queryLearnings(this.getMemoryContext(), scopes, text, limit, identity);
  }

  async getLearnings(filter?: { scope?: string; limit?: number }): Promise<Learning[]> {
    return listLearnings(this.getMemoryContext(), filter);
  }

  async deleteLearning(id: string): Promise<{ success: boolean; error?: string }> {
    return deleteLearningById(this.getMemoryContext(), id);
  }

  async deleteLearnings(filters: {
    confidence_lt?: number;
    not_recalled_in_days?: number;
    scope?: string;
  }): Promise<{ deleted: number; ids: string[] }> {
    return deleteLearningsByFilter(this.getMemoryContext(), filters);
  }

  async getSecret(scopes: string[], name: string): Promise<string | null> {
    return getSecretValue(this.getSecretsContext(), scopes, name);
  }

  async setSecret(scope: string, name: string, value: string): Promise<{ success: boolean; error?: string }> {
    return setSecretValue(this.getSecretsContext(), scope, name, value);
  }

  async deleteSecret(scope: string, name: string): Promise<{ success: boolean; error?: string }> {
    return deleteSecretValue(this.getSecretsContext(), scope, name);
  }

  async getStats(): Promise<Stats> {
    return getStatsSnapshot(this.getStatsContext());
  }

  async getState(runId: string): Promise<WorkingStateResponse | null> {
    return getStateByRunId(this.getWorkingStateContext(), runId);
  }

  async upsertState(
    runId: string,
    payload: WorkingStatePayload,
    updatedBy?: string,
    changeSummary: string = 'state upsert',
    identity?: SharedRunIdentity,
  ): Promise<WorkingStateResponse> {
    return upsertWorkingState(this.getWorkingStateContext(), runId, payload, updatedBy, changeSummary, identity);
  }

  async patchState(runId: string, patch: any, updatedBy?: string, identity?: SharedRunIdentity): Promise<WorkingStateResponse> {
    return patchWorkingState(this.getWorkingStateContext(), runId, patch, updatedBy, identity);
  }

  async addStateEvent(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
    createdBy?: string,
    identity?: SharedRunIdentity,
  ): Promise<{ success: true; id: string }> {
    return addWorkingStateEvent(this.getWorkingStateContext(), runId, eventType, payload, createdBy, identity);
  }

  async resolveState(runId: string, opts: ResolveStateOptions = {}): Promise<WorkingStateResponse | null> {
    return resolveWorkingState(this.getWorkingStateContext(), runId, opts);
  }

  async recordRun(payload: RecordRunPayload): Promise<LoopRun> {
    return recordLoopRun(this.getLoopRunsContext(), payload);
  }

  async getRuns(scope?: string, limit?: number): Promise<RunsQueryResult> {
    return queryLoopRuns(this.getLoopRunsContext(), scope, limit);
  }

  async listSecrets(scope?: string): Promise<Secret[]> {
    return listSecrets(this.getSecretsContext(), scope);
  }

  private initApp(): Hono<{ Bindings: Env }> {
    if (this.app) return this.app;
    this.app = createDejaApp({
      cleanup: this.cleanup.bind(this),
      learn: this.learn.bind(this),
      confirm: this.confirm.bind(this),
      reject: this.reject.bind(this),
      query: this.query.bind(this),
      inject: this.inject.bind(this),
      injectTrace: this.injectTrace.bind(this),
      getStats: this.getStats.bind(this),
      getState: this.getState.bind(this),
      upsertState: this.upsertState.bind(this),
      patchState: this.patchState.bind(this),
      addStateEvent: this.addStateEvent.bind(this),
      resolveState: this.resolveState.bind(this),
      getLearnings: this.getLearnings.bind(this),
      deleteLearnings: this.deleteLearnings.bind(this),
      deleteLearning: this.deleteLearning.bind(this),
      getLearningNeighbors: this.getLearningNeighbors.bind(this),
      setSecret: this.setSecret.bind(this),
      getSecret: this.getSecret.bind(this),
      deleteSecret: this.deleteSecret.bind(this),
      listSecrets: this.listSecrets.bind(this),
      recordRun: this.recordRun.bind(this),
      getRuns: this.getRuns.bind(this),
    });
    return this.app;
  }

  async fetch(request: Request) {
    try {
      const app = this.initApp();
      return await app.fetch(request, this.env);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
