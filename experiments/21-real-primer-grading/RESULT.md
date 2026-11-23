# Experiment 21: grading real session-start memory

**Label: live (real sessions), graded by an independent model. Not a controlled on/off test.**

## Question

When Deja's session primer injects notes into a real coding session, are the notes relevant, does the agent use them, and do they save work?

## Method

1. `extract.py` reads local Pi session files and finds every primer injection: 661 injections in 91 sessions. For each, it keeps the user's request, the injected notes, and the first 6,000 characters of the agent's work afterwards.
2. `grade.ts` takes a seeded sample, at most 60 per project, and asks Claude Opus 5.5 (high effort) to grade each injection as strict JSON. The definitions are in the system prompt in `grade.ts`. A note from another project counts as relevant if its content applies.
3. `summarize.py` computes the totals below.

Raw sessions, prompts and grades stay on the owner's machine. Only totals are published here. Grading cost $6.55 for 267 grades.

## Results (main sample: 257 injections, 31 projects, 477 notes)

| Measure | Result |
|---|---|
| Notes judged relevant | 229/477 (48%) |
| Notes the agent visibly used | 79/477 (17%) |
| Notes judged misleading | 15/477 (3%) |
| Injections where at least one note was used | 63/257 (25%) |
| Injections that plausibly saved work | 33/257 (13%) |
| Injections into requests that needed no memory | 95/257 (37%) |
| Primer size | median ~340 tokens, p95 ~770 tokens |

Saved work by whether the request needed memory:

| Request needed memory? | Injections | Saved work |
|---|---:|---:|
| yes | 97 | 31 (32%) |
| unclear | 65 | 2 |
| no | 95 | 0 |

Trust labels do not predict use: low-trust notes were used about as often as medium ones (44/213 against 32/231), and high-trust notes were rare (22).

Misleading notes (15) fall into three groups: a decision that was later replaced (for example, a design document that has a newer version), a note that conflicts with an explicit instruction in the request, and a note from a different task in the same area.

## What changed because of this

A third of injections went to requests that needed no memory, and those injections never saved work. The largest identifiable group is self-contained briefs: a pasted skill, a pasted HANDOFF, BRIEF or task file, or "read X.md and do what it says".

- In the main sample, a rule matching those shapes catches 32 injections: 29 graded "not needed", and 0 saved work.
- Held-out check: 10 further injections matched by the rule, not in the main sample, were graded afterwards: 8 "not needed", 2 "unclear", 0 saved work.
- The rule now ships in the primer (`self-contained` skip reason in pi-fresh-session-handoff). On the main sample it would cut injections into no-need requests from 37% to 31% and raise the share of injections where a note is used from 25% to 27%.

## Limits

- One grader model, no human check of the grades. The grader sees only the first 6,000 characters of work after the injection.
- "Used" and "saved work" are judgements from text, not measured time or cost.
- One owner's sessions. Many come from a single folder.
- No paired run without memory on the same real prompts. This measures precision and use, not the size of the saving.

## Follow-up: can the primer's settings cut unused notes?

Tested on the graded notes, no new model spend beyond Clef calls (`floor.ts`).

**Relevance floor.** Each graded note was re-scored with the live Clef relevance judge (490 scored). Raising the floor does not separate used notes from unused ones: the share of kept notes that get used stays at 18-20% from a floor of 0.7 to 0.95. It only loses saves:

| Floor | Notes kept | Used share | Saved injections still served |
|---|---:|---:|---:|
| 0.7 (current) | 414 | 18% | 32/33 |
| 0.8 | 315 | 19% | 30/33 |
| 0.85 | 243 | 19% | 22/33 |
| 0.9 | 137 | 19% | 14/33 |

Decision: keep 0.7. Clef's relevance score does not predict use, so tuning the floor is the wrong lever.

**A sharper question.** The same notes were re-scored with "Does this memory note tell the agent something specific and useful for this request that the request itself does not already say?". It separated used from unused notes worse than the current question (AUC 0.54 against 0.60, where 0.5 is chance), and kept more notes. Not shipped.

**Notes per injection.** Notes in position 3 or later were used 6 times in 80, and only 1 of 33 saved injections depended on them. Cutting the maximum from 3 to 2 would drop about 15% of injected notes for that one save. Not shipped; it is a small token saving against a real loss.

**Near-duplicates.** Among 355 live notes, 6 same-project pairs overlap heavily (word overlap of 60% or more). Not the main problem yet.

## Next

- The biggest remaining loss is relevant-but-unused notes (48% relevant, 17% used). Clef, asked about one note and the request alone, sees too little to tell them apart (best AUC 0.60). A better selector needs more context than the request, for example the session's earlier turns or the files in view, or a stronger judge on the few candidates. Test against these grades before shipping.
- Replaced decisions still reach agents. Write-time conflict and near-duplicate checks (roadmap v0.2, write quality) target this.
