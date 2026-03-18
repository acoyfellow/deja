import { desc, eq } from 'drizzle-orm';

import * as schema from '../schema';
import type { LoopRun, LoopRunsOperationsContext, RecordRunPayload, RunsQueryResult, RunTrend } from './types';

function createRunId(): string {
  return `run-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;
}

export async function recordLoopRun(
  ctx: LoopRunsOperationsContext,
  payload: RecordRunPayload,
): Promise<LoopRun> {
  const db = await ctx.initDB();
  const id = createRunId();
  const scope = payload.scope || 'shared';
  const now = new Date().toISOString();

  await db.insert(schema.loopRuns).values({
    id,
    scope,
    outcome: payload.outcome,
    attempts: payload.attempts,
    code: payload.code ?? null,
    error: payload.error ?? null,
    createdAt: now,
  });

  const codeSnippet = payload.code ? payload.code.slice(0, 500) : '';
  const summary =
    payload.outcome === 'pass'
      ? `passed in ${payload.attempts} attempt${payload.attempts === 1 ? '' : 's'}${codeSnippet ? `: ${codeSnippet}` : ''}`
      : `${payload.outcome} after ${payload.attempts} attempt${payload.attempts === 1 ? '' : 's'}${payload.error ? `: ${payload.error.slice(0, 200)}` : ''}`;

  const confidence =
    payload.outcome === 'pass' ? Math.max(0.5, 1.0 - (payload.attempts - 1) * 0.1) : 0.6;

  ctx
    .learn(scope, `loop run: ${scope}`, summary, confidence, undefined, `loop_run:${id}`)
    .catch(() => {});

  return {
    id,
    scope,
    outcome: payload.outcome,
    attempts: payload.attempts,
    code: payload.code,
    error: payload.error,
    createdAt: now,
  };
}

export async function queryLoopRuns(
  ctx: LoopRunsOperationsContext,
  scope?: string,
  limit: number = 50,
): Promise<RunsQueryResult> {
  const db = await ctx.initDB();

  const rows: any[] = scope
    ? await db
        .select()
        .from(schema.loopRuns)
        .where(eq(schema.loopRuns.scope, scope))
        .orderBy(desc(schema.loopRuns.createdAt))
        .limit(limit)
    : await db
        .select()
        .from(schema.loopRuns)
        .orderBy(desc(schema.loopRuns.createdAt))
        .limit(limit);

  const runs: LoopRun[] = rows.map((r) => ({
    id: r.id,
    scope: r.scope,
    outcome: r.outcome as LoopRun['outcome'],
    attempts: r.attempts,
    code: r.code ?? undefined,
    error: r.error ?? undefined,
    createdAt: r.createdAt,
  }));

  const total = runs.length;
  const pass = runs.filter((r) => r.outcome === 'pass').length;
  const fail = runs.filter((r) => r.outcome === 'fail').length;
  const exhausted = runs.filter((r) => r.outcome === 'exhausted').length;
  const mean_attempts = total > 0 ? runs.reduce((s, r) => s + r.attempts, 0) / total : 0;
  const best_attempts = total > 0 ? Math.min(...runs.map((r) => r.attempts)) : 0;

  let trend: RunTrend = 'insufficient_data';
  if (total >= 4) {
    const mid = Math.floor(total / 2);
    // rows are ordered DESC (newest first), so slice(0, mid) = newer, slice(mid) = older
    const newer = runs.slice(0, mid);
    const older = runs.slice(mid);
    const olderMean = older.reduce((s, r) => s + r.attempts, 0) / older.length;
    const newerMean = newer.reduce((s, r) => s + r.attempts, 0) / newer.length;
    const delta = (olderMean - newerMean) / olderMean; // positive = fewer attempts now = improving
    if (delta > 0.1) trend = 'improving';
    else if (delta < -0.1) trend = 'regressing';
    else trend = 'stable';
  }

  return { runs, stats: { total, pass, fail, exhausted, mean_attempts, best_attempts, trend } };
}
