# 20 — Deja on/off for resumed work

Label: offline result
Verdict: inconclusive for the product question; memory delivery passes held-out 6/6, dev 4/6 with two leaks

## Hypothesis

With Deja on, an agent resuming work is handed the notes it needs (goal, current decision, known fix) and is not handed wrong-project, superseded or irrelevant notes. With Deja off it is handed nothing.

## Baseline

Deja off: the agent gets no memory. It passes only the cases where no memory is the right answer.

## Single change

Deja on: the same public Deja library recalls up to 3 notes and the active handoff for the prompt, with 1,200 tokens of budget, as the session primer does.

## Fixed evaluation

`bun run experiments/20-resume-on-off/run.ts`

- 14 synthetic notes across 4 made-up projects, including 2 superseded decisions and one decoy per project.
- 12 cases in 4 families: resume work, reuse a finding, reject bad memory, and no memory needed.
- 6 dev cases and 6 held-out cases. Held-out cases were written before the first run and were not used for tuning.
- A case passes when every needed note is delivered and no forbidden note is delivered.

## Budget

$0. No model calls. Runs in under a second.

## Gates

- On must beat off on needed recall in both splits.
- On must deliver 0 forbidden notes on held-out.
- No-memory cases must stay clean.

## Result (2026-11-18)

| Split | Arm | Pass | Needed notes delivered | Forbidden notes delivered | Avg memory chars |
|---|---|---|---|---|---|
| dev | off | 1/6 | 0% | 0 | 0 |
| dev | on | 4/6 | 100% | 2 | 275 |
| held-out | off | 1/6 | 0% | 0 | 0 |
| held-out | on | 6/6 | 100% | 0 | 275 |

Failures with Deja on, both dev:

- `atlas-test-runner`: the right note (bun test) was delivered, and so was another project's runner note (vitest). A cross-project leak.
- `none-regex`: a question that needs no memory got a note anyway.

Superseded decisions were never delivered in either split: the supersede link works.

## What this does and does not show

- It shows that Deja's recall hands over the right notes for these cases, at a small and fixed size.
- It does **not** show that an agent finishes work cheaper or faster. No agent ran. That is the product question, so the overall verdict stays inconclusive.
- The live primer adds a Clef relevance check (floor 0.7) that this run does not model. It may already drop both leaks.
- 12 cases is small. Pass rates move a lot with one case.

## Rollback

Nothing changed in Deja. Nothing to roll back.

## Next step

1. Model the primer's relevance check in this harness (free if run against local Clef, or skip it) and re-run on dev only.
2. Then the paid arm: the same model resumes each task with Deja on and off, scored by hidden checks, with cost and time per passed task. Needs Jordan's approval of a quoted budget.
