# Using deja — Agent Policy

Short doc for agents (and humans reviewing agent behavior).
Not for end users; see [README.md](./README.md) for that.

## Defaults

- Default scope for writes: `session:<id>` where `<id>` is unique per agent run
  (ULID, timestamp+random, whatever). **Not** `shared`.
- Recall before learn. Check if a memory exists before writing a new one —
  `learn()` dedupes near-identical writes but it still costs an embedding.
- Use `sync: true` on `learn()` when you plan to recall what you just wrote
  in the same session. Default is async, which means Vectorize won't index
  your fresh write for ~15-20s. With sync, learn blocks for up to 30s
  waiting for the row to become queryable and returns `synced: true|false`.

## Lifecycle

- End of session: `bless(session_id)` the learnings worth keeping, or
  do nothing and let the 24h TTL clean up. Default is "don't bless."
- Blessed rows are cross-session visible regardless of scope.
- Session rows are visible only to the session that authored them.
- Discard is destructive (session rows hard-deleted). Bless is additive.

## Scopes

- `shared` — institutional memory, visible everywhere
- `agent:<id>` — scoped to one agent identity across sessions
- `session:<id>` — scratchpad for one session
- Mixing (`['session:x', 'shared']`) returns rows matching either.
- `['session:x', 'agent:y', 'shared']` collapses `shared` — session+agent
  narrowing already gave you a specific slice, shared becomes noise.

## Anti-patterns (don't do these)

- Don't store secrets in deja memories. Provenance is visible; content is
  not encrypted. Use `/secret` for that.
- Don't bless everything. Be selective, or the blessed tier becomes noise
  and suspect_score stops being a useful triage signal.
- Don't recall with too many scopes. Be specific. The scope filter is
  "widen to match" — every extra scope widens the search.
- Don't write to `shared` from ephemeral runs. Session scope first;
  promote via `bless()` only when something is genuinely worth keeping.
- Don't ignore `suspect_score` on search hits. Hits with `suspect_score >= 0.3`
  are probably stale, poisoned, superseded, or anti-patterns — treat them
  as "inspect before trusting."

## Handoffs

When ending a session that the next agent will continue:
- Bless the 3-5 most important learnings.
- Consider using the working-state endpoints (`/state/:runId`) to leave a
  structured summary alongside the blessed memories.

## Quick reference

REST / MCP op → what it does → when to use

| Op | What it does | When |
|---|---|---|
| `learn` | Store a memory in a scope; returns the new id (or dedupe target) | After completing a task or observing something worth remembering |
| `learn` + `sync:true` | Same, but waits for Vectorize to index before returning | When you will recall this memory in the same turn |
| `inject` | Fetch ready-to-use prompt with top-K relevant memories | Before starting a task, for context injection |
| `search` (lean) | Return metadata-only hits for triage | Before `inject`/`read`, when you want to score options without paying for bodies |
| `execute({op:'read', id})` | Fetch a single learning body by id | After `search`, to pull the top-scored result |
| `trace` / `inject/trace` | Full candidate list with scores, threshold markers, suspect_score | Debugging "why didn't X get recalled" |
| `confirm` | Boost a memory's confidence after it helped | After verifying a recalled memory was correct and useful |
| `reject` | Drop confidence; auto-inverts to anti-pattern below 0.15 | After a recalled memory turned out wrong |
| `forget` | Hard-delete a single learning by id | Cleaning up test data; correcting a mistaken write |
| `neighbors` | Find semantically similar memories to one id | Before writing: check if something adjacent exists |
| `bless` | Promote session-state learnings to blessed (cross-scope visible) | End of a productive session, keeping 3-5 key learnings |
| `discard` | Hard-delete all session-state rows in a branch | Abandoning a failed session |
| `branch_status` | Get one session branch's open/blessed/discarded state | Inspecting session lifecycle |
| `list_branches` | Enumerate all session branches on this DO | Ops / debugging; rarely needed by agents |
| `state_get` / `state_put` / `state_patch` / `state_resolve` | Working-state snapshot + event log per run | Handoffs, long-running tasks, checkpointing |
| `stats` | Memory counts by scope | Ops visibility |

## suspect_score cheatsheet

Returned on every `search` hit and every `trace` candidate. Range `[0, 1]`,
higher = more suspicious. Weighted additive signals:

- age (linear to 365 days)
- never recalled + older than 7 days
- anti-pattern type
- confidence < 0.3
- this row superseded another (chain signal)

Rule of thumb: filter for `suspect_score < 0.3` when you want "clean"
memories. Inspect anything above that before committing to it.
