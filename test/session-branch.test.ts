import {
  blessSessionBranch,
  deriveBranchStatus,
  discardSessionBranch,
  ensureSessionBranch,
  gcExpiredSessionBranches,
  getBranchStatus,
  getSessionBranch,
  listBranches,
  normalizeSessionId,
  scopeToSessionId,
  sessionIdToScope,
  SESSION_BRANCH_DEFAULT_TTL_MS,
} from '../src/do/sessionBranch';
import type { SessionBranch } from '../src/do/types';

// --------------------------------------------------------------------------
// Pure helpers — no DB. Covers the string/status primitives that sit under
// every bless/discard/GC call.
// --------------------------------------------------------------------------

describe('session-branch pure helpers', () => {
  it('sessionIdToScope + scopeToSessionId roundtrip', () => {
    expect(sessionIdToScope('abc')).toBe('session:abc');
    expect(scopeToSessionId('session:abc')).toBe('abc');
    expect(scopeToSessionId('shared')).toBeNull();
    expect(scopeToSessionId('agent:1')).toBeNull();
  });

  it('normalizeSessionId accepts bare and prefixed form, rejects empties', () => {
    expect(normalizeSessionId('abc')).toBe('abc');
    expect(normalizeSessionId('session:abc')).toBe('abc');
    expect(normalizeSessionId('  session:abc  ')).toBe('abc');
    expect(normalizeSessionId('')).toBeNull();
    expect(normalizeSessionId('session:')).toBeNull();
    expect(normalizeSessionId(null)).toBeNull();
    expect(normalizeSessionId(undefined)).toBeNull();
  });

  it('deriveBranchStatus: open when not blessed, discarded, or expired', () => {
    const now = Date.parse('2026-04-23T12:00:00Z');
    const base: SessionBranch = {
      sessionId: 's',
      createdAt: '2026-04-23T00:00:00Z',
      expiresAt: '2026-04-24T00:00:00Z',
      blessedAt: null,
      discardedAt: null,
    };
    expect(deriveBranchStatus(base, now)).toBe('open');
  });

  it('deriveBranchStatus: blessed takes precedence over open', () => {
    const now = Date.parse('2026-04-23T12:00:00Z');
    const branch: SessionBranch = {
      sessionId: 's',
      createdAt: '2026-04-23T00:00:00Z',
      expiresAt: '2026-04-24T00:00:00Z',
      blessedAt: '2026-04-23T06:00:00Z',
      discardedAt: null,
    };
    expect(deriveBranchStatus(branch, now)).toBe('blessed');
  });

  it('deriveBranchStatus: discarded wins over blessed (defensive)', () => {
    const now = Date.parse('2026-04-23T12:00:00Z');
    const branch: SessionBranch = {
      sessionId: 's',
      createdAt: '2026-04-23T00:00:00Z',
      expiresAt: '2026-04-24T00:00:00Z',
      blessedAt: '2026-04-23T06:00:00Z',
      discardedAt: '2026-04-23T06:30:00Z',
    };
    expect(deriveBranchStatus(branch, now)).toBe('discarded');
  });

  it('deriveBranchStatus: expired when past expiresAt and not blessed/discarded', () => {
    const now = Date.parse('2026-04-23T12:00:00Z');
    const branch: SessionBranch = {
      sessionId: 's',
      createdAt: '2026-04-22T00:00:00Z',
      expiresAt: '2026-04-22T23:59:59Z',
      blessedAt: null,
      discardedAt: null,
    };
    expect(deriveBranchStatus(branch, now)).toBe('expired');
  });

  it('deriveBranchStatus: blessed branches never expire', () => {
    const now = Date.parse('2026-04-23T12:00:00Z');
    const branch: SessionBranch = {
      sessionId: 's',
      // Expired long ago in the calendar, but blessed cancels expiry.
      createdAt: '2025-01-01T00:00:00Z',
      expiresAt: '2025-01-02T00:00:00Z',
      blessedAt: '2025-01-01T12:00:00Z',
      discardedAt: null,
    };
    expect(deriveBranchStatus(branch, now)).toBe('blessed');
  });

  it('SESSION_BRANCH_DEFAULT_TTL_MS is 24h', () => {
    expect(SESSION_BRANCH_DEFAULT_TTL_MS).toBe(24 * 60 * 60 * 1000);
  });
});

