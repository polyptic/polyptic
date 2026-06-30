#!/bin/sh
# deploy/install.sh — Polyptic zero-touch, AIR-GAPPED edge provisioner.
#
# This script is SERVED BY THE CONTROL PLANE at `GET /install`. The control-plane base URL is
# BAKED IN by the server from the incoming request's Host header (it substitutes the literal
# placeholder {{POLYPTIC_BASE}} below), so the box installs using the very URL it curled:
#
#     curl -sfL http://HOST:8080/install | POLYPTIC_TOKEN=xyz sh -
#     curl -sfL http://HOST:8080/install | POLYPTIC_TOKEN=xyz sh -s -- --kiosk
#
# THE AIR-GAP MODEL: the edge box reaches ONLY the server. The server is the depot. Everything
# this script needs — the agent binary and (with --kiosk) the visual substrate .debs — is pulled
# from the server, never from the internet. The substrate path is OFFLINE-FIRST: it tries the
# server's bundle, and only if there is no bundle for this distro+arch AND the box happens to have
# internet does it fall back to the distro package manager online.
#
# STAGE A (always): download the agent binary, write /etc/polyptic/agent.toml + a systemd SYSTEM
#   unit (Restart=always), enable+start it → the box ENROLS now. Fully air-gapped (server only).
# STAGE B (--kiosk): provision the greetd→sway→Chromium substrate. Offline-first from the server's
#   bundled .debs, else online apt/dnf/pacman, else a clear failure. Then hand off to
#   `polyptic-agent setup --skip-deps …` for the kiosk wiring, and retire the Stage-A system unit
#   in favour of the session-scoped user agent that setup installs.
#
# POSIX sh. `set -eu`. Idempotent. Every step logged. Clear errors.

set -eu

# ─────────────────────────────────────────────────────────────────────────────
# Configuration (substituted by the server / overridable by env + flags)
# ─────────────────────────────────────────────────────────────────────────────

# The control-plane base URL. The server replaces {{POLYPTIC_BASE}} on GET /install with the URL
# the box curled (scheme + host[:port], from the Host header). POLYPTIC_BASE overrides it — handy
# when piping a saved copy of this script by hand.
POLYPTIC_BASE_DEFAULT='{{POLYPTIC_BASE}}'
BASE="${POLYPTIC_BASE:-$POLYPTIC_BASE_DEFAULT}"

# One-time enrolment bootstrap token for the server's GATED mode (Phase 2b). Empty = OPEN mode.
TOKEN="${POLYPTIC_TOKEN:-}"

# --kiosk / POLYPTIC_KIOSK=1 → also provision the visual substrate (Stage B).
KIOSK="${POLYPTIC_KIOSK:-0}"

# Install locations.
BIN_PATH="/usr/local/bin/polyptic-agent"
ETC_DIR="/etc/polyptic"
CONFIG_PATH="${ETC_DIR}/agent.toml"
UNIT_PATH="/etc/systemd/system/polyptic-agent.service"
STATE_DIR="/var/lib/polyptic"

# Repeatable --output CONNECTOR[=WxH][@X,Y] pins, forwarded verbatim to `polyptic-agent setup`.
OUTPUT_ARGS=""

# ─────────────────────────────────────────────────────────────────────────────
# Logging + helpers
# ─────────────────────────────────────────────────────────────────────────────

log()  { printf '\033[1;36m[polyptic]\033[0m %s\n' "$*" >&2; }
step() { printf '\033[1;35m[polyptic] ==>\033[0m %s\n' "$*" >&2; }
warn() { printf '\033[1;33m[polyptic] WARN:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[polyptic] ERROR:\033[0m %s\n' "$*" >&2; exit 1; }

# Privilege: run privileged commands through sudo when not already root (k3s-style). This lets the
# whole thing run as `curl … | sh` from a sudo-capable user, or directly as root.
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "must run as root (or install sudo). Try: curl -sfL ${BASE}/install | sudo POLYPTIC_TOKEN=… sh -"
  fi
fi

# Downloader: prefer curl, fall back to wget.
DL=""
if command -v curl >/dev/null 2>&1; then
  DL="curl"
elif command -v wget >/dev/null 2>&1; then
  DL="wget"
else
  die "need curl or wget to talk to the control plane"
fi

# Scratch dir for downloads; cleaned on exit.
WORK="$(mktemp -d "${TMPDIR:-/tmp}/polyptic-install.XXXXXX")"
cleanup() { rm -rf "$WORK" 2>/dev/null || true; }
trap cleanup EXIT INT TERM

