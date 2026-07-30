#!/bin/sh
# Run the SITE LAYER's boot-time hooks, with this box's site secrets in hand (POL-190).
#
# THE SPLIT THIS IMPLEMENTS. An organisation's endpoint tooling is INSTALLED at image build time
# (deploy/build-live-image.sh's site step) and REGISTERED here, on the box. That split is not a
# convenience, it is forced: every one of these tools writes its bearer credential to disk when it
# registers, and the image is a single file served ungated from the depot, so a registration performed
# at build time would publish the credential to anyone who can reach the control plane. Install is
# public and shareable; registration is per-box and secret.
#
# "FIRSTBOOT" MEANS EVERY BOOT, deliberately. A Polyptic box boots a fresh read-only image and throws
# the writable layer away at power-off — netboot boxes overlay in RAM, and installed boxes carry
# `rd.live.overlay.reset=1` (render-disk-grub.sh) — so nothing a registration writes survives. Every
# boot IS a first boot. That is also why the build's `seal.sh` hook exists: an agent baked in
# already-registered would make the whole fleet report as one host.
#
# NOTHING HERE MAY BLACK THE WALL (D65). A site hook that fails, hangs or is misconfigured must cost
# nothing but a journal line: this unit is ordered alongside the session, never before it, every hook
# is time-boxed, and this script ALWAYS exits 0. A compliance agent that did not enrol is a problem for
# an operator to read in Console ▸ Logs, not a technical message on a public screen.
#
# Secrets reach the hooks two ways, both in RAM only:
#   - the environment of each hook (SITE_* names, exactly as written in site.conf)
#   - one file per secret under $POLYPTIC_SITE_SECRETS_DIR, 0600, for tooling that wants a file
#     (also the safer shape: a value passed as a file path does not show up in `ps`)
#
# Stubbable for the off-box tests: find-boot-medium.sh + site-conf.sh come from POLYPTIC_LIB_DIR, the
# hook directory from POLYPTIC_SITE_HOOK_DIR, the secrets file from POLYPTIC_SITE_CONF (which skips the
# medium hunt entirely), and the run directory from POLYPTIC_SITE_RUN_DIR.

LIB="${POLYPTIC_LIB_DIR:-/usr/local/lib/polyptic}"
HOOK_DIR="${POLYPTIC_SITE_HOOK_DIR:-/etc/polyptic/site/firstboot.d}"
RUN_DIR="${POLYPTIC_SITE_RUN_DIR:-/run/polyptic}"
SECRETS_DIR="$RUN_DIR/site-secrets"
MNT="$RUN_DIR/site-medium"
HOOK_TIMEOUT="${POLYPTIC_SITE_HOOK_TIMEOUT:-120}"

log()  { printf 'site-firstboot: %s\n' "$1"; }
warn() { printf 'site-firstboot: %s\n' "$1" >&2; }

# No hooks, nothing to do. The overwhelmingly common case (no site layer configured at all) must be a
# silent no-op, not a warning an operator learns to ignore.
[ -d "$HOOK_DIR" ] || exit 0
hooks="$(find "$HOOK_DIR" -maxdepth 1 -type f -perm -u+x 2>/dev/null | sort)"
[ -n "$hooks" ] || exit 0

# One run per boot. systemd already guarantees that for a oneshot unit, but this script is also the
# thing an operator re-runs by hand from the console while debugging an enrolment, and a second run
# mid-boot would re-register a box that had just registered.
mkdir -p "$RUN_DIR" 2>/dev/null || true
if [ -e "$RUN_DIR/site-firstboot.done" ] && [ "${POLYPTIC_SITE_FORCE:-0}" != "1" ]; then
  log "already ran this boot (POLYPTIC_SITE_FORCE=1 overrides)"
  exit 0
fi

# ─── site secrets ────────────────────────────────────────────────────────────────────────────────────
# The file lives on the boot medium as `polyptic/site.conf`, alongside wifi.conf and identified the
# same way (by the medium's own marker content, never by label alone). An installed box's medium is its
# ESP, so one mechanism covers netboot and installed boxes with no second code path.
conf=""
mounted=""
if [ -n "${POLYPTIC_SITE_CONF:-}" ]; then
  conf="$POLYPTIC_SITE_CONF"                      # tests, and an operator staging a file by hand
