#!/bin/bash
# Health check for deja - run between worker sessions
cd "$(dirname "$0")/.." || exit 1

echo "=== UNCOMMITTED WORK ==="
UNCOMMITTED=$(git status --porcelain | head -5)
if [ -n "$UNCOMMITTED" ]; then
  echo "⚠️ UNCOMMITTED - commit first!"
  echo "$UNCOMMITTED"
fi

echo ""
echo "=== TYPE CHECK ==="
if ! npx tsc --noEmit 2>&1; then
  echo "❌ Type errors - fix before continuing"
  exit 1
fi
echo "✅ Types OK"

echo ""
echo "=== TESTS ==="
if [ -f "test/deja-do.test.ts" ]; then
  echo "⚠️ DejaDO tests exist but require Cloudflare runtime"
elif [ -f "test/secrets.test.ts" ]; then
  echo "⚠️ Secrets tests exist but require running service"
else
  echo "⚠️ No tests yet"
fi

echo ""
echo "=== WRANGLER CHECK ==="
npx wrangler deploy --dry-run 2>&1 | tail -10 || echo "⚠️ Dry-run issues"
