#!/bin/sh
# Locate + mount the medium THIS BOX BOOTED FROM → its device node on stdout (POL-63). The medium is
# wherever the LOCAL boot payload lives: the universal USB stick (FAT32 labeled POLYPTIC-BT) or, on
# an installed box, its own ESP — which install-to-disk.sh labels POLYPTIC-BT too, because after an
# install the ESP IS the boot medium. Identity is proven by CONTENT (`polyptic/medium-id`) and by the
# RUNNING BOOT CHAIN, never by label alone. Used by four callers with one contract: the initrd Wi-Fi
# hook (read wifi.conf before the network exists), the rootfs polyptic-wifi.service (same file,
# Linux-world handoff), update-poll.sh (write refreshed boot files into the inactive slot) and
# install-to-disk.sh (the never-wipe-the-disk-you-booted-from guard, plus the wifi/certs/theme copy).
#
#   usage: find-boot-medium.sh <mountpoint> [ro|rw]      (default ro)
#          find-boot-medium.sh --booted-disk             (see below)
#
# Prints the device node and leaves it mounted at <mountpoint> on success (the CALLER owns the
# unmount); prints nothing and exits 1 when no medium is present — a fine state, wired boxes on the
# lean dongle have none.
#
# WHY THE BOOT CHAIN AND NOT THE LABEL. On a box that already has an install and is booted from the
# USB stick to be re-installed, BOTH volumes are labeled POLYPTIC-BT and BOTH carry a marker, so
# /dev/disk/by-label/POLYPTIC-BT is ambiguous — udev publishes one symlink and which volume wins is
# not deterministic. Answering "the internal ESP" there had install-to-disk.sh refuse to install onto
# the very disk the operator was re-imaging. So the booted medium is identified like this:
#
#   1. THE LIVE DEVICE. dmsquash-live mounts the live medium at /run/initramfs/live, and the kernel
#      cmdline carries the live root spec (`root=live:LABEL=…` / `root=live:CDLABEL=…`). Either one
#      names a device; the disk that device sits on is the disk this box booted. Candidates on THAT
#      disk are probed first — which is exactly how an installed box still finds its own ESP.
#   2. AN INSTALLED ESP IS ONLY EVER THE BOOT MEDIUM OF THE BOX THAT BOOTED IT. install-to-disk.sh
#      stamps its marker `disk-esp-…` (the USB stick's is `medium-…`, a fielded offloaded ESP's
#      `medium-esp-…`), so a `disk-esp-` marker is accepted only on a boot that came from that disk —
#      `polyptic.bootpath=disk`, or a live device on the same disk. A box booted from the stick or
#      from the network therefore walks straight past the internal ESP to its real medium.
#   3. Otherwise the old probe order stands: the by-label fast path, then every vfat filesystem blkid
#      can see. A filesystem without the marker is unmounted and skipped, never trusted — a foreign
#      stick that happens to be labeled POLYPTIC-BT identifies nothing.
#
# `--booted-disk` prints the kernel name (`sda`, `nvme0n1`) of the disk the boot chain came from, or
# exits 1 when that cannot be determined (a netboot streams its root, so no local disk booted it).
# install-to-disk.sh asks this directly: "never wipe the disk this box booted from" is a question
# about the boot chain, not about which volume answered the label.
#
# POSIX sh, and no tool the initramfs does not carry (POL-78's law: 51polyptic-wifi/module-setup.sh
# installs mount/umount/blkid/readlink and nothing more exotic — no lsblk, no awk).
#
# Stubbable for the off-box tests (find-boot-medium.test.sh): mount/umount/blkid/readlink come from
# PATH; POLYPTIC_BYLABEL_DIR, POLYPTIC_CMDLINE_FILE, POLYPTIC_MOUNTS_FILE, POLYPTIC_SYS_BLOCK and
# POLYPTIC_LIVE_DIR name the rest.

BYLABEL="${POLYPTIC_BYLABEL_DIR:-/dev/disk/by-label}"
LABEL="${POLYPTIC_MEDIUM_LABEL:-POLYPTIC-BT}"   # FAT volume labels max out at 11 chars
MARKER="polyptic/medium-id"
CMDLINE_FILE="${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}"
MOUNTS_FILE="${POLYPTIC_MOUNTS_FILE:-/proc/mounts}"
SYS_BLOCK="${POLYPTIC_SYS_BLOCK:-/sys/class/block}"
LIVE_DIR="${POLYPTIC_LIVE_DIR:-/run/initramfs/live}"

# Read one namespaced key off the kernel cmdline (first occurrence wins, never eval'd).
cmdline_value() {
  [ -r "$CMDLINE_FILE" ] || return 0
  IFS= read -r _line < "$CMDLINE_FILE" || _line=""
  for _tok in $_line; do            # intentional unquoted split on IFS whitespace
    case "$_tok" in
      "$1"=*) printf '%s' "${_tok#"$1"=}"; return 0 ;;
    esac
  done
  return 0
}

