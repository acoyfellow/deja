/**
 * DejaDO - Durable Object implementation for deja
 * 
 * Each user gets their own isolated DejaDO instance with SQLite storage.
 */
import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../schema';
import { eq, and, like, desc, sql } from 'drizzle-orm';

interface Env {
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  API_KEY?: string;
}

export class DejaDO extends DurableObject {
  private db: ReturnType<typeof drizzle> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  /**
   * Initialize the database connection
   */
  private async initDB() {
    if (this.db) return this.db;
    
    // @ts-ignore - Cloudflare types
    this.db = drizzle(this.ctx.storage.sql, { schema });
    return this.db;
  }

  /**
   * Filter scopes by priority - first match wins
   * Order: session:<id>, agent:<id>, shared
   */
  private filterByScopePriority(scopes: string[]) {
    // Sort scopes by priority
    const priority = ['session:', 'agent:', 'shared'];
    return scopes.sort((a, b) => {
      const aPriority = priority.findIndex(p => a.startsWith(p));
      const bPriority = priority.findIndex(p => b.startsWith(p));
      return aPriority - bPriority;
    });
  }

  /**
   * RPC method: Inject memories into context
   */
  async inject(scopes: string[], context: string, limit: number = 5, format: string = 'structured') {
    const db = await this.initDB();
    
    // Filter scopes by priority
    const sortedScopes = this.filterByScopePriority(scopes);
    
    // For now, we'll implement a simple query without Vectorize
    // In a full implementation, we would use the AI embedding and Vectorize
    const results = await db.select().from(schema.learnings)
      .where(
        and(
          eq(schema.learnings.scope, sortedScopes[0])
        )
      )
      .orderBy(desc(schema.learnings.createdAt))
      .limit(limit);

    if (format === 'prompt') {
      const lines = results.map(
        (l) =>
          `- ${l.trigger}: ${l.learning}${l.reason ? ` (${l.reason})` : ''}`
      );
      const injection = results.length > 0
        ? `## Relevant learnings from previous work:\n${lines.join('\n')}`
        : '';
      return { injection };
    }

    return {
      injection: results.map((l) => ({
        trigger: l.trigger,
        learning: l.learning,
        reason: l.reason,
        confidence: l.confidence,
      })),
    };
  }

  /**
   * RPC method: Learn something new
   */
  async learn(scope: string, trigger: string, learning: string, confidence: number = 1.0, reason?: string, source?: string) {
    const db = await this.initDB();
    
    const id = crypto.randomUUID();
    const now = new Date().toISOString();

    // For now, we'll skip the Vectorize part and just store in SQLite
    // In a full implementation, we would also create an embedding
    await db.insert(schema.learnings).values({
      id,
      trigger,
      learning,
      reason: reason ?? null,
      confidence,
      source: source ?? null,
      scope,
      createdAt: now,
    });

    return { id, status: 'stored' };
  }

  /**
   * RPC method: Query memories
   */
  async query(scopes: string[], text: string, limit: number = 5) {
    const db = await this.initDB();
    
    // Filter scopes by priority
    const sortedScopes = this.filterByScopePriority(scopes);
    
    // For now, we'll implement a simple query without Vectorize
    // In a full implementation, we would use the AI embedding and Vectorize
    const results = await db.select().from(schema.learnings)
      .where(
        and(
          eq(schema.learnings.scope, sortedScopes[0])
        )
      )
      .orderBy(desc(schema.learnings.createdAt))
      .limit(limit);

    return { learnings: results };
  }

  /**
   * RPC method: Get all learnings (with filtering)
   */
  async getLearnings(filter?: { scope?: string }) {
    const db = await this.initDB();
    
    let query = db.select().from(schema.learnings);
    
    if (filter?.scope) {
      query = query.where(eq(schema.learnings.scope, filter.scope));
    }
    
    const results = await query.orderBy(desc(schema.learnings.createdAt));
    
    return { learnings: results };
  }

  /**
   * RPC method: Delete a learning
   */
  async deleteLearning(id: string) {
    const db = await this.initDB();
    
    // Check if exists
    const existing = await db.select().from(schema.learnings)
      .where(eq(schema.learnings.id, id));

    if (existing.length === 0) {
      return { error: 'not found' };
    }

    // Delete from database
    await db.delete(schema.learnings)
      .where(eq(schema.learnings.id, id));

    return { status: 'deleted', id };
  }

  /**
   * RPC method: Get a secret
   */
  async getSecret(scopes: string[], name: string) {
    const db = await this.initDB();
    
    // Filter scopes by priority
    const sortedScopes = this.filterByScopePriority(scopes);
    
    // Try to find secret in each scope in order
    for (const scope of sortedScopes) {
      const results = await db.select().from(schema.secrets)
        .where(
          and(
            eq(schema.secrets.name, name),
            eq(schema.secrets.scope, scope)
          )
        );
      
      if (results.length > 0) {
        return { name: results[0].name, value: results[0].value };
      }
    }
    
    return null;
  }

  /**
   * RPC method: Set a secret
   */
  async setSecret(scope: string, name: string, value: string) {
    const db = await this.initDB();
    
    const now = new Date().toISOString();

    // Upsert the secret
    await db.insert(schema.secrets).values({
      name,
      value,
      scope,
      createdAt: now,
      updatedAt: now,
    }).onConflictDoUpdate({
      target: [schema.secrets.name, schema.secrets.scope],
      set: {
        value,
        updatedAt: now,
      },
    });

    return { name, status: 'stored' };
  }

  /**
   * RPC method: Delete a secret
   */
  async deleteSecret(scope: string, name: string) {
    const db = await this.initDB();
    
    const existing = await db.select().from(schema.secrets)
      .where(
        and(
          eq(schema.secrets.name, name),
          eq(schema.secrets.scope, scope)
        )
      );

    if (existing.length === 0) {
      return { error: 'not found' };
    }

    await db.delete(schema.secrets)
      .where(
        and(
          eq(schema.secrets.name, name),
          eq(schema.secrets.scope, scope)
        )
      );

    return { status: 'deleted', name };
  }

  /**
   * RPC method: Get statistics
   */
  async getStats() {
    const db = await this.initDB();
    
    const result: { count: number; avgConfidence: number | null }[] = await db.select({
      count: sql<number>`COUNT(*)`,
      avgConfidence: sql<number | null>`AVG(confidence)`
    }).from(schema.learnings);

    return { 
      total_learnings: result[0]?.count ?? 0, 
      avg_confidence: result[0]?.avgConfidence ?? 0 
    };
  }
}