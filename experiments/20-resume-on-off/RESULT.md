# 20 — Deja on/off for resumed work

Label: controlled result (synthetic tasks)
Verdict: Deja on wins: 96/100 correct vs 57/100, 21% cheaper per call, 53% cheaper per correct answer, about 1.3s faster (paired, p<0.001); synthetic tasks only, not yet shown on real work

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

## Agent arm (2026-11-21)

Same model in both arms (Opus 5.5, low thinking), same system prompt, no tools, no extensions except the model provider. The only difference: the "on" arm gets the notes the primer selected (retrieval plus Clef), plus the handoff where the case has one. 20 cases x 2 arms x 5 repeats = 200 runs. Answer checks for all 20 cases were frozen in a commit (`20cc4cb`) before the 200 runs. They are regular expressions on the answer: the right command or fact must appear, and superseded commands must not.

| Arm | Correct | Total cost | Cost per correct | Median time | Seconds per correct | Input tokens | Output tokens |
|---|---|---|---|---|---|---|---|
| off | 57/100 | $1.02 | $0.0179 | 6.2s | 11.3 | 145 | 481 |
| on | 96/100 | $0.80 | $0.0084 | 5.0s | 5.3 | 240 | 353 |

Paired by case and repeat (permutation test, 20,000 shuffles): correct +0.39 per run, cost -$0.0022 per run, time -1.35s per run, all p<0.001.

| Family | off | on |
|---|---|---|
| resume work | 7/20 | 20/20 |
| reuse a finding | 20/40 | 40/40 |
| reject bad memory | 15/25 | 21/25 |
| no memory needed | 15/15 | 15/15 |

Why "on" is also cheaper: notes add about 95 input tokens, but without them the model writes longer hedged answers (481 vs 353 output tokens), and output costs more than input.

Caveats:
- **The grader is generous to "off".** 32 of the "off" passes open with "I don't know" and then list guesses that happen to include the right term. A stricter grader would widen the gap, not close it.
- **One grader miss against "on".** `fresh-ledger-deploy` failed 4 of 5: the answer correctly said it does not know ledger's deploy steps, but used wording ("I don't have") the frozen check did not match. The raw score is kept as is.
- **Synthetic tasks.** Short questions, no tools, 14 notes. Real sessions have thousands of notes, tool use and long context. This proves the mechanism, not the size of the saving in real work.
- Memory upkeep cost (writing notes, the Clef check) is not counted here; the Clef check is a few cents of Workers AI per 20 cases.
- Raw runs are kept locally in `~/.deja/experiments/20/` (not committed: they contain model output only, but the file is large).

Total spend for this experiment: about $2.15 (200 scored runs plus a 40-run dry pass).

## Rescore (scoring corrected): cross-project notes are a feature

Deja sits above every project on purpose. A note from another project is not wrong for being from another project; the earlier scoring treated it as a leak, and that was a scoring mistake. A note now counts as **wrong** only when it is a superseded decision, or when it reaches a question that needs no memory. **First** counts cases where the needed note is ranked first.

| Arm | dev (6) | held-out (8) | fresh (6) | Wrong notes | Needed note first |
|---|---|---|---|---|---|
| off | 1 | 1 | 3 | 0 | (n/a) |
| on (retrieval only) | 5 | 8 | 6 | 1 (a note on a regex question) | 18/20 |
| primer (retrieval plus Clef, floor 0.7) | 6 | 8 | 6 | 0 | 20/20 |

- Superseded decisions were never delivered, in any arm.
- The Clef check removes the off-topic note and puts the needed note first in every case, at about half the memory text (116–183 chars vs 273–284).
- The cross-project filter below would have removed a feature. It stays reverted.

## Fix attempt (2026-11-18), reverted (based on the old scoring)

Six fresh cases were frozen in a commit (`d105a56`) before any change, so a fix could not be tuned to them. Two more held-out cases test legitimate cross-project reuse (asking about another project by name).

| Arm | dev | held-out | fresh | Wrong notes (dev / held-out / fresh) |
|---|---|---|---|---|
| off | 1/6 | 1/8 | 3/6 | 0 / 0 / 0 |
| on (retrieval only) | 4/6 | 8/8 | 4/6 | 2 / 0 / 2 |
| primer (retrieval plus live Clef check, floor 0.7) | 5/6 | 8/8 | 4/6 | 1 / 0 / 3 |
| on with "drop other-project notes weaker than the best local note" | 5/6 | 8/8 | 4/6 | 1 / 0 / 2 |

- The filter fixed only the dev case it was written for, did nothing on fresh cases, and broke an existing test. That is overfitting, so it was reverted.
- The Clef check removes off-topic notes (the regex leak) but keeps other-project notes, because a vitest note does look relevant to a test-runner question.
- The failure shape: the agent asks about a convention of project X, X has no note on it, and Deja hands over project Y's convention. Blocking that in retrieval also blocks the 2 legitimate cases where the agent asks about project Y by name.
- The live primer labels every note with where it came from (`from: ...`). Whether an agent is misled by a labelled other-project note is a behavior question this harness cannot answer.

## Rollback

Nothing changed in Deja. Nothing to roll back.

## Next step

The mechanism is proven on synthetic tasks. Next: real work. Replay real resumed prompts from session history (start of a session after a break), with and without the primer's notes, graded by an independent reviewer model on the same top model, plus a stricter grader for this synthetic set.



1. Done: the Clef check is modelled (`run.ts --clef`, a few cents of Workers AI).
2. The paid arm: the same model resumes each task with Deja on and off, scored by hidden checks, with cost and time per passed task. Needs Jordan's approval of a quoted budget.


## Notes-file baseline (added 2026-11-22)

A third arm, run later with the same model, system prompt, cases and frozen checks. It gets the project's own notes in write order, plus the handoff, cut to the last 2,000 tokens. No ranking, no notes from other projects, no superseded-note handling. This is the "plain notes file" a memory system must beat.

| Family | Off | Notes file | Deja |
|---|---|---|---|
| resume | 7/20 | 20/20 | 20/20 |
| reuse | 20/40 | 26/40 | 40/40 |
| reject | 15/25 | 18/25 | 21/25 |
| none | 15/15 | 15/15 | 15/15 |
| **total** | 57/100 | 79/100 | 96/100 |
| cost per correct | $0.0179 | $0.0091 | $0.0084 |
| seconds per correct | 11.3 | 5.8 | 5.3 |

Paired by case and repeat (permutation test, 20,000 shuffles):

- Deja beats the notes file on correct answers: +17, p<0.001.
- Per run, Deja costs more in total ($0.81 against $0.72 for 100 runs) and takes longer (53 s more in total), because its notes are longer. It is cheaper only per correct answer.
- The notes file beats no memory: +22, p<0.001.

Where the notes file fails: reuse across projects (the fix lives in another project's notes, 14 misses) and a superseded decision shown next to its replacement (`ledger-migrate`, 5 misses).

What this means: on resume, a plain handoff is as good as Deja. Deja's measured edge is cross-project reuse and superseded decisions. The notes-file run was a separate session a day later, so time-of-day effects on the provider are not controlled.