# The device carrying filesystem label <1>, resolved through the by-label dir. `-L` as well as `-e`:
# a by-label link is worth following even when the node behind it has not settled yet.
by_label() {
  [ -n "${1:-}" ] || return 1
  [ -e "$BYLABEL/$1" ] || [ -L "$BYLABEL/$1" ] || return 1
  _l="$(readlink -f "$BYLABEL/$1" 2>/dev/null | head -n1)"
  [ -n "$_l" ] || _l="$BYLABEL/$1"
  printf '%s\n' "$_l"
}

# The DISK a device sits on, by kernel name. sysfs marks a partition with a `partition` file and
# nests it under its disk (/sys/class/block/sda1 → …/block/sda/sda1), so the parent directory's name
# is the answer; a whole disk is its own answer.
disk_of() {
  _n="${1:-}"; _n="${_n##*/}"
  [ -n "$_n" ] || return 1
  [ -e "$SYS_BLOCK/$_n/partition" ] || { printf '%s\n' "$_n"; return 0; }
  _p="$(readlink -f "$SYS_BLOCK/$_n" 2>/dev/null || true)"
  _p="${_p%/*}"; _p="${_p##*/}"
  [ -n "$_p" ] && [ "$_p" != "$_n" ] && [ -e "$SYS_BLOCK/$_p" ] || return 1
  printf '%s\n' "$_p"
}

# The live medium this boot came from: what dmsquash-live left mounted, else the cmdline's root spec.
live_device() {
  if [ -r "$MOUNTS_FILE" ]; then
    while read -r _dev _mp _rest; do
      [ "$_mp" = "$LIVE_DIR" ] || continue
      case "$_dev" in /dev/*) printf '%s\n' "$_dev"; return 0 ;; esac
    done < "$MOUNTS_FILE"
  fi
  _root="$(cmdline_value root)"
  case "$_root" in
    live:LABEL=*)   by_label "${_root#live:LABEL=}"   && return 0 ;;
    live:CDLABEL=*) by_label "${_root#live:CDLABEL=}" && return 0 ;;
  esac
  return 1
}

booted_dev="$(live_device 2>/dev/null || true)"
booted_disk=""
[ -z "$booted_dev" ] || booted_disk="$(disk_of "$booted_dev" 2>/dev/null || true)"
# An installed box says so on its own cmdline (render-disk-grub.sh bakes it), which keeps the
# installed contract standing even on a box whose live device cannot be resolved.
diskboot=0
[ "$(cmdline_value polyptic.bootpath)" != "disk" ] || diskboot=1
[ -z "$booted_disk" ] || diskboot=1

if [ "${1:-}" = "--booted-disk" ]; then
  [ -n "$booted_disk" ] || exit 1
  printf '%s\n' "$booted_disk"
  exit 0
fi

MNT="${1:?usage: find-boot-medium.sh <mountpoint> [ro|rw]  |  find-boot-medium.sh --booted-disk}"
MODE="${2:-ro}"

mkdir -p "$MNT" 2>/dev/null || exit 1

# Is this marker's medium the one that booted THIS box? Only the installed-ESP stamp is conditional:
# every other marker belongs to a medium the box can only be reading because it is plugged in here.
belongs_to_this_boot() { # <dev> <marker contents>
  case "${2:-}" in
    disk-esp-*)
      [ "$diskboot" = 1 ] || return 1
      [ -z "$booted_disk" ] || [ "$(disk_of "$1" 2>/dev/null || true)" = "$booted_disk" ] || return 1
      ;;
  esac
  return 0
}

# Mount one candidate and keep it ONLY if it carries a marker that belongs to this boot.
try() {
  mount -o "$MODE" "$1" "$MNT" 2>/dev/null || return 1
  if [ -f "$MNT/$MARKER" ]; then
    # `|| true`: a marker written without a trailing newline still leaves its text in $_id.
    _id=""
    IFS= read -r _id < "$MNT/$MARKER" 2>/dev/null || true
    if belongs_to_this_boot "$1" "$_id"; then printf '%s\n' "$1"; return 0; fi
  fi
  umount "$MNT" 2>/dev/null || true
  return 1
}

# The candidates, in the old probe order: the by-label fast path, then every vfat filesystem.
candidates=""
add_candidate() {
  case " $candidates " in *" $1 "*) return 0 ;; esac
  candidates="$candidates $1"
}
lab="$(by_label "$LABEL" 2>/dev/null || true)"
[ -z "$lab" ] || add_candidate "$lab"
for dev in $(blkid -o device -t TYPE=vfat 2>/dev/null); do add_candidate "$dev"; done

# The disk this box booted from goes first: on an installed box that is its own ESP, and on a box
# booted from the stick it excludes the ESP of the install being replaced.
if [ -n "$booted_disk" ]; then
  for dev in $candidates; do
    [ "$(disk_of "$dev" 2>/dev/null || true)" = "$booted_disk" ] || continue
    try "$dev" && exit 0
  done
fi
for dev in $candidates; do
  try "$dev" && exit 0
done
exit 1
