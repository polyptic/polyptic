#!/usr/bin/env sh
# Pure-shell tests for the boot-path report + per-boot forensics log (POL-171). Runs ANYWHERE
# (macOS/Linux/CI), no root, no real disks: every external command boot-path.sh touches — curl, ip,
# mount, umount, blkid, plymouth — is a stub on PATH, and every path it reads is an env-overridable
# fixture (offload.test.sh pattern).
#
# What this pins is the field lesson of 2026-07-21: a WIRED box on the local fallback chain must
# REPORT (loudly), a Wi-Fi box on the same chain must not be treated as a failure, and the forensics
# log must land on the medium with the token REDACTED and never a credential in it. Wrapped by
# packages/e2e/netboot-boot-path.test.ts so it runs in `bun test` / CI.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "contains: $2" "$3" ;; esac; }
hasnt() { case "$3" in *"$2"*) bad "$1" "does NOT contain: $2" "(present)" ;; *) ok "$1" ;; esac; }

# ─── Stubs ──────────────────────────────────────────────────────────────────────────────────────────
BIN="$ROOT/bin"; mkdir -p "$BIN"

# curl: POSTs are appended to $STUB/posts (url \t auth \t body), everything else succeeds silently.
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
if [ -n "$post" ]; then printf '%s\t%s\t%s\n' "$url" "$auth" "$body" >> "$STUB/posts"; fi
exit 0
EOF

# ip: `route show default` reads $STUB/default_route; the forensics dumps print canned lines.
cat > "$BIN/ip" <<'EOF'
#!/bin/sh
case "$*" in
  *"route show default"*) cat "$STUB/default_route" 2>/dev/null ;;
  *"route"*) printf 'default via 10.0.0.1 dev stub0\n' ;;
  *"-br link"*) printf 'stub0 UP aa:bb:cc:dd:ee:01\n' ;;
  *"-br addr"*) printf 'stub0 UP 10.0.0.99/24\n' ;;
esac
exit 0
EOF

