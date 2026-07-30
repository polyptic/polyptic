#!/bin/sh
# Parse + validate the SITE SECRETS file → normalized SITE_* lines on stdout (POL-190). Pure; the
# source is $1 or POLYPTIC_SITE_CONF.
#
# WHY THIS FILE EXISTS AT ALL: an organisation's endpoint tooling registers itself with a bearer
# credential (an EDR customer id, a scanner linking key, a subscription token). That credential CANNOT
# live in the image: `rootfs.squashfs` is served UNGATED by design (a box has no session before it
# boots, so GRUB's HTTP client cannot authenticate), and anyone who can reach the depot can
# `unsquashfs` it. So the credential rides the BOOT MEDIUM as `polyptic/site.conf` — the same place,
# and the same trust model, as the Wi-Fi credentials in wifi-conf.sh — and is handed to the site's own
# `firstboot.d/` scripts at boot, in RAM, where it never reaches a published artifact.
#
# NEVER SOURCED, NEVER EVAL'D. Values are split on the FIRST '=' and taken verbatim to end of line, so
# a token containing spaces, quotes, '=' or '$' needs no escaping and cannot execute anything. Trailing
# CRs are stripped (a file touched by Notepad arrives CRLF). First occurrence of a key wins (the
# parse-cmdline.sh / wifi-conf.sh convention).
#
# SCHEMA: unlike wifi.conf there is no fixed vocabulary — the key names belong to whatever tooling the
# organisation runs, and we deliberately know nothing about it (no vendor names in core code paths).
# What IS enforced is the shape:
#   SITE_<NAME>=<value>     NAME is [A-Z0-9_]+, value is one line, taken verbatim
# A key without the SITE_ prefix is a HARD ERROR rather than a silent skip. A typo'd credential that
# is quietly ignored means a box that boots, renders, looks perfect and is not enrolled in anything —
# the worst failure this feature can have, because nobody notices until an audit.
#
# Exit contract: absent/comment-only file → NOTHING on stdout, exit 0 (a fleet with no site secrets is
# a fine and common state). A file that sets keys but fails validation → one plain-English line on
# stderr, exit 1, and NO output — a half-valid file must never half-configure a registration.

CONF="${POLYPTIC_SITE_CONF:-${1:-}}"
[ -n "$CONF" ] && [ -r "$CONF" ] || exit 0

fail() { printf 'site-conf: %s\n' "$1" >&2; exit 1; }

CR="$(printf '\r')"
out=""
seen=""

while IFS= read -r line || [ -n "$line" ]; do
  line="${line%"$CR"}"
  case "$line" in ''|'#'*) continue ;; esac
  case "$line" in *=*) ;; *) fail "malformed line (expected SITE_KEY=value): '$line'" ;; esac
  k="${line%%=*}"; v="${line#*=}"

  # Whitespace around the KEY is an editor artefact, not part of the name, and a key can never contain
  # whitespace legitimately, so strip all of it (spaces and tabs, however many). The VALUE is
  # deliberately untouched: a token may legitimately start or end with anything at all.
  k="$(printf '%s' "$k" | tr -d ' \t')"

  case "$k" in
    SITE_*) ;;
    *) fail "key '$k' is missing the SITE_ prefix (site secrets must be named SITE_<NAME>)" ;;
  esac
  # Reject anything that is not a plain shell-safe name. We export these into the environment of the
  # site's own scripts, so a key with a space, a dot or a '-' in it would be unexportable and would
  # silently vanish rather than fail.
  case "$k" in
    *[!ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_]*)
      fail "key '$k' has characters outside A-Z 0-9 _ (rename it)" ;;
  esac
  [ "$k" != "SITE_" ] || fail "key 'SITE_' has no name after the prefix"

  [ -n "$v" ] || continue           # an empty value means "unset", so a template can ship blank keys

  # First occurrence wins, quietly — a file that lists a key twice is an edit in progress, not an error.
  case " $seen " in *" $k "*) continue ;; esac
  seen="$seen $k"
  out="$out$k=$v
"
done < "$CONF"

[ -n "$out" ] || exit 0
printf '%s' "$out"
