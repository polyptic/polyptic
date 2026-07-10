#!/bin/sh
# Parse + validate the Polyptic Wi-Fi credentials file → normalized WIFI_* lines on stdout (POL-63).
# Pure; the source is $1 or POLYPTIC_WIFI_CONF. The file lives on the boot medium as
# `polyptic/wifi.conf`, is edited by OPERATORS in whatever editor is at hand, and is NEVER
# sourced/eval'd — values are split on the FIRST '=' and taken verbatim to end of line, so SSIDs and
# passphrases with spaces, quotes or '=' need no escaping. Trailing CRs are stripped (a file touched
# by Notepad arrives CRLF). First occurrence of a key wins (the parse-cmdline.sh convention).
#
# Schema (all values one line; keys are the ONLY vocabulary — an unknown key is a hard error, because
# a typo'd WIFI_PSK silently ignored means a box that never comes online):
#   WIFI_SSID=<network name>                      required
#   WIFI_SECURITY=psk|eap|open                    optional; inferred from the keys present
#   WIFI_HIDDEN=0|1                               optional (also yes/no/true/false)
#   WIFI_COUNTRY=<ISO 3166-1 alpha-2>             optional regulatory domain, e.g. GB
#   WIFI_PSK=<passphrase|64-hex>                  psk: 8..63 byte passphrase, or the raw 256-bit key
#   WIFI_EAP=peap|ttls|tls                        eap only; default peap
#   WIFI_IDENTITY=<username>                      eap: required
#   WIFI_PASSWORD=<password>                      eap peap/ttls: required; tls: the private-key passphrase
#   WIFI_PHASE2=mschapv2|pap                      eap peap/ttls; pap is ttls-only; default mschapv2
#   WIFI_ANONYMOUS_IDENTITY=<outer identity>      eap, optional
#   WIFI_CA_CERT=certs/ca.pem                     eap, optional; path RELATIVE to the medium's polyptic/
#   WIFI_CLIENT_CERT=certs/box.pem                eap tls: required
#   WIFI_CLIENT_KEY=certs/box.key                 eap tls: required
#
# Exit contract: absent/comment-only file → NOTHING on stdout, exit 0 (no Wi-Fi is a fine state);
# a file that sets keys but fails validation → one plain-English line on stderr, exit 1, no output
# (a half-valid config must never half-configure a supplicant).

CONF="${POLYPTIC_WIFI_CONF:-${1:-}}"
[ -n "$CONF" ] && [ -r "$CONF" ] || exit 0

fail() { printf 'wifi-conf: %s\n' "$1" >&2; exit 1; }
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }

CR="$(printf '\r')"
ssid=""; security=""; hidden=""; country=""; psk=""; eap=""; identity=""
password=""; phase2=""; anon=""; ca_cert=""; client_cert=""; client_key=""
seen=""

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%"$CR"}"
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) fail "malformed line (expected KEY=value): '$line'" ;; esac
  k="${line%%=*}"; v="${line#*=}"
  [ -n "$v" ] || continue           # an empty value means "unset", so templates can ship blank keys
  case "$k" in
    WIFI_SSID)               [ -n "$ssid" ]        || ssid="$v" ;;
    WIFI_SECURITY)           [ -n "$security" ]    || security="$(lower "$v")" ;;
    WIFI_HIDDEN)             [ -n "$hidden" ]      || hidden="$(lower "$v")" ;;
    WIFI_COUNTRY)            [ -n "$country" ]     || country="$v" ;;
    WIFI_PSK)                [ -n "$psk" ]         || psk="$v" ;;
    WIFI_EAP)                [ -n "$eap" ]         || eap="$(lower "$v")" ;;
    WIFI_IDENTITY)           [ -n "$identity" ]    || identity="$v" ;;
    WIFI_PASSWORD)           [ -n "$password" ]    || password="$v" ;;
    WIFI_PHASE2)             [ -n "$phase2" ]      || phase2="$(lower "$v")" ;;
    WIFI_ANONYMOUS_IDENTITY) [ -n "$anon" ]        || anon="$v" ;;
    WIFI_CA_CERT)            [ -n "$ca_cert" ]     || ca_cert="$v" ;;
    WIFI_CLIENT_CERT)        [ -n "$client_cert" ] || client_cert="$v" ;;
    WIFI_CLIENT_KEY)         [ -n "$client_key" ]  || client_key="$v" ;;
    *) fail "unknown key '$k' — check the spelling against the WIFI_* schema in docs/NETBOOT.md" ;;
  esac
  seen=1
