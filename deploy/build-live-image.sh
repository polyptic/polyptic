#!/usr/bin/env bash
# deploy/build-live-image.sh, bake a NETBOOTABLE Polyptic live image (POL-33). amd64 first.
#
# Produces into deploy/dist/image/<arch>/ (served UNGATED at GET /dist/image/<arch>/{vmlinuz,initrd,
# polyptic.iso}): vmlinuz + initrd copied VERBATIM from the base ISO's casper/ (vmlinuz IS the
# Canonical-signed PE kernel; a byte-identical copy keeps the signature, guarded below); polyptic.iso =
# a minimal casper ISO wrapping the rebuilt squashfs = base rootfs + the SAME substrate `polyptic-agent
# setup` installs today (greetd/sway/Chromium + the agent binary) + the diskless-identity overlay
# (deploy/live/). Boot flow the server's /boot/grub.cfg drives (Secure Boot stays ON):
#
#   shim → GRUB → kernel+initrd over HTTP (shim_lock verifies the SIGNED kernel on the loaded buffer) →
#   casper `iso-url=` wgets the WHOLE polyptic.iso into RAM and loop-mounts casper/filesystem.squashfs
#   inside it (NOTHING hits disk; the box needs RAM >= ~2x the ISO plus the working set) → systemd →
#   polyptic-agent-env.service derives a STABLE POLYPTIC_MACHINE_ID (DMI/MAC) + parses
#   polyptic.server_url/token off /proc/cmdline → greetd autologin → sway → the agent dials in and
#   re-attaches (enroll.ts case-4) → renders its screen slice.
#   (26.04 outlook: its ISOs still ship casper; dracut-live `root=live:` is the future path, docs cover it.)
#
# MODEL: unsquashfs the base rootfs, chroot, run the compiled `polyptic-agent setup`, overlay
# deploy/live/, mksquashfs back, wrap in a plain ISO (xorriso). The kernel is NEVER changed (apt-mark
# hold, metapackages included) so the reused ISO initrd stays matched to the squashfs's /lib/modules,
# the #1 netboot footgun.
#
# LINUX BUILD HOST ONLY, unsquashfs/mksquashfs/chroot/loop-mount are Linux-only; this CANNOT run or be
# verified on macOS. The PURE identity layer IS verifiable here: `sh deploy/live/test/identity.test.sh`
# (also wrapped by `bun test packages/e2e/netboot-identity.test.ts`).
#
# PREREQS (Linux, root): squashfs-tools (unsquashfs/mksquashfs), rsync, xorriso, sbsigntool
# (recommended; without sbverify the signed-kernel guard falls back to a bare PE cert-table check), a
# loop-mountable casper ISO, and deploy/dist/polyptic-agent-<arch> (run deploy/build-agent.sh <arch>
# first). Cross-arch arm64-on-amd64 additionally needs qemu-user-static + binfmt.
#
# USAGE:
#   sudo BASE_ISO=/path/ubuntu-24.04.x-live-server-amd64.iso deploy/build-live-image.sh [amd64|arm64]
#     env: BASE_ISO (required; a casper live ISO, Server-live keeps the squashfs small)
#          BROWSER (default cog, Chromium is snap-only on Ubuntu and unreliable in a casper overlay)
#          OUT_DIR SQUASHFS
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"

case "${1:-amd64}" in
  amd64|x86_64|x64) ARCH=amd64 ;;
  arm64|aarch64)    ARCH=arm64 ;;
  *) echo "build-live-image: unknown arch '${1:-}' (amd64|arm64)" >&2; exit 2 ;;
esac
: "${BASE_ISO:?set BASE_ISO=/path/to/ubuntu-*-live-*.iso (a casper live ISO)}"
BROWSER="${BROWSER:-cog}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/deploy/dist/image/$ARCH}"
AGENT_BIN="$REPO_ROOT/deploy/dist/polyptic-agent-$ARCH"
OVERLAY="$REPO_ROOT/deploy/live"

[ "$(uname -s)" = "Linux" ] || { echo "Linux build host required (got $(uname -s))" >&2; exit 1; }
[ "$(id -u)" = 0 ]          || { echo "must run as root (chroot + mounts)" >&2; exit 1; }
for t in unsquashfs mksquashfs rsync xorriso; do command -v "$t" >/dev/null || { echo "missing $t (squashfs-tools/rsync/xorriso)" >&2; exit 1; }; done
[ -f "$AGENT_BIN" ] || { echo "$AGENT_BIN missing, run deploy/build-agent.sh $ARCH first" >&2; exit 1; }
[ -d "$OVERLAY" ]   || { echo "$OVERLAY missing, the diskless identity overlay is required" >&2; exit 1; }

