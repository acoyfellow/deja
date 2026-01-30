/**
 * deja - persistent memory for agents
 * 
 * Agents learn from failures. Deja remembers.
 */

import { cleanup } from './cleanup';

interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  API_KEY?: string;
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

    // API Key authentication for write/delete operations (not query/inject)
    const needsAuth = (path === '/learn' && request.method === 'POST') || request.method === 'DELETE';
    if (needsAuth && env.API_KEY) {
      const authHeader = request.headers.get('Authorization');
      const providedKey = authHeader?.replace('Bearer ', '');
      if (providedKey !== env.API_KEY) {
        return new Response(
          JSON.stringify({ error: 'unauthorized - valid API key required for write operations' }),
          { status: 401, headers: corsHeaders }
        );
      }
    }

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
          }
        }), { headers: corsHeaders });
      }

      // Gate: learn-endpoint
      if (path === '/learn' && request.method === 'POST') {
        return await handleLearn(request, env, corsHeaders);
      }

      // Gate: query-endpoint
      if (path === '/query' && request.method === 'POST') {
        return await handleQuery(request, env, corsHeaders);
      }

      // Gate: inject-endpoint
      if (path === '/inject' && request.method === 'POST') {
        return await handleInject(request, env, corsHeaders);
      }

      // Gate: stats-endpoint
      if (path === '/stats' && request.method === 'GET') {
        return await handleStats(env, corsHeaders);
      }

      // GET /learnings - list all (paginated)
      if (path === '/learnings' && request.method === 'GET') {
        return await handleListLearnings(url, env, corsHeaders);
      }

      // GET /learning/:id - retrieve by ID (for testability)
      const learningMatch = path.match(/^\/learning\/([a-f0-9-]+)$/);
      if (learningMatch && request.method === 'GET') {
        return await handleGetLearning(learningMatch[1], env, corsHeaders);
      }

      // DELETE /learning/:id - delete a learning
      if (learningMatch && request.method === 'DELETE') {
        return await handleDeleteLearning(learningMatch[1], env, corsHeaders);
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

async function handleLearn(
  request: Request,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const body: any = await request.json();

  if (!body.trigger || !body.learning) {
    return new Response(
      JSON.stringify({ error: 'trigger and learning are required' }),
      { status: 400, headers }
    );
  }

  const id = crypto.randomUUID();
  let confidence = body.confidence ?? 1.0;
  
  // Validate confidence bounds
  if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
    return new Response(
      JSON.stringify({ error: 'confidence must be a number between 0 and 1' }),
      { status: 400, headers }
    );
  }
  const now = new Date().toISOString();

  const textToEmbed = `${body.trigger}: ${body.learning}`;
  const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: textToEmbed,
  });
  const embedding = embeddingResult.data[0];

  await env.DB.prepare(
    `INSERT INTO learnings (id, trigger, learning, reason, confidence, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, body.trigger, body.learning, body.reason ?? null, confidence, body.source ?? null, now)
    .run();

  await env.VECTORIZE.upsert([
    {
      id,
      values: embedding,
      metadata: {
        trigger: body.trigger,
        learning: body.learning,
        confidence,
      },
    },
  ]);

  return new Response(
    JSON.stringify({ id, status: 'stored' }),
    { headers }
  );
}

async function handleQuery(
  request: Request,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const body: any = await request.json();

  if (!body.context) {
    return new Response(
      JSON.stringify({ error: 'context is required' }),
      { status: 400, headers }
    );
  }

  const limit = body.limit ?? 5;
  const minConfidence = body.min_confidence ?? 0;

  const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: body.context,
  });
  const embedding = embeddingResult.data[0];

  const matches = await env.VECTORIZE.query(embedding, {
    topK: limit,
    returnMetadata: 'all',
  });

  const ids = matches.matches.map((m) => m.id);
  if (ids.length === 0) {
    return new Response(JSON.stringify({ learnings: [] }), { headers });
  }

  const placeholders = ids.map(() => '?').join(',');
  const results = await env.DB.prepare(
    `SELECT * FROM learnings WHERE id IN (${placeholders}) AND confidence >= ?`
  )
    .bind(...ids, minConfidence)
    .all();

  const scoreMap = new Map(matches.matches.map((m) => [m.id, m.score]));
  const learnings = results.results
    .map((r: any) => ({ ...r, score: scoreMap.get(r.id) ?? 0 }))
    .sort((a: any, b: any) => b.score - a.score);

  return new Response(JSON.stringify({ learnings }), { headers });
}

async function handleInject(
  request: Request,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const body: any = await request.json();

  if (!body.context) {
    return new Response(
      JSON.stringify({ error: 'context is required' }),
      { status: 400, headers }
    );
  }

  const limit = body.limit ?? 5;
  const format = body.format ?? 'structured';

  const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: body.context,
  });
  const embedding = embeddingResult.data[0];

  const matches = await env.VECTORIZE.query(embedding, {
    topK: limit,
    returnMetadata: 'all',
  });

  const ids = matches.matches.map((m) => m.id);
  if (ids.length === 0) {
    if (format === 'prompt') {
      return new Response(JSON.stringify({ injection: '' }), { headers });
    }
    return new Response(JSON.stringify({ injection: [] }), { headers });
  }

  const placeholders = ids.map(() => '?').join(',');
  const results = await env.DB.prepare(
    `SELECT * FROM learnings WHERE id IN (${placeholders})`
  )
    .bind(...ids)
    .all();

  const scoreMap = new Map(matches.matches.map((m) => [m.id, m.score]));
  const learnings = results.results
    .map((r: any) => ({ ...r, score: scoreMap.get(r.id) ?? 0 }))
    .sort((a: any, b: any) => b.score - a.score);

  if (format === 'prompt') {
    const lines = learnings.map(
      (l: any) =>
        `- ${l.trigger}: ${l.learning}${l.reason ? ` (${l.reason})` : ''}`
    );
    const injection = learnings.length > 0
      ? `## Relevant learnings from previous work:\n${lines.join('\n')}`
      : '';
    return new Response(JSON.stringify({ injection }), { headers });
  }

  return new Response(
    JSON.stringify({
      injection: learnings.map((l: any) => ({
        trigger: l.trigger,
        learning: l.learning,
        reason: l.reason,
        confidence: l.confidence,
      })),
    }),
    { headers }
  );
}

