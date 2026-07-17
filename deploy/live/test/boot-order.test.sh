#!/usr/bin/env sh
# Pure-shell tests for the UEFI boot-order watch (POL-115). Runs ANYWHERE (macOS/Linux/CI), no root,
# no firmware: efibootmgr and curl are stubs on PATH whose "NVRAM" is a text file holding REAL
# `efibootmgr` output, and every path boot-order.sh reads is an env-overridable fixture.
#
# What this pins is the safety posture, not the happy path:
#
#   * report-only is the DEFAULT, and a box that cannot reach the control plane writes NOTHING;
#   * a box that leads its own boot order writes nothing and says nothing (no NVRAM churn every 5 min);
#   * a box with no entry of ours does nothing at all;
#   * re-assertion NEVER creates or deletes a boot entry — the other entries survive, in their order;
#   * a firmware that refuses the new order is REPORTED, and the boot order is left exactly as it was.
#
# Also wrapped by a bun test (packages/e2e/boot-order.test.ts) so it runs in `bun test` / CI.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "contains: $2" "$3" ;; esac; }
hasnt() { case "$3" in *"$2"*) bad "$1" "does NOT contain: $2" "$3" ;; *) ok "$1" ;; esac; }

BIN="$ROOT/bin"; mkdir -p "$BIN"

# ─── efibootmgr stub ────────────────────────────────────────────────────────────────────────────────
# $STUB/nvram is the boot-variable store, in the tool's own output format. Writes it understands:
#   -o <order>   set BootOrder      (refused when $STUB/nvram_sticky_order exists — the firmware fight)
#   -a -b <num>  activate an entry  (refused when $STUB/nvram_readonly exists)
# `-c` (create) and `-B` (delete) are NOT implemented on purpose: if boot-order.sh ever grows one,
# these tests break loudly rather than quietly wiping a fixture the way it would wipe a real box.
cat > "$BIN/efibootmgr" <<'EOF'
#!/bin/sh
[ -f "$STUB/nvram_unreadable" ] && exit 1
order=""; activate=""; target=""
while [ $# -gt 0 ]; do
  case "$1" in
    -q|-v) ;;
    -a) activate=1 ;;
    -b) shift; target="$1" ;;
    -o) shift; order="$1" ;;
    -c|-B) printf 'stub: boot-order.sh must never create or delete a boot entry\n' >&2; exit 99 ;;
  esac
  shift
done
if [ -n "$order$activate" ] && [ -f "$STUB/nvram_readonly" ]; then exit 1; fi
if [ -n "$activate" ]; then
  # Set the active flag on OUR entry: `Boot0004  label` → `Boot0004* label`.
  sed "s/^Boot$target  /Boot$target* /" "$STUB/nvram" > "$STUB/nvram.tmp" && mv "$STUB/nvram.tmp" "$STUB/nvram"
  exit 0
fi
if [ -n "$order" ]; then
  [ -f "$STUB/nvram_sticky_order" ] && exit 0        # accepted, then quietly ignored (real firmware!)
  grep -v '^BootOrder:' "$STUB/nvram" > "$STUB/nvram.tmp" || true
  # Keep BootOrder where the real tool puts it (3rd line): rebuild in the canonical order.
  { grep '^BootCurrent:' "$STUB/nvram" || true
    grep '^Timeout:' "$STUB/nvram" || true
    printf 'BootOrder: %s\n' "$order"
    grep '^Boot[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]' "$STUB/nvram" || true
  } > "$STUB/nvram.tmp"
  mv "$STUB/nvram.tmp" "$STUB/nvram"
  exit 0
fi
cat "$STUB/nvram"
exit 0
EOF

# ─── curl stub ──────────────────────────────────────────────────────────────────────────────────────
# GET  <base>/boot/policy → $STUB/policy (absent / $STUB/curl_fails → the network is down)
# POST <base>/boot/report → appended to $STUB/posts as "<url>\t<auth header>\t<body>"
cat > "$BIN/curl" <<'EOF'
#!/bin/sh
url=""; post=""; body=""; auth=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) shift; [ "$1" = POST ] && post=1 ;;
    --data-binary) shift; body="$1" ;;
    -H) shift; case "$1" in Authorization:*) auth="$1" ;; esac ;;
    -m|-o) shift ;;
    -*) ;;
    *) url="$1" ;;
  esac
  shift
done
[ -f "$STUB/curl_fails" ] && exit 7
if [ -n "$post" ]; then printf '%s\t%s\t%s\n' "$url" "$auth" "$body" >> "$STUB/posts"; exit 0; fi
case "$url" in
  */boot/policy) [ -f "$STUB/policy" ] || exit 22; cat "$STUB/policy"; exit 0 ;;
