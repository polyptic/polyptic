#!/bin/sh
# One-shot OFFLOAD (POL-33/D47, hardened by POL-58/D60): relocate the SIGNED loader pair (the POINTER,
# not the OS) onto THIS box's existing EFI System Partition + make it the firmware's first boot option,
# so it self-boots the identical HTTP flow on every power-on with no dongle attached. The pair is
# Ubuntu's Microsoft-signed shim + the Canonical-signed network GRUB, the same chain as the dongle, so
# Secure Boot stays ON. Triggered by `polyptic.offload=1` on the kernel cmdline, which the server's
# /boot/grub.cfg tags onto its "Polyptic (Offload Bootloader)" entry. Runs from the booted live image
# via polyptic-offload.service (ConditionKernelCommandLine=polyptic.offload=1).
#
# HARD RULE: never repartition, format, or wipe. This ONLY (a) drops shim+GRUB into our own subdir on
# the EXISTING ESP, (b) writes the stage-1 config at paths it owns (refusing to touch a foreign file),
# and (c) rewrites the UEFI BootOrder so our entry leads. The full live OS still streams from the
# control plane into RAM every boot; what lands on disk is the ~few-MB loader pair, never an OS,
# identity, or state. The box's previous OS stays on disk, untouched, and remains bootable from the
# firmware's boot menu. UEFI-only.
#
# POL-58: the first field attempt "claimed to offload" and then booted straight back into the box's old
# Ubuntu. Every abort path here used to exit into a journal nobody reads, and the unit mapped exit 1
# onto success — so a box that never got a boot entry looked identical to one that did. Three changes
# follow from that: (1) NOTHING is claimed that was not verified — the UEFI entry is read BACK and
# BootOrder is asserted to lead with it; (2) every outcome, good or bad, is announced on the screen the
# operator is standing in front of AND posted to the control plane's activity feed; (3) the ESP is
# chosen deliberately (never "the first one lsblk printed") — removable media are excluded, and when a
# box has several ESPs the one the firmware already boots from wins, with `polyptic.offload_disk=` as
# the operator's override and a loud abort rather than a coin toss.
#
# PURE-ish + TESTABLE: every input path and every external command is overridable/stubbable, so the
# whole decision tree runs against fixtures off-box (deploy/live/test/offload.test.sh).
#   POLYPTIC_CMDLINE_FILE   (/proc/cmdline)      POLYPTIC_EFI_DIR    (/sys/firmware/efi)
#   POLYPTIC_SYS_BLOCK      (/sys/class/block)   POLYPTIC_RUN_DIR    (/run/polyptic)
#   POLYPTIC_OFFLOAD_STAMP  (/var/lib/polyptic/offloaded)
#   POLYPTIC_LIB_DIR        (this script's dir)  POLYPTIC_CONSOLE    (/dev/console)
#   POLYPTIC_HOLD_SECONDS / POLYPTIC_HOLD_SECONDS_OK   (how long a message stays on screen)
set -eu

# The ESP GUID that marks an EFI System Partition in a GPT table.
ESP_GUID="c12a7328-f81f-11d2-ba4b-00a0c93ec93b"
# The UEFI boot entry we own. Matched exactly when pruning stale entries, so never reuse this label.
LABEL="Polyptic Netboot"

STAMP="${POLYPTIC_OFFLOAD_STAMP:-/var/lib/polyptic/offloaded}"
CMDLINE_FILE="${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}"
EFI_DIR="${POLYPTIC_EFI_DIR:-/sys/firmware/efi}"
SYS_BLOCK="${POLYPTIC_SYS_BLOCK:-/sys/class/block}"
RUN_DIR="${POLYPTIC_RUN_DIR:-/run/polyptic}"
LIB_DIR="${POLYPTIC_LIB_DIR:-$(CDPATH= cd "$(dirname "$0")" && pwd)}"
CONSOLE="${POLYPTIC_CONSOLE:-/dev/console}"
HOLD_BAD="${POLYPTIC_HOLD_SECONDS:-15}"
HOLD_OK="${POLYPTIC_HOLD_SECONDS_OK:-6}"
STATUS_FILE="$RUN_DIR/bootloader-status"