elif [ -x "$LIB/find-boot-medium.sh" ]; then
  if dev="$(sh "$LIB/find-boot-medium.sh" "$MNT" ro 2>/dev/null)" && [ -n "$dev" ]; then
    mounted="$MNT"
    [ -r "$MNT/polyptic/site.conf" ] && conf="$MNT/polyptic/site.conf"
  fi
fi

unmount() { [ -n "$mounted" ] && umount "$mounted" 2>/dev/null; mounted=""; }

rm -rf "$SECRETS_DIR" 2>/dev/null
mkdir -p "$SECRETS_DIR" 2>/dev/null || { warn "cannot create $SECRETS_DIR, running hooks with no secrets"; }
chmod 0700 "$SECRETS_DIR" 2>/dev/null || true

secret_env=""
if [ -n "$conf" ]; then
  if parsed="$(POLYPTIC_SITE_CONF="$conf" sh "$LIB/site-conf.sh" 2>"$RUN_DIR/site-conf.err")"; then
    # Copy the file OFF the medium before unmounting, one file per key. Values are written with printf
    # '%s' so no trailing newline is invented — a token with a stray \n appended fails to authenticate
    # and the error the vendor returns never says why.
    n=0
    while IFS= read -r kv; do
      [ -n "$kv" ] || continue
      k="${kv%%=*}"; v="${kv#*=}"
      if [ -d "$SECRETS_DIR" ]; then
        ( umask 0077; printf '%s' "$v" > "$SECRETS_DIR/$k" ) 2>/dev/null || warn "could not stage $k"
      fi
      secret_env="$secret_env $k"
      n=$((n+1))
    done <<EOF
$parsed
EOF
    log "$n site secret(s) staged in $SECRETS_DIR"
  else
    # A malformed secrets file is the one thing worth being loud about: the hooks will run and quietly
    # fail to enrol, and the reason is sitting in one line on the medium.
    warn "site.conf is invalid, running hooks with NO secrets: $(cat "$RUN_DIR/site-conf.err" 2>/dev/null)"
  fi
else
  log "no site.conf on the boot medium, running hooks with no secrets"
fi
unmount

# ─── run the hooks ───────────────────────────────────────────────────────────────────────────────────
# Filename order, one at a time, each time-boxed. `timeout` is in coreutils and is in the image; if it
# somehow is not, run the hook bare rather than skipping it (an un-timed registration beats none).
runner="sh -c"
if command -v timeout >/dev/null 2>&1; then runner="timeout $HOOK_TIMEOUT"; else runner=""; fi

# Build the export list once. These are already validated as [A-Z0-9_]+ names by site-conf.sh, so the
# eval cannot expand into anything but an assignment.
stage_env() {
  for k in $secret_env; do
    v="$(cat "$SECRETS_DIR/$k" 2>/dev/null)"
    export "$k=$v"
  done
  export POLYPTIC_SITE_SECRETS_DIR="$SECRETS_DIR"
  # Hand the hooks this box's STABLE identity (DMI product UUID, or a hashed NIC MAC) as well. A site
  # whose tooling can deduplicate on a stable name uses it to avoid a fresh host record per boot, which
  # is the single most useful thing we can give an organisation's asset inventory.
  [ -r "$RUN_DIR/agent.env" ] && . "$RUN_DIR/agent.env" 2>/dev/null || true
}
stage_env

failed=0
ran=0
for hook in $hooks; do
  name="$(basename "$hook")"
  log "running $name"
  if [ -n "$runner" ]; then
    $runner "$hook" </dev/null && rc=0 || rc=$?
  else
    "$hook" </dev/null && rc=0 || rc=$?
  fi
  ran=$((ran+1))
  if [ "$rc" -eq 0 ]; then
    log "$name ok"
  elif [ "$rc" -eq 124 ]; then
    warn "$name TIMED OUT after ${HOOK_TIMEOUT}s (left running nothing; the box keeps rendering)"
    failed=$((failed+1))
  else
    warn "$name FAILED (exit $rc); the box keeps rendering, but this site hook did not complete"
    failed=$((failed+1))
  fi
done

: > "$RUN_DIR/site-firstboot.done" 2>/dev/null || true
if [ "$failed" -gt 0 ]; then
  warn "$failed of $ran site hook(s) did not complete"
else
  log "$ran site hook(s) completed"
fi

# ALWAYS 0. A non-zero exit here would mark the unit failed, and a failed unit on a box whose only
# output device is a public wall buys nothing an operator cannot already read in the journal.
exit 0
