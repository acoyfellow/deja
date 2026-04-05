import { and, desc, eq, inArray, like, sql } from 'drizzle-orm';

import * as schema from '../schema';
import { createLearningId } from './helpers';
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

function stripAntiPatternPrefix(text: string): string {
  return text.startsWith(ANTI_PATTERN_PREFIX) ? text.slice(ANTI_PATTERN_PREFIX.length) : text;
}

function buildEmbeddingText(trigger: string, learning: string): string {
  return `When ${trigger}, ${stripAntiPatternPrefix(learning)}`;
}

function clampConfidence(confidence: number): number {
  return Math.min(CONFIDENCE_MAX, Math.max(CONFIDENCE_MIN, Math.round(confidence * 1000) / 1000));
}

function appendDistinctValue(current: string | undefined, incoming: string | undefined): string | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  const existingValues = current
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (existingValues.includes(incoming)) {
    return current;
  }
  return `${current}\n${incoming}`;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function buildLearningPayload(learning: Learning, tier: 'trigger' | 'full'): Learning {
  return {
    ...learning,
    tier,
    learning: tier === 'full' ? learning.learning : '',
    reason: tier === 'full' ? learning.reason : undefined,
    source: tier === 'full' ? learning.source : undefined,
  };
}

function applyInjectBudget(
  learnings: Learning[],
  maxTokens?: number,
): Learning[] {
  if (!maxTokens || maxTokens <= 0) {
    return learnings.map((learning) => buildLearningPayload(learning, 'full'));
  }

  const triggerBudget = Math.floor(maxTokens * 0.3);
  const triggerTier: Learning[] = [];
  let triggerTokensUsed = 0;

  for (const learning of learnings) {
    const triggerTokens = estimateTokens(learning.trigger);
    if (triggerTier.length > 0 && triggerTokensUsed + triggerTokens > triggerBudget) {
      break;
    }
    triggerTier.push(buildLearningPayload(learning, 'trigger'));
    triggerTokensUsed += triggerTokens;
  }

  const resultById = new Map<string, Learning>(triggerTier.map((learning) => [learning.id, learning]));
  let remainingTokens = maxTokens - triggerTokensUsed;

  for (const learning of learnings) {
    if (!resultById.has(learning.id)) {
      continue;
    }
    const fullText = [learning.trigger, learning.learning, learning.reason, learning.source]
      .filter((value): value is string => typeof value === 'string' && value.length > 0)
      .join('\n');
    const fullTokens = estimateTokens(fullText);
    const triggerTokens = estimateTokens(learning.trigger);
    const expansionCost = Math.max(fullTokens - triggerTokens, 0);
    if (expansionCost > remainingTokens) {
      continue;
    }
    resultById.set(learning.id, buildLearningPayload(learning, 'full'));
    remainingTokens -= expansionCost;
  }

  return learnings
    .filter((learning) => resultById.has(learning.id))
    .map((learning) => resultById.get(learning.id) as Learning);
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

function buildFtsQuery(text: string): string {
  const keywords = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 1);
  return keywords.map((keyword) => `"${keyword}"`).join(' OR ');
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

async function queryHostedTextSearch(
  sqlDb: DurableObjectState['storage']['sql'] | undefined,
  scopes: string[],
  context: string,
  limit: number,
): Promise<any[]> {
  if (!sqlDb) {
    return [];
  }
  const ftsQuery = buildFtsQuery(context);
  if (!ftsQuery) {
    return [];
  }

  return [
    ...sqlDb.exec<any>(
      `SELECT l.*
       FROM learnings_fts
       JOIN learnings l ON l.rowid = learnings_fts.rowid
       WHERE learnings_fts MATCH ?
         AND l.scope IN (${scopes.map(() => '?').join(', ')})
       ORDER BY bm25(learnings_fts)
       LIMIT ?`,
      ftsQuery,
      ...scopes,
      limit,
    ),
  ];
}

async function loadRankedLearnings(
  ctx: MemoryOperationsContext,
  db: any,
  ids: string[],
  scopes: string[],
): Promise<Learning[]> {
  if (ids.length === 0) {
    return [];
  }

  const rows = await db
    .select()
    .from(schema.learnings)
    .where(
      and(
        inArray(schema.learnings.id, ids),
        inArray(schema.learnings.scope, scopes),
      ),
    );
  const rowById = new Map<string, any>(rows.map((row: any) => [row.id, row]));
  return ids
    .map((id) => rowById.get(id))
    .filter((row: any | undefined): row is any => row !== undefined)
    .map((row: any) => ctx.convertDbLearning(rowById.get(row.id) ?? row));
}

export async function cleanupLearnings(
  ctx: MemoryOperationsContext,
): Promise<{ deleted: number; reasons: string[] }> {
  const db = await ctx.initDB();
  const reasons: string[] = [];
  let deleted = 0;

  try {
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const staleSessionEntries = await db
      .select()
      .from(schema.learnings)
      .where(
        and(
          like(schema.learnings.scope, 'session:%'),
          sql`${schema.learnings.createdAt} < ${weekAgo}`,
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
  search: 'vector' | 'text' | 'hybrid' = 'hybrid',
  _identity?: SharedRunIdentity,
  maxTokens?: number,
): Promise<InjectResult> {
  const db = await ctx.initDB();
  const filteredScopes = ctx.filterScopesByPriority(scopes);
  if (filteredScopes.length === 0) {
    return { prompt: '', learnings: [] };
  }

  try {
    const ids: string[] = [];
    const seen = new Set<string>();

    if (search === 'vector' || search === 'hybrid') {
      const embedding = await ctx.createEmbedding(context);
      const vectorResults = await ctx.env.VECTORIZE.query(embedding, {
        topK: limit * 2,
        returnValues: true,
      });
      for (const match of vectorResults.matches) {
        if (seen.has(match.id)) continue;
        seen.add(match.id);
        ids.push(match.id);
      }
    }

    if (search === 'text' || search === 'hybrid') {
      const textRows = await queryHostedTextSearch(ctx.sql, filteredScopes, context, limit * 2);
      for (const row of textRows) {
        if (seen.has(row.id)) continue;
        seen.add(row.id);
        ids.push(row.id);
      }
    }

    if (ids.length === 0) {
      return { prompt: '', learnings: [] };
    }

    const rankedLearnings = (await loadRankedLearnings(ctx, db, ids, filteredScopes)).slice(0, limit);
    const injectedLearnings = applyInjectBudget(rankedLearnings, maxTokens);
    const now = new Date().toISOString();

    await Promise.all(
      injectedLearnings.map((learning: Learning) =>
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
        prompt: injectedLearnings
          .map((learning: Learning) =>
            learning.tier === 'trigger'
              ? learning.trigger
              : `When ${learning.trigger}, ${learning.learning}`,
          )
          .join('\n'),
        learnings: injectedLearnings,
      };
    }

    return { prompt: '', learnings: injectedLearnings };
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

    const dbLearnings = await db
      .select()
      .from(schema.learnings)
      .where(
        and(
          inArray(schema.learnings.id, ids),
          inArray(schema.learnings.scope, filteredScopes),
        ),
      );

    const candidates = dbLearnings.map((row: any) => {
      const learning = ctx.convertDbLearning(row);
      const similarity_score = scoreById.get(row.id) ?? 0;
      return {
        id: learning.id,
        trigger: learning.trigger,
        learning: learning.learning,
        similarity_score,
        passed_threshold: similarity_score >= threshold,
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
  noveltyThreshold: number = DEDUPE_THRESHOLD,
): Promise<Learning> {
  const db = await ctx.initDB();
  const normalizedConfidence = clampConfidence(confidence);
  const embedding = await ctx.createEmbedding(buildEmbeddingText(trigger, learning));
  const nearestMatches = await getNearestLearningMatches(ctx, db, embedding, scope);
  const bestMatch = nearestMatches[0];

  if (noveltyThreshold > 0 && bestMatch && bestMatch.similarity >= noveltyThreshold) {
    const existingLearning = ctx.convertDbLearning(bestMatch.row);
    const mergedIdentity = mergeIdentity(existingLearning.identity, identity);
    const keepIncomingVersion = normalizedConfidence > existingLearning.confidence;
    const nextTrigger = keepIncomingVersion ? trigger : existingLearning.trigger;
    const nextLearningText = keepIncomingVersion ? learning : existingLearning.learning;
    const nextConfidence = Math.max(existingLearning.confidence, normalizedConfidence);
    const nextReason = appendDistinctValue(existingLearning.reason, reason);
    const nextSource = appendDistinctValue(existingLearning.source, source);
    const nextCreatedAt = new Date().toISOString();
    const nextEmbedding = keepIncomingVersion
      ? embedding
      : existingLearning.embedding ??
        (bestMatch.row.embedding ? JSON.parse(bestMatch.row.embedding) : undefined);

    await db
      .update(schema.learnings)
      .set({
        trigger: nextTrigger,
        learning: nextLearningText,
        confidence: nextConfidence,
        reason: nextReason ?? null,
        source: nextSource ?? null,
        createdAt: nextCreatedAt,
        embedding: nextEmbedding ? JSON.stringify(nextEmbedding) : null,
        ...learningIdentityFields(mergedIdentity),
      })
      .where(eq(schema.learnings.id, existingLearning.id));

    await upsertLearningVector(ctx, {
      ...existingLearning,
      trigger: nextTrigger,
      learning: nextLearningText,
      confidence: nextConfidence,
      reason: nextReason,
      source: nextSource,
      createdAt: nextCreatedAt,
      identity: mergedIdentity,
      embedding: nextEmbedding,
    });

    return {
      ...existingLearning,
      trigger: nextTrigger,
      learning: nextLearningText,
      confidence: nextConfidence,
      reason: nextReason,
      source: nextSource,
      createdAt: nextCreatedAt,
      embedding: nextEmbedding,
      identity: mergedIdentity,
    };
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
    embedding,
    createdAt: new Date().toISOString(),
    recallCount: 0,
    identity,
  };

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
    embedding: newLearning.embedding ? JSON.stringify(newLearning.embedding) : null,
    createdAt: newLearning.createdAt,
    ...learningIdentityFields(identity),
  });

  await upsertLearningVector(ctx, newLearning);

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

    const dbLearnings = await db
      .select()
      .from(schema.learnings)
      .where(
        and(
          inArray(schema.learnings.id, ids),
          inArray(schema.learnings.scope, filteredScopes),
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
