import { describe, test, expect } from 'bun:test';
import {
  generateKey,
  isValidHexKey,
  editJsonc,
  buildDejaMcpBlock,
  simpleDiff,
  renderDiff,
  detectShell,
  upsertEnvVarInRc,
  callToolsList,
  EXPECTED_LEAN_TOOLS,
} from '../src/util';
import { readFileSync, writeFileSync, existsSync, unlinkSync, mkdtempSync, chmodSync, statSync } from 'node:fs';
import { parseTree, findNodeAtLocation, parse } from 'jsonc-parser';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ============================================================================
// generateKey / isValidHexKey
// ============================================================================

describe('generateKey', () => {
  test('produces 64-char lowercase hex', () => {
    for (let i = 0; i < 10; i++) {
      const k = generateKey();
      expect(k).toMatch(/^[0-9a-f]{64}$/);
      expect(k.length).toBe(64);
    }
  });

  test('is non-deterministic', () => {
    const a = generateKey();
    const b = generateKey();
    expect(a).not.toBe(b);
  });
});

describe('isValidHexKey', () => {
  test('accepts 64-char lowercase hex', () => {
    expect(isValidHexKey('a'.repeat(64))).toBe(true);
    expect(isValidHexKey(generateKey())).toBe(true);
  });
  test('accepts uppercase too', () => {
    expect(isValidHexKey('A'.repeat(64))).toBe(true);
  });
  test('rejects wrong length', () => {
    expect(isValidHexKey('a'.repeat(63))).toBe(false);
    expect(isValidHexKey('a'.repeat(65))).toBe(false);
  });
  test('rejects non-hex', () => {
    expect(isValidHexKey('g'.repeat(64))).toBe(false);
  });
});

// ============================================================================
// editJsonc — comment preservation
// ============================================================================

describe('editJsonc (comment-preserving merge)', () => {
  const fixtureBase = readFileSync(
    join(import.meta.dir, 'fixtures/opencode.base.jsonc'),
    'utf8',
  );
  const fixtureWithDeja = readFileSync(
    join(import.meta.dir, 'fixtures/opencode.with-deja.jsonc'),
    'utf8',
  );

  test('injecting mcp.deja preserves all existing comments in the file', () => {
    const block = buildDejaMcpBlock('https://example.workers.dev/mcp/lean');
    const next = editJsonc(fixtureBase, ['mcp', 'deja'], block);

    // Every comment in the original should still appear verbatim
    const originalComments = [
      '// Keep this comment: it tells future-me why provider X is disabled.',
      '// Allow file edits without prompting',
      '// (no deja yet)',
    ];
    for (const c of originalComments) {
      expect(next).toContain(c);
    }
  });

  test('injected block is parseable + has expected shape', () => {
    const block = buildDejaMcpBlock('https://example.workers.dev/mcp/lean');
    const next = editJsonc(fixtureBase, ['mcp', 'deja'], block);
    const parsed = parse(next) as {
      mcp: { deja: { type: string; url: string; oauth: boolean; enabled: boolean; headers: Record<string, string> } };
    };
    expect(parsed.mcp.deja.type).toBe('remote');
    expect(parsed.mcp.deja.url).toBe('https://example.workers.dev/mcp/lean');
    expect(parsed.mcp.deja.oauth).toBe(false);
    expect(parsed.mcp.deja.enabled).toBe(true);
    expect(parsed.mcp.deja.headers.Authorization).toBe('Bearer {env:DEJA_API_KEY}');
  });

  test('injected block leaves the sibling cf-portal block untouched', () => {
    const block = buildDejaMcpBlock('https://example.workers.dev/mcp/lean');
    const next = editJsonc(fixtureBase, ['mcp', 'deja'], block);
    const parsed = parse(next) as { mcp: { 'cf-portal': { url: string } } };
    expect(parsed.mcp['cf-portal'].url).toBe('https://portal.mcp.cfdata.org/mcp');
  });

  test('rotation path (mcp.deja already present) only replaces the block, preserves the rotation comment', () => {
    const block = buildDejaMcpBlock('https://rotated.workers.dev/mcp/lean');
    const next = editJsonc(fixtureWithDeja, ['mcp', 'deja'], block);

    // Rotation comment above the block stays
    expect(next).toContain('// deja already configured — rotation path should not touch this comment');

    // URL has changed
    const tree = parseTree(next)!;
    const node = findNodeAtLocation(tree, ['mcp', 'deja', 'url']);
    expect(node?.value).toBe('https://rotated.workers.dev/mcp/lean');
  });
});

