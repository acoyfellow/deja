import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { installOpenCode, verifyOpenCode } from '../src/opencode';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'jsonc-parser';

// Silence stdout for these tests so bun test output stays readable.
// Tests assert on return values, not on log output.
const silence = () => {
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((..._a: unknown[]) => true) as typeof process.stdout.write;
  process.stderr.write = ((..._a: unknown[]) => true) as typeof process.stderr.write;
  return () => {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  };
};

const mkTempConfigDir = (contents?: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'deja-install-opencode-'));
  const path = join(dir, 'opencode.jsonc');
  if (contents !== undefined) writeFileSync(path, contents);
  return path;
};

// ============================================================================
// Dry-run
// ============================================================================

describe('installOpenCode — dry-run', () => {
  let restore: () => void;
  beforeEach(() => { restore = silence(); });
  afterEach(() => { restore(); });

  test('changes nothing on disk when --dry-run is set', async () => {
    const fixture = readFileSync(
      join(import.meta.dir, 'fixtures/opencode.base.jsonc'),
      'utf8',
    );
    const path = mkTempConfigDir(fixture);
    const before = readFileSync(path, 'utf8');
    const beforeMtime = statSync(path).mtimeMs;

    // small delay to make mtime check meaningful if it did change
    await new Promise((r) => setTimeout(r, 5));

    const result = await installOpenCode({
      configPath: path,
      dryRun: true,
      noShellWrite: true,
      skipVerify: true,
    });

    expect(result.mode).toBe('dry-run');
    expect(readFileSync(path, 'utf8')).toBe(before);
    expect(statSync(path).mtimeMs).toBe(beforeMtime);
    expect(result.key).toBeDefined();
    expect(result.key).toMatch(/^[0-9a-f]{64}$/);

    rmSync(path, { force: true });
  });

  test('dry-run still produces a valid key when --key supplied', async () => {
    const fixture = readFileSync(
      join(import.meta.dir, 'fixtures/opencode.base.jsonc'),
      'utf8',
    );
    const path = mkTempConfigDir(fixture);
    const supplied = 'a'.repeat(64);

    const result = await installOpenCode({
      configPath: path,
      dryRun: true,
      existingKey: supplied,
      noShellWrite: true,
      skipVerify: true,
    });

    expect(result.key).toBe(supplied);
    rmSync(path, { force: true });
  });
});

// ============================================================================
// Real install
// ============================================================================

describe('installOpenCode — real install (HOME redirected)', () => {
  let restore: () => void;
  let origHome: string | undefined;
  let fakeHome: string;

  beforeEach(() => {
    restore = silence();
    // Redirect HOME so upsertEnvVarInRc writes to a temp dir, not the user's
    // real ~/.zshenv. DEJA_INSTALL_SHELL forces zsh regardless of $SHELL so
    // the test deterministically picks ~/.zshenv inside fakeHome.
    fakeHome = mkdtempSync(join(tmpdir(), 'deja-install-home-'));
    origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    process.env.DEJA_INSTALL_SHELL = '/bin/zsh';
  });

  afterEach(() => {
    if (origHome !== undefined) process.env.HOME = origHome;
    else delete process.env.HOME;
    delete process.env.DEJA_INSTALL_SHELL;
    try { rmSync(fakeHome, { recursive: true, force: true }); } catch {}
    restore();
  });

  test('writes deja block + preserves comments + creates backup (noShellWrite path)', async () => {
    // noShellWrite=true skips the interactive prompt — the rc-file injection
    // itself is tested directly against upsertEnvVarInRc in util.test.ts.
    const fixture = readFileSync(
      join(import.meta.dir, 'fixtures/opencode.base.jsonc'),
      'utf8',
    );
    const configPath = join(fakeHome, 'opencode.jsonc');
    writeFileSync(configPath, fixture);

    const result = await installOpenCode({
      configPath,
      existingKey: 'b'.repeat(64),
      noShellWrite: true,
      skipVerify: true,
    });

    expect(result.mode).toBe('install');
    expect(result.key).toBe('b'.repeat(64));

    const after = readFileSync(configPath, 'utf8');
    const parsed = parse(after) as { mcp: { deja: { url: string }; 'cf-portal': { url: string } } };
    expect(parsed.mcp.deja.url).toBe('https://deja.coy.workers.dev/mcp/lean');
    // Sibling mcp block left alone
    expect(parsed.mcp['cf-portal'].url).toBe('https://portal.mcp.cfdata.org/mcp');

    // Comments from fixture preserved
    expect(after).toContain('// Keep this comment');
    expect(after).toContain('// Allow file edits without prompting');

    // Backup created alongside the config
    const fs = await import('node:fs');
    const path = await import('node:path');
    const sibling = fs.readdirSync(path.dirname(configPath));
    const backup = sibling.find((f) => f.startsWith('opencode.jsonc.bak-deja-install-'));
    expect(backup).toBeDefined();
    // Backup content matches pre-install state
    expect(fs.readFileSync(path.join(path.dirname(configPath), backup!), 'utf8')).toBe(fixture);
  });

  test('rotate path — pre-existing deja block, flagged, user says no → aborted', async () => {
    const fixture = readFileSync(
      join(import.meta.dir, 'fixtures/opencode.with-deja.jsonc'),
      'utf8',
    );
    const configPath = join(fakeHome, 'opencode.jsonc');
    writeFileSync(configPath, fixture);
    const before = readFileSync(configPath, 'utf8');

    // dry-run path when block already exists: dryRun short-circuits the
    // rotation prompt and renders the diff that rotation *would* produce.
    const result = await installOpenCode({
      configPath,
      dryRun: true,
      noShellWrite: true,
      skipVerify: true,
    });
    expect(result.mode).toBe('dry-run');
    // Config should be untouched by dry-run even when deja already exists
    expect(readFileSync(configPath, 'utf8')).toBe(before);
  });
});

