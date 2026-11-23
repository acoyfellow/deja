import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DATA = join(homedir(), ".deja/experiments/21");
const MODEL = process.env.MODEL ?? "";
if (!MODEL) throw new Error("set MODEL, e.g. MODEL=<provider>/<model>:high");
const PROVIDER_EXTENSION = process.env.PROVIDER_EXTENSION ?? "";
const SAMPLE = Number(process.env.SAMPLE ?? 200);
const PER_PROJECT_CAP = Number(process.env.PER_PROJECT_CAP ?? 40);
const PARALLEL = Number(process.env.PARALLEL ?? 6);
const GRADES = join(DATA, "grades.jsonl");

type Injection = { key: string; project: string; prompt: string; primer: string; primerChars: number; notes: { trust: string; id: string }[]; after: string };
type NoteGrade = { id: string; relevant: boolean; used: boolean; misleading: boolean; why: string };
type Grade = { key: string; project: string; primerChars: number; noteCount: number; needed: "yes" | "no" | "unclear"; notes: NoteGrade[]; savedWork: "yes" | "no" | "unclear"; summary: string; cost: number; ms: number; error?: string };

const SYSTEM = `You grade one memory injection from a real coding-agent session. You are strict and independent.

You get: the user's request, the memory notes that were injected before the agent answered, and the start of the agent's work afterwards.

Answer with a single JSON object and nothing else:
{
  "needed": "yes" | "no" | "unclear",
  "notes": [{ "id": "<note id>", "relevant": bool, "used": bool, "misleading": bool, "why": "<12 words max>" }],
  "savedWork": "yes" | "no" | "unclear",
  "summary": "<20 words max>"
}

Definitions:
- needed: would a capable agent with no memory plausibly need facts from earlier sessions to do this request well? "no" for self-contained requests (a pasted task with everything included, general questions, trivial chat).
- relevant: the note bears on this specific request. A note from another project counts as relevant if its content applies here. Being from another project is never by itself a reason to mark it irrelevant.
- used: the agent's work visibly reflects the note: it follows its instruction, reuses its fact, cites it, or avoids the pitfall it names. Doing something the request already said does not count.
- misleading: the note pushed or could push the agent toward something wrong or outdated for this request.
- savedWork: did the injected memory plausibly save the agent investigation, a wrong turn, or a question to the user? "no" if nothing was used.

Judge only from the text given. Do not reward length.`;

function load(): Injection[] {
  return readFileSync(join(DATA, "injections.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

function seededShuffle<T>(items: T[], seed: number): T[] {
  const out = [...items];
  let state = seed;
  for (let index = out.length - 1; index > 0; index--) {
    state = (state * 1103515245 + 12345) % 2147483648;
    const pick = state % (index + 1);
    [out[index], out[pick]] = [out[pick], out[index]];
  }
  return out;
}

function sample(all: Injection[]): Injection[] {
  const keysFile = process.env.KEYS_FILE;
  if (keysFile) {
    const keys = new Set(readFileSync(keysFile, "utf8").split("\n").filter(Boolean));
    return all.filter((row) => keys.has(row.key));
  }
  const usable = all.filter((row) => row.prompt && row.after && row.notes.length > 0);
  const byProject = new Map<string, Injection[]>();
  for (const row of seededShuffle(usable, 21)) byProject.set(row.project, [...(byProject.get(row.project) ?? []), row]);
  const picked: Injection[] = [];
  for (const rows of byProject.values()) picked.push(...rows.slice(0, PER_PROJECT_CAP));
  return seededShuffle(picked, 2121).slice(0, SAMPLE);
}

function prompt(row: Injection): string {
  return [
    "USER REQUEST:",
    row.prompt,
    "",
    "INJECTED MEMORY:",
    row.primer,
    "",
    "AGENT WORK AFTERWARDS (truncated):",
    row.after,
  ].join("\n");
}

function parse(text: string): Omit<Grade, "key" | "project" | "primerChars" | "noteCount" | "cost" | "ms"> | undefined {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return undefined;
  try {
    return JSON.parse(match[0]);
  } catch {
    return undefined;
  }
}

function gradeOne(row: Injection): Promise<Grade> {
  const args = ["-p", "--no-session", "-nt", "-ne", ...(PROVIDER_EXTENSION ? ["-e", PROVIDER_EXTENSION] : []), "--no-mcp", "-ns", "-nc", "-np", "--mode", "json", "--model", MODEL, "--system-prompt", SYSTEM, prompt(row)];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("pi", args, { cwd: DATA, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const killer = setTimeout(() => child.kill("SIGKILL"), 300_000);
    child.on("close", () => {
      clearTimeout(killer);
      const turns = stdout.split("\n").filter(Boolean).flatMap((line) => {
        try {
          const event = JSON.parse(line);
          return event.type === "turn_end" ? [event.message] : [];
        } catch {
          return [];
        }
      });
      const cost = turns.reduce((sum, message) => sum + (message?.usage?.cost?.total ?? 0), 0);
      const answer = turns.flatMap((message) => (message?.content ?? []).filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text)).join("\n");
      const parsed = parse(answer);
      const base = { key: row.key, project: row.project, primerChars: row.primerChars, noteCount: row.notes.length, cost, ms: Date.now() - started };
      resolve(parsed ? { ...base, ...parsed } : { ...base, needed: "unclear", notes: [], savedWork: "unclear", summary: "", error: (answer || stderr).slice(-300) || "no answer" });
    });
  });
}

const done = new Set(existsSync(GRADES) ? readFileSync(GRADES, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line).key) : []);
const jobs = sample(load()).filter((row) => !done.has(row.key));
writeFileSync(join(DATA, "sample-size.txt"), String(jobs.length + done.size));
let next = 0;
let finished = 0;
async function worker() {
  while (next < jobs.length) {
    const row = jobs[next++];
    const grade = await gradeOne(row);
    appendFileSync(GRADES, JSON.stringify(grade) + "\n");
    finished++;
    console.log(`${finished}/${jobs.length} ${row.project} needed=${grade.needed} saved=${grade.savedWork} $${grade.cost.toFixed(4)}${grade.error ? " ERROR" : ""}`);
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
