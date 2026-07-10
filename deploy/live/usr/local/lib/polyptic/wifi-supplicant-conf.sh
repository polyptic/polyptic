#!/bin/sh
# Render a wpa_supplicant config from the medium's wifi.conf → stdout (POL-63). Pure; wraps
# wifi-conf.sh (which owns parsing + validation) and owns only the ESCAPING and the wpa_supplicant
# dialect, so the two failure modes stay separable: a bad file fails in wifi-conf.sh with a message,
# a rendering bug fails here in tests.
#
# Escaping is what this file exists for. wpa_supplicant string values are C-style quoted strings, and
# an SSID/passphrase containing `"` or `\` (or a UTF-8 SSID) must survive the round trip byte-exact:
#   - ssid is ALWAYS emitted as a bare hex string (`ssid=48656c6c6f`) — no quoting rules to get wrong;
#   - a 64-hex WIFI_PSK is the raw pre-derived key and is emitted bare (`psk=<hex>`); such a network
#     is WPA2-only (SAE derives from the passphrase, which a raw key no longer has);
#   - every other string value is quoted with `\` and `"` escaped.
# Both the initrd hook and the rootfs polyptic-wifi.service call this, so one association dialect
# serves the whole boot (D67).
#
#   $1 / POLYPTIC_WIFI_CONF      the wifi.conf to render
#   POLYPTIC_WIFI_CERT_DIR       where the medium's polyptic/ tree was staged (default /run/polyptic);
#                                relative WIFI_*_CERT paths resolve against it
#   POLYPTIC_LIB_DIR             where wifi-conf.sh lives (default: beside this script)
#
# Exit contract mirrors wifi-conf.sh: no config → nothing, exit 0; invalid → its stderr line, exit 1.

LIB="${POLYPTIC_LIB_DIR:-$(CDPATH= cd "$(dirname "$0")" && pwd)}"
CONF="${POLYPTIC_WIFI_CONF:-${1:-}}"
CERT_DIR="${POLYPTIC_WIFI_CERT_DIR:-/run/polyptic}"

parsed="$(sh "$LIB/wifi-conf.sh" "$CONF")" || exit 1
[ -n "$parsed" ] || exit 0

ssid=""; security=""; hidden=""; country=""; psk=""; eap=""; identity=""
password=""; phase2=""; anon=""; ca_cert=""; client_cert=""; client_key=""
while IFS= read -r line; do
  k="${line%%=*}"; v="${line#*=}"
  case "$k" in
    WIFI_SSID) ssid="$v" ;;                WIFI_SECURITY) security="$v" ;;
    WIFI_HIDDEN) hidden="$v" ;;            WIFI_COUNTRY) country="$v" ;;
    WIFI_PSK) psk="$v" ;;                  WIFI_EAP) eap="$v" ;;
    WIFI_IDENTITY) identity="$v" ;;        WIFI_PASSWORD) password="$v" ;;
    WIFI_PHASE2) phase2="$v" ;;            WIFI_ANONYMOUS_IDENTITY) anon="$v" ;;
    WIFI_CA_CERT) ca_cert="$v" ;;          WIFI_CLIENT_CERT) client_cert="$v" ;;
    WIFI_CLIENT_KEY) client_key="$v" ;;
  esac
done <<EOF
$parsed
EOF

hex() { printf '%s' "$1" | od -An -v -tx1 | tr -d ' \n'; }
esc() { printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'; }
qline() { printf '  %s="%s"\n' "$1" "$(esc "$2")"; }   # quoted-string field
certline() { printf '  %s="%s/%s"\n' "$1" "$CERT_DIR" "$2"; }

printf '# Generated from the boot medium'"'"'s polyptic/wifi.conf (POL-63); regenerated every boot, do not edit.\n'
printf 'ctrl_interface=DIR=/run/wpa_supplicant GROUP=root\n'
[ -z "$country" ] || printf 'country=%s\n' "$country"
printf '\nnetwork={\n'
printf '  ssid=%s\n' "$(hex "$ssid")"
[ -z "$hidden" ] || printf '  scan_ssid=1\n'

case "$security" in
  open)
    printf '  key_mgmt=NONE\n'
    ;;
  psk)
    if printf '%s' "$psk" | grep -Eq '^[0-9a-fA-F]{64}$'; then
      printf '  key_mgmt=WPA-PSK\n'
      printf '  psk=%s\n' "$(printf '%s' "$psk" | tr 'A-F' 'a-f')"
    else
      # Passphrase: offer WPA2-PSK and WPA3-SAE, let the AP pick; ieee80211w=1 (PMF optional) keeps
      # WPA2-only APs working while satisfying WPA3's PMF requirement.
      printf '  key_mgmt=WPA-PSK SAE\n'
      printf '  ieee80211w=1\n'
      qline psk "$psk"
    fi
    ;;
  eap)
    printf '  key_mgmt=WPA-EAP\n'
    printf '  ieee80211w=1\n'
    printf '  eap=%s\n' "$(printf '%s' "$eap" | tr 'a-z' 'A-Z')"
    qline identity "$identity"
    [ -z "$anon" ] || qline anonymous_identity "$anon"
    case "$eap" in
      peap|ttls)
        qline password "$password"
        # Default inner method is MSCHAPv2 (the near-universal RADIUS setup); PAP is ttls-only and
        # already validated by wifi-conf.sh.
        case "${phase2:-mschapv2}" in
          pap) printf '  phase2="auth=PAP"\n' ;;
          *)   printf '  phase2="auth=MSCHAPV2"\n' ;;
        esac
        ;;
      tls)
        certline client_cert "$client_cert"
        certline private_key "$client_key"
        [ -z "$password" ] || qline private_key_passwd "$password"
        ;;
    esac
    [ -z "$ca_cert" ] || certline ca_cert "$ca_cert"
    ;;
esac
printf '}\n'
exit 0
