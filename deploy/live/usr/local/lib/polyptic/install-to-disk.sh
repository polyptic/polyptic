#!/bin/sh
# One-shot INSTALL TO DISK (POL-176). Reverses D55's diskless contract: Polyptic boxes own their
# disk. The console shows INSTALL on a live-booted box; the agent (kiosk user) writes ONE line
# `device=/dev/sdX` to /run/polyptic/requests/install; a root path unit (polyptic-install.path)
# runs this script. It WIPES the chosen disk, lays down GPT with an ESP + A/B image slots +
# encrypted swap + a scratch overlay partition, fetches a FRESH image from the depot into slot A,
# installs the signed loader pair, and registers a `Polyptic` UEFI entry as the FIRST boot option.
# From then on the box boots its squashfs FROM DISK (render-disk-grub.sh's menuless config) and
# netboot demotes to the recovery path. Offload is retired — this supersedes it.
#
# Disk layout (whole target disk, GPT):
#   1  ESP      1536 MiB  FAT32  label POLYPTIC-BT   partlabel POLYPTIC-ESP   (the boot medium!)
#   2  slot A      4 GiB  ext4   label POLYPTIC-A    squashfs at /LiveOS/squashfs.img
#   3  slot B      4 GiB  ext4   label POLYPTIC-B    (empty at install; update-poll stages into it)
#   4  swap        4 GiB  plain partition, partlabel POLYPTIC-SWAP — dm-crypt with an EPHEMERAL
#                  random key each boot via /etc/crypttab, so wall pixels/tokens never hit disk in
#                  the clear and nothing on it survives a power cycle
#   5  scratch  rest      ext4   label POLYPTIC-SCRATCH — dracut's rd.live.overlay, wiped every
#                  boot by rd.live.overlay.reset=1 (statelessness by construction)
# Minimum disk ~= 16 GiB; smaller is refused, loudly, before anything is written.
#
# The ESP carries the `polyptic/medium-id` marker (content `disk-esp-<utc-ts>`) — the ESP IS the
# boot medium from then on, so find-boot-medium.sh, the forensics trail, the theme heal and
# update-poll's kernel staging all work unchanged.
#
# NEVER copies its running image: the squashfs/kernel/initrd are fetched fresh from the depot and
# sha256-verified against that build's SHA256SUMS, so an install always lands a depot-known build.
#
# POL-58's discipline carries over: NOTHING is claimed that was not verified — the UEFI entry is
# read BACK from NVRAM — but per POL-178 firmware that refuses/drops the entry only WARNS (the
# unconditional EFI/BOOT fallback loader keeps the disk bootable); every outcome is reported to
# the control plane (POST /boot/report) AND to the on-box progress file the console tails. UNLIKE
# offload, a failure does NOT hold the boot: the box is mid-session, the wall is rendering, and the
# operator is watching the console — report, mark `failed`, exit 1.
#
# Progress contract (shared with the agent, POL-176): lines appended to /run/polyptic/install-status
# (0644), `<phase>|<percent>|<detail>`, phase in
# starting|wiping|partitioning|fetching|verifying|writing-loader|boot-entry|done|failed; percent
# 0-100 or `-`. The file is truncated at start; the final line is `done|100|…` or `failed|-|…`.
#
# PURE-ish + TESTABLE (the retired offload.sh's pattern, kept alive here): every input path and
# every external command is
# overridable/stubbable, so the whole decision tree runs against fixtures off-box
# (deploy/live/test/install.test.sh).
#   POLYPTIC_CMDLINE_FILE     (/proc/cmdline)      POLYPTIC_EFI_DIR   (/sys/firmware/efi)
#   POLYPTIC_SYS_BLOCK        (/sys/class/block)   POLYPTIC_RUN_DIR   (/run/polyptic)
#   POLYPTIC_INSTALL_REQUEST  (/run/polyptic/requests/install)
#   POLYPTIC_INSTALL_STATUS   (/run/polyptic/install-status)
#   POLYPTIC_MOUNTS_FILE      (/proc/mounts)       POLYPTIC_DEV_DIR   (/dev)
#   POLYPTIC_LIB_DIR          (this script's dir)  POLYPTIC_CONSOLE   (/dev/console)
#   POLYPTIC_NET_WAIT_SECONDS / POLYPTIC_NET_STEP_SECONDS  (depot pre-flight budget/beat, POL-168)
#   POLYPTIC_NODE_WAIT_TRIES  (how long to wait for the new partition device nodes)
set -eu