# http_fetch URL OUTFILE → prints the HTTP status code (or 000 on transport failure).
# On a non-2xx status the (error-body) OUTFILE is removed so callers never act on garbage.
http_fetch() {
  _url="$1"; _out="$2"; _code="000"
  if [ "$DL" = "curl" ]; then
    _code="$(curl -fsSL --connect-timeout 10 -o "$_out" -w '%{http_code}' "$_url" 2>/dev/null)" || _code="${_code:-000}"
    [ -n "$_code" ] || _code="000"
  else
    if wget -q -O "$_out" "$_url" 2>/dev/null; then _code="200"; else _code="404"; fi
  fi
  case "$_code" in
    2??) : ;;
    *) rm -f "$_out" 2>/dev/null || true ;;
  esac
  printf '%s' "$_code"
}

# Does this box have general internet (beyond the server)? Best-effort, short timeout.
has_internet() {
  [ "$DL" = "curl" ] || return 1
  curl -fsS --max-time 5 -o /dev/null "https://deb.debian.org/" 2>/dev/null && return 0
  curl -fsS --max-time 5 -o /dev/null "https://www.google.com/" 2>/dev/null && return 0
  return 1
}

# Write FILE (privileged) from stdin with the given mode.
write_file() {
  _dest="$1"; _mode="$2"
  _tmp="${WORK}/$(basename "$_dest").stage"
  cat > "$_tmp"
  $SUDO install -D -m "$_mode" "$_tmp" "$_dest"
  rm -f "$_tmp" 2>/dev/null || true
}

# ─────────────────────────────────────────────────────────────────────────────
# Argument parsing
# ─────────────────────────────────────────────────────────────────────────────

usage() {
  cat >&2 <<EOF
polyptic install.sh — provision a box from the control plane.

Usage (served): curl -sfL ${BASE}/install | POLYPTIC_TOKEN=… sh -s -- [flags]

Flags:
  --kiosk                       also provision the greetd→sway→Chromium substrate (Stage B)
  --output CONN[=WxH][@X,Y]     pin a compositor output (repeatable); forwarded to setup
  -h, --help                    show this help

Env:
  POLYPTIC_TOKEN   one-time enrolment bootstrap token (server GATED mode)
  POLYPTIC_KIOSK   set to 1 for the substrate (same as --kiosk)
  POLYPTIC_BASE    override the baked-in control-plane base URL
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --kiosk) KIOSK="1" ;;
    --output)
      [ $# -ge 2 ] || die "--output expects a value, e.g. --output DP-1=1920x1080@0,0"
      OUTPUT_ARGS="${OUTPUT_ARGS} --output $2"; shift ;;
    --output=*)
      OUTPUT_ARGS="${OUTPUT_ARGS} --output ${1#--output=}" ;;
    -h|--help) usage; exit 0 ;;
    *) die "unknown argument '$1' (try --help)" ;;
  esac
  shift
done

# ─────────────────────────────────────────────────────────────────────────────
# Resolve the control-plane base → host[:port] + ws/wss scheme
# ─────────────────────────────────────────────────────────────────────────────

case "$BASE" in
  # Empty, or still-unsubstituted (leftover `{{…}}` — the server replaces the exact `{{POLYPTIC_BASE}}`
  # token, so checking for bare braces here survives substitution where matching the token wouldn't).
  ""|*'{{'*)
    die "control-plane base URL is unset. Pipe this script from the server (GET /install bakes it
     in), or set POLYPTIC_BASE=http://your-server:8080 explicitly." ;;
  http://*|https://*) : ;;
  *) die "POLYPTIC_BASE must start with http:// or https:// (got '${BASE}')" ;;
esac

# Strip a trailing slash for clean concatenation.
BASE="${BASE%/}"

SCHEME="${BASE%%://*}"
HOSTPORT="${BASE#*://}"
HOSTPORT="${HOSTPORT%%/*}"
[ -n "$HOSTPORT" ] || die "could not parse a host from POLYPTIC_BASE='${BASE}'"
case "$SCHEME" in
  https) WS_SCHEME="wss" ;;
  *)     WS_SCHEME="ws" ;;
esac
SERVER_URL="${WS_SCHEME}://${HOSTPORT}/agent"

# ─────────────────────────────────────────────────────────────────────────────
# Detect architecture + distro
# ─────────────────────────────────────────────────────────────────────────────

step "detecting architecture + distro"

UNAME_M="$(uname -m)"
case "$UNAME_M" in
  x86_64|amd64)        ARCH="amd64" ;;
  aarch64|arm64)       ARCH="arm64" ;;
  *) die "unsupported CPU architecture '${UNAME_M}' (need x86_64/amd64 or aarch64/arm64)" ;;
