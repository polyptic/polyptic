#!/usr/bin/env sh
# Pure-shell tests for the clock-sync conf helper (POL-148). Runs ANYWHERE (macOS/Linux/CI), no root:
# it just feeds timesync-conf.sh a fixture cmdline + output dir and checks the timesyncd drop-in it
# writes. Wrapped by packages/e2e/netboot-timesync.test.ts so it runs in `bun test` / CI.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

runN=0
run() { # <cmdline> ; writes into a fresh conf dir, echoes the NTP= line (or empty)
  runN=$((runN+1))
  cmdfile="$TMP/cmdline"; confdir="$TMP/conf.$runN"
  rm -rf "$confdir"
  printf '%s\n' "$1" > "$cmdfile"
  POLYPTIC_CMDLINE_FILE="$cmdfile" POLYPTIC_TIMESYNC_CONF_DIR="$confdir" sh "$LIB/timesync-conf.sh"
  [ -f "$confdir/10-polyptic.conf" ] && grep '^NTP=' "$confdir/10-polyptic.conf" || true
}

# 1) explicit polyptic.ntp wins.
eq "explicit polyptic.ntp" "NTP=boot.polyptic.example.com" \
  "$(run 'root=live:x rd.overlay=1 polyptic.ntp=boot.polyptic.example.com polyptic.server_url=ws://other.host/agent quiet')"

# 2) fallback: derive the host out of the ws:// agent URL (scheme, port, path all stripped).
eq "fallback from server_url host" "NTP=10.0.0.10" \
  "$(run 'root=live:x polyptic.server_url=ws://10.0.0.10:8080/agent quiet splash')"

# 3) wss:// with userinfo + path still yields the bare host.
eq "wss with userinfo+path" "NTP=time.example" \
  "$(run 'polyptic.server_url=wss://user@time.example:9443/agent')"

# 4) no ntp and no server_url -> writes NOTHING (never a boot failure over a clock).
eq "no keys -> no file" "" \
  "$(run 'root=live:CDLABEL=POLYPTIC quiet splash')"

# 5) [Time] section header is present so timesyncd parses NTP=.
cmdfile="$TMP/c5"; confdir="$TMP/conf5"
printf 'polyptic.ntp=h.example\n' > "$cmdfile"
POLYPTIC_CMDLINE_FILE="$cmdfile" POLYPTIC_TIMESYNC_CONF_DIR="$confdir" sh "$LIB/timesync-conf.sh"
eq "drop-in has [Time] header" "[Time]" "$(grep '^\[Time\]$' "$confdir/10-polyptic.conf")"

[ "$fails" = 0 ] && { echo "ALL PASS"; exit 0; } || { echo "$fails FAILED"; exit 1; }
