#!/usr/bin/env bash
# deploy/build-live-image.sh — bake the NETBOOTABLE Polyptic live image (POL-33/D47, rebuilt for
# POL-35). Produces into deploy/dist/image/<arch>/ (served UNGATED at GET /dist/image/<arch>/…):
#
#   vmlinuz          the chroot's own /boot/vmlinuz-<kver>, a Canonical-signed EFI PE (guarded below)
#   initrd           a dracut initramfs built IN the chroot, matched to the same apt transaction
#   rootfs.squashfs  a BARE squashfs — no ISO wrapper, no casper
#   SHA256SUMS, image-id.txt
#
# Boot flow the server's /boot/grub.cfg drives (Secure Boot stays ON):
#
#   shim → GRUB → vmlinuz + initrd over HTTP (shim_lock verifies the SIGNED kernel on the loaded
#   buffer; the initrd is verification-exempt, the standard shim model) → dracut's livenet curls
#   rootfs.squashfs into the initramfs tmpfs and dmsquash-live loop-mounts it under an overlayfs
#   (NOTHING hits disk) → systemd → polyptic-agent-env.service derives a STABLE
#   POLYPTIC_MACHINE_ID (DMI/MAC) + parses polyptic.server_url/token off /proc/cmdline → greetd
#   autologin → sway → the agent dials in and re-attaches (enroll.ts case-4) → renders its screen.
#
# MODEL (POL-35): build the rootfs UP from `ubuntu-base` instead of trimming DOWN from the live-server
# installer's squashfs. apt installs the kernel, dracut, a curated firmware set and the same substrate
# `polyptic-agent setup` installs today (greetd/sway/surf + the agent binary); deploy/live/ overlays the
# diskless-identity layer; dracut then builds the initramfs against THAT kernel's modules. Kernel,
# modules and initrd all come out of one apt transaction, so the old `apt-mark hold` gymnastics and the
# byte-identical-initrd constraint — the #1 netboot footgun — are gone rather than maintained.
#
# There is no BASE_ISO input any more, and no xorriso stage: casper needed a whole `.iso` for its
# `iso-url=` fetch, dracut takes the bare squashfs at `root=live:<url>`.
#
# LINUX BUILD HOST ONLY (chroot + mksquashfs); this CANNOT run or be verified on macOS. Use
# deploy/full-rebuild-image-docker.sh to run it in a privileged container from anywhere. The PURE
# identity layer IS verifiable on macOS: `sh deploy/live/test/identity.test.sh`.
#
# PREREQS (Linux, root): squashfs-tools, rsync, curl, sbsigntool (recommended; without sbverify the
# signed-kernel guard falls back to a bare PE cert-table check), and deploy/dist/polyptic-agent-<arch>
# (run deploy/build-agent.sh <arch> first). Cross-arch arm64-on-amd64 additionally needs
# qemu-user-static + binfmt.
#
# USAGE:
#   sudo deploy/build-live-image.sh [amd64|arm64]
#     env: UBUNTU_RELEASE  (default 26.04) the ubuntu-base release + archive suite
#          SUITE           (default derived: 26.04 → resolute)
#          MIRROR          (default archive.ubuntu.com on amd64, ports.ubuntu.com on arm64)
#          BROWSER         (default surf; the kiosk browser `setup` installs)
#          FULL_FIRMWARE=1 ship the whole `linux-firmware` (~600 MB) instead of the curated set —
#                          the escape hatch for hardware whose blobs we did not anticipate
#          FIRMWARE_PACKAGES  override the curated set outright (space-separated; "" = none)
#          SQUASHFS_BLOCK  (default 1M) mksquashfs block size
#          BASE_TARBALL    a local ubuntu-base tarball (skips the download)
#          OUT_DIR CACHE_DIR
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"; cd "$REPO_ROOT"

case "${1:-amd64}" in
  amd64|x86_64|x64) ARCH=amd64; DEFAULT_MIRROR=http://archive.ubuntu.com/ubuntu ;;
  arm64|aarch64)    ARCH=arm64; DEFAULT_MIRROR=http://ports.ubuntu.com/ubuntu-ports ;;
  *) echo "build-live-image: unknown arch '${1:-}' (amd64|arm64)" >&2; exit 2 ;;
