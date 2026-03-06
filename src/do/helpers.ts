import type {
  Learning,
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
        embedding TEXT,
        created_at TEXT NOT NULL
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
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS state_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_by TEXT,
        created_at TEXT NOT NULL
      );
    `);
  });
}

export function filterScopesByPriority(scopes: string[]): string[] {
  const priority = ['session:', 'agent:', 'shared'];

  for (const prefix of priority) {
    const matches = scopes.filter((scope) => scope.startsWith(prefix));
    if (matches.length > 0) {
      return matches;
    }
  }

  return scopes.includes('shared') ? ['shared'] : [];
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
    embedding: dbLearning.embedding ? JSON.parse(dbLearning.embedding) : undefined,
    createdAt: dbLearning.createdAt,
    lastRecalledAt: dbLearning.lastRecalledAt ?? undefined,
    recallCount: dbLearning.recallCount ?? 0,
  };
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
