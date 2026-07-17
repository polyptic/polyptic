#!/usr/bin/env sh
# Pure-shell tests for the Wi-Fi credential layer (POL-63). Runs ANYWHERE (macOS/Linux/CI), no root,
# no radios: wifi-conf.sh and wifi-supplicant-conf.sh are pure text transforms, and
# find-boot-medium.sh's externals (mount, umount, blkid, readlink) are stubs on PATH in the
# offload.test.sh style. What this pins: an operator-edited wifi.conf (Notepad CRLF, spaces, quotes,
# UTF-8 SSIDs) survives byte-exact into a wpa_supplicant config, every invalid file fails LOUDLY
# (never half-configures), and the medium is identified by its marker content, never by label alone.
# Also wrapped by a bun test (packages/e2e/netboot-wifi.test.ts) so it runs in `bun test` / CI.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "contains: $2" "$3" ;; esac; }
hasnt() { case "$3" in *"$2"*) bad "$1" "must NOT contain: $2" "$3" ;; *) ok "$1" ;; esac; }

conf() { printf '%s\n' "$@" > "$ROOT/wifi.conf"; }
# Octal permissions, portably: GNU stat first (`-c`), BSD/macOS second (`-f`). The order matters —
# GNU's `-f` is *filesystem* mode, which succeeds with a multi-line blob instead of failing over.
perms() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
parse() { sh "$LIB/wifi-conf.sh" "$ROOT/wifi.conf" 2>"$ROOT/err"; }
render() { POLYPTIC_WIFI_CERT_DIR="${CERTS:-/run/polyptic}" sh "$LIB/wifi-supplicant-conf.sh" "$ROOT/wifi.conf" 2>"$ROOT/err"; }

# ─── wifi-conf.sh: parsing + validation ──────────────────────────────────────────────────────────────

# 1) absent file → nothing, exit 0 (no Wi-Fi is a fine state).
out="$(sh "$LIB/wifi-conf.sh" "$ROOT/nonexistent")"; rc=$?
eq "absent file is silent success" "0:" "$rc:$out"

# 2) comment-only template → nothing, exit 0.
conf '# WIFI_SSID=' '# WIFI_PSK=' '' 'WIFI_SSID=' 'WIFI_PSK='
out="$(parse)"; rc=$?
eq "comment/blank-value template configures nothing" "0:" "$rc:$out"

# 3) plain PSK network; security inferred.
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=hunter2hunter2'
out="$(parse)"; rc=$?
eq "psk parse rc" 0 "$rc"
has "psk ssid"      "WIFI_SSID=MyNet" "$out"
has "psk inferred"  "WIFI_SECURITY=psk" "$out"
has "psk value"     "WIFI_PSK=hunter2hunter2" "$out"

# 4) CRLF file (Notepad) with spaces + '=' in values → byte-exact minus the CRs.
printf 'WIFI_SSID=Caffe Wifi\r\nWIFI_PSK=pass with = spaces\r\n' > "$ROOT/wifi.conf"
out="$(parse)"; rc=$?
eq "crlf parse rc" 0 "$rc"
has "crlf ssid keeps spaces" "WIFI_SSID=Caffe Wifi" "$out"
has "crlf psk keeps '='"     "WIFI_PSK=pass with = spaces" "$out"
case "$out" in *"$(printf '\r')"*) bad "no CR survives" "no CR" "CR found" ;; *) ok "no CR survives" ;; esac

# 5) security=eap inferred from identity; peap defaulted; password required → present here.
conf 'WIFI_SSID=Corp' 'WIFI_IDENTITY=box@corp' 'WIFI_PASSWORD=s3cret'
out="$(parse)"; rc=$?
eq "eap inferred rc" 0 "$rc"
has "eap inferred"   "WIFI_SECURITY=eap" "$out"
has "eap defaulted"  "WIFI_EAP=peap" "$out"

# 6) peap without a password fails loudly.
conf 'WIFI_SSID=Corp' 'WIFI_SECURITY=eap' 'WIFI_IDENTITY=box@corp'
out="$(parse)"; rc=$?
eq "peap needs password (rc)" 1 "$rc"
has "peap needs password (msg)" "WIFI_PASSWORD" "$(cat "$ROOT/err")"
eq "invalid emits nothing" "" "$out"

# 7) short passphrase rejected.
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=short'
out="$(parse)"; rc=$?
eq "short psk rejected" 1 "$rc"
has "short psk message" "8-63" "$(cat "$ROOT/err")"

# 8) 64-hex raw key accepted.
hexkey="0123456789abcdef0123456789abcdef0123456789ABCDEF0123456789abcdef"
conf 'WIFI_SSID=MyNet' "WIFI_PSK=$hexkey"
out="$(parse)"; rc=$?
eq "raw 64-hex psk accepted" 0 "$rc"

# 9) unknown key (a typo) is a hard error, not a silent ignore.
conf 'WIFI_SSID=MyNet' 'WIFI_PSSK=hunter2hunter2'
out="$(parse)"; rc=$?
eq "typo'd key rejected" 1 "$rc"
has "typo'd key named" "WIFI_PSSK" "$(cat "$ROOT/err")"

# 10) phase2=pap is ttls-only.
conf 'WIFI_SSID=Corp' 'WIFI_EAP=peap' 'WIFI_IDENTITY=u' 'WIFI_PASSWORD=p' 'WIFI_PHASE2=pap'
out="$(parse)"; rc=$?
eq "pap+peap rejected" 1 "$rc"
conf 'WIFI_SSID=Corp' 'WIFI_EAP=ttls' 'WIFI_IDENTITY=u' 'WIFI_PASSWORD=p' 'WIFI_PHASE2=pap'
out="$(parse)"; rc=$?
eq "pap+ttls accepted" 0 "$rc"

