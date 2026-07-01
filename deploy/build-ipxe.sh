#!/usr/bin/env bash
# deploy/build-ipxe.sh, build the Polyptic iPXE BOOT MEDIUM (POL-33). Sibling of build-agent.sh.
#
# Clones iPXE, bakes the control-plane base URL into an embedded script (deploy/embed.ipxe.tmpl → menu:
# boot-now / offload), and compiles a UEFI binary whose embedded script chains ${base}/boot.ipxe. The
# binary is TOKENLESS (base only); the server bakes the enrolment token at chain time. Output:
#   deploy/dist/ipxe/polyptic-boot-<arch>.efi           the raw loader (UEFI HTTP Boot / DHCP / offload)
#   deploy/dist/ipxe/polyptic-boot-<arch>-snponly.efi   SNP-only variant for fussy NICs
#   deploy/dist/ipxe/polyptic-boot-<arch>.img           a dd-able FAT32 USB dongle image
# The server serves these UNGATED at GET /dist/ipxe/<file> and links the .img from Console ▸ Settings ▸
# Netboot (Download boot medium).
#
# LINUX BUILD HOST ONLY, iPXE cross-compiles to a UEFI PE binary with a GNU toolchain; this CANNOT be
# built or verified on macOS (no toolchain producing bin-*-efi/*.efi there). Run on Linux/CI.
#
# PREREQUISITES (Debian/Ubuntu build host):
#   amd64:  sudo apt-get install -y build-essential liblzma-dev perl git mtools
#   arm64:  also  sudo apt-get install -y gcc-aarch64-linux-gnu binutils-aarch64-linux-gnu
#
# USAGE:
#   POLYPTIC_BASE=https://polyptic.example.com deploy/build-ipxe.sh [amd64|arm64]
#     env: POLYPTIC_BASE (required)   IPXE_REF (pin a commit/tag; default master)   SKIP_IMG=1 (no .img)
set -euo pipefail

: "${POLYPTIC_BASE:?set POLYPTIC_BASE, e.g. https://polyptic.example.com (baked into the medium)}"
ARCH_IN="${1:-amd64}"
IPXE_REF="${IPXE_REF:-master}"

case "$ARCH_IN" in
  amd64|x86_64|x64) ARCH=amd64; TARGET=bin-x86_64-efi; CROSS=();                         EFINAME=BOOTX64.EFI  ;;
  arm64|aarch64)    ARCH=arm64; TARGET=bin-arm64-efi;  CROSS=(CROSS=aarch64-linux-gnu-); EFINAME=BOOTAA64.EFI ;;
  *) echo "build-ipxe: unknown arch '$ARCH_IN' (expected amd64 or arm64)" >&2; exit 2 ;;
esac
# NOTE: never pass ARCH= to make, iPXE derives it from the bin-<plat>-efi target name.

[ "$(uname -s)" = "Linux" ] || { echo "build-ipxe: Linux build host required (got $(uname -s)), iPXE needs a GNU/EFI toolchain" >&2; exit 1; }
command -v git  >/dev/null 2>&1 || { echo "build-ipxe: 'git' not found" >&2; exit 1; }
command -v make >/dev/null 2>&1 || { echo "build-ipxe: 'make' not found, apt-get install build-essential" >&2; exit 1; }

HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$HERE/dist/ipxe"
TMPL="$HERE/embed.ipxe.tmpl"
[ -f "$TMPL" ] || { echo "build-ipxe: missing $TMPL" >&2; exit 1; }
mkdir -p "$DIST"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

echo "==> Cloning iPXE ($IPXE_REF)"
git clone --depth 1 --branch "$IPXE_REF" https://github.com/ipxe/ipxe "$WORK/ipxe" \
  || git clone https://github.com/ipxe/ipxe "$WORK/ipxe"
SRC="$WORK/ipxe/src"

# Bake the base URL into the embedded script (sentinel → literal; bash must NOT expand iPXE's ${...}).
sed "s|@@POLYPTIC_BASE@@|$POLYPTIC_BASE|g" "$TMPL" > "$SRC/embed.ipxe"

# Enable HTTPS + the menu/reboot commands the embedded script uses (off by default in iPXE).
{ echo '#define DOWNLOAD_PROTO_HTTPS'
  echo '#define REBOOT_CMD'
} >> "$SRC/config/local/general.h"
# NB: for an https base with a PRIVATE CA, also pass TRUST=/path/ca.pem to make so iPXE trusts the cert.
# Plain http on a trusted LAN needs nothing.

echo "==> Building $TARGET/ipxe.efi + snponly.efi (EMBED)"
make -C "$SRC" "${CROSS[@]}" "$TARGET/ipxe.efi"    EMBED=embed.ipxe -j"$(nproc)"
make -C "$SRC" "${CROSS[@]}" "$TARGET/snponly.efi" EMBED=embed.ipxe -j"$(nproc)"
cp "$SRC/$TARGET/ipxe.efi"    "$DIST/polyptic-boot-$ARCH.efi"
cp "$SRC/$TARGET/snponly.efi" "$DIST/polyptic-boot-$ARCH-snponly.efi"

# A dd-able FAT32 USB image (boots via the firmware's default \EFI\BOOT\<EFINAME> path). NEVER touches a
# target machine, this IS the dongle image itself. Needs mtools (mmd/mcopy) + dosfstools (mkfs.vfat).
if [ -z "${SKIP_IMG:-}" ] && command -v mkfs.vfat >/dev/null 2>&1 && command -v mcopy >/dev/null 2>&1; then
  IMG="$DIST/polyptic-boot-$ARCH.img"
  echo "==> Wrapping into a FAT32 USB image -> $IMG"
  # 64 MiB with 512-byte clusters (-s 1) gives ~130k data clusters, comfortably above the 65,525-cluster
  # FLOOR that *defines* FAT32. A smaller image (e.g. 16 MiB) lays out a FAT32 BPB but has too few clusters,
  # so a spec-strict UEFI FAT driver (EDK2/OVMF, incl. the arm64 UTM VMs) counts clusters, decides FAT16,
  # misreads the BPB, and never finds \EFI\BOOT\<EFINAME>, the USB silently fails to boot on strict firmware.
  dd if=/dev/zero of="$IMG" bs=1M count=64 status=none
  mkfs.vfat -F 32 -s 1 -n POLYPTIC "$IMG"    # keep stderr (a cluster-count warning must be visible)
  mmd   -i "$IMG" ::/EFI ::/EFI/BOOT
  mcopy -i "$IMG" "$DIST/polyptic-boot-$ARCH.efi" "::/EFI/BOOT/$EFINAME"
else
  echo "==> Skipping .img (SKIP_IMG set, or mtools/dosfstools missing), the .efi still serves HTTP-boot"
fi

echo
echo "==> Done. Point IPXE_DIST_DIR at $DIST/ ; the server serves GET /dist/ipxe/<file>:"
ls -1 "$DIST"/polyptic-boot-"$ARCH"* 2>/dev/null || true
