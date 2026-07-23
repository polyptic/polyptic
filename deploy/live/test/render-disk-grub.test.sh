#!/usr/bin/env sh
# Pure-shell tests for the disk GRUB renderer (POL-176). Runs ANYWHERE (macOS/Linux/CI), no root:
# render-disk-grub.sh is a pure text transform. What this pins: the header round-trips through the
# SAME sed patterns update-poll.sh parses it with, the cmdline is the disk contract exactly (labels,
# overlayfs, per-boot reset, bootpath=disk, NO network options), the menuless posture
# (hidden timeout + default=live + fallback=netboot), and the netboot entry's wired walk stays
# byte-lockstep with deploy/dongle-grub.cfg.tmpl.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
TMPL="$HERE/../../dongle-grub.cfg.tmpl"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "contains: $2" "$3" ;; esac; }
hasnt() { case "$3" in *"$2"*) bad "$1" "must NOT contain: $2" "(present)" ;; *) ok "$1" ;; esac; }

render() { sh "$LIB/render-disk-grub.sh" "$@"; }

OUT="$(render amd64 a 10.0.0.10:8080 20260722T000000Z-cafe1234 tok-secret)"

# ─── 1) The header: parseable back out with update-poll.sh's exact sed patterns ─────────────────────
eq "header line"        "# polyptic-disk arch=amd64 slot=a image=20260722T000000Z-cafe1234" \
                        "$(printf '%s\n' "$OUT" | head -n1)"
eq "slot round-trips"   "a" "$(printf '%s\n' "$OUT" | sed -n '1s/.* slot=\([a-z]\).*/\1/p')"
eq "image round-trips"  "20260722T000000Z-cafe1234" "$(printf '%s\n' "$OUT" | sed -n '1s/.* image=\([^ ]*\).*/\1/p')"

# ─── 2) The menuless posture (the POL-176 pitch: no GRUB menu, ever, on a healthy boot) ─────────────
has "hidden timeout style" "set timeout_style=hidden" "$OUT"
has "one-second window"    "set timeout=1" "$OUT"
has "defaults to live"     "set default=live" "$OUT"
has "netboot is the automatic fallback" "set fallback=netboot" "$OUT"

# ─── 3) The disk cmdline, exactly ───────────────────────────────────────────────────────────────────
live_line="$(printf '%s\n' "$OUT" | sed -n '/--id live {/,/^}/p' | grep '  linux ')"
has "root is the slot's fs label"    "root=live:LABEL=POLYPTIC-A" "$live_line"
has "overlay on the scratch label"   "rd.live.overlay=LABEL=POLYPTIC-SCRATCH" "$live_line"
has "overlayfs mode"                 "rd.live.overlay.overlayfs=1" "$live_line"
has "per-boot overlay reset (statelessness by construction)" "rd.live.overlay.reset=1" "$live_line"
has "base for the agent"             "polyptic.base=http://10.0.0.10:8080" "$live_line"
has "ws url for the agent"           "polyptic.server_url=ws://10.0.0.10:8080/agent" "$live_line"
has "token when given"               "polyptic.token=tok-secret" "$live_line"
has "marked as the disk chain"       "polyptic.bootpath=disk" "$live_line"
has "tail mirrors the local menu's"  "multipath=off quiet splash plymouth.ignore-serial-consoles" "$live_line"
# A disk boot needs NO network in the initramfs — the whole point of the install.
hasnt "no ip=dhcp"      "ip=dhcp" "$live_line"
hasnt "no rd.neednet"   "rd.neednet" "$live_line"
has  "kernel from this slot's ESP dir" "/polyptic/boot/amd64/a/vmlinuz" "$live_line"

