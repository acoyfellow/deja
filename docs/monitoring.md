# Monitoring your memory

Memory that nobody checks drifts into noise. `deja report` shows how your agents
actually use Deja, from your local database only. Nothing is sent anywhere.

```bash
deja report                      # last 14 days, in the terminal
deja report --days=30 --html=deja-report.html
deja report --json               # for your own scripts
deja report --show-queries       # include the text of recent queries
```

Query text is hidden by default because it is often your own prompts. Only
share an HTML report made with `--show-queries` if you are happy for others to
read those prompts.

## What it measures

| Number | Where it comes from | What a bad value means |
|---|---|---|
| recalls | every recorded `recall` (MCP, CLI, or hooks) | none: nothing calls Deja, or tracing is off |
| found notes / empty | recalls that returned at least one note | many empty: the bank lacks notes for your work |
| from bots or tests | queries starting with known automated prompts | high: bots inflate every other number |
| notes recalled | distinct notes returned by those recalls | |
| marked used | notes with `used_count > 0` | 0: nothing grades memory, so you cannot tell whether it helps |
| recalled most, never used | notes returned often but never marked used | a note that matches too broadly |
| kept, never used, over 60 days | the bank's dead weight | high: review with `deja ls`, forget dead notes |

"Notes recalled" counts what search returned. A filter between search and the
agent (like the Pi session primer, which asks Clef whether each note is
relevant) may inject fewer, so the real used share among injected notes is
higher than this report shows.

## Make the numbers mean something

The report is only as good as the grading signal. Agents rarely grade memory on
their own, so wire grading in:

- MCP: the `signal` tool with `kind=used` or `kind=wrong`.
- CLI: `deja signal <id> used` or `deja signal <id> wrong`.
- Pi: [pi-fresh-session-handoff](https://github.com/acoyfellow/pi-fresh-session-handoff)
  marks a note used automatically when the reply quotes it or Clef says the reply
  relied on it.

## A loop that works

1. Run `deja report --days=7` once a week.
2. Fix the top finding: skip bots, forget or rewrite the noisiest unused note,
   or prune stale kept notes.
3. Compare the used share the next week.

What we found doing this on our own bank: 3 of 5 recalls went to bots and tests,
0 notes had ever been graded, and 59% of kept notes were over 60 days old and
never used. Skipping bots, adding a relevance check, and auto-grading took the
used share of injected notes from 0 to about 1 in 5.
