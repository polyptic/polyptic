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
#          MIRROR          (default archive.ubuntu.com on amd64, ports.ubuntu.com on arm64). Also the
#                          hook for an organisation's OWN Ubuntu mirror (an internal mirror or proxy),
#                          which keeps builds off the public archive entirely.
#          FULL_FIRMWARE=1 ship the whole `linux-firmware` (~600 MB) instead of the curated set —
#                          the escape hatch for hardware whose blobs we did not anticipate
#          FIRMWARE_PACKAGES  override the curated set outright (space-separated; "" = none)
#          SQUASHFS_BLOCK  (default 1M) mksquashfs block size
#          BASE_TARBALL    a local ubuntu-base tarball (skips the download)
#          SITE_DIR        (default deploy/site, absent = exact no-op) the SITE LAYER: an organisation's
#                          own endpoint/compliance tooling, injected at step 6. See deploy/site.example/
#                          and docs/DISTRIBUTION.md. Packages install here; registration happens on the
#                          box at boot, because a registration writes a credential and this image is
#                          served ungated (POL-190).
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
SQUASHFS_BLOCK="${SQUASHFS_BLOCK:-1M}"
OUT_DIR="${OUT_DIR:-$REPO_ROOT/deploy/dist/image/$ARCH}"
CACHE_DIR="${CACHE_DIR:-$REPO_ROOT/deploy/dist/cache}"
AGENT_BIN="$REPO_ROOT/deploy/dist/polyptic-agent-$ARCH"
OVERLAY="$REPO_ROOT/deploy/live"
# The site layer (POL-190). `deploy/site` is gitignored; `deploy/site.example` is the committed template.
SITE_DIR="${SITE_DIR:-$REPO_ROOT/deploy/site}"
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
# DRACUT RUNS in step 7, deliberately: dracut's kernel-network-modules pulls all of =drivers/net in
# --no-hostonly mode and bundles firmware for every module it installs, so any wlan firmware present
# when the LEAN initrd builds would silently ride the wired GRUB fetch (+74 MB measured; and
# --omit-drivers can't exclude a subtree, its entries are ^anchored$ module names). Under
# FULL_FIRMWARE=1 the wireless blobs are already in `linux-firmware` from step 3 — the lean initrd
# absorbs them exactly as it did pre-POL-63; that escape hatch has always traded size for coverage.
WIFI_PACKAGES="wpasupplicant wireless-regdb iw rfkill"
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

echo "==> [1/9] ubuntu-base $UBUNTU_RELEASE ($ARCH)"
BASE_TARBALL="${BASE_TARBALL:-$CACHE_DIR/$(basename "$BASE_TARBALL_URL")}"
if [ ! -f "$BASE_TARBALL" ]; then
  echo "    downloading $BASE_TARBALL_URL (cached for future runs)"
  curl -fL --progress-bar -o "$BASE_TARBALL.part" "$BASE_TARBALL_URL"
  mv "$BASE_TARBALL.part" "$BASE_TARBALL"
else
  echo "    cache hit: $BASE_TARBALL"
fi
tar -xzf "$BASE_TARBALL" -C "$ROOTFS"

echo '==> [2/9] apt sources + chroot mounts'
# The chroot needs WORKING DNS to apt-get the substrate. A modern build host's /etc/resolv.conf is the
# systemd-resolved STUB (nameserver 127.0.0.53), which resolves nothing inside a chroot with no resolved
# running; prefer systemd-resolved's real-upstream file when present. The image never ships this (step 9
# deletes it before mksquashfs), so the booted box stays on its own DHCP/agent DNS.
# We own the UBUNTU archive definition and nothing else (POL-190). The old blanket
# `rm -f sources.list.d/*` also deleted any THIRD-PARTY repo a supplied base carried, which is a silent
# trap rather than a clean failure: the vendor's packages stay installed and working, their update path
# is gone, and the nightly refresh can never patch them again because it no longer knows where they
# came from. So drop only the two files we replace, and keep (loudly) whatever else arrived.
mkdir -p "$ROOTFS/etc/apt/sources.list.d"
rm -f "$ROOTFS/etc/apt/sources.list" "$ROOTFS/etc/apt/sources.list.d/ubuntu.sources"
preserved="$(find "$ROOTFS/etc/apt/sources.list.d" -maxdepth 1 -type f 2>/dev/null | sort || true)"
if [ -n "$preserved" ]; then
  echo "    preserving apt sources that came with the base:"
  printf '      %s\n' $(printf '%s\n' "$preserved" | sed "s|^$ROOTFS/etc/apt/||")
