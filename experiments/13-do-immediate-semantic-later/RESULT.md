# Experiment 13 — RESULT

Generated at 2026-06-11T09:41:30.239Z from synthetic data against:

- Durable Object: `http://127.0.0.1:8913` (local `wrangler dev`, SQLite storage)
- Supermemory: `http://127.0.0.1:6767` (real local server)
- continuity id: `exp13-147338fc-7b74-47b0-a265-2042d988bea8`
- synthetic marker: `semcatch-fd8341e033fc4440a46d3a4ec1b1d2ab`

## Observations

| event | elapsed / latency | observed state |
| --- | ---: | --- |
| DO write returned committed receipt | 3.83 ms | exact=available; semantic=`pending`, stale=true, fresh=false |
| immediate DO read-after-write | 3.64 ms (8.30 ms after start) | exact byte-for-byte match=true; semantic=`pending` |
| Supermemory accepted document | 18.41 ms (26.85 ms after start) | queued document `Wyv9KwdEC384xDxE6wVJ7w`; semantic=`submitted`, stale=true, fresh=false |
| first search result containing that document id | 810.48 ms after start | **observed**; semantic=`visible`, stale=false, fresh=true |

Search attempts: 2; poll interval: 500 ms; timeout: 180000 ms.

## Verdict

**Supported in this local run.** The exact continuity path completed and passed read-after-write before semantic submission began. Semantic freshness was not asserted when Supermemory returned `queued`; it became fresh only after search returned document id `Wyv9KwdEC384xDxE6wVJ7w`, 810.48 ms after the write began.

This proves a two-speed *interface observation*, not production Cloudflare durability or a bound on semantic lag. Local workerd, localhost networking, one record, model warmness, and machine load all affect these numbers.
