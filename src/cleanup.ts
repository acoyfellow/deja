/**
 * Scheduled cleanup for deja
 * Runs daily via Cloudflare Cron Trigger
 */

interface Env {
  DEJA: DurableObjectNamespace;
  VECTORIZE: VectorizeIndex;
  AI: any;
  API_KEY?: string;
}

export async function cleanup(env: Env): Promise<{ deleted: number; reasons: string[] }> {
  const activeUserId = env.API_KEY || 'anonymous';
  const stub = env.DEJA.get(env.DEJA.idFromName(activeUserId));

  try {
    const response = await stub.fetch(new Request('http://deja/cleanup', { method: 'POST' }));
    const result = await response.json() as { deleted: number; reasons: string[] };
    return result;
  } catch (error) {
    console.error('Cleanup failed:', error);
    return { deleted: 0, reasons: ['Failed to execute cleanup'] };
  }
}
