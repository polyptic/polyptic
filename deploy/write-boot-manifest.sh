#!/bin/sh
# deploy/write-boot-manifest.sh — write the boot medium's SIDECAR MANIFEST (POL-122).
#
# The FULL universal medium (local payload + Wi-Fi) and the LEAN one (LEAN=1: wired netboot only)
# ship under the SAME filename, from the SAME URL, with no metadata: from outside they are
# indistinguishable. That is how a fresh install could publish a wired-only stick and the console
# could offer it as "Download bootloader" with a straight face while every Wi-Fi screen in the
# building failed to boot from it. So the medium now describes itself: this writes a JSON file
# beside the image (`polyptic-boot.json`) which the server parses and the console tells the truth
# from. It rides to the depot with the image (the helm Job copies deploy/dist/boot/*).
#
# Its own script (rather than a heredoc inside build-boot-medium.sh) so the contract is testable:
# packages/e2e/boot-medium.test.ts EXECUTES this and parses what comes out.
#
# POSIX sh, no exotic tools (POL-78: the initramfs shipped no `dirname` and every Wi-Fi config was
# rejected for months). printf and shell parameter expansion only — no jq, no python, no bun.
#
# USAGE:
#   write-boot-manifest.sh <out.json> <lean:0|1> <mediumId> <builtAt> <tokenBaked:0|1> <bytes> \
#                          [<arch>:<imageId> ...]
# e.g. write-boot-manifest.sh dist/boot/polyptic-boot.json 0 medium-…-ab12 2026-07-14T09:00:00Z 1 \
#        402653184 amd64:20260714T090000Z-1bdb6281 arm64:20260714T090000Z-1bdb6281
set -eu

if [ "$#" -lt 6 ]; then
  echo "write-boot-manifest: usage: $0 <out.json> <lean:0|1> <mediumId> <builtAt> <tokenBaked:0|1> <bytes> [<arch>:<imageId> ...]" >&2
  exit 2
fi

OUT=$1
LEAN=$2
MEDIUM_ID=$3
BUILT_AT=$4
TOKEN_BAKED=$5
BYTES=$6
shift 6

bool() { [ "$1" = "1" ] && printf 'true' || printf 'false'; }
# Everything we emit is our own ASCII (ids, ISO timestamps, arch names) — but a `"` or `\` sneaking
# in from an env-provided value would produce invalid JSON, and the server's parse would then throw
# the medium's whole shape away. Escape both; nothing else can appear.
jstr() {
  s=$1
  s=$(printf '%s' "$s" | sed 's/\\/\\\\/g; s/"/\\"/g')
  printf '"%s"' "$s"
}
# A JSON string, or a bare null when the value is empty.
jstr_or_null() { [ -n "$1" ] && jstr "$1" || printf 'null'; }

ARCHES=""
IMAGE_IDS=""
for pair in "$@"; do
  arch=${pair%%:*}
  iid=${pair#*:}
  [ -n "$arch" ] || continue
  [ -z "$ARCHES" ] || ARCHES="$ARCHES, "
  ARCHES="$ARCHES$(jstr "$arch")"
  [ -z "$IMAGE_IDS" ] || IMAGE_IDS="$IMAGE_IDS, "
  IMAGE_IDS="$IMAGE_IDS$(jstr "$arch"): $(jstr "$iid")"
done

cat > "$OUT" <<EOF
{
  "mediumId": $(jstr_or_null "$MEDIUM_ID"),
  "builtAt": $(jstr_or_null "$BUILT_AT"),
  "lean": $(bool "$LEAN"),
  "arches": [$ARCHES],
  "imageIds": {$IMAGE_IDS},
  "tokenBaked": $(bool "$TOKEN_BAKED"),
  "bytes": ${BYTES:-0}
}
EOF
