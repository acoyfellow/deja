export interface Env {
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  API_KEY?: string;
}

export interface SharedRunIdentity {
  traceId?: string | null;
  workspaceId?: string | null;
  conversationId?: string | null;
  runId?: string | null;
  proofRunId?: string | null;
  proofIterationId?: string | null;
}

export interface Learning {
  id: string;
  trigger: string;
  learning: string;
  reason?: string;
  confidence: number;
  source?: string;
  scope: string;
  embedding?: number[];
  createdAt: string;
  lastRecalledAt?: string;
  recallCount: number;
  identity?: SharedRunIdentity;
}

export interface Secret {
  name: string;
  value: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

export interface Stats {
  totalLearnings: number;
  totalSecrets: number;
  scopes: Record<string, { learnings: number; secrets: number }>;
}

export interface QueryResult {
  learnings: Learning[];
  hits: Record<string, number>;
}

export interface InjectResult {
  prompt: string;
  learnings: Learning[];
  state?: WorkingStateResponse;
}

export interface InjectTraceResult {
  input_context: string;
  embedding_generated: number[];
  candidates: Array<{
    id: string;
    trigger: string;
    learning: string;
    similarity_score: number;
    passed_threshold: boolean;
  }>;
  threshold_applied: number;
  injected: Learning[];
  duration_ms: number;
  metadata: {
    total_candidates: number;
    above_threshold: number;
    below_threshold: number;
  };
}

export interface WorkingStatePayload {
  goal?: string;
  assumptions?: string[];
  decisions?: Array<{ id?: string; text: string; status?: string }>;
  open_questions?: string[];
  next_actions?: string[];
  confidence?: number;
}

export interface WorkingStateResponse {
  runId: string;
  revision: number;
  status: string;
  state: WorkingStatePayload;
  updatedBy?: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  identity?: SharedRunIdentity;
}

export interface ResolveStateOptions {
  persistToLearn?: boolean;
  scope?: string;
  summaryStyle?: 'compact' | 'full';
  updatedBy?: string;
  identity?: SharedRunIdentity;
}

export interface LoopRun {
  id: string;
  scope: string;
  outcome: 'pass' | 'fail' | 'exhausted';
  attempts: number;
  code?: string;
  error?: string;
  createdAt: string;
}

export interface RecordRunPayload {
  scope?: string;
  outcome: 'pass' | 'fail' | 'exhausted';
  attempts: number;
  code?: string;
  error?: string;
}

export type RunTrend = 'improving' | 'regressing' | 'stable' | 'insufficient_data';

export interface RunsQueryResult {
  runs: LoopRun[];
  stats: {
    total: number;
    pass: number;
    fail: number;
    exhausted: number;
    mean_attempts: number;
    best_attempts: number;
    trend: RunTrend;
  };
}

export interface LoopRunsOperationsContext {
  initDB(): Promise<any>;
  learn(
    scope: string,
    trigger: string,
    learning: string,
    confidence?: number,
    reason?: string,
    source?: string,
    identity?: SharedRunIdentity,
  ): Promise<Learning>;
}

export interface MemoryOperationsContext {
  env: Env;
  initDB(): Promise<any>;
  createEmbedding(text: string): Promise<number[]>;
  filterScopesByPriority(scopes: string[]): string[];
  convertDbLearning(dbLearning: any): Learning;
}

export interface SecretsOperationsContext {
  initDB(): Promise<any>;
  filterScopesByPriority(scopes: string[]): string[];
}

export interface StatsOperationsContext {
  initDB(): Promise<any>;
}

export interface WorkingStateOperationsContext {
  initDB(): Promise<any>;
  normalizeWorkingStatePayload(payload: any): WorkingStatePayload;
  normalizeRunIdentityPayload(payload: any): SharedRunIdentity | undefined;
  learn(
    scope: string,
    trigger: string,
    learning: string,
    confidence?: number,
    reason?: string,
    source?: string,
    identity?: SharedRunIdentity,
  ): Promise<Learning>;
}
