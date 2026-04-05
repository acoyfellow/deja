import { eq } from 'drizzle-orm';

import * as schema from '../schema';
import type {
  ResolveStateOptions,
  SharedRunIdentity,
  WorkingStateOperationsContext,
  WorkingStatePayload,
  WorkingStateResponse,
} from './types';

export async function getStateByRunId(
  ctx: WorkingStateOperationsContext,
  runId: string,
): Promise<WorkingStateResponse | null> {
  const db = await ctx.initDB();
  const rows = await db
    .select()
    .from(schema.stateRuns)
    .where(eq(schema.stateRuns.runId, runId))
    .limit(1);

  if (!rows.length) {
    return null;
  }

  const current = rows[0] as any;
  return {
    runId: current.runId,
    revision: current.revision,
    status: current.status,
    state: JSON.parse(current.stateJson || '{}'),
    updatedBy: current.updatedBy ?? undefined,
    createdAt: current.createdAt,
    updatedAt: current.updatedAt,
    resolvedAt: current.resolvedAt ?? undefined,
    identity: ctx.normalizeRunIdentityPayload(current),
  };
}

export async function upsertWorkingState(
  ctx: WorkingStateOperationsContext,
  runId: string,
  payload: WorkingStatePayload,
  updatedBy?: string,
  changeSummary: string = 'state upsert',
  identity?: SharedRunIdentity,
): Promise<WorkingStateResponse> {
  const db = await ctx.initDB();
  const now = new Date().toISOString();
  const normalized = ctx.normalizeWorkingStatePayload(payload);
  const existing = await getStateByRunId(ctx, runId);
  const nextRevision = (existing?.revision ?? 0) + 1;
  const stateJson = JSON.stringify(normalized);
  const nextIdentity = identity ?? existing?.identity;

  if (existing) {
    await db
      .update(schema.stateRuns)
      .set({
        revision: nextRevision,
        stateJson,
        status: existing.status,
        updatedBy,
        traceId: nextIdentity?.traceId ?? null,
        workspaceId: nextIdentity?.workspaceId ?? null,
        conversationId: nextIdentity?.conversationId ?? null,
        proofRunId: nextIdentity?.proofRunId ?? null,
        proofIterationId: nextIdentity?.proofIterationId ?? null,
        updatedAt: now,
      })
      .where(eq(schema.stateRuns.runId, runId));
  } else {
    await db.insert(schema.stateRuns).values({
      runId,
      revision: nextRevision,
      stateJson,
      status: 'active',
      updatedBy,
      traceId: nextIdentity?.traceId ?? null,
      workspaceId: nextIdentity?.workspaceId ?? null,
      conversationId: nextIdentity?.conversationId ?? null,
      proofRunId: nextIdentity?.proofRunId ?? null,
      proofIterationId: nextIdentity?.proofIterationId ?? null,
      createdAt: now,
      updatedAt: now,
      resolvedAt: null,
    } as any);
  }

  await db.insert(schema.stateRevisions).values({
    id: crypto.randomUUID(),
    runId,
    revision: nextRevision,
    stateJson,
    changeSummary,
    updatedBy,
    traceId: nextIdentity?.traceId ?? null,
    workspaceId: nextIdentity?.workspaceId ?? null,
    conversationId: nextIdentity?.conversationId ?? null,
    proofRunId: nextIdentity?.proofRunId ?? null,
    proofIterationId: nextIdentity?.proofIterationId ?? null,
    createdAt: now,
  } as any);

  return (await getStateByRunId(ctx, runId)) as WorkingStateResponse;
}

export async function patchWorkingState(
  ctx: WorkingStateOperationsContext,
  runId: string,
  patch: any,
  updatedBy?: string,
  identity?: SharedRunIdentity,
): Promise<WorkingStateResponse> {
  const current = (await getStateByRunId(ctx, runId)) ?? {
    runId,
    revision: 0,
    status: 'active',
    state: {},
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
  const next = {
    ...current.state,
    ...ctx.normalizeWorkingStatePayload({ ...current.state, ...patch }),
  };
  return upsertWorkingState(ctx, runId, next, updatedBy, 'state patch', identity ?? current.identity);
}

export async function addWorkingStateEvent(
  ctx: WorkingStateOperationsContext,
  runId: string,
  eventType: string,
  payload: Record<string, unknown>,
  createdBy?: string,
  identity?: SharedRunIdentity,
): Promise<{ success: true; id: string }> {
  const db = await ctx.initDB();
  const now = new Date().toISOString();
  const id = crypto.randomUUID();

  await db.insert(schema.stateEvents).values({
    id,
    runId,
    eventType,
    payloadJson: JSON.stringify(payload ?? {}),
    createdBy,
    traceId: identity?.traceId ?? null,
    workspaceId: identity?.workspaceId ?? null,
    conversationId: identity?.conversationId ?? null,
    proofRunId: identity?.proofRunId ?? null,
    proofIterationId: identity?.proofIterationId ?? null,
    createdAt: now,
  } as any);

  return { success: true, id };
}

export async function resolveWorkingState(
  ctx: WorkingStateOperationsContext,
  runId: string,
  opts: ResolveStateOptions = {},
): Promise<WorkingStateResponse | null> {
  const db = await ctx.initDB();
  const current = await getStateByRunId(ctx, runId);
  if (!current) {
    return null;
  }

  const now = new Date().toISOString();
  await db
    .update(schema.stateRuns)
    .set({
      status: 'resolved',
      updatedBy: opts.updatedBy,
      updatedAt: now,
      resolvedAt: now,
    })
    .where(eq(schema.stateRuns.runId, runId));

  if (opts.persistToLearn) {
    const compact = [
      current.state.goal ? `Goal: ${current.state.goal}` : '',
      current.state.decisions?.length
        ? `Decisions: ${current.state.decisions.map((decision) => decision.text).join('; ')}`
        : '',
      current.state.next_actions?.length
        ? `Next actions: ${current.state.next_actions.join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' | ');

    if (compact) {
      await ctx.learn(
        opts.scope || 'shared',
        `run:${runId} resolved`,
        compact,
        typeof current.state.confidence === 'number' ? current.state.confidence : 0.8,
        'Derived from working state resolve',
        `state:${runId}`,
        undefined,
        opts.identity,
      );
    }
  }

  return getStateByRunId(ctx, runId);
}
