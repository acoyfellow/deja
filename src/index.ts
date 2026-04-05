/**
 * deja - persistent memory for agents
 *
 * Agents learn from failures. Deja remembers.
 */

import { DejaDO } from './do/DejaDO';
import { cleanup } from './cleanup';

interface Env {
  DEJA: DurableObjectNamespace;
  API_KEY?: string;
  VECTORIZE: VectorizeIndex;
  AI: any;
  ASSETS?: Fetcher;
}

export { DejaDO };

// MCP Tool definitions
const MCP_TOOLS = [
  {
    name: 'learn',
    description: 'Store a learning for future recall. Use after completing tasks, encountering issues, or when the user says "remember this".',
    inputSchema: {
      type: 'object',
      properties: {
        trigger: { type: 'string', description: 'When this learning applies (e.g., "deploying to production")' },
        learning: { type: 'string', description: 'What was learned (e.g., "always run dry-run first")' },
        confidence: { type: 'number', description: 'Confidence level 0-1 (default 0.8)', default: 0.8 },
        scope: { type: 'string', description: 'Memory scope: "shared", "agent:<id>", or "session:<id>"', default: 'shared' },
        reason: { type: 'string', description: 'Why this was learned' },
        source: { type: 'string', description: 'Source identifier' },
        noveltyThreshold: { type: 'number', description: 'Novelty merge threshold. Default 0.95, set 0 to disable.' },
        proof_run_id: { type: 'string', description: 'Optional proof run identifier for the learning evidence' },
        proof_iteration_id: { type: 'string', description: 'Optional proof iteration identifier for the learning evidence' },
      },
      required: ['trigger', 'learning'],
    },
  },
  {
    name: 'confirm',
    description: 'Boost a memory confidence score after it proves useful.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Learning ID to confirm' },
        proof_run_id: { type: 'string', description: 'Optional proof run identifier for the confirming evidence' },
        proof_iteration_id: { type: 'string', description: 'Optional proof iteration identifier for the confirming evidence' },
      },
      required: ['id'],
    },
  },
  {
    name: 'reject',
    description: 'Reduce a memory confidence score after it proves wrong or stale. May invert into an anti-pattern warning.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Learning ID to reject' },
        proof_run_id: { type: 'string', description: 'Optional proof run identifier for the rejecting evidence' },
        proof_iteration_id: { type: 'string', description: 'Optional proof iteration identifier for the rejecting evidence' },
      },
      required: ['id'],
    },
  },
  {
    name: 'inject',
    description: 'Retrieve relevant memories for the current context. Use before starting tasks to get helpful context.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Current context to find relevant memories for' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes to search', default: ['shared'] },
        limit: { type: 'number', description: 'Max memories to return', default: 5 },
        includeState: { type: 'boolean', description: 'Include live working state in prompt', default: false },
        runId: { type: 'string', description: 'Run/session ID when includeState is true' },
        search: {
          type: 'string',
          enum: ['vector', 'text', 'hybrid'],
          description: 'Search mode. Hosted defaults to hybrid.',
        },
      },
      required: ['context'],
    },
  },
  {
    name: 'inject_trace',
    description: 'Debug retrieval pipeline: returns candidates, similarity scores, threshold filtering. Use to understand why agents recall what they recall.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Current context to find relevant memories for' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes to search', default: ['shared'] },
        limit: { type: 'number', description: 'Max memories to return', default: 5 },
        threshold: { type: 'number', description: 'Minimum similarity score (0-1). Memories below this are marked rejected.', default: 0 },
      },
      required: ['context'],
    },
  },
  {
    name: 'query',
    description: 'Search memories semantically. Use when looking for specific past learnings.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes to search', default: ['shared'] },
        limit: { type: 'number', description: 'Max results', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'forget',
    description: 'Delete a specific learning by ID. Use to remove outdated or incorrect memories.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Learning ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'forget_bulk',
    description: 'Bulk delete memories by filters. Requires at least one filter. Use to prune stale or low-confidence memories.',
    inputSchema: {
      type: 'object',
      properties: {
        confidence_lt: { type: 'number', description: 'Delete memories with confidence below this' },
        not_recalled_in_days: { type: 'number', description: 'Delete memories not recalled in this many days' },
        scope: { type: 'string', description: 'Delete only memories in this scope' },
      },
    },
  },
  {
    name: 'learning_neighbors',
    description: 'Find semantically similar memories for a learning. Use to check for contradictions or overlap before saving new memories.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Learning ID to find neighbors for' },
        threshold: { type: 'number', description: 'Minimum cosine similarity (0-1)', default: 0.85 },
        limit: { type: 'number', description: 'Max neighbors to return', default: 10 },
      },
      required: ['id'],
    },
  },
  {
    name: 'list',
    description: 'List all memories, optionally filtered by scope.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Filter by scope' },
        limit: { type: 'number', description: 'Max results', default: 20 },
      },
    },
  },
  {
    name: 'stats',
    description: 'Get memory statistics including counts by scope.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'state_put',
    description: 'Upsert live working state for a run/session.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        goal: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'object' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        next_actions: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' },
        updatedBy: { type: 'string' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'state_get',
    description: 'Fetch live working state for a run/session.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
  },
  {
    name: 'state_patch',
    description: 'Patch live working state for a run/session.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        patch: { type: 'object' },
        updatedBy: { type: 'string' },
      },
      required: ['runId', 'patch'],
    },
  },
  {
    name: 'state_resolve',
    description: 'Resolve a run/session state and optionally persist compact learnings.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        persistToLearn: { type: 'boolean', default: false },
        scope: { type: 'string', default: 'shared' },
        summaryStyle: { type: 'string', enum: ['compact', 'full'], default: 'compact' },
        updatedBy: { type: 'string' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'record_run',
    description: 'Record the outcome of an optimization loop run. Automatically fires learn() to persist the result as a memory for future runs.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['pass', 'fail', 'exhausted'], description: 'Run outcome' },
        attempts: { type: 'number', description: 'Number of attempts taken' },
        scope: { type: 'string', description: 'Memory scope', default: 'shared' },
        code: { type: 'string', description: 'Code produced by the run (stored truncated at 500 chars in memory)' },
        error: { type: 'string', description: 'Error message if outcome is fail or exhausted' },
      },
      required: ['outcome', 'attempts'],
    },
  },
  {
    name: 'get_runs',
    description: 'Get run history and convergence stats for an optimization loop.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Filter by scope' },
        limit: { type: 'number', description: 'Max runs to return', default: 50 },
      },
    },
  },
];

