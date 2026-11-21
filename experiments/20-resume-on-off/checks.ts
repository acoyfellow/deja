export type AnswerCheck = { must: RegExp[]; mustNot?: RegExp[] };

export const CHECKS: Record<string, AnswerCheck> = {
  "ledger-resume-refund": { must: [/amount_cents/i, /refunded_at/i] },
  "ledger-migrate": { must: [/db:migrate/i], mustNot: [/knex migrate:latest/i] },
  "ledger-rounding": { must: [/\bUTC\b/] },
  "atlas-stale-tiles": { must: [/style[_ ]version/i] },
  "atlas-test-runner": { must: [/bun test/i] },
  "atlas-ship": { must: [/staging/i, /health/i] },
  "atlas-admin-call": { must: [/cloudflared access/i] },
  "notes-storage": { must: [/indexeddb/i] },
  "notes-sync": { must: [/web lock|navigator\.locks/i] },
  "notes-copy": { must: [/\S/], mustNot: [/!/, /\p{Extended_Pictographic}/u] },
  "cross-atlas-from-notes": { must: [/cloudflared access/i] },
  "cross-ledger-from-atlas": { must: [/\bUTC\b/] },
  "fresh-atlas-from-ledger": { must: [/style[_ ]version/i] },
  "fresh-ledger-columns": { must: [/finance/i] },
  "fresh-notes-quota": { must: [/indexeddb/i] },
  "none-regex": { must: [/\\d\{4\}|\[0-9\]\{4\}/] },
  "none-sql": { must: [/inner join/i, /left (outer )?join/i] },
  "fresh-none-css": { must: [/grid/i, /place-items|align-items|justify-(content|items)/i] },
  "fresh-notes-runner": { must: [/(don.t know|do not know|not sure|unknown|no (record|note|information)|isn.t (recorded|documented|in)|not (recorded|documented|specified|mentioned)|check (the |its |your )?(package\.json|readme|scripts|repo)|can.t (tell|confirm|determine))/i] },
  "fresh-ledger-deploy": { must: [/(don.t know|do not know|not sure|unknown|no (record|note|information)|isn.t (recorded|documented|in)|not (recorded|documented|specified|mentioned)|check (the |its |your )?(package\.json|readme|scripts|repo)|can.t (tell|confirm|determine))/i] },
};

export function passes(caseId: string, answer: string): boolean | undefined {
  const check = CHECKS[caseId];
  if (!check) return undefined;
  return check.must.every((pattern) => pattern.test(answer)) && !(check.mustNot ?? []).some((pattern) => pattern.test(answer));
}