# 11) cert paths must stay inside the medium's polyptic/ dir.
conf 'WIFI_SSID=Corp' 'WIFI_EAP=peap' 'WIFI_IDENTITY=u' 'WIFI_PASSWORD=p' 'WIFI_CA_CERT=/etc/ssl/ca.pem'
eq "absolute cert path rejected" 1 "$(parse >/dev/null; echo $?)"
conf 'WIFI_SSID=Corp' 'WIFI_EAP=peap' 'WIFI_IDENTITY=u' 'WIFI_PASSWORD=p' 'WIFI_CA_CERT=../../shadow'
eq "dotdot cert path rejected" 1 "$(parse >/dev/null; echo $?)"

# 12) hidden + country normalization; bad country rejected.
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=hunter2hunter2' 'WIFI_HIDDEN=yes' 'WIFI_COUNTRY=gb'
out="$(parse)"
has "hidden normalized"  "WIFI_HIDDEN=1" "$out"
has "country uppercased" "WIFI_COUNTRY=GB" "$out"
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=hunter2hunter2' 'WIFI_COUNTRY=GBR'
eq "bad country rejected" 1 "$(parse >/dev/null; echo $?)"

# 13) open network: just an SSID.
conf 'WIFI_SSID=Lobby'
out="$(parse)"; rc=$?
eq "open network rc" 0 "$rc"
has "open inferred" "WIFI_SECURITY=open" "$out"

# 14) first occurrence wins (the parse-cmdline.sh convention).
conf 'WIFI_SSID=First' 'WIFI_SSID=Second' 'WIFI_PSK=hunter2hunter2'
out="$(parse)"
has "first occurrence wins" "WIFI_SSID=First" "$out"
hasnt "second occurrence ignored" "Second" "$out"

# 15) EAP-TLS requires the client pair; valid case carries it through.
conf 'WIFI_SSID=Corp' 'WIFI_EAP=tls' 'WIFI_IDENTITY=box1'
eq "tls without certs rejected" 1 "$(parse >/dev/null; echo $?)"
conf 'WIFI_SSID=Corp' 'WIFI_EAP=tls' 'WIFI_IDENTITY=box1' \
     'WIFI_CLIENT_CERT=certs/box.pem' 'WIFI_CLIENT_KEY=certs/box.key'
out="$(parse)"; rc=$?
eq "tls with certs rc" 0 "$rc"
has "tls client cert" "WIFI_CLIENT_CERT=certs/box.pem" "$out"

# ─── wifi-supplicant-conf.sh: escape-safe rendering ─────────────────────────────────────────────────

# 16) passphrase PSK: hex ssid, quoted psk with escapes, WPA2+WPA3 offered.
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=pa"ss\word etc'
out="$(render)"; rc=$?
eq "render psk rc" 0 "$rc"
has "ssid is bare hex"      'ssid=4d794e6574' "$out"
has "psk escaped + quoted"  'psk="pa\"ss\\word etc"' "$out"
has "psk offers WPA3"       'key_mgmt=WPA-PSK SAE' "$out"
has "pmf optional"          'ieee80211w=1' "$out"

# 17) raw hex PSK: bare, lowercased, WPA2-only (no passphrase for SAE to derive from).
conf 'WIFI_SSID=MyNet' "WIFI_PSK=$hexkey"
out="$(render)"
has "raw psk bare + lowercase" "psk=$(printf '%s' "$hexkey" | tr 'A-F' 'a-f')" "$out"
hasnt "raw psk is WPA2-only (no SAE)" 'SAE' "$out"

# 18) PEAP: identity/password quoted, MSCHAPv2 defaulted, ca_cert resolved against the staging dir.
CERTS="/run/polyptic"
conf 'WIFI_SSID=Corp' 'WIFI_EAP=peap' 'WIFI_IDENTITY=box@corp' 'WIFI_PASSWORD=s3cret' \
     'WIFI_CA_CERT=certs/ca.pem'
out="$(render)"
has "peap eap"       'eap=PEAP' "$out"
has "peap identity"  'identity="box@corp"' "$out"
has "peap password"  'password="s3cret"' "$out"
has "peap phase2"    'phase2="auth=MSCHAPV2"' "$out"
has "peap ca path"   'ca_cert="/run/polyptic/certs/ca.pem"' "$out"
has "peap key_mgmt"  'key_mgmt=WPA-EAP' "$out"

# 19) TTLS+PAP renders auth=PAP.
conf 'WIFI_SSID=Corp' 'WIFI_EAP=ttls' 'WIFI_IDENTITY=u' 'WIFI_PASSWORD=p' 'WIFI_PHASE2=pap'
out="$(render)"
has "ttls pap" 'phase2="auth=PAP"' "$out"

# 20) EAP-TLS: client pair + key passphrase land as wpa_supplicant fields.
conf 'WIFI_SSID=Corp' 'WIFI_EAP=tls' 'WIFI_IDENTITY=box1' 'WIFI_PASSWORD=keypass' \
     'WIFI_CLIENT_CERT=certs/box.pem' 'WIFI_CLIENT_KEY=certs/box.key'
out="$(render)"
has "tls client cert" 'client_cert="/run/polyptic/certs/box.pem"' "$out"
has "tls private key" 'private_key="/run/polyptic/certs/box.key"' "$out"
has "tls key passwd"  'private_key_passwd="keypass"' "$out"

# 21) open → key_mgmt=NONE.
conf 'WIFI_SSID=Lobby'
out="$(render)"
has "open key_mgmt" 'key_mgmt=NONE' "$out"

# 22) hidden + country reach the supplicant dialect.
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=hunter2hunter2' 'WIFI_HIDDEN=1' 'WIFI_COUNTRY=GB'
out="$(render)"
has "hidden scan_ssid" 'scan_ssid=1' "$out"
has "country line"     'country=GB' "$out"

