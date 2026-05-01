#!/usr/bin/env bun
/**
 * deja MCP server — local stdio.
 *
 * Four tools, matching the four-verb library plus a feedback channel:
 *   recall    — search; returns hits + active handoff. Empty/blank query
 *               returns "what's recent": active handoff + N most recent
 *               kept slips (no FTS).
 *   remember  — jot a slip (draft by default; pass keep=true to skip the draft step)
 *   handoff   — close the session with a summary
 *   signal    — close the loop on a recalled slip:
 *                 action="used"    -> bump usedCount (slip was helpful)
 *                 action="wrong"   -> bump wrongCount (slip was misleading)
 *                 action="forget"  -> expire the slip (no undo)
 *
 * `keep` is folded into `remember(keep: true)` because MCP clients tend
 * to treat tools as one-shot — promoting separately is friction. The
 * library still exposes keep() for in-process callers.
 *
 * Structural recall enforcement:
 * On the first `remember` or `handoff` call of a session where no
 * `recall` has happened yet, we surface the most recent prior handoff
 * (if any) in the tool response. This makes the previous agent's
 * signoff visible to a forgetful agent without requiring it to ask.
 * Cheap (one indexed row), additive, zero new state.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Deja, defaultDbPath } from "./index.ts";
import { formatRecall, formatRecents } from "./format.ts";

/**
 * Dispatch state. Exposed only for tests / harnesses that want to
 * exercise the MCP handler logic without spinning up a transport.
 */
export interface DispatchState {
  /** Has `recall` been called yet this process? Mutated by dispatch(). */
  recallSeen: boolean;
}

export function newDispatchState(): DispatchState {
  return { recallSeen: false };
}

/**
 * If the agent has not called recall yet, return a short banner pointing
 * at the most recent prior handoff (if any). Structural nudge — agents
 * that skipped recall still see context.
 */
function priorHandoffNudge(deja: Deja, state: DispatchState): string {
  if (state.recallSeen) return "";
  const latest = deja.latestHandoffs(1)[0];
  if (!latest) return "";
  const summary = latest.summary.length > 240
    ? latest.summary.slice(0, 240) + "…"
    : latest.summary;
  return `\n\n# fyi — most recent handoff (you have not called recall yet)\n${summary}\n\n(call \`recall\` with a query to search, or \`recall\` with empty query for recents.)`;
}

/**
 * Pure dispatch: maps (toolName, args) -> {text, isError}.
 * Mutates `state.recallSeen`. No transport, no I/O beyond the deja
 * instance. Test-friendly.
 */
