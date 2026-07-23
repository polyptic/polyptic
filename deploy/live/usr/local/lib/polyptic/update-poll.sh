#!/bin/sh
# Update poll (POL-41; self-updating boot media POL-63): every 5 minutes (polyptic-update-poll.timer)
# compare the image id this box BOOTED (/etc/polyptic/image-id, baked at build/refresh time) against
# the id the control plane is SERVING (/dist/image/<arch>/manifest.json). A mismatch means a newer
# image exists; a reboot IS the re-pull, the OS streams from the server at every boot. Policy:
#
#   urgent (admin switch in Console ▸ Settings ▸ Image updates) → reboot NOW, with a 0-4 min
#       per-box splay so a wall doesn't hammer the depot in unison;
#   not urgent → reboot only inside the nightly window (03:00–04:59 local), also splayed. A 01:00
#       scheduled refresh therefore rolls across the fleet the same night, invisibly.
#
# The manifest is fetched PER MACHINE (POL-105: `?machineId=<this box>`), so `imageId` and `urgent`
# are this box's answer, not the fleet's: a box the operator tagged `canary` is told to boot the
# canary build (and may be told to do it urgently while the rest of the fleet waits for the night).
# Everything below is unchanged by that — the box still just compares two ids and reboots.
#
# NETBOOT OR INSTALLED BOXES ONLY: a box booted from the live ISO re-boots the SAME stale medium,
# so rebooting it is at best pointless and at worst a loop. `root=live:http…` is exactly and only
# what a netboot cmdline carries (dracut streams the squashfs from that URL); an ISO boot carries
# `root=live:CDLABEL=…`, so matching on the scheme is the guard. `polyptic.bootpath=disk` (POL-176)
# is an INSTALLED box: it boots from its own disk, so a reboot is NOT a re-pull — the new build is
# staged onto the disk's inactive slot first, and only then is a reboot worth anything.
#
# INSTALLED BOXES (POL-176) stage onto their own DISK: kernel + LEAN initrd into the ESP's inactive
# slot dir, the squashfs into the inactive slot PARTITION, cfg rewrite last (the commit point) —
# the medium pattern below, at disk scale. The reboot policy is OPERATOR-FIRST: urgent → now
# (splayed); the nightly window is only the backstop so a fleet never drifts; otherwise the box
# waits for the console's "reboot to apply". Every poll writes /run/polyptic/update-state
# (`running=<id>` + `staged=<id>`) so the console can show both truthfully.
#
# BOXES WITH A LOCAL BOOT MEDIUM (POL-63) — the universal USB stick or an offloaded ESP — stage the
# new build onto that medium ON EVERY POLL the moment a newer image is served (POL-172), regardless
# of the reboot policy: the new build's vmlinuz + initrd-wifi are fetched into the medium's INACTIVE
# slot, verified against the depot's SHA256SUMS, and only then is the arch menu rewritten to point at
# the new slot + pinned image. Power loss mid-refresh leaves the old menu → the old, intact slot: the
# medium is never half-updated. Only the REBOOT waits for urgent/the nightly window — staging bytes
# is harmless, rebooting a wall is not. A refresh that cannot complete (depot flaky, sums mismatch)
# SKIPS this round's reboot — rebooting would land on the old pinned build anyway, so waiting 5
# minutes and retrying is strictly better. Boxes without a medium (server-menu netboot) reboot
# exactly as before.
#
# Stubbable for the off-box tests: POLYPTIC_CMDLINE_FILE, POLYPTIC_IMAGE_ID_FILE, POLYPTIC_ENV_FILE,
# POLYPTIC_RUN_DIR, POLYPTIC_LIB_DIR; curl/systemctl/sleep/date come from PATH.
set -u

CMDLINE_FILE="${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}"
IMAGE_ID_FILE="${POLYPTIC_IMAGE_ID_FILE:-/etc/polyptic/image-id}"
ENV_FILE="${POLYPTIC_ENV_FILE:-/run/polyptic/agent.env}"
RUN_DIR="${POLYPTIC_RUN_DIR:-/run/polyptic}"
LIB="${POLYPTIC_LIB_DIR:-$(CDPATH= cd "$(dirname "$0")" && pwd)}"

