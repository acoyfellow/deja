/**
 * Shared helpers for deja-install.
 *
 * Intentionally zero npm deps outside jsonc-parser. Prompts use node:readline,
 * colors use ANSI escapes, no chalk/ora/inquirer.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync, appendFileSync, mkdirSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join, dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { applyEdits, modify, parse } from 'jsonc-parser';
import type { JSONPath } from 'jsonc-parser';

// ============================================================================
// Terminal output
// ============================================================================

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
} as const;

const useColor = (): boolean => {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return process.stdout.isTTY === true;
};

const c = (color: keyof typeof ANSI, s: string): string =>
  useColor() ? `${ANSI[color]}${s}${ANSI.reset}` : s;

export const style = {
  ok: (s: string) => c('green', s),
  warn: (s: string) => c('yellow', s),
  err: (s: string) => c('red', s),
  info: (s: string) => c('cyan', s),
  bold: (s: string) => c('bold', s),
  dim: (s: string) => c('dim', s),
};

export const log = {
  info: (s: string) => process.stdout.write(`${style.info('•')} ${s}\n`),
  ok: (s: string) => process.stdout.write(`${style.ok('✓')} ${s}\n`),
  warn: (s: string) => process.stdout.write(`${style.warn('!')} ${s}\n`),
  err: (s: string) => process.stderr.write(`${style.err('✗')} ${s}\n`),
  step: (s: string) => process.stdout.write(`\n${style.bold(s)}\n`),
  plain: (s: string) => process.stdout.write(`${s}\n`),
};

// ============================================================================
// Prompts (readline, no inquirer)
// ============================================================================

export const ask = async (question: string, defaultYes = false): Promise<boolean> => {
  const rl = createInterface({ input, output });
  try {
    const suffix = defaultYes ? '[Y/n]' : '[y/N]';
    const answer = (await rl.question(`${question} ${suffix} `)).trim().toLowerCase();
    if (answer === '') return defaultYes;
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
};

export const askLine = async (question: string): Promise<string> => {
  const rl = createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
};

// ============================================================================
// Key generation
// ============================================================================

/** Generate a random 256-bit hex-encoded key (64 chars). */
export const generateKey = (): string => randomBytes(32).toString('hex');

export const isValidHexKey = (key: string): boolean =>
  /^[0-9a-f]{64}$/i.test(key);

// ============================================================================
// Platform / shell detection
// ============================================================================

export type ShellKind = 'zsh' | 'bash' | 'fish';

export interface ShellInfo {
  kind: ShellKind;
  rcFile: string;
  exportLine: (varName: string, value: string) => string;
  matchLinePrefix: (varName: string) => string;
}

const homeFile = (rel: string): string => join(homedir(), rel);

/**
 * Detect the user's login shell + the right rc file.
 *
 * Preference order:
 *   1. Explicit override via DEJA_INSTALL_SHELL env var (for tests)
 *   2. Parse $SHELL
 *   3. If zsh exists on disk (~/.zshenv OR ~/.zshrc present), prefer zsh
 *   4. Fall back to bash
 *
 * Zsh beats bash when both exist because `~/.zshenv` loads for non-interactive
 * shells too (relevant: opencode launched from Finder / GUI / launchd agents
 * on macOS). `~/.bashrc` only loads for interactive non-login shells.
 */
export const detectShell = (env: NodeJS.ProcessEnv = process.env): ShellInfo => {
  const override = env.DEJA_INSTALL_SHELL;
  const shell = (override || env.SHELL || '').toLowerCase();

  // Fish is unambiguous; if the user is on fish, respect it.
  // matchLinePrefix deliberately ends with a space so `DEJA_API_KEY_FOO`
  // doesn't match the prefix for `DEJA_API_KEY`.
  if (shell.includes('fish')) {
    return {
      kind: 'fish',
      rcFile: homeFile('.config/fish/config.fish'),
      exportLine: (name, value) => `set -gx ${name} ${value}`,
      matchLinePrefix: (name) => `set -gx ${name} `,
    };
  }

  // zsh-over-bash preference: if the shell is zsh OR ~/.zshenv/zshrc exists,
  // use zsh even if $SHELL happens to be bash in the current test env.
  const zshHints =
    shell.includes('zsh') ||
    existsSync(homeFile('.zshenv')) ||
    existsSync(homeFile('.zshrc'));

  // matchLinePrefix ends with `=` so `export DEJA_API_KEY=x` only matches
  // `export DEJA_API_KEY=` and not `export DEJA_API_KEY_OTHER=…`. The `=`
  // character isn't valid inside a shell var name, so this prefix is safe.
  if (zshHints) {
    return {
      kind: 'zsh',
      rcFile: homeFile('.zshenv'),
      exportLine: (name, value) => `export ${name}=${value}`,
      matchLinePrefix: (name) => `export ${name}=`,
    };
  }

  return {
    kind: 'bash',
    rcFile: homeFile('.bashrc'),
    exportLine: (name, value) => `export ${name}=${value}`,
    matchLinePrefix: (name) => `export ${name}=`,
  };
};

