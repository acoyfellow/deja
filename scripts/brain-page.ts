import { Database } from "bun:sqlite";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildReport, DEFAULT_AUTOMATED_PREFIXES, formatCount, reportHtml } from "../src/report.ts";

interface MetricsRow {
  sessionId: string;
  endedAt: string;
  arm?: string;
  compactArm?: string;
  turns: number;
  cost: number;
  cacheRead: number;
  cacheWrite: number;
  turnsOver200k?: number;
  spills?: number;
  toolErrors?: number;
  memoryInjections?: number;
  memoryUsed?: number;
}

interface ArmTotals {
  sessions: number;
  turns: number;
  cost: number;
  errors: number;
  spills: number;
  cacheRead: number;
  cacheWrite: number;
}

const DAY_MS = 86_400_000;
const outPath = process.argv[2] ?? "/private/tmp/deja-report.html";
const jsonPath = process.argv[3];
const abSince = process.env.BRAIN_AB_SINCE ?? "2026-11-04T22:16";
const abField = (process.env.BRAIN_AB_FIELD ?? "compactArm") as "arm" | "compactArm";
const frugalDir = process.env.PI_FRUGAL_DIR ?? join(homedir(), ".pi", "agent", "frugal");
const nowMs = Date.now();

const rows: MetricsRow[] = readFileSync(join(frugalDir, "metrics.jsonl"), "utf8")
  .split("\n")
  .flatMap((line) => {
    if (!line) return [];
    try {
      return [JSON.parse(line) as MetricsRow];
    } catch {
      return [];
    }
  });

