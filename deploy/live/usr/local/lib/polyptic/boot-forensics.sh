#!/bin/sh
# Write ONE per-boot forensics log onto the boot medium → the log's ON-MEDIUM relative path on stdout
# (POL-171). The 2026-07-21 field failure was invisible for a day because the only record of WHICH
# chain booted the box was /proc/cmdline on a box nobody could reach; this file is the record anyone
# holding the stick can read: boot path, redacted cmdline, image id, which interface got the default
# route, and (appended later by offload.sh) the offload verdict.
#
#   usage: boot-forensics.sh <medium-mount-dir>
#
# The caller (boot-path.sh) owns finding + mounting the medium RW; this script only composes and
# writes, so the off-box tests point it at a plain fixture directory. BEST-EFFORT BY CONTRACT: every
# step is guarded, it always exits 0, and it must NEVER cost the boot — a full, read-only, or vanished
# medium loses a log line, nothing more.
#
# SECRETS NEVER LAND HERE: polyptic.token= is redacted out of the cmdline before it is written, and
# nothing reads polyptic/wifi.conf (the credentials file that shares this medium). The size cap keeps
# a pathological tool output from eating a FAT ESP's headroom; the prune keeps the newest ~20 boots
# (names are UTC timestamps, so lexical order IS chronological order).
#
# Stubbable for the off-box tests (offload.test.sh pattern):
#   POLYPTIC_CMDLINE_FILE  (/proc/cmdline)     POLYPTIC_NET_DIR         (/sys/class/net)
#   POLYPTIC_FORENSICS_TS  (the UTC stamp)     POLYPTIC_FORENSICS_KEEP  (20)
#   POLYPTIC_FORENSICS_MAX_BYTES (65536);  ip / networkctl come from PATH and are optional.
set -u

MEDIUM="${1:-}"
[ -n "$MEDIUM" ] && [ -d "$MEDIUM" ] || exit 0

CMDLINE_FILE="${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}"
NET_DIR="${POLYPTIC_NET_DIR:-/sys/class/net}"
KEEP="${POLYPTIC_FORENSICS_KEEP:-20}"
MAX_BYTES="${POLYPTIC_FORENSICS_MAX_BYTES:-65536}"
TS="${POLYPTIC_FORENSICS_TS:-$(date -u +%Y%m%dT%H%M%SZ 2>/dev/null || echo unknown)}"

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

# The image id, from the pinned root= URL when the local menu pinned one (builds/<id>/), else from
# the unpinned root's manifest-published sibling — which the cmdline does not carry, so "unpinned".
image_id() {
  _root="$(cmdline_value root)"
  case "$_root" in
    *"/builds/"*) _id="${_root#*/builds/}"; printf '%s' "${_id%%/*}" ;;
    *) printf 'unpinned' ;;
  esac
}

# The device holding the default route, and whether it is wireless (the wired-vs-Wi-Fi tell).
default_route_dev() {
  ip route show default 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n1
}

imgid="$(image_id)"
bootpath="$(cmdline_value polyptic.bootpath)"
[ -n "$bootpath" ] || bootpath="absent (pre-POL-171 medium)"

logdir="$MEDIUM/polyptic/logs"
mkdir -p "$logdir" 2>/dev/null || exit 0
logname="boot-$TS-$imgid.txt"

# Compose the whole report, cap it, then write in one shot — a FAT medium someone yanks mid-boot
# should hold either a complete (truncated) file or none, never a torn half-section.
{
  printf 'Polyptic boot forensics (POL-171) — one file per boot, newest %s kept\n' "$KEEP"
  printf 'time (UTC):  %s\n' "$TS"
  printf 'boot path:   %s\n' "$bootpath"
  printf 'image:       %s\n' "$imgid"
  printf '\n--- kernel cmdline (polyptic.token redacted) ---\n'
  sed 's/polyptic\.token=[^ ]*/polyptic.token=REDACTED/g' "$CMDLINE_FILE" 2>/dev/null || echo "(unreadable)"
  printf '\n--- default route ---\n'
  _dev="$(default_route_dev)"
  if [ -n "$_dev" ]; then
    if [ -d "$NET_DIR/$_dev/wireless" ]; then _kind="wireless"; else _kind="wired"; fi
    printf 'via %s (%s)\n' "$_dev" "$_kind"
  else
    printf 'none - this box never got a route this boot\n'
  fi
  ip route 2>/dev/null || true
  printf '\n--- interfaces ---\n'
  ip -br link 2>/dev/null || true
  ip -br addr 2>/dev/null || true
  printf '\n--- DHCP / wait-online ---\n'
  if command -v networkctl >/dev/null 2>&1; then networkctl list --no-pager 2>/dev/null || true
  else printf 'networkctl unavailable\n'; fi
  if command -v systemctl >/dev/null 2>&1; then
    printf 'wait-online: %s\n' "$(systemctl show -p Result --value systemd-networkd-wait-online.service 2>/dev/null || echo unknown)"
  fi
} 2>/dev/null | head -c "$MAX_BYTES" > "$logdir/$logname" 2>/dev/null || exit 0

# Prune to the newest $KEEP files. Portable (no GNU `head -n -N`): count, then drop the excess from
# the top of the lexically-sorted (== oldest-first) list.
count="$(ls -1 "$logdir" 2>/dev/null | grep -c '^boot-.*\.txt$')" || count=0
excess=$((count - KEEP))
if [ "$excess" -gt 0 ] 2>/dev/null; then
  ls -1 "$logdir" 2>/dev/null | grep '^boot-.*\.txt$' | sort | sed -n "1,${excess}p" \
    | while IFS= read -r _old; do rm -f "$logdir/$_old" 2>/dev/null || true; done
fi

printf 'polyptic/logs/%s\n' "$logname"
exit 0
