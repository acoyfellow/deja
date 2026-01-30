/**
 * deja - persistent memory for agents
 * 
 * Agents learn from failures. Deja remembers.
 */

export interface Env {
  DB: D1Database;
  VECTORIZE: VectorizeIndex;
  AI: Ai;
}

interface Learning {
  id?: string;
  trigger: string;
  learning: string;
  reason?: string;
  confidence?: number;
  source?: string;
  created_at?: string;
}

interface QueryRequest {
  context: string;
  limit?: number;
  min_confidence?: number;
}

interface InjectRequest {
  context: string;
  limit?: number;
  format?: 'structured' | 'prompt';
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers for agent access
    const corsHeaders = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      if (path === '/' && request.method === 'GET') {
        return new Response(JSON.stringify({
          name: 'deja',
          version: '0.1.0',
          description: 'persistent memory for agents',
          endpoints: {
            'POST /learn': 'Store a learning',
            'POST /query': 'Semantic search for learnings',
            'POST /inject': 'Get learnings formatted for context injection',
            'GET /stats': 'Get memory statistics',
          }
        }), { headers: corsHeaders });
      }

      if (path === '/learn' && request.method === 'POST') {
        return await handleLearn(request, env, corsHeaders);
      }

      if (path === '/query' && request.method === 'POST') {
        return await handleQuery(request, env, corsHeaders);
      }

      if (path === '/inject' && request.method === 'POST') {
        return await handleInject(request, env, corsHeaders);
      }

      if (path === '/stats' && request.method === 'GET') {
        return await handleStats(env, corsHeaders);
      }

      return new Response(JSON.stringify({ error: 'not found' }), {
        status: 404,
        headers: corsHeaders,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
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
  const body: Learning = await request.json();

  if (!body.trigger || !body.learning) {
    return new Response(
      JSON.stringify({ error: 'trigger and learning are required' }),
      { status: 400, headers }
    );
  }

  const id = crypto.randomUUID();
  const confidence = body.confidence ?? 1.0;
  const now = new Date().toISOString();

  // Generate embedding for the trigger + learning
  const textToEmbed = `${body.trigger}: ${body.learning}`;
  const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: textToEmbed,
  });
  const embedding = embeddingResult.data[0];

  // Store in D1
  await env.DB.prepare(
    `INSERT INTO learnings (id, trigger, learning, reason, confidence, source, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(id, body.trigger, body.learning, body.reason ?? null, confidence, body.source ?? null, now)
    .run();

  // Store in Vectorize
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
  const body: QueryRequest = await request.json();

  if (!body.context) {
    return new Response(
      JSON.stringify({ error: 'context is required' }),
      { status: 400, headers }
    );
  }

  const limit = body.limit ?? 5;
  const minConfidence = body.min_confidence ?? 0;

  // Generate embedding for the query
  const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: body.context,
  });
  const embedding = embeddingResult.data[0];

  // Query Vectorize
  const matches = await env.VECTORIZE.query(embedding, {
    topK: limit,
    returnMetadata: 'all',
  });

  // Fetch full records from D1
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

  // Sort by vector similarity score
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
  const body: InjectRequest = await request.json();

  if (!body.context) {
    return new Response(
      JSON.stringify({ error: 'context is required' }),
      { status: 400, headers }
    );
  }

  const limit = body.limit ?? 5;
  const format = body.format ?? 'structured';

  // Generate embedding for the query
  const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: body.context,
  });
  const embedding = embeddingResult.data[0];

  // Query Vectorize
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
    // Format as text for prompt injection
    const lines = learnings.map(
      (l: any) =>
        `- ${l.trigger}: ${l.learning}${l.reason ? ` (${l.reason})` : ''}`
    );
    const injection = learnings.length > 0
      ? `## Relevant learnings from previous work:\n${lines.join('\n')}`
      : '';
    return new Response(JSON.stringify({ injection }), { headers });
  }

  // Structured format
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
