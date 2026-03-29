import type { APIRoute } from 'astro';

const llmsTxt = `# deja

deja is a self-hosted memory layer for agents.
It provides durable memory + optional live working state via REST and MCP.

## Quick facts
- MCP endpoint: /mcp
- Auth: Authorization: Bearer <API_KEY>
- Scopes: shared | agent:<id> | session:<id>
- Stack: Cloudflare Workers + Durable Objects + SQLite + Vectorize + Workers AI

## Diátaxis map

### Tutorial
- https://deja.coey.dev/guides/quickstart

### How-to
- https://deja.coey.dev/docs
- https://deja.coey.dev/integrations

### Reference
- https://deja.coey.dev/docs
- https://github.com/acoyfellow/deja/blob/main/docs/openapi-working-state.yaml

### Explanation
- https://deja.coey.dev/guides/architecture-and-self-hosting
- https://deja.coey.dev/use-cases

### Research
- https://deja.coey.dev/research
- https://deja.coey.dev/research/llms.txt

## Core API
- POST /learn
- POST /learning/:id/confirm
- POST /learning/:id/reject
- POST /inject
- POST /inject/trace
- POST /query
- POST /cleanup
- POST /run
- GET /learnings
- GET /learning/:id/neighbors
- GET /runs
- DELETE /learning/:id
- DELETE /learnings
- GET /stats
- GET|PUT|PATCH /state/:runId
- POST /state/:runId/events
- POST /state/:runId/resolve
- POST /secret
- GET /secret/:name
- DELETE /secret/:name
- GET /secrets

## MCP tools
- learn
- confirm
- reject
- inject
- inject_trace
- query
- forget
- forget_bulk
- learning_neighbors
- list
- stats
- state_put
- state_get
- state_patch
- state_resolve
- record_run
- get_runs
`;

export const GET: APIRoute = async () => {
  return new Response(llmsTxt, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
