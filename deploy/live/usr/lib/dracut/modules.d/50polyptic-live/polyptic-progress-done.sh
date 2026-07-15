#!/bin/sh
# Polyptic (POL-53): splash narration, phase 4 — the root image is mounted and we are about to
# switch-root. Take our narration back down.
#
# The splash carries ONE status line, and a `plymouth display-message` outranks systemd's unit-name
# status while it is up (see the theme's status_line() in packages/agent/src/setup/plymouth.ts).
# Nothing hides those messages on its own, so without this hook the wall would still read
# "Downloading the OS image ..." while the real root boots — and `plymouth quit --retain-splash`
# would freeze that stale frame on screen for the compositor to paint over. Hiding them hands the
# line back to systemd, which is the thing actually making progress from here on.
#
# Every message the earlier phases can raise is named: hide-message matches on exact text, and
# whichever one is currently up is the one that clears. The others are no-ops.
#
# SOURCED by dracut (see polyptic-ram.sh for the sourcing rules: no set -e/-u, no exit).
if type plymouth > /dev/null 2>&1 && plymouth --ping 2> /dev/null; then
    plymouth hide-message --text="Waiting for the network (DHCP) ..." 2> /dev/null || :
    plymouth hide-message --text="Downloading the OS image ..." 2> /dev/null || :
    plymouth hide-message --text="Cannot fetch the OS image" 2> /dev/null || :
fi
