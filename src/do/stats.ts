import { sql } from 'drizzle-orm';

import * as schema from '../schema';
import type { Stats, StatsOperationsContext } from './types';

export async function getStatsSnapshot(ctx: StatsOperationsContext): Promise<Stats> {
  const db = await ctx.initDB();

  try {
    const learningCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.learnings);
    const secretCountResult = await db
      .select({ count: sql<number>`count(*)` })
      .from(schema.secrets);

    const learningByScope = await db
      .select({
        scope: schema.learnings.scope,
        count: sql<number>`count(*)`,
      })
      .from(schema.learnings)
      .groupBy(schema.learnings.scope);
    const secretsByScope = await db
      .select({
        scope: schema.secrets.scope,
        count: sql<number>`count(*)`,
      })
      .from(schema.secrets)
      .groupBy(schema.secrets.scope);

    const scopes: Record<string, { learnings: number; secrets: number }> = {};
    if (Array.isArray(learningByScope)) {
      learningByScope.forEach((row: any) => {
        if (!scopes[row.scope]) {
          scopes[row.scope] = { learnings: 0, secrets: 0 };
        }
        scopes[row.scope].learnings = row.count;
      });
    }
    if (Array.isArray(secretsByScope)) {
      secretsByScope.forEach((row: any) => {
        if (!scopes[row.scope]) {
          scopes[row.scope] = { learnings: 0, secrets: 0 };
        }
        scopes[row.scope].secrets = row.count;
      });
    }

    return {
      totalLearnings: learningCountResult[0]?.count || 0,
      totalSecrets: secretCountResult[0]?.count || 0,
      scopes,
    };
  } catch (error) {
    console.error('Get stats error:', error);
    return { totalLearnings: 0, totalSecrets: 0, scopes: {} };
  }
}
