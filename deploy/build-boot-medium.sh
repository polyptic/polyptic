#!/usr/bin/env bash
# deploy/build-boot-medium.sh, build the Polyptic SIGNED BOOT MEDIUM (POL-33/D47). Sibling of
# build-agent.sh; replaces the old unsigned first stage (D46), nothing is compiled or signed by us.
#
# Assembles a dd-able USB dongle from the boot chain Canonical already ships for its own netboot
# installer: the firmware db (Microsoft UEFI CA 2011) verifies shim, shim's embedded Canonical cert
# verifies GRUB (grubnet, the ONLY Ubuntu signed GRUB with HTTP built in), and GRUB's shim_lock
# verifier checks the Canonical-signed kernel on the loaded buffer, HTTP included. Secure Boot stays
# ON end to end. The medium is TOKENLESS (control-plane address only); the server bakes the enrolment
# token into GET /boot/grub.cfg at chain time. Output into deploy/dist/boot/:
#   shimx64.efi grubx64.efi shimaa64.efi grubaa64.efi   the signed loaders (offload + UEFI HTTP Boot)
#   polyptic-boot.img                                   UNIVERSAL dd-able FAT32 dongle (amd64 AND arm64)
# The server serves these UNGATED at GET /dist/boot/<file> and links the .img from Console > Settings >
# Netboot (Download boot medium).
#
# WHY THE PINS: SBAT revocations brick older binaries (the GA noble grub build carries grub,4 and is
# already refused by updated firmware; shim 15.4 = *.signed.previous likewise), so the four .debs AND
# the four payload .efi files inside them are pinned by sha256: shim 15.8 (SBAT shim,4) + grub
# 2.12-1ubuntu7.3 (SBAT grub,5). To bump: take the newest shim-signed / grub2-signed from
# noble(-updates), update the 4 URLs + 8 sha256 pins below in one deliberate commit, rebuild, reflash.
# NEVER ship the bare shimx64.efi/shimaa64.efi (unsigned, empty cert table), *.signed.previous, or the
# non-net grubx64.efi.signed (no HTTP module). Superseded -updates debs are GC'd from the pool; the
# launchpad +files URL is the permanent fallback.
#
# Runs on macOS AND Linux, no root, no toolchain: downloads + a text template + mtools, nothing else.
#
# PREREQUISITES: curl, shasum -a 256 (or sha256sum), ar, tar, zstd (the grub debs are data.tar.zst;
# even macOS bsdtar shells out to it), mtools (mformat/mmd/mcopy).
#   macOS: brew install mtools zstd          Debian/Ubuntu: apt-get install -y curl binutils mtools zstd
#
# USAGE:
#   POLYPTIC_BASE=http://10.0.0.5:8080 deploy/build-boot-medium.sh
#     env: POLYPTIC_BASE (required, PLAIN http; baked into the dongle's stage-1 config)
set -euo pipefail

: "${POLYPTIC_BASE:?set POLYPTIC_BASE, e.g. http://10.0.0.5:8080 (baked into the medium)}"
case "$POLYPTIC_BASE" in
  https://*) echo "build-boot-medium: POLYPTIC_BASE is https, but GRUB and casper speak PLAIN HTTP only (no TLS).
The boot depot is plain-http by contract: keep it on the LAN / management VLAN and pass http://host:port." >&2; exit 2 ;;
  http://*) ;;
  *) echo "build-boot-medium: POLYPTIC_BASE must look like http://host[:port] (got '$POLYPTIC_BASE')" >&2; exit 2 ;;
