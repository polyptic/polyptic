#!/bin/sh
# Polyptic (POL-35): splash narration, phase 1 — the initqueue is settling and no interface is
# online yet, i.e. the box is waiting on link/DHCP. One-shot.
#
# The SPLASH text names no protocol (POL-47: a wall screen is public signage, and "DHCP" means
# nothing to whoever walks past it); the console line below keeps the word for whoever is debugging.
#
# SOURCED by dracut's initqueue (see polyptic-ram.sh for the sourcing rules: no set -e/-u, no exit).
if [ ! -e /tmp/polyptic-progress-wait ]; then
    : > /tmp/polyptic-progress-wait
    if type plymouth > /dev/null 2>&1 && plymouth --ping 2> /dev/null; then
        plymouth display-message --text="Waiting for the network ..." 2> /dev/null || :
    fi
    echo "polyptic: waiting for the network (DHCP)" > /dev/console 2> /dev/null || :   # /dev/kmsg writes are dropped in the initqueue (verified); the console IS the alt-tab channel
fi
