/**
 * SQLite-backed storage for deja.
 *
 * Three tables: slips, links, handoffs.
 * FTS5 virtual table on slips.text for recall().
 *
 * Atomic-immutable: rows are inserted, state transitions are updates to
 * `state` and `*_at` timestamps only. Text is never edited in place.
 */

import { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { mkdirSync } from "node:fs";
import type {
  Slip,
  SlipState,
  Link,
  LinkKind,
  Handoff,
} from "./types.ts";

export interface StorageOptions {
  /** Override DB path. Default: ~/.deja/deja.db (or :memory: in tests). */
  path?: string;
}

export function defaultDbPath(): string {
  return process.env.DEJA_DB ?? join(homedir(), ".deja", "deja.db");
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS slips (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL,
  authored_by TEXT NOT NULL,
  text        TEXT NOT NULL,
  tags        TEXT NOT NULL DEFAULT '[]',  -- JSON array
  state       TEXT NOT NULL CHECK (state IN ('draft','kept','expired')),
  created_at  INTEGER NOT NULL,
  kept_at     INTEGER,
  expired_at  INTEGER,
  used_count  INTEGER NOT NULL DEFAULT 0,
  wrong_count INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_slips_session  ON slips(session_id);
CREATE INDEX IF NOT EXISTS idx_slips_state    ON slips(state);
CREATE INDEX IF NOT EXISTS idx_slips_created  ON slips(created_at);

CREATE TABLE IF NOT EXISTS links (
  from_id    TEXT NOT NULL,
  to_id      TEXT NOT NULL,
  kind       TEXT NOT NULL CHECK (kind IN ('supersedes','contradicts','related')),
  created_at INTEGER NOT NULL,
  PRIMARY KEY (from_id, to_id, kind),
  FOREIGN KEY (from_id) REFERENCES slips(id),
  FOREIGN KEY (to_id)   REFERENCES slips(id)
);

CREATE INDEX IF NOT EXISTS idx_links_to ON links(to_id);

CREATE TABLE IF NOT EXISTS handoffs (
  id          TEXT PRIMARY KEY,
  session_id  TEXT NOT NULL UNIQUE,  -- one handoff per session
  authored_by TEXT NOT NULL,
  summary     TEXT NOT NULL,
  kept        TEXT NOT NULL DEFAULT '[]',  -- JSON array of slip ids
  next        TEXT NOT NULL DEFAULT '[]',  -- JSON array of strings
  created_at  INTEGER NOT NULL
);

-- Porter stemming layered on top of unicode61. Catches morphological
-- variants ("prefers" matches "preferred", "deploy" matches "deployment").
-- Stemming is the cheapest possible win for natural-language queries
-- where the slip and the query don't share exact word forms.
CREATE VIRTUAL TABLE IF NOT EXISTS slips_fts USING fts5(
  text,
  tags,
  content='slips',
  content_rowid='rowid',
  tokenize="porter unicode61 remove_diacritics 2"
);

CREATE TRIGGER IF NOT EXISTS slips_ai AFTER INSERT ON slips BEGIN
  INSERT INTO slips_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS slips_ad AFTER DELETE ON slips BEGIN
  INSERT INTO slips_fts(slips_fts, rowid, text, tags)
    VALUES ('delete', old.rowid, old.text, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS slips_au AFTER UPDATE OF text, tags ON slips BEGIN
  INSERT INTO slips_fts(slips_fts, rowid, text, tags)
    VALUES ('delete', old.rowid, old.text, old.tags);
  INSERT INTO slips_fts(rowid, text, tags) VALUES (new.rowid, new.text, new.tags);
END;
`;

interface SlipRow {
  id: string;
  session_id: string;
  authored_by: string;
  text: string;
  tags: string;
  state: SlipState;
  created_at: number;
  kept_at: number | null;
  expired_at: number | null;
  used_count: number;
  wrong_count: number;
}

function rowToSlip(r: SlipRow): Slip {
  return {
    id: r.id,
    sessionId: r.session_id,
    authoredBy: r.authored_by,
    text: r.text,
    tags: JSON.parse(r.tags) as string[],
    state: r.state,
    createdAt: r.created_at,
    keptAt: r.kept_at,
    expiredAt: r.expired_at,
    usedCount: r.used_count,
    wrongCount: r.wrong_count,
  };
}

interface HandoffRow {
  id: string;
  session_id: string;
  authored_by: string;
  summary: string;
  kept: string;
  next: string;
  created_at: number;
}

function rowToHandoff(r: HandoffRow): Handoff {
  return {
    id: r.id,
    sessionId: r.session_id,
    authoredBy: r.authored_by,
    summary: r.summary,
    kept: JSON.parse(r.kept) as string[],
    next: JSON.parse(r.next) as string[],
    createdAt: r.created_at,
  };
}

export class Storage {
  readonly db: Database;
  readonly path: string;

  constructor(opts: StorageOptions = {}) {
    this.path = opts.path ?? defaultDbPath();
    if (this.path !== ":memory:") {
      mkdirSync(dirname(this.path), { recursive: true });
    }
    this.db = new Database(this.path, { create: true });
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
  }

  close(): void {
    this.db.close();
  }

  // ----- slips -----

  insertSlip(s: Slip): void {
    this.db
      .prepare(
        `INSERT INTO slips
         (id, session_id, authored_by, text, tags, state, created_at, kept_at, expired_at, used_count, wrong_count)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        s.id,
        s.sessionId,
        s.authoredBy,
        s.text,
        JSON.stringify(s.tags),
        s.state,
        s.createdAt,
        s.keptAt,
        s.expiredAt,
        s.usedCount,
        s.wrongCount,
      );
  }

  getSlip(id: string): Slip | null {
    const r = this.db
      .prepare(`SELECT * FROM slips WHERE id = ?`)
      .get(id) as SlipRow | null;
    return r ? rowToSlip(r) : null;
  }

  setState(id: string, state: SlipState, at: number): boolean {
    const stmt =
      state === "kept"
        ? `UPDATE slips SET state = 'kept',    kept_at    = ? WHERE id = ?`
        : state === "expired"
          ? `UPDATE slips SET state = 'expired', expired_at = ? WHERE id = ?`
          : `UPDATE slips SET state = 'draft' WHERE id = ?`;
    const args = state === "draft" ? [id] : [at, id];
    const res = this.db.prepare(stmt).run(...args);
    return res.changes > 0;
  }

  bumpUsed(id: string): void {
    this.db
      .prepare(`UPDATE slips SET used_count = used_count + 1 WHERE id = ?`)
      .run(id);
  }

  bumpWrong(id: string): void {
    this.db
      .prepare(`UPDATE slips SET wrong_count = wrong_count + 1 WHERE id = ?`)
      .run(id);
  }

  /** Expire all drafts older than `cutoff` ms. Returns count. */
  gcDrafts(cutoff: number, now: number): number {
    const res = this.db
      .prepare(
        `UPDATE slips SET state = 'expired', expired_at = ?
         WHERE state = 'draft' AND created_at < ?`,
      )
      .run(now, cutoff);
    return res.changes;
  }

  listBySession(sessionId: string): Slip[] {
    const rows = this.db
      .prepare(`SELECT * FROM slips WHERE session_id = ? ORDER BY created_at ASC`)
      .all(sessionId) as SlipRow[];
    return rows.map(rowToSlip);
  }

  listKept(limit = 50): Slip[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM slips WHERE state = 'kept' ORDER BY kept_at DESC LIMIT ?`,
      )
      .all(limit) as SlipRow[];
    return rows.map(rowToSlip);
  }

  // ----- search -----

  /** FTS5 search over kept + draft slips (excludes expired). */
  searchFts(
    query: string,
    limit: number,
  ): Array<{ slip: Slip; score: number }> {
    // Tokenize on whitespace, strip non-word chars per token, drop empties.
    // Bare tokens let FTS5's porter tokenizer stem ("prefers" matches "preferred").
    // We OR them so any subset match still ranks; longest match wins via BM25.
    const sanitized = query
      .split(/\s+/)
      .map((t) => t.replace(/[^a-zA-Z0-9]/g, ""))
      .filter((t) => t.length > 0)
      .join(" OR ");
    if (!sanitized) return [];

    const rows = this.db
      .prepare(
        `SELECT s.*, bm25(slips_fts) AS score
         FROM slips_fts
         JOIN slips s ON s.rowid = slips_fts.rowid
         WHERE slips_fts MATCH ?
           AND s.state != 'expired'
         ORDER BY score ASC
         LIMIT ?`,
      )
      .all(sanitized, limit) as Array<SlipRow & { score: number }>;

    return rows.map((r) => ({
      slip: rowToSlip(r),
      score: r.score,
    }));
  }

  // ----- links -----

  insertLink(l: Link): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO links (from_id, to_id, kind, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run(l.fromId, l.toId, l.kind, l.createdAt);
  }

  linksFrom(id: string): Link[] {
    const rows = this.db
      .prepare(`SELECT from_id, to_id, kind, created_at FROM links WHERE from_id = ?`)
      .all(id) as Array<{
      from_id: string;
      to_id: string;
      kind: LinkKind;
      created_at: number;
    }>;
    return rows.map((r) => ({
      fromId: r.from_id,
      toId: r.to_id,
      kind: r.kind,
      createdAt: r.created_at,
    }));
  }

  // ----- handoffs -----

  insertHandoff(h: Handoff): void {
    this.db
      .prepare(
        `INSERT INTO handoffs (id, session_id, authored_by, summary, kept, next, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        h.id,
        h.sessionId,
        h.authoredBy,
        h.summary,
        JSON.stringify(h.kept),
        JSON.stringify(h.next),
        h.createdAt,
      );
  }

  getHandoffBySession(sessionId: string): Handoff | null {
    const r = this.db
      .prepare(`SELECT * FROM handoffs WHERE session_id = ?`)
      .get(sessionId) as HandoffRow | null;
    return r ? rowToHandoff(r) : null;
  }

  latestHandoffs(limit = 5): Handoff[] {
    const rows = this.db
      .prepare(`SELECT * FROM handoffs ORDER BY created_at DESC LIMIT ?`)
      .all(limit) as HandoffRow[];
    return rows.map(rowToHandoff);
  }

  // ----- diagnostics -----

  counts(): { slips: number; kept: number; drafts: number; handoffs: number } {
    const total = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM slips`).get() as { n: number }
    ).n;
    const kept = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM slips WHERE state = 'kept'`)
        .get() as { n: number }
    ).n;
    const drafts = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM slips WHERE state = 'draft'`)
        .get() as { n: number }
    ).n;
    const handoffs = (
      this.db.prepare(`SELECT COUNT(*) AS n FROM handoffs`).get() as { n: number }
    ).n;
    return { slips: total, kept, drafts, handoffs };
  }
}
