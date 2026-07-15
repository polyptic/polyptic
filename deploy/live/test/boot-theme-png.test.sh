#!/usr/bin/env sh
# Pure-shell tests for grub-png-check.sh, the POL-130 "file exists is not file loads" gate. Runs
# ANYWHERE (macOS/Linux/CI), no root, no network: the checker is POSIX sh + dd + od by design (the
# POL-78 lesson — the environments it ships to have nothing else), so the tests need nothing else
# either. Wrapped by packages/e2e/netboot-theme-png.test.ts so it runs in `bun test` / CI.
#
# What this pins is the bug POL-130 exists for: a theme bitmap that passes every `[ -f ]` guard and
# that GRUB still cannot LOAD leaves "error: null src bitmap in grub_video_bitmap_create_scaled ...
# Press any key to continue" on a wall with no keyboard. The checker is what keeps such a file out
# of every medium — at bake time (build-boot-medium.sh fails the BUILD on it) and at heal time
# (update-poll.sh refuses to commit it). The constraints mirror grub 2.12's own
# grub-core/video/readers/png.c, read from the pinned source, not from documentation.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
CHECK="$HERE/../usr/local/lib/polyptic/grub-png-check.sh"
ASSETS="$HERE/../../../packages/server/assets"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
fails=0
ok() { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
passes() { sh "$CHECK" "$2" >/dev/null 2>&1 && ok "$1" || bad "$1" "exit 0 (decodable)" "exit $?"; }
rejects() { sh "$CHECK" "$2" >/dev/null 2>&1 && bad "$1" "exit 1 (rejected)" "exit 0" || ok "$1"; }

# png <out> [depth] [ctype] [interlace] [wlow]: a minimal PNG header — signature + IHDR — which is
# exactly what the checker inspects. Defaults are the profile GRUB 2.12 decodes: 8x8, 8-bit
# truecolour (2), non-interlaced.
png() {
  out="$1"; depth="${2:-8}"; ctype="${3:-2}"; inter="${4:-0}"; wlow="${5:-8}"
  printf '\211PNG\r\n\032\n\000\000\000\015IHDR' > "$out"
  # width / height, big-endian dwords (only the low byte varies here)
  printf '\000\000\000' >> "$out"; printf "\\$(printf '%03o' "$wlow")" >> "$out"
  printf '\000\000\000\010' >> "$out"
  printf "\\$(printf '%03o' "$depth")" >> "$out"
  printf "\\$(printf '%03o' "$ctype")" >> "$out"
  printf '\000\000' >> "$out"   # compression, filter — always 0 in a real PNG
  printf "\\$(printf '%03o' "$inter")" >> "$out"
  printf 'CRC4' >> "$out"       # the checker reads the header, not the checksums
}

# ─── The REAL shipped assets pass — the bake must never reject what we actually commit ──────────────
passes "the committed boot logo is decodable"            "$ASSETS/boot-logo.png"
passes "the committed desktop background is decodable"   "$ASSETS/boot-bg.png"

# ─── The profile GRUB 2.12 accepts ──────────────────────────────────────────────────────────────────
png "$ROOT/rgb8.png";        passes "8-bit truecolour, non-interlaced"        "$ROOT/rgb8.png"
png "$ROOT/rgba8.png" 8 6;   passes "8-bit truecolour+alpha"                  "$ROOT/rgba8.png"
png "$ROOT/rgb16.png" 16 2;  passes "16-bit truecolour (grub reads 8 and 16)" "$ROOT/rgb16.png"

# ─── What GRUB 2.12 rejects — and therefore what must never reach a medium ─────────────────────────
# Interlaced: png.c is explicit — "png: interlace method not supported". THE POL-130 acceptance case.
png "$ROOT/adam7.png" 8 2 1; rejects "an INTERLACED (Adam7) image is rejected" "$ROOT/adam7.png"
# Greyscale (0/4): grub 2.12 errors "png: color type not supported" on both.
png "$ROOT/gray.png"  8 0;   rejects "greyscale is rejected"                   "$ROOT/gray.png"
png "$ROOT/graya.png" 8 4;   rejects "greyscale+alpha is rejected"             "$ROOT/graya.png"
# Palette decodes in grub but needs a PLTE chunk the checker does not verify — rejected as a class.
png "$ROOT/pal.png"   8 3;   rejects "palette is rejected"                     "$ROOT/pal.png"
# Bit depths grub does not read for truecolour.
png "$ROOT/bd4.png"   4 2;   rejects "4-bit truecolour is rejected"            "$ROOT/bd4.png"
png "$ROOT/bd1.png"   1 2;   rejects "1-bit is rejected"                       "$ROOT/bd1.png"
# Degenerate dimensions: grub errors "png: invalid image size".
png "$ROOT/w0.png" 8 2 0 0;  rejects "a zero-width image is rejected"          "$ROOT/w0.png"

# ─── Not-a-PNG-at-all: torn writes, truncations, the wrong file entirely ───────────────────────────
: > "$ROOT/empty.png";                          rejects "an empty file is rejected"     "$ROOT/empty.png"
printf 'GIF89a...' > "$ROOT/gif.png";           rejects "a mislabelled GIF is rejected" "$ROOT/gif.png"
dd if="$ASSETS/boot-bg.png" of="$ROOT/trunc.png" bs=1 count=20 2>/dev/null
rejects "a truncated PNG (torn FAT write) is rejected" "$ROOT/trunc.png"
rejects "a missing file is rejected"            "$ROOT/does-not-exist.png"

[ "$fails" = 0 ] && { echo "ALL PASS"; exit 0; } || { echo "$fails FAILED"; exit 1; }