export function dispatch(
  deja: Deja,
  state: DispatchState,
  name: string,
  args: Record<string, unknown> = {},
): { text: string; isError?: boolean } {
  try {
    switch (name) {
      case "recall": {
        const query = String(args.query ?? "");
        const limit = Number(args.limit ?? 8);
        state.recallSeen = true;

        if (query.trim().length === 0) {
          const activeHandoff =
            deja.storage.getHandoffBySession(
              process.env.DEJA_SESSION ?? "",
            ) ?? deja.latestHandoffs(1)[0] ?? null;
          const recent = deja.listKept(limit);
          return { text: formatRecents(activeHandoff, recent) };
        }

        const r = deja.recall(query, limit);
        return { text: formatRecall(r, deja.storage) };
      }
      case "remember": {
        const text = String(args.text ?? "");
        const tags = args.tags as string[] | undefined;
        const keep = Boolean(args.keep ?? false);
        const slip = deja.remember(text, { tags });

        let rolledUpHandoff: string | null = null;
        if (keep) {
          deja.keep([slip.id]);
          const sessionSlips = deja.listSession();
          if (sessionSlips.length > 0 && sessionSlips[0]) {
            const h = deja.storage.getHandoffBySession(sessionSlips[0].sessionId);
            if (h && Math.abs(h.createdAt - Date.now()) < 5000) {
              rolledUpHandoff = h.id;
            }
          }
        }

        const base = `${keep ? "kept" : "drafted"} slip ${slip.id}${
          keep ? "" : " (auto-expires in 24h unless kept)"
        }`;
        const trailer = rolledUpHandoff
          ? ` — auto-rolled into session handoff ${rolledUpHandoff}; visible to next agent on any recall`
          : "";
        return { text: base + trailer + priorHandoffNudge(deja, state) };
      }
      case "handoff": {
        const summary = String(args.summary ?? "");
        const next = args.next as string[] | undefined;
        const h = deja.handoff({ summary, next });
        return {
          text:
            `handoff ${h.id} written (${h.kept.length} slip(s) kept)` +
            priorHandoffNudge(deja, state),
        };
      }
      case "signal": {
        const id = String(args.id ?? "");
        const action = String(args.action ?? "");
        if (!id) return { text: "error: id is required", isError: true };
        switch (action) {
          case "used":
            deja.used(id);
            return { text: `signal: ${id} used (+1)` };
          case "wrong":
            deja.wrong(id);
            return { text: `signal: ${id} wrong (+1)` };
          case "forget": {
            const ok = deja.forget(id);
            return {
              text: ok
                ? `signal: ${id} forgotten (expired, no undo)`
                : `signal: ${id} not forgotten (already expired or not found)`,
            };
          }
          default:
            return {
              text: `error: unknown action '${action}' (expected used | wrong | forget)`,
              isError: true,
            };
        }
      }
      case "send": {
        const to = String(args.to ?? "");
        const body = String(args.body ?? "");
        const threadId = args.threadId ? String(args.threadId) : undefined;
        const msg = deja.send({ to, body, threadId });
        return { text: `sent ${msg.id} to ${msg.to} (thread ${msg.threadId})` };
      }
      case "inbox": {
        const to = String(args.to ?? process.env.DEJA_AUTHOR ?? "unknown-agent");
        const limit = Number(args.limit ?? 20);
        const includeRead = Boolean(args.includeRead ?? false);
        const msgs = deja.inbox(to, { limit, includeRead });
        if (msgs.length === 0) return { text: `(no ${includeRead ? "" : "unread "}messages for ${to})` };
        return { text: msgs.map((m) => `${m.id}  ${m.state}  ${new Date(m.createdAt).toISOString()}  from ${m.from}  thread ${m.threadId}\n${m.body}`).join("\n\n") };
      }
      case "read": {
        const id = String(args.id ?? "");
        if (!id) return { text: "error: id is required", isError: true };
        const ok = deja.read(id);
        return { text: ok ? `read ${id}` : `message ${id} not found`, ...(ok ? {} : { isError: true }) };
      }
      case "reply": {
        const id = String(args.id ?? "");
        const body = String(args.body ?? "");
        const msg = deja.reply(id, body);
        return { text: `replied ${msg.id} to ${msg.to} (thread ${msg.threadId})` };
      }
      default:
        return { text: `unknown tool: ${name}`, isError: true };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { text: `error: ${msg}`, isError: true };
  }
}

// Bootstrap is gated on `import.meta.main` so importing this module from
// tests / harnesses doesn't open ~/.deja/deja.db or hijack stdio. Only
// the top-level invocation (`bun run src/mcp.ts`) starts the server.
if (import.meta.main) {
  const dbPath = process.env.DEJA_DB ?? defaultDbPath();
  const deja = new Deja({ path: dbPath });
  const dispatchState = newDispatchState();
  await runServer(deja, dispatchState);
}

async function runServer(deja: Deja, dispatchState: DispatchState): Promise<void> {
  const server = new Server(
    { name: "deja", version: "0.0.3" },
    { capabilities: { tools: {} } },
  );

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "recall",
      description:
        "Search agent memory for facts, decisions, preferences, and project-specific conventions the user (or a previous agent) wrote down. Use this BEFORE answering questions about: 'this project', 'this codebase', 'this repo', the user's preferences/setup/tools, decisions made in past sessions, work-in-progress, or anything where the answer could differ from generic best practice. Returns ranked hits with trust labels (high/medium/low) and the most recent handoff. Treat high-trust hits as authoritative — they are what the user actually decided. Empty or whitespace-only query returns 'what's recent' instead of searching: active handoff + the N most recent kept slips. Cheap call — use it at session start when you don't know what to ask.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search. Broaden if the first query returns no hits. Pass empty string for 'what's recent' (active handoff + recent kept slips)." },
          limit: {
            type: "number",
            description: "Max hits (default 8).",
            default: 8,
          },
        },
        required: ["query"],
      },
    },
    {
      name: "remember",
      description:
        "Jot a memory. Default state is 'draft' (auto-expires in 24h). Pass keep=true to promote immediately. Tags are optional, free-form.",
      inputSchema: {
        type: "object",
        properties: {
          text: { type: "string", description: "What to remember." },
          tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional free-form tags.",
          },
          keep: {
            type: "boolean",
            description:
              "Promote to kept immediately. Default false (drafts auto-GC at 24h).",
            default: false,
          },
        },
        required: ["text"],
      },
    },
    {
      name: "handoff",
      description:
        "Close this session with a note for the next agent. One handoff per session — write it once, in your own voice. All drafts in this session are auto-promoted to kept.",
      inputSchema: {
        type: "object",
        properties: {
          summary: {
            type: "string",
            description: "What happened this session, in your voice.",
          },
          next: {
            type: "array",
            items: { type: "string" },
            description:
              "Optional: things the next agent should do or watch for.",
          },
        },
        required: ["summary"],
      },
    },
    {
      name: "signal",
      description:
        "Close the feedback loop on a recalled slip. Three actions: 'used' bumps usedCount (the slip was helpful — confirms the trust label), 'wrong' bumps wrongCount (the slip was misleading or stale — warns future recalls), 'forget' expires the slip permanently (no undo; use when something was written incorrectly with keep=true). Use 'used' liberally; use 'forget' only when you're sure the slip is wrong, not just outdated (prefer writing a new slip that supersedes via remember).",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Slip ULID to signal on (from a recall hit).",
          },
          action: {
            type: "string",
            enum: ["used", "wrong", "forget"],
            description:
              "'used' = helpful. 'wrong' = misleading. 'forget' = expire (irreversible).",
          },
        },
        required: ["id", "action"],
      },
    },
    {
      name: "send",
      description: "Send a short async message to another local agent identity. This is mailbox-only: the recipient must call inbox. Use to coordinate with Pi/OpenCode/Claude/etc. Set to the recipient's DEJA_AUTHOR.",
      inputSchema: { type: "object", properties: { to: { type: "string" }, body: { type: "string" }, threadId: { type: "string" } }, required: ["to", "body"] },
    },
    {
      name: "inbox",
      description: "Read messages addressed to an agent identity (default: this process's DEJA_AUTHOR). Call this when starting, when asked to check for work, or after sending a message and waiting for a reply.",
      inputSchema: { type: "object", properties: { to: { type: "string" }, limit: { type: "number", default: 20 }, includeRead: { type: "boolean", default: false } } },
    },
    {
      name: "read",
      description: "Mark a mailbox message read by id.",
      inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "reply",
      description: "Reply to a mailbox message by id. The reply goes to the original sender and stays in the same thread.",
      inputSchema: { type: "object", properties: { id: { type: "string" }, body: { type: "string" } }, required: ["id", "body"] },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  const result = dispatch(deja, dispatchState, name, args as Record<string, unknown>);
  return {
    content: [{ type: "text", text: result.text }],
    ...(result.isError ? { isError: true } : {}),
  };
});

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
