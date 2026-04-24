# Unprompted deja usage — 2026-04-24

**What happened:** A second Claude instance, in a session I had nothing to do with, spontaneously invoked the `deja` skill, wrote two memories to a session branch, blessed them, and authored a handoff packet. The user (Jordan) never mentioned deja to it.

This is the clearest validation the product works.

---

## Timeline

### 2026-04-23 evening
- Shipped the `deja` MCP at `https://deja.coy.workers.dev/mcp/lean`
- Wrote `~/.claude/skills/deja/SKILL.md` — a 190-line on-demand playbook with trigger-word description, loaded by OpenCode at startup but body only injected when the model calls the `skill` tool
- Registered the skill path in `~/.config/opencode/opencode.jsonc`

### 2026-04-24 ~01:41
- Dogfood session: wrote 6 bootstrap memories about deja itself, blessed them all, wrote a bootstrap handoff packet. Explicit, aware setup.

### 2026-04-24 ~05:54 — THE OBSERVATION
- Jordan was using a separate OpenCode session to reproduce a Cloudflare Containers bug (cf-containers-footgun-repro)
- That session's agent, working on `tsconfig` and `image binding drift` topics, **loaded the `deja` skill unprompted** — the skill description's trigger words ("remember", "recall", "what do I know about") matched the topic organically
- The agent executed the full end-of-session pattern:
  1. `deja_search` with two queries, checking for existing memories
  2. Narrated: *"No existing memories on either topic — both are net-new. Writing them to a session branch now, then blessing."*
  3. `deja_execute [op=learn]` × 2 (both tagged `branch_state: session`, scoped to `session:ses-cf-containers-footgun-20260424`)
  4. Narrated: *"Both stored. Now bless and add a handoff packet so whoever (you, or another agent) picks this up next has structured context:"*
  5. `deja_execute [op=bless]`
  6. `deja_execute [op=handoff_create]`

### 2026-04-24 ~05:59
- Jordan screenshotted the TUI. Attached below.
- Read-only verification: the handoff packet for `ses-cf-containers-footgun-20260424` exists in production deja. Summary stored:
  > *"Minified + validated an isolation repro for a post-GA Cloudflare Containers bug where redeploys push new image digests but the running Container Application keeps serving the previous image. Repo at ~"*
- Two blessed memories exist under that scope:
  - `setting up tsconfig for an alchemy-based Cloudflare Worker project`
  - `reproducing CF Containers image-binding drift after first deploy`

---

## Why this matters

Three layers of evidence, in increasing strength:

1. **The skill description works as an intent classifier.** The agent never saw the word "deja" in user input. It saw topics that matched the skill's trigger phrases and chose to load it. That's the hardest part of an on-demand skill primitive — making the selection decision land correctly without forcing the user to explicitly name-drop.

2. **The policy executed verbatim.** AGENTS.md at the deja repo root is never read by this agent (different working directory, different session). The only source of truth was the 190-line SKILL.md loaded into context by the `skill` tool. The agent followed it:
   - Default scope `session:<id>` (not `shared`) ✅
   - Recall before learn (`deja_search` × 2 first) ✅
   - Bless selectively (2 of 2 in this case) ✅
   - Write a handoff packet at end ✅

3. **The handoff was authored for an unknown future reader.** The agent's own narration: *"so whoever (you, or another agent) picks this up next has structured context."* It wasn't writing for itself or for Jordan. It was writing for the next agent. That's the cross-session contract the product was designed around.

---

## What was wrong / what to fix

**`authoredBy` was empty on the packet.** The spec has it as optional; the agent omitted it. Result: the handoff is useful but unattributable — a future agent reading it can't tell which model/session wrote the work.

Fixed in the same session as this observation: SKILL.md now marks `authoredBy` as required with an inline example showing a reasonable format (`"<model-id> (<short-context>)"`). Observation inlined in the skill so future agents see it when the skill loads.

No other policy deviations. Bless-then-handoff order isn't specified in the skill (handoff could come first, or bless-only is also valid); this agent did bless-then-handoff which is the natural order.

---

## What the observation does NOT prove

- Does NOT prove recall works across sessions in the wild — that's session 2's job. This observation is about **writing**, not reading. Cross-session recall has been verified against the bootstrap data but not against this new agent's writes yet.
- Does NOT prove the suspect_score signal is calibrated correctly for real-world distribution — that's a longer-term validation.
- Does NOT prove multiple agents writing concurrently don't step on each other — one agent, sequential writes, no contention observed.
- Does NOT prove the product scales — 10 memories total in the DO, two blessed sessions, one handoff. Toy scale.

The observation proves **ONE thing well**: the on-demand skill + MCP + deja loop fires correctly when an organic topic match triggers it, and the agent follows the written policy.

---

## Artifacts

- Screenshots: `docs/observations/assets/2026-04-24-0554-learn-bless-sequence.png` and `docs/observations/assets/2026-04-24-0555-handoff-create.png`
- Live handoff packet (read with `handoff_read`): `sessionId: ses-cf-containers-footgun-20260424`
- Skill file: `~/.claude/skills/deja/SKILL.md` (outside this repo; user's config)
- MCP live at: `https://deja.coy.workers.dev/mcp/lean`

---

## What was deliberately NOT done in response

Four things:

1. **Didn't stamp `authoredBy` retroactively on the existing packet.** The observation is cleaner if the original artifact stays as it was.
2. **Didn't read the content of the two blessed memories.** The fact that they were blessed is the signal. Reading them and second-guessing would be the observation agent polluting its own experiment.
3. **Didn't interrupt the cf-containers-footgun session.** It's still in-flight. The handoff says "Repo at ~" (truncated) — the actual work lives in `~/cloudflare/cf-containers-footgun-repro/`. That session continues on its own.
4. **Didn't write this observation through deja itself.** This is meta-documentation about the product's behavior; it belongs in git-tracked docs, not in the running memory store. Keep the two substrates separate.

## Credits

Observed by: `claude-opus-4-7 (dogfood session, 2026-04-24 ~05:59)`.
Unprompted agent: `claude-opus-4-7 (cf-containers-footgun-repro session, 2026-04-24 05:54–05:55)`.
Both running via Anthropic through Cloudflare AI Gateway (visible in screenshot footer).
