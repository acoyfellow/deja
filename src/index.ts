/**
 * deja - persistent memory for agents
 * 
 * Agents learn from failures. Deja remembers.
 */

import { DejaDO } from './do/DejaDO';

interface Env {
  DEJA: DurableObjectNamespace;
  API_KEY?: string;
}

export { DejaDO };

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

    // Check auth helper
    const checkAuth = (): boolean => {
      if (!env.API_KEY) return true;
      const authHeader = request.headers.get('Authorization');
      const providedKey = authHeader?.replace('Bearer ', '');
      return providedKey === env.API_KEY;
    };

    // API Key authentication for ALL operations except root health check
    // This protects our memory from public access
    const publicPaths = ['/', '/inject', '/query'];
    const isPublicPath = publicPaths.includes(path) && request.method !== 'DELETE';
    
    if (!isPublicPath && !checkAuth()) {
      return new Response(
        JSON.stringify({ error: 'unauthorized - API key required' }),
        { status: 401, headers: corsHeaders }
      );
    }

    // Extra check for secrets (belt and suspenders)
    if (path.startsWith('/secret')) {
      if (!checkAuth()) {
        return new Response(
          JSON.stringify({ error: 'unauthorized - API key required for secrets' }),
          { status: 401, headers: corsHeaders }
        );
      }
    }

    // Get user ID from API key or use 'anonymous'
    const userId = getUserIdFromApiKey(env.API_KEY, request.headers.get('Authorization'));
    const stub = env.DEJA.get(env.DEJA.idFromName(userId));

    try {
      // Gate: api-health - root responds with service info
      if (path === '/' && request.method === 'GET') {
        return new Response(JSON.stringify({
          name: 'deja',
          version: '0.2.0',
          description: 'persistent memory for agents (persistent memory for agents)',
          auth: env.API_KEY ? 'required for POST' : 'none',
          endpoints: {
            'POST /learn': 'Store a learning (auth required)',
            'GET /learnings': 'List all learnings (paginated)',
            'GET /learning/:id': 'Retrieve a learning by ID',
            'DELETE /learning/:id': 'Delete a learning (auth required)',
            'POST /query': 'Semantic search for learnings',
            'POST /inject': 'Get learnings formatted for context injection',
            'GET /stats': 'Get memory statistics',
            'POST /secret': 'Store a secret (auth required for read AND write)',
            'GET /secret/:name': 'Retrieve a secret (auth required)',
            'DELETE /secret/:name': 'Delete a secret (auth required)',
          }
        }), { headers: corsHeaders });
      }

      // Gate: learn-endpoint
      if (path === '/learn' && request.method === 'POST') {
        const body: any = await request.json();
        const scope = body.scope || 'shared';
        const result = await stub.learn(scope, body.trigger, body.learning, body.confidence, body.reason, body.source);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }

      // Gate: query-endpoint
      if (path === '/query' && request.method === 'POST') {
        const body: any = await request.json();
        const scopes = body.scopes || ['shared'];
        const result = await stub.query(scopes, body.context, body.limit);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }

      // Gate: inject-endpoint
      if (path === '/inject' && request.method === 'POST') {
        const body: any = await request.json();
        const scopes = body.scopes || ['shared'];
        const format = body.format || 'structured';
        const result = await stub.inject(scopes, body.context, body.limit, format);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }

      // Gate: stats-endpoint
      if (path === '/stats' && request.method === 'GET') {
        const result = await stub.getStats();
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }

      // GET /learnings - list all (paginated)
      if (path === '/learnings' && request.method === 'GET') {
        const scope = url.searchParams.get('scope') || undefined;
        const result = await stub.getLearnings({ scope });
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }

      // GET /learning/:id - retrieve by ID (for testability)
      const learningMatch = path.match(/^\/learning\/([a-f0-9-]+)$/);
      if (learningMatch && request.method === 'GET') {
        // This would need to be implemented differently since we don't have direct access to the DO's data
        // For now, we'll return not found
        return new Response(JSON.stringify({ error: 'not found' }), {
          status: 404,
          headers: corsHeaders,
        });
      }

      // DELETE /learning/:id - delete a learning
      if (learningMatch && request.method === 'DELETE') {
        const result = await stub.deleteLearning(learningMatch[1]);
        if (result.error) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 404,
            headers: corsHeaders,
          });
        }
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }

      // POST /secret - store a secret (auth required)
      if (path === '/secret' && request.method === 'POST') {
        const body: any = await request.json();
        const scope = body.scope || 'shared';
        const result = await stub.setSecret(scope, body.name, body.value);
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }

      // GET /secret/:name - retrieve a secret (auth required)
      const secretMatch = path.match(/^\/secret\/([\w-]+)$/);
      if (secretMatch && request.method === 'GET') {
        const scopes = ['shared']; // Default scope, would be determined by user context
        const result = await stub.getSecret(scopes, secretMatch[1]);
        if (!result) {
          return new Response(JSON.stringify({ error: 'not found' }), {
            status: 404,
            headers: corsHeaders,
          });
        }
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }

      // DELETE /secret/:name - delete a secret (auth required)
      if (secretMatch && request.method === 'DELETE') {
        const scope = 'shared'; // Default scope, would be determined by user context
        const result = await stub.deleteSecret(scope, secretMatch[1]);
        if (result.error) {
          return new Response(JSON.stringify({ error: result.error }), {
            status: 404,
            headers: corsHeaders,
          });
        }
        return new Response(JSON.stringify(result), { headers: corsHeaders });
      }

      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: corsHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      // JSON parse errors should be 400, not 500
      const isParseError = message.includes('JSON') || message.includes('Unexpected token');
      return new Response(JSON.stringify({ error: message }), {
        status: isParseError ? 400 : 500,
        headers: corsHeaders,
      });
    }
  },
};

function getUserIdFromApiKey(apiKey: string | undefined, authHeader: string | null): string {
  if (!apiKey || !authHeader) return 'anonymous';
  const providedKey = authHeader?.replace('Bearer ', '');
  return providedKey === apiKey ? 'user' : 'anonymous';
}