/**
 * deja - persistent memory for agents
 *
 * Agents learn from failures. Deja remembers.
 */

import { DejaDO } from './do/DejaDO';
import { cleanup } from './cleanup';

interface Env {
  DEJA: DurableObjectNamespace;
  API_KEY?: string;
  VECTORIZE: VectorizeIndex;
  AI: any;
  ASSETS?: Fetcher;
}

export { DejaDO };

// MCP Tool definitions
const MCP_TOOLS = [
  {
    name: 'learn',
    description: 'Store a learning for future recall. Use after completing tasks, encountering issues, or when the user says "remember this".',
    inputSchema: {
      type: 'object',
      properties: {
        trigger: { type: 'string', description: 'When this learning applies (e.g., "deploying to production")' },
        learning: { type: 'string', description: 'What was learned (e.g., "always run dry-run first")' },
        confidence: { type: 'number', description: 'Confidence level 0-1 (default 0.8)', default: 0.8 },
        scope: { type: 'string', description: 'Memory scope: "shared", "agent:<id>", or "session:<id>"', default: 'shared' },
        reason: { type: 'string', description: 'Why this was learned' },
        source: { type: 'string', description: 'Source identifier' },
        proof_run_id: { type: 'string', description: 'Optional proof run identifier for the learning evidence' },
        proof_iteration_id: { type: 'string', description: 'Optional proof iteration identifier for the learning evidence' },
        sync: { type: 'boolean', description: 'Wait for Vectorize to index the new row before returning so it is immediately queryable. Adds ~15-20s latency; use only when you plan to recall this memory in the same session. Default false.', default: false },
      },
      required: ['trigger', 'learning'],
    },
  },
  {
    name: 'confirm',
    description: 'Boost a memory confidence score after it proves useful.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Learning ID to confirm' },
        proof_run_id: { type: 'string', description: 'Optional proof run identifier for the confirming evidence' },
        proof_iteration_id: { type: 'string', description: 'Optional proof iteration identifier for the confirming evidence' },
      },
      required: ['id'],
    },
  },
  {
    name: 'reject',
    description: 'Reduce a memory confidence score after it proves wrong or stale. May invert into an anti-pattern warning.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Learning ID to reject' },
        proof_run_id: { type: 'string', description: 'Optional proof run identifier for the rejecting evidence' },
        proof_iteration_id: { type: 'string', description: 'Optional proof iteration identifier for the rejecting evidence' },
      },
      required: ['id'],
    },
  },
  {
    name: 'inject',
    description: 'Retrieve relevant memories for the current context. Use before starting tasks to get helpful context.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Current context to find relevant memories for' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes to search', default: ['shared'] },
        limit: { type: 'number', description: 'Max memories to return', default: 5 },
        includeState: { type: 'boolean', description: 'Include live working state in prompt', default: false },
        runId: { type: 'string', description: 'Run/session ID when includeState is true' },
      },
      required: ['context'],
    },
  },
  {
    name: 'inject_trace',
    description: 'Debug retrieval pipeline: returns candidates, similarity scores, threshold filtering. Use to understand why agents recall what they recall.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Current context to find relevant memories for' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes to search', default: ['shared'] },
        limit: { type: 'number', description: 'Max memories to return', default: 5 },
        threshold: { type: 'number', description: 'Minimum similarity score (0-1). Memories below this are marked rejected.', default: 0 },
      },
      required: ['context'],
    },
  },
  {
    name: 'query',
    description: 'Search memories semantically. Use when looking for specific past learnings.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes to search', default: ['shared'] },
        limit: { type: 'number', description: 'Max results', default: 10 },
      },
      required: ['query'],
    },
  },
  {
    name: 'forget',
    description: 'Delete a specific learning by ID. Use to remove outdated or incorrect memories.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Learning ID to delete' },
      },
      required: ['id'],
    },
  },
  {
    name: 'forget_bulk',
    description: 'Bulk delete memories by filters. Requires at least one filter. Use to prune stale or low-confidence memories.',
    inputSchema: {
      type: 'object',
      properties: {
        confidence_lt: { type: 'number', description: 'Delete memories with confidence below this' },
        not_recalled_in_days: { type: 'number', description: 'Delete memories not recalled in this many days' },
        scope: { type: 'string', description: 'Delete only memories in this scope' },
      },
    },
  },
  {
    name: 'learning_neighbors',
    description: 'Find semantically similar memories for a learning. Use to check for contradictions or overlap before saving new memories.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Learning ID to find neighbors for' },
        threshold: { type: 'number', description: 'Minimum cosine similarity (0-1)', default: 0.85 },
        limit: { type: 'number', description: 'Max neighbors to return', default: 10 },
      },
      required: ['id'],
    },
  },
  {
    name: 'list',
    description: 'List all memories, optionally filtered by scope.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Filter by scope' },
        limit: { type: 'number', description: 'Max results', default: 20 },
      },
    },
  },
  {
    name: 'stats',
    description: 'Get memory statistics including counts by scope.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'state_put',
    description: 'Upsert live working state for a run/session.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        goal: { type: 'string' },
        assumptions: { type: 'array', items: { type: 'string' } },
        decisions: { type: 'array', items: { type: 'object' } },
        open_questions: { type: 'array', items: { type: 'string' } },
        next_actions: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' },
        updatedBy: { type: 'string' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'state_get',
    description: 'Fetch live working state for a run/session.',
    inputSchema: {
      type: 'object',
      properties: { runId: { type: 'string' } },
      required: ['runId'],
    },
  },
  {
    name: 'state_patch',
    description: 'Patch live working state for a run/session.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        patch: { type: 'object' },
        updatedBy: { type: 'string' },
      },
      required: ['runId', 'patch'],
    },
  },
  {
    name: 'state_resolve',
    description: 'Resolve a run/session state and optionally persist compact learnings.',
    inputSchema: {
      type: 'object',
      properties: {
        runId: { type: 'string' },
        persistToLearn: { type: 'boolean', default: false },
        scope: { type: 'string', default: 'shared' },
        summaryStyle: { type: 'string', enum: ['compact', 'full'], default: 'compact' },
        updatedBy: { type: 'string' },
      },
      required: ['runId'],
    },
  },
  {
    name: 'record_run',
    description: 'Record the outcome of an optimization loop run. Automatically fires learn() to persist the result as a memory for future runs.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string', enum: ['pass', 'fail', 'exhausted'], description: 'Run outcome' },
        attempts: { type: 'number', description: 'Number of attempts taken' },
        scope: { type: 'string', description: 'Memory scope', default: 'shared' },
        code: { type: 'string', description: 'Code produced by the run (stored truncated at 500 chars in memory)' },
        error: { type: 'string', description: 'Error message if outcome is fail or exhausted' },
      },
      required: ['outcome', 'attempts'],
    },
  },
  {
    name: 'get_runs',
    description: 'Get run history and convergence stats for an optimization loop.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', description: 'Filter by scope' },
        limit: { type: 'number', description: 'Max runs to return', default: 50 },
      },
    },
  },
  {
    name: 'bless_branch',
    description:
      'Promote session-branch learnings from "session" to "blessed". Blessed learnings become visible outside the session (subject to scope) and opt out of the session-branch TTL sweep. Pass learning_ids to bless a subset; omit to bless all session-state rows in the branch.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id (bare, e.g. "abc") or full scope ("session:abc")' },
        learning_ids: { type: 'array', items: { type: 'string' }, description: 'Optional subset of learning ids to bless' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'discard_branch',
    description:
      'Hard-delete all "session"-state learnings in a session branch. Already-blessed rows are preserved. The branch row itself is retained with discarded_at set as an audit trail.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id (bare or scope form)' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'branch_status',
    description:
      'Return metadata for a single session branch: status (open | blessed | discarded | expired), createdAt, expiresAt, blessedAt, discardedAt, sessionCount, blessedCount.',
    inputSchema: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'Session id (bare or scope form)' },
      },
      required: ['session_id'],
    },
  },
  {
    name: 'list_branches',
    description: 'List all known session branches (open + blessed + discarded + expired) with their rollup counts, newest first.',
    inputSchema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'handoff_create',
    description:
      'Create or overwrite a handoff packet — a typed end-of-session summary that outlives the session that authored it. Upsert by session_id: a second call with the same id replaces the first. Use at the end of a run so the next agent starts with context instead of a cold open.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id this packet belongs to (matches session:<id> scope suffix)' },
        authoredBy: { type: 'string', description: 'Optional agent/user identifier' },
        summary: { type: 'string', description: '1-2 sentence high-level summary' },
        whatShipped: { type: 'array', items: { type: 'string' }, description: 'Completed work items' },
        whatBlessed: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              learningId: { type: 'string' },
              note: { type: 'string' },
            },
            required: ['learningId'],
          },
          description: 'Learnings explicitly preserved, each citing a learning id',
        },
        whatRemains: { type: 'array', items: { type: 'string' }, description: 'Open threads / deferred work' },
        nextVerify: { type: 'array', items: { type: 'string' }, description: 'Things the next agent should verify before trusting state' },
        links: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              kind: { type: 'string', enum: ['commit', 'pr', 'url', 'wiki'] },
              value: { type: 'string' },
              label: { type: 'string' },
            },
            required: ['kind', 'value'],
          },
          description: 'Optional commit SHAs, PR URLs, wiki pages',
        },
      },
      required: ['sessionId', 'summary'],
    },
  },
  {
    name: 'handoff_get',
    description: 'Fetch a handoff packet by session id. Returns the full typed struct as JSON, or 404 if none exists.',
    inputSchema: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Session id the packet was written for' },
      },
      required: ['sessionId'],
    },
  },
  {
    name: 'handoff_list',
    description: 'List recent handoff packets, newest-first by createdAt. Default limit 20.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max packets to return (default 20)', default: 20 },
      },
    },
  },
];

// ---------------------------------------------------------------------------
// Lean MCP surface — 2 front-door tools (search, execute) + 1 common-path
// shortcut (inject). Every capability the 17-tool MCP exposes is reachable
// through `execute({ op, args })`. This cuts the agent's per-session tool-
// schema footprint from ~5KB to ~1KB without removing any functionality.
//
// Design follows Cloudflare's MCP convention (cloudflare-docs, backstage,
// wiki): one searcher that returns cheap metadata, one executor that pulls
// bodies / performs writes on demand. Progressive disclosure by default.
// ---------------------------------------------------------------------------

const LEAN_EXECUTE_OPS = [
  'read', 'inject', 'learn', 'confirm', 'reject', 'forget', 'forget_bulk',
  'neighbors', 'trace', 'list', 'stats',
  'state_get', 'state_put', 'state_patch', 'state_resolve',
  'record_run', 'get_runs',
  'bless', 'discard', 'branch_status', 'list_branches',
  // Handoff packets. handoff_read is distinct from handoff_get because it
  // returns the rendered markdown instead of the raw struct — useful for
  // injecting into an agent's prompt without re-serializing.
  'handoff_create', 'handoff_get', 'handoff_list', 'handoff_read',
] as const;
type LeanExecuteOp = typeof LEAN_EXECUTE_OPS[number];

const MCP_TOOLS_LEAN = [
  {
    name: 'search',
    description:
      'Find relevant memories. Returns metadata-only hits (id, trigger, confidence, scope, recall_count, suspect_score, similarity_score) — not learning bodies. Use execute({op:"read", id}) or execute({op:"inject", context}) to pull content. suspect_score is 0..1 (higher = more likely stale/poisoned/superseded) — prefer hits with suspect_score < 0.3.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Context or text to search for' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes to search', default: ['shared'] },
        limit: { type: 'number', description: 'Max hits to return', default: 10 },
        threshold: { type: 'number', description: 'Minimum similarity (0-1). Hits below this are flagged as rejected.', default: 0 },
      },
      required: ['query'],
    },
  },
  {
    name: 'execute',
    description:
      'Dispatch a memory operation. Use search() first to discover ids and triage via suspect_score, then execute() to read bodies or mutate. Ops: ' +
      LEAN_EXECUTE_OPS.join(' | ') +
      '. Each op takes its own args shape — see op descriptions in server docs.',
    inputSchema: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: LEAN_EXECUTE_OPS as unknown as string[], description: 'Operation verb' },
        args: { type: 'object', description: 'Op-specific arguments', default: {} },
      },
      required: ['op'],
    },
  },
  {
    name: 'inject',
    description:
      'Common-path shortcut: search + read + assemble prompt in one call. Returns ready-to-use memory prompt plus the underlying learnings. Use this when the agent just wants "context for what I\'m about to do" and doesn\'t need fine-grained triage.',
    inputSchema: {
      type: 'object',
      properties: {
        context: { type: 'string', description: 'Current context to find relevant memories for' },
        scopes: { type: 'array', items: { type: 'string' }, description: 'Scopes to search', default: ['shared'] },
        limit: { type: 'number', description: 'Max memories to return', default: 5 },
        includeState: { type: 'boolean', description: 'Include live working state in prompt', default: false },
        runId: { type: 'string', description: 'Run/session ID when includeState is true' },
      },
      required: ['context'],
    },
  },
];

// Map lean-execute ops to the existing 17-tool handlers. Keeps the legacy
// path authoritative — lean is strictly a re-skin.
const LEAN_OP_TO_LEGACY: Record<LeanExecuteOp, string | null> = {
  read: null, // handled inline (list+filter by id; cheaper than adding a new REST endpoint)
  inject: 'inject',
  learn: 'learn',
  confirm: 'confirm',
  reject: 'reject',
  forget: 'forget',
  forget_bulk: 'forget_bulk',
  neighbors: 'learning_neighbors',
  trace: 'inject_trace',
  list: 'list',
  stats: 'stats',
  state_get: 'state_get',
  state_put: 'state_put',
  state_patch: 'state_patch',
  state_resolve: 'state_resolve',
  record_run: 'record_run',
  get_runs: 'get_runs',
  // Session-branch ops. These hit dedicated /session/:id/* endpoints on the
  // DO so the executor dispatches them inline (below) rather than via a
  // matching legacy MCP tool. Legacy tools exist too but the lean path
  // bypasses them.
  bless: 'bless_branch',
  discard: 'discard_branch',
  branch_status: 'branch_status',
  list_branches: 'list_branches',
  // Handoff packets. handoff_read maps to handoff_get + render — handled
  // inline in the executor since there's no matching legacy MCP tool for
  // "get and markdown-render in one call".
  handoff_create: 'handoff_create',
  handoff_get: 'handoff_get',
  handoff_list: 'handoff_list',
  handoff_read: null,
};

async function handleLeanToolCall(
  stub: DurableObjectStub,
  toolName: string,
  args: any,
): Promise<any> {
  switch (toolName) {
    case 'search': {
      // search = inject_trace with threshold, stripping learning bodies from candidates.
      const traceResult = await handleMcpToolCall(stub, 'inject_trace', {
        context: args.query,
        scopes: args.scopes ?? ['shared'],
        limit: args.limit ?? 10,
        threshold: args.threshold ?? 0,
      });
      const hits = (traceResult?.candidates ?? []).map((candidate: any) => ({
        id: candidate.id,
        trigger: candidate.trigger,
        similarity_score: candidate.similarity_score,
        passed_threshold: candidate.passed_threshold,
        confidence: candidate.confidence,
        scope: candidate.scope,
        recall_count: candidate.recall_count,
        created_at: candidate.created_at,
        last_recalled_at: candidate.last_recalled_at,
        anti_pattern: candidate.anti_pattern,
        supersedes: candidate.supersedes,
        suspect_score: candidate.suspect_score,
        // branch_state lets agents triage session-branch hits from main/blessed
        // without pulling bodies. 'session' hits come only from the caller's
        // own session; 'blessed' hits are promoted scratchpads; 'main' is
        // the unmarked default.
        branch_state: candidate.branch_state,
      }));
      return {
        hits,
        threshold_applied: traceResult?.threshold_applied ?? 0,
        metadata: traceResult?.metadata ?? { total_candidates: 0, above_threshold: 0, below_threshold: 0 },
      };
    }
    case 'inject': {
      return handleMcpToolCall(stub, 'inject', args);
    }
    case 'execute': {
      const op = args?.op as LeanExecuteOp | undefined;
      const opArgs = (args?.args ?? {}) as any;
      if (!op || !(LEAN_EXECUTE_OPS as readonly string[]).includes(op)) {
        throw new Error(`Unknown op: ${op ?? '(missing)'}. Valid ops: ${LEAN_EXECUTE_OPS.join(', ')}`);
      }
      if (op === 'read') {
        // Pull a single learning body by id via the existing list endpoint.
        if (!opArgs.id) throw new Error('execute(read) requires args.id');
        const listResult = await handleMcpToolCall(stub, 'list', { limit: 10000 });
        const rows = Array.isArray(listResult) ? listResult : (listResult?.learnings ?? []);
        const hit = rows.find((row: any) => row?.id === opArgs.id);
        if (!hit) return { found: false, id: opArgs.id };
        return { found: true, learning: hit };
      }
      // handoff_read has no legacy MCP tool — it's get+render handled inline.
      // Run this branch BEFORE the legacy-mapping fallthrough, otherwise the
      // `!legacy` guard fires on a null entry and throws.
      if (op === 'handoff_read') {
        const sessionId = extractHandoffSessionIdArg(opArgs);
        if (!sessionId) throw new Error('execute(handoff_read) requires args.sessionId');
        const response = await stub.fetch(
          new Request(`http://internal/handoff/${encodeURIComponent(sessionId)}?format=markdown`),
        );
        if (response.status === 404) {
          return { found: false, sessionId };
        }
        const markdown = await response.text();
        return { found: true, sessionId, markdown };
      }
      const legacy = LEAN_OP_TO_LEGACY[op];
      if (!legacy) throw new Error(`execute(${op}) has no legacy mapping — implementation bug`);
      // `trace` exposes the inject_trace candidate shape directly, which
      // carries the new suspect_score metadata; no extra plumbing needed.
      if (op === 'trace') {
        return handleMcpToolCall(stub, 'inject_trace', {
          context: opArgs.context ?? opArgs.query,
          scopes: opArgs.scopes,
          limit: opArgs.limit,
          threshold: opArgs.threshold,
        });
      }
      if (op === 'neighbors') {
        return handleMcpToolCall(stub, 'learning_neighbors', opArgs);
      }
      if (op === 'bless') return handleMcpToolCall(stub, 'bless_branch', opArgs);
      if (op === 'discard') return handleMcpToolCall(stub, 'discard_branch', opArgs);
      if (op === 'branch_status') return handleMcpToolCall(stub, 'branch_status', opArgs);
      if (op === 'list_branches') return handleMcpToolCall(stub, 'list_branches', opArgs);
      return handleMcpToolCall(stub, legacy, opArgs);
    }
    default:
      throw new Error(`Unknown lean tool: ${toolName}`);
  }
}

// Handle MCP tool calls
async function handleMcpToolCall(stub: DurableObjectStub, toolName: string, args: any): Promise<any> {
  switch (toolName) {
    case 'learn': {
      const response = await stub.fetch(new Request('http://internal/learn', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          trigger: args.trigger,
          learning: args.learning,
          confidence: args.confidence ?? 0.8,
          scope: args.scope ?? 'shared',
          reason: args.reason,
          source: args.source,
          proof_run_id: args.proof_run_id,
          proof_iteration_id: args.proof_iteration_id,
          // Opt-in Vectorize consistency. Forwarded verbatim; the DO
          // decides whether to poll the index before returning.
          sync: args.sync === true ? true : undefined,
        }),
      }));
      return response.json();
    }
    case 'confirm': {
      const response = await stub.fetch(new Request(`http://internal/learning/${args.id}/confirm`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proof_run_id: args.proof_run_id,
          proof_iteration_id: args.proof_iteration_id,
        }),
      }));
      return response.json();
    }
    case 'reject': {
      const response = await stub.fetch(new Request(`http://internal/learning/${args.id}/reject`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          proof_run_id: args.proof_run_id,
          proof_iteration_id: args.proof_iteration_id,
        }),
      }));
      return response.json();
    }
    case 'inject': {
      const response = await stub.fetch(new Request('http://internal/inject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: args.context,
          scopes: args.scopes ?? ['shared'],
          limit: args.limit ?? 5,
          includeState: args.includeState ?? false,
          runId: args.runId,
        }),
      }));
      return response.json();
    }
    case 'inject_trace': {
      const url = new URL('http://internal/inject/trace');
      if (args.threshold != null) url.searchParams.set('threshold', String(args.threshold));
      const response = await stub.fetch(new Request(url.toString(), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          context: args.context,
          scopes: args.scopes ?? ['shared'],
          limit: args.limit ?? 5,
          threshold: args.threshold,
        }),
      }));
      return response.json();
    }
    case 'query': {
      const response = await stub.fetch(new Request('http://internal/query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: args.query,
          scopes: args.scopes ?? ['shared'],
          limit: args.limit ?? 10,
        }),
      }));
      return response.json();
    }
    case 'forget': {
      const response = await stub.fetch(new Request(`http://internal/learning/${args.id}`, {
        method: 'DELETE',
      }));
      return response.json();
    }
    case 'learning_neighbors': {
      const params = new URLSearchParams();
      if (args.threshold != null) params.set('threshold', String(args.threshold));
      if (args.limit != null) params.set('limit', String(args.limit));
      const response = await stub.fetch(new Request(`http://internal/learning/${args.id}/neighbors?${params}`));
      return response.json();
    }
    case 'forget_bulk': {
      const params = new URLSearchParams();
      if (args.confidence_lt != null) params.set('confidence_lt', String(args.confidence_lt));
      if (args.not_recalled_in_days != null) params.set('not_recalled_in_days', String(args.not_recalled_in_days));
      if (args.scope != null) params.set('scope', args.scope);
      const response = await stub.fetch(new Request(`http://internal/learnings?${params}`, { method: 'DELETE' }));
      return response.json();
    }
    case 'list': {
      const params = new URLSearchParams();
      if (args.scope) params.set('scope', args.scope);
      if (args.limit) params.set('limit', String(args.limit));
      const response = await stub.fetch(new Request(`http://internal/learnings?${params}`));
      return response.json();
    }
    case 'stats': {
      const response = await stub.fetch(new Request('http://internal/stats'));
      return response.json();
    }
    case 'state_get': {
      const response = await stub.fetch(new Request(`http://internal/state/${args.runId}`));
      return response.json();
    }
    case 'state_put': {
      const { runId, ...payload } = args;
      const response = await stub.fetch(new Request(`http://internal/state/${runId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }));
      return response.json();
    }
    case 'state_patch': {
      const response = await stub.fetch(new Request(`http://internal/state/${args.runId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...(args.patch || {}), updatedBy: args.updatedBy }),
      }));
      return response.json();
    }
    case 'state_resolve': {
      const response = await stub.fetch(new Request(`http://internal/state/${args.runId}/resolve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          persistToLearn: args.persistToLearn ?? false,
          scope: args.scope ?? 'shared',
          summaryStyle: args.summaryStyle ?? 'compact',
          updatedBy: args.updatedBy,
        }),
      }));
      return response.json();
    }
    case 'record_run': {
      const response = await stub.fetch(new Request('http://internal/run', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          outcome: args.outcome,
          attempts: args.attempts,
          scope: args.scope ?? 'shared',
          code: args.code,
          error: args.error,
        }),
      }));
      return response.json();
    }
    case 'get_runs': {
      const params = new URLSearchParams();
      if (args.scope) params.set('scope', args.scope);
      if (args.limit) params.set('limit', String(args.limit));
      const response = await stub.fetch(new Request(`http://internal/runs?${params}`));
      return response.json();
    }
    case 'bless_branch': {
      const sessionId = extractSessionIdArg(args);
      if (!sessionId) throw new Error('bless_branch requires args.session_id');
      const payload: Record<string, unknown> = {};
      if (Array.isArray(args.learning_ids)) payload.learning_ids = args.learning_ids;
      else if (Array.isArray(args.learningIds)) payload.learningIds = args.learningIds;
      const response = await stub.fetch(new Request(`http://internal/session/${encodeURIComponent(sessionId)}/bless`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }));
      return response.json();
    }
    case 'discard_branch': {
      const sessionId = extractSessionIdArg(args);
      if (!sessionId) throw new Error('discard_branch requires args.session_id');
      const response = await stub.fetch(new Request(`http://internal/session/${encodeURIComponent(sessionId)}/discard`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      }));
      return response.json();
    }
    case 'branch_status': {
      const sessionId = extractSessionIdArg(args);
      if (!sessionId) throw new Error('branch_status requires args.session_id');
      const response = await stub.fetch(new Request(`http://internal/session/${encodeURIComponent(sessionId)}/status`));
      return response.json();
    }
    case 'list_branches': {
      const response = await stub.fetch(new Request('http://internal/sessions'));
      return response.json();
    }
    case 'handoff_create': {
      const sessionId = extractHandoffSessionIdArg(args);
      if (!sessionId) throw new Error('handoff_create requires args.sessionId');
      // Forward the whole args object as the packet body. The DO
      // normalizer drops unknown fields, so extra metadata on args
      // (e.g. `op`, `kind`) can't leak into storage.
      const response = await stub.fetch(new Request('http://internal/handoff', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...args, sessionId }),
      }));
      return response.json();
    }
    case 'handoff_get': {
      const sessionId = extractHandoffSessionIdArg(args);
      if (!sessionId) throw new Error('handoff_get requires args.sessionId');
      const response = await stub.fetch(new Request(`http://internal/handoff/${encodeURIComponent(sessionId)}`));
      if (response.status === 404) {
        return { found: false, sessionId };
      }
      const packet = await response.json();
      return { found: true, packet };
    }
    case 'handoff_list': {
      const params = new URLSearchParams();
      if (args?.limit != null) params.set('limit', String(args.limit));
      const qs = params.toString();
      const response = await stub.fetch(new Request(`http://internal/handoffs${qs ? `?${qs}` : ''}`));
      return response.json();
    }
    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

