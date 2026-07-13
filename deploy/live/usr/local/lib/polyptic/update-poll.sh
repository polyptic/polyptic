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
# NETBOOT BOXES ONLY: a box booted from the live ISO re-boots the SAME stale medium, so rebooting it
# is at best pointless and at worst a loop. `root=live:http…` is exactly and only what a netboot
# cmdline carries (dracut streams the squashfs from that URL); an ISO boot carries
# `root=live:CDLABEL=…`, so matching on the scheme is the guard.
#
# BOXES WITH A LOCAL BOOT MEDIUM (POL-63) — the universal USB stick or an offloaded ESP — refresh
# that medium BEFORE rebooting: the new build's vmlinuz + initrd-wifi are fetched into the medium's
# INACTIVE slot, verified against the depot's SHA256SUMS, and only then is the arch menu rewritten
# to point at the new slot + pinned image. Power loss mid-refresh leaves the old menu → the old,
# intact slot: the medium is never half-updated. A refresh that cannot complete (depot flaky, sums
# mismatch) SKIPS this round's reboot — rebooting would land on the old pinned build anyway, so
# waiting 5 minutes and retrying is strictly better. Boxes without a medium (server-menu netboot)
# reboot exactly as before.
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
case " $CMDLINE " in *" root=live:http"*) : ;; *) exit 0 ;; esac   # not netboot → not ours

RUNNING="$(cat "$IMAGE_ID_FILE" 2>/dev/null || true)"
[ -n "$RUNNING" ] || exit 0   # pre-POL-41 image: no identity, nothing to compare

base="$(printf '%s' "$CMDLINE" | sed -n 's/.*polyptic\.base=\([^ ]*\).*/\1/p')"
[ -n "$base" ] || exit 0
token="$(printf '%s' "$CMDLINE" | sed -n 's/.*polyptic\.token=\([^ ]*\).*/\1/p')"
hostport="${base#http://}"; hostport="${hostport%%/*}"

case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) exit 0 ;; esac

MANIFEST="$(curl -fsS --max-time 10 "$base/dist/image/$arch/manifest.json" 2>/dev/null || true)"
[ -n "$MANIFEST" ] || exit 0   # server unreachable: try again in 5 minutes, never guess

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
  # Only a medium with the local (offline) menu needs a baked theme: a plain server-menu netboot stick
  # fetches the theme from the server, and a LEAN medium has no /polyptic tree.
  if [ -n "$hdev" ] && [ -f "$hm/grub/local-$arch.cfg" ]; then
    td="$hm/polyptic/boot/theme"
    # POL-87 orphan repair FIRST, independent of the server: theme.txt without its logo.png makes
    # GRUB paint "error: null src bitmap ... Press any key" on every offline boot (the theme
    # references logo.png; old media were rendered with a guard that only checked theme.txt). An
    # already-broken stick repairs itself here even when the server serves no theme — plain menu,
    # which boots silently, until a later poll re-heals the full pair.
    if [ -f "$td/theme.txt" ] && [ ! -s "$td/logo.png" ]; then
      rm -f "$td/theme.txt" 2>/dev/null \
        && echo "update-poll: removed an orphan theme.txt (no logo.png) from $hdev — plain menu until the splash re-heals"
    fi
    stg="$(mktemp -d 2>/dev/null || true)"
    if [ -n "$stg" ] \
       && curl -fsS --max-time 60 -o "$stg/theme.txt" "$base/boot/theme.txt" 2>/dev/null \
       && curl -fsS --max-time 60 -o "$stg/logo.png"  "$base/boot/logo.png"  2>/dev/null \
       && [ -s "$stg/theme.txt" ] && [ -s "$stg/logo.png" ]; then
      if cmp -s "$stg/theme.txt" "$td/theme.txt" 2>/dev/null \
         && cmp -s "$stg/logo.png" "$td/logo.png" 2>/dev/null; then
        : # already current — leave the FAT untouched (the every-5-minutes steady state)
      # logo FIRST, theme.txt LAST (POL-87): theme.txt is what the GRUB guard keys on, so it is the
      # COMMIT record — its dependency must exist before it. A write torn anywhere in this chain
      # leaves either the old state or logo-without-theme, both of which boot silently; the old
      # order could leave theme-without-logo, which errors on the glass forever.
      elif mkdir -p "$td" 2>/dev/null \
           && cp "$stg/logo.png"  "$td/logo.png.new"  2>/dev/null \
           && cp "$stg/theme.txt" "$td/theme.txt.new" 2>/dev/null \
           && mv -f "$td/logo.png.new"  "$td/logo.png"  2>/dev/null \
           && mv -f "$td/theme.txt.new" "$td/theme.txt" 2>/dev/null; then
        echo "update-poll: healed the offline boot splash on $hdev from $base/boot/ (theme.txt + logo.png)"
      fi
      rm -f "$td/theme.txt.new" "$td/logo.png.new" 2>/dev/null || true
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

if [ "$SERVED" = "$RUNNING" ] && [ "$STALE_BOOT" = 0 ]; then exit 0; fi

URGENT=0
case "$MANIFEST" in *'"urgent":true'*) URGENT=1 ;; esac

if [ "$URGENT" != "1" ]; then
  hour="$(date +%H)"
  case "$hour" in 03|04) : ;; *) echo "update-poll: newer image $SERVED available (running $RUNNING$([ "$STALE_BOOT" = 1 ] && printf ', kernel mismatched')); waiting for the nightly window"; exit 0 ;; esac
fi

# ── Refresh the local boot medium first (POL-63): the reboot must land on the NEW image ─────────────
# sha256 of one file, compared against the depot build's SHA256SUMS line for <name>.
sum_ok() { # <file> <name> <sums-file>
  want="$(awk -v n="$2" '$2==n {print $1}' "$3" | head -n1)"
  [ -n "$want" ] || return 1
  got="$( (sha256sum "$1" 2>/dev/null || shasum -a 256 "$1") | awk '{print $1}')"
  [ "$got" = "$want" ]
}

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
      echo "update-poll: medium refresh for $SERVED did not complete; keeping $cur_img and retrying next poll"
      exit 0
    fi
    echo "update-poll: medium $mdev now boots $SERVED (slot $new_slot)"
  fi
else
  rmdir "$mmnt" 2>/dev/null || true   # no medium (server-menu netboot): nothing to refresh
fi

# One reboot request per boot: the marker lives on tmpfs so it cannot outlive the reboot itself.
MARKER="$RUN_DIR/update-reboot-requested"
[ -f "$MARKER" ] && exit 0
mkdir -p "$RUN_DIR" && : > "$MARKER"

# Per-box splay (0–240 s) derived from the stable machine id, so every box in a wall lands on a
# different second and the depot never serves the whole fleet at once.
MID="$(cat "$ENV_FILE" 2>/dev/null | sed -n 's/^POLYPTIC_MACHINE_ID=//p')"
SPLAY=$(( $(printf '%s' "${MID:-$RUNNING}" | cksum | cut -d' ' -f1) % 241 ))
if [ "$SERVED" = "$RUNNING" ]; then
  echo "update-poll: rebooting to re-pair the kernel with image $SERVED (recovery boot); in ${SPLAY}s"
else
  echo "update-poll: image $SERVED supersedes $RUNNING (urgent=$URGENT); rebooting to re-pull in ${SPLAY}s"
fi
sleep "$SPLAY"
systemctl reboot
