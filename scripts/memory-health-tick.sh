#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
exec bun scripts/memory-health-tick.ts "$@"
