# Handoff: Implement time-based confidence decay, agent attribution, and anti-pattern tracking in deja

## Context

deja is a persistent memory system for AI agents with three deployment variants:

- **deja-local** (Bun + SQLite + local embeddings) — packages/deja-local/src/index.ts
- **deja-edge** (Cloudflare DO + FTS5) — packages/deja-edge/src/index.ts
- **deja (hosted)** (CF Worker + DO + Vectorize) — src/do/memory.ts, src/schema.ts, src/do/DejaDO.ts

All three share the same mental model: remember() / recall() / confirm() / reject() / forget().

After a competitive analysis against cass-memory (github.com/Dicklesworthstone/cass_memory_system), we identified three gaps worth closing. This prompt describes exactly what to implement.

---

## 1. Time-based confidence decay (all three packages)

### Problem

Currently, confidence only changes via explicit confirm(+0.1) / reject(-0.15). A memory stored 6 months ago that nobody confirmed or rejected sits at 0.5 forever. Stale memories pollute recall results.

### What to implement

Apply exponential decay to confidence AT RECALL TIME (not via cron). This keeps storage untouched and makes decay a read-side concern.

Formula: decayedConfidence = storedConfidence * (0.5 ^ (daysSinceCreatedOrLastRecalled / HALF_LIFE_DAYS))

Use HALF_LIFE_DAYS = 90.

In each variant's recall() function, after fetching memories and before scoring:

1. Calculate daysSince = (now - max(createdAt, lastRecalledAt)) / 86400000
2. Apply decayedConfidence = confidence * Math.pow(0.5, daysSince / 90)
3. Use decayedConfidence in the blending formula: score = relevance * 0.7 + decayedConfidence * 0.3

### deja-local (packages/deja-local/src/index.ts)

The memories table has no last_recalled_at column. Add a migration in migrateSchema() that runs ALTER TABLE memories ADD COLUMN last_recalled_at TEXT.

In recall(), after matching, update last_recalled_at for returned results with UPDATE memories SET last_recalled_at = ? WHERE id = ?.

In the in-memory IndexEntry interface, add lastRecalledAt?: string.

In the scoring loop (around line 330), use decayedConfidence instead of raw entry.confidence in the blending formula.

### deja-edge (packages/deja-edge/src/index.ts)

Same schema migration — add last_recalled_at TEXT column to memories table in initSchema().

In recall() (around line 293), apply decay before the blending step.

After returning results, update last_recalled_at for matched memory IDs.

### deja hosted (src/do/memory.ts, src/schema.ts)

Already has lastRecalledAt and recallCount columns — no schema change needed.

In injectMemories() (around line 91), apply decay to confidence when sorting/ranking results.

The cleanup function (cleanupLearnings) already deletes low-confidence entries — this is complementary.

### Important

Do NOT change stored confidence values via decay. Only confirm/reject/conflict should mutate stored confidence. Do NOT run decay as a background job or cron — compute it on read.

### Tests to add

For packages/deja-local/test/index.test.ts and packages/deja-edge/test/edge-memory.test.ts:

- "old memories score lower than fresh ones with same text similarity"
- "recently recalled memories resist decay"
- "confirm still boosts stored confidence independent of decay"

To test time-based behavior, mock Date.now() or inject a now parameter into recall internals.

---

## 2. Agent attribution on memories (deja-local and deja-edge only)

### Problem

When multiple agents share memory, there's no way to know which agent stored a given memory. cass tracks this as a first-class agent field. deja's hosted variant already has a source field but the local/edge packages don't.

### What to implement

For deja-local: Add optional source?: string to the Memory interface and to remember() as an options parameter. Add source TEXT column to memories table via migration. Store it on insert, return it in results. No filtering by source — just attribution for transparency.

For deja-edge: Same — add source TEXT column, accept optional source in remember(), return in results.

For deja hosted: Already has source field — no changes needed.

The API change for local/edge should be backward-compatible:

Before: remember(text: string): Memory
After: remember(text: string, options?: { source?: string }): Memory

The options parameter is optional, source defaults to undefined.

### Tests

- "source is stored and returned when provided"
- "source is undefined when not provided (backward compat)"

---

## 3. Anti-pattern / negative knowledge tracking (deja-local and deja-edge only)

### Problem

When a memory gets rejected enough times, deja just lowers its confidence until it's nearly invisible. But negative knowledge ("don't do X") is as valuable as positive knowledge. cass auto-inverts heavily-rejected rules into anti-patterns that actively warn agents.

### What to implement

Add a type field to memories: "memory" or "anti-pattern".

Schema change for both local and edge: ALTER TABLE memories ADD COLUMN type TEXT NOT NULL DEFAULT 'memory'

Add type to the Memory interface as type: "memory" | "anti-pattern".

Auto-inversion rule — when reject() is called and the resulting confidence drops below 0.15, AND the current type is not already "anti-pattern":

1. Flip the memory's type to "anti-pattern"
2. Reset confidence to 0.5 (it's now a useful warning, not a failed memory)
3. Prepend the text with "KNOWN PITFALL: " + original text

This way, anti-patterns show up in recall with positive confidence and actively warn agents away from known mistakes.

In recall(), anti-patterns are just memories with type "anti-pattern". They participate in recall normally. The KNOWN PITFALL prefix makes them self-describing when injected into agent prompts.

For deja hosted: Don't implement this yet — the hosted variant has a different data model (trigger/learning instead of flat text). We'll design this separately.

### Tests

- "memory auto-inverts to anti-pattern after enough rejections"
- "anti-pattern has reset confidence and KNOWN PITFALL prefix"
- "anti-pattern appears in recall results normally"
- "confirming an anti-pattern still boosts its confidence"
- "already-inverted anti-pattern doesn't double-invert"

---

## Implementation order

1. Time-based decay — highest impact, lowest risk, no API changes
2. Agent attribution — simple schema addition, backward-compatible
3. Anti-pattern tracking — most complex, local/edge only

## Files to modify

- packages/deja-local/src/index.ts — all three features
- packages/deja-local/test/index.test.ts — new tests for all three
- packages/deja-edge/src/index.ts — all three features
- packages/deja-edge/test/edge-memory.test.ts — new tests for all three
- src/do/memory.ts — decay in injectMemories() only
- src/schema.ts — no changes (already has needed columns)

## What NOT to do

- Don't add a three-layer architecture (episodic/working/procedural) — deja's flat model is intentional
- Don't add LLM-powered reflection or rule extraction — deja is embedding-only by design
- Don't add session log ingestion — agents decide what to remember
- Don't add evidence gating — open learn() is a feature
- Don't add file-based storage — SQLite everywhere
- Don't change the public API signatures beyond the backward-compatible additions described above
- Don't add any new dependencies

## Run tests with

cd packages/deja-local && bun test
cd packages/deja-edge && bun test