export const rejectWindows = (): void => {
  if (platform() === 'win32') {
    log.err(
      'Windows is not supported by deja-install yet. On WSL, run this from inside the WSL shell.',
    );
    log.plain(
      'If you need Windows support, open an issue: https://github.com/acoyfellow/deja/issues',
    );
    process.exit(1);
  }
};

// ============================================================================
// OpenCode MCP block
// ============================================================================

export interface McpBlock {
  type: 'remote';
  url: string;
  enabled: true;
  oauth: false;
  headers: Record<string, string>;
}

export const buildDejaMcpBlock = (url: string, envVarName = 'DEJA_API_KEY'): McpBlock => ({
  type: 'remote',
  url,
  enabled: true,
  oauth: false,
  headers: {
    Authorization: `Bearer {env:${envVarName}}`,
  },
});

// ============================================================================
// JSONC edit — comment-preserving merge
// ============================================================================

/**
 * Merge (or replace) a value at the given JSON path while preserving all
 * surrounding comments and formatting.
 *
 * Uses jsonc-parser's `modify` + `applyEdits` — NOT JSON.stringify round-trip,
 * which would nuke the comments.
 */
export const editJsonc = (
  original: string,
  path: JSONPath,
  value: unknown,
  formattingOptions: { tabSize?: number; insertSpaces?: boolean } = { tabSize: 2, insertSpaces: true },
): string => {
  const edits = modify(original, path, value, { formattingOptions });
  return applyEdits(original, edits);
};

export const readJsoncIfExists = (path: string): { text: string; value: unknown } | null => {
  if (!existsSync(path)) return null;
  const text = readFileSync(path, 'utf8');
  return { text, value: parse(text) };
};

export interface DiffLine {
  kind: 'add' | 'del' | 'ctx';
  text: string;
}

/**
 * Minimal diff renderer. We don't pull in a diff library; we split both
 * documents into lines and produce a unified-style view per the stdlib
 * `diff` behavior is fine enough for "show me what would change" UX.
 *
 * Algorithm: LCS, but on small files (opencode.jsonc is ~50 lines) the O(nm)
 * table is trivially small.
 */