// Handle MCP tool calls
async function handleMcpToolCall(stub: DurableObjectStub, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'learn': {
      const response = await stub.fetch(new Request('http://internal/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: args.trigger,
          learning: args.learning,
          confidence: args.confidence ?? 0.8,
          scope: args.scope ?? 'shared',
          reason: args.reason,
          source: args.source,
          noveltyThreshold: args.noveltyThreshold,
          proof_run_id: args.proof_run_id,
          proof_iteration_id: args.proof_iteration_id,
        }),
      }));
      return response.json();
    }
    case 'confirm': {
      const response = await stub.fetch(new Request(`http://internal/learning/${args.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proof_run_id: args.proof_run_id,
          proof_iteration_id: args.proof_iteration_id,
        }),
      }));
      return response.json();
    }
    case 'reject': {
      const response = await stub.fetch(new Request(`http://internal/learning/${args.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proof_run_id: args.proof_run_id,
          proof_iteration_id: args.proof_iteration_id,
        }),
      }));
      return response.json();
    }
    case 'inject': {
      const response = await stub.fetch(new Request('http://internal/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: args.context,
          scopes: args.scopes ?? ['shared'],
          limit: args.limit ?? 5,
          includeState: args.includeState ?? false,
          runId: args.runId,
          search: args.search,
        }),
      }));
      return response.json();
    }
    case 'inject_trace': {
      const url = new URL('http://internal/inject/trace');
      if (args.threshold != null) url.searchParams.set('threshold', String(args.threshold));
      const response = await stub.fetch(new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: args.context,
          scopes: args.scopes ?? ['shared'],
          limit: args.limit ?? 5,
          threshold: args.threshold,
        }),
      }));
      return response.json();
    }
    case 'query': {
      const response = await stub.fetch(new Request('http://internal/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: args.query,
          scopes: args.scopes ?? ['shared'],
          limit: args.limit ?? 10,
        }),
      }));
      return response.json();
    }
    case 'forget': {
      const response = await stub.fetch(new Request(`http://internal/learning/${args.id}`, {
        method: 'DELETE',
      }));
      return response.json();
    }
    case 'learning_neighbors': {
      const params = new URLSearchParams();
      if (args.threshold != null) params.set('threshold', String(args.threshold));
      if (args.limit != null) params.set('limit', String(args.limit));
      const response = await stub.fetch(new Request(`http://internal/learning/${args.id}/neighbors?${params}`));
      return response.json();
    }
    case 'forget_bulk': {
      const params = new URLSearchParams();
      if (args.confidence_lt != null) params.set('confidence_lt', String(args.confidence_lt));
      if (args.not_recalled_in_days != null) params.set('not_recalled_in_days', String(args.not_recalled_in_days));
      if (args.scope != null) params.set('scope', args.scope);
      const response = await stub.fetch(new Request(`http://internal/learnings?${params}`, { method: 'DELETE' }));
      return response.json();
    }
    case 'list': {
      const params = new URLSearchParams();
      if (args.scope) params.set('scope', args.scope);
      if (args.limit) params.set('limit', String(args.limit));
      const response = await stub.fetch(new Request(`http://internal/learnings?${params}`));
      return response.json();
    }
    case 'stats': {
      const response = await stub.fetch(new Request('http://internal/stats'));
      return response.json();
    }
    case 'state_get': {
      const response = await stub.fetch(new Request(`http://internal/state/${args.runId}`));
      return response.json();
    }
    case 'state_put': {
      const { runId, ...payload } = args;
      const response = await stub.fetch(new Request(`http://internal/state/${runId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }));
      return response.json();
    }
    case 'state_patch': {
      const response = await stub.fetch(new Request(`http://internal/state/${args.runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(args.patch || {}), updatedBy: args.updatedBy }),
      }));
      return response.json();
    }
    case 'state_resolve': {
      const response = await stub.fetch(new Request(`http://internal/state/${args.runId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persistToLearn: args.persistToLearn ?? false,
          scope: args.scope ?? 'shared',
          summaryStyle: args.summaryStyle ?? 'compact',
          updatedBy: args.updatedBy,
        }),
      }));
      return response.json();
    }
    case 'record_run': {
      const response = await stub.fetch(new Request('http://internal/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome: args.outcome,
          attempts: args.attempts,
          scope: args.scope ?? 'shared',
          code: args.code,
          error: args.error,
        }),
      }));
      return response.json();
    }
    case 'get_runs': {
      const params = new URLSearchParams();
      if (args.scope) params.set('scope', args.scope);
      if (args.limit) params.set('limit', String(args.limit));
      const response = await stub.fetch(new Request(`http://internal/runs?${params}`));
      return response.json();
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// Handle MCP JSON-RPC requests
async function handleMcpRequest(request: Request, stub: DurableObjectStub): Promise<Response> {
  const body = await request.json() as any;
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== '2.0') {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'Invalid Request - must be JSON-RPC 2.0' },
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  try {
    let result: any;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: 'deja', version: '1.0.0' },
        };
        break;

      case 'tools/list':
        result = { tools: MCP_TOOLS };
        break;

      case 'tools/call': {
        const { name, arguments: args } = params;
        const toolResult = await handleMcpToolCall(stub, name, args || {});
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
        };
        break;
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        // These are notifications, no response needed
        return new Response(null, { status: 204 });

      default:
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: error.message || 'Internal error' },
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}