esac
UBUNTU_RELEASE="${UBUNTU_RELEASE:-26.04}"
# The archive suite (codename) for the release. Only the releases we actually build against.
case "$UBUNTU_RELEASE" in
  26.04) DEFAULT_SUITE=resolute ;;
  25.10) DEFAULT_SUITE=questing ;;
  *) DEFAULT_SUITE="" ;;
esac
SUITE="${SUITE:-$DEFAULT_SUITE}"
[ -n "$SUITE" ] || { echo "build-live-image: unknown UBUNTU_RELEASE '$UBUNTU_RELEASE' — set SUITE=<codename>" >&2; exit 2; }
MIRROR="${MIRROR:-$DEFAULT_MIRROR}"
BROWSER="${BROWSER:-surf}"
SQUASHFS_BLOCK="${SQUASHFS_BLOCK:-1M}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/deploy/dist/image/$ARCH}"
CACHE_DIR="${CACHE_DIR:-$REPO_ROOT/deploy/dist/cache}"
AGENT_BIN="$REPO_ROOT/deploy/dist/polyptic-agent-$ARCH"
OVERLAY="$REPO_ROOT/deploy/live"
BASE_TARBALL_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/${UBUNTU_RELEASE}/release/ubuntu-base-${UBUNTU_RELEASE}-base-${ARCH}.tar.gz"

# The curated firmware set (POL-35). Full `linux-firmware` is ~600 MB already-compressed and would
# erase most of the size win, so 26.04's per-vendor split packages let us ship only what a kiosk
# fleet plausibly has: a minimal core plus the two GPU vendors and the common Realtek NICs. A box
# with something else gets a black screen or a dead NIC — that is what FULL_FIRMWARE=1 is for.
# Packages absent for the arch are skipped, not fatal (arm64 has no intel/amd graphics blobs).
DEFAULT_FIRMWARE="linux-firmware-minimal linux-firmware-intel-graphics linux-firmware-amd-graphics linux-firmware-realtek"
if [ "${FULL_FIRMWARE:-0}" = "1" ]; then
  FIRMWARE_PACKAGES="${FIRMWARE_PACKAGES-linux-firmware}"
else
  FIRMWARE_PACKAGES="${FIRMWARE_PACKAGES-$DEFAULT_FIRMWARE}"
fi
# The Wi-Fi stack (POL-63): every major vendor's wlan blobs (the fleet's chipsets are not known up
# front, and a Wi-Fi box that boots with a dead radio has no other path to the control plane;
# Realtek rtw88/89 already rides the wired set) plus the supplicant. INSTALLED BETWEEN THE TWO
# DRACUT RUNS in step 6, deliberately: dracut's kernel-network-modules pulls all of =drivers/net in
# --no-hostonly mode and bundles firmware for every module it installs, so any wlan firmware present
# when the LEAN initrd builds would silently ride the wired GRUB fetch (+74 MB measured; and
# --omit-drivers can't exclude a subtree, its entries are ^anchored$ module names). Under
# FULL_FIRMWARE=1 the wireless blobs are already in `linux-firmware` from step 3 — the lean initrd
# absorbs them exactly as it did pre-POL-63; that escape hatch has always traded size for coverage.
WIFI_PACKAGES="wpasupplicant wireless-regdb iw"
if [ "${FULL_FIRMWARE:-0}" = "1" ]; then
  WIFI_FIRMWARE_PACKAGES="${WIFI_FIRMWARE_PACKAGES-}"
else
  WIFI_FIRMWARE_PACKAGES="${WIFI_FIRMWARE_PACKAGES-linux-firmware-intel-wireless linux-firmware-qualcomm-wireless linux-firmware-mediatek linux-firmware-broadcom-wireless linux-firmware-marvell-wireless}"
fi