# 23) no config → nothing, exit 0; invalid config → exit 1 and NO partial render.
out="$(sh "$LIB/wifi-supplicant-conf.sh" "$ROOT/nonexistent")"; rc=$?
eq "render absent file" "0:" "$rc:$out"
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=short'
out="$(render)"; rc=$?
eq "render invalid rc" 1 "$rc"
eq "render invalid emits nothing" "" "$out"

# 23b) POL-78 regression: the supplicant resolves its sibling wifi-conf.sh with NO `dirname` on PATH.
# The initramfs shipped no dirname, so the old `$(dirname "$0")` left LIB empty → sh looked for
# `/wifi-conf.sh` → not found → EVERY Wi-Fi config "rejected" on real hardware. A broken dirname
# (exit 127) stands in for its absence; the pure-`${0%/*}` resolver must not touch it.
mkdir -p "$ROOT/nodirname"
printf '#!/bin/sh\necho "dirname: command not found" >&2\nexit 127\n' > "$ROOT/nodirname/dirname"
chmod +x "$ROOT/nodirname/dirname"
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=hunter2hunter2'
out="$(PATH="$ROOT/nodirname:$PATH" sh "$LIB/wifi-supplicant-conf.sh" "$ROOT/wifi.conf" 2>"$ROOT/err")"; rc=$?
eq "renders with dirname absent (rc)"   0 "$rc"
has "renders with dirname absent (ssid)" "ssid=4d794e6574" "$out"

# ─── find-boot-medium.sh: marker-proven identity ────────────────────────────────────────────────────
# Stubs (offload.test.sh pattern): `mount` copies a fixture volume into the mountpoint, `umount`
# empties it, `blkid` lists $STUB/vfat_devs. Volumes live at $STUB/vol-<basename-of-device>.

BIN="$ROOT/bin"; mkdir -p "$BIN"
# `mount` SYMLINKS the fixture volume in place of the mountpoint (so writes back to a mounted medium
# persist into the fixture, which is what the update-poll refresh asserts on); `umount` undoes it.
cat > "$BIN/mount" <<'EOF'
#!/bin/sh
dev=""; mnt=""
while [ $# -gt 0 ]; do
  case "$1" in -o) shift ;; -*) ;; *) if [ -z "$dev" ]; then dev="$1"; else mnt="$1"; fi ;; esac
  shift
