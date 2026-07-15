#!/bin/sh
# Can GRUB 2.12's own PNG reader decode this file? (POL-130)
#
#   sh grub-png-check.sh <file.png>     → exit 0 = decodable, exit 1 = GRUB would hand its theme a
#                                         NULL bitmap (or the file is missing/empty/not a PNG)
#
# "File exists" is not "file loads": a logo/background GRUB cannot decode passes every `[ -f ]`
# guard and still paints "error: null src bitmap in grub_video_bitmap_create_scaled ... Press any
# key to continue" on a wall with no keyboard. So every writer of theme bitmaps — the medium bake
# (build-boot-medium.sh) and the on-box self-heal (update-poll.sh) — runs this BEFORE committing a
# PNG anywhere a wall will read it. Rejecting at build/heal time is cheap; rejecting on the glass
# is the POL-87/POL-130 failure class.
#
# The constraints are read out of the pinned decoder (grub 2.12, grub-core/video/readers/png.c —
# the source of the signed grubnet loaders we ship, D47), not out of documentation:
#   - bit depth 8 or 16 (4 only for palette, which our pipeline never emits — rejected here);
#   - colour type 2 (truecolour) or 6 (truecolour+alpha). Palette (3) decodes in GRUB but needs a
#     PLTE chunk this check does not verify, and greyscale (0/4) is REJECTED by grub 2.12 outright;
#   - interlace 0 — Adam7 is "png: interlace method not supported";
#   - nonzero dimensions.
#
# Pure POSIX sh + dd + od, nothing else (POL-78's lesson: the environments this runs in ship no
# exotic tools — no python, no file(1), not even dirname in the worst of them). Runs as a SCRIPT,
# never sourced, so callers need no path gymnastics beyond knowing where it lives.
set -u

f="${1:?usage: grub-png-check.sh <file.png>}"

[ -s "$f" ] || exit 1

# One byte at offset $1, as a decimal string ("" past EOF).
byte_at() {
  dd if="$f" bs=1 skip="$1" count=1 2>/dev/null | od -An -tu1 | tr -d ' \n'
}

# The 8-byte PNG signature, hex-flattened.
sig="$(dd if="$f" bs=1 count=8 2>/dev/null | od -An -tx1 | tr -d ' \n')"
[ "$sig" = "89504e470d0a1a0a" ] || exit 1

# IHDR is mandatory and mandatory-FIRST per the PNG spec (GRUB also assumes it), so the layout is
# fixed: width @16..19, height @20..23, bit depth @24, colour type @25, interlace @28.
depth="$(byte_at 24)"
ctype="$(byte_at 25)"
inter="$(byte_at 28)"

case "$depth" in 8|16) : ;; *) exit 1 ;; esac
case "$ctype" in 2|6) : ;; *) exit 1 ;; esac
[ "$inter" = "0" ] || exit 1

# Dimensions must be nonzero — GRUB errors "png: invalid image size" on 0, which lands on the wall
# as a failed theme. Checking the low bytes of each big-endian dword is enough to catch the real
# case (an all-zero header from a torn write); a >16M-pixel-wide image is not a thing our pipeline
# can produce.
w3="$(byte_at 19)"; w2="$(byte_at 18)"; w1="$(byte_at 17)"; w0="$(byte_at 16)"
h3="$(byte_at 23)"; h2="$(byte_at 22)"; h1="$(byte_at 21)"; h0="$(byte_at 20)"
[ "$w0$w1$w2$w3" != "0000" ] || exit 1
[ "$h0$h1$h2$h3" != "0000" ] || exit 1

exit 0
