import { and, desc, eq, inArray, like, or, sql } from 'drizzle-orm';

import * as schema from '../schema';
import { createLearningId } from './helpers';
import { ensureSessionBranch, gcExpiredSessionBranches } from './sessionBranch';
import type {
  InjectResult,
  InjectTraceResult,
  Learning,
  MemoryOperationsContext,
  QueryResult,
  SharedRunIdentity,
} from './types';

const DEDUPE_THRESHOLD = 0.95;
const CONFLICT_THRESHOLD = 0.6;
const DEDUPE_QUERY_TOP_K = 20;
const CONFIDENCE_CONFIRM_BOOST = 0.1;
const CONFIDENCE_REJECT_DECAY = 0.15;
const CONFIDENCE_MIN = 0.01;
const CONFIDENCE_MAX = 1.0;
const CONFIDENCE_DEFAULT = 0.5;
const ANTI_PATTERN_THRESHOLD = 0.15;
const ANTI_PATTERN_PREFIX = 'KNOWN PITFALL: ';

// Vectorize is eventually consistent: a fresh insert is not queryable for
// ~15-20s. Callers that want write-then-read consistency (e.g. an agent
// about to recall what it just wrote) pass `sync: true` to learn() and we
// poll VECTORIZE.query for the new id until it shows up or we time out.
//
// Defaults keep the fast-path async; sync is opt-in because it adds ~15-20s
// of wall-clock latency per write and would cripple bulk ingest.
const SYNC_MAX_WAIT_MS = 30_000;
const SYNC_INITIAL_INTERVAL_MS = 500;
const SYNC_MAX_INTERVAL_MS = 2_000;

// suspect_score composition — higher = more suspicious, range [0, 1].
// Weights are additive and clamped to [0, 1]; individual signals are bounded
// so no one signal can push a memory over 1.0 on its own.
//
// "Effective age" is time since `lastRecalledAt ?? createdAt`. An ancient
// memory that is actively recalled is load-bearing institutional knowledge,
// not cold storage, and should not be penalised just for its birthday.
const SUSPECT_WEIGHT_AGE = 0.2;                    // effective age / 365 days, clamped
const SUSPECT_WEIGHT_STALE_COLD = 0.3;             // effective age + under-recalled
const SUSPECT_WEIGHT_ANTI_PATTERN = 0.3;           // scaled by (1 - confidence): confirmed anti-patterns barely penalise
const SUSPECT_WEIGHT_LOW_CONFIDENCE = 0.5;         // continuous ramp — no cliff at 0.3
const SUSPECT_STALE_RAMP_START_DAYS = 7;
const SUSPECT_STALE_RAMP_END_DAYS = 30;
const SUSPECT_LOW_CONFIDENCE_FULL = 0.6;           // ramp engages below this; a 0.5 memory still takes a small hit
const SUSPECT_MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Compute a 0..1 integrity-suspect score for a learning at query time.
 *
 * This is a cheap, purely-derived signal meant to ride alongside similarity
 * scores in search/trace responses so agents can make context-bounded
 * decisions about whether to trust a hit without pulling its full body.
 *
 * Signals, weighted additively and clamped to [0, 1]:
 *   - effective age (time since lastRecalledAt, or createdAt if never
 *     recalled); linear up to 365 days
 *   - stale-cold — scales effective age (ramp 7d → 30d) by how
 *     under-recalled the memory is. A never-recalled month-old memory fires
 *     full; a heavily-recalled one doesn't fire at all.
 *   - anti-pattern, scaled by (1 - confidence): a *confirmed* anti-pattern is
 *     valuable negative knowledge and should barely register, a low-confidence
 *     "ANTI: I think..." is the suspicious case
 *   - low confidence as a continuous ramp up to 0.5 (no cliff at 0.3)
 *
 * `supersedes` is intentionally NOT a penalty: the superseding memory is the
 * chain *winner* — the newer, corrected version — not the discredited one.
 */
