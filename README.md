# deja 0.05

*What survives a run.*

deja is a self-hosted memory layer for agents.
It exposes durable memory via REST + MCP, with scoped recall and optional live working state.

In 0.05, Deja is the memory rail in a three-layer stack:

- filepath does bounded work
- Gateproof decides whether the work is true
- Deja carries recall and working state across runs

Shared run identity is now part of that contract: learnings and working state can carry `traceId`, `workspaceId`, `conversationId`, `runId`, `proofRunId`, and `proofIterationId`.

## Start here

### 1) Tutorial (learning-oriented)
- **Quickstart**: https://deja.coey.dev/guides/quickstart

### 2) How-to guides (task-oriented)
- **Connect an MCP client**: https://deja.coey.dev/docs
- **Integrations index**: https://deja.coey.dev/integrations
- **Cursor integration**: https://deja.coey.dev/integrations/cursor
- **Claude Code integration**: https://deja.coey.dev/integrations/claude-code
- **GitHub Actions integration**: https://deja.coey.dev/integrations/github-actions

### 3) Reference (information-oriented)
- **REST + MCP reference**: https://deja.coey.dev/docs
- **OpenAPI (working state)**: `docs/openapi-working-state.yaml`
- **Drizzle schema source of truth**: `src/schema.ts`
- **Migration artifacts**: `drizzle/`

### 4) Explanation (understanding-oriented)
- **Architecture & self-hosting**: https://deja.coey.dev/guides/architecture-and-self-hosting
- **Use cases**: https://deja.coey.dev/use-cases

---

## Minimal deploy

```bash
git clone https://github.com/acoyfellow/deja
cd deja
bun install
wrangler login
wrangler vectorize create deja-embeddings --dimensions 384 --metric cosine
wrangler secret put API_KEY
bun run deploy
```

---

## Minimal MCP config (agent-agnostic)

Any MCP-capable agent can connect to:

- Endpoint: `https://<your-host>/mcp`
- Header: `Authorization: Bearer <API_KEY>`

Example:

```json
{
  "mcpServers": {
    "deja": {
      "type": "http",
      "url": "https://deja.your-subdomain.workers.dev/mcp",
      "headers": {
        "Authorization": "Bearer ${DEJA_API_KEY}"
      }
    }
  }
}
```

---

## Core API surface

- Memory: `/learn`, `/inject`, `/inject/trace`, `/query`, `/learnings`, `/learning/:id`, `/learning/:id/neighbors`, `/stats`, `DELETE /learning/:id`, `DELETE /learnings`
- Working state: `/state/:runId`, `/state/:runId/events`, `/state/:runId/resolve`
- Secrets: `/secret`, `/secret/:name`, `/secrets`

Learnings include `last_recalled_at`, `recall_count` for tracking. Bulk delete: `DELETE /learnings?confidence_lt=0.5` or `?not_recalled_in_days=90` or `?scope=shared` (requires at least one filter).

For full payloads and examples, use: https://deja.coey.dev/docs
