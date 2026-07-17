#!/bin/sh
# Bring up Wi-Fi in the ROOTFS from the boot medium's polyptic/wifi.conf (POL-63). ExecStart for
# polyptic-wifi.service, ordered Before=systemd-networkd-wait-online.service so a Wi-Fi-only box's
# association counts toward wait-online's --any.
#
# This is the LINUX-WORLD HANDOFF: even when the dracut initrd already associated to download the
# root image, that supplicant died at switch-root — and without a running supplicant the connection
# survives only until the next WPA group-key rotation (minutes). So the rootfs re-reads the SAME
# credentials and runs its own wpa_supplicant@<iface>, which is what keeps the agent, the wall's web
# pages, and the update poll online. networkd then DHCPs the interface via the static
# 80-polyptic-wlan.network — the exact split netplan uses, minus netplan.
#
# Credential sources, in order (first hit wins):
#   1. /run/polyptic/wifi.conf        staged by the initrd hook (/run survives switch-root)
#   2. /run/initramfs/live/polyptic/  the live ISO's mounted medium (dracut keeps it mounted)
#   3. find-boot-medium.sh            the USB stick / offloaded ESP, mounted briefly read-only
# No source → exit 0 silently: no Wi-Fi is the normal state of every wired box.
#
# A PRESENT-but-invalid config fails loudly (unit failure + the boot splash names the problem) —
# a Wi-Fi box with a typo'd wifi.conf must say so on the screen the operator is standing at, not
# sit on "Starting up" forever.
#
# Stubbable for the off-box tests: every path + external below is overridable / on PATH.
#   POLYPTIC_RUN_DIR (/run/polyptic)   POLYPTIC_LIVE_DIR (/run/initramfs/live)
#   POLYPTIC_LIB_DIR (this dir)        POLYPTIC_NET_DIR  (/sys/class/net)
#   POLYPTIC_WPA_DIR (/etc/wpa_supplicant)   POLYPTIC_MEDIUM_TRIES (10)
set -u

LIB="${POLYPTIC_LIB_DIR:-$(CDPATH= cd "$(dirname "$0")" && pwd)}"
RUN_DIR="${POLYPTIC_RUN_DIR:-/run/polyptic}"
LIVE_DIR="${POLYPTIC_LIVE_DIR:-/run/initramfs/live}"
NET_DIR="${POLYPTIC_NET_DIR:-/sys/class/net}"
WPA_DIR="${POLYPTIC_WPA_DIR:-/etc/wpa_supplicant}"
TRIES="${POLYPTIC_MEDIUM_TRIES:-10}"

say() {
  printf 'polyptic-wifi: %s\n' "$1" >&2
  if command -v plymouth >/dev/null 2>&1; then
    plymouth message --text="Polyptic: $1" >/dev/null 2>&1 || true
  fi
  return 0
}

# ── Stage the credentials into $RUN_DIR (root-only: the PSK/password is a secret) ───────────────────
stage_from() {  # $1 = a directory containing wifi.conf (+ optionally certs/)
  mkdir -p "$RUN_DIR"
  cp "$1/wifi.conf" "$RUN_DIR/wifi.conf" || return 1
  chmod 0600 "$RUN_DIR/wifi.conf"
  if [ -d "$1/certs" ]; then
    rm -rf "$RUN_DIR/certs"
    cp -R "$1/certs" "$RUN_DIR/certs"
    chmod -R go-rwx "$RUN_DIR/certs"
  fi
  return 0
}

if [ -f "$RUN_DIR/wifi.conf" ]; then
  :   # the initrd hook already staged it
elif [ -f "$LIVE_DIR/polyptic/wifi.conf" ]; then
  stage_from "$LIVE_DIR/polyptic" || exit 1
else
  # The medium's device node may still be settling this early in boot; poll briefly, then accept
  # absence — every wired box lands here every boot, so absence must stay cheap and silent.
  mnt="$(mktemp -d)"; dev=""; i=0
  while [ "$i" -lt "$TRIES" ]; do
    dev="$(sh "$LIB/find-boot-medium.sh" "$mnt" ro 2>/dev/null || true)"
    [ -n "$dev" ] && break
    i=$((i+1)); [ "$i" -lt "$TRIES" ] && sleep 1
  done
  if [ -z "$dev" ]; then rmdir "$mnt" 2>/dev/null || true; exit 0; fi
  if [ ! -f "$mnt/polyptic/wifi.conf" ]; then
    umount "$mnt" 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true; exit 0
  fi
  stage_from "$mnt/polyptic"; rc=$?
  umount "$mnt" 2>/dev/null || true; rmdir "$mnt" 2>/dev/null || true
  [ "$rc" = 0 ] || exit 1
fi

# ── Render the supplicant config (validation lives in wifi-conf.sh; failures are named) ─────────────
conf="$(POLYPTIC_WIFI_CERT_DIR="$RUN_DIR" sh "$LIB/wifi-supplicant-conf.sh" "$RUN_DIR/wifi.conf" 2>"$RUN_DIR/wifi.err")"
if [ $? -ne 0 ]; then
  say "Wi-Fi config rejected. $(cat "$RUN_DIR/wifi.err" 2>/dev/null || echo 'see journalctl -u polyptic-wifi')"
  exit 1
fi
[ -n "$conf" ] || exit 0   # a comment-only template configures nothing

# ── One supplicant per wireless interface ───────────────────────────────────────────────────────────
started=0
for path in "$NET_DIR"/*; do
  [ -d "$path/wireless" ] || continue
  ifname="$(basename "$path")"
  mkdir -p "$WPA_DIR"
  printf '%s\n' "$conf" > "$WPA_DIR/wpa_supplicant-$ifname.conf"
  chmod 0600 "$WPA_DIR/wpa_supplicant-$ifname.conf"
  if systemctl start "wpa_supplicant@$ifname.service"; then
    say "Wi-Fi: joining $(sed -n 's/^WIFI_SSID=//p' "$RUN_DIR/wifi.conf" | head -n1) on $ifname"
    started=$((started+1))
  else
    say "Wi-Fi: wpa_supplicant failed to start on $ifname (journalctl -u wpa_supplicant@$ifname)"
  fi
done

if [ "$started" = 0 ]; then
  # A wifi.conf on the medium + no radio is worth saying out loud: it is either a wired box sharing
  # the fleet stick (fine) or a Wi-Fi box whose adapter has no driver/firmware (the curated-set gap).
  say "Wi-Fi configured but no wireless interface exists on this box (fine if it is wired, otherwise the adapter needs firmware). See FULL_FIRMWARE in docs/NETBOOT.md"
fi
exit 0
