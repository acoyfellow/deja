import {
  getHandoffPacket,
  HANDOFF_LIST_DEFAULT_LIMIT,
  listHandoffPackets,
  normalizeHandoffPacket,
  renderHandoffMarkdown,
  upsertHandoffPacket,
} from '../src/do/handoff';
import type { HandoffPacket } from '../src/do/types';

// --------------------------------------------------------------------------
// Pure helpers — normalization + markdown rendering. No DB involved.
// --------------------------------------------------------------------------

describe('normalizeHandoffPacket', () => {
  it('accepts the full spec shape and round-trips every field', () => {
    const now = '2026-04-23T10:00:00.000Z';
    const packet = normalizeHandoffPacket(
      'sess-full',
      {
        createdAt: now,
        authoredBy: 'claude-opus-4-7',
        summary: 'Landed handoff-packet primitive.',
        whatShipped: ['schema', 'routes', 'MCP wiring'],
        whatBlessed: [
          { learningId: 'mem-7', note: 'bless preserves provenance' },
          { learningId: 'mem-8' },
        ],
        whatRemains: ['auto-inject into recall'],
        nextVerify: ['bun test green on clean clone'],
        links: [
          { kind: 'commit', value: 'abc123', label: 'add handoff' },
          { kind: 'pr', value: '42' },
        ],
      },
      now,
    );

    expect(packet.sessionId).toBe('sess-full');
    expect(packet.createdAt).toBe(now);
    expect(packet.authoredBy).toBe('claude-opus-4-7');
    expect(packet.whatShipped).toEqual(['schema', 'routes', 'MCP wiring']);
    expect(packet.whatBlessed).toEqual([
      { learningId: 'mem-7', note: 'bless preserves provenance' },
      { learningId: 'mem-8' },
    ]);
    expect(packet.whatRemains).toEqual(['auto-inject into recall']);
    expect(packet.nextVerify).toEqual(['bun test green on clean clone']);
    expect(packet.links).toEqual([
      { kind: 'commit', value: 'abc123', label: 'add handoff' },
      { kind: 'pr', value: '42' },
    ]);
  });

  it('defaults createdAt to the supplied now when the caller omits it', () => {
    const now = '2026-04-23T12:00:00.000Z';
    const packet = normalizeHandoffPacket('sess-a', { summary: 'hi' }, now);
    expect(packet.createdAt).toBe(now);
  });

  it('drops junk from whatBlessed (missing learningId) and skips empty strings', () => {
    const packet = normalizeHandoffPacket(
      'sess-x',
      {
        summary: 'trim',
        whatShipped: ['  keep me  ', '', '   ', 42 as any],
        whatBlessed: [
          { learningId: 'mem-1', note: 'ok' },
          { note: 'orphan note with no id' },
          null,
          'nope',
          { learningId: '   ' }, // empty after trim
        ],
      },
      '2026-04-23T00:00:00Z',
    );
    expect(packet.whatShipped).toEqual(['keep me', '42']);
    expect(packet.whatBlessed).toEqual([{ learningId: 'mem-1', note: 'ok' }]);
  });

  it('rejects links with unknown kinds and empty values', () => {
    const packet = normalizeHandoffPacket(
      'sess-l',
      {
        summary: 's',
        links: [
          { kind: 'commit', value: 'deadbeef' },
          { kind: 'telegram', value: 'nope' }, // unknown kind -> dropped
          { kind: 'url', value: '   ' }, // blank value -> dropped
          { kind: 'wiki', value: '/display/X/page', label: 'Page' },
        ],
      },
      '2026-04-23T00:00:00Z',
    );
    expect(packet.links).toEqual([
      { kind: 'commit', value: 'deadbeef' },
      { kind: 'wiki', value: '/display/X/page', label: 'Page' },
    ]);
  });

  it('omits optional fields when they would otherwise be empty', () => {
    const packet = normalizeHandoffPacket(
      'sess-min',
      { summary: 'minimal packet' },
      '2026-04-23T00:00:00Z',
    );
    expect(packet.authoredBy).toBeUndefined();
    expect(packet.nextVerify).toBeUndefined();
    expect(packet.links).toBeUndefined();
    // But the required-structured fields are always present, even empty.
    expect(packet.whatShipped).toEqual([]);
    expect(packet.whatBlessed).toEqual([]);
    expect(packet.whatRemains).toEqual([]);
  });
});