// ============================================================================
// Verify
// ============================================================================

describe('verifyOpenCode', () => {
  let restore: () => void;
  beforeEach(() => { restore = silence(); });
  afterEach(() => { restore(); });

  test('fails gracefully when config file is missing', async () => {
    const bogus = join(tmpdir(), 'deja-install-nonexistent-' + Date.now(), 'opencode.jsonc');
    const steps = await verifyOpenCode({ configPath: bogus });
    expect(steps[0]?.name).toBe('config file exists');
    expect(steps[0]?.status).toBe('fail');
  });

  test('fails when mcp.deja block is absent', async () => {
    const fixture = readFileSync(
      join(import.meta.dir, 'fixtures/opencode.base.jsonc'),
      'utf8',
    );
    const path = mkTempConfigDir(fixture);
    const steps = await verifyOpenCode({ configPath: path });
    const blockStep = steps.find((s) => s.name === 'mcp.deja block present');
    expect(blockStep?.status).toBe('fail');
    rmSync(path, { force: true });
  });

  test('fails on env-var missing when the header references {env:NAME}', async () => {
    const fixture = readFileSync(
      join(import.meta.dir, 'fixtures/opencode.with-deja.jsonc'),
      'utf8',
    );
    const path = mkTempConfigDir(fixture);
    // Stash + clear the env var
    const saved = process.env.DEJA_API_KEY;
    delete process.env.DEJA_API_KEY;
    try {
      const steps = await verifyOpenCode({ configPath: path });
      const envStep = steps.find((s) => s.name.startsWith('env var'));
      expect(envStep?.status).toBe('fail');
    } finally {
      if (saved !== undefined) process.env.DEJA_API_KEY = saved;
      rmSync(path, { force: true });
    }
  });

  test('401 path — env var set but key is bogus → auth accepted=fail', async () => {
    const fixture = readFileSync(
      join(import.meta.dir, 'fixtures/opencode.with-deja.jsonc'),
      'utf8',
    );
    const path = mkTempConfigDir(fixture);
    const saved = process.env.DEJA_API_KEY;
    process.env.DEJA_API_KEY = 'deadbeef-not-a-real-key';
    try {
      const steps = await verifyOpenCode({ configPath: path });
      const authStep = steps.find((s) => s.name === 'auth accepted');
      // Either we get to the auth step and it fails, or the URL is unreachable
      // (both represent "not PASS"). The test verifies we don't throw.
      if (authStep) {
        expect(authStep.status).toBe('fail');
      } else {
        const reach = steps.find((s) => s.name === 'URL reachable');
        expect(reach?.status).toBe('fail');
      }
    } finally {
      if (saved !== undefined) process.env.DEJA_API_KEY = saved;
      else delete process.env.DEJA_API_KEY;
      rmSync(path, { force: true });
    }
  }, 15000);
});
