#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/deja-package-smoke.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

(
  cd "$ROOT"
  bun pm pack --destination "$TMP" --quiet >/dev/null
)
TARBALL="$(find "$TMP" -maxdepth 1 -name 'deja-*.tgz' -print -quit)"
[ -n "$TARBALL" ] || { echo 'FAIL: Bun did not create a package tarball' >&2; exit 1; }

CONSUMER="$TMP/consumer"
mkdir "$CONSUMER"
(
  cd "$CONSUMER"
  bun init -y >/dev/null
  bun add "$TARBALL" >/dev/null
  DEJA_DB="$CONSUMER/deja.db" ./node_modules/.bin/deja init >/dev/null
  VERIFY="$(DEJA_DB="$CONSUMER/deja.db" ./node_modules/.bin/deja verify)"
  printf '%s\n' "$VERIFY" | grep -Fq 'sqlite: ok' || {
    echo "FAIL: installed package could not initialize and verify SQLite: $VERIFY" >&2
    exit 1
  }
)

echo 'PASS: packed artifact installs into a clean Bun consumer and runs deja init + verify'
