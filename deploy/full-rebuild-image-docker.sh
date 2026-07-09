#!/usr/bin/env bash
# deploy/full-rebuild-image-docker.sh — the WEEKLY full-rebuild hook (POL-43), Docker edition.
# Sibling of rebuild-image-docker.sh (the daily in-place refresh): where the refresh apt-upgrades
# the existing squashfs with the kernel HELD (D47), this one rebuilds the live image FROM THE BASE
# ISO with deploy/build-live-image.sh — picking up the base ISO's current Canonical-signed kernel.
# This is the cycle that rolls KERNEL CVEs; everything else refreshes nightly.
#
# What it does (host side, then a privileged Linux container):
#   1. ensures the compiled agent binary exists (bun cross-compiles on macOS/Linux alike);
#   2. ensures the base ISO is cached under deploy/dist/cache/ (downloads BASE_ISO_URL once);
#   3. runs deploy/build-live-image.sh inside a privileged ubuntu:24.04 container
#      (unsquashfs/chroot/loop mounts need Linux root — the container IS the Linux build host).
#
# Wire it up:   IMAGE_FULL_REBUILD_CMD="deploy/full-rebuild-image-docker.sh arm64"
# (the server runs hooks from the repo root; Console ▸ Settings ▸ Image updates schedules it,
#  default Sundays 02:00, plus a "Full rebuild now" button).
#
# USAGE:
#   deploy/full-rebuild-image-docker.sh [amd64|arm64]
#     env: BASE_ISO      path to a local casper live ISO (skips the download)
#          BASE_ISO_URL  where to fetch the base ISO from (cached; default: Ubuntu 26.04 live-server)
#          UBUNTU_RELEASE  release used for the default BASE_ISO_URL (default 26.04)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-arm64}" in
  amd64|x86_64|x64) ARCH=amd64; PLATFORM=linux/amd64 ;;
  arm64|aarch64)    ARCH=arm64; PLATFORM=linux/arm64 ;;
  *) echo "full-rebuild-image-docker: unknown arch '${1:-}' (amd64|arm64)" >&2; exit 2 ;;
esac
command -v docker >/dev/null || { echo "docker not found — this hook builds inside a privileged Linux container" >&2; exit 1; }

UBUNTU_RELEASE="${UBUNTU_RELEASE:-26.04}"
# arm64 lives on cdimage.ubuntu.com; amd64 on releases.ubuntu.com. Both are casper live-server ISOs.
if [ -z "${BASE_ISO_URL:-}" ]; then
  case "$ARCH" in
    arm64) BASE_ISO_URL="https://cdimage.ubuntu.com/releases/${UBUNTU_RELEASE}/release/ubuntu-${UBUNTU_RELEASE}-live-server-arm64.iso" ;;
    amd64) BASE_ISO_URL="https://releases.ubuntu.com/${UBUNTU_RELEASE}/ubuntu-${UBUNTU_RELEASE}-live-server-amd64.iso" ;;
  esac
fi

echo "==> [1/3] agent binary"
AGENT_BIN="$REPO_ROOT/deploy/dist/polyptic-agent-$ARCH"
if [ ! -f "$AGENT_BIN" ]; then
  command -v bun >/dev/null || { echo "no $AGENT_BIN and no bun to build it — run deploy/build-agent.sh $ARCH first" >&2; exit 1; }
  bash "$REPO_ROOT/deploy/build-agent.sh" "$ARCH"
fi

echo "==> [2/3] base ISO"
if [ -n "${BASE_ISO:-}" ]; then
  [ -f "$BASE_ISO" ] || { echo "BASE_ISO=$BASE_ISO does not exist" >&2; exit 1; }
  ISO_HOST="$BASE_ISO"
else
  CACHE_DIR="$REPO_ROOT/deploy/dist/cache"
  mkdir -p "$CACHE_DIR"
  ISO_HOST="$CACHE_DIR/$(basename "$BASE_ISO_URL")"
  if [ ! -f "$ISO_HOST" ]; then
    echo "    downloading $BASE_ISO_URL (cached for future runs)"
    curl -fL --progress-bar -o "$ISO_HOST.part" "$BASE_ISO_URL"
    mv "$ISO_HOST.part" "$ISO_HOST"
  else
    echo "    cache hit: $ISO_HOST"
  fi
fi

# The container sees the repo at /repo and the ISO at /base.iso; build-live-image.sh loop-mounts the
# ISO and chroots the unsquashed rootfs, which is why the container must be --privileged.
echo "==> [3/3] build-live-image.sh in a privileged $PLATFORM container"
case "$ISO_HOST" in
  "$REPO_ROOT"/*) ISO_MOUNT=(); ISO_IN_CONTAINER="/repo${ISO_HOST#"$REPO_ROOT"}" ;;
  *)              ISO_MOUNT=(-v "$ISO_HOST:/base.iso:ro"); ISO_IN_CONTAINER="/base.iso" ;;
esac
exec docker run --rm --privileged --platform "$PLATFORM" \
  -e BASE_ISO="$ISO_IN_CONTAINER" \
  -e BROWSER="${BROWSER:-auto}" \
  -v "$REPO_ROOT:/repo" \
  ubuntu:24.04 bash -c '
    set -euo pipefail
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y -qq squashfs-tools rsync xorriso cpio zstd python3 sbsigntool >/dev/null
    bash /repo/deploy/build-live-image.sh '"$ARCH"'
  '