base=""
token=""
mnt=""

# ─── Telling the operator what happened ─────────────────────────────────────────────────────────────
# Whoever runs an offload is standing at the box watching the splash, so the screen is the primary
# channel; the journal is for later, and the control plane is for the operator who is not in the room.

# Announce one line: journal (stderr) + the boot splash + the console, best effort, never fatal.
say() {
  printf 'offload: %s\n' "$1" >&2
  if command -v plymouth >/dev/null 2>&1; then
    plymouth message --text="Polyptic: $1" >/dev/null 2>&1 || true
  fi
  if [ -w "$CONSOLE" ]; then
    printf 'Polyptic offload: %s\n' "$1" > "$CONSOLE" 2>/dev/null || true
  fi
  return 0
}

# Leave a message on screen long enough to be read before greetd paints the kiosk over it.
hold() {
  [ "$1" -gt 0 ] 2>/dev/null || return 0
  sleep "$1" || true
  return 0
}

# Copy one file onto the ESP, creating its directory. `install -D` would say this in one word, but
# BSD/macOS install has no -D and the whole decision tree is exercised off-box on macOS.
put() {
  mkdir -p "$(dirname "$2")"
  cp "$1" "$2"
  chmod 0644 "$2"
}

# Minimal JSON string body: drop control characters, escape the two structural characters, clamp the
# length. Every `detail` here is composed by this script, so this is belt-and-braces, not parsing.
json_escape() {
  printf '%s' "$1" | tr -d '[:cntrl:]' | cut -c1-200 | sed 's/\\/\\\\/g; s/"/\\"/g'
}

# Record the outcome where the box (and, best effort, the control plane) can see it. `ok` is the JSON
# literal true|false; `code` is the machine-readable reason; `detail` the human sentence.
report() {
  _ok="$1"; _code="$2"; _detail="$3"
  mkdir -p "$RUN_DIR" 2>/dev/null || true
  printf 'ok=%s\ncode=%s\ndetail=%s\n' "$_ok" "$_code" "$_detail" > "$STATUS_FILE" 2>/dev/null || true

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

# Abort: announce, report, hold the message on screen, exit non-zero. Nothing partial is left behind
# that a later boot would mistake for a finished install (the stamp is written only on success).
fail() {
  say "BOOTLOADER INSTALL FAILED — $2"
  report false "$1" "$2"
  hold "$HOLD_BAD"
  exit 1
}

cleanup() {
  if [ -n "$mnt" ] && mountpoint -q "$mnt" 2>/dev/null; then umount "$mnt" 2>/dev/null || true; fi
  if [ -n "$mnt" ]; then rmdir "$mnt" 2>/dev/null || true; fi
  rm -f "${tmp_shim:-}" "${tmp_grub:-}" "${tmp_cfg:-}" 2>/dev/null || true
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

# ─── Pre-flight: everything that can be checked BEFORE a single byte is written ──────────────────────

base="$(cmdline_value polyptic.base)"
token="$(cmdline_value polyptic.token)"
want_disk="$(cmdline_value polyptic.offload_disk)"
[ -n "$base" ] || fail no-base "the kernel cmdline carries no polyptic.base=, so there is no control plane to fetch the signed loaders from"
# GRUB wants the control-plane address as a bare host:port.
hostport="${base#http://}"; hostport="${hostport%%/*}"

# UEFI-mode only: efibootmgr needs efivarfs. A BIOS/CSM boot has no NVRAM boot entries to add, and a
# box whose existing OS was installed in legacy mode lands here — worth saying out loud, because the
# fix is a firmware setting, not a Polyptic one.
[ -d "$EFI_DIR" ] || fail not-uefi "this box booted in legacy BIOS/CSM mode, which has no UEFI boot entries. Enable UEFI boot in firmware setup and install again"
# efivarfs carries the boot variables; systemd usually mounts it, but a live root is not guaranteed to.
if [ -d "$EFI_DIR/efivars" ] && ! mountpoint -q "$EFI_DIR/efivars" 2>/dev/null; then
  mount -t efivarfs efivarfs "$EFI_DIR/efivars" >/dev/null 2>&1 || true
fi
# Pre-flight the boot-entry tool BEFORE touching the ESP: with `set -eu` a missing efibootmgr used to
# kill the script AFTER the loaders were installed but BEFORE the entry existed — a half-offload that
# looks done and never boots (POL-39). The image build ships efibootmgr; this guard keeps the failure
# loud and early if it is ever dropped again.
command -v efibootmgr >/dev/null 2>&1 \
  || fail no-efibootmgr "efibootmgr is missing from this image, so no UEFI boot entry can be registered (nothing was written)"
efibootmgr >/dev/null 2>&1 \
  || fail no-efivars "the UEFI boot variables are unreadable (efivarfs is not mounted, or the firmware denies access), so no boot entry can be registered (nothing was written)"

# EFI arch suffix (shim/grub binary names) + GRUB platform dir, from the RUNNING kernel; dpkg is not
# guaranteed to reflect the firmware arch. `grubdir` is the arch subdir grubnet's memdisk bootstrap
# sources FIRST (before the plain $prefix/grub.cfg), so writing our config there always wins over a
# foreign lower-precedence config left on a repurposed ESP.
case "$(uname -m)" in
  x86_64)  efiarch=x64;  fbname=BOOTX64.EFI;  grubdir=x86_64-efi ;;
  aarch64) efiarch=aa64; fbname=BOOTAA64.EFI; grubdir=arm64-efi  ;;
  *) fail unsupported-arch "unsupported machine architecture '$(uname -m)'" ;;