# The UEFI boot entry we own on an INSTALLED box. Matched exactly when pruning stale entries. The
# old offload entry (`Polyptic Netboot`) is pruned too — an install supersedes an offload — but
# fielded offloaded boxes that never install keep theirs (boot-order.sh watches both labels).
LABEL="Polyptic"
LABEL_LEGACY="Polyptic Netboot"

CMDLINE_FILE="${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}"
EFI_DIR="${POLYPTIC_EFI_DIR:-/sys/firmware/efi}"
SYS_BLOCK="${POLYPTIC_SYS_BLOCK:-/sys/class/block}"
RUN_DIR="${POLYPTIC_RUN_DIR:-/run/polyptic}"
REQUEST="${POLYPTIC_INSTALL_REQUEST:-$RUN_DIR/requests/install}"
STATUS_FILE="${POLYPTIC_INSTALL_STATUS:-$RUN_DIR/install-status}"
MOUNTS_FILE="${POLYPTIC_MOUNTS_FILE:-/proc/mounts}"
DEV_DIR="${POLYPTIC_DEV_DIR:-/dev}"
LIB_DIR="${POLYPTIC_LIB_DIR:-$(CDPATH= cd "$(dirname "$0")" && pwd)}"
CONSOLE="${POLYPTIC_CONSOLE:-/dev/console}"
NET_WAIT="${POLYPTIC_NET_WAIT_SECONDS:-60}"
NET_STEP="${POLYPTIC_NET_STEP_SECONDS:-5}"
NODE_TRIES="${POLYPTIC_NODE_WAIT_TRIES:-10}"
# Minimum target size in 512-byte sectors (~16 GiB): 1.5G ESP + 4+4G slots + 4G swap + real scratch.
MIN_SECTORS=33554432

base=""
token=""
mnt_esp=""
mnt_slot=""
mnt_medium=""
tmpd=""

# ─── Telling the operator what happened ─────────────────────────────────────────────────────────────
# The operator who clicked INSTALL is watching the console's progress dialog, so the status file is
# the primary channel; the journal is for later, and /boot/report for the activity feed.

# Announce one line: journal (stderr) + the console, best effort, never fatal. (No plymouth: this
# runs mid-session, the wall is rendering — there is no splash to write to.)
say() {
  printf 'install-to-disk: %s\n' "$1" >&2
  if [ -w "$CONSOLE" ]; then
    printf 'Polyptic install: %s\n' "$1" > "$CONSOLE" 2>/dev/null || true
  fi
  return 0
}

# One progress line: `<phase>|<percent>|<detail>`, appended (the console tails the whole file).
progress() {
  printf '%s|%s|%s\n' "$1" "$2" "$3" >> "$STATUS_FILE" 2>/dev/null || true
  chmod 0644 "$STATUS_FILE" 2>/dev/null || true
  return 0
}

