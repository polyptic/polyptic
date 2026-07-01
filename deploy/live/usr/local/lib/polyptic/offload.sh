#!/bin/sh
# One-shot OFFLOAD (POL-33): relocate the tiny iPXE loader (the POINTER, not the OS) onto THIS box's
# existing EFI System Partition + register a UEFI boot entry, so it self-boots the identical HTTP flow
# on every power-on with no dongle attached. Triggered by `polyptic.offload=1` on the kernel cmdline
# (the boot medium's "Offload to this box" menu item chains GET /boot.ipxe?offload=1). Runs from the
# booted live image via polyptic-offload.service (ConditionKernelCommandLine=polyptic.offload=1).
#
# HARD RULE: never repartition, format, or wipe. This ONLY (a) drops one file into the EXISTING ESP and
# (b) adds one UEFI boot entry. The full live OS still streams from the control plane into RAM every boot;
# what lands on disk is the ~few-MB loader, never an OS, identity, or state. UEFI-only.
set -eu

# The ESP GUID that marks an EFI System Partition in a GPT table.
ESP_GUID="c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
STAMP="${POLYPTIC_OFFLOAD_STAMP:-/var/lib/polyptic/offloaded}"

# UEFI-mode only: efibootmgr needs efivarfs. A BIOS/CSM boot has no NVRAM boot entries to add.
if [ ! -d /sys/firmware/efi ]; then
  echo "offload: not booted in UEFI mode, cannot add a boot entry; leaving box as dongle-only" >&2
  exit 0
fi

# Recover the HTTP control-plane base + arch from the cmdline (the same values GET /boot.ipxe baked).
base="$(sed -n 's/.*polyptic\.base=\([^ ]*\).*/\1/p' /proc/cmdline)"
[ -n "$base" ] || { echo "offload: no polyptic.base= on cmdline, aborting" >&2; exit 1; }
arch="$(dpkg --print-architecture 2>/dev/null || echo amd64)"
loader_efi="EFI/polyptic/polyptic.efi"

# Fetch the TOKENLESS loader from the ungated depot (the box has no operator session).
tmp_efi="$(mktemp)"
mnt=""
# Clean up on ANY exit (set -eu means a mid-sequence failure would otherwise leave the ESP mounted on a
# temp dir + leak the loader). Best-effort, never masks the real exit status.
cleanup() { [ -n "$mnt" ] && mountpoint -q "$mnt" 2>/dev/null && umount "$mnt" 2>/dev/null; [ -n "$mnt" ] && rmdir "$mnt" 2>/dev/null; rm -f "$tmp_efi" 2>/dev/null; return 0; }
trap cleanup EXIT
if ! curl -fsSL "$base/dist/ipxe/polyptic-boot-$arch.efi" -o "$tmp_efi"; then
  echo "offload: could not fetch $base/dist/ipxe/polyptic-boot-$arch.efi, aborting" >&2
  exit 1
fi

# Find the EXISTING ESP by GPT partition-type GUID (never create/format one).
esp_part=""
for p in $(lsblk -rno NAME,PARTTYPE | awk -v g="$ESP_GUID" 'tolower($2)==g {print $1}'); do
  esp_part="$p"; break
done
[ -n "$esp_part" ] || { echo "offload: no EFI System Partition found, aborting (nothing wiped)" >&2; exit 1; }
disk="/dev/$(lsblk -no PKNAME "/dev/$esp_part")"
partnum="$(cat "/sys/class/block/$esp_part/partition")"

# Drop the loader into our own subdir on the ESP, leaving everything else untouched.
mnt="$(mktemp -d)"
mount "/dev/$esp_part" "$mnt"
install -D -m0644 "$tmp_efi" "$mnt/$loader_efi"
umount "$mnt"; rmdir "$mnt"; mnt=""; rm -f "$tmp_efi"

# Add a UEFI boot entry pointing at it (backslash-separated ESP-relative path). Add-only.
if ! efibootmgr | grep -q "Polyptic Netboot"; then
  efibootmgr -c -d "$disk" -p "$partnum" -L "Polyptic Netboot" -l '\EFI\polyptic\polyptic.efi'
fi

mkdir -p "$(dirname "$STAMP")"; : > "$STAMP"
echo "offload: installed \\EFI\\polyptic\\polyptic.efi on $disk part $partnum + added UEFI entry, pull the USB."
exit 0
