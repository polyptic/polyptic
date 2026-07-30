#!/bin/sh
# A site BOOT hook. Runs on the box, as root, at every boot, in filename order, with the network up and
# this box's site secrets already in hand. This is where registration goes.
#
# WHY HERE AND NOT AT BUILD TIME. Registration writes a bearer credential to disk. The image is served
# without authentication (a box cannot present a session before it has booted), so a credential written
# during the build is downloadable by anyone who can reach the control plane. Written here, it lives in
# a tmpfs and dies with the boot.
#
# "EVERY BOOT" IS NOT A MISTAKE. Nothing this script does survives a power cycle, so there is no
# first-run state to remember and no point guarding against a second run. Write it to be safely
# repeatable, and expect your console to see a fresh registration per boot unless your tooling
# deduplicates on something stable. Polyptic sets a stable per-box identity you can use for that:
# $POLYPTIC_MACHINE_ID, derived from the motherboard UUID (falling back to a hashed NIC MAC).
#
# SECRETS reach you two ways, both in RAM:
#   $SITE_<NAME>                          environment, named exactly as in the medium's site.conf
#   $POLYPTIC_SITE_SECRETS_DIR/SITE_<NAME>  a 0600 file with the raw value and no trailing newline
# Prefer the file where the tool accepts one. A value on a command line is visible in `ps` to anything
# else on the box.
#
# FAILURE IS CHEAP AND MUST STAY CHEAP. Exit non-zero and you get a journal line an operator can read in
# Console ▸ Logs. You will not black the wall, and you will not delay it: this runs alongside the
# session, not before it, and it is killed after a timeout (POLYPTIC_SITE_HOOK_TIMEOUT, default 120s).
# Do not add a retry loop that outlives that budget; the next boot is your retry.
set -eu

log() { printf 'site/10-register-example: %s\n' "$1"; }

# Nothing configured, nothing to do. Keep this shape: a hook that is loud when it has no work teaches
# operators to ignore its output.
if [ -z "${SITE_EXAMPLE_ENROL_TOKEN:-}" ]; then
  log "no SITE_EXAMPLE_ENROL_TOKEN on the boot medium, skipping"
  exit 0
fi

# Example: register with a customer/tenant identifier and a linking key, reading the secret from its
# file rather than passing it on the command line.
#
#   /opt/vendor/bin/vendorctl register \
#     --tenant "${SITE_EXAMPLE_TENANT:-}" \
#     --token-file "$POLYPTIC_SITE_SECRETS_DIR/SITE_EXAMPLE_ENROL_TOKEN" \
#     --hostname "${POLYPTIC_MACHINE_ID:-$(hostname)}"
#
# Then start it. Do NOT `systemctl enable` here (the image is read-only and the unit was enabled at
# build time); just make sure it is running this boot.
#
#   systemctl start vendor-agent.service

log "example hook ran (edit me, or delete me)"
