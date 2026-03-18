import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';

export const learnings = sqliteTable('learnings', {
  id: text('id').primaryKey(),
  trigger: text('trigger').notNull(),
  learning: text('learning').notNull(),
  reason: text('reason'),
  confidence: real('confidence').default(1.0),
  source: text('source'),
  scope: text('scope').notNull(), // Added for scope support
  embedding: text('embedding'), // Vector embedding as JSON string
  createdAt: text('created_at').notNull(),
  lastRecalledAt: text('last_recalled_at'),
  recallCount: integer('recall_count').default(0),
  traceId: text('trace_id'),
  workspaceId: text('workspace_id'),
  conversationId: text('conversation_id'),
  runId: text('run_id'),
  proofRunId: text('proof_run_id'),
  proofIterationId: text('proof_iteration_id'),
});

export const secrets = sqliteTable('secrets', {
  name: text('name').primaryKey(),
  value: text('value').notNull(),
  scope: text('scope').notNull(), // Added for scope support
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

// Live working state for active runs/sessions
export const stateRuns = sqliteTable('state_runs', {
  runId: text('run_id').primaryKey(),
  revision: integer('revision').notNull().default(0),
  stateJson: text('state_json').notNull(),
  status: text('status').notNull().default('active'),
  updatedBy: text('updated_by'),
  traceId: text('trace_id'),
  workspaceId: text('workspace_id'),
  conversationId: text('conversation_id'),
  proofRunId: text('proof_run_id'),
  proofIterationId: text('proof_iteration_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  resolvedAt: text('resolved_at'),
});

// Immutable revision history of state changes
export const stateRevisions = sqliteTable('state_revisions', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  revision: integer('revision').notNull(),
  stateJson: text('state_json').notNull(),
  changeSummary: text('change_summary'),
  updatedBy: text('updated_by'),
  traceId: text('trace_id'),
  workspaceId: text('workspace_id'),
  conversationId: text('conversation_id'),
  proofRunId: text('proof_run_id'),
  proofIterationId: text('proof_iteration_id'),
  createdAt: text('created_at').notNull(),
});

// Immutable loop run ledger
export const loopRuns = sqliteTable('loop_runs', {
  id: text('id').primaryKey(),
  scope: text('scope').notNull(),
  outcome: text('outcome').notNull(), // 'pass' | 'fail' | 'exhausted'
  attempts: integer('attempts').notNull(),
  code: text('code'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
});

// Immutable event stream attached to runs
export const stateEvents = sqliteTable('state_events', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  eventType: text('event_type').notNull(),
  payloadJson: text('payload_json').notNull(),
  createdBy: text('created_by'),
  traceId: text('trace_id'),
  workspaceId: text('workspace_id'),
  conversationId: text('conversation_id'),
  proofRunId: text('proof_run_id'),
  proofIterationId: text('proof_iteration_id'),
  createdAt: text('created_at').notNull(),
});
