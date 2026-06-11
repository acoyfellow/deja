#!/usr/bin/env bash
set -euo pipefail

# This intentionally uses curl rather than npm: some managed npm clients rewrite
# scoped registry requests even when `npm config get registry` says npmjs.org.
REGISTRY='https://registry.npmjs.org'
WORKSPACE='@cloudflare/workspace'
ALPHA='0.0.0-alpha.7'
RELEASE_API='https://api.github.com/repos/supermemoryai/supermemory/releases/tags/server-v0.0.2'
RELEASE_BASE='https://github.com/supermemoryai/supermemory/releases/download/server-v0.0.2'
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch() { curl --fail --silent --show-error --location --retry 1 --connect-timeout 10 --max-time "$1" "$2" -o "$3"; }
pass() { printf 'PASS: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }

fetch 30 "$REGISTRY/%40cloudflare%2Fworkspace" "$TMP/packument.json"
node - "$TMP/packument.json" "$TMP/urls" <<'NODE'
const fs = require('node:fs');
const [packumentPath, outputPath] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(packumentPath, 'utf8'));
if (p['dist-tags']?.latest !== '0.0.0') throw new Error(`unexpected latest: ${p['dist-tags']?.latest}`);
const latest = p.versions?.['0.0.0'];
const alpha = p.versions?.['0.0.0-alpha.7'];
if (!latest?.dist?.tarball || !alpha?.dist?.tarball) throw new Error('required tarball URL absent');
fs.writeFileSync(outputPath, `${latest.dist.tarball}\n${alpha.dist.tarball}\n`);
NODE
pass 'public npm registry reports latest @cloudflare/workspace as 0.0.0 and alpha.7 exists'

LATEST_URL="$(head -n 1 "$TMP/urls")"
ALPHA_URL="$(tail -n 1 "$TMP/urls")"
fetch 30 "$LATEST_URL" "$TMP/latest.tgz"
tar -tzf "$TMP/latest.tgz" > "$TMP/latest.list"
grep -qx 'package/package.json' "$TMP/latest.list" || fail 'latest tarball lacks package.json'
if grep -Eq 'package/(index\.(js|mjs|cjs)|dist/)' "$TMP/latest.list"; then
  fail 'latest unexpectedly contains an implementation'
fi
pass 'npm latest tarball is a placeholder: package.json only, with no importable Workspace API'

# The alpha tarball is ~43 MiB compressed. Bound the transfer so the preflight
# cannot wait indefinitely.
fetch 120 "$ALPHA_URL" "$TMP/alpha.tgz"
tar -tzf "$TMP/alpha.tgz" > "$TMP/alpha.list"
grep -qx 'package/dist/index.js' "$TMP/alpha.list" || fail 'alpha lacks Workspace implementation'
grep -qx 'package/dist/bin/wsd-linux-x64' "$TMP/alpha.list" || fail 'alpha lacks documented x64 daemon'
if grep -Eq 'wsd-(linux-)?arm64|wsd-aarch64' "$TMP/alpha.list"; then
  fail 'alpha unexpectedly contains an arm64 wsd daemon; reassess experiment'
fi
mkdir "$TMP/unpack"
tar -xzf "$TMP/alpha.tgz" -C "$TMP/unpack" package/dist/bin/wsd-linux-x64 package/README.md
grep -q 'runs the shell as.*just-bash' "$TMP/unpack/package/README.md" || fail 'published README no longer identifies Worker backend as just-bash'
node - "$TMP/unpack/package/dist/bin/wsd-linux-x64" <<'NODE'
const fs = require('node:fs');
const b = Buffer.alloc(20);
const fd = fs.openSync(process.argv[2], 'r'); fs.readSync(fd, b); fs.closeSync(fd);
if (!b.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) throw new Error('wsd is not ELF');
const little = b[5] === 1;
const machine = little ? b.readUInt16LE(18) : b.readUInt16BE(18);
if (machine !== 62) throw new Error(`wsd ELF e_machine=${machine}, expected x86-64 (62)`);
NODE
pass 'alpha.7 ships an x86-64 Linux ELF wsd and no arm64 wsd'

fetch 30 "$RELEASE_API" "$TMP/release.json"
fetch 30 "$RELEASE_BASE/manifest.json" "$TMP/manifest.json"
fetch 30 "$RELEASE_BASE/supermemory-server-linux-arm64.sha256" "$TMP/supermemory.sha256"
EXPECTED="$(node - "$TMP/release.json" "$TMP/manifest.json" <<'NODE'
const fs = require('node:fs');
const [rp, mp] = process.argv.slice(2);
const release = JSON.parse(fs.readFileSync(rp, 'utf8'));
const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
if (release.tag_name !== 'server-v0.0.2' || manifest.version !== '0.0.2') throw new Error('wrong release/version');
const asset = release.assets.find(a => a.name === 'supermemory-server-linux-arm64');
if (!asset || asset.size <= 0) throw new Error('linux-arm64 release asset absent');
const checksum = manifest.platforms?.['linux-arm64']?.checksum;
if (!/^[0-9a-f]{64}$/.test(checksum)) throw new Error('manifest checksum absent/invalid');
process.stdout.write(checksum);
NODE
)"
PUBLISHED="$(awk '{print $1}' "$TMP/supermemory.sha256")"
[[ "$PUBLISHED" == "$EXPECTED" ]] || fail 'manifest and checksum sidecar disagree'
pass "Supermemory server-v0.0.2 publishes linux-arm64 with checksum $EXPECTED"

if [[ -n "${SUPERMEMORY_BIN:-}" ]]; then
  [[ -f "$SUPERMEMORY_BIN" ]] || fail "SUPERMEMORY_BIN does not name a file"
  ACTUAL="$(shasum -a 256 "$SUPERMEMORY_BIN" | awk '{print $1}')"
  [[ "$ACTUAL" == "$EXPECTED" ]] || fail 'SUPERMEMORY_BIN checksum is not the verified v0.0.2 linux-arm64 artifact'
  pass 'provided Supermemory binary bytes match the published checksum'
fi

OS="$(uname -s)"; ARCH="$(uname -m)"
case "$OS/$ARCH" in
  Linux/aarch64|Linux/arm64) : ;;
  *) pass "current host $OS/$ARCH cannot directly execute a Linux/arm64 ELF" ;;
esac

# Even on a Linux/arm64 host, the Worker backend is just-bash (not a native
# process runtime), while the package's Container transport daemon is x86-64.
# Thus the specifically requested linux-arm64 artifact has no compatible
# executable Workspace backend/path in this package.
pass 'BLOCKER CONFIRMED: alpha Worker backend is just-bash; Container wsd is Linux/x86-64; requested Supermemory binary is Linux/arm64'
printf 'RESULT=unsupported\n'
