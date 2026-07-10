#!/bin/bash
# Polyptic's Wi-Fi dracut module (POL-63). Pulled in by `dracut --add polyptic-wifi` when
# deploy/build-live-image.sh builds the initramfs inside the image chroot, beside polyptic-live.
#
# Why the INITRD needs a supplicant at all: on a Wi-Fi-only box the local boot stage (universal USB
# medium or offloaded ESP) carries kernel+initrd, but the ROOT IMAGE still streams from the control
# plane — and livenet cannot curl anything until the radio has associated. So this module ships the
# whole association stack pre-root: wpa_supplicant, every major vendor's wlan driver (dracut pulls
# each module's firmware alongside), the regulatory db, and a settled-hook that reads the medium's
# polyptic/wifi.conf, associates, and stages the credentials in /run/polyptic — where the rootfs's
# polyptic-wifi.service finds them after switch-root and takes over with its own supplicant (the
# Linux-world handoff; an initrd association dies with its supplicant at the next WPA rekey).
#
# The networkd side needs nothing new: the initrd's systemd-networkd DHCPs the wlan interface via
# the same 80-polyptic-wlan.network the rootfs uses, and the polyptic-live wait-online drop-in
# (--any, bounded) already counts an associated wlan as "online". A wired link still wins when
# present — the hook is opportunistic and never blocks the initqueue.
#
# `check()` returns 0 unconditionally: the module is never auto-detected, only `--add`ed.

check() {
    return 0
}

depends() {
    return 0
}

installkernel() {
    # cfg80211/mac80211 + the ENTIRE wireless driver tree: the fleet's chipsets are not known at
    # build time, and a netbooted box cannot load a module later — its /lib/modules lives in the
    # root image it has not fetched yet. dracut installs each module's `modinfo firmware:` blobs
    # automatically, which is what actually wakes the radios (and most of this module's size).
    instmods cfg80211 mac80211
    instmods '=drivers/net/wireless'
}

install() {
    inst_multiple wpa_supplicant od sed grep tr wc mkdir cp chmod basename readlink mount umount blkid
    # The shared credential helpers, at their canonical path — the hook, the rootfs service and the
    # tests all speak the same files (deploy/live/usr/local/lib/polyptic/).
    inst_simple /usr/local/lib/polyptic/wifi-conf.sh
    inst_simple /usr/local/lib/polyptic/wifi-supplicant-conf.sh
    inst_simple /usr/local/lib/polyptic/find-boot-medium.sh
    # DHCP for wl* — the exact file the rootfs uses; the initrd's networkd reads /etc too.
    inst_simple /etc/systemd/network/80-polyptic-wlan.network
    # The regulatory database (wireless-regdb). Optional: without it drivers sit on the conservative
    # world domain, which associates fine but may skip local-only channels.
    [ -f /lib/firmware/regulatory.db ]     && inst_simple /lib/firmware/regulatory.db
    [ -f /lib/firmware/regulatory.db.p7s ] && inst_simple /lib/firmware/regulatory.db.p7s
    # After progress-wait (05) so "Waiting for the network" paints first; well before livenet's
    # online hook (95), which only fires once something — wired or this — is online.
    inst_hook initqueue/settled 07 "$moddir/polyptic-wifi-up.sh"
}
