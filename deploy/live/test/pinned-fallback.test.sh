#!/usr/bin/env sh
# Pure-shell tests for the initramfs pinned-build fallback (POL-116). Runs ANYWHERE (macOS/Linux/CI),
# no root, no network, no dracut: polyptic-pinned-fallback.sh is a `netroot` hook that dracut SOURCES
# in the shell holding $netroot, so the test sources it the same way and reads $netroot back. Every
# external it touches — curl, plymouth, sleep — is a stub on PATH in the offload.test.sh style, and
# every input path (the cmdline, the DMI uuid, the console) is an env-overridable fixture.
#
# What this pins is the bug the file exists for: a box whose medium pins a build the depot has pruned
# must BOOT (on the active image, loud on the console and off-box but quiet on the splash, POL-140)
# — while a box whose pin is fine must be affected in no way
# at all, and a box whose depot is simply unreachable must keep the old retry-the-pin behaviour rather
# than be told a lie about pruning. Also wrapped by a bun test (packages/e2e/netboot-pinned-fallback.test.ts)
# so it runs in `bun test` / CI.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../usr/lib/dracut/modules.d/50polyptic-live/polyptic-pinned-fallback.sh"
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
fails=0
ok() { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails + 1)); }
eq() { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "contains: $2" "$3" ;; esac; }
hasnt() { case "$3" in *"$2"*) bad "$1" "must NOT contain: $2" "$3" ;; *) ok "$1" ;; esac; }

BIN="$ROOT/bin"
mkdir -p "$BIN"

# ─── The stub environment ───────────────────────────────────────────────────────────────────────────
# $STUB/serve   : one URL per line that the depot really serves (a probe of anything else is a 404)
# $STUB/manifest: the body of manifest.json (absent → the depot 404s it)
# $STUB/down    : present → every request fails like a dead network (curl exit 7), NOT a 404
# $STUB/probes  : every probed URL, in order        $STUB/reports: every POSTed body + headers
# $STUB/plymouth: every splash message raised (must stay empty — POL-140 keeps the glass quiet)

cat > "$BIN/curl" << 'EOF'
#!/bin/sh
post=""; want_code=""; body=""; url=""; hdrs=""; fail_on_http=""
while [ $# -gt 0 ]; do
  case "$1" in
    -X) shift; [ "$1" = POST ] && post=1 ;;
    -w) shift; want_code=1 ;;
    -H) shift; hdrs="$hdrs $1" ;;
    --data-binary|--data) shift; body="$1" ;;
    -o|-r|-m|--max-time|--connect-timeout) shift ;;
    -fsS|-fs) fail_on_http=1 ;;
    -*) : ;;
    *) url="$1" ;;
  esac
  shift
done
if [ -f "$STUB/down" ]; then
  [ -n "$want_code" ] && printf '000'
  exit 7                                  # a dead network: curl itself fails
fi
if [ -n "$post" ]; then
  printf '%s |%s| %s\n' "$url" "$hdrs" "$body" >> "$STUB/reports"
  exit 0
fi
case "$url" in
  */manifest.json)
    if [ -s "$STUB/manifest" ]; then cat "$STUB/manifest"; exit 0; fi
    exit 22 ;;                            # curl -f against a 404
esac
printf '%s\n' "$url" >> "$STUB/probes"
if grep -qxF "$url" "$STUB/serve" 2>/dev/null; then
  [ -n "$want_code" ] && printf '206'     # the depot streams the byte we asked for
  exit 0
fi
[ -n "$want_code" ] && printf '404'
[ -n "$fail_on_http" ] && exit 22
exit 0    # a 404 without -f is still a SUCCESSFUL curl run: the whole fix rests on telling these apart
EOF

cat > "$BIN/plymouth" << 'EOF'
#!/bin/sh
case "${1:-}" in
  --ping) exit 0 ;;
  display-message|hide-message) printf '%s\n' "$*" >> "$STUB/plymouth"; exit 0 ;;
esac
exit 0
EOF