WORK="$(mktemp -d /var/tmp/polyptic-live.XXXXXX)"; ISO_MNT="$WORK/iso"; ROOTFS="$WORK/rootfs"
mkdir -p "$ISO_MNT" "$ROOTFS" "$OUT_DIR"
cleanup() {
  for m in dev/pts dev proc sys run; do mountpoint -q "$ROOTFS/$m" && umount -lf "$ROOTFS/$m" || true; done
  mountpoint -q "$ISO_MNT" && umount -lf "$ISO_MNT" || true
}
trap cleanup EXIT

echo '==> [1/8] mount base ISO'
mount -o loop,ro "$BASE_ISO" "$ISO_MNT"

echo '==> [2/8] locate casper kernel/initrd/squashfs'
VMLINUZ="$(ls "$ISO_MNT"/casper/vmlinuz* 2>/dev/null | head -n1 || true)"
INITRD="$(ls "$ISO_MNT"/casper/initrd* 2>/dev/null | head -n1 || true)"
if [ -n "${SQUASHFS:-}" ]; then SQUASH="$ISO_MNT/casper/$SQUASHFS"; else SQUASH="$(ls -S "$ISO_MNT"/casper/*.squashfs 2>/dev/null | head -n1 || true)"; fi
[ -f "$VMLINUZ" ] && [ -f "$INITRD" ] && [ -f "$SQUASH" ] || { echo 'casper artifacts not found on the ISO (is it a casper live ISO?)' >&2; exit 1; }
# Secure Boot guard: shim_lock verifies the KERNEL at the `linux` command, so an unsigned vmlinuz builds
# fine here and then dies on the box with "bad shim signature". sbverify --list ALWAYS exits 0, grep its
# output; without sbsigntool, fall back to requiring a non-empty PE cert table (data-directory entry 4).
if command -v sbverify >/dev/null 2>&1; then
  sbverify --list "$VMLINUZ" 2>/dev/null | grep -q 'Canonical Ltd. Secure Boot Signing' \
    || { echo "$VMLINUZ is not Canonical-signed, Secure Boot boxes would refuse it (repacked/unofficial ISO?)" >&2; exit 1; }
else
  python3 -c 'import struct,sys;d=open(sys.argv[1],"rb").read();assert d[:2]==b"MZ";o=struct.unpack("<I",d[60:64])[0];m=struct.unpack("<H",d[o+24:o+26])[0];dd=o+24+(112 if m==0x20b else 96)+32;va,sz=struct.unpack("<II",d[dd:dd+8]);sys.exit(0 if sz>0 else 1)' "$VMLINUZ" \
    || { echo "$VMLINUZ has an empty PE certificate table (unsigned), Secure Boot boxes would refuse it; install sbsigntool to check the signer" >&2; exit 1; }
fi

echo '==> [3/8] unsquashfs base rootfs'
rm -rf "$ROOTFS"; unsquashfs -d "$ROOTFS" "$SQUASH"

echo '==> [4/8] chroot: install the substrate via the compiled agent setup'
cp -f /etc/resolv.conf "$ROOTFS/etc/resolv.conf"   # build-host DNS; the BOX stays air-gapped
mount --bind /dev "$ROOTFS/dev"; mount --bind /dev/pts "$ROOTFS/dev/pts"
mount -t proc proc "$ROOTFS/proc"; mount -t sysfs sys "$ROOTFS/sys"; mount -t tmpfs tmp "$ROOTFS/run"
install -m0755 "$AGENT_BIN" "$ROOTFS/usr/local/bin/polyptic-agent"
chroot "$ROOTFS" /bin/sh -eux <<'CHROOT'
export DEBIAN_FRONTEND=noninteractive
# Hold the kernel so no apt operation desyncs the squashfs /lib/modules from the reused ISO initrd (the
# #1 netboot footgun). `apt-mark hold` takes LITERAL package names, a glob would match nothing, so
# expand the actually-installed kernel packages via dpkg-query first. The metapackages (linux-generic /
# linux-image-generic / linux-headers-generic + hwe variants) are held too: they are what pull a NEW
# ABI in, so holding only the concrete linux-image-6.x packages would not stop an upgrade.
held="$(dpkg-query -W -f='${Package}\n' 'linux-image-*' 'linux-headers-*' 'linux-modules-*' \
        'linux-generic*' 'linux-image-generic*' 'linux-headers-generic*' 2>/dev/null | sort -u | grep -v '^$' || true)"
