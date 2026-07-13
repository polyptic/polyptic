#!/bin/sh
# Polyptic netboot RAM pre-flight (POL-35, carried over from POL-46's casper equivalent).
#
# dracut's livenet curls rootfs.squashfs into the initramfs root — a tmpfs the kernel caps at 50% of
# RAM — and dmsquash-live loop-mounts it there for the whole session. So the download alone needs the
# image to fit under half of RAM unless we say otherwise. Two things happen here, both before livenet
# runs:
#
#   1. raise the cap to 90%, which is what makes a small box boot at all;
#   2. below the floor, print a plain-English message naming the live ISO, rather than letting curl
#      fail minutes later with a bare ENOSPC.
#
# Netboot only. A live-ISO boot (`root=live:CDLABEL=…`) mounts the squashfs straight off the medium
# and needs no headroom at all.
#
# THIS FILE IS *SOURCED*, NOT EXECUTED. dracut runs `cmdline` hooks with `source_hook`, i.e. `. file`,
# in the same shell that later sources livenet's parser. Two rules follow, both learned by breaking a
# boot (POL-35): never `exit` (it would kill dracut-cmdline outright), and never change shell options
# — an earlier `set -u` here made dracut-ng's own `url-lib.sh` die on `url_handler_map: unbound
# variable`, so livenet never registered its netroot handler, the image was never fetched, and the
# box dropped into the emergency shell with a misleading `overlayfs: failed to resolve
# '/run/rootfsbase'`. Hence: no `set -e`, no `set -u`, no `exit`, everything inside one `if`.

case " $(cat /proc/cmdline 2>/dev/null) " in
    *" root=live:http"*)
        # Give the download room: the image lives in this tmpfs for the whole session, so 50% is
        # never enough.
        mount -o remount,size=90% / 2>/dev/null || :

        polyptic_mem_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo 2>/dev/null || echo 0)
        # 3 GiB (3145728 KiB). The floor tracks the image, and the image has grown twice:
        #   POL-63 added every major vendor's Wi-Fi firmware  (squashfs → ~700 MiB)
        #   POL-67 added Chrome, ~300-400 MB                  (squashfs → ~1.0-1.1 GiB)
        # 90% of RAM has to hold the squashfs for the WHOLE session (it is loop-mounted out of this
        # tmpfs, not freed after boot), plus the overlay's writes, plus a running sway + Chrome —
        # and Chrome is multi-process, so it is hungrier than the surf it replaced. On a 2 GB box
        # that is now hopeless: 90% ≈ 1.8 GB, and the image alone eats ~1.05 GB of it.
        #
        # THESE ARE ESTIMATES, not measurements: the first post-Chrome build is what calibrates them.
        # When it lands, re-check the real `rootfs.squashfs` size and correct BOTH numbers here and
        # the copy below (docs/NETBOOT.md "RAM" section quotes the same figures).
        if [ "${polyptic_mem_kb:-0}" -gt 0 ] && [ "$polyptic_mem_kb" -lt 3145728 ]; then
            polyptic_mem_gb=$((polyptic_mem_kb / 1048576))
            {
                echo ""
                echo "  ##############################################################"
                echo "  ## Polyptic: this machine has ~${polyptic_mem_gb} GB RAM."
                echo "  ## Netbooting streams the whole OS image into RAM and needs ~3.5 GB."
                echo "  ##"
                echo "  ## Use the LIVE ISO instead (Console > Settings > Onboard Screens):"
                echo "  ## it runs the OS straight off the USB stick and needs ~1 GB."
                echo "  ##############################################################"
                echo ""
            } > /dev/console 2>/dev/null || :
            sleep 10
        fi
        unset polyptic_mem_kb polyptic_mem_gb
        ;;
esac