// --------------------------------------------------------------------------
// Integration-ish: exercise the branch functions against a tiny mock DB that
// returns canned rows by table/predicate intent. This is lower-fidelity than
// real SQLite but higher-fidelity than testing only the pure helpers.
//
// Pattern: each test constructs a db whose select/insert/update/delete
// stubs return exactly what the test expects at each call site. The mock
// does NOT interpret drizzle predicates — so the test's canned responses
// must match the real function's call order.
// --------------------------------------------------------------------------

interface DbCallLog {
  selects: Array<{ table: string }>;
  inserts: Array<{ table: string; values: any; conflict: 'none' | 'nothing' | 'update' }>;
  updates: Array<{ table: string; patch: any }>;
  deletes: Array<{ table: string }>;
}

function buildDb(responses: {
  selectQueue: any[][]; // one row-set per select call, in order
  tableForEachSelect?: string[]; // 'branches' or 'learnings' per call
}) {
  const log: DbCallLog = { selects: [], inserts: [], updates: [], deletes: [] };
  let selectIdx = 0;

  function pickNextRows(): any[] {
    const rows = responses.selectQueue[selectIdx] ?? [];
    selectIdx += 1;
    return rows;
  }

  function tableName(table: any): string {
    // drizzle table's symbol-based name; fall back to string tag.
    // The table object has a Symbol(drizzle:Name) property.
    const sym = Object.getOwnPropertySymbols(table ?? {})
      .map((s) => ({ s, desc: s.toString() }))
      .find(({ desc }) => desc.includes('Name'));
    if (sym) return String((table as any)[sym.s] ?? '');
    return '';
  }

  const db = {
    select: (_projection?: any) => ({
      from: (table: any) => {
        const name = tableName(table);
        log.selects.push({ table: name });
        const rows = pickNextRows();
        const promise = Promise.resolve(rows);
        const thenable = {
          where: (_p: any) => ({
            limit: (_n: number) => Promise.resolve(rows),
            groupBy: (_col: any) => Promise.resolve(rows),
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
            finally: promise.finally.bind(promise),
          }),
          limit: (_n: number) => Promise.resolve(rows),
          groupBy: (_col: any) => Promise.resolve(rows),
          then: promise.then.bind(promise),
          catch: promise.catch.bind(promise),
          finally: promise.finally.bind(promise),
        };
        return thenable;
      },
    }),
    insert: (table: any) => ({
      values: (values: any) => {
        const record = { table: tableName(table), values, conflict: 'none' as const };
        const push = () => {
          log.inserts.push(record);
          return Promise.resolve();
        };
        return {
          onConflictDoNothing: () => {
            (record as any).conflict = 'nothing';
            return push();
          },
          onConflictDoUpdate: (_opts: any) => {
            (record as any).conflict = 'update';
            return push();
          },
          then: (resolve: any, reject?: any) => push().then(resolve, reject),
        };
      },
    }),
    update: (table: any) => ({
      set: (patch: any) => ({
        where: (_p: any) => {
          log.updates.push({ table: tableName(table), patch });
          return Promise.resolve();
        },
      }),
    }),
    delete: (table: any) => ({
      where: (_p: any) => {
        log.deletes.push({ table: tableName(table) });
        return Promise.resolve();
      },
    }),
  };

  return { db, log };
}

// --------------------------------------------------------------------------
// getSessionBranch + ensureSessionBranch
// --------------------------------------------------------------------------

describe('getSessionBranch', () => {
  it('returns null when no row exists', async () => {
    const { db } = buildDb({ selectQueue: [[]] });
    const result = await getSessionBranch({ initDB: () => Promise.resolve(db) }, 'sess-1');
    expect(result).toBeNull();
  });

  it('returns the row when one exists', async () => {
    const existingRow = {
      sessionId: 'sess-1',
      createdAt: '2026-04-20T00:00:00Z',
      expiresAt: '2026-04-21T00:00:00Z',
      blessedAt: null,
      discardedAt: null,
    };
    const { db } = buildDb({ selectQueue: [[existingRow]] });
    const result = await getSessionBranch({ initDB: () => Promise.resolve(db) }, 'sess-1');
    expect(result).toEqual({
      sessionId: 'sess-1',
      createdAt: '2026-04-20T00:00:00Z',
      expiresAt: '2026-04-21T00:00:00Z',
      blessedAt: null,
      discardedAt: null,
    });
  });
});

