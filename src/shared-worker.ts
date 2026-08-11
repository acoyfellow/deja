/**
 * deja shared-authority Worker — the CONSENTED shared seam only.
 *
 * This is the one honest way deja becomes a composable cloud service without
 * violating local-first: it exposes the SharedAuthority append-only log
 * (explicit, redaction-aware, consented writes) behind a Durable Object that
 * persists committed events. Raw private local memory NEVER reaches this
 * service — only writes an agent explicitly sends to the shared authority.
 *
 * Routes (delegated to the tested handleAuthorityRequest adapter):
 *   POST /v1/shared/remember | /handoff | /signal | /delete
 *   GET  /v1/shared/events?since=<r>&limit=<n> | /status | /stream (SSE)
 *   GET  /health
 *
 * Deploy: wrangler.shared.toml (separate Worker from the marketing site).
 */

import { DurableObject } from 'cloudflare:workers';
import { SharedAuthority } from './shared-authority/authority.ts';
import { handleAuthorityRequest } from './shared-authority/handlers.ts';
import type { SharedMemoryEvent } from './shared-authority/types.ts';

export interface Env {
  SHARED_AUTHORITY: DurableObjectNamespace<SharedAuthorityDO>;
}

/**
 * One Durable Object per authority id. Persists each committed event to DO
 * storage keyed by zero-padded revision, and rehydrates the in-memory
 * SharedAuthority log on cold start via restore().
 */
export class SharedAuthorityDO extends DurableObject<Env> {
  private authority: SharedAuthority | null = null;
  private ready: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const authorityId = (await ctx.storage.get<string>('authority')) ?? 'pending';
      const auth = new SharedAuthority({ authority: authorityId });
      const stored = await ctx.storage.list<SharedMemoryEvent>({ prefix: 'ev:' });
      if (stored.size > 0) {
        const events = [...stored.values()].sort((a, b) => a.revision - b.revision);
        auth.restore(events);
      }
      // Persist every future committed event durably before it is observable
      // to other readers via events/stream.
      auth.subscribe((event) => {
        void ctx.storage.put(`ev:${String(event.revision).padStart(12, '0')}`, event);
      });
      this.authority = auth;
    });
  }

  async bind(authorityId: string): Promise<void> {
    await this.ready;
    if ((await this.ctx.storage.get<string>('authority')) === undefined) {
      await this.ctx.storage.put('authority', authorityId);
    }
  }

  override async fetch(request: Request): Promise<Response> {
    await this.ready;
    if (!this.authority) {
      return Response.json({ ok: false, error: 'authority not initialized' }, { status: 503 });
    }
    return handleAuthorityRequest(this.authority, request, '/v1/shared');
  }
}

const app = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return Response.json({ ok: true, service: 'deja-shared-authority' });
    }

    if (url.pathname.startsWith('/v1/shared')) {
      // Authority id from header (opaque per-owner slug). One DO per authority.
      const authorityId = request.headers.get('x-deja-authority')?.trim() || 'default';
      const id = env.SHARED_AUTHORITY.idFromName(authorityId);
      const stub = env.SHARED_AUTHORITY.get(id);
      await stub.bind(authorityId);
      return stub.fetch(request);
    }

    return Response.json({ ok: false, error: 'not found' }, { status: 404 });
  },
};

export default app;