done
src="$STUB/vol-$(basename "$dev")"
[ -d "$src" ] || exit 32
rmdir "$mnt" 2>/dev/null || true
ln -s "$src" "$mnt"
exit 0
EOF
cat > "$BIN/umount" <<'EOF'
#!/bin/sh
t="${1:?}"
if [ -L "$t" ]; then rm -f "$t"; mkdir -p "$t"; exit 0; fi
case "$t" in "$STUB_ROOT"/*) rm -rf "$t"; mkdir -p "$t"; exit 0 ;; esac
exit 1
EOF
cat > "$BIN/blkid" <<'EOF'
#!/bin/sh
cat "$STUB/vfat_devs" 2>/dev/null
exit 0
EOF
chmod +x "$BIN/mount" "$BIN/umount" "$BIN/blkid"

fbm() { PATH="$BIN:$PATH" STUB="$STUB" STUB_ROOT="$ROOT" \
        POLYPTIC_BYLABEL_DIR="$STUB/by-label" sh "$LIB/find-boot-medium.sh" "$@"; }

# 24) by-label fast path: labeled volume with the marker is found and mounted.
STUB="$ROOT/case24"; mkdir -p "$STUB/by-label" "$STUB/vol-POLYPTIC-BT/polyptic" "$ROOT/mnt24"
: > "$STUB/by-label/POLYPTIC-BT"
printf 'medium-1\n' > "$STUB/vol-POLYPTIC-BT/polyptic/medium-id"
out="$(fbm "$ROOT/mnt24")"; rc=$?
eq "by-label rc" 0 "$rc"
has "by-label prints device" "POLYPTIC-BT" "$out"
eq "by-label mounted marker" "medium-1" "$(cat "$ROOT/mnt24/polyptic/medium-id")"

# 25) no label: the vfat scan finds the marker on the SECOND device (an offloaded ESP).
STUB="$ROOT/case25"; mkdir -p "$STUB" "$STUB/vol-sda1" "$STUB/vol-sdb1/polyptic" "$ROOT/mnt25"
printf '/dev/sda1\n/dev/sdb1\n' > "$STUB/vfat_devs"
printf 'medium-2\n' > "$STUB/vol-sdb1/polyptic/medium-id"
out="$(fbm "$ROOT/mnt25")"; rc=$?
eq "scan rc" 0 "$rc"
eq "scan picked the marked ESP" "/dev/sdb1" "$out"
eq "scan skipped the markerless vfat" "" "$(ls "$ROOT/mnt25" | grep -v polyptic || true)"

# 26) nothing found → exit 1, prints nothing (the wired lean-dongle box).
STUB="$ROOT/case26"; mkdir -p "$STUB" "$ROOT/mnt26"
out="$(fbm "$ROOT/mnt26")"; rc=$?
eq "no medium rc" "1:" "$rc:$out"

# 27) a foreign stick labeled POLYPTIC-BT but without the marker is NOT trusted.
STUB="$ROOT/case27"; mkdir -p "$STUB/by-label" "$STUB/vol-POLYPTIC-BT" "$ROOT/mnt27"
: > "$STUB/by-label/POLYPTIC-BT"
printf 'not-our-files\n' > "$STUB/vol-POLYPTIC-BT/readme.txt"
out="$(fbm "$ROOT/mnt27")"; rc=$?
eq "foreign label rejected" "1:" "$rc:$out"

# ─── start-wifi.sh: the rootfs Linux-world handoff ──────────────────────────────────────────────────
# systemctl + plymouth are stubbed; the medium comes through the same mount stubs. What is pinned:
# the three staging paths, root-only permissions on staged secrets, one supplicant per wireless
# iface, silent no-op on wired boxes, and a LOUD failure for a present-but-invalid config.

cat > "$BIN/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB/systemctl.log"
[ -f "$STUB/systemctl_fails" ] && exit 1
exit 0
EOF
cat > "$BIN/plymouth" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB/plymouth.log" 2>/dev/null || true
exit 0
EOF
chmod +x "$BIN/systemctl" "$BIN/plymouth"

# One wireless (wlan0) + one wired (eth0) interface fixture.
NETFIX="$ROOT/netfix"; mkdir -p "$NETFIX/wlan0/wireless" "$NETFIX/eth0"

sw() { # run start-wifi.sh against a case dir: $1=STUB dir (pre-made), rest env overrides
  _stub="$1"; shift
  PATH="$BIN:$PATH" STUB="$_stub" STUB_ROOT="$ROOT" \
  POLYPTIC_LIB_DIR="$LIB" POLYPTIC_BYLABEL_DIR="$_stub/by-label" \
  POLYPTIC_RUN_DIR="$_stub/run" POLYPTIC_LIVE_DIR="$_stub/live" \
  POLYPTIC_NET_DIR="$NETFIX" POLYPTIC_WPA_DIR="$_stub/wpa" \
  POLYPTIC_MEDIUM_TRIES=1 "$@" sh "$LIB/start-wifi.sh" 2>"$_stub/stderr"
}

# 28) initrd handoff: /run/polyptic/wifi.conf already staged → supplicant conf written + started.
STUB="$ROOT/case28"; mkdir -p "$STUB/run" "$STUB/by-label"
printf 'WIFI_SSID=MyNet\nWIFI_PSK=hunter2hunter2\n' > "$STUB/run/wifi.conf"
sw "$STUB"; rc=$?
eq "handoff rc" 0 "$rc"
has "handoff renders supplicant conf" "ssid=4d794e6574" "$(cat "$STUB/wpa/wpa_supplicant-wlan0.conf" 2>/dev/null)"
has "handoff starts the unit" "start wpa_supplicant@wlan0.service" "$(cat "$STUB/systemctl.log" 2>/dev/null)"
eq "supplicant conf is root-only" "600" "$(perms "$STUB/wpa/wpa_supplicant-wlan0.conf")"

# 29) live-ISO path: creds under $LIVE_DIR/polyptic are staged (certs included) with tight perms.
STUB="$ROOT/case29"; mkdir -p "$STUB/run" "$STUB/by-label" "$STUB/live/polyptic/certs"
printf 'WIFI_SSID=Corp\nWIFI_EAP=peap\nWIFI_IDENTITY=u\nWIFI_PASSWORD=p\nWIFI_CA_CERT=certs/ca.pem\n' \
  > "$STUB/live/polyptic/wifi.conf"
printf 'PEM\n' > "$STUB/live/polyptic/certs/ca.pem"
sw "$STUB"; rc=$?
eq "iso path rc" 0 "$rc"
eq "iso path staged conf" "600" "$(perms "$STUB/run/wifi.conf")"
eq "iso path staged cert" "PEM" "$(cat "$STUB/run/certs/ca.pem")"
has "iso ca path points at the staging dir" "ca_cert=\"$STUB/run/certs/ca.pem\"" "$(cat "$STUB/wpa/wpa_supplicant-wlan0.conf")"

# 30) medium path: no staged conf, medium found via by-label → staged + started.
STUB="$ROOT/case30"; mkdir -p "$STUB/run" "$STUB/by-label" "$STUB/vol-POLYPTIC-BT/polyptic"
: > "$STUB/by-label/POLYPTIC-BT"
printf 'medium-3\n' > "$STUB/vol-POLYPTIC-BT/polyptic/medium-id"
printf 'WIFI_SSID=SiteNet\nWIFI_PSK=hunter2hunter2\n' > "$STUB/vol-POLYPTIC-BT/polyptic/wifi.conf"
sw "$STUB"; rc=$?
eq "medium path rc" 0 "$rc"
has "medium path staged" "WIFI_SSID=SiteNet" "$(cat "$STUB/run/wifi.conf" 2>/dev/null)"

# 31) wired box, no config anywhere → silent success, nothing written, nothing started.
STUB="$ROOT/case31"; mkdir -p "$STUB/run-none" "$STUB/by-label"
PATH="$BIN:$PATH" STUB="$STUB" STUB_ROOT="$ROOT" \
POLYPTIC_LIB_DIR="$LIB" POLYPTIC_BYLABEL_DIR="$STUB/by-label" \
POLYPTIC_RUN_DIR="$STUB/run" POLYPTIC_LIVE_DIR="$STUB/live" \
POLYPTIC_NET_DIR="$NETFIX" POLYPTIC_WPA_DIR="$STUB/wpa" \
POLYPTIC_MEDIUM_TRIES=1 sh "$LIB/start-wifi.sh" 2>"$STUB/stderr"; rc=$?
eq "wired no-op rc" 0 "$rc"
eq "wired no-op starts nothing" "" "$(cat "$STUB/systemctl.log" 2>/dev/null || true)"

# 32) present-but-invalid config fails LOUDLY (unit failure + named reason).
STUB="$ROOT/case32"; mkdir -p "$STUB/run" "$STUB/by-label"
printf 'WIFI_SSID=MyNet\nWIFI_PSK=short\n' > "$STUB/run/wifi.conf"
sw "$STUB"; rc=$?
eq "invalid config fails the unit" 1 "$rc"
has "invalid config names the reason" "8-63" "$(cat "$STUB/stderr")"

# ─── update-poll.sh: the self-updating boot medium (POL-63) ─────────────────────────────────────────
# What is pinned: the refresh writes the INACTIVE slot and rewrites the menu LAST (the commit point),
# a corrupted download refreshes NOTHING and skips the reboot, a box without a medium reboots exactly
# as before (POL-41), and a recovery-booted box (kernel/rootfs mismatch) heals itself.

cat > "$BIN/uname" <<'EOF'
#!/bin/sh
case "${1:-}" in -m) echo aarch64 ;; -r) echo 6.8.0-test ;; *) echo Linux ;; esac
EOF
cat > "$BIN/curl" <<'EOF'
#!/bin/sh
out=""; url=""
while [ $# -gt 0 ]; do
  case "$1" in -o) shift; out="$1" ;; --max-time) shift ;; -*) ;; *) url="$1" ;; esac
  shift
done
printf '%s\n' "$url" >> "$STUB/curl.log"
case "$url" in
  # POL-105: the poll now asks for the manifest AS A MACHINE (`?machineId=…`), so the depot can
  # answer it with a roll-out ring's build instead of the fleet's. Both shapes are matched.
  */manifest.json|*/manifest.json\?*) cat "$STUB/manifest" 2>/dev/null || exit 22 ;;
  */builds/*/vmlinuz)     [ -f "$STUB/curl_fail_kernel" ] && exit 22; cp "$STUB/new-vmlinuz" "$out" ;;
  */builds/*/initrd-wifi) [ -f "$STUB/curl_fail_initrd" ] && exit 22; cp "$STUB/new-initrd" "$out" ;;
  */builds/*/SHA256SUMS)  cp "$STUB/new-sums" "$out" ;;
  */boot/theme.txt) [ -f "$STUB/served-theme" ] || exit 22; cp "$STUB/served-theme" "$out" ;;
  */boot/logo.png)  [ -f "$STUB/served-logo" ]  || exit 22; cp "$STUB/served-logo"  "$out" ;;
  */boot/bg.png)    [ -f "$STUB/served-bg" ]    || exit 22; cp "$STUB/served-bg"    "$out" ;;
  *) exit 22 ;;
