#!/usr/bin/env bash
# deploy/build-live-iso.sh, build the SELF-CONTAINED, BOOTABLE Polyptic live ISO (POL-38).
# Sibling of build-live-image.sh, which makes the NETBOOT payload (deploy/dist/image/<arch>/
# polyptic.iso, deliberately NOT bootable, casper wgets it over HTTP). This script wraps that same
# rootfs into a stock Ubuntu live ISO that boots from USB/CD/virtual-CD with NO network boot
# infrastructure — a first-class provisioning option alongside netboot (D49): write it to a stick,
# boot the box, it comes up diskless and enrols. Also the fastest way to sanity-check the OS half
# in a VM (UTM/QEMU/OVMF). Served by the control plane at GET /dist/image/<arch>/polyptic-live.iso
# with a download button in Console > Settings > Netboot.
#
# MODEL: take a stock casper BASE_ISO, swap in the Polyptic squashfs from the netboot payload,
# bake server URL + enrolment token into /boot/grub/grub.cfg, and REBUILD the boot metadata the
# way Ubuntu lays it out (El Torito UEFI entry = the appended GPT ESP partition).
#
# THE PITFALL THIS EXISTS TO AVOID (hard-won, POL-38): on post-20.10 Ubuntu ISOs the EFI System
# Partition is NOT a file in the ISO tree, it is an APPENDED PARTITION that the El Torito catalog
# points into. A naive xorriso grow/replay repack relocates the El Torito entry but carries over
# only the FIRST 2048-byte sector of the ~5 MiB ESP, so the firmware mounts a FAT whose directory
# tree is garbage: \EFI\BOOT\BOOT*.EFI is unfindable, the auto-created boot option is skipped, and
# the VM drops to the UEFI shell (where even `FS0:\EFI\BOOT\BOOTAA64.EFI` fails with File Not
# Found). The fix: extract the intact ESP from the BASE_ISO and re-attach it with
# `-append_partition ... -e --interval:appended_partition_2:all::` so El Torito and GPT point at
# the SAME, complete image. This script also self-verifies that (see step 5).
#
# Runs on macOS AND Linux, no root: xorriso does everything in userspace (brew install xorriso /
# apt-get install -y xorriso). UEFI boot only (fine for UTM/QEMU; no BIOS El Torito entry).
#
# USAGE:
#   POLYPTIC_BASE=http://192.168.1.62:8080 POLYPTIC_TOKEN=lab-token-123 \
#     BASE_ISO=~/Downloads/ubuntu-26.04-live-server-arm64.iso \
#     deploy/build-live-iso.sh [amd64|arm64]
#     env: BASE_ISO       (required) stock casper live ISO, SAME release/arch the payload was
#                         built from (kernel/initrd/casper-uuid must match the squashfs)
#          POLYPTIC_BASE  (required) control plane, plain http://host:port (VM-reachable address)
#          POLYPTIC_TOKEN (required) enrolment token baked into the cmdline (the ISO file is a
#                         CREDENTIAL: anyone who can read it can read the token; a leaked token
#                         still only lands a NEW box as PENDING for operator approval)
#          PAYLOAD        netboot payload ISO holding casper/filesystem.squashfs
#                         (default deploy/dist/image/<arch>/polyptic.iso, from build-live-image.sh)
#          OUT            output path (default deploy/dist/image/<arch>/polyptic-live.iso)
#
# UTM notes (POL-38): give the VM a GPU display card (virtio-gpu-gl-pci, "GPU Supported") or sway
# has no GL renderer and the screen stays black; leave the drive as a USB CD (auto-boots once the
# ESP is intact). RAM >= 4 GiB: casper copies the whole ISO into RAM.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-arm64}" in
  amd64|x86_64|x64) ARCH=amd64 ;;
  arm64|aarch64)    ARCH=arm64 ;;
  *) echo "build-live-iso: unknown arch '${1:-}' (amd64|arm64)" >&2; exit 2 ;;
