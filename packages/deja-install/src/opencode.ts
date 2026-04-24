/**
 * OpenCode-specific installer.
 *
 * Writes an MCP block to ~/.config/opencode/opencode.jsonc, preserving
 * comments via jsonc-parser. Then (optionally) sets DEJA_API_KEY in the
 * user's shell rc file and live-verifies the endpoint.
 */
import { existsSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseTree, findNodeAtLocation } from 'jsonc-parser';
import {
  ask,
  buildDejaMcpBlock,
  callToolsList,
  detectShell,
  editJsonc,
  EXPECTED_LEAN_TOOLS,
  generateKey,
  isValidHexKey,
  log,
  readJsoncIfExists,
  renderDiff,
  style,
  upsertEnvVarInRc,
  type VerifyStep,
} from './util.js';

export const DEFAULT_MCP_URL = 'https://deja.coy.workers.dev/mcp/lean';
export const OPENCODE_CONFIG_PATH = join(homedir(), '.config', 'opencode', 'opencode.jsonc');

export interface InstallOpts {
  url?: string;
  existingKey?: string;
  dryRun?: boolean;
  envVarName?: string;
  /** For tests: override config path */
  configPath?: string;
  /** Non-interactive: skip rc-file prompt, still print instructions. */
  noShellWrite?: boolean;
  /** For tests: skip the live verify HTTP call. */
  skipVerify?: boolean;
}

export interface InstallResult {
  mode: 'install' | 'rotate' | 'dry-run' | 'aborted';
  configPath: string;
  rcPath?: string;
  rcAction?: 'added' | 'updated' | 'unchanged';
  key?: string;
  verify?: VerifyStep[];
}

// ============================================================================
// Install
// ============================================================================

