# deja

[![ci](https://github.com/acoyfellow/deja/actions/workflows/ci.yml/badge.svg)](https://github.com/acoyfellow/deja/actions/workflows/ci.yml)

Cross-session memory for agents. Four verbs over SQLite + FTS5, exposed via a 3-tool MCP server.

## Install

```bash
git clone https://github.com/acoyfellow/deja
cd deja && bun install
bun run src/cli.ts init   # creates ~/.deja/deja.db, prints MCP wiring
```

Library users (Bun-only for now — not yet on npm):

```bash
bun add github:acoyfellow/deja
```

```ts
import { Deja } from "deja";
const d = new Deja();

d.remember("the user prefers vitest over jest");
d.handoff({ summary: "shipped the auth refactor", next: ["wire it into the gateway"] });

// later, in a fresh process:
const r = d.recall("test runner");
// r.hits[0].slip.text === "the user prefers vitest over jest"
// r.activeHandoff.summary === "shipped the auth refactor"
```

Three things to know:

1. **It's just SQLite.** Stored at `~/.deja/deja.db` by default, FTS5-indexed. No network, no auth, no Worker, no daemon. Open the file with any SQLite client to inspect.
2. **It's append-only.** Slips don't get edited. Contradictions become new slips that link to the old.
3. **It's MCP-shaped.** Designed to be used by agents through an MCP server. The library is also fine for direct use, in Bun.

## Four verbs

```ts
d.remember(text, opts?)         // jot a draft. drafts auto-expire in 24h
d.keep(ids)                     // promote drafts to permanent
d.handoff({ summary, next? })   // close the session for whoever comes next. one per session.
d.recall(query)                 // find slips, plus the most recent handoff
```

Plus three signals that don't change the lifecycle:

```ts
d.forget(id)   // expire a slip (kept or otherwise). no undo
d.used(id)     // record that a recalled slip was helpful
d.wrong(id)    // record that a recalled slip was misleading
```

## Auto-rollup

When you `keep()` a slip whose text or tags look "chain-shaped" — a decision, preference, work-in-progress note — and the current session has no handoff yet, deja writes one for you. The rollup makes the slip discoverable on **every** recall, not just queries that lexically match it.

```ts
const slip = d.remember("Decision: use Bun for new TS libs");
d.keep([slip.id]);  // also writes a session handoff that mentions the decision

const r = d.recall("anything at all");
// r.activeHandoff.summary contains the decision, even though "anything at all"
// doesn't lexically match the slip
```

Disable per-call (`d.keep(ids, { noChainRollup: true })`) or globally (`new Deja({ noChainRollup: true })`).

## CLI

```bash
deja init                  # create the db, print mcp wiring snippet
deja recall <query>        # search slips
deja ls [--session]        # list kept slips (or current session's slips)
deja show <id>             # show a slip + its links
deja stats                 # counts and db path
deja handoffs              # list recent handoffs
```

The CLI is for humans poking at the DB. Agents use the library or MCP.

## MCP

Three tools: `recall`, `remember`, `handoff`. Tool descriptions and responses tell the agent how to use them — no SKILL.md, no AGENTS.md, no system-prompt ceremony.

```jsonc
// ~/.config/claude-code/mcp.json
{
  "mcpServers": {
    "deja": { "command": "bun", "args": ["run", "<path-to-deja>/src/mcp.ts"] }
  }
}
```

Run `deja init` for the wiring snippets for OpenCode and pi.

## Storage layout

Three tables: `slips`, `links`, `handoffs`. Plus a virtual FTS5 table over slip text. See `src/storage.ts:32` for the schema. ULID primary keys (sortable by creation time). Atomic-immutable: state transitions update the row's `state` and timestamps, never the text.

## Env

- `DEJA_DB` — override DB path (default `~/.deja/deja.db`).
- `DEJA_AUTHOR` — identity recorded with new slips (default `unknown-agent`).
- `DEJA_SESSION` — override session id (default: derived per-process).

## Limits

What deja deliberately doesn't do:

- **Not a vector store.** Lexical FTS5 only. Bring your own embeddings if you need semantic search.
- **Not multi-user.** One DB, one user. No accounts, no sharing, no permissions.
- **Not synced.** Local file. Use Syncthing/rsync if you want it on another machine.
- **Not encrypted at rest.** Plain SQLite — don't put secrets in it.
- **Not a platform.** No metrics, no audit log, no rate limits.
- **Not magic.** Agents reach for memory when the question shape suggests it. Some questions ("world-knowledge" ones) never trigger recall; we measured this in [loop 3 s8](docs/loops/2026-04-25-loop-3-three-meta-tools.md) and [loop 4 c1](docs/loops/2026-04-25-loop-4-cross-session-chain.md). It's a model-prior boundary.

## How we know it works

Run the retrieval bench locally:

```bash
bun run bench/recall.ts
# recall@1: 8/8 (100%)   recall@3: 8/8 (100%)
```

Run the behavioral bench locally:

```bash
bun run bench:behavior
# writes docs/bench/behavior-latest.md
```

Read:

- [`docs/bench/latest.txt`](docs/bench/latest.txt) — retrieval bench, regenerated by CI on every push to `main`.
- [`docs/bench/behavior-latest.md`](docs/bench/behavior-latest.md) — behavioral hypotheses, metrics, evidence, and recommendations.
- [`docs/bench/claims.md`](docs/bench/claims.md) — claim → evidence map.
- [`docs/agents/parallel-dogfood.md`](docs/agents/parallel-dogfood.md) — how to dogfood deja with parallel headless agents.

The full evidence base lives in [`docs/loops/`](docs/loops/) — four research loops, each with hypothesis, battery, results, and what we changed because of them.


