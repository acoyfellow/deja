# deja-install

One-command installer for [deja](https://github.com/acoyfellow/deja)'s MCP
surface. Collapses the 8-step manual install (gen key → update CI secret →
redeploy → update Worker secret → edit `opencode.jsonc` → edit `~/.zshenv` →
`chmod 600` → verify) into a single `npx` call.

## Quick start

```bash
npx deja-install opencode
```

That's it. The command:

1. Generates a random 256-bit hex key (or accepts `--key ...`).
2. Merges a `mcp.deja` block into `~/.config/opencode/opencode.jsonc`, **preserving your existing comments and formatting** (uses `jsonc-parser`, not a `JSON.stringify` round-trip).
3. Appends `export DEJA_API_KEY=...` to the right shell rc file (`~/.zshenv` on zsh, `~/.bashrc` on bash, `~/.config/fish/config.fish` on fish) and `chmod 600`s it.
4. Live-verifies the MCP endpoint with your new key — `tools/list` must return `search / execute / inject`.
5. Prints next-step instructions (restart OpenCode, env-var propagation reminder).

## Other commands

```bash
npx deja-install opencode --dry-run        # show diff, change nothing
npx deja-install verify opencode            # PASS/FAIL per install step
npx deja-install rotate opencode            # new key + optional wrangler/gh sync

npx deja-install opencode --url https://my-deja.workers.dev/mcp/lean
npx deja-install opencode --key $(openssl rand -hex 32)
```

## What this tool does NOT do

- **Does not deploy the Worker.** This tool assumes the `--url` points at an already-deployed deja instance (yours or someone else's). For a fresh deploy — including creating the Cloudflare account, Vectorize index, `API_KEY` secret, and CI wiring — see the main [deja README](https://github.com/acoyfellow/deja#deploy).
- **Does not configure multiple clients at once.** One client per invocation. Run it twice for OpenCode and Claude (once Claude support lands).
- **Does not silently run `wrangler` or `gh`.** `rotate` prompts before invoking either; if you decline, it prints the exact command to run manually.

## Supported clients

| Client       | Status             |
|--------------|--------------------|
| OpenCode     | ✓ implemented      |
| Claude Code  | stub — exits 2     |
| Cursor       | stub — exits 2     |

Claude and Cursor stubs print their config file paths so you can add the block manually until their installers land.

## Platform support

macOS + Linux. Windows is rejected with a message pointing WSL users at the WSL shell; native Windows support tracks [the issue](https://github.com/acoyfellow/deja/issues).

## Security note

The key lands in plaintext in your shell rc file (`~/.zshenv` etc.). That file is `chmod 600`'d after write, but any secret scanner or backup tool with read access to your home dir will see it. If you run [guardrail](https://github.com/acoyfellow/guardrail) (`guardrail secrets`) as part of your git-ignored file audit, add the rc file to the allowlist or accept the finding — the key is intentionally there.

Rotate any time:

```bash
npx deja-install rotate opencode
```

Rotation is cheap: `getUserIdFromApiKey` on the Worker side uses the key string as the Durable Object id, so rotating the key automatically lands you on a fresh empty DO. Old learnings become unreachable (but are not deleted) under the previous key's DO id.

## Development

```bash
cd packages/deja-install
bun install
bun test
bun run dev opencode --dry-run
```

Build artifact (`dist/cli.js`) is produced by `bun run build` (via tsup, esm-only, Node 18+).

## License

MIT
