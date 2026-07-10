#!/usr/bin/env sh
# Pure-shell tests for the bootloader offload (POL-33/D47, hardened by POL-58). Runs ANYWHERE
# (macOS/Linux/CI), no root, no real disks: every external command offload.sh touches — lsblk,
# efibootmgr, curl, mount, umount, mountpoint, uname, plymouth — is a stub on PATH that reads its
# scripted behaviour out of $STUB_DIR, and every path it reads is an env-overridable fixture.
#
# What this pins is the whole reason POL-58 exists: an offload that cannot make the firmware boot
# Polyptic must FAIL, loudly, and never leave a stamp behind claiming it worked. Also wrapped by a bun
# test (packages/e2e/netboot-offload.test.ts) so it runs in `bun test` / CI.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "contains: $2" "$3" ;; esac; }

# ─── The stub environment ───────────────────────────────────────────────────────────────────────────
# One directory per test case, holding: the fake sysfs/cmdline, the fake ESP (a plain directory that
# `mount` binds by symlinking), and the stubs' scripted state (efibootmgr's NVRAM as a text file).

BIN="$ROOT/bin"; mkdir -p "$BIN"

cat > "$BIN/uname" <<'EOF'
#!/bin/sh
[ "${1:-}" = "-m" ] && { printf '%s\n' "${STUB_ARCH:-x86_64}"; exit 0; }
exit 0
EOF

# lsblk stubs: -rno NAME,PARTTYPE,PKNAME lists the fake block devices; -no PKNAME and -rno PARTUUID
# answer per-device queries. All driven by $STUB/blockdevs, lines of "<part> <parttype> <disk> <partuuid>".
cat > "$BIN/lsblk" <<'EOF'
#!/bin/sh
case "$*" in
  *"NAME,PARTTYPE,PKNAME"*) awk '{print $1" "$2" "$3}' "$STUB/blockdevs"; exit 0 ;;
esac
for a in "$@"; do dev="$a"; done      # the device is always the last argument
dev="${dev##*/}"
case "$*" in
  *PARTUUID*) awk -v d="$dev" '$1==d {print $4}' "$STUB/blockdevs"; exit 0 ;;
  *PKNAME*)   awk -v d="$dev" '$1==d {print $3}' "$STUB/blockdevs"; exit 0 ;;
esac
exit 0
EOF

# efibootmgr stub: $STUB/nvram is the boot-variable store, one "BootXXXX* label" line plus a
# "BootOrder: ..." line, exactly as the real tool prints them. $STUB/nvram_readonly makes every write
# fail (the firmware-refuses case); $STUB/nvram_amnesia drops writes silently (accept-then-forget).
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
  # The real tool drops the entry AND its place in BootOrder.
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
  # A firmware that APPENDS rather than prepends is the interesting one; $STUB/nvram_appends picks it.
  if [ -f "$STUB/nvram_appends" ]; then printf 'BootOrder: %s%s\n' "${cur:+$cur,}" "$num" >> "$STUB/nvram.tmp"
  else printf 'BootOrder: %s%s\n' "$num" "${cur:+,$cur}" >> "$STUB/nvram.tmp"; fi
  mv "$STUB/nvram.tmp" "$STUB/nvram"
elif [ -n "$order" ]; then
  # $STUB/nvram_sticky_order: firmware keeps the entry but refuses to reorder (the POL-58 box).
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

# curl stub: records every request; -o writes a fake payload; POSTs are appended to $STUB/posts.
cat > "$BIN/curl" <<'EOF'
#!/bin/sh
out=""; url=""; post=""; body=""; auth=""
while [ $# -gt 0 ]; do
  case "$1" in
    -o) shift; out="$1" ;;
    -X) shift; [ "$1" = POST ] && post=1 ;;
    --data-binary) shift; body="$1" ;;
    -H) shift; case "$1" in Authorization:*) auth="$1" ;; esac ;;
    -m) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
