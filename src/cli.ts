#!/usr/bin/env bun
/**
 * deja CLI — local introspection + MCP launcher.
 *
 * Subcommands:
 *   deja init              Create the DB + print MCP wiring snippet
 *   deja mcp               Run the MCP server (stdio)
 *   deja verify            Check DB exists and is readable
 *   deja recall <query>    Search slips
 *   deja ls [--session]    List kept slips (or current session)
 *   deja show <id>         Show a slip + its links
 *   deja stats             Counts and DB path
 *   deja handoffs          List recent handoffs
 *
 * The CLI is for humans poking at the DB. Agents use `deja mcp`.
 *
 * deja deliberately does NOT write a SKILL.md. The MCP tool descriptions
 * are the spec the agent works from. Bullets in a markdown file are
 * decaying prompts; the tool is the prompt.
 */

import { dirname } from "node:path";
import { existsSync } from "node:fs";
import { Deja, SharedDeja, defaultDbPath } from "./index.ts";
import { currentSessionId } from "./lifecycle.ts";

function usage(): never {
  console.log(`deja — local-first agent memory

Usage:
  deja as <author> <command...>  Run a command as an agent identity
  deja init                  Create the DB + print MCP wiring snippet
  deja mcp                   Run the MCP server (stdio — for agent clients)
  deja verify                Check schema, SQLite integrity, and FTS coverage
  deja recall [query] [--tokens=N] [--kind=decision,pitfall]
  deja remember <text> [--keep] [--kind=decision]
  deja handoff <summary>     Leave one active handoff for this session
  deja resolve <id> [completed|abandoned]
  deja link <from> <supersedes|contradicts|related> <to>
deja assess <trace> <useful|wrong|missed|no_memory_needed> [note]
   deja eval                  Show scoped recall-quality evidence
   deja redact <id>           Mask a slip in recall output; raw text stays local
   deja forget-session <id> --yes  Expire a session's scoped slips
  deja ls [--session]        List kept slips (or current session's slips)
  deja show <id>             Show a slip + its links
  deja stats                 Print counts and DB path
  deja handoffs              List recent handoffs
  deja send <to> <message>   Send async mailbox message
  deja inbox [to]            Read unread mailbox messages
  deja read <id>             Mark message read
  deja reply <id> <message>  Reply to a message
  deja shared status          Check shared local copy/current state
  deja shared recall <query>  Search shared local copy
  deja shared remember <text> Save shared memory
  deja shared handoff <text>  Leave shared handoff
  deja shared signal <id> <used|wrong|forget>
  deja shared delete <id>     Delete shared memory content locally + from server replay
  deja shared mcp             Run shared MCP server

Env:
  DEJA_AUTHOR    Identity recorded with new slips (default: unknown-agent)
  DEJA_SESSION   Override session id (default: derived per-process)
  DEJA_DB        Override DB path (default: ~/.deja/deja.db)
  DEJA_SCOPE     Override automatic git-repository scope (use global deliberately)
  DEJA_INCLUDE_LEGACY  Set to 1 to search pre-scope rows during migration
  DEJA_SHARED_GATEWAY  Shared memory server URL (required for shared commands)
  DEJA_SHARED_TOKEN    Bearer token for the shared memory server
  DEJA_SHARED_MIRROR_DB Local searchable shared-copy DB path (optional)
`);
  process.exit(1);
}

function dbPath(): string {
  return process.env.DEJA_DB ?? defaultDbPath();
}

function author(): string {
  return process.env.DEJA_AUTHOR ?? "unknown-agent";
}

function fmtSlip(s: ReturnType<Deja["get"]> & object): string {
  const tags = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
  const state = s.state.padEnd(7);
  const date = new Date(s.createdAt).toISOString().slice(0, 19);
  return `${s.id}  ${state}  ${date}  ${s.authoredBy}${tags}\n  scope: ${s.scope}\n  ${s.text.replace(/\n/g, "\n  ")}`;
}

