# Parallel dogfood loop

Use this when multiple headless agents are working on deja at once. The point is
not just throughput; it is a product experiment: does deja make parallel agents
more coherent than stateless agents?

## Orchestrator contract

The orchestrator owns integration and the scientific bar.

1. Split work into one hypothesis per worker.
2. Create an isolated git worktree per worker.
3. Require each worker to recall context at start and write a handoff at end.
4. Merge only changes with a passing experiment or a clear negative result.
5. Update the claim -> evidence map when a claim becomes stronger or weaker.

## Worker contract

Each worker receives one bounded mission and must produce:

- hypothesis
- code/doc change, if needed
- experiment or fixture
- test output
- handoff with changed/evidence/risks/next

Required checks before handoff:

```bash
bun test
bun run typecheck
bun run bench:behavior
```

## Suggested first wave

```bash
git worktree add ../deja-behavior-report -b exp/behavior-report
git worktree add ../deja-recall-trigger -b exp/recall-trigger
git worktree add ../deja-stale-memory -b exp/stale-memory
git worktree add ../deja-handoff-ab -b exp/handoff-ab
git worktree add ../deja-evidence-map -b exp/evidence-map
```

Example worker launch shape (adapt flags to the local pi version):

```bash
pi --headless --cwd ../deja-recall-trigger < prompts/recall-trigger.md
```

## deja usage

At start, worker:

```text
deja_recall("deja current roadmap worker contract open experiments")
```

For durable decisions:

```text
deja_remember(text="Decision: ...", keep=true, tags=["decision", "deja"])
```

At end:

```text
deja_handoff(summary="...", next=["..."])
```

## Dogfood experiment

Baseline: run parallel workers without deja recall/handoff.

Variant: run parallel workers with deja recall/handoff.

Measure:

- duplicate work
- conflicting decisions
- missed dependencies
- integration time
- test pass rate
- quality of final handoffs

If the variant wins, the project can honestly claim deja improved the parallel
agent loop that built deja.
