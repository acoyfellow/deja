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

## Next

- The biggest remaining loss is relevant-but-unused notes (48% relevant, 17% used). Candidate fixes: a higher relevance floor, or fewer notes per injection. Test each on this graded set before shipping.
- Replaced decisions still reach agents. Write-time conflict and near-duplicate checks (roadmap v0.2, write quality) target this.
