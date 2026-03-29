import type {
  Learning,
  SharedRunIdentity,
  WorkingStatePayload,
  WorkingStateResponse,
} from './types';

export function initializeStorage(state: DurableObjectState) {
  state.blockConcurrencyWhile(async () => {
    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS learnings (
        id TEXT PRIMARY KEY,
        trigger TEXT NOT NULL,
        learning TEXT NOT NULL,
        reason TEXT,
        confidence REAL DEFAULT 1.0,
        source TEXT,
        scope TEXT NOT NULL,
        supersedes TEXT,
        type TEXT NOT NULL DEFAULT 'memory',
        embedding TEXT,
        created_at TEXT NOT NULL,
        trace_id TEXT,
        workspace_id TEXT,
        conversation_id TEXT,
        run_id TEXT,
        proof_run_id TEXT,
        proof_iteration_id TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_learnings_trigger ON learnings(trigger);
      CREATE INDEX IF NOT EXISTS idx_learnings_confidence ON learnings(confidence);
      CREATE INDEX IF NOT EXISTS idx_learnings_created_at ON learnings(created_at);
      CREATE INDEX IF NOT EXISTS idx_learnings_scope ON learnings(scope);
    `);
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN last_recalled_at TEXT`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN recall_count INTEGER DEFAULT 0`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`CREATE INDEX IF NOT EXISTS idx_learnings_last_recalled_at ON learnings(last_recalled_at)`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN trace_id TEXT`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN workspace_id TEXT`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN conversation_id TEXT`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN run_id TEXT`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN proof_run_id TEXT`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN proof_iteration_id TEXT`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN supersedes TEXT`);
    } catch (_) {}
    try {
      state.storage.sql.exec(`ALTER TABLE learnings ADD COLUMN type TEXT NOT NULL DEFAULT 'memory'`);
    } catch (_) {}

    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS secrets (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        scope TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_secrets_scope ON secrets(scope);
    `);

    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS state_runs (
        run_id TEXT PRIMARY KEY,
        revision INTEGER NOT NULL DEFAULT 0,
        state_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        updated_by TEXT,
        trace_id TEXT,
        workspace_id TEXT,
        conversation_id TEXT,
        proof_run_id TEXT,
        proof_iteration_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS state_revisions (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        state_json TEXT NOT NULL,
        change_summary TEXT,
        updated_by TEXT,
        trace_id TEXT,
        workspace_id TEXT,
        conversation_id TEXT,
        proof_run_id TEXT,
        proof_iteration_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_by TEXT,
        trace_id TEXT,
        workspace_id TEXT,
        conversation_id TEXT,
        proof_run_id TEXT,
        proof_iteration_id TEXT,
        created_at TEXT NOT NULL
      );
    `);
    state.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS loop_runs (
        id TEXT PRIMARY KEY,
        scope TEXT NOT NULL,
        outcome TEXT NOT NULL,
        attempts INTEGER NOT NULL,
        code TEXT,
        error TEXT,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_loop_runs_scope ON loop_runs(scope);
      CREATE INDEX IF NOT EXISTS idx_loop_runs_created_at ON loop_runs(created_at);
    `);

    for (const table of ['state_runs', 'state_revisions', 'state_events']) {
      for (const column of ['trace_id', 'workspace_id', 'conversation_id', 'proof_run_id', 'proof_iteration_id']) {
        try {
          state.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} TEXT`);
        } catch (_) {}
      }
    }
  });
}

export function filterScopesByPriority(scopes: string[]): string[] {
  if (scopes.length === 0) return [];

  const priority = ['session:', 'agent:', 'shared'];

  for (const prefix of priority) {
    const matches = scopes.filter((scope) => scope.startsWith(prefix));
    if (matches.length > 0) {
      return matches;
    }
  }

  // Pass through custom scopes (e.g. workspace-specific scopes from filepath)
  return scopes;
}