export const simpleDiff = (before: string, after: string): DiffLine[] => {
  const a = before.split('\n');
  const b = after.split('\n');
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      if (a[i] === b[j]) dp[i]![j] = dp[i + 1]![j + 1]! + 1;
      else dp[i]![j] = Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const out: DiffLine[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      out.push({ kind: 'ctx', text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      out.push({ kind: 'del', text: a[i]! });
      i++;
    } else {
      out.push({ kind: 'add', text: b[j]! });
      j++;
    }
  }
  while (i < m) { out.push({ kind: 'del', text: a[i++]! }); }
  while (j < n) { out.push({ kind: 'add', text: b[j++]! }); }
  return out;
};

export const renderDiff = (before: string, after: string, opts: { contextLines?: number } = {}): string => {
  const lines = simpleDiff(before, after);
  const ctx = opts.contextLines ?? 2;

  // Show all lines with +/- markers, but collapse long context runs
  const parts: string[] = [];
  let lastChangeIdx = -Infinity;
  // Find indexes of changes so we can include surrounding context
  const changeIndexes = new Set<number>();
  lines.forEach((l, idx) => {
    if (l.kind !== 'ctx') changeIndexes.add(idx);
  });
  const keep = new Set<number>();
  for (const idx of changeIndexes) {
    for (let k = Math.max(0, idx - ctx); k <= Math.min(lines.length - 1, idx + ctx); k++) {
      keep.add(k);
    }
  }
  let prev = -2;
  for (let i = 0; i < lines.length; i++) {
    if (!keep.has(i)) continue;
    if (i - prev > 1) parts.push(style.dim('  …'));
    const l = lines[i]!;
    if (l.kind === 'add') parts.push(style.ok(`+ ${l.text}`));
    else if (l.kind === 'del') parts.push(style.err(`- ${l.text}`));
    else parts.push(style.dim(`  ${l.text}`));
    prev = i;
  }
  return parts.join('\n');
};

// ============================================================================
// Shell rc file injection
// ============================================================================

export interface RcInjectResult {
  action: 'added' | 'updated' | 'unchanged';
  path: string;
}

/**
 * Idempotent append of `export NAME=value` into the shell rc file.
 *
 * - If the exact line is present: no-op.
 * - If a line starting with `export NAME=` is present with a different value:
 *   rewrite that line in place (rotation case).
 * - Otherwise: append to the end with a leading deja marker comment.
 * - chmod 600 afterwards — the file holds a bearer token.
 */
export const upsertEnvVarInRc = (
  shell: ShellInfo,
  varName: string,
  value: string,
): RcInjectResult => {
  const prefix = shell.matchLinePrefix(varName);
  const desiredLine = shell.exportLine(varName, value);

  let existing = '';
  if (existsSync(shell.rcFile)) existing = readFileSync(shell.rcFile, 'utf8');

  const lines = existing.length === 0 ? [] : existing.split('\n');
  const idx = lines.findIndex((l) => l.startsWith(prefix));

  if (idx === -1) {
    // Append
    const appended: string[] = [];
    if (existing.length > 0 && !existing.endsWith('\n')) appended.push('');
    appended.push('# Added by deja-install — bearer token for the deja MCP');
    appended.push(desiredLine);
    const next = existing + appended.join('\n') + '\n';
    writeOrCreate(shell.rcFile, next);
    chmodSafe(shell.rcFile, 0o600);
    return { action: 'added', path: shell.rcFile };
  }

  if (lines[idx] === desiredLine) {
    chmodSafe(shell.rcFile, 0o600);
    return { action: 'unchanged', path: shell.rcFile };
  }

  lines[idx] = desiredLine;
  writeOrCreate(shell.rcFile, lines.join('\n'));
  chmodSafe(shell.rcFile, 0o600);
  return { action: 'updated', path: shell.rcFile };
};

const writeOrCreate = (path: string, content: string): void => {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    // Matches macOS behavior — shell rc dirs always exist at $HOME, but
    // ~/.config/fish might not.
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, content, 'utf8');
};

const chmodSafe = (path: string, mode: number): void => {
  try {
    chmodSync(path, mode);
  } catch {
    // Non-fatal — some filesystems (e.g. certain CI runners) refuse chmod
  }
};

// re-export for callers that want to append a comment without rewriting
export const appendLineToFile = (path: string, line: string): void => {
  const needsLeadingNewline = existsSync(path) && !readFileSync(path, 'utf8').endsWith('\n');
  appendFileSync(path, (needsLeadingNewline ? '\n' : '') + line + '\n', 'utf8');
};

// ============================================================================
// MCP live verify
// ============================================================================

export interface VerifyStep {
  name: string;
  status: 'pass' | 'fail' | 'skip';
  detail?: string;
}

export interface ToolsListResponse {
  tools?: Array<{ name: string }>;
}

/**
 * POST a JSON-RPC `tools/list` to the MCP endpoint. Expects HTTP 200 and
 * a tools array with at least `search`, `execute`, `inject`.
 *
 * Hitting the server returns tool names WITHOUT the `deja_` prefix that
 * OpenCode applies client-side (OpenCode namespaces by server key).
 */
export const callToolsList = async (
  url: string,
  apiKey: string,
  timeoutMs = 10_000,
): Promise<
  | { ok: true; tools: string[]; status: number }
  | { ok: false; status: number; error: string }
> => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      signal: controller.signal,
    });
    const status = res.status;
    const text = await res.text();
    if (!res.ok) return { ok: false, status, error: text.slice(0, 200) };
    try {
      const parsed = JSON.parse(text) as { result?: ToolsListResponse; error?: unknown };
      const tools = (parsed.result?.tools || []).map((t) => t.name);
      return { ok: true, status, tools };
    } catch {
      return { ok: false, status, error: `non-JSON response: ${text.slice(0, 200)}` };
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, status: 0, error: msg };
  } finally {
    clearTimeout(timer);
  }
};

export const EXPECTED_LEAN_TOOLS = ['search', 'execute', 'inject'] as const;
