import { and, eq, inArray, like, lt, sql } from 'drizzle-orm';

import * as schema from '../schema';
import type { SessionBranch, SessionBranchStatus } from './types';

// Default TTL for an unblessed session branch. Overridable per-call but 24h
// is long enough for a normal debugging or building session and short enough
// that forgotten scratchpads don't pile up. Blessed branches ignore this.
export const SESSION_BRANCH_DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

// Scope prefix all session branches share. Same convention as the rest of
// deja — filterScopesByPriority already special-cases this prefix.
const SESSION_SCOPE_PREFIX = 'session:';

export interface SessionBranchOperationsContext {
  initDB(): Promise<any>;
}

export function sessionIdToScope(sessionId: string): string {
  return `${SESSION_SCOPE_PREFIX}${sessionId}`;
}

export function scopeToSessionId(scope: string): string | null {
  return scope.startsWith(SESSION_SCOPE_PREFIX)
    ? scope.slice(SESSION_SCOPE_PREFIX.length)
    : null;
}

// Parse a session_id from a raw scope input. Accepts either the bare id
// ('abc') or the prefixed form ('session:abc'). Returns the bare id or null
// if the input doesn't look like a session scope. Empty string is rejected.
export function normalizeSessionId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const fromScope = scopeToSessionId(trimmed);
  if (fromScope !== null) return fromScope.length > 0 ? fromScope : null;
  return trimmed;
}

// Map DB row → SessionBranch. Drizzle returns camelCase via the schema map.
function convertDbBranch(row: any): SessionBranch {
  return {
    sessionId: row.sessionId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    blessedAt: row.blessedAt ?? null,
    discardedAt: row.discardedAt ?? null,
  };
}

export function deriveBranchStatus(
  branch: SessionBranch,
  nowMs: number = Date.now(),
): SessionBranchStatus {
  if (branch.discardedAt) return 'discarded';
  if (branch.blessedAt) return 'blessed';
  const expiresMs = Date.parse(branch.expiresAt);
  if (Number.isFinite(expiresMs) && expiresMs <= nowMs) return 'expired';
  return 'open';
}

// Look up a branch by session id. Returns null if no row exists.
export async function getSessionBranch(
  ctx: SessionBranchOperationsContext,
  sessionId: string,
): Promise<SessionBranch | null> {
  const db = await ctx.initDB();
  const rows = await db
    .select()
    .from(schema.sessionBranches)
    .where(eq(schema.sessionBranches.sessionId, sessionId))
    .limit(1);
  return rows.length ? convertDbBranch(rows[0]) : null;
}

// Ensure a branch row exists for the session. Idempotent — if a row is
// already present it's returned unchanged (even if blessed/discarded). This
// is called from the hot `learn()` path, so it must be cheap and allocation-
// light on the happy "row already exists" case.
export async function ensureSessionBranch(
  ctx: SessionBranchOperationsContext,
  sessionId: string,
  ttlMs: number = SESSION_BRANCH_DEFAULT_TTL_MS,
  nowMs: number = Date.now(),
): Promise<SessionBranch> {
  const existing = await getSessionBranch(ctx, sessionId);
  if (existing) return existing;

  const db = await ctx.initDB();
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + ttlMs).toISOString();

  // ON CONFLICT DO NOTHING — if two concurrent learns race this path, the
  // second one silently falls through and re-reads the row below.
  await db
    .insert(schema.sessionBranches)
    .values({
      sessionId,
      createdAt,
      expiresAt,
      blessedAt: null,
      discardedAt: null,
    })
    .onConflictDoNothing();

  const reread = await getSessionBranch(ctx, sessionId);
  if (reread) return reread;

  // Fallback — the insert succeeded but the re-read returned nothing. Return
  // the in-memory shape we would have written. This path should be unreachable
  // in correct DO SQLite but keeps the type contract honest.
  return {
    sessionId,
    createdAt,
    expiresAt,
    blessedAt: null,
    discardedAt: null,
  };
}

export interface BlessOptions {
  // If provided, only these learning ids are blessed. Other 'session' rows
  // in the branch are left untouched. When omitted, ALL 'session' rows for
  // the branch are promoted to 'blessed'.
  learningIds?: string[];
}

export interface BlessResult {
  sessionId: string;
  blessedAt: string;
  promotedCount: number;
  promotedIds: string[];
}

