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
- POST /inject
- POST /query
- GET /learnings
- DELETE /learning/:id
- GET /stats
- GET|PUT|PATCH /state/:runId
- POST /state/:runId/events
- POST /state/:runId/resolve
- POST /secret
- GET /secret/:name

## MCP tools
- learn
- inject
- query
- forget
- list
- stats
- state_put
- state_get
- state_patch
- state_resolve
`;

export const GET: APIRoute = async () => {
  return new Response(llmsTxt, {
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
};