export const installOpenCode = async (opts: InstallOpts = {}): Promise<InstallResult> => {
  const configPath = opts.configPath ?? OPENCODE_CONFIG_PATH;
  const url = opts.url ?? DEFAULT_MCP_URL;
  const envVarName = opts.envVarName ?? 'DEJA_API_KEY';

  log.step('deja-install — OpenCode');
  log.info(`config: ${style.dim(configPath)}`);
  log.info(`url:    ${style.dim(url)}`);

  // 1. Config file must exist
  const current = readJsoncIfExists(configPath);
  if (!current) {
    log.err(`OpenCode config not found: ${configPath}`);
    log.plain('');
    log.plain('Create it first. Minimal stub:');
    log.plain(style.dim(`  mkdir -p "$(dirname "${configPath}")"`));
    log.plain(
      style.dim(
        `  cat > "${configPath}" <<'JSON'\n{\n  "$schema": "https://opencode.ai/config.json"\n}\nJSON`,
      ),
    );
    log.plain('');
    log.plain('Then re-run `npx deja-install opencode`.');
    process.exit(1);
  }

  // 2. Check for existing deja block
  const tree = parseTree(current.text);
  const existingDeja = tree ? findNodeAtLocation(tree, ['mcp', 'deja']) : undefined;
  const alreadyInstalled = existingDeja !== undefined;

  let mode: 'install' | 'rotate' = 'install';
  if (alreadyInstalled) {
    if (opts.dryRun) {
      log.warn('deja MCP block already present — would rotate the key and leave the URL/shape alone.');
    } else {
      const rotate = await ask('deja MCP is already configured. Rotate key?', false);
      if (!rotate) {
        log.info('Nothing to do. Exiting.');
        return { mode: 'aborted', configPath };
      }
      mode = 'rotate';
    }
  }

  // 3. Resolve key
  let key: string;
  if (opts.existingKey) {
    if (!isValidHexKey(opts.existingKey)) {
      log.err(`--key must be a 64-char hex string (got ${opts.existingKey.length} chars).`);
      process.exit(1);
    }
    key = opts.existingKey;
    log.info('using supplied --key');
  } else {
    key = generateKey();
    log.info(`generated new 256-bit key (${style.dim(key.slice(0, 8) + '…' + key.slice(-4))})`);
  }

  // 4. Compute next config
  const block = buildDejaMcpBlock(url, envVarName);
  const nextConfig = editJsonc(current.text, ['mcp', 'deja'], block);

  // ------------------------------------------------------------------
  // Dry-run branch — show diff, do nothing
  // ------------------------------------------------------------------
  if (opts.dryRun) {
    log.step('Dry-run — no files will be modified.');

    log.plain('');
    log.plain(style.bold(`Would modify ${configPath}:`));
    log.plain('');
    const diff = renderDiff(current.text, nextConfig);
    log.plain(diff || style.dim('  (no change)'));

    const shell = detectShell();
    log.plain('');
    log.plain(style.bold(`Would add to ${shell.rcFile}:`));
    log.plain('');
    log.plain(style.ok(`+ # Added by deja-install — bearer token for the deja MCP`));
    log.plain(style.ok(`+ ${shell.exportLine(envVarName, key)}`));
    log.plain('');
    log.plain(style.dim('(Exact key shown above is a candidate — a real install would also `chmod 600` the rc file.)'));

    return { mode: 'dry-run', configPath, key };
  }

  // ------------------------------------------------------------------
  // Real install branch
  // ------------------------------------------------------------------

  // Back up the existing config — one-line safety net
  const backup = `${configPath}.bak-deja-install-${timestamp()}`;
  copyFileSync(configPath, backup);
  log.info(`backup: ${style.dim(backup)}`);

  writeFileSync(configPath, nextConfig, 'utf8');
  log.ok(mode === 'rotate' ? 'rotated deja MCP block in opencode.jsonc' : 'injected deja MCP block into opencode.jsonc');

  // 5. Offer to write rc file
  let rcAction: 'added' | 'updated' | 'unchanged' | undefined;
  let rcPath: string | undefined;

  const shell = detectShell();
  let writeRc = true;
  if (opts.noShellWrite) {
    writeRc = false;
  } else {
    writeRc = await ask(`Add ${envVarName} to ${shell.rcFile}?`, true);
  }

  if (writeRc) {
    const r = upsertEnvVarInRc(shell, envVarName, key);
    rcAction = r.action;
    rcPath = r.path;
    log.ok(`${r.action === 'unchanged' ? 'env var already present' : r.action === 'updated' ? 'updated env var in' : 'added env var to'} ${r.path} (chmod 600)`);
  } else {
    log.warn('Skipped shell rc update. Export this yourself before launching OpenCode:');
    log.plain(style.dim(`  ${shell.exportLine(envVarName, key)}`));
  }

  // 6. Current-shell warning
  const currentValue = process.env[envVarName];
  if (currentValue !== key) {
    log.warn(`${envVarName} is not exported in this shell yet.`);
    log.plain(`  Open a new terminal, or run:  ${style.dim(`source ${shell.rcFile}`)}`);
    log.plain(`  before launching OpenCode, or the MCP handshake will 401.`);
  }

  // 7. Live verify
  let verify: VerifyStep[] | undefined;
  if (!opts.skipVerify) {
    log.step('Verifying the endpoint');
    verify = await runVerifyHttp(url, key);
    printVerify(verify);
  }

  // 8. Next steps
  log.step('Next steps');
  log.plain('  1. Restart OpenCode (quit and relaunch) to pick up the MCP change.');
  log.plain('  2. The deja MCP will appear as:');
  log.plain(style.dim('       deja_search(query, …)'));
  log.plain(style.dim('       deja_execute(op, args)'));
  log.plain(style.dim('       deja_inject(context, …)'));
  log.plain('     (OpenCode prefixes server tool names with the server key.)');
  log.plain('');
  log.plain(`  Your key is in ${style.dim(rcPath ?? shell.rcFile)}. Back up safely; rotate with ${style.dim('npx deja-install rotate opencode')}.`);

  return { mode, configPath, rcPath, rcAction, key, verify };
};

// ============================================================================
// Verify
// ============================================================================

export interface VerifyOpts {
  configPath?: string;
  envVarName?: string;
  /** Override the URL the verify reads from config with. For tests. */
  urlOverride?: string;
}

