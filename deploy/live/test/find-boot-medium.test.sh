#!/usr/bin/env sh
# Pure-shell tests for find-boot-medium.sh — WHICH medium did this box actually boot from. Runs
# ANYWHERE (macOS/Linux/CI), no root, no real disks: mount/umount/blkid are stubs on PATH reading
# their behaviour out of $STUB (the install.test.sh pattern), and every path the script reads is an
# env-overridable fixture.
#
# THE BUG THIS PINS. An installed box and the USB stick both carry a FAT volume labeled POLYPTIC-BT
# with a `polyptic/medium-id` marker on it — deliberately, because after an install the ESP IS the
# boot medium. So on a box booted from the stick to be RE-installed, /dev/disk/by-label/POLYPTIC-BT
# is ambiguous: udev publishes one symlink, and answering "the internal ESP" made install-to-disk.sh
# refuse to install onto the very disk being re-imaged. The boot chain breaks the tie — the live
# device dmsquash-live mounted, the cmdline's live root spec, and the `disk-esp-` marker stamp that
# only an installed box's own ESP wears.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

# ─── Stubs: mount binds <dev> to its $STUB/vol-<name> fixture, blkid lists the vfat devices ─────────
BIN="$ROOT/bin"; mkdir -p "$BIN"
cat > "$BIN/mount" <<'EOF'
#!/bin/sh
dev=""; dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift ;;
    -*) ;;
    *) if [ -z "$dev" ]; then dev="$1"; else dir="$1"; fi ;;
  esac
  shift
done
src="$STUB/vol-$(basename "$dev")"
[ -d "$src" ] || exit 32
rmdir "$dir" 2>/dev/null || true
ln -s "$src" "$dir"
exit 0
EOF
cat > "$BIN/umount" <<'EOF'
#!/bin/sh
rm -f "$1" 2>/dev/null; mkdir -p "$1" 2>/dev/null; exit 0
EOF
cat > "$BIN/blkid" <<'EOF'
#!/bin/sh
cat "$STUB/vfat_devs" 2>/dev/null
exit 0
EOF
chmod +x "$BIN"/*

# ─── Fixture builder ────────────────────────────────────────────────────────────────────────────────
# A box with an INSTALLED disk (/dev/sdb: ESP sdb1 stamped `disk-esp-…`, slot A sdb2) and the
# universal USB stick in the front panel (/dev/sda1, stamped `medium-…`). Both volumes are labeled
# POLYPTIC-BT; the by-label symlink deliberately points at the INTERNAL ESP — the wrong answer udev
# is free to publish, which is the whole failure.
new_case() {
  d="$ROOT/$1"
  mkdir -p "$d/dev" "$d/by-label" "$d/mnt" \
           "$d/sysblock/sda" "$d/sysblock/sda1" "$d/sysblock/sdb" "$d/sysblock/sdb1" "$d/sysblock/sdb2"
  # sysfs nests a partition under its disk and marks it with a `partition` file.
  mkdir -p "$d/sysblock/sda/sda1" "$d/sysblock/sdb/sdb1" "$d/sysblock/sdb/sdb2"
  rmdir "$d/sysblock/sda1" "$d/sysblock/sdb1" "$d/sysblock/sdb2"
  ln -s "sda/sda1" "$d/sysblock/sda1"
  ln -s "sdb/sdb1" "$d/sysblock/sdb1"
  ln -s "sdb/sdb2" "$d/sysblock/sdb2"
  printf '1\n' > "$d/sysblock/sda/sda1/partition"
  printf '1\n' > "$d/sysblock/sdb/sdb1/partition"
  printf '2\n' > "$d/sysblock/sdb/sdb2/partition"
  : > "$d/dev/sda"; : > "$d/dev/sda1"; : > "$d/dev/sdb"; : > "$d/dev/sdb1"; : > "$d/dev/sdb2"
  ln -s "$d/dev/sdb1" "$d/by-label/POLYPTIC-BT"      # the ambiguous symlink, resolved the wrong way
  ln -s "$d/dev/sdb2" "$d/by-label/POLYPTIC-A"       # the installed box's slot A
  mkdir -p "$d/vol-sda1/polyptic" "$d/vol-sdb1/polyptic"
  printf 'medium-20260801T090000Z-ab12cd34\n' > "$d/vol-sda1/polyptic/medium-id"
  printf 'disk-esp-20260801T091500Z\n'        > "$d/vol-sdb1/polyptic/medium-id"
  printf '%s\n%s\n' "$d/dev/sdb1" "$d/dev/sda1" > "$d/vfat_devs"   # blkid's order: ESP first
  printf '' > "$d/mounts"
  printf '%s' "$d"
}

# The two cmdlines that matter. A box booted from the USB stick streams its root from the control
# plane (`root=live:http…`, polyptic.bootpath=local); an INSTALLED box boots its own slot A.
usb_cmdline() {
  printf 'BOOT_IMAGE=/vmlinuz root=live:http://depot.invalid/dist/image/amd64/builds/x/rootfs.squashfs polyptic.bootpath=local quiet splash\n' > "$1/cmdline"
}
disk_cmdline() {
  printf 'BOOT_IMAGE=/vmlinuz root=live:LABEL=POLYPTIC-A rd.live.overlay.reset=1 polyptic.bootpath=disk quiet splash\n' > "$1/cmdline"
}

find_medium() {
  d="$1"; shift
  STUB="$d" PATH="$BIN:$PATH" \
  POLYPTIC_BYLABEL_DIR="$d/by-label" POLYPTIC_CMDLINE_FILE="$d/cmdline" \
  POLYPTIC_MOUNTS_FILE="$d/mounts" POLYPTIC_SYS_BLOCK="$d/sysblock" \
  POLYPTIC_LIVE_DIR="/run/initramfs/live" \
    sh "$LIB/find-boot-medium.sh" "$@" 2>/dev/null
}
# The device node, reduced to its kernel name so the fixture's absolute paths stay out of the asserts.
name_of() { printf '%s' "${1##*/}"; }

