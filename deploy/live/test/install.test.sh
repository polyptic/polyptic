#!/usr/bin/env sh
# Pure-shell tests for install-to-disk (POL-176). Runs ANYWHERE (macOS/Linux/CI), no root, no real
# disks: every external command install-to-disk.sh touches — sgdisk, wipefs, mkfs.*, mkswap,
# partprobe, udevadm, efibootmgr, curl, lsblk, mount, umount, blkid — is a stub on PATH that reads
# its scripted behaviour out of $STUB, and every path it reads is an env-overridable fixture
# (the offload.test.sh pattern, carried over with the offload's retirement).
#
# What this pins: a WIPE may only ever hit the disk the operator named, and only after every
# refusal (bad target, removable, too small, the booted medium, mounted, unreachable depot) has had
# its chance — with "nothing was erased" PROVEN by an empty sgdisk log, not claimed. The POL-58
# verify-don't-assume law survives POL-178 amended: the entry is still re-read from NVRAM, but
# firmware that refuses/drops it now WARNS (`installed-no-nvram-entry`, done|100) instead of
# failing — the unconditional EFI/BOOT fallback loader keeps the disk bootable without an entry.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "contains: $2" "$3" ;; esac; }
hasnt() { case "$3" in *"$2"*) bad "$1" "must NOT contain: $2" "(present)" ;; *) ok "$1" ;; esac; }

# ─── The stub environment ───────────────────────────────────────────────────────────────────────────
BIN="$ROOT/bin"; mkdir -p "$BIN"

cat > "$BIN/uname" <<'EOF'
#!/bin/sh
[ "${1:-}" = "-m" ] && { printf '%s\n' "${STUB_ARCH:-x86_64}"; exit 0; }
exit 0
EOF

# sgdisk: append every invocation to the log (an empty log IS the "nothing was erased" proof); a
# partitioning call (-n) creates the five partition device nodes under the fake /dev.
cat > "$BIN/sgdisk" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB/sgdisk.log"
printf 'sgdisk\n' >> "$STUB/order.log"
[ -f "$STUB/sgdisk_fails" ] && exit 1
case "$*" in
  *" -n "*|*"-n "*)
    for a in "$@"; do dev="$a"; done
    name="${dev##*/}"
    case "$name" in *[0-9]) sep=p ;; *) sep= ;; esac
    i=1; while [ "$i" -le 5 ]; do : > "$STUB/dev/$name$sep$i"; i=$((i+1)); done
    ;;
esac
exit 0
EOF
printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$STUB/wipefs.log"\nprintf "wipefs\\n" >> "$STUB/order.log"\nexit 0\n' > "$BIN/wipefs"
printf '#!/bin/sh\nexit 0\n' > "$BIN/partprobe"
printf '#!/bin/sh\nexit 0\n' > "$BIN/udevadm"
printf '#!/bin/sh\nexit 0\n' > "$BIN/sync"
printf '#!/bin/sh\nexit 0\n' > "$BIN/sleep"
printf '#!/bin/sh\nexit 1\n' > "$BIN/mountpoint"     # never "already mounted"
# POL-194 — the three commands that take the swap partition back. Each logs its call so the tests can
# pin BOTH that it ran and that it ran before the wipe; none of them has to exist on a real box (the
# installer calls them best-effort), which is exactly why the log is the only proof available.
# Each also stamps a shared order.log, because WHEN the release runs is the entire fix: doing it
# after the wipe would still abort a disk that had already been erased.
for t in cryptsetup systemctl; do
  printf '#!/bin/sh\nprintf "%%s\\n" "$*" >> "$STUB/%s.log"\nprintf "%s\\n" >> "$STUB/order.log"\nexit 0\n' "$t" "$t" > "$BIN/$t"
done
# swapoff also DEACTIVATES: it drops the device from the swaps fixture, as the real one drops it from
# /proc/swaps. Without that the installer would re-read a device it had just released and refuse.
cat > "$BIN/swapoff" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB/swapoff.log"
printf 'swapoff\n' >> "$STUB/order.log"
[ -f "$STUB/swapoff_fails" ] && exit 1
for a in "$@"; do dev="$a"; done
if [ -f "$STUB/swaps" ]; then
  grep -v "^$dev " "$STUB/swaps" > "$STUB/swaps.tmp" 2>/dev/null || true
  mv "$STUB/swaps.tmp" "$STUB/swaps"
fi
exit 0
EOF

# mkfs stubs: log the call and create the volume fixture the mount stub binds for that node.
mkfs_stub() {
  cat > "$BIN/$1" <<'EOF'
#!/bin/sh
printf 'CMD %s\n' "$*" >> "$STUB/mkfs.log"
printf 'mkfs\n' >> "$STUB/order.log"
for a in "$@"; do dev="$a"; done
mkdir -p "$STUB/vol-$(basename "$dev")"
exit 0
EOF
  chmod +x "$BIN/$1"
}
mkfs_stub mkfs.vfat
mkfs_stub mkfs.ext4
mkfs_stub mkswap

