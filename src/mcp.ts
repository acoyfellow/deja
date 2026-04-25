#!/usr/bin/env bun
/**
 * deja MCP server — local stdio.
 *
 * Three tools, matching the four-verb library exactly minus `keep`:
 *   recall    — search; returns hits + active handoff
 *   remember  — jot a slip (draft by default; pass keep=true to skip the draft step)
 *   handoff   — close the session with a summary
 *
 * `keep` is folded into `remember(keep: true)` because MCP clients tend
 * to treat tools as one-shot — promoting separately is friction. The
 * library still exposes keep() for in-process callers.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Deja, defaultDbPath } from "./index.ts";

const dbPath = process.env.DEJA_DB ?? defaultDbPath();
const deja = new Deja({ path: dbPath });

const server = new Server(
  { name: "deja", version: "0.0.2" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "recall",
      description:
        "Search agent memory for facts, decisions, preferences, and project-specific conventions the user (or a previous agent) wrote down. Use this BEFORE answering questions about: 'this project', 'this codebase', 'this repo', the user's preferences/setup/tools, decisions made in past sessions, work-in-progress, or anything where the answer could differ from generic best practice. Returns ranked hits with trust labels (high/medium/low) and the most recent handoff. Treat high-trust hits as authoritative — they are what the user actually decided.",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Free-text search. Broaden if the first query returns no hits." },
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
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;

  try {
    switch (name) {
      case "recall": {
        const query = String((args as { query?: unknown }).query ?? "");
        const limit = Number((args as { limit?: unknown }).limit ?? 8);
        const r = deja.recall(query, limit);
        const text = formatRecall(r);
        return { content: [{ type: "text", text }] };
      }
      case "remember": {
        const text = String((args as { text?: unknown }).text ?? "");
        const tags = (args as { tags?: unknown }).tags as string[] | undefined;
        const keep = Boolean((args as { keep?: unknown }).keep ?? false);
        const slip = deja.remember(text, { tags });

        let rolledUpHandoff: string | null = null;
        if (keep) {
          deja.keep([slip.id]);
          // If keep auto-rolled this slip into a session handoff, surface
          // that fact in the response. Tells the agent "this is now
          // discoverable on every recall" without needing a second call.
          const sessionId = (deja.options as { path?: string } & { sessionId?: string })
            ? undefined // session id resolved internally
            : undefined;
          // Fish the session's handoff out (if any) to confirm rollup
          const sessionSlips = deja.listSession();
          if (sessionSlips.length > 0 && sessionSlips[0]) {
            const h = deja.storage.getHandoffBySession(sessionSlips[0].sessionId);
            // Only mention rollup if the handoff was created in this turn
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
        return { content: [{ type: "text", text: base + trailer }] };
      }
      case "handoff": {
        const summary = String((args as { summary?: unknown }).summary ?? "");
        const next = (args as { next?: unknown }).next as string[] | undefined;
        const h = deja.handoff({ summary, next });
        return {
          content: [
            {
              type: "text",
              text: `handoff ${h.id} written (${h.kept.length} slip(s) kept)`,
            },
          ],
        };
      }
      default:
        return {
          content: [{ type: "text", text: `unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `error: ${msg}` }],
      isError: true,
    };
  }
});

function formatRecall(r: ReturnType<Deja["recall"]>): string {
  const parts: string[] = [];
  if (r.activeHandoff) {
    parts.push(
      `# previous handoff\n${r.activeHandoff.summary}` +
        (r.activeHandoff.next.length > 0
          ? `\n\nnext:\n${r.activeHandoff.next.map((n) => `- ${n}`).join("\n")}`
          : ""),
    );
  }

  if (r.hits.length === 0) {
    parts.push(
      `# recall("${r.query}") — no hits\nTry a broader or differently-phrased query (one or two words, synonyms) before falling back to general knowledge. If still nothing, the user has not recorded this yet — it is safe to ask them or proceed without memory.`,
    );
  } else {
    const hasHigh = r.hits.some((h) => h.trust === "high");
    const heading = hasHigh
      ? `# recall("${r.query}") — high-trust hit found, treat as authoritative`
      : `# recall("${r.query}")`;
    parts.push(heading);
    for (const h of r.hits) {
      const tags =
        h.slip.tags.length > 0 ? ` [${h.slip.tags.join(", ")}]` : "";
      const prefix =
        h.trust === "high"
          ? "**[high — the user recorded this]**"
          : h.trust === "medium"
            ? "**[medium]**"
            : "**[low — verify before relying on]**";
      parts.push(
        `- ${prefix} ${h.slip.id}${tags}\n  ${h.slip.text.replace(/\n/g, "\n  ")}`,
      );
    }
  }
  return parts.join("\n\n");
}

const transport = new StdioServerTransport();
await server.connect(transport);
