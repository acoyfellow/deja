import { spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CASES, NOTES } from "./cases.ts";
import { passes } from "./checks.ts";

const here = import.meta.dir;
const MODEL = process.env.MODEL ?? "";
if (!MODEL) throw new Error("set MODEL, e.g. MODEL=<provider>/<model>:low");
const REPS = Number(process.env.REPS ?? 3);
const PARALLEL = Number(process.env.PARALLEL ?? 6);
const PROVIDER_EXTENSION = process.env.PROVIDER_EXTENSION ?? "";

type Delivered = { id: string; arm: string; ids: string[] };
const delivered = (JSON.parse(readFileSync(join(here, "deliveries.json"), "utf8")) as { rows: Delivered[] }).rows.filter((row) => row.arm === "primer");
const textOf = new Map(NOTES.map((note) => [note.key, note.text]));

const SYSTEM = [
  "You are a coding agent working in the project named in the request.",
  "Answer concisely with the exact commands, names or facts the user needs.",
  "If a project-specific fact is unknown to you, say so instead of guessing.",
].join(" ");

function memoryBlock(caseId: string): string {
  const c = CASES.find((entry) => entry.id === caseId)!;
  const ids = delivered.find((row) => row.id === caseId)?.ids ?? [];
  const parts: string[] = [];
  if (c.handoff) parts.push(`Handoff from the previous session: ${c.handoff.summary} Next: ${c.handoff.next.join("; ")}.`);
  for (const id of ids) parts.push(`- (from: ${NOTES.find((note) => note.key === id)?.scope}) ${textOf.get(id)}`);
  if (parts.length === 0) return "";
  return ["Deja memory: notes from earlier sessions that match this request.", "Treat them as leads, not truth.", "", ...parts].join("\n");
}

type Run = { id: string; family: string; split: string; arm: "off" | "on"; rep: number; pass: boolean | undefined; input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; ms: number; answer: string; error?: string };

function runOnce(caseId: string, arm: "off" | "on", rep: number): Promise<Run> {
  const c = CASES.find((entry) => entry.id === caseId)!;
  const memory = arm === "on" ? memoryBlock(caseId) : "";
  const prompt = `${memory ? `${memory}\n\n` : ""}Project: ${c.scope.replace("proj-", "")}\nRequest: ${c.prompt}`;
  const args = ["-p", "--no-session", "-nt", "-ne", ...(PROVIDER_EXTENSION ? ["-e", PROVIDER_EXTENSION] : []), "--no-mcp", "-ns", "-nc", "-np", "--mode", "json", "--model", MODEL, "--system-prompt", SYSTEM, prompt];
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn("pi", args, { cwd: here, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    const killer = setTimeout(() => child.kill("SIGKILL"), 180_000);
    child.on("close", () => {
      clearTimeout(killer);
      const ms = Date.now() - started;
      const turns = stdout.split("\n").filter(Boolean).flatMap((line) => {
        try {
          const event = JSON.parse(line);
          return event.type === "turn_end" ? [event.message] : [];
        } catch {
          return [];
        }
      });
      const usage = turns.reduce((sum, message) => {
        const u = message?.usage ?? {};
        return { input: sum.input + (u.input ?? 0), output: sum.output + (u.output ?? 0), cacheRead: sum.cacheRead + (u.cacheRead ?? 0), cacheWrite: sum.cacheWrite + (u.cacheWrite ?? 0), cost: sum.cost + (u.cost?.total ?? 0) };
      }, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
      const answer = turns.flatMap((message) => (message?.content ?? []).filter((part: { type: string }) => part.type === "text").map((part: { text: string }) => part.text)).join("\n");
      resolve({ id: caseId, family: c.family, split: c.split, arm, rep, pass: answer ? passes(caseId, answer) : false, ...usage, ms, answer, error: answer ? undefined : stderr.slice(-300) || "no answer" });
    });
  });
}

const jobs: Array<() => Promise<Run>> = [];
for (let rep = 0; rep < REPS; rep++) for (const c of CASES) for (const arm of ["off", "on"] as const) jobs.push(() => runOnce(c.id, arm, rep));

const results: Run[] = [];
let next = 0;
async function worker() {
  while (next < jobs.length) {
    const job = jobs[next++];
    const run = await job();
    results.push(run);
    process.stderr.write(`${results.length}/${jobs.length} ${run.arm} ${run.id} pass=${run.pass} $${run.cost.toFixed(4)} ${run.ms}ms${run.error ? ` ERR ${run.error.slice(0, 80)}` : ""}\n`);
  }
}
await Promise.all(Array.from({ length: PARALLEL }, worker));
const out = join(here, `agent-runs-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(out, JSON.stringify({ model: MODEL, reps: REPS, system: SYSTEM, results }, null, 2));
console.log(out);