esac

# ─── Choose the ESP, deliberately ───────────────────────────────────────────────────────────────────
# `lsblk` order is kernel enumeration order, which on a box with a USB stick in it and two internal
# disks means "the first ESP" is a coin toss. Never guess: filter, score, and abort if still ambiguous.

# Every partition that carries the ESP type GUID, as "<part> <disk>" lines.
esp_partitions() {
  lsblk -rno NAME,PARTTYPE,PKNAME 2>/dev/null \
    | awk -v g="$ESP_GUID" 'tolower($2)==g && $3!="" {print $1" "$3}'
}

# Removable/hot-plugged media (the Polyptic USB stick itself, a rescue drive) must never be offloaded
# onto: the entry would point at a disk the operator is about to pull, and the box would silently fall
# through to whatever it booted before. Exactly the POL-58 symptom.
is_removable() {
  [ "$(cat "$SYS_BLOCK/$1/removable" 2>/dev/null || echo 0)" = "1" ]
}

# How many of the firmware's existing boot entries point at this partition. An ESP the firmware already
# knows how to boot from is, on a multi-disk box, the one the operator means.
firmware_affinity() {
  _uuid="$(lsblk -rno PARTUUID "/dev/$1" 2>/dev/null || true)"
  [ -n "$_uuid" ] || { echo 0; return 0; }
  efibootmgr -v 2>/dev/null | grep -ic "$_uuid" || echo 0
}

candidates=""
skipped_removable=""
for line in $(esp_partitions | tr ' ' ':'); do
  part="${line%%:*}"; disk="${line#*:}"
  if [ -n "$want_disk" ] && [ "/dev/$disk" != "$want_disk" ] && [ "$disk" != "$want_disk" ]; then continue; fi
  if is_removable "$disk"; then skipped_removable="$skipped_removable /dev/$disk"; continue; fi
  candidates="$candidates $part:$disk"
done
candidates="${candidates# }"

if [ -z "$candidates" ]; then
  if [ -n "$want_disk" ]; then
    fail no-esp "no EFI System Partition on $want_disk (nothing was erased)"
  elif [ -n "$skipped_removable" ]; then
    fail no-esp "the only EFI System Partition found is on removable media ($(echo "$skipped_removable" | sed 's/^ //')), which would leave the box unbootable once the stick is pulled. Install to an internal disk (nothing was erased)"
  fi
  fail no-esp "no EFI System Partition found on any internal disk — this box's existing OS was probably installed in legacy BIOS mode, which cannot chain a signed loader. Nothing was erased"
fi

# One candidate is the overwhelmingly common case. Several means a dual-boot / multi-disk box: prefer
# the ESP the firmware itself already boots from, and if that is still a tie, stop and ask.
esp_part=""
if [ "$(printf '%s\n' $candidates | wc -l | tr -d ' ')" = "1" ]; then
  esp_part="${candidates%%:*}"
