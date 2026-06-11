#!/usr/bin/env bun
/** One-shot restart of the local agent's Deja store to resolve its handoff. */
import { Deja } from "../../src/index.ts";

const db = process.env.EXP16_LOCAL_DB;
const id = process.env.EXP16_HANDOFF_ID;
const query = process.env.EXP16_QUERY ?? "";
if (!db || !id) throw new Error("missing EXP16_LOCAL_DB or EXP16_HANDOFF_ID");
const deja = new Deja({ path: db, noChainRollup: true, recordRecallTraces: false });
const resolved = deja.resolveHandoff(id, "completed");
const recalled = deja.recall(query);
console.log(JSON.stringify({
  pid: process.pid,
  scope: deja.scope,
  resolved,
  activeHandoff: recalled.activeHandoff,
  hitIds: recalled.hits.map((hit) => hit.slip.id),
}));
deja.close();
