# deja examples

Runnable demos for each memory style.

## `local/` — In-process vector memory

SQLite + real embeddings (all-MiniLM-L6-v2). Runs anywhere Bun runs.

```bash
cd examples/local
bun install
bun run start
```

First run downloads the embedding model (~23MB, cached after that).

## `edge/` — Edge memory for Cloudflare Workers

FTS5 full-text search inside a Durable Object. No embeddings, no external deps.

```bash
cd examples/edge
npm install
npx wrangler dev
# then visit http://localhost:8787/demo
```

Or deploy it:

```bash
npx wrangler deploy
```

## Memory lifecycle

Both examples walk through the same lifecycle:

1. **remember** — store memories (with automatic deduplication)
2. **recall** — search by context (vector similarity or full-text)
3. **confirm/reject** — feedback loop to adjust confidence
4. **forget** — remove a memory entirely
