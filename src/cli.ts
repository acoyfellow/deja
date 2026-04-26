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
import { Deja, defaultDbPath } from "./index.ts";
import { currentSessionId } from "./lifecycle.ts";

function usage(): never {
  console.log(`deja — local-first agent memory

Usage:
  deja init                  Create the DB + print MCP wiring snippet
  deja mcp                   Run the MCP server (stdio — for agent clients)
  deja verify                Check DB
  deja recall <query>        Search slips (FTS5)
  deja ls [--session]        List kept slips (or current session's slips)
  deja show <id>             Show a slip + its links
  deja stats                 Print counts and DB path
  deja handoffs              List recent handoffs

Env:
  DEJA_AUTHOR    Identity recorded with new slips (default: unknown-agent)
  DEJA_SESSION   Override session id (default: derived per-process)
  DEJA_DB        Override DB path (default: ~/.deja/deja.db)
`);
  process.exit(1);
}

function dbPath(): string {
  return process.env.DEJA_DB ?? defaultDbPath();
}

function fmtSlip(s: ReturnType<Deja["get"]> & object): string {
  const tags = s.tags.length > 0 ? ` [${s.tags.join(", ")}]` : "";
  const state = s.state.padEnd(7);
  const date = new Date(s.createdAt).toISOString().slice(0, 19);
  return `${s.id}  ${state}  ${date}  ${s.authoredBy}${tags}\n  ${s.text.replace(/\n/g, "\n  ")}`;
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
  const c = d.counts();
  console.log(`slips: ${c.slips} (${c.kept} kept, ${c.drafts} draft)`);
  console.log(`handoffs: ${c.handoffs}`);
  d.close();
  console.log(`session: ${currentSessionId()}`);
}

function cmdRecall(args: string[]): void {
  const query = args.join(" ").trim();
  if (!query) {
    console.error("usage: deja recall <query>");
    process.exit(1);
  }
  const d = new Deja({ path: dbPath(), skipGc: true });
  const r = d.recall(query, 10);
  if (r.activeHandoff) {
    console.log(`-- active handoff (this session) --`);
    console.log(`  ${r.activeHandoff.summary}`);
    if (r.activeHandoff.next.length > 0) {
      console.log(`  next:`);
      for (const n of r.activeHandoff.next) console.log(`    - ${n}`);
    }
    console.log();
  }
  if (r.hits.length === 0) {
    console.log(`(no hits for "${query}")`);
  } else {
    for (const h of r.hits) {
      console.log(`[${h.trust}] ${fmtSlip(h.slip)}`);
      console.log();
    }
  }
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
  console.log(`slips:    ${c.slips}`);
  console.log(`  kept:   ${c.kept}`);
  console.log(`  drafts: ${c.drafts}`);
  console.log(`  expired:${c.slips - c.kept - c.drafts}`);
  console.log(`handoffs: ${c.handoffs}`);
  d.close();
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

const [, , cmd, ...rest] = process.argv;
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
  default:
    usage();
}
