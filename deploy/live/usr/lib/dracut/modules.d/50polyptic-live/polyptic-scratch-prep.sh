#!/bin/sh
# Polyptic scratch-overlay prep (POL-179). Disk boots only (`polyptic.bootpath=disk`).
#
# The installed-boot cmdline points dmsquash-live at the scratch partition with
# `rd.live.overlay=LABEL=POLYPTIC-SCRATCH:/overlayfs` — and dmsquash-live (dracut-ng 110,
# do_live_overlay) only treats that device as a persistent overlay when BOTH `overlayfs/` (the
# pathspec) and `ovlwork/` exist on it. A scratch fs missing the pair — a box installed before
# POL-179 seeded them, or an fs corrupted by a power cut — reads as "no overlay": dracut falls back
# to a RAM overlay and paints "Unable to find a persistent overlay; using a temporary one." across a
# public wall (the first real installed boot, 2026-07-23; a D65 violation on top of the RAM churn).
# This hook makes the pair exist BEFORE dmsquash-live looks: wait for the scratch device, mount it,
# create the dirs — and if it will not mount at all, mkfs it back to life (scratch is ephemeral by
# design; there is nothing on it worth keeping).
#
# The per-boot wipe stays dracut's own `rd.live.overlay.reset=1`: VERIFIED against dracut-ng 110
# (Ubuntu 26.04's dracut-core 110-11) — 70overlayfs/prepare-overlayfs.sh resets with
# `rm -r -- "$dir"/* "$dir"/.*`, i.e. it removes the overlay dir's CONTENTS, never the dir itself,
# so reset can never regress the next boot to tmpfs. No wipe needed here.
#
# THIS FILE IS *SOURCED*, NOT EXECUTED (same contract as polyptic-ram.sh, learned in POL-35): it is
# an initqueue/settled hook, sourced by dracut-initqueue's main loop — never `exit`, never touch
# shell options, everything guarded. Ordering is by filename within the settled dir: this installs
# as `04polyptic-scratch-prep.sh`, and dmsquash-live's own job arrives at runtime as
# `dmsquash-live-root.sh` (udev RUN → `initqueue --settled --onetime --unique`) — digits sort before
# letters, so in the settle pass where the root device (same disk!) appears, this runs first.
# Settled hooks re-run every pass, hence the one-shot marker; before the scratch device exists the
# hook just returns and tries again next pass.
#
# The device is found by GPT PARTLABEL, not fs LABEL, deliberately: a corrupted fs has no label for
# udev to publish, but the partition table survives — by-partlabel is the one name that exists
# exactly when there is something to heal. Every external this shells out to is named in
# module-setup.sh's inst_multiple (the POL-78 no-missing-binaries law).
#
# LEGACY CMDLINE (a box installed before POL-179, until its ESP config is re-rendered): update-poll
# re-renders grub.cfg with the renderer of the image it is RUNNING, so the `:/overlayfs` pathspec
# arrives one update LATE — the first post-fix boot still carries the bare
# `rd.live.overlay=LABEL=POLYPTIC-SCRATCH`, under which dmsquash-live defaults the pathspec to
# `/LiveOS/overlay-<live-label>-<live-uuid>` (+ `/LiveOS/ovlwork`). When the cmdline has no pathspec,
# this hook seeds THAT layout too — computed from the booted slot exactly as dmsquash-live computes
# it (blkid LABEL/UUID of the live device) — so the warning dies on the FIRST update, not the second.
#
# Test overrides (deploy/live/test/scratch-prep.test.sh): POLYPTIC_CMDLINE_FILE,
# POLYPTIC_SCRATCH_DEV, POLYPTIC_SCRATCH_MNT, POLYPTIC_SCRATCH_DONE, POLYPTIC_BYLABEL_DIR.