describe('ensureSessionBranch', () => {
  it('returns existing branch without inserting', async () => {
    const existingRow = {
      sessionId: 'sess-2',
      createdAt: '2026-04-20T00:00:00Z',
      expiresAt: '2026-04-21T00:00:00Z',
      blessedAt: null,
      discardedAt: null,
    };
    const { db, log } = buildDb({ selectQueue: [[existingRow]] });
    const branch = await ensureSessionBranch({ initDB: () => Promise.resolve(db) }, 'sess-2');
    expect(branch.sessionId).toBe('sess-2');
    expect(log.inserts).toHaveLength(0);
  });

  it('inserts a new branch when none exists, then re-reads it', async () => {
    const { db, log } = buildDb({
      // 1st select: getSessionBranch → no row. Then insert happens. Then
      // getSessionBranch re-reads and finds the new row.
      selectQueue: [[], [{
        sessionId: 'sess-3',
        createdAt: '2026-04-23T00:00:00Z',
        expiresAt: '2026-04-24T00:00:00Z',
        blessedAt: null,
        discardedAt: null,
      }]],
    });
    const branch = await ensureSessionBranch(
      { initDB: () => Promise.resolve(db) },
      'sess-3',
      1000, // ttl 1s
      Date.parse('2026-04-23T00:00:00Z'),
    );
    expect(branch.sessionId).toBe('sess-3');
    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0].conflict).toBe('nothing');
    expect(log.inserts[0].values.sessionId).toBe('sess-3');
  });
});

// --------------------------------------------------------------------------
// bless / discard
// --------------------------------------------------------------------------

describe('blessSessionBranch', () => {
  it('promotes all session-state learnings when no learning_ids passed', async () => {
    const { db, log } = buildDb({
      selectQueue: [
        [{ id: 'mem-1' }, { id: 'mem-2' }, { id: 'mem-3' }], // candidates select
      ],
    });
    const result = await blessSessionBranch(
      { initDB: () => Promise.resolve(db) },
      'sess-4',
    );
    expect(result.sessionId).toBe('sess-4');
    expect(result.promotedCount).toBe(3);
    expect(result.promotedIds).toEqual(['mem-1', 'mem-2', 'mem-3']);
    // One update to flip branch_state, one upsert on session_branches.
    expect(log.updates).toHaveLength(1);
    expect(log.updates[0].patch).toEqual({ branchState: 'blessed' });
    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0].conflict).toBe('update');
  });

  it('honors an explicit learning_ids subset', async () => {
    const { db, log } = buildDb({
      selectQueue: [
        [{ id: 'mem-5' }], // only mem-5 matches the id filter
      ],
    });
    const result = await blessSessionBranch(
      { initDB: () => Promise.resolve(db) },
      'sess-5',
      { learningIds: ['mem-5', 'mem-ghost'] },
    );
    expect(result.promotedCount).toBe(1);
    expect(result.promotedIds).toEqual(['mem-5']);
    expect(log.updates).toHaveLength(1);
  });

  it('blessing an empty branch still records bless timestamp (zero rows updated)', async () => {
    const { db, log } = buildDb({
      selectQueue: [[]], // no candidates
    });
    const result = await blessSessionBranch(
      { initDB: () => Promise.resolve(db) },
      'sess-empty',
    );
    expect(result.promotedCount).toBe(0);
    expect(result.promotedIds).toEqual([]);
    // No learnings update (none to patch), but branch row always upserted.
    expect(log.updates).toHaveLength(0);
    expect(log.inserts).toHaveLength(1);
    expect(result.blessedAt).toBeTruthy();
  });
});

describe('discardSessionBranch', () => {
  it('deletes all session-state learnings and marks the branch discarded', async () => {
    const { db, log } = buildDb({
      selectQueue: [
        [{ id: 'mem-10' }, { id: 'mem-11' }], // candidates to delete
      ],
    });
    const result = await discardSessionBranch(
      { initDB: () => Promise.resolve(db) },
      'sess-6',
    );
    expect(result.sessionId).toBe('sess-6');
    expect(result.deletedCount).toBe(2);
    expect(result.deletedIds).toEqual(['mem-10', 'mem-11']);
    expect(log.deletes).toHaveLength(1);
    expect(log.inserts).toHaveLength(1);
    expect(log.inserts[0].conflict).toBe('update');
    expect(result.discardedAt).toBeTruthy();
  });

  it('discarding an empty branch still records the discard timestamp', async () => {
    const { db, log } = buildDb({ selectQueue: [[]] });
    const result = await discardSessionBranch(
      { initDB: () => Promise.resolve(db) },
      'sess-empty',
    );
    expect(result.deletedCount).toBe(0);
    expect(log.deletes).toHaveLength(0);
    expect(log.inserts).toHaveLength(1);
  });
});