CMDLINE="$(cat "$CMDLINE_FILE" 2>/dev/null || true)"
DISKBOOT=0
case " $CMDLINE " in *" polyptic.bootpath=disk "*) DISKBOOT=1 ;; esac   # installed box (POL-176)
case " $CMDLINE " in
  *" root=live:http"*) : ;;                       # netboot: a reboot IS the re-pull (unchanged flow)
  *) [ "$DISKBOOT" = 1 ] || exit 0 ;;             # neither netboot nor installed → not ours
esac

RUNNING="$(cat "$IMAGE_ID_FILE" 2>/dev/null || true)"
[ -n "$RUNNING" ] || exit 0   # pre-POL-41 image: no identity, nothing to compare

base="$(printf '%s' "$CMDLINE" | sed -n 's/.*polyptic\.base=\([^ ]*\).*/\1/p')"
[ -n "$base" ] || exit 0
token="$(printf '%s' "$CMDLINE" | sed -n 's/.*polyptic\.token=\([^ ]*\).*/\1/p')"
hostport="${base#http://}"; hostport="${hostport%%/*}"

# ── Watch our own UEFI boot path (POL-115) ──────────────────────────────────────────────────────────
# Firmware re-prepends its own OS entry to BootOrder after updates and reflashes, so a box that
# offloaded cleanly boots a stale disk OS on its next power-cycle and the wall goes dark. This runs
# BEFORE every early exit below (a box already on the current image still needs its boot path
# watched), reports drift to the activity feed, and only re-orders NVRAM when the operator has opted
# in. Best-effort and non-fatal by construction: nothing it can do may stop the update poll.
sh "$LIB/boot-order.sh" || true

case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) exit 0 ;; esac

# The box's stable machine id (POL-105): the manifest is resolved PER MACHINE, so a box tagged
# `canary` in the console is told to boot a different build than the rest of the fleet FROM THE SAME
# DEPOT. Sent as a query parameter, never a header, because GRUB/dracut fetch the same URL later. A
# box whose id the server does not know (or one that has not enrolled yet) matches no roll-out ring
# and is answered with the fleet's active build — exactly the pre-POL-105 behaviour.
MID="$(sed -n 's/^POLYPTIC_MACHINE_ID=//p' "$ENV_FILE" 2>/dev/null)"
MURL="$base/dist/image/$arch/manifest.json"
[ -z "$MID" ] || MURL="$MURL?machineId=$MID"

MANIFEST="$(curl -fsS --max-time 10 "$MURL" 2>/dev/null || true)"
if [ -z "$MANIFEST" ]; then
  # Server unreachable: try again next poll, never guess. A disk box keeps the state file from its
  # last successful poll; if none exists yet this boot, record the conservative running=staged
  # answer so the agent always has a file to read (the POL-176 contract).
  if [ "$DISKBOOT" = 1 ] && [ ! -f "$RUN_DIR/update-state" ]; then
    mkdir -p "$RUN_DIR" 2>/dev/null || true
    printf 'running=%s\nstaged=%s\n' "$RUNNING" "$RUNNING" > "$RUN_DIR/update-state" 2>/dev/null || true
    chmod 0644 "$RUN_DIR/update-state" 2>/dev/null || true
  fi
  exit 0
fi

