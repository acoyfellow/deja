import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = join(import.meta.dir, "..", "src", "cli.ts");

function runCli(dbPath: string, args: string[]) {
  const result = Bun.spawnSync(["bun", cli, ...args], { env: { ...process.env, DEJA_DB: dbPath, DEJA_SESSION: "s-json" } });
  return { stdout: result.stdout.toString(), stderr: result.stderr.toString(), code: result.exitCode };
}

describe("cli recall --json and signal", () => {
  test("recall --json returns ids, scores and formatted text; signal grades a note", () => {
    const db = join(mkdtempSync(join(tmpdir(), "deja-json-")), "deja.db");
    const remembered = runCli(db, ["remember", "Marketing deploy runs deploy.sh and checks health.json", "--keep"]);
    const id = remembered.stdout.split(" ")[2]!;
    const out = runCli(db, ["recall", "marketing deploy", "--json", "--no-trace"]);
    const parsed = JSON.parse(out.stdout);
    expect(parsed.hits[0].id).toBe(id);
    expect(typeof parsed.hits[0].score).toBe("number");
    expect(parsed.hits[0].formatted).toContain(`[medium] ${id}`);
    expect(runCli(db, ["signal", id, "used"]).stdout.trim()).toBe(`used ${id}`);
    expect(runCli(db, ["signal", "01NOTAREALID0000000000000", "used"]).code).not.toBe(0);
  });
});