export const verifyOpenCode = async (opts: VerifyOpts = {}): Promise<VerifyStep[]> => {
  const configPath = opts.configPath ?? OPENCODE_CONFIG_PATH;
  const envVarName = opts.envVarName ?? 'DEJA_API_KEY';
  const steps: VerifyStep[] = [];

  // 1. Config block present?
  const current = readJsoncIfExists(configPath);
  if (!current) {
    steps.push({ name: 'config file exists', status: 'fail', detail: `not found: ${configPath}` });
    return steps;
  }
  steps.push({ name: 'config file exists', status: 'pass', detail: configPath });

  const tree = parseTree(current.text);
  const dejaNode = tree ? findNodeAtLocation(tree, ['mcp', 'deja']) : undefined;
  if (!dejaNode) {
    steps.push({ name: 'mcp.deja block present', status: 'fail', detail: 'missing in opencode.jsonc' });
    return steps;
  }
  const dejaValue = (current.value as { mcp?: { deja?: { url?: string; headers?: Record<string, string> } } })?.mcp?.deja;
  steps.push({ name: 'mcp.deja block present', status: 'pass' });

  const url = opts.urlOverride ?? dejaValue?.url ?? '';
  if (!url) {
    steps.push({ name: 'mcp.deja.url set', status: 'fail', detail: 'url missing' });
    return steps;
  }
  steps.push({ name: 'mcp.deja.url set', status: 'pass', detail: url });

  // Resolve header — may contain {env:NAME}
  const rawAuth = dejaValue?.headers?.Authorization ?? '';
  const envRefMatch = rawAuth.match(/\{env:([A-Z_][A-Z0-9_]*)\}/);
  const referencedEnvVar = envRefMatch ? envRefMatch[1] : undefined;
  const effectiveEnvVar = referencedEnvVar ?? envVarName;
  const envVal = process.env[effectiveEnvVar];

  if (!envVal) {
    steps.push({
      name: `env var $${effectiveEnvVar} set`,
      status: 'fail',
      detail: `not exported in current shell. \`source ~/.zshenv\` or open a new terminal, then re-run verify.`,
    });
    return steps;
  }
  steps.push({ name: `env var $${effectiveEnvVar} set`, status: 'pass', detail: `${envVal.length} chars` });

  // 2. URL reachable + auth + tools
  const live = await runVerifyHttp(url, envVal);
  return [...steps, ...live];
};

const runVerifyHttp = async (url: string, apiKey: string): Promise<VerifyStep[]> => {
  const steps: VerifyStep[] = [];
  const r = await callToolsList(url, apiKey);
  if (!r.ok) {
    if (r.status === 401 || r.status === 403) {
      steps.push({
        name: 'auth accepted',
        status: 'fail',
        detail: `HTTP ${r.status} — the server rejected the bearer token. Either the key doesn't match the Worker's API_KEY secret, or the Worker was redeployed against a different key. Run \`npx deja-install rotate opencode\` to generate a new one, then update the Worker secret.`,
      });
      return steps;
    }
    if (r.status === 0) {
      steps.push({
        name: 'URL reachable',
        status: 'fail',
        detail: `network error: ${r.error}`,
      });
      return steps;
    }
    steps.push({
      name: 'URL reachable',
      status: 'fail',
      detail: `HTTP ${r.status}: ${r.error}`,
    });
    return steps;
  }

  steps.push({ name: 'URL reachable', status: 'pass', detail: `HTTP ${r.status}` });
  steps.push({ name: 'auth accepted', status: 'pass' });

  const missing = EXPECTED_LEAN_TOOLS.filter((t) => !r.tools.includes(t));
  if (missing.length > 0) {
    steps.push({
      name: 'tools/list returns expected 3 lean tools',
      status: 'fail',
      detail: `missing: ${missing.join(', ')} | got: ${r.tools.join(', ')}`,
    });
  } else {
    steps.push({
      name: 'tools/list returns expected 3 lean tools',
      status: 'pass',
      detail: r.tools.join(', '),
    });
  }
  return steps;
};

export const printVerify = (steps: VerifyStep[]): void => {
  for (const s of steps) {
    const icon =
      s.status === 'pass' ? style.ok('PASS') : s.status === 'skip' ? style.warn('SKIP') : style.err('FAIL');
    const detail = s.detail ? ` ${style.dim('— ' + s.detail)}` : '';
    log.plain(`  [${icon}] ${s.name}${detail}`);
  }
};

// ============================================================================
// Rotate
// ============================================================================

export interface RotateOpts {
  configPath?: string;
  envVarName?: string;
  /** Run wrangler/gh regardless of prompt (tests only). */
  autoYes?: boolean;
  /** Skip the two "also update" prompts. */
  skipSync?: boolean;
}

