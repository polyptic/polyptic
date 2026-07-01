#!/usr/bin/env bash
# Regenerate the Polyptic PNG icon set from the source SVGs.
# Requires librsvg (`brew install librsvg` → provides rsvg-convert).
# Run from anywhere: ./brand/generate.sh
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out="$here/png"
mkdir -p "$out"

sizes=(16 32 48 64 128 180 192 256 512 1024)

for size in "${sizes[@]}"; do
  rsvg-convert -w "$size" -h "$size" "$here/icon.svg"      -o "$out/icon-${size}.png"
  rsvg-convert -w "$size" -h "$size" "$here/icon-dark.svg" -o "$out/icon-dark-${size}.png"
done

echo "Wrote ${#sizes[@]} sizes × 2 variants to $out"
