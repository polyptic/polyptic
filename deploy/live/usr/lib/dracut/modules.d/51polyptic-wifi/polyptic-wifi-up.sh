#!/bin/sh
# Polyptic (POL-63): associate to Wi-Fi from the boot medium's polyptic/wifi.conf, pre-root, so
# livenet can stream the OS image over the radio. Runs at initqueue/settled 07, opportunistically:
# it retries each settle pass until the medium's device node exists, marks itself done exactly once,
# and NEVER blocks the queue — a wired box sails past it, and a Wi-Fi box that can't associate ends
# at the existing timeout narration, not a hang of ours.
#
# It also STAGES the credentials in /run/polyptic (which survives switch-root), so the rootfs's
# polyptic-wifi.service can run its own supplicant without re-finding the medium — the handoff that
# keeps the connection alive past the first WPA rekey.
#
# SOURCED by dracut's initqueue (see polyptic-ram.sh for the sourcing rules: no set -e/-u, no exit,
# prefix every variable).

if [ ! -e /tmp/polyptic-wifi-done ]; then
    polyptic_wlans=""
    for polyptic_p in /sys/class/net/*/wireless; do
        [ -d "$polyptic_p" ] && polyptic_wlans="$polyptic_wlans ${polyptic_p%/wireless}"
    done

    # No radio (yet): keep checking — a driver can finish probing a pass or two after its firmware
    # loads. The glob above is the whole cost, so retrying is free; a wired box just never matches.
    if [ -n "$polyptic_wlans" ]; then
        mkdir -p /tmp/polyptic-medium 2>/dev/null || :
        polyptic_dev="$(sh /usr/local/lib/polyptic/find-boot-medium.sh /tmp/polyptic-medium ro 2>/dev/null)" || :
        if [ -n "$polyptic_dev" ]; then
            if [ -f /tmp/polyptic-medium/polyptic/wifi.conf ]; then
                mkdir -p /run/polyptic 2>/dev/null || :
                cp /tmp/polyptic-medium/polyptic/wifi.conf /run/polyptic/wifi.conf 2>/dev/null || :
                chmod 0600 /run/polyptic/wifi.conf 2>/dev/null || :
                if [ -d /tmp/polyptic-medium/polyptic/certs ]; then
                    rm -rf /run/polyptic/certs 2>/dev/null || :
                    cp -R /tmp/polyptic-medium/polyptic/certs /run/polyptic/certs 2>/dev/null || :
                    chmod -R go-rwx /run/polyptic/certs 2>/dev/null || :
                fi
                umount /tmp/polyptic-medium 2>/dev/null || :

                if POLYPTIC_WIFI_CERT_DIR=/run/polyptic \
                     sh /usr/local/lib/polyptic/wifi-supplicant-conf.sh /run/polyptic/wifi.conf \
                     > /run/polyptic/wpa_supplicant.conf 2> /run/polyptic/wifi.err \
                   && [ -s /run/polyptic/wpa_supplicant.conf ]; then
                    for polyptic_if in $polyptic_wlans; do
                        polyptic_if="${polyptic_if##*/}"
                        wpa_supplicant -B -i "$polyptic_if" -c /run/polyptic/wpa_supplicant.conf > /dev/null 2>&1 || :
                    done
                    # The splash stays generic (wall screens are public signage); the SSID detail
                    # goes to the console behind alt-tab, where every netboot diagnosis starts.
                    if type plymouth > /dev/null 2>&1 && plymouth --ping 2> /dev/null; then
                        plymouth display-message --text="Joining Wi-Fi ..." 2> /dev/null || :
                    fi
                    echo "polyptic: joining Wi-Fi '$(sed -n 's/^WIFI_SSID=//p' /run/polyptic/wifi.conf | head -n1)'" > /dev/console 2> /dev/null || :
                else
                    # A present-but-invalid config: say WHY on the screen the operator is facing.
                    # Not fatal here — a wired link (if any) still boots the box.
                    if type plymouth > /dev/null 2>&1 && plymouth --ping 2> /dev/null; then
                        plymouth display-message --text="Wi-Fi config rejected. See polyptic/wifi-debug.txt on the boot medium" 2> /dev/null || :
                    fi
                    echo "polyptic: wifi.conf rejected: $(cat /run/polyptic/wifi.err 2>/dev/null)" > /dev/console 2> /dev/null || :
                    # A keyboard-less display node can't read that console line, so persist the full
                    # story to the medium: remount it read-write and drop polyptic/wifi-debug.txt with
                    # the reject reason, the sh -x validation trace, and the whole net/interface state
                    # (POL-77). Best-effort — every step is guarded so a read-only or vanished medium
                    # never turns a Wi-Fi hiccup into a boot failure.
                    if [ -n "$polyptic_dev" ]; then
                        mkdir -p /tmp/polyptic-medium-rw 2>/dev/null || :
                        if mount -o rw "$polyptic_dev" /tmp/polyptic-medium-rw 2>/dev/null; then
                            mkdir -p /tmp/polyptic-medium-rw/polyptic 2>/dev/null || :
                            sh /usr/local/lib/polyptic/wifi-diagnostics.sh /run/polyptic/wifi.conf \
                                > /tmp/polyptic-medium-rw/polyptic/wifi-debug.txt 2>&1 || :
                            sync 2>/dev/null || :
                            umount /tmp/polyptic-medium-rw 2>/dev/null || :
                        fi
                    fi
                fi
                : > /tmp/polyptic-wifi-done
            else
                # A medium with no wifi.conf is every wired box's stick: done, quietly.
                umount /tmp/polyptic-medium 2>/dev/null || :
                : > /tmp/polyptic-wifi-done
            fi
        fi
        # $polyptic_dev empty → the stick's device node has not settled yet: retry next pass.
        unset polyptic_dev polyptic_if
    fi
    unset polyptic_wlans polyptic_p
fi
