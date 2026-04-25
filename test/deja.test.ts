import { describe, expect, test, beforeEach } from "bun:test";
import { Deja, memory } from "../src/index.ts";
import { _resetSessionForTesting } from "../src/lifecycle.ts";

beforeEach(() => {
  _resetSessionForTesting();
  // Pin author/session for determinism
  process.env.DEJA_SESSION = "test-session-1";
  process.env.DEJA_AUTHOR = "test-agent";
});

describe("Deja API", () => {
  test("remember creates a draft", () => {
    const d = memory();
    const s = d.remember("the user uses pnpm");
    expect(s.state).toBe("draft");
    expect(s.text).toBe("the user uses pnpm");
    expect(s.authoredBy).toBe("test-agent");
    expect(s.sessionId).toBe("test-session-1");
    d.close();
  });

  test("remember rejects empty text", () => {
    const d = memory();
    expect(() => d.remember("")).toThrow();
    expect(() => d.remember("   ")).toThrow();
    d.close();
  });

  test("recall returns FTS hits with trust labels", () => {
    const d = memory();
    d.remember("the user prefers TypeScript strict mode");
    d.remember("totally unrelated garbage");
    const r = d.recall("TypeScript strict");
    expect(r.hits.length).toBeGreaterThan(0);
    expect(r.hits[0]!.slip.text).toContain("TypeScript");
    expect(["high", "medium", "low"]).toContain(r.hits[0]!.trust);
    d.close();
  });

  test("keep promotes drafts and skips already-kept", () => {
    const d = memory();
    const a = d.remember("a");
    const b = d.remember("b");
    const promoted = d.keep([a.id, b.id]);
    expect(promoted.length).toBe(2);
    expect(promoted.every((s) => s.state === "kept")).toBe(true);

    // Second keep is a no-op
    const promoted2 = d.keep([a.id]);
    expect(promoted2.length).toBe(0);
    d.close();
  });

  test("handoff auto-promotes session drafts", () => {
    const d = memory();
    d.remember("draft 1");
    d.remember("draft 2");
    const h = d.handoff({ summary: "did stuff", next: ["next thing"] });
    expect(h.kept.length).toBe(2);
    expect(h.summary).toBe("did stuff");
    expect(h.next).toEqual(["next thing"]);
    expect(h.authoredBy).toBe("test-agent");
    d.close();
  });

  test("handoff rejects second handoff in same session", () => {
    const d = memory();
    d.remember("note");
    d.handoff({ summary: "first" });
    expect(() => d.handoff({ summary: "second" })).toThrow(
      /already has a handoff/,
    );
    d.close();
  });

  test("recall surfaces active handoff for current session", () => {
    const d = memory();
    d.remember("something");
    d.handoff({ summary: "this is the handoff" });
    const r = d.recall("anything");
    expect(r.activeHandoff).not.toBeNull();
    expect(r.activeHandoff!.summary).toBe("this is the handoff");
    d.close();
  });

  test("recall falls back to latest handoff from any session when current has none", () => {
    const d = memory();
    // Plant an old handoff in a different session
    d.handoff({
      sessionId: "old-session",
      authoredBy: "old-agent",
      summary: "previous session signoff",
    });
    // Switch to a fresh session — current has no handoff
    process.env.DEJA_SESSION = "fresh-session";
    _resetSessionForTesting();
    const r = d.recall("anything");
    expect(r.activeHandoff).not.toBeNull();
    expect(r.activeHandoff!.summary).toBe("previous session signoff");
    d.close();
  });

  test("keep auto-rolls chain-shaped slips into a handoff", () => {
    const d = memory();
    const a = d.remember("Decision: use Bun, not Node, for new TS libraries.");
    const b = d.remember("just a random fact about the weather"); // not chain-shaped
    d.keep([a.id, b.id]);

    // Session should now have a handoff that mentions the chain-shaped slip
    const h = d.storage.getHandoffBySession("test-session-1");
    expect(h).not.toBeNull();
    expect(h!.summary).toContain("Bun");
    expect(h!.summary).not.toContain("weather");
    d.close();
  });

  test("keep does not roll up when current session already has a handoff", () => {
    const d = memory();
    d.handoff({ summary: "first handoff" });
    const a = d.remember("Decision: use Bun.");
    // Should NOT throw, should NOT create a second handoff
    d.keep([a.id]);
    const h = d.storage.getHandoffBySession("test-session-1");
    expect(h).not.toBeNull();
    expect(h!.summary).toBe("first handoff");
    d.close();
  });

  test("keep skips rollup when noChainRollup option set", () => {
    const d = new Deja({ path: ":memory:", skipGc: true, noChainRollup: true });
    const a = d.remember("Decision: use Bun.");
    d.keep([a.id]);
    const h = d.storage.getHandoffBySession("test-session-1");
    expect(h).toBeNull();
    d.close();
  });

  test("keep can disable rollup per-call", () => {
    const d = memory();
    const a = d.remember("Decision: use Bun.");
    d.keep([a.id], { noChainRollup: true });
    const h = d.storage.getHandoffBySession("test-session-1");
    expect(h).toBeNull();
    d.close();
  });

  test("keep does not roll up non-chain-shaped slips", () => {
    const d = memory();
    const a = d.remember("the sky is blue today");
    d.keep([a.id]);
    const h = d.storage.getHandoffBySession("test-session-1");
    expect(h).toBeNull();
    d.close();
  });

  test("forget expires kept slips too", () => {
    const d = memory();
    const s = d.remember("one");
    d.keep([s.id]);
    expect(d.get(s.id)!.state).toBe("kept");
    expect(d.forget(s.id)).toBe(true);
    expect(d.get(s.id)!.state).toBe("expired");
    expect(d.forget(s.id)).toBe(false); // already expired, no-op
    d.close();
  });

  test("used / wrong bump counters", () => {
    const d = memory();
    const s = d.remember("once");
    d.used(s.id);
    d.used(s.id);
    d.wrong(s.id);
    const got = d.get(s.id)!;
    expect(got.usedCount).toBe(2);
    expect(got.wrongCount).toBe(1);
    d.close();
  });

  test("remember with links creates supersedes edges", () => {
    const d = memory();
    const old = d.remember("uses npm");
    const fresh = d.remember("uses pnpm now", {
      links: [{ toId: old.id, kind: "supersedes" }],
    });
    const links = d.storage.linksFrom(fresh.id);
    expect(links.length).toBe(1);
    expect(links[0]!.kind).toBe("supersedes");
    expect(links[0]!.toId).toBe(old.id);
    d.close();
  });

  test("gc expires drafts older than 24h", () => {
    const d = new Deja({ path: ":memory:", skipGc: true });
    // insert a synthetic ancient draft
    d.storage.insertSlip({
      id: "01OLD0000000000000000000000",
      sessionId: "old",
      authoredBy: "old-agent",
      text: "ancient",
      tags: [],
      state: "draft",
      createdAt: 1000,
      keptAt: null,
      expiredAt: null,
      usedCount: 0,
      wrongCount: 0,
    });
    const expired = d.gc();
    expect(expired).toBe(1);
    expect(d.get("01OLD0000000000000000000000")!.state).toBe("expired");
    d.close();
  });
});