# Minimal JSON string body: drop control characters, escape the two structural characters, clamp the
# length. Every `detail` here is composed by this script, so this is belt-and-braces, not parsing.
json_escape() {
  printf '%s' "$1" | tr -d '[:cntrl:]' | cut -c1-200 | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# POL-171 — append the install verdict to THIS boot's forensics log on the booted medium, so the
# on-stick trail carries the outcome too. boot-path.sh recorded the log's on-medium path in
# $RUN_DIR/forensics-file at boot. Best-effort end to end: a boot with no medium, no log, or a
# medium mounted elsewhere loses the appended line, never the install or its report.
append_forensics() {
  _ff="$RUN_DIR/forensics-file"
  [ -r "$_ff" ] || return 0
  IFS= read -r _rel < "$_ff" || return 0
  [ -n "$_rel" ] || return 0
  _fmnt="$(mktemp -d 2>/dev/null)" || return 0
  _fdev="$(sh "$LIB_DIR/find-boot-medium.sh" "$_fmnt" rw 2>/dev/null || true)"
  if [ -n "$_fdev" ] && [ -f "$_fmnt/$_rel" ]; then
    printf '\n--- install verdict ---\n%s\n' "$1" >> "$_fmnt/$_rel" 2>/dev/null || true
    sync 2>/dev/null || true
  fi
  umount "$_fmnt" 2>/dev/null || true
  rmdir "$_fmnt" 2>/dev/null || true
  return 0
}

# Record the outcome where the box (and, best effort, the control plane) can see it. `ok` is the
# JSON literal true|false; `code` the machine-readable reason; `detail` the human sentence.
report() {
  _ok="$1"; _code="$2"; _detail="$3"
  append_forensics "ok=$_ok code=$_code detail=$_detail"
  [ -n "$base" ] || return 0
  _mid=""
  if [ -r "$LIB_DIR/derive-machine-id.sh" ]; then
    _mid="$(sh "$LIB_DIR/derive-machine-id.sh" 2>/dev/null || true)"
  fi
  _body="$(printf '{"ok":%s,"code":"%s","detail":"%s","machineId":"%s"}' \
    "$_ok" "$(json_escape "$_code")" "$(json_escape "$_detail")" "$(json_escape "$_mid")")"
  # The enrolment token (when the fleet is gated) authenticates the report; it never reaches a log.
  set -- -fsS -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary "$_body"
  if [ -n "$token" ]; then set -- "$@" -H "Authorization: Bearer $token"; fi
  curl "$@" "$base/boot/report" >/dev/null 2>&1 || true
  return 0
}

# Abort: announce, mark the progress file failed, report, exit 1. NO hold (deliberately unlike
# offload.sh's POL-167 hold): the box is mid-session and the wall keeps rendering — the operator is
# watching the console dialog, and holding a running wall hostage would punish the room for a
# failed install. A failure leaves the target disk in whatever state it reached; the box itself is
# untouched (it runs from RAM) and the next boot is the same netboot as before.
fail() {
  say "INSTALL FAILED ($1): $2"
  progress failed - "$2"
  report false "$1" "$2"
  exit 1
}

cleanup() {
  for m in "$mnt_esp" "$mnt_slot" "$mnt_medium"; do
    [ -n "$m" ] || continue
    umount "$m" 2>/dev/null || true
    rmdir "$m" 2>/dev/null || true
  done
  [ -z "$tmpd" ] || rm -rf "$tmpd" 2>/dev/null || true
  return 0
}
trap cleanup EXIT

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

# ─── The request ────────────────────────────────────────────────────────────────────────────────────
# One line, `device=/dev/sdX`, written by the agent (kiosk user) into the root-owned tmpfs requests
# dir. Deleted UP FRONT, before any validation: a request that fails must never re-fire the path
# unit in a loop, and a stale request must never wipe a disk the operator chose for a previous box.
mkdir -p "$RUN_DIR" 2>/dev/null || true
: > "$STATUS_FILE" 2>/dev/null || true
chmod 0644 "$STATUS_FILE" 2>/dev/null || true
progress starting 0 "reading the install request"

[ -r "$REQUEST" ] || fail install-bad-target "no install request at $REQUEST (nothing was erased)"
req_line=""
IFS= read -r req_line < "$REQUEST" || true
rm -f "$REQUEST" 2>/dev/null || true
target=""
case "$req_line" in
  device=*) target="${req_line#device=}" ;;
esac
[ -n "$target" ] || fail install-bad-target "the install request did not name a device (expected device=/dev/sdX, got '$req_line'; nothing was erased)"

base="$(cmdline_value polyptic.base)"
token="$(cmdline_value polyptic.token)"
[ -n "$base" ] || fail no-base "the kernel cmdline carries no polyptic.base=, so there is no control plane to fetch the image from (nothing was erased)"
# GRUB wants the control-plane address as a bare host:port.
hostport="${base#http://}"; hostport="${hostport%%/*}"

# ─── Pre-flight: everything that can be checked BEFORE a single byte is written ─────────────────────

# UEFI-mode only: the install ends by registering a UEFI boot entry, which needs efivarfs. Same
# guards, same ordering lesson as offload.sh (POL-39/POL-58): probe the boot-entry tool FIRST, so a
# missing efibootmgr can never kill the script after the disk is already wiped.
[ -d "$EFI_DIR" ] || fail not-uefi "this box booted in legacy BIOS/CSM mode, which has no UEFI boot entries. Enable UEFI boot in firmware setup and install again (nothing was erased)"
if [ -d "$EFI_DIR/efivars" ] && ! mountpoint -q "$EFI_DIR/efivars" 2>/dev/null; then
  mount -t efivarfs efivarfs "$EFI_DIR/efivars" >/dev/null 2>&1 || true
fi
command -v efibootmgr >/dev/null 2>&1 \
  || fail no-efibootmgr "efibootmgr is missing from this image, so no UEFI boot entry can be registered (nothing was erased)"
efibootmgr >/dev/null 2>&1 \
  || fail no-efivars "the UEFI boot variables are unreadable (efivarfs is not mounted, or the firmware denies access), so no boot entry can be registered (nothing was erased)"

# Every tool the destructive path needs, checked before the destructive path starts.
for t in sgdisk wipefs mkfs.vfat mkfs.ext4 mkswap; do
  command -v "$t" >/dev/null 2>&1 \
    || fail install-no-tools "$t is missing from this image, so the disk cannot be prepared (nothing was erased)"