// Promote session-branch learnings to 'blessed'. After bless():
//   - branch_state flips from 'session' → 'blessed' on the selected rows
//   - the session_branches row gets blessed_at set
//   - recall filters treat these rows like 'main' (visible everywhere
//     scope allows), but the scope stays 'session:<id>' so provenance of
//     which session authored the write is preserved on disk.
// Only rows with branch_state = 'session' are promoted — already-blessed
// rows are skipped, and 'main' rows belonging to a different session can
// never be dragged into someone else's branch.
export async function blessSessionBranch(
  ctx: SessionBranchOperationsContext,
  sessionId: string,
  opts: BlessOptions = {},
): Promise<BlessResult> {
  const db = await ctx.initDB();
  const nowIso = new Date().toISOString();
  const scope = sessionIdToScope(sessionId);

  // Collect the ids we're about to promote, so we can return the exact list.
  const idFilter = opts.learningIds && opts.learningIds.length > 0
    ? inArray(schema.learnings.id, opts.learningIds)
    : undefined;

  const candidates: Array<{ id: string }> = await db
    .select({ id: schema.learnings.id })
    .from(schema.learnings)
    .where(
      idFilter
        ? and(
            eq(schema.learnings.scope, scope),
            eq(schema.learnings.branchState, 'session'),
            idFilter,
          )
        : and(
            eq(schema.learnings.scope, scope),
            eq(schema.learnings.branchState, 'session'),
          ),
    );

  const promotedIds = candidates.map((row) => row.id);

  if (promotedIds.length > 0) {
    await db
      .update(schema.learnings)
      .set({ branchState: 'blessed' })
      .where(inArray(schema.learnings.id, promotedIds));
  }

  // Always record the bless timestamp on the branch row, even if zero rows
  // were promoted (e.g. an agent blessing an empty branch to close it out).
  await db
    .insert(schema.sessionBranches)
    .values({
      sessionId,
      createdAt: nowIso,
      expiresAt: nowIso, // blessed branches don't expire, but column is NOT NULL
      blessedAt: nowIso,
      discardedAt: null,
    })
    .onConflictDoUpdate({
      target: schema.sessionBranches.sessionId,
      set: { blessedAt: nowIso },
    });

  return {
    sessionId,
    blessedAt: nowIso,
    promotedCount: promotedIds.length,
    promotedIds,
  };
}

export interface DiscardResult {
  sessionId: string;
  discardedAt: string;
  deletedCount: number;
  deletedIds: string[];
}

// Immediate hard-delete of all 'session' rows in the branch. Already-blessed
// rows are preserved — discard() only throws away the scratchpad, not the
// commitments. The branch row itself is kept (with discarded_at set) as an
// audit trail that the branch existed and was thrown away.
export async function discardSessionBranch(
  ctx: SessionBranchOperationsContext,
  sessionId: string,
): Promise<DiscardResult> {
  const db = await ctx.initDB();
  const nowIso = new Date().toISOString();
  const scope = sessionIdToScope(sessionId);

  const toDelete: Array<{ id: string }> = await db
    .select({ id: schema.learnings.id })
    .from(schema.learnings)
    .where(
      and(
        eq(schema.learnings.scope, scope),
        eq(schema.learnings.branchState, 'session'),
      ),
    );

  const deletedIds = toDelete.map((row) => row.id);

  if (deletedIds.length > 0) {
    await db.delete(schema.learnings).where(inArray(schema.learnings.id, deletedIds));
  }

  await db
    .insert(schema.sessionBranches)
    .values({
      sessionId,
      createdAt: nowIso,
      expiresAt: nowIso,
      blessedAt: null,
      discardedAt: nowIso,
    })
    .onConflictDoUpdate({
      target: schema.sessionBranches.sessionId,
      set: { discardedAt: nowIso },
    });

  return {
    sessionId,
    discardedAt: nowIso,
    deletedCount: deletedIds.length,
    deletedIds,
  };
}

export interface BranchStatus {
  sessionId: string;
  status: SessionBranchStatus;
  createdAt: string;
  expiresAt: string;
  blessedAt: string | null;
  discardedAt: string | null;
  // Counts at query time. Rollups, not the rows themselves — intentional.
  // Use list_branch to pull the actual learnings.
  sessionCount: number;
  blessedCount: number;
}

