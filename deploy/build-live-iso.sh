#!/usr/bin/env bash
# deploy/build-live-iso.sh, build the SELF-CONTAINED, BOOTABLE Polyptic live ISO (POL-38/D49).
# Sibling of build-live-image.sh, which makes the NETBOOT payload (deploy/dist/image/<arch>/
# {vmlinuz,initrd,rootfs.squashfs}, streamed over HTTP). This script wraps that same rootfs into a
# bootable ISO for USB/CD/virtual-CD with NO network boot infrastructure — a first-class provisioning
# option alongside netboot (D49): write it to a stick, boot the box, it comes up diskless and enrols.
# It is also the LOW-RAM option: the squashfs is mounted straight off the medium instead of being
# downloaded into RAM, so a box that cannot netboot can still run Polyptic.
#
# MODEL: take a stock Ubuntu live BASE_ISO purely for its BOOT METADATA (the signed EFI System
# Partition and GRUB's on-disk prefix), throw away everything else, and lay down our own kernel,
# dracut initrd and `rootfs.squashfs` (as /LiveOS/squashfs.img, where dracut's dmsquash-live looks).
# The cmdline is dracut's `root=live:CDLABEL=POLYPTIC`, the same initrd the netboot flow uses — one
# initrd, two media. Secure Boot is unaffected: shim + GRUB come from the base ISO's ESP untouched,
# and vmlinuz is the Canonical-signed kernel build-live-image.sh already guarded.
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
#     env: BASE_ISO       (required) a stock Ubuntu live ISO of the SAME ARCH, used only for its
#                         signed ESP + GRUB prefix. Its kernel, initrd and squashfs are discarded,
#                         so its release no longer has to match the payload's.
#          POLYPTIC_BASE  (required) control plane, plain http://host:port (VM-reachable address)
#          POLYPTIC_TOKEN (required) enrolment token baked into the cmdline (the ISO file is a
#                         CREDENTIAL: anyone who can read it can read the token; a leaked token
#                         still only lands a NEW box as PENDING for operator approval)
#          IMAGE_DIR      the netboot payload dir holding vmlinuz/initrd/rootfs.squashfs
#                         (default deploy/dist/image/<arch>, from build-live-image.sh)
#          OUT            output path (default deploy/dist/image/<arch>/polyptic-live.iso)
#          POLYPTIC_WIFI_SSID / POLYPTIC_WIFI_PSK
#                         (optional, POL-63) bake Wi-Fi credentials: the booted box associates and
#                         enrols over Wi-Fi with no wired network at all. PSK networks only via the
#                         shorthand; for WPA-Enterprise (or hidden SSIDs, country, EAP certs) point
#                         POLYPTIC_WIFI_CONF at a full wifi.conf instead (schema: docs/NETBOOT.md).
#          POLYPTIC_WIFI_CONF   (optional) path to a complete wifi.conf to bake verbatim
#          POLYPTIC_WIFI_CERTS  (optional) directory of EAP cert files, baked as polyptic/certs/
#                         An ISO is read-only, so credentials CANNOT be edited after the build (that
#                         is the universal USB medium's trick) — rebake to change them. Like the
#                         token, baked Wi-Fi secrets make the FILE a credential.
#
# UTM notes (POL-38): give the VM a GPU display card (virtio-gpu-gl-pci, "GPU Supported") or sway
# has no GL renderer and the screen stays black; leave the drive as a USB CD (auto-boots once the
# ESP is intact). RAM >= 2 GiB: the squashfs is mounted off the medium, not copied into RAM.
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

case "${1:-arm64}" in
  amd64|x86_64|x64) ARCH=amd64 ;;
  arm64|aarch64)    ARCH=arm64 ;;
  *) echo "build-live-iso: unknown arch '${1:-}' (amd64|arm64)" >&2; exit 2 ;;
esac
: "${BASE_ISO:?set BASE_ISO=/path/to/ubuntu-*-live-*.iso (a stock Ubuntu live ISO, same arch)}"
: "${POLYPTIC_BASE:?set POLYPTIC_BASE, e.g. http://192.168.1.62:8080 (VM-reachable)}"
: "${POLYPTIC_TOKEN:?set POLYPTIC_TOKEN (the enrolment/bootstrap token to bake in)}"
IMAGE_DIR="${IMAGE_DIR:-$REPO_ROOT/deploy/dist/image/$ARCH}"
OUT="${OUT:-$REPO_ROOT/deploy/dist/image/$ARCH/polyptic-live.iso}"
# The ISO9660 volume label. `root=live:CDLABEL=$VOLID` resolves through /dev/disk/by-label, so this
# string and the cmdline below must agree exactly.
VOLID="POLYPTIC"

case "$POLYPTIC_BASE" in
  http://*) ;;
  *) echo "build-live-iso: POLYPTIC_BASE must be plain http://host[:port] (the agent's WS URL is derived from it)" >&2; exit 2 ;;
esac
HOSTPORT="${POLYPTIC_BASE#http://}"; HOSTPORT="${HOSTPORT%/}"