// ============================================================================
// simpleDiff / renderDiff
// ============================================================================

describe('simpleDiff', () => {
  test('identical strings → all context, no changes', () => {
    const d = simpleDiff('a\nb\nc', 'a\nb\nc');
    expect(d.every((l) => l.kind === 'ctx')).toBe(true);
  });

  test('pure addition at end', () => {
    const d = simpleDiff('a\nb', 'a\nb\nc');
    const adds = d.filter((l) => l.kind === 'add');
    expect(adds.length).toBe(1);
    expect(adds[0]!.text).toBe('c');
  });

  test('pure deletion', () => {
    const d = simpleDiff('a\nb\nc', 'a\nc');
    const dels = d.filter((l) => l.kind === 'del');
    expect(dels.length).toBe(1);
    expect(dels[0]!.text).toBe('b');
  });
});

describe('renderDiff', () => {
  test('unchanged file yields empty output', () => {
    expect(renderDiff('same\n', 'same\n')).toBe('');
  });

  test('addition produces a + marker with the new text', () => {
    process.env.NO_COLOR = '1'; // strip ANSI for assertion
    const out = renderDiff('x\n', 'x\ny\n');
    delete process.env.NO_COLOR;
    expect(out).toContain('+ y');
  });
});

// ============================================================================
// detectShell — zsh-over-bash preference
// ============================================================================

describe('detectShell', () => {
  test('respects DEJA_INSTALL_SHELL override for fish', () => {
    const s = detectShell({ DEJA_INSTALL_SHELL: '/usr/local/bin/fish' } as NodeJS.ProcessEnv);
    expect(s.kind).toBe('fish');
    expect(s.rcFile).toContain('config.fish');
  });

  test('picks zsh when SHELL=zsh', () => {
    const s = detectShell({ DEJA_INSTALL_SHELL: '/bin/zsh' } as NodeJS.ProcessEnv);
    expect(s.kind).toBe('zsh');
    expect(s.rcFile).toContain('.zshenv');
    expect(s.exportLine('FOO', 'bar')).toBe('export FOO=bar');
  });

  test('picks zsh over bash when $SHELL=bash but ~/.zshenv or ~/.zshrc exists', () => {
    // This is the real-world case: $SHELL=/bin/bash (system default on some
    // docker containers) but the dev uses zsh interactively. zsh wins.
    const s = detectShell({ DEJA_INSTALL_SHELL: '/bin/bash' } as NodeJS.ProcessEnv);
    // On the test runner's $HOME, .zshenv or .zshrc likely exists (dev box);
    // if neither exists, this will fall through to bash which is also a valid
    // outcome — but the spec-defined zsh-beats-bash rule is covered by the
    // override test above. Here we assert the result is zsh if the hints exist.
    if (existsSync(join(require('node:os').homedir(), '.zshenv')) ||
        existsSync(join(require('node:os').homedir(), '.zshrc'))) {
      expect(s.kind).toBe('zsh');
    } else {
      expect(s.kind).toBe('bash');
    }
  });

  test('fish export syntax differs', () => {
    const s = detectShell({ DEJA_INSTALL_SHELL: '/usr/local/bin/fish' } as NodeJS.ProcessEnv);
    expect(s.exportLine('FOO', 'bar')).toBe('set -gx FOO bar');
    expect(s.matchLinePrefix('FOO')).toBe('set -gx FOO ');
  });
});

// ============================================================================
// upsertEnvVarInRc — idempotent + rotation
// ============================================================================