# efibootmgr: offload.test.sh's stub, verbatim — $STUB/nvram is the store; knobs:
# nvram_readonly (writes refused), nvram_amnesia (accepted then dropped), nvram_sticky_order
# (entry kept, order refused — the POL-58 firmware), nvram_appends (appends instead of prepending).
cat > "$BIN/efibootmgr" <<'EOF'
#!/bin/sh
[ -f "$STUB/nvram_unreadable" ] && exit 1
create=""; del=""; order=""; label=""
while [ $# -gt 0 ]; do
  case "$1" in
    -q|-v) ;;
    -c) create=1 ;;
    -B) del=1 ;;
    -b) shift; target="$1" ;;
    -o) shift; order="$1" ;;
    -L) shift; label="$1" ;;
    -d|-p|-l) shift ;;
  esac
  shift
done
if [ -n "$create$del$order" ] && [ -f "$STUB/nvram_readonly" ]; then exit 1; fi
if [ -n "$create$del$order" ] && [ -f "$STUB/nvram_amnesia" ]; then exit 0; fi
if [ -n "$del" ]; then
  cur="$(sed -n 's/^BootOrder: //p' "$STUB/nvram")"
  new="$(printf '%s' "$cur" | tr ',' '\n' | grep -v "^$target\$" | tr '\n' ',' | sed 's/,$//')"
  grep -v "^Boot$target" "$STUB/nvram" | grep -v '^BootOrder:' > "$STUB/nvram.tmp" || true
  printf 'BootOrder: %s\n' "$new" >> "$STUB/nvram.tmp"
  mv "$STUB/nvram.tmp" "$STUB/nvram"
elif [ -n "$create" ]; then
  n=0
  while grep -q "^Boot$(printf '%04X' $n)" "$STUB/nvram" 2>/dev/null; do n=$((n+1)); done
  num="$(printf '%04X' $n)"
  cur="$(sed -n 's/^BootOrder: //p' "$STUB/nvram")"
  grep -v '^BootOrder:' "$STUB/nvram" > "$STUB/nvram.tmp" || true
  printf 'Boot%s* %s\n' "$num" "$label" >> "$STUB/nvram.tmp"
  if [ -f "$STUB/nvram_appends" ]; then printf 'BootOrder: %s%s\n' "${cur:+$cur,}" "$num" >> "$STUB/nvram.tmp"
  else printf 'BootOrder: %s%s\n' "$num" "${cur:+,$cur}" >> "$STUB/nvram.tmp"; fi
  mv "$STUB/nvram.tmp" "$STUB/nvram"
elif [ -n "$order" ]; then
  if [ ! -f "$STUB/nvram_sticky_order" ]; then
    grep -v '^BootOrder:' "$STUB/nvram" > "$STUB/nvram.tmp" || true
    printf 'BootOrder: %s\n' "$order" >> "$STUB/nvram.tmp"
    mv "$STUB/nvram.tmp" "$STUB/nvram"
  fi
else
  cat "$STUB/nvram"
fi
exit 0
EOF

# curl: the depot. GETs serve the fixture files; POSTs land in $STUB/posts; knobs: curl_fails (+
# curl_exit, curl_http_code) fail every GET — the depot-unreachable pre-flight case.
cat > "$BIN/curl" <<'EOF'
#!/bin/sh
out=""; url=""; post=""; body=""; auth=""; wantw=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -X) shift; [ "$1" = POST ] && post=1 ;;
    --data-binary) shift; body="$1" ;;
    -H) shift; case "$1" in Authorization:*) auth="$1" ;; esac ;;
    -w) shift; wantw=1 ;;
    -m|--retry|--retry-delay|--connect-timeout) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
if [ -n "$post" ]; then printf '%s\t%s\t%s\n' "$url" "$auth" "$body" >> "$STUB/posts"; exit 0; fi
if [ -f "$STUB/curl_fails" ]; then
  if [ -n "$wantw" ] && [ -f "$STUB/curl_http_code" ]; then cat "$STUB/curl_http_code"; exit 0; fi
  exit "$(cat "$STUB/curl_exit" 2>/dev/null || echo 22)"
fi
printf '%s\n' "$url" >> "$STUB/curl.log"
case "$url" in
  */manifest.json|*/manifest.json\?*) cat "$STUB/manifest" 2>/dev/null || exit 22 ;;
  */dist/boot/shim*.efi) [ -n "$out" ] && printf 'SIGNED-SHIM\n' > "$out" ;;
  */dist/boot/grub*.efi) [ -n "$out" ] && printf 'SIGNED-GRUB\n' > "$out" ;;
  */builds/*/vmlinuz)         cp "$STUB/new-vmlinuz"  "$out" ;;
  */builds/*/initrd)          cp "$STUB/new-initrd"   "$out" ;;
  */builds/*/SHA256SUMS)      cp "$STUB/new-sums"     "$out" ;;
  */builds/*/rootfs.squashfs) cp "$STUB/new-squashfs" "$out" ;;
  *) exit 22 ;;
esac
exit 0
EOF

# lsblk: `-no PKNAME <dev>` from $STUB/blockdevs, lines of "<part> <disk>".
cat > "$BIN/lsblk" <<'EOF'
#!/bin/sh
for a in "$@"; do dev="$a"; done
dev="${dev##*/}"
case "$*" in
  *PKNAME*) awk -v d="$dev" '$1==d {print $2}' "$STUB/blockdevs" 2>/dev/null; exit 0 ;;
