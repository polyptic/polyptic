#!/bin/sh
# POL-114 — a TEST DOUBLE for the PDF rasterizer half of the document toolchain.
#
# CI runners (and most dev laptops) ship no document toolchain, and a pipeline whose only test is
# "with no converter we refuse" is a pipeline whose happy path is never exercised. This stands in for
# the real binary at the SAME command-line contract the adapter drives it with (`-v` answers a
# version; the last two arguments are the input PDF and the output prefix; pages are written as
# <prefix>-<n>.png), so the ADAPTER's own code — argument shape, output discovery, natural page sort,
# progress polling — runs for real. It is deliberately dumb: it writes one page image per `/Type /Page`
# it finds in the PDF, copied from the committed photo.png, so the page COUNT comes from the real file.
set -e

if [ "$1" = "-v" ] || [ "$1" = "--version" ]; then
  echo "fake-pdftoppm (polyptic test double) 0.0"
  exit 0
fi

for a in "$@"; do
  prev="$last"
  last="$a"
done
input="$prev"
prefix="$last"

[ -f "$input" ] || exit 1
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

pages=$(grep -a -o "/Type */Page[^s]" "$input" | wc -l | tr -d ' ')
[ "$pages" -gt 0 ] || pages=1

n=1
while [ "$n" -le "$pages" ]; do
  cp "$here/photo.png" "${prefix}-${n}.png"
  n=$((n + 1))
done
