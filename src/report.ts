import type { Database } from "bun:sqlite";

export interface ReportOptions {
  sinceMs: number;
  nowMs: number;
  showQueries: boolean;
  automatedPrefixes: readonly string[];
}

export const DEFAULT_AUTOMATED_PREFIXES = [
  "READ-ONLY",
  "You are a Terrarium child",
  "Reply with exactly",
  "Do nothing",
  "From the coordinator",
  "<file name=\"/var/folders/",
];

export interface AuthorRow {
  author: string;
  recalls: number;
  withHits: number;
  hits: number;
}

export interface NoteRow {
  id: string;
  text: string;
  shown: number;
  used: number;
  wrong: number;
}

export interface MemoryReport {
  window: { sinceMs: number; nowMs: number };
  recalls: { total: number; withHits: number; empty: number; automated: number; hitsShown: number };
  grading: { notesShown: number; notesUsed: number; notesWrong: number; usedShare: number };
  assessed: { total: number; useful: number; wrong: number; missed: number; noMemoryNeeded: number };
  byAuthor: AuthorRow[];
  bank: { kept: number; drafts: number; expired: number; keptNeverUsed: number; keptStale: number; staleDays: number };
  mostShownNeverUsed: NoteRow[];
  mostUsed: NoteRow[];
  sampleQueries: { query: string; hits: number }[];
}

const STALE_DAYS = 60;
const DAY_MS = 86_400_000;

function isAutomated(query: string, prefixes: readonly string[]): boolean {
  const lowered = query.trimStart().toLowerCase();
  return prefixes.some((prefix) => lowered.startsWith(prefix.toLowerCase()));
}

function redactQuery(query: string): string {
  const words = query.trim().split(/\s+/).filter(Boolean).length;
  return `(${words} word${words === 1 ? "" : "s"}, hidden; use --show-queries)`;
}

export function buildReport(db: Database, options: ReportOptions): MemoryReport {
  const traces = db
    .prepare(`SELECT authored_by, query, hit_ids, assessment FROM recall_traces WHERE created_at >= ? AND created_at <= ? ORDER BY created_at DESC`)
    .all(options.sinceMs, options.nowMs) as Array<{ authored_by: string; query: string; hit_ids: string; assessment: string | null }>;

  const authors = new Map<string, AuthorRow>();
  const shownCount = new Map<string, number>();
  let withHits = 0;
  let automated = 0;
  let hitsShown = 0;
  const assessed = { total: 0, useful: 0, wrong: 0, missed: 0, noMemoryNeeded: 0 };
  for (const trace of traces) {
    const ids = parseIds(trace.hit_ids);
    const row = authors.get(trace.authored_by) ?? { author: trace.authored_by, recalls: 0, withHits: 0, hits: 0 };
    row.recalls++;
    row.hits += ids.length;
    if (ids.length > 0) {
      row.withHits++;
      withHits++;
    }
    authors.set(trace.authored_by, row);
    hitsShown += ids.length;
    if (isAutomated(trace.query, options.automatedPrefixes)) automated++;
    for (const id of ids) shownCount.set(id, (shownCount.get(id) ?? 0) + 1);
    if (trace.assessment) {
      assessed.total++;
      if (trace.assessment === "useful") assessed.useful++;
      if (trace.assessment === "wrong") assessed.wrong++;
      if (trace.assessment === "missed") assessed.missed++;
      if (trace.assessment === "no_memory_needed") assessed.noMemoryNeeded++;
    }
  }

  const shownIds = [...shownCount.keys()];
  const notes = shownIds.length === 0 ? [] : (db
    .prepare(`SELECT id, text, used_count, wrong_count FROM slips WHERE id IN (SELECT value FROM json_each(?))`)
    .all(JSON.stringify(shownIds)) as Array<{ id: string; text: string; used_count: number; wrong_count: number }>)
    .map((slip): NoteRow => ({ id: slip.id, text: slip.text, shown: shownCount.get(slip.id) ?? 0, used: slip.used_count, wrong: slip.wrong_count }));
  const notesUsed = notes.filter((note) => note.used > 0).length;
  const notesWrong = notes.filter((note) => note.wrong > 0).length;

  const staleCutoff = options.nowMs - STALE_DAYS * DAY_MS;
  const bank = db
    .prepare(`SELECT
        SUM(state = 'kept') kept,
        SUM(state = 'draft') drafts,
        SUM(state = 'expired') expired,
        SUM(state = 'kept' AND used_count = 0) kept_never_used,
        SUM(state = 'kept' AND used_count = 0 AND created_at < ?) kept_stale
      FROM slips`)
    .get(staleCutoff) as Record<string, number | null>;

  return {
    window: { sinceMs: options.sinceMs, nowMs: options.nowMs },
    recalls: { total: traces.length, withHits, empty: traces.length - withHits, automated, hitsShown },
    grading: { notesShown: notes.length, notesUsed, notesWrong, usedShare: notes.length === 0 ? 0 : notesUsed / notes.length },
    assessed,
    byAuthor: [...authors.values()].sort((a, b) => b.recalls - a.recalls),
    bank: {
      kept: bank.kept ?? 0,
      drafts: bank.drafts ?? 0,
      expired: bank.expired ?? 0,
      keptNeverUsed: bank.kept_never_used ?? 0,
      keptStale: bank.kept_stale ?? 0,
      staleDays: STALE_DAYS,
    },
    mostShownNeverUsed: notes.filter((note) => note.used === 0).sort((a, b) => b.shown - a.shown).slice(0, 10),
    mostUsed: notes.filter((note) => note.used > 0).sort((a, b) => b.used - a.used).slice(0, 10),
    sampleQueries: traces.slice(0, 15).map((trace) => ({
      query: options.showQueries ? trace.query.replace(/\s+/g, " ").slice(0, 100) : redactQuery(trace.query),
      hits: parseIds(trace.hit_ids).length,
    })),
  };
}

function parseIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "0%" : `${Math.round((100 * part) / whole)}%`;
}

export function findings(report: MemoryReport): string[] {
  const out: string[] = [];
  const { recalls, grading, bank } = report;
  if (recalls.total === 0) return ["No recalls recorded in this window. Is anything calling Deja, or is tracing off (--no-trace)?"];
  if (recalls.automated / recalls.total > 0.3) out.push(`${percent(recalls.automated, recalls.total)} of recalls came from bots or tests. Skip them before recalling so they stop inflating every number.`);
  if (recalls.empty / recalls.total > 0.5) out.push(`${percent(recalls.empty, recalls.total)} of recalls found nothing. Either the bank lacks notes for this work or queries are too vague.`);
  if (grading.notesShown > 0 && grading.notesUsed === 0) out.push("No recalled note has ever been marked used. Nothing is grading memory, so you cannot tell if it helps. Wire `deja signal <id> used` or the MCP signal tool into your agent.");
  else if (grading.notesShown > 0 && grading.usedShare < 0.1) out.push(`Only ${percent(grading.notesUsed, grading.notesShown)} of recalled notes were marked used. Recall is probably surfacing weak matches; add a relevance check before injecting (the Pi primer uses Clef for this).`);
  if (bank.kept > 0 && bank.keptStale / bank.kept > 0.4) out.push(`${percent(bank.keptStale, bank.kept)} of kept notes are over ${bank.staleDays} days old and never used. Review them with \`deja ls\` and forget the dead ones.`);
  if (report.mostShownNeverUsed[0] && report.mostShownNeverUsed[0].shown >= 5) out.push(`One note came up in ${report.mostShownNeverUsed[0].shown} recalls and was never used (${report.mostShownNeverUsed[0].id}). It matches too broadly; rewrite or forget it.`);
  if (out.length === 0) out.push("No obvious problems in this window.");
  return out;
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" })[char] ?? char);
}

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function reportText(report: MemoryReport): string {
  const { recalls, grading, bank, assessed } = report;
  const lines = [
    `Deja memory report, ${day(report.window.sinceMs)} to ${day(report.window.nowMs)}`,
    "",
    `recalls            ${recalls.total} (${recalls.withHits} found notes, ${recalls.empty} empty, ${recalls.automated} from bots/tests)`,
    `notes recalled     ${grading.notesShown} distinct, ${recalls.hitsShown} times in total (a filter like the Pi primer may inject fewer)`,
    `marked used        ${grading.notesUsed} of those notes (${percent(grading.notesUsed, grading.notesShown)})`,
    `marked wrong       ${grading.notesWrong}`,
    `recalls assessed   ${assessed.total} (useful ${assessed.useful}, wrong ${assessed.wrong}, missed ${assessed.missed})`,
    `bank               ${bank.kept} kept, ${bank.drafts} drafts, ${bank.keptStale} kept notes over ${bank.staleDays} days old and never used`,
    "",
    "who recalls:",
    ...report.byAuthor.slice(0, 8).map((row) => `  ${row.author.padEnd(28)} ${String(row.recalls).padStart(5)} recalls, ${percent(row.withHits, row.recalls)} found notes`),
    "",
    "findings:",
    ...findings(report).map((line) => `  - ${line}`),
  ];
  return lines.join("\n");
}

