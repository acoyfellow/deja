/**
 * DejaDO - Durable Object implementation for deja
 * 
 * Each user gets their own isolated DejaDO instance with SQLite storage.
 */
import { DurableObject } from 'cloudflare:workers';
import { drizzle } from 'drizzle-orm/d1';
import * as schema from '../schema';
import { eq, and, like, desc, sql, inArray } from 'drizzle-orm';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  VECTORIZE: VectorizeIndex;
  AI: Ai;
  API_KEY?: string;
}

// Types for our methods
interface Learning {
  id: string;
  trigger: string;
  learning: string;
  reason?: string;
  confidence: number;
  source?: string;
  scope: string;
  embedding?: number[];
  createdAt: string;
}

interface Secret {
  name: string;
  value: string;
  scope: string;
  createdAt: string;
  updatedAt: string;
}

interface Stats {
  totalLearnings: number;
  totalSecrets: number;
  scopes: Record<string, { learnings: number; secrets: number }>;
}

interface QueryResult {
  learnings: Learning[];
  hits: Record<string, number>;
}

interface InjectResult {
  prompt: string;
  learnings: Learning[];
}

export class DejaDO extends DurableObject<Env> {
  private db: ReturnType<typeof drizzle> | null = null;
  private app: Hono<{ Bindings: Env }> | null = null;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
  }

  /**
   * Initialize the database connection
   */
  private async initDB() {
    if (this.db) return this.db;
    
    try {
      // @ts-ignore - Cloudflare types
      this.db = drizzle(this.ctx.storage.sql, { schema });
      return this.db;
    } catch (error) {
      console.error('Database initialization error:', error);
      throw error;
    }
  }

  /**
   * Create embedding for text using Workers AI
   */
  private async createEmbedding(text: string): Promise<number[]> {
    try {
      // @ts-ignore - Cloudflare types
      const response: any = await this.env.AI.run('@cf/baai/bge-large-en-v1.5', { text });
      // Check if it's a direct response or async response
      if (response.data && response.data[0]) {
        return response.data[0];
      } else {
        // For async responses, we might need to poll
        // For now, let's assume it's direct
        return response;
      }
    } catch (error) {
      console.error('Embedding creation error:', error);
      throw error;
    }
  }

  /**
   * Filter scopes by priority - first match wins
   * Priority order: session:<id>, agent:<id>, shared
   */
  private filterScopesByPriority(scopes: string[]): string[] {
    const priority = ['session:', 'agent:', 'shared'];
    const filtered: string[] = [];
    
    for (const prefix of priority) {
      const matches = scopes.filter(scope => scope.startsWith(prefix));
      if (matches.length > 0) {
        return matches; // Return first match type
      }
    }
    
    // If no matches, return shared if in scopes
    return scopes.includes('shared') ? ['shared'] : [];
  }

  /**
   * Convert database learning to our Learning interface
   */
  private convertDbLearning(dbLearning: any): Learning {
    return {
      id: dbLearning.id,
      trigger: dbLearning.trigger,
      learning: dbLearning.learning,
      reason: dbLearning.reason !== null ? dbLearning.reason : undefined,
      confidence: dbLearning.confidence !== null ? dbLearning.confidence : 0,
      source: dbLearning.source !== null ? dbLearning.source : undefined,
      scope: dbLearning.scope,
      embedding: dbLearning.embedding ? JSON.parse(dbLearning.embedding) : undefined,
      createdAt: dbLearning.createdAt
    };
  }

  /**
   * RPC METHODS - Direct method calls for service binding
   */

  /**
   * Inject relevant memories into a prompt
   * @param scopes Scopes to search in (shared, agent:<id>, session:<id>)
   * @param context Context to find relevant memories for
   * @param limit Maximum number of memories to return
   * @param format Format of the result (prompt or learnings)
   * @returns Injected prompt or learnings
   */
  async inject(scopes: string[], context: string, limit: number = 5, format: 'prompt' | 'learnings' = 'prompt'): Promise<InjectResult> {
    const db = await this.initDB();
    
    // Filter scopes by priority
    const filteredScopes = this.filterScopesByPriority(scopes);
    if (filteredScopes.length === 0) {
      return { prompt: '', learnings: [] };
    }
    
    try {
      // Create embedding for context
      const embedding = await this.createEmbedding(context);
      
      // Query Vectorize for similar embeddings
      const vectorResults = await this.env.VECTORIZE.query(embedding, { 
        topK: limit * 2, // Get more results to filter by scope
        returnValues: true 
      });
      
      // Extract IDs from vector results
      const ids = vectorResults.matches.map(match => match.id);
      
      if (ids.length === 0) {
        return { prompt: '', learnings: [] };
      }
      
      // Get learnings from DB, filter by scope and IDs
      const whereClause = and(
        inArray(schema.learnings.id, ids),
        inArray(schema.learnings.scope, filteredScopes)
      );
      
      const dbLearnings = await db.select().from(schema.learnings).where(whereClause).limit(limit);
      
      // Convert to our Learning interface
      const learnings = dbLearnings.map(this.convertDbLearning);
      
      // Update hit counts for returned learnings
      const hitUpdates = learnings.map(learning => 
        db.update(schema.learnings)
          .set({ 
            confidence: sql`${schema.learnings.confidence} + 0.1` 
          })
          .where(eq(schema.learnings.id, learning.id))
      );
      
      await Promise.all(hitUpdates);
      
      // Format result based on requested format
      if (format === 'prompt') {
        const prompt = learnings.map(l => `When ${l.trigger}, ${l.learning}`).join('\n');
        return { prompt, learnings };
      } else {
        return { prompt: '', learnings };
      }
    } catch (error) {
      console.error('Inject error:', error);
      return { prompt: '', learnings: [] };
    }
  }

  /**
   * Learn a new memory
   * @param scope Scope to store the learning in
   * @param trigger When to apply this learning
   * @param learning What to do
   * @param confidence Confidence level (0-1)
   * @param reason Reason for the learning
   * @param source Source of the learning
   * @returns Created learning
   */
  async learn(scope: string, trigger: string, learning: string, confidence: number = 0.5, reason?: string, source?: string): Promise<Learning> {
    const db = await this.initDB();
    
    // Generate ID
    const id = `${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    
    // Create embedding
    const textForEmbedding = `When ${trigger}, ${learning}`;
    const embedding = await this.createEmbedding(textForEmbedding);
    
    // Create learning object
    const newLearning: Learning = {
      id,
      trigger,
      learning,
      reason,
      confidence,
      source,
      scope,
      embedding,
      createdAt: new Date().toISOString()
    };
    
    try {
      // Insert into DB
      await db.insert(schema.learnings).values({
        id: newLearning.id,
        trigger: newLearning.trigger,
        learning: newLearning.learning,
        reason: newLearning.reason,
        confidence: newLearning.confidence,
        source: newLearning.source,
        scope: newLearning.scope,
        embedding: newLearning.embedding ? JSON.stringify(newLearning.embedding) : null,
        createdAt: newLearning.createdAt
      });
      
      // Insert into Vectorize
      await this.env.VECTORIZE.insert([{
        id: newLearning.id,
        values: newLearning.embedding || [],
        metadata: {
          scope: newLearning.scope,
          trigger: newLearning.trigger,
          learning: newLearning.learning
        }
      }]);
      
      return newLearning;
    } catch (error) {
      console.error('Learn error:', error);
      throw error;
    }
  }

  /**
   * Query for learnings by text
   * @param scopes Scopes to search in
   * @param text Text to search for
   * @param limit Maximum number of results
   * @returns Query results
   */
  async query(scopes: string[], text: string, limit: number = 10): Promise<QueryResult> {
    const db = await this.initDB();
    
    // Filter scopes by priority
    const filteredScopes = this.filterScopesByPriority(scopes);
    if (filteredScopes.length === 0) {
      return { learnings: [], hits: {} };
    }
    
    try {
      // Create embedding for search text
      const embedding = await this.createEmbedding(text);
      
      // Query Vectorize
      const vectorResults = await this.env.VECTORIZE.query(embedding, { 
        topK: limit * 2, 
        returnValues: true 
      });
      
      // Extract IDs and scores
      const matches = vectorResults.matches.map(match => ({ id: match.id, score: match.score }));
      const ids = matches.map(match => match.id);
      
      if (ids.length === 0) {
        return { learnings: [], hits: {} };
      }
      
      // Get learnings from DB, filter by scope and IDs
      const whereClause = and(
        inArray(schema.learnings.id, ids),
        inArray(schema.learnings.scope, filteredScopes)
      );
      
      const dbLearnings = await db.select().from(schema.learnings).where(whereClause).limit(limit);
      
      // Convert to our Learning interface
      const learnings = dbLearnings.map(this.convertDbLearning);
      
      // Sort by vector similarity score
      const sortedLearnings = learnings.sort((a, b) => {
        const scoreA = matches.find(m => m.id === a.id)?.score || 0;
        const scoreB = matches.find(m => m.id === b.id)?.score || 0;
        return scoreB - scoreA;
      });
      
      // Count hits by scope
      const hits: Record<string, number> = {};
      sortedLearnings.forEach(learning => {
        hits[learning.scope] = (hits[learning.scope] || 0) + 1;
      });
      
      return { learnings: sortedLearnings, hits };
    } catch (error) {
      console.error('Query error:', error);
      return { learnings: [], hits: {} };
    }
  }

  /**
   * Get learnings with optional filtering
   * @param filter Filter options
   * @returns List of learnings
   */
  async getLearnings(filter?: { scope?: string; limit?: number }): Promise<Learning[]> {
    const db = await this.initDB();
    
    try {
      let query: any = db.select().from(schema.learnings);
      
      if (filter?.scope) {
        query = query.where(eq(schema.learnings.scope, filter.scope));
      }
      
      if (filter?.limit) {
        query = query.limit(filter.limit);
      }
      
      const results = await query.orderBy(desc(schema.learnings.createdAt));
      return results.map(this.convertDbLearning);
    } catch (error) {
      console.error('Get learnings error:', error);
      return [];
    }
  }

  /**
   * Delete a learning by ID
   * @param id Learning ID
   * @returns Success status
   */
  async deleteLearning(id: string): Promise<{ success: boolean; error?: string }> {
    const db = await this.initDB();
    
    try {
      // Delete from DB
      await db.delete(schema.learnings).where(eq(schema.learnings.id, id));
      
      // Delete from Vectorize
      await this.env.VECTORIZE.deleteByIds([id]);
      
      return { success: true };
    } catch (error) {
      console.error('Delete learning error:', error);
      return { success: false, error: 'Failed to delete learning' };
    }
  }

  /**
   * Get a secret by name, checking scopes in priority order
   * @param scopes Scopes to search in
   * @param name Secret name
   * @returns Secret value or null
   */
  async getSecret(scopes: string[], name: string): Promise<string | null> {
    const db = await this.initDB();
    
    // Filter scopes by priority
    const filteredScopes = this.filterScopesByPriority(scopes);
    if (filteredScopes.length === 0) {
      return null;
    }
    
    try {
      // Query secrets, filter by scope and name
      const whereClause = and(
        eq(schema.secrets.name, name),
        inArray(schema.secrets.scope, filteredScopes)
      );
      
      const results = await db.select().from(schema.secrets).where(whereClause).limit(1);
      
      return results.length > 0 ? results[0].value : null;
    } catch (error) {
      console.error('Get secret error:', error);
      return null;
    }
  }

  /**
   * Set a secret
   * @param scope Scope to store in
   * @param name Secret name
   * @param value Secret value
   * @returns Success status
   */
  async setSecret(scope: string, name: string, value: string): Promise<{ success: boolean; error?: string }> {
    const db = await this.initDB();
    
    try {
      const now = new Date().toISOString();
      
      // Try to update first
      const result: any = await db.update(schema.secrets)
        .set({ 
          value, 
          updatedAt: now 
        })
        .where(and(
          eq(schema.secrets.name, name),
          eq(schema.secrets.scope, scope)
        ));
      
      // If no rows were updated, insert
      // @ts-ignore - Drizzle result type
      if (result.rowsAffected === 0) {
        await db.insert(schema.secrets).values({
          name,
          value,
          scope,
          createdAt: now,
          updatedAt: now
        });
      }
      
      return { success: true };
    } catch (error) {
      console.error('Set secret error:', error);
      return { success: false, error: 'Failed to set secret' };
    }
  }

  /**
   * Delete a secret
   * @param scope Scope to delete from
   * @param name Secret name
   * @returns Success status
   */
  async deleteSecret(scope: string, name: string): Promise<{ success: boolean; error?: string }> {
    const db = await this.initDB();
    
    try {
      await db.delete(schema.secrets)
        .where(and(
          eq(schema.secrets.name, name),
          eq(schema.secrets.scope, scope)
        ));
      
      return { success: true };
    } catch (error) {
      console.error('Delete secret error:', error);
      return { success: false, error: 'Failed to delete secret' };
    }
  }

  /**
   * Get statistics about stored learnings and secrets
   * @returns Statistics
   */
  async getStats(): Promise<Stats> {
    const db = await this.initDB();
    
    try {
      // Get total counts
      const learningCountResult = await db.select({ count: sql<number>`count(*)` }).from(schema.learnings);
      const secretCountResult = await db.select({ count: sql<number>`count(*)` }).from(schema.secrets);
      
      const learningCount = learningCountResult[0]?.count || 0;
      const secretCount = secretCountResult[0]?.count || 0;
      
      // Get scope breakdown
      const learningByScope = await db.select({
        scope: schema.learnings.scope,
        count: sql<number>`count(*)`
      }).from(schema.learnings).groupBy(schema.learnings.scope);
      
      const secretsByScope = await db.select({
        scope: schema.secrets.scope,
        count: sql<number>`count(*)`
      }).from(schema.secrets).groupBy(schema.secrets.scope);
      
      // Build scopes object
      const scopes: Record<string, { learnings: number; secrets: number }> = {};
      
      // Handle case where groupBy might not be supported in all environments
      if (Array.isArray(learningByScope)) {
        learningByScope.forEach((row: any) => {
          if (!scopes[row.scope]) scopes[row.scope] = { learnings: 0, secrets: 0 };
          scopes[row.scope].learnings = row.count;
        });
      }
      
      if (Array.isArray(secretsByScope)) {
        secretsByScope.forEach((row: any) => {
          if (!scopes[row.scope]) scopes[row.scope] = { learnings: 0, secrets: 0 };
          scopes[row.scope].secrets = row.count;
        });
      }
      
      return {
        totalLearnings: learningCount,
        totalSecrets: secretCount,
        scopes
      };
    } catch (error) {
      console.error('Get stats error:', error);
      return { totalLearnings: 0, totalSecrets: 0, scopes: {} };
    }
  }

  /**
   * Initialize Hono app for HTTP handling
   */
  private initApp(): Hono<{ Bindings: Env }> {
    if (this.app) return this.app;
    
    const app = new Hono<{ Bindings: Env }>();
    
    // CORS middleware
    app.use('*', cors());
    
    // Health check
    app.get('/', (c) => {
      return c.json({ status: 'ok', service: 'deja' });
    });
    
    // Learn endpoint
    app.post('/learn', async (c) => {
      const body: any = await c.req.json();
      const result = await this.learn(body.scope || 'shared', body.trigger, body.learning, body.confidence, body.reason, body.source);
      return c.json(result);
    });
    
    // Query endpoint
    app.post('/query', async (c) => {
      const body: any = await c.req.json();
      const result = await this.query(body.scopes || ['shared'], body.text, body.limit);
      return c.json(result);
    });
    
    // Inject endpoint
    app.post('/inject', async (c) => {
      const body: any = await c.req.json();
      const result = await this.inject(body.scopes || ['shared'], body.context, body.limit, body.format);
      return c.json(result);
    });
    
    // Stats endpoint
    app.get('/stats', async (c) => {
      const result = await this.getStats();
      return c.json(result);
    });
    
    // Get learnings endpoint
    app.get('/learnings', async (c) => {
      const scope = c.req.query('scope');
      const limit = c.req.query('limit');
      const result = await this.getLearnings({ 
        scope, 
        limit: limit ? parseInt(limit) : undefined 
      });
      return c.json(result);
    });
    
    // Delete learning endpoint
    app.delete('/learning/:id', async (c) => {
      const id = c.req.param('id');
      const result = await this.deleteLearning(id);
      return c.json(result);
    });
    
    // Set secret endpoint
    app.post('/secret', async (c) => {
      const body: any = await c.req.json();
      const result = await this.setSecret(body.scope || 'shared', body.name, body.value);
      return c.json(result);
    });
    
    // Get secret endpoint
    app.get('/secret/:name', async (c) => {
      const name = c.req.param('name');
      const result = await this.getSecret(['shared'], name);
      if (result === null) {
        return c.json({ error: 'not found' }, 404);
      }
      return c.json({ value: result });
    });
    
    // Delete secret endpoint
    app.delete('/secret/:name', async (c) => {
      const name = c.req.param('name');
      const result = await this.deleteSecret('shared', name);
      if (result.error) {
        return c.json({ error: result.error }, 404);
      }
      return c.json(result);
    });
    
    // 404 handler
    app.notFound((c) => {
      return c.json({ error: 'not found' }, 404);
    });
    
    // Error handler
    app.onError((err, c) => {
      console.error('Hono error:', err);
      return c.json({ error: err.message }, 500);
    });
    
    this.app = app;
    return app;
  }

  /**
   * HTTP fetch handler using Hono
   */
  async fetch(request: Request) {
    try {
      const app = this.initApp();
      return await app.fetch(request, this.env);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'unknown error';
      return new Response(JSON.stringify({ error: message }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
  }
}
