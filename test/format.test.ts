import { describe, expect, test } from "bun:test";
import { formatRecall } from "../src/format.ts";
import type { Link, RecallResult, Slip } from "../src/types.ts";

function slip(id: string, text: string): Slip {
  return {
    id,
    sessionId: "s",
    authoredBy: "test",
    text,
    tags: [],
    state: "kept",
    createdAt: 1,
    keptAt: 2,
    expiredAt: null,
    usedCount: 0,
    wrongCount: 0,
  };
}

function result(id: string, text: string): RecallResult {
  return {
    query: "test runner",
    activeHandoff: null,
    hits: [{ slip: slip(id, text), score: -1, trust: "high" }],
  };
}

describe("formatRecall", () => {
  test("surfaces outgoing supersedes and contradicts links", () => {
    const linksFrom: Link[] = [
      { fromId: "new", toId: "old", kind: "supersedes", createdAt: 3 },
      { fromId: "new", toId: "wrong", kind: "contradicts", createdAt: 4 },
    ];
    const text = formatRecall(result("new", "use vitest now"), {
      linksFrom: () => linksFrom,
      linksTo: () => [],
    });

    expect(text).toContain("links: supersedes old; contradicts wrong");
  });

  test("surfaces incoming superseded-by and contradicted-by links", () => {
    const linksTo: Link[] = [
      { fromId: "new", toId: "old", kind: "supersedes", createdAt: 3 },
      { fromId: "correction", toId: "old", kind: "contradicts", createdAt: 4 },
    ];
    const text = formatRecall(result("old", "use jest"), {
      linksFrom: () => [],
      linksTo: () => linksTo,
    });

    expect(text).toContain("links: superseded by new; contradicted by correction");
  });
});