esac

DISTRO_ID="unknown"; DISTRO_VER=""; DISTRO_LIKE=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_ID="${ID:-unknown}"
  DISTRO_VER="${VERSION_ID:-}"
  DISTRO_LIKE="${ID_LIKE:-}"
fi
# The depot path segment for a substrate bundle, e.g. "ubuntu-24.04".
if [ -n "$DISTRO_VER" ]; then
  DISTRO_SLUG="${DISTRO_ID}-${DISTRO_VER}"
else
  DISTRO_SLUG="${DISTRO_ID}"
fi

log "arch=${ARCH}  distro=${DISTRO_SLUG}  base=${BASE}  server_url=${SERVER_URL}"
log "kiosk=${KIOSK}  token=$( [ -n "$TOKEN" ] && echo 'set' || echo 'EMPTY (server OPEN mode)' )"

# ═════════════════════════════════════════════════════════════════════════════
# STAGE A — agent (fully air-gapped; server only)
# ═════════════════════════════════════════════════════════════════════════════

# ── A1. Download the agent binary ────────────────────────────────────────────
step "A1: downloading agent binary (${ARCH}) from the control plane"
AGENT_URL="${BASE}/dist/agent/${ARCH}"
AGENT_TMP="${WORK}/polyptic-agent"
CODE="$(http_fetch "$AGENT_URL" "$AGENT_TMP")"
case "$CODE" in
  2??)
    [ -s "$AGENT_TMP" ] || die "agent binary from ${AGENT_URL} was empty"
    ;;
  404)
    die "the control plane has no agent binary for '${ARCH}' (${AGENT_URL} → 404).
     Build + bundle it on the server: deploy/build-agent.sh ${ARCH} (then set AGENT_DIST_DIR), or
     rebuild the server image which compiles both arches." ;;
  000)
    die "could not reach the control plane at ${BASE} (${AGENT_URL}). Is the box's only network
     path to the server up? Is the URL right?" ;;
  *)
    die "unexpected HTTP ${CODE} fetching ${AGENT_URL}" ;;
esac

step "A1: installing → ${BIN_PATH}"
$SUDO install -D -m 0755 "$AGENT_TMP" "$BIN_PATH"
# NB: do NOT execute the binary here — it has no --version flag, so running it starts the full agent
# (which blocks this installer and, with no config yet, dials the default localhost). systemd runs it.
log "installed the agent binary at ${BIN_PATH}"

# ── A2. /etc/polyptic/agent.toml ─────────────────────────────────────────────
# The agent reads this flat TOML at boot (server_url + bootstrap_token + backend). The keys here
# match packages/agent's on-box config schema (server_url / bootstrap_token / backend).
step "A2: writing ${CONFIG_PATH}"
$SUDO install -d -m 0755 "$ETC_DIR"
write_file "$CONFIG_PATH" 0640 <<EOF
# /etc/polyptic/agent.toml — written by the control-plane installer (GET /install).
# The agent reads these at boot. Real POLYPTIC_* env vars + the systemd unit's Environment= win.
#   restart after edits:  systemctl restart polyptic-agent

# Control-plane agent channel (derived from the URL this box installed from).
server_url = "${SERVER_URL}"

# One-time enrolment bootstrap token for the server's GATED mode (Phase 2b). Empty in OPEN mode.
# After first contact the agent persists a durable credential under state_dir and no longer needs it.
bootstrap_token = "${TOKEN}"

# Display backend: "wayland-sway" (default) | "x11-i3" (NVIDIA/fallback) | "dev-open".
backend = "wayland-sway"
EOF

# ── A3. systemd SYSTEM unit (Restart=always) ─────────────────────────────────
# Headless enrolment service: runs the agent as a system service so the box dials home and enrols
# immediately, before (and independent of) any kiosk session. In --kiosk mode this is retired in
# Stage B in favour of the session-scoped user agent that `setup` installs.
step "A3: writing systemd SYSTEM unit ${UNIT_PATH}"
$SUDO install -d -m 0755 "$STATE_DIR"
write_file "$UNIT_PATH" 0644 <<EOF
[Unit]
Description=Polyptic agent (control-plane reconciler / headless enrolment)
Documentation=${BASE}/install
Wants=network-online.target
After=network-online.target
# An unattended display must always come back — never give up restarting.
StartLimitIntervalSec=0

