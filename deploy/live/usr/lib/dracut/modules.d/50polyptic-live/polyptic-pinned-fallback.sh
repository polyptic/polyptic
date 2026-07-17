#!/bin/sh
# Polyptic (POL-116): the box heals a PRUNED PIN in the initramfs, where it still has a network.
#
# THE FAILURE (real hardware, 2026-07-14). The offline/Wi-Fi path boots the LOCAL menu baked on the
# medium (GRUB cannot join WPA, D67), and that menu PINS the root image to one build:
#
#   root=live:http://<host>/dist/image/<arch>/builds/<imageId>/rootfs.squashfs
#
# The pin is deliberate — the kernel + initrd carried on the stick then always meet the /lib/modules
# they were built with. It is refreshed by update-poll's A/B slot switch, which only runs AFTER a
# successful boot. Retention (D54) keeps `imageUpdates.retainBuilds` builds per arch (default 3) and
# prunes the rest. So a box powered off across three rebuilds comes back to a pin that no longer
# exists, and livenet retries the 404 a hundred times, five seconds apart, forever:
#
#   curl: (22) The requested URL returned error: 404
#   Warning: Downloading '…/builds/20260713T140345Z-fe8ca57b/rootfs.squashfs' failed!
#
# It can never boot the offline path to earn the refresh that would fix its pin. Chicken-and-egg.
# Making retention pin-aware was REJECTED (D105): protecting every build some fielded medium *might*
# still pin means never pruning. So the BOX heals itself instead — it has just joined the Wi-Fi, the
# depot is right there, and the only thing wrong is which build id it is asking for.
#
# WHAT THIS DOES, in order:
#   1. Probe the pinned image. If the depot serves it — the overwhelmingly common case — return with
#      $netroot untouched: nothing about a healthy boot changes.
#   2. Pinned unreachable after a bounded number of attempts → ask the ungated manifest which build
#      is ACTIVE and probe THAT build's `builds/<activeId>/` path (POL-79's ensureActiveBuild
#      hardlinks the mirror into existence on the fetch if it is missing).
#   3. Manifest unreachable or its build unusable → fall back to the UNPINNED arch root
#      (`/dist/image/<arch>/rootfs.squashfs`), which is always the active build.
#   4. Neither reachable → change NOTHING. A dead network must not be dressed up as a pruned build:
#      leaving $netroot alone hands the boot back to livenet's own retry loop and the existing
#      "Cannot fetch the OS image" narration, exactly as before this file existed.
#   5. When it DOES swap the image, say so where the OPERATOR looks — console and a `POST
#      /boot/report` (code `pinned-build-missing`) — because the box is now running a rootfs its
#      on-stick kernel did not ship with. NOT on the splash (POL-140): the wall is public signage,
#      the swap is self-healing bookkeeping, and to anyone in the room this boot looks standard. A genuine kernel/module mismatch is still owned by the existing D67
#      recovery machinery (update-poll's missing-/lib/modules tell): it refreshes the medium and
#      reboots into a matched pair. Across daily rebuilds of one kernel ABI that mismatch is usually
#      a non-event, and a box that boots with a loud warning beats a box that never boots.
#
# Self-limiting: after this boot, update-poll re-pins the medium as it always has, so it fires once.
#
# HOW IT HOOKS IN. dracut's /sbin/netroot (45net-lib) runs `source_hook netroot` and THEN invokes the
# handler as `"$handler" "$netif" "$netroot" "$NEWROOT"` — livenetroot reads the image URL from that
# second argument. So a `netroot` hook is sourced in the very shell that holds $netroot, and
# reassigning it here is all it takes to point livenet at a different image. No livenet file is
# patched, no fetch/retry logic is reimplemented.
#
# THIS FILE IS *SOURCED*, NOT EXECUTED (see polyptic-ram.sh for the same rules, learned by breaking a
# boot): never `exit` (it would kill /sbin/netroot before it ran the handler — no root, ever), never
# `set -e`/`set -u` (dracut's own libs are not written for them). All the work happens inside a
# SUBSHELL, so nothing in here can escape into the caller's shell but the one URL we choose.
#
# dash-safe: no bashisms, no arrays, no [[ ]]. Externals: curl + sed + sleep + tr only, every one of
# them installed by this module's inst_multiple (POL-78 is the cautionary tale — the initramfs
# shipped no `dirname`, so every Wi-Fi config was silently "rejected"). tr is additionally guarded
# with `command -v`, and its absence only costs the machine id in the report.

