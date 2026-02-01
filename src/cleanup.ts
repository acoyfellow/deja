/**
 * Scheduled cleanup for deja
 * Runs daily via Cloudflare Cron Trigger
 */

import { DejaDO } from './do/DejaDO';

interface Env {
  DEJA: DurableObjectNamespace;
  VECTORIZE: VectorizeIndex;
  AI: any;
}

export async function cleanup(env: Env): Promise<{ deleted: number; reasons: string[] }> {
  const reasons: string[] = [];
  let deleted = 0;

  // For cleanup, we'll use a special 'cleanup' user ID
  const stub = env.DEJA.get(env.DEJA.idFromName('cleanup'));
  
  // We need to implement cleanup logic in the DO itself since we can't directly access the DB
  // For now, we'll create a special endpoint in the DO for cleanup
  
  try {
    const response = await stub.fetch(new Request('http://deja/cleanup', { method: 'POST' }));
    const result = await response.json() as { deleted: number; reasons: string[] };
    return result;
  } catch (error) {
    console.error('Cleanup failed:', error);
    return { deleted: 0, reasons: ['Failed to execute cleanup'] };
  }
}