# ─── 1) Booted from the USB stick, with an installed ESP present → the STICK wins ───────────────────
d="$(new_case usb-boot)"; usb_cmdline "$d"
out="$(find_medium "$d" "$d/mnt" ro)"; rc=$?
eq "usb boot: finds a medium"                       "0" "$rc"
eq "usb boot: the stick, not the installed ESP"     "sda1" "$(name_of "$out")"
eq "usb boot: the stick is left mounted for the caller" "medium-20260801T090000Z-ab12cd34" \
   "$(cat "$d/mnt/polyptic/medium-id" 2>/dev/null)"
eq "usb boot: no booted disk — nothing local booted this box" "1" \
   "$(find_medium "$d" --booted-disk >/dev/null 2>&1; printf '%s' "$?")"

# The same box with the stick's marker missing: the installed ESP is still not this boot's medium.
d="$(new_case usb-boot-unmarked)"; usb_cmdline "$d"; rm -f "$d/vol-sda1/polyptic/medium-id"
find_medium "$d" "$d/mnt" ro >/dev/null 2>&1
eq "usb boot, unmarked stick: no medium rather than the wrong one" "1" "$?"

# ─── 2) Booted from the DISK → the ESP wins (the installed contract) ────────────────────────────────
d="$(new_case disk-boot)"; disk_cmdline "$d"
out="$(find_medium "$d" "$d/mnt" ro)"; rc=$?
eq "disk boot: finds a medium"                      "0" "$rc"
eq "disk boot: the box's own ESP"                   "sdb1" "$(name_of "$out")"
eq "disk boot: names the disk it booted from"       "sdb" "$(find_medium "$d" --booted-disk)"

# dmsquash-live's live mount is the first signal, and it stands on its own: same box, a cmdline that
# names no live device.
d="$(new_case disk-boot-live-mount)"
printf 'BOOT_IMAGE=/vmlinuz quiet splash\n' > "$d/cmdline"
printf '%s /run/initramfs/live ext4 ro 0 0\n' "/dev/sdb2" > "$d/mounts"
eq "live mount alone names the booted disk"         "sdb" "$(find_medium "$d" --booted-disk)"
eq "live mount alone finds that disk's ESP"         "sdb1" "$(name_of "$(find_medium "$d" "$d/mnt" ro)")"

# ─── 3) No medium at all → exit 1, cleanly (a wired box on the lean dongle) ─────────────────────────
d="$(new_case no-medium)"; usb_cmdline "$d"
rm -rf "$d/vol-sda1" "$d/vol-sdb1"; rm -f "$d/by-label/POLYPTIC-BT"; : > "$d/vfat_devs"
out="$(find_medium "$d" "$d/mnt" ro)"; rc=$?
eq "no medium: exits 1"                             "1" "$rc"
eq "no medium: prints nothing"                      "" "$out"
eq "no medium: no booted disk either"               "1" \
   "$(find_medium "$d" --booted-disk >/dev/null 2>&1; printf '%s' "$?")"

# ─── 4) A stick alone, on a box with no install, is still found by the label fast path ──────────────
d="$(new_case stick-only)"; usb_cmdline "$d"
rm -rf "$d/vol-sdb1"; rm -f "$d/by-label/POLYPTIC-BT"; ln -s "$d/dev/sda1" "$d/by-label/POLYPTIC-BT"
printf '%s\n' "$d/dev/sda1" > "$d/vfat_devs"
eq "stick only: found"                              "sda1" "$(name_of "$(find_medium "$d" "$d/mnt" ro)")"

# ─── 5) A fielded OFFLOADED ESP (`medium-esp-…`) keeps working — only `disk-esp-` is conditional ────
d="$(new_case offloaded-esp)"; usb_cmdline "$d"
rm -rf "$d/vol-sda1"
printf 'medium-esp-20260701T120000Z\n' > "$d/vol-sdb1/polyptic/medium-id"
printf '%s\n' "$d/dev/sdb1" > "$d/vfat_devs"
eq "offloaded ESP: still the boot medium"           "sdb1" "$(name_of "$(find_medium "$d" "$d/mnt" ro)")"

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'ALL PASS\n'; exit 0; fi
printf '%d FAILED\n' "$fails"; exit 1