async function handleStats(
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT COUNT(*) as count, AVG(confidence) as avg_confidence FROM learnings`
  ).first();

  return new Response(
    JSON.stringify({
      total_learnings: result?.count ?? 0,
      avg_confidence: result?.avg_confidence ?? 0,
    }),
    { headers }
  );
}

async function handleGetLearning(
  id: string,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT * FROM learnings WHERE id = ?`
  ).bind(id).first();

  if (!result) {
    return new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers }
    );
  }

  return new Response(JSON.stringify(result), { headers });
}

async function handleListLearnings(
  url: URL,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const limit = parseInt(url.searchParams.get('limit') ?? '50');
  const offset = parseInt(url.searchParams.get('offset') ?? '0');

  const results = await env.DB.prepare(
    `SELECT id, trigger, learning, confidence, created_at FROM learnings 
     ORDER BY created_at DESC LIMIT ? OFFSET ?`
  ).bind(limit, offset).all();

  const countResult = await env.DB.prepare(
    `SELECT COUNT(*) as total FROM learnings`
  ).first();

  return new Response(JSON.stringify({
    learnings: results.results,
    total: countResult?.total ?? 0,
    limit,
    offset
  }), { headers });
}

async function handleDeleteLearning(
  id: string,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  // Check if exists
  const existing = await env.DB.prepare(
    `SELECT id FROM learnings WHERE id = ?`
  ).bind(id).first();

  if (!existing) {
    return new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers }
    );
  }

  // Delete from D1
  await env.DB.prepare(
    `DELETE FROM learnings WHERE id = ?`
  ).bind(id).run();

  // Delete from Vectorize
  await env.VECTORIZE.deleteByIds([id]);

  return new Response(
    JSON.stringify({ status: 'deleted', id }),
    { headers }
  );
}

// Cron trigger for daily cleanup
export const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env) => {
  const result = await cleanup(env);
  console.log(`Cleanup: deleted ${result.deleted} entries`, result.reasons);
};
