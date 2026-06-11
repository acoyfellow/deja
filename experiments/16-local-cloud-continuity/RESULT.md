# Experiment 16 — RESULT

- outcome: **PASS**
- run: `exp16mq9bfyhk`
- timestamp: 2026-06-11T09:49:44.139Z
- shared authority: `http://127.0.0.1:8796` (local Worker + SQLite Durable Object)
- Supermemory: `http://127.0.0.1:6767` (real local server)
- synthetic marker: `exp16mq9bfyhk`

## Verdict

Operational continuity proved; full Supermemory extraction disproved in this run (terminal failed), while any exact document search visibility is reported separately.

The supported model is **two-speed, authority-first continuity**: repository-scoped Deja owns the local active handoff; revisioned shared memory transports exact operational state; Supermemory is a derived semantic index whose pending/failed state must never block or masquerade as operational freshness.

## Evidence

| phase | observation | timing |
|---|---|---:|
| independent clients | local PID 90284; cloud PID 90289; separate DBs | process boundary |
| local write + exact authority receipts | local handoff active; writer mirror at rev 2 | 7.64 ms |
| connected cloud continuity | separate process observed exact slip + handoff | 0.89 ms |
| Supermemory submit | returned `queued`; immediate status `queued`, exact doc visible=false | 28.18 ms |
| disconnected write | authority committed revision 3 | 3.22 ms |
| honest stale probe | mirror 2, head 3, behind 1, fresh=false | 2.06 ms |
| reconnect catch-up | fresh=true, behind=0 | 3.13 ms |
| cloud resolution | resolution rev 4; restarted local handoff inactive=true | 2.47 ms |
| initial semantic pipeline | status=failed; exact doc visible at not observed; timedOut=false | 9409.93 ms to terminal |
| resolution semantic pipeline | status=failed; exact doc visible at not observed; timedOut=false | 16835.20 ms to terminal |

## Anti-theater checks

- local and cloud clients are separate OS processes with separate Deja and mirror SQLite files;
- same-origin synthetic checkouts derived the same repository scope; an unrelated origin derived a different scope;
- the cloud client's isolated local Deja DB did **not** magically contain the local client's handoff; transport came from authority revisions;
- while disconnected, cloud local recall missed the new text and the status probe reported the exact revision gap;
- reconnect had to advance the contiguous watermark before freshness was asserted;
- semantic visibility only counts a Supermemory search result with the submitted document ID, preventing unrelated approximate hits from passing;
- `queued/indexing/processing`, timeout, and `failed` are reported as pending/not-fresh or failed, never as semantic completion;
- all content was synthetic and submitted Supermemory documents were deleted after observation.

## Event log

```text
2026-06-11T09:49:26.744Z spawn — starting independent local and cloud-shaped processes
2026-06-11T09:49:26.796Z scope — PIDs local=90284 cloud=90289; same scope repo:continuity-fixture:3a3958f3ed68; outsider repo:unrelated-fixture:644bf58c6918
2026-06-11T09:49:26.804Z immediate local continuity — local 1.19ms; shared revisions 1-2 in 5.08ms
2026-06-11T09:49:26.805Z immediate cloud continuity — separate PID mirror at rev 2; observed in 0.89ms
2026-06-11T09:49:27.133Z semantic pending — document CLNzbUwy3iHiiu7mt7DwVn status=queued; exact document searchable=false
2026-06-11T09:49:27.140Z disconnect/staleness — mirror=2 head=3 behind=1; local hit=false
2026-06-11T09:49:27.143Z reconnect/catch-up — revision 2 -> 3 in 3.13ms
2026-06-11T09:49:27.277Z resolution — authority resolution revision 4; local handoff inactive; peer saw in 0.32ms
2026-06-11T09:49:44.122Z semantic observation — initial=failed visible=false; resolution=failed visible=false
```