esac
: "${BASE_ISO:?set BASE_ISO=/path/to/ubuntu-*-live-*.iso (stock casper ISO, same release as the payload)}"
: "${POLYPTIC_BASE:?set POLYPTIC_BASE, e.g. http://192.168.1.62:8080 (VM-reachable)}"
: "${POLYPTIC_TOKEN:?set POLYPTIC_TOKEN (the enrolment/bootstrap token to bake in)}"
PAYLOAD="${PAYLOAD:-$REPO_ROOT/deploy/dist/image/$ARCH/polyptic.iso}"
OUT="${OUT:-$REPO_ROOT/deploy/dist/image/$ARCH/polyptic-live.iso}"

case "$POLYPTIC_BASE" in
  http://*) ;;
  *) echo "build-live-iso: POLYPTIC_BASE must be plain http://host[:port] (GRUB/casper speak no TLS)" >&2; exit 2 ;;
esac
HOSTPORT="${POLYPTIC_BASE#http://}"; HOSTPORT="${HOSTPORT%/}"

command -v xorriso >/dev/null || { echo "missing xorriso (brew install xorriso / apt-get install xorriso)" >&2; exit 1; }
[ -f "$BASE_ISO" ] || { echo "BASE_ISO not found: $BASE_ISO" >&2; exit 1; }
[ -f "$PAYLOAD" ]  || { echo "payload not found: $PAYLOAD (run deploy/build-live-image.sh $ARCH first, or set PAYLOAD=)" >&2; exit 1; }

WORK="$(mktemp -d "${TMPDIR:-/tmp}/polyptic-vmiso.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
TREE="$WORK/tree"; mkdir -p "$TREE" "$(dirname "$OUT")"

echo '==> [1/5] extract the intact ESP out of the base ISO (El Torito UEFI image)'
# The report line: "El Torito boot img : 1 UEFI y none 0x0000 0x00 <Ldsiz> <LBA>", LBA in
# 2048-byte blocks, load size in 512-byte blocks. This IS the appended ESP on Ubuntu ISOs.
ET_LINE="$(xorriso -indev "$BASE_ISO" -report_el_torito plain 2>/dev/null | grep -E '^El Torito boot img.* UEFI ' | head -n1)"
[ -n "$ET_LINE" ] || { echo "no UEFI El Torito entry on $BASE_ISO (not a UEFI-bootable casper ISO?)" >&2; exit 1; }
ET_LBA="$(echo "$ET_LINE" | awk '{print $NF}')"; ET_LDSIZ="$(echo "$ET_LINE" | awk '{print $(NF-1)}')"
dd if="$BASE_ISO" of="$WORK/esp.img" bs=512 skip=$((ET_LBA * 4)) count="$ET_LDSIZ" 2>/dev/null
# The ESP must be a FAT image, not a stub: boot-sector signature + a jump opcode.
head -c 512 "$WORK/esp.img" | od -An -tx1 | tr -d ' \n' | grep -q '^eb' || { echo "extracted ESP does not start with a FAT boot sector" >&2; exit 1; }

