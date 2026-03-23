# deja-local

Local in-process memory for AI agents. SQLite-backed, vector search, no network. **Requires Bun.**

```ts
import { createMemory } from 'deja-local'

const mem = createMemory({ path: './agent.db' })

await mem.remember('always run migrations before deploying to staging')
const results = await mem.recall('deploying to staging')
// [{ text: "always run migrations before deploying to staging", score: 0.82, confidence: 0.5 }]
```

## Install

```bash
bun add deja-local
```

This package uses `bun:sqlite` and requires the Bun runtime. It will not work in Node.js.

## API

### `remember(text)`

Store a memory. Dedup and conflict resolution happen automatically.

```ts
await mem.remember('Use pnpm, not npm -- the lockfile breaks otherwise')
await mem.remember('Redis must be running before starting the API server')
```

If a new memory contradicts an existing one, the old memory's confidence drops and the new one takes priority.

### `recall(query, opts?)`

Search memories by semantic similarity, ranked by relevance and confidence.

```ts
const results = await mem.recall('setting up the dev environment')
```

Complex queries are decomposed into sub-queries for broader recall. Options: `{ limit, threshold, minConfidence }`

### `confirm(id)` / `reject(id)`

Feedback loop. Confirm boosts confidence (+0.1), reject drops it (-0.15). Over time, useful memories surface first.

### `forget(id)`

Delete a memory.

### `list(opts?)` / `recallLog(opts?)`

Inspect memories and the audit trail.

## Configuration

```ts
const mem = createMemory({
  path: './memory.db',                    // required -- SQLite file path
  model: 'Xenova/all-MiniLM-L6-v2',      // HuggingFace model (default)
  embed: customEmbedFn,                   // or bring your own embed function
  threshold: 0.3,                         // min similarity for recall (default 0.3)
  dedupeThreshold: 0.95,                  // similarity to skip as duplicate (default 0.95)
  conflictThreshold: 0.6,                 // similarity to detect conflict (default 0.6)
})
```

## How it works

**Embeddings**: all-MiniLM-L6-v2 via ONNX, runs on CPU (~23MB model, cached locally). In-memory vector index loaded at startup.

**Scoring**: `relevance * 0.7 + confidence * 0.3`. Confirm/reject adjusts confidence. Over thousands of memories, this separates signal from noise.

**Dedup**: >= 0.95 similarity at write time is skipped. 0.6-0.95 similarity triggers conflict resolution — old memory's confidence drops to 30%.

## License

MIT