printf '#!/bin/sh\nexit 0\n' > "$BIN/sleep"   # the probe backoff must never make the suite slow
chmod +x "$BIN"/*
PATH="$BIN:$PATH"
export PATH

HOST="http://polyptic-boot.homelab"
PINNED_ID="20260713T140345Z-fe8ca57b"
ACTIVE_ID="20260714T045032Z-5724b929"
PIN_URL="$HOST/dist/image/amd64/builds/$PINNED_ID/rootfs.squashfs"
ACTIVE_URL="$HOST/dist/image/amd64/builds/$ACTIVE_ID/rootfs.squashfs"
ROOT_URL="$HOST/dist/image/amd64/rootfs.squashfs"

# One case: a fresh stub dir, then source the hook exactly as /sbin/netroot does, and echo the
# $netroot it leaves behind. The subshell is the test's, not the hook's — nothing leaks between cases.
setup() {
  STUB="$ROOT/stub"
  rm -rf "$STUB"
  mkdir -p "$STUB"
  : > "$STUB/serve"
  export STUB
  printf 'BOOT_IMAGE=/vmlinuz root=live:%s rd.overlay=1 ip=dhcp polyptic.base=%s polyptic.token=tok-abc quiet splash\n' \
    "$PIN_URL" "$HOST" > "$STUB/cmdline"
  printf '4c4c4544-0037-3010-8043-b4c04f463433\n' > "$STUB/dmi"
}

# `netroot` is the variable dracut's /sbin/netroot holds and then passes to livenetroot as $2.
resolve() { # <netroot value> → the netroot the hook leaves behind
  (
    netroot="$1"
    POLYPTIC_PIN_URL_FILE="$STUB/url" \
      POLYPTIC_CMDLINE_FILE="$STUB/cmdline" \
      POLYPTIC_DMI_UUID_FILE="$STUB/dmi" \
      POLYPTIC_CONSOLE="$STUB/console" \
      POLYPTIC_PIN_ATTEMPTS="${ATTEMPTS:-2}" \
      POLYPTIC_PIN_SLEEP=0
    export POLYPTIC_PIN_URL_FILE POLYPTIC_CMDLINE_FILE POLYPTIC_DMI_UUID_FILE POLYPTIC_CONSOLE \
      POLYPTIC_PIN_ATTEMPTS POLYPTIC_PIN_SLEEP
    # shellcheck disable=SC1090
    . "$HOOK"
    printf '%s\n' "$netroot"
  )
}
serve() { printf '%s\n' "$@" >> "$STUB/serve"; }
manifest() { printf '{"imageId":"%s","sha256":"abc","urgent":false}' "$1" > "$STUB/manifest"; }
probes() { [ -f "$STUB/probes" ] && wc -l < "$STUB/probes" | tr -d ' ' || printf 0; }
file() { cat "$1" 2> /dev/null || printf ''; }

# ─── 1) The happy path: a pin the depot still serves is used, unchanged ─────────────────────────────
# The single most important assertion in this file. A healthy offline boot must be untouched by all of
# the above: same URL, no splash, no report, no fallback.
setup
serve "$PIN_URL" "$ACTIVE_URL" "$ROOT_URL"
manifest "$ACTIVE_ID"
out="$(resolve "livenet:$PIN_URL")"
eq "pinned build present → netroot unchanged" "livenet:$PIN_URL" "$out"
eq "pinned build present → probed once, then handed straight to livenet" "1" "$(probes)"
eq "pinned build present → nothing on the splash" "" "$(file "$STUB/plymouth")"
eq "pinned build present → nothing reported off-box" "" "$(file "$STUB/reports")"

# ─── 2) The bug: a pinned build the depot has pruned → the ACTIVE build from the manifest ───────────
setup
serve "$ACTIVE_URL" "$ROOT_URL" # the pin is gone; everything else is there
manifest "$ACTIVE_ID"
out="$(resolve "livenet:$PIN_URL")"
eq "pruned pin → livenet is re-pointed at the active build" "livenet:$ACTIVE_URL" "$out"
eq "pruned pin → nothing on the splash (POL-140: a standard startup, as far as the room knows)" \
  "" "$(file "$STUB/plymouth")"
has "pruned pin → the console names BOTH build ids" "$PINNED_ID" "$(file "$STUB/console")"
has "pruned pin → the console names the image it booted instead" "$ACTIVE_ID" "$(file "$STUB/console")"
has "pruned pin → reported off-box under the POL-116 code" \
  '"code":"pinned-build-missing"' "$(file "$STUB/reports")"
has "pruned pin → the report goes to POST /boot/report" "/boot/report" "$(file "$STUB/reports")"
has "pruned pin → the report carries the box's stable id" \
  '"machineId":"dmi-4c4c4544-0037-3010-8043-b4c04f463433"' "$(file "$STUB/reports")"
has "pruned pin → the fleet token rides in the header, never the body" \
  "Authorization: Bearer tok-abc" "$(file "$STUB/reports")"
hasnt "pruned pin → the token is never in the reported body" '"token"' "$(file "$STUB/reports")"
eq "pruned pin → the pin is retried (a transient must not read as a prune) before the fallback" \
  "2" "$(printf '%s' "$(grep -c "builds/$PINNED_ID/" "$STUB/probes")")"

# ─── 3) The manifest is unreachable → the unpinned arch root (always the active build) ─────────────
setup
serve "$ROOT_URL" # no manifest fixture → the depot 404s manifest.json
out="$(resolve "livenet:$PIN_URL")"
eq "no manifest → livenet falls back to the unpinned arch root" "livenet:$ROOT_URL" "$out"
eq "no manifest → still nothing on the splash (POL-140)" "" "$(file "$STUB/plymouth")"
has "no manifest → still reported off-box" '"code":"pinned-build-missing"' "$(file "$STUB/reports")"

# ─── 4) The manifest names a build whose mirror is ALSO gone → the arch root ────────────────────────
setup
serve "$ROOT_URL"
manifest "$ACTIVE_ID" # the id is published, but builds/<id>/ 404s (POL-79's heal could not run)
out="$(resolve "livenet:$PIN_URL")"
eq "active build unfetchable → the arch root carries the boot" "livenet:$ROOT_URL" "$out"

# ─── 5) A DEAD NETWORK is not a pruned build ───────────────────────────────────────────────────────
# The one way this fix could make things worse: silently swapping the image on every flaky boot. When
# nothing answers, nothing changes — livenet keeps retrying the pin, exactly as it did before POL-116.
setup
: > "$STUB/down"
out="$(resolve "livenet:$PIN_URL")"
eq "depot unreachable → netroot is left alone (livenet's own retry loop owns it)" \
  "livenet:$PIN_URL" "$out"
eq "depot unreachable → no splash claiming the image was pruned" "" "$(file "$STUB/plymouth")"
eq "depot unreachable → nothing reported (it would be a lie)" "" "$(file "$STUB/reports")"

# ─── 6) The depot answers, but has nothing at all → also unchanged ──────────────────────────────────
setup # empty serve list: pin, active build and arch root all 404
out="$(resolve "livenet:$PIN_URL")"
eq "depot serves no image at all → netroot unchanged, existing failure behaviour" \
  "livenet:$PIN_URL" "$out"
eq "depot serves no image at all → nothing reported" "" "$(file "$STUB/reports")"

# ─── 7) The WIRED path (an unpinned arch root) is not ours to touch — not even probed ───────────────
setup
serve "$ROOT_URL"
out="$(resolve "livenet:$ROOT_URL")"
eq "unpinned arch root → untouched" "livenet:$ROOT_URL" "$out"
eq "unpinned arch root → not even probed (zero cost on the wired path)" "0" "$(probes)"

# ─── 8) A live-ISO / non-livenet root is untouched ──────────────────────────────────────────────────
setup
out="$(resolve "dhcp")"
eq "a non-livenet netroot is passed through verbatim" "dhcp" "$out"
eq "a non-livenet netroot is never probed" "0" "$(probes)"

# ─── 9) Firmware with a placeholder UUID still reports — just without an id ─────────────────────────
setup
serve "$ROOT_URL"
printf '00000000-0000-0000-0000-000000000000\n' > "$STUB/dmi"
out="$(resolve "livenet:$PIN_URL")"
eq "placeholder DMI uuid → still boots the fallback" "livenet:$ROOT_URL" "$out"
has "placeholder DMI uuid → reports with an empty machine id, never a fake one" \
  '"machineId":""' "$(file "$STUB/reports")"

# ─── 10) The decision is cached: a second interface coming online does not re-probe ────────────────
setup
serve "$ACTIVE_URL" "$ROOT_URL"
manifest "$ACTIVE_ID"
out="$(resolve "livenet:$PIN_URL")"
before="$(probes)"
out2="$(resolve "livenet:$PIN_URL")" # /sbin/netroot runs once per interface that comes online
eq "a second netroot run reuses the resolved image" "livenet:$ACTIVE_URL" "$out2"
eq "a second netroot run re-probes nothing" "$before" "$(probes)"
eq "a second netroot run does not re-report" "1" "$(wc -l < "$STUB/reports" | tr -d ' ')"

# ─── 11) A depot behind a path prefix keeps its prefix ─────────────────────────────────────────────
setup
PFX="http://boot.example/polyptic"
serve "$PFX/dist/image/arm64/rootfs.squashfs"
out="$(resolve "livenet:$PFX/dist/image/arm64/builds/$PINNED_ID/rootfs.squashfs")"
eq "a prefixed depot URL is rebuilt with its prefix and arch" \
  "livenet:$PFX/dist/image/arm64/rootfs.squashfs" "$out"

# ─── 12) The hook is SOURCED: it must never be able to kill /sbin/netroot ──────────────────────────
# If it could `exit`, the handler would never run and the box would have no root at all. Reaching this
# line at all proves the sourcing is survivable; the grep proves nobody adds one later.
if grep -q '^[[:space:]]*exit' "$HOOK"; then
  bad "the hook never calls exit" "no exit" "$(grep -n '^[[:space:]]*exit' "$HOOK")"
else
  ok "the hook never calls exit (it is sourced into /sbin/netroot)"
fi
if grep -q '^[[:space:]]*set -[eu]' "$HOOK"; then
  bad "the hook never sets shell options" "no set -e/-u" "$(grep -n '^[[:space:]]*set -[eu]' "$HOOK")"
else
  ok "the hook never sets shell options (dracut's own libs die under set -u)"
fi

printf '\n'
if [ "$fails" -eq 0 ]; then
  printf 'ALL PASS\n'
  exit 0
fi
printf '%d FAILED\n' "$fails"
exit 1
