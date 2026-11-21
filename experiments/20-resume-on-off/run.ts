import { Deja } from "../../src/index.ts";
import { CASES, NOTES, type ResumeCase } from "./cases.ts";
import { DEFAULT_PRIMER_OPTIONS, selectRelevant, type RecallNote } from "../../../pi-fresh-session-handoff/src/hooks/deja-session-primer.ts";
import { createClefJudge, wranglerCredentials } from "../../../pi-fresh-session-handoff/src/hooks/clef.ts";

const WITH_CLEF = process.argv.includes("--clef");
const judge = WITH_CLEF ? createClefJudge(DEFAULT_PRIMER_OPTIONS.clefModel, 10_000, wranglerCredentials()) : undefined;

const MAX_NOTES = 3;
const MAX_TOKENS = 1200;

type Delivery = { ids: string[]; chars: number; handoff: boolean };
type Arm = "off" | "on" | "primer";
type Scored = { id: string; split: string; family: string; arm: Arm; pass: boolean; neededHit: number; neededTotal: number; forbiddenHit: number; neededFirst: boolean; chars: number; handoff: boolean };

function seededDeja(c: ResumeCase): { deja: Deja; keyOf: Map<string, string> } {
  const deja = new Deja({ path: ":memory:", skipGc: true, scope: c.scope, recallReach: "all", recordRecallTraces: false });
  const idOf = new Map<string, string>();
  const keyOf = new Map<string, string>();
  for (const seed of NOTES) {
    const supersededId = seed.supersedes ? idOf.get(seed.supersedes) : undefined;
    const slip = deja.remember(seed.text, {
      scope: seed.scope,
      kind: seed.kind,
      links: supersededId ? [{ toId: supersededId, kind: "supersedes" }] : undefined,
    });
    deja.keep([slip.id]);
    idOf.set(seed.key, slip.id);
    keyOf.set(slip.id, seed.key);
  }
  if (c.handoff) deja.handoff({ summary: c.handoff.summary, next: c.handoff.next, scope: c.scope, sessionId: `prev-${c.id}` });
  return { deja, keyOf };
}

async function deliver(c: ResumeCase, arm: "on" | "primer"): Promise<Delivery> {
  const { deja, keyOf } = seededDeja(c);
  const result = deja.recall(c.prompt, { limit: arm === "primer" ? 10 : MAX_NOTES, maxTokens: MAX_TOKENS });
  let hits = result.hits.slice(0, MAX_NOTES);
  if (arm === "primer") {
    const notes: RecallNote[] = result.hits.map((hit) => ({ id: hit.slip.id, score: hit.score, text: hit.slip.text, formatted: hit.slip.text }));
    const chosen = new Set((await selectRelevant(c.prompt, notes, DEFAULT_PRIMER_OPTIONS, judge)).map((note) => note.id));
    hits = result.hits.filter((hit) => chosen.has(hit.slip.id));
  }
  const handoffText = result.activeHandoff && result.activeHandoff.scope === c.scope ? `${result.activeHandoff.summary} ${result.activeHandoff.next.join(" ")}` : "";
  const chars = hits.reduce((sum, hit) => sum + hit.slip.text.length, 0) + handoffText.length;
  const ids = hits.map((hit) => keyOf.get(hit.slip.id) ?? hit.slip.id);
  deja.close();
  return { ids, chars, handoff: handoffText.length > 0 };
}

function score(c: ResumeCase, arm: Arm, delivery: Delivery): Scored {
  const neededHit = c.needed.filter((key) => delivery.ids.includes(key)).length;
  const forbiddenHit = c.forbidden.filter((key) => delivery.ids.includes(key)).length;
  const pass = neededHit === c.needed.length && forbiddenHit === 0;
  const neededFirst = c.needed.length === 0 || delivery.ids[0] === c.needed[0];
  return { id: c.id, split: c.split, family: c.family, arm, pass, neededHit, neededTotal: c.needed.length, forbiddenHit, neededFirst, chars: delivery.chars, handoff: delivery.handoff };
}

const rows: Scored[] = [];
for (const c of CASES) {
  rows.push(score(c, "off", { ids: [], chars: 0, handoff: false }));
  rows.push(score(c, "on", await deliver(c, "on")));
  if (WITH_CLEF) rows.push(score(c, "primer", await deliver(c, "primer")));
}

function summary(split: string, arm: Arm) {
  const subset = rows.filter((row) => row.split === split && row.arm === arm);
  const passed = subset.filter((row) => row.pass).length;
  const needed = subset.reduce((sum, row) => sum + row.neededTotal, 0);
  const neededHit = subset.reduce((sum, row) => sum + row.neededHit, 0);
  const forbidden = subset.reduce((sum, row) => sum + row.forbiddenHit, 0);
  const chars = subset.reduce((sum, row) => sum + row.chars, 0);
  const first = subset.filter((row) => row.neededFirst).length;
  return { split, arm, cases: subset.length, passed, first, neededRecall: needed === 0 ? 1 : neededHit / needed, forbiddenInjected: forbidden, avgChars: Math.round(chars / Math.max(subset.length, 1)) };
}

const table = ["dev", "heldout", "fresh"].flatMap((split) => (WITH_CLEF ? (["off", "on", "primer"] as const) : (["off", "on"] as const)).map((arm) => summary(split, arm)));

if (process.argv.includes("--json")) {
  console.log(JSON.stringify({ table, rows }, null, 2));
} else {
  console.log("split    arm    pass   first  needed-recall  wrong  avg-chars");
  for (const row of table) console.log(`${row.split.padEnd(8)} ${row.arm.padEnd(6)} ${`${row.passed}/${row.cases}`.padEnd(6)} ${`${row.first}/${row.cases}`.padEnd(6)} ${row.neededRecall.toFixed(2).padEnd(14)} ${String(row.forbiddenInjected).padEnd(10)} ${row.avgChars}`);
  console.log("\nfailures:");
  for (const row of rows.filter((r) => r.arm !== "off" && !r.pass)) console.log(`  ${row.arm} ${row.split} ${row.id} [${row.family}] needed ${row.neededHit}/${row.neededTotal} forbidden ${row.forbiddenHit}`);
}