SERVED="$(printf '%s' "$MANIFEST" | sed -n 's/.*"imageId":"\([^"]*\)".*/\1/p')"
[ -n "$SERVED" ] || exit 0

# ── Self-heal the POL-47 boot splash onto the medium (POL-80) ───────────────────────────────────────
# A stick flashed from an OLD (theme-less) medium shows a PLAIN GRUB menu on the OFFLINE/Wi-Fi path,
# because that path can't reach the server to fetch the theme (GRUB/UEFI can't join WPA). This box IS
# in Linux now and CAN reach the depot (wired OR Wi-Fi — the server was just proven reachable above),
# so pull /boot/theme.txt + logo.png and drop them at the medium's /polyptic/boot/theme/, where
# render-local-grub points `set theme=`. The theme is SHARED, not slotted: this is deliberately
# independent of the A/B kernel/initrd slot refresh below, and runs on EVERY poll (a box already on
# the current image never reaches that refresh, but its old stick still needs the splash). Idempotent
# (a content compare, so a medium already current is never rewritten — no FAT churn, no log line),
# atomic-ish (stage on tmpfs, then mv into place), and strictly best-effort: every step is guarded so
# nothing here can block or brick the boot.
heal_boot_theme() {
  hm="$(mktemp -d 2>/dev/null)" || return 0
  hdev="$(sh "$LIB/find-boot-medium.sh" "$hm" rw 2>/dev/null || true)"
  # Only a medium with an OFFLINE menu needs a baked theme — the local (Wi-Fi) menu, or an installed
  # box's disk menu (POL-176: render-disk-grub points `set theme=` at the ESP's copy too). A plain
  # server-menu netboot stick fetches the theme from the server, and a LEAN medium has no /polyptic
  # tree.
  case "$arch" in amd64) hgrub=x86_64-efi ;; *) hgrub=arm64-efi ;; esac
  if [ -n "$hdev" ] && { [ -f "$hm/grub/local-$arch.cfg" ] \
       || head -n1 "$hm/grub/$hgrub/grub.cfg" 2>/dev/null | grep -q '^# polyptic-disk'; }; then
    td="$hm/polyptic/boot/theme"
    # POL-87/POL-130 orphan repair FIRST, independent of the server: theme.txt without EITHER of
    # its bitmaps makes GRUB paint "error: null src bitmap ... Press any key" on every offline
    # boot. logo.png is what the theme's image block draws (POL-87); bg.png is the desktop-image
    # GRUB 2.12's gfxmenu scales at every draw (POL-130) — media flashed BEFORE bg.png existed
    # carry a complete-LOOKING theme that still errors, so its absence alone must fire this. An
    # already-broken stick repairs itself here even when the server serves no theme — plain menu,
    # which boots silently, until a later poll re-heals the full set.
    if [ -f "$td/theme.txt" ] && { [ ! -s "$td/logo.png" ] || [ ! -s "$td/bg.png" ]; }; then
      rm -f "$td/theme.txt" 2>/dev/null \
        && echo "update-poll: removed an orphan theme.txt (missing logo.png or bg.png) from $hdev. The menu stays plain until the splash re-heals"
    fi
    stg="$(mktemp -d 2>/dev/null || true)"
    if [ -n "$stg" ] \
       && curl -fsS --max-time 60 -o "$stg/theme.txt" "$base/boot/theme.txt" 2>/dev/null \
       && curl -fsS --max-time 60 -o "$stg/logo.png"  "$base/boot/logo.png"  2>/dev/null \
       && curl -fsS --max-time 60 -o "$stg/bg.png"    "$base/boot/bg.png"    2>/dev/null \
       && [ -s "$stg/theme.txt" ] && [ -s "$stg/logo.png" ] && [ -s "$stg/bg.png" ] \
       && sh "$LIB/grub-png-check.sh" "$stg/logo.png" 2>/dev/null \
       && sh "$LIB/grub-png-check.sh" "$stg/bg.png"   2>/dev/null; then
      # The png checks are the POL-130 "file exists is not file loads" gate: a served bitmap GRUB
      # cannot decode (interlaced, greyscale, truncated en route) must never be COMMITTED to a
      # medium a wall boots from — skip this round's heal instead, keeping whatever state the
      # stick has (worst case the orphan repair above already made it plain, which boots silently).
      if cmp -s "$stg/theme.txt" "$td/theme.txt" 2>/dev/null \
         && cmp -s "$stg/logo.png" "$td/logo.png" 2>/dev/null \
         && cmp -s "$stg/bg.png"   "$td/bg.png"   2>/dev/null; then
        : # already current — leave the FAT untouched (the every-5-minutes steady state)
      # Bitmaps FIRST, theme.txt LAST (POL-87): theme.txt is what the GRUB guard keys on, so it is
      # the COMMIT record — its dependencies must exist before it. A write torn anywhere in this
      # chain leaves either the old state or bitmaps-without-theme, both of which boot silently;
      # the old order could leave theme-without-bitmaps, which errors on the glass forever.
      elif mkdir -p "$td" 2>/dev/null \
           && cp "$stg/logo.png"  "$td/logo.png.new"  2>/dev/null \
           && cp "$stg/bg.png"    "$td/bg.png.new"    2>/dev/null \
           && cp "$stg/theme.txt" "$td/theme.txt.new" 2>/dev/null \
           && mv -f "$td/logo.png.new"  "$td/logo.png"  2>/dev/null \
           && mv -f "$td/bg.png.new"    "$td/bg.png"    2>/dev/null \
           && mv -f "$td/theme.txt.new" "$td/theme.txt" 2>/dev/null; then
        echo "update-poll: healed the offline boot splash on $hdev from $base/boot/ (theme.txt + logo.png + bg.png)"
      fi
      rm -f "$td/theme.txt.new" "$td/logo.png.new" "$td/bg.png.new" 2>/dev/null || true
    fi
    [ -z "$stg" ] || rm -rf "$stg" 2>/dev/null || true
  fi
  umount "$hm" 2>/dev/null || true; rmdir "$hm" 2>/dev/null || true
}
heal_boot_theme

