#!/bin/sh
# UEFI BOOT-ORDER WATCH (POL-115). Real firmware does not leave BootOrder alone: a firmware update, a
# "load setup defaults", or a disk OS running `grub-install` re-prepends its own entry, and a box that
# offloaded cleanly months ago silently boots a stale disk OS on its next power-cycle. The wall goes
# dark, and someone drives to it. Observed on the homelab Lenovo, which re-prepends `ubuntu` every
# time its firmware is touched.
#
# The box that is UP is the only thing in a position to notice, because it can read its own NVRAM. So
# on every update poll (5 minutes) this script compares the firmware's BootOrder against the entry the
# offload (POL-33/D47/POL-58) installed, and:
#
#   in the DEFAULT posture (report-only)     — writes NOTHING, and reports the drift, so the operator
#                                              sees "this box will boot something else next time" in
#                                              the Live Activity feed instead of finding out when a
#                                              screen goes dark;
#   when the operator has OPTED IN           — puts our entry back at the head of BootOrder, re-reads
#     (Console ▸ Settings ▸ Boot order)        NVRAM from scratch, and reports what the firmware
#                                              actually kept. A firmware that wins anyway is reported
#                                              as a fight, not silently retried forever.
#
# SAFETY POSTURE — a mangled BootOrder can leave a box unable to boot ANYTHING, so every rule here is
# a "cannot", not a "should not":
#
#   * NOTHING is written unless the control plane says the operator opted in. Unreachable server,
#     401, malformed answer, no answer → report-only. Firmware writes cannot happen by default,
#     by omission, or by a control plane going away.
#   * We only ever act on an entry WE created (exact label match). A box that was never offloaded has
#     no such entry, so this script does nothing at all on it.
#   * We never CREATE and never DELETE a boot entry. The only writes are `-o` (reorder) and `-a`
#     (activate OUR entry). Entries we did not add are never removed and never reordered relative to
#     each other — they keep their existing sequence, behind ours.
#   * The reorder is idempotent: a box already leading writes nothing at all (no NVRAM churn, no feed
#     line, every 5 minutes forever).
#   * The write is verified by re-reading NVRAM, and the read-back REFUSES to call it a success unless
#     every entry that was in BootOrder before is still in it afterwards. If anything is off, the
#     verdict is "boot order unchanged / firmware won" and the operator is told — never a claim.
#
# UNPRIVILEGED AGENT: this runs from polyptic-update-poll.service, a root-owned system unit that
# already exists. The kiosk agent is not involved and gains no new escalation — deliberately: giving
# the agent a touch-file that triggers an NVRAM write would ADD an attack surface for no benefit,
# since the root poll already visits this every 5 minutes.
#
# Stubbable for the off-box tests: POLYPTIC_CMDLINE_FILE, POLYPTIC_EFI_DIR, POLYPTIC_RUN_DIR,
# POLYPTIC_LIB_DIR, POLYPTIC_BOOT_ORDER_STATE; efibootmgr + curl come from PATH.
set -u

# The UEFI entry the offload installs. MUST stay identical to offload.sh's LABEL — it is the only
# thing that tells our entry apart from the firmware's own, and it is what we match to know that this
# box's boot path is ours to keep healthy.
LABEL="Polyptic Netboot"

CMDLINE_FILE="${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}"
EFI_DIR="${POLYPTIC_EFI_DIR:-/sys/firmware/efi}"
RUN_DIR="${POLYPTIC_RUN_DIR:-/run/polyptic}"
LIB_DIR="${POLYPTIC_LIB_DIR:-$(CDPATH= cd "$(dirname "$0")" && pwd)}"
# One report per distinct drift state per boot: the poll runs every 5 minutes and a firmware fight can
# last for weeks, so the feed must not become a metronome. /run is tmpfs → a reboot re-reports.
STATE_FILE="${POLYPTIC_BOOT_ORDER_STATE:-$RUN_DIR/boot-order-state}"

base=""
token=""

