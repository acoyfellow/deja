#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
scriptc coverage server.ts
scriptc build server.ts -o deja-native