export function computeSuspectScore(learning: Learning, nowMs: number = Date.now()): number {
  let score = 0;

  const createdMs = Date.parse(learning.createdAt);
  const createdAgeDays = Number.isFinite(createdMs)
    ? Math.max(0, (nowMs - createdMs) / SUSPECT_MS_PER_DAY)
    : 0;

  // Effective age: if the memory was recalled recently, treat it as young
  // even if createdAt is ancient. Fall back to createdAgeDays when
  // lastRecalledAt is missing or unparseable.
  let effectiveAgeDays = createdAgeDays;
  if (typeof learning.lastRecalledAt === 'string') {
    const recalledMs = Date.parse(learning.lastRecalledAt);
    if (Number.isFinite(recalledMs)) {
      effectiveAgeDays = Math.max(0, (nowMs - recalledMs) / SUSPECT_MS_PER_DAY);
    }
  }

  score += Math.min(1, effectiveAgeDays / 365) * SUSPECT_WEIGHT_AGE;

  // Stale-cold: ramps in by effective age (so a memory recalled yesterday
  // doesn't look stale no matter how old its createdAt is) and scaled by
  // how *under-recalled* the memory is. A never-recalled row that is 30+
  // days past its last touch fires full; a heavily-recalled row never does.
  if (effectiveAgeDays > SUSPECT_STALE_RAMP_START_DAYS) {
    const ageRamp = Math.min(
      1,
      (effectiveAgeDays - SUSPECT_STALE_RAMP_START_DAYS) /
        (SUSPECT_STALE_RAMP_END_DAYS - SUSPECT_STALE_RAMP_START_DAYS),
    );
    // coldness: recallCount=0 → 1, 1 → 0.5, 2 → 0.33, 10 → 0.09
    const coldness = 1 / (1 + learning.recallCount);
    score += ageRamp * coldness * SUSPECT_WEIGHT_STALE_COLD;
  }

  // Anti-pattern penalty is inversely proportional to confidence. A
  // high-confidence anti-pattern is accurate negative knowledge; a
  // low-confidence one is "I vaguely remember this was bad" — the actual
  // suspect case. confidence=0.9 → +0.03, confidence=0.1 → +0.27.
  if (learning.type === 'anti-pattern') {
    const uncertainty = Math.max(0, Math.min(1, 1 - learning.confidence));
    score += uncertainty * SUSPECT_WEIGHT_ANTI_PATTERN;
  }

  // Continuous confidence ramp: max penalty at confidence=0, zero at or
  // above confidence=0.5. Replaces the `< 0.3` cliff, which was both a
  // hard threshold (0.3 slipped through, 0.29 fired full) and too narrow
  // (plenty of mid-confidence memories are legitimately suspect).
  if (learning.confidence < SUSPECT_LOW_CONFIDENCE_FULL) {
    const confRamp = (SUSPECT_LOW_CONFIDENCE_FULL - learning.confidence) / SUSPECT_LOW_CONFIDENCE_FULL;
    score += Math.max(0, Math.min(1, confRamp)) * SUSPECT_WEIGHT_LOW_CONFIDENCE;
  }

  // NOTE: supersedes is NOT scored. The superseding memory is the new,
  // winning revision — treating it as suspect was a directional error in
  // the original formulation.

  return Math.min(1, Math.round(score * 1000) / 1000);
}

// Single source of truth for recall visibility. Owns BOTH the scope match
// and the branch_state rule — callsites must not AND another scope filter
// alongside this one. Three disjunct branches:
//
//   1. 'main'     — normal learning. Visible iff scope is in the requested
//                   list. (Classic scope-isolation semantics; nothing new.)
//
//   2. 'blessed'  — promoted scratchpad. Visible REGARDLESS of scope. The
//                   stored scope ('session:<id>') is retained as authored-
//                   by provenance, not used as a filter. This is the whole
//                   point of bless: graduating a learning from throwaway
//                   to cross-session institutional memory. Without this
//                   branch, bless() would only make rows session-permanent
//                   — not promoted — which is not what the word means.
//
//   3. 'session'  — live scratchpad. Visible only if the caller explicitly
//                   asked for that exact session:<id> scope. No session's
//                   unblessed scratchpad ever leaks to other callers.
//
// If no session scopes are in the filter, branch (3) evaluates to false
// (via the sql`0` fallback), so no session rows leak at all. This is the
// load-bearing isolation invariant and it holds regardless of (1)/(2).
//
// Returns a drizzle predicate. REPLACES the prior inArray(scope, ...) SQL
// clause at recall callsites — don't AND this with another scope filter.
export function buildBranchVisibilityPredicate(filteredScopes: string[]) {
  const sessionScopes = filteredScopes.filter((scope) => scope.startsWith('session:'));

  return or(
    // (1) main — classic scope match
    and(
      eq(schema.learnings.branchState, 'main'),
      inArray(schema.learnings.scope, filteredScopes),
    ),
    // (2) blessed — always visible, scope is metadata not filter
    eq(schema.learnings.branchState, 'blessed'),
    // (3) session — own-session-only, or false if no session asked for
    sessionScopes.length > 0
      ? and(
          eq(schema.learnings.branchState, 'session'),
          inArray(schema.learnings.scope, sessionScopes),
        )
      : sql`0`,
  );
}

function stripAntiPatternPrefix(text: string): string {
  return text.startsWith(ANTI_PATTERN_PREFIX) ? text.slice(ANTI_PATTERN_PREFIX.length) : text;
}

