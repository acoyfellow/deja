import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createClefJudge, wranglerCredentials } from "../../../pi-fresh-session-handoff/src/hooks/clef.ts";
import { RELEVANCE_QUESTION, relevanceState } from "../../../pi-fresh-session-handoff/src/hooks/deja-session-primer.ts";

const DATA = join(homedir(), ".deja/experiments/21");
const OUT = join(DATA, "clef-scores.jsonl");
const DB = join(homedir(), ".deja/deja.db");
const PARALLEL = Number(process.env.PARALLEL ?? 8);

type Injection = { key: string; prompt: string; notes: { id: string }[] };
type Grade = { key: string; notes: { id: string; relevant: boolean; used: boolean; misleading: boolean }[]; savedWork: string };

const injections = new Map<string, Injection>(readFileSync(join(DATA, "injections.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => {
  const row = JSON.parse(line) as Injection;
  return [row.key, row];
}));
const grades: Grade[] = readFileSync(join(DATA, "grades.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));

const { Database } = await import("bun:sqlite");
const db = new Database(DB, { readonly: true });
const textOf = (id: string): string | undefined => (db.query("select text from slips where id = ?").get(id) as { text: string } | null)?.text;

const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").split("\n").filter(Boolean).map((line) => { const row = JSON.parse(line); return `${row.key}:${row.id}`; }) : []);
const judge = createClefJudge("@cf/cloudflare/clef", 20_000, wranglerCredentials());
const jobs = grades.flatMap((grade) => grade.notes.map((note) => ({ grade, note }))).filter(({ grade, note }) => !done.has(`${grade.key}:${note.id}`));

let next = 0;
let finished = 0;
async function worker() {
  while (next < jobs.length) {
    const { grade, note } = jobs[next++];
    const text = textOf(note.id);
    const prompt = injections.get(grade.key)?.prompt.replace(/\s+/g, " ").slice(0, 400) ?? "";
    let probability: number | null = null;
    if (text) {
      try {
        probability = await judge(relevanceState(prompt, { id: note.id, score: 0, text, formatted: text }), RELEVANCE_QUESTION);
      } catch {
        probability = null;
      }
    }
    appendFileSync(OUT, JSON.stringify({ key: grade.key, id: note.id, probability, relevant: note.relevant, used: note.used, misleading: note.misleading, saved: grade.savedWork === "yes" }) + "\n");
    finished++;
    if (finished % 50 === 0) console.log(`${finished}/${jobs.length}`);
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