async function cmdInit(): Promise<void> {
  const path = dbPath();
  const d = new Deja({ path });
  d.close();
  console.log(`deja: db ready at ${path}`);

  console.log(`
Wire deja into your MCP client. Tool descriptions are the spec — no SKILL.md, no AGENTS.md.

If you ran this via 'bunx github:acoyfellow/deja init', the MCP server is reachable
the same way: 'bunx github:acoyfellow/deja mcp'. If you cloned, use the local path.

Claude Code (~/.config/claude-code/mcp.json):

  {
    "mcpServers": {
      "deja": {
        "command": "bunx",
        "args": ["github:acoyfellow/deja", "mcp"]
      }
    }
  }

OpenCode (~/.config/opencode/opencode.jsonc):

  "mcp": {
    "deja": {
      "type": "local",
      "command": ["bunx", "github:acoyfellow/deja", "mcp"]
    }
  }

pi (~/.pi/agent/mcp.json):

  {
    "mcpServers": {
      "deja": {
        "command": "bunx",
        "args": ["github:acoyfellow/deja", "mcp"]
      }
    }
  }

(Cloned the repo instead? Replace 'bunx github:acoyfellow/deja' with
 'bun run ${import.meta.dir}/cli.ts' in any of the above.)
`);
}

function cmdVerify(): void {
  const path = dbPath();
  const exists = existsSync(path);
  console.log(`db:    ${path} ${exists ? "OK" : "MISSING"}`);
  if (!exists) process.exit(1);

  const d = new Deja({ path, skipGc: true });
  const health = d.storage.health();
  const c = d.counts();
  console.log(`scope: ${d.scope}`);
  console.log(`sqlite: ${health.sqlite}`);
  console.log(`fts: ${health.indexed}/${health.slips} indexed`);
  console.log(`slips: ${c.slips} (${c.kept} kept, ${c.drafts} draft)`);
  console.log(`handoffs: ${c.handoffs}`);
  console.log(`messages: ${c.messages} (${c.pending} pending)`);
  d.close();
  console.log(`session: ${currentSessionId()}`);
  if (!health.ok) process.exit(1);
}

function cmdRecall(args: string[]): void {
  const maxTokens = Number(args.find((arg) => arg.startsWith("--tokens="))?.split("=")[1] ?? 1200);
  const kindArg = args.find((arg) => arg.startsWith("--kind="))?.split("=")[1];
  const kinds = kindArg ? kindArg.split(",") as import("./types.ts").MemoryKind[] : undefined;
  const query = args.filter((arg) => !arg.startsWith("--tokens=") && !arg.startsWith("--kind=")).join(" ").trim();
  const d = new Deja({ path: dbPath(), skipGc: true });
  const r = d.recall(query, { limit: 10, maxTokens, kinds });
  console.log(`receipt: ${r.traceId}`);
  if (r.activeHandoff) {
    console.log(`-- active handoff (${r.activeHandoff.scope}) --`);
    console.log(`  ${r.activeHandoff.summary}`);
    if (r.activeHandoff.next.length > 0) {
      console.log(`  next:`);
      for (const n of r.activeHandoff.next) console.log(`    - ${n}`);
    }
    console.log();
  }
  if (r.hits.length === 0) {
    console.log(query ? `(no hits for "${query}")` : "(no recent scoped memory)");
  } else {
    for (const h of r.hits) {
      console.log(`[${h.trust}] ${fmtSlip(h.slip)}`);
      console.log();
    }
  }
  d.close();
}

function cmdRemember(args: string[]): void {
  const keep = args.includes("--keep");
  const kindArg = args.find((arg) => arg.startsWith("--kind="))?.split("=")[1] as import("./types.ts").MemoryKind | undefined;
  const text = args.filter((arg) => arg !== "--keep" && !arg.startsWith("--kind=")).join(" ").trim();
  if (!text) throw new Error("usage: deja remember <text> [--keep] [--kind=decision]");
  const d = new Deja({ path: dbPath(), skipGc: true });
  const slip = d.remember(text, { kind: kindArg });
  if (keep) d.keep([slip.id]);
  console.log(`${keep ? "kept" : "drafted"} ${slip.kind} ${slip.id} in ${slip.scope}`);
  d.close();
}

function cmdWriteHandoff(args: string[]): void {
  const summary = args.join(" ").trim();
  if (!summary) throw new Error("usage: deja handoff <summary>");
  const d = new Deja({ path: dbPath(), skipGc: true });
  const handoff = d.handoff({ summary });
  console.log(`active handoff ${handoff.id} (${handoff.kept.length} slip(s) kept)`);
  d.close();
}