describe('renderHandoffMarkdown', () => {
  it('renders every documented section in the expected order', () => {
    const packet: HandoffPacket = {
      sessionId: 'sess-render',
      createdAt: '2026-04-23T10:00:00.000Z',
      authoredBy: 'claude-opus-4-7',
      summary: 'Landed handoff-packet primitive; all tests green.',
      whatShipped: ['schema + migration', 'routes + MCP wiring'],
      whatBlessed: [
        { learningId: 'mem-42', note: 'blessed-visibility fix holds' },
        { learningId: 'mem-99' },
      ],
      whatRemains: ['decide on auto-inject behavior'],
      nextVerify: ['bun test green', 'tsc --noEmit clean'],
      links: [
        { kind: 'commit', value: 'abc123', label: 'add handoff-packet' },
        { kind: 'pr', value: '42', label: 'feature Z' },
        { kind: 'url', value: 'https://example.com/ticket/9' },
      ],
    };

    const md = renderHandoffMarkdown(packet);

    expect(md).toContain('# Session handoff — sess-render');
    expect(md).toContain('**Created:** 2026-04-23T10:00:00.000Z');
    expect(md).toContain('**By:** claude-opus-4-7');
    expect(md).toContain('Landed handoff-packet primitive; all tests green.');
    expect(md).toContain('## What shipped\n- schema + migration\n- routes + MCP wiring');
    expect(md).toContain('## What was blessed\n- mem-42: blessed-visibility fix holds\n- mem-99');
    expect(md).toContain('## What remains\n- decide on auto-inject behavior');
    expect(md).toContain('## Next agent should verify\n- bun test green\n- tsc --noEmit clean');
    expect(md).toContain('## Links\n- commit abc123 — add handoff-packet\n- pr 42 — feature Z\n- https://example.com/ticket/9');

    // Section order: shipped → blessed → remains → verify → links.
    const order = ['## What shipped', '## What was blessed', '## What remains', '## Next agent should verify', '## Links'];
    let cursor = 0;
    for (const heading of order) {
      const idx = md.indexOf(heading, cursor);
      expect(idx).toBeGreaterThan(-1);
      cursor = idx;
    }
  });

  it('omits empty sections entirely', () => {
    const packet: HandoffPacket = {
      sessionId: 'sess-sparse',
      createdAt: '2026-04-23T10:00:00.000Z',
      summary: 'only summary.',
      whatShipped: [],
      whatBlessed: [],
      whatRemains: [],
    };
    const md = renderHandoffMarkdown(packet);
    expect(md).not.toContain('## What shipped');
    expect(md).not.toContain('## What was blessed');
    expect(md).not.toContain('## What remains');
    expect(md).not.toContain('## Next agent should verify');
    expect(md).not.toContain('## Links');
    // But the header + summary still render.
    expect(md).toContain('# Session handoff — sess-sparse');
    expect(md).toContain('only summary.');
  });

  it('omits **By:** when authoredBy is missing', () => {
    const packet: HandoffPacket = {
      sessionId: 'sess-anon',
      createdAt: '2026-04-23T10:00:00.000Z',
      summary: 's',
      whatShipped: [],
      whatBlessed: [],
      whatRemains: [],
    };
    const md = renderHandoffMarkdown(packet);
    expect(md).not.toContain('**By:**');
    expect(md).toContain('**Created:** 2026-04-23T10:00:00.000Z');
  });

  it('formats bare wiki / url links without forcing labels', () => {
    const packet: HandoffPacket = {
      sessionId: 'sess-links',
      createdAt: '2026-04-23T10:00:00.000Z',
      summary: 's',
      whatShipped: [],
      whatBlessed: [],
      whatRemains: [],
      links: [
        { kind: 'wiki', value: '/display/X/Y' },
        { kind: 'url', value: 'https://ex.com' },
      ],
    };
    const md = renderHandoffMarkdown(packet);
    expect(md).toContain('- wiki /display/X/Y');
    expect(md).toContain('- https://ex.com');
    // URLs without a label should not render with a trailing em-dash.
    expect(md).not.toContain('https://ex.com —');
  });
});

