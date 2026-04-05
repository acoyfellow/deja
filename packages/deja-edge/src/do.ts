/**
 * Ready-to-use Durable Object class with HTTP routes.
 *
 * ```ts
 * // wrangler.json:
 * // { "durable_objects": { "bindings": [{ "name": "MEMORY", "class_name": "DejaEdgeDO" }] } }
 * // { "migrations": [{ "tag": "v1", "new_sqlite_classes": ["DejaEdgeDO"] }] }
 *
 * // worker.ts:
 * export { DejaEdgeDO } from 'deja-edge/do'
 * ```
 */

import { createEdgeMemory, type EdgeMemoryStore, type CreateEdgeMemoryOptions } from './index'

export class DejaEdgeDO extends DurableObject {
  private memory: EdgeMemoryStore

  constructor(ctx: DurableObjectState, env: unknown) {
    super(ctx, env)
    this.memory = createEdgeMemory(ctx)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname
    const method = request.method

    try {
      // POST /remember — store a memory
      if (method === 'POST' && path === '/remember') {
        const body = await request.json<{ text?: string; trigger?: string; learning?: string; confidence?: number; scope?: string; reason?: string; source?: string; noveltyThreshold?: number }>()
        if (body.trigger && body.learning) {
          const result = this.memory.learn(body.trigger, body.learning, {
            confidence: body.confidence,
            scope: body.scope,
            reason: body.reason,
            source: body.source,
            noveltyThreshold: body.noveltyThreshold,
          })
          return json(result, 201)
        }
        if (!body.text) return json({ error: 'text is required' }, 400)
        const result = this.memory.remember(body.text, { source: body.source })
        return json(result, 201)
      }

      // POST /recall — search memories
      if (method === 'POST' && path === '/recall') {
        const body = await request.json<{ context: string; limit?: number; threshold?: number; minConfidence?: number; maxTokens?: number; format?: 'prompt' | 'learnings'; search?: 'text' }>()
        if (!body.context) return json({ error: 'context is required' }, 400)
        const result = this.memory.inject(body.context, {
          limit: body.limit,
          threshold: body.threshold,
          minConfidence: body.minConfidence,
          maxTokens: body.maxTokens,
          format: body.format,
          search: body.search,
        })
        return json(body.format === 'learnings' || body.maxTokens ? result : result.learnings.map(learning => ({
          id: learning.id,
          text: learning.text,
          confidence: learning.confidence,
          createdAt: learning.createdAt,
        })))
      }

      // POST /confirm/:id
      if (method === 'POST' && path.startsWith('/confirm/')) {
        const id = path.slice('/confirm/'.length)
        const ok = this.memory.confirm(id)
        return ok ? json({ ok: true }) : json({ error: 'not found' }, 404)
      }

      // POST /reject/:id
      if (method === 'POST' && path.startsWith('/reject/')) {
        const id = path.slice('/reject/'.length)
        const ok = this.memory.reject(id)
        return ok ? json({ ok: true }) : json({ error: 'not found' }, 404)
      }

      // DELETE /forget/:id
      if (method === 'DELETE' && path.startsWith('/forget/')) {
        const id = path.slice('/forget/'.length)
        const ok = this.memory.forget(id)
        return ok ? json({ ok: true }) : json({ error: 'not found' }, 404)
      }

      // GET /list
      if (method === 'GET' && path === '/list') {
        const limit = parseInt(url.searchParams.get('limit') ?? '100')
        const offset = parseInt(url.searchParams.get('offset') ?? '0')
        return json(this.memory.list({ limit, offset }))
      }

      // GET /recall-log
      if (method === 'GET' && path === '/recall-log') {
        const limit = parseInt(url.searchParams.get('limit') ?? '50')
        return json(this.memory.recallLog({ limit }))
      }

      // GET /size
      if (method === 'GET' && path === '/size') {
        return json({ size: this.memory.size })
      }

      // GET / — health
      if (method === 'GET' && path === '/') {
        return json({ status: 'ok', service: 'deja-edge', size: this.memory.size })
      }

      return json({ error: 'not found' }, 404)
    } catch (err) {
      const message = err instanceof Error ? err.message : 'internal error'
      return json({ error: message }, 500)
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

export default DejaEdgeDO
