# Result

**Status: B — unsupported package/platform combination, machine-verified.**

Run on 2026-06-11 from Darwin/arm64:

```text
PASS: public npm registry reports latest @cloudflare/workspace as 0.0.0 and alpha.7 exists
PASS: npm latest tarball is a placeholder: package.json only, with no importable Workspace API
PASS: alpha.7 ships an x86-64 Linux ELF wsd and no arm64 wsd
PASS: Supermemory server-v0.0.2 publishes linux-arm64 with checksum 90ebd17c42d2d649af328b1a80518d8eacf966ed2444d8cd25ef5e2d9bb0b165
PASS: current host Darwin/arm64 cannot directly execute a Linux/arm64 ELF
PASS: BLOCKER CONFIRMED: alpha Worker backend is just-bash; Container wsd is Linux/x86-64; requested Supermemory binary is Linux/arm64
RESULT=unsupported
```

## Evidence and interpretation

| Check | Observed | Consequence |
|---|---|---|
| npm dist-tag | `latest = 0.0.0` | Default installation does not provide the preview API. |
| `0.0.0` tar contents | only `package/package.json` | There is no `index.js`, `dist/`, or exported `Workspace`. |
| Preview package | `0.0.0-alpha.7` has `dist/index.js` | This is the only public version tested with an implementation. |
| Worker backend contract | package README says it runs the shell as `just-bash` | It cannot launch a native Supermemory ELF. |
| Container transport | packaged `wsd-linux-x64` has ELF `e_machine=62`; no arm64 `wsd` exists | The shipped native container route is x86-64, not arm64. |
| Supermemory release | release tag and manifest are `server-v0.0.2` / `0.0.2`; Linux/arm64 asset exists | The requested artifact is real and platform-specific. |
| Integrity metadata | manifest and `.sha256` both say `90ebd17...b0b165` | A local artifact can be verified with `SUPERMEMORY_BIN=...`. |
| Test machine | `Darwin/arm64` | It cannot directly execute the Linux/arm64 artifact either. |

The initial package discovery was fail-fast. An `npm view` request was rewritten
by the local managed npm client to an HTML-returning registry gateway despite an
explicit public registry argument, so discovery switched to direct bounded
HTTPS requests to `registry.npmjs.org`. The public metadata and tarballs were
then successfully inspected. No secrets were read or used.

## What was not proven

No Wrangler persistence test was run, and this result must not be interpreted
as evidence that bytes survive a Workspace runtime restart. The blocker occurs
before a truthful end-to-end Supermemory execution can be constructed. A
filesystem-only test would answer a weaker question and was deliberately not
presented as the requested proof.
