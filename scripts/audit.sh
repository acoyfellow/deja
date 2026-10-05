#!/usr/bin/env bash
set -uo pipefail

DEJA_REPO="$(cd "$(dirname "$0")/.." && pwd)"
PLUGIN_REPO="${PLUGIN_REPO:-$HOME/cloudflare/pi-fresh-session-handoff}"
DB="${DEJA_DB:-$HOME/.deja/deja.db}"
REVIEWS="$DEJA_REPO/.tmp/reviews"
FAILURES=0

pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
check() { if eval "$2"; then pass "$1"; else fail "$1"; fi; }
sql() { sqlite3 "$DB" "$1"; }

PII_SLIP="01M3YCWD2VAHGZPCC1PKE374GP"
PII_MARKERS_FILE="${DEJA_PII_MARKERS:-$HOME/.deja/pii-markers}"
PII_MARKERS=()
if [ -f "$PII_MARKERS_FILE" ]; then
  while IFS= read -r marker; do [ -n "$marker" ] && PII_MARKERS+=("$marker"); done < "$PII_MARKERS_FILE"
fi
HUMAN_PENDING="'01M3AGNY17MKD5FR5J0ZY8HB2D','01M28A1KM777W2HBMCHN48M4P9','01KZK7ZYE8MV36X6KSNXGE3V4X','01KYAPNRVHZ3B4A2CSTQ7Y2E0H','01KXQWG07YTNH0WR5W1N846Z24'"
FIX_SINCE_MS=$(sql "SELECT COALESCE((SELECT created_at FROM slips WHERE tags LIKE '%from-handoff%' ORDER BY created_at LIMIT 1), 0)")

echo "== 1. customer personal data"
check "PII slip row is gone" '[ "$(sql "SELECT COUNT(*) FROM slips WHERE id = '"'"'$PII_SLIP'"'"'")" = 0 ]'
check "local PII marker list present (${#PII_MARKERS[@]} markers)" '[ "${#PII_MARKERS[@]}" -gt 0 ]'
MARKER_INDEX=0
for marker in "${PII_MARKERS[@]}"; do
  MARKER_INDEX=$((MARKER_INDEX + 1))
  check "no bytes of PII marker #$MARKER_INDEX in db, wal or shm" '! grep -aqF "$marker" "$DB" "$DB-wal" "$DB-shm" 2>/dev/null'
done
PII_SCAN=$(sql "SELECT text FROM slips WHERE authored_by = 'pi/auto-memory' AND state != 'expired'" | grep -cE '[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+\.[A-Za-z]{2,}|\b[0-9a-f]{32}\b|account[[:space:]]*(id[[:space:]]*)?[:#]?[[:space:]]*[0-9]{6,}|user[[:space:]]*id[[:space:]]*[:#]?[[:space:]]*`?[0-9a-z-]{8,}')
check "no active auto-memory slip carries an email, 32-hex id, account or user id ($PII_SCAN)" '[ "$PII_SCAN" = 0 ]'
check "extraction prompt forbids third-party personal data" 'grep -q "Never record personal data about customers" "$PLUGIN_REPO/src/hooks/deja-auto-memory.ts"'
check "candidate filter drops personal identifiers" 'grep -q "containsPersonalData(memoryText)" "$PLUGIN_REPO/src/hooks/deja-auto-memory.ts"'

echo "== 2. promote only on a different session"
check "plugin keeps with --from-other-session" 'grep -q "\"--from-other-session\"" "$PLUGIN_REPO/src/hooks/deja-auto-memory.ts"'
check "deja keep honours --from-other-session" 'grep -q "fromOtherSession" "$DEJA_REPO/src/cli.ts"'
SAME_SESSION_PROBE=$(
  TMP=$(mktemp -d); export DEJA_DB="$TMP/p.db"
  ID=$(DEJA_SESSION=s1 bun "$DEJA_REPO/src/cli.ts" remember "audit same-session probe" | awk '{print $3}')
  A=$(DEJA_SESSION=s1 bun "$DEJA_REPO/src/cli.ts" keep "$ID" --from-other-session)
  B=$(DEJA_SESSION=s2 bun "$DEJA_REPO/src/cli.ts" keep "$ID" --from-other-session)
  rm -rf "$TMP"; printf '%s|%s' "${A%% *}" "${B%% *}"
)
check "same session refused, other session kept ($SAME_SESSION_PROBE)" '[ "$SAME_SESSION_PROBE" = "unchanged|kept" ]'

