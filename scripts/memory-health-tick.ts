import { Database } from "bun:sqlite";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildReport, DEFAULT_AUTOMATED_PREFIXES } from "../src/report.ts";

const DAY_MS = 86_400_000;
const nowMs = Date.now();
const dbPath = process.env.DEJA_DB ?? join(homedir(), ".deja", "deja.db");
const metricsPath = process.env.FRUGAL_METRICS ?? join(homedir(), ".pi", "agent", "frugal", "metrics.jsonl");

const db = new Database(dbPath, { readonly: true });
const report = buildReport(db, { sinceMs: nowMs - 14 * DAY_MS, nowMs, showQueries: false, automatedPrefixes: DEFAULT_AUTOMATED_PREFIXES });

type MetricRow = { endedAt?: string; memoryInjections?: number; memoryUsed?: number };
const since = new Date(nowMs - DAY_MS).toISOString();
const rows: MetricRow[] = existsSync(metricsPath)
  ? readFileSync(metricsPath, "utf8").split("\n").filter(Boolean).map((line) => {
      try {
        return JSON.parse(line) as MetricRow;
      } catch {
        return {};
      }
    }).filter((row) => (row.endedAt ?? "") >= since)
  : [];
const injected = rows.reduce((sum, row) => sum + (row.memoryInjections ?? 0), 0);
const used = rows.reduce((sum, row) => sum + (row.memoryUsed ?? 0), 0);

const primerSince = Number(process.env.BOT_SINCE_MS ?? nowMs - 3_600_000);
const botRecalls = (db.prepare(`SELECT query FROM recall_traces WHERE authored_by = 'pi/session-primer' AND created_at >= ?`).all(primerSince) as { query: string }[])
  .filter((row) => DEFAULT_AUTOMATED_PREFIXES.some((prefix) => row.query.trimStart().toLowerCase().startsWith(prefix.toLowerCase())) || /^<file name="[^"]*(?:\/var\/folders\/|\/reviews\/recipe\/|\/evals?\/|\/results\/|\/fixtures\/|\/experiments\/)/.test(row.query) || /^(?:Run this bash command:|Finish this small feature and ship it\.)/.test(row.query) || /^Run '[^']*test/.test(row.query)).length;

const botQuery = /^(?:<file name="[^"]*(?:\/var\/folders\/|\/reviews\/recipe\/|\/evals?\/|\/results\/|\/fixtures\/|\/experiments\/)|Run this bash command:|Run '[^']*test|READ-ONLY|You are a Terrarium child|Reply with exactly|Do nothing|From the coordinator|Finish this small feature and ship it\.)/i;
const humanHits = new Map<string, number>();
for (const trace of db.prepare(`SELECT authored_by, query, hit_ids FROM recall_traces WHERE created_at >= ?`).all(nowMs - 14 * DAY_MS) as { authored_by: string; query: string; hit_ids: string }[]) {
  if (trace.authored_by.includes("replay") || botQuery.test(trace.query.trimStart())) continue;
  for (const id of JSON.parse(trace.hit_ids) as string[]) humanHits.set(id, (humanHits.get(id) ?? 0) + 1);
}
const noisy = [...humanHits]
  .filter(([, shown]) => shown >= 20)
  .map(([id, shown]) => ({ id, shown, ...(db.prepare(`SELECT text, used_count FROM slips WHERE id = ? AND state = 'kept' AND NOT EXISTS (SELECT 1 FROM links WHERE to_id = slips.id AND kind = 'supersedes')`).get(id) as { text: string; used_count: number } | undefined ?? { text: "", used_count: -1 }) }))
  .filter((note) => note.used_count === 0)
  .sort((a, b) => b.shown - a.shown);
const staleShare = report.bank.kept === 0 ? 0 : report.bank.keptStale / report.bank.kept;
const usedShare = injected === 0 ? 0 : used / injected;

const targets = {
  usedShare: { value: `${used}/${injected} = ${(usedShare * 100).toFixed(0)}%`, pass: injected > 0 && usedShare >= 0.3 },
  botRecalls1h: { value: String(botRecalls), pass: botRecalls === 0 },
  staleKept: { value: `${report.bank.keptStale}/${report.bank.kept} = ${(staleShare * 100).toFixed(0)}%`, pass: staleShare < 0.2 },
  noisyNotes: { value: String(noisy.length), pass: noisy.length === 0 },
};

const keepPath = join(import.meta.dir, "..", ".tmp", "keep-ids.txt");
const keepIds = new Set(existsSync(keepPath) ? readFileSync(keepPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean) : []);
const staleRows = (db.prepare(`SELECT id, created_at, text FROM slips WHERE state = 'kept' AND used_count = 0 AND created_at < ? ORDER BY created_at ASC LIMIT 200`).all(nowMs - 60 * DAY_MS) as { id: string; created_at: number; text: string }[])
  .filter((note) => !keepIds.has(note.id))
  .slice(0, 25);
if (process.argv.includes("--json")) {
  console.log(JSON.stringify({
    at: new Date(nowMs).toISOString(),
    allPass: Object.values(targets).every((target) => target.pass),
    targets: {
      usedShare: { ...targets.usedShare, used, injected, goal: ">= 30%" },
      botRecalls1h: { ...targets.botRecalls1h, goal: "0" },
      staleKept: { ...targets.staleKept, stale: report.bank.keptStale, kept: report.bank.kept, goal: "< 20%" },
      noisyNotes: { ...targets.noisyNotes, goal: "0" },
    },
    bank: report.bank,
    recalls14d: report.recalls,
    noisy: noisy.slice(0, 5).map((note) => ({ id: note.id, recalled: note.shown, text: note.text.replace(/\s+/g, " ").slice(0, 100) })),
    nextStale: staleRows.slice(0, 5).map((note) => ({ id: note.id, date: new Date(note.created_at).toISOString().slice(0, 10), text: note.text.replace(/\s+/g, " ").slice(0, 100) })),
  }));
  db.close();
  process.exit(0);
}
console.log(`memory-health ${new Date(nowMs).toISOString()}`);
for (const [name, target] of Object.entries(targets)) console.log(`${target.pass ? "PASS" : "FAIL"} ${name.padEnd(14)} ${target.value}`);
console.log(`ALL ${Object.values(targets).every((target) => target.pass) ? "PASS" : "FAIL"}`);
console.log("noisy (recalled >=20x in 14d by real prompts, never used):");
for (const note of noisy) console.log(`  ${note.id} x${note.shown}  ${note.text.replace(/\s+/g, " ").slice(0, 80)}`);
const stale = db.prepare(`SELECT id, created_at, text FROM slips WHERE state = 'kept' AND used_count = 0 AND created_at < ? ORDER BY created_at ASC LIMIT 25`).all(nowMs - 60 * DAY_MS) as { id: string; created_at: number; text: string }[];
console.log("oldest stale kept (first 25):");
for (const note of stale) console.log(`  ${note.id} ${new Date(note.created_at).toISOString().slice(0, 10)}  ${note.text.replace(/\s+/g, " ").slice(0, 80)}`);
db.close();