[ "$(uname -s)" = "Linux" ] || { echo "Linux build host required (got $(uname -s))" >&2; exit 1; }
[ "$(id -u)" = 0 ]          || { echo "must run as root (chroot + mounts)" >&2; exit 1; }
for t in mksquashfs rsync curl; do command -v "$t" >/dev/null || { echo "missing $t (squashfs-tools/rsync/curl)" >&2; exit 1; }; done
[ -f "$AGENT_BIN" ] || { echo "$AGENT_BIN missing, run deploy/build-agent.sh $ARCH first" >&2; exit 1; }
[ -d "$OVERLAY" ]   || { echo "$OVERLAY missing, the diskless identity overlay is required" >&2; exit 1; }

WORK="$(mktemp -d /var/tmp/polyptic-live.XXXXXX)"; ROOTFS="$WORK/rootfs"
mkdir -p "$ROOTFS" "$OUT_DIR" "$CACHE_DIR"
cleanup() { for m in dev/pts dev proc sys run; do mountpoint -q "$ROOTFS/$m" 2>/dev/null && umount -lf "$ROOTFS/$m" || true; done; }
trap cleanup EXIT

echo "==> [1/8] ubuntu-base $UBUNTU_RELEASE ($ARCH)"
BASE_TARBALL="${BASE_TARBALL:-$CACHE_DIR/$(basename "$BASE_TARBALL_URL")}"
if [ ! -f "$BASE_TARBALL" ]; then
  echo "    downloading $BASE_TARBALL_URL (cached for future runs)"
  curl -fL --progress-bar -o "$BASE_TARBALL.part" "$BASE_TARBALL_URL"
  mv "$BASE_TARBALL.part" "$BASE_TARBALL"
else
  echo "    cache hit: $BASE_TARBALL"
fi
tar -xzf "$BASE_TARBALL" -C "$ROOTFS"

