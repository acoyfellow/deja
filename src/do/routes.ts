import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { formatStatePrompt, resolveRunIdentityPayload } from './helpers';
import type {
  Env,
  InjectTraceResult,
  Learning,
  LoopRun,
  QueryResult,
  RecordRunPayload,
  ResolveStateOptions,
  RunsQueryResult,
  Secret,
  SharedRunIdentity,
  Stats,
  WorkingStatePayload,
  WorkingStateResponse,
} from './types';

interface RouteHandlers {
  cleanup(): Promise<{ deleted: number; reasons: string[] }>;
  learn(
    scope: string,
    trigger: string,
    learning: string,
    confidence?: number,
    reason?: string,
    source?: string,
    assets?: Array<{ type: string; ref: string; label?: string }>,
    identity?: SharedRunIdentity,
    noveltyThreshold?: number,
  ): Promise<Learning>;
  confirm(id: string, identity?: SharedRunIdentity): Promise<Learning | null>;
  reject(id: string, identity?: SharedRunIdentity): Promise<Learning | null>;
  query(scopes: string[], text: string, limit?: number, identity?: SharedRunIdentity): Promise<QueryResult>;
  inject(
    scopes: string[],
    context: string,
    limit?: number,
    format?: 'prompt' | 'learnings',
    search?: 'vector' | 'text' | 'hybrid',
    identity?: SharedRunIdentity,
    maxTokens?: number,
  ): Promise<{ prompt: string; learnings: Learning[]; state?: WorkingStateResponse }>;
  injectTrace(
    scopes: string[],
    context: string,
    limit?: number,
    threshold?: number,
    identity?: SharedRunIdentity,
  ): Promise<InjectTraceResult>;
  getStats(): Promise<Stats>;
  getState(runId: string): Promise<WorkingStateResponse | null>;
  upsertState(
    runId: string,
    payload: WorkingStatePayload,
    updatedBy?: string,
    changeSummary?: string,
    identity?: SharedRunIdentity,
  ): Promise<WorkingStateResponse>;
  patchState(runId: string, patch: any, updatedBy?: string, identity?: SharedRunIdentity): Promise<WorkingStateResponse>;
  addStateEvent(
    runId: string,
    eventType: string,
    payload: Record<string, unknown>,
    createdBy?: string,
    identity?: SharedRunIdentity,
  ): Promise<{ success: true; id: string }>;
  resolveState(runId: string, opts?: ResolveStateOptions): Promise<WorkingStateResponse | null>;
  getLearnings(filter?: { scope?: string; limit?: number }): Promise<Learning[]>;
  deleteLearnings(filters: {
    confidence_lt?: number;
    not_recalled_in_days?: number;
    scope?: string;
  }): Promise<{ deleted: number; ids: string[] }>;
  deleteLearning(id: string): Promise<{ success: boolean; error?: string }>;
  getLearningNeighbors(
    id: string,
    threshold?: number,
    limit?: number,
  ): Promise<Array<Learning & { similarity_score: number }>>;
  setSecret(scope: string, name: string, value: string): Promise<{ success: boolean; error?: string }>;
  getSecret(scopes: string[], name: string): Promise<string | null>;
  deleteSecret(scope: string, name: string): Promise<{ success: boolean; error?: string }>;
  listSecrets(scope?: string): Promise<Secret[]>;
  recordRun(payload: RecordRunPayload): Promise<LoopRun>;
  getRuns(scope?: string, limit?: number): Promise<RunsQueryResult>;
}