function money(value: number, digits = 2): string {
  return `$${value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

function pct(part: number, whole: number): string {
  return whole ? `${Math.round((100 * part) / whole).toLocaleString("en-US")}%` : "–";
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char] ?? char);
}

function armTotals(arm: string): ArmTotals {
  const armRows = rows.filter((row) => row[abField] === arm && row.endedAt >= abSince && row.turns > 0);
  return {
    sessions: new Set(armRows.map((row) => row.sessionId)).size,
    turns: armRows.reduce((sum, row) => sum + row.turns, 0),
    cost: armRows.reduce((sum, row) => sum + row.cost, 0),
    errors: armRows.reduce((sum, row) => sum + (row.toolErrors ?? 0), 0),
    spills: armRows.reduce((sum, row) => sum + (row.spills ?? 0), 0),
    cacheRead: armRows.reduce((sum, row) => sum + row.cacheRead, 0),
    cacheWrite: armRows.reduce((sum, row) => sum + row.cacheWrite, 0),
  };
}

function dailySpend(days: number): { day: string; cost: number; turns: number; over200k: number }[] {
  const byDay = new Map<string, { cost: number; turns: number; over200k: number }>();
  for (const row of rows) {
    const day = row.endedAt.slice(0, 10);
    if (day < new Date(nowMs - days * DAY_MS).toISOString().slice(0, 10)) continue;
    const entry = byDay.get(day) ?? { cost: 0, turns: 0, over200k: 0 };
    entry.cost += row.cost;
    entry.turns += row.turns;
    entry.over200k += row.turnsOver200k ?? 0;
    byDay.set(day, entry);
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, entry]) => ({ day, ...entry }));
}

function topSessionsToday(): { sessionId: string; cost: number }[] {
  const today = new Date(nowMs).toISOString().slice(0, 10);
  const bySession = new Map<string, number>();
  for (const row of rows) if (row.endedAt.startsWith(today)) bySession.set(row.sessionId, (bySession.get(row.sessionId) ?? 0) + row.cost);
  return [...bySession.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([sessionId, cost]) => ({ sessionId, cost }));
}

const on = armTotals("on");
const off = armTotals("off");
const perTurn = (totals: ArmTotals) => (totals.turns ? totals.cost / totals.turns : 0);
const enough = on.sessions >= 20 && off.sessions >= 20 && on.turns >= 500 && off.turns >= 500;
const saving = perTurn(off) ? (perTurn(off) - perTurn(on)) / perTurn(off) : 0;
const verdict = !enough ? "collecting" : saving > 0 && on.errors / on.turns <= off.errors / off.turns ? "on wins" : "on loses";

const abRow = (label: string, totals: ArmTotals) =>
  `<tr><td>${label}</td><td class="r">${formatCount(totals.sessions)}</td><td class="r">${formatCount(totals.turns)}</td><td class="r">${money(totals.cost)}</td><td class="r">${money(perTurn(totals), 3)}</td><td class="r">${pct(totals.cacheRead, totals.cacheRead + totals.cacheWrite)}</td><td class="r">${formatCount(totals.spills)}</td><td class="r">${totals.turns ? (totals.errors / totals.turns).toLocaleString("en-US", { maximumFractionDigits: 3 }) : "–"}</td></tr>`;
const spendRows = dailySpend(7)
  .map((day) => `<tr><td>${day.day}</td><td class="r">${money(day.cost)}</td><td class="r">${formatCount(day.turns)}</td><td class="r">${money(day.turns ? day.cost / day.turns : 0, 3)}</td><td class="r">${pct(day.over200k, day.turns)}</td></tr>`)
  .join("");
const topRows = topSessionsToday()
  .map((row) => `<tr><td class="m">${escapeHtml(row.sessionId.slice(0, 13))}</td><td class="r">${money(row.cost)}</td></tr>`)
  .join("");

const db = new Database(join(homedir(), ".deja", "deja.db"), { readonly: true });
const memory = reportHtml(buildReport(db, { sinceMs: nowMs - 14 * DAY_MS, nowMs, showQueries: false, automatedPrefixes: DEFAULT_AUTOMATED_PREFIXES }));
db.close();

const brainSection = `<h1>Brain loop</h1>
<p class="sub">Updated ${new Date(nowMs).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short" })} · compact-at-200k A/B since ${escapeHtml(abSince)} · verdict: <b class="${verdict === "on wins" ? "ok" : verdict === "on loses" ? "bad" : "warn"}">${verdict}</b>${enough ? ` (${Math.round(saving * 100).toLocaleString("en-US")}% per turn)` : " (needs 20 sessions and 500 turns per arm)"}</p>
<h2>Compact at 200k A/B (spill on for all)</h2><div class="card"><table><tr><th>arm</th><th class="r">sessions</th><th class="r">turns</th><th class="r">cost</th><th class="r">per turn</th><th class="r">cache hit</th><th class="r">spills</th><th class="r">errors/turn</th></tr>${abRow("on", on)}${abRow("off", off)}</table></div>
<h2>Spend, last 7 days</h2><div class="card"><table><tr><th>day</th><th class="r">cost</th><th class="r">turns</th><th class="r">per turn</th><th class="r">turns over 200k</th></tr>${spendRows}</table></div>
<h2>Top sessions today</h2><div class="card"><table><tr><th>session</th><th class="r">cost</th></tr>${topRows}</table></div>
<h1 style="margin-top:40px">Memory</h1>`;

const page = memory
  .replace("<title>Deja memory report</title>", `<title>Brain loop</title><meta http-equiv="refresh" content="60">`)
  .replace("<main>", `<main>${brainSection}`);
const tmp = `${outPath}.tmp`;
writeFileSync(tmp, page);
renameSync(tmp, outPath);

interface BrainSnapshot {
  at: string;
  experiment: { name: string; since: string; verdict: string; on: ArmTotals; off: ArmTotals; enough: boolean; savingPct: number };
  spendToday: number;
  spendYesterday: number;
  topSessions: { sessionId: string; cost: number }[];
  memory: { usedPct: number; stalePct: number; noisy: number; bots1h: number };
  previous: { name: string; result: string }[];
}

function writeSnapshot(path: string): void {
  const day = (offset: number) => new Date(nowMs - offset * DAY_MS).toISOString().slice(0, 10);
  const spendOn = (date: string) => rows.filter((row) => row.endedAt.startsWith(date)).reduce((sum, row) => sum + row.cost, 0);
  const health = JSON.parse(String(Bun.spawnSync(["bash", join(import.meta.dir, "memory-health-tick.sh"), "--json"]).stdout)) as {
    targets: { usedShare: { used: number; injected: number }; staleKept: { stale: number; kept: number }; noisyNotes: { value: string }; botRecalls1h: { value: string } };
  };
  const snapshot: BrainSnapshot = {
    at: new Date(nowMs).toISOString(),
    experiment: { name: "Compact at 200k", since: abSince, verdict, on, off, enough, savingPct: Math.round(saving * 100) },
    spendToday: spendOn(day(0)),
    spendYesterday: spendOn(day(1)),
    topSessions: topSessionsToday().slice(0, 3),
    memory: {
      usedPct: health.targets.usedShare.injected ? Math.round((100 * health.targets.usedShare.used) / health.targets.usedShare.injected) : 0,
      stalePct: health.targets.staleKept.kept ? Math.round((100 * health.targets.staleKept.stale) / health.targets.staleKept.kept) : 0,
      noisy: Number(health.targets.noisyNotes.value),
      bots1h: Number(health.targets.botRecalls1h.value),
    },
    previous: [{ name: "Spill 10k", result: "not proven: looked 27% cheaper, but p=0.09 and the median session was no cheaper. Left on; tool errors were lower." }],
  };
  writeFileSync(`${path}.tmp`, JSON.stringify(snapshot));
  renameSync(`${path}.tmp`, path);
}

if (jsonPath) writeSnapshot(jsonPath);
