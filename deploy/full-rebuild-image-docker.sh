#!/usr/bin/env bash
# deploy/full-rebuild-image-docker.sh — the WEEKLY full-rebuild hook (POL-43), Docker edition.
# Sibling of rebuild-image-docker.sh (the daily in-place refresh): where the refresh apt-upgrades
# the existing squashfs with the kernel HELD, this one rebuilds the live image FROM SCRATCH with
# deploy/build-live-image.sh — a fresh ubuntu-base rootfs and the archive's current
# Canonical-signed kernel. This is the cycle that rolls KERNEL CVEs; everything else refreshes
# nightly.
#
# What it does (host side, then a privileged Linux container):
#   1. ensures the compiled agent binary exists (bun cross-compiles on macOS/Linux alike);
#   2. runs deploy/build-live-image.sh inside a privileged ubuntu:24.04 container (chroot + apt +
#      mksquashfs need Linux root — the container IS the Linux build host). The ubuntu-base tarball
#      the build starts from is cached under deploy/dist/cache/ by the build script itself.
#
# Wire it up:   IMAGE_FULL_REBUILD_CMD="deploy/full-rebuild-image-docker.sh arm64"
# (the server runs hooks from the repo root; Console ▸ Settings ▸ Update schedule schedules it,
#  default Sundays 02:00, plus a "Full rebuild" item in the ⋯ menu).
#
# USAGE:
#   deploy/full-rebuild-image-docker.sh [amd64|arm64]
#     env: UBUNTU_RELEASE  the ubuntu-base release + archive suite to build from (default 26.04)
#          FULL_FIRMWARE=1 ship the whole linux-firmware set (see build-live-image.sh)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-arm64}" in
  amd64|x86_64|x64) ARCH=amd64; PLATFORM=linux/amd64 ;;
  arm64|aarch64)    ARCH=arm64; PLATFORM=linux/arm64 ;;
  *) echo "full-rebuild-image-docker: unknown arch '${1:-}' (amd64|arm64)" >&2; exit 2 ;;
esac
command -v docker >/dev/null || { echo "docker not found — this hook builds inside a privileged Linux container" >&2; exit 1; }

echo "==> [1/2] agent binary"
AGENT_BIN="$REPO_ROOT/deploy/dist/polyptic-agent-$ARCH"
if [ ! -f "$AGENT_BIN" ]; then
  command -v bun >/dev/null || { echo "no $AGENT_BIN and no bun to build it — run deploy/build-agent.sh $ARCH first" >&2; exit 1; }
  bash "$REPO_ROOT/deploy/build-agent.sh" "$ARCH"
fi

# The container sees the repo at /repo. build-live-image.sh chroots the rootfs it unpacks, which is
# why the container must be --privileged.
echo "==> [2/2] build-live-image.sh in a privileged $PLATFORM container"
exec docker run --rm --privileged --platform "$PLATFORM" \
  -e UBUNTU_RELEASE="${UBUNTU_RELEASE:-26.04}" \
  -e FULL_FIRMWARE="${FULL_FIRMWARE:-0}" \
  -v "$REPO_ROOT:/repo" \
  ubuntu:24.04 bash -c '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq squashfs-tools rsync curl ca-certificates zstd python3 sbsigntool >/dev/null
    bash /repo/deploy/build-live-image.sh '"$ARCH"'
  '