export function createDejaApp(handlers: RouteHandlers): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.use('*', cors());

  app.get('/', (c) => c.json({ status: 'ok', service: 'deja' }));

  app.post('/learn', async (c) => {
    const body: any = await c.req.json();
    const identity = resolveRunIdentityPayload(body);
    const result = await handlers.learn(
      body.scope || 'shared',
      body.trigger,
      body.learning,
      body.confidence,
      body.reason,
      body.source,
      body.assets,
      identity,
      body.noveltyThreshold,
    );
    return c.json(result);
  });

  app.post('/learning/:id/confirm', async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const result = await handlers.confirm(c.req.param('id'), resolveRunIdentityPayload(body));
    if (!result) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(result);
  });

  app.post('/learning/:id/reject', async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const result = await handlers.reject(c.req.param('id'), resolveRunIdentityPayload(body));
    if (!result) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(result);
  });

  app.post('/query', async (c) => {
    const body: any = await c.req.json();
    return c.json(
      await handlers.query(
        body.scopes || ['shared'],
        body.text,
        body.limit,
        resolveRunIdentityPayload(body),
      ),
    );
  });

  app.post('/inject', async (c) => {
    const body: any = await c.req.json();
    const result = await handlers.inject(
      body.scopes || ['shared'],
      body.context,
      body.limit,
      body.format,
      body.search,
      resolveRunIdentityPayload(body),
      body.maxTokens,
    );

    const stateRunId =
      typeof body.runId === 'string' && body.runId.trim()
        ? body.runId.trim()
        : typeof body.identity?.proofRunId === 'string' && body.identity.proofRunId.trim()
          ? body.identity.proofRunId.trim()
          : typeof body.identity?.runId === 'string' && body.identity.runId.trim()
            ? body.identity.runId.trim()
            : '';

    if (body.includeState && stateRunId) {
      const state = await handlers.getState(stateRunId);
      if (state) {
        const statePrompt = formatStatePrompt(state);
        if (result.prompt) {
          result.prompt = `${statePrompt}\n\n${result.prompt}`;
        } else if ((body.format || 'prompt') === 'prompt') {
          result.prompt = statePrompt;
        }
        result.state = state;
      }
    }

    return c.json(result);
  });

  app.post('/inject/trace', async (c) => {
    const body: any = await c.req.json().catch(() => ({}));
    const thresholdParam = c.req.query('threshold');
    const threshold =
      typeof body.threshold === 'number'
        ? body.threshold
        : thresholdParam !== undefined
          ? parseFloat(thresholdParam)
          : 0;
    return c.json(
      await handlers.injectTrace(
        body.scopes || ['shared'],
        body.context || '',
        body.limit ?? 5,
        Number.isFinite(threshold) ? threshold : 0,
        resolveRunIdentityPayload(body),
      ),
    );
  });

  app.get('/stats', async (c) => c.json(await handlers.getStats()));

  app.get('/state/:runId', async (c) => {
    const state = await handlers.getState(c.req.param('runId'));
    if (!state) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(state);
  });

  app.put('/state/:runId', async (c) => {
    const body: any = await c.req.json();
    return c.json(
      await handlers.upsertState(
        c.req.param('runId'),
        body,
        body.updatedBy,
        body.changeSummary || 'state put',
        resolveRunIdentityPayload(body),
      ),
    );
  });

  app.patch('/state/:runId', async (c) => {
    const body: any = await c.req.json();
    return c.json(
      await handlers.patchState(
        c.req.param('runId'),
        body,
        body.updatedBy,
        resolveRunIdentityPayload(body),
      ),
    );
  });

  app.post('/state/:runId/events', async (c) => {
    const body: any = await c.req.json();
    return c.json(
      await handlers.addStateEvent(
        c.req.param('runId'),
        body.eventType || 'note',
        body.payload || body,
        body.createdBy,
        resolveRunIdentityPayload(body),
      ),
    );
  });

  app.post('/state/:runId/resolve', async (c) => {
    const body: any = await c.req.json();
    const result = await handlers.resolveState(c.req.param('runId'), {
      persistToLearn: Boolean(body.persistToLearn),
      scope: body.scope,
      summaryStyle: body.summaryStyle,
      updatedBy: body.updatedBy,
      identity: resolveRunIdentityPayload(body),
    });
    if (!result) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json(result);
  });

  app.get('/learnings', async (c) => {
    const scope = c.req.query('scope');
    const limit = c.req.query('limit');
    return c.json(
      await handlers.getLearnings({
        scope,
        limit: limit ? parseInt(limit, 10) : undefined,
      }),
    );
  });

  app.delete('/learnings', async (c) => {
    const confidenceLt = c.req.query('confidence_lt');
    const notRecalledInDays = c.req.query('not_recalled_in_days');
    const scope = c.req.query('scope');
    const filters: { confidence_lt?: number; not_recalled_in_days?: number; scope?: string } = {};

    if (confidenceLt != null) {
      const parsed = parseFloat(confidenceLt);
      if (Number.isFinite(parsed)) {
        filters.confidence_lt = parsed;
      }
    }
    if (notRecalledInDays != null) {
      const parsed = parseInt(notRecalledInDays, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        filters.not_recalled_in_days = parsed;
      }
    }
    if (scope != null && scope.trim()) {
      filters.scope = scope.trim();
    }

    if (Object.keys(filters).length === 0) {
      return c.json(
        { error: 'At least one filter required: confidence_lt, not_recalled_in_days, or scope' },
        400,
      );
    }

    return c.json(await handlers.deleteLearnings(filters));
  });

  app.delete('/learning/:id', async (c) => c.json(await handlers.deleteLearning(c.req.param('id'))));

  app.get('/learning/:id/neighbors', async (c) => {
    const thresholdParam = c.req.query('threshold');
    const limitParam = c.req.query('limit');
    const threshold = thresholdParam ? parseFloat(thresholdParam) : 0.85;
    const limit = limitParam ? parseInt(limitParam, 10) : 10;
    return c.json(
      await handlers.getLearningNeighbors(
        c.req.param('id'),
        Number.isFinite(threshold) ? threshold : 0.85,
        Number.isFinite(limit) && limit > 0 ? limit : 10,
      ),
    );
  });

  app.post('/secret', async (c) => {
    const body: any = await c.req.json();
    return c.json(await handlers.setSecret(body.scope || 'shared', body.name, body.value));
  });

  app.get('/secret/:name', async (c) => {
    const result = await handlers.getSecret(
      c.req.query('scopes')?.split(',') || ['shared'],
      c.req.param('name'),
    );
    if (result === null) {
      return c.json({ error: 'not found' }, 404);
    }
    return c.json({ value: result });
  });

  app.delete('/secret/:name', async (c) => {
    const result = await handlers.deleteSecret(c.req.query('scope') || 'shared', c.req.param('name'));
    if (result.error) {
      return c.json({ error: result.error }, 404);
    }
    return c.json(result);
  });

  app.get('/secrets', async (c) => {
    try {
      return c.json(await handlers.listSecrets(c.req.query('scope')));
    } catch (error) {
      console.error('Get secrets error:', error);
      return c.json({ error: 'Failed to get secrets' }, 500);
    }
  });

  app.post('/run', async (c) => {
    const body: any = await c.req.json();
    const result = await handlers.recordRun(body);
    return c.json(result, 201);
  });

  app.get('/runs', async (c) => {
    const scope = c.req.query('scope');
    const limit = c.req.query('limit');
    return c.json(await handlers.getRuns(scope, limit ? parseInt(limit, 10) : undefined));
  });

  app.post('/cleanup', async (c) => c.json(await handlers.cleanup()));

  app.notFound((c) => c.json({ error: 'not found' }, 404));
  app.onError((err, c) => {
    console.error('Hono error:', err);
    return c.json({ error: err.message }, 500);
  });

  return app;
}