export const rotateOpenCode = async (opts: RotateOpts = {}): Promise<InstallResult> => {
  const configPath = opts.configPath ?? OPENCODE_CONFIG_PATH;
  const envVarName = opts.envVarName ?? 'DEJA_API_KEY';

  log.step('deja-install — rotate OpenCode key');

  const current = readJsoncIfExists(configPath);
  if (!current) {
    log.err(`No config at ${configPath}. Run \`npx deja-install opencode\` first.`);
    process.exit(1);
  }
  const tree = parseTree(current.text);
  const dejaNode = tree ? findNodeAtLocation(tree, ['mcp', 'deja']) : undefined;
  if (!dejaNode) {
    log.err(`No mcp.deja block in ${configPath}. Run \`npx deja-install opencode\` first.`);
    process.exit(1);
  }

  const newKey = generateKey();
  log.ok(`generated new key — ${style.bold('copy this somewhere safe now:')}`);
  log.plain('');
  log.plain(`  ${style.bold(newKey)}`);
  log.plain('');
  log.plain(style.dim('  (It will also be written to your shell rc file. This is your only chance to'));
  log.plain(style.dim('   see the full string in this terminal — the rc file will be chmod 600.)'));
  log.plain('');

  // Update rc file
  const shell = detectShell();
  const r = upsertEnvVarInRc(shell, envVarName, newKey);
  log.ok(`${r.action === 'added' ? 'added' : r.action === 'updated' ? 'updated' : 'unchanged'} ${envVarName} in ${r.path} (chmod 600)`);

  if (opts.skipSync) {
    log.warn('Skipped Worker + GitHub Actions sync. Remember: this key will 401 until the Worker secret matches.');
    return { mode: 'rotate', configPath, rcPath: r.path, rcAction: r.action, key: newKey };
  }

  // Prompt: wrangler
  const { spawnSync } = await import('node:child_process');
  const hasWrangler = spawnSync('wrangler', ['--version'], { stdio: 'ignore' }).status === 0;
  if (hasWrangler) {
    const runWrangler = opts.autoYes || (await ask(
      `Update the Worker secret now via \`wrangler secret put API_KEY\` (in the deja worker)?`,
      false,
    ));
    if (runWrangler) {
      log.info('Running: wrangler secret put API_KEY');
      log.plain(style.dim('  (wrangler will prompt you to paste the value — paste the new key above)'));
      const res = spawnSync('wrangler', ['secret', 'put', 'API_KEY'], { stdio: 'inherit' });
      if (res.status === 0) log.ok('wrangler secret updated');
      else log.err(`wrangler exited with code ${res.status}. Re-run manually from the deja project root.`);
    } else {
      log.info('Skipped wrangler. Run manually when ready:  wrangler secret put API_KEY');
    }
  } else {
    log.info('wrangler not found on PATH. When ready:  wrangler secret put API_KEY  (in the deja project root)');
  }

  // Prompt: gh
  const hasGh = spawnSync('gh', ['auth', 'status'], { stdio: 'ignore' }).status === 0;
  if (hasGh) {
    const runGh = opts.autoYes || (await ask(
      `Update the GitHub Actions secret now via \`gh secret set ${envVarName}\`?`,
      false,
    ));
    if (runGh) {
      log.info(`Running: gh secret set ${envVarName}`);
      const res = spawnSync('gh', ['secret', 'set', envVarName, '--body', newKey], { stdio: 'inherit' });
      if (res.status === 0) log.ok('GitHub Actions secret updated');
      else log.err(`gh exited with code ${res.status}. Re-run manually.`);
    } else {
      log.info(`Skipped gh. Run manually when ready:  gh secret set ${envVarName}`);
    }
  } else {
    log.info(`gh not authed / not found. When ready:  gh secret set ${envVarName}`);
  }

  log.plain('');
  log.warn('The new key will 401 against the Worker until the Worker secret matches.');
  log.plain('  If the Worker is your own deploy, trigger CI redeploy after `gh secret set` lands.');
  log.plain('  If the endpoint is someone else\'s, they need to roll their secret on their end.');

  return { mode: 'rotate', configPath, rcPath: r.path, rcAction: r.action, key: newKey };
};

// ============================================================================
// utils
// ============================================================================

const timestamp = (): string => {
  const d = new Date();
  const pad = (n: number) => n.toString().padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};