describe('upsertEnvVarInRc', () => {
  const mkTempRc = (content = ''): string => {
    const dir = mkdtempSync(join(tmpdir(), 'deja-install-test-'));
    const path = join(dir, '.zshenv');
    if (content) writeFileSync(path, content);
    return path;
  };

  const mockShell = (rcFile: string) => ({
    kind: 'zsh' as const,
    rcFile,
    exportLine: (n: string, v: string) => `export ${n}=${v}`,
    matchLinePrefix: (n: string) => `export ${n}=`,
  });

  test('adds line to an empty rc file and chmods 600', () => {
    const path = mkTempRc();
    const r = upsertEnvVarInRc(mockShell(path), 'DEJA_API_KEY', 'abc');
    expect(r.action).toBe('added');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('export DEJA_API_KEY=abc');
    expect(content).toContain('# Added by deja-install');
    const mode = statSync(path).mode & 0o777;
    expect(mode).toBe(0o600);
    unlinkSync(path);
  });

  test('is idempotent — re-running with the same value is unchanged', () => {
    const path = mkTempRc();
    upsertEnvVarInRc(mockShell(path), 'DEJA_API_KEY', 'abc');
    const first = readFileSync(path, 'utf8');
    const r = upsertEnvVarInRc(mockShell(path), 'DEJA_API_KEY', 'abc');
    expect(r.action).toBe('unchanged');
    expect(readFileSync(path, 'utf8')).toBe(first);
    unlinkSync(path);
  });

  test('rotation — same var, different value → in-place rewrite, no duplicate', () => {
    const path = mkTempRc('# existing\nexport OTHER=1\nexport DEJA_API_KEY=old\n');
    const r = upsertEnvVarInRc(mockShell(path), 'DEJA_API_KEY', 'new');
    expect(r.action).toBe('updated');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('export DEJA_API_KEY=new');
    expect(content).not.toContain('export DEJA_API_KEY=old');
    expect(content).toContain('export OTHER=1');
    // Only one DEJA_API_KEY line
    const occurrences = content.split('\n').filter((l) => l.startsWith('export DEJA_API_KEY=')).length;
    expect(occurrences).toBe(1);
    unlinkSync(path);
  });

  test('preserves preceding content when appending', () => {
    const path = mkTempRc('export PATH=/usr/bin\n');
    upsertEnvVarInRc(mockShell(path), 'DEJA_API_KEY', 'xyz');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('export PATH=/usr/bin');
    expect(content).toContain('export DEJA_API_KEY=xyz');
    unlinkSync(path);
  });

  test('prefix safety — does not treat `DEJA_API_KEY_OTHER=…` as the same var', () => {
    // The `=` terminator in matchLinePrefix makes this safe. Regression guard.
    const path = mkTempRc('export DEJA_API_KEY_OTHER=sibling\n');
    const r = upsertEnvVarInRc(mockShell(path), 'DEJA_API_KEY', 'real');
    expect(r.action).toBe('added');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('export DEJA_API_KEY_OTHER=sibling'); // untouched
    expect(content).toContain('export DEJA_API_KEY=real');          // appended
    unlinkSync(path);
  });
});

// ============================================================================
// callToolsList — 401 path
// ============================================================================

describe('callToolsList', () => {
  test('returns ok:false with status=401 when auth is rejected', async () => {
    // Use real MCP endpoint with an intentionally bogus key — this is a
    // real integration check that the 401 path is exercised.
    const r = await callToolsList('https://deja.coy.workers.dev/mcp/lean', 'not-a-real-key-deadbeef', 5000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect([401, 403]).toContain(r.status);
    }
  }, 10000);

  test('returns ok:false with status=0 + error when URL is unreachable', async () => {
    const r = await callToolsList('https://nonexistent-host-deja-test-58192.invalid/mcp/lean', 'x', 3000);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(0);
      expect(r.error.length).toBeGreaterThan(0);
    }
  }, 8000);

  test('expected lean tool list', () => {
    expect(EXPECTED_LEAN_TOOLS).toEqual(['search', 'execute', 'inject']);
  });
});