// Normalize a session_id arg accepting either 'abc' or 'session:abc'. Empty
// strings are treated as missing. Used by every bless/discard/status call.
function extractSessionIdArg(args: any): string | null {
  const raw = args?.session_id ?? args?.sessionId;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed.startsWith('session:') ? trimmed.slice('session:'.length) : trimmed;
}

// Same shape as extractSessionIdArg but named for the handoff call sites
// so grep across the codebase finds both independently. Handoffs use the
// bare session id in the URL path, never the 'session:<id>' scope form.
function extractHandoffSessionIdArg(args: any): string | null {
  return extractSessionIdArg(args);
}

// Handle MCP JSON-RPC requests. `variant` switches between the full 17-tool
// surface and the lean 3-tool surface without changing transport shape.
async function handleMcpRequest(
  request: Request,
  stub: DurableObjectStub,
  variant: 'full' | 'lean' = 'full',
): Promise<Response> {
  const body = await request.json() as any;
  const { jsonrpc, id, method, params } = body;

  if (jsonrpc !== '2.0') {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32600, message: 'Invalid Request - must be JSON-RPC 2.0' },
    }), { headers: { 'Content-Type': 'application/json' } });
  }

  try {
    let result: any;

    switch (method) {
      case 'initialize':
        result = {
          protocolVersion: '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: {
            name: variant === 'lean' ? 'deja-lean' : 'deja',
            version: '1.0.0',
          },
        };
        break;

      case 'tools/list':
        result = { tools: variant === 'lean' ? MCP_TOOLS_LEAN : MCP_TOOLS };
        break;

      case 'tools/call': {
        const { name, arguments: args } = params;
        const toolResult =
          variant === 'lean'
            ? await handleLeanToolCall(stub, name, args || {})
            : await handleMcpToolCall(stub, name, args || {});
        result = {
          content: [{ type: 'text', text: JSON.stringify(toolResult, null, 2) }],
        };
        break;
      }

      case 'notifications/initialized':
      case 'notifications/cancelled':
        // These are notifications, no response needed
        return new Response(null, { status: 204 });

      default:
        return new Response(JSON.stringify({
          jsonrpc: '2.0',
          id,
          error: { code: -32601, message: `Method not found: ${method}` },
        }), { headers: { 'Content-Type': 'application/json' } });
    }

    return new Response(JSON.stringify({ jsonrpc: '2.0', id, result }), {
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error: any) {
    return new Response(JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: { code: -32603, message: error.message || 'Internal error' },
    }), { headers: { 'Content-Type': 'application/json' } });
  }
}