esac
exit 22
EOF
chmod +x "$BIN"/*

# ─── The fixture: a REAL `efibootmgr` capture ───────────────────────────────────────────────────────
# Verbatim shape from the homelab Lenovo (a ThinkCentre that re-prepends `ubuntu` every time its
# firmware is touched — the machine POL-115 exists for), plus a Windows entry, an inactive `Setup`
# entry (no `*`), a PXE entry with parentheses and colons in its label, and LOWERCASE hex in the boot
# numbers. This exact text is what the parser has to survive; the format is fiddly and the two spaces
# in front of an inactive entry's label are not a typo.
REAL_NVRAM='BootCurrent: 000a
Timeout: 0 seconds
BootOrder: 0000,000a,0002,0001,0003
Boot0000* ubuntu
Boot0001  Setup
Boot0002* Windows Boot Manager
Boot0003* UEFI: PXE IPv4 Realtek PCIe GbE Family Controller (MAC:8c164512ab34)
Boot000a* Polyptic Netboot'

# new_case <name> [nvram] → prints the case dir.
new_case() {
  d="$ROOT/$1"
  mkdir -p "$d/efi" "$d/run"
  printf 'BOOT_IMAGE=/vmlinuz root=live:http://10.0.0.10/dist/image/amd64/rootfs.squashfs polyptic.base=http://10.0.0.10 polyptic.token=secret-fleet-token quiet splash\n' > "$d/cmdline"
  printf '%s\n' "${2:-$REAL_NVRAM}" > "$d/nvram"
  printf '{"reassert":false}\n' > "$d/policy"
  printf '%s' "$d"
}

watch() {
  d="$1"
  STUB="$d" PATH="$BIN:$PATH" \
  POLYPTIC_CMDLINE_FILE="$d/cmdline" POLYPTIC_EFI_DIR="$d/efi" POLYPTIC_RUN_DIR="$d/run" \
  POLYPTIC_LIB_DIR="$LIB" POLYPTIC_BOOT_ORDER_STATE="$d/run/boot-order-state" \
    sh "$LIB/boot-order.sh" 2>&1
  printf 'exit=%s\n' "$?"
}

posts() { cat "$1/posts" 2>/dev/null || true; }
order_of() { sed -n 's/^BootOrder: //p' "$1/nvram"; }
entries_of() { sed -n 's/^\(Boot[0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f][0-9A-Fa-f]\).*/\1/p' "$1/nvram" | sort | tr '\n' ' '; }

printf '\n── the parser, against real efibootmgr output ──\n'
d="$(new_case parse)"
out="$(watch "$d")"
# `Boot000a* Polyptic Netboot` is ours (lowercase hex); `ubuntu` (0000) currently leads; the drift
# sentence must name BOTH, and quote the boot order verbatim.
has "finds OUR entry by label, lowercase hex and all"      "'Polyptic Netboot' is entry 000a" "$out"
has "names the entry that displaced us, by ITS label"      "the firmware now boots ubuntu first"  "$out"
has "quotes the boot order it read"                        "boot order 0000,000a,0002,0001,0003"  "$out"
has "reports the drift"                                    '"code":"boot-order-drift"'            "$(posts "$d")"
has "the drift report is not a success"                    '"ok":false'                           "$(posts "$d")"
# "Nothing was written" is the control plane's half of the sentence (it is a property of the POLICY,
# not of this box's firmware) — the box saying it too made the activity line say it twice.
hasnt "…and does NOT duplicate the server's 'Nothing was written'" "Nothing was written" "$(posts "$d")"
eq  "REPORT-ONLY: the boot order is untouched"             "0000,000a,0002,0001,0003" "$(order_of "$d")"
has "the fleet token travels in a header"                  "Authorization: Bearer secret-fleet-token" "$(posts "$d")"
hasnt "…and never in the body"                             '"token"'                              "$(posts "$d")"

printf '\n── the steady state: we lead, and we are enabled ──\n'
d="$(new_case leading)"
printf 'BootCurrent: 000a\nTimeout: 0 seconds\nBootOrder: 000a,0000,0002\nBoot0000* ubuntu\nBoot0002* Windows Boot Manager\nBoot000a* Polyptic Netboot\n' > "$d/nvram"
out="$(watch "$d")"
eq  "writes nothing"                     "000a,0000,0002" "$(order_of "$d")"
eq  "says nothing to the control plane"  ""               "$(posts "$d")"
eq  "exits clean"                        "exit=0"         "$(printf '%s' "$out" | tail -n1)"

printf '\n── a box that was never offloaded is not ours to touch ──\n'
d="$(new_case foreign)"
printf 'BootCurrent: 0000\nTimeout: 1 seconds\nBootOrder: 0000,0002\nBoot0000* ubuntu\nBoot0002* Windows Boot Manager\n' > "$d/nvram"
printf '{"reassert":true}\n' > "$d/policy"
out="$(watch "$d")"
eq "no entry of ours → no write, even with re-assert ON" "0000,0002" "$(order_of "$d")"
eq "…and nothing reported"                               ""          "$(posts "$d")"

