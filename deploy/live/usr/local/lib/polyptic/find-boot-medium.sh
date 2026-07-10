#!/bin/sh
# Locate + mount the Polyptic boot medium → its device node on stdout (POL-63). The medium is wherever
# the LOCAL boot payload lives: the universal USB stick (FAT32 labeled POLYPTIC-BOOT) or, after an
# offload, the box's own ESP — whose label is the firmware's business, not ours, so identity is proven
# by CONTENT: the `polyptic/medium-id` marker file, never by label alone. Used by three callers with
# one contract: the initrd Wi-Fi hook (read wifi.conf before the network exists), the rootfs
# polyptic-wifi.service (same file, Linux-world handoff), and update-poll.sh (write refreshed boot
# files into the inactive slot).
#
#   usage: find-boot-medium.sh <mountpoint> [ro|rw]      (default ro)
#
# Prints the device node and leaves it mounted at <mountpoint> on success (the CALLER owns the
# unmount); prints nothing and exits 1 when no medium is present — a fine state, wired boxes on the
# lean dongle have none. Probe order: the by-label fast path, then every vfat filesystem blkid can
# see (the offloaded-ESP case). A filesystem without the marker is unmounted and skipped, never
# trusted — a foreign stick that happens to be labeled POLYPTIC-BOOT identifies nothing.
#
# Stubbable for the off-box tests (offload.test.sh pattern): mount/umount/blkid/readlink come from
# PATH; the by-label directory is POLYPTIC_BYLABEL_DIR.

MNT="${1:?usage: find-boot-medium.sh <mountpoint> [ro|rw]}"
MODE="${2:-ro}"
BYLABEL="${POLYPTIC_BYLABEL_DIR:-/dev/disk/by-label}"
LABEL="${POLYPTIC_MEDIUM_LABEL:-POLYPTIC-BT}"   # FAT volume labels max out at 11 chars
MARKER="polyptic/medium-id"

mkdir -p "$MNT" 2>/dev/null || exit 1

# Mount one candidate and keep it ONLY if it carries the marker.
try() {
  mount -o "$MODE" "$1" "$MNT" 2>/dev/null || return 1
  if [ -f "$MNT/$MARKER" ]; then printf '%s\n' "$1"; return 0; fi
  umount "$MNT" 2>/dev/null || true
  return 1
}

if [ -e "$BYLABEL/$LABEL" ]; then
  dev="$(readlink -f "$BYLABEL/$LABEL" 2>/dev/null || printf '%s' "$BYLABEL/$LABEL")"
  try "$dev" && exit 0
fi

for dev in $(blkid -o device -t TYPE=vfat 2>/dev/null); do
  try "$dev" && exit 0
done
exit 1
