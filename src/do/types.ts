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

// Branch lifecycle for a learning:
//   'main'    — normal learning, visible wherever scope allows (default).
//   'session' — scratchpad write tied to a session:<id> scope. Invisible
//               to other sessions; auto-GC'd after the branch TTL expires
//               unless blessed first.
//   'blessed' — was 'session', explicitly promoted via bless(). Opts out
//               of the session-TTL sweep. Scope stays session:<id> so the
//               write's provenance (which session authored it) survives.
export type LearningBranchState = 'main' | 'session' | 'blessed';

export interface Learning {
  id: string;
  trigger: string;
  learning: string;
  reason?: string;
  confidence: number;
  source?: string;
  scope: string;
  supersedes?: string;
  type: 'memory' | 'anti-pattern';
  branchState: LearningBranchState;
  embedding?: number[];
  createdAt: string;
  lastRecalledAt?: string;
  recallCount: number;
  identity?: SharedRunIdentity;
}

// Per-session branch metadata.
export interface SessionBranch {
  sessionId: string; // matches the session:<id> scope suffix
  createdAt: string;
  expiresAt: string;
  blessedAt: string | null;
  discardedAt: string | null;
}

export type SessionBranchStatus = 'open' | 'blessed' | 'discarded' | 'expired';

// End-of-session structured summary. The outgoing agent writes one of these
// when resolving its work; the incoming agent reads it as an onboarding
// brief. Not a free-form memory — a typed struct with known sections so the
// system can render it and future sessions can query by sessionId.
//
// Semantics:
//   sessionId   — primary key. Posting a packet with the same sessionId
//                 overwrites the previous packet (upsert-by-session).
//   createdAt   — ISO timestamp, server-stamped if omitted on input.
//   authoredBy  — free-text agent/user identifier ('claude-opus-4-7',
//                 'alice@ex.com', 'ci-bot').
//   summary     — 1-2 sentence high-level what-happened.
//   whatShipped — completed work items. Plain strings.
//   whatBlessed — learnings explicitly preserved. Each entry cites the
//                 learning id so the incoming agent can pull the body.
//   whatRemains — open threads / deferred work.
//   nextVerify  — verifications the next agent should run before trusting
//                 the state. Optional; skip if you're confident.
//   links       — related commit SHAs, PR URLs, wiki pages. Typed so the
//                 renderer can treat commits vs PRs vs raw URLs differently.
export interface HandoffPacketLink {
  kind: 'commit' | 'pr' | 'url' | 'wiki';
  value: string;
  label?: string;
}

export interface HandoffBlessedRef {
  learningId: string;
  note?: string;
}

export interface HandoffPacket {
  sessionId: string;
  createdAt: string;
  authoredBy?: string;
  summary: string;
  whatShipped: string[];
  whatBlessed: HandoffBlessedRef[];
  whatRemains: string[];
  nextVerify?: string[];
  links?: HandoffPacketLink[];
}

export interface HandoffOperationsContext {
  initDB(): Promise<any>;
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

export interface InjectTraceCandidate {
  id: string;
  trigger: string;
  learning: string;
  similarity_score: number;
  passed_threshold: boolean;
  // Additive integrity metadata. Cheap to compute at query time and used by
  // the lean-MCP `search` verb so agents can triage hits without pulling
  // learning bodies into context.
  confidence: number;
  scope: string;
  recall_count: number;
  created_at: string;
  last_recalled_at: string | null;
  anti_pattern: boolean;
  supersedes: string | null;
  suspect_score: number;
  branch_state: LearningBranchState;
}

export interface InjectTraceResult {
  input_context: string;
  embedding_generated: number[];
  candidates: InjectTraceCandidate[];
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
