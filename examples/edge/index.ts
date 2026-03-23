/**
 * deja-edge example — Edge memory inside a Cloudflare Durable Object.
 *
 * Deploy: cd examples/edge && npx wrangler deploy
 * Dev:    cd examples/edge && npx wrangler dev
 *
 * Then hit the endpoints:
 *   curl http://localhost:8787/demo
 *
 * Uses FTS5 full-text search. No embeddings, no external deps.
 */

import { createEdgeMemory, type EdgeMemoryStore } from 'deja-edge'

// --- Durable Object: wraps deja-edge memory with HTTP routes ---

export class MemoryDO extends DurableObject {
  private memory: EdgeMemoryStore

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env)
    this.memory = createEdgeMemory(ctx)
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url)
    const path = url.pathname

    // POST /remember  { text: "..." }
    if (request.method === 'POST' && path === '/remember') {
      const { text } = await request.json<{ text: string }>()
      return Response.json(this.memory.remember(text), { status: 201 })
    }

    // POST /recall  { context: "..." }
    if (request.method === 'POST' && path === '/recall') {
      const { context } = await request.json<{ context: string }>()
      return Response.json(this.memory.recall(context))
    }

    // POST /confirm/:id
    if (request.method === 'POST' && path.startsWith('/confirm/')) {
      const id = path.slice('/confirm/'.length)
      return Response.json({ ok: this.memory.confirm(id) })
    }

    // POST /reject/:id
    if (request.method === 'POST' && path.startsWith('/reject/')) {
      const id = path.slice('/reject/'.length)
      return Response.json({ ok: this.memory.reject(id) })
    }

    // DELETE /forget/:id
    if (request.method === 'DELETE' && path.startsWith('/forget/')) {
      const id = path.slice('/forget/'.length)
      return Response.json({ ok: this.memory.forget(id) })
    }

    // GET /list
    if (request.method === 'GET' && path === '/list') {
      return Response.json(this.memory.list())
    }

    // GET /size
    if (request.method === 'GET' && path === '/size') {
      return Response.json({ size: this.memory.size })
    }

    return Response.json({ error: 'not found' }, { status: 404 })
  }
}

// --- Worker: routes requests to the DO ---

interface Env {
  MEMORY: DurableObjectNamespace<MemoryDO>
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // /demo — run the full lifecycle and return the results
    if (url.pathname === '/demo') {
      return runDemo(env)
    }

    // Everything else → forward to the DO
    const id = env.MEMORY.idFromName('default')
    const stub = env.MEMORY.get(id)
    return stub.fetch(request)
  },
} satisfies ExportedHandler<Env>

// --- Interactive demo that exercises the full lifecycle ---

async function runDemo(env: Env): Promise<Response> {
  const id = env.MEMORY.idFromName('demo')
  const stub = env.MEMORY.get(id)
  const base = 'http://do'
  const log: string[] = []

  log.push('--- deja-edge demo ---\n')

  // 1. Remember
  log.push('1. Remembering things...')
  const m1 = await stub.fetch(new Request(`${base}/remember`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Always run tests before deploying to production' }),
  })).then(r => r.json()) as { id: string; text: string }

  const m2 = await stub.fetch(new Request(`${base}/remember`, {
    method: 'POST',
    body: JSON.stringify({ text: 'The API rate limit is 100 requests per minute' }),
  })).then(r => r.json()) as { id: string; text: string }

  const m3 = await stub.fetch(new Request(`${base}/remember`, {
    method: 'POST',
    body: JSON.stringify({ text: 'Use wrangler.toml for Cloudflare Workers config' }),
  })).then(r => r.json()) as { id: string; text: string }

  const size = await stub.fetch(new Request(`${base}/size`)).then(r => r.json()) as { size: number }
  log.push(`   Stored ${size.size} memories\n`)

  // 2. Recall
  log.push('2. Recalling "deploying production"...')
  const results = await stub.fetch(new Request(`${base}/recall`, {
    method: 'POST',
    body: JSON.stringify({ context: 'deploying production' }),
  })).then(r => r.json()) as Array<{ id: string; text: string; score: number }>

  for (const r of results) {
    log.push(`   [score=${r.score.toFixed(3)}] ${r.text}`)
  }

  // 3. Confirm
  if (results.length > 0) {
    log.push('\n3. Confirming top result...')
    await stub.fetch(new Request(`${base}/confirm/${results[0].id}`, { method: 'POST' }))
    log.push(`   Confirmed: "${results[0].text}"`)
  }

  // 4. Forget
  log.push('\n4. Forgetting a memory...')
  await stub.fetch(new Request(`${base}/forget/${m3.id}`, { method: 'DELETE' }))
  log.push(`   Forgot: "${m3.text}"`)

  const finalSize = await stub.fetch(new Request(`${base}/size`)).then(r => r.json()) as { size: number }
  log.push(`   Memories remaining: ${finalSize.size}`)

  log.push('\n--- done ---')

  return new Response(log.join('\n'), { headers: { 'Content-Type': 'text/plain' } })
}