done < "$CONF"

[ -n "$seen" ] || exit 0            # a template of comments/blank keys configures nothing
[ -n "$ssid" ] || fail "WIFI_SSID is required"

# Security mode: explicit, else inferred from which credential keys are present.
if [ -z "$security" ]; then
  if [ -n "$eap$identity$client_cert" ]; then security=eap
  elif [ -n "$psk" ]; then security=psk
  else security=open; fi
fi
case "$security" in psk|eap|open) ;; *) fail "WIFI_SECURITY must be psk, eap or open (got '$security')" ;; esac

case "$hidden" in
  ''|0|no|false) hidden="" ;;
  1|yes|true)    hidden=1 ;;
  *) fail "WIFI_HIDDEN must be 0 or 1 (got '$hidden')" ;;
esac

if [ -n "$country" ]; then
  printf '%s' "$country" | grep -Eq '^[A-Za-z][A-Za-z]$' \
    || fail "WIFI_COUNTRY must be a two-letter code like GB (got '$country')"
  country="$(printf '%s' "$country" | tr 'a-z' 'A-Z')"
fi

# A cert path names a file the operator put on the medium under polyptic/, so it must stay inside
# that directory: relative, no '..', and a conservative charset (it crosses a FAT filesystem anyway).
cert_path_ok() {
  case "$2" in
    /*)   fail "$1 must be a path relative to the medium's polyptic/ directory (got '$2')" ;;
    *..*) fail "$1 must not contain '..' (got '$2')" ;;
  esac
  printf '%s' "$2" | grep -Eq '^[A-Za-z0-9._/-]+$' || fail "$1 contains unsupported characters (got '$2')"
}

case "$security" in
  psk)
    [ -n "$psk" ] || fail "WIFI_SECURITY=psk needs WIFI_PSK"
    if ! printf '%s' "$psk" | grep -Eq '^[0-9a-fA-F]{64}$'; then
      n="$(printf '%s' "$psk" | wc -c | tr -d '[:space:]')"
      { [ "$n" -ge 8 ] && [ "$n" -le 63 ]; } \
        || fail "WIFI_PSK must be an 8-63 character passphrase or exactly 64 hex digits"
    fi
    ;;
  eap)
    [ -n "$eap" ] || eap=peap
    case "$eap" in peap|ttls|tls) ;; *) fail "WIFI_EAP must be peap, ttls or tls (got '$eap')" ;; esac
    [ -n "$identity" ] || fail "WPA-Enterprise (WIFI_SECURITY=eap) needs WIFI_IDENTITY"
    case "$eap" in
      peap|ttls) [ -n "$password" ] || fail "WIFI_EAP=$eap needs WIFI_PASSWORD" ;;
      tls) { [ -n "$client_cert" ] && [ -n "$client_key" ]; } \
             || fail "WIFI_EAP=tls needs WIFI_CLIENT_CERT and WIFI_CLIENT_KEY" ;;
    esac
    if [ -n "$phase2" ]; then
      case "$phase2" in
        mschapv2) ;;
        pap) [ "$eap" = ttls ] || fail "WIFI_PHASE2=pap is only valid with WIFI_EAP=ttls" ;;
        *) fail "WIFI_PHASE2 must be mschapv2 or pap (got '$phase2')" ;;
      esac
    fi
    [ -z "$ca_cert" ]     || cert_path_ok WIFI_CA_CERT "$ca_cert"
    [ -z "$client_cert" ] || cert_path_ok WIFI_CLIENT_CERT "$client_cert"
    [ -z "$client_key" ]  || cert_path_ok WIFI_CLIENT_KEY "$client_key"
    ;;
esac

emit() { [ -z "$2" ] || printf '%s=%s\n' "$1" "$2"; }
emit WIFI_SSID "$ssid"
emit WIFI_SECURITY "$security"
emit WIFI_HIDDEN "$hidden"
emit WIFI_COUNTRY "$country"
case "$security" in
  psk) emit WIFI_PSK "$psk" ;;
  eap)
    emit WIFI_EAP "$eap"
    emit WIFI_IDENTITY "$identity"
    emit WIFI_PASSWORD "$password"
    emit WIFI_PHASE2 "$phase2"
    emit WIFI_ANONYMOUS_IDENTITY "$anon"
    emit WIFI_CA_CERT "$ca_cert"
    emit WIFI_CLIENT_CERT "$client_cert"
    emit WIFI_CLIENT_KEY "$client_key"
    ;;
esac
exit 0