done

# EFI arch suffix (shim/grub binary names) + GRUB platform dir, from the RUNNING kernel (offload.sh
# pattern — dpkg is not guaranteed to reflect the firmware arch).
case "$(uname -m)" in
  x86_64)  efiarch=x64;  fbname=BOOTX64.EFI;  grubdir=x86_64-efi; debarch=amd64 ;;
  aarch64) efiarch=aa64; fbname=BOOTAA64.EFI; grubdir=arm64-efi;  debarch=arm64 ;;
  *) fail unsupported-arch "unsupported machine architecture '$(uname -m)'" ;;
esac

# ─── Validate the target. This disk is about to be WIPED — every "cannot" here is load-bearing. ─────
name="${target##*/}"
case "$target" in /dev/*) : ;; *) fail install-bad-target "'$target' is not a /dev path (nothing was erased)" ;; esac
[ -e "$DEV_DIR/$name" ] && [ -e "$SYS_BLOCK/$name" ] \
  || fail install-bad-target "$target does not exist on this box (nothing was erased)"
# A partition has a `partition` file in sysfs; a whole disk does not. INSTALL takes whole disks only.
[ ! -f "$SYS_BLOCK/$name/partition" ] \
  || fail install-bad-target "$target is a partition, not a whole disk. Name the disk itself (nothing was erased)"
# Removable media (the boot stick itself, a rescue drive) are never installed onto: the entry would
# point at a disk the operator is about to pull. Exactly the POL-58 symptom.
[ "$(cat "$SYS_BLOCK/$name/removable" 2>/dev/null || echo 0)" != "1" ] \
  || fail install-bad-target "$target is removable media. Install to an internal disk (nothing was erased)"
# Never the disk this box BOOTED from: wiping the medium under a running boot chain strands the box.
mnt_medium="$(mktemp -d)"
medium_dev="$(sh "$LIB_DIR/find-boot-medium.sh" "$mnt_medium" ro 2>/dev/null || true)"
medium_disk=""
if [ -n "$medium_dev" ]; then
  medium_disk="$(lsblk -no PKNAME "$medium_dev" 2>/dev/null | head -n1 || true)"
fi
if [ -n "$medium_disk" ] && [ "$medium_disk" = "$name" ]; then
  fail install-bad-target "$target carries the boot medium this box booted from (nothing was erased)"
fi
# Nothing on the target may be mounted anywhere: a mounted filesystem under a wipe is data loss the
# operator did not ask for, and the kernel would fight the re-read anyway. /proc/mounts always
# speaks real /dev paths, so the match is on the request's own /dev prefix (covers the disk AND its
# partitions).
if grep -q "^$target" "$MOUNTS_FILE" 2>/dev/null; then
  fail install-bad-target "$target (or a partition on it) is currently mounted. Unmount it and install again (nothing was erased)"
fi
# The layout needs ~14 GiB before scratch has any room at all; refuse small disks loudly.
sectors="$(cat "$SYS_BLOCK/$name/size" 2>/dev/null || echo 0)"
if [ "$sectors" -lt "$MIN_SECTORS" ] 2>/dev/null; then
  fail install-disk-too-small "$target is $(( sectors / 2048 )) MiB but the install needs at least 16 GiB (ESP + two 4 GiB image slots + 4 GiB swap + scratch). Nothing was erased"
fi

# Partition node name: sda → sda1, nvme0n1 → nvme0n1p1 (kernel convention: disks ending in a digit
# get a `p` separator).
part_node() {
  case "$name" in
    *[0-9]) printf '%s/%sp%s' "$DEV_DIR" "$name" "$1" ;;
    *)      printf '%s/%s%s'  "$DEV_DIR" "$name" "$1" ;;
  esac
}

# ─── Depot pre-flight (POL-168): WAIT for the depot before deciding anything destructive ────────────
# A fresh image is fetched from the depot, never copied from RAM — so the depot must be reachable
# BEFORE the wipe, or a transient network wobble would leave a wiped, OS-less disk.
depot_probe() {
  curl -fsS -m 5 -o /dev/null "$base/dist/boot/shim$efiarch.efi" 2>/dev/null
}
probe_rc=1
waited=0
while :; do
  if depot_probe; then probe_rc=0; break; else probe_rc=$?; fi
  if [ "$waited" -ge "$NET_WAIT" ]; then break; fi
  say "Waiting for the network to reach $hostport ..."
  sleep "$NET_STEP" || true
  if [ "$NET_STEP" -gt 0 ] 2>/dev/null; then waited=$((waited + NET_STEP)); else waited=$((waited + 1)); fi
done
if [ "$probe_rc" != 0 ]; then
  if [ "$probe_rc" = 22 ]; then
    http_code="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$base/dist/boot/shim$efiarch.efi" 2>/dev/null || true)"
    fail no-loaders "the depot at $hostport answered HTTP ${http_code:-error} for shim$efiarch.efi (nothing was erased)"
  fi
  fail depot-unreachable "could not reach the depot at $hostport after ${waited}s (curl exit $probe_rc). Check DNS and the route to the control plane (nothing was erased)"
fi

# ─── Resolve a FRESH image id, per machine (POL-105), before the wipe ───────────────────────────────
mid=""
if [ -r "$LIB_DIR/derive-machine-id.sh" ]; then
  mid="$(sh "$LIB_DIR/derive-machine-id.sh" 2>/dev/null || true)"
fi
murl="$base/dist/image/$debarch/manifest.json"
[ -z "$mid" ] || murl="$murl?machineId=$mid"
manifest="$(curl -fsS -m 10 "$murl" 2>/dev/null || true)"
imgid="$(printf '%s' "$manifest" | sed -n 's/.*"imageId":"\([^"]*\)".*/\1/p')"
[ -n "$imgid" ] \
  || fail install-no-image "the depot at $hostport serves no $debarch image manifest, so there is nothing to install (nothing was erased)"
