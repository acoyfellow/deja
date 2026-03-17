# deja

> Persistent memory for agents. Store learnings, recall context.

[Docs](https://deja.coey.dev/docs) · [Quickstart](https://deja.coey.dev/guides/quickstart)

## What Deja does

Agents learn from runs. Deja remembers across them.

- **Learn** — store a learning with trigger, context, and confidence
- **Recall** — semantic search returns relevant learnings before the next run
- **Working state** — live snapshots and event streams for in-progress work
- **Scoped** — learnings are isolated by scope (`shared`, `agent:<id>`, `session:<id>`, or custom)

## Install

### As part of filepath (recommended)

Deja is an npm-installable Cloudflare Worker. When used with [filepath](https://github.com/acoyfellow/filepath), add it to `alchemy.run.ts` and it deploys alongside your filepath instance. See the [filepath README](https://github.com/acoyfellow/filepath#how-to-enable-memory-deja) for setup.

### Standalone

```bash
git clone https://github.com/acoyfellow/deja
cd deja
bun install
wrangler login
wrangler vectorize create deja-embeddings --dimensions 384 --metric cosine
wrangler secret put API_KEY
bun run deploy
```

## Connect

### REST

```
POST /learn         — store a learning
POST /inject        — recall relevant learnings for a context
POST /inject/trace  — recall with debug info
POST /query         — search learnings
GET  /learnings     — list learnings (filterable by scope)
GET  /stats         — counts by scope
```

### MCP

Any MCP-capable agent can connect:

```json
{
  "mcpServers": {
    "deja": {
      "type": "http",
      "url": "https://your-deja-instance.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${DEJA_API_KEY}"
      }
    }
  }
}
```

Integration guides: [Cursor](https://deja.coey.dev/integrations/cursor) · [Claude Code](https://deja.coey.dev/integrations/claude-code) · [GitHub Actions](https://deja.coey.dev/integrations/github-actions)

## API surface

- **Memory**: `/learn`, `/inject`, `/inject/trace`, `/query`, `/learnings`, `/learning/:id`, `/learning/:id/neighbors`, `/stats`, `DELETE /learning/:id`, `DELETE /learnings`
- **Working state**: `/state/:runId`, `/state/:runId/events`, `/state/:runId/resolve`
- **Secrets**: `/secret`, `/secret/:name`, `/secrets`

Learnings track `lastRecalledAt` and `recallCount`. Bulk delete supports filters: `?confidence_lt=0.5`, `?not_recalled_in_days=90`, `?scope=shared`.

Full reference: https://deja.coey.dev/docs

## Architecture

- **Runtime**: Cloudflare Worker + Durable Object (per-user SQLite)
- **Embeddings**: Workers AI (`@cf/baai/bge-small-en-v1.5`, 384 dimensions)
- **Search**: Cloudflare Vectorize (cosine similarity)
- **Auth**: optional `API_KEY` secret; open access if not set

## Reference

- Schema: `src/schema.ts`
- Worker entry: `src/index.ts`
- Durable Object: `src/do/DejaDO.ts`
- Client package: `packages/deja-client/`
- Architecture guide: https://deja.coey.dev/guides/architecture-and-self-hosting