command -v xorriso >/dev/null || { echo "missing xorriso (brew install xorriso / apt-get install xorriso)" >&2; exit 1; }
[ -f "$BASE_ISO" ] || { echo "BASE_ISO not found: $BASE_ISO" >&2; exit 1; }
for f in vmlinuz initrd rootfs.squashfs; do
  [ -f "$IMAGE_DIR/$f" ] || { echo "payload missing: $IMAGE_DIR/$f (run deploy/build-live-image.sh $ARCH first, or set IMAGE_DIR=)" >&2; exit 1; }
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/polyptic-liveiso.XXXXXX")"; trap 'rm -rf "$WORK"' EXIT
TREE="$WORK/tree"; mkdir -p "$TREE" "$(dirname "$OUT")"

echo '==> [1/5] extract the intact ESP out of the base ISO (El Torito UEFI image)'
# The report line: "El Torito boot img : 1 UEFI y none 0x0000 0x00 <Ldsiz> <LBA>", LBA in
# 2048-byte blocks, load size in 512-byte blocks. This IS the appended ESP on Ubuntu ISOs.
ET_LINE="$(xorriso -indev "$BASE_ISO" -report_el_torito plain 2>/dev/null | grep -E '^El Torito boot img.* UEFI ' | head -n1)"
[ -n "$ET_LINE" ] || { echo "no UEFI El Torito entry on $BASE_ISO (not a UEFI-bootable live ISO?)" >&2; exit 1; }
ET_LBA="$(echo "$ET_LINE" | awk '{print $NF}')"; ET_LDSIZ="$(echo "$ET_LINE" | awk '{print $(NF-1)}')"
dd if="$BASE_ISO" of="$WORK/esp.img" bs=512 skip=$((ET_LBA * 4)) count="$ET_LDSIZ" 2>/dev/null
# The ESP must be a FAT image, not a stub: boot-sector signature + a jump opcode.
head -c 512 "$WORK/esp.img" | od -An -tx1 | tr -d ' \n' | grep -q '^eb' || { echo "extracted ESP does not start with a FAT boot sector" >&2; exit 1; }

echo '==> [2/5] lay down our own boot tree (the base ISO gives only /boot/grub + /EFI)'
# GRUB resolves its config against the prefix baked into the signed binary on the ESP, which on an
# Ubuntu live ISO is the CD's own `/boot/grub`. Take that directory (and the /EFI copy beside it)
# from the base ISO and nothing else — no casper, no installer pool, no second kernel.
xorriso -osirrox on -indev "$BASE_ISO" -extract /boot "$TREE/boot" >/dev/null 2>&1 \
  || { echo "base ISO has no /boot tree (unexpected layout)" >&2; exit 1; }
xorriso -osirrox on -indev "$BASE_ISO" -extract /EFI "$TREE/EFI" >/dev/null 2>&1 || true
chmod -R u+w "$TREE"   # osirrox mirrors the ISO's read-only permissions; we must edit the tree
rm -rf "$TREE"/boot/vmlinuz* "$TREE"/boot/initrd*
install -m0644 "$IMAGE_DIR/vmlinuz" "$TREE/boot/vmlinuz"
install -m0644 "$IMAGE_DIR/initrd"  "$TREE/boot/initrd"
# dracut's dmsquash-live looks for `<rd.live.dir>/<rd.live.squashimg>` on the mounted live device;
# the defaults are LiveOS/squashfs.img. Our squashfs is a FLAT root (it has /usr), which
# dmsquash-live detects and mounts under a required overlayfs — no nested rootfs.img needed.
mkdir -p "$TREE/LiveOS"
cp -f "$IMAGE_DIR/rootfs.squashfs" "$TREE/LiveOS/squashfs.img"

echo '==> [3/6] bake Wi-Fi credentials (optional, POL-63)'
# The booted rootfs looks for polyptic/wifi.conf on the mounted live medium (dracut keeps the ISO at
# /run/initramfs/live), so credentials ride the ISO tree, not the cmdline — SSIDs and passphrases
# with spaces/quotes need no cmdline escaping, and EAP cert FILES can ride along. Validated HERE with
# the same parser the box runs (deploy/live/.../wifi-conf.sh): a typo'd config must fail the build,
# not a box that is already mounted on a wall.
WIFI_SUMMARY="none (wired provisioning)"
if [ -n "${POLYPTIC_WIFI_CONF:-}" ] || [ -n "${POLYPTIC_WIFI_SSID:-}" ]; then
  mkdir -p "$TREE/polyptic"
  if [ -n "${POLYPTIC_WIFI_CONF:-}" ]; then
    [ -f "$POLYPTIC_WIFI_CONF" ] || { echo "POLYPTIC_WIFI_CONF not found: $POLYPTIC_WIFI_CONF" >&2; exit 1; }
    install -m0644 "$POLYPTIC_WIFI_CONF" "$TREE/polyptic/wifi.conf"
  else
    : "${POLYPTIC_WIFI_PSK:?POLYPTIC_WIFI_SSID is set, so POLYPTIC_WIFI_PSK is required (open networks / EAP need a full POLYPTIC_WIFI_CONF)}"
    printf 'WIFI_SSID=%s\nWIFI_PSK=%s\n' "$POLYPTIC_WIFI_SSID" "$POLYPTIC_WIFI_PSK" > "$TREE/polyptic/wifi.conf"
  fi
  if [ -n "${POLYPTIC_WIFI_CERTS:-}" ]; then
    [ -d "$POLYPTIC_WIFI_CERTS" ] || { echo "POLYPTIC_WIFI_CERTS is not a directory: $POLYPTIC_WIFI_CERTS" >&2; exit 1; }
    mkdir -p "$TREE/polyptic/certs"
    cp -R "$POLYPTIC_WIFI_CERTS/." "$TREE/polyptic/certs/"
  fi
  sh "$REPO_ROOT/deploy/live/usr/local/lib/polyptic/wifi-conf.sh" "$TREE/polyptic/wifi.conf" >/dev/null \
    || { echo "build-live-iso: the Wi-Fi config is invalid (message above); nothing was built" >&2; exit 1; }
  WIFI_SUMMARY="$(sed -n 's/^WIFI_SSID=//p' "$TREE/polyptic/wifi.conf" | head -n1) (credentials baked, read-only)"
  echo "    Wi-Fi: $WIFI_SUMMARY"
