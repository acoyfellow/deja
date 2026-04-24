import { sqliteTable, text, real, integer } from 'drizzle-orm/sqlite-core';

export const learnings = sqliteTable('learnings', {
  id: text('id').primaryKey(),
  trigger: text('trigger').notNull(),
  learning: text('learning').notNull(),
  reason: text('reason'),
  confidence: real('confidence').default(1.0),
  source: text('source'),
  scope: text('scope').notNull(), // Added for scope support
  supersedes: text('supersedes'),
  type: text('type').notNull().default('memory'),
  // Branch lifecycle. 'main' = normal learning visible everywhere scope allows.
  // 'session' = scratchpad write tied to a single session:<id> scope, invisible
  // to other sessions, auto-GC'd after the branch TTL expires unless blessed.
  // 'blessed' = was 'session', explicitly promoted via bless(). Opts out of the
  // session-TTL sweep but keeps its session:<id> scope as provenance.
  branchState: text('branch_state').notNull().default('main'),
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

// Session-branch metadata. One row per session that has at least one write.
// Tracks TTL (auto-GC boundary), bless/discard lifecycle, and created_at for
// ordering. Rows outlive their learnings intentionally — a discarded branch's
// row persists as audit evidence that the branch existed and was thrown away.
export const sessionBranches = sqliteTable('session_branches', {
  sessionId: text('session_id').primaryKey(), // matches the 'session:<id>' scope suffix
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at').notNull(),
  blessedAt: text('blessed_at'), // null = still open or discarded
  discardedAt: text('discarded_at'), // null = still open or blessed
});

// Handoff packets. Typed structured summaries of a session's end-of-run state:
// what shipped, what was blessed, what remains, what the next agent should
// verify. One row per session_id — posting again overwrites. The whole packet
// is serialized to JSON in packet_json rather than normalized into child
// tables; a handoff is a single typed blob, not a relational tree.
export const handoffPackets = sqliteTable('handoff_packets', {
  sessionId: text('session_id').primaryKey(),
  createdAt: text('created_at').notNull(),
  authoredBy: text('authored_by'),
  packetJson: text('packet_json').notNull(),
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
