# Experiment 04 — Result

**Question:** Can Deja be passed into a Terrarium child?

**Verdict:** ✅ **PROVEN** for the transport layer.
Terrarium children inherit parent env vars (including `DEJA_DB`,
`DEJA_AUTHOR`) and, if the child command runs the Deja CLI, the child reads
and writes the same isolated SQLite DB the parent is using.

Out of scope (and explicitly **not proven**): whether an LLM-driven child
(e.g., `opencode run`) *autonomously chooses* to invoke the Deja MCP server.
That is a model-behavior question and would require a separate experiment.

## Evidence runs

- `evidence/run-20260517-071007/` — first run; one assertion failed due to a
  too-narrow grep pattern in my assertion (not a behavioral failure — the
  underlying evidence files showed the child write *did* land). Fixed and
  re-ran.
- `evidence/run-20260517-071026/` — final clean run. All 6 assertions PASS.
  `RESULT=PROVEN`. **This is the canonical evidence run.**

## What the canonical run shows

`run-20260517-071026/assertions.txt`:
```
PASS: child-env file written
PASS: child saw DEJA_DB=…/evidence/run-20260517-071026/deja.db
PASS: child saw DEJA_AUTHOR=parent-04 (inherited)
PASS: parent inbox contains a message from child-04
PASS: child saw parent-04's earlier message in inherited DB
PASS: isolated DB file exists at $DEJA_DB
```

### Env inheritance (proves H1)

`run-20260517-071026/child-env.txt`:
```
DEJA_DB=<repo>/experiments/04-terrarium-deja-inheritance/evidence/run-20260517-071026/deja.db
DEJA_AUTHOR=parent-04
DEJA_SESSION=<unset>
EXPERIMENT_EVIDENCE_DIR=<repo>/experiments/04-terrarium-deja-inheritance/evidence/run-20260517-071026
TERRARIUM_RUN_ID=ter_20260517111026828_li7iev
TERRARIUM_DEPTH=2
```

Note `TERRARIUM_DEPTH=2` (parent was `ter_…fw0jy3` at depth 1; child run is
its direct descendant). The Deja vars exported by `run.sh` are visible
verbatim inside the child process. Terrarium did nothing special — it
`spawn`s the child agent and the child inherits the calling shell's env.

### Shared-DB read/write (proves H2)

Parent first wrote a message in step 2:
```
parent-04 -> child-04  thread 01KRTT2NV744PJKPJ6X9A6KX72
  ping from parent-04, run=20260517-071026
```

Child, running entirely inside Terrarium, saw it via `deja inbox --all`
(`child-inbox.txt`):
```
01KRTT2NV744PJKPJ6X9A6KX72  pending  2026-05-17T11:10:26  parent-04 -> child-04
  ping from parent-04, run=20260517-071026
```

Child then wrote its own message authored as `child-04`
(`child-send.txt`):
```
01KRTT2PB68ZZHAT8V2HFXVM17  pending  2026-05-17T11:10:27  child-04 -> parent-04
  hello from terrarium child, run=ter_20260517111026828_li7iev
```

Parent, after Terrarium returned, saw it via `deja inbox parent-04 --all`
(`parent-inbox-after.txt`):
```
01KRTT2PB68ZZHAT8V2HFXVM17  pending  2026-05-17T11:10:27  child-04 -> parent-04
  hello from terrarium child, run=ter_20260517111026828_li7iev
```

`child-stats.txt` reports the child saw the same DB path the parent
exported, and counted `messages: 2 pending:2` — both rows, written from
two different processes (parent shell + Terrarium child), via the Deja CLI
hitting the same SQLite file.

### Isolation

`home-deja-listing.txt` shows `~/.deja/deja.db` mtime of **May 14**, well
before this experiment ran (May 17). The experiment wrote only to its
`evidence/run-…/deja.db`. No user-global Deja state was touched.

No Terrarium global config (`~/.terrarium/…`) was edited. No opencode
config was edited. The agent passed to Terrarium was a script *inside the
experiment directory*; pointing at it required only the `--agent` flag.

## Interpretation

What this proves (transport):
1. **Terrarium children inherit the parent process env.** This is the
   standard POSIX subprocess behavior, and Terrarium does not strip
   `DEJA_*` (or anything else) on its way down.
2. **A child agent command can be any executable**, not just an LLM driver.
   When the agent is the Deja CLI (directly or via a shell wrapper), the
   child *is* a Deja user against whatever `DEJA_DB` points to.
3. **Therefore "passing Deja to a Terrarium child" is just**
   `export DEJA_DB=…; export DEJA_AUTHOR=…; terrarium --agent <cmd> …`.
   No code changes needed in either Deja or Terrarium.

What this does **not** prove:
- That an LLM-driven child (e.g., `opencode run` configured with the Deja
  MCP) will choose to call `deja_recall`/`deja_remember` on its own. The
  MCP wiring there lives in the child agent's own config, not in Terrarium.
  Terrarium's contribution is strictly env + arg transport. Verifying LLM
  behavior is a separate, model-dependent experiment (and would belong in
  `eval/` or `bench/`, not here).
- That `~/.deja` is *guaranteed* untouched by all concurrent processes —
  only that this experiment's writes were directed into the isolated DB.

## Repro

```bash
cd <deja-repository>
./experiments/04-terrarium-deja-inheritance/run.sh
# expect: "RESULT=PROVEN" and exit 0
```

Each run produces a fresh `evidence/run-<timestamp>/` so prior runs are
preserved.

## Follow-ups (not done here)

- A sibling experiment in `experiments/0X-…/` that uses `--agent "opencode
  run"` with a deja-MCP-configured opencode and measures: across N runs,
  what fraction of LLM children actually call `deja_recall` and
  `deja_remember`? That's the *behavioral* counterpart to this
  *transport* experiment.
- A variant where the parent passes a *task* that explicitly tells the
  child "first call `deja_recall` for prior context" — to distinguish
  "child can't" from "child won't".
- Wire `DEJA_SESSION` deliberately so parent+child share a session id and
  their slips group together in `deja ls --session`.