bsrc="$base/dist/image/$debarch/builds/$imgid"

# The downloads keep their own retries (offload.sh's fetch_loader): the pre-flight proved the depot
# once, but a flapping switch can still bite mid-transfer, and a retry is free next to a truck roll.
fetch() { # <url> <out> [max-time]
  curl -fsSL --retry 5 --retry-all-errors --retry-delay 2 --connect-timeout 5 -m "${3:-120}" -o "$2" "$1"
}
# sha256 of one file, compared against the depot build's SHA256SUMS line for <name> (update-poll.sh
# pattern).
sum_ok() { # <file> <name> <sums-file>
  want="$(awk -v n="$2" '$2==n {print $1}' "$3" | head -n1)"
  [ -n "$want" ] || return 1
  got="$( (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{print $1}')"
  [ "$got" = "$want" ]
}

# The small artifacts land on tmpfs first, so a failed fetch never leaves a half-written disk. The
# LEAN `initrd` is deliberate (not initrd-wifi): a disk boot needs no network in the initramfs, and
# any Wi-Fi credentials ride the ESP for the REAL root's polyptic-wifi.service exactly as they did
# on the USB medium.
tmpd="$(mktemp -d)"
progress fetching 15 "downloading image $imgid from $hostport"
say "downloading image $imgid ..."
fetch "$bsrc/vmlinuz"    "$tmpd/vmlinuz" \
  || fail install-write-failed "could not download vmlinuz for image $imgid from $hostport (nothing was erased)"
fetch "$bsrc/initrd"     "$tmpd/initrd" \
  || fail install-write-failed "could not download the initrd for image $imgid from $hostport (nothing was erased)"
fetch "$bsrc/SHA256SUMS" "$tmpd/SHA256SUMS" 30 \
  || fail install-write-failed "could not download SHA256SUMS for image $imgid from $hostport (nothing was erased)"
sum_ok "$tmpd/vmlinuz" vmlinuz "$tmpd/SHA256SUMS" \
  || fail install-write-failed "vmlinuz for image $imgid failed its sha256 check (nothing was erased)"
sum_ok "$tmpd/initrd" initrd "$tmpd/SHA256SUMS" \
  || fail install-write-failed "the initrd for image $imgid failed its sha256 check (nothing was erased)"

# Fetch the signed loaders TOKENLESSLY from the ungated depot (offload.sh's fetch_loader pattern) —
# still before the wipe: everything the install needs from the network is in hand before the first
# destructive write.
fetch "$base/dist/boot/shim$efiarch.efi" "$tmpd/shim.efi" \
  || fail no-loaders "the depot at $hostport would not serve shim$efiarch.efi (nothing was erased)"
fetch "$base/dist/boot/grub$efiarch.efi" "$tmpd/grub.efi" \
  || fail no-loaders "the depot at $hostport would not serve grub$efiarch.efi (nothing was erased)"

# ─── THE POINT OF NO RETURN: wipe + partition + mkfs ────────────────────────────────────────────────
say "wiping $target and laying down the Polyptic disk layout ..."
progress wiping 25 "erasing $target"
sgdisk --zap-all "$target" >/dev/null 2>&1 \
  || fail install-write-failed "could not erase the partition table on $target"
