import { describe, expect, test } from "bun:test";
import { Storage } from "../src/storage.ts";
import { ulid } from "../src/ulid.ts";
import type { Slip } from "../src/types.ts";

function makeSlip(overrides: Partial<Slip> = {}): Slip {
  const now = Date.now();
  return {
    id: ulid(now),
    sessionId: "test-session",
    authoredBy: "test",
    text: "hello world",
    tags: [],
    state: "draft",
    createdAt: now,
    keptAt: null,
    expiredAt: null,
    usedCount: 0,
    wrongCount: 0,
    ...overrides,
  };
}

describe("Storage", () => {
  test("insert + get round-trip", () => {
    const s = new Storage({ path: ":memory:" });
    const slip = makeSlip({ text: "decided to use SQLite" });
    s.insertSlip(slip);
    const got = s.getSlip(slip.id);
    expect(got).not.toBeNull();
    expect(got!.text).toBe("decided to use SQLite");
    expect(got!.state).toBe("draft");
    s.close();
  });

  test("FTS5 search ranks relevant slips", () => {
    const s = new Storage({ path: ":memory:" });
    s.insertSlip(makeSlip({ text: "the user prefers tabs over spaces" }));
    s.insertSlip(makeSlip({ text: "completely unrelated text" }));
    s.insertSlip(makeSlip({ text: "tabs are better than spaces in this repo" }));

    const hits = s.searchFts("tabs spaces", 10);
    expect(hits.length).toBe(2);
    // best score (most negative) is first
    expect(hits[0]!.score).toBeLessThanOrEqual(hits[1]!.score);
  });

  test("FTS5 excludes expired slips", () => {
    const s = new Storage({ path: ":memory:" });
    const a = makeSlip({ text: "kept memory" });
    const b = makeSlip({ text: "expired memory" });
    s.insertSlip(a);
    s.insertSlip(b);
    s.setState(b.id, "expired", Date.now());

    const hits = s.searchFts("memory", 10);
    expect(hits.length).toBe(1);
    expect(hits[0]!.slip.id).toBe(a.id);
    s.close();
  });

  test("setState transitions draft -> kept and stamps keptAt", () => {
    const s = new Storage({ path: ":memory:" });
    const slip = makeSlip();
    s.insertSlip(slip);

    const at = Date.now() + 1000;
    s.setState(slip.id, "kept", at);
    const got = s.getSlip(slip.id)!;
    expect(got.state).toBe("kept");
    expect(got.keptAt).toBe(at);
    expect(got.expiredAt).toBeNull();
    s.close();
  });

  test("gcDrafts expires only old drafts", () => {
    const s = new Storage({ path: ":memory:" });
    const old = makeSlip({ createdAt: 1000, text: "old" });
    const recent = makeSlip({ createdAt: Date.now(), text: "recent" });
    const oldKept = makeSlip({
      createdAt: 1000,
      state: "kept",
      keptAt: 1500,
      text: "old kept",
    });
    s.insertSlip(old);
    s.insertSlip(recent);
    s.insertSlip(oldKept);

    const expired = s.gcDrafts(Date.now() - 1000, Date.now());
    expect(expired).toBe(1);
    expect(s.getSlip(old.id)!.state).toBe("expired");
    expect(s.getSlip(recent.id)!.state).toBe("draft");
    expect(s.getSlip(oldKept.id)!.state).toBe("kept");
    s.close();
  });

  test("handoffs are unique per session", () => {
    const s = new Storage({ path: ":memory:" });
    const now = Date.now();
    s.insertHandoff({
      id: ulid(now),
      sessionId: "S1",
      authoredBy: "test",
      summary: "first",
      kept: [],
      next: [],
      createdAt: now,
    });
    expect(() =>
      s.insertHandoff({
        id: ulid(now + 1),
        sessionId: "S1",
        authoredBy: "test",
        summary: "second",
        kept: [],
        next: [],
        createdAt: now + 1,
      }),
    ).toThrow();
    s.close();
  });

  test("links round-trip", () => {
    const s = new Storage({ path: ":memory:" });
    const a = makeSlip({ text: "old" });
    const b = makeSlip({ text: "new" });
    s.insertSlip(a);
    s.insertSlip(b);
    s.insertLink({
      fromId: b.id,
      toId: a.id,
      kind: "supersedes",
      createdAt: Date.now(),
    });
    const links = s.linksFrom(b.id);
    expect(links.length).toBe(1);
    expect(links[0]!.kind).toBe("supersedes");
    expect(links[0]!.toId).toBe(a.id);
    s.close();
  });
});
