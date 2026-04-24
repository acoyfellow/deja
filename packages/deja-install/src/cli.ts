#!/usr/bin/env node
/**
 * deja-install CLI — argv dispatcher.
 *
 *   npx deja-install <client> [--url ...] [--key ...] [--dry-run]
 *   npx deja-install verify <client>
 *   npx deja-install rotate <client>
 *
 * Supported clients:
 *   opencode   — fully implemented
 *   claude     — stub, exits 2
 *   cursor     — stub, exits 2
 */
import { log, rejectWindows, style } from './util.js';
import { installOpenCode, verifyOpenCode, rotateOpenCode, printVerify } from './opencode.js';
import { installClaude, verifyClaude, rotateClaude } from './claude.js';
import { installCursor, verifyCursor, rotateCursor } from './cursor.js';

const USAGE = `deja-install — one-command installer for the deja MCP

Usage:
  npx deja-install <client> [--url <url>] [--key <hex>] [--dry-run]
  npx deja-install verify <client>
  npx deja-install rotate <client>

Clients:
  opencode   ${style.ok('✓')} implemented
  claude     ${style.dim('(stub)')}
  cursor     ${style.dim('(stub)')}

Flags:
  --url <url>        MCP URL to point at (default: https://deja.coy.workers.dev/mcp/lean)
  --key <hex>        Use a supplied 64-char hex key instead of generating one
  --dry-run          Show the diff; change nothing
  --no-shell-write   Skip writing to ~/.zshenv (or equivalent)
  --skip-verify      Skip the post-install live-verify HTTP call

Exit codes:
  0  success
  1  user error / invalid args / missing config
  2  client not implemented yet
`;

interface Args {
  verb: 'install' | 'verify' | 'rotate' | 'help';
  client?: string;
  url?: string;
  key?: string;
  dryRun: boolean;
  noShellWrite: boolean;
  skipVerify: boolean;
}

const parse = (argv: string[]): Args => {
  const args: Args = { verb: 'install', dryRun: false, noShellWrite: false, skipVerify: false };
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === '--help' || a === '-h') {
      args.verb = 'help';
      return args;
    } else if (a === '--dry-run') args.dryRun = true;
    else if (a === '--no-shell-write') args.noShellWrite = true;
    else if (a === '--skip-verify') args.skipVerify = true;
    else if (a === '--url') args.url = argv[++i];
    else if (a.startsWith('--url=')) args.url = a.slice('--url='.length);
    else if (a === '--key') args.key = argv[++i];
    else if (a.startsWith('--key=')) args.key = a.slice('--key='.length);
    else if (a.startsWith('--')) {
      log.err(`unknown flag: ${a}`);
      process.exit(1);
    } else {
      positional.push(a);
    }
  }

  if (positional.length === 0) {
    args.verb = 'help';
    return args;
  }

  const first = positional[0]!;
  if (first === 'verify' || first === 'rotate') {
    args.verb = first;
    args.client = positional[1];
  } else {
    args.verb = 'install';
    args.client = first;
  }

  return args;
};

export const main = async (argv: string[] = process.argv.slice(2)): Promise<void> => {
  rejectWindows();

  const args = parse(argv);

  if (args.verb === 'help') {
    process.stdout.write(USAGE);
    return;
  }

  if (!args.client) {
    log.err('missing <client>');
    process.stdout.write(USAGE);
    process.exit(1);
  }

  const client = args.client.toLowerCase();

  try {
    if (args.verb === 'install') {
      if (client === 'opencode') {
        await installOpenCode({
          url: args.url,
          existingKey: args.key,
          dryRun: args.dryRun,
          noShellWrite: args.noShellWrite,
          skipVerify: args.skipVerify,
        });
      } else if (client === 'claude' || client === 'claude-code') {
        await installClaude();
      } else if (client === 'cursor') {
        await installCursor();
      } else {
        log.err(`unknown client: ${client}`);
        process.exit(1);
      }
    } else if (args.verb === 'verify') {
      if (client === 'opencode') {
        const steps = await verifyOpenCode();
        log.step('Verify — OpenCode');
        printVerify(steps);
        const failed = steps.some((s) => s.status === 'fail');
        process.exit(failed ? 1 : 0);
      } else if (client === 'claude' || client === 'claude-code') {
        await verifyClaude();
      } else if (client === 'cursor') {
        await verifyCursor();
      } else {
        log.err(`unknown client: ${client}`);
        process.exit(1);
      }
    } else if (args.verb === 'rotate') {
      if (client === 'opencode') {
        await rotateOpenCode();
      } else if (client === 'claude' || client === 'claude-code') {
        await rotateClaude();
      } else if (client === 'cursor') {
        await rotateCursor();
      } else {
        log.err(`unknown client: ${client}`);
        process.exit(1);
      }
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.stack || e.message : String(e);
    log.err(msg);
    process.exit(1);
  }
};

// ESM entry
const isEntry = () => {
  // `import.meta.url` resolves to a file:// URL. Compare to argv[1].
  const invokedPath = process.argv[1] ?? '';
  try {
    const here = new URL(import.meta.url).pathname;
    return invokedPath === here || here.endsWith(invokedPath);
  } catch {
    return false;
  }
};

if (isEntry()) {
  void main();
}
