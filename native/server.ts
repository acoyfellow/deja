type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type JsonObject = { [key: string]: JsonValue };

type RpcRequest = {
  id?: JsonValue;
  method?: string;
  params?: ToolCallParams | null;
};

type ToolCallParams = {
  name?: string;
  arguments?: JsonObject;
};

const VERSION = "0.1.0";

const memoryKinds: JsonValue[] = ["decision", "preference", "procedure", "pitfall", "fact", "wip", "note"];

const toolNames = ["recall", "remember", "handoff", "assess", "link", "resolve_handoff", "signal", "redact", "send", "inbox", "read", "reply"];

const tools: JsonValue[] = [
  {
    name: "recall",
    description: "Search agent memory for facts, decisions, preferences, and project-specific conventions the user (or a previous agent) wrote down. Use this BEFORE answering questions about: 'this project', 'this codebase', 'this repo', the user's preferences/setup/tools, decisions made in past sessions, work-in-progress, or anything where the answer could differ from generic best practice. Returns repository-scoped hits with evidence trust (high = repeatedly useful, medium = kept but unconfirmed, low = draft or disputed), provenance, and the most recent handoff from this repository. Trust is not truth: verify mutable facts against live state. Empty or whitespace-only query returns 'what's recent' instead of searching: active handoff + the N most recent kept slips. Cheap call — use it at session start when you don't know what to ask.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Free-text search. Broaden if the first query returns no hits. Pass empty string for 'what's recent' (active handoff + recent kept slips)." },
        limit: { type: "number", description: "Max hits (default 8).", default: 8 },
        maxTokens: { type: "number", description: "Approximate context budget. Default 900 tokens.", default: 900 },
        kinds: { type: "array", items: { type: "string", enum: memoryKinds }, description: "Optional memory-kind filter." }
      },
      required: ["query"]
    }
  },
  {
    name: "remember",
    description: "Jot a memory. Default state is 'draft' (auto-expires in 24h). Pass keep=true to promote immediately. Tags are optional, free-form.",
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "What to remember." },
        tags: { type: "array", items: { type: "string" }, description: "Optional free-form tags." },
        kind: { type: "string", enum: memoryKinds, description: "Memory class. Deja infers conservatively when omitted." },
        supersedes: { type: "array", items: { type: "string" }, description: "Older slip ids this memory replaces." },
        contradicts: { type: "array", items: { type: "string" }, description: "Slip ids this memory explicitly disputes." },
        keep: { type: "boolean", description: "Promote to kept immediately. Default false (drafts auto-GC at 24h).", default: false }
      },
      required: ["text"]
    }
  },
  {
    name: "handoff",
    description: "Close this session with a note for the next agent. One handoff per session — write it once, in your own voice. All drafts in this session are auto-promoted to kept.",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string", description: "What happened this session, in your voice." },
        next: { type: "array", items: { type: "string" }, description: "Optional: things the next agent should do or watch for." }
      },
      required: ["summary"]
    }
  },
  {
    name: "assess",
    description: "Evaluate a recall receipt after acting. This measures retrieval quality separately from whether one slip was useful.",
    inputSchema: {
      type: "object",
      properties: {
        traceId: { type: "string", description: "Recall receipt id shown at the top of recall output." },
        assessment: { type: "string", enum: ["useful", "wrong", "missed", "no_memory_needed"] },
        note: { type: "string", description: "Optional short evidence note; do not paste transcripts." }
      },
      required: ["traceId", "assessment"]
    }
  },
  {
    name: "link",
    description: "Relate two memories in the current repository. Use supersedes when a newer memory replaces an older one; contradictions remain visible for auditability.",
    inputSchema: {
      type: "object",
      properties: {
        fromId: { type: "string" },
        toId: { type: "string" },
        kind: { type: "string", enum: ["supersedes", "contradicts", "related"] }
      },
      required: ["fromId", "toId", "kind"]
    }
  },
  {
    name: "resolve_handoff",
    description: "Mark an active handoff completed or abandoned so it stops directing future agents.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        status: { type: "string", enum: ["completed", "abandoned"], default: "completed" }
      },
      required: ["id"]
    }
  },
  {
    name: "signal",
    description: "Close the feedback loop on a recalled slip. Three actions: 'used' bumps usedCount (the slip was helpful — confirms the trust label), 'wrong' bumps wrongCount (the slip was misleading or stale — warns future recalls), 'forget' expires the slip permanently (no undo; use when something was written incorrectly with keep=true). Use 'used' when a memory materially helped; two successful uses promote a kept memory to high trust. Use 'wrong' when misleading. Use 'forget' only when you're sure the slip is wrong, not merely outdated.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string", description: "Slip ULID to signal on (from a recall hit)." },
        action: { type: "string", enum: ["used", "wrong", "forget"], description: "'used' = helpful. 'wrong' = misleading. 'forget' = expire (irreversible)." }
      },
      required: ["id", "action"]
    }
  },
  {
    name: "redact",
    description: "Explicitly mask a slip in recall output. The raw text stays in the local SQLite file; only direct inspection (e.g. deja show) can read it after this call. Use when a memory accidentally contains a secret, credential, or customer content.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Slip ULID to redact." } },
      required: ["id"]
    }
  },
  {
    name: "send",
    description: "Send a short async message to another local agent identity. This is mailbox-only: the recipient must call inbox. Use to coordinate with Pi/OpenCode/Claude/etc. Set to the recipient's DEJA_AUTHOR.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, body: { type: "string" }, threadId: { type: "string" } },
      required: ["to", "body"]
    }
  },
  {
    name: "inbox",
    description: "Read messages addressed to an agent identity (default: this process's DEJA_AUTHOR). Call this when starting, when asked to check for work, or after sending a message and waiting for a reply.",
    inputSchema: {
      type: "object",
      properties: { to: { type: "string" }, limit: { type: "number", default: 20 }, includeRead: { type: "boolean", default: false } }
    }
  },
  {
    name: "read",
    description: "Mark a mailbox message read by id.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }
  },
  {
    name: "reply",
    description: "Reply to a mailbox message by id. The reply goes to the original sender and stays in the same thread.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, body: { type: "string" } },
      required: ["id", "body"]
    }
  }
];