export function convertDbLearning(dbLearning: any): Learning {
  return {
    id: dbLearning.id,
    trigger: dbLearning.trigger,
    learning: dbLearning.learning,
    reason: dbLearning.reason !== null ? dbLearning.reason : undefined,
    confidence: dbLearning.confidence !== null ? dbLearning.confidence : 0,
    source: dbLearning.source !== null ? dbLearning.source : undefined,
    scope: dbLearning.scope,
    supersedes: dbLearning.supersedes ?? undefined,
    type: (dbLearning.type as Learning['type'] | null) ?? 'memory',
    embedding: dbLearning.embedding ? JSON.parse(dbLearning.embedding) : undefined,
    createdAt: dbLearning.createdAt,
    lastRecalledAt: dbLearning.lastRecalledAt ?? undefined,
    recallCount: dbLearning.recallCount ?? 0,
    identity: normalizeRunIdentityPayload(dbLearning),
  };
}

export function normalizeRunIdentityPayload(payload: any): SharedRunIdentity | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  const identity: SharedRunIdentity = {
    traceId: typeof payload.traceId === 'string' ? payload.traceId : payload.trace_id ?? null,
    workspaceId:
      typeof payload.workspaceId === 'string' ? payload.workspaceId : payload.workspace_id ?? null,
    conversationId:
      typeof payload.conversationId === 'string'
        ? payload.conversationId
        : payload.conversation_id ?? null,
    runId: typeof payload.runId === 'string' ? payload.runId : payload.run_id ?? null,
    proofRunId:
      typeof payload.proofRunId === 'string' ? payload.proofRunId : payload.proof_run_id ?? null,
    proofIterationId:
      typeof payload.proofIterationId === 'string'
        ? payload.proofIterationId
        : payload.proof_iteration_id ?? null,
  };

  return Object.values(identity).some((value) => typeof value === 'string' && value.length > 0)
    ? identity
    : undefined;
}

export function resolveRunIdentityPayload(payload: any): SharedRunIdentity | undefined {
  if (!payload || typeof payload !== 'object') {
    return undefined;
  }

  return normalizeRunIdentityPayload({
    ...(payload.identity ?? {}),
    ...payload,
  });
}

export function normalizeWorkingStatePayload(payload: any): WorkingStatePayload {
  const asStringArray = (value: any): string[] | undefined => {
    if (!Array.isArray(value)) return undefined;
    return value
      .map((v) => (typeof v === 'string' ? v.trim() : String(v ?? '').trim()))
      .filter(Boolean);
  };

  const decisions = Array.isArray(payload?.decisions)
    ? payload.decisions
        .map((decision: any) => ({
          id: typeof decision?.id === 'string' ? decision.id : undefined,
          text:
            typeof decision?.text === 'string'
              ? decision.text.trim()
              : String(decision?.text ?? '').trim(),
          status: typeof decision?.status === 'string' ? decision.status : undefined,
        }))
        .filter((decision: any) => decision.text)
    : undefined;

  return {
    goal: typeof payload?.goal === 'string' ? payload.goal.trim() : undefined,
    assumptions: asStringArray(payload?.assumptions),
    decisions,
    open_questions: asStringArray(payload?.open_questions),
    next_actions: asStringArray(payload?.next_actions),
    confidence:
      typeof payload?.confidence === 'number' && Number.isFinite(payload.confidence)
        ? payload.confidence
        : undefined,
  };
}

export function formatStatePrompt(state: WorkingStateResponse): string {
  const lines: string[] = [];
  lines.push('Working state (live):');
  if (state.state.goal) lines.push(`Goal: ${state.state.goal}`);
  if (state.state.assumptions?.length) {
    lines.push('Assumptions:');
    state.state.assumptions.forEach((assumption) => lines.push(`- ${assumption}`));
  }
  if (state.state.decisions?.length) {
    lines.push('Decisions:');
    state.state.decisions.forEach((decision) =>
      lines.push(`- ${decision.text}${decision.status ? ` (${decision.status})` : ''}`),
    );
  }
  if (state.state.open_questions?.length) {
    lines.push('Open questions:');
    state.state.open_questions.forEach((question) => lines.push(`- ${question}`));
  }
  if (state.state.next_actions?.length) {
    lines.push('Next actions:');
    state.state.next_actions.forEach((action) => lines.push(`- ${action}`));
  }
  if (typeof state.state.confidence === 'number') {
    lines.push(`Confidence: ${state.state.confidence}`);
  }
  return lines.join('\n');
}

export function createLearningId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
}
