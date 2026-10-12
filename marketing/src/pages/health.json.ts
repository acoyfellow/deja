import { execSync } from "node:child_process";

function buildCommit(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

export function GET(): Response {
  const body = { ok: true, service: "deja-marketing", commit: buildCommit(), builtAt: new Date().toISOString() };
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
