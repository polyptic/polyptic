#!/bin/sh
# polyptych-agent — pre-remove hook (deb prerm / rpm preun; one script for both).
#
# nfpm passes the packager-native argument:
#   deb prerm: $1 = remove | upgrade | deconfigure | failed-upgrade
#   rpm preun: $1 = 0 (final erase) | 1 (upgrade)
# Tear down ONLY on a genuine removal — never on an upgrade (which would needlessly blank the wall
# between the old and new binary).
set -e

case "${1:-remove}" in
  upgrade|deconfigure|failed-upgrade|1)
    exit 0
    ;;
esac

# Disable the first-boot oneshot (packaging glue we enabled in postinstall).
if command -v systemctl >/dev/null 2>&1; then
  systemctl disable --now polyptych-agent-firstboot.service 2>/dev/null || true
fi

# Reverse what `setup` wired: stop the agent, disable greetd (restoring any prior display manager
# setup recorded), remove generated greetd/sway/agent configs. Policy lives in the binary; `--no-pkg`
# keeps teardown off the package manager (its lock is held during this transaction). Best-effort so
# removal never blocks.
if command -v polyptych-agent >/dev/null 2>&1; then
  polyptych-agent teardown --no-pkg 2>/dev/null || true
fi

if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload 2>/dev/null || true
fi
exit 0