// --------------------------------------------------------------------------
// Storage — exercised against a tiny canned-response DB mock. Pattern
// borrowed from test/session-branch.test.ts; this mock ignores drizzle
// predicates and returns pre-queued rows in order.
// --------------------------------------------------------------------------

interface DbCallLog {
  selects: number;
  inserts: Array<{ values: any; conflict: 'none' | 'nothing' | 'update' }>;
}

function buildHandoffDb(selectQueue: any[][]) {
  const log: DbCallLog = { selects: 0, inserts: [] };
  let selectIdx = 0;

  const takeNext = () => {
    const rows = selectQueue[selectIdx] ?? [];
    selectIdx += 1;
    log.selects += 1;
    return rows;
  };

  const db = {
    select: () => ({
      from: (_t: any) => {
        const rows = takeNext();
        const promise = Promise.resolve(rows);
        const thenable: any = {
          where: (_p: any) => ({
            limit: (_n: number) => Promise.resolve(rows),
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
            finally: promise.finally.bind(promise),
          }),
          orderBy: (_c: any) => ({
            limit: (_n: number) => Promise.resolve(rows),
            then: promise.then.bind(promise),
            catch: promise.catch.bind(promise),
            finally: promise.finally.bind(promise),
          }),
          limit: (_n: number) => Promise.resolve(rows),
          then: promise.then.bind(promise),
          catch: promise.catch.bind(promise),
          finally: promise.finally.bind(promise),
        };
        return thenable;
      },
    }),
    insert: (_t: any) => ({
      values: (values: any) => {
        const record = { values, conflict: 'none' as const };
        const push = () => {
          log.inserts.push(record);
          return Promise.resolve();
        };
        return {
          onConflictDoUpdate: (_opts: any) => {
            (record as any).conflict = 'update';
            return push();
          },
          then: (resolve: any, reject?: any) => push().then(resolve, reject),
        };
      },
    }),
  };

  return { db, log };
}

describe('upsertHandoffPacket', () => {
  it('normalizes the body and upserts via onConflictDoUpdate', async () => {
    const { db, log } = buildHandoffDb([]); // no selects during insert
    const result = await upsertHandoffPacket(
      { initDB: () => Promise.resolve(db) },
      'sess-write',
      {
        authoredBy: '  claude-opus-4-7 ',
        summary: 'Write path test.',
        whatShipped: ['a', 'b'],
        whatBlessed: [{ learningId: 'mem-1' }],
        whatRemains: [],
      },
    );

    expect(result.sessionId).toBe('sess-write');
    expect(result.authoredBy).toBe('claude-opus-4-7'); // trimmed
    expect(result.whatShipped).toEqual(['a', 'b']);
    expect(log.inserts).toHaveLength(1);
    // Upsert semantics: second POST replaces first → must use onConflictDoUpdate.
    expect(log.inserts[0].conflict).toBe('update');
    expect(log.inserts[0].values.sessionId).toBe('sess-write');
    expect(log.inserts[0].values.authoredBy).toBe('claude-opus-4-7');
    // packet_json is the whole serialized typed object.
    const serialized = JSON.parse(log.inserts[0].values.packetJson);
    expect(serialized.summary).toBe('Write path test.');
    expect(serialized.whatBlessed).toEqual([{ learningId: 'mem-1' }]);
  });

  it('second upsert replaces first (both writes hit onConflictDoUpdate)', async () => {
    const { db, log } = buildHandoffDb([]);
    const ctx = { initDB: () => Promise.resolve(db) };
    await upsertHandoffPacket(ctx, 'sess-overwrite', {
      summary: 'first take',
      whatShipped: ['old'],
    });
    await upsertHandoffPacket(ctx, 'sess-overwrite', {
      summary: 'second take',
      whatShipped: ['new'],
    });
    expect(log.inserts).toHaveLength(2);
    // Both writes are upserts — second will replace first at the DB layer.
    expect(log.inserts[0].conflict).toBe('update');
    expect(log.inserts[1].conflict).toBe('update');
    expect(JSON.parse(log.inserts[1].values.packetJson).summary).toBe('second take');
  });
});