esac
exit 0
EOF

# mount/umount/blkid: find-boot-medium's + the installer's world. `mount <dev> <dir>` replaces
# <dir> with a symlink to $STUB/vol-<basename(dev)> (created by the mkfs stubs / the fixtures), so
# writes persist into the fixture; a device with no fixture fails to mount.
cat > "$BIN/mount" <<'EOF'
#!/bin/sh
case "${1:-}" in -t) exit 0 ;; esac
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
[ -f "$STUB/mount_fails_$(basename "$dev")" ] && exit 32   # knob: this device refuses to mount
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

shahex() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

# ─── Fixture builder ────────────────────────────────────────────────────────────────────────────────
# new_case <name> → a netbooted amd64 box with a 64 GiB internal /dev/sdb target, a booted USB
# medium on /dev/sda1 (marker + wifi.conf + a complete theme), a depot serving image new-1, and a
# firmware that already carries an old `Polyptic Netboot` entry (the offloaded-fleet reality).
new_case() {
  d="$ROOT/$1"
  mkdir -p "$d/dev" "$d/efi/efivars" "$d/run/requests" "$d/by-label" \
           "$d/sysblock/sdb" "$d/sysblock/sda/sda1"
  : > "$d/dev/sdb"; : > "$d/dev/sda"; : > "$d/dev/sda1"
  printf '0\n' > "$d/sysblock/sdb/removable"
  printf '134217728\n' > "$d/sysblock/sdb/size"      # 64 GiB in 512-byte sectors
  printf '0\n' > "$d/sysblock/sda/removable"
  printf '134217728\n' > "$d/sysblock/sda/size"
  # sysfs nests a partition under its disk and marks it with a `partition` file — how
  # find-boot-medium.sh answers "which disk is this device on" with no lsblk in the initramfs.
  printf '1\n' > "$d/sysblock/sda/sda1/partition"
  ln -s "sda/sda1" "$d/sysblock/sda1"
  printf 'BOOT_IMAGE=/vmlinuz root=live:http://10.0.0.10/dist/image/amd64/rootfs.squashfs polyptic.base=http://10.0.0.10 polyptic.token=secret-fleet-token quiet splash\n' > "$d/cmdline"
  printf 'device=/dev/sdb\n' > "$d/run/requests/install"
  printf 'sda1 sda\n' > "$d/blockdevs"
  printf '' > "$d/mounts"
  printf 'Filename\t\t\t\tType\t\tSize\tUsed\tPriority\n' > "$d/swaps"
  printf 'Boot0000* ubuntu\nBoot0001* Polyptic Netboot\nBootOrder: 0001,0000\n' > "$d/nvram"
  printf '{"imageId":"new-1","urgent":false}\n' > "$d/manifest"
  printf 'FAKE-KERNEL\n' > "$d/new-vmlinuz"
  printf 'FAKE-LEAN-INITRD\n' > "$d/new-initrd"
  printf 'FAKE-SQUASHFS\n' > "$d/new-squashfs"
  { printf '%s  vmlinuz\n' "$(shahex "$d/new-vmlinuz")"
    printf '%s  initrd\n' "$(shahex "$d/new-initrd")"
    printf '%s  rootfs.squashfs\n' "$(shahex "$d/new-squashfs")"; } > "$d/new-sums"
  # The booted medium (find-boot-medium proves identity by content).
  m="$d/vol-sda1"; mkdir -p "$m/polyptic/boot/theme" "$m/polyptic/certs"
  printf 'medium-2026\n' > "$m/polyptic/medium-id"
  printf 'WIFI_SSID=SiteNet\nWIFI_PSK=hunter2hunter2\n' > "$m/polyptic/wifi.conf"
  printf 'PEM\n' > "$m/polyptic/certs/ca.pem"
  printf 'THEME\n' > "$m/polyptic/boot/theme/theme.txt"
  printf 'LOGO\n'  > "$m/polyptic/boot/theme/logo.png"
  printf 'BG\n'    > "$m/polyptic/boot/theme/bg.png"
  printf '/dev/sda1\n' > "$d/vfat_devs"
  printf '%s' "$d"
}

install() {
  d="$1"
  STUB="$d" PATH="$BIN:$PATH" \
  POLYPTIC_CMDLINE_FILE="$d/cmdline" POLYPTIC_EFI_DIR="$d/efi" POLYPTIC_SYS_BLOCK="$d/sysblock" \
  POLYPTIC_RUN_DIR="$d/run" POLYPTIC_DEV_DIR="$d/dev" POLYPTIC_MOUNTS_FILE="$d/mounts" \
  POLYPTIC_SWAPS_FILE="$d/swaps" \
  POLYPTIC_INSTALL_REQUEST="$d/run/requests/install" POLYPTIC_INSTALL_STATUS="$d/run/install-status" \
  POLYPTIC_LIB_DIR="$LIB" POLYPTIC_CONSOLE="$d/console" POLYPTIC_BYLABEL_DIR="$d/by-label" \
  POLYPTIC_NET_WAIT_SECONDS=0 POLYPTIC_NET_STEP_SECONDS=0 POLYPTIC_NODE_WAIT_TRIES=1 \
  STUB_ARCH="${STUB_ARCH:-x86_64}" \
    sh "$LIB/install-to-disk.sh" 2>&1
  printf 'exit=%s\n' "$?"
}
exit_of()  { printf '%s' "$1" | sed -n 's/^exit=//p'; }
status_of(){ cat "$1/run/install-status" 2>/dev/null; }
last_status(){ status_of "$1" | tail -n1; }
fail_code(){ posted "$1" | tail -n1 | sed -n 's/.*"code":"\([^"]*\)".*/\1/p'; }
posted()   { cat "$1/posts" 2>/dev/null; }
wiped()    { [ -s "$1/sgdisk.log" ] && echo yes || echo no; }