# ─── Reading NVRAM ──────────────────────────────────────────────────────────────────────────────────
# `efibootmgr` (no -v) prints exactly:
#
#   BootCurrent: 0003
#   Timeout: 1 seconds
#   BootOrder: 0000,0003,0001,0002
#   Boot0000* ubuntu
#   Boot0001* Windows Boot Manager
#   Boot0003* Polyptic Netboot
#   Boot0004  UEFI: PXEv4 (MAC:...)          ← no '*' == entry present but INACTIVE (won't be booted)
#
# The `*` is the active flag, the two spaces are not a typo, and the label runs to end-of-line. Some
# builds pad with a tab and device path even without -v, so the label match tolerates a trailing tab.

nvram() { efibootmgr 2>/dev/null; }

# The boot numbers whose label is exactly ours (there should be one; a re-offloaded box can briefly
# have more, and we lead with the first).
our_entries() {
  nvram | sed -n "s/^Boot\([0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]\)[* ] $LABEL[	 ]*\$/\1/p"
}

# The comma-separated BootOrder, exactly as the firmware holds it.
boot_order() { nvram | sed -n 's/^BootOrder: *//p' | head -n1; }

# 1 when boot entry $1 carries the active flag (`Boot0003* …`), 0 when it does not (`Boot0003  …`).
entry_active() {
  nvram | grep -q "^Boot$1\*" && printf '1' || printf '0'
}

# The human label of boot entry $1 ("ubuntu", "Windows Boot Manager", …), for the sentence we report.
entry_label() {
  nvram | sed -n "s/^Boot$1[* ] //p" | head -n1 | sed 's/[	].*$//' | sed 's/[[:space:]]*$//'
}

# ─── Telling the control plane ──────────────────────────────────────────────────────────────────────
# Same contract as the offload's (POST /boot/report → ONE Live Activity line): the codes are the
# machine-readable half, `detail` is a sentence this box composed about its own firmware.

json_escape() {
  printf '%s' "$1" | tr -d '[:cntrl:]' | cut -c1-200 | sed 's/\\/\\\\/g; s/"/\\"/g'
}

report() {
  _ok="$1"; _code="$2"; _detail="$3"
  printf 'boot-order: %s\n' "$_detail" >&2
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

# ─── Guards: is there anything here that is ours to watch? ──────────────────────────────────────────

[ -d "$EFI_DIR" ] || exit 0                              # legacy BIOS/CSM: no boot entries exist
command -v efibootmgr >/dev/null 2>&1 || exit 0          # nothing to read NVRAM with
nvram >/dev/null 2>&1 || exit 0                          # efivars unreadable (locked-down firmware)

entry="$(our_entries | head -n1)"
# No entry of ours == this box was never offloaded (it boots from the USB medium, or from the server's
# menu). There is no boot path of ours to keep healthy, and inventing one is exactly the kind of write
# that could strand a box. Do nothing, say nothing.
[ -n "$entry" ] || exit 0

order="$(boot_order)"
first="$(printf '%s' "$order" | cut -d, -f1)"
active="$(entry_active "$entry")"

# Case-insensitive compare: firmware prints hex in either case, and `0003` vs `0003` must not depend on it.
upper() { printf '%s' "$1" | tr 'a-f' 'A-F'; }

# ─── The steady state: we lead, and we are enabled. Nothing to do, nothing to say. ──────────────────
if [ "$(upper "$first")" = "$(upper "$entry")" ] && [ "$active" = "1" ]; then
  rm -f "$STATE_FILE" 2>/dev/null || true    # healthy again → a future drift re-reports
  exit 0
fi

# ─── Drift. Describe it in the operator's terms before deciding anything. ───────────────────────────
usurper_label="$(entry_label "$first")"
if [ "$active" = "1" ]; then
  what="the firmware now boots ${usurper_label:-entry ${first:-?}} first"
else
  what="the firmware has DISABLED '$LABEL' (entry $entry)"
  if [ -n "$first" ] && [ "$(upper "$first")" != "$(upper "$entry")" ]; then
    what="$what and boots ${usurper_label:-entry $first} first"
  fi
fi
drift="$what; '$LABEL' is entry $entry, boot order $order"

base="$(cmdline_value polyptic.base)"
token="$(cmdline_value polyptic.token)"

# ─── May we do anything about it? Ask; assume NO on any doubt. ──────────────────────────────────────
# The answer is one boolean an operator set in the console. Anything other than a clear yes — no base
# on the cmdline, server down, 401, garbled body — is a no, and a no means we write nothing.
reassert=0
if [ -n "$base" ]; then
  set -- -fsS -m 5
  if [ -n "$token" ]; then set -- "$@" -H "Authorization: Bearer $token"; fi
  # Whitespace-insensitive, so a pretty-printed body reads the same as a compact one. Anything that is
  # not literally `"reassert":true` leaves `reassert` at 0 — including an empty body and a 401.
  policy="$(curl "$@" "$base/boot/policy" 2>/dev/null | tr -d ' \t\n' || true)"
  case "$policy" in *'"reassert":true'*) reassert=1 ;; esac