esac
exit 0
EOF
cat > "$BIN/date" <<'EOF'
#!/bin/sh
case "${1:-}" in +%H) cat "$STUB/hour" 2>/dev/null || echo 03 ;; *) echo 20260710T120000Z ;; esac
EOF
cat > "$BIN/sleep" <<'EOF'
#!/bin/sh
printf '%s\n' "$1" >> "$STUB/slept"; exit 0
EOF
cat > "$BIN/systemctl" <<'EOF'
#!/bin/sh
printf '%s\n' "$*" >> "$STUB/systemctl.log"; exit 0
EOF
chmod +x "$BIN/uname" "$BIN/curl" "$BIN/date" "$BIN/sleep" "$BIN/systemctl"

shahex() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | awk '{print $1}'; }

# mk_png <out> <tag> [bad]: a minimal PNG whose header satisfies (or, with "bad", violates — an
# interlaced image) grub-png-check.sh — signature + IHDR (8x8, 8-bit truecolour), then <tag> as
# trailing bytes so two "versions" of a served bitmap differ in content. The heal validates every
# fetched bitmap against the check (POL-130), so the stub server must speak real-enough PNG.
mk_png() {
  printf '\211PNG\r\n\032\nxxxxIHDR\000\000\000\010\000\000\000\010\010\002\000\000' > "$1"
  if [ "${3:-}" = bad ]; then printf '\001' >> "$1"; else printf '\000' >> "$1"; fi
  printf 'crc4%s' "$2" >> "$1"
}
# Binary-safe equality for the heal assertions (a `$(cat …)` would mangle PNG bytes).
same() { cmp -s "$2" "$3" 2>/dev/null && ok "$1" || bad "$1" "files differ" "$2 vs $3"; }

# new_poll_case <name> <running-id> <served-id> [medium-image-id]: a netbooted arm64 box; when a
# 4th arg is given, a POLYPTIC-BT medium with an `a`-slot payload pinned to that image rides along.
new_poll_case() {
  d="$ROOT/$1"; mkdir -p "$d/run" "$d/by-label" "$d/modules/6.8.0-test"
  printf 'BOOT_IMAGE=/vmlinuz root=live:http://10.0.0.10:8080/dist/image/arm64/rootfs.squashfs polyptic.base=http://10.0.0.10:8080 polyptic.token=tok quiet\n' > "$d/cmdline"
  printf '%s\n' "$2" > "$d/image-id"
  printf 'POLYPTIC_MACHINE_ID=dmi-test\n' > "$d/agent.env"
  printf '{"imageId":"%s","urgent":true}\n' "$3" > "$d/manifest"
  printf 'NEW-KERNEL\n' > "$d/new-vmlinuz"; printf 'NEW-INITRD-WIFI\n' > "$d/new-initrd"
  { printf '%s  vmlinuz\n' "$(shahex "$d/new-vmlinuz")"
    printf '%s  initrd-wifi\n' "$(shahex "$d/new-initrd")"; } > "$d/new-sums"
  if [ -n "${4:-}" ]; then
    m="$d/vol-POLYPTIC-BT"; mkdir -p "$m/grub" "$m/polyptic/boot/arm64/a"
    : > "$d/by-label/POLYPTIC-BT"
    printf 'medium-x\n' > "$m/polyptic/medium-id"
    printf 'OLD-KERNEL\n' > "$m/polyptic/boot/arm64/a/vmlinuz"
    printf 'OLD-INITRD\n' > "$m/polyptic/boot/arm64/a/initrd"
    sh "$LIB/render-local-grub.sh" arm64 a 10.0.0.10:8080 "$4" tok > "$m/grub/local-arm64.cfg"
  fi
  printf '%s' "$d"
}
up() {
  PATH="$BIN:$PATH" STUB="$1" STUB_ROOT="$ROOT" \
  POLYPTIC_CMDLINE_FILE="$1/cmdline" POLYPTIC_IMAGE_ID_FILE="$1/image-id" \
  POLYPTIC_ENV_FILE="$1/agent.env" POLYPTIC_RUN_DIR="$1/run" POLYPTIC_LIB_DIR="$LIB" \
  POLYPTIC_BYLABEL_DIR="$1/by-label" POLYPTIC_MODULES_BASE="$1/modules" \
    sh "$LIB/update-poll.sh" 2>&1
}

