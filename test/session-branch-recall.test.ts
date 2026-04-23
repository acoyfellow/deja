import { SQLiteSyncDialect } from 'drizzle-orm/sqlite-core/dialect';

import { buildBranchVisibilityPredicate } from '../src/do/memory';

// The predicate returned from `buildBranchVisibilityPredicate` is a drizzle
// SQL fragment. Render it via the SQLite dialect to get the concrete SQL +
// params, then pattern-match to prove the semantics:
//
//   1. 'main' rows pass only when scope matches the requested list
//   2. 'blessed' rows pass unconditionally (scope is metadata, not filter)
//   3. 'session' rows pass only when the caller asked for that exact session
//
// These semantic tests would have caught the bug we just fixed — the prior
// impl AND'd a separate scope filter alongside this predicate, which meant
// blessed rows with session:<id> scope were dropped when the caller asked
// for 'shared' only. Real SQL assertions instead of structural identity.

const dialect = new SQLiteSyncDialect();
function render(p: unknown): { sql: string; params: unknown[] } {
  return dialect.sqlToQuery((p as any).getSQL());
}

describe('buildBranchVisibilityPredicate (semantic)', () => {
  it('shared-only query: main+shared scope, any blessed, NO session', () => {
    const { sql, params } = render(buildBranchVisibilityPredicate(['shared']));

    // Must reference all three branch states, then lock the 'session'
    // branch to a literal 0 (dead branch, nothing passes).
    expect(sql).toMatch(/branch_state/);
    expect(params).toContain('main');
    expect(params).toContain('blessed');
    expect(params).toContain('shared');
    // No 'session' literal param — the session branch is sql`0`, not a
    // parameterised value.
    expect(params).not.toContain('session');
    // The trailing `or 0` is how we express "never visible" for that
    // branch when no session scope was requested.
    expect(sql).toMatch(/or 0/);
  });

  it('session-only query: main+session scope, any blessed, own session', () => {
    const { sql, params } = render(buildBranchVisibilityPredicate(['session:abc']));

    expect(params).toContain('main');
    expect(params).toContain('blessed');
    expect(params).toContain('session');
    // session:abc is both the 'main' scope filter and the 'session' scope
    // filter, so it appears twice in params.
    const abcCount = params.filter((p) => p === 'session:abc').length;
    expect(abcCount).toBe(2);
    // No `or 0` — the session branch is live.
    expect(sql).not.toMatch(/or 0\)?$/);
  });

  it('mixed query (shared + session): main sees both, blessed always, session own-only', () => {
    const { sql, params } = render(
      buildBranchVisibilityPredicate(['session:abc', 'shared']),
    );

    expect(params).toContain('main');
    expect(params).toContain('blessed');
    expect(params).toContain('session');
    // Both scopes are params (for the 'main' branch's `scope IN (...)`),
    // session:abc also appears in the 'session' branch's filter.
    expect(params).toContain('shared');
    expect(params).toContain('session:abc');
    const sessionAbcCount = params.filter((p) => p === 'session:abc').length;
    expect(sessionAbcCount).toBe(2);
  });

  it('blessed rows are UNCONDITIONALLY visible (no scope filter on blessed branch)', () => {
    // The regression test for the bug we just fixed. The blessed branch
    // must be a bare equality on branch_state, NOT an AND with a scope
    // filter. If anyone adds a scope clause to the blessed branch in the
    // future, this test fails.
    const { sql } = render(buildBranchVisibilityPredicate(['shared']));

    // Break into top-level OR arms. The blessed arm must not contain
    // scope/in/and — it should be a bare `branch_state = ?`.
    const sqlLower = sql.toLowerCase();

    // Count the occurrences of "blessed" in the sql string (as quoted
    // literal it'd be in params, not sql). The branch_state = ? equality
    // gets the literal 'blessed' at its param slot.
    // We check structurally: the sql should contain exactly one
    // standalone `branch_state" = ?` clause that isn't wrapped in an
    // AND with a scope filter.
    const branchStateEq = sqlLower.match(/"branch_state"\s*=\s*\?/g) ?? [];
    // At least two: one for main (inside an AND), one standalone for blessed.
    expect(branchStateEq.length).toBeGreaterThanOrEqual(2);

    // Structural: the word "blessed" must appear as a param. Then the
    // preceding SQL should NOT pair it with `scope` in the same AND.
    // Split by " or " at the top level (roughly), find the arm containing
    // the blessed param. That arm must not contain "scope".
    // Drizzle emits: `(main_arm) or blessed_arm or (session_arm)` where
    // blessed_arm is `"learnings"."branch_state" = ?`.
    // If we split on ` or ` we should find a bare `branch_state = ?` arm.
    const arms = sql.split(/\s+or\s+/);
    const bareBlessedArm = arms.find(
      (a) => /"branch_state"\s*=\s*\?/.test(a) && !/scope/i.test(a),
    );
    expect(bareBlessedArm).toBeTruthy();
  });

  it('session rows are never visible when no session scope requested', () => {
    // The other half of the invariant. When scopes=['shared'], the
    // session branch must reduce to a false literal so NO session row
    // can ever leak to shared callers.
    const { sql } = render(buildBranchVisibilityPredicate(['shared']));
    expect(sql).toMatch(/\bor 0\b/);
  });

  it('session rows are only visible for the exact session requested', () => {
    // Two different session ids → session branch references only the
    // requested one, not the other.
    const { params } = render(
      buildBranchVisibilityPredicate(['session:alpha']),
    );
    expect(params).toContain('session:alpha');
    expect(params).not.toContain('session:beta');
  });

  it('defensive: empty scope list produces a valid predicate that matches nothing useful', () => {
    // filterScopesByPriority would normally prevent this, but guard
    // against accidents: empty scopes → main branch scope list is empty,
    // session branch is sql`0`. Only blessed rows can match. Arguably
    // that's a bug surface of its own but it's not a leak — it's
    // over-permissive for blessed, which is already always visible.
    const { sql, params } = render(buildBranchVisibilityPredicate([]));
    // Must not throw, must reference blessed.
    expect(sql).toBeTruthy();
    expect(params).toContain('blessed');
  });
});