function response(id: JsonValue, result: JsonValue) {
  return { jsonrpc: "2.0", id, result };
}

function errorResponse(id: JsonValue, code: number, message: string) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolResponse(id: JsonValue, text: string, isError: boolean) {
  return {
    jsonrpc: "2.0",
    id,
    result: { content: [{ type: "text", text }], isError }
  };
}

function handleRequest(request: RpcRequest): ReturnType<typeof response> | ReturnType<typeof errorResponse> | ReturnType<typeof toolResponse> | null {
  const id = request.id === undefined ? null : request.id;
  const method = typeof request.method === "string" ? request.method : "";
  if (method === "initialize") {
    return response(id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: {} },
      serverInfo: { name: "deja-native", version: VERSION }
    });
  }
  if (method === "notifications/initialized") {
    return null;
  }
  if (method === "ping") {
    return response(id, {});
  }
  if (method === "tools/list") {
    return response(id, { tools });
  }
  if (method === "tools/call") {
    const params = request.params;
    if (params === null || params === undefined) {
      return errorResponse(id, -32602, "Invalid tools/call params");
    }
    const name = typeof params.name === "string" ? params.name : "";
    let known = false;
    for (let index = 0; index < toolNames.length; index += 1) {
      if (toolNames[index] === name) {
        known = true;
      }
    }
    if (!known) {
      return toolResponse(id, "unknown tool: " + name, true);
    }
    return toolResponse(id, "deja-native storage is not configured; set DEJA_DB when a native storage adapter is available", true);
  }
  return errorResponse(id, -32601, "Method not found: " + method);
}

let input = "";
process.stdin.on("data", (chunk: Uint8Array) => {
  for (let index = 0; index < chunk.length; index += 1) {
    input += String.fromCharCode(chunk[index] ?? 0);
  }
  let newline = input.indexOf("\n");
  while (newline >= 0) {
    const line = input.slice(0, newline).trim();
    input = input.slice(newline + 1);
    if (line.length > 0) {
      try {
        const parsed = JSON.parse(line) as RpcRequest;
        const output = handleRequest(parsed);
        if (output !== null) {
          process.stdout.write(JSON.stringify(output) + "\n");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stdout.write(JSON.stringify(errorResponse(null, -32700, "Parse error: " + message)) + "\n");
      }
    }
    newline = input.indexOf("\n");
  }
});