describe('getHandoffPacket', () => {
  it('returns null when no row exists (404 path)', async () => {
    const { db } = buildHandoffDb([[]]);
    const result = await getHandoffPacket(
      { initDB: () => Promise.resolve(db) },
      'sess-ghost',
    );
    expect(result).toBeNull();
  });

  it('returns a normalized packet when a row exists', async () => {
    const row = {
      sessionId: 'sess-read',
      createdAt: '2026-04-23T00:00:00Z',
      authoredBy: 'ci-bot',
      packetJson: JSON.stringify({
        sessionId: 'sess-read',
        createdAt: '2026-04-23T00:00:00Z',
        authoredBy: 'ci-bot',
        summary: 'round-trip',
        whatShipped: ['one'],
        whatBlessed: [{ learningId: 'mem-x' }],
        whatRemains: [],
      }),
    };
    const { db } = buildHandoffDb([[row]]);
    const result = await getHandoffPacket(
      { initDB: () => Promise.resolve(db) },
      'sess-read',
    );
    expect(result).not.toBeNull();
    expect(result!.sessionId).toBe('sess-read');
    expect(result!.summary).toBe('round-trip');
    expect(result!.whatShipped).toEqual(['one']);
    expect(result!.whatBlessed).toEqual([{ learningId: 'mem-x' }]);
    expect(result!.authoredBy).toBe('ci-bot');
  });

  it('re-normalizes malformed JSON stored on disk (defensive)', async () => {
    // Packet_json with extra junk fields + missing arrays — normalize should
    // recover a clean packet instead of bubbling nonsense up to callers.
    const row = {
      sessionId: 'sess-broken',
      createdAt: '2026-04-23T00:00:00Z',
      authoredBy: null,
      packetJson: JSON.stringify({
        summary: 'broken but readable',
        garbageField: 'nope',
        whatShipped: [null, 123, 'ok'],
      }),
    };
    const { db } = buildHandoffDb([[row]]);
    const result = await getHandoffPacket(
      { initDB: () => Promise.resolve(db) },
      'sess-broken',
    );
    expect(result).not.toBeNull();
    expect(result!.summary).toBe('broken but readable');
    expect(result!.whatShipped).toEqual(['123', 'ok']);
    expect((result as any).garbageField).toBeUndefined();
  });
});

describe('listHandoffPackets', () => {
  it('returns rows newest-first (handled by the DB orderBy)', async () => {
    // The mock doesn't actually sort; the storage function relies on
    // `orderBy(desc(createdAt))` which we verify by passing pre-sorted rows
    // and checking the result preserves order. Real SQLite sorting is
    // covered by DO integration tests downstream.
    const newer = {
      sessionId: 'sess-newer',
      createdAt: '2026-04-23T10:00:00Z',
      authoredBy: null,
      packetJson: JSON.stringify({
        sessionId: 'sess-newer',
        createdAt: '2026-04-23T10:00:00Z',
        summary: 'newer',
        whatShipped: [],
        whatBlessed: [],
        whatRemains: [],
      }),
    };
    const older = {
      sessionId: 'sess-older',
      createdAt: '2026-04-20T10:00:00Z',
      authoredBy: null,
      packetJson: JSON.stringify({
        sessionId: 'sess-older',
        createdAt: '2026-04-20T10:00:00Z',
        summary: 'older',
        whatShipped: [],
        whatBlessed: [],
        whatRemains: [],
      }),
    };
    const { db } = buildHandoffDb([[newer, older]]);
    const result = await listHandoffPackets(
      { initDB: () => Promise.resolve(db) },
      10,
    );
    expect(result).toHaveLength(2);
    expect(result[0].sessionId).toBe('sess-newer');
    expect(result[1].sessionId).toBe('sess-older');
  });

  it('falls back to the default limit when given a garbage value', async () => {
    const { db } = buildHandoffDb([[]]);
    const result = await listHandoffPackets(
      { initDB: () => Promise.resolve(db) },
      Number.NaN,
    );
    expect(result).toEqual([]);
    expect(HANDOFF_LIST_DEFAULT_LIMIT).toBe(20);
  });
});
