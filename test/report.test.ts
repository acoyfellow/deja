import { describe, expect, test } from "bun:test";
import { Deja } from "../src/index.ts";
import { buildReport, DEFAULT_AUTOMATED_PREFIXES, findings, reportHtml, reportText } from "../src/report.ts";

function seeded() {
  const d = new Deja({ path: ":memory:", skipGc: true, scope: "repo:test:1" });
  const deploy = d.remember("Marketing deploy runs deploy.sh and checks health.json");
  const noise = d.remember("Broad note about everything and deploy and health");
  d.keep([deploy.id, noise.id]);
  for (let i = 0; i < 6; i++) d.recall("deploy health", 5);
  d.recall("READ-ONLY review this diff for deploy", 5);
  d.recall("zzzz nothing matches this", 5);
  d.used(deploy.id);
  return { d, deploy, noise };
}

describe("deja report", () => {
  test("counts recalls, bots, empty results, grading and the noisiest unused note", () => {
    const { d, deploy, noise } = seeded();
    const report = buildReport(d.storage.db, { sinceMs: 0, nowMs: Date.now() + 1000, showQueries: false, automatedPrefixes: DEFAULT_AUTOMATED_PREFIXES });
    expect(report.recalls.total).toBe(8);
    expect(report.recalls.automated).toBe(1);
    expect(report.recalls.empty).toBe(1);
    expect(report.grading.notesShown).toBe(2);
    expect(report.grading.notesUsed).toBe(1);
    expect(report.mostUsed[0].id).toBe(deploy.id);
    expect(report.mostShownNeverUsed[0].id).toBe(noise.id);
    expect(report.mostShownNeverUsed[0].shown).toBe(7);
    expect(findings(report).some((line) => line.includes(noise.id))).toBe(true);
    d.close();
  });

  test("hides query text unless asked, in text and HTML", () => {
    const { d } = seeded();
    const hidden = buildReport(d.storage.db, { sinceMs: 0, nowMs: Date.now() + 1000, showQueries: false, automatedPrefixes: DEFAULT_AUTOMATED_PREFIXES });
    expect(JSON.stringify(hidden.sampleQueries)).not.toContain("zzzz");
    expect(reportHtml(hidden)).not.toContain("zzzz");
    const shown = buildReport(d.storage.db, { sinceMs: 0, nowMs: Date.now() + 1000, showQueries: true, automatedPrefixes: DEFAULT_AUTOMATED_PREFIXES });
    expect(reportHtml(shown)).toContain("zzzz");
    expect(reportText(shown)).toContain("recalls            8");
    d.close();
  });

  test("an empty database says so instead of reporting zeros as health", () => {
    const d = new Deja({ path: ":memory:", skipGc: true });
    const report = buildReport(d.storage.db, { sinceMs: 0, nowMs: Date.now(), showQueries: false, automatedPrefixes: DEFAULT_AUTOMATED_PREFIXES });
    expect(findings(report)[0]).toContain("No recalls recorded");
    d.close();
  });
});

test("formatCount groups thousands for legibility", async () => {
  const { formatCount } = await import("../src/report.ts");
  expect(formatCount(1234567)).toBe("1,234,567");
  expect(formatCount(42)).toBe("42");
});