# ─── 1) The happy path ──────────────────────────────────────────────────────────────────────────────
d="$(new_case happy)"; out="$(install "$d")"
eq  "happy: exits 0"                       "0" "$(exit_of "$out")"
eq  "happy: request deleted"               "no" "$([ -f "$d/run/requests/install" ] && echo yes || echo no)"
has "happy: wiped exactly the named disk"  "--zap-all /dev/sdb" "$(cat "$d/sgdisk.log")"
has "happy: five partitions, our labels"   "POLYPTIC-ESP" "$(cat "$d/sgdisk.log")"
has "happy: swap partlabel"                "POLYPTIC-SWAP" "$(cat "$d/sgdisk.log")"
has "happy: scratch takes the rest"        "-n 5:0:0" "$(cat "$d/sgdisk.log")"
has "happy: ESP is FAT32"                  "-F 32" "$(cat "$d/mkfs.log")"
has "happy: ESP labelled POLYPTIC-BT (find-boot-medium's fast path)" "-n POLYPTIC-BT" "$(cat "$d/mkfs.log")"
has "happy: slot A ext4 label"             "-L POLYPTIC-A" "$(cat "$d/mkfs.log")"
has "happy: slot B ext4 label"             "-L POLYPTIC-B" "$(cat "$d/mkfs.log")"
has "happy: scratch ext4 label (16 chars, the ext4 max)" "-L POLYPTIC-SCRATCH" "$(cat "$d/mkfs.log")"
eq  "happy: scratch seeded with dracut's persistent-overlay pair (POL-179)" "yes" "$([ -d "$d/vol-sdb5/overlayfs" ] && [ -d "$d/vol-sdb5/ovlwork" ] && echo yes || echo no)"
eq  "happy: squashfs committed at dmsquash-live's path" "FAKE-SQUASHFS" "$(cat "$d/vol-sdb2/LiveOS/squashfs.img" 2>/dev/null)"
eq  "happy: no .new left behind"           "no" "$([ -f "$d/vol-sdb2/LiveOS/squashfs.img.new" ] && echo yes || echo no)"
eq  "happy: kernel on the ESP, slot a"     "FAKE-KERNEL" "$(cat "$d/vol-sdb1/polyptic/boot/amd64/a/vmlinuz" 2>/dev/null)"
eq  "happy: LEAN initrd on the ESP"        "FAKE-LEAN-INITRD" "$(cat "$d/vol-sdb1/polyptic/boot/amd64/a/initrd" 2>/dev/null)"
eq  "happy: slot b dir waiting for update-poll" "yes" "$([ -d "$d/vol-sdb1/polyptic/boot/amd64/b" ] && echo yes || echo no)"
eq  "happy: shim in our subdir"            "SIGNED-SHIM" "$(cat "$d/vol-sdb1/EFI/polyptic/shimx64.efi" 2>/dev/null)"
eq  "happy: fallback pair claimed unconditionally" "SIGNED-SHIM" "$(cat "$d/vol-sdb1/EFI/BOOT/BOOTX64.EFI" 2>/dev/null)"
eq  "happy: fallback grub beside it"       "SIGNED-GRUB" "$(cat "$d/vol-sdb1/EFI/BOOT/grubx64.efi" 2>/dev/null)"
has "happy: disk cfg at the arch path"     "# polyptic-disk arch=amd64 slot=a image=new-1" "$(head -n1 "$d/vol-sdb1/grub/x86_64-efi/grub.cfg" 2>/dev/null)"
has "happy: plain cfg path too"            "# polyptic-disk" "$(head -n1 "$d/vol-sdb1/grub/grub.cfg" 2>/dev/null)"
has "happy: the ESP IS the medium now"     "disk-esp-" "$(cat "$d/vol-sdb1/polyptic/medium-id" 2>/dev/null)"
eq  "happy: wifi.conf travels"             "WIFI_SSID=SiteNet" "$(head -n1 "$d/vol-sdb1/polyptic/wifi.conf" 2>/dev/null)"
eq  "happy: certs travel"                  "PEM" "$(cat "$d/vol-sdb1/polyptic/certs/ca.pem" 2>/dev/null)"
eq  "happy: theme travels (complete set)"  "THEME" "$(cat "$d/vol-sdb1/polyptic/boot/theme/theme.txt" 2>/dev/null)"
eq  "happy: Polyptic leads BootOrder"      "0001,0000" "$(sed -n 's/^BootOrder: //p' "$d/nvram")"
has "happy: entry labelled Polyptic"       "Boot0001* Polyptic" "$(grep '^Boot0001' "$d/nvram")"
eq  "happy: old Netboot entry pruned"      "0" "$(grep -c 'Polyptic Netboot' "$d/nvram")"
has "happy: reported installed"            '"code":"installed"' "$(posted "$d")"
has "happy: report names netboot as the fallback" "recovery path" "$(posted "$d")"
has "happy: report carries the token"      "Authorization: Bearer secret-fleet-token" "$(posted "$d")"
has "happy: final progress line"           "done|100|" "$(last_status "$d")"
has "happy: progress narrated the phases"  "wiping|" "$(status_of "$d")"
has "happy: fetch phase present"           "fetching|" "$(status_of "$d")"
has "happy: verify phase present"          "verifying|" "$(status_of "$d")"
has "happy: loader phase present"          "writing-loader|" "$(status_of "$d")"
has "happy: boot-entry phase present"      "boot-entry|" "$(status_of "$d")"