function buildEmbeddingText(trigger: string, learning: string): string {
  return `When ${trigger}, ${stripAntiPatternPrefix(learning)}`;
}

function clampConfidence(confidence: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, Math.round(confidence * 1000) / 1000));
}

function mergeIdentity(
  current: SharedRunIdentity | undefined,
  updates: SharedRunIdentity | undefined,
): SharedRunIdentity | undefined {
  const merged: SharedRunIdentity = {
    traceId: updates?.traceId ?? current?.traceId ?? null,
    workspaceId: updates?.workspaceId ?? current?.workspaceId ?? null,
    conversationId: updates?.conversationId ?? current?.conversationId ?? null,
    runId: updates?.runId ?? current?.runId ?? null,
    proofRunId: updates?.proofRunId ?? current?.proofRunId ?? null,
    proofIterationId: updates?.proofIterationId ?? current?.proofIterationId ?? null,
  };

  return Object.values(merged).some((value) => typeof value === 'string' && value.length > 0)
    ? merged
    : undefined;
}

function identitiesEqual(
  left: SharedRunIdentity | undefined,
  right: SharedRunIdentity | undefined,
): boolean {
  return (
    (left?.traceId ?? null) === (right?.traceId ?? null) &&
    (left?.workspaceId ?? null) === (right?.workspaceId ?? null) &&
    (left?.conversationId ?? null) === (right?.conversationId ?? null) &&
    (left?.runId ?? null) === (right?.runId ?? null) &&
    (left?.proofRunId ?? null) === (right?.proofRunId ?? null) &&
    (left?.proofIterationId ?? null) === (right?.proofIterationId ?? null)
  );
}

function learningIdentityFields(identity: SharedRunIdentity | undefined) {
  return {
    traceId: identity?.traceId ?? null,
    workspaceId: identity?.workspaceId ?? null,
    conversationId: identity?.conversationId ?? null,
    runId: identity?.runId ?? null,
    proofRunId: identity?.proofRunId ?? null,
    proofIterationId: identity?.proofIterationId ?? null,
  };
}

function buildVectorMetadata(learning: Learning): Record<string, string> {
  const metadata: Record<string, string> = {
    scope: learning.scope,
    trigger: learning.trigger,
    learning: learning.learning,
    type: learning.type,
  };

  if (learning.supersedes) metadata.supersedes = learning.supersedes;
  if (learning.source) metadata.source = learning.source;

  return metadata;
}

async function upsertLearningVector(
  ctx: MemoryOperationsContext,
  learning: Learning,
): Promise<void> {
  await ctx.env.VECTORIZE.insert([
    {
      id: learning.id,
      values: learning.embedding || [],
      metadata: buildVectorMetadata(learning),
    },
  ]);
}

/**
 * Poll VECTORIZE.query until the freshly-inserted id shows up in results,
 * or the overall budget runs out. Returns true on confirmation, false on
 * timeout. The caller decides whether to surface the synced state to
 * callers — we never throw here, because a timeout is not an error: the
 * write itself succeeded and will show up eventually.
 *
 * Poll schedule: 500ms, doubling to a 2s cap, until SYNC_MAX_WAIT_MS.
 */
