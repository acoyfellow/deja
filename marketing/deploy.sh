#!/usr/bin/env bash
set -uo pipefail
cd "$(dirname "$0")"
COMMIT=$(git rev-parse HEAD)
[ -z "$(git status --porcelain -- .)" ] || { echo "refusing to deploy: marketing/ has uncommitted changes"; exit 1; }
bun run test && bun run build || exit 1
LOG=$(mktemp)
for attempt in 1 2 3; do
  npx wrangler deploy 2>&1 | tee "$LOG"
  DEPLOY_EXIT=${PIPESTATUS[0]}
  grep -qE "malformed response from the API|504 Gateway Timeout" "$LOG" || break
  echo "Cloudflare API glitch on attempt $attempt, retrying"
  sleep 10
done
if [ "$DEPLOY_EXIT" -ne 0 ]; then
  if grep -q "limit of 100 Workers custom domains" "$LOG"; then
    echo "custom domain already attached; zone is at its domain limit, continuing to healthcheck"
  else
    echo "deploy failed"; exit "$DEPLOY_EXIT"
  fi
fi
for attempt in 1 2 3 4 5 6; do
  EXPECT_COMMIT="$COMMIT" ./healthcheck.sh && exit 0
  sleep 10
done
exit 1