# 33) happy refresh: inactive slot written+verified, menu rewritten LAST, then the reboot.
d="$(new_poll_case poll-happy old-1 new-2 old-1)"
out="$(up "$d")"
eq "poll: new kernel in slot b"     "NEW-KERNEL"      "$(cat "$d/vol-POLYPTIC-BT/polyptic/boot/arm64/b/vmlinuz" 2>/dev/null)"
eq "poll: new initrd in slot b"     "NEW-INITRD-WIFI" "$(cat "$d/vol-POLYPTIC-BT/polyptic/boot/arm64/b/initrd" 2>/dev/null)"
has "poll: menu pins the new pair"  "slot=b image=new-2" "$(head -n1 "$d/vol-POLYPTIC-BT/grub/local-arm64.cfg")"
eq "poll: old slot a kept as fallback" "OLD-KERNEL" "$(cat "$d/vol-POLYPTIC-BT/polyptic/boot/arm64/a/vmlinuz")"
has "poll: reboots"                 "reboot" "$(cat "$d/systemctl.log" 2>/dev/null)"

# 34) corrupted download: NO menu rewrite, NO reboot, retry next poll.
d="$(new_poll_case poll-corrupt old-1 new-2 old-1)"
printf 'TAMPERED\n' > "$d/new-initrd"   # sums file still carries the good hash
out="$(up "$d")"
has "poll corrupt: says it skipped"  "did not complete" "$out"
has "poll corrupt: menu untouched"   "slot=a image=old-1" "$(head -n1 "$d/vol-POLYPTIC-BT/grub/local-arm64.cfg")"
eq "poll corrupt: no reboot"         "" "$(cat "$d/systemctl.log" 2>/dev/null || true)"

# 35) no medium: the plain POL-41 flow — reboot, nothing else.
d="$(new_poll_case poll-no-medium old-1 new-2)"
out="$(up "$d")"
has "poll no-medium: reboots"        "reboot" "$(cat "$d/systemctl.log" 2>/dev/null)"

# 35a) POL-105: the poll asks for the manifest AS THIS MACHINE, so the depot can answer it with a
#      canary ring's build rather than the fleet's. The box itself is unchanged — it still just
#      compares two ids — but if this query parameter goes missing, every box silently rejoins the
#      fleet build and staged roll-outs quietly stop working. Hence a test.
d="$(new_poll_case poll-machineid old-1 new-2)"
out="$(up "$d")"
has "poll: manifest is fetched per machine" "manifest.json?machineId=dmi-test" "$(cat "$d/curl.log")"

# 35b) …and a box with no machine id yet (pre-enrolment) asks for the plain fleet manifest rather
#      than an empty, meaningless `?machineId=`.
d="$(new_poll_case poll-no-machineid old-1 new-2)"
: > "$d/agent.env"
out="$(up "$d")"
has "poll: no machine id → the plain fleet manifest" "manifest.json" "$(cat "$d/curl.log")"
eq  "poll: no empty machineId param" "" "$(grep -c 'machineId=$' "$d/curl.log" | grep -v '^0$')"

# 36) recovery-boot heal: ids MATCH but the kernel has no modules dir → refresh check + reboot.
d="$(new_poll_case poll-heal new-2 new-2 new-2)"
rm -rf "$d/modules/6.8.0-test"
out="$(up "$d")"
has "poll heal: names the re-pair"   "re-pair the kernel" "$out"
has "poll heal: reboots"             "reboot" "$(cat "$d/systemctl.log" 2>/dev/null)"

# 37) matched ids + matched kernel: silence (the every-5-minutes common path).
d="$(new_poll_case poll-quiet new-2 new-2 new-2)"
out="$(up "$d")"
eq "poll quiet: no output"           "" "$out"
eq "poll quiet: no reboot"           "" "$(cat "$d/systemctl.log" 2>/dev/null || true)"

# 38) non-urgent outside the window: waits, refreshes nothing, reboots nothing.
d="$(new_poll_case poll-window old-1 new-2 old-1)"
printf '{"imageId":"new-2","urgent":false}\n' > "$d/manifest"
printf '14\n' > "$d/hour"
out="$(up "$d")"
has "poll window: waits"             "Waiting for the nightly window" "$out"
has "poll window: medium untouched"  "slot=a image=old-1" "$(head -n1 "$d/vol-POLYPTIC-BT/grub/local-arm64.cfg")"
eq "poll window: no reboot"          "" "$(cat "$d/systemctl.log" 2>/dev/null || true)"

