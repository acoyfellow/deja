#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
bash -n "$ROOT/scripts/preflight.sh"
out="$("$ROOT/scripts/preflight.sh")"
printf '%s\n' "$out"
grep -q '^PASS: npm latest tarball is a placeholder' <<<"$out"
grep -q '^PASS: alpha.7 ships an x86-64 Linux ELF wsd and no arm64 wsd' <<<"$out"
grep -q '^PASS: BLOCKER CONFIRMED:' <<<"$out"
grep -q '^RESULT=unsupported$' <<<"$out"