esac
# GRUB's device syntax wants bare host:port, `(http,HOST:PORT)`; no scheme, no path.
HOSTPORT="${POLYPTIC_BASE#http://}"; HOSTPORT="${HOSTPORT%/}"
case "$HOSTPORT" in
  "")  echo "build-boot-medium: empty host in POLYPTIC_BASE" >&2; exit 2 ;;
  */*) echo "build-boot-medium: POLYPTIC_BASE must not carry a path, the boot depot lives at the server root" >&2; exit 2 ;;
esac

for t in curl ar tar zstd mformat mmd mcopy; do
  command -v "$t" >/dev/null 2>&1 || { echo "build-boot-medium: '$t' not found (see PREREQUISITES in this script)" >&2; exit 1; }
done
if   command -v shasum    >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | awk '{print $1}'; }
else echo "build-boot-medium: neither 'shasum' nor 'sha256sum' found" >&2; exit 1; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist/boot"
TMPL="$HERE/dongle-grub.cfg.tmpl"
[ -f "$TMPL" ] || { echo "build-boot-medium: missing $TMPL" >&2; exit 1; }
mkdir -p "$DIST"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

verify() { # verify <file> <expected-sha256> <label>; any mismatch is a hard stop
  local got; got="$(sha256 "$1")"
  [ "$got" = "$2" ] && return 0
  { echo "build-boot-medium: sha256 MISMATCH for $3"
    echo "  expected $2"
    echo "  got      $got"
    echo "  refusing to ship it. If Ubuntu published a new signed build, bump the pins deliberately (see header)."
  } >&2
  exit 1
}

fetch_and_extract() { # <deb-url> <deb-sha256> <member-in-data-tar> <payload-sha256> <install-name>
  local url="$1" deb_sha="$2" member="$3" efi_sha="$4" name="$5"
  local deb="$WORK/$(basename "$url")" dir="$WORK/x-$5"
  echo "==> $name  <-  $(basename "$url")"
  # -updates debs vanish from the pool once superseded; launchpad's +files URL is permanent (a 303
  # redirect, hence -L). Only the BUILD HOST follows redirects here, GRUB never sees these URLs.
  curl -fL -o "$deb" "$url" \
    || curl -fL -o "$deb" "https://launchpad.net/ubuntu/+archive/primary/+files/$(basename "$url")"
  verify "$deb" "$deb_sha" "$(basename "$url")"     # BEFORE unpacking
  mkdir -p "$dir"
  ( cd "$dir"
    ar -x "$deb"    # a .deb is an ar archive: debian-binary + control.tar.* + data.tar.*
    # shim-signed debs carry data.tar.xz (tar reads it natively on both OSes); grub2-signed debs carry
    # data.tar.zst, which stock macOS bsdtar only opens by shelling out to zstd, so pipe explicitly.
    if   [ -f data.tar.zst ]; then zstd -d -q < data.tar.zst | tar -xf -
    elif [ -f data.tar.xz  ]; then tar -xf data.tar.xz
    else echo "build-boot-medium: no data.tar.{zst,xz} inside $(basename "$deb")" >&2; exit 1; fi )
  [ -f "$dir/$member" ] || { echo "build-boot-medium: $member not found inside $(basename "$deb")" >&2; exit 1; }
  verify "$dir/$member" "$efi_sha" "$name ($member)"   # defense in depth: pin the payload too
  install -m 0644 "$dir/$member" "$DIST/$name"
}

# ── Pins: 4 debs + the exact signed payload inside each (8 sha256s; see header to bump) ──────────
#    <deb url>  <deb sha256>  <payload member>  <payload sha256>  <installed name>
while read -r url deb_sha member efi_sha name; do
  [ -n "$url" ] || continue
  fetch_and_extract "$url" "$deb_sha" "$member" "$efi_sha" "$name"
done <<'PINS'
http://archive.ubuntu.com/ubuntu/pool/main/s/shim-signed/shim-signed_1.58+15.8-0ubuntu1_amd64.deb ba9b5d80e5d886c30664f2bebfb5c2fcce3b9b40f16fc46cba49c19a91c8059c usr/lib/shim/shimx64.efi.signed.latest 6fe6e1bcbe6cf6baec8e056d40361ca1aa715cc04ddcc2855351de060b84350b shimx64.efi
http://ports.ubuntu.com/ubuntu-ports/pool/main/s/shim-signed/shim-signed_1.58+15.8-0ubuntu1_arm64.deb 58b0f8a0f43bdff2122af8f52b05a5eb73b1964079e36e3eed8d06b4d5164917 usr/lib/shim/shimaa64.efi.signed.latest 706f15b9578f780a2fddda8ee0806cd15b59124692cc297db320414a5a40fe44 shimaa64.efi
http://archive.ubuntu.com/ubuntu/pool/main/g/grub2-signed/grub-efi-amd64-signed_1.202.5+2.12-1ubuntu7.3_amd64.deb 8bd5cd99c3af82aab23af0f15f54c91799f343416412e122df661ef36a44a511 usr/lib/grub/x86_64-efi-signed/grubnetx64.efi.signed b457801e0f4cfd77fe375ecf8dcf098786e540706d81f552c8e58949755c62e8 grubx64.efi
http://ports.ubuntu.com/ubuntu-ports/pool/main/g/grub2-signed/grub-efi-arm64-signed_1.202.5+2.12-1ubuntu7.3_arm64.deb 728d506c28c56d3e4372f5f5b143d837d96b202c82ed05cbbd3ec27a5d4de955 usr/lib/grub/arm64-efi-signed/grubnetaa64.efi.signed f9bf85d005a6be54313a478f33728825515bc6c87509ce39f4fec7212a1b1305 grubaa64.efi
PINS

echo "==> Rendering the stage-1 config ((http,$HOSTPORT), from $(basename "$TMPL"))"
# Sentinel -> literal via sed. The template's $net is a GRUB RUNTIME var and must reach the dongle
# verbatim, which is why nothing here goes through shell expansion.
sed "s|@@POLYPTIC_BASE_HOSTPORT@@|$HOSTPORT|g" "$TMPL" > "$WORK/grub.cfg"

IMG="$DIST/polyptic-boot.img"
echo "==> Assembling the universal FAT32 dongle -> $IMG"
# 64 MiB with 512-byte clusters (-c 1) gives ~130k data clusters, comfortably above the 65,525-cluster
# FLOOR that *defines* FAT32. A smaller image (e.g. 16 MiB) lays out a FAT32 BPB but has too few clusters,
# so a spec-strict UEFI FAT driver (EDK2/OVMF, incl. the arm64 UTM VMs) counts clusters, decides FAT16,
# misreads the BPB, and never finds \EFI\BOOT\<name>, the USB silently fails to boot on strict firmware.
# mtools only: runs unprivileged on macOS AND Linux (no mkfs.vfat, no root, no loop mounts).
rm -f "$IMG"
dd if=/dev/zero of="$IMG" bs=1048576 count=64   # bs=1M is GNU-only and macOS dd spells it 1m; bytes work on both
mformat -i "$IMG" -F -c 1 -v POLYPTIC ::
# One dongle boots BOTH arches: firmware picks \EFI\BOOT\BOOT{X64,AA64}.EFI to match its own CPU, and
# shim then loads grub{x64,aa64}.efi by name from ITS OWN directory. grubnet's baked-in prefix is /grub
# on the device it loaded from, so the stage-1 config lives at the VOLUME ROOT, not beside the binaries.
mmd   -i "$IMG" ::/EFI ::/EFI/BOOT ::/grub
mcopy -i "$IMG" "$DIST/shimx64.efi"  ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "$IMG" "$DIST/grubx64.efi"  ::/EFI/BOOT/grubx64.efi
mcopy -i "$IMG" "$DIST/shimaa64.efi" ::/EFI/BOOT/BOOTAA64.EFI
mcopy -i "$IMG" "$DIST/grubaa64.efi" ::/EFI/BOOT/grubaa64.efi
mcopy -i "$IMG" "$WORK/grub.cfg"     ::/grub/grub.cfg

echo
echo "==> Done. Point BOOT_DIST_DIR at $DIST/ ; the server serves GET /dist/boot/<file>:"
ls -1 "$DIST"/polyptic-boot.img "$DIST"/shim*.efi "$DIST"/grub*.efi
cat <<EOF

Write it:  dd if=$IMG of=/dev/<usb-disk> bs=1048576   (the whole device, not a partition)
Boot the box from USB with Secure Boot ON; it DHCPs, then chains http://$HOSTPORT/boot/grub.cfg.
EOF