# ─── 2) Refusals, each proven bloodless (empty sgdisk log) ──────────────────────────────────────────
d="$(new_case bad-target)"; printf 'device=/dev/sdz\n' > "$d/run/requests/install"
out="$(install "$d")"
eq  "bad target: fails"                    "1" "$(exit_of "$out")"
has "bad target: failed status"            "failed|-|" "$(last_status "$d")"
has "bad target: reported code"            '"code":"install-bad-target"' "$(posted "$d")"
eq  "bad target: nothing wiped"            "no" "$(wiped "$d")"
eq  "bad target: request still deleted"    "no" "$([ -f "$d/run/requests/install" ] && echo yes || echo no)"

d="$(new_case partition-target)"; printf 'device=/dev/sda1\n' > "$d/run/requests/install"
out="$(install "$d")"
eq  "partition target: fails"              "1" "$(exit_of "$out")"
has "partition target: names the rule"     "whole disk" "$out"
eq  "partition target: nothing wiped"      "no" "$(wiped "$d")"

d="$(new_case removable-target)"; printf '1\n' > "$d/sysblock/sdb/removable"
out="$(install "$d")"
eq  "removable: fails"                     "1" "$(exit_of "$out")"
has "removable: reported code"             '"code":"install-bad-target"' "$(posted "$d")"
eq  "removable: nothing wiped"             "no" "$(wiped "$d")"

d="$(new_case too-small)"; printf '16777216\n' > "$d/sysblock/sdb/size"   # 8 GiB
out="$(install "$d")"
eq  "too small: fails"                     "1" "$(exit_of "$out")"
has "too small: reported code"             '"code":"install-disk-too-small"' "$(posted "$d")"
has "too small: names the numbers"         "16 GiB" "$out"
eq  "too small: nothing wiped"             "no" "$(wiped "$d")"

# The disk carrying the medium this box BOOTED from is never a target.
d="$(new_case booted-medium)"; printf 'device=/dev/sda\n' > "$d/run/requests/install"
out="$(install "$d")"
eq  "booted medium: fails"                 "1" "$(exit_of "$out")"
has "booted medium: names why"             "boot medium" "$out"
has "booted medium: names the device taken to be the medium" "/dev/sda1" "$out"
eq  "booted medium: nothing wiped"         "no" "$(wiped "$d")"

# ─── 2b) RE-INSTALLING a box that already has an install ────────────────────────────────────────────
# Both volumes are labeled POLYPTIC-BT and both carry a marker — the ESP by design, since after an
# install the ESP IS the boot medium — so /dev/disk/by-label/POLYPTIC-BT is ambiguous and udev may
# publish either. The boot chain decides: this box booted the USB stick, so the internal disk is a
# legal target and the install must run.
installed_esp() { # <case dir> — an existing install on the target /dev/sdb, ESP at sdb1
  mkdir -p "$1/sysblock/sdb/sdb1" "$1/vol-sdb1/polyptic"
  : > "$1/dev/sdb1"
  printf '1\n' > "$1/sysblock/sdb/sdb1/partition"
  ln -s "sdb/sdb1" "$1/sysblock/sdb1"
  printf 'disk-esp-20260722T101500Z\n' > "$1/vol-sdb1/polyptic/medium-id"
  printf 'sdb1 sdb\n' >> "$1/blockdevs"
  printf '%s\n%s\n' "/dev/sdb1" "/dev/sda1" > "$1/vfat_devs"     # blkid's order: the ESP first
  ln -sf "$1/dev/sdb1" "$1/by-label/POLYPTIC-BT"                 # udev resolved the label wrongly
}

d="$(new_case reinstall-from-usb)"; installed_esp "$d"
out="$(install "$d")"
eq  "re-install from the stick: succeeds"  "0" "$(exit_of "$out")"
has "re-install from the stick: wiped the named disk" "--zap-all /dev/sdb" "$(cat "$d/sgdisk.log")"
has "re-install from the stick: reported installed" '"code":"installed"' "$(posted "$d")"
eq  "re-install from the stick: wifi.conf came off the STICK, not the old ESP" "WIFI_SSID=SiteNet" \
    "$(head -n1 "$d/vol-sdb1/polyptic/wifi.conf" 2>/dev/null)"