if [ -n "$post" ]; then printf '%s\t%s\t%s\n' "$url" "$auth" "$body" >> "$STUB/posts"; exit 0; fi
[ -f "$STUB/curl_fails" ] && exit 22
printf '%s\n' "fake-payload-of $url" >> "$STUB/fetched"
[ -n "$out" ] && printf 'SIGNED-EFI-BINARY\n' > "$out"
exit 0
EOF

# mount/umount/mountpoint: `mount [-o opts] <dev> <dir>` replaces <dir> with a symlink to a fixture:
# $STUB/vol-<basename(dev)> when that exists (the POL-63 boot medium), else the fake ESP tree.
cat > "$BIN/mount" <<'EOF'
#!/bin/sh
case "${1:-}" in -t) exit 0 ;; esac        # `mount -t efivarfs ...` is a no-op here
[ -f "$STUB/mount_fails" ] && exit 32
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
[ -d "$src" ] || src="$STUB/esp"
rmdir "$dir" 2>/dev/null || true
ln -s "$src" "$dir"
printf '%s\n' "$dir" >> "$STUB/mounted"
exit 0
EOF
cat > "$BIN/umount" <<'EOF'
#!/bin/sh
rm -f "$1" 2>/dev/null; mkdir -p "$1" 2>/dev/null; exit 0
EOF
printf '#!/bin/sh\nexit 1\n' > "$BIN/mountpoint"      # never "already mounted"
printf '#!/bin/sh\nexit 0\n' > "$BIN/plymouth"
# The POL-63 Wi-Fi payload path: `ip route show default` decides payload-vs-pointer, `df -Pk` is the
# ESP space check, `blkid` backs find-boot-medium's scan.
cat > "$BIN/ip" <<'EOF'
#!/bin/sh
case "$*" in *"route show default"*) cat "$STUB/default_route" 2>/dev/null ;; esac
exit 0
EOF
cat > "$BIN/df" <<'EOF'
#!/bin/sh
avail="$(cat "$STUB/df_avail_kb" 2>/dev/null || echo 999999999)"
printf 'Filesystem 1024-blocks Used Available Capacity Mounted-on\n'
printf 'stub 1 1 %s 1%% /\n' "$avail"
exit 0
EOF
cat > "$BIN/blkid" <<'EOF'
#!/bin/sh
cat "$STUB/vfat_devs" 2>/dev/null
exit 0
EOF
chmod +x "$BIN"/*

# ─── Fixture builder ────────────────────────────────────────────────────────────────────────────────
# new_case <name> → prints the case dir; the caller tweaks it, then calls `offload <dir>`.
new_case() {
  d="$ROOT/$1"
  mkdir -p "$d/esp" "$d/efi/efivars" "$d/run" "$d/var" "$d/by-label" "$d/netdir" \
           "$d/sysblock/sda" "$d/sysblock/sda1" "$d/sysblock/nvme0n1" "$d/sysblock/nvme0n1p1"
  printf '1\n' > "$d/sysblock/sda1/partition"
  printf '1\n' > "$d/sysblock/nvme0n1p1/partition"
  printf '0\n' > "$d/sysblock/nvme0n1/removable"
  printf '0\n' > "$d/sysblock/sda/removable"
  printf 'BOOT_IMAGE=/vmlinuz root=live:http://10.0.0.10/dist/image/amd64/rootfs.squashfs polyptic.base=http://10.0.0.10 polyptic.token=secret-fleet-token quiet splash polyptic.offload=1\n' > "$d/cmdline"
  # One internal NVMe ESP; the firmware already boots it (its PARTUUID appears in the NVRAM below).
  printf 'nvme0n1p1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b nvme0n1 aaaa-1111\n' > "$d/blockdevs"
  printf 'Boot0000* ubuntu\nBootOrder: 0000\n' > "$d/nvram"
  printf '%s' "$d"
}

offload() {
  d="$1"
  STUB="$d" PATH="$BIN:$PATH" \
  POLYPTIC_CMDLINE_FILE="$d/cmdline" POLYPTIC_EFI_DIR="$d/efi" POLYPTIC_SYS_BLOCK="$d/sysblock" \
  POLYPTIC_RUN_DIR="$d/run" POLYPTIC_OFFLOAD_STAMP="$d/var/offloaded" POLYPTIC_LIB_DIR="$LIB" \
  POLYPTIC_CONSOLE="$d/console" POLYPTIC_HOLD_SECONDS=0 POLYPTIC_HOLD_SECONDS_OK=0 \
  POLYPTIC_BYLABEL_DIR="$d/by-label" POLYPTIC_NET_DIR="$d/netdir" \
  STUB_ARCH="${STUB_ARCH:-x86_64}" \
    sh "$LIB/offload.sh" 2>&1
  printf 'exit=%s\n' "$?"
}
code_of()   { sed -n 's/^code=//p' "$1/run/bootloader-status" 2>/dev/null; }
exit_of()   { printf '%s' "$1" | sed -n 's/^exit=//p'; }
posted()    { cat "$1/posts" 2>/dev/null; }

# ─── 1) The happy path: loaders land, the entry leads, the stamp is written ──────────────────────────
d="$(new_case happy)"; out="$(offload "$d")"
eq "happy: exits 0"                       "0"   "$(exit_of "$out")"
eq "happy: status code"                   "installed" "$(code_of "$d")"
eq "happy: stamp written"                 "yes" "$([ -f "$d/var/offloaded" ] && echo yes || echo no)"
eq "happy: shim installed"                "yes" "$([ -f "$d/esp/EFI/polyptic/shimx64.efi" ] && echo yes || echo no)"
eq "happy: grub installed"                "yes" "$([ -f "$d/esp/EFI/polyptic/grubx64.efi" ] && echo yes || echo no)"
eq "happy: arch-dir stage-1 config"       "yes" "$([ -f "$d/esp/grub/x86_64-efi/grub.cfg" ] && echo yes || echo no)"
eq "happy: root stage-1 config too"       "yes" "$([ -f "$d/esp/grub/grub.cfg" ] && echo yes || echo no)"
eq "happy: config carries the marker"     "# polyptic-offload" "$(head -n1 "$d/esp/grub/x86_64-efi/grub.cfg")"
eq "happy: config carries the base"       "set net=(http,10.0.0.10)" "$(grep '^set net=' "$d/esp/grub/x86_64-efi/grub.cfg")"
eq "happy: our entry leads BootOrder"     "0001,0000" "$(sed -n 's/^BootOrder: //p' "$d/nvram")"
eq "happy: entry is labelled"             "Boot0001* Polyptic Netboot" "$(grep 'Polyptic Netboot' "$d/nvram")"
has "happy: says nothing was erased"      "nothing was erased" "$out"
has "happy: reported to the control plane" '"code":"installed"' "$(posted "$d")"
has "happy: report carries the token"     "Authorization: Bearer secret-fleet-token" "$(posted "$d")"
has "happy: report goes to /boot/report"  "http://10.0.0.10/boot/report" "$(posted "$d")"

# The box's own EFI/BOOT fallback was free, so we claimed it (a box with no usable NVRAM still boots).
eq "happy: claims the free fallback path" "yes" "$([ -f "$d/esp/EFI/BOOT/BOOTX64.EFI" ] && echo yes || echo no)"

# ─── 2) A foreign default loader is NEVER replaced ──────────────────────────────────────────────────
d="$(new_case keeps-foreign-fallback)"
mkdir -p "$d/esp/EFI/BOOT"; printf 'UBUNTU-SHIM\n' > "$d/esp/EFI/BOOT/BOOTX64.EFI"
out="$(offload "$d")"
eq "foreign fallback: still succeeds"     "0" "$(exit_of "$out")"
eq "foreign fallback: left untouched"     "UBUNTU-SHIM" "$(cat "$d/esp/EFI/BOOT/BOOTX64.EFI")"
eq "foreign fallback: our subdir written" "yes" "$([ -f "$d/esp/EFI/polyptic/shimx64.efi" ] && echo yes || echo no)"

# ─── 3) A foreign GRUB config at our path aborts before anything is written ─────────────────────────
d="$(new_case foreign-cfg)"
mkdir -p "$d/esp/grub/x86_64-efi"; printf 'menuentry "someone else" {}\n' > "$d/esp/grub/x86_64-efi/grub.cfg"
out="$(offload "$d")"
eq "foreign cfg: fails"                   "1" "$(exit_of "$out")"
eq "foreign cfg: code"                    "foreign-grub-cfg" "$(code_of "$d")"
eq "foreign cfg: config untouched"        'menuentry "someone else" {}' "$(cat "$d/esp/grub/x86_64-efi/grub.cfg")"
eq "foreign cfg: no stamp"                "no" "$([ -f "$d/var/offloaded" ] && echo yes || echo no)"

# ─── 4) THE POL-58 BUG: the firmware keeps the entry but won't boot it first ────────────────────────
d="$(new_case sticky-order)"; : > "$d/nvram_sticky_order"; : > "$d/nvram_appends"
out="$(offload "$d")"
eq "sticky order: fails (never claims success)" "1" "$(exit_of "$out")"
eq "sticky order: code"                   "boot-order-not-first" "$(code_of "$d")"
eq "sticky order: NO stamp"               "no" "$([ -f "$d/var/offloaded" ] && echo yes || echo no)"
has "sticky order: tells the operator where to fix it" "firmware setup" "$out"
has "sticky order: reported as a failure" '"ok":false' "$(posted "$d")"

# ─── 5) Firmware accepts the entry and forgets it ───────────────────────────────────────────────────
d="$(new_case amnesia)"; : > "$d/nvram_amnesia"
out="$(offload "$d")"
eq "amnesia: fails"                       "1" "$(exit_of "$out")"
eq "amnesia: code"                        "nvram-entry-missing" "$(code_of "$d")"
eq "amnesia: no stamp"                    "no" "$([ -f "$d/var/offloaded" ] && echo yes || echo no)"

# ─── 6) Firmware refuses the write outright ─────────────────────────────────────────────────────────
d="$(new_case readonly-nvram)"; : > "$d/nvram_readonly"
out="$(offload "$d")"
eq "readonly nvram: fails"                "1" "$(exit_of "$out")"
eq "readonly nvram: code"                 "nvram-write-failed" "$(code_of "$d")"

# ─── 7) The USB stick we booted from is never offloaded onto ────────────────────────────────────────
d="$(new_case removable-only)"
printf 'sda1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b sda bbbb-2222\n' > "$d/blockdevs"
printf '1\n' > "$d/sysblock/sda/removable"
out="$(offload "$d")"
eq "removable: fails rather than bricking the box" "1" "$(exit_of "$out")"
eq "removable: code"                      "no-esp" "$(code_of "$d")"
has "removable: explains why"             "removable media" "$out"
eq "removable: NVRAM untouched"           "BootOrder: 0000" "$(grep '^BootOrder' "$d/nvram")"

# A removable ESP alongside an internal one: the internal one wins, silently and correctly.
d="$(new_case removable-plus-internal)"
{ printf 'sda1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b sda bbbb-2222\n'
  printf 'nvme0n1p1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b nvme0n1 aaaa-1111\n'; } > "$d/blockdevs"
printf '1\n' > "$d/sysblock/sda/removable"
out="$(offload "$d")"
eq "usb+internal: succeeds"               "0" "$(exit_of "$out")"
has "usb+internal: installs to the internal disk" "/dev/nvme0n1" "$out"

# ─── 8) Two internal ESPs: the one the firmware boots wins; a true tie aborts ───────────────────────
d="$(new_case two-esps-one-known)"
mkdir -p "$d/sysblock/sdb" "$d/sysblock/sdb1"; printf '0\n' > "$d/sysblock/sdb/removable"; printf '1\n' > "$d/sysblock/sdb1/partition"
{ printf 'sdb1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b sdb cccc-3333\n'
  printf 'nvme0n1p1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b nvme0n1 aaaa-1111\n'; } > "$d/blockdevs"
printf 'Boot0000* ubuntu\tHD(1,GPT,aaaa-1111,0x800,0x100000)/File(\\EFI\\ubuntu\\shimx64.efi)\nBootOrder: 0000\n' > "$d/nvram"
out="$(offload "$d")"
eq "two ESPs: succeeds"                   "0" "$(exit_of "$out")"
has "two ESPs: picks the one the firmware boots" "/dev/nvme0n1" "$out"

d="$(new_case two-esps-tie)"
mkdir -p "$d/sysblock/sdb" "$d/sysblock/sdb1"; printf '0\n' > "$d/sysblock/sdb/removable"; printf '1\n' > "$d/sysblock/sdb1/partition"
{ printf 'sdb1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b sdb cccc-3333\n'
  printf 'nvme0n1p1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b nvme0n1 aaaa-1111\n'; } > "$d/blockdevs"
out="$(offload "$d")"
eq "ambiguous ESPs: refuses to guess"     "1" "$(exit_of "$out")"
eq "ambiguous ESPs: code"                 "ambiguous-esp" "$(code_of "$d")"
has "ambiguous ESPs: names the override"  "polyptic.offload_disk=" "$out"

# …and the override resolves it.
d="$(new_case two-esps-override)"
mkdir -p "$d/sysblock/sdb" "$d/sysblock/sdb1"; printf '0\n' > "$d/sysblock/sdb/removable"; printf '1\n' > "$d/sysblock/sdb1/partition"
{ printf 'sdb1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b sdb cccc-3333\n'
  printf 'nvme0n1p1 c12a7328-f81f-11d2-ba4b-00a0c93ec93b nvme0n1 aaaa-1111\n'; } > "$d/blockdevs"
sed 's|polyptic.offload=1|polyptic.offload_disk=/dev/sdb polyptic.offload=1|' "$d/cmdline" > "$d/cmdline.new"
mv "$d/cmdline.new" "$d/cmdline"
out="$(offload "$d")"
eq "offload_disk override: succeeds"      "0" "$(exit_of "$out")"
has "offload_disk override: honoured"     "/dev/sdb" "$out"

# ─── 9) Legacy BIOS box (the likeliest reason a pre-existing Ubuntu has no ESP to chain from) ───────
d="$(new_case legacy-bios)"; rm -rf "$d/efi"
out="$(offload "$d")"
eq "legacy bios: fails"                   "1" "$(exit_of "$out")"
eq "legacy bios: code"                    "not-uefi" "$(code_of "$d")"
has "legacy bios: names the fix"          "firmware setup" "$out"
has "legacy bios: still reaches the operator" '"code":"not-uefi"' "$(posted "$d")"

# ─── 10) No ESP at all on an internal disk ──────────────────────────────────────────────────────────
d="$(new_case no-esp)"; printf 'nvme0n1p1 0fc63daf-8483-4772-8e79-3d69d8477de4 nvme0n1 aaaa-1111\n' > "$d/blockdevs"
out="$(offload "$d")"
eq "no esp: fails"                        "1" "$(exit_of "$out")"
eq "no esp: code"                         "no-esp" "$(code_of "$d")"
has "no esp: says nothing was erased"     "Nothing was erased" "$out"

# ─── 11) The depot is unreachable: fail before touching the disk ────────────────────────────────────
d="$(new_case no-loaders)"; : > "$d/curl_fails"
out="$(offload "$d")"
eq "no loaders: fails"                    "1" "$(exit_of "$out")"
eq "no loaders: code"                     "no-loaders" "$(code_of "$d")"
eq "no loaders: ESP untouched"            "" "$(ls "$d/esp")"

# ─── 12) A cmdline with no control plane ────────────────────────────────────────────────────────────
d="$(new_case no-base)"; printf 'BOOT_IMAGE=/vmlinuz quiet splash polyptic.offload=1\n' > "$d/cmdline"
out="$(offload "$d")"
eq "no base: fails"                       "1" "$(exit_of "$out")"
eq "no base: code"                        "no-base" "$(code_of "$d")"

# ─── 13) Re-offloading a box replaces its stale entry instead of stacking duplicates ────────────────
d="$(new_case reoffload)"
printf 'Boot0000* ubuntu\nBoot0001* Polyptic Netboot\nBootOrder: 0000,0001\n' > "$d/nvram"
out="$(offload "$d")"
eq "re-offload: succeeds"                 "0" "$(exit_of "$out")"
eq "re-offload: exactly one entry of ours" "1" "$(grep -c 'Polyptic Netboot' "$d/nvram")"
eq "re-offload: and it leads"             "0001,0000" "$(sed -n 's/^BootOrder: //p' "$d/nvram")"

# ─── 14) An arm64 box installs the aa64 pair ────────────────────────────────────────────────────────
d="$(new_case arm64)"
out="$(STUB_ARCH=aarch64 offload "$d")"
eq "arm64: succeeds"                      "0" "$(exit_of "$out")"
eq "arm64: shimaa64"                      "yes" "$([ -f "$d/esp/EFI/polyptic/shimaa64.efi" ] && echo yes || echo no)"
eq "arm64: arm64-efi config dir"          "yes" "$([ -f "$d/esp/grub/arm64-efi/grub.cfg" ] && echo yes || echo no)"
eq "arm64: BOOTAA64.EFI fallback"         "yes" "$([ -f "$d/esp/EFI/BOOT/BOOTAA64.EFI" ] && echo yes || echo no)"

# ─── 15) The report never leaks the fleet token into its body ───────────────────────────────────────
d="$(new_case token-hygiene)"; out="$(offload "$d")"
eq "token stays in the header, not the body" "" "$(posted "$d" | cut -f3 | grep -o 'secret-fleet-token' || true)"

# ─── 16) POL-63: a Wi-Fi boot also offloads the LOCAL payload ───────────────────────────────────────
# wifi_case <name>: a box whose default route rides wlan0, booted from a medium whose amd64 payload
# sits in slot `b` (proving the ESP copy re-renders for slot `a`).
wifi_case() {
  d="$(new_case "$1")"
  mkdir -p "$d/netdir/wlan0/wireless"
  printf 'default via 10.0.0.1 dev wlan0 proto dhcp\n' > "$d/default_route"
  m="$d/vol-POLYPTIC-BT"
  mkdir -p "$m/grub" "$m/polyptic/boot/amd64/b" "$m/polyptic/certs"
  : > "$d/by-label/POLYPTIC-BT"
  printf 'medium-2026-test\n' > "$m/polyptic/medium-id"
  printf 'WIFI_SSID=SiteNet\nWIFI_PSK=hunter2hunter2\n' > "$m/polyptic/wifi.conf"
  printf 'PEM\n' > "$m/polyptic/certs/ca.pem"
  printf '# polyptic-local dispatcher (POL-63)\nconfigfile /grub/local-$arch.cfg\n' > "$m/grub/local.cfg"
  sh "$LIB/render-local-grub.sh" amd64 b 10.0.0.10 20260701T000000Z-cafe secret-fleet-token > "$m/grub/local-amd64.cfg"
  printf 'FAKE-KERNEL\n' > "$m/polyptic/boot/amd64/b/vmlinuz"
  printf 'FAKE-INITRD-WIFI\n' > "$m/polyptic/boot/amd64/b/initrd"
  printf '%s' "$d"
}

d="$(wifi_case wifi-happy)"
out="$(offload "$d")"
eq "wifi: succeeds"                        "0" "$(exit_of "$out")"
eq "wifi: payload kernel on the ESP"       "FAKE-KERNEL" "$(cat "$d/esp/polyptic/boot/amd64/a/vmlinuz" 2>/dev/null)"
eq "wifi: payload initrd on the ESP"       "FAKE-INITRD-WIFI" "$(cat "$d/esp/polyptic/boot/amd64/a/initrd" 2>/dev/null)"
has "wifi: menu re-rendered for slot a"    "slot=a image=20260701T000000Z-cafe" "$(head -n1 "$d/esp/grub/local-amd64.cfg" 2>/dev/null)"
eq "wifi: dispatcher copied"               "# polyptic-local dispatcher (POL-63)" "$(head -n1 "$d/esp/grub/local.cfg" 2>/dev/null)"
eq "wifi: credentials travel"              "WIFI_SSID=SiteNet" "$(head -n1 "$d/esp/polyptic/wifi.conf" 2>/dev/null)"
eq "wifi: certs travel"                    "PEM" "$(cat "$d/esp/polyptic/certs/ca.pem" 2>/dev/null)"
eq "wifi: the ESP becomes the medium"      "yes" "$([ -f "$d/esp/polyptic/medium-id" ] && echo yes || echo no)"
has "wifi: stage-1 gains the local fallback" "configfile /grub/local.cfg" "$(cat "$d/esp/grub/x86_64-efi/grub.cfg")"
has "wifi: reported with the payload"      "Wi-Fi local payload" "$(posted "$d")"

# The ESP is too small for two slots: fail BEFORE anything is written, with the honest code.
d="$(wifi_case wifi-esp-too-small)"; printf '1024\n' > "$d/df_avail_kb"
out="$(offload "$d")"
eq "esp-too-small: fails"                  "1" "$(exit_of "$out")"
eq "esp-too-small: code"                   "esp-too-small" "$(code_of "$d")"
eq "esp-too-small: ESP untouched"          "" "$(ls "$d/esp")"
has "esp-too-small: names the numbers"     "MB free" "$out"

# On Wi-Fi with no medium attached (stick already pulled): refuse, name the fix.
d="$(new_case wifi-no-medium)"
mkdir -p "$d/netdir/wlan0/wireless"
printf 'default via 10.0.0.1 dev wlan0 proto dhcp\n' > "$d/default_route"
out="$(offload "$d")"
eq "wifi no medium: fails"                 "1" "$(exit_of "$out")"
eq "wifi no medium: code"                  "no-local-payload" "$(code_of "$d")"
has "wifi no medium: names the fix"        "leave the USB stick in" "$out"

# A medium with no payload for this box's arch: refuse rather than install an unbootable chain.
d="$(wifi_case wifi-wrong-arch)"
out="$(STUB_ARCH=aarch64 offload "$d")"
eq "wifi wrong arch: fails"                "1" "$(exit_of "$out")"
eq "wifi wrong arch: code"                 "no-local-payload" "$(code_of "$d")"

# polyptic.offload_wifi=0 forces the old pointer-only install even on a Wi-Fi route.
d="$(wifi_case wifi-forced-off)"
sed 's|polyptic.offload=1|polyptic.offload_wifi=0 polyptic.offload=1|' "$d/cmdline" > "$d/cmdline.new"
mv "$d/cmdline.new" "$d/cmdline"
out="$(offload "$d")"
eq "forced pointer-only: succeeds"         "0" "$(exit_of "$out")"
eq "forced pointer-only: no payload"       "no" "$([ -d "$d/esp/polyptic" ] && echo yes || echo no)"

# A WIRED offload from the same payload-carrying medium stays pointer-only (the pre-POL-63 flow).
d="$(wifi_case wired-stays-pointer)"
rm -rf "$d/netdir/wlan0"; printf 'default via 10.0.0.1 dev eth0 proto dhcp\n' > "$d/default_route"
out="$(offload "$d")"
eq "wired: succeeds"                       "0" "$(exit_of "$out")"
eq "wired: no payload copied"              "no" "$([ -d "$d/esp/polyptic" ] && echo yes || echo no)"
eq "wired: still pointer-installed"        "installed" "$(code_of "$d")"

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'ALL PASS\n'; exit 0; fi
printf '%d FAILED\n' "$fails"; exit 1
