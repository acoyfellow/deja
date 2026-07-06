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
    expect(s.scope).toBe(d.scope);
    d.close();
  });

  test("remember rejects empty text", () => {
    const d = memory();
    expect(() => d.remember("")).toThrow();
    expect(() => d.remember("   ")).toThrow();
    d.close();
  });

  test("recall trust reflects evidence rather than BM25 score", () => {
    const d = memory();
    const slip = d.remember("the user prefers TypeScript strict mode");
    expect(d.recall("TypeScript strict").hits[0]!.trust).toBe("low");

    d.keep([slip.id], { noChainRollup: true });
    expect(d.recall("TypeScript strict").hits[0]!.trust).toBe("medium");

    d.used(slip.id);
    d.used(slip.id);
    expect(d.recall("TypeScript strict").hits[0]!.trust).toBe("high");

    d.wrong(slip.id);
    expect(d.recall("TypeScript strict").hits[0]!.trust).toBe("low");
    d.close();
  });

  test("recall excludes slips and handoffs from another repository scope", () => {
    const d = new Deja({ path: ":memory:", skipGc: true, scope: "repo:alpha" });
    const ours = d.remember("shared marker belongs to alpha");
    d.keep([ours.id], { noChainRollup: true });
    const theirs = d.remember("shared marker belongs to beta", { scope: "repo:beta" });
    d.keep([theirs.id], { noChainRollup: true });
    d.handoff({ sessionId: "beta-session", scope: "repo:beta", summary: "beta-only handoff" });

    const recalled = d.recall("shared marker");
    expect(recalled.hits.map((hit) => hit.slip.text)).toEqual(["shared marker belongs to alpha"]);
    expect(recalled.activeHandoff).toBeNull();
    d.close();
  });

  test("empty library recall returns budgeted scoped recents", () => {
    const d = memory();
    const recent = d.remember("recent scoped memory");
    d.keep([recent.id], { noChainRollup: true });
    const result = d.recall("", { limit: 5, maxTokens: 200 });
    expect(result.hits.map((hit) => hit.slip.id)).toEqual([recent.id]);
    expect(result.traceId).toBeTruthy();
    d.close();
  });

  test("recall trace storage can be disabled without returning a phantom id", () => {
    const d = new Deja({ path: ":memory:", skipGc: true, recordRecallTraces: false });
    expect(d.recall("anything").traceId).toBeNull();
    expect(d.storage.recentRecallTraces()).toEqual([]);
    d.close();
  });

  test("recall records a content-free scoped trace", () => {
    const d = new Deja({ path: ":memory:", skipGc: true, scope: "repo:trace" });
    const memory = d.remember("traceable decision");
    d.keep([memory.id], { noChainRollup: true });
    d.recall("traceable");
    const traces = d.storage.recentRecallTraces(10, "repo:trace");
    expect(traces).toHaveLength(1);
    expect(traces[0]).toMatchObject({
      query: "traceable",
      scope: "repo:trace",
      hitIds: [memory.id],
    });
    const raw = d.storage.db.prepare(`SELECT * FROM recall_traces`).get() as Record<string, unknown>;
    expect(JSON.stringify(raw)).not.toContain("traceable decision");
    d.close();
  });

  test("next-agent ranker stays off unless explicitly enabled", () => {
    const stable = new Deja({ path: ":memory:", skipGc: true, scope: "repo:test" });
    const decision = stable.remember("Decision: use Bun for this project");
    stable.keep([decision.id], { noChainRollup: true });
    expect(stable.recall("project runtime").readFirst).toEqual([]);
    stable.close();

    const experimental = new Deja({
      path: ":memory:",
      skipGc: true,
      scope: "repo:test",
      experimentalNextAgentRanking: true,
    });
    const candidate = experimental.remember("Decision: use Bun for this project");
    experimental.keep([candidate.id], { noChainRollup: true });
    expect(experimental.recall("project runtime").readFirst.length).toBeGreaterThan(0);
    experimental.close();
  });

  test("memory kinds infer conservatively and filter recall", () => {
    const d = memory();
    const decision = d.remember("Decision: use SQLite for local truth");
    const pitfall = d.remember("Sharp edge: never treat BM25 as confidence");
    d.keep([decision.id, pitfall.id], { noChainRollup: true });
    expect(decision.kind).toBe("decision");
    expect(pitfall.kind).toBe("pitfall");
    expect(d.recall("SQLite BM25", { kinds: ["pitfall"] }).hits.map((hit) => hit.slip.id)).toEqual([pitfall.id]);
    d.close();
  });

  test("recall respects an approximate token budget", () => {
    const d = memory();
    for (let i = 0; i < 5; i += 1) {
      const slip = d.remember(`budget marker ${i} ${"context ".repeat(80)}`);
      d.keep([slip.id], { noChainRollup: true });
    }
    const broad = d.recall("budget marker", { limit: 5, maxTokens: 5000 });
    const bounded = d.recall("budget marker", { limit: 5, maxTokens: 100 });
    expect(broad.hits.length).toBe(5);
    expect(bounded.hits.length).toBe(1);
    d.close();
  });

  test("resolved handoffs stop directing future agents", () => {
    const d = memory();
    const handoff = d.handoff({ summary: "finish the migration" });
    expect(d.recall("migration").activeHandoff?.id).toBe(handoff.id);
    expect(d.resolveHandoff(handoff.id)).toBe(true);
    expect(d.recall("migration").activeHandoff).toBeNull();
    expect(d.resolveHandoff(handoff.id)).toBe(false);
    d.close();
  });

  test("recall assessments produce a scoped quality report", () => {
    const d = memory();
    const trace = d.recall("nothing here").traceId;
    expect(trace).toBeTruthy();
    expect(d.assessRecall(trace!, "missed", "expected a decision")).toBe(true);
    expect(d.recallReport()).toMatchObject({ total: 1, assessed: 1, missed: 1 });
    expect(d.storage.recentRecallTraces(1, d.scope)[0]?.note).toBe("expected a decision");
    d.close();
  });

  test("explicit links require scope and recall follows supersession to current truth", () => {
    const d = memory();
    const old = d.remember("use jest for the test runner");
    const fresh = d.remember("use vitest now");
    d.keep([old.id, fresh.id], { noChainRollup: true });
    expect(d.link(fresh.id, old.id, "supersedes")).toBe(true);
    expect(d.storage.linksFrom(fresh.id)[0]?.kind).toBe("supersedes");
    expect(d.recall("jest test runner").hits[0]?.slip.id).toBe(fresh.id);
    const foreign = d.remember("foreign", { scope: "repo:elsewhere" });
    expect(d.link(fresh.id, foreign.id, "related")).toBe(false);
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

  test("an explicit final handoff replaces the session's automatic rollup", () => {
    const d = memory();
    const decision = d.remember("Decision: use Bun.");
    d.keep([decision.id]);
    const automatic = d.storage.getHandoffBySession("test-session-1")!;
    expect(automatic.automatic).toBe(true);

    const final = d.handoff({ summary: "Finished migration", next: ["publish"] });
    expect(final.automatic).toBe(false);
    expect(final.id).not.toBe(automatic.id);
    expect(d.storage.getHandoffBySession("test-session-1")?.summary).toBe("Finished migration");
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
      scope: d.scope,
      kind: "note",
      text: "ancient",
      tags: [],
      state: "draft",
      createdAt: 1000,
      keptAt: null,
      expiredAt: null,
      usedCount: 0,
      wrongCount: 0,
      redacted: false,
    });
    const expired = d.gc();
    expect(expired).toBe(1);
    expect(d.get("01OLD0000000000000000000000")!.state).toBe("expired");
    d.close();
  });
});