// --------------------------------------------------------------------------
// branch_status + list_branches
// --------------------------------------------------------------------------

describe('getBranchStatus', () => {
  it('returns null for unknown session', async () => {
    const { db } = buildDb({ selectQueue: [[]] });
    const result = await getBranchStatus(
      { initDB: () => Promise.resolve(db) },
      'sess-ghost',
    );
    expect(result).toBeNull();
  });

  it('returns status + rollup counts for a known session', async () => {
    const branchRow = {
      sessionId: 'sess-7',
      createdAt: '2026-04-22T00:00:00Z',
      expiresAt: '2026-04-23T00:00:00Z',
      blessedAt: null,
      discardedAt: null,
    };
    const { db } = buildDb({
      selectQueue: [
        [branchRow], // getSessionBranch
        [{ state: 'session', n: 4 }, { state: 'blessed', n: 1 }], // counts
      ],
    });
    const result = await getBranchStatus(
      { initDB: () => Promise.resolve(db) },
      'sess-7',
      Date.parse('2026-04-22T12:00:00Z'),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe('open');
    expect(result!.sessionCount).toBe(4);
    expect(result!.blessedCount).toBe(1);
  });
});

describe('listBranches', () => {
  it('returns branches sorted newest-first with counts', async () => {
    const older = {
      sessionId: 'sess-older',
      createdAt: '2026-04-20T00:00:00Z',
      expiresAt: '2026-04-21T00:00:00Z',
      blessedAt: null,
      discardedAt: null,
    };
    const newer = {
      sessionId: 'sess-newer',
      createdAt: '2026-04-22T00:00:00Z',
      expiresAt: '2026-04-23T00:00:00Z',
      blessedAt: null,
      discardedAt: null,
    };
    const { db } = buildDb({
      selectQueue: [
        [older, newer], // listBranches
        [{ state: 'session', n: 1 }], // count for sess-older
        [{ state: 'blessed', n: 2 }], // count for sess-newer
      ],
    });
    const result = await listBranches(
      { initDB: () => Promise.resolve(db) },
      Date.parse('2026-04-22T12:00:00Z'),
    );
    expect(result).toHaveLength(2);
    expect(result[0].sessionId).toBe('sess-newer');
    expect(result[1].sessionId).toBe('sess-older');
  });
});

// --------------------------------------------------------------------------
// gcExpiredSessionBranches — core of session-TTL enforcement
// --------------------------------------------------------------------------

describe('gcExpiredSessionBranches', () => {
  it('returns zero counts when no expired branches exist', async () => {
    const { db, log } = buildDb({ selectQueue: [[]] });
    const result = await gcExpiredSessionBranches(
      { initDB: () => Promise.resolve(db) },
      Date.parse('2026-04-23T00:00:00Z'),
    );
    expect(result.expiredBranches).toBe(0);
    expect(result.deletedLearnings).toBe(0);
    expect(log.deletes).toHaveLength(0);
  });

  it('deletes session-state learnings for expired (unblessed, undiscarded) branches', async () => {
    const { db, log } = buildDb({
      selectQueue: [
        [{ sessionId: 'sess-exp-1' }, { sessionId: 'sess-exp-2' }], // expired branches
        [{ id: 'mem-a' }, { id: 'mem-b' }, { id: 'mem-c' }], // to delete
      ],
    });
    const result = await gcExpiredSessionBranches(
      { initDB: () => Promise.resolve(db) },
      Date.parse('2026-04-23T00:00:00Z'),
    );
    expect(result.expiredBranches).toBe(2);
    expect(result.deletedLearnings).toBe(3);
    expect(result.deletedIds).toEqual(['mem-a', 'mem-b', 'mem-c']);
    expect(log.deletes).toHaveLength(1);
  });

  it('does nothing when expired branches exist but own no session-state rows', async () => {
    const { db, log } = buildDb({
      selectQueue: [
        [{ sessionId: 'sess-exp' }], // expired branch
        [], // but no learnings with branch_state = 'session'
      ],
    });
    const result = await gcExpiredSessionBranches(
      { initDB: () => Promise.resolve(db) },
      Date.parse('2026-04-23T00:00:00Z'),
    );
    expect(result.expiredBranches).toBe(1);
    expect(result.deletedLearnings).toBe(0);
    expect(log.deletes).toHaveLength(0);
  });
});
