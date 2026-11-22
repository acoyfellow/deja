# Agent Continuity Benchmark

**Status: draft design. Scores below are not yet produced by this benchmark. Experiment 20 is its seed.**

This benchmark describes what Deja wants to be, and measures how far it is from that. It is the target we hill-climb on, in public. Any memory system can enter under the same rules, and Deja's losing rows get published too.

## The question

Does memory help a coding agent keep working across sessions and projects, and does it make each verified task cheaper and faster?

Most memory benchmarks ask whether a system can recall facts from a long chat. This one asks whether an agent finishes work. Accuracy alone does not score. The headline numbers are **cost per verified task** and **time per verified task**, next to the pass rate.

## Who can enter

Any memory system that implements two calls:

| Call | When | Input | Output |
|---|---|---|---|
| `save(session)` | A session ends | The session's prompts, answers and tool results, plus anything the agent chose to write down | Nothing |
| `brief(request)` | A new session starts, or the topic changes | The new request and its project | Text to put in front of the agent, possibly empty |

The harness controls everything else: model, system prompt, tools, task order and grading. Every entrant runs with the same model in the same harness.

Every run reports two reference arms beside the entrants:

- **No memory**: `brief` always returns nothing.
- **Notes file**: `brief` returns the last 2,000 tokens of a plain append-only notes file for the project. A memory system that cannot beat this has not earned its complexity.

## Task families

| Family | What a pass requires | Draws on |
|---|---|---|
| Resume work | After a break or a compaction, recover the goal, constraints and next step, and act on them | Experiment 20; the "resume" setting is ours |
| Reuse a finding | Apply an earlier fix instead of investigating again | Evo-Memory and ReasoningBank (reuse of experience across a task stream) |
| Follow the current decision | Use the newest decision and not the one it replaced | LongMemEval "knowledge updates"; MemoryAgentBench "selective forgetting" |
| Reach across projects | Use a finding from another project when it applies, and label where it came from | Ours. We know of no benchmark that scores this. |
| Know when memory is not needed | Answer a general request without injecting memory, and say "unknown" when a project fact was never recorded | LongMemEval "abstention" |
| Get better over time | In a sequence of related tasks, later tasks cost less with no loss of correctness, after counting the cost of making the memory | SWE-Bench-CL (ordered coding tasks); Evo-Memory (task streams) |

## Scoring

Per family and overall, for each arm:

- **Pass rate.** A pass is decided by tests in a task repository where possible, otherwise by answer checks frozen in a commit before any entrant runs.
- **Cost per verified task**: total model spend divided by passes. Unknown prices are reported as unknown, never as zero.
- **Time per verified task**: total wall time divided by passes, including the memory system's own time.
- **Memory upkeep**: tokens and time spent by `save` and `brief`, reported on their own and included in the totals above.
- **Wrong memory followed**: answers that act on a replaced decision.

Paired by task and repeat. Differences are reported with a permutation p-value; fewer than 5 repeats per task means the row is marked inconclusive.

## Splits

| Split | Published | Purpose |
|---|---|---|
| dev | yes | Build and debug against it |
| public test | yes, with answer checks | Reproducible scores |
| held-out | no | Guards against tuning to the test set, by anyone including us. Run by the maintainers on request; results published with the model and date. |

Held-out tasks are written in a commit with a hash published before any entrant runs against them, and revealed when retired.

## Rules that keep it honest

- Answer checks and tests are committed before the runs they grade. A check changed after seeing answers is marked in the results.
- The same model runs every arm. A judge model, when one is needed, is the same strong model for every arm.
- Results tables include every family, including the ones Deja loses.
- Synthetic tasks are labelled as synthetic. Real-work tasks come from public repositories only.
- A score is reported with the benchmark version, model, date and commit.

## Where Deja stands today

From experiment 20 (synthetic, 20 tasks, 5 repeats, Opus 5.5 low): with Deja's notes, 96/100 correct against 57/100 with no memory, 53% cheaper and 53% faster per correct answer. Not yet measured: the notes-file baseline, tasks with tools, real repositories, compaction, and the "get better over time" family.

## Roadmap

1. Port experiment 20 into this harness, with the `save`/`brief` interface and the notes-file baseline.
2. Add tool-using tasks in small public repositories, graded by their tests.
3. Add the "get better over time" sequence.
4. Freeze v1, publish the dev and public splits, and hash the held-out split.

## Sources and what we take from each

| Source | What we use | Why |
|---|---|---|
| Wu et al., *LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory*, [arXiv:2410.10813](https://arxiv.org/abs/2410.10813) | The "knowledge updates" and "abstention" abilities | It names both clearly. We test them in agent work, not chat. |
| Hu, Wang, McAuley, *Evaluating Memory in LLM Agents via Incremental Multi-Turn Interactions* (MemoryAgentBench), [arXiv:2507.05257](https://arxiv.org/abs/2507.05257) | "Selective forgetting" as a competency | Same need as following the current decision |
| Pakhomov, Nijkamp, *Bookkeeping, Composition, or Unreachable Gold? Reading MemoryAgentBench's Conflict-Resolution Scores Against a Frozen Last-Write Resolver*, [arXiv:2610.09193](https://arxiv.org/abs/2610.09193) | A warning, not a task | A simple rule can score high on a conflict split, and some gold answers can be unreachable. We include a trivial baseline (the notes file) and check that every gold answer is reachable. |
| Wei et al., *Evo-Memory: Benchmarking LLM Agent Test-time Learning with Self-Evolving Memory*, [arXiv:2511.20857](https://arxiv.org/abs/2511.20857) | Task streams where memory must build up and be reused | Basis for "reuse a finding" and "get better over time" |
| Ouyang et al., *ReasoningBank: Scaling Agent Self-Evolving with Reasoning Memory*, [arXiv:2509.25140](https://arxiv.org/abs/2509.25140) | Learning from both successful and failed attempts | Reuse should include known fixes and known traps |
| Joshi et al., *SWE-Bench-CL: Continual Learning for Coding Agents*, [arXiv:2507.00014](https://arxiv.org/abs/2507.00014) | Ordered coding tasks from real repository history | Model for the coding "get better over time" sequence |
| Maharana et al., *Evaluating Very Long-Term Conversational Memory of LLM Agents* (LoCoMo), [arXiv:2402.17753](https://arxiv.org/abs/2402.17753) | Context only | The main long-chat benchmark. We do not use its tasks, because Deja does not ingest chat. |
| Nakajima, *Regimes: An Auditable, Held-Out-Gated Improvement Loop Demonstrated on LongMemEval with ActiveGraph*, [arXiv:2606.10241](https://arxiv.org/abs/2606.10241) | The method of improving in public against a held-out gate | The same discipline we use to hill-climb Deja against this benchmark |
