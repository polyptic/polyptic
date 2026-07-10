#!/usr/bin/env bash
# Regenerate the Polyptic PNG icon set from the source SVGs, pack the favicon.ico, and sync the
# favicon set into the two web apps' Vite public/ dirs.
# Requires librsvg (`brew install librsvg` → provides rsvg-convert) and bun.
# Run from anywhere: ./brand/generate.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/.." && pwd)"
out="$here/png"
mkdir -p "$out"

sizes=(16 32 48 64 128 180 192 256 512 1024)

for size in "${sizes[@]}"; do
  rsvg-convert -w "$size" -h "$size" "$here/icon.svg"      -o "$out/icon-${size}.png"
  rsvg-convert -w "$size" -h "$size" "$here/icon-dark.svg" -o "$out/icon-dark-${size}.png"
done

echo "Wrote ${#sizes[@]} sizes × 2 variants to $out"

# The multi-resolution .ico, packed from the 16/32/48 PNGs just written.
bun "$here/make-ico.ts"

# Sync the served favicon set into each app's public/ dir. These files are COMMITTED: the Docker
# build runs `vite build` with no librsvg, so it must find them already on disk. brand/ stays the
# single source of truth — edit here, re-run this script, commit the result.
#
# The console is a browsable operator app (tab icon, bookmark, pinned to a phone home screen);
# the player is a fullscreen kiosk page that only ever shows a tab icon when a human opens it to
# debug, so it takes the two favicons and skips the apple-touch icon.
console_public="$repo/packages/console/public"
player_public="$repo/packages/player/public"
mkdir -p "$console_public" "$player_public"

for dir in "$console_public" "$player_public"; do
  cp "$here/favicon.svg" "$dir/favicon.svg"
  cp "$here/favicon.ico" "$dir/favicon.ico"
done
cp "$out/icon-180.png" "$console_public/apple-touch-icon.png"

echo "Synced favicons → packages/{console,player}/public"
