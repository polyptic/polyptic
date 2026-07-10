#!/bin/sh
# Polyptic (POL-35): splash narration, phase 2 — an interface is ONLINE and livenet is about to
# curl the root image (its hook runs at initqueue/online 95, right after this one). One-shot.
#
# The SPLASH text is deliberately generic: wall screens are public signage, so no hostnames or
# other identifiers ever go there. The detail (which host the box is fetching from — the first
# question every netboot failure asks) goes to /dev/kmsg, readable on the console behind alt-tab.
#
# SOURCED by dracut's initqueue (see polyptic-ram.sh for the sourcing rules: no set -e/-u, no exit).
if [ ! -e /tmp/polyptic-progress-online ]; then
    : > /tmp/polyptic-progress-online
    if type plymouth > /dev/null 2>&1 && plymouth --ping 2> /dev/null; then
        plymouth display-message --text="Downloading the OS image ..." 2> /dev/null || :
    fi
    polyptic_host="$(sed -n 's!.*root=live:https\{0,1\}://\([^/ ]*\).*!\1!p' /proc/cmdline 2> /dev/null)"
    echo "polyptic: network online, downloading the OS image from ${polyptic_host:-?}" > /dev/console 2> /dev/null || :   # /dev/kmsg writes are dropped in the initqueue (verified); the console IS the alt-tab channel
    unset polyptic_host
fi