async function waitForVectorIndex(
  ctx: MemoryOperationsContext,
  learningId: string,
  embedding: number[],
): Promise<boolean> {
  const deadline = Date.now() + SYNC_MAX_WAIT_MS;
  let interval = SYNC_INITIAL_INTERVAL_MS;

  while (Date.now() < deadline) {
    try {
      const result = await ctx.env.VECTORIZE.query(embedding, { topK: 1 });
      const matches: any[] = (result as any)?.matches ?? [];
      if (matches.some((match) => match?.id === learningId)) {
        return true;
      }
    } catch (err) {
      // Transient query errors during indexing are expected; keep polling.
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    const wait = Math.min(interval, remaining);
    await new Promise((resolve) => setTimeout(resolve, wait));
    interval = Math.min(SYNC_MAX_INTERVAL_MS, interval * 2);
  }

  return false;
}

async function getLearningRowById(db: any, id: string): Promise<any | null> {
  const rows = await db.select().from(schema.learnings).where(eq(schema.learnings.id, id)).limit(1);
  return rows[0] ?? null;
}

async function getNearestLearningMatches(
  ctx: MemoryOperationsContext,
  db: any,
  embedding: number[],
  scope: string,
): Promise<Array<{ row: any; similarity: number }>> {
  const vectorResults = await ctx.env.VECTORIZE.query(embedding, {
    topK: DEDUPE_QUERY_TOP_K,
    returnValues: true,
  });
  const ids = vectorResults.matches.map((match: any) => match.id);

  if (ids.length === 0) {
    return [];
  }

  const dbRows = await db
    .select()
    .from(schema.learnings)
    .where(and(inArray(schema.learnings.id, ids), eq(schema.learnings.scope, scope)));
  const rowById = new Map<string, any>(dbRows.map((row: any) => [row.id, row]));

  return vectorResults.matches
    .map((match: any) => {
      const row = rowById.get(match.id);
      if (!row) return null;
      return { row, similarity: match.score ?? 0 };
    })
    .filter((match: { row: any; similarity: number } | null): match is { row: any; similarity: number } => match !== null);
}

export async function cleanupLearnings(
  ctx: MemoryOperationsContext,
): Promise<{ deleted: number; reasons: string[] }> {
  const db = await ctx.initDB();
  const reasons: string[] = [];
  let deleted = 0;

  try {
    // Sweep 0 (runs first): expired session branches. The per-branch TTL
    // defaults to 24h in sessionBranch.ts; this is the tight window that
    // auto-cleans forgotten scratchpads. Blessed and discarded branches
    // are skipped inside gcExpiredSessionBranches().
    const branchGc = await gcExpiredSessionBranches({ initDB: () => Promise.resolve(db) });
    if (branchGc.deletedLearnings > 0) {
      deleted += branchGc.deletedLearnings;
      reasons.push(`${branchGc.deletedLearnings} expired session-branch entries from ${branchGc.expiredBranches} branches`);
      await ctx.env.VECTORIZE.deleteByIds(branchGc.deletedIds);
    }

    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    // NOTE: branch_state != 'blessed' is critical here. A blessed row keeps
    // its session:<id> scope (for provenance) but must survive the 7-day
    // sweep. Session-branch mode relies on this carve-out. The new
    // gcExpiredSessionBranches() sweep in session-branch.ts handles the
    // stricter 24h TTL for unblessed 'session' rows; this sweep remains as
    // a backstop for pre-branch-state session writes (branchState = 'main'
    // from before the column existed) and for any 'session'-state rows that
    // escaped the branch GC.
    const staleSessionEntries = await db
      .select()
      .from(schema.learnings)
      .where(
        and(
          like(schema.learnings.scope, 'session:%'),
          sql`${schema.learnings.createdAt} < ${weekAgo}`,
          sql`${schema.learnings.branchState} != 'blessed'`,
        ),
      );

    if (staleSessionEntries.length > 0) {
      deleted += staleSessionEntries.length;
      reasons.push(`${staleSessionEntries.length} stale session entries`);
      await db
        .delete(schema.learnings)
        .where(
          and(
            like(schema.learnings.scope, 'session:%'),
            sql`${schema.learnings.createdAt} < ${weekAgo}`,
            sql`${schema.learnings.branchState} != 'blessed'`,
          ),
        );
      await ctx.env.VECTORIZE.deleteByIds(staleSessionEntries.map((entry: any) => entry.id));
    }

    const monthAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const staleAgentEntries = await db
      .select()
      .from(schema.learnings)
      .where(
        and(
          like(schema.learnings.scope, 'agent:%'),
          sql`${schema.learnings.createdAt} < ${monthAgo}`,
        ),
      );

    if (staleAgentEntries.length > 0) {
      deleted += staleAgentEntries.length;
      reasons.push(`${staleAgentEntries.length} stale agent entries`);
      await db
        .delete(schema.learnings)
        .where(
          and(
            like(schema.learnings.scope, 'agent:%'),
            sql`${schema.learnings.createdAt} < ${monthAgo}`,
          ),
        );
      await ctx.env.VECTORIZE.deleteByIds(staleAgentEntries.map((entry: any) => entry.id));
    }

    const lowConfidenceEntries = await db
      .select()
      .from(schema.learnings)
      .where(sql`${schema.learnings.confidence} < 0.3`);

    if (lowConfidenceEntries.length > 0) {
      deleted += lowConfidenceEntries.length;
      reasons.push(`${lowConfidenceEntries.length} low confidence entries`);
      await db.delete(schema.learnings).where(sql`${schema.learnings.confidence} < 0.3`);
      await ctx.env.VECTORIZE.deleteByIds(lowConfidenceEntries.map((entry: any) => entry.id));
    }

    return { deleted, reasons };
  } catch (error) {
    console.error('Cleanup error:', error);
    return { deleted: 0, reasons: ['Cleanup failed with error'] };
  }
}

export async function injectMemories(
  ctx: MemoryOperationsContext,
  scopes: string[],
  context: string,
  limit: number = 5,
  format: 'prompt' | 'learnings' = 'prompt',
  _identity?: SharedRunIdentity,
): Promise<InjectResult> {
  const db = await ctx.initDB();
  const filteredScopes = ctx.filterScopesByPriority(scopes);
  if (filteredScopes.length === 0) {
    return { prompt: '', learnings: [] };
  }

  try {
    const embedding = await ctx.createEmbedding(context);
    const vectorResults = await ctx.env.VECTORIZE.query(embedding, {
      topK: limit * 2,
      returnValues: true,
    });
    const ids = vectorResults.matches.map((match: any) => match.id);

    if (ids.length === 0) {
      return { prompt: '', learnings: [] };
    }

    // buildBranchVisibilityPredicate owns both the scope match and the
    // branch_state rule. Do not AND a separate scope filter alongside it —
    // the predicate's 'blessed' branch is intentionally scope-agnostic.
    const dbLearnings = await db
      .select()
      .from(schema.learnings)
      .where(
        and(
          inArray(schema.learnings.id, ids),
          buildBranchVisibilityPredicate(filteredScopes),
        ),
      )
      .limit(limit);

    const learnings = dbLearnings.map((learning: any) => ctx.convertDbLearning(learning));
    const now = new Date().toISOString();
    const nowMs = Date.now();

    // Apply time-based confidence decay for ranking (read-side only, stored values unchanged)
    const HALF_LIFE_DAYS = 90;
    const rankedLearnings = [...learnings].sort((a: Learning, b: Learning) => {
      const aLastActive = a.lastRecalledAt ?? a.createdAt;
      const bLastActive = b.lastRecalledAt ?? b.createdAt;
      const aDays = (nowMs - new Date(aLastActive).getTime()) / 86400000;
      const bDays = (nowMs - new Date(bLastActive).getTime()) / 86400000;
      const aDecayed = (a.confidence ?? 1.0) * Math.pow(0.5, aDays / HALF_LIFE_DAYS);
      const bDecayed = (b.confidence ?? 1.0) * Math.pow(0.5, bDays / HALF_LIFE_DAYS);
      return bDecayed - aDecayed;
    });

    await Promise.all(
      rankedLearnings.map((learning: Learning) =>
        db
          .update(schema.learnings)
          .set({
            lastRecalledAt: now,
            recallCount: sql`COALESCE(${schema.learnings.recallCount}, 0) + 1`,
          })
          .where(eq(schema.learnings.id, learning.id)),
      ),
    );

    if (format === 'prompt') {
      return {
        prompt: rankedLearnings
          .map((learning: Learning) => `When ${learning.trigger}, ${learning.learning}`)
          .join('\n'),
        learnings: rankedLearnings,
      };
    }

    return { prompt: '', learnings: rankedLearnings };
  } catch (error) {
    console.error('Inject error:', error);
    return { prompt: '', learnings: [] };
  }
}

export async function injectMemoriesWithTrace(
  ctx: MemoryOperationsContext,
  scopes: string[],
  context: string,
  limit: number = 5,
  threshold: number = 0,
  _identity?: SharedRunIdentity,
): Promise<InjectTraceResult> {
  const startTime = Date.now();
  const db = await ctx.initDB();
  const filteredScopes = ctx.filterScopesByPriority(scopes);

  if (filteredScopes.length === 0) {
    return {
      input_context: context,
      embedding_generated: [],
      candidates: [],
      threshold_applied: threshold,
      injected: [],
      duration_ms: Date.now() - startTime,
      metadata: { total_candidates: 0, above_threshold: 0, below_threshold: 0 },
    };
  }

  try {
    const embedding = await ctx.createEmbedding(context);
    const vectorResults = await ctx.env.VECTORIZE.query(embedding, {
      topK: Math.max(limit * 3, 20),
      returnValues: true,
    });
    const scoreById = new Map<string, number>(
      vectorResults.matches.map((match: any) => [match.id, match.score ?? 0]),
    );
    const ids = vectorResults.matches.map((match: any) => match.id);

    if (ids.length === 0) {
      return {
        input_context: context,
        embedding_generated: embedding,
        candidates: [],
        threshold_applied: threshold,
        injected: [],
        duration_ms: Date.now() - startTime,
        metadata: { total_candidates: 0, above_threshold: 0, below_threshold: 0 },
      };
    }

    // buildBranchVisibilityPredicate owns scope + branch_state together.
    const dbLearnings = await db
      .select()
      .from(schema.learnings)
      .where(
        and(
          inArray(schema.learnings.id, ids),
          buildBranchVisibilityPredicate(filteredScopes),
        ),
      );

    const nowMs = Date.now();
    const candidates = dbLearnings.map((row: any) => {
      const learning = ctx.convertDbLearning(row);
      const similarity_score = scoreById.get(row.id) ?? 0;
      return {
        id: learning.id,
        trigger: learning.trigger,
        learning: learning.learning,
        similarity_score,
        passed_threshold: similarity_score >= threshold,
        // Metadata additions used by the lean-MCP `search` tool to let agents
        // triage hits without pulling the learning body. Cheap to compute,
        // safe for existing consumers (additive fields only).
        confidence: learning.confidence,
        scope: learning.scope,
        recall_count: learning.recallCount,
        created_at: learning.createdAt,
        last_recalled_at: learning.lastRecalledAt ?? null,
        anti_pattern: learning.type === 'anti-pattern',
        supersedes: learning.supersedes ?? null,
        suspect_score: computeSuspectScore(learning, nowMs),
        branch_state: learning.branchState,
      };
    });

    candidates.sort(
      (
        a: (typeof candidates)[number],
        b: (typeof candidates)[number],
      ) => b.similarity_score - a.similarity_score,
    );

    const injected = candidates
      .filter((candidate: (typeof candidates)[number]) => candidate.passed_threshold)
      .slice(0, limit)
      .map((candidate: (typeof candidates)[number]) => {
        const fullRow = dbLearnings.find((row: any) => row.id === candidate.id);
        return fullRow ? ctx.convertDbLearning(fullRow) : null;
      })
      .filter((learning: Learning | null): learning is Learning => learning !== null);

    const aboveThreshold = candidates.filter(
      (candidate: (typeof candidates)[number]) => candidate.passed_threshold,
    ).length;

    return {
      input_context: context,
      embedding_generated: embedding,
      candidates,
      threshold_applied: threshold,
      injected,
      duration_ms: Date.now() - startTime,
      metadata: {
        total_candidates: candidates.length,
        above_threshold: aboveThreshold,
        below_threshold: candidates.length - aboveThreshold,
      },
    };
  } catch (error) {
    console.error('InjectTrace error:', error);
    return {
      input_context: context,
      embedding_generated: [],
      candidates: [],
      threshold_applied: threshold,
      injected: [],
      duration_ms: Date.now() - startTime,
      metadata: { total_candidates: 0, above_threshold: 0, below_threshold: 0 },
    };
  }
}

export async function learnMemory(
  ctx: MemoryOperationsContext,
  scope: string,
  trigger: string,
  learning: string,
  confidence: number = 0.5,
  reason?: string,
  source?: string,
  identity?: SharedRunIdentity,
  opts?: { sync?: boolean },
): Promise<Learning & { synced?: boolean }> {
  const db = await ctx.initDB();
  const normalizedConfidence = clampConfidence(confidence);
  const embedding = await ctx.createEmbedding(buildEmbeddingText(trigger, learning));
  const nearestMatches = await getNearestLearningMatches(ctx, db, embedding, scope);
  const bestMatch = nearestMatches[0];

  if (bestMatch && bestMatch.similarity >= DEDUPE_THRESHOLD) {
    const existingLearning = ctx.convertDbLearning(bestMatch.row);
    const mergedIdentity = mergeIdentity(existingLearning.identity, identity);

    if (!identitiesEqual(existingLearning.identity, mergedIdentity)) {
      await db
        .update(schema.learnings)
        .set(learningIdentityFields(mergedIdentity))
        .where(eq(schema.learnings.id, existingLearning.id));
    }

    // Dedupe hit — no new vector was inserted, so there's nothing to wait
    // for. Report synced:true when the caller asked for sync so the
    // contract ("returned; safe to query") is honored.
    const result: Learning & { synced?: boolean } = {
      ...existingLearning,
      identity: mergedIdentity,
    };
    if (opts?.sync) result.synced = true;
    return result;
  }

  let supersedes: string | undefined;
  if (bestMatch && bestMatch.similarity >= CONFLICT_THRESHOLD) {
    supersedes = bestMatch.row.id;
    const nextConfidence = clampConfidence((bestMatch.row.confidence ?? CONFIDENCE_DEFAULT) * 0.3);
    await db
      .update(schema.learnings)
      .set({ confidence: nextConfidence })
      .where(eq(schema.learnings.id, bestMatch.row.id));
  }

  // A write to a 'session:<id>' scope is a scratchpad write — it goes to
  // the session's branch. All other scopes ('shared', 'agent:*', custom)
  // write directly to main. Blessing promotes 'session' → 'blessed' later.
  const branchState: Learning['branchState'] = scope.startsWith('session:') ? 'session' : 'main';

  const id = createLearningId();
  const newLearning: Learning = {
    id,
    trigger,
    learning,
    reason,
    confidence: normalizedConfidence,
    source,
    scope,
    supersedes,
    type: 'memory',
    branchState,
    embedding,
    createdAt: new Date().toISOString(),
    recallCount: 0,
    identity,
  };

  // Ensure the session_branches row exists before the learning lands, so
  // the branch's expiresAt is defined by the time the first write is live.
  // Non-session scopes skip this entirely.
  if (branchState === 'session') {
    const sessionId = scope.slice('session:'.length);
    if (sessionId.length > 0) {
      await ensureSessionBranch({ initDB: () => Promise.resolve(db) }, sessionId);
    }
  }

  await db.insert(schema.learnings).values({
    id: newLearning.id,
    trigger: newLearning.trigger,
    learning: newLearning.learning,
    reason: newLearning.reason,
    confidence: newLearning.confidence,
    source: newLearning.source,
    scope: newLearning.scope,
    supersedes: newLearning.supersedes ?? null,
    type: newLearning.type,
    branchState: newLearning.branchState,
    embedding: newLearning.embedding ? JSON.stringify(newLearning.embedding) : null,
    createdAt: newLearning.createdAt,
    ...learningIdentityFields(identity),
  });

  await upsertLearningVector(ctx, newLearning);

  if (opts?.sync) {
    const synced = await waitForVectorIndex(ctx, newLearning.id, embedding);
    return { ...newLearning, synced };
  }

  return newLearning;
}

export async function confirmMemory(
  ctx: MemoryOperationsContext,
  id: string,
  identity?: SharedRunIdentity,
): Promise<Learning | null> {
  const db = await ctx.initDB();
  const row = await getLearningRowById(db, id);

  if (!row) {
    return null;
  }

  const currentLearning = ctx.convertDbLearning(row);
  const mergedIdentity = mergeIdentity(currentLearning.identity, identity);
  const nextConfidence = clampConfidence(currentLearning.confidence + CONFIDENCE_CONFIRM_BOOST);

  await db
    .update(schema.learnings)
    .set({
      confidence: nextConfidence,
      ...learningIdentityFields(mergedIdentity),
    })
    .where(eq(schema.learnings.id, id));

  return {
    ...currentLearning,
    confidence: nextConfidence,
    identity: mergedIdentity,
  };
}

export async function rejectMemory(
  ctx: MemoryOperationsContext,
  id: string,
  identity?: SharedRunIdentity,
): Promise<Learning | null> {
  const db = await ctx.initDB();
  const row = await getLearningRowById(db, id);

  if (!row) {
    return null;
  }

  const currentLearning = ctx.convertDbLearning(row);
  const mergedIdentity = mergeIdentity(currentLearning.identity, identity);
  let nextLearning: Learning = {
    ...currentLearning,
    confidence: clampConfidence(currentLearning.confidence - CONFIDENCE_REJECT_DECAY),
    identity: mergedIdentity,
  };

  if (
    nextLearning.confidence < ANTI_PATTERN_THRESHOLD &&
    currentLearning.type !== 'anti-pattern'
  ) {
    const invertedLearning = `${ANTI_PATTERN_PREFIX}${stripAntiPatternPrefix(currentLearning.learning)}`;
    nextLearning = {
      ...nextLearning,
      learning: invertedLearning,
      confidence: CONFIDENCE_DEFAULT,
      type: 'anti-pattern',
      embedding: await ctx.createEmbedding(buildEmbeddingText(currentLearning.trigger, invertedLearning)),
    };
  } else {
    nextLearning = {
      ...nextLearning,
      embedding: currentLearning.embedding,
    };
  }

  await db
    .update(schema.learnings)
    .set({
      learning: nextLearning.learning,
      confidence: nextLearning.confidence,
      type: nextLearning.type,
      embedding: nextLearning.embedding ? JSON.stringify(nextLearning.embedding) : null,
      ...learningIdentityFields(mergedIdentity),
    })
    .where(eq(schema.learnings.id, id));

  if (nextLearning.type !== currentLearning.type || nextLearning.learning !== currentLearning.learning) {
    await upsertLearningVector(ctx, nextLearning);
  }

  return nextLearning;
}

export async function getLearningNeighbors(
  ctx: MemoryOperationsContext,
  id: string,
  threshold: number = 0.85,
  limit: number = 10,
): Promise<Array<Learning & { similarity_score: number }>> {
  const db = await ctx.initDB();
  const rows = await db.select().from(schema.learnings).where(eq(schema.learnings.id, id)).limit(1);
  if (rows.length === 0) return [];

  const embeddingJson = rows[0].embedding;
  if (!embeddingJson) return [];

  const vectorResults = await ctx.env.VECTORIZE.query(JSON.parse(embeddingJson), {
    topK: limit + 5,
    returnValues: true,
  });
  const neighborMatches = vectorResults.matches
    .filter((match: any) => match.id !== id && (match.score ?? 0) >= threshold)
    .slice(0, limit);

  if (neighborMatches.length === 0) return [];

  const ids = neighborMatches.map((match: any) => match.id);
  const scoreById = new Map(neighborMatches.map((match: any) => [match.id, match.score ?? 0]));
  const dbNeighbors = await db.select().from(schema.learnings).where(inArray(schema.learnings.id, ids));
  return dbNeighbors.map((neighbor: any) => ({
    ...ctx.convertDbLearning(neighbor),
    similarity_score: scoreById.get(neighbor.id) ?? 0,
  }));
}

export async function queryLearnings(
  ctx: MemoryOperationsContext,
  scopes: string[],
  text: string,
  limit: number = 10,
  _identity?: SharedRunIdentity,
): Promise<QueryResult> {
  const db = await ctx.initDB();
  const filteredScopes = ctx.filterScopesByPriority(scopes);
  if (filteredScopes.length === 0) {
    return { learnings: [], hits: {} };
  }

  try {
    const embedding = await ctx.createEmbedding(text);
    const vectorResults = await ctx.env.VECTORIZE.query(embedding, {
      topK: limit * 2,
      returnValues: true,
    });
    const matches = vectorResults.matches.map((match: any) => ({
      id: match.id,
      score: match.score ?? 0,
    }));
    const ids = matches.map((match: any) => match.id);

    if (ids.length === 0) {
      return { learnings: [], hits: {} };
    }

    // buildBranchVisibilityPredicate owns scope + branch_state together.
    const dbLearnings = await db
      .select()
      .from(schema.learnings)
      .where(
        and(
          inArray(schema.learnings.id, ids),
          buildBranchVisibilityPredicate(filteredScopes),
        ),
      )
      .limit(limit);

    const learnings = dbLearnings.map((learning: any) => ctx.convertDbLearning(learning));
    const sortedLearnings = learnings.sort((left: Learning, right: Learning) => {
      const leftScore = matches.find((match: any) => match.id === left.id)?.score || 0;
      const rightScore = matches.find((match: any) => match.id === right.id)?.score || 0;
      return rightScore - leftScore;
    });

    const hits: Record<string, number> = {};
    sortedLearnings.forEach((learning: Learning) => {
      hits[learning.scope] = (hits[learning.scope] || 0) + 1;
    });

    return { learnings: sortedLearnings, hits };
  } catch (error) {
    console.error('Query error:', error);
    return { learnings: [], hits: {} };
  }
}

export async function listLearnings(
  ctx: MemoryOperationsContext,
  filter?: { scope?: string; limit?: number },
): Promise<Learning[]> {
  const db = await ctx.initDB();

  try {
    let query: any = db.select().from(schema.learnings);

    if (filter?.scope) {
      query = query.where(eq(schema.learnings.scope, filter.scope));
    }

    if (filter?.limit) {
      query = query.limit(filter.limit);
    }

    const results = await query.orderBy(desc(schema.learnings.createdAt));
    return results.map((result: any) => ctx.convertDbLearning(result));
  } catch (error) {
    console.error('Get learnings error:', error);
    return [];
  }
}

export async function deleteLearningById(
  ctx: MemoryOperationsContext,
  id: string,
): Promise<{ success: boolean; error?: string }> {
  const db = await ctx.initDB();

  try {
    await db.delete(schema.learnings).where(eq(schema.learnings.id, id));
    await ctx.env.VECTORIZE.deleteByIds([id]);
    return { success: true };
  } catch (error) {
    console.error('Delete learning error:', error);
    return { success: false, error: 'Failed to delete learning' };
  }
}

export async function deleteLearningsByFilter(
  ctx: MemoryOperationsContext,
  filters: { confidence_lt?: number; not_recalled_in_days?: number; scope?: string },
): Promise<{ deleted: number; ids: string[] }> {
  const db = await ctx.initDB();
  const conditions: any[] = [];

  if (filters.confidence_lt != null) {
    conditions.push(sql`${schema.learnings.confidence} < ${filters.confidence_lt}`);
  }
  if (filters.not_recalled_in_days != null) {
    const cutoff = new Date(
      Date.now() - filters.not_recalled_in_days * 24 * 60 * 60 * 1000,
    ).toISOString();
    conditions.push(
      sql`COALESCE(${schema.learnings.lastRecalledAt}, ${schema.learnings.createdAt}) < ${cutoff}`,
    );
  }
  if (filters.scope != null) {
    conditions.push(eq(schema.learnings.scope, filters.scope));
  }

  if (conditions.length === 0) {
    return { deleted: 0, ids: [] };
  }

  const whereClause = conditions.length === 1 ? conditions[0] : and(...conditions);
  const toDelete = await db
    .select({ id: schema.learnings.id })
    .from(schema.learnings)
    .where(whereClause);
  const ids = toDelete.map((row: any) => row.id);
  if (ids.length === 0) {
    return { deleted: 0, ids: [] };
  }

  await db.delete(schema.learnings).where(whereClause);
  await ctx.env.VECTORIZE.deleteByIds(ids);
  return { deleted: ids.length, ids };
}
