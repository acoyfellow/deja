import { and, desc, eq, inArray } from 'drizzle-orm';

import * as schema from '../schema';
import type { Secret, SecretsOperationsContext } from './types';

export async function getSecretValue(
  ctx: SecretsOperationsContext,
  scopes: string[],
  name: string,
): Promise<string | null> {
  const db = await ctx.initDB();
  const filteredScopes = ctx.filterScopesByPriority(scopes);
  if (filteredScopes.length === 0) {
    return null;
  }

  try {
    const results = await db
      .select()
      .from(schema.secrets)
      .where(
        and(eq(schema.secrets.name, name), inArray(schema.secrets.scope, filteredScopes)),
      )
      .limit(1);
    return results.length > 0 ? results[0].value : null;
  } catch (error) {
    console.error('Get secret error:', error);
    return null;
  }
}

export async function setSecretValue(
  ctx: SecretsOperationsContext,
  scope: string,
  name: string,
  value: string,
): Promise<{ success: boolean; error?: string }> {
  const db = await ctx.initDB();

  try {
    const now = new Date().toISOString();
    const result: any = await db
      .update(schema.secrets)
      .set({ value, updatedAt: now })
      .where(and(eq(schema.secrets.name, name), eq(schema.secrets.scope, scope)));

    if (result.rowsAffected === 0) {
      await db.insert(schema.secrets).values({
        name,
        value,
        scope,
        createdAt: now,
        updatedAt: now,
      });
    }

    return { success: true };
  } catch (error) {
    console.error('Set secret error:', error);
    return { success: false, error: 'Failed to set secret' };
  }
}

export async function deleteSecretValue(
  ctx: SecretsOperationsContext,
  scope: string,
  name: string,
): Promise<{ success: boolean; error?: string }> {
  const db = await ctx.initDB();

  try {
    await db
      .delete(schema.secrets)
      .where(and(eq(schema.secrets.name, name), eq(schema.secrets.scope, scope)));
    return { success: true };
  } catch (error) {
    console.error('Delete secret error:', error);
    return { success: false, error: 'Failed to delete secret' };
  }
}

export async function listSecrets(
  ctx: SecretsOperationsContext,
  scope?: string,
): Promise<Secret[]> {
  const db = await ctx.initDB();

  try {
    let query: any = db.select().from(schema.secrets);

    if (scope) {
      query = query.where(eq(schema.secrets.scope, scope));
    }

    return await query.orderBy(desc(schema.secrets.updatedAt));
  } catch (error) {
    console.error('Get secrets error:', error);
    throw new Error('Failed to get secrets');
  }
}