wipefs -a "$target" >/dev/null 2>&1 || true

progress partitioning 30 "creating the ESP, A/B slots, swap and scratch on $target"
# Types: ef00 = ESP, 8300 = Linux filesystem, 8200 = Linux swap. Partition 5 takes the rest.
sgdisk \
  -n 1:0:+1536M -t 1:ef00 -c 1:POLYPTIC-ESP \
  -n 2:0:+4G    -t 2:8300 -c 2:POLYPTIC-A \
  -n 3:0:+4G    -t 3:8300 -c 3:POLYPTIC-B \
  -n 4:0:+4G    -t 4:8200 -c 4:POLYPTIC-SWAP \
  -n 5:0:0      -t 5:8300 -c 5:POLYPTIC-SCRATCH \
  "$target" >/dev/null 2>&1 \
  || fail install-write-failed "could not partition $target"
partprobe "$target" >/dev/null 2>&1 || true
udevadm settle >/dev/null 2>&1 || true
# The kernel re-reads the table asynchronously; wait (bounded) for the nodes to appear rather than
# racing mkfs against udev.
tries=0
while [ ! -e "$(part_node 5)" ] && [ "$tries" -lt "$NODE_TRIES" ]; do
  sleep 1 || true
  tries=$((tries + 1))
done
[ -e "$(part_node 1)" ] && [ -e "$(part_node 5)" ] \
  || fail install-write-failed "the new partitions on $target never appeared as device nodes"

progress partitioning 40 "formatting the new partitions"
# The ESP's FAT volume label is POLYPTIC-BT — the SAME label as the USB medium (find-boot-medium's
# by-label fast path), because the ESP is the boot medium from now on. POLYPTIC-SCRATCH is exactly
# 16 characters, ext4's label maximum — keep it exact.
mkfs.vfat -F 32 -n POLYPTIC-BT "$(part_node 1)" >/dev/null 2>&1 \
  || fail install-write-failed "could not format the ESP on $target"
mkfs.ext4 -q -F -L POLYPTIC-A "$(part_node 2)" >/dev/null 2>&1 \
  || fail install-write-failed "could not format slot A on $target"
mkfs.ext4 -q -F -L POLYPTIC-B "$(part_node 3)" >/dev/null 2>&1 \
  || fail install-write-failed "could not format slot B on $target"
# The swap header written here is ceremonial — /etc/crypttab re-keys and re-mkswaps the partition
# with an ephemeral random key on every boot — but a formatted partition is self-describing to any
# tool that looks before the first boot.
mkswap "$(part_node 4)" >/dev/null 2>&1 \
  || fail install-write-failed "could not format the swap partition on $target"
mkfs.ext4 -q -F -L POLYPTIC-SCRATCH "$(part_node 5)" >/dev/null 2>&1 \
  || fail install-write-failed "could not format the scratch partition on $target"

# ─── Slot A: the squashfs, streamed straight onto the disk ──────────────────────────────────────────
# ~1 GiB, fetched AFTER the mkfs so it can stream to disk instead of doubling up in RAM (this box's
# whole root already lives in RAM). Fetched as .new then renamed after the sha256 check, so a torn
# transfer can never look like an installed image.
mnt_slot="$(mktemp -d)"
mount "$(part_node 2)" "$mnt_slot" \
  || fail install-write-failed "could not mount slot A on $target"
mkdir -p "$mnt_slot/LiveOS"
progress fetching 50 "downloading the operating system image ($imgid)"
fetch "$bsrc/rootfs.squashfs" "$mnt_slot/LiveOS/squashfs.img.new" 1800 \
  || fail install-write-failed "could not download rootfs.squashfs for image $imgid from $hostport"
progress verifying 65 "verifying the operating system image"
sum_ok "$mnt_slot/LiveOS/squashfs.img.new" rootfs.squashfs "$tmpd/SHA256SUMS" \
  || fail install-write-failed "rootfs.squashfs for image $imgid failed its sha256 check"
mv "$mnt_slot/LiveOS/squashfs.img.new" "$mnt_slot/LiveOS/squashfs.img" \
  || fail install-write-failed "could not commit the operating system image onto slot A"
sync 2>/dev/null || true
umount "$mnt_slot"; rmdir "$mnt_slot" 2>/dev/null || true; mnt_slot=""

# ─── The ESP: loaders, kernel pair, credentials, theme, marker, GRUB config ─────────────────────────
progress writing-loader 75 "installing the signed boot loaders"
mnt_esp="$(mktemp -d)"
mount "$(part_node 1)" "$mnt_esp" \
  || fail install-write-failed "could not mount the new ESP on $target"

