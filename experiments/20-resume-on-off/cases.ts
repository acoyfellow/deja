export type NoteSeed = {
  key: string;
  text: string;
  scope: string;
  kind?: "note" | "decision" | "pitfall";
  supersedes?: string;
};

export type ResumeCase = {
  id: string;
  split: "dev" | "heldout";
  family: "resume" | "reuse" | "reject" | "none";
  scope: string;
  prompt: string;
  handoff?: { summary: string; next: string[] };
  needed: string[];
  forbidden: string[];
};

export const NOTES: NoteSeed[] = [
  { key: "a-runner", scope: "proj-ledger", kind: "decision", text: "ledger: tests run with vitest, not jest. Run `npm run test:unit` for the fast suite; the full suite needs the local Postgres container." },
  { key: "a-migr-old", scope: "proj-ledger", kind: "decision", text: "ledger: database migrations are applied with `knex migrate:latest` from the repo root." },
  { key: "a-migr-new", scope: "proj-ledger", kind: "decision", supersedes: "a-migr-old", text: "ledger: migrations moved to drizzle. Apply them with `npm run db:migrate`; knex was removed in the September cleanup." },
  { key: "a-flaky", scope: "proj-ledger", kind: "pitfall", text: "ledger: the invoice rounding test fails when TZ is not UTC. Run tests with TZ=UTC before calling it a regression." },
  { key: "a-goal", scope: "proj-ledger", text: "ledger: current goal is the refund export. CSV columns are fixed by finance: id, amount_cents, currency, refunded_at. Do not add columns without asking." },
  { key: "b-deploy", scope: "proj-atlas", kind: "decision", text: "atlas: deploy with `wrangler deploy --env staging` first, check /health returns 200, then promote. Never deploy straight to production." },
  { key: "b-cache", scope: "proj-atlas", kind: "pitfall", text: "atlas: tile responses were stale because the cache key ignored the style version. Fix: include style_version in the cache key." },
  { key: "b-runner", scope: "proj-atlas", kind: "decision", text: "atlas: tests run with bun test. Do not add vitest to this repo." },
  { key: "b-auth", scope: "proj-atlas", text: "atlas: the admin API sits behind Access. Local calls need `cloudflared access curl`, not a bearer token." },
  { key: "c-style", scope: "proj-notes", text: "notes app: the owner wants plain copy with no exclamation marks and no emoji in UI strings." },
  { key: "c-sync", scope: "proj-notes", kind: "pitfall", text: "notes app: sync conflicts came from two tabs writing the same IndexedDB store. Fix: take a Web Lock around the writer." },
  { key: "c-old-db", scope: "proj-notes", kind: "decision", text: "notes app: store notes in localStorage as one JSON blob." },
  { key: "c-new-db", scope: "proj-notes", kind: "decision", supersedes: "c-old-db", text: "notes app: notes moved from localStorage to IndexedDB, one record per note, because the single blob hit the 5 MB quota." },
  { key: "x-shell", scope: "proj-misc", text: "The owner uses macOS with zsh and Homebrew." },
];