fi
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

echo '==> [3/9] chroot: kernel, dracut, init, firmware'
# THE KERNEL IS INSTALLED BY ITS CONCRETE NAME, NOT VIA `linux-image-generic`. The metapackage
# *Depends* (not Recommends) on `linux-firmware`, which in turn Depends on all eighteen per-vendor
# firmware packages — ~600 MB that `--no-install-recommends` cannot decline — plus the ZFS modules.
# The concrete `linux-image-<abi>-generic` depends only on kmod/linux-base/linux-modules, so we
# resolve the ABI the metapackage currently points at and install that. It is the SAME
# Canonical-signed PE the live-server ISO ships (both come from the `linux-signed` source), so the
# signature guard in step 8 passes unchanged; apt is just a different courier.
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
# dracut runs in step 7, so the lean wired initrd never absorbs it (see WIFI_PACKAGES above).
# systemd-timesyncd (POL-148) is a SEPARATE package on ubuntu-base minimal — without it a netboot box
# has NO time client at all (`timedatectl` reads "NTP service: n/a") and free-runs off the RTC, which
# drifted a real box an hour ahead and broke a relative-range dashboard. It runs as a system service
# with CAP_SYS_TIME, so it sets the clock without the unprivileged kiosk user; step 5 enables it +
# our polyptic-timesync-conf.service (which points it at the baked NTP host) under sysinit.target.
# gdisk/dosfstools/e2fsprogs are install-to-disk.sh's partitioner + mkfs set (POL-176: a live box
# can now wipe its own disk and lay down A/B slots); cryptsetup backs the ephemeral encrypted swap
# on installed boxes (/etc/crypttab, dm-crypt with a per-boot random key).
apt-get install -y --no-install-recommends \
  systemd-sysv systemd-resolved systemd-timesyncd libpam-systemd udev dbus kmod dmsetup \
  iproute2 netplan.io ca-certificates curl efibootmgr procps \
  gdisk dosfstools e2fsprogs cryptsetup \
  "\$kernel" dracut-core dracut-network
# systemd-cryptsetup split out of the systemd package on newer suites; install it where the archive
# has it (elsewhere the generator already ships inside systemd) — guarded, not fatal (POL-176).
if apt-cache policy systemd-cryptsetup 2>/dev/null | grep -qE 'Candidate: [0-9]'; then
  apt-get install -y --no-install-recommends systemd-cryptsetup
else
  echo "    no systemd-cryptsetup package on this suite (assuming systemd ships the generator)"
fi
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

echo '==> [4/9] chroot: the substrate, via the compiled agent setup'
install -m0755 "$AGENT_BIN" "$ROOTFS/usr/local/bin/polyptic-agent"
# No --server-url/--bootstrap-token/--start: those arrive on the kernel cmdline at boot; greetd starts
# the agent. `setup` writes greetd autologin, the compositor launcher, sway/i3 config + the user unit,
# installs the browser(s) (POL-67/D77: google-chrome-stable from GOOGLE'S apt repo on amd64 — the
# repo file + key land under /etc/apt and PERSIST into the squashfs, so the nightly refresh's plain
# `apt-get upgrade` tracks the latest stable Chrome; surf/xwayland/xdotool ship alongside as the
# fallback and are all arm64 gets, since Google publishes no Linux arm64 Chrome), and (POL-7/D45)
# writes /etc/dracut.conf.d/polyptic-splash.conf so the Plymouth theme lands in the initramfs step 7
# builds. That drop-in is why this runs BEFORE dracut. Chrome costs ~300-400 MB in the squashfs —
# the POL-35 ~492 MiB amd64 image lands back around ~800 MiB (re-measure the RAM floor accordingly);
# correctness on real GPUs beats the size win (D77).
# The cast substrate (uxplay/avahi/gstreamer + the POL-144/D120 VA hardware-decode driver) also
# lands here, via corePackages()'s `cast` set — so a change to those packages needs a FULL IMAGE
# REBUILD (this script) before it can be re-tested on a box; the running fleet won't have them.
chroot "$ROOTFS" /usr/local/bin/polyptic-agent setup \
  --backend wayland-sway --user kiosk --render auto
chroot "$ROOTFS" /bin/sh -c 'apt-get clean'