# Is the depot really serving this image? A 1-byte RANGED GET on the very route livenet will use
# (the depot answers 206 — provision.ts parseRange), so this proves the fetch, not a HEAD route that
# some proxy might answer differently. 404 → curl still exits 0 and prints the code, which is the
# whole point: a pruned build and an unreachable depot must NOT look the same.
polyptic_pin_probe() { # <url> → 0 only if the depot answered with the bytes
  _code="$(curl -sS -o /dev/null -w '%{http_code}' -r 0-0 \
    --connect-timeout "${POLYPTIC_PIN_CONNECT_TIMEOUT:-5}" \
    --max-time "${POLYPTIC_PIN_MAX_TIME:-20}" "$1" 2> /dev/null)" || return 1
  case "$_code" in 200 | 206) return 0 ;; esac
  return 1
}

# The stable netboot identity, in the SAME `dmi-<uuid>` form derive-machine-id.sh emits in the rootfs,
# so the operator's activity line names the box they already know. Pure shell + tr; a box whose
# firmware reports a placeholder UUID simply reports no id ("A machine"), which is honest.
polyptic_pin_machine_id() {
  _f="${POLYPTIC_DMI_UUID_FILE:-/sys/class/dmi/id/product_uuid}"
  [ -r "$_f" ] || return 0
  command -v tr > /dev/null 2>&1 || return 0
  _u="$(tr 'A-Z' 'a-z' < "$_f" 2> /dev/null | tr -d '\r\n\t ')"
  case "$_u" in
    00000000-0000-0000-0000-000000000000) return 0 ;; # firmware all-zero placeholder
    ffffffff-ffff-ffff-ffff-ffffffffffff) return 0 ;; # firmware all-ones placeholder
    [0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]-[0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f][0-9a-f])
      printf 'dmi-%s' "$_u"
      ;;
  esac
  return 0
}

# One Live Activity line, off the box, while the box still has the network that produced it (POL-58's
# route, POL-116's code). Everything is best-effort: a depot that refuses the report must not cost the
# boot. The enrolment token (when the fleet is gated) rides in the header, never in the body.
polyptic_pin_report() { # <detail>
  _cmd="$(cat "${POLYPTIC_CMDLINE_FILE:-/proc/cmdline}" 2> /dev/null)"
  _base="$(printf '%s' "$_cmd" | sed -n 's/.*polyptic\.base=\([^ ]*\).*/\1/p')"
  [ -n "$_base" ] || return 0
  _token="$(printf '%s' "$_cmd" | sed -n 's/.*polyptic\.token=\([^ ]*\).*/\1/p')"
  # `detail` is BootReportBody's 200-char field; clamp BEFORE anything else so no escape is halved.
  # Every character in it is composed here out of ids we validated, so there is nothing to escape.
  _detail="$(printf '%.200s' "$1")"
  _body="$(printf '{"ok":false,"code":"pinned-build-missing","detail":"%s","machineId":"%s"}' \
    "$_detail" "$(polyptic_pin_machine_id)")"
  set -- -fsS -m 15 -o /dev/null -X POST -H 'Content-Type: application/json' --data-binary "$_body"
  if [ -n "$_token" ]; then set -- "$@" -H "Authorization: Bearer $_token"; fi
  curl "$@" "$_base/boot/report" > /dev/null 2>&1 || true
  return 0
}

