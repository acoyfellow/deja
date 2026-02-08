/**
 * prd.ts - Post-deploy smoke gates
 *
 * Validates the deployed deja service is healthy.
 * Run after deploy: bun run prd.ts
 *
 * Env vars:
 *   DEJA_URL     - Deployed worker URL (e.g., https://deja.coey.workers.dev)
 *   DEJA_API_KEY - API key for authenticated endpoints
 */

const DEJA_URL = process.env.DEJA_URL;
const DEJA_API_KEY = process.env.DEJA_API_KEY;

if (!DEJA_URL) {
  console.error('❌ DEJA_URL is required');
  process.exit(1);
}

const authHeaders: Record<string, string> = {
  'Content-Type': 'application/json',
  ...(DEJA_API_KEY ? { Authorization: `Bearer ${DEJA_API_KEY}` } : {}),
};

let passed = 0;
let failed = 0;

async function gate(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ❌ ${name}: ${msg}`);
    failed++;
  }
}

console.log(`\n🔍 Smoke gates for ${DEJA_URL}\n`);

// 1. Health check - root returns 200
await gate('GET / returns 200', async () => {
  const res = await fetch(DEJA_URL);
  if (!res.ok) throw new Error(`status ${res.status}`);
});

// 2. Stats endpoint works (requires auth)
await gate('GET /stats returns valid JSON', async () => {
  const res = await fetch(`${DEJA_URL}/stats`, { headers: authHeaders });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json() as Record<string, unknown>;
  if (typeof data.totalLearnings !== 'number') {
    throw new Error('missing totalLearnings in response');
  }
});

// 3. Learn + query round-trip (cleaned up at end)
const smokeId = `smoke-${Date.now()}`;
let smokeEntryId: string | null = null;
await gate('POST /learn stores a memory', async () => {
  const res = await fetch(`${DEJA_URL}/learn`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      trigger: `smoke test ${smokeId}`,
      learning: 'this is a post-deploy smoke test entry',
      confidence: 0.1,
      scope: `session:smoke-${smokeId}`,
    }),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json() as Record<string, unknown>;
  if (!data.id) throw new Error('missing id in response');
  smokeEntryId = data.id as string;
});

await gate('GET /learnings returns entries', async () => {
  const res = await fetch(`${DEJA_URL}/learnings?limit=1`, {
    headers: authHeaders,
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json();
  if (!Array.isArray(data)) throw new Error('expected array response');
});

// 4. Inject endpoint works
await gate('POST /inject returns prompt', async () => {
  const res = await fetch(`${DEJA_URL}/inject`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      context: 'smoke test',
      format: 'prompt',
      limit: 1,
    }),
  });
  if (!res.ok) throw new Error(`status ${res.status}`);
  const data = await res.json() as Record<string, unknown>;
  if (!('prompt' in data) && !('learnings' in data)) {
    throw new Error('missing prompt or learnings in response');
  }
});

// 5. 404 for unknown routes (use auth so we don't get 401 first)
await gate('GET /nonexistent returns 404', async () => {
  const res = await fetch(`${DEJA_URL}/nonexistent-route-xyz`, {
    headers: authHeaders,
  });
  if (res.status !== 404) throw new Error(`expected 404, got ${res.status}`);
});

// 6. Clean up smoke test entry
if (smokeEntryId) {
  await gate('DELETE /learning/:id cleans up smoke entry', async () => {
    const res = await fetch(`${DEJA_URL}/learning/${smokeEntryId}`, {
      method: 'DELETE',
      headers: authHeaders,
    });
    if (!res.ok) throw new Error(`status ${res.status}`);
  });
}

// Summary
console.log(`\n${'─'.repeat(40)}`);
console.log(`  ${passed} passed, ${failed} failed`);
console.log(`${'─'.repeat(40)}\n`);

if (failed > 0) {
  process.exit(1);
}
