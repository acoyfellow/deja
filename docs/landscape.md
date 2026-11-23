# Where Deja sits among open-source agent memory tools

Snapshot: 2026-11-23. Sources are each project's own README and the cited papers. Star counts are from the GitHub API on that day. This is a design and evidence comparison, not a benchmark result. Corrections welcome.

## The field in one table

| Project | Stars | Shape | Published evidence |
|---|---:|---|---|
| [claude-mem](https://github.com/thedotmack/claude-mem) | 119k | Coding agents. A second agent watches tool calls, writes observations, injects a compact index at session start. | A token A/B for its code-search tools (5 queries, one repo). No memory on/off or quality result found. |
| [mem0](https://github.com/mem0ai/mem0) | 69k | Chat and user memory. LLM extracts facts. | LoCoMo 92.5, LongMemEval 94.4 (managed platform). Eval framework open-sourced. |
| [cognee](https://github.com/topoteretes/cognee) | 34k | Knowledge-graph memory platform. | Not reviewed in depth. |
| [graphiti](https://github.com/getzep/graphiti) (Zep) | 33k | Temporal knowledge graph. | Zep paper on LongMemEval and DMR. |
| [supermemory](https://github.com/supermemoryai/supermemory) | 32k | Memory and context API. Extracts facts, handles updates and forgetting. | Claims #1 on LongMemEval, LoCoMo, ConvoMem. |
| [letta](https://github.com/letta-ai/letta) | 26k | Stateful agent platform (formerly MemGPT). | MemGPT paper, DMR. |
| [EverOS](https://github.com/EverMind-AI/EverOS) | 14k | Local-first, Markdown-native memory layer. | LoCoMo 94.6 (re-judged), LongMemEval 94.0, reproduction steps published. |
| [MemOS](https://github.com/MemTensor/MemOS) | 12k | Memory OS for LLMs and agents. | Not reviewed in depth. |
| [byterover-cli](https://github.com/campfirein/byterover-cli) | 5k | Coding agents. Curated context tree, cloud sync. | LoCoMo 96.1, LongMemEval-S 92.8. |
| [basic-memory](https://github.com/basicmachines-co/basic-memory) | 5k | Markdown knowledge base over MCP, Obsidian-compatible. | None found. |
| [mcp-memory-service](https://github.com/doobidoo/mcp-memory-service) | 2k | MCP memory with typed edges (causes, fixes, contradicts), session hooks. | None found. |
| [projectmem](https://github.com/riponcm/projectmem) | 0.9k | Coding agents. Append-only typed events (issues, attempts, fixes, decisions), precheck before edits. | Author self-study, 27 projects, six months ([arXiv:2606.12329](https://arxiv.org/abs/2606.12329)). Token sizes on nine projects. ROI score is self-estimated. |
| [eidetic](https://github.com/LARIkoz/eidetic) | <0.1k | Claude Code. Session-end extraction, FTS5, drift and supersession down-ranking. | None found. |
| [jevmory](https://github.com/romiluz13/jevmory) | <0.1k | Coding agents. Every fact is a verbatim quote, graded stale, wrong or unsupported. | Demo with planted errors. |

## Benchmarks people actually cite

| Benchmark | What it tests | Fit for coding-agent continuity |
|---|---|---|
| LongMemEval, LoCoMo | Question answering over long chats | Low. Tests recall from conversation, not finishing work. |
| [ContextWeave](https://github.com/OpenMOSS/ContextWeave) ([arXiv:2608.04830](https://arxiv.org/abs/2608.04830)) | 1,005 executable tasks from 14 people's multi-month work streams, with and without recall, graded by rubrics in containers. Includes robustness to misleading recall. Memory systems plug in through two commands, inject and recall, and it ships components for mem0, supermemory, langmem, MemOS, A-Mem, MemoryBank and a plain-text baseline. | **High.** The closest public match to what Deja does, and its plug-in shape matches Deja's save/brief design. |
| [Total Recall at What Cost?](https://arxiv.org/abs/2608.11879) | Serving cost of Mem0 and others against a rolling window and full transcript, paired with accuracy | High for the cost axis. Finds no system wins both cost and accuracy. |

Two recent audits matter for reading anyone's numbers:

- [What Moves a LoCoMo Score?](https://arxiv.org/abs/2611.19199): changing only the judge moves a LoCoMo score by up to 7.2 points, and only the answer prompt by up to 9.3. The paper notes that its evaluated system was tuned on LoCoMo itself, with no held-out set.
- [Auditing Long-Term Memory Evaluation](https://arxiv.org/abs/2609.38021): repeated judging and reader choice swing LongMemEval results; reports should include negative controls.

The top systems score 92-96% on these benchmarks and present them as headline results. Judge and prompt choice alone can account for gaps that size.

## What Deja reinvented

Most of Deja's base is now common practice. These are not differentiators:

| Feature | Also in |
|---|---|
| Inject a few notes at session start | claude-mem, eidetic, jevmory, mcp-memory-service, supermemory |
| Typed memories (decision, pitfall, procedure) | projectmem, mcp-memory-service, claude-mem |
| Supersession and contradiction links, history kept | eidetic, mcp-memory-service, projectmem, mem0 v3 |
| Local SQLite with FTS5 | eidetic, many MCP servers |
| Per-project scope with cross-project search | supermemory, projectmem, claude-mem (opt-in) |
| Token budget on the injected packet | claude-mem, projectmem |

## Where others are ahead

- **Capture without the agent's help.** claude-mem and eidetic extract memory from every session automatically. Deja's auto-memory exists but is narrower, and most notes still depend on an agent writing them.
- **Staleness against the code.** projectmem checks memories against git history. EA-Graph ([arXiv:2608.04278](https://arxiv.org/abs/2608.04278)) anchors claims to the exact code they depend on. Deja ages notes by time and explicit supersession only. In experiment 21, replaced decisions were the biggest source of misleading notes.
- **Memory at the moment of action.** projectmem's precheck shows a file's failure history before an edit. Deja only injects at session start and on topic change.
- **Reach.** claude-mem has many supported harnesses and a large install base. Deja has one primary harness.
- **Developer view of what is stored.** MemoSync ([arXiv:2611.24165](https://arxiv.org/abs/2611.24165)) found, in a 132-person study, that letting developers review what the agent stores and uses improves task results. Deja has a CLI, but no review surface.

## Where Deja is ahead

Mostly evidence discipline, which is rare in this field:

- **On/off and plain-baseline tests on agent work.** Experiment 20 compares no memory, a plain notes file and Deja, with checks frozen before any run. Among the coding-agent tools reviewed, none publishes a comparison against a plain notes file.
- **Grading of real injections.** Experiment 21 graded 267 real session-start injections and published the unflattering parts: 17% of notes used, 37% of injections went to requests that needed no memory. No other tool reviewed publishes a usage rate.
- **Cost per verified task as the headline.** Most tools publish benchmark accuracy or token sizes. Only the serving-cost paper above pairs cost with accuracy, and it does so for chat.
- **Cross-project reach as a measured feature**, not a flag.

## Where Deja may be heading the wrong way

- **A custom benchmark when ContextWeave exists.** ContextWeave already measures with-recall against without-recall on executable, multi-session work, including misleading recall. Deja should run on it as the outside measure and keep its own benchmark for what ContextWeave lacks: cost per task, a plain notes-file baseline, and cross-project reach.
- **Selecting notes from the request alone.** Experiment 21 shows the selector cannot predict use from the request alone. ContextWeave's finding that "actionable, experience-rich memory" helps more than compact summaries points the same way: notes need to carry more of the specific situation, and selection needs more context.

## Gauge

| Axis | Deja's position |
|---|---|
| Adoption | Far behind. Small project against tools with 30k-120k stars. |
| Features | At parity on the basics; behind on automatic capture, code-anchored staleness and pre-edit warnings. |
| Evidence | Ahead of every coding-agent tool reviewed on honest, published measurement. Behind on outside comparability until it runs a public benchmark. |

## What this changes

1. Run Deja on ContextWeave as the outside measure: write a Deja component (inject and recall commands) and report it next to the no-recall baseline, the plain-text component and mem0 or supermemory. It needs Docker images, the Codex CLI and model keys.
2. Narrow the Agent Continuity Benchmark to the gaps ContextWeave does not cover, and cite it.
3. Next build candidates, in order of evidence: staleness checked against the code (replaced decisions are the main source of misleading notes); selection with session context; memory at the moment of action.
