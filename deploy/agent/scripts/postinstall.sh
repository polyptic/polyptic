#!/bin/sh
# polyptych-agent — post-install hook (deb postinst / rpm post; one script for both).
#
# Generic across apt/dnf (D26): all real provisioning lives in the binary's `setup`, so this script
# is thin glue. It (1) registers the shipped systemd units, (2) enables the first-boot oneshot that
# does the package-manager half of setup once the install lock is released, and (3) best-effort runs
# the NON-package-manager half of setup now so a plain reboot is all that's left.
#
# It must never abort the package transaction: every step is non-fatal.
set -e

# 1. Register the shipped (system) units with systemd.
if command -v systemctl >/dev/null 2>&1; then
  systemctl daemon-reload || true

  # The first-boot oneshot completes the package-manager half of `setup` (deps incl. the real
  # Chromium) on next boot, when the dpkg/rpm lock is free. Enabled now, runs on reboot.
  systemctl enable polyptych-agent-firstboot.service || true
fi

# 2. Best-effort: do the NON-package-manager half of setup now (create the kiosk user, write
#    greetd/sway/systemd/agent.toml, enable greetd). `--no-pkg` keeps us off the package manager
#    while THIS transaction holds its lock. Non-fatal: the first-boot oneshot (which runs the plain,
#    guaranteed `polyptych-agent setup`) is the completion path, and `sudo polyptych-agent setup`
#    always finishes it by hand.
if command -v polyptych-agent >/dev/null 2>&1; then
  if ! POLYPTYCH_NONINTERACTIVE=1 polyptych-agent setup --no-pkg; then
    echo "polyptych-agent: deferred full provisioning to first boot (or run 'sudo polyptych-agent setup')." >&2
  fi
fi

echo "polyptych-agent installed."
echo "  1. Edit /etc/polyptych/agent.toml  (control-plane URL + bootstrap token)."
echo "  2. Reboot — the box autologins into sway and the agent drives the wall."
exit 0