# The same two volumes, booted from the DISK: the ESP genuinely IS the boot medium, and a box cannot
# wipe the disk it is running from.
d="$(new_case reinstall-from-disk)"; installed_esp "$d"
mkdir -p "$d/sysblock/sdb/sdb2"; : > "$d/dev/sdb2"
printf '2\n' > "$d/sysblock/sdb/sdb2/partition"; ln -s "sdb/sdb2" "$d/sysblock/sdb2"
ln -sf "$d/dev/sdb2" "$d/by-label/POLYPTIC-A"
printf 'BOOT_IMAGE=/vmlinuz root=live:LABEL=POLYPTIC-A polyptic.base=http://10.0.0.10 polyptic.bootpath=disk quiet splash\n' > "$d/cmdline"
out="$(install "$d")"
eq  "installed box, same disk: fails"      "1" "$(exit_of "$out")"
has "installed box, same disk: names the condition" "the disk this box booted from" "$out"
has "installed box, same disk: names the remedy"    "Polyptic USB medium" "$out"
eq  "installed box, same disk: nothing wiped"       "no" "$(wiped "$d")"

d="$(new_case mounted-target)"
printf '/dev/sdb1 /mnt/data ext4 rw 0 0\n' > "$d/mounts"
out="$(install "$d")"
eq  "mounted: fails"                       "1" "$(exit_of "$out")"
has "mounted: names the fix"               "Unmount it" "$out"
eq  "mounted: nothing wiped"               "no" "$(wiped "$d")"

# ─── 3) The depot must answer BEFORE anything destructive ───────────────────────────────────────────
d="$(new_case depot-dead)"; : > "$d/curl_fails"; printf '6\n' > "$d/curl_exit"
out="$(install "$d")"
eq  "depot dead: fails"                    "1" "$(exit_of "$out")"
has "depot dead: honest code"              "depot-unreachable" "$out"
eq  "depot dead: nothing wiped"            "no" "$(wiped "$d")"

# ─── 4) A corrupted download FAILS the install — never a half-trusted image ─────────────────────────
# initrd tampered: caught before the wipe (small artifacts are fetched + verified first).
d="$(new_case sum-mismatch-early)"; printf 'TAMPERED\n' > "$d/new-initrd"
out="$(install "$d")"
eq  "early sum mismatch: fails"            "1" "$(exit_of "$out")"
has "early sum mismatch: reported code"    '"code":"install-write-failed"' "$(posted "$d")"
has "early sum mismatch: names the check"  "sha256" "$out"
eq  "early sum mismatch: nothing wiped"    "no" "$(wiped "$d")"

# squashfs tampered: caught after the wipe (it streams to disk), but the cfg/boot entry are never
# written — the disk holds no committed image and the firmware still boots what it booted before.
d="$(new_case sum-mismatch-squashfs)"; printf 'TAMPERED\n' > "$d/new-squashfs"
out="$(install "$d")"
eq  "squashfs mismatch: fails"             "1" "$(exit_of "$out")"
has "squashfs mismatch: failed status"     "failed|-|" "$(last_status "$d")"
eq  "squashfs mismatch: image not committed" "no" "$([ -f "$d/vol-sdb2/LiveOS/squashfs.img" ] && echo yes || echo no)"
eq  "squashfs mismatch: no Polyptic entry"  "0" "$(grep -c '^Boot[0-9A-F]* Polyptic$' "$d/nvram")"

# ─── 5) POL-178: post-write NVRAM misbehaviour WARNS, never fails — the disk is bootable anyway ─────
# The installer writes EFI/BOOT/BOOT<arch>.EFI unconditionally, so a firmware that will not keep the
# entry still boots the disk via the fallback path. The verify-don't-assume half of POL-58 survives:
# the entry is still re-read, the outcome is still reported — it just no longer blocks.

# Sticky order: the entry EXISTS on re-read (existence is all that is asserted now) → plain success.
d="$(new_case sticky-order)"; : > "$d/nvram_sticky_order"; : > "$d/nvram_appends"
out="$(install "$d")"
eq  "sticky order: succeeds (entry exists; order-first is no longer a gate)" "0" "$(exit_of "$out")"
has "sticky order: reported code"          '"code":"installed"' "$(posted "$d")"
has "sticky order: done status line"       "done|100|" "$(last_status "$d")"

# Amnesia (the field Dell): entry accepted then dropped → success WITH the warning code, and the
# detail names the fallback loader path and the manual firmware-setup remedy.
d="$(new_case amnesia)"; : > "$d/nvram_amnesia"
out="$(install "$d")"
eq  "amnesia: succeeds with a warning"     "0" "$(exit_of "$out")"
has "amnesia: reported code"               '"code":"installed-no-nvram-entry"' "$(posted "$d")"
has "amnesia: reported ok=true"            '"ok":true' "$(posted "$d")"
has "amnesia: done status line"            "done|100|" "$(last_status "$d")"
has "amnesia: names the fallback loader path" "EFI/BOOT/BOOTX64.EFI" "$(last_status "$d")"
has "amnesia: names the manual remedy"     "firmware setup" "$(last_status "$d")"
eq  "amnesia: image still committed"       "FAKE-SQUASHFS" "$(cat "$d/vol-sdb2/LiveOS/squashfs.img" 2>/dev/null)"
eq  "amnesia: fallback loader on the ESP"  "SIGNED-SHIM" "$(cat "$d/vol-sdb1/EFI/BOOT/BOOTX64.EFI" 2>/dev/null)"

