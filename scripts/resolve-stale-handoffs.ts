import { Deja } from "../src/index.ts";

const HUMAN_STATUS_PENDING = new Set([
  "01M3AGNY17MKD5FR5J0ZY8HB2D",
  "01M28A1KM777W2HBMCHN48M4P9",
  "01KZK7ZYE8MV36X6KSNXGE3V4X",
  "01KYAPNRVHZ3B4A2CSTQ7Y2E0H",
  "01KXQWG07YTNH0WR5W1N846Z24",
]);
const STALE_AFTER_MS = 7 * 86_400_000;
const apply = process.argv.includes("--apply");

type HandoffRow = { id: string; scope: string; summary: string; kept: string; created_at: number };

const d = new Deja({ path: process.env.DEJA_DB, skipGc: true, scope: "global" });
const db = d.storage["db"];
const cutoff = Date.now() - STALE_AFTER_MS;
const stale = db
  .prepare(`SELECT id, scope, summary, kept, created_at FROM handoffs WHERE status = 'active' AND created_at < ? ORDER BY created_at`)
  .all(cutoff) as HandoffRow[];

let resolved = 0;
let preserved = 0;
for (const handoff of stale) {
  if (HUMAN_STATUS_PENDING.has(handoff.id)) continue;
  const keptIds = JSON.parse(handoff.kept) as string[];
  const survives = keptIds.some((id) => (db.prepare(`SELECT state FROM slips WHERE id = ?`).get(id) as { state: string } | null)?.state === "kept");
  if (!survives) {
    if (apply) {
      const slip = d.remember(handoff.summary, { scope: handoff.scope, kind: "decision", tags: ["from-handoff", handoff.id] });
      d.storage.setState(slip.id, "kept", Date.now(), handoff.scope);
    }
    preserved += 1;
  }
  if (apply) d.storage.resolveHandoff(handoff.id, "completed", Date.now(), handoff.scope);
  resolved += 1;
}
console.log(`${apply ? "resolved" : "would resolve"} ${resolved} stale handoffs; preserved ${preserved} summaries as kept slips; left ${HUMAN_STATUS_PENDING.size} awaiting human status`);
d.close();