echo '==> [2/5] extract the base ISO tree + swap in the Polyptic squashfs'
xorriso -osirrox on -indev "$BASE_ISO" -extract / "$TREE" >/dev/null 2>&1
chmod -R u+w "$TREE"   # osirrox mirrors the ISO's read-only permissions; we must edit the tree
rm -f "$TREE"/casper/*.squashfs "$TREE"/casper/*.squashfs.gpg
xorriso -osirrox on -indev "$PAYLOAD" -extract /casper/filesystem.squashfs "$TREE/casper/filesystem.squashfs" >/dev/null 2>&1 \
  || { echo "payload $PAYLOAD has no /casper/filesystem.squashfs" >&2; exit 1; }
chmod u+w "$TREE/casper/filesystem.squashfs"
# casper sizes its RAM overlay from filesystem.size; the payload carries the right value.
xorriso -osirrox on -indev "$PAYLOAD" -extract /casper/filesystem.size "$TREE/casper/filesystem.size" >/dev/null 2>&1 || true
# Kernel/.disk/casper-uuid-* stay the BASE ISO's own: build-live-image.sh never changes the kernel
# (apt-mark hold), so the base initrd matches the squashfs modules AND its baked casper-uuid. The
# INITRD prefers build-live-image.sh's splash-augmented copy next to the payload when present: same
# stock initrd + an appended cpio segment carrying the Polyptic Plymouth theme (POL-38), which is
# what makes `quiet splash` show a branded splash instead of text.
AUG_INITRD="$(dirname "$PAYLOAD")/initrd"
if [ -f "$AUG_INITRD" ]; then
  cp -f "$AUG_INITRD" "$TREE/casper/initrd"; chmod u+w "$TREE/casper/initrd"
  echo "    using the splash-augmented initrd from $(dirname "$PAYLOAD")"
fi

echo '==> [3/5] bake the enrolment cmdline into /boot/grub/grub.cfg'
# `quiet splash` (POL-7/POL-38): the squashfs carries the Polyptic Plymouth theme (baked by `setup`
# at image-build time); these flags are what replace the scrolling kernel/systemd text with it.
mkdir -p "$TREE/boot/grub"
cat > "$TREE/boot/grub/grub.cfg" <<EOF
set timeout=5
set default=0
menuentry "Polyptic" {
    set gfxpayload=keep
    linux  /casper/vmlinuz boot=casper layerfs-path=filesystem.squashfs polyptic.server_url=ws://$HOSTPORT/agent polyptic.token=$POLYPTIC_TOKEN multipath=off quiet splash plymouth.ignore-serial-consoles --- console=tty0
    initrd /casper/initrd
}
menuentry 'UEFI Firmware Settings' { fwsetup }
EOF

echo '==> [4/5] rebuild the ISO with the ESP appended (El Torito -> appended GPT partition)'
VOLID="$(xorriso -indev "$BASE_ISO" -pvd_info 2>/dev/null | awk -F': ' '/^Volume Id/{print $2}')"
rm -f "$OUT"
xorriso -as mkisofs -r -V "${VOLID:-POLYPTIC-LIVE}" -J -joliet-long -l \
  -o "$OUT" \
  -partition_offset 16 \
  -append_partition 2 C12A7328-F81F-11D2-BA4B-00A0C93EC93B "$WORK/esp.img" \
  -appended_part_as_gpt \
  -c boot.catalog -e '--interval:appended_partition_2:all::' -no-emul-boot \
  "$TREE"

echo '==> [5/5] self-verify: El Torito must point at the appended ESP, and its FAT must be whole'
REP="$(xorriso -indev "$OUT" -report_el_torito plain -report_system_area plain 2>/dev/null)"
NEW_LBA="$(echo "$REP" | grep -E '^El Torito boot img.* UEFI ' | awk '{print $NF}')"
ESP_START="$(echo "$REP" | awk '/^GPT start and size/{if ($(NF-1) != "") last2=$(NF-1)" "$NF} /GPT type GUID.*28732ac1/{want=1} want && /^GPT start and size/{print $(NF-1); exit}')"
[ -n "$NEW_LBA" ] || { echo "VERIFY FAIL: rebuilt ISO has no UEFI El Torito entry" >&2; exit 1; }
[ "$((NEW_LBA * 4))" = "$ESP_START" ] || { echo "VERIFY FAIL: El Torito LBA $NEW_LBA != GPT ESP start $ESP_START/4 (the POL-38 breakage)" >&2; exit 1; }
cmp -s "$WORK/esp.img" <(dd if="$OUT" bs=512 skip="$ESP_START" count="$ET_LDSIZ" 2>/dev/null) \
  || { echo "VERIFY FAIL: ESP bytes inside the rebuilt ISO differ from the extracted ESP" >&2; exit 1; }
echo "    El Torito UEFI image == appended GPT ESP at 512-block $ESP_START, byte-identical. PASS."

echo "==> done -> $OUT"
cat <<EOF

Attach $OUT to a UEFI VM as a (USB) CD and it auto-boots: GRUB (5s) -> casper -> greetd/sway ->
agent enrols into ws://$HOSTPORT/agent with the baked token. UTM: set the display card to
virtio-gpu-gl-pci ("GPU Supported"), RAM >= 4 GiB. For a real box: write it to a USB stick
(dd if=<iso> of=/dev/<usb-disk> bs=4M) and boot with Secure Boot ON. The baked token makes the
FILE a credential: share it like one (a leaked token still only lands new boxes as PENDING).
EOF