# Read-only NVRAM: the create itself refused → the same warning, not a failure.
d="$(new_case nvram-readonly)"; : > "$d/nvram_readonly"
out="$(install "$d")"
eq  "readonly nvram: succeeds with a warning" "0" "$(exit_of "$out")"
has "readonly nvram: reported code"        '"code":"installed-no-nvram-entry"' "$(posted "$d")"
has "readonly nvram: done status line"     "done|100|" "$(last_status "$d")"

# But a WRITE failure that genuinely blocks booting still hard-fails: the warning posture is for
# NVRAM only, never for the disk's own contents.
d="$(new_case loader-write-fails)"
: > "$d/mount_fails_sdb1"   # the new ESP refuses to mount → the loaders can never be written
out="$(install "$d")"
eq  "loader write blocked: still fails"    "1" "$(exit_of "$out")"
has "loader write blocked: reported code"  '"code":"install-write-failed"' "$(posted "$d")"
has "loader write blocked: failed status"  "failed|-|" "$(last_status "$d")"

# ─── 5b) POL-194: the swap partition is taken back before the wipe, or the wipe does not happen ─────
# The live rootfs IS the installed rootfs, so this box carries the installed system's crypttab entry
# for POLYPTIC-SWAP. On a re-install systemd has already opened and swapped-on that partition; on a
# first install the unit is armed and fires the moment `sgdisk -c 4:POLYPTIC-SWAP` creates the
# partlabel. Either way mkswap met a busy device AFTER the disk was already wiped.

# The release runs before anything destructive, and in the right order — swapoff before close, since
# an active swap holds the mapper which holds the partition.
d="$(new_case release-swap)"; out="$(install "$d")"
eq  "release: still a clean install"       "0" "$(exit_of "$out")"
has "release: swaps off the mapper"        "$d/dev/mapper/polyptic-swap" "$(cat "$d/swapoff.log" 2>/dev/null)"
has "release: closes the mapping"          "close polyptic-swap" "$(cat "$d/cryptsetup.log" 2>/dev/null)"
has "release: masks the unit at runtime"   "mask --runtime" "$(cat "$d/systemctl.log" 2>/dev/null)"
has "release: masks the escaped unit name" 'systemd-cryptsetup@polyptic\x2dswap.service' "$(cat "$d/systemctl.log" 2>/dev/null)"
# --runtime and nothing else: a persistent mask would follow the image onto the installed disk and
# rob every future boot of its ephemeral encrypted swap, which is the whole privacy point.
hasnt "release: never masks persistently"  "mask systemd" "$(cat "$d/systemctl.log" 2>/dev/null)"
# Ordering is the fix, not decoration: releasing AFTER the wipe would still abort a wiped disk.
eq  "release: swapoff is the FIRST of the two"  "swapoff" "$(grep -n -m1 -E '^(swapoff|sgdisk)$' "$d/order.log" | cut -d: -f2)"
eq  "release: every release step precedes sgdisk" "yes" \
    "$([ "$(grep -n -m1 '^sgdisk$' "$d/order.log" | cut -d: -f1)" -gt "$(grep -n '^cryptsetup$' "$d/order.log" | tail -n1 | cut -d: -f1)" ] && echo yes || echo no)"

# A holder that survives the release stops the install while "nothing was erased" is still true.
d="$(new_case held-partition)"
mkdir -p "$d/sysblock/sdb4/holders/dm-0" "$d/sysblock/sdb4/holders/dm-0/dm"
printf 'polyptic-swap\n' > "$d/sysblock/sdb4/holders/dm-0/dm/name"
out="$(install "$d")"
eq  "held: refuses"                        "1" "$(exit_of "$out")"
eq  "held: NOTHING was erased"             "no" "$(wiped "$d")"
has "held: reported code"                  '"code":"install-bad-target"' "$(posted "$d")"
has "held: names the partition"            "sdb4" "$(posted "$d")"
# `dm-0` is what sysfs calls it and `polyptic-swap` is what the operator can act on.
has "held: names the holder, not dm-N"     "polyptic-swap" "$(posted "$d")"

# A neighbouring disk's partitions are not this disk's: `sdb` must not sweep up `sdbb`.
d="$(new_case held-other-disk)"
mkdir -p "$d/sysblock/sdbb1/holders/dm-0"
out="$(install "$d")"
eq  "other disk held: install proceeds"    "0" "$(exit_of "$out")"

# ─── 5c) POL-196: a RAW active swap on the target, and stale signatures inside re-made partitions ───
# A raw swap partition (no device-mapper in the way) is invisible to BOTH existing guards: swap is
# not a mount, so /proc/mounts never names it, and with nothing layered on top it has no holders.
# Formatting over a live swap corrupts a running system.
d="$(new_case raw-swap)"
printf '/dev/sdb4                               partition\t4194300\t0\t-2\n' >> "$d/swaps"
out="$(install "$d")"
has "raw swap: swapped off by device"      "/dev/sdb4" "$(cat "$d/swapoff.log" 2>/dev/null)"
eq  "raw swap: install proceeds once off"  "0" "$(exit_of "$out")"

