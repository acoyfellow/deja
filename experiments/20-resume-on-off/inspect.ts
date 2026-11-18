import { Deja } from "../../src/index.ts";
import { CASES, NOTES } from "./cases.ts";
for (const c of CASES) {
  const deja = new Deja({ path: ":memory:", skipGc: true, scope: c.scope, recallReach: "all", recordRecallTraces: false });
  const keyOf = new Map<string, string>(); const idOf = new Map<string, string>();
  for (const seed of NOTES) {
    const sup = seed.supersedes ? idOf.get(seed.supersedes) : undefined;
    const slip = deja.remember(seed.text, { scope: seed.scope, kind: seed.kind, links: sup ? [{ toId: sup, kind: "supersedes" }] : undefined });
    deja.keep([slip.id]); idOf.set(seed.key, slip.id); keyOf.set(slip.id, seed.key);
  }
  const r = deja.recall(c.prompt, { limit: 5, maxTokens: 1200 });
  console.log(c.split, c.id, r.hits.map((h) => `${keyOf.get(h.slip.id)}:${h.score.toFixed(2)}:${h.trust}:${h.slip.scope === c.scope ? "local" : "other"}`).join("  "));
  deja.close();
}
