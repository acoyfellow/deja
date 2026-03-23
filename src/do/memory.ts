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
): Promise<Learning> {
  const db = await ctx.initDB();
  const id = createLearningId();
  const embedding = await ctx.createEmbedding(`When ${trigger}, ${learning}`);
  const newLearning: Learning = {
    id,
    trigger,
    learning,
    reason,
    confidence,
    source,
    scope,
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
    embedding: newLearning.embedding ? JSON.stringify(newLearning.embedding) : null,
    createdAt: newLearning.createdAt,
    traceId: identity?.traceId ?? null,
    workspaceId: identity?.workspaceId ?? null,
    conversationId: identity?.conversationId ?? null,
    runId: identity?.runId ?? null,
    proofRunId: identity?.proofRunId ?? null,
    proofIterationId: identity?.proofIterationId ?? null,
  });

  await ctx.env.VECTORIZE.insert([
    {
      id: newLearning.id,
      values: newLearning.embedding || [],
      metadata: {
        scope: newLearning.scope,
        trigger: newLearning.trigger,
        learning: newLearning.learning,
      },
    },
  ]);

  return newLearning;
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