function cmdResolve(args: string[]): void {
  const id = args[0];
  const status = (args[1] ?? "completed") as "completed" | "abandoned";
  if (!id || !["completed", "abandoned"].includes(status)) throw new Error("usage: deja resolve <id> [completed|abandoned]");
  const d = new Deja({ path: dbPath(), skipGc: true });
  if (!d.resolveHandoff(id, status)) throw new Error(`active handoff ${id} not found`);
  console.log(`handoff ${id}: ${status}`);
  d.close();
}

function cmdLink(args: string[]): void {
  const [from, kind, to] = args as [string | undefined, import("./types.ts").LinkKind | undefined, string | undefined];
  if (!from || !to || !kind || !["supersedes", "contradicts", "related"].includes(kind)) throw new Error("usage: deja link <from> <supersedes|contradicts|related> <to>");
  const d = new Deja({ path: dbPath(), skipGc: true });
  if (!d.link(from, to, kind)) throw new Error("both slips must exist in the current repository scope");
  console.log(`linked ${from} ${kind} ${to}`);
  d.close();
}

function cmdAssess(args: string[]): void {
  const [traceId, assessment, ...noteParts] = args as [string | undefined, import("./types.ts").RecallAssessment | undefined, ...string[]];
  if (!traceId || !assessment || !["useful", "wrong", "missed", "no_memory_needed"].includes(assessment)) throw new Error("usage: deja assess <trace> <useful|wrong|missed|no_memory_needed> [note]");
  const d = new Deja({ path: dbPath(), skipGc: true });
  if (!d.assessRecall(traceId, assessment, noteParts.join(" "))) throw new Error(`recall trace ${traceId} not found`);
  console.log(`recall ${traceId}: ${assessment}`);
  d.close();
}

function cmdRedact(args: string[]): void {
  const id = args[0];
  if (!id) throw new Error("usage: deja redact <id>");
  const d = new Deja({ path: dbPath(), skipGc: true });
  if (!d.redact(id)) throw new Error(`slip ${id} not found or already redacted`);
  console.log(`redacted ${id} — raw text remains in local DB but is masked in recall output`);
  d.close();
}

function cmdEval(): void {
  const d = new Deja({ path: dbPath(), skipGc: true });
  const report = d.recallReport();
  console.log(`scope: ${d.scope}`);
  console.log(`recalls: ${report.total}`);
  console.log(`assessed: ${report.assessed}`);
  console.log(`  useful: ${report.useful}`);
  console.log(`  wrong: ${report.wrong}`);
  console.log(`  missed: ${report.missed}`);
  console.log(`  no memory needed: ${report.noMemoryNeeded}`);
  const actionable = report.useful + report.wrong + report.missed;
  if (actionable > 0) console.log(`useful share of actionable recalls: ${((report.useful / actionable) * 100).toFixed(1)}%`);
  d.close();
}

function cmdForgetSession(args: string[]): void {
  const sessionId = args.find((arg) => arg !== "--yes");
  if (!sessionId || !args.includes("--yes")) throw new Error("usage: deja forget-session <id> --yes");
  const d = new Deja({ path: dbPath(), skipGc: true });
  console.log(`expired ${d.forgetSession(sessionId)} slip(s) from ${sessionId} in ${d.scope}`);
  d.close();
}

function cmdLs(args: string[]): void {
  const useSession = args.includes("--session");
  const d = new Deja({ path: dbPath(), skipGc: true });
  const slips = useSession ? d.listSession() : d.listKept(50);
  if (slips.length === 0) {
    console.log(useSession ? "(no slips in this session)" : "(no kept slips)");
  } else {
    for (const s of slips) {
      console.log(fmtSlip(s));
      console.log();
    }
  }
  d.close();
}

function cmdShow(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error("usage: deja show <id>");
    process.exit(1);
  }
  const d = new Deja({ path: dbPath(), skipGc: true });
  const s = d.get(id);
  if (!s) {
    console.error(`(no slip ${id})`);
    process.exit(1);
  }
  console.log(fmtSlip(s));
  console.log(`  used: ${s.usedCount}, wrong: ${s.wrongCount}`);
  const links = d.storage.linksFrom(s.id);
  if (links.length > 0) {
    console.log(`  links:`);
    for (const l of links) console.log(`    ${l.kind} -> ${l.toId}`);
  }
  d.close();
}