describe("Redaction", () => {
  test("remember with redacted: true stores with redacted flag", () => {
    const d = memory();
    const s = d.remember("secret: api key is sk-1234", { redacted: true });
    expect(s.redacted).toBe(true);
    d.close();
  });

  test("remember without redacted stores with redacted: false", () => {
    const d = memory();
    const s = d.remember("normal memory");
    expect(s.redacted).toBe(false);
    d.close();
  });

  test("redact() marks an existing slip as redacted", () => {
    const d = memory();
    const s = d.remember("accidental secret");
    expect(s.redacted).toBe(false);
    expect(d.redact(s.id)).toBe(true);
    expect(d.get(s.id)!.redacted).toBe(true);
    d.close();
  });

  test("redact() returns false for already-redacted or missing slips", () => {
    const d = memory();
    const s = d.remember("secret", { redacted: true });
    expect(d.redact(s.id)).toBe(false);
    expect(d.redact("nonexistent")).toBe(false);
    d.close();
  });

  test("recall masks redacted slip text", () => {
    const d = memory();
    const s = d.remember("secret: api key is sk-1234", { redacted: true });
    d.keep([s.id], { noChainRollup: true });
    const result = d.recall("secret");
    expect(result.hits.length).toBeGreaterThan(0);
    for (const hit of result.hits) {
      if (hit.slip.id === s.id) {
        expect(hit.slip.text).toBe("[redacted]");
      }
    }
    d.close();
  });

  test("recall does not mask non-redacted slip text", () => {
    const d = memory();
    const s = d.remember("normal memory");
    d.keep([s.id], { noChainRollup: true });
    const result = d.recall("normal");
    expect(result.hits[0]!.slip.text).toBe("normal memory");
    d.close();
  });

  test("rawMemoryLocal: false disables masking", () => {
    const d = new Deja({ path: ":memory:", skipGc: true, rawMemoryLocal: false });
    const s = d.remember("secret: api key", { redacted: true });
    d.keep([s.id], { noChainRollup: true });
    const result = d.recall("secret");
    expect(result.hits[0]!.slip.text).toBe("secret: api key");
    d.close();
  });

  test("get() returns raw text regardless of redaction", () => {
    const d = memory();
    const s = d.remember("secret", { redacted: true });
    expect(d.get(s.id)!.text).toBe("secret");
    d.close();
  });
});