echo '==> [5/9] overlay diskless identity + install layer'
rsync -a "$OVERLAY"/ "$ROOTFS"/ --exclude test
chmod 0755 "$ROOTFS"/usr/local/lib/polyptic/*.sh
chmod 0755 "$ROOTFS"/usr/lib/dracut/modules.d/50polyptic-live/*.sh
chmod 0755 "$ROOTFS"/usr/lib/dracut/modules.d/51polyptic-wifi/*.sh
chmod 0600 "$ROOTFS"/etc/netplan/01-polyptic-dhcp.yaml   # netplan refuses/warns on world-readable configs
# Enable the system units OFFLINE via the same .wants symlinks `systemctl enable` would create (which
# is a no-op/warn inside a chroot).
mkdir -p "$ROOTFS/etc/systemd/system/multi-user.target.wants"
# polyptic-install.path (POL-176) replaces the retired polyptic-offload.service: the console's
# INSTALL request lands as a file, and the path unit escalates it to the root installer.
# polyptic-site-firstboot.service (POL-190) enables unconditionally and costs nothing when no site
# layer is configured: the unit carries ConditionPathIsDirectory=/etc/polyptic/site/firstboot.d, so on
# an image with no site bundle systemd skips it silently rather than logging a failure.
for unit in polyptic-agent-env.service polyptic-wifi.service polyptic-boot-path.service polyptic-install.path polyptic-site-firstboot.service; do
  ln -sf "../$unit" "$ROOTFS/etc/systemd/system/multi-user.target.wants/$unit"
done
# The update-poll timer (POL-41) is a timer unit, so it enables under timers.target.
mkdir -p "$ROOTFS/etc/systemd/system/timers.target.wants"
ln -sf "../polyptic-update-poll.timer" "$ROOTFS/etc/systemd/system/timers.target.wants/polyptic-update-poll.timer"
# Clock sync (POL-148). systemd-timesyncd's [Install] is WantedBy=sysinit.target, and our conf helper
# must run BEFORE it (it writes timesyncd's NTP server into a /run drop-in), so both enable under
# sysinit.target.wants. ubuntu-base's minimal preset does NOT enable timesyncd, hence the explicit
# symlink; the box then disciplines its clock early at boot instead of free-running off the RTC.
mkdir -p "$ROOTFS/etc/systemd/system/sysinit.target.wants"
ln -sf "/usr/lib/systemd/system/systemd-timesyncd.service" "$ROOTFS/etc/systemd/system/sysinit.target.wants/systemd-timesyncd.service"
ln -sf "../polyptic-timesync-conf.service" "$ROOTFS/etc/systemd/system/sysinit.target.wants/polyptic-timesync-conf.service"
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

echo '==> [6/9] site layer: the organisation'"'"'s own tooling (SITE_DIR)'
# THE ESCAPE HATCH (POL-190). A self-hosted fleet lands on somebody else's corporate network, and their
# security function will require its own endpoint tooling on every box. This step is the ONE generic
# place that goes, so an organisation never has to fork the build. It is deliberately vendor-blind: we
# consume a declarative bundle and know nothing about what is in it.
#
# INSTALL HERE, REGISTER ON THE BOX. Packages, config and trust land in the image; the registration that
# turns a package into an enrolled agent runs at boot from `firstboot.d/` (see site-firstboot.sh). That
# split is forced, not stylistic: registration writes a bearer credential to disk, and this image is
# served UNGATED from the depot, so registering at build time would publish the credential to anyone who
# can reach the control plane.
#
# BEFORE the dracut runs below, deliberately: anything the bundle drops in /etc that the initramfs needs
# (a CA bundle, a network policy drop-in) has to exist before the initramfs is generated.
#
# An absent or empty SITE_DIR is an EXACT no-op — no files touched, no apt transaction, no unit enabled.
# That is the state every build that is not ours is in, and it must stay free.
if [ -n "$SITE_DIR" ] && [ -d "$SITE_DIR" ]; then
  echo "    bundle: $SITE_DIR"

  # 1) apt repos + keyrings FIRST, so the vendor's own archive is available to the install below and —
  # because these files persist into the squashfs — so the nightly refresh tracks that vendor forever.
  # Exactly how google-chrome-stable stays current (POL-67/D77); no new machinery.
  if [ -d "$SITE_DIR/apt" ]; then
    for f in "$SITE_DIR"/apt/*.sources "$SITE_DIR"/apt/*.list; do
      [ -f "$f" ] || continue
      install -m0644 "$f" "$ROOTFS/etc/apt/sources.list.d/$(basename "$f")"
      echo "    apt source: $(basename "$f")"
    done
    if [ -d "$SITE_DIR/apt/keyrings" ]; then
      mkdir -p "$ROOTFS/etc/apt/keyrings"
      for f in "$SITE_DIR"/apt/keyrings/*; do
        [ -f "$f" ] || continue
        install -m0644 "$f" "$ROOTFS/etc/apt/keyrings/$(basename "$f")"
        echo "    apt keyring: $(basename "$f")"
      done
    fi
  fi

  # 2) The file overlay BEFORE any package install, so a package's postinst sees the site's config
  # rather than writing its own default and having us overwrite it afterwards. CA certificates, policy
  # drop-ins, inventory tag files, the site's own units.
  if [ -d "$SITE_DIR/rootfs" ]; then
    rsync -a "$SITE_DIR/rootfs"/ "$ROOTFS"/
    echo "    overlaid $(find "$SITE_DIR/rootfs" -type f | wc -l | tr -d ' ') file(s) from rootfs/"
    # A site that ships CA certificates expects them trusted, not just present.
    if [ -d "$SITE_DIR/rootfs/usr/local/share/ca-certificates" ]; then
      chroot "$ROOTFS" /bin/sh -c 'command -v update-ca-certificates >/dev/null && update-ca-certificates >/dev/null 2>&1' \
        || echo "    WARNING: update-ca-certificates failed or is absent; site CAs may not be trusted"
    fi
  fi

  # 3) Repo packages, behind the SAME arch guard as the firmware set: a package that does not exist for
  # this architecture is skipped LOUDLY, never fatally, because a fleet is often mixed and a vendor's
  # arm64 coverage rarely matches its amd64 coverage.
  SITE_PACKAGES=""
  if [ -f "$SITE_DIR/packages.list" ]; then
    SITE_PACKAGES="$(sed -e 's/#.*//' -e '/^[[:space:]]*$/d' "$SITE_DIR/packages.list" | tr '\n' ' ')"
  fi
  # 4) Local .debs, for vendors who ship a download rather than an archive. `apt-get install ./x.deb`
  # (not `dpkg -i`) so dependencies resolve from the archive instead of leaving a half-configured
  # package that breaks the next apt transaction.
  SITE_DEBS=""
  if [ -d "$SITE_DIR/debs" ]; then
    rm -rf "$ROOTFS/tmp/site-debs"; mkdir -p "$ROOTFS/tmp/site-debs"
    for f in "$SITE_DIR"/debs/*.deb; do
      [ -f "$f" ] || continue
      install -m0644 "$f" "$ROOTFS/tmp/site-debs/$(basename "$f")"
      SITE_DEBS="$SITE_DEBS /tmp/site-debs/$(basename "$f")"
    done
  fi

  if [ -n "$SITE_PACKAGES" ] || [ -n "$SITE_DEBS" ]; then
    chroot "$ROOTFS" /bin/sh -eux <<CHROOT
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
want=""
for p in $SITE_PACKAGES; do
  if apt-cache policy "\$p" 2>/dev/null | grep -qE 'Candidate: [0-9]'; then want="\$want \$p"; else echo "    site: no \$p for $ARCH, skipping"; fi
done
[ -n "\$want" ] && apt-get install -y --no-install-recommends \$want || echo "    site: no repo packages installed"
# --no-install-recommends on the .debs too. A vendor agent's Recommends can drag a desktop stack into an
# image that streams into RAM, and the size shows up as a hardware requirement on every box.
[ -n "$SITE_DEBS" ] && apt-get install -y --no-install-recommends $SITE_DEBS || true
apt-get clean
CHROOT
    rm -rf "$ROOTFS/tmp/site-debs"
  fi

  # 5) The site's own systemd units, enabled OFFLINE via the same .wants symlinks `systemctl enable`
  # would create (systemctl is a no-op inside a chroot, which is why nothing here calls it).
  if [ -f "$SITE_DIR/units.wants" ]; then
    while IFS= read -r unit; do
      case "$unit" in ''|'#'*) continue ;; esac
      ln -sf "../$unit" "$ROOTFS/etc/systemd/system/multi-user.target.wants/$unit"
      echo "    enabled unit: $unit"
    done < "$SITE_DIR/units.wants"
  fi

  # 6) The boot-time hooks. This is where registration lives, with the site's secrets handed to it in
  # RAM from the boot medium.
  if [ -d "$SITE_DIR/firstboot.d" ]; then
    mkdir -p "$ROOTFS/etc/polyptic/site/firstboot.d"
    rsync -a "$SITE_DIR/firstboot.d"/ "$ROOTFS/etc/polyptic/site/firstboot.d"/
    chmod 0755 "$ROOTFS"/etc/polyptic/site/firstboot.d/* 2>/dev/null || true
    echo "    boot hooks: $(find "$SITE_DIR/firstboot.d" -type f | wc -l | tr -d ' ')"
  fi

  # 7) The imperative escape hatch, for what files cannot express. Runs in the chroot, MUST be
  # non-interactive (there is nobody to answer a prompt) and MUST NOT register anything (see the header).
  if [ -f "$SITE_DIR/configure.sh" ]; then
    echo '    running configure.sh in the chroot'
    install -m0755 "$SITE_DIR/configure.sh" "$ROOTFS/tmp/site-configure.sh"
    chroot "$ROOTFS" /bin/sh -c 'DEBIAN_FRONTEND=noninteractive /tmp/site-configure.sh' \
      || { echo "site configure.sh FAILED — refusing to seal a half-configured image" >&2; exit 1; }
    rm -f "$ROOTFS/tmp/site-configure.sh"
  fi

  # 8) The bundle's identity, published next to the image id so "which compliance payload is this screen
  # running?" is a query rather than an argument. Content-addressed over the whole bundle, so a changed
  # package list or a changed hook produces a new id.
  # Hash PATHS as well as contents, so renaming a hook or dropping a file changes the id. Content alone
  # would call two materially different bundles the same thing.
  SITE_ID="$(cd "$SITE_DIR" && find . -type f ! -name '.gitkeep' -exec sha256sum {} + 2>/dev/null | sort | sha256sum | cut -c1-16)"
  printf '%s\n' "$SITE_ID" > "$ROOTFS/etc/polyptic/site-id"
  chmod 0644 "$ROOTFS/etc/polyptic/site-id"
  echo "    site id: $SITE_ID"
else
  echo '    no site layer configured (SITE_DIR absent) — nothing added'
  SITE_ID=""
fi

# ext4/vfat/fat + the FAT codepage modules (nls_cp437/nls_iso8859-1) in BOTH driver lists below are
# the POL-176 disk boot: an installed box's initramfs mounts the ext4 slot (root=live:LABEL=…), the
# ext4 scratch overlay (rd.live.overlay=LABEL=…) and — for staging/forensics — the FAT ESP, with NO
# network in the loop. They are usually built-in or auto-pulled, but "usually" bricked a boot once
# already (POL-35's resolved lesson): list them explicitly so a kernel packaging change cannot
# silently drop disk boots.
echo '==> [7/9] chroot: dracut initramfs ×2 (--no-hostonly), matched to this kernel'
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
# `drm` is NOT listed here but IS in the initramfs: step 4's `polyptic-agent setup` wrote
# /etc/dracut.conf.d/polyptic-splash.conf, which asks for it (POL-53 — without a real KMS driver the
# splash renders at the firmware's framebuffer resolution and the panel upscales it). That drop-in is
# the single place both this image and an installed box get it from; see packages/agent/src/setup/
# plymouth.ts. It costs ~47 MiB of initramfs on amd64, ~13 MiB on arm64.
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
  --add-drivers "virtio_net virtio_pci virtio_blk virtio_mmio squashfs overlay loop ext4 vfat fat nls_cp437 nls_iso8859-1" \
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
  --add-drivers "virtio_net virtio_pci virtio_blk virtio_mmio squashfs overlay loop ext4 vfat fat nls_cp437 nls_iso8859-1" \
  --kver "$KVER" "/boot/initrd-wifi.img-$KVER"
CHROOT

echo '==> [8/9] Secure Boot guard + publish kernel/initrds'
VMLINUZ="$ROOTFS/boot/vmlinuz-$KVER"
INITRD="$ROOTFS/boot/initrd.img-$KVER"
INITRD_WIFI="$ROOTFS/boot/initrd-wifi.img-$KVER"
[ -f "$VMLINUZ" ] && [ -f "$INITRD" ] && [ -f "$INITRD_WIFI" ] || { echo "chroot produced no $VMLINUZ / $INITRD / $INITRD_WIFI" >&2; exit 1; }
# shim_lock verifies the KERNEL at GRUB's `linux` command, so an unsigned vmlinuz builds fine here and
# then dies on the box with "bad shim signature". `sbverify --list` ALWAYS exits 0, so grep its output;
# without sbsigntool, fall back to requiring a non-empty PE cert table (data-directory entry 4).
if command -v sbverify >/dev/null 2>&1; then
  sbverify --list "$VMLINUZ" 2>/dev/null | grep -q 'Canonical Ltd. Secure Boot Signing' \
    || { echo "$VMLINUZ is not Canonical-signed (apt installed an unsigned kernel?), so Secure Boot boxes would refuse it" >&2; exit 1; }
else
  python3 -c 'import struct,sys;d=open(sys.argv[1],"rb").read();assert d[:2]==b"MZ";o=struct.unpack("<I",d[60:64])[0];m=struct.unpack("<H",d[o+24:o+26])[0];dd=o+24+(112 if m==0x20b else 96)+32;va,sz=struct.unpack("<II",d[dd:dd+8]);sys.exit(0 if sz>0 else 1)' "$VMLINUZ" \
    || { echo "$VMLINUZ has an empty PE certificate table (unsigned); install sbsigntool to check the signer" >&2; exit 1; }
fi
cp -f "$VMLINUZ" "$OUT_DIR/vmlinuz"; cp -f "$INITRD" "$OUT_DIR/initrd"; chmod u+w "$OUT_DIR/initrd"
cp -f "$INITRD_WIFI" "$OUT_DIR/initrd-wifi"; chmod u+w "$OUT_DIR/initrd-wifi"

echo "==> [9/9] mksquashfs (zstd, -b $SQUASHFS_BLOCK)"
for m in dev/pts dev proc sys run; do umount -lf "$ROOTFS/$m"; done; trap - EXIT
rm -f "$ROOTFS/etc/resolv.conf"
# The kernel + initrds reach the box over the boot chain, never out of the root image; carrying a
# second copy inside the squashfs would ride in RAM for the whole session for nothing.
rm -f "$ROOTFS"/boot/vmlinuz-* "$ROOTFS"/boot/initrd.img-* "$ROOTFS"/boot/initrd-wifi.img-* \
      "$ROOTFS"/boot/System.map-* "$ROOTFS"/boot/config-*
# Translations we never render. `path-exclude` (step 2) already kept docs/man out.
find "$ROOTFS/usr/share/locale" -mindepth 1 -maxdepth 1 -type d ! -name 'en*' -exec rm -rf {} + 2>/dev/null || true
rm -rf "$ROOTFS"/var/lib/apt/lists/* "$ROOTFS"/var/cache/apt/archives/*.deb "$ROOTFS"/usr/share/i18n
# The site layer's LAST word before the image is sealed (POL-190). This is where an organisation strips
# per-host state, and it is the difference between a fleet that reports as N hosts and one that reports as
# a single host. Endpoint agents mint their identity at first registration, so a vendor's own
# golden-image procedure exists precisely for this moment; every Polyptic boot is a golden-image first
# boot, so this hook is not an optimisation, it is the mechanism.
if [ -n "$SITE_DIR" ] && [ -f "$SITE_DIR/seal.sh" ]; then
  echo '    running the site layer'"'"'s seal.sh (strip per-host state)'
  # Runs OUTSIDE the chroot with the rootfs path as $1: by this point /proc, /sys and /dev are
  # unmounted, so a chroot would be a poor place to run anything, and a seal step mostly deletes files.
  POLYPTIC_ROOTFS="$ROOTFS" sh "$SITE_DIR/seal.sh" "$ROOTFS" \
    || { echo "site seal.sh FAILED — refusing to seal an image that may carry per-host state" >&2; exit 1; }
fi
# Drop the pre-D47/pre-POL-35 artifacts so a depot upgraded in place doesn't keep serving (or
# retaining) an image the boot cmdline no longer knows how to use.
rm -f "$OUT_DIR/squashfs" "$OUT_DIR/polyptic.iso" "$OUT_DIR/rootfs.squashfs"
mksquashfs "$ROOTFS" "$OUT_DIR/rootfs.squashfs" -noappend -comp zstd -Xcompression-level 19 -b "$SQUASHFS_BLOCK" -no-progress
printf '%s\n' "$IMAGE_ID" > "$OUT_DIR/image-id.txt"   # published in /dist/image/<arch>/manifest.json (POL-41)
# The site bundle's identity, published beside the image id so an operator (or a security function) can
# answer "which compliance payload is this screen running?" without unpacking anything.
if [ -n "${SITE_ID:-}" ]; then
  printf '%s\n' "$SITE_ID" > "$OUT_DIR/site-id.txt"
else
  rm -f "$OUT_DIR/site-id.txt"
fi
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
