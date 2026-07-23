#!/usr/bin/env sh
# Pure-shell tests for polyptic-scratch-prep.sh (POL-179) — the initramfs hook that guarantees
# dmsquash-live finds `overlayfs/` + `ovlwork/` on the scratch partition of an installed box. Runs
# ANYWHERE (macOS/Linux/CI), no root: mount/umount/mkfs.ext4/udevadm are stubs on PATH reading
# their behaviour out of $STUB (the install.test.sh pattern), and every path the hook reads is an
# env-overridable fixture.
#
# What this pins:
#   - the hook fires ONLY on polyptic.bootpath=disk boots, only once the device exists, and only
#     ONCE per boot (the marker) — a sourced settled hook re-runs every settle pass;
#   - a mountable scratch gets the two dirs and a clean unmount, and is NEVER mkfs'd;
#   - an unmountable scratch is mkfs'd back to life (self-healing corruption), then seeded;
#   - a scratch beyond both mount and mkfs is given up on for THIS boot (marker still written —
#     retrying every settle pass would just re-run mkfs against the same brokenness);
#   - the hook is source-safe: no exit, so the caller's shell survives (the polyptic-ram.sh law).
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
HOOK="$HERE/../usr/lib/dracut/modules.d/50polyptic-live/polyptic-scratch-prep.sh"
ROOT="$(mktemp -d)"; trap 'rm -rf "$ROOT"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }
has() { case "$3" in *"$2"*) ok "$1" ;; *) bad "$1" "contains: $2" "$3" ;; esac; }

# ─── Stubs ──────────────────────────────────────────────────────────────────────────────────────────
BIN="$ROOT/bin"; mkdir -p "$BIN"

# mount: log; `mount -t ext4 <dev> <dir>` symlinks <dir> to $STUB/vol (the scratch fs), so the
# hook's mkdirs land in the fixture. Knobs: mount_fails (every mount refused), mount_fails_once
# (refuse until mkfs has run — the corrupt-then-healed fs).
cat > "$BIN/mount" <<'EOF'
#!/bin/sh
printf 'CMD %s\n' "$*" >> "$STUB/mount.log"
dev=""; dir=""
while [ $# -gt 0 ]; do
  case "$1" in
    -t) shift ;;
    -*) ;;
    *) if [ -z "$dev" ]; then dev="$1"; else dir="$1"; fi ;;
  esac
  shift
