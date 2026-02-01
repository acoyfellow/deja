# deja

*What survives a run.*

deja provides durable recall for agent systems.

It extracts structured memory from completed runs and stores it independently of any single execution. Memory in deja is explicit, reviewable, and optional.

Agents may consult deja. They are never required to.

## What deja is

- **Post-run recall** — derived from artifacts and outcomes
- **Addressable and scoped** — by user, agent, or session
- **Designed to persist** — longer than any single agent session

## What deja is not

- Conversation history
- Implicit context
- Hidden state
- Live cognition

## Why deja exists

Long-running systems repeat work unless memory is made explicit.

deja captures what mattered after execution, so future runs can begin informed rather than reactive.

## Safety and control

All entries in deja are:

- Traceable to a source run
- Auditable
- Removable
- Scoped by intent

Memory persists by choice, not by accident.

---

## Quick Start

### Store an entry

```bash
curl -X POST https://deja.coey.dev/learn \
  -H "Authorization: Bearer $DEJA_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "trigger": "when deploying to cloudflare",
    "learning": "run wrangler deploy --dry-run first",
    "confidence": 0.9
  }'
```

### Retrieve relevant entries

```bash
curl -X POST https://deja.coey.dev/inject \
  -H "Content-Type: application/json" \
  -d '{
    "context": "deploying a cloudflare worker",
    "format": "prompt",
    "limit": 5
  }'
```

Returns entries semantically relevant to the context.

---

## Architecture

**Durable Object per user.** Each user gets isolated storage. Isolation by architecture, not access control.

**Two interfaces:**
- **RPC** (service binding) — direct method calls, no auth needed
- **HTTP** (CLI/standalone) — API key auth

```
service binding          HTTP + API key
      │                        │
      ▼                        ▼
┌──────────────────────────────────────┐
│            DejaDO                    │
│  ┌────────────────────────────────┐  │
│  │  SQLite (entries, secrets)     │  │
│  └────────────────────────────────┘  │
│              │                       │
│              ▼                       │
│         Vectorize                    │
│    (semantic retrieval)              │
└──────────────────────────────────────┘
```

---

## Scopes

Entries are scoped:

| Scope | Visibility |
|-------|------------|
| `shared` | All agents for this user |
| `agent:<id>` | Specific agent |
| `session:<id>` | Specific session |

Callers declare which scopes they can access. deja filters accordingly.

---

## HTTP API

Base URL: `https://deja.coey.dev`

### POST /learn

Store an entry.

```bash
curl -X POST /learn \
  -H "Authorization: Bearer $KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "trigger": "when this is relevant",
    "learning": "what to recall",
    "confidence": 0.9,
    "scope": "shared"
  }'
```

### POST /inject

Retrieve relevant entries for a context. Tracks hits.

```bash
curl -X POST /inject \
  -H "Content-Type: application/json" \
  -d '{
    "context": "describe the task",
    "scopes": ["shared", "agent:ralph"],
    "limit": 5,
    "format": "prompt"
  }'
```

### POST /query

Search entries without tracking hits.

```bash
curl -X POST /query \
  -H "Authorization: Bearer $KEY" \
  -d '{"text": "search term", "limit": 10}'
```

### GET /learnings

List entries with optional filters.

```bash
curl -H "Authorization: Bearer $KEY" \
  "/learnings?scope=shared&limit=20"
```

### DELETE /learning/:id

Remove an entry.

```bash
curl -X DELETE /learning/<id> \
  -H "Authorization: Bearer $KEY"
```

### GET /stats

Get memory statistics.

```bash
curl -H "Authorization: Bearer $KEY" /stats
```

---

## Secrets

deja also stores secrets, scoped the same way as entries.

### POST /secret

```bash
curl -X POST /secret \
  -H "Authorization: Bearer $KEY" \
  -d '{"name": "API_KEY", "value": "sk-...", "scope": "agent:ralph"}'
```

### GET /secret/:name

```bash
curl -H "Authorization: Bearer $KEY" /secret/API_KEY
```

### DELETE /secret/:name

```bash
curl -X DELETE /secret/API_KEY \
  -H "Authorization: Bearer $KEY"
```

---

## RPC (service binding)

For internal callers (filepath, orchestrators):

```typescript
const deja = env.DEJA.get(env.DEJA.idFromName(userId));

// Entries
await deja.inject(scopes, context, limit);  // retrieve relevant
await deja.learn(scope, trigger, learning, confidence, source);
await deja.query(scopes, text, limit);      // search without tracking
await deja.getLearnings(filter);
await deja.deleteLearning(id);

// Secrets
await deja.getSecret(scopes, name);         // first match wins
await deja.setSecret(scope, name, value);
await deja.deleteSecret(scope, name);

// Stats
await deja.getStats();
```

---

## Self-hosting

### Prerequisites

- Cloudflare account
- Wrangler CLI
- Vectorize index (for semantic search)

### Setup

```bash
git clone https://github.com/acoyfellow/deja
cd deja
bun install

# Create vectorize index
wrangler vectorize create deja-embeddings --dimensions 384 --metric cosine

# Set API key secret
wrangler secret put API_KEY

# Deploy
bun run deploy
```

### Configuration

Edit `wrangler.toml`:

```toml
name = "deja"
main = "src/index.ts"

[durable_objects]
bindings = [
  { name = "DEJA", class_name = "DejaDO" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["DejaDO"]

[[vectorize]]
binding = "VECTORIZE"
index_name = "deja-embeddings"

[ai]
binding = "AI"
```

---

## Development

```bash
bun install
bun run dev        # local dev server
bun run test       # run tests
bun run deploy     # deploy to Cloudflare
```

## Stack

- Cloudflare Workers + Durable Objects
- SQLite (DO storage)
- Vectorize (semantic retrieval)
- Workers AI (embeddings)
- Hono (HTTP routing)

---

*Recall, by design.*