# mount/umount/blkid: find-boot-medium's world. `mount <dev> <dir>` replaces <dir> with a symlink to
# the fixture $STUB/vol-<basename(dev)>; a device with no fixture fails to mount.
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
printf '#!/bin/sh\nexit 0\n' > "$BIN/plymouth"
printf '#!/bin/sh\nexit 0\n' > "$BIN/sync"
chmod +x "$BIN"/*

# ─── Fixture builder ────────────────────────────────────────────────────────────────────────────────
# new_case <name> <bootpath|-> → a case dir with a pinned-local cmdline, a wired route, and a medium
# fixture on /dev/sdb1 that carries the marker + a wifi.conf whose PSK must never reach a log.
new_case() {
  d="$ROOT/$1"
  mkdir -p "$d/run" "$d/netdir" "$d/by-label" "$d/vol-sdb1/polyptic"
  printf 'medium-test\n' > "$d/vol-sdb1/polyptic/medium-id"
  printf 'WIFI_SSID=lab\nWIFI_PSK=super-secret-psk\n' > "$d/vol-sdb1/polyptic/wifi.conf"
  printf '/dev/sdb1\n' > "$d/vfat_devs"
  printf 'default via 10.0.0.1 dev eth0 proto dhcp\n' > "$d/default_route"
  printf '00000000-0000-4000-8000-00000000abcd\n' > "$d/dmi_uuid"
  tag=""
  [ "$2" != "-" ] && tag=" polyptic.bootpath=$2"
  printf 'BOOT_IMAGE=/vmlinuz root=live:http://10.0.0.10/dist/image/amd64/builds/20260721T120000Z-abcd1234/rootfs.squashfs polyptic.base=http://10.0.0.10 polyptic.token=secret-fleet-token%s quiet splash\n' "$tag" > "$d/cmdline"
  printf '%s' "$d"
}

run_boot_path() {
  d="$1"
  STUB="$d" PATH="$BIN:$PATH" \
  POLYPTIC_CMDLINE_FILE="$d/cmdline" POLYPTIC_NET_DIR="$d/netdir" POLYPTIC_RUN_DIR="$d/run" \
  POLYPTIC_LIB_DIR="$LIB" POLYPTIC_CONSOLE="$d/console" POLYPTIC_BYLABEL_DIR="$d/by-label" \
  POLYPTIC_DMI_UUID_FILE="$d/dmi_uuid" POLYPTIC_FORENSICS_TS=20260721T120001Z \
    sh "$LIB/boot-path.sh" 2>/dev/null
  printf 'exit=%s\n' "$?"
}
posted() { cat "$1/posts" 2>/dev/null; }
logfile() { ls "$1/vol-sdb1/polyptic/logs" 2>/dev/null | head -n1; }
logtext() { cat "$1/vol-sdb1/polyptic/logs/$(logfile "$1")" 2>/dev/null; }

# ─── 1) THE field case: a wired-capable box on the local fallback reports, loudly ───────────────────
d="$(new_case wired-fallback local)"; : > "$d/console"
out="$(run_boot_path "$d")"
eq  "wired fallback: exits 0"              "exit=0" "$(printf '%s' "$out" | tail -n1)"
has "wired fallback: posts the code"       '"code":"local-fallback-boot"' "$(posted "$d")"
has "wired fallback: reports NOT ok"       '"ok":false' "$(posted "$d")"
has "wired fallback: names the pinned image" 'image pinned at 20260721T120000Z-abcd1234' "$(posted "$d")"
has "wired fallback: report carries the token" 'Authorization: Bearer secret-fleet-token' "$(posted "$d")"
has "wired fallback: report goes to /boot/report" 'http://10.0.0.10/boot/report' "$(posted "$d")"
has "wired fallback: machineId is the stable dmi id" '"machineId":"dmi-00000000-0000-4000-8000-00000000abcd"' "$(posted "$d")"
has "wired fallback: says it on the console" 'booted via the local fallback' "$(cat "$d/console" 2>/dev/null)"
eq  "wired fallback: once per boot (stamp)" "yes" "$([ -f "$d/run/boot-path-reported" ] && echo yes || echo no)"

# …and the forensics log landed on the medium.
eq  "forensics: one log written"           "boot-20260721T120001Z-20260721T120000Z-abcd1234.txt" "$(logfile "$d")"
has "forensics: records the boot path"     'boot path:   local' "$(logtext "$d")"
has "forensics: records the default route" 'via eth0 (wired)' "$(logtext "$d")"
has "forensics: token is REDACTED"         'polyptic.token=REDACTED' "$(logtext "$d")"
hasnt "forensics: the token value never lands" 'secret-fleet-token' "$(logtext "$d")"
hasnt "forensics: wifi credentials never land" 'super-secret-psk' "$(logtext "$d")"
eq  "forensics: path recorded for offload.sh" "polyptic/logs/$(logfile "$d")" "$(cat "$d/run/forensics-file" 2>/dev/null)"

# A second run in the same boot (unit restart) posts nothing again.
run_boot_path "$d" >/dev/null
eq "wired fallback: no second report"      "1" "$(grep -c 'local-fallback-boot' "$d/posts")"

# ─── 2) A genuinely Wi-Fi box on the local chain is NORMAL: quiet, state-only code ──────────────────
d="$(new_case wifi-normal local)"; : > "$d/console"
mkdir -p "$d/netdir/wlan0/wireless"
printf 'default via 10.0.0.1 dev wlan0 proto dhcp\n' > "$d/default_route"
run_boot_path "$d" >/dev/null
has "wifi: posts the quiet code"           '"code":"local-boot-wifi"' "$(posted "$d")"
has "wifi: reports ok"                     '"ok":true' "$(posted "$d")"
hasnt "wifi: never the fallback code"      'local-fallback-boot' "$(posted "$d")"
hasnt "wifi: nothing alarming on the console" 'fallback' "$(cat "$d/console" 2>/dev/null)"
has "wifi: forensics says wireless"        'via wlan0 (wireless)' "$(logtext "$d")"

# ─── 3) A wired-chain boot posts the all-clear that self-clears the fallback flag ───────────────────
d="$(new_case wired-clean wired)"
run_boot_path "$d" >/dev/null
has "wired: posts wired-boot"              '"code":"wired-boot"' "$(posted "$d")"
has "wired: reports ok"                    '"ok":true' "$(posted "$d")"

# ─── 3b) An INSTALLED box (POL-176): disk-boot is the quiet all-clear ───────────────────────────────
# `polyptic.bootpath=disk` comes off render-disk-grub's cmdline. State-only: ok:true, empty detail,
# nothing on the console — the new normal must be as silent as a clean wired boot.
d="$(new_case disk-clean disk)"; : > "$d/console"
sed 's|root=live:http://10.0.0.10/dist/image/amd64/builds/20260721T120000Z-abcd1234/rootfs.squashfs|root=live:LABEL=POLYPTIC-A|' "$d/cmdline" > "$d/cmdline.new"
mv "$d/cmdline.new" "$d/cmdline"
run_boot_path "$d" >/dev/null
has "disk: posts disk-boot"                '"code":"disk-boot"' "$(posted "$d")"
has "disk: reports ok (self-clears a fallback flag)" '"ok":true' "$(posted "$d")"
has "disk: detail is empty"                '"detail":""' "$(posted "$d")"
hasnt "disk: never the fallback code"      'local-fallback-boot' "$(posted "$d")"
hasnt "disk: nothing alarming on the console" 'fallback' "$(cat "$d/console" 2>/dev/null)"
# …and the forensics log still lands on the medium (the ESP, on an installed box).
has "disk: forensics records the path"     'boot path:   disk' "$(logtext "$d")"

# ─── 4) No marker = a pre-POL-171 medium: report nothing, forensics still written ───────────────────
d="$(new_case unmarked -)"
run_boot_path "$d" >/dev/null
eq  "unmarked: no report posted"           "no" "$([ -f "$d/posts" ] && echo yes || echo no)"
has "unmarked: forensics says so"          'boot path:   absent (pre-POL-171 medium)' "$(logtext "$d")"

# ─── 5) No default route on the local chain: nothing to report AND no way to deliver it ─────────────
d="$(new_case no-route local)"
: > "$d/default_route"
run_boot_path "$d" >/dev/null
eq  "no route: no report posted"           "no" "$([ -f "$d/posts" ] && echo yes || echo no)"
has "no route: forensics records the state" 'none - this box never got a route this boot' "$(logtext "$d")"

# ─── 6) No medium (a pointer-only offloaded boot): skip silently, cost nothing ──────────────────────
d="$(new_case no-medium local)"
rm -rf "$d/vol-sdb1"; : > "$d/vfat_devs"
out="$(run_boot_path "$d")"
eq  "no medium: still exits 0"             "exit=0" "$(printf '%s' "$out" | tail -n1)"
eq  "no medium: no forensics-file"         "no" "$([ -f "$d/run/forensics-file" ] && echo yes || echo no)"
has "no medium: the report still went out" '"code":"local-fallback-boot"' "$(posted "$d")"

# ─── 7) The forensics writer directly: prune, size cap, unpinned image ──────────────────────────────
d="$(new_case forensics-prune local)"
mkdir -p "$d/vol-sdb1/polyptic/logs"
i=1
while [ "$i" -le 22 ]; do
  printf 'old\n' > "$d/vol-sdb1/polyptic/logs/boot-202607$(printf '%02d' "$i")T000000Z-x.txt"
  i=$((i+1))
done
run_boot_path "$d" >/dev/null
eq "prune: newest 20 kept"                 "20" "$(ls "$d/vol-sdb1/polyptic/logs" | grep -c '^boot-')"
eq "prune: oldest gone"                    "no" "$([ -f "$d/vol-sdb1/polyptic/logs/boot-20260701T000000Z-x.txt" ] && echo yes || echo no)"
eq "prune: this boot's log survives"       "yes" "$([ -f "$d/vol-sdb1/polyptic/logs/boot-20260721T120001Z-20260721T120000Z-abcd1234.txt" ] && echo yes || echo no)"

d="$(new_case forensics-unpinned local)"
sed 's|/builds/20260721T120000Z-abcd1234||' "$d/cmdline" > "$d/cmdline.new"; mv "$d/cmdline.new" "$d/cmdline"
STUB="$d" PATH="$BIN:$PATH" POLYPTIC_CMDLINE_FILE="$d/cmdline" POLYPTIC_NET_DIR="$d/netdir" \
  POLYPTIC_FORENSICS_TS=20260721T120001Z POLYPTIC_FORENSICS_MAX_BYTES=64 \
  sh "$LIB/boot-forensics.sh" "$d/vol-sdb1" >/dev/null 2>&1
eq "unpinned root names no build"          "boot-20260721T120001Z-unpinned.txt" "$(logfile "$d")"
size="$(wc -c < "$d/vol-sdb1/polyptic/logs/$(logfile "$d")" | tr -d ' ')"
eq "size cap holds"                        "yes" "$([ "$size" -le 64 ] && echo yes || echo no)"

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'ALL PASS\n'; exit 0; fi
printf '%d FAILED\n' "$fails"; exit 1
