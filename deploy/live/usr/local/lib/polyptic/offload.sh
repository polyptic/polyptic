#!/bin/sh
# One-shot OFFLOAD (POL-33/D47): relocate the SIGNED loader pair (the POINTER, not the OS) onto THIS
# box's existing EFI System Partition + register a UEFI boot entry, so it self-boots the identical HTTP
# flow on every power-on with no dongle attached. The pair is Ubuntu's Microsoft-signed shim + the
# Canonical-signed network GRUB, the same chain as the dongle, so Secure Boot stays ON. Triggered by
# `polyptic.offload=1` on the kernel cmdline (the "offload" entry in the server's /boot/grub.cfg menu).
# Runs from the booted live image via polyptic-offload.service
# (ConditionKernelCommandLine=polyptic.offload=1).
#
# HARD RULE: never repartition, format, or wipe. This ONLY (a) drops shim+GRUB into our own subdir on
# the EXISTING ESP, (b) writes the stage-1 config at the ESP's /grub/<arch>-efi/grub.cfg (refusing to
# touch a foreign file there), and (c) adds one UEFI boot entry. The full live OS still streams from the control
# plane into RAM every boot; what lands on disk is the ~few-MB loader pair, never an OS, identity, or
# state. UEFI-only.
set -eu

# The ESP GUID that marks an EFI System Partition in a GPT table.
ESP_GUID="c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
STAMP="${POLYPTIC_OFFLOAD_STAMP:-/var/lib/polyptic/offloaded}"

# UEFI-mode only: efibootmgr needs efivarfs. A BIOS/CSM boot has no NVRAM boot entries to add.
if [ ! -d /sys/firmware/efi ]; then
  echo "offload: not booted in UEFI mode, cannot add a boot entry; leaving box as dongle-only" >&2
  exit 0
fi

# Recover the HTTP control-plane base from the cmdline (the same value GET /boot/grub.cfg baked); GRUB
# wants it as bare host:port.
base="$(sed -n 's/.*polyptic\.base=\([^ ]*\).*/\1/p' /proc/cmdline)"
[ -n "$base" ] || { echo "offload: no polyptic.base= on cmdline, aborting" >&2; exit 1; }
hostport="${base#http://}"; hostport="${hostport%%/*}"

# EFI arch suffix (shim/grub binary names) + GRUB platform dir, from the RUNNING kernel; dpkg is not
# guaranteed to reflect the firmware arch. grubdir is the arch subdir grubnet's memdisk bootstrap
# sources FIRST (before the plain $prefix/grub.cfg), so writing our config there always wins over a
# foreign lower-precedence config left on a repurposed ESP.
case "$(uname -m)" in
  x86_64)  efiarch=x64;  grubdir=x86_64-efi ;;
  aarch64) efiarch=aa64; grubdir=arm64-efi  ;;
  *) echo "offload: unsupported machine '$(uname -m)', aborting" >&2; exit 1 ;;
esac

# Fetch the TOKENLESS signed pair from the ungated depot (the box has no operator session).
tmp_shim="$(mktemp)"; tmp_grub="$(mktemp)"; tmp_cfg="$(mktemp)"
mnt=""
# Clean up on ANY exit (set -eu means a mid-sequence failure would otherwise leave the ESP mounted on a
# temp dir + leak the loaders). Best-effort, never masks the real exit status.
cleanup() { [ -n "$mnt" ] && mountpoint -q "$mnt" 2>/dev/null && umount "$mnt" 2>/dev/null; [ -n "$mnt" ] && rmdir "$mnt" 2>/dev/null; rm -f "$tmp_shim" "$tmp_grub" "$tmp_cfg" 2>/dev/null; return 0; }
trap cleanup EXIT
if ! curl -fsSL "$base/dist/boot/shim$efiarch.efi" -o "$tmp_shim" \
|| ! curl -fsSL "$base/dist/boot/grub$efiarch.efi" -o "$tmp_grub"; then
  echo "offload: could not fetch $base/dist/boot/{shim,grub}$efiarch.efi, aborting" >&2
  exit 1
fi