function cmdStats(): void {
  const d = new Deja({ path: dbPath(), skipGc: true });
  const c = d.counts();
  console.log(`db:       ${d.storage.path}`);
  console.log(`scope:    ${d.scope} (${d.context.source})`);
  console.log(`root:     ${d.context.root}`);
  console.log(`slips:    ${c.slips}`);
  console.log(`  kept:   ${c.kept}`);
  console.log(`  drafts: ${c.drafts}`);
  console.log(`  expired:${c.slips - c.kept - c.drafts}`);
  console.log(`handoffs: ${c.handoffs}`);
  console.log(`messages: ${c.messages}`);
  console.log(`  pending:${c.pending}`);
  d.close();
}

function fmtMsg(m: ReturnType<Deja["inbox"]>[number]): string {
  const date = new Date(m.createdAt).toISOString().slice(0, 19);
  const delivery = m.delivery
    ? m.delivery.ok
      ? `\n  delivered via ${m.delivery.transport}: ${m.delivery.path}`
      : `\n  mailbox-only: ${m.delivery.reason}`
    : "";
  return `${m.id}  ${m.state}  ${date}  ${m.from} -> ${m.to}  thread ${m.threadId}\n  ${m.body.replace(/\n/g, "\n  ")}${delivery}`;
}

function cmdSend(args: string[]): void {
  const to = args[0];
  const body = args.slice(1).join(" ").trim();
  if (!to || !body) {
    console.error("usage: deja send <to> <message>");
    process.exit(1);
  }
  const d = new Deja({ path: dbPath(), skipGc: true });
  const m = d.send({ to, body });
  console.log(fmtMsg(m));
  d.close();
}

function cmdInbox(args: string[]): void {
  const to = args.find((a) => a !== "--all") ?? author();
  const d = new Deja({ path: dbPath(), skipGc: true });
  const msgs = d.inbox(to, { includeRead: args.includes("--all") });
  if (msgs.length === 0) console.log(`(no unread messages for ${to})`);
  for (const m of msgs) console.log(fmtMsg(m) + "\n");
  d.close();
}

function cmdRead(args: string[]): void {
  const id = args[0];
  if (!id) {
    console.error("usage: deja read <id>");
    process.exit(1);
  }
  const d = new Deja({ path: dbPath(), skipGc: true });
  console.log(d.read(id) ? `read ${id}` : `message ${id} not found`);
  d.close();
}

function cmdReply(args: string[]): void {
  const id = args[0];
  const body = args.slice(1).join(" ").trim();
  if (!id || !body) {
    console.error("usage: deja reply <id> <message>");
    process.exit(1);
  }
  const d = new Deja({ path: dbPath(), skipGc: true });
  const m = d.reply(id, body);
  console.log(fmtMsg(m));
  d.close();
}

async function sharedClient(): Promise<SharedDeja> {
  const gateway = process.env.DEJA_SHARED_GATEWAY;
  if (!gateway) throw new Error("DEJA_SHARED_GATEWAY is required for deja shared commands");
  return SharedDeja.connect({ gateway, token: process.env.DEJA_SHARED_TOKEN });
}

