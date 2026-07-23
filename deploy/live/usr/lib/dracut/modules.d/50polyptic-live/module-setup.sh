#!/bin/bash
# Polyptic's dracut module (POL-35). Pulled in by `dracut --add polyptic-live` when
# deploy/build-live-image.sh builds the initramfs inside the image chroot.
#
# Five jobs, each earned by a real boot failure:
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
#   4. polyptic-pinned-fallback.sh — the offline/Wi-Fi menu PINS `builds/<imageId>/rootfs.squashfs`
#      (D67), and retention (D54) prunes that build once the box has been off across three rebuilds:
#      a 404 the box could never boot past, because the refresh that re-pins the medium only happens
#      after a successful boot (real hardware, 2026-07-14, POL-116). The netroot hook probes the pin
#      and, when the depot no longer has it, re-points livenet at the ACTIVE build (or the unpinned
#      arch root) — loudly. It is a `netroot` hook because that is the one place dracut sources our
#      code into the shell that owns $netroot, right before it hands that URL to livenetroot.
#   5. polyptic-scratch-prep.sh — disk boots only (POL-176/POL-179): dmsquash-live treats the
#      scratch partition as a persistent overlay only when `overlayfs/` + `ovlwork/` exist on it;
#      a box installed before the installer seeded them (the first real installed boot, 2026-07-23)
#      or a corrupted scratch fs falls back to a RAM overlay WITH a technical warning across the
#      wall. The hook creates the pair (mkfs-ing the partition back to life if it won't mount)
#      before dmsquash-live looks.
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
    # Scratch-overlay prep MUST sort before dmsquash-live's own settled job (POL-179): dmsquash's
    # udev rule queues `dmsquash-live-root.sh` into the SAME settled dir at runtime, and settled
    # hooks run in filename order — `04…` beats `dmsquash…` (digits before letters), so in the very
    # settle pass where the disk's partitions appear, the overlay dirs exist before dmsquash looks.
    inst_hook initqueue/settled 04 "$moddir/polyptic-scratch-prep.sh"
    # Progress narration: `settled` fires while udev/DHCP are still converging (say "waiting for
    # network"), `online` fires when an interface is up (say "downloading"), `timeout` only fires
    # when the boot has genuinely stalled (say what to check).
    inst_hook initqueue/settled 05 "$moddir/polyptic-progress-wait.sh"
    inst_hook initqueue/online 94 "$moddir/polyptic-progress-online.sh"
    inst_hook initqueue/timeout 10 "$moddir/polyptic-progress-timeout.sh"
    # `netroot` hooks are SOURCED by /sbin/netroot (45net-lib) in the shell that holds $netroot, and
    # immediately before it runs `livenetroot "$netif" "$netroot"` — the only place a hook can change
    # WHICH image livenet fetches without patching livenet itself (POL-116).
    inst_hook netroot 50 "$moddir/polyptic-pinned-fallback.sh"
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
    # Everything polyptic-pinned-fallback.sh shells out to must be HERE: an initramfs missing one
    # external is how POL-78 spent a week rejecting every Wi-Fi config (no `dirname` in the initrd).
    # curl comes in with url-lib and sed/awk/sleep with the hooks above; naming them is the contract.
    # `tr` is the only soft one — the script guards it with `command -v` and just reports no machine
    # id without it. mkdir/umount/mkfs.ext4/udevadm/blkid are polyptic-scratch-prep.sh's (POL-179):
    # mkfs.ext4 is the self-heal, and it is NOT otherwise in a dracut initramfs.
    inst_multiple awk mount sleep sed curl tr mkdir umount mkfs.ext4 udevadm blkid
}