done
[ -f "$STUB/mount_fails" ] && exit 32
if [ -f "$STUB/mount_fails_once" ] && [ ! -f "$STUB/mkfs.log" ]; then exit 32; fi
rmdir "$dir" 2>/dev/null || true
ln -s "$STUB/vol" "$dir"
exit 0
EOF
cat > "$BIN/umount" <<'EOF'
#!/bin/sh
printf 'CMD %s\n' "$*" >> "$STUB/umount.log"
rm -f "$1" 2>/dev/null; mkdir -p "$1" 2>/dev/null; exit 0
EOF
cat > "$BIN/mkfs.ext4" <<'EOF'
#!/bin/sh
printf 'CMD %s\n' "$*" >> "$STUB/mkfs.log"
[ -f "$STUB/mkfs_fails" ] && exit 1
mkdir -p "$STUB/vol"
exit 0
EOF
printf '#!/bin/sh\nprintf "CMD %%s\\n" "$*" >> "$STUB/udevadm.log"\nexit 0\n' > "$BIN/udevadm"
# blkid: `-s UUID -o value <dev>` → the live slot's UUID (knob: blkid_fails → nothing resolves).
cat > "$BIN/blkid" <<'EOF'
#!/bin/sh
[ -f "$STUB/blkid_fails" ] && exit 2
printf 'aaaa-bbbb\n'
exit 0
EOF
chmod +x "$BIN"/*

# ─── Fixture + runner ───────────────────────────────────────────────────────────────────────────────
# new_case <name> [cmdline] → a disk-boot cmdline and a scratch device whose fs fixture exists (the
# healthy installed box). The hook is SOURCED (as dracut-initqueue does) inside a subshell that
# proves source-safety by printing a sentinel after the dot.
new_case() {
  d="$ROOT/$1"; mkdir -p "$d"
  printf '%s\n' "${2:-BOOT_IMAGE=/vmlinuz root=live:LABEL=POLYPTIC-A rd.live.overlay=LABEL=POLYPTIC-SCRATCH:/overlayfs rd.live.overlay.overlayfs=1 rd.live.overlay.reset=1 polyptic.bootpath=disk quiet splash}" > "$d/cmdline"
  : > "$d/scratch-dev"
  mkdir -p "$d/vol"
  printf '%s' "$d"
}
prep() {
  d="$1"
  STUB="$d" PATH="$BIN:$PATH" \
  POLYPTIC_CMDLINE_FILE="$d/cmdline" POLYPTIC_SCRATCH_DEV="$d/scratch-dev" \
  POLYPTIC_SCRATCH_MNT="$d/mnt" POLYPTIC_SCRATCH_DONE="$d/done" \
  POLYPTIC_BYLABEL_DIR="$d/by-label" \
    sh -c ". '$HOOK'; printf 'SURVIVED\n'" 2>&1
}
mounted() { grep -c "^CMD" "$1/mount.log" 2>/dev/null || echo 0; }

# ─── 1) Healthy installed box: mount, seed, unmount — no mkfs, marker written ───────────────────────
d="$(new_case healthy)"; out="$(prep "$d")"
eq  "healthy: pinned pathspec → no legacy LiveOS layout seeded" "no" "$([ -d "$d/vol/LiveOS" ] && echo yes || echo no)"
has "healthy: hook is source-safe (no exit)"    "SURVIVED" "$out"
eq  "healthy: scratch mounted"                  "1" "$(mounted "$d")"
eq  "healthy: overlayfs/ created"               "yes" "$([ -d "$d/vol/overlayfs" ] && echo yes || echo no)"
eq  "healthy: ovlwork/ created"                 "yes" "$([ -d "$d/vol/ovlwork" ] && echo yes || echo no)"
eq  "healthy: unmounted after seeding"          "yes" "$([ -s "$d/umount.log" ] && echo yes || echo no)"
eq  "healthy: never mkfs'd"                     "no" "$([ -f "$d/mkfs.log" ] && echo yes || echo no)"
eq  "healthy: one-shot marker written"          "yes" "$([ -f "$d/done" ] && echo yes || echo no)"

# Second settle pass: the marker short-circuits everything.
out="$(prep "$d")"
eq  "healthy: second pass does nothing (marker)" "1" "$(mounted "$d")"

# ─── 2) Not a disk boot: the hook never touches anything ────────────────────────────────────────────
d="$(new_case netboot "BOOT_IMAGE=/vmlinuz root=live:http://10.0.0.10/dist/image/amd64/rootfs.squashfs rd.overlay=1 ip=dhcp rd.neednet=1 quiet splash")"
out="$(prep "$d")"
has "netboot: source-safe"                      "SURVIVED" "$out"
eq  "netboot: no mount attempted"               "0" "$(mounted "$d")"
eq  "netboot: no marker"                        "no" "$([ -f "$d/done" ] && echo yes || echo no)"

# ─── 3) Device not there yet: return quietly, NO marker — the next settle pass retries ──────────────
d="$(new_case early)"; rm -f "$d/scratch-dev"
out="$(prep "$d")"
eq  "early: no mount attempted"                 "0" "$(mounted "$d")"
eq  "early: no marker (retries next pass)"      "no" "$([ -f "$d/done" ] && echo yes || echo no)"
# The device appears on a later pass → the hook completes normally.
: > "$d/scratch-dev"; out="$(prep "$d")"
eq  "early: later pass seeds the pair"          "yes" "$([ -d "$d/vol/overlayfs" ] && [ -d "$d/vol/ovlwork" ] && echo yes || echo no)"

# ─── 4) Corrupt scratch: mount fails → mkfs -F heals it, settle, remount, seed ──────────────────────
d="$(new_case corrupt)"; rm -rf "$d/vol"; : > "$d/mount_fails_once"
out="$(prep "$d")"
has "corrupt: mkfs'd back to life"              "-F -L POLYPTIC-SCRATCH" "$(cat "$d/mkfs.log" 2>/dev/null)"
has "corrupt: udev settled after mkfs (the LABEL= devspec must resolve for dmsquash)" "settle" "$(cat "$d/udevadm.log" 2>/dev/null)"
eq  "corrupt: pair seeded on the healed fs"     "yes" "$([ -d "$d/vol/overlayfs" ] && [ -d "$d/vol/ovlwork" ] && echo yes || echo no)"
eq  "corrupt: marker written"                   "yes" "$([ -f "$d/done" ] && echo yes || echo no)"

# ─── 5) Legacy cmdline (pre-POL-179 ESP config, no `:` pathspec): ALSO seed dmsquash-live's default
#        pathspec for the booted slot, or the fielded box keeps warning until its SECOND update ─────
d="$(new_case legacy "BOOT_IMAGE=/vmlinuz root=live:LABEL=POLYPTIC-B rd.live.overlay=LABEL=POLYPTIC-SCRATCH rd.live.overlay.overlayfs=1 rd.live.overlay.reset=1 polyptic.bootpath=disk quiet splash")"
out="$(prep "$d")"
eq  "legacy: pinned layout still seeded"        "yes" "$([ -d "$d/vol/overlayfs" ] && [ -d "$d/vol/ovlwork" ] && echo yes || echo no)"
eq  "legacy: default pathspec seeded for the booted slot" "yes" "$([ -d "$d/vol/LiveOS/overlay-POLYPTIC-B-aaaa-bbbb" ] && echo yes || echo no)"
eq  "legacy: LiveOS/ovlwork beside it"          "yes" "$([ -d "$d/vol/LiveOS/ovlwork" ] && echo yes || echo no)"

# The live device's UUID unresolvable (blkid fails): the legacy seeding is skipped quietly, the
# pinned layout still lands, the hook still completes.
d="$(new_case legacy-no-uuid "BOOT_IMAGE=/vmlinuz root=live:LABEL=POLYPTIC-A rd.live.overlay=LABEL=POLYPTIC-SCRATCH rd.live.overlay.overlayfs=1 polyptic.bootpath=disk quiet")"
: > "$d/blkid_fails"; out="$(prep "$d")"
has "legacy no-uuid: source-safe"               "SURVIVED" "$out"
eq  "legacy no-uuid: pinned layout seeded"      "yes" "$([ -d "$d/vol/overlayfs" ] && echo yes || echo no)"
eq  "legacy no-uuid: no half-named LiveOS dir"  "no" "$([ -d "$d/vol/LiveOS" ] && echo yes || echo no)"
eq  "legacy no-uuid: marker written"            "yes" "$([ -f "$d/done" ] && echo yes || echo no)"

# ─── 6) Beyond healing: both mounts fail → give up for THIS boot, marker still written ──────────────
d="$(new_case hopeless)"; : > "$d/mount_fails"
out="$(prep "$d")"
has "hopeless: source-safe"                     "SURVIVED" "$out"
eq  "hopeless: mkfs was attempted"              "yes" "$([ -f "$d/mkfs.log" ] && echo yes || echo no)"
eq  "hopeless: marker written anyway (no mkfs loop every settle pass)" "yes" "$([ -f "$d/done" ] && echo yes || echo no)"
eq  "hopeless: no dirs claimed"                 "no" "$([ -d "$d/vol/overlayfs" ] && echo yes || echo no)"

printf '\n'
if [ "$fails" -eq 0 ]; then printf 'ALL PASS\n'; exit 0; fi
printf '%d FAILED\n' "$fails"; exit 1
