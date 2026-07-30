#!/bin/sh
# The site layer's BUILD-TIME hook. Runs inside the image's chroot, as root, once per build, after your
# packages and your rootfs/ overlay are in place and before the initramfs is generated.
#
# TWO HARD RULES.
#
# 1. NON-INTERACTIVE. There is nobody to answer a prompt. A `read`, an apt question or a vendor
#    installer that waits for confirmation hangs the build until it is killed. DEBIAN_FRONTEND is
#    already noninteractive; pass whatever unattended flag your tooling has.
#
# 2. DO NOT REGISTER ANYTHING HERE. Registration writes a bearer credential to disk, and this
#    filesystem is about to be sealed into an image that is served without authentication. Anything a
#    registration writes becomes downloadable by anyone who can reach the control plane. Registration
#    belongs in firstboot.d/, where the credential lives in RAM and dies with the boot.
#
# Non-zero exit FAILS THE BUILD, on purpose. A half-configured image that boots and quietly is not
# compliant is worse than no new image.
#
# Delete this file if you have nothing imperative to do. Files belong in rootfs/, packages in
# packages.list, and both are easier to review than a script.
set -eu

# Example: point a log forwarder at your collector. The config itself would normally just be a file in
# rootfs/, which is preferable — this is only worth doing when something has to be computed.
#
#   printf 'target=%s\n' "logs.internal.example" > /etc/example-forwarder.conf

# Example: put an agent into a mode that suits an immutable, diskless host, where that is a config
# switch rather than a registration.
#
#   /opt/vendor/bin/vendorctl set --mode=ebpf --no-auto-update

echo "site configure.sh: nothing to do (edit me, or delete me)"