describe("Episodes", () => {
  test("recordEpisode stores failure->repair metadata", () => {
    const d = memory();
    const fail = d.remember("failed to parse JSON");
    const repair = d.remember("added try-catch around JSON.parse");
    d.keep([fail.id, repair.id], { noChainRollup: true });

    const ep = d.recordEpisode({
      failureMode: "JSON parse error on malformed input",
      failureSlipIds: [fail.id],
      repairSlipIds: [repair.id],
      taskClass: "json-handling",
      failingModel: "llama-3.1-8b",
      repairModel: "claude-opus-4",
    });
    expect(ep.taskClass).toBe("json-handling");
    expect(ep.failureSlipIds).toEqual([fail.id]);
    expect(ep.repairSlipIds).toEqual([repair.id]);
    expect(ep.evaluations).toEqual([]);
    expect(ep.exportPolicy).toBe("metadata-only");
    expect(ep.redactionPolicy).toBe("allow");
    d.close();
  });

  test("getEpisode retrieves stored episode", () => {
    const d = memory();
    const fail = d.remember("failure slip");
    const repair = d.remember("repair slip");
    d.keep([fail.id, repair.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "timeout on large input",
      failureSlipIds: [fail.id],
      repairSlipIds: [repair.id],
      taskClass: "timeout",
    });
    const got = d.getEpisode(ep.id);
    expect(got).not.toBeNull();
    expect(got!.failureMode).toBe("timeout on large input");
    d.close();
  });

  test("episodesByTaskClass returns scoped episodes", () => {
    const d = memory();
    const a = d.remember("a"); const b = d.remember("b"); const c = d.remember("c");
    d.keep([a.id, b.id, c.id], { noChainRollup: true });
    d.recordEpisode({ failureMode: "a", failureSlipIds: [a.id], repairSlipIds: [a.id], taskClass: "parser" });
    d.recordEpisode({ failureMode: "b", failureSlipIds: [b.id], repairSlipIds: [b.id], taskClass: "parser" });
    d.recordEpisode({ failureMode: "c", failureSlipIds: [c.id], repairSlipIds: [c.id], taskClass: "network" });
    expect(d.episodesByTaskClass("parser").length).toBe(2);
    expect(d.episodesByTaskClass("network").length).toBe(1);
    d.close();
  });

  test("addEpisodeEvaluation records an evaluation result", () => {
    const d = memory();
    const s = d.remember("test slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "test",
    });
    const ok = d.addEpisodeEvaluation(ep.id, {
      caseLabel: "case-1",
      pass: true,
      modelId: "test-model",
      ablated: false,
      evaluatedAt: Date.now(),
    });
    expect(ok).toBe(true);
    const got = d.getEpisode(ep.id)!;
    expect(got.evaluations.length).toBe(1);
    expect(got.evaluations[0]!.caseLabel).toBe("case-1");
    expect(got.evaluations[0]!.pass).toBe(true);
    d.close();
  });

  test("ablationReceipt returns null when no episodes exist", () => {
    const d = memory();
    expect(d.ablationReceipt("nonexistent")).toBeNull();
    d.close();
  });

  test("ablationReceipt demonstrates ablation with paired comparison", () => {
    const d = memory();
    const s = d.remember("slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "json-handling",
    });
    // Paired: same caseLabel, same non-null modelId, distinct evidence receipt refs
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: true, modelId: "model-a", ablated: false, evaluatedAt: 1, evidenceReceiptRef: "ev-c1-with" });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: false, modelId: "model-a", ablated: true, evaluatedAt: 2, evidenceReceiptRef: "ev-c1-ablated" });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c2", pass: true, modelId: "model-a", ablated: false, evaluatedAt: 3, evidenceReceiptRef: "ev-c2-with" });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c2", pass: false, modelId: "model-a", ablated: true, evaluatedAt: 4, evidenceReceiptRef: "ev-c2-ablated" });

    const receipt = d.ablationReceipt("json-handling");
    expect(receipt).not.toBeNull();
    expect(receipt!.ablationDemonstrated).toBe(true);
    expect(receipt!.passedWithEpisodes).toBe(2);
    expect(receipt!.passedAblated).toBe(0);
    expect(receipt!.pairedResults).toBeDefined();
    expect(receipt!.pairedResults!.length).toBe(2);
    expect(receipt!.pairedResults![0]!.caseLabel).toBe("c1");
    expect(receipt!.pairedResults![0]!.withEpisode!.pass).toBe(true);
    expect(receipt!.pairedResults![0]!.ablated!.pass).toBe(false);
    expect(receipt!.pairedResults![0]!.withEpisode!.evidenceReceiptRef).toBe("ev-c1-with");
    expect(receipt!.mechanicsVerified).toBe(true);
    expect(receipt!.modelTransferUnproven).toBe(true);
    d.close();
  });

  test("ablationReceipt shows no ablation when paired passes match", () => {
    const d = memory();
    const s = d.remember("slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "trivial",
    });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: true, modelId: "model-a", ablated: false, evaluatedAt: 1, evidenceReceiptRef: "ev-c1-with" });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: true, modelId: "model-a", ablated: true, evaluatedAt: 2, evidenceReceiptRef: "ev-c1-ablated" });

    const receipt = d.ablationReceipt("trivial");
    expect(receipt).not.toBeNull();
    expect(receipt!.ablationDemonstrated).toBe(false);
    expect(receipt!.pairedResults).toBeDefined();
    expect(receipt!.pairedResults![0]!.withEpisode!.pass).toBe(true);
    expect(receipt!.pairedResults![0]!.ablated!.pass).toBe(true);
    expect(receipt!.mechanicsVerified).toBe(true);
    expect(receipt!.modelTransferUnproven).toBe(true);
    d.close();
  });

  // ----- negative tests -----

  test("recordEpisode rejects empty failureMode", () => {
    const d = memory();
    expect(() => d.recordEpisode({
      failureMode: "",
      failureSlipIds: [],
      repairSlipIds: [],
      taskClass: "test",
    })).toThrow("failureMode is required");
    d.close();
  });

  test("recordEpisode rejects empty slip ids in failureSlipIds", () => {
    const d = memory();
    expect(() => d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [""],
      repairSlipIds: [],
      taskClass: "test",
    })).toThrow("failureSlipIds contains empty id");
    d.close();
  });

  test("recordEpisode rejects empty slip ids in repairSlipIds", () => {
    const d = memory();
    expect(() => d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [],
      repairSlipIds: [""],
      taskClass: "test",
    })).toThrow("repairSlipIds contains empty id");
    d.close();
  });

  test("recordEpisode rejects nonexistent slip ids", () => {
    const d = memory();
    expect(() => d.recordEpisode({
      failureMode: "test",
      failureSlipIds: ["nonexistent-ulid"],
      repairSlipIds: [],
      taskClass: "test",
    })).toThrow("slip nonexistent-ulid not found");
    d.close();
  });

  test("recordEpisode rejects slip from another scope or DB", () => {
    const d = memory();
    const s = d.remember("scoped slip");
    d.keep([s.id], { noChainRollup: true });
    // A different deja instance (separate :memory: DB) can't see this slip
    const d2 = new Deja({ path: ":memory:", skipGc: true, scope: "repo:other" });
    expect(() => d2.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [],
      taskClass: "test",
    })).toThrow("not found");
    d.close();
    d2.close();
  });

  test("ablationReceipt ignores unpaired evaluations for ablation claims", () => {
    const d = memory();
    const s = d.remember("slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "unpaired",
    });
    // c1 has only a with-episode eval; c2 has both sides but no evidence receipt refs.
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: true, modelId: "model-a", ablated: false, evaluatedAt: 1, evidenceReceiptRef: "ev-c1-with" });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c2", pass: true, modelId: "model-a", ablated: false, evaluatedAt: 2 });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c2", pass: false, modelId: "model-a", ablated: true, evaluatedAt: 3 });

    const receipt = d.ablationReceipt("unpaired");
    expect(receipt).not.toBeNull();
    // No eligible complete pairs, so mechanics are not verified and ablation is not demonstrated.
    expect(receipt!.pairedResults).toBeUndefined();
    expect(receipt!.ablationDemonstrated).toBe(false);
    expect(receipt!.mechanicsVerified).toBe(false);
    // Aggregate counts are still reported for backward compatibility.
    expect(receipt!.passedWithEpisodes).toBe(2);
    expect(receipt!.passedAblated).toBe(0);
    d.close();
  });

  test("ablationReceipt includes portable evidence refs without local slip ids", () => {
    const d = memory();
    const s = d.remember("slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "ev-test",
    });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: true, modelId: "model-a", ablated: false, evaluatedAt: 1, evidenceReceiptRef: "ev-c1-with" });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: false, modelId: "model-a", ablated: true, evaluatedAt: 2, evidenceReceiptRef: "ev-c1-ablated" });

    const receipt = d.ablationReceipt("ev-test");
    expect(receipt!.evidence).toBeDefined();
    expect(receipt!.evidence!.length).toBe(1);
    expect(receipt!.evidence![0]!.evidenceReceiptRefs).toEqual(["ev-c1-with", "ev-c1-ablated"]);
    expect(receipt!.evidence![0]).not.toHaveProperty("slipIds");
    expect(receipt!.evidence![0]!.evaluationTraceId).toBeUndefined();
    d.close();
  });

  test("ablationReceipt marks modelTransferUnproven unconditionally", () => {
    const d = memory();
    const s = d.remember("slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "single-model",
      failingModel: "llama-3.1-8b",
      repairModel: "claude-opus-4",
    });
    // Multiple models are present, but Phase 1 API still reports transfer as unproven.
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: true, modelId: "llama-3.1-8b", ablated: false, evaluatedAt: 1, evidenceReceiptRef: "ev-c1-with" });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: false, modelId: "llama-3.1-8b", ablated: true, evaluatedAt: 2, evidenceReceiptRef: "ev-c1-ablated" });

    const receipt = d.ablationReceipt("single-model");
    expect(receipt!.modelTransferUnproven).toBe(true);
    expect(receipt!.mechanicsVerified).toBe(true);
    d.close();
  });

  test("ablationReceipt requires distinct evidence receipt refs for pairing", () => {
    const d = memory();
    const s = d.remember("slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "same-ref",
    });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: true, modelId: "model-a", ablated: false, evaluatedAt: 1, evidenceReceiptRef: "same-ref" });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: false, modelId: "model-a", ablated: true, evaluatedAt: 2, evidenceReceiptRef: "same-ref" });

    const receipt = d.ablationReceipt("same-ref");
    expect(receipt!.pairedResults).toBeUndefined();
    expect(receipt!.mechanicsVerified).toBe(false);
    expect(receipt!.ablationDemonstrated).toBe(false);
    d.close();
  });

  test("ablationReceipt requires same non-null modelId for pairing", () => {
    const d = memory();
    const s = d.remember("slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "null-model",
    });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: true, modelId: null, ablated: false, evaluatedAt: 1, evidenceReceiptRef: "ev-c1-with" });
    d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: false, modelId: null, ablated: true, evaluatedAt: 2, evidenceReceiptRef: "ev-c1-ablated" });

    const receipt = d.ablationReceipt("null-model");
    expect(receipt!.pairedResults).toBeUndefined();
    expect(receipt!.mechanicsVerified).toBe(false);
    expect(receipt!.ablationDemonstrated).toBe(false);
    d.close();
  });

  test("evidence-less evaluations remain storable but are ineligible for observed receipt", () => {
    const d = memory();
    const s = d.remember("slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "legacy",
    });
    const ok = d.addEpisodeEvaluation(ep.id, { caseLabel: "c1", pass: true, modelId: "model-a", ablated: false, evaluatedAt: 1 });
    expect(ok).toBe(true);

    const receipt = d.ablationReceipt("legacy");
    expect(receipt).not.toBeNull();
    expect(receipt!.mechanicsVerified).toBe(false);
    expect(receipt!.ablationDemonstrated).toBe(false);
    d.close();
  });

  test("recordEpisode accepts exportPolicy and redactionPolicy", () => {
    const d = memory();
    const s = d.remember("slip");
    d.keep([s.id], { noChainRollup: true });
    const ep = d.recordEpisode({
      failureMode: "test",
      failureSlipIds: [s.id],
      repairSlipIds: [s.id],
      taskClass: "policy-test",
      exportPolicy: "redacted",
      redactionPolicy: "strip",
    });
    expect(ep.exportPolicy).toBe("redacted");
    expect(ep.redactionPolicy).toBe("strip");
    d.close();
  });
});