printf '\n── the control plane is unreachable ──\n'
d="$(new_case offline)"; : > "$d/curl_fails"
watch "$d" >/dev/null
eq "a box that cannot ask permission writes NOTHING" "0000,000a,0002,0001,0003" "$(order_of "$d")"

printf '\n── legacy BIOS / no efibootmgr / unreadable efivars ──\n'
d="$(new_case bios)"; rm -rf "$d/efi"
watch "$d" >/dev/null
eq "no UEFI → no write"      "0000,000a,0002,0001,0003" "$(order_of "$d")"
eq "no UEFI → no report"     ""                         "$(posts "$d")"
d="$(new_case efivars)"; : > "$d/nvram_unreadable"
watch "$d" >/dev/null
eq "unreadable NVRAM → no report" "" "$(posts "$d")"

printf '\n── the operator opted in: re-assert ──\n'
d="$(new_case reassert)"
printf '{"reassert":true}\n' > "$d/policy"
before="$(entries_of "$d")"
out="$(watch "$d")"
eq  "our entry leads, every other entry keeps its order behind it" "000a,0000,0002,0001,0003" "$(order_of "$d")"
eq  "not one boot entry was created or deleted"                    "$before" "$(entries_of "$d")"
has "reports the correction"                                       '"code":"boot-order-reasserted"' "$(posts "$d")"
has "…as a success"                                                '"ok":true'                      "$(posts "$d")"
has "and says what the order is now, and was"                      "Boot order 000a,0000,0002,0001,0003 (was 0000,000a,0002,0001,0003)" "$(posts "$d")"

printf '\n── the firmware DISABLED our entry ──\n'
d="$(new_case disabled)"
printf 'BootCurrent: 0000\nTimeout: 0 seconds\nBootOrder: 000a,0000\nBoot0000* ubuntu\nBoot000a  Polyptic Netboot\n' > "$d/nvram"
printf '{"reassert":true}\n' > "$d/policy"
out="$(watch "$d")"
has "an entry at the head but DISABLED is still drift" "DISABLED" "$out"
has "re-enables our entry (and only ours)"             "Boot000a* Polyptic Netboot" "$(cat "$d/nvram")"
has "reports the correction"                           '"code":"boot-order-reasserted"' "$(posts "$d")"

printf '\n── the firmware wins anyway (accepts the write, ignores it) ──\n'
d="$(new_case sticky)"
printf '{"reassert":true}\n' > "$d/policy"
: > "$d/nvram_sticky_order"
out="$(watch "$d")"
eq  "the boot order is left exactly as the firmware wants it" "0000,000a,0002,0001,0003" "$(order_of "$d")"
has "the fight is REPORTED, not retried in silence"           '"code":"boot-order-reassert-failed"' "$(posts "$d")"
has "…and the operator is told where to fix it"               "firmware setup"                      "$(posts "$d")"

printf '\n── the firmware refuses the write outright ──\n'
d="$(new_case readonly)"
printf '{"reassert":true}\n' > "$d/policy"
: > "$d/nvram_readonly"
watch "$d" >/dev/null
eq  "boot order unchanged"          "0000,000a,0002,0001,0003" "$(order_of "$d")"
has "reported as a failed re-assert" '"code":"boot-order-reassert-failed"' "$(posts "$d")"

printf '\n── the feed is not a metronome: one report per drift state per boot ──\n'
d="$(new_case once)"
watch "$d" >/dev/null; watch "$d" >/dev/null; watch "$d" >/dev/null
eq "three polls, one drift line" "1" "$(posts "$d" | grep -c 'boot-order-drift')"

printf '\n── every sentence this box composes fits the contract ──\n'
# `BootReportBody.detail` is capped at 200 characters in the protocol: a longer sentence is a 400 from
# the control plane, i.e. a report that silently never reaches the operator. Check EVERY detail this
# suite made the script produce, in every case above.
too_long=0
for f in "$ROOT"/*/posts; do
  [ -f "$f" ] || continue
  while IFS= read -r line; do
    detail="${line#*\"detail\":\"}"; detail="${detail%%\"*}"
    n="$(printf '%s' "$detail" | wc -c | tr -d ' ')"
    [ "$n" -le 200 ] || { too_long=$((too_long+1)); printf '       over 200 chars (%s): %s\n' "$n" "$detail"; }
  done < "$f"
done
eq "no reported detail exceeds the protocol's 200-character cap" "0" "$too_long"

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'ALL PASS\n'; exit 0; fi
printf '%s FAILED\n' "$fails"; exit 1