# The whole decision, run in a SUBSHELL. Writes the URL to use to <outfile> — and writes NOTHING when
# the pinned image is fine, or when the depot cannot be reached at all.
polyptic_pin_fallback() { # <pinned-url> <outfile>
  _url="$1"
  _out="$2"
  _console="${POLYPTIC_CONSOLE:-/dev/console}"

  # Only a PINNED build path can be orphaned by retention. An unpinned arch root (the wired,
  # server-rendered menu) and a live-ISO/CDLABEL root are not ours to touch.
  case "$_url" in
    http://*/dist/image/*/builds/*/rootfs.squashfs) : ;;
    https://*/dist/image/*/builds/*/rootfs.squashfs) : ;;
    *) return 0 ;;
  esac

  # 1) Is the pin still there? Bounded attempts, because a radio that has just associated can drop
  #    the first request or two — and a transient must not be read as a prune.
  _attempts="${POLYPTIC_PIN_ATTEMPTS:-3}"
  _i=1
  while [ "$_i" -le "$_attempts" ]; do
    polyptic_pin_probe "$_url" && return 0 # the happy path: $netroot is never touched
    [ "$_i" -lt "$_attempts" ] && sleep "${POLYPTIC_PIN_SLEEP:-5}"
    _i=$((_i + 1))
  done

  # Split the pinned URL with parameter expansion only: <base>/dist/image/<arch>/builds/<id>/rootfs…
  _pre="${_url%%/dist/image/*}"
  _rest="${_url#*/dist/image/}"
  _arch="${_rest%%/*}"
  _pinned="${_rest#*/builds/}"
  _pinned="${_pinned%%/*}"
  case "$_arch" in "" | *[!A-Za-z0-9._-]*) return 0 ;; esac
  case "$_pinned" in "" | *[!A-Za-z0-9._-]*) _pinned="unknown" ;; esac
  _root="$_pre/dist/image/$_arch"

  # 2) Which build is ACTIVE? The manifest is ungated and is what update-poll already polls.
  _active="$(curl -fsS --max-time "${POLYPTIC_PIN_MAX_TIME:-20}" "$_root/manifest.json" 2> /dev/null \
    | sed -n 's/.*"imageId":"\([^"]*\)".*/\1/p')"
  case "$_active" in *[!A-Za-z0-9._-]*) _active="" ;; esac

  _new=""
  if [ -n "$_active" ] && [ "$_active" != "$_pinned" ] \
    && polyptic_pin_probe "$_root/builds/$_active/rootfs.squashfs"; then
    _new="$_root/builds/$_active/rootfs.squashfs"
    _why="the OS image this screen was pinned to ($_pinned) is gone from the depot, so booting the current image ($_active) instead"
  elif polyptic_pin_probe "$_root/rootfs.squashfs"; then
    # 3) No usable manifest — but the arch root is always the active build, and it 200s.
    _new="$_root/rootfs.squashfs"
    _why="the OS image this screen was pinned to ($_pinned) is gone from the depot, so booting the depot's current image instead"
  else
    # 4) The DEPOT, not the pin, is the problem. Say nothing, change nothing: livenet's own retry
    #    loop and the initqueue timeout narration own a network outage, and always have.
    echo "polyptic: cannot reach the OS image depot. Retrying the pinned image" > "$_console" 2> /dev/null || true
    return 0
  fi

  # 5) Loud where the operator looks (console + report) — never on the glass (POL-140). The splash
  #    keeps showing the ordinary boot narration; to the room this is a standard startup.
  echo "polyptic: $_why" > "$_console" 2> /dev/null || true
  polyptic_pin_report "$_why"

  printf '%s\n' "$_new" > "$_out"
  return 0
}

# ── The hook proper ────────────────────────────────────────────────────────────────────────────────
# /sbin/netroot runs once per interface that comes online, each in its own process, so the cache is a
# FILE: a decision already taken is reused, and a boot that never needed one re-probes (cheap, and
# correct when the second NIC is the one that can actually reach the depot).
case "${netroot:-}" in
  livenet:*)
    polyptic_pin_url_file="${POLYPTIC_PIN_URL_FILE:-/tmp/polyptic-pinned-fallback.url}"
    if [ ! -s "$polyptic_pin_url_file" ]; then
      # Subshell: no `exit`, no shell option, no stray variable of ours can reach /sbin/netroot.
      (polyptic_pin_fallback "${netroot#livenet:}" "$polyptic_pin_url_file") < /dev/null > /dev/null 2>&1
    fi
    if [ -s "$polyptic_pin_url_file" ]; then
      read -r polyptic_pin_url < "$polyptic_pin_url_file"
      [ -n "$polyptic_pin_url" ] && netroot="livenet:$polyptic_pin_url"
      unset polyptic_pin_url
    fi
    unset polyptic_pin_url_file
    ;;
esac
