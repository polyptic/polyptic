#!/bin/bash
# Polyptic's dracut module (POL-35). Pulled in by `dracut --add polyptic-live` when
# deploy/build-live-image.sh builds the initramfs inside the image chroot.
#
# Three jobs, each earned by a real boot failure:
#
#   1. polyptic-ram.sh — livenet downloads the WHOLE rootfs.squashfs into the initramfs root, a
#      tmpfs the kernel caps at 50% of RAM. Raise the cap, and speak English on a box that truly
#      cannot hold the image (POL-46's casper fix, carried over).
#   2. polyptic-wait-online.conf — dracut's own wait-online drop-in keeps the stock semantics (wait
#      for EVERY managed link) with TimeoutStartSec=120, so a kiosk with a second unplugged NIC sat
#      on a silent "Starting up" splash for two full minutes before the download even began (seen
#      on the first real-hardware boot). One online link is all netboot needs: --any, bounded.
#   3. polyptic-progress-*.sh — narrate the initramfs on the splash (waiting for DHCP / downloading
#      from which host / what is failing), so a stuck boot says WHY without alt-tab console
#      archaeology. plymouth's display-message feeds the theme's live status line (D45).
#
# `check()` returns 0 unconditionally: the module is never auto-detected, only `--add`ed.

check() {
    return 0
}

depends() {
    echo "dmsquash-live livenet"
    return 0
}

install() {
    # `cmdline` is the earliest hook that runs with a writable / and a parsed cmdline, well before
    # the initqueue where livenet's download happens.
    inst_hook cmdline 00 "$moddir/polyptic-ram.sh"
    # Progress narration: `settled` fires while udev/DHCP are still converging (say "waiting for
    # network"), `online` fires when an interface is up (say "downloading"), `timeout` only fires
    # when the boot has genuinely stalled (say what to check).
    inst_hook initqueue/settled 05 "$moddir/polyptic-progress-wait.sh"
    inst_hook initqueue/online 94 "$moddir/polyptic-progress-online.sh"
    inst_hook initqueue/timeout 10 "$moddir/polyptic-progress-timeout.sh"
    # Sorts AFTER dracut's own 99-dracut.conf (d < p), so these settings win.
    inst_simple "$moddir/polyptic-wait-online.conf" \
        "$systemdsystemunitdir/systemd-networkd-wait-online.service.d/99-polyptic.conf"
    inst_multiple awk mount sleep sed
}
