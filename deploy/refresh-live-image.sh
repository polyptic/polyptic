#!/usr/bin/env bash
# deploy/refresh-live-image.sh — refresh an EXISTING live image with the latest Ubuntu bug/security
# fixes (POL-41). This is the nightly "updates" half of the netboot story: the control plane runs it
# on a schedule (IMAGE_REBUILD_CMD, Console ▸ Settings ▸ Image updates, default 01:00), boxes notice
# the new image id on their 5-minute update poll, and a reboot IS the re-pull — the OS streams from
# the server at every boot, so a refreshed image rolls out with zero per-box work.
#
# MODEL: take the CURRENT netboot payload (deploy/dist/image/<arch>/polyptic.iso), unsquash its
# rootfs, `apt-get upgrade` it in a chroot (security + updates pockets; the kernel packages stay
# HELD from the original build so /lib/modules never drifts from the reused initrd — the D47
# invariant), re-wrap it, and stamp a NEW image id. If apt has nothing to upgrade the script exits
# WITHOUT touching the artifacts (no image-id churn, no pointless fleet reboots); force with
# FORCE=1.
#
# KERNEL CVEs ARE OUT OF SCOPE by design: the kernel is pinned to the base ISO's Canonical-signed
# build. A kernel bump = rebuild from a newer base ISO with deploy/build-live-image.sh (documented
# in NETBOOT.md). Everything else (openssl, glibc, browsers, sway, ...) refreshes here.
#
# LINUX ROOT ONLY (chroot + loop-ish mounts), container-friendly: the same privileged Docker recipe
# as build-live-image.sh works (apt-get install squashfs-tools rsync xorriso cpio zstd python3).
#
# USAGE:
#   sudo deploy/refresh-live-image.sh [amd64|arm64]
#     env: OUT_DIR   artifact dir (default deploy/dist/image/<arch>; polyptic.iso is read+replaced)
#          FORCE=1   rebuild even when apt reports nothing to upgrade
#          APT_ARGS  extra args for the upgrade (default "-o APT::Get::Always-Include-Phased-Updates=true")
#
# After a refresh, regenerate the DOWNLOADABLE live ISO too (any machine):
#   POLYPTIC_BASE=... POLYPTIC_TOKEN=... BASE_ISO=... deploy/build-live-iso.sh <arch>
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-arm64}" in
  amd64|x86_64|x64) ARCH=amd64 ;;
  arm64|aarch64)    ARCH=arm64 ;;
  *) echo "refresh-live-image: unknown arch '${1:-}' (amd64|arm64)" >&2; exit 2 ;;
esac
OUT_DIR="${OUT_DIR:-$REPO_ROOT/deploy/dist/image/$ARCH}"
PAYLOAD="$OUT_DIR/polyptic.iso"
APT_ARGS="${APT_ARGS:--o APT::Get::Always-Include-Phased-Updates=true}"

[ "$(uname -s)" = "Linux" ] || { echo "Linux host required (got $(uname -s))" >&2; exit 1; }
[ "$(id -u)" = 0 ]          || { echo "must run as root (chroot + mounts)" >&2; exit 1; }
for t in unsquashfs mksquashfs xorriso; do command -v "$t" >/dev/null || { echo "missing $t (squashfs-tools/xorriso)" >&2; exit 1; }; done
[ -f "$PAYLOAD" ] || { echo "no payload at $PAYLOAD — build one first (deploy/build-live-image.sh $ARCH)" >&2; exit 1; }

WORK="$(mktemp -d /var/tmp/polyptic-refresh.XXXXXX)"; ROOTFS="$WORK/rootfs"
cleanup() { for m in dev/pts dev proc sys run; do mountpoint -q "$ROOTFS/$m" 2>/dev/null && umount -lf "$ROOTFS/$m" || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

echo '==> [1/6] unpack the current payload'
xorriso -osirrox on -indev "$PAYLOAD" -extract / "$WORK/tree" >/dev/null 2>&1
chmod -R u+w "$WORK/tree"
unsquashfs -q -d "$ROOTFS" "$WORK/tree/casper/filesystem.squashfs" >/dev/null

echo '==> [2/6] chroot: apt upgrade (kernel stays held)'
rm -f "$ROOTFS/etc/resolv.conf"
if [ -s /run/systemd/resolve/resolv.conf ]; then cp -fL /run/systemd/resolve/resolv.conf "$ROOTFS/etc/resolv.conf"; else cp -fL /etc/resolv.conf "$ROOTFS/etc/resolv.conf"; fi
mount --bind /dev "$ROOTFS/dev"; mount --bind /dev/pts "$ROOTFS/dev/pts"
mount -t proc proc "$ROOTFS/proc"; mount -t sysfs sys "$ROOTFS/sys"; mount -t tmpfs tmp "$ROOTFS/run"
chroot "$ROOTFS" /bin/sh -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq'
# Simulate first: an image with zero pending upgrades must NOT churn the image id (a new id makes
# the whole fleet reboot for nothing). `apt-get -s upgrade` lists "Inst" lines per package.
PENDING="$(chroot "$ROOTFS" /bin/sh -c "apt-get -s upgrade $APT_ARGS 2>/dev/null | grep -c '^Inst '" || true)"
echo "    pending upgrades: $PENDING"
if [ "${PENDING:-0}" = "0" ] && [ "${FORCE:-0}" != "1" ]; then
  echo '==> nothing to upgrade — artifacts left untouched (FORCE=1 overrides)'
  exit 0
fi
chroot "$ROOTFS" /bin/sh -c "DEBIAN_FRONTEND=noninteractive apt-get -y upgrade $APT_ARGS"
chroot "$ROOTFS" /bin/sh -c 'apt-get clean'
# Re-stamp the ConditionNeedsUpdate markers AFTER the upgrade (see build-live-image.sh: without
# this every boot re-runs ldconfig for ~a minute on the splash).
touch "$ROOTFS/etc/.updated" "$ROOTFS/var/.updated"
for m in dev/pts dev proc sys run; do umount -lf "$ROOTFS/$m"; done
rm -f "$ROOTFS/etc/resolv.conf"

echo '==> [3/6] stamp the new image id'
IMAGE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s\n' "$IMAGE_ID" > "$ROOTFS/etc/polyptic/image-id"
chmod 0644 "$ROOTFS/etc/polyptic/image-id"

echo '==> [4/6] mksquashfs'
mksquashfs "$ROOTFS" "$WORK/filesystem.squashfs" -noappend -comp zstd -Xcompression-level 19 -no-progress
mv -f "$WORK/filesystem.squashfs" "$WORK/tree/casper/filesystem.squashfs"
du -sx --block-size=1 "$ROOTFS" | cut -f1 > "$WORK/tree/casper/filesystem.size"

echo '==> [5/6] re-wrap the payload ISO'
rm -f "$WORK/new.iso"
xorriso -as mkisofs -J -r -V POLYPTIC -o "$WORK/new.iso" "$WORK/tree" >/dev/null 2>&1
mv -f "$WORK/new.iso" "$PAYLOAD"

echo '==> [6/6] publish image id + checksums'
printf '%s\n' "$IMAGE_ID" > "$OUT_DIR/image-id.txt"
( cd "$OUT_DIR" && sha256sum vmlinuz initrd polyptic.iso > SHA256SUMS && cat SHA256SUMS )
echo "==> refreshed -> $PAYLOAD (image id $IMAGE_ID)"
echo "    Boxes on the 5-minute update poll will reboot per policy (urgent: now; else the nightly window)."
