#!/bin/sh
# Emit a Wi-Fi bring-up diagnostics report to stdout (POL-77). A display node has no keyboard and its
# screen shows only the generic "Wi-Fi config rejected" splash, so when the initramfs hook cannot
# start association it calls this and writes the output to the boot medium as polyptic/wifi-debug.txt:
# the operator pulls the stick, reads it on a laptop, and sees WHY — the exact failing validation
# step, the runtime PATH and tool set (the initrd is a curated environment, so a missing tool is a
# real possibility), and the full network/interface state.
#
# Pure inspection: mutates nothing, starts no supplicant. Every external probe is guarded with have()
# so a tool absent from the initramfs degrades to a one-line note instead of aborting the report —
# the report's whole job is to run in a degraded environment.
#
#   $1 / POLYPTIC_WIFI_CONF   the wifi.conf that was rejected (default /run/polyptic/wifi.conf)
#   POLYPTIC_RUN_DIR          where the hook staged wifi.err / wpa_supplicant.conf (default /run/polyptic)
#   POLYPTIC_LIB_DIR          where wifi-conf.sh lives (default: beside this script)
#
# NOTE: the validation trace echoes shell variables, so this file can contain the Wi-Fi passphrase —
# it lives on the same medium as wifi.conf (which already holds it in clear), but treat it the same:
# do not photograph or share it without redacting.

CONF="${POLYPTIC_WIFI_CONF:-${1:-/run/polyptic/wifi.conf}}"
RUN="${POLYPTIC_RUN_DIR:-/run/polyptic}"
# Pure-shell own-directory resolution: the initramfs has no `dirname` (POL-78 — the very bug this
# report exists to catch), so never depend on it here either.
_lib="${0%/*}"; [ "$_lib" = "$0" ] && _lib="."
LIB="${POLYPTIC_LIB_DIR:-$_lib}"

have() { command -v "$1" >/dev/null 2>&1; }
sec()  { printf '\n===== %s =====\n' "$1"; }
# Run an inspection command if its binary exists, else note its absence; never fail the report.
run()  { if have "$1"; then "$@" 2>&1 || printf '[%s exited %s]\n' "$1" "$?"; else printf '[%s: not in initramfs]\n' "$1"; fi; }

printf 'Polyptic Wi-Fi diagnostics (POL-77)\n'
printf 'Written during initramfs Wi-Fi bring-up because association could not start. May contain the\n'
printf 'Wi-Fi passphrase (same as wifi.conf), so treat accordingly.\n'

sec 'reject reason (wifi-supplicant-conf.sh stderr)'
cat "$RUN/wifi.err" 2>/dev/null || printf '(no wifi.err, so the supplicant-config step may not have run)\n'

sec 'generated wpa_supplicant.conf (psk/password redacted)'
if [ -s "$RUN/wpa_supplicant.conf" ]; then
  sed -e 's/^\( *psk=\).*/\1<redacted>/' -e 's/^\( *password=\).*/\1<redacted>/' "$RUN/wpa_supplicant.conf"
else
  printf '(empty or absent because nothing was generated, which is what triggered the reject)\n'
fi

sec 'runtime PATH (does it include where the validator tools live?)'
printf '%s\n' "$PATH"

sec 'tool resolution (each validator/diagnostic dependency)'
for t in sh wc od tr grep sed cut cat mount umount blkid wpa_supplicant ip iw rfkill dmesg lsmod; do
  if have "$t"; then printf '%-14s %s\n' "$t" "$(command -v "$t")"; else printf '%-14s NOT FOUND\n' "$t"; fi
done

sec 'validation trace (sh -x wifi-conf.sh — pinpoints the failing step)'
sh -x "$LIB/wifi-conf.sh" "$CONF" 2>&1
printf '[wifi-conf.sh exit: %s]\n' "$?"

sec 'wifi.conf as the box read it (od -c — reveals hidden/CR/UTF-8 bytes)'
if have od; then od -c "$CONF" 2>/dev/null || printf '(unreadable)\n'; else cat "$CONF" 2>/dev/null || printf '(unreadable)\n'; fi

sec 'wireless-capable interfaces (/sys/class/net/*/wireless)'
_found=
for _d in /sys/class/net/*/wireless; do
  [ -d "$_d" ] || continue
  _ifn="${_d%/wireless}"; printf '%s\n' "${_ifn##*/}"; _found=1
done
[ -n "$_found" ] || printf '(none because no wireless interface is present in this kernel/initramfs)\n'

sec 'all network interfaces (/sys/class/net)'
for _d in /sys/class/net/*; do [ -e "$_d" ] || continue; printf '%s\n' "${_d##*/}"; done

sec 'ip link (every interface, detailed)'
run ip -d link show

sec 'ip addr (addresses per interface)'
run ip -d addr show

sec 'ip route'
run ip route show

sec 'iw dev (wireless device/interface state)'
run iw dev

sec 'rfkill (is a radio soft/hard blocked?)'
run rfkill list

sec 'loaded wireless/net modules'
if have lsmod; then
  lsmod | grep -iE 'cfg80211|mac80211|iwl|iwlwifi|iwlmvm|ath[0-9k]|rtw|rtl8|brcm|mt7|mwifiex|r8152|r8169|igc' \
    || printf '(no matching modules loaded)\n'
else
  printf '[lsmod: not in initramfs]\n'
fi

sec 'kernel wifi/firmware messages (dmesg tail)'
if have dmesg; then
  dmesg 2>/dev/null | grep -iE 'firmware|cfg80211|wlan|wifi|iwl|ath|rtw|rtl8|brcm|mt7|mwifiex|regulatory|nl80211' | tail -60 \
    || printf '(no matching dmesg lines)\n'
else
  printf '[dmesg: not in initramfs]\n'
fi

printf '\n===== end of Polyptic Wi-Fi diagnostics =====\n'