async function countLearningsByBranchState(
  ctx: SessionBranchOperationsContext,
  scope: string,
): Promise<{ session: number; blessed: number }> {
  const db = await ctx.initDB();
  const rows: Array<{ state: string; n: number }> = await db
    .select({
      state: schema.learnings.branchState,
      n: sql<number>`cast(count(*) as integer)`,
    })
    .from(schema.learnings)
    .where(eq(schema.learnings.scope, scope))
    .groupBy(schema.learnings.branchState);

  let session = 0;
  let blessed = 0;
  for (const row of rows) {
    if (row.state === 'session') session = row.n;
    else if (row.state === 'blessed') blessed = row.n;
  }
  return { session, blessed };
}

export async function getBranchStatus(
  ctx: SessionBranchOperationsContext,
  sessionId: string,
  nowMs: number = Date.now(),
): Promise<BranchStatus | null> {
  const branch = await getSessionBranch(ctx, sessionId);
  if (!branch) return null;

  const counts = await countLearningsByBranchState(ctx, sessionIdToScope(sessionId));

  return {
    sessionId,
    status: deriveBranchStatus(branch, nowMs),
    createdAt: branch.createdAt,
    expiresAt: branch.expiresAt,
    blessedAt: branch.blessedAt,
    discardedAt: branch.discardedAt,
    sessionCount: counts.session,
    blessedCount: counts.blessed,
  };
}

// List all known branches (open + blessed + discarded + expired). Caller can
// filter by status on the returned list. Used by MCP `branch_status` when no
// session_id is given.
export async function listBranches(
  ctx: SessionBranchOperationsContext,
  nowMs: number = Date.now(),
): Promise<BranchStatus[]> {
  const db = await ctx.initDB();
  const rows = await db.select().from(schema.sessionBranches);
  const branches = rows.map(convertDbBranch);

  const results: BranchStatus[] = [];
  for (const branch of branches) {
    const counts = await countLearningsByBranchState(ctx, sessionIdToScope(branch.sessionId));
    results.push({
      sessionId: branch.sessionId,
      status: deriveBranchStatus(branch, nowMs),
      createdAt: branch.createdAt,
      expiresAt: branch.expiresAt,
      blessedAt: branch.blessedAt,
      discardedAt: branch.discardedAt,
      sessionCount: counts.session,
      blessedCount: counts.blessed,
    });
  }

  // Newest first — matches the vibe of other list endpoints in deja.
  results.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return results;
}

export interface BranchGcResult {
  expiredBranches: number;
  deletedLearnings: number;
  deletedIds: string[];
}

// Cron-side GC. Deletes all 'session'-state learnings whose branch has
// expired. Safe to run repeatedly — only ever looks at expired, unblessed,
// undiscarded branches. Blessed rows are NEVER touched here (they have
// branch_state = 'blessed', which is excluded from the delete WHERE).
// Branch rows themselves are kept; marking them 'discardedAt = now' at GC
// time would overload semantics (discarded implies an explicit user action).
export async function gcExpiredSessionBranches(
  ctx: SessionBranchOperationsContext,
  nowMs: number = Date.now(),
): Promise<BranchGcResult> {
  const db = await ctx.initDB();
  const nowIso = new Date(nowMs).toISOString();

  const expiredBranches: Array<{ sessionId: string }> = await db
    .select({ sessionId: schema.sessionBranches.sessionId })
    .from(schema.sessionBranches)
    .where(
      and(
        lt(schema.sessionBranches.expiresAt, nowIso),
        // isNull in drizzle is a predicate — inline via sql template for
        // portability across the mocked drizzle surface used in tests.
        sql`${schema.sessionBranches.blessedAt} IS NULL`,
        sql`${schema.sessionBranches.discardedAt} IS NULL`,
      ),
    );

  if (expiredBranches.length === 0) {
    return { expiredBranches: 0, deletedLearnings: 0, deletedIds: [] };
  }

  const scopes = expiredBranches.map((branch) => sessionIdToScope(branch.sessionId));

  const toDelete: Array<{ id: string }> = await db
    .select({ id: schema.learnings.id })
    .from(schema.learnings)
    .where(
      and(
        inArray(schema.learnings.scope, scopes),
        eq(schema.learnings.branchState, 'session'),
      ),
    );

  const deletedIds = toDelete.map((row) => row.id);

  if (deletedIds.length > 0) {
    await db.delete(schema.learnings).where(inArray(schema.learnings.id, deletedIds));
  }

  return {
    expiredBranches: expiredBranches.length,
    deletedLearnings: deletedIds.length,
    deletedIds,
  };
}