else
  echo '    Wi-Fi: none requested'
fi

echo '==> [4/6] bake the enrolment cmdline into /boot/grub/grub.cfg'
# `quiet splash` (POL-7/POL-38): the squashfs carries the Polyptic Plymouth theme and dracut bundled
# it into the initrd; these flags are what replace the scrolling kernel/systemd text with it.
# `plymouth.ignore-serial-consoles` is load-bearing on arm64 VMs (implicit devicetree serial console).
mkdir -p "$TREE/boot/grub"
cat > "$TREE/boot/grub/grub.cfg" <<EOF
set timeout=5
set default=0
menuentry "Polyptic" {
    set gfxpayload=keep
    linux  /boot/vmlinuz root=live:CDLABEL=$VOLID rd.overlay=1 polyptic.server_url=ws://$HOSTPORT/agent polyptic.token=$POLYPTIC_TOKEN multipath=off quiet splash plymouth.ignore-serial-consoles console=tty0
    initrd /boot/initrd
}
menuentry 'UEFI Firmware Settings' { fwsetup }
EOF

echo '==> [5/6] rebuild the ISO with the ESP appended (El Torito -> appended GPT partition)'
rm -f "$OUT"
xorriso -as mkisofs -r -V "$VOLID" -J -joliet-long -l \
  -o "$OUT" \
  -partition_offset 16 \
  -append_partition 2 C12A7328-F81F-11D2-BA4B-00A0C93EC93B "$WORK/esp.img" \
  -appended_part_as_gpt \
  -c boot.catalog -e '--interval:appended_partition_2:all::' -no-emul-boot \
  "$TREE"

echo '==> [6/6] self-verify: El Torito must point at the appended ESP, and its FAT must be whole'
REP="$(xorriso -indev "$OUT" -report_el_torito plain -report_system_area plain 2>/dev/null)"
NEW_LBA="$(echo "$REP" | grep -E '^El Torito boot img.* UEFI ' | awk '{print $NF}')"
ESP_START="$(echo "$REP" | awk '/^GPT start and size/{if ($(NF-1) != "") last2=$(NF-1)" "$NF} /GPT type GUID.*28732ac1/{want=1} want && /^GPT start and size/{print $(NF-1); exit}')"
[ -n "$NEW_LBA" ] || { echo "VERIFY FAIL: rebuilt ISO has no UEFI El Torito entry" >&2; exit 1; }
[ "$((NEW_LBA * 4))" = "$ESP_START" ] || { echo "VERIFY FAIL: El Torito LBA $NEW_LBA != GPT ESP start $ESP_START/4 (the POL-38 breakage)" >&2; exit 1; }
cmp -s "$WORK/esp.img" <(dd if="$OUT" bs=512 skip="$ESP_START" count="$ET_LDSIZ" 2>/dev/null) \
  || { echo "VERIFY FAIL: ESP bytes inside the rebuilt ISO differ from the extracted ESP" >&2; exit 1; }
echo "    El Torito UEFI image == appended GPT ESP at 512-block $ESP_START, byte-identical. PASS."

echo "==> done -> $OUT ($(du -h "$OUT" | cut -f1))"
cat <<EOF

Attach $OUT to a UEFI VM as a (USB) CD and it auto-boots: GRUB (5s) -> dracut mounts
/LiveOS/squashfs.img off the medium -> greetd/sway -> the agent enrols into ws://$HOSTPORT/agent
with the baked token. UTM: set the display card to virtio-gpu-gl-pci ("GPU Supported"), RAM >= 2 GiB
(nothing is copied into RAM). For a real box: write it to a USB stick (dd if=<iso> of=/dev/<usb-disk>
bs=4M) and boot with Secure Boot ON. The baked token makes the FILE a credential: share it like one
(a leaked token still only lands new boxes as PENDING). Wi-Fi: $WIFI_SUMMARY.
EOF
