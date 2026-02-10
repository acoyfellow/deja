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
  ASSETS: Fetcher;
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
      },
      required: ['trigger', 'learning'],
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
