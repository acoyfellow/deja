#!/usr/bin/env bash
set -uo pipefail
BASE="${1:-https://deja.coey.dev}"
EXPECT_COMMIT="${EXPECT_COMMIT:-}"
FAILURES=0
pass() { printf 'PASS  %s\n' "$1"; }
fail() { printf 'FAIL  %s\n' "$1"; FAILURES=$((FAILURES + 1)); }
status() { curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE$1"; }

for path in / /manifest.json /sw.js /robots.txt; do
  code=$(status "$path")
  [ "$code" = 200 ] && pass "$path returns 200" || fail "$path returns $code"
done
code=$(status /definitely-not-a-page)
[ "$code" = 404 ] && pass "unknown path returns 404" || fail "unknown path returns $code"
curl -s --max-time 10 "$BASE/" | grep -qi '<title>[^<]*deja' && pass "home page title mentions deja" || fail "home page title missing deja"

HEALTH=$(curl -s --max-time 10 -H 'cache-control: no-cache' "$BASE/health.json?ts=$(date +%s)")
[ "$(jq -r .ok <<<"$HEALTH" 2>/dev/null)" = true ] && pass "/health.json ok:true" || fail "/health.json not ok: ${HEALTH:0:120}"
LIVE_COMMIT=$(jq -r .commit <<<"$HEALTH" 2>/dev/null)
if [ -n "$EXPECT_COMMIT" ]; then
  [ "$LIVE_COMMIT" = "$EXPECT_COMMIT" ] && pass "live build is commit ${EXPECT_COMMIT:0:7}" || fail "live build is ${LIVE_COMMIT:0:7}, expected ${EXPECT_COMMIT:0:7}"
fi

[ "$FAILURES" -eq 0 ] && { echo "HEALTHY $BASE (commit ${LIVE_COMMIT:0:7}, built $(jq -r .builtAt <<<"$HEALTH"))"; exit 0; }
echo "UNHEALTHY $BASE ($FAILURES failures)"; exit 1