export function reportHtml(report: MemoryReport): string {
  const { recalls, grading, bank } = report;
  const card = (value: string | number, label: string, tone = "") => `<div class="fs"><b class="${tone}">${value}</b><small>${escapeHtml(label)}</small></div>`;
  const noteRows = (rows: NoteRow[]) => rows.map((row) => `<tr><td class="m">${row.id.slice(0, 10)}</td><td>${escapeHtml(row.text.replace(/\s+/g, " ").slice(0, 110))}</td><td class="r">${row.shown}</td><td class="r">${row.used}</td></tr>`).join("");
  const authorRows = report.byAuthor.slice(0, 12).map((row) => `<tr><td>${escapeHtml(row.author)}</td><td class="r">${row.recalls}</td><td class="r">${percent(row.withHits, row.recalls)}</td></tr>`).join("");
  const queryRows = report.sampleQueries.map((row) => `<tr><td>${escapeHtml(row.query)}</td><td class="r">${row.hits}</td></tr>`).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Deja memory report</title><style>
body{margin:0;background:#0b1118;color:#f7f9fb;font:15px/1.5 system-ui,sans-serif}main{max-width:1100px;margin:0 auto;padding:32px 24px 60px}
h1{font-size:28px;margin:0 0 4px}h2{font-size:19px;margin:28px 0 10px}.sub{color:#9baaba;margin:0 0 20px}
.funnel{display:grid;grid-template-columns:repeat(5,1fr);gap:8px}.fs{background:#182431;border-radius:10px;padding:14px}.fs b{display:block;font-size:26px}.fs small{color:#9baaba}
.ok{color:#63d5a2}.warn{color:#f7b53b}.bad{color:#ff7d68}.card{background:#111a24;border:1px solid rgba(174,196,216,.14);border-radius:12px;padding:16px;margin-top:12px}
table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:#9baaba;font-weight:500;padding:6px;border-bottom:1px solid rgba(174,196,216,.2)}td{padding:6px;border-top:1px solid rgba(174,196,216,.08);vertical-align:top}.r{text-align:right;font-family:ui-monospace,monospace}.m{font-family:ui-monospace,monospace;color:#9baaba}
ul.f li{margin:8px 0}.grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
</style></head><body><main>
<h1>Deja memory report</h1>
<p class="sub">${day(report.window.sinceMs)} to ${day(report.window.nowMs)} · generated by <code>deja report</code> from your local Deja database only</p>
<div class="funnel">
${card(recalls.total, "recalls")}
${card(recalls.withHits, "found at least one note")}
${card(grading.notesShown, "distinct notes recalled")}
${card(grading.notesUsed, `marked used (${percent(grading.notesUsed, grading.notesShown)})`, grading.notesUsed === 0 ? "bad" : grading.usedShare < 0.1 ? "warn" : "ok")}
${card(recalls.automated, "recalls from bots or tests", recalls.automated / Math.max(1, recalls.total) > 0.3 ? "warn" : "")}
</div>
<h2>Findings</h2><div class="card"><ul class="f">${findings(report).map((line) => `<li>${escapeHtml(line)}</li>`).join("")}</ul></div>
<div class="grid">
<div class="card"><h2 style="margin-top:0">Who recalls</h2><table><tr><th>author</th><th class="r">recalls</th><th class="r">found notes</th></tr>${authorRows}</table></div>
<div class="card"><h2 style="margin-top:0">The bank</h2><table>
<tr><td>kept notes</td><td class="r">${bank.kept}</td></tr><tr><td>drafts (expire in 24h unless kept)</td><td class="r">${bank.drafts}</td></tr>
<tr><td>kept, never used</td><td class="r">${bank.keptNeverUsed}</td></tr><tr><td>kept, never used, over ${bank.staleDays} days old</td><td class="r">${bank.keptStale}</td></tr></table></div>
</div>
<h2>Recalled most, never used</h2><div class="card"><table><tr><th>id</th><th>note</th><th class="r">recalled</th><th class="r">used</th></tr>${noteRows(report.mostShownNeverUsed)}</table></div>
<h2>Most used</h2><div class="card"><table><tr><th>id</th><th>note</th><th class="r">recalled</th><th class="r">used</th></tr>${noteRows(report.mostUsed)}</table></div>
<h2>Latest recalls</h2><div class="card"><table><tr><th>query</th><th class="r">notes found</th></tr>${queryRows}</table></div>
</main></body></html>`;
}