# 38a) offline-splash self-heal (POL-80): a stick flashed from an OLD, theme-less medium gets the
#      branded splash pulled from the server WITHOUT re-flashing — even when the image is ALREADY
#      current (running==served, kernel matched), which is exactly the box that never reaches the A/B
#      refresh. The theme dir does not exist on the medium beforehand.
d="$(new_poll_case poll-theme cur-9 cur-9 cur-9)"   # up to date: heal runs, no reboot
printf 'THEME-BODY-v1\n' > "$d/served-theme"
mk_png "$d/served-logo" logo-v1
mk_png "$d/served-bg"   bg-v1
eq "theme heal: medium starts theme-less" "" "$(ls "$d/vol-POLYPTIC-BT/polyptic/boot/theme" 2>/dev/null || true)"
out="$(up "$d")"
tdir="$d/vol-POLYPTIC-BT/polyptic/boot/theme"
eq "theme heal: theme.txt baked from the server" "THEME-BODY-v1" "$(cat "$tdir/theme.txt" 2>/dev/null)"
same "theme heal: logo.png baked from the server" "$d/served-logo" "$tdir/logo.png"
same "theme heal: bg.png baked from the server (POL-130)" "$d/served-bg" "$tdir/bg.png"
has "theme heal: logs the heal"                  "healed the offline boot splash" "$out"
eq "theme heal: up-to-date box does not reboot"  "" "$(cat "$d/systemctl.log" 2>/dev/null || true)"

# 38b) idempotent: a second poll with the medium already current rewrites NOTHING and logs nothing
#      (the every-5-minutes steady state — no FAT churn).
out2="$(up "$d")"
hasnt "theme heal: idempotent second run is silent" "healed the offline boot splash" "$out2"
eq "theme heal: theme.txt unchanged" "THEME-BODY-v1" "$(cat "$tdir/theme.txt" 2>/dev/null)"
eq "theme heal: no stray temp files" "" "$(ls "$tdir" | grep '\.new$' || true)"

# 38c) a changed server theme is re-pulled onto an already-themed medium (drift → re-heal).
printf 'THEME-BODY-v2\n' > "$d/served-theme"
out3="$(up "$d")"
has "theme heal: re-heals on drift"       "healed the offline boot splash" "$out3"
eq "theme heal: theme.txt updated to v2"  "THEME-BODY-v2" "$(cat "$tdir/theme.txt" 2>/dev/null)"

# 38d) a server not serving the theme (/boot/* 404s) heals nothing and stays silent — never a
#      half-written or empty theme (guards the deterministic-bake fallback path too).
d="$(new_poll_case poll-notheme cur-9 cur-9 cur-9)"   # no served-theme/served-logo set → curl exits 22
out="$(up "$d")"
hasnt "theme heal: silent when server serves no theme" "healed the offline boot splash" "$out"
eq "theme heal: no theme.txt written on 404" "" "$(cat "$d/vol-POLYPTIC-BT/polyptic/boot/theme/theme.txt" 2>/dev/null || true)"

# ─── POL-87/POL-130: a theme without its bitmaps makes GRUB error on a keyboard-less screen ─────────
# theme.txt references logo.png (its image block) AND bg.png (the desktop-image GRUB 2.12's gfxmenu
# scales at every draw); a medium carrying the theme without EITHER paints
# "error: null src bitmap ... Press any key to continue" on every offline boot. Pinned here:
# an already-broken stick repairs itself even when the server serves no theme, a zero-byte bitmap
# counts as missing, a bg-less-but-otherwise-complete theme (every pre-POL-130 medium) counts as
# broken, a torn heal can never CREATE the broken state (bitmaps first, theme.txt last — theme.txt
# is the commit, because it is what the GRUB guard keys on), and a served bitmap GRUB cannot DECODE
# is never committed at all ("file exists" is not "file loads").

# 38e) orphan repair: theme.txt with NO logo.png (the pre-fix heal's torn-write legacy) is removed
#      on the next poll — even with the server serving no theme — so the box falls back to the
#      plain menu, which boots silently.
d="$(new_poll_case poll-orphan cur-9 cur-9 cur-9)"   # no served-theme/-logo/-bg → curl exits 22
tdir="$d/vol-POLYPTIC-BT/polyptic/boot/theme"; mkdir -p "$tdir"
printf 'ORPHANED-THEME\n' > "$tdir/theme.txt"
out="$(up "$d")"
eq  "orphan repair: theme.txt removed"  "" "$(cat "$tdir/theme.txt" 2>/dev/null || true)"
has "orphan repair: logs the removal"   "removed an orphan theme.txt" "$out"
out2="$(up "$d")"
hasnt "orphan repair: second run is silent" "removed an orphan theme.txt" "$out2"

# 38f) a ZERO-BYTE logo (a torn FAT write) counts as missing — GRUB would hand it to the scaler and
#      hit the same null bitmap, so the orphan repair fires on it too.
d="$(new_poll_case poll-orphan0 cur-9 cur-9 cur-9)"
tdir="$d/vol-POLYPTIC-BT/polyptic/boot/theme"; mkdir -p "$tdir"
printf 'ORPHANED-THEME\n' > "$tdir/theme.txt"; : > "$tdir/logo.png"; mk_png "$tdir/bg.png" bg
out="$(up "$d")"
eq  "orphan repair: fires on a zero-byte logo" "" "$(cat "$tdir/theme.txt" 2>/dev/null || true)"

# 38f2) POL-130: a COMPLETE-looking pre-POL-130 theme (theme.txt + logo, NO bg.png — what every
#       fielded stick carries) is the state that reproduced on real hardware: GRUB scales a NULL
#       desktop image and errors the moment the menu boots. The orphan repair must treat it as
#       broken and fall back to the plain menu even when the server is unreachable.
d="$(new_poll_case poll-orphan-nobg cur-9 cur-9 cur-9)"
tdir="$d/vol-POLYPTIC-BT/polyptic/boot/theme"; mkdir -p "$tdir"
printf 'PRE-POL130-THEME\n' > "$tdir/theme.txt"; mk_png "$tdir/logo.png" logo
out="$(up "$d")"
eq  "orphan repair: fires on a missing bg.png (POL-130)" "" "$(cat "$tdir/theme.txt" 2>/dev/null || true)"
has "orphan repair: logs the bg removal" "removed an orphan theme.txt" "$out"