# The stage-1 config, same content as the dongle's (deploy/dongle-grub.cfg.tmpl) plus our marker line.
# $net is GRUB RUNTIME syntax: the heredoc delimiter is quoted so the shell expands NOTHING, then sed
# fills in the one build-time value.
sed "s|@@POLYPTIC_BASE_HOSTPORT@@|$hostport|g" > "$tmp_cfg" <<'EOF'
# polyptic-offload
# Polyptic boot dongle (POL-33/D47). TOKENLESS: carries only the control-plane address. The
# enrolment token is baked by the server into /boot/grub.cfg at chain time. Secure Boot stays ON.
set net=(http,@@POLYPTIC_BASE_HOSTPORT@@)
echo "Polyptic: bringing the network up (DHCP on all NICs) ..."
net_dhcp
echo "Polyptic: chaining $net/boot/grub.cfg ..."
configfile $net/boot/grub.cfg
# Only reached when DHCP or the chain failed:
set timeout=10
set default=retry
menuentry "Retry (DHCP + chain again)" --id retry { net_dhcp ; configfile $net/boot/grub.cfg }
menuentry "Reboot" { reboot }
menuentry "Firmware setup" { fwsetup }
EOF

# Find the EXISTING ESP by GPT partition-type GUID (never create/format one).
esp_part=""
for p in $(lsblk -rno NAME,PARTTYPE | awk -v g="$ESP_GUID" 'tolower($2)==g {print $1}'); do
  esp_part="$p"; break
done
[ -n "$esp_part" ] || { echo "offload: no EFI System Partition found, aborting (nothing wiped)" >&2; exit 1; }
disk="/dev/$(lsblk -no PKNAME "/dev/$esp_part")"
partnum="$(cat "/sys/class/block/$esp_part/partition")"

mnt="$(mktemp -d)"
mount "/dev/$esp_part" "$mnt"

# grubnet's baked-in prefix is /grub ON THE DEVICE IT LOADED FROM; it will NOT read a config beside the
# binaries, so the stage-1 config must sit under the ESP's /grub. grubnet's memdisk bootstrap sources
# $prefix/$grubdir/grub.cfg BEFORE the plain $prefix/grub.cfg, so we write OUR config to that first-
# checked path: it wins even if a foreign $prefix/grub.cfg (or the buggy grub.cfg-amd64 branch) already
# sits on a repurposed ESP. The add-only rule extends to it: an existing file at OUR path without the
# marker belongs to someone else and is NEVER clobbered.
cfg_dst="$mnt/grub/$grubdir/grub.cfg"
if [ -f "$cfg_dst" ] && ! grep -q '^# polyptic-offload$' "$cfg_dst"; then
  echo "offload: $cfg_dst on /dev/$esp_part exists WITHOUT the '# polyptic-offload' marker; refusing to overwrite a foreign GRUB config, aborting (nothing changed)" >&2
  exit 1
fi

# Drop the pair into our own subdir, leaving everything else untouched. shim resolves its second stage
# BY NAME from ITS OWN directory, so shim + grub must land side by side.
install -D -m0644 "$tmp_shim" "$mnt/EFI/polyptic/shim$efiarch.efi"
install -D -m0644 "$tmp_grub" "$mnt/EFI/polyptic/grub$efiarch.efi"
install -D -m0644 "$tmp_cfg"  "$cfg_dst"
umount "$mnt"; rmdir "$mnt"; mnt=""

# Add a UEFI boot entry pointing at shim (backslash-separated ESP-relative path). Add-only.
if ! efibootmgr | grep -q "Polyptic Netboot"; then
  efibootmgr -c -d "$disk" -p "$partnum" -L "Polyptic Netboot" -l "\\EFI\\polyptic\\shim$efiarch.efi"
fi

mkdir -p "$(dirname "$STAMP")"; : > "$STAMP"
echo "offload: installed \\EFI\\polyptic\\shim$efiarch.efi (+ grub$efiarch.efi, /grub/$grubdir/grub.cfg) on $disk part $partnum + added UEFI entry, pull the USB."
exit 0
