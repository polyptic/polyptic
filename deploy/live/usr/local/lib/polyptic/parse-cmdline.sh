#!/bin/sh
# Parse Polyptic runtime config out of the kernel command line → systemd EnvironmentFile lines on stdout
# (POL-33). Pure; the source is overridable via POLYPTIC_CMDLINE_FILE (default /proc/cmdline).
#
# Namespaced keys (so they can't clash with kernel/casper options), baked by GET /boot/grub.cfg:
#   polyptic.server_url=<ws(s) agent URL, e.g. ws://10.0.0.10:8080/agent> → POLYPTIC_SERVER_URL
#   polyptic.token=<one bootstrap enrolment token>                        → POLYPTIC_BOOTSTRAP_TOKEN
# Other polyptic.* keys (polyptic.base=, polyptic.offload=1) are read elsewhere and ignored here.
#
# /proc/cmdline is one whitespace-separated line; URLs/tokens contain no spaces. First occurrence wins.
# An absent key emits NOTHING (the agent keeps its agent.toml / built-in default). Never eval's a value.

CMDLINE_FILE="${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}"
[ -r "$CMDLINE_FILE" ] || exit 0

server_url=""; token=""
IFS= read -r line < "$CMDLINE_FILE" || line=""
for tok in $line; do            # intentional unquoted split on IFS whitespace
  case "$tok" in
    polyptic.server_url=*) [ -z "$server_url" ] && server_url="${tok#polyptic.server_url=}" ;;
    polyptic.token=*)      [ -z "$token" ]      && token="${tok#polyptic.token=}" ;;
  esac
done

[ -n "$server_url" ] && printf 'POLYPTIC_SERVER_URL=%s\n' "$server_url"
[ -n "$token" ]      && printf 'POLYPTIC_BOOTSTRAP_TOKEN=%s\n' "$token"
exit 0
