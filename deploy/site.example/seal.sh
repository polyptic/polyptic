#!/bin/sh
# The site layer's LAST word before the image is sealed. Runs on the BUILD HOST (not in a chroot) with
# the rootfs path as $1, immediately before mksquashfs.
#
# WHY THIS EXISTS. An endpoint agent mints its host identity the first time it registers, and then
# refuses to re-register because it believes it already has one. Bake an image containing an
# already-registered agent and every box in the fleet claims to be the same host: one entry in your
# console where there should be forty, detections attributed to the wrong machine, and a licence count
# that makes no sense. Vendors publish a "golden image" or "master image" procedure for exactly this
# moment, and it almost always amounts to deleting an identity file or calling a reset subcommand.
#
# Every Polyptic boot is a golden-image first boot, because the writable layer is discarded at
# power-off. So this hook is not an optimisation, it is the mechanism that makes a shared image legal.
#
# Non-zero exit FAILS THE BUILD. That is deliberate: shipping an image that carries one box's identity
# to the whole fleet is a worse outcome than not shipping.
#
# Delete this file if nothing you install registers itself.
set -eu

ROOTFS="${1:?usage: seal.sh <rootfs>}"

# Example: remove an agent's identity file so each box mints its own on first start.
#
#   rm -f "$ROOTFS/opt/vendor/etc/agent-id"
#
# Example: some agents ship a reset that must run against the installed tree rather than a live host.
#
#   chroot "$ROOTFS" /opt/vendor/bin/vendorctl reset --identity
#
# Also worth clearing here: anything host-shaped that a package's postinst wrote during the build, such
# as a cached hostname, a machine-specific config file or a queued telemetry spool.

echo "site seal.sh: nothing to strip (edit me, or delete me)"