echo '==> [2/8] apt sources + chroot mounts'
# The chroot needs WORKING DNS to apt-get the substrate. A modern build host's /etc/resolv.conf is the
# systemd-resolved STUB (nameserver 127.0.0.53), which resolves nothing inside a chroot with no resolved
# running; prefer systemd-resolved's real-upstream file when present. The image never ships this (step 7
# deletes it before mksquashfs), so the booted box stays on its own DHCP/agent DNS.
rm -f "$ROOTFS/etc/apt/sources.list"; rm -f "$ROOTFS"/etc/apt/sources.list.d/*
cat > "$ROOTFS/etc/apt/sources.list.d/ubuntu.sources" <<EOF
Types: deb
URIs: $MIRROR
Suites: $SUITE $SUITE-updates $SUITE-security
Components: main universe
Signed-By: /usr/share/keyrings/ubuntu-archive-keyring.gpg
EOF
# Ship no man pages, no /usr/share/doc except the copyright files, no translated docs. Set BEFORE the
# first install so nothing is unpacked and then deleted (a later `rm -rf` would be undone by any
# package the nightly refresh reinstalls).
mkdir -p "$ROOTFS/etc/dpkg/dpkg.cfg.d"
cat > "$ROOTFS/etc/dpkg/dpkg.cfg.d/01-polyptic-nodoc" <<'EOF'
path-exclude /usr/share/doc/*
path-include /usr/share/doc/*/copyright
path-exclude /usr/share/man/*
path-exclude /usr/share/info/*
path-exclude /usr/share/groff/*
path-exclude /usr/share/lintian/*
path-exclude /usr/share/help/*
EOF
rm -f "$ROOTFS/etc/resolv.conf"
if [ -s /run/systemd/resolve/resolv.conf ]; then cp -fL /run/systemd/resolve/resolv.conf "$ROOTFS/etc/resolv.conf"
else cp -fL /etc/resolv.conf "$ROOTFS/etc/resolv.conf"; fi
mount --bind /dev "$ROOTFS/dev"; mount --bind /dev/pts "$ROOTFS/dev/pts"
mount -t proc proc "$ROOTFS/proc"; mount -t sysfs sys "$ROOTFS/sys"; mount -t tmpfs tmp "$ROOTFS/run"

echo '==> [3/8] chroot: kernel, dracut, init, firmware'
# THE KERNEL IS INSTALLED BY ITS CONCRETE NAME, NOT VIA `linux-image-generic`. The metapackage
# *Depends* (not Recommends) on `linux-firmware`, which in turn Depends on all eighteen per-vendor
# firmware packages — ~600 MB that `--no-install-recommends` cannot decline — plus the ZFS modules.
# The concrete `linux-image-<abi>-generic` depends only on kmod/linux-base/linux-modules, so we
# resolve the ABI the metapackage currently points at and install that. It is the SAME
# Canonical-signed PE the live-server ISO ships (both come from the `linux-signed` source), so the
# signature guard in step 7 passes unchanged; apt is just a different courier.
#
# `dmsetup` and `curl` are not decoration: dracut's `dm` module (which dmsquash-live requires) and
# its `url-lib` module (which livenet requires) refuse to install without them, and dracut reports
# that as "Module 'dmsquash-live' cannot be installed" long after you have stopped reading.
# initramfs-tools is deliberately absent: dracut is the generator, and two generators fighting over
# /boot/initrd.img-* is exactly the desync this rebuild deletes.
chroot "$ROOTFS" /bin/sh -eux <<CHROOT
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
kernel="\$(apt-cache depends linux-image-generic | sed -n 's/.*Depends: \(linux-image-[0-9][^ ]*\)/\1/p' | head -n1)"
[ -n "\$kernel" ] || { echo "cannot resolve the concrete kernel package behind linux-image-generic" >&2; exit 1; }
echo "    kernel package: \$kernel"
# procps (top/ps/free/vmstat) is deliberate, not bloat (~1.5 MB): the first hot box in the field
# had NO way to answer "what is eating this CPU" from its debug shell (POL-35, 2026-07-10).
# The Wi-Fi stack (wpasupplicant + wlan firmware, POL-63) is NOT here — it lands between the two
# dracut runs in step 6, so the lean wired initrd never absorbs it (see WIFI_PACKAGES above).
apt-get install -y --no-install-recommends \
  systemd-sysv systemd-resolved libpam-systemd udev dbus kmod dmsetup \
  iproute2 netplan.io ca-certificates curl efibootmgr procps \
  "\$kernel" dracut-core dracut-network
# The curated firmware set. \`apt-cache policy\` guards each name so a package that does not exist for
# this arch (the intel/amd graphics blobs on arm64) is skipped rather than failing the build.
want=""
for p in $FIRMWARE_PACKAGES; do
  if apt-cache policy "\$p" 2>/dev/null | grep -qE 'Candidate: [0-9]'; then want="\$want \$p"; else echo "    firmware: no \$p for $ARCH, skipping"; fi
done
[ -n "\$want" ] && apt-get install -y --no-install-recommends \$want || echo "    firmware: none installed"
CHROOT

KVER="$(basename "$(ls -d "$ROOTFS"/lib/modules/*/ | head -n1)")"
echo "    kernel: $KVER"

echo '==> [4/8] chroot: the substrate, via the compiled agent setup'
install -m0755 "$AGENT_BIN" "$ROOTFS/usr/local/bin/polyptic-agent"
# No --server-url/--bootstrap-token/--start: those arrive on the kernel cmdline at boot; greetd starts
# the agent. `setup` writes greetd autologin, the compositor launcher, sway/i3 config + the user unit,
# installs the browser, and (POL-7/D45) writes /etc/dracut.conf.d/polyptic-splash.conf so the Plymouth
# theme lands in the initramfs step 6 builds. That drop-in is why this runs BEFORE dracut.
chroot "$ROOTFS" /usr/local/bin/polyptic-agent setup \
  --backend wayland-sway --user kiosk --browser "$BROWSER" --render auto
chroot "$ROOTFS" /bin/sh -c 'apt-get clean'

