# Experiment 11: Supermemory on Workspace persistence

## Question

Can the verified Supermemory server `v0.0.2` Linux/arm64 binary run over a
Cloudflare Workspace path, with bytes surviving a local Wrangler runtime
restart?

## Outcome

**Blocked at preflight; no persistence claim is made.** The public package and
platform matrix do not currently expose a compatible execution path:

1. The public npm `latest` for `@cloudflare/workspace` is `0.0.0`, a placeholder
   tarball containing only `package.json`. It has no Workspace API.
2. The usable preview is `0.0.0-alpha.7`. Its Worker backend is explicitly a
   `just-bash` interpreter, not a native Linux process environment.
3. Its Container backend package contains one daemon,
   `dist/bin/wsd-linux-x64`. The file is an ELF with `e_machine=62` (x86-64),
   and the package contains no arm64 daemon.
4. The requested Supermemory release artifact is Linux/arm64. The release API,
   manifest, and checksum sidecar agree on version and checksum, but that binary
   cannot execute in `just-bash`, against the package's x86-64 container
   transport, or directly on this Darwin/arm64 test host.

A filesystem-only Workspace can persist bytes in Durable Object SQLite, but
that would not establish that the Supermemory native process can execute
against the path. Substituting a normal directory or mock filesystem would fake
the central premise, so this experiment follows branch **B** of the task and
stops before Wrangler setup.

## Run

Requirements: Bash, Node.js, `curl`, and `tar`. No credentials are used.

```sh
./tests/preflight.test.sh
```

The preflight reads the public npm registry and public GitHub release endpoints.
It downloads the alpha tarball (about 43 MiB compressed) into a temporary
directory, applies finite connect/transfer timeouts, inspects the packaged ELF
header, and removes all temporary files.

To additionally verify already-downloaded Supermemory bytes:

```sh
SUPERMEMORY_BIN=/path/to/supermemory-server-linux-arm64 \
  ./scripts/preflight.sh
```

That optional mode SHA-256 checks the file against the checksum published for
`server-v0.0.2`; it still reports the same execution incompatibility.

## Success condition for a future retry

A real branch-A proof needs all of the following:

- an importable public Workspace release (not the `0.0.0` placeholder),
- a backend that can launch native Linux/arm64 processes, or a matching verified
  Supermemory Linux/x64 artifact for the Workspace Container backend,
- a local Wrangler flow that writes through Workspace, fully stops and restarts
  the runtime, then reads the same bytes, and
- execution of Supermemory against the Workspace-backed path—not a host
  directory standing in for Workspace.
