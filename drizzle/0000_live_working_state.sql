-- Generated migration artifact for live working state tables
-- Source of truth: src/schema.ts

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

CREATE INDEX IF NOT EXISTS idx_state_runs_status ON state_runs(status);
CREATE INDEX IF NOT EXISTS idx_state_runs_updated_at ON state_runs(updated_at);

CREATE TABLE IF NOT EXISTS state_revisions (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  state_json TEXT NOT NULL,
  change_summary TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_revisions_run_id ON state_revisions(run_id);
CREATE INDEX IF NOT EXISTS idx_state_revisions_run_rev ON state_revisions(run_id, revision);

CREATE TABLE IF NOT EXISTS state_events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_by TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_state_events_run_id ON state_events(run_id);
CREATE INDEX IF NOT EXISTS idx_state_events_created_at ON state_events(created_at);
