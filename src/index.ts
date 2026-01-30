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

    // Check auth helper
    const checkAuth = (): boolean => {
      if (!env.API_KEY) return true;
      const authHeader = request.headers.get('Authorization');
      const providedKey = authHeader?.replace('Bearer ', '');
      return providedKey === env.API_KEY;
    };

    // API Key authentication for write/delete operations (not query/inject)
    const needsAuth = (path === '/learn' && request.method === 'POST') || request.method === 'DELETE';
    if (needsAuth && !checkAuth()) {
      return new Response(
        JSON.stringify({ error: 'unauthorized - valid API key required for write operations' }),
        { status: 401, headers: corsHeaders }
      );
    }

    // Secrets require auth for ALL operations (read and write)
    if (path.startsWith('/secret')) {
      if (!checkAuth()) {
        return new Response(
          JSON.stringify({ error: 'unauthorized - API key required for secrets' }),
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
            'POST /secret': 'Store a secret (auth required for read AND write)',
            'GET /secret/:name': 'Retrieve a secret (auth required)',
            'DELETE /secret/:name': 'Delete a secret (auth required)',
            'POST /evaluate': 'AI-evaluate a proposed action against stored failures',
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

      // Gate: evaluate-endpoint - AI-based action evaluation
      if (path === '/evaluate' && request.method === 'POST') {
        return await handleEvaluate(request, env, corsHeaders);
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

      // POST /secret - store a secret (auth required)
      if (path === '/secret' && request.method === 'POST') {
        return await handleStoreSecret(request, env, corsHeaders);
      }

      // GET /secret/:name - retrieve a secret (auth required)
      const secretMatch = path.match(/^\/secret\/([\w-]+)$/);
      if (secretMatch && request.method === 'GET') {
        return await handleGetSecret(secretMatch[1], env, corsHeaders);
      }

      // DELETE /secret/:name - delete a secret (auth required)
      if (secretMatch && request.method === 'DELETE') {
        return await handleDeleteSecret(secretMatch[1], env, corsHeaders);
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

// --- Secret handlers (authenticated read/write) ---

async function handleStoreSecret(
  request: Request,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const body: any = await request.json();

  if (!body.name || !body.value) {
    return new Response(
      JSON.stringify({ error: 'name and value are required' }),
      { status: 400, headers }
    );
  }

  // Validate name format (alphanumeric, dashes, underscores)
  if (!/^[\w-]+$/.test(body.name)) {
    return new Response(
      JSON.stringify({ error: 'name must be alphanumeric with dashes/underscores only' }),
      { status: 400, headers }
    );
  }

  const now = new Date().toISOString();

  // Upsert the secret
  await env.DB.prepare(
    `INSERT INTO secrets (name, value, created_at, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(name) DO UPDATE SET value = ?, updated_at = ?`
  )
    .bind(body.name, body.value, now, now, body.value, now)
    .run();

  return new Response(
    JSON.stringify({ name: body.name, status: 'stored' }),
    { headers }
  );
}

async function handleGetSecret(
  name: string,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT * FROM secrets WHERE name = ?`
  ).bind(name).first();

  if (!result) {
    return new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers }
    );
  }

  return new Response(
    JSON.stringify({ name: result.name, value: result.value }),
    { headers }
  );
}

async function handleDeleteSecret(
  name: string,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const existing = await env.DB.prepare(
    `SELECT name FROM secrets WHERE name = ?`
  ).bind(name).first();

  if (!existing) {
    return new Response(
      JSON.stringify({ error: 'not found' }),
      { status: 404, headers }
    );
  }

  await env.DB.prepare(
    `DELETE FROM secrets WHERE name = ?`
  ).bind(name).run();

  return new Response(
    JSON.stringify({ status: 'deleted', name }),
    { headers }
  );
}

async function handleEvaluate(
  request: Request,
  env: Env,
  headers: Record<string, string>
): Promise<Response> {
  const body: any = await request.json();

  if (!body.action) {
    return new Response(
      JSON.stringify({ error: 'action is required' }),
      { status: 400, headers }
    );
  }

  const action = body.action;

  // Query memory for relevant failures
  const embeddingResult = await env.AI.run('@cf/baai/bge-base-en-v1.5', {
    text: action,
  });
  const embedding = embeddingResult.data[0];

  const matches = await env.VECTORIZE.query(embedding, {
    topK: 5,
    returnMetadata: 'all',
  });

  const ids = matches.matches.map((m) => m.id);
  let learnings: any[] = [];
  
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(',');
    const results = await env.DB.prepare(
      `SELECT * FROM learnings WHERE id IN (${placeholders})`
    ).bind(...ids).all();
    
    const scoreMap = new Map(matches.matches.map((m) => [m.id, m.score]));
    learnings = results.results
      .map((r: any) => ({ ...r, score: scoreMap.get(r.id) ?? 0 }))
      .filter((l: any) => l.score > 0.5) // Only high relevance
      .sort((a: any, b: any) => b.score - a.score);
  }

  // Build context for AI evaluation
  const memoryContext = learnings.length > 0
    ? learnings.map(l => `- ${l.trigger}: ${l.learning}`).join('\n')
    : 'No relevant past failures found.';

  // Use AI to evaluate
  const prompt = `You are a code review critic. Evaluate this proposed action against past failures.

PROPOSED ACTION: ${action}

RELEVANT PAST FAILURES/LEARNINGS:
${memoryContext}

Respond with ONLY valid JSON (no markdown, no explanation):
{
  "verdict": "STOP" | "CAUTION" | "PROCEED",
  "confidence": 0.0-1.0,
  "reasons": ["reason1", "reason2"],
  "suggestions": ["suggestion1"]
}

STOP = high risk of repeating a past failure
CAUTION = some risk, proceed carefully
PROCEED = no obvious risks detected`;

  try {
    const aiResult = await env.AI.run('@cf/meta/llama-3.1-8b-instruct', {
      prompt,
      max_tokens: 300,
    });

    // Parse AI response
    const responseText = (aiResult as any).response || '';
    
    // Extract JSON from response (handle markdown code blocks)
    let jsonStr = responseText;
    const jsonMatch = responseText.match(/```(?:json)?\s*([\s\S]*?)```/) || 
                      responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1] || jsonMatch[0];
    }
    
    const evaluation = JSON.parse(jsonStr.trim());
    
    return new Response(JSON.stringify({
      action: action.slice(0, 100),
      verdict: evaluation.verdict || 'PROCEED',
      confidence: evaluation.confidence || 0.5,
      reasons: evaluation.reasons || [],
      suggestions: evaluation.suggestions || [],
      memory_matches: learnings.length,
    }), { headers });
    
  } catch (parseErr) {
    // If AI response can't be parsed, fall back to simple heuristics
    const hasFailureMatch = learnings.some(l => 
      l.learning.toLowerCase().includes('failure') ||
      l.learning.toLowerCase().includes('prevention')
    );
    
    return new Response(JSON.stringify({
      action: action.slice(0, 100),
      verdict: hasFailureMatch ? 'CAUTION' : 'PROCEED',
      confidence: 0.5,
      reasons: hasFailureMatch 
        ? ['Found relevant past failures in memory']
        : ['No relevant failures found'],
      suggestions: hasFailureMatch
        ? ['Review the memory matches before proceeding']
        : [],
      memory_matches: learnings.length,
      fallback: true,
    }), { headers });
  }
}

// Cron trigger for daily cleanup
export const scheduled: ExportedHandlerScheduledHandler<Env> = async (event, env) => {
  const result = await cleanup(env);
  console.log(`Cleanup: deleted ${result.deleted} entries`, result.reasons);
};