[Service]
Type=simple
Environment=POLYPTIC_STATE_DIR=${STATE_DIR}
# Optional env bridge (written by \`polyptic-agent setup\`); '-' keeps it optional.
EnvironmentFile=-${ETC_DIR}/agent.env
ExecStart=${BIN_PATH}
Restart=always
RestartSec=2
KillMode=control-group
TimeoutStopSec=10

[Install]
WantedBy=multi-user.target
EOF

step "A3: enabling + (re)starting polyptic-agent.service"
$SUDO systemctl daemon-reload
$SUDO systemctl enable polyptic-agent.service
# restart (not `enable --now`) so a RE-install actually picks up a freshly-downloaded binary —
# `--now` only starts a stopped unit; it would leave an already-running old agent in place.
$SUDO systemctl restart polyptic-agent.service
log "Stage A complete — the box is enrolling. Approve it in the console (it shows PENDING in GATED mode)."

# If this is an agent-only install, we're done.
if [ "$KIOSK" != "1" ]; then
  log "Done (Stage A — agent only)."
  cat >&2 <<EOF
  • binary : ${BIN_PATH}
  • config : ${CONFIG_PATH}
  • service: polyptic-agent.service  (systemctl status polyptic-agent)
  • logs   : journalctl -u polyptic-agent -f

Re-run with --kiosk to also provision the greetd→sway→Chromium visual substrate.
EOF
  exit 0
fi

# ═════════════════════════════════════════════════════════════════════════════
# STAGE B — visual substrate (offline-first from the server, else online, else fail)
# ═════════════════════════════════════════════════════════════════════════════

step "B1: provisioning the visual substrate (--kiosk)"

DEPS_BASE="${BASE}/dist/deps/${DISTRO_SLUG}/${ARCH}"
MANIFEST_URL="${DEPS_BASE}/manifest.json"
MANIFEST_TMP="${WORK}/manifest.json"

step "B1: probing server bundle ${MANIFEST_URL}"
CODE="$(http_fetch "$MANIFEST_URL" "$MANIFEST_TMP")"