case " $(cat "${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}" 2>/dev/null) " in
    *" polyptic.bootpath=disk "*)
        polyptic_sp_done="${POLYPTIC_SCRATCH_DONE:-/run/polyptic-scratch-prep.done}"
        polyptic_sp_dev="${POLYPTIC_SCRATCH_DEV:-/dev/disk/by-partlabel/POLYPTIC-SCRATCH}"
        if [ ! -e "$polyptic_sp_done" ] && [ -e "$polyptic_sp_dev" ]; then
            polyptic_sp_mnt="${POLYPTIC_SCRATCH_MNT:-/run/polyptic-scratch-prep}"
            mkdir -p "$polyptic_sp_mnt" 2>/dev/null || :
            polyptic_sp_up=""
            if mount -t ext4 "$polyptic_sp_dev" "$polyptic_sp_mnt" 2>/dev/null; then
                polyptic_sp_up=1
            else
                # Self-healing: an unmountable scratch is corruption, and scratch holds nothing
                # worth keeping — re-mkfs (restoring the POLYPTIC-SCRATCH fs label the cmdline's
                # LABEL= devspec resolves by) and settle so udev republishes it before dmsquash
                # looks it up.
                if [ -w /dev/kmsg ]; then echo "polyptic: the scratch overlay partition would not mount - reformatting it" > /dev/kmsg; fi
                if mkfs.ext4 -q -F -L POLYPTIC-SCRATCH "$polyptic_sp_dev" 2>/dev/null; then
                    udevadm settle 2>/dev/null || :
                    mount -t ext4 "$polyptic_sp_dev" "$polyptic_sp_mnt" 2>/dev/null && polyptic_sp_up=1
                fi
            fi
            if [ -n "$polyptic_sp_up" ]; then
                mkdir -p "$polyptic_sp_mnt/overlayfs" "$polyptic_sp_mnt/ovlwork" 2>/dev/null || :
                # Legacy cmdline (no `:` pathspec on rd.live.overlay): also seed dmsquash-live's
                # DEFAULT pathspec for the booted slot, or a pre-POL-179 ESP config keeps warning
                # until its SECOND update (see the header).
                polyptic_sp_ov=""; polyptic_sp_lab=""
                for polyptic_sp_tok in $(cat "${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}" 2>/dev/null); do
                    case "$polyptic_sp_tok" in
                        rd.live.overlay=*) polyptic_sp_ov="${polyptic_sp_tok#rd.live.overlay=}" ;;
                        root=live:LABEL=*) polyptic_sp_lab="${polyptic_sp_tok#root=live:LABEL=}" ;;
                    esac
                done
                case "$polyptic_sp_ov" in
                    *:*) : ;;   # pathspec pinned — /overlayfs above is the layout
                    *)
                        if [ -n "$polyptic_sp_lab" ]; then
                            polyptic_sp_uuid="$(blkid -s UUID -o value "${POLYPTIC_BYLABEL_DIR:-/dev/disk/by-label}/$polyptic_sp_lab" 2>/dev/null)" || polyptic_sp_uuid=""
                            if [ -n "$polyptic_sp_uuid" ]; then
                                mkdir -p "$polyptic_sp_mnt/LiveOS/overlay-$polyptic_sp_lab-$polyptic_sp_uuid" \
                                         "$polyptic_sp_mnt/LiveOS/ovlwork" 2>/dev/null || :
                            fi
                            unset polyptic_sp_uuid
                        fi
                        ;;
                esac
                unset polyptic_sp_ov polyptic_sp_lab polyptic_sp_tok
                umount "$polyptic_sp_mnt" 2>/dev/null || :
            else
                # Device present but beyond both mount and mkfs: dracut will fall back to a RAM
                # overlay (the box still boots). Say so in the journal, not on the glass.
                if [ -w /dev/kmsg ]; then echo "polyptic: could not prepare the scratch overlay partition - this boot uses a RAM overlay" > /dev/kmsg; fi
            fi
            # One attempt per boot, success or not: with the device present, retrying every settle
            # pass would just re-run mkfs against the same brokenness.
            : > "$polyptic_sp_done" 2>/dev/null || :
            unset polyptic_sp_mnt polyptic_sp_up
        fi
        unset polyptic_sp_done polyptic_sp_dev
        ;;
esac