# A box that booted the local menu's RECOVERY entry (medium pruned past retention → newest image on
# an older kernel) runs the SERVED rootfs already, so the image-id comparison alone would never heal
# it. The tell is structural: the running kernel has no /lib/modules directory in this rootfs. Such
# a box refreshes its medium and reboots into a matched pair on the normal policy.
STALE_BOOT=0
[ -d "${POLYPTIC_MODULES_BASE:-/lib/modules}/$(uname -r)" ] || STALE_BOOT=1

# sha256 of one file, compared against the depot build's SHA256SUMS line for <name>. Shared by the
# medium refresh below and the disk staging (POL-176).
sum_ok() { # <file> <name> <sums-file>
  want="$(awk -v n="$2" '$2==n {print $1}' "$3" | head -n1)"
  [ -n "$want" ] || return 1
  got="$( (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{print $1}')"
  [ "$got" = "$want" ]
}

# ── Installed boxes (POL-176): stage onto the DISK, reboot OPERATOR-FIRST ───────────────────────────
# The ESP is the boot medium (install-to-disk.sh wrote the polyptic/medium-id marker), so
# find-boot-medium + the boot-order watch + the theme heal above all ran unchanged. Staging mirrors
# the medium refresh below: everything lands in the INACTIVE slot, verified against the build's
# SHA256SUMS, and the cfg rewrite is the LAST step — power loss anywhere before it leaves the old
# cfg pointing at the old, intact slot. Any failure skips the round, keeps the old state, and the
# next poll retries. This block always exits: the netboot flow below is never an installed box's.
if [ "$DISKBOOT" = 1 ]; then
  case "$arch" in amd64) grubdir=x86_64-efi ;; *) grubdir=arm64-efi ;; esac
  staged="$RUNNING"
  ok=1
  mmnt="$(mktemp -d)"
  mdev="$(sh "$LIB/find-boot-medium.sh" "$mmnt" rw 2>/dev/null || true)"
  dcfg="$mmnt/grub/$grubdir/grub.cfg"
  if [ -n "$mdev" ] && [ -f "$dcfg" ] && head -n1 "$dcfg" 2>/dev/null | grep -q '^# polyptic-disk'; then
    cur_slot="$(sed -n '1s/.* slot=\([a-z]\).*/\1/p' "$dcfg")"
    cur_img="$(sed -n '1s/.* image=\([^ ]*\).*/\1/p' "$dcfg")"
    staged="$cur_img"
    if [ "$cur_img" != "$SERVED" ]; then
      case "$cur_slot" in a) new_slot=b ;; *) new_slot=a ;; esac
      new_label="POLYPTIC-$(printf '%s' "$new_slot" | tr 'ab' 'AB')"
      dst="$mmnt/polyptic/boot/$arch/$new_slot"
      bsrc="$base/dist/image/$arch/builds/$SERVED"
      echo "update-poll: staging image $SERVED into disk slot $new_slot"
      mkdir -p "$dst" 2>/dev/null || ok=0
      # The LEAN initrd, deliberately (not initrd-wifi): a disk boot needs no network in the
      # initramfs — the kernel pair loads from the ESP and the squashfs mounts from the slot.
      curl -fsS --max-time 600 -o "$dst/vmlinuz.new" "$bsrc/vmlinuz" 2>/dev/null || ok=0
      curl -fsS --max-time 600 -o "$dst/initrd.new"  "$bsrc/initrd"  2>/dev/null || ok=0
      curl -fsS --max-time 30  -o "$mmnt/polyptic/SHA256SUMS.new" "$bsrc/SHA256SUMS" 2>/dev/null || ok=0
      if [ "$ok" = 1 ]; then
        sum_ok "$dst/vmlinuz.new" vmlinuz "$mmnt/polyptic/SHA256SUMS.new" || ok=0
        sum_ok "$dst/initrd.new"  initrd  "$mmnt/polyptic/SHA256SUMS.new" || ok=0
      fi
      # The squashfs goes to the inactive slot PARTITION (by filesystem label), fetched as .new and
      # renamed only after its sha256 check: a torn transfer can never look like a staged image.
      if [ "$ok" = 1 ]; then
        smnt="$(mktemp -d)"
        if mount "${POLYPTIC_BYLABEL_DIR:-/dev/disk/by-label}/$new_label" "$smnt" 2>/dev/null; then
          mkdir -p "$smnt/LiveOS" 2>/dev/null || ok=0
          curl -fsS --max-time 1800 -o "$smnt/LiveOS/squashfs.img.new" "$bsrc/rootfs.squashfs" 2>/dev/null || ok=0
          if [ "$ok" = 1 ]; then
            sum_ok "$smnt/LiveOS/squashfs.img.new" rootfs.squashfs "$mmnt/polyptic/SHA256SUMS.new" || ok=0
          fi
          if [ "$ok" = 1 ]; then
            mv -f "$smnt/LiveOS/squashfs.img.new" "$smnt/LiveOS/squashfs.img" || ok=0
          fi
          rm -f "$smnt/LiveOS/squashfs.img.new" 2>/dev/null || true
          umount "$smnt" 2>/dev/null || true
        else
          ok=0
        fi
        rmdir "$smnt" 2>/dev/null || true
      fi
      if [ "$ok" = 1 ]; then
        mv -f "$dst/vmlinuz.new" "$dst/vmlinuz" && mv -f "$dst/initrd.new" "$dst/initrd" || ok=0
      fi
      if [ "$ok" = 1 ]; then
        # The cfg rewrite is LAST — the commit point. Both paths grubnet's memdisk bootstrap probes
        # get it; the plain /grub/grub.cfg only when it is ours (polyptic-marked) or absent.
        sh "$LIB/render-disk-grub.sh" "$arch" "$new_slot" "$hostport" "$SERVED" "$token" > "$dcfg" || ok=0
        if [ "$ok" = 1 ] && { [ ! -f "$mmnt/grub/grub.cfg" ] || head -n1 "$mmnt/grub/grub.cfg" 2>/dev/null | grep -q '^# polyptic-disk'; }; then
          cp "$dcfg" "$mmnt/grub/grub.cfg" 2>/dev/null || true
        fi
      fi
      rm -f "$mmnt/polyptic/SHA256SUMS.new" 2>/dev/null || true
      if [ "$ok" = 1 ]; then
        staged="$SERVED"
        echo "update-poll: disk now stages $SERVED (slot $new_slot)"
      else
        echo "update-poll: disk staging for $SERVED did not complete, so keeping $cur_img and retrying next poll"
      fi
    fi
  else
    ok=0
    # Named so field triage can tell "the ESP's boot config is missing/foreign" from "never ran".
    echo "update-poll: this box boots from disk but its ESP boot config was not found: nothing staged"
  fi
  umount "$mmnt" 2>/dev/null || true; rmdir "$mmnt" 2>/dev/null || true

  # The contract file the agent relays to the console (POL-176), written on EVERY disk-box poll:
  # `staged` is whatever the disk GRUB cfg header points at (equals `running` when up to date).
  mkdir -p "$RUN_DIR" 2>/dev/null || true
  printf 'running=%s\nstaged=%s\n' "$RUNNING" "$staged" > "$RUN_DIR/update-state" 2>/dev/null || true
  chmod 0644 "$RUN_DIR/update-state" 2>/dev/null || true

  [ "$SERVED" = "$RUNNING" ] && exit 0    # up to date: the steady state, silent
  [ "$staged" = "$SERVED" ] || exit 0     # staging incomplete: never reboot onto a half-staged disk

  # OPERATOR-FIRST reboot policy (POL-176): the staged image is committed and a reboot applies it,
  # but rebooting a wall is disruptive — urgent reboots now (splayed), the nightly window is the
  # backstop so a fleet never drifts, and otherwise the box WAITS: the console shows "staged" from
  # the state file above and its "reboot to apply" rides the existing reboot command.
  URGENT=0
  case "$MANIFEST" in *'"urgent":true'*) URGENT=1 ;; esac
  if [ "$URGENT" != "1" ]; then
    hour="$(date +%H)"
    case "$hour" in 03|04) : ;; *) echo "update-poll: image $SERVED staged (running $RUNNING). Waiting for the operator or the nightly window"; exit 0 ;; esac
  fi
  MARKER="$RUN_DIR/update-reboot-requested"
  [ -f "$MARKER" ] && exit 0
  mkdir -p "$RUN_DIR" && : > "$MARKER"
  SPLAY=$(( $(printf '%s' "${MID:-$RUNNING}" | cksum | cut -d' ' -f1) % 241 ))
  echo "update-poll: rebooting onto staged image $SERVED (urgent=$URGENT) in ${SPLAY}s"
  sleep "$SPLAY"
  systemctl reboot
  exit 0
