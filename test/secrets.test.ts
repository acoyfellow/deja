/**
 * Secrets endpoint tests
 * Run against local dev: npx wrangler dev
 * Then: bun test test/secrets.test.ts
 */

const BASE_URL = process.env.DEJA_URL || 'http://localhost:8787';
const API_KEY = process.env.API_KEY || 'test-key';

const headers = {
  'Content-Type': 'application/json',
  'Authorization': `Bearer ${API_KEY}`,
};

const noAuthHeaders = {
  'Content-Type': 'application/json',
};

describe('secrets', () => {
  const testName = `test-secret-${Date.now()}`;
  const testValue = 'super-secret-value';

  test('POST /secret requires auth', async () => {
    const res = await fetch(`${BASE_URL}/secret`, {
      method: 'POST',
      headers: noAuthHeaders,
      body: JSON.stringify({ name: testName, value: testValue }),
    });
    expect(res.status).toBe(401);
  });

  test('POST /secret stores with auth', async () => {
    const res = await fetch(`${BASE_URL}/secret`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: testName, value: testValue }),
    });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.status).toBe('stored');
    expect(data.name).toBe(testName);
  });

  test('GET /secret/:name requires auth', async () => {
    const res = await fetch(`${BASE_URL}/secret/${testName}`, {
      headers: noAuthHeaders,
    });
    expect(res.status).toBe(401);
  });

  test('GET /secret/:name retrieves with auth', async () => {
    const res = await fetch(`${BASE_URL}/secret/${testName}`, { headers });
    expect(res.status).toBe(200);
    const data: any = await res.json();
    expect(data.name).toBe(testName);
    expect(data.value).toBe(testValue);
  });

  test('GET /secret/:name returns 404 for missing', async () => {
    const res = await fetch(`${BASE_URL}/secret/nonexistent`, { headers });
    expect(res.status).toBe(404);
  });

  test('POST /secret validates name format', async () => {
    const res = await fetch(`${BASE_URL}/secret`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: 'invalid name!', value: 'x' }),
    });
    expect(res.status).toBe(400);
  });

  test('POST /secret upserts existing', async () => {
    const newValue = 'updated-value';
    const res = await fetch(`${BASE_URL}/secret`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ name: testName, value: newValue }),
    });
    expect(res.status).toBe(200);

    const get = await fetch(`${BASE_URL}/secret/${testName}`, { headers });
    const data: any = await get.json();
    expect(data.value).toBe(newValue);
  });

  test('DELETE /secret/:name requires auth', async () => {
    const res = await fetch(`${BASE_URL}/secret/${testName}`, {
      method: 'DELETE',
      headers: noAuthHeaders,
    });
    expect(res.status).toBe(401);
  });

  test('DELETE /secret/:name deletes with auth', async () => {
    const res = await fetch(`${BASE_URL}/secret/${testName}`, {
      method: 'DELETE',
      headers,
    });
    expect(res.status).toBe(200);

    const get = await fetch(`${BASE_URL}/secret/${testName}`, { headers });
    expect(get.status).toBe(404);
  });
});
