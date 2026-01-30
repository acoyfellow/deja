# deja

**Persistent memory for agents.**

Agents learn from failures. Deja remembers.

## What is this?

Deja is a semantic memory store designed for AI agents. It lets agents:

1. **Store learnings** - When something works or fails, record it
2. **Query by context** - Find relevant learnings using semantic search
3. **Inject into prompts** - Get formatted learnings for context injection

## Why?

Agents forget. Every session starts fresh. They make the same mistakes, try the same failing approaches, can't build on previous work.

Deja gives agents scar tissue.

## API

### Store a learning

```bash
curl -X POST https://deja.coy.workers.dev/learn \
  -H "Content-Type: application/json" \
  -d '{
    "trigger": "email validation",
    "learning": "use zod, not regex",
    "reason": "regex fails on international domains",
    "confidence": 0.95,
    "source": "task-123"
  }'
```

### Query for learnings

```bash
curl -X POST https://deja.coy.workers.dev/query \
  -H "Content-Type: application/json" \
  -d '{
    "context": "validating user email on signup form",
    "limit": 5
  }'
```

### Get learnings for prompt injection

```bash
curl -X POST https://deja.coy.workers.dev/inject \
  -H "Content-Type: application/json" \
  -d '{
    "context": "building authentication flow",
    "format": "prompt"
  }'
```

Returns:
```
## Relevant learnings from previous work:
- email validation: use zod, not regex (regex fails on international domains)
```

### Check stats

```bash
curl https://deja.coy.workers.dev/stats
```

## Data Model

```typescript
interface Learning {
  id: string;           // UUID
  trigger: string;      // What context triggers this learning
  learning: string;     // What was learned
  reason?: string;      // Why (optional)
  confidence?: number;  // 0-1, default 1.0
  source?: string;      // Where this came from
  created_at: string;   // ISO timestamp
}
```

## Architecture

Built on Cloudflare:

- **Workers** - API layer at the edge
- **D1** - SQLite for structured storage
- **Vectorize** - Vector DB for semantic search
- **Workers AI** - Embeddings (bge-base-en-v1.5)

## Self-hosting

```bash
git clone https://github.com/acoyfellow/deja.git
cd deja
npm install

# Create D1 database
npx wrangler d1 create deja-db
# Update wrangler.toml with database_id

# Create Vectorize index
npx wrangler vectorize create deja-index --dimensions=768 --metric=cosine

# Initialize schema
npx wrangler d1 execute deja-db --file=schema.sql --remote

# Deploy
npx wrangler deploy
```

## Integration Examples

### In a gateproof loop

```typescript
// Before starting work, query for relevant learnings
const response = await fetch('https://deja.coy.workers.dev/inject', {
  method: 'POST',
  body: JSON.stringify({
    context: story.title,
    format: 'prompt'
  })
});
const { injection } = await response.json();
// Add injection to agent context

// After a failure, store the learning
await fetch('https://deja.coy.workers.dev/learn', {
  method: 'POST',
  body: JSON.stringify({
    trigger: 'what went wrong',
    learning: 'what to do instead',
    source: `gate:${story.id}`
  })
});
```

### In AGENTS.md

```markdown
## Memory

Before starting work, query deja for relevant learnings:

curl -X POST https://deja.coy.workers.dev/inject \
  -d '{"context": "<current task description>", "format": "prompt"}'

After failures, store what you learned:

curl -X POST https://deja.coy.workers.dev/learn \
  -d '{"trigger": "...", "learning": "...", "source": "..."}'
```

## License

MIT
