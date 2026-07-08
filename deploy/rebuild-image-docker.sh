#!/usr/bin/env bash
# deploy/rebuild-image-docker.sh — run the live-image refresh inside a privileged Linux container
# (POL-41). This is the ready-made IMAGE_REBUILD_CMD for hosts where the control plane itself is
# not a root-privileged Linux box: a macOS dev machine, or a containerised server triggering a
# sibling container via the docker socket. The image surgery (chroot, mounts, mksquashfs) always
# happens INSIDE Linux; only the trigger runs here.
#
#   IMAGE_REBUILD_CMD="deploy/rebuild-image-docker.sh arm64"   # Console ▸ Settings ▸ Image updates
#
# USAGE: deploy/rebuild-image-docker.sh [amd64|arm64]
#   env: DOCKER_IMAGE (default ubuntu:24.04), FORCE=1 passthrough (rebuild despite no upgrades)
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ARCH="${1:-arm64}"
case "$ARCH" in
  amd64|x86_64|x64) ARCH=amd64; PLATFORM=linux/amd64 ;;
  arm64|aarch64)    ARCH=arm64; PLATFORM=linux/arm64 ;;
  *) echo "rebuild-image-docker: unknown arch '$ARCH' (amd64|arm64)" >&2; exit 2 ;;
esac
command -v docker >/dev/null || { echo "rebuild-image-docker: docker not found" >&2; exit 1; }

exec docker run --rm --privileged --platform "$PLATFORM" \
  -e "FORCE=${FORCE:-0}" \
  -v "$REPO_ROOT":/repo \
  "${DOCKER_IMAGE:-ubuntu:24.04}" \
  bash -c 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq squashfs-tools rsync xorriso cpio zstd python3 >/dev/null 2>&1 && bash /repo/deploy/refresh-live-image.sh '"$ARCH"