async function cmdShared(args: string[]): Promise<void> {
  const sub = args.shift();
  if (sub === "mcp") {
    await import("./shared-mcp.ts");
    return;
  }
  const d = await sharedClient();
  try {
    switch (sub) {
      case "status": {
        const status = await d.refreshStatus();
        console.log(`shared: ${status.status}`);
        console.log(`local copy: ${status.mirrorRevision}`);
        console.log(`server: ${status.knownHeadRevision}`);
        console.log(`behind: ${status.freshness.behind}`);
        console.log(`current: ${status.freshness.fresh ? "yes" : "no"}`);
        return;
      }
      case "recall": {
        const query = args.join(" ").trim();
        if (!query) throw new Error("usage: deja shared recall <query>");
        const result = d.recall(query, 10);
        if (result.latestHandoff) {
          console.log(`-- latest handoff [change ${result.latestHandoff.revision}] --`);
          console.log(`  ${result.latestHandoff.summary}`);
          for (const next of result.latestHandoff.next) console.log(`  next: ${next}`);
          console.log();
        }
        if (result.hits.length === 0) console.log(`(no shared hits for "${query}"; local copy at change ${result.mirrorRevision})`);
        for (const hit of result.hits) console.log(`${hit.slipId}  change ${hit.revision}\n  ${hit.text}\n`);
        return;
      }
      case "remember": {
        const text = args.join(" ").trim();
        if (!text) throw new Error("usage: deja shared remember <text>");
        const saved = await d.remember(text);
        console.log(`saved shared memory ${saved.id} (change ${saved.receipt.revision}; immediately searchable here)`);
        return;
      }
      case "handoff": {
        const summary = args.join(" ").trim();
        if (!summary) throw new Error("usage: deja shared handoff <summary>");
        const saved = await d.handoff(summary);
        console.log(`saved shared handoff ${saved.id} (change ${saved.receipt.revision})`);
        return;
      }
      case "signal": {
        const id = args[0]; const action = args[1] as "used" | "wrong" | "forget" | undefined;
        if (!id || !action || !["used", "wrong", "forget"].includes(action)) throw new Error("usage: deja shared signal <id> <used|wrong|forget>");
        const saved = await d.signal(id, action);
        console.log(`saved shared signal ${id} ${action} (change ${saved.receipt.revision})`);
        return;
      }
      case "delete": {
        const id = args[0];
        if (!id) throw new Error("usage: deja shared delete <id>");
        const saved = await d.delete(id);
        console.log(`deleted shared memory ${id} (change ${saved.receipt.revision}; removed from synced local copies and redacted from server replay)`);
        return;
      }
      default:
        throw new Error("usage: deja shared <status|recall|remember|handoff|signal|delete|mcp> ...");
    }
  } finally {
    await d.close();
  }
}

function cmdHandoffs(): void {
  const d = new Deja({ path: dbPath(), skipGc: true });
  const hs = d.latestHandoffs(10);
  if (hs.length === 0) {
    console.log("(no handoffs)");
  } else {
    for (const h of hs) {
      const date = new Date(h.createdAt).toISOString().slice(0, 19);
      console.log(`${h.id}  ${date}  ${h.authoredBy}  (session ${h.sessionId})`);
      console.log(`  ${h.summary.replace(/\n/g, "\n  ")}`);
      if (h.kept.length > 0) console.log(`  kept: ${h.kept.length} slip(s)`);
      if (h.next.length > 0) {
        console.log(`  next:`);
        for (const n of h.next) console.log(`    - ${n}`);
      }
      console.log();
    }
  }
  d.close();
}

let [, , cmd, ...rest] = process.argv;
if (cmd === "as") {
  const who = rest.shift();
  if (!who || rest.length === 0) {
    console.error("usage: deja as <author> <command...>");
    process.exit(1);
  }
  process.env.DEJA_AUTHOR = who;
  cmd = rest.shift();
}
switch (cmd) {
  case "init":
    await cmdInit();
    break;
  case "mcp":
    // Boot the MCP stdio server in this process. Importing for side
    // effects: mcp.ts attaches to stdin/stdout and connects the
    // transport at module load. Agent clients launch us with
    // `deja mcp` and start sending JSON-RPC.
    await import("./mcp.ts");
    break;
  case "verify":
    cmdVerify();
    break;
  case "recall":
    cmdRecall(rest);
    break;
  case "remember":
    cmdRemember(rest);
    break;
  case "handoff":
    cmdWriteHandoff(rest);
    break;
  case "resolve":
    cmdResolve(rest);
    break;
  case "link":
    cmdLink(rest);
    break;
  case "assess":
    cmdAssess(rest);
    break;
  case "eval":
    cmdEval();
    break;
  case "redact":
    cmdRedact(rest);
    break;
  case "forget-session":
    cmdForgetSession(rest);
    break;
  case "ls":
    cmdLs(rest);
    break;
  case "show":
    cmdShow(rest);
    break;
  case "stats":
    cmdStats();
    break;
  case "handoffs":
    cmdHandoffs();
    break;
  case "send":
    cmdSend(rest);
    break;
  case "inbox":
    cmdInbox(rest);
    break;
  case "read":
    cmdRead(rest);
    break;
  case "reply":
    cmdReply(rest);
    break;
  case "shared":
    await cmdShared(rest);
    break;
  default:
    usage();
}