fi

# One report per distinct state per boot (see STATE_FILE). The drift sentence IS the state: a firmware
# that keeps winning reports once, not 288 times a day.
seen="$(cat "$STATE_FILE" 2>/dev/null || true)"
mark() { mkdir -p "$RUN_DIR" 2>/dev/null || true; printf '%s\n' "$1" > "$STATE_FILE" 2>/dev/null || true; }

if [ "$reassert" != "1" ]; then
  if [ "$seen" != "report:$drift" ]; then
    # Just the facts. "Nothing was written" is the CONTROL PLANE's sentence (it is a property of the
    # policy, not of this box's firmware) — saying it here too made the feed line say it twice.
    report false boot-order-drift "$drift"
    mark "report:$drift"
  fi
  exit 0
fi

# ─── Re-assert. Additive only: our entry to the front, everyone else behind it, in the order the ────
#     firmware already had them. No entry is created, deleted, or reordered relative to its peers.
before_entries="$(nvram | sed -n 's/^Boot\([0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]\)[* ].*/\1/p' | sort)"
rest="$(printf '%s' "$order" | tr ',' '\n' \
  | awk -v n="$entry" 'NF && toupper($0) != toupper(n)' | tr '\n' ',' | sed 's/,$//')"

wrote=1
if [ "$active" != "1" ]; then
  # Re-enable OUR entry (and only ours): a disabled entry at the head of BootOrder is skipped, so
  # leading without this would be a lie.
  efibootmgr -q -a -b "$entry" >/dev/null 2>&1 || wrote=0
fi
if [ -n "$rest" ]; then
  efibootmgr -q -o "$entry,$rest" >/dev/null 2>&1 || wrote=0
else
  efibootmgr -q -o "$entry" >/dev/null 2>&1 || wrote=0
fi

# ─── The proof. Re-read NVRAM from scratch; the firmware, not this script, decides what happened. ───
final_order="$(boot_order)"
final_first="$(printf '%s' "$final_order" | cut -d, -f1)"
final_active="$(entry_active "$entry")"
after_entries="$(nvram | sed -n 's/^Boot\([0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]\)[* ].*/\1/p' | sort)"

# "Never remove an entry you did not add" is not a promise, it is a check: if the box has fewer boot
# entries than it started this poll with, something went wrong that we do not understand, and the
# operator hears about it in those words.
if [ "$before_entries" != "$after_entries" ]; then
  report false boot-order-reassert-failed \
    "the set of UEFI boot entries changed while re-ordering them (before: $(printf '%s' "$before_entries" | tr '\n' ' ')after: $(printf '%s' "$after_entries" | tr '\n' ' ')). Check this box's firmware setup before rebooting it"
  mark "failed:$drift"
  exit 0
fi

if [ "$wrote" = 1 ] \
  && [ "$(upper "$final_first")" = "$(upper "$entry")" ] \
  && [ "$final_active" = "1" ]; then
  report true boot-order-reasserted \
    "$what — '$LABEL' (entry $entry) is the first boot option again; boot order $final_order (was $order)"
  rm -f "$STATE_FILE" 2>/dev/null || true
  exit 0
fi

# The firmware kept its own answer. Nothing here is retried in a loop: it is reported once, and the
# box goes on rendering. The boot order is whatever the firmware decided it is — we claim nothing.
if [ "$seen" != "failed:$drift" ]; then
  # `detail` is capped at 200 characters by the contract, so this sentence stays tight: what the
  # firmware does, what it still reads, and where a human fixes it.
  report false boot-order-reassert-failed \
    "$what, and would not accept a new boot order (it still reads ${final_order:-unreadable}). Move '$LABEL' to the top in firmware setup"
  mark "failed:$drift"
fi
exit 0
