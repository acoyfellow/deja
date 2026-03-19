# deja-local

Cross-session memory for AI agents. One function to remember, one function to recall.

```ts
import { createMemory } from "deja-local";

const mem = await createMemory({ path: "./agent-memory.db" });

// Store a learning
await mem.remember("Always run migrations before deploying to staging");

// Recall relevant memories later, in any session
const results = await mem.recall("deploying to staging");
// [{ text: "Always run migrations before deploying to staging", score: 0.82, confidence: 0.5 }]
```

## Why

AI agents are amnesiacs. Every session starts from zero. Your agent figures out that the test suite needs `NODE_ENV=test` on Monday, then wastes 10 minutes rediscovering it on Tuesday.

deja-local gives agents a durable memory that gets smarter over time.

- **SQLite-backed** -- no external services, no API keys, no network
- **Real embeddings** -- all-MiniLM-L6-v2 via ONNX, runs on CPU
- **ACID durable** -- memory is persisted before `remember()` returns
- **Gets smarter** -- confirm/reject feedback makes good memories rise and bad ones fade

## Install

```bash
npm install deja-local
```

## API

### `remember(text)`

Store a memory. Deja handles dedup and conflict resolution automatically.

```ts
await mem.remember("The Stripe webhook secret is in 1Password, not .env");
await mem.remember("Use pnpm, not npm -- the lockfile breaks otherwise");
await mem.remember("Redis must be running before starting the API server");
```

If a new memory contradicts an existing one, Deja detects the conflict and supersedes it:

```ts
await mem.remember("Deploy target is us-east-1");
// ... weeks later ...
await mem.remember("Deploy target moved to eu-west-1");
// Old memory is superseded -- its confidence drops, new one takes priority
```

Identical or near-identical memories are deduplicated at write time.

### `recall(query, opts?)`

Retrieve relevant memories, ranked by relevance and confidence.

```ts
const results = await mem.recall("setting up the dev environment");
// [
//   { text: "Redis must be running before starting the API server", score: 0.81, confidence: 0.7 },
//   { text: "Use pnpm, not npm -- the lockfile breaks otherwise", score: 0.74, confidence: 0.5 },
// ]
```

Complex queries are automatically decomposed into sub-queries for broader recall:

```ts
const results = await mem.recall("full deploy checklist for production");
// Internally searches: deploy, checklist, production, deploy checklist, checklist production
// Returns merged, deduplicated results
```

Options:

```ts
await mem.recall("deploy steps", { limit: 3 });            // max results
await mem.recall("deploy steps", { threshold: 0.5 });       // min relevance
await mem.recall("deploy steps", { minConfidence: 0.4 });   // skip low-confidence memories
```

### `confirm(id)` / `reject(id)`

Give feedback on recalled memories. This is the ratchet -- memories that help get promoted, memories that mislead get demoted.

```ts
const results = await mem.recall("database connection string format");

// This one was useful
await mem.confirm(results[0].id);

// This one was outdated
await mem.reject(results[1].id);
```

Over time, high-signal memories surface first. Low-signal memories fade.

### `forget(id)`

Permanently remove a memory.

```ts
await mem.forget(memory.id);
```

### `list(opts?)` / `recallLog(opts?)`

Inspect stored memories and the audit trail.

```ts
const all = mem.list();                    // all memories, newest first
const recent = mem.list({ limit: 10 });    // paginated

const log = mem.recallLog();               // what was recalled and when
```

## Configuration

```ts
const mem = createMemory({
  path: "./memory.db",           // required -- SQLite file path
  model: "Xenova/all-MiniLM-L6-v2",  // HuggingFace model (default)
  embed: customEmbedFn,          // or bring your own embed function
  threshold: 0.3,                // min similarity for recall (default 0.3)
  dedupeThreshold: 0.95,         // similarity to consider duplicate (default 0.95)
  conflictThreshold: 0.6,        // similarity to detect conflict (default 0.6)
});
```

## How it works

**Dedup:** At write time, if a new memory's embedding is >= 0.95 similar to an existing one, it's a duplicate and skipped.

**Conflict resolution:** If similarity is between 0.6 and 0.95, the memories are about the same topic but say different things. The new memory supersedes the old one -- the old memory's confidence drops to 30% of its current value, so it naturally sinks in recall rankings.

**The ratchet:** `confirm()` boosts confidence by 0.1, `reject()` drops it by 0.15. Recall ranks by `relevance * 0.7 + confidence * 0.3`. Over thousands of memories, this is the difference between useful recall and noise.

**Recall decomposition:** Complex queries are split into keyword pairs and individual terms. Each sub-query is embedded and scored independently. The best score per memory wins. This catches memories that match part of your intent even if they don't match the full query.

**Audit trail:** Every `recall()` is logged with the query, matched memory IDs, scores, and timestamp. Inspect with `recallLog()`.

## License

MIT