# …and when it will not go, the install refuses while nothing has been erased, naming the remedy.
d="$(new_case raw-swap-stuck)"
printf '/dev/sdb4                               partition\n' >> "$d/swaps"
: > "$d/swapoff_fails"
out="$(install "$d")"
eq  "stuck swap: refuses"                  "1" "$(exit_of "$out")"
eq  "stuck swap: NOTHING was erased"       "no" "$(wiped "$d")"
has "stuck swap: reported code"            '"code":"install-bad-target"' "$(posted "$d")"
has "stuck swap: names the device"         "/dev/sdb4" "$(posted "$d")"
has "stuck swap: names the remedy"         "swapoff /dev/sdb4" "$(posted "$d")"

# Swap on a DIFFERENT disk is none of our business.
d="$(new_case swap-elsewhere)"
printf '/dev/sdc2                               partition\n' >> "$d/swaps"
out="$(install "$d")"
eq  "swap elsewhere: install proceeds"     "0" "$(exit_of "$out")"
hasnt "swap elsewhere: left alone"         "/dev/sdc2" "$(cat "$d/swapoff.log" 2>/dev/null)"

# Stale signatures: --zap-all and the disk-level wipefs destroy the TABLE, not the filesystems inside
# the partitions it described. The layout is deterministic, so a re-install re-creates each partition
# at the same LBA, on top of the last install's superblocks.
d="$(new_case stale-signatures)"; out="$(install "$d")"
eq  "stale sigs: every partition wiped"    "5" "$(grep -c 'dev/sdb[1-5]$' "$d/wipefs.log" 2>/dev/null | tr -d ' ')"
has "stale sigs: the disk itself too"      "dev/sdb" "$(cat "$d/wipefs.log")"
# Wiping AFTER mkfs would erase the filesystem we just made — the order is the whole point.
eq  "stale sigs: every wipe precedes every mkfs" "yes" \
    "$([ "$(grep -n '^mkfs$' "$d/order.log" | head -n1 | cut -d: -f1)" -gt "$(grep -n '^wipefs$' "$d/order.log" | tail -n1 | cut -d: -f1)" ] && echo yes || echo no)"
# ─── 5c) POL-195: a failing tool's OWN words reach the verdict ──────────────────────────────────────
# "could not format the swap partition on /dev/nvme0n1" is a sentence about what we were trying to
# do. `mkswap`'s "Device or resource busy" is what happened — and it used to go to /dev/null, which
# is how a real install failure reached the operator carrying no reason at all.
d="$(new_case stderr-carried)"; : > "$d/console"   # say() only writes to a console that exists
cat > "$BIN/mkswap" <<'EOF'
#!/bin/sh
echo "mkswap: /dev/sdb4: Device or resource busy" >&2
exit 1
EOF
chmod +x "$BIN/mkswap"
out="$(install "$d")"
eq  "stderr: still fails"                  "1" "$(exit_of "$out")"
has "stderr: keeps our sentence"           "could not format the swap partition on /dev/sdb" "$(last_status "$d")"
has "stderr: carries the tool's reason"    "Device or resource busy" "$(last_status "$d")"
has "stderr: reason reaches the report"    "Device or resource busy" "$(posted "$d")"
has "stderr: reason reaches the console"   "Device or resource busy" "$(cat "$d/console" 2>/dev/null)"
mkfs_stub mkswap   # restore for any later case

# A tool that fails SILENTLY leaves the sentence alone rather than trailing an empty separator.
d="$(new_case stderr-silent)"
printf '#!/bin/sh\nexit 1\n' > "$BIN/mkswap"; chmod +x "$BIN/mkswap"
out="$(install "$d")"
eq  "silent tool: still fails"             "1" "$(exit_of "$out")"
has "silent tool: plain sentence"          "could not format the swap partition on /dev/sdb" "$(last_status "$d")"
hasnt "silent tool: no dangling separator" "on /dev/sdb: " "$(last_status "$d")"
mkfs_stub mkswap

# Multi-line, noisy output is flattened to one line — the verdict travels through a status line, a
# JSON body and the forensics log, none of which want a page of tool output.
d="$(new_case stderr-noisy)"
cat > "$BIN/mkswap" <<'EOF'
#!/bin/sh
printf 'line one\nline two\n\n   line three   \n' >&2
exit 1
EOF
chmod +x "$BIN/mkswap"
out="$(install "$d")"
has "noisy tool: flattened to one line"    "line one line two line three" "$(last_status "$d")"
eq  "noisy tool: verdict stays one line"   "1" "$(last_status "$d" | wc -l | tr -d ' ')"
mkfs_stub mkswap

# ─── 6) The token never leaks into a report body ────────────────────────────────────────────────────
d="$(new_case token-hygiene)"; out="$(install "$d")"
eq "token stays in the header, not the body" "" "$(posted "$d" | cut -f3 | grep -o 'secret-fleet-token' || true)"

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'ALL PASS\n'; exit 0; fi
printf '%d FAILED\n' "$fails"; exit 1
