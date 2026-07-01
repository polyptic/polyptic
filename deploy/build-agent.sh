#!/usr/bin/env bash
# deploy/build-agent.sh — compile the Polyptic agent to a single self-contained binary.
#
# The agent is delivered ONLY via the zero-touch control-plane depot (D35/D41): the server serves
# this binary at GET /dist/agent/<arch> and the box installs it with `curl -sfL …/install | sh -`.
# There is NO standalone .deb/.rpm/apt path (removed in D41). Use this script to (re)produce the
# binary that seeds the depot (AGENT_DIST_DIR) when you are not building the whole server image
# (deploy/server.Dockerfile builds the same binary for both arches inside the image).
#
# PREREQUISITE (on the BUILD host): bun >= 1.1 (https://bun.sh) — compiles the single binary.
#
# USAGE:
#   deploy/build-agent.sh [arch]
#     arch = arm64 (default; the Apple-Silicon UTM/Parallels test VM) | amd64 (the thin clients)
#
#   env overrides:
#     VERSION=<semver>   version baked into the binary (default: read from packages/agent/package.json)
#     SKIP_INSTALL=1     skip `bun install` (assume workspace deps already present)
#
# OUTPUT (into deploy/dist/):
#   polyptic-agent-<arch>                       the compiled single binary (what the depot serves)
#
# D7: the agent ships as a Bun single binary — one file, no runtime to install on the box.
# bun cross-compiles the runtime INTO the binary, so one host can build BOTH arches (e.g. an
# arm64 Mac builds the amd64 thin-client binary too).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Resolve target arch -> bun compile target ───────────────────────────────────────────────────
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

# ── OTA (POL-28): (re)generate the release manifest (version + per-arch sha256) the depot serves at
# GET /dist/agent/manifest.json. It hashes EVERY binary present in $OUT_DIR, so building each arch and
# re-running this converges to a manifest covering both. PROVISION_EPOCH env bumps the provisioning
# epoch for a provisioning-changing release (default 1).
echo "==> gen-manifest -> $OUT_DIR/manifest.json"
VERSION="$VERSION" bun deploy/gen-manifest.mjs "$OUT_DIR" "$VERSION" "${PROVISION_EPOCH:-1}"

echo
echo "==> Done. Serve this at GET /dist/agent/${ARCH} (point AGENT_DIST_DIR at $OUT_DIR/):"
ls -1 "$BIN_OUT" "$OUT_DIR/manifest.json" 2>/dev/null || true
