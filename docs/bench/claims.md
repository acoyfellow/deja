# Claim -> evidence map

Every strong product claim should point at a runnable experiment, loop transcript,
or explicit known failure. Claims without evidence should be phrased as hypotheses.

| Claim | Status | Evidence | Next proof needed |
|---|---|---|---|
| deja can retrieve recorded lexical memories. | Supported | `bench/recall.ts`, `docs/bench/latest.txt` | Keep fixture bench in CI. |
| Specific recall-trigger wording should improve when agents use memory. | Proxy-supported | `bench/behavior/run.ts`, `docs/bench/behavior-latest.md#recall-trigger-policy-pass` | Replace proxy with real agent transcripts over the same prompt battery. |
| Structured handoff packets may improve cross-session continuation. | Proxy-supported hypothesis | `bench/behavior/run.ts`, `docs/bench/behavior-latest.md#handoff-structure-pass` | Run LLM-in-the-loop freeform vs structured handoff A/B. |
| Supersedes/contradicts links reduce stale-memory harm. | Proxy-supported hypothesis | `bench/behavior/run.ts`, `docs/bench/behavior-latest.md#stale-preference-pass`; storage + MCP link surfacing tests | Add agent behavior fixture: old jest vs new vitest. |
| deja improves parallel agent coordination. | Hypothesis | `docs/agents/parallel-dogfood.md` | Run baseline vs deja-assisted parallel worker loop. |
| deja does not force agents to use memory. | Known limit | `docs/loops/2026-04-25-loop-3-three-meta-tools.md`, `docs/loops/2026-04-25-loop-4-cross-session-chain.md` | Continue recall-trigger experiments. |
