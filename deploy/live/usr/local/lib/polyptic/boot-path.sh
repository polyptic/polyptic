#!/bin/sh
# WHICH boot chain produced this boot — say so where the operator looks, once per boot (POL-171).
# Runs from polyptic-boot-path.service (after network-online, before offload + greetd).
#
# THE FAILURE THIS EXISTS FOR (2026-07-21, real hardware): a WIRED box's GRUB DHCP failed on its
# NIC, stage 1 silently fell through to the stick's LOCAL Wi-Fi menu, and the box spent the whole
# day rendering the image that menu PINS — rebuilds appeared to do nothing, and the only witness
# was /proc/cmdline. The fallback is kept (a Wi-Fi box physically needs the local chain: GRUB can
# never join WPA) — it just may never again be silent on a wired box.
#
# Two jobs:
#   1. REPORT the boot path (`polyptic.bootpath=` — `wired` from the server menu, `local` from the
#      medium's menus) to POST /boot/report. The WIRED default route is the tell that separates the
#      suspicious case from the normal one:
#        local + wired route    → `local-fallback-boot` — the wired chain failed and the fallback
#                                 caught the box. Loud: splash + console + a warn feed line, and the
#                                 machine record wears the state until the next wired boot.
#        local + wireless route → `local-boot-wifi` — this box's NORMAL path. State-only (the
#                                 console shows a neutral marker), no splash noise, no feed line.
#        wired                  → `wired-boot` — the all-clear that self-clears a fallback flag.
#        no default route       → nothing to report AND no way to deliver it; the forensics log
#                                 still records the state for whoever pulls the stick.
#      No marker at all = a pre-POL-171 medium: report nothing (absence is silence, not "wired").
#   2. FORENSICS: find the boot medium (USB stick or offloaded ESP — find-boot-medium proves
#      identity by content), mount it RW, and have boot-forensics.sh write this boot's log. The
#      log's on-medium path lands in $RUN_DIR/forensics-file so offload.sh can append its verdict
#      to the SAME file later this boot. Pointer-only offloaded boots have no medium: skipped,
#      silently — that is the documented cost of a pointer-only install, not an error.
#
# BEST-EFFORT THROUGHOUT: every step is guarded, exit is always 0, and nothing here may cost the
# boot — this script observes the boot, it is not part of it.
#
# Stubbable for the off-box tests (deploy/live/test/boot-path.test.sh, offload.test.sh pattern):
#   POLYPTIC_CMDLINE_FILE (/proc/cmdline)   POLYPTIC_NET_DIR  (/sys/class/net)
#   POLYPTIC_RUN_DIR      (/run/polyptic)   POLYPTIC_LIB_DIR  (this script's dir)
#   POLYPTIC_CONSOLE      (/dev/console);   curl / ip / mount / blkid come from PATH.
set -u

CMDLINE_FILE="${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}"
NET_DIR="${POLYPTIC_NET_DIR:-/sys/class/net}"
RUN_DIR="${POLYPTIC_RUN_DIR:-/run/polyptic}"
LIB_DIR="${POLYPTIC_LIB_DIR:-$(CDPATH= cd "$(dirname "$0")" && pwd)}"
CONSOLE="${POLYPTIC_CONSOLE:-/dev/console}"

base=""
token=""

# Announce one line: journal (stderr) + the boot splash + the console, best effort, never fatal.
say() {
  printf 'boot-path: %s\n' "$1" >&2
  if command -v plymouth >/dev/null 2>&1; then
    plymouth message --text="Polyptic: $1" >/dev/null 2>&1 || true
  fi
  if [ -w "$CONSOLE" ]; then
    printf 'Polyptic: %s\n' "$1" > "$CONSOLE" 2>/dev/null || true
  fi
  return 0
}

# Same /boot/report contract as offload.sh and boot-order.sh: the code is the machine-readable half,
# `detail` a sentence this box composed; the enrolment token authenticates and never reaches a log.
json_escape() {
  printf '%s' "$1" | tr -d '[:cntrl:]' | cut -c1-200 | sed 's/\\/\\\\/g; s/"/\\"/g'
}

report() {
  _ok="$1"; _code="$2"; _detail="$3"
  [ -n "$base" ] || return 0
  _mid=""
  if [ -r "$LIB_DIR/derive-machine-id.sh" ]; then
    _mid="$(sh "$LIB_DIR/derive-machine-id.sh" 2>/dev/null || true)"
  fi
  _body="$(printf '{"ok":%s,"code":"%s","detail":"%s","machineId":"%s"}' \
    "$_ok" "$(json_escape "$_code")" "$(json_escape "$_detail")" "$(json_escape "$_mid")")"
  set -- -fsS -m 5 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary "$_body"
  if [ -n "$token" ]; then set -- "$@" -H "Authorization: Bearer $token"; fi
  curl "$@" "$base/boot/report" >/dev/null 2>&1 || true
  return 0
}

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

# The image id this boot runs, read off root= — the local menu PINS builds/<id>/, which is the very
# staleness the fallback report is warning about; the wired root is unpinned by design.
image_id() {
  _root="$(cmdline_value root)"
  case "$_root" in
    *"/builds/"*) _id="${_root#*/builds/}"; printf '%s' "${_id%%/*}" ;;
    *) printf '%s' "" ;;
  esac
}

base="$(cmdline_value polyptic.base)"
token="$(cmdline_value polyptic.token)"
bootpath="$(cmdline_value polyptic.bootpath)"

# ─── 1) Report the boot path, once (this is a oneshot; the stamp guards a unit re-run) ───────────────
stamp="$RUN_DIR/boot-path-reported"
if [ -n "$bootpath" ] && [ ! -e "$stamp" ]; then
  dev="$(ip route show default 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n1)"
  imgid="$(image_id)"
  case "$bootpath" in
    wired)
      report true wired-boot ""
      ;;
    local)
      if [ -z "$dev" ]; then
        # No route at all: the report cannot leave the box, and "no network" is livenet's story to
        # tell (this boot will not have finished anyway). The forensics log below still records it.
        :
      elif [ -d "$NET_DIR/$dev/wireless" ]; then
        # A wireless default route on the local chain is a Wi-Fi box's NORMAL boot. State-only.
        report true local-boot-wifi "image pinned at ${imgid:-unknown}"
      else
        # THE suspicious case: a wired-capable box on the fallback. The wired GRUB chain got no
        # lease, and this box renders the pinned image until someone fixes that.
        report false local-fallback-boot "image pinned at ${imgid:-unknown}"
        say "booted via the local fallback - the wired boot chain did not get a lease. Image pinned at ${imgid:-unknown}"
      fi
      ;;
  esac
  mkdir -p "$RUN_DIR" 2>/dev/null || true
  : > "$stamp" 2>/dev/null || true
fi

# ─── 2) The per-boot forensics log on the medium ─────────────────────────────────────────────────────
mnt="$(mktemp -d 2>/dev/null)" || exit 0
medium_dev="$(sh "$LIB_DIR/find-boot-medium.sh" "$mnt" rw 2>/dev/null || true)"
if [ -n "$medium_dev" ]; then
  rel="$(sh "$LIB_DIR/boot-forensics.sh" "$mnt" 2>/dev/null || true)"
  if [ -n "$rel" ]; then
    mkdir -p "$RUN_DIR" 2>/dev/null || true
    printf '%s\n' "$rel" > "$RUN_DIR/forensics-file" 2>/dev/null || true
  fi
  sync 2>/dev/null || true
  umount "$mnt" 2>/dev/null || true
fi
rmdir "$mnt" 2>/dev/null || true
exit 0