fi

if [ "$SERVED" = "$RUNNING" ] && [ "$STALE_BOOT" = 0 ]; then exit 0; fi

# ── Stage the new image onto the local boot medium NOW (POL-63; decoupled from the window, POL-172) ─
# Like the theme heal above, this runs the moment a mismatch is seen, deliberately independent of the
# reboot policy below: rebooting a wall is disruptive (hence urgent/nightly), but staging bytes into
# the medium's INACTIVE slot is invisible to a boot until the menu rewrite commits it — harmless at
# any hour. Gating the staging behind the window (the pre-POL-172 shape) left a stick pinned at a
# stale image all day, and a wall powered off overnight could NEVER self-refresh: the window is
# exactly when it is dark. Idempotent: a medium already carrying $SERVED skips straight to the reboot
# decision, so the every-5-minutes retry costs nothing once caught up. (sum_ok is defined above,
# shared with the POL-176 disk staging.)

mmnt="$(mktemp -d)"
mdev="$(sh "$LIB/find-boot-medium.sh" "$mmnt" rw 2>/dev/null || true)"
if [ -n "$mdev" ] && [ -f "$mmnt/grub/local-$arch.cfg" ]; then
  cur_slot="$(sed -n '1s/.* slot=\([a-z]\).*/\1/p' "$mmnt/grub/local-$arch.cfg")"
  cur_img="$(sed -n '1s/.* image=\([^ ]*\).*/\1/p' "$mmnt/grub/local-$arch.cfg")"
  if [ "$cur_img" = "$SERVED" ]; then
    echo "update-poll: medium $mdev already carries $SERVED"
    umount "$mmnt" 2>/dev/null || true; rmdir "$mmnt" 2>/dev/null || true
  else
    case "$cur_slot" in a) new_slot=b ;; *) new_slot=a ;; esac
    dst="$mmnt/polyptic/boot/$arch/$new_slot"
    bsrc="$base/dist/image/$arch/builds/$SERVED"
    echo "update-poll: refreshing medium $mdev slot $new_slot with image $SERVED"
    ok=1
    mkdir -p "$dst" 2>/dev/null || ok=0
    curl -fsS --max-time 600 -o "$dst/vmlinuz.new" "$bsrc/vmlinuz"        2>/dev/null || ok=0
    curl -fsS --max-time 600 -o "$dst/initrd.new"  "$bsrc/initrd-wifi"    2>/dev/null || ok=0
    curl -fsS --max-time 30  -o "$mmnt/polyptic/SHA256SUMS.new" "$bsrc/SHA256SUMS" 2>/dev/null || ok=0
    if [ "$ok" = 1 ]; then
      sum_ok "$dst/vmlinuz.new" vmlinuz     "$mmnt/polyptic/SHA256SUMS.new" || ok=0
      sum_ok "$dst/initrd.new"  initrd-wifi "$mmnt/polyptic/SHA256SUMS.new" || ok=0
    fi
    if [ "$ok" = 1 ]; then
      mv -f "$dst/vmlinuz.new" "$dst/vmlinuz" && mv -f "$dst/initrd.new" "$dst/initrd" || ok=0
    fi
    if [ "$ok" = 1 ]; then
      # The menu rewrite is LAST — the commit point. Everything before it is invisible to a boot.
      sh "$LIB/render-local-grub.sh" "$arch" "$new_slot" "$hostport" "$SERVED" "$token" \
        > "$mmnt/grub/local-$arch.cfg" || ok=0
    fi
    rm -f "$mmnt/polyptic/SHA256SUMS.new" 2>/dev/null || true
    umount "$mmnt" 2>/dev/null || true; rmdir "$mmnt" 2>/dev/null || true
    if [ "$ok" != 1 ]; then
      echo "update-poll: medium refresh for $SERVED did not complete, so keeping $cur_img and retrying next poll"
      exit 0
    fi
    echo "update-poll: medium $mdev now boots $SERVED (slot $new_slot)"
  fi
