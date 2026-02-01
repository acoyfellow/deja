-- deja: persistent memory for agents

CREATE TABLE IF NOT EXISTS learnings (
  id TEXT PRIMARY KEY,
  trigger TEXT NOT NULL,
  learning TEXT NOT NULL,
  reason TEXT,
  confidence REAL DEFAULT 1.0,
  source TEXT,
  scope TEXT NOT NULL, -- Added for scope support
  embedding TEXT, -- Vector embedding as JSON string
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_learnings_trigger ON learnings(trigger);
CREATE INDEX IF NOT EXISTS idx_learnings_confidence ON learnings(confidence);
CREATE INDEX IF NOT EXISTS idx_learnings_created_at ON learnings(created_at);
CREATE INDEX IF NOT EXISTS idx_learnings_scope ON learnings(scope);

-- Secrets table (authenticated read/write)
CREATE TABLE IF NOT EXISTS secrets (
  name TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  scope TEXT NOT NULL, -- Added for scope support
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_secrets_scope ON secrets(scope);