else
  best_score=-1; best_count=0; best=""
  for c in $candidates; do
    p="${c%%:*}"
    score="$(firmware_affinity "$p" | head -n1)"
    if [ "$score" -gt "$best_score" ]; then best_score="$score"; best="$p"; best_count=1
    elif [ "$score" -eq "$best_score" ]; then best_count=$((best_count + 1)); fi
  done
  if [ "$best_count" != "1" ] || [ "$best_score" -le 0 ]; then
    fail ambiguous-esp "this box has $(printf '%s\n' $candidates | wc -l | tr -d ' ') EFI System Partitions and none is clearly the one the firmware boots. Re-run the install with polyptic.offload_disk=/dev/<disk> on the kernel command line (nothing was erased)"
  fi
  esp_part="$best"
  say "several EFI System Partitions; choosing /dev/$esp_part, the one this firmware already boots from"
fi

disk="/dev/$(lsblk -no PKNAME "/dev/$esp_part" 2>/dev/null | head -n1)"
partnum="$(cat "$SYS_BLOCK/$esp_part/partition" 2>/dev/null || true)"
[ -n "$partnum" ] || fail no-partnum "cannot read the partition number of /dev/$esp_part (nothing was erased)"

# ─── Fetch the signed loaders (TOKENLESS, from the ungated depot: the box has no operator session) ───

tmp_shim="$(mktemp)"; tmp_grub="$(mktemp)"; tmp_cfg="$(mktemp)"
if ! curl -fsSL "$base/dist/boot/shim$efiarch.efi" -o "$tmp_shim" \
|| ! curl -fsSL "$base/dist/boot/grub$efiarch.efi" -o "$tmp_grub"; then
  fail no-loaders "could not download the signed loaders from $base/dist/boot/ (nothing was erased)"
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

# ─── Write to the ESP (add-only) ────────────────────────────────────────────────────────────────────

mnt="$(mktemp -d)"
mount "/dev/$esp_part" "$mnt" || fail mount-failed "cannot mount the EFI System Partition /dev/$esp_part (nothing was erased)"

# A file at one of OUR paths that lacks the marker belongs to someone else and is NEVER clobbered.
ours_or_absent() {
  [ ! -f "$1" ] || grep -q '^# polyptic-offload$' "$1"
}

# grubnet's baked-in prefix is /grub ON THE DEVICE IT LOADED FROM; it will NOT read a config beside the
# binaries, so the stage-1 config must sit under the ESP's /grub. Its memdisk bootstrap probes
# $prefix/$grubdir/grub.cfg BEFORE the plain $prefix/grub.cfg, so the arch path is the one that wins
# over a foreign lower-precedence config; we write the plain path too (when free) so the config is
# found whichever probe order a future signed grubnet uses.
cfg_dst="$mnt/grub/$grubdir/grub.cfg"
cfg_alt="$mnt/grub/grub.cfg"
ours_or_absent "$cfg_dst" \
  || fail foreign-grub-cfg "$cfg_dst on /dev/$esp_part is a GRUB config Polyptic did not write; refusing to overwrite it (nothing was changed)"

# Drop the pair into our own subdir, leaving everything else untouched. shim resolves its second stage
# BY NAME from ITS OWN directory, so shim + grub must land side by side.
put "$tmp_shim" "$mnt/EFI/polyptic/shim$efiarch.efi"
put "$tmp_grub" "$mnt/EFI/polyptic/grub$efiarch.efi"
put "$tmp_cfg"  "$cfg_dst"
if ours_or_absent "$cfg_alt"; then put "$tmp_cfg" "$cfg_alt"; fi

