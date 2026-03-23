# deja-edge

Edge memory for Cloudflare Durable Objects. FTS5 full-text search, zero external dependencies.

```ts
import { createEdgeMemory } from 'deja-edge'

export class MyDO extends DurableObject {
  private memory = createEdgeMemory(this.ctx)

  async fetch(request: Request) {
    const context = await request.text()
    const results = this.memory.recall(context)
    return Response.json(results)
  }
}
```

## Why

You have agents running in Cloudflare Workers. You want them to remember things across requests without adding Vectorize, Workers AI, or any external service. deja-edge gives you full-text search memory inside your Durable Object's built-in SQLite.

## Install

```bash
npm install deja-edge
```

Your wrangler config needs a DO with SQLite:

```json
{
  "durable_objects": {
    "bindings": [{ "name": "MEMORY", "class_name": "MyDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["MyDO"] }]
}
```

## API

All methods are synchronous — no async needed, no network calls. Everything runs in the DO's SQLite.

### `remember(text, options?)`

Store a memory.

```ts
memory.remember('Redis must be running before starting the API server')
memory.remember('Use pnpm, not npm')

// With agent attribution
memory.remember('always check wrangler.toml', { source: 'deploy-agent' })
```

Dedup: near-identical text is detected and skipped.
Conflict: same topic but different content — the new memory supersedes the old one (old confidence drops).

### `recall(context, opts?)`

Search memories. Returns results ranked by FTS5 relevance blended with confidence.

```ts
const results = memory.recall('setting up the dev environment')
// [{ id, text, score, confidence, createdAt }]
```

Options: `{ limit, threshold, minConfidence }`

### `confirm(id)` / `reject(id)`

Feedback loop. Confirm boosts confidence (+0.1), reject drops it (-0.15).

```ts
memory.confirm(results[0].id)  // useful
memory.reject(results[1].id)   // outdated
```

### `forget(id)`

Delete a memory.

### `list(opts?)` / `recallLog(opts?)`

Inspect memories and the audit trail.

```ts
memory.list()                    // all memories, newest first
memory.list({ limit: 10 })      // paginated
memory.recallLog()               // what was recalled and when
```

### `size`

Number of stored memories.

## Drop-in DO class

If you don't need a custom DO, use `DejaEdgeDO` directly:

```ts
// worker.ts
export { DejaEdgeDO } from 'deja-edge/do'

export default {
  async fetch(request, env) {
    const id = env.MEMORY.idFromName('default')
    const stub = env.MEMORY.get(id)
    return stub.fetch(request)
  }
}
```

Routes: `POST /remember`, `POST /recall`, `POST /confirm/:id`, `POST /reject/:id`, `DELETE /forget/:id`, `GET /list`, `GET /recall-log`, `GET /size`, `GET /`

## How it works

**Search**: SQLite FTS5 with Porter stemming tokenizer. Queries are decomposed into keywords, matched with `OR`, and ranked by BM25. Scores are normalized to 0-1 and blended with decayed confidence (70% relevance, 30% confidence).

**Time-based decay**: Confidence decays exponentially at recall time (half-life: 90 days). Memories that are recalled frequently stay fresh — each recall resets the decay clock. Stored confidence is only changed by `confirm()` and `reject()`.

**Dedup**: Trigram Jaccard similarity. Memories above 0.85 similarity are considered duplicates.

**Conflict resolution**: Memories between 0.5-0.85 similarity are about the same topic but say different things. The old memory's confidence drops to 30%, the new one takes priority.

**Anti-patterns**: When `reject()` drops a memory's confidence below 0.15, it auto-inverts into an anti-pattern — prefixed with "KNOWN PITFALL: ", confidence resets to 0.5, and it surfaces in recall as a warning. Negative knowledge actively warns agents away from known mistakes.

**Agent attribution**: Pass `{ source: 'agent-name' }` to `remember()` to track which agent stored a memory.

## Configuration

```ts
const memory = createEdgeMemory(ctx, {
  dedupeThreshold: 0.85,      // similarity to skip as duplicate (default 0.85)
  conflictThreshold: 0.5,     // similarity to detect conflict (default 0.5)
})
```

## License

MIT