function getUserIdFromApiKey(apiKey: string | undefined, authHeader: string | null): string {
  if (!apiKey || !authHeader) return 'anonymous';
  const providedKey = authHeader?.replace('Bearer ', '');
  // If API key is provided and matches, use it as the user ID for isolation
  // Otherwise, use 'anonymous'
  return providedKey === apiKey ? providedKey : 'anonymous';
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

    // Marketing domain: serve static Astro site, no auth required
    if (url.hostname === 'deja.coey.dev') {
      if (!env.ASSETS) {
        return new Response('Marketing site not configured', { status: 404, headers: corsHeaders });
      }
      return env.ASSETS.fetch(request);
    }

    // API domain (deja-api.coey.dev, workers.dev, localhost, etc.)
    // All routes require authentication
    const checkAuth = (): boolean => {
      if (!env.API_KEY) return true; // No API key configured = open access
      const authHeader = request.headers.get('Authorization');
      const providedKey = authHeader?.replace('Bearer ', '');
      return providedKey === env.API_KEY;
    };

    if (!checkAuth()) {
      return new Response(
        JSON.stringify({ error: 'unauthorized - API key required' }),
        { status: 401, headers: corsHeaders }
      );
    }

    // Get user ID from API key or use 'anonymous'
    const userId = getUserIdFromApiKey(env.API_KEY, request.headers.get('Authorization'));
    const stub = env.DEJA.get(env.DEJA.idFromName(userId));

    // MCP endpoint - Model Context Protocol (full 17-tool surface)
    if (path === '/mcp' && request.method === 'POST') {
      return handleMcpRequest(request, stub, 'full');
    }

    // MCP discovery endpoint
    if (path === '/mcp' && request.method === 'GET') {
      return new Response(JSON.stringify({
        name: 'deja',
        version: '1.0.0',
        description: 'Persistent memory for agents. Store learnings, recall context.',
        protocol: 'mcp',
        endpoint: `${url.origin}/mcp`,
        tools: MCP_TOOLS.map(t => t.name),
        variants: { lean: `${url.origin}/mcp/lean` },
      }), { headers: corsHeaders });
    }

    // Lean MCP endpoint - 2 front-door tools (search, execute) + inject shortcut.
    // Same capabilities as /mcp, 1/5th the schema footprint in the agent's context.
    if (path === '/mcp/lean' && request.method === 'POST') {
      return handleMcpRequest(request, stub, 'lean');
    }

    if (path === '/mcp/lean' && request.method === 'GET') {
      return new Response(JSON.stringify({
        name: 'deja-lean',
        version: '1.0.0',
        description:
          'Lean MCP surface over deja. Two front-door tools (search, execute) + one common-path shortcut (inject). Progressive disclosure by default.',
        protocol: 'mcp',
        endpoint: `${url.origin}/mcp/lean`,
        tools: MCP_TOOLS_LEAN.map(t => t.name),
        execute_ops: LEAN_EXECUTE_OPS,
      }), { headers: corsHeaders });
    }

    // Health check at API root
    if (path === '/') {
      return new Response(JSON.stringify({ status: 'ok', service: 'deja' }), { headers: corsHeaders });
    }

    // Forward all other requests to the Durable Object
    return await stub.fetch(request);
  },

  async scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    // Run cleanup daily
    try {
      const result = await cleanup(env);
      console.log(`Cleanup completed: ${result.deleted} entries deleted`, result.reasons);
    } catch (error) {
      console.error('Cleanup failed:', error);
    }
  },
};