# The removable-media fallback path (\EFI\BOOT\BOOT<arch>.EFI) is what firmware boots when it has no
# usable NVRAM entry — a real state on boxes that lose their boot variables, and the only path some
# cheap firmware ever looks at. Claim it ONLY when it is free: an existing loader there belongs to the
# box's previous OS, and silently replacing another vendor's default loader is precisely the kind of
# destructive surprise this flow promises not to spring.
fallback="no"
if [ ! -e "$mnt/EFI/BOOT/$fbname" ] && [ ! -e "$mnt/EFI/BOOT/grub$efiarch.efi" ]; then
  put "$tmp_shim" "$mnt/EFI/BOOT/$fbname"
  put "$tmp_grub" "$mnt/EFI/BOOT/grub$efiarch.efi"
  fallback="yes"
fi

umount "$mnt"; rmdir "$mnt"; mnt=""

# ─── Own the boot order, then PROVE it ──────────────────────────────────────────────────────────────
# `efibootmgr -c` prepends to BootOrder, but a box that has been offloaded before already carries an
# entry (possibly pointing at a disk that has since moved) and would be skipped. Prune ours, create one
# fresh against the ESP we actually wrote, then assert the firmware really persisted it — NVRAM can be
# full, read-only, or quietly ignored, and that is the difference between "installed" and the POL-58
# box that booted straight back into its old Ubuntu.

# Boot entry numbers whose label is exactly ours. efibootmgr prints `Boot0003* <label>` (`*` = active).
our_entries() {
  efibootmgr 2>/dev/null | sed -n "s/^Boot\([0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]\)[* ] $LABEL\$/\1/p"
}
boot_order() { efibootmgr 2>/dev/null | sed -n 's/^BootOrder: //p' | head -n1; }

for old in $(our_entries); do efibootmgr -q -B -b "$old" >/dev/null 2>&1 || true; done
efibootmgr -q -c -d "$disk" -p "$partnum" -L "$LABEL" -l "\\EFI\\polyptic\\shim$efiarch.efi" >/dev/null 2>&1 \
  || fail nvram-write-failed "the firmware refused to store a new UEFI boot entry (its boot-variable storage may be full). The loaders are on $disk; add a boot entry for \\EFI\\polyptic\\shim$efiarch.efi in firmware setup, or clear unused entries and install again"

entry="$(our_entries | head -n1)"
[ -n "$entry" ] || fail nvram-entry-missing "the firmware accepted the new UEFI boot entry and then dropped it. The loaders are on $disk; add a boot entry for \\EFI\\polyptic\\shim$efiarch.efi in firmware setup"

# Put our entry at the head of BootOrder, keeping every other entry (the box's old OS included) behind
# it. `-c` already does this, but only for an entry it created — say it explicitly so a firmware that
# appends rather than prepends is corrected too.
order="$(boot_order)"
rest="$(printf '%s' "$order" | tr ',' '\n' | awk -v n="$entry" 'NF && toupper($0) != toupper(n)' | tr '\n' ',' | sed 's/,$//')"
if [ -n "$rest" ]; then efibootmgr -q -o "$entry,$rest" >/dev/null 2>&1 || true
else efibootmgr -q -o "$entry" >/dev/null 2>&1 || true; fi

# The proof. Everything above can succeed and still leave the box booting its old OS; nothing is called
# an install until the firmware, re-read from scratch, agrees that we lead.
final="$(boot_order)"
first="${final%%,*}"
[ -n "$(our_entries | head -n1)" ] \
  || fail nvram-not-persisted "the UEFI boot entry did not survive being written. The loaders are on $disk; add a boot entry for \\EFI\\polyptic\\shim$efiarch.efi in firmware setup"
[ "$(printf '%s' "$first" | tr 'a-f' 'A-F')" = "$(printf '%s' "$entry" | tr 'a-f' 'A-F')" ] \
  || fail boot-order-not-first "the firmware kept '$LABEL' but would not make it the first boot option (it still boots ${first:-something else} first). Move '$LABEL' to the top of the boot order in firmware setup"

mkdir -p "$(dirname "$STAMP")"; : > "$STAMP"
detail="installed the signed loaders on $disk (partition $partnum) and made '$LABEL' the first UEFI boot option"
if [ "$fallback" = "yes" ]; then detail="$detail, plus the removable-media fallback path"; fi
report true installed "$detail"
say "bootloader installed on $disk. Remove the USB stick and reboot — nothing was erased, and the previous OS is still on this disk and bootable from the firmware boot menu."
hold "$HOLD_OK"
exit 0