SUBSTRATE_DONE="0"
if [ "$CODE" = "200" ] || { [ "${CODE#2}" != "$CODE" ] && [ -s "$MANIFEST_TMP" ]; }; then
  # ── B2a. OFFLINE-FIRST: install the server's bundled .debs (no internet) ───
  log "found a server bundle for ${DISTRO_SLUG}/${ARCH} — installing offline from the depot"

  case "$DISTRO_ID" in
    ubuntu|debian|*deb*) : ;;
    *) case "$DISTRO_LIKE" in *debian*) : ;; *)
         die "server bundle exists but this distro (${DISTRO_ID}) is not apt-based — bundles are
     .deb closures and install with apt-get. Re-bundle for ${DISTRO_SLUG} or use a Debian/Ubuntu box." ;;
       esac ;;
  esac
  command -v apt-get >/dev/null 2>&1 || die "apt-get not found but the server bundle is .debs"

  # Parse the "files" array out of manifest.json without jq (flatten newlines, slice the array).
  FLAT="$(tr -d '\n\r\t' < "$MANIFEST_TMP")"
  FILES="$(printf '%s' "$FLAT" \
    | sed -n 's/.*"files"[[:space:]]*:[[:space:]]*\[\([^]]*\)\].*/\1/p' \
    | tr ',' '\n' \
    | sed -e 's/^[[:space:]]*"//' -e 's/"[[:space:]]*$//' -e 's/[][" ]//g' \
    | sed '/^$/d')"
  [ -n "$FILES" ] || die "server bundle manifest at ${MANIFEST_URL} listed no files (\"files\": [])"

  DEB_DIR="${WORK}/debs"
  mkdir -p "$DEB_DIR"
  N=0
  for f in $FILES; do
    # Path-traversal safety: reject anything but a bare filename.
    case "$f" in
      */*|*..*|"") die "refusing suspicious bundle filename '${f}' in manifest" ;;
    esac
    N=$((N + 1))
    step "B2: [${N}] downloading ${f}"
    FCODE="$(http_fetch "${DEPS_BASE}/${f}" "${DEB_DIR}/${f}")"
    case "$FCODE" in
      2??) [ -s "${DEB_DIR}/${f}" ] || die "downloaded ${f} was empty" ;;
      *) die "failed to download bundle file ${f} (HTTP ${FCODE} from ${DEPS_BASE}/${f})" ;;
    esac
  done

  step "B2: installing ${N} bundled .deb(s) with apt-get (offline)"
  # Install the whole closure at once so apt resolves interdependencies; -y, no network needed.
  $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y --no-download --allow-downgrades \
    "$DEB_DIR"/*.deb \
    || $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y "$DEB_DIR"/*.deb \
    || die "apt-get failed installing the bundled substrate .debs (see output above)"
  SUBSTRATE_DONE="1"
  log "substrate installed offline from the server bundle"

elif [ "$CODE" = "404" ]; then
  # ── B2b. ONLINE FALLBACK: no server bundle for this distro+arch ────────────
  warn "no server bundle for ${DISTRO_SLUG}/${ARCH} (${MANIFEST_URL} → 404)"
  if has_internet; then
    log "box has internet — falling back to the distro package manager online"
    install_online() {
      case "$DISTRO_ID" in
        ubuntu|debian)
          $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update
          $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y \
            sway greetd grim wayvnc dbus-user-session fonts-dejavu-core \
            && { $SUDO apt-get install -y chromium-browser || $SUDO apt-get install -y chromium; }
          ;;
        fedora|rhel|centos|rocky|almalinux)
          $SUDO dnf install -y sway greetd grim wayvnc dbus-daemon dejavu-sans-fonts chromium
          ;;
        arch|archarm|manjaro)
          $SUDO pacman -Sy --noconfirm sway greetd grim wayvnc dbus chromium ttf-dejavu
          ;;
        *)
          case "$DISTRO_LIKE" in
            *debian*)
              $SUDO env DEBIAN_FRONTEND=noninteractive apt-get update
              $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y \
                sway greetd grim wayvnc dbus-user-session fonts-dejavu-core \
                && { $SUDO apt-get install -y chromium-browser || $SUDO apt-get install -y chromium; } ;;
            *fedora*|*rhel*)
              $SUDO dnf install -y sway greetd grim wayvnc dbus-daemon dejavu-sans-fonts chromium ;;
            *arch*)
              $SUDO pacman -Sy --noconfirm sway greetd grim wayvnc dbus chromium ttf-dejavu ;;
            *)
              return 3 ;;
          esac
          ;;
      esac
    }
    if install_online; then
      SUBSTRATE_DONE="1"
      log "substrate installed online via the distro package manager"
    else
      die "no known online package recipe for distro '${DISTRO_ID}'. Add a server bundle with
     deploy/bundle-deps.sh, or install sway greetd chromium grim wayvnc dbus + fonts by hand, then
     re-run with --kiosk."
    fi
  else
    die "no server bundle for ${DISTRO_SLUG}/${ARCH} and no internet on this box.
     Either: (a) bundle this distro on the server — run deploy/bundle-deps.sh on an Ubuntu host of
     this arch and redeploy; or (b) use one of the bundled distros baked into the image; or
     (c) give this box one-time internet so the online apt/dnf/pacman fallback can run."
  fi
else
  die "unexpected HTTP ${CODE} probing the substrate bundle at ${MANIFEST_URL}"
fi

[ "$SUBSTRATE_DONE" = "1" ] || die "substrate provisioning did not complete"

# ── B3. Hand off to the agent's setup CLI for the greetd/sway/Chromium wiring ─
# Dependencies are present now, so --skip-deps. setup writes its own agent.toml + the session
# units (greetd autologin → sway → systemd --user polyptic-agent.service → Chromium-per-output).
step "B3: wiring the kiosk via 'polyptic-agent setup --skip-deps'"
# shellcheck disable=SC2086
$SUDO "$BIN_PATH" setup --skip-deps \
  --server-url "$SERVER_URL" \
  --bootstrap-token "$TOKEN" \
  $OUTPUT_ARGS \
  || die "'polyptic-agent setup' failed (see output above)"

# ── B4. Retire the Stage-A system service ────────────────────────────────────
# The kiosk runs the agent as a systemd --user unit INSIDE the sway session (it must inherit
# WAYLAND_DISPLAY to drive Chromium). Two agents for one machine-id is pointless, so stop+disable
# the Stage-A system service now that the session-scoped agent owns the box.
step "B4: retiring the Stage-A system service (the kiosk session now owns the agent)"
$SUDO systemctl disable --now polyptic-agent.service 2>/dev/null || true

log "Done (Stage A + Stage B — kiosk)."
cat >&2 <<EOF
  • binary  : ${BIN_PATH}
  • substrate: sway + greetd + Chromium + grim + wayvnc + dbus + fonts
  • wiring  : polyptic-agent setup (greetd autologin → sway → user agent → Chromium-per-output)
  • next    : sudo reboot   # cold-boot into the kiosk; approve the box in the console

Logs after reboot:
  • session : journalctl -b -u greetd
  • agent   : journalctl --user -u polyptic-agent   (run inside the kiosk session)
EOF
exit 0