[ -n "$held" ] && apt-mark hold $held || echo "no linux-* packages to hold (unusual, verify the ISO)"
apt-get update
CHROOT
# No --server-url/--bootstrap-token/--start: those arrive on the kernel cmdline at boot; greetd starts
# the agent. `setup` writes greetd autologin, the compositor launcher, sway/i3 config + the user unit.
chroot "$ROOTFS" /usr/local/bin/polyptic-agent setup \
  --backend wayland-sway --user kiosk --browser "$BROWSER" --render auto
chroot "$ROOTFS" /bin/sh -c 'apt-get clean'

echo '==> [5/8] overlay diskless identity + offload layer'
rsync -a "$OVERLAY"/ "$ROOTFS"/ --exclude test
chmod 0755 "$ROOTFS"/usr/local/lib/polyptic/*.sh
# Enable the system units OFFLINE via the same .wants symlinks `systemctl enable` would create (which
# is a no-op/warn inside a chroot).
mkdir -p "$ROOTFS/etc/systemd/system/multi-user.target.wants"
for unit in polyptic-agent-env.service polyptic-offload.service; do
  ln -sf "../$unit" "$ROOTFS/etc/systemd/system/multi-user.target.wants/$unit"
done
# Empty machine-id so systemd mints a transient one each boot (the agent ignores it, our var wins).
: > "$ROOTFS/etc/machine-id"; rm -f "$ROOTFS/var/lib/dbus/machine-id"

echo '==> [6/8] mksquashfs'
for m in dev/pts dev proc sys run; do umount -lf "$ROOTFS/$m"; done
rm -f "$ROOTFS/etc/resolv.conf" "$OUT_DIR/squashfs"   # incl. the pre-D47 bare-squashfs artifact
mksquashfs "$ROOTFS" "$WORK/filesystem.squashfs" -noappend -comp zstd -Xcompression-level 19 -no-progress
cp -f "$VMLINUZ" "$OUT_DIR/vmlinuz"; cp -f "$INITRD" "$OUT_DIR/initrd"

echo '==> [7/8] wrap the squashfs in a casper ISO'
# casper has no bare-squashfs fetch (`netboot=http fetch=` does not exist in 20.04-26.04): its iso-url=
# mode wgets a WHOLE .iso into RAM and uses /casper/*.squashfs inside it. Keep the wrapper minimal,
# every byte of it rides in the box's RAM.
STAGE="$WORK/iso-stage"
mkdir -p "$STAGE/casper" "$STAGE/.disk"
mv "$WORK/filesystem.squashfs" "$STAGE/casper/filesystem.squashfs"
du -sx --block-size=1 "$ROOTFS" | cut -f1 > "$STAGE/casper/filesystem.size"   # casper sizes the RAM overlay from this
echo "Polyptic live image ($ARCH)" > "$STAGE/.disk/info"
rm -f "$OUT_DIR/polyptic.iso"
xorriso -as mkisofs -J -r -V POLYPTIC -o "$OUT_DIR/polyptic.iso" "$STAGE"

echo "==> [8/8] done -> $OUT_DIR"
( cd "$OUT_DIR" && sha256sum vmlinuz initrd polyptic.iso > SHA256SUMS && cat SHA256SUMS )
umount -lf "$ISO_MNT"; rm -rf "$WORK"; trap - EXIT

cat <<EOF

Point IMAGE_DIST_DIR at $(dirname "$OUT_DIR"); the server serves GET /dist/image/$ARCH/{vmlinuz,initrd,polyptic.iso}.
Boxes boot these via the server's generated GET /boot/grub.cfg (no hand-written config needed). For
reference, its menu entries are equivalent to:
  linux  <net>/dist/image/$ARCH/vmlinuz boot=casper iso-url=<base>/dist/image/$ARCH/polyptic.iso ip=dhcp \\
         polyptic.base=<base> polyptic.server_url=ws://<host>/agent polyptic.token=<enrolment-token> ---
  initrd <net>/dist/image/$ARCH/initrd
casper wgets the WHOLE ISO into RAM before switching root: size the box's RAM at >= ~2x the ISO plus
the working set. (busybox wget in the casper initrd speaks plain http and resolves IPs, not DNS, use
the server's IP in <base> if DNS is absent.)
EOF
