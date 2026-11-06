import { readFileSync } from "node:fs";
import { Storage, defaultDbPath } from "../src/storage.ts";

const [listPath] = process.argv.slice(2);
if (!listPath || !process.argv.includes("--yes")) throw new Error("usage: bun scripts/expire-notes.ts <file with one slip id per line> --yes");
const ids = readFileSync(listPath, "utf8").split("\n").map((line) => (line.split("\t")[0] ?? "").trim()).filter(Boolean);
if (ids.length > 25) throw new Error(`refusing ${ids.length} ids; the loop contract caps a batch at 25`);
const storage = new Storage({ path: process.env.DEJA_DB ?? defaultDbPath() });
const now = Date.now();
for (const id of ids) {
  const row = storage.db.prepare(`SELECT scope, state, used_count FROM slips WHERE id = ?`).get(id) as { scope: string; state: string; used_count: number } | undefined;
  if (!row) console.log(`skip ${id} missing`);
  else if (row.state !== "kept" || row.used_count > 0) console.log(`skip ${id} state=${row.state} used=${row.used_count}`);
  else console.log(`${storage.setState(id, "expired", now, row.scope) ? "expired" : "failed"} ${id} ${row.scope}`);
}
storage.close();