export const CASES: ResumeCase[] = [
  {
    id: "ledger-resume-refund", split: "dev", family: "resume", scope: "proj-ledger",
    prompt: "picking the refund export back up, where were we and what should the CSV contain",
    handoff: { summary: "Refund export half done: query written, CSV writer not started.", next: ["write the CSV writer", "add a test for an empty refund list"] },
    needed: ["a-goal"], forbidden: ["b-deploy", "c-style"],
  },
  {
    id: "ledger-migrate", split: "dev", family: "reject", scope: "proj-ledger",
    prompt: "how do I apply the database migrations in ledger before running the tests",
    needed: ["a-migr-new"], forbidden: ["a-migr-old"],
  },
  {
    id: "ledger-rounding", split: "dev", family: "reuse", scope: "proj-ledger",
    prompt: "the invoice rounding test is failing on my machine, is this a real regression",
    needed: ["a-flaky"], forbidden: [],
  },
  {
    id: "atlas-stale-tiles", split: "dev", family: "reuse", scope: "proj-atlas",
    prompt: "users report stale map tiles again after the style change, what did we do last time",
    needed: ["b-cache"], forbidden: [],
  },
  {
    id: "atlas-test-runner", split: "dev", family: "reject", scope: "proj-atlas",
    prompt: "add a unit test for the tile router, which test runner does this repo use",
    needed: ["b-runner"], forbidden: ["a-runner"],
  },
  {
    id: "none-regex", split: "dev", family: "none", scope: "proj-atlas",
    prompt: "write a regular expression that matches an ISO 8601 date like 2026-11-18",
    needed: [], forbidden: ["a-runner", "a-goal", "b-deploy", "b-cache", "b-runner", "b-auth", "c-style", "c-sync", "c-new-db", "x-shell"],
  },
  {
    id: "atlas-ship", split: "heldout", family: "resume", scope: "proj-atlas",
    prompt: "the tile fix is merged, ship it to production for atlas now",
    handoff: { summary: "Tile cache fix merged to main.", next: ["deploy it"] },
    needed: ["b-deploy"], forbidden: [],
  },
  {
    id: "atlas-admin-call", split: "heldout", family: "reuse", scope: "proj-atlas",
    prompt: "my curl to the atlas admin API returns 403 even with my token, how do I call it locally",
    needed: ["b-auth"], forbidden: [],
  },
  {
    id: "notes-storage", split: "heldout", family: "reject", scope: "proj-notes",
    prompt: "where does the notes app keep its data now, I need to add a tags field to each note",
    needed: ["c-new-db"], forbidden: ["c-old-db"],
  },
  {
    id: "notes-sync", split: "heldout", family: "reuse", scope: "proj-notes",
    prompt: "two browser tabs are overwriting each other's notes again in the notes app",
    needed: ["c-sync"], forbidden: [],
  },
  {
    id: "notes-copy", split: "heldout", family: "resume", scope: "proj-notes",
    prompt: "write the empty-state message for the notes list in the notes app",
    needed: ["c-style"], forbidden: ["b-deploy"],
  },
  {
    id: "none-sql", split: "heldout", family: "none", scope: "proj-ledger",
    prompt: "explain the difference between an inner join and a left join with a short example",
    needed: [], forbidden: ["a-runner", "a-goal", "a-flaky", "a-migr-new", "b-deploy", "b-cache", "b-runner", "b-auth", "c-style", "c-sync", "c-new-db", "x-shell"],
  },
  {
    id: "cross-atlas-from-notes", split: "heldout", family: "reuse", scope: "proj-notes",
    prompt: "from the notes app I need to call the atlas admin API, how do I authenticate to it locally",
    needed: ["b-auth"], forbidden: [],
  },
  {
    id: "cross-ledger-from-atlas", split: "heldout", family: "reuse", scope: "proj-atlas",
    prompt: "the ledger invoice rounding test fails in CI for me, what was the known cause",
    needed: ["a-flaky"], forbidden: [],
  },
  {
    id: "fresh-notes-runner", split: "fresh", family: "reject", scope: "proj-notes",
    prompt: "which command runs the unit tests in the notes app",
    needed: [], forbidden: ["a-runner", "b-runner"],
  },
  {
    id: "fresh-ledger-deploy", split: "fresh", family: "reject", scope: "proj-ledger",
    prompt: "how do we deploy ledger to staging",
    needed: [], forbidden: ["b-deploy"],
  },
  {
    id: "fresh-atlas-from-ledger", split: "fresh", family: "reuse", scope: "proj-ledger",
    prompt: "atlas map tiles look stale after a style change, what fixed that before",
    needed: ["b-cache"], forbidden: [],
  },
  {
    id: "fresh-none-css", split: "fresh", family: "none", scope: "proj-notes",
    prompt: "center a div horizontally and vertically with css grid",
    needed: [], forbidden: ["a-runner", "a-goal", "a-flaky", "a-migr-new", "b-deploy", "b-cache", "b-runner", "b-auth", "c-style", "c-sync", "c-new-db", "x-shell"],
  },
  {
    id: "fresh-ledger-columns", split: "fresh", family: "resume", scope: "proj-ledger",
    prompt: "can I add a refund_reason column to the refund export",
    needed: ["a-goal"], forbidden: [],
  },
  {
    id: "fresh-notes-quota", split: "fresh", family: "reuse", scope: "proj-notes",
    prompt: "users hit a storage quota error when they have many notes, did we see this before",
    needed: ["c-new-db"], forbidden: ["c-old-db"],
  },
];
