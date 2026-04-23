import { computeSuspectScore } from '../src/do/memory';
import type { Learning } from '../src/do/types';

function makeLearning(overrides: Partial<Learning> = {}): Learning {
  return {
    id: 'mem-1',
    trigger: 'deploying to production',
    learning: 'check wrangler.toml first',
    confidence: 0.8,
    scope: 'shared',
    type: 'memory',
    branchState: 'main',
    createdAt: new Date('2026-04-22T00:00:00.000Z').toISOString(),
    recallCount: 2,
    ...overrides,
  };
}

const NOW = Date.parse('2026-04-23T00:00:00.000Z'); // 1 day after default createdAt

describe('computeSuspectScore', () => {
  test('fresh, recalled, confident memory scores near zero', () => {
    const score = computeSuspectScore(makeLearning(), NOW);
    // 1 day old: age contribution is (1/365) * 0.2 ~= 0.0005, rounded to 0.001
    expect(score).toBeLessThan(0.01);
  });

  test('anti-patterns add 0.3 on top', () => {
    const clean = computeSuspectScore(makeLearning(), NOW);
    const antiPattern = computeSuspectScore(makeLearning({ type: 'anti-pattern' }), NOW);
    expect(antiPattern).toBeGreaterThanOrEqual(clean + 0.3 - 0.001);
  });

  test('low confidence (< 0.3) adds 0.3', () => {
    const score = computeSuspectScore(makeLearning({ confidence: 0.1 }), NOW);
    expect(score).toBeGreaterThanOrEqual(0.3);
  });

  test('stale + never-recalled adds 0.2', () => {
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    const score = computeSuspectScore(
      makeLearning({ createdAt: tenDaysAgo, recallCount: 0 }),
      NOW,
    );
    // 10 days age: (10/365)*0.2 ~= 0.0055 + stale_unrecalled 0.2 = ~0.206
    expect(score).toBeGreaterThan(0.2);
    expect(score).toBeLessThan(0.21);
  });

  test('stale but recalled skips the stale-unrecalled penalty', () => {
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    const score = computeSuspectScore(
      makeLearning({ createdAt: tenDaysAgo, recallCount: 5 }),
      NOW,
    );
    expect(score).toBeLessThan(0.01);
  });

  test('recent (< 7d) + unrecalled also skips the penalty', () => {
    const score = computeSuspectScore(
      makeLearning({ recallCount: 0 }), // 1 day old
      NOW,
    );
    expect(score).toBeLessThan(0.01);
  });

  test('supersedes chain adds 0.1', () => {
    const score = computeSuspectScore(makeLearning({ supersedes: 'mem-0' }), NOW);
    expect(score).toBeGreaterThanOrEqual(0.1);
    expect(score).toBeLessThan(0.11);
  });

  test('compounding signals clamp at 1.0', () => {
    const oneYearAgo = new Date(NOW - 365 * 24 * 60 * 60 * 1000).toISOString();
    const score = computeSuspectScore(
      makeLearning({
        createdAt: oneYearAgo, // +0.2 age
        recallCount: 0,        // +0.2 stale_unrecalled
        type: 'anti-pattern',  // +0.3
        confidence: 0.05,      // +0.3 low_confidence
        supersedes: 'mem-0',   // +0.1
      }),
      NOW,
    );
    // raw sum = 1.1, clamped to 1.0
    expect(score).toBe(1);
  });

  test('returns zero when createdAt is unparseable', () => {
    const score = computeSuspectScore(
      makeLearning({ createdAt: 'not-a-date', confidence: 0.8, recallCount: 5 }),
      NOW,
    );
    // No other penalties fire; age contribution is 0 because parseable fails.
    expect(score).toBe(0);
  });

  test('rounds to 3 decimal places', () => {
    const tenDaysAgo = new Date(NOW - 10 * 24 * 60 * 60 * 1000).toISOString();
    const score = computeSuspectScore(
      makeLearning({ createdAt: tenDaysAgo, recallCount: 0 }),
      NOW,
    );
    const decimals = score.toString().split('.')[1] ?? '';
    expect(decimals.length).toBeLessThanOrEqual(3);
  });
});
