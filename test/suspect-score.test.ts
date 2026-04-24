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
const DAY = 24 * 60 * 60 * 1000;

describe('computeSuspectScore', () => {
  test('fresh, recalled, confident memory scores near zero', () => {
    const score = computeSuspectScore(makeLearning(), NOW);
    // 1 day effective age: (1/365) * 0.2 ~= 0.0005, rounded to 0.001
    expect(score).toBeLessThan(0.01);
  });

  test('confirmed (high-confidence) anti-patterns barely penalise', () => {
    // The weight scales by (1 - confidence). At confidence 0.9 the
    // anti-pattern contribution is 0.1 * 0.3 = 0.03.
    const clean = computeSuspectScore(makeLearning({ confidence: 0.9 }), NOW);
    const antiPattern = computeSuspectScore(
      makeLearning({ confidence: 0.9, type: 'anti-pattern' }),
      NOW,
    );
    expect(antiPattern - clean).toBeLessThan(0.05);
  });

  test('low-confidence anti-patterns accumulate both signals', () => {
    // confidence 0.1 → anti-pattern adds 0.9 * 0.3 = 0.27,
    // low_confidence ramp adds 0.833... * 0.5 ≈ 0.417.
    const score = computeSuspectScore(
      makeLearning({ confidence: 0.1, type: 'anti-pattern' }),
      NOW,
    );
    expect(score).toBeGreaterThan(0.65);
  });

  test('very low confidence (0.1) engages the low-confidence ramp fully', () => {
    // (0.6 - 0.1) / 0.6 = 0.833..., * 0.5 = ~0.417
    const score = computeSuspectScore(makeLearning({ confidence: 0.1 }), NOW);
    expect(score).toBeGreaterThanOrEqual(0.4);
    expect(score).toBeLessThan(0.43);
  });

  test('confidence at the old 0.3 cliff still contributes (continuous ramp, no cliff)', () => {
    // (0.6 - 0.3) / 0.6 = 0.5, * 0.5 = 0.25
    const score = computeSuspectScore(makeLearning({ confidence: 0.3 }), NOW);
    expect(score).toBeGreaterThan(0.24);
    expect(score).toBeLessThan(0.26);
  });

  test('confidence at 0.6 or above no longer contributes', () => {
    const at = computeSuspectScore(makeLearning({ confidence: 0.6 }), NOW);
    const above = computeSuspectScore(makeLearning({ confidence: 0.9 }), NOW);
    // Only age contribution remains (tiny), supersedes removed.
    expect(at).toBeLessThan(0.01);
    expect(above).toBeLessThan(0.01);
  });

  test('stale + never-recalled engages the cold-ramp', () => {
    const thirtyDaysAgo = new Date(NOW - 30 * DAY).toISOString();
    const score = computeSuspectScore(
      makeLearning({ createdAt: thirtyDaysAgo, confidence: 0.8, recallCount: 0 }),
      NOW,
    );
    // 30d effective age: age (30/365)*0.2 = 0.016, stale full (cap at 30d)
    // coldness 1/1=1, stale_cold 1*1*0.3 = 0.3. Total ~0.316.
    expect(score).toBeGreaterThan(0.3);
    expect(score).toBeLessThan(0.35);
  });

  test('heavily-recalled old memory does not look stale', () => {
    const thirtyDaysAgo = new Date(NOW - 30 * DAY).toISOString();
    const score = computeSuspectScore(
      makeLearning({
        createdAt: thirtyDaysAgo,
        recallCount: 20,
        lastRecalledAt: new Date(NOW - 0.5 * DAY).toISOString(),
        confidence: 0.8,
      }),
      NOW,
    );
    // Effective age = 0.5d (from lastRecalledAt), well below stale ramp start.
    expect(score).toBeLessThan(0.01);
  });

  test('lastRecalledAt overrides createdAt for age and stale signals', () => {
    // 300d old, but touched yesterday — should look healthy.
    const ancientCreatedAt = new Date(NOW - 300 * DAY).toISOString();
    const recentRecall = new Date(NOW - 1 * DAY).toISOString();
    const score = computeSuspectScore(
      makeLearning({
        createdAt: ancientCreatedAt,
        lastRecalledAt: recentRecall,
        recallCount: 10,
        confidence: 0.8,
      }),
      NOW,
    );
    expect(score).toBeLessThan(0.01);
  });

  test('supersedes no longer penalises (directional fix)', () => {
    // The newer chain-head is the winning, corrected memory.
    const score = computeSuspectScore(makeLearning({ supersedes: 'mem-0' }), NOW);
    expect(score).toBeLessThan(0.01);
  });

  test('compounding signals clamp at 1.0', () => {
    const oneYearAgo = new Date(NOW - 365 * DAY).toISOString();
    const score = computeSuspectScore(
      makeLearning({
        createdAt: oneYearAgo,
        recallCount: 0,
        type: 'anti-pattern',
        confidence: 0.05,
      }),
      NOW,
    );
    // age 0.2 + stale_cold 0.3 + anti-pattern 0.95*0.3 ≈ 0.285 +
    // low_conf 0.917*0.5 ≈ 0.458 → sum > 1, clamped to 1.0.
    expect(score).toBe(1);
  });

  test('returns zero when createdAt is unparseable and no other signals fire', () => {
    const score = computeSuspectScore(
      makeLearning({ createdAt: 'not-a-date', confidence: 0.8, recallCount: 5 }),
      NOW,
    );
    expect(score).toBe(0);
  });

  test('rounds to 3 decimal places', () => {
    const tenDaysAgo = new Date(NOW - 10 * DAY).toISOString();
    const score = computeSuspectScore(
      makeLearning({ createdAt: tenDaysAgo, recallCount: 0 }),
      NOW,
    );
    const decimals = score.toString().split('.')[1] ?? '';
    expect(decimals.length).toBeLessThanOrEqual(3);
  });

  test('stale signal uses a continuous ramp rather than a hard 7d cliff', () => {
    // 8 days: ramp = (8-7)/(30-7) ≈ 0.043, stale_cold 0.043*1*0.3 ≈ 0.013.
    const eightDaysAgo = new Date(NOW - 8 * DAY).toISOString();
    const score = computeSuspectScore(
      makeLearning({ createdAt: eightDaysAgo, recallCount: 0, confidence: 0.8 }),
      NOW,
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(0.05);
  });
});