# 38g) torn-write ordering: if the FINAL mv dies (yanked stick, FAT error), the medium must be left
#      WITHOUT a theme.txt — plain menu — never with a theme that references bitmaps it doesn't
#      have. The next healthy poll completes the set.
cat > "$BIN/mv" <<'EOF'
#!/bin/sh
if [ -f "$STUB/mv_fail_theme" ]; then
  for a in "$@"; do case "$a" in */theme.txt) exit 1 ;; esac; done
fi
exec /bin/mv "$@"
EOF
chmod +x "$BIN/mv"
d="$(new_poll_case poll-torn cur-9 cur-9 cur-9)"
printf 'THEME-BODY-v1\n' > "$d/served-theme"
mk_png "$d/served-logo" logo-v1
mk_png "$d/served-bg"   bg-v1
: > "$d/mv_fail_theme"
tdir="$d/vol-POLYPTIC-BT/polyptic/boot/theme"
out="$(up "$d")"
eq    "torn heal: no theme.txt committed"  "" "$(cat "$tdir/theme.txt" 2>/dev/null || true)"
hasnt "torn heal: does not claim success"  "healed the offline boot splash" "$out"
eq    "torn heal: no stray temp files"     "" "$(ls "$tdir" 2>/dev/null | grep '\.new$' || true)"
rm -f "$d/mv_fail_theme"
out2="$(up "$d")"
eq   "torn heal: next poll completes the set (theme)" "THEME-BODY-v1" "$(cat "$tdir/theme.txt" 2>/dev/null)"
same "torn heal: next poll completes the set (logo)"  "$d/served-logo" "$tdir/logo.png"
same "torn heal: next poll completes the set (bg)"    "$d/served-bg" "$tdir/bg.png"
rm -f "$BIN/mv"   # later cases must see the real mv

# 38h) POL-130 "file exists is not file loads": a served bitmap grub-png-check.sh rejects (here an
#      INTERLACED png — GRUB 2.12: "png: interlace method not supported") must never be committed.
#      The heal skips the round entirely: no theme.txt, no partial writes, no success log.
d="$(new_poll_case poll-badpng cur-9 cur-9 cur-9)"
printf 'THEME-BODY-v1\n' > "$d/served-theme"
mk_png "$d/served-logo" logo-v1 bad
mk_png "$d/served-bg"   bg-v1
tdir="$d/vol-POLYPTIC-BT/polyptic/boot/theme"
out="$(up "$d")"
eq    "bad-png heal: no theme.txt committed"      "" "$(cat "$tdir/theme.txt" 2>/dev/null || true)"
eq    "bad-png heal: no logo committed"           "" "$(ls "$tdir" 2>/dev/null || true)"
hasnt "bad-png heal: does not claim success"      "healed the offline boot splash" "$out"
# …and the same round starts healing again the moment the server serves a decodable bitmap.
mk_png "$d/served-logo" logo-v1
out2="$(up "$d")"
has  "bad-png heal: recovers once the served png is decodable" "healed the offline boot splash" "$out2"
same "bad-png heal: bg.png committed after recovery" "$d/served-bg" "$tdir/bg.png"

# ─── wifi-diagnostics.sh: the keyboard-less failure report (POL-77) ──────────────────────────────────
# When association can't start the hook writes this report to the medium so a screen with no keyboard
# can be debugged by pulling the stick. What is pinned: it surfaces the staged reject reason, traces
# the EXACT failing validation step, redacts secrets from the rendered supplicant conf, and prints
# every section header even when the inspection tools (ip/iw/rfkill) are absent — the report's whole
# job is to run in a degraded initramfs.

diag() { POLYPTIC_RUN_DIR="$DRUN" POLYPTIC_LIB_DIR="$LIB" sh "$LIB/wifi-diagnostics.sh" "$ROOT/wifi.conf"; }

# 39) a rejected short-PSK config: the report carries the reason AND the pinpointing trace.
DRUN="$ROOT/diag-run"; mkdir -p "$DRUN"
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=short'
printf 'wifi-conf: WIFI_PSK must be an 8-63 character passphrase or exactly 64 hex digits\n' > "$DRUN/wifi.err"
out="$(diag)"
has "diag surfaces the reject reason" "8-63 character passphrase" "$out"
has "diag has a validation trace"     "validation trace" "$out"
has "diag trace shows the exit code"  "wifi-conf.sh exit: 1" "$out"
has "diag lists tool resolution"      "tool resolution" "$out"
has "diag enumerates interfaces"      "all network interfaces" "$out"
has "diag has an ip section"          "ip link" "$out"

# 40) secrets in the rendered supplicant conf are redacted in the report.
printf 'network={\n  ssid=4d794e6574\n  psk="topsecretpass"\n}\n' > "$DRUN/wpa_supplicant.conf"
out="$(diag)"
has "diag redacts the psk"   "psk=<redacted>" "$out"
hasnt "diag leaks no secret" "topsecretpass" "$out"

# 41) a healthy config still produces a report (exit-0 trace), not just failures.
DRUN="$ROOT/diag-ok"; mkdir -p "$DRUN"
conf 'WIFI_SSID=MyNet' 'WIFI_PSK=hunter2hunter2'
out="$(diag)"
has "diag runs on a valid config too" "wifi-conf.sh exit: 0" "$out"

[ "$fails" = 0 ] && { echo "ALL PASS"; exit 0; } || { echo "$fails FAILED"; exit 1; }
