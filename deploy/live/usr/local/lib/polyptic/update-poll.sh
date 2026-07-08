#!/bin/sh
# Update poll (POL-41): every 5 minutes (polyptic-update-poll.timer) compare the image id this box
# BOOTED (/etc/polyptic/image-id, baked at build/refresh time) against the id the control plane is
# SERVING (/dist/image/<arch>/manifest.json). A mismatch means a newer image exists; a reboot IS the
# re-pull, the OS streams from the server at every boot. Policy:
#
#   urgent (admin switch in Console ▸ Settings ▸ Image updates) → reboot NOW, with a 0-4 min
#       per-box splay so a wall doesn't hammer the depot in unison;
#   not urgent → reboot only inside the nightly window (03:00–04:59 local), also splayed. A 01:00
#       scheduled refresh therefore rolls across the fleet the same night, invisibly.
#
# NETBOOT BOXES ONLY: a box booted from the live ISO / USB stick re-boots the SAME stale medium, so
# rebooting it is at best pointless and at worst a loop. The `iso-url=` kernel arg exists exactly
# and only on netboot cmdlines (casper streams the image from it), so it is the guard.
set -u

CMDLINE="$(cat /proc/cmdline 2>/dev/null || true)"
case " $CMDLINE " in *" iso-url="*|*" iso-url"*) : ;; *) exit 0 ;; esac   # not netboot → not ours

RUNNING="$(cat /etc/polyptic/image-id 2>/dev/null || true)"
[ -n "$RUNNING" ] || exit 0   # pre-POL-41 image: no identity, nothing to compare

base="$(printf '%s' "$CMDLINE" | sed -n 's/.*polyptic\.base=\([^ ]*\).*/\1/p')"
[ -n "$base" ] || exit 0

case "$(uname -m)" in x86_64) arch=amd64 ;; aarch64) arch=arm64 ;; *) exit 0 ;; esac

MANIFEST="$(curl -fsS --max-time 10 "$base/dist/image/$arch/manifest.json" 2>/dev/null || true)"
[ -n "$MANIFEST" ] || exit 0   # server unreachable: try again in 5 minutes, never guess

SERVED="$(printf '%s' "$MANIFEST" | sed -n 's/.*"imageId":"\([^"]*\)".*/\1/p')"
[ -n "$SERVED" ] || exit 0
[ "$SERVED" = "$RUNNING" ] && exit 0

URGENT=0
case "$MANIFEST" in *'"urgent":true'*) URGENT=1 ;; esac

if [ "$URGENT" != "1" ]; then
  hour="$(date +%H)"
  case "$hour" in 03|04) : ;; *) echo "update-poll: newer image $SERVED available (running $RUNNING); waiting for the nightly window"; exit 0 ;; esac
fi

# One reboot request per boot: the marker lives on tmpfs so it cannot outlive the reboot itself.
MARKER=/run/polyptic/update-reboot-requested
[ -f "$MARKER" ] && exit 0
mkdir -p /run/polyptic && : > "$MARKER"

# Per-box splay (0–240 s) derived from the stable machine id, so every box in a wall lands on a
# different second and the depot never serves the whole fleet at once.
MID="$(cat /run/polyptic/agent.env 2>/dev/null | sed -n 's/^POLYPTIC_MACHINE_ID=//p')"
SPLAY=$(( $(printf '%s' "${MID:-$RUNNING}" | cksum | cut -d' ' -f1) % 241 ))
echo "update-poll: image $SERVED supersedes $RUNNING (urgent=$URGENT); rebooting to re-pull in ${SPLAY}s"
sleep "$SPLAY"
systemctl reboot
