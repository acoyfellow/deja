#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/deja-local-smoke.XXXXXX")"
DB="$TMP/deja.db"
trap 'rm -rf "$TMP"' EXIT

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

make_repo() {
  local name="$1"
  local repo="$TMP/$name"
  git init -q "$repo"
  git -C "$repo" remote add origin "https://example.test/deja-smoke/$name.git"
  printf '%s' "$repo"
}

run_cli() {
  local repo="$1" session="$2"
  shift 2
  (
    cd "$repo"
    DEJA_DB="$DB" DEJA_SESSION="$session" DEJA_AUTHOR="local-smoke" \
      bun run "$ROOT/src/cli.ts" "$@"
  )
}

ALPHA="$(make_repo alpha)"
BETA="$(make_repo beta)"

run_cli "$ALPHA" "local-write" init >/dev/null
[ -f "$DB" ] || fail "init did not create the requested SQLite database"

OLD_OUT="$(run_cli "$ALPHA" "local-write" remember 'Decision: old local smoke setting' --keep)"
OLD_ID="$(printf '%s\n' "$OLD_OUT" | awk '/^kept / { print $3; exit }')"
[ -n "$OLD_ID" ] || fail "could not parse original slip id: $OLD_OUT"

CURRENT_OUT="$(run_cli "$ALPHA" "local-write" remember 'Decision: current local smoke marker' --keep)"
CURRENT_ID="$(printf '%s\n' "$CURRENT_OUT" | awk '/^kept / { print $3; exit }')"
[ -n "$CURRENT_ID" ] || fail "could not parse current slip id: $CURRENT_OUT"
run_cli "$ALPHA" "local-write" link "$CURRENT_ID" supersedes "$OLD_ID" >/dev/null

SECOND_RECALL="$(run_cli "$ALPHA" "local-second-session" recall 'old local smoke setting')"
printf '%s\n' "$SECOND_RECALL"
printf '%s\n' "$SECOND_RECALL" | grep -Fq 'current local smoke marker' || fail "second session did not recall the corrected memory"

HANDOFF_OUT="$(run_cli "$ALPHA" "local-write" handoff 'local smoke handoff: resolve before closing')"
HANDOFF_ID="$(printf '%s\n' "$HANDOFF_OUT" | awk '/^active handoff / { print $3; exit }')"
[ -n "$HANDOFF_ID" ] || fail "could not parse handoff id: $HANDOFF_OUT"
NEXT_RECALL="$(run_cli "$ALPHA" "local-next-session" recall '')"
printf '%s\n' "$NEXT_RECALL" | grep -Fq 'local smoke handoff: resolve before closing' || fail "next session did not receive handoff"
run_cli "$ALPHA" "local-next-session" resolve "$HANDOFF_ID" completed >/dev/null
RESOLVED_RECALL="$(run_cli "$ALPHA" "local-after-resolution" recall '')"
! printf '%s\n' "$RESOLVED_RECALL" | grep -Fq 'local smoke handoff: resolve before closing' || fail "resolved handoff still directs recall"

SHOW_OUT="$(run_cli "$ALPHA" "local-inspect" show "$CURRENT_ID")"
printf '%s\n' "$SHOW_OUT" | grep -Fq 'current local smoke marker' || fail "show did not inspect current scoped memory"

if CROSS_OUT="$(run_cli "$BETA" "local-inspect" show "$CURRENT_ID" 2>&1)"; then
  fail "another repository inspected a known foreign slip id: $CROSS_OUT"
fi
printf '%s\n' "$CROSS_OUT" | grep -Fq '(no slip' || fail "cross-scope inspection did not fail honestly: $CROSS_OUT"
run_cli "$BETA" "local-write" handoff 'beta handoff in the same harness session' >/dev/null
BETA_RECALL="$(run_cli "$BETA" "beta-next-session" recall '')"
printf '%s\n' "$BETA_RECALL" | grep -Fq 'beta handoff in the same harness session' || fail "same session could not retain beta handoff"

run_cli "$ALPHA" "local-inspect" redact "$CURRENT_ID" >/dev/null
REDACTED_RECALL="$(run_cli "$ALPHA" "local-redacted" recall 'current local smoke marker')"
printf '%s\n' "$REDACTED_RECALL" | grep -Fq '[redacted]' || fail "redacted memory was not masked in recall"
if run_cli "$ALPHA" "local-inspect" forget "$CURRENT_ID" >/dev/null 2>&1; then
  fail "forget without --yes succeeded"
fi
run_cli "$ALPHA" "local-inspect" forget "$CURRENT_ID" --yes >/dev/null
FORGOTTEN_RECALL="$(run_cli "$ALPHA" "local-after-forget" recall 'current local smoke marker')"
! printf '%s\n' "$FORGOTTEN_RECALL" | grep -Fq "$CURRENT_ID" || fail "forgotten memory remained in recall"
RAW_SHOW="$(run_cli "$ALPHA" "local-inspect" show "$CURRENT_ID")"
printf '%s\n' "$RAW_SHOW" | grep -Fq 'current local smoke marker' || fail "forget unexpectedly erased raw local history"

MCP_OUT="$(
  printf '%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"deja-local-smoke","version":"1"}}}' \
    '{"jsonrpc":"2.0","method":"notifications/initialized","params":{}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
    '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"remember","arguments":{"text":"Decision: MCP local smoke marker","keep":true}}}' |
    (cd "$ALPHA" && DEJA_DB="$DB" DEJA_SESSION="mcp-local-smoke" DEJA_AUTHOR="local-smoke" bun run "$ROOT/src/mcp.ts")
)"
printf '%s\n' "$MCP_OUT" | grep -Fq '"name":"recall"' || fail "MCP tools/list did not return recall"
printf '%s\n' "$MCP_OUT" | grep -Fq 'kept slip' || fail "MCP remember did not return a successful receipt"
MCP_RECALL="$(run_cli "$ALPHA" "mcp-second-session" recall 'MCP local smoke marker')"
printf '%s\n' "$MCP_RECALL" | grep -Fq 'MCP local smoke marker' || fail "MCP-written memory did not survive into a second session"

echo 'PASS: local init → CLI remember/correct/recall/handoff/resolve/inspect/redact/forget → repository isolation → MCP stdio → second-session recall'