function getUserIdFromApiKey(apiKey: string | undefined, authHeader: string | null): string {
  if (!apiKey || !authHeader) return 'anonymous';
  const providedKey = authHeader?.replace('Bearer ', '');
  // If API key is provided and matches, use it as the user ID for isolation
  // Otherwise, use 'anonymous'
  return providedKey === apiKey ? providedKey : 'anonymous';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    // Marketing domain: serve static Astro site, no auth required
    if (url.hostname === 'deja.coey.dev') {
      if (!env.ASSETS) {
        return new Response('Marketing site not configured', { status: 404, headers: corsHeaders });
      }
      return env.ASSETS.fetch(request);
    }

    // API domain (deja-api.coey.dev, workers.dev, localhost, etc.)
    // All routes require authentication
    const checkAuth = (): boolean => {
      if (!env.API_KEY) return true; // No API key configured = open access
      const authHeader = request.headers.get('Authorization');
      const providedKey = authHeader?.replace('Bearer ', '');
      return providedKey === env.API_KEY;
    };

    if (!checkAuth()) {
      return new Response(
        JSON.stringify({ error: 'unauthorized - API key required' }),
        { status: 401, headers: corsHeaders }
      );
    }

    // Get user ID from API key or use 'anonymous'
    const userId = getUserIdFromApiKey(env.API_KEY, request.headers.get('Authorization'));
    const stub = env.DEJA.get(env.DEJA.idFromName(userId));

    // MCP endpoint - Model Context Protocol
    if (path === '/mcp' && request.method === 'POST') {
      return handleMcpRequest(request, stub);
    }

    // MCP discovery endpoint
    if (path === '/mcp' && request.method === 'GET') {
      return new Response(JSON.stringify({
        name: 'deja',
        version: '1.0.0',
        description: 'Persistent memory for agents. Store learnings, recall context.',
        protocol: 'mcp',
        endpoint: `${url.origin}/mcp`,
        tools: MCP_TOOLS.map(t => t.name),
      }), { headers: corsHeaders });
    }

    // Health check at API root
    if (path === '/') {
      return new Response(JSON.stringify({ status: 'ok', service: 'deja' }), { headers: corsHeaders });
    }

    // Forward all other requests to the Durable Object
    return await stub.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Run cleanup daily
    try {
      const result = await cleanup(env);
      console.log(`Cleanup completed: ${result.deleted} entries deleted`, result.reasons);
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
  },
};
