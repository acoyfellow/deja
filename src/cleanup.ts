/**
 * Scheduled cleanup for deja
 * Runs daily via Cloudflare Cron Trigger
 */

export async function cleanup(env: any): Promise<{ deleted: number; reasons: string[] }> {
  const reasons: string[] = [];
  let deleted = 0;

  // 1. Delete session:* entries older than 7 days
  const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const stale = await env.DB.prepare(
    `DELETE FROM learnings WHERE trigger LIKE 'session:%' AND created_at < ? RETURNING id`
  ).bind(weekAgo).all();
  
  if (stale.results?.length) {
    deleted += stale.results.length;
    reasons.push(`${stale.results.length} stale session entries`);
    
    // Also delete from vectorize
    const ids = stale.results.map((r: any) => r.id);
    await env.VECTORIZE.deleteByIds(ids);
  }

  // 2. Delete low confidence (< 0.3) entries
  const lowConf = await env.DB.prepare(
    `DELETE FROM learnings WHERE confidence < 0.3 RETURNING id`
  ).all();
  
  if (lowConf.results?.length) {
    deleted += lowConf.results.length;
    reasons.push(`${lowConf.results.length} low confidence entries`);
    
    const ids = lowConf.results.map((r: any) => r.id);
    await env.VECTORIZE.deleteByIds(ids);
  }

  return { deleted, reasons };
}