put() { mkdir -p "$(dirname "$2")"; cp "$1" "$2"; chmod 0644 "$2"; }

# shim resolves its second stage BY NAME from ITS OWN directory, so shim + grub land side by side.
# The EFI/BOOT fallback pair is written UNCONDITIONALLY — unlike offload's shared ESP, this disk is
# entirely ours, and the fallback path is the only one some cheap firmware ever looks at.
put "$tmpd/shim.efi" "$mnt_esp/EFI/polyptic/shim$efiarch.efi"
put "$tmpd/grub.efi" "$mnt_esp/EFI/polyptic/grub$efiarch.efi"
put "$tmpd/shim.efi" "$mnt_esp/EFI/BOOT/$fbname"
put "$tmpd/grub.efi" "$mnt_esp/EFI/BOOT/grub$efiarch.efi"

# Slot A's kernel pair (LEAN initrd — no network needed to boot from disk). Slot B's dir is created
# empty so update-poll's staging has its shape waiting.
mkdir -p "$mnt_esp/polyptic/boot/$debarch/a" "$mnt_esp/polyptic/boot/$debarch/b"
cp "$tmpd/vmlinuz" "$mnt_esp/polyptic/boot/$debarch/a/vmlinuz"
cp "$tmpd/initrd"  "$mnt_esp/polyptic/boot/$debarch/a/initrd"

# Wi-Fi credentials, certs and the splash theme travel from the booted medium when present —
# best-effort, the install succeeds without them. Theme copies only a COMPLETE set, bitmaps first
# and theme.txt last (POL-87/POL-130): a theme missing a bitmap paints "error: null src bitmap" on
# a keyboard-less screen, so an incomplete source set must not propagate.
if [ -n "$medium_dev" ]; then
  if [ -f "$mnt_medium/polyptic/wifi.conf" ]; then
    cp "$mnt_medium/polyptic/wifi.conf" "$mnt_esp/polyptic/wifi.conf" 2>/dev/null || true
  fi
  if [ -d "$mnt_medium/polyptic/certs" ]; then
    mkdir -p "$mnt_esp/polyptic/certs"
    cp -R "$mnt_medium/polyptic/certs/." "$mnt_esp/polyptic/certs/" 2>/dev/null || true
  fi
  if [ -f "$mnt_medium/polyptic/boot/theme/theme.txt" ] && [ -s "$mnt_medium/polyptic/boot/theme/logo.png" ] \
     && [ -s "$mnt_medium/polyptic/boot/theme/bg.png" ]; then
    mkdir -p "$mnt_esp/polyptic/boot/theme"
    cp "$mnt_medium/polyptic/boot/theme/logo.png"  "$mnt_esp/polyptic/boot/theme/logo.png" 2>/dev/null \
      && cp "$mnt_medium/polyptic/boot/theme/bg.png" "$mnt_esp/polyptic/boot/theme/bg.png" 2>/dev/null \
      && cp "$mnt_medium/polyptic/boot/theme/theme.txt" "$mnt_esp/polyptic/boot/theme/theme.txt" 2>/dev/null \
      || true
  fi
fi
umount "$mnt_medium" 2>/dev/null || true; rmdir "$mnt_medium" 2>/dev/null || true; mnt_medium=""

# The marker that makes this ESP *be* the boot medium from now on (find-boot-medium proves identity
# by this file's content-presence): forensics, theme heal and update-poll's staging all just work.
printf 'disk-esp-%s\n' "$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo unknown)" > "$mnt_esp/polyptic/medium-id"

# The menuless disk GRUB config, committed at both paths grubnet's memdisk bootstrap probes (the
# arch dir wins; the plain path covers any future probe order — offload.sh's lesson, and here the
# whole disk is ours so there is no foreign config to defer to).
mkdir -p "$mnt_esp/grub/$grubdir"
sh "$LIB_DIR/render-disk-grub.sh" "$debarch" a "$hostport" "$imgid" "$token" > "$mnt_esp/grub/$grubdir/grub.cfg" \
  || fail install-write-failed "could not render the disk boot menu"
cp "$mnt_esp/grub/$grubdir/grub.cfg" "$mnt_esp/grub/grub.cfg"

sync 2>/dev/null || true
umount "$mnt_esp"; rmdir "$mnt_esp" 2>/dev/null || true; mnt_esp=""