else
  rmdir "$mmnt" 2>/dev/null || true
  # Named so field triage can tell "skipped: no medium attached" from "never reached this code".
  echo "update-poll: no local boot medium (server-menu netboot): nothing to stage"
fi

URGENT=0
case "$MANIFEST" in *'"urgent":true'*) URGENT=1 ;; esac

# Only the REBOOT is policy-gated: urgent → now (splayed below); otherwise the nightly window. The
# medium above is already staged either way, so the eventual reboot always lands on the new image.
if [ "$URGENT" != "1" ]; then
  hour="$(date +%H)"
  case "$hour" in 03|04) : ;; *) echo "update-poll: newer image $SERVED available (running $RUNNING$([ "$STALE_BOOT" = 1 ] && printf ', kernel mismatched')). Waiting for the nightly window"; exit 0 ;; esac
fi

# One reboot request per boot: the marker lives on tmpfs so it cannot outlive the reboot itself.
MARKER="$RUN_DIR/update-reboot-requested"
[ -f "$MARKER" ] && exit 0
mkdir -p "$RUN_DIR" && : > "$MARKER"

# Per-box splay (0–240 s) derived from the stable machine id (read above), so every box in a wall
# lands on a different second and the depot never serves the whole fleet at once.
SPLAY=$(( $(printf '%s' "${MID:-$RUNNING}" | cksum | cut -d' ' -f1) % 241 ))
if [ "$SERVED" = "$RUNNING" ]; then
  echo "update-poll: rebooting to re-pair the kernel with image $SERVED (recovery boot) in ${SPLAY}s"
else
  echo "update-poll: image $SERVED supersedes $RUNNING (urgent=$URGENT). Rebooting to re-pull in ${SPLAY}s"
fi
sleep "$SPLAY"
systemctl reboot
