#!/usr/bin/env bash
# deploy/build-agent.sh — compile the Polyptic agent to a single binary and package it as .deb + .rpm.
#
# PREREQUISITES (on the BUILD host):
#   * bun   >= 1.1    https://bun.sh                   (REQUIRED — compiles the single binary)
#   * nfpm  >= 2.30   https://nfpm.goreleaser.com      (OPTIONAL — only for .deb/.rpm; `brew install nfpm`)
# The single binary (served by the control-plane depot at /dist/agent/<arch> and installed by the
# zero-touch `curl|sh`) needs only bun; nfpm is just for the classic `apt install ./*.deb` path.
#
# USAGE:
#   deploy/build-agent.sh [arch]
#     arch = arm64 (default; the Apple-Silicon UTM/Parallels test VM) | amd64 (the thin clients)
#
#   env overrides:
#     VERSION=<semver>   package version (default: read from packages/agent/package.json)
#     SKIP_INSTALL=1     skip `bun install` (assume workspace deps already present)
#
# OUTPUT (into deploy/dist/):
#   polyptic-agent-<arch>                       the compiled single binary
#   polyptic-agent_<version>_<arch>.deb
#   polyptic-agent-<version>-1.<rpmarch>.rpm
#
# D7: the agent ships as a Bun single binary — one file, no runtime to install on the box.
# bun cross-compiles the runtime INTO the binary, so one host can build BOTH arches (e.g. an
# arm64 Mac builds the amd64 thin-client package too). D26: same binary + `setup` logic, packaged
# for deb AND rpm from this one config.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Resolve target arch -> (nfpm arch, bun target) ───────────────────────────────────────────────
ARCH_IN="${1:-arm64}"
case "$ARCH_IN" in
  amd64|x86_64|x64)  ARCH=amd64; BUN_TARGET=bun-linux-x64   ;;
  arm64|aarch64)     ARCH=arm64; BUN_TARGET=bun-linux-arm64 ;;
  *) echo "build-agent: unknown arch '$ARCH_IN' (expected amd64 or arm64)" >&2; exit 2 ;;
esac

# ── Version: explicit override, else parse packages/agent/package.json (no node/jq needed) ───────
if [ -z "${VERSION:-}" ]; then
  VERSION="$(grep -m1 '"version"' packages/agent/package.json \
    | sed -E 's/.*"version"[[:space:]]*:[[:space:]]*"([^"]+)".*/\1/')"
fi
if [ -z "${VERSION:-}" ]; then
  echo "build-agent: could not determine VERSION (set VERSION=... )" >&2; exit 1
fi

# ── Prereq checks ────────────────────────────────────────────────────────────────────────────────
command -v bun  >/dev/null 2>&1 || { echo "build-agent: 'bun' not found — see https://bun.sh" >&2; exit 1; }
# nfpm is OPTIONAL — it only builds the .deb/.rpm. The single binary needs only bun, so a missing
# nfpm just skips packaging (with a note) rather than failing the build.
HAVE_NFPM=0
command -v nfpm >/dev/null 2>&1 && HAVE_NFPM=1

OUT_DIR="deploy/dist"
mkdir -p "$OUT_DIR"
BIN_OUT="$OUT_DIR/polyptic-agent-$ARCH"

echo "==> Building polyptic-agent v$VERSION for $ARCH ($BUN_TARGET)"

# ── Resolve workspace deps (@polyptic/protocol, ws, zod) before compiling ───────────────────────
if [ -z "${SKIP_INSTALL:-}" ]; then
  echo "==> bun install"
  bun install
fi

# ── Compile the agent entrypoint to a single self-contained executable for the target ────────────
# Bake the version in at compile time: the standalone binary cannot read package.json off disk (bun
# compiles sources into a virtual FS), so packages/agent/src/version.ts reads this define instead —
# which is what the boot splash (POL-7) and `agent/hello` report.
echo "==> bun build --compile -> $BIN_OUT  (POLYPTIC_BUILD_VERSION=$VERSION)"
bun build \
  --compile \
  --minify \
  --define "process.env.POLYPTIC_BUILD_VERSION=\"$VERSION\"" \
  --target="$BUN_TARGET" \
  --outfile "$BIN_OUT" \
  packages/agent/src/index.ts
chmod 0755 "$BIN_OUT"

# ── Package (OPTIONAL): nfpm reads ${ARCH}/${VERSION} from the env (see deploy/nfpm.yaml). The binary
#    above is the primary artifact; .deb/.rpm are only for the classic `apt install` path. ──────────
if [ "$HAVE_NFPM" = 1 ]; then
  export ARCH VERSION
  echo "==> nfpm package (deb)"
  nfpm package --config deploy/nfpm.yaml --packager deb --target "$OUT_DIR/"
  echo "==> nfpm package (rpm)"
  nfpm package --config deploy/nfpm.yaml --packager rpm --target "$OUT_DIR/"
else
  echo "==> nfpm not installed — built the binary only, skipping .deb/.rpm."
  echo "    (the depot + curl|sh use the binary; for the classic apt path: brew install nfpm)"
fi

echo
echo "==> Done. Artifacts in $OUT_DIR/:"
ls -1 "$BIN_OUT" "$OUT_DIR"/*.deb "$OUT_DIR"/*.rpm 2>/dev/null || true
