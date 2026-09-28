# Deja ship-readiness ledger

**Assessed:** 2026-07-11  
**Verdict:** **No public or shared release.** Local Deja is ready for an individual developer's **daily Bun/MCP dogfooding**. The final consolidated gate below passed on this checkout, but the evidence is not sufficient for stronger product claims.

**Final receipt:** `bun run check` — **PASS** on 2026-07-11: 194 unit/release tests, both TypeScript configurations, lexical benchmark (8/8 top-1 and top-3), three behavior fixtures, packed-artifact smoke, clean CLI/MCP smoke, and serial shared-preview Worker/CLI integration proofs.

## Falsifiable acceptance criteria

| Acceptance criterion | Current result / executable evidence |
|---|---|
| A clean Bun consumer can install the packed artifact and initialize a database. | `bun run smoke:package` — PASS locally; packs, installs into a temporary consumer, then runs `deja init` and `deja verify`. |
| CLI and actual MCP stdio retain repository-scoped memory across sessions and expose safe lifecycle operations. | `bun run smoke:local` — PASS locally; clean Git repos exercise init, remember, correction, second-session recall, handoff/resolution, inspect, redaction, confirmation-gated expiration, cross-repo denial, and MCP `initialize`/`tools/list`/`tools/call`. |
| Direct-ID actions cannot inspect or mutate another repository's memory; same harness session can hand off in two repositories. | Scoped API/storage regressions in `test/deja.test.ts` and `test/storage.test.ts` — PASS locally. The migration preserves content while changing handoff uniqueness to `(session_id, scope)`. |
| Local implementation, release metadata, typechecks, lexical benchmark, and behavior fixtures are green. | `bun run check` — PASS on 2026-07-11; includes `bun test ./test`, both typechecks, `bench/recall.ts`, and `bench:behavior`. The eight-case lexical benchmark and three behavior fixtures are narrow checks, not proof of agent improvement. |
| Shared preview has a concrete local boundary and honest failure behavior. | `bun run test:shared-server` — PASS on 2026-07-11; Worker token-space routing, malformed-input/page-limit rejection, bounded-stream behavior, two-client recall/delete/redaction, and server replay redaction. **Preview only.** |

## Supported local lifecycle boundary

- `deja show`, `deja redact`, `deja forget <id> --yes`, `deja link`, MCP `signal`, and handoff resolution operate only in the current exact repository scope.
- `forget` means **expire from Deja recall**, not raw SQLite erasure. `redact` masks recall output only. Direct inspection deliberately still shows raw local history. Local hard delete and export/import are not implemented; do not claim them.
- Local SQLite is plaintext and repository scope is not an OS security boundary. Do not store secrets, customer data, or regulated data.

## Shared preview threat-model result

| Area | Evidence / current boundary | Why it still blocks release |
|---|---|---|
| Authn/authz and tenant isolation | Every request needs a configured local bearer token; one token maps to one Durable Object space; cross-space status/events are integration-tested. | Bearer tokens are not verified identity, are not per-device/revocable sessions, and provide full authority inside a space. |
| CORS/origin | The Worker emits no permissive CORS headers and uses bearer headers rather than cookies. | This is not a deployed edge/auth policy or an employee access design. |
| Replay/order/failure | Numbered revisions, contiguous mirror watermark, bounded 200-event pages, 64 KiB JSON requests, and explicit `400` validation failures are tested. | No retry idempotency keys, quotas, or production abuse/availability policy. |
| Deletion/redaction | Numbered delete removes synced local content and rewrites server replay payloads; local proof checks both. | Not erasure from logs, backups, replicas, or already-compromised local copies. Retention is undefined. |
| Durable Object lifecycle | Streams force reauthentication at a bounded TTL (900 s default; 3600 s maximum), cap a space at 32 streams, and replay at most 200 changes; clients reconnect/catch up through paged events. | No deployed revocation proof, storage compaction/quota, audit policy, encryption decision, or account/route review. |
| Product parity | Shared preview proves remember, handoff, signal, delete, status, and mirror freshness. | It does not carry local repository scope, kinds, links/currentness, handoff resolution, or recall receipts. It cannot be presented as the release surface. |

## Unclosed blockers

1. **Public local-product claims:** collect the roadmap's 50 assessed real recalls across at least five repositories and baseline-vs-Deja continuation evidence. Until then, do not claim fewer tokens, avoided work, or production efficacy.
2. **Shared deployment:** close every open item in [`docs/shared-security-review.md`](docs/shared-security-review.md): verified identity, short-lived revocable sessions, content policy, audit/retention, encryption, cross-owner proof, and route/edge review.
3. **Shared product parity:** carry repository scope and the local memory lifecycle before treating shared memory as more than an isolated local protocol preview.
4. **Local data boundary:** local hard erasure/export/import and retention tooling are intentionally absent. The current expire/redact behavior must remain described exactly.

## Next command

```bash
bun run check
```

A green result is a receipt for **local daily dogfooding only**. It does not close any blocker above or authorize deployment/publishing.
