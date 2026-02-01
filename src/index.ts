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

    // Forward all requests to the Durable Object
    return await stub.fetch(request);
  },
};

function getUserIdFromApiKey(apiKey: string | undefined, authHeader: string | null): string {
  if (!apiKey || !authHeader) return 'anonymous';
  const providedKey = authHeader?.replace('Bearer ', '');
  // If API key is provided and matches, use it as the user ID for isolation
  // Otherwise, use 'anonymous'
  return providedKey === apiKey ? providedKey : 'anonymous';
}