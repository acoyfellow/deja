import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { HANDOFF_TRANSITIONS, MESSAGE_TRANSITIONS, SLIP_TRANSITIONS, canTransition, sourcesFor } from "../src/fsm.ts";
import { memory } from "../src/index.ts";

describe("slip lifecycle", () => {
  test("draft can be kept or expired; kept can only expire; expired is final", () => {
    expect(sourcesFor(SLIP_TRANSITIONS, "kept")).toEqual(["draft"]);
    expect(sourcesFor(SLIP_TRANSITIONS, "expired")).toEqual(["draft", "kept"]);
    expect(sourcesFor(SLIP_TRANSITIONS, "draft")).toEqual([]);
    expect(canTransition(SLIP_TRANSITIONS, "expired", "kept")).toBe(false);
  });

  test("storage refuses to revive an expired slip", () => {
    const d = memory();
    const slip = d.remember("a note that will be forgotten");
    d.keep([slip.id]);
    expect(d.forget(slip.id)).toBe(true);
    expect(d.storage.setState(slip.id, "kept", Date.now())).toBe(false);
    expect(d.get(slip.id)?.state).toBe("expired");
    d.close();
  });

  test("storage refuses to move a kept slip back to draft", () => {
    const d = memory();
    const slip = d.remember("a kept note");
    d.keep([slip.id]);
    expect(d.storage.setState(slip.id, "draft", Date.now())).toBe(false);
    expect(d.get(slip.id)?.state).toBe("kept");
    d.close();
  });

  test("expiring twice changes nothing the second time", () => {
    const d = memory();
    const slip = d.remember("expire me");
    expect(d.storage.setState(slip.id, "expired", 1)).toBe(true);
    expect(d.storage.setState(slip.id, "expired", 2)).toBe(false);
    expect(d.get(slip.id)?.expiredAt).toBe(1);
    d.close();
  });
});

describe("message lifecycle", () => {
  test("pending can be read or archived; read can be archived; archived is final", () => {
    expect(sourcesFor(MESSAGE_TRANSITIONS, "read")).toEqual(["pending"]);
    expect(sourcesFor(MESSAGE_TRANSITIONS, "archived")).toEqual(["pending", "read"]);
  });

  test("reading an archived message does not un-archive it", () => {
    const d = memory();
    const m = d.send({ from: "a", to: "b", body: "hi" });
    expect(d.archive(m.id)).toBe(true);
    expect(d.read(m.id)).toBe(false);
    expect(d.message(m.id)?.state).toBe("archived");
    d.close();
  });

  test("reading twice still reports success and keeps the first read time", () => {
    const d = memory();
    const m = d.send({ from: "a", to: "b", body: "hi" });
    expect(d.read(m.id)).toBe(true);
    const firstReadAt = d.message(m.id)?.readAt;
    expect(d.read(m.id)).toBe(true);
    expect(d.message(m.id)?.readAt).toBe(firstReadAt);
    d.close();
  });
});

describe("handoff lifecycle", () => {
  test("active resolves to completed or abandoned; both are final", () => {
    expect(HANDOFF_TRANSITIONS.active).toEqual(["completed", "abandoned"]);
    expect(HANDOFF_TRANSITIONS.completed).toEqual([]);
    expect(HANDOFF_TRANSITIONS.abandoned).toEqual([]);
  });
});

describe("state writes stay in one place", () => {
  test("only src/storage.ts and the shared mirror write slip, message or handoff state in SQL", () => {
    const writer = /UPDATE\s+(slips|messages|handoffs)\s+SET\s+(state|status)\b/;
    const allowed = new Set(["storage.ts", join("shared-mirror", "mirror.ts")]);
    const offenders: string[] = [];
    const walk = (dir: string, prefix = ""): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const relative = prefix ? join(prefix, entry.name) : entry.name;
        if (entry.isDirectory()) walk(join(dir, entry.name), relative);
        else if (entry.name.endsWith(".ts") && writer.test(readFileSync(join(dir, entry.name), "utf8")) && !allowed.has(relative)) offenders.push(relative);
      }
    };
    walk(join(import.meta.dir, "..", "src"));
    expect(offenders).toEqual([]);
  });
});
