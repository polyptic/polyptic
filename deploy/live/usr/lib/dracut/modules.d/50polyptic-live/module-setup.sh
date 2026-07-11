#!/bin/bash
# Polyptic's dracut module (POL-35). Pulled in by `dracut --add polyptic-live` when
# deploy/build-live-image.sh builds the initramfs inside the image chroot.
#
# Three jobs, each earned by a real boot failure:
#
#   1. polyptic-ram.sh — livenet downloads the WHOLE rootfs.squashfs into the initramfs root, a
#      tmpfs the kernel caps at 50% of RAM. Raise the cap, and speak English on a box that truly
#      cannot hold the image (POL-46's casper fix, carried over).
#   2. polyptic-netboot.network + polyptic-wait-online.conf — a kiosk with a second, UNPLUGGED NIC
#      sat on a silent "Starting Polyptic ..." splash for ~3 minutes before the download began
#      (real hardware, 2026-07-11, POL-76). dracut marks EVERY physical NIC RequiredForOnline
#      (routable), and `wait-online --any` STILL blocks on a required link stuck below carrier
#      (systemd#5154). The fix is the per-link policy, not just the wait: polyptic-netboot.network
#      sets RequiredForOnline=no on the wired links (the initramfs twin of the rootfs's netplan
#      `optional: true`), so an unplugged NIC never blocks and the first carrier-up NIC drives
#      livenet's own `online` hook in seconds. polyptic-wait-online.conf keeps --any + a bounded
#      timeout as the backstop for a link that IS required (Wi-Fi association).
#   3. polyptic-progress-*.sh — narrate the initramfs on the splash (waiting for DHCP / downloading
#      from which host / what is failing), so a stuck boot says WHY without alt-tab console
#      archaeology. plymouth's display-message feeds the theme's live status line (D45), which our
#      narration owns while it is up; `-done` hands it back to systemd before switch-root (POL-53).
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
    # `pre-pivot` is the last hook that runs with plymouthd still owning the initramfs' screen.
    inst_hook pre-pivot 50 "$moddir/polyptic-progress-done.sh"
    # Sorts AFTER dracut's own 99-dracut.conf (d < p), so these settings win.
    inst_simple "$moddir/polyptic-wait-online.conf" \
        "$systemdsystemunitdir/systemd-networkd-wait-online.service.d/99-polyptic.conf"
    # RequiredForOnline=no on the WIRED links (POL-76): the actual fix for the multi-NIC stall — an
    # unplugged NIC must not hold up network-online.target, the initramfs counterpart of the rootfs's
    # netplan `optional: true`. Sorts before dracut's generated 70-*/zzzz-*.network, so it wins.
    inst_simple "$moddir/polyptic-netboot.network" \
        "/etc/systemd/network/10-polyptic-netboot.network"
    inst_multiple awk mount sleep sed
}