# ─── 4) live-other boots the OTHER slot (the keyboard operator's rollback) ──────────────────────────
other_line="$(printf '%s\n' "$OUT" | sed -n '/--id live-other {/,/^}/p' | grep '  linux ')"
has "other slot's root label"  "root=live:LABEL=POLYPTIC-B" "$other_line"
has "other slot's kernel dir"  "/polyptic/boot/amd64/b/vmlinuz" "$other_line"
# …and rendering slot b flips both.
OUTB="$(render amd64 b 10.0.0.10:8080 img-2)"
has "slot b: live boots B"        "root=live:LABEL=POLYPTIC-B" "$(printf '%s\n' "$OUTB" | sed -n '/--id live {/,/^}/p')"
has "slot b: live-other boots A"  "root=live:LABEL=POLYPTIC-A" "$(printf '%s\n' "$OUTB" | sed -n '/--id live-other {/,/^}/p')"

# ─── 5) The debug entry: this slot + the root shell, reachable only via the hidden menu ─────────────
dbg_line="$(printf '%s\n' "$OUT" | sed -n '/--id debug {/,/^}/p' | grep '  linux ')"
has "debug: same slot"        "root=live:LABEL=POLYPTIC-A" "$dbg_line"
has "debug: root shell"       "systemd.debug-shell=1" "$dbg_line"

# ─── 6) The netboot entry replays the template's wired walk VERBATIM (the lockstep pin) ─────────────
# The walk (one card at a time, first lease wins — POL-118) is duplicated because an installed box
# has no copy of the repo. Extract the identical span from both texts and diff them byte for byte.
walk_of() { sed -n '/^set nic_ip=$/,/^configfile \$net\/boot\/grub.cfg$/p' "$1"; }
printf '%s\n' "$OUT" > "$ROOT/rendered.cfg"
tmpl_walk="$(walk_of "$TMPL")"
rendered_walk="$(walk_of "$ROOT/rendered.cfg")"
[ -n "$tmpl_walk" ] && ok "template walk extracted" || bad "template walk extracted" "non-empty" ""
eq "netboot walk matches dongle-grub.cfg.tmpl byte for byte" "$tmpl_walk" "$rendered_walk"
has "netboot entry sets \$net to the depot" "set net=(http,10.0.0.10:8080)" "$OUT"
# Kept short by design: the netboot chain paints its own failure handling once chained — no
# pager/debug dump lives here.
hasnt "no debug dump in the disk config" "set debug=net,efinet,http" "$OUT"
hasnt "no pager in the disk config"      "set pager=1" "$OUT"

# ─── 7) The gfx preamble: guarded, themed from the ESP, correct dark ────────────────────────────────
has "guarded on loadfont" "if loadfont (memdisk)/fonts/unicode.pf2 ; then" "$OUT"
has "shared dark background" 'background_color "#0b0b0d"' "$OUT"
has "theme from the ESP, all-three-files guarded (POL-87/POL-130)" \
  'if [ -f ($root)/polyptic/boot/theme/theme.txt ]; then if [ -f ($root)/polyptic/boot/theme/logo.png ]; then if [ -f ($root)/polyptic/boot/theme/bg.png ]; then set theme=($root)/polyptic/boot/theme/theme.txt ; fi ; fi ; fi' \
  "$OUT"

# ─── 8) Tokenless render (an ungated fleet) carries no polyptic.token= at all ───────────────────────
OUT_NOTOK="$(render arm64 a 10.0.0.10:8080 img-3)"
hasnt "no token → no polyptic.token=" "polyptic.token=" "$OUT_NOTOK"
has   "arm64 paths"                   "/polyptic/boot/arm64/a/vmlinuz" "$OUT_NOTOK"

# ─── 9) A bad slot is refused (the renderer is the last writer before a wall boots it) ──────────────
render amd64 c 10.0.0.10:8080 img-4 >/dev/null 2>&1 && rc=0 || rc=$?
eq "slot c refused" "2" "$rc"

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'ALL PASS\n'; exit 0; fi
printf '%d FAILED\n' "$fails"; exit 1