echo '==> [5/8] overlay diskless identity + offload layer'
rsync -a "$OVERLAY"/ "$ROOTFS"/ --exclude test
chmod 0755 "$ROOTFS"/usr/local/lib/polyptic/*.sh
chmod 0755 "$ROOTFS"/usr/lib/dracut/modules.d/50polyptic-live/*.sh
chmod 0755 "$ROOTFS"/usr/lib/dracut/modules.d/51polyptic-wifi/*.sh
chmod 0600 "$ROOTFS"/etc/netplan/01-polyptic-dhcp.yaml   # netplan refuses/warns on world-readable configs
# Enable the system units OFFLINE via the same .wants symlinks `systemctl enable` would create (which
# is a no-op/warn inside a chroot).
mkdir -p "$ROOTFS/etc/systemd/system/multi-user.target.wants"
for unit in polyptic-agent-env.service polyptic-offload.service polyptic-wifi.service; do
  ln -sf "../$unit" "$ROOTFS/etc/systemd/system/multi-user.target.wants/$unit"
done
# The update-poll timer (POL-41) is a timer unit, so it enables under timers.target.
mkdir -p "$ROOTFS/etc/systemd/system/timers.target.wants"
ln -sf "../polyptic-update-poll.timer" "$ROOTFS/etc/systemd/system/timers.target.wants/polyptic-update-poll.timer"
# A live box must not inherit the build host's SAN/snap baggage: multipathd crashes noisily in a live
# env and sprays the console during the plymouth→greetd handoff; nothing here uses snaps.
for unit in multipathd.service multipathd.socket snapd.service snapd.socket snapd.seeded.service; do
  ln -sf /dev/null "$ROOTFS/etc/systemd/system/$unit"
done
# Empty machine-id so systemd mints a transient one each boot (the agent ignores it, our var wins).
: > "$ROOTFS/etc/machine-id"; rm -f "$ROOTFS/var/lib/dbus/machine-id"
# The image id (POL-41): a per-build identity the box carries at /etc/polyptic/image-id and the
# server publishes in /dist/image/<arch>/manifest.json. The update-poll timer compares the two
# every 5 minutes; a mismatch means "the server has a newer image than the one I booted".
IMAGE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
printf '%s\n' "$IMAGE_ID" > "$ROOTFS/etc/polyptic/image-id"
chmod 0644 "$ROOTFS/etc/polyptic/image-id"
# Kill the per-boot "first boot after update" churn (POL-38): with nothing persisted, systemd's
# ConditionNeedsUpdate check trips EVERY boot and runs ldconfig.service (a ~40-60s dynamic-linker
# cache rebuild that stalls the splash), journal-catalog-update, sysusers, etc. Stamping .updated
# NEWER than /usr (we are past every apt operation here) marks the image up to date.
touch "$ROOTFS/etc/.updated" "$ROOTFS/var/.updated"

echo '==> [6/8] chroot: dracut initramfs ×2 (--no-hostonly), matched to this kernel'
# dmsquash-live + livenet are the `root=live:<url>` pair; polyptic-live (deploy/live/) is our own
# module and carries the netboot RAM pre-flight, the bounded wait-online, and the splash narration.
# `systemd-resolved` is LOAD-BEARING, not decoration: networkd gets the DHCP lease, but nothing
# else in the initramfs can resolve NAMES — without resolved, livenet's curl dies with "Could not
# resolve host" against a DNS bootHost while a raw-IP URL works fine (found on the first
# real-hardware boot, 2026-07-10; resolved reads the lease DNS straight from networkd's state
# files, no dbus needed). The omitted modules are storage stacks a diskless kiosk never has —
# multipath in particular used to spray "fatal configuration error" across the console before
# plymouth owned the screen (POL-38).
#
# TWO initrds come out of one kernel (POL-63). The LEAN `initrd` is what a WIRED netboot fetches
# through GRUB's few-MB/s HTTP client — byte-compatible with the pre-Wi-Fi chain, and it must stay
# small because that fetch is on every wired power-on's critical path. `initrd-wifi` adds the
# polyptic-wifi module: wpa_supplicant plus EVERY major vendor's wlan drivers AND their firmware
# (the fleet's chipsets are unknown at build time), far too heavy for the GRUB fetch — and it never
# takes it: initrd-wifi is only ever loaded from fast LOCAL media (the universal USB medium or an
# offloaded ESP), where its bulk costs a second of USB read instead of minutes of HTTP.
# ORDER IS THE MECHANISM here: the lean initrd builds BEFORE the Wi-Fi stack is installed, so it is
# byte-for-byte the pre-POL-63 wired initrd (dracut has always bundled every wlan MODULE via its
# =drivers/net sweep — 26.04 kernel-network-modules — but with no firmware present they cost ~0 and
# never probe usefully). Then the Wi-Fi packages land, and the fat initrd-wifi picks up supplicant +
# firmware. Installing them any earlier grew the lean initrd 92 → 166 MB (measured), a minute-plus
# on GRUB's few-MB/s wired HTTP fetch every power-on.
chroot "$ROOTFS" /bin/sh -eux <<CHROOT
export DEBIAN_FRONTEND=noninteractive
dracut --force --no-hostonly --no-hostonly-cmdline \
  --add "dmsquash-live livenet polyptic-live plymouth systemd-resolved" \
  --omit "multipath lvm mdraid crypt btrfs iscsi nfs nbd" \
  --add-drivers "virtio_net virtio_pci virtio_blk virtio_mmio squashfs overlay loop" \
  --kver "$KVER" "/boot/initrd.img-$KVER"
# The Wi-Fi stack (POL-63): supplicant + regulatory db + every major vendor's wlan firmware. The
# same apt-cache guard as the step-3 firmware: a package absent for this arch is skipped, loudly.
want=""
for p in $WIFI_PACKAGES $WIFI_FIRMWARE_PACKAGES; do
  if apt-cache policy "\$p" 2>/dev/null | grep -qE 'Candidate: [0-9]'; then want="\$want \$p"; else echo "    wifi: no \$p for $ARCH, skipping"; fi
done
[ -n "\$want" ] && apt-get install -y --no-install-recommends \$want || echo "    wifi: none installed"
apt-get clean
dracut --force --no-hostonly --no-hostonly-cmdline \
  --add "dmsquash-live livenet polyptic-live polyptic-wifi plymouth systemd-resolved" \
  --omit "multipath lvm mdraid crypt btrfs iscsi nfs nbd" \
  --add-drivers "virtio_net virtio_pci virtio_blk virtio_mmio squashfs overlay loop" \
  --kver "$KVER" "/boot/initrd-wifi.img-$KVER"
CHROOT

echo '==> [7/8] Secure Boot guard + publish kernel/initrds'
VMLINUZ="$ROOTFS/boot/vmlinuz-$KVER"
INITRD="$ROOTFS/boot/initrd.img-$KVER"
INITRD_WIFI="$ROOTFS/boot/initrd-wifi.img-$KVER"
[ -f "$VMLINUZ" ] && [ -f "$INITRD" ] && [ -f "$INITRD_WIFI" ] || { echo "chroot produced no $VMLINUZ / $INITRD / $INITRD_WIFI" >&2; exit 1; }
# shim_lock verifies the KERNEL at GRUB's `linux` command, so an unsigned vmlinuz builds fine here and
# then dies on the box with "bad shim signature". `sbverify --list` ALWAYS exits 0, so grep its output;
# without sbsigntool, fall back to requiring a non-empty PE cert table (data-directory entry 4).
if command -v sbverify >/dev/null 2>&1; then
  sbverify --list "$VMLINUZ" 2>/dev/null | grep -q 'Canonical Ltd. Secure Boot Signing' \
    || { echo "$VMLINUZ is not Canonical-signed (apt installed an unsigned kernel?), Secure Boot boxes would refuse it" >&2; exit 1; }
else
  python3 -c 'import struct,sys;d=open(sys.argv[1],"rb").read();assert d[:2]==b"MZ";o=struct.unpack("<I",d[60:64])[0];m=struct.unpack("<H",d[o+24:o+26])[0];dd=o+24+(112 if m==0x20b else 96)+32;va,sz=struct.unpack("<II",d[dd:dd+8]);sys.exit(0 if sz>0 else 1)' "$VMLINUZ" \
    || { echo "$VMLINUZ has an empty PE certificate table (unsigned); install sbsigntool to check the signer" >&2; exit 1; }
fi
cp -f "$VMLINUZ" "$OUT_DIR/vmlinuz"; cp -f "$INITRD" "$OUT_DIR/initrd"; chmod u+w "$OUT_DIR/initrd"
cp -f "$INITRD_WIFI" "$OUT_DIR/initrd-wifi"; chmod u+w "$OUT_DIR/initrd-wifi"

echo "==> [8/8] mksquashfs (zstd, -b $SQUASHFS_BLOCK)"
for m in dev/pts dev proc sys run; do umount -lf "$ROOTFS/$m"; done; trap - EXIT
rm -f "$ROOTFS/etc/resolv.conf"
# The kernel + initrds reach the box over the boot chain, never out of the root image; carrying a
# second copy inside the squashfs would ride in RAM for the whole session for nothing.
rm -f "$ROOTFS"/boot/vmlinuz-* "$ROOTFS"/boot/initrd.img-* "$ROOTFS"/boot/initrd-wifi.img-* \
      "$ROOTFS"/boot/System.map-* "$ROOTFS"/boot/config-*
# Translations we never render. `path-exclude` (step 2) already kept docs/man out.
find "$ROOTFS/usr/share/locale" -mindepth 1 -maxdepth 1 -type d ! -name 'en*' -exec rm -rf {} + 2>/dev/null || true
rm -rf "$ROOTFS"/var/lib/apt/lists/* "$ROOTFS"/var/cache/apt/archives/*.deb "$ROOTFS"/usr/share/i18n
# Drop the pre-D47/pre-POL-35 artifacts so a depot upgraded in place doesn't keep serving (or
# retaining) an image the boot cmdline no longer knows how to use.
rm -f "$OUT_DIR/squashfs" "$OUT_DIR/polyptic.iso" "$OUT_DIR/rootfs.squashfs"
mksquashfs "$ROOTFS" "$OUT_DIR/rootfs.squashfs" -noappend -comp zstd -Xcompression-level 19 -b "$SQUASHFS_BLOCK" -no-progress
printf '%s\n' "$IMAGE_ID" > "$OUT_DIR/image-id.txt"   # published in /dist/image/<arch>/manifest.json (POL-41)
( cd "$OUT_DIR" && sha256sum vmlinuz initrd initrd-wifi rootfs.squashfs > SHA256SUMS && cat SHA256SUMS )
echo "    rootfs.squashfs: $(du -h "$OUT_DIR/rootfs.squashfs" | cut -f1)  initrd: $(du -h "$OUT_DIR/initrd" | cut -f1)  initrd-wifi: $(du -h "$OUT_DIR/initrd-wifi" | cut -f1)  vmlinuz: $(du -h "$OUT_DIR/vmlinuz" | cut -f1)"
rm -rf "$WORK"

cat <<EOF

Point IMAGE_DIST_DIR at $(dirname "$OUT_DIR"); the server serves GET /dist/image/$ARCH/{vmlinuz,initrd,rootfs.squashfs}.
Boxes boot these via the server's generated GET /boot/grub.cfg (no hand-written config needed). For
reference, its menu entries are equivalent to:
  linux  <net>/dist/image/$ARCH/vmlinuz root=live:<base>/dist/image/$ARCH/rootfs.squashfs \\
         rd.overlay=1 ip=dhcp rd.neednet=1 \\
         polyptic.base=<base> polyptic.server_url=ws://<host>/agent polyptic.token=<enrolment-token>
  initrd <net>/dist/image/$ARCH/initrd
dracut's livenet downloads the WHOLE squashfs into a RAM tmpfs before switching root, so size the box's
RAM at >= the squashfs plus the working set (the initrd raises the tmpfs cap to 90% and refuses to
limp on a box that cannot hold it). Unlike casper's busybox wget, livenet uses curl: DNS names,
redirects and retries all work.
EOF
