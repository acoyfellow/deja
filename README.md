# deja

**Persistent memory for agents.** Agents learn from failures. Deja remembers.

## The System

Deja is three things:

1. **Memory API** - Store and query learnings across sessions
2. **preflight** - Query memory before building (prevent reinventing)
3. **approach-log** - Track attempts within a session (prevent loops)

## Quick Start

```bash
# Before starting work, run preflight
node tools/preflight.mjs "what you're about to build"

# This queries deja and shows relevant memory, then asks:
# - What exactly are you building?
# - Why is this needed?
# - How will you test it?
# - What could go wrong?
# - Is the answer in memory already?
```

## Memory API

```bash
# Get context (no auth needed)
curl -X POST https://deja.coey.dev/inject \
  -H "Content-Type: application/json" \
  -d '{"context": "your task", "format": "prompt", "limit": 5}'

# Store a learning (auth required)
curl -X POST https://deja.coey.dev/learn \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"trigger": "when relevant", "learning": "what you learned", "confidence": 0.9}'
```

### Endpoints

| Endpoint | Auth | Description |
|----------|------|-------------|
| `POST /inject` | No | Get formatted context for prompt |
| `POST /query` | No | Semantic search |
| `POST /learn` | Yes | Store a learning |
| `GET /learnings` | No | List all (for cleanup) |
| `GET /learning/:id` | No | Get by ID |
| `DELETE /learning/:id` | Yes | Remove garbage |
| `GET /stats` | No | Count and avg confidence |

## Tools

### preflight

Query memory + force yourself to think before building.

```bash
node tools/preflight.mjs "building a session state service"
# Shows relevant memory
# Asks the 5 questions
# If memory has the answer, don't build
```

### approach-log

Track what you tried within a session. Prevents loops.

```bash
node tools/approach-log.mjs log "tried X" "result Y" "learned Z"
node tools/approach-log.mjs show
node tools/approach-log.mjs check "something similar"
node tools/approach-log.mjs clear
```

## Philosophy

- **Memory across sessions**: deja API
- **Memory within session**: approach-log
- **Think before building**: preflight
- **Simpler is better**: No separate service for session-handoff, just use `trigger: "session:current"`

## Blog Series

- [Part 1: deja](https://coey.dev/deja) - Agent memory
- [Part 2: gate-review](https://coey.dev/gate-review) - Adversarial test review
- [Part 3: preflight](https://coey.dev/preflight) - Slow down and think

## Self-Hosting

```bash
npm install
npx wrangler d1 create deja-db
npx wrangler vectorize create deja-index --dimensions=768 --metric=cosine
npx wrangler d1 execute deja-db --file=schema.sql --remote
npx wrangler secret put API_KEY
npx wrangler deploy
```

## License

MIT