# ─── Own the boot order — attempt, verify, REPORT, but never fail on it (POL-178) ───────────────────
# Prune stale entries of OURS (both labels — an install supersedes an offload), create the `Polyptic`
# entry fresh against the disk we actually wrote, put it first best-effort, then re-read NVRAM.
#
# POL-178 — post-write NVRAM misbehaviour DOWNGRADES to a warning; it no longer fails the install.
# A field Dell accepted the entry and then dropped it on re-read, and a fully written, verified disk
# was declared FAILED — yet that box would have booted anyway: this installer writes the
# removable-media fallback pair at EFI/BOOT/BOOT<arch>.EFI unconditionally (the disk is entirely
# ours), which is the path firmware walks when NVRAM names nothing bootable. Post-wipe there is no
# competing OS on this disk — stale entries point at nothing and the firmware falls through — and
# boot-order.sh (POL-115) re-asserts any later drift. D60's never-claim-silently survives: NVRAM is
# still re-read and the outcome is REPORTED truthfully; it just no longer blocks a bootable install.
# (The PRE-WIPE not-uefi/no-efibootmgr/no-efivars preflights stay hard failures on purpose: aborting
# before the wipe costs nothing, and a box whose NVRAM cannot be read at all is worth stopping on.)
progress boot-entry 90 "registering the UEFI boot entry"

entries_for() { # <label> → entry numbers whose label is exactly <label>
  efibootmgr 2>/dev/null | sed -n "s/^Boot\([0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]\)[* ] $1\$/\1/p"
}
boot_order() { efibootmgr 2>/dev/null | sed -n 's/^BootOrder: //p' | head -n1; }

for old in $(entries_for "$LABEL"); do efibootmgr -q -B -b "$old" >/dev/null 2>&1 || true; done
# The legacy offload entry is superseded: from now on this box boots its own disk, and netboot is
# reached through the disk GRUB's fallback entry, not through a second NVRAM entry.
for old in $(entries_for "$LABEL_LEGACY"); do efibootmgr -q -B -b "$old" >/dev/null 2>&1 || true; done

# When the firmware misbehaves, this holds the reason sentence; empty means the entry verifiably exists.
nvram_warn=""
if efibootmgr -q -c -d "$target" -p 1 -L "$LABEL" -l "\\EFI\\polyptic\\shim$efiarch.efi" >/dev/null 2>&1; then
  entry="$(entries_for "$LABEL" | head -n1)"
  if [ -n "$entry" ]; then
    # Best-effort: put our entry first, keeping every other entry behind in its existing order. The
    # RESULT is deliberately not asserted (POL-178): the old boot-order-not-first gate is gone —
    # post-wipe nothing else on this disk competes, and boot-order.sh handles later drift.
    order="$(boot_order)"
    rest="$(printf '%s' "$order" | tr ',' '\n' | awk -v n="$entry" 'NF && toupper($0) != toupper(n)' | tr '\n' ',' | sed 's/,$//')"
    if [ -n "$rest" ]; then efibootmgr -q -o "$entry,$rest" >/dev/null 2>&1 || true
    else efibootmgr -q -o "$entry" >/dev/null 2>&1 || true; fi
    # The final re-read asserts EXISTENCE only — nothing is claimed that was not verified.
    [ -n "$(entries_for "$LABEL" | head -n1)" ] \
      || nvram_warn="the firmware did not keep the '$LABEL' boot entry"
  else
    nvram_warn="the firmware accepted the '$LABEL' boot entry, then dropped it"
  fi
else
  nvram_warn="the firmware refused the '$LABEL' boot entry"
fi

if [ -n "$nvram_warn" ]; then
  # Success WITH a warning, never a failure: the disk is fully written and verified, and the
  # unconditional EFI/BOOT fallback loader makes it bootable without any NVRAM entry. The server
  # renders `installed-no-nvram-entry` as a warn line; ok=true because the install itself succeeded.
  detail="installed image $imgid on $target, but $nvram_warn — the box boots via its default loader path (EFI/BOOT/$fbname); if it does not come up, add \\EFI\\polyptic\\shim$efiarch.efi in firmware setup, named exactly '$LABEL'"
  report true installed-no-nvram-entry "$detail"
  progress done 100 "$detail"
  say "installed image $imgid on $target ($nvram_warn — the EFI/BOOT fallback loader carries the boot)."
  exit 0
fi

detail="installed image $imgid on $target (ESP + A/B slots + encrypted swap + scratch) and registered the '$LABEL' UEFI boot entry. Netboot remains the recovery path"
report true installed "$detail"
progress done 100 "$detail"
say "installed image $imgid on $target. This screen boots from its own disk after the next restart."
exit 0
