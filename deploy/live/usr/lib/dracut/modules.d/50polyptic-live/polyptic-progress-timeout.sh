#!/bin/sh
# Polyptic (POL-35): splash narration, phase 3 — the initqueue TIMEOUT path, which only runs when
# the boot has genuinely stalled (no root device after the wait). One-shot.
#
# The SPLASH text is deliberately generic (public signage, no identifiers — see
# polyptic-progress-online.sh); the actionable detail (host, the check list: does the name
# resolve, is the control plane up and reachable over plain HTTP) goes to /dev/kmsg for the
# console behind alt-tab.
#
# SOURCED by dracut's initqueue (see polyptic-ram.sh for the sourcing rules: no set -e/-u, no exit).
if [ ! -e /tmp/polyptic-progress-timeout ]; then
    : > /tmp/polyptic-progress-timeout
    if type plymouth > /dev/null 2>&1 && plymouth --ping 2> /dev/null; then
        plymouth display-message --text="Cannot fetch the OS image" 2> /dev/null || :
    fi
    polyptic_host="$(sed -n 's!.*root=live:https\{0,1\}://\([^/ ]*\).*!\1!p' /proc/cmdline 2> /dev/null)"
    echo "polyptic: cannot fetch the OS image from ${polyptic_host:-?} — check that the name resolves and that the control plane is up and reachable over plain HTTP" > /dev/console 2> /dev/null || :   # /dev/kmsg writes are dropped in the initqueue (verified); the console IS the alt-tab channel
    unset polyptic_host
fi
