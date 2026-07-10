#!/usr/bin/env bash
# deploy/refresh-live-image.sh — refresh an EXISTING live image with the latest Ubuntu bug/security
# fixes (POL-41). This is the nightly "updates" half of the netboot story: the control plane runs it
# on a schedule (IMAGE_REBUILD_CMD, Console ▸ Settings ▸ Update schedule, default 01:00), boxes notice
# the new image id on their 5-minute update poll, and a reboot IS the re-pull — the OS streams from
# the server at every boot, so a refreshed image rolls out with zero per-box work.
#
# MODEL: take the CURRENT netboot payload (deploy/dist/image/<arch>/rootfs.squashfs), unsquash it,
# `apt-get upgrade` it in a chroot (security + updates pockets; the kernel packages stay HELD so the
# published vmlinuz/initrd keep matching the rootfs's /lib/modules), re-squash it, and stamp a NEW
# image id. If apt has nothing to upgrade the script exits WITHOUT touching the artifacts (no image-id
# churn, no pointless fleet reboots); force with FORCE=1.
#
# KERNEL CVEs ARE OUT OF SCOPE by design — not because the old footgun forces it (POL-35 deleted that:
# kernel, modules and initrd now come from one apt transaction), but because a kernel bump means
# republishing vmlinuz + rebuilding the initrd, which is exactly what the weekly full rebuild
# (deploy/build-live-image.sh) does. Everything else (openssl, glibc, browsers, sway, …) refreshes here.
#
# LINUX ROOT ONLY (chroot), container-friendly: the same privileged Docker recipe as
# build-live-image.sh works (apt-get install squashfs-tools rsync curl).
#
# USAGE:
#   sudo deploy/refresh-live-image.sh [amd64|arm64]
#     env: OUT_DIR   artifact dir (default deploy/dist/image/<arch>; rootfs.squashfs is read+replaced)
#          FORCE=1   rebuild even when apt reports nothing to upgrade
#          APT_ARGS  extra args for the upgrade (default "-o APT::Get::Always-Include-Phased-Updates=true")
#
# After a refresh, regenerate the DOWNLOADABLE live ISO too (any machine):
#   POLYPTIC_BASE=... POLYPTIC_TOKEN=... deploy/build-live-iso.sh <arch>
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-arm64}" in
  amd64|x86_64|x64) ARCH=amd64 ;;
  arm64|aarch64)    ARCH=arm64 ;;
  *) echo "refresh-live-image: unknown arch '${1:-}' (amd64|arm64)" >&2; exit 2 ;;
esac
OUT_DIR="${OUT_DIR:-$REPO_ROOT/deploy/dist/image/$ARCH}"
PAYLOAD="$OUT_DIR/rootfs.squashfs"
APT_ARGS="${APT_ARGS:--o APT::Get::Always-Include-Phased-Updates=true}"
SQUASHFS_BLOCK="${SQUASHFS_BLOCK:-1M}"

[ "$(uname -s)" = "Linux" ] || { echo "Linux host required (got $(uname -s))" >&2; exit 1; }
[ "$(id -u)" = 0 ]          || { echo "must run as root (chroot + mounts)" >&2; exit 1; }
for t in unsquashfs mksquashfs; do command -v "$t" >/dev/null || { echo "missing $t (squashfs-tools)" >&2; exit 1; }; done
[ -f "$PAYLOAD" ] || { echo "no payload at $PAYLOAD — build one first (deploy/build-live-image.sh $ARCH)" >&2; exit 1; }

WORK="$(mktemp -d /var/tmp/polyptic-refresh.XXXXXX)"; ROOTFS="$WORK/rootfs"
cleanup() { for m in dev/pts dev proc sys run; do mountpoint -q "$ROOTFS/$m" 2>/dev/null && umount -lf "$ROOTFS/$m" || true; done; rm -rf "$WORK"; }
trap cleanup EXIT

echo '==> [1/5] unpack the current payload'
unsquashfs -q -d "$ROOTFS" "$PAYLOAD" >/dev/null

echo '==> [2/5] chroot: apt upgrade (kernel stays held)'
rm -f "$ROOTFS/etc/resolv.conf"
if [ -s /run/systemd/resolve/resolv.conf ]; then cp -fL /run/systemd/resolve/resolv.conf "$ROOTFS/etc/resolv.conf"; else cp -fL /etc/resolv.conf "$ROOTFS/etc/resolv.conf"; fi
mount --bind /dev "$ROOTFS/dev"; mount --bind /dev/pts "$ROOTFS/dev/pts"
mount -t proc proc "$ROOTFS/proc"; mount -t sysfs sys "$ROOTFS/sys"; mount -t tmpfs tmp "$ROOTFS/run"
# Hold the kernel for the duration of THIS upgrade: the published vmlinuz + initrd are not rebuilt
# here, so a new kernel ABI would leave the rootfs's /lib/modules pointing at a kernel the boot chain
# never serves. `apt-mark hold` takes LITERAL package names, so expand the installed set via
# dpkg-query; the metapackages are held too, since they are what pull a new ABI in.
chroot "$ROOTFS" /bin/sh -eux <<'CHROOT'
export DEBIAN_FRONTEND=noninteractive
held="$(dpkg-query -W -f='${Package}\n' 'linux-image-*' 'linux-headers-*' 'linux-modules-*' \
        'linux-generic*' 'linux-image-generic*' 'linux-headers-generic*' 2>/dev/null | sort -u | grep -v '^$' || true)"
[ -n "$held" ] && apt-mark hold $held >/dev/null || echo "no linux-* packages to hold (unusual)"
apt-get update -qq
CHROOT
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

echo '==> [3/5] stamp the new image id'
IMAGE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s\n' "$IMAGE_ID" > "$ROOTFS/etc/polyptic/image-id"
chmod 0644 "$ROOTFS/etc/polyptic/image-id"

echo '==> [4/5] mksquashfs'
# A kernel-hook package may have regenerated /boot during the upgrade; the boot chain serves the
# published vmlinuz/initrd, never the ones inside the root image (see build-live-image.sh step 8).
rm -f "$ROOTFS"/boot/vmlinuz-* "$ROOTFS"/boot/initrd.img-* "$ROOTFS"/boot/System.map-* "$ROOTFS"/boot/config-*
rm -rf "$ROOTFS"/var/lib/apt/lists/* "$ROOTFS"/var/cache/apt/archives/*.deb
mksquashfs "$ROOTFS" "$WORK/rootfs.squashfs" -noappend -comp zstd -Xcompression-level 19 -b "$SQUASHFS_BLOCK" -no-progress
# `mv` allocates a NEW inode, which is what lets the depot hardlink the payload between the arch root
# and the retained build directory without a refresh rewriting history (see image-updates.ts SHAREABLE).
mv -f "$WORK/rootfs.squashfs" "$PAYLOAD"

echo '==> [5/5] publish image id + checksums'
printf '%s\n' "$IMAGE_ID" > "$OUT_DIR/image-id.txt"
# initrd-wifi (POL-63) exists on post-Wi-Fi builds only; the refresh carries it through unchanged
# (the kernel is held, so both initrds stay matched) and its checksum is what the boxes' update-poll
# verifies a medium refresh against.
( cd "$OUT_DIR" && sha256sum vmlinuz initrd $([ -f initrd-wifi ] && echo initrd-wifi) rootfs.squashfs > SHA256SUMS && cat SHA256SUMS )
echo "==> refreshed -> $PAYLOAD (image id $IMAGE_ID, $(du -h "$PAYLOAD" | cut -f1))"
echo "    Boxes on the 5-minute update poll will reboot per policy (urgent: now; else the nightly window)."