echo "== 3. auto-memory lookups leave no recall traces"
check "plugin recalls with --no-trace" 'grep -q "\"--no-trace\"" "$PLUGIN_REPO/src/hooks/deja-auto-memory.ts"'
check "no auto-memory traces written since the fix" '[ "$(sql "SELECT COUNT(*) FROM recall_traces WHERE authored_by = '"'"'pi/auto-memory'"'"' AND created_at > $FIX_SINCE_MS")" = 0 ]'
TRACE_PROBE=$(
  TMP=$(mktemp -d); export DEJA_DB="$TMP/t.db"
  bun "$DEJA_REPO/src/cli.ts" remember "audit trace probe" >/dev/null
  bun "$DEJA_REPO/src/cli.ts" recall "trace probe" --no-trace >/dev/null
  N=$(sqlite3 "$DEJA_DB" "SELECT COUNT(*) FROM recall_traces"); rm -rf "$TMP"; echo "$N"
)
check "recall --no-trace writes 0 traces ($TRACE_PROBE)" '[ "$TRACE_PROBE" = 0 ]'

echo "== 4. one memory bank with origins"
REACH_PROBE=$(
  TMP=$(mktemp -d); export DEJA_DB="$TMP/r.db"
  ( mkdir -p "$TMP/alpha" && cd "$TMP/alpha" && DEJA_SCOPE=repo:alpha bun "$DEJA_REPO/src/cli.ts" remember "reach probe marker from alpha" --keep >/dev/null )
  OUT=$(cd "$TMP" && DEJA_SCOPE=repo:beta bun "$DEJA_REPO/src/cli.ts" recall "reach probe marker" --no-trace)
  rm -rf "$TMP"; printf '%s' "$OUT"
)
check "recall from another origin finds the note" 'grep -q "reach probe marker from alpha" <<<"$REACH_PROBE"'
check "recalled note shows where it came from" 'grep -q "from: alpha" <<<"$REACH_PROBE"'
check "legacy rows stay out of default recall" 'grep -q "s.scope != '"'"'legacy:global'"'"'" "$DEJA_REPO/src/storage.ts"'

echo "== 5. stale handoffs"
check "only human-pending or <7d handoffs remain active" \
  '[ "$(sql "SELECT COUNT(*) FROM handoffs WHERE status = '"'"'active'"'"' AND id NOT IN ($HUMAN_PENDING) AND created_at < (strftime('"'"'%s'"'"','"'"'now'"'"') - 7*86400)*1000")" = 0 ]'
check "all 5 human-pending handoffs still active" '[ "$(sql "SELECT COUNT(*) FROM handoffs WHERE status = '"'"'active'"'"' AND id IN ($HUMAN_PENDING)")" = 5 ]'
check "no resolved handoff lost its content" \
  '[ "$(sql "SELECT COUNT(*) FROM handoffs h WHERE h.status = '"'"'completed'"'"' AND NOT EXISTS (SELECT 1 FROM json_each(h.kept) j JOIN slips s ON s.id = j.value WHERE s.state = '"'"'kept'"'"') AND NOT EXISTS (SELECT 1 FROM slips s WHERE s.tags LIKE '"'"'%'"'"' || h.id || '"'"'%'"'"' AND s.state = '"'"'kept'"'"')")" = 0 ]'
check "sqlite integrity ok" '[ "$(sql "PRAGMA integrity_check")" = ok ]'

echo "== tests"
check "deja: bun test + typecheck" '(cd "$DEJA_REPO" && bun test ./test >/dev/null 2>&1 && bun run typecheck >/dev/null 2>&1)'
check "plugin: build + hook tests" '(cd "$PLUGIN_REPO" && npx tsc -p tsconfig.json --noEmit >/dev/null 2>&1 && npx vitest run tests/deja-auto-memory.test.ts tests/hooks.test.ts tests/model-invariants.test.ts tests/schema.test.ts >/dev/null 2>&1)'
check "installed extension matches plugin repo" 'diff -rq "$PLUGIN_REPO/src" "$HOME/.pi/agent/extensions/fresh-session-handoff/src" >/dev/null'

echo "== reviews"
DEJA_SHA=$(git -C "$DEJA_REPO" rev-parse HEAD)
PLUGIN_SHA=$(git -C "$PLUGIN_REPO" rev-parse HEAD)
check "both repos committed and clean" '[ -z "$(git -C "$DEJA_REPO" status --porcelain --untracked-files=no)" ] && [ -z "$(git -C "$PLUGIN_REPO" status --porcelain --untracked-files=no)" ]'
for reviewer in kenton-varda james-snell; do
  RECEIPT="$REVIEWS/$reviewer.md"
  check "$reviewer review exists" '[ -f "$RECEIPT" ]'
  check "$reviewer verdict AGREE" 'grep -qx "VERDICT: AGREE" "$RECEIPT" 2>/dev/null'
  check "$reviewer reviewed current SHAs" 'grep -q "deja@$DEJA_SHA" "$RECEIPT" 2>/dev/null && grep -q "plugin@$PLUGIN_SHA" "$RECEIPT" 2>/dev/null'
done

echo
if [ "$FAILURES" -eq 0 ]; then echo "AUDIT PASS"; exit 0; fi
echo "AUDIT FAIL ($FAILURES)"; exit 1
