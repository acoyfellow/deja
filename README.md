# deja

Persistent memory for AI agents. Agents learn from runs — deja remembers across them.

## Three ways to use deja

| | **deja-local** | **deja-edge** | **deja (hosted)** |
|---|---|---|---|
| **What it is** | In-process SQLite memory | Cloudflare Durable Object memory | Hosted Cloudflare Worker service |
| **Search** | Vector embeddings (all-MiniLM-L6-v2) | FTS5 full-text search | Vectorize + Workers AI embeddings |
| **Runtime** | Bun | Cloudflare Workers | Cloudflare Workers |
| **Dependencies** | None (runs locally) | None (runs in your DO) | Vectorize index + Workers AI |
| **Latency** | Zero (in-process) | Zero (in-DO) | Network round-trip |
| **Install** | `npm install deja-local` | `npm install deja-edge` | Clone + `wrangler deploy` |
| **Best for** | Local agents, scripts, CLI tools | Edge agents running in Workers | Multi-tenant, team-shared memory |

### deja-local

Memory lives in a local SQLite file. Vector search via ONNX embeddings on CPU. No network, no API keys. Requires Bun.

```ts
import { createMemory } from 'deja-local'

const mem = createMemory({ path: './agent.db' })
await mem.remember('always run migrations before deploying')
const results = await mem.recall('deploying to staging')
```

[Full docs →](./packages/deja-local/)

### deja-edge

Memory lives in a Cloudflare Durable Object's SQLite. FTS5 full-text search with BM25 ranking. No Vectorize, no Workers AI — just text matching. Zero external dependencies.

```ts
import { createEdgeMemory } from 'deja-edge'

export class MyDO extends DurableObject {
  private memory = createEdgeMemory(this.ctx)

  async onRemember(text: string) {
    return this.memory.remember(text)
  }
  async onRecall(context: string) {
    return this.memory.recall(context)
  }
}
```

Or use the drop-in DO class with HTTP routes:

```ts
export { DejaEdgeDO } from 'deja-edge/do'
```

[Full docs →](./packages/deja-edge/)

### deja (hosted)

Hosted service with Vectorize semantic search, scoped memory, working state, secrets, and MCP support. Deploy your own instance or use as part of [filepath](https://github.com/acoyfellow/filepath).

```bash
git clone https://github.com/acoyfellow/deja && cd deja
bun install && wrangler login
wrangler vectorize create deja-embeddings --dimensions 384 --metric cosine
wrangler secret put API_KEY
bun run deploy
```

Connect via REST, the [client package](./packages/deja-client/), or MCP:

```json
{
  "mcpServers": {
    "deja": {
      "type": "http",
      "url": "https://your-deja-instance.workers.dev/mcp",
      "headers": { "Authorization": "Bearer ${DEJA_API_KEY}" }
    }
  }
}
```

## Core concepts

All three systems share the same mental model:

- **Remember** — store a memory (text, optionally with trigger/context/confidence)
- **Recall** — search for relevant memories given a context
- **Confirm / Reject** — feedback loop. Confirmed memories rise, rejected ones fade
- **Forget** — permanently delete a memory

Memories are deduplicated at write time. Conflicting memories (same topic, different content) are automatically resolved — the newer one supersedes the older one.

### Time-based confidence decay

Stale memories don't sit at 0.5 forever. At recall time, confidence decays exponentially based on how recently the memory was created or last recalled:

```
decayedConfidence = storedConfidence × 0.5^(daysSince / 90)
```

A memory untouched for 90 days has its effective confidence halved. Recalling a memory resets its decay clock — actively used knowledge stays fresh. Stored confidence is never mutated by decay; only `confirm()` and `reject()` change the stored value.

### Agent attribution

Track which agent stored a memory with the optional `source` parameter:

```ts
await mem.remember('always use pnpm', { source: 'deploy-agent' })
```

### Anti-patterns

When a memory is rejected enough that its confidence drops below 0.15, it auto-inverts into an **anti-pattern** — a warning that actively surfaces during recall:

```
Before: "use eval for JSON parsing"  (confidence: 0.05, type: "memory")
After:  "KNOWN PITFALL: use eval for JSON parsing"  (confidence: 0.5, type: "anti-pattern")
```

Negative knowledge is as valuable as positive knowledge. Anti-patterns participate in recall normally and warn agents away from known mistakes.

## Hosted service API

The hosted service adds features beyond basic memory:

- **Scoped memory** — `shared`, `agent:<id>`, `session:<id>`, or custom scopes
- **Confidence feedback** — `confirm` boosts confidence, `reject` lowers it
- **Conflict tracking** — hosted learnings carry `type` and optional `supersedes`
- **Proof citations** — `proof_run_id` and `proof_iteration_id` can be attached as evidence and are returned on recall
- **Working state** — live snapshots + event streams for in-progress work
- **Secrets** — scoped key-value storage
- **Loop runs** — track optimization loops with auto-learning from outcomes

Core REST endpoints: `/learn`, `/learning/:id/confirm`, `/learning/:id/reject`, `/inject`, `/inject/trace`, `/query`, `/learnings`, `/learning/:id/neighbors`, `/cleanup`, `/stats`, `/state/:runId`, `/secret`, `/run`

Full reference: https://deja.coey.dev/docs

## Architecture

- **deja-local**: Bun SQLite + ONNX embeddings (all-MiniLM-L6-v2). In-memory vector index loaded at startup.
- **deja-edge**: Cloudflare DO SQLite + FTS5. Porter stemming tokenizer. BM25 ranking blended with confidence.
- **deja (hosted)**: Cloudflare Worker + Durable Object + Vectorize + Workers AI. Per-user isolation via API key.

## License

MIT
