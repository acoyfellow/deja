# Security

## Supported surface

The only supported daily-dogfood surface in this release candidate is local Deja: one SQLite database used by one operating-system user. It is not a public-production approval.

Shared Deja is preview-only. Do not expose or deploy `shared-server` until the blocking review in [`docs/shared-security-review.md`](docs/shared-security-review.md) is complete.

## Data classification

Local Deja stores plaintext SQLite at `~/.deja/deja.db` unless `DEJA_DB` overrides the path. It is designed for project context, decisions, procedures, and handoffs.

Do not store:

- passwords, tokens, private keys, or credentials;
- customer data;
- regulated or highly sensitive personal data;
- content that is not permitted on the local machine.

Repository scope is a retrieval boundary, not an operating-system security boundary. Direct Deja/CLI inspection and mutation enforce the current exact repository scope; processes that can read the database file can still inspect all rows outside Deja.

`forget` expires a slip from Deja recall and requires `--yes` in the CLI. It does not remove the raw SQLite row. `redact` masks recall output only. Neither operation is cryptographic erasure; local hard delete and export/import are not supported.

## Reporting a vulnerability

Do not open a public issue containing exploit details or memory content. Contact the repository owner privately through the security-reporting channel listed on the GitHub repository.

Include:

- affected version or commit;
- local or shared-preview surface;
- minimal reproduction without real secrets;
- expected and observed isolation behavior;
- any deletion, logging, or retention implications.

## Shared preview

Bearer-token mappings in local Wrangler dogfood prove memory-space routing only. They are not production identity. A production shared release requires verified identity, short-lived and revocable sessions, cross-owner isolation, content policy, audit boundaries, retention/deletion policy, and an encryption decision.
