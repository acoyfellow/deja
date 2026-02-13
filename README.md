# deja

*What survives a run.*

deja provides durable recall for agent systems.

It extracts structured memory from completed runs and stores it independently of any single execution. Memory in deja is explicit, reviewable, and optional.

Agents may consult deja. They are never required to.

## What deja is

- **Post-run recall** — derived from artifacts and outcomes
- **Addressable and scoped** — by user, agent, or session
- **Designed to persist** — longer than any single agent session
- **Self-hosted** — runs on your Cloudflare account

## What deja is not

- A shared service
- Conversation history
- Implicit context
- Hidden state

## Why deja exists

Long-running systems repeat work unless memory is made explicit.

deja captures what mattered after execution, so future runs can begin informed rather than reactive.

## Safety and control

All entries in deja are:

- Stored in your Cloudflare account
- Traceable to a source run
- Auditable
- Removable
- Scoped by intent

Memory persists by choice, not by accident.

---

## Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/acoyfellow/deja)

Or deploy manually:

### Prerequisites

- Cloudflare account
- Wrangler CLI (`npm install -g wrangler`)
- Node.js 18+ or Bun

### Setup

```bash
# Clone
git clone https://github.com/acoyfellow/deja
cd deja

# Install dependencies
bun install  # or npm install

# Login to Cloudflare
wrangler login

# Create vectorize index for semantic search
wrangler vectorize create deja-embeddings --dimensions 384 --metric cosine

# Set your API key (you'll use this to authenticate requests)
wrangler secret put API_KEY
# Enter a secure random string when prompted

# Deploy
bun run deploy  # or npm run deploy
```

After deploy, wrangler outputs your worker URL:
```
Published deja (1.0.0)
  https://deja.<your-subdomain>.workers.dev
```

### Schema & migrations (Drizzle-first)

`src/schema.ts` is the schema source of truth.

```bash
# Generate SQL artifacts from Drizzle schema
bun run db:generate

# Apply live working-state migration (repo artifact)
bun run db:migrate:state
```

Migration artifacts live under `drizzle/`.

### Configuration

Edit `wrangler.json` before deploying:

```json
{
  "name": "deja",
  "main": "src/index.ts",
  "compatibility_date": "2024-01-01",
  "workers_dev": true,
  "durable_objects": {
    "bindings": [
      { "name": "DEJA", "class_name": "DejaDO" }
    ]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["DejaDO"] }
  ],
  "vectorize": [
    { "binding": "VECTORIZE", "index_name": "deja-embeddings" }
  ],
  "ai": {
    "binding": "AI"
  }
}
```

---

## Usage

Replace `$DEJA_URL` with your deployed worker URL.  
Replace `$API_KEY` with the key you set during setup.

### Store an entry

```bash
curl -X POST $DEJA_URL/learn \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "trigger": "when deploying to cloudflare",
    "learning": "run wrangler deploy --dry-run first",
    "confidence": 0.9
  }'
```

### Retrieve relevant entries

```bash
curl -X POST $DEJA_URL/inject \
  -H "Authorization: Bearer $API_KEY" \
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

```
Your infrastructure
│
▼
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

## API Reference

### POST /learn

Store an entry.

```bash
curl -X POST $DEJA_URL/learn \
  -H "Authorization: Bearer $API_KEY" \
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
curl -X POST $DEJA_URL/inject \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "context": "describe the task",
    "scopes": ["shared", "agent:myagent"],
    "limit": 5,
    "format": "prompt"
  }'
```

Inject also supports optional live working-state context:

```bash
curl -X POST $DEJA_URL/inject \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "context": "handoff update",
    "scopes": ["shared"],
    "includeState": true,
    "runId": "run_123",
    "limit": 5
  }'
```

### POST /query

Search entries without tracking hits.

```bash
curl -X POST $DEJA_URL/query \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"text": "search term", "limit": 10}'
```

### GET /learnings

List entries with optional filters.

```bash
curl "$DEJA_URL/learnings?scope=shared&limit=20" \
  -H "Authorization: Bearer $API_KEY"
```

### DELETE /learning/:id

Remove an entry.

```bash
curl -X DELETE $DEJA_URL/learning/<id> \
  -H "Authorization: Bearer $API_KEY"
```

### GET /stats

Get memory statistics.

```bash
curl $DEJA_URL/stats \
  -H "Authorization: Bearer $API_KEY"
```

---

## Working State API

Live, explicit state for active runs/sessions. This complements durable learnings.

### GET /state/:runId

```bash
curl $DEJA_URL/state/run_123 \
  -H "Authorization: Bearer $API_KEY"
```

### PUT /state/:runId

```bash
curl -X PUT $DEJA_URL/state/run_123 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "goal": "Ship onboarding PR",
    "assumptions": ["Mike is handoff owner"],
    "decisions": [{"text": "Link PR in update", "status": "accepted"}],
    "open_questions": ["Need extra env docs?"],
    "next_actions": ["Open PR", "Share link"],
    "confidence": 0.84,
    "updatedBy": "agent:main"
  }'
```

### PATCH /state/:runId

```bash
curl -X PATCH $DEJA_URL/state/run_123 \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "next_actions": ["Send Ali message with PR link"],
    "updatedBy": "agent:main"
  }'
```

### POST /state/:runId/events

```bash
curl -X POST $DEJA_URL/state/run_123/events \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "eventType": "note",
    "payload": {"text": "ali requested no meeting mention"},
    "createdBy": "agent:main"
  }'
```

### POST /state/:runId/resolve

```bash
curl -X POST $DEJA_URL/state/run_123/resolve \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "persistToLearn": true,
    "scope": "shared",
    "summaryStyle": "compact",
    "updatedBy": "agent:main"
  }'
```

---

## Secrets

deja also stores secrets, scoped the same way as entries.

### POST /secret

```bash
curl -X POST $DEJA_URL/secret \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "OPENAI_KEY", "value": "sk-...", "scope": "shared"}'
```

### GET /secret/:name

```bash
curl $DEJA_URL/secret/OPENAI_KEY \
  -H "Authorization: Bearer $API_KEY"
```

### DELETE /secret/:name

```bash
curl -X DELETE $DEJA_URL/secret/OPENAI_KEY \
  -H "Authorization: Bearer $API_KEY"
```

---

## Service Binding (RPC)

If you're building on Cloudflare and want direct access without HTTP:

```typescript
// In your wrangler.json, add:
"services": [
  { "binding": "DEJA", "service": "deja", "entrypoint": "DejaDO" }
]

// In your code
const deja = env.DEJA.get(env.DEJA.idFromName(userId));

// Entries
await deja.inject(scopes, context, limit);
await deja.learn(scope, trigger, learning, confidence, source);
await deja.query(scopes, text, limit);
await deja.getLearnings(filter);
await deja.deleteLearning(id);

// Secrets
await deja.getSecret(scopes, name);
await deja.setSecret(scope, name, value);
await deja.deleteSecret(scope, name);

// Stats
await deja.getStats();
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

*Recall, by design.

## API Contracts

Working-state endpoint contracts are documented in:

- `docs/openapi-working-state.yaml`*
