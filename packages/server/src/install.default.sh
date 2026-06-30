#!/bin/sh
# ─────────────────────────────────────────────────────────────────────────────
# Polyptic — zero-touch, air-gapped edge installer.
#
#   curl -sfL {{POLYPTIC_BASE}}/install | POLYPTIC_TOKEN=xyz sh -
#
# The control-plane base is baked in below from the host you curled. Stage A (the agent + enrolment)
# talks ONLY to that server — no internet required. Stage B (--kiosk) provisions the visual substrate,
# offline-first from the server's bundled packages, falling back to the distro package manager only if
# this box happens to have internet.
#
# Env:
#   POLYPTIC_TOKEN   enrolment bootstrap token (for the server's gated mode). Optional in open mode.
#   POLYPTIC_KIOSK=1 also provision the kiosk substrate (same as passing --kiosk).
# Args:
#   --kiosk          provision the greetd/sway/Chromium substrate too (Stage B).
#   --output PIN     compositor output pin, repeatable (e.g. --output DP-1=1920x1080@0,0).
# ─────────────────────────────────────────────────────────────────────────────
set -eu

BASE="{{POLYPTIC_BASE}}"

log()  { printf '[polyptic-install] %s\n' "$*" >&2; }
warn() { printf '[polyptic-install] WARN: %s\n' "$*" >&2; }
die()  { printf '[polyptic-install] ERROR: %s\n' "$*" >&2; exit 1; }

# ── Parse flags ──────────────────────────────────────────────────────────────
KIOSK="${POLYPTIC_KIOSK:-0}"
OUTPUT_ARGS=""
while [ $# -gt 0 ]; do
  case "$1" in
    --kiosk) KIOSK=1 ;;
    --output) shift; [ $# -gt 0 ] || die "--output needs a value"; OUTPUT_ARGS="$OUTPUT_ARGS --output $1" ;;
    --output=*) OUTPUT_ARGS="$OUTPUT_ARGS --output ${1#--output=}" ;;
    *) warn "ignoring unknown argument: $1" ;;
  esac
  shift
done

TOKEN="${POLYPTIC_TOKEN:-}"

# ── Root / sudo ──────────────────────────────────────────────────────────────
SUDO=""
if [ "$(id -u)" -ne 0 ]; then
  if command -v sudo >/dev/null 2>&1; then
    SUDO="sudo"
  else
    die "must run as root (or install sudo): re-run with 'sudo' or as root"
  fi
fi

# ── A tool to fetch from the control plane ───────────────────────────────────
if command -v curl >/dev/null 2>&1; then
  DL() { curl -fsSL "$1" -o "$2"; }
  HEAD_OK() { curl -fsSL -o /dev/null "$1" 2>/dev/null; }
elif command -v wget >/dev/null 2>&1; then
  DL() { wget -q -O "$2" "$1"; }
  HEAD_OK() { wget -q -O /dev/null "$1" 2>/dev/null; }
else
  die "need curl or wget to download from the control plane"
fi

# ── Detect arch ──────────────────────────────────────────────────────────────
RAW_ARCH="$(uname -m)"
case "$RAW_ARCH" in
  aarch64|arm64)        ARCH=arm64 ;;
  x86_64|amd64)         ARCH=amd64 ;;
  *) die "unsupported CPU architecture '$RAW_ARCH' (need arm64 or amd64)" ;;
esac
log "architecture: $ARCH (uname -m: $RAW_ARCH)"

# ── Detect distro ────────────────────────────────────────────────────────────
DISTRO_ID="unknown"
DISTRO_VER=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_ID="${ID:-unknown}"
  DISTRO_VER="${VERSION_ID:-}"
fi
if [ -n "$DISTRO_VER" ]; then
  DISTRO_SLUG="${DISTRO_ID}-${DISTRO_VER}"
else
  DISTRO_SLUG="${DISTRO_ID}"
fi
log "distro: ${DISTRO_ID} ${DISTRO_VER} (bundle slug: ${DISTRO_SLUG})"

# ── Derive the agent websocket URL from the baked HTTP base ──────────────────
case "$BASE" in
  https://*) WS_SCHEME=wss; BASE_HOST="${BASE#https://}" ;;
  http://*)  WS_SCHEME=ws;  BASE_HOST="${BASE#http://}" ;;
  *)         WS_SCHEME=ws;  BASE_HOST="$BASE" ;;
esac
BASE_HOST="${BASE_HOST%/}"
WS_URL="${WS_SCHEME}://${BASE_HOST}/agent"
log "control plane: ${BASE} (agent ws: ${WS_URL})"

# ─────────────────────────────────────────────────────────────────────────────
# Stage A — the agent + enrolment (fully air-gapped: server only)
# ─────────────────────────────────────────────────────────────────────────────

# 1. Download the agent binary.
TMP_AGENT="$(mktemp)"
log "downloading agent binary: ${BASE}/dist/agent/${ARCH}"
if ! DL "${BASE}/dist/agent/${ARCH}" "$TMP_AGENT"; then
  rm -f "$TMP_AGENT"
  die "could not download agent binary from ${BASE}/dist/agent/${ARCH} (is the ${ARCH} binary bundled on the server?)"
fi
$SUDO install -m 0755 -D "$TMP_AGENT" /usr/local/bin/polyptic-agent
rm -f "$TMP_AGENT"
log "installed /usr/local/bin/polyptic-agent"

# 2. Write /etc/polyptic/agent.toml (idempotent — overwrite each run).
$SUDO mkdir -p /etc/polyptic
TMP_TOML="$(mktemp)"
{
  printf '# Written by the Polyptic zero-touch installer. Edit + restart polyptic-agent to apply.\n'
  printf 'server_url = "%s"\n' "$WS_URL"
  if [ -n "$TOKEN" ]; then
    printf 'bootstrap_token = "%s"\n' "$TOKEN"
  fi
} > "$TMP_TOML"
$SUDO install -m 0600 -D "$TMP_TOML" /etc/polyptic/agent.toml
rm -f "$TMP_TOML"
log "wrote /etc/polyptic/agent.toml"
[ -n "$TOKEN" ] || warn "no POLYPTIC_TOKEN given — this only enrols on a server in OPEN mode"

# 3. systemd system unit (Restart=always), enable + start → the box enrols now.
if command -v systemctl >/dev/null 2>&1; then
  TMP_UNIT="$(mktemp)"
  cat > "$TMP_UNIT" <<'UNIT'
[Unit]
Description=Polyptic display agent
Documentation=https://github.com/polyptic
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=/usr/local/bin/polyptic-agent
Restart=always
RestartSec=2
# Config is read from /etc/polyptic/agent.toml.

[Install]
WantedBy=multi-user.target
UNIT
  $SUDO install -m 0644 -D "$TMP_UNIT" /etc/systemd/system/polyptic-agent.service
  rm -f "$TMP_UNIT"
  $SUDO systemctl daemon-reload
  $SUDO systemctl enable polyptic-agent.service >/dev/null 2>&1 || true
  $SUDO systemctl restart polyptic-agent.service
  log "polyptic-agent.service enabled + started — the box is enrolling"
else
  warn "systemd not found — agent installed but NOT supervised; run /usr/local/bin/polyptic-agent yourself"
fi

if [ "$KIOSK" != "1" ]; then
  log "Stage A complete (agent enrolled). Re-run with --kiosk (or POLYPTIC_KIOSK=1) to provision the display substrate."
  exit 0
fi

# ─────────────────────────────────────────────────────────────────────────────
# Stage B — the visual substrate (offline-first from the server's bundle)
# ─────────────────────────────────────────────────────────────────────────────
log "Stage B: provisioning the kiosk substrate"

MANIFEST_URL="${BASE}/dist/deps/${DISTRO_SLUG}/${ARCH}/manifest.json"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

USED_BUNDLE=0
log "checking for a server bundle: ${MANIFEST_URL}"
if DL "$MANIFEST_URL" "$WORK/manifest.json" 2>/dev/null; then
  log "server bundle found — installing packages OFFLINE (no internet needed)"
  # Extract each "file" value from the manifest (no jq dependency: a tolerant grep/sed).
  FILES="$(tr ',' '\n' < "$WORK/manifest.json" | sed -n 's/.*"file"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
  [ -n "$FILES" ] || die "server manifest at ${MANIFEST_URL} listed no package files"
  for f in $FILES; do
    case "$f" in
      */*|*..*) die "refusing manifest entry with a path separator: $f" ;;
    esac
    log "  downloading package: $f"
    DL "${BASE}/dist/deps/${DISTRO_SLUG}/${ARCH}/${f}" "$WORK/$f" \
      || die "could not download bundled package ${f} from the control plane"
  done
  log "installing bundled .debs with apt-get (offline)"
  $SUDO apt-get install -y --no-install-recommends "$WORK"/*.deb \
    || die "apt-get failed installing the bundled packages"
  USED_BUNDLE=1
else
  warn "no server bundle for ${DISTRO_SLUG}/${ARCH} (HTTP 404)"
fi

if [ "$USED_BUNDLE" != "1" ]; then
  # No server bundle — fall back to the distro package manager, but ONLY if this box has internet.
  log "falling back to the distro package manager (requires internet on this box)"
  HAVE_NET=0
  if HEAD_OK "https://deb.debian.org" || HEAD_OK "http://deb.debian.org" \
     || HEAD_OK "https://archive.ubuntu.com" || HEAD_OK "http://archive.ubuntu.com"; then
    HAVE_NET=1
  fi
  [ "$HAVE_NET" = "1" ] || die "no server bundle for ${DISTRO_SLUG}/${ARCH} and no internet on this box — use a bundled distro, or give this box one-time internet, then re-run with --kiosk"

  SUBSTRATE_APT="greetd sway grim foot dbus fonts-dejavu chromium chromium-browser"
  SUBSTRATE_DNF="greetd sway grim foot dbus fonts-dejavu chromium"
  SUBSTRATE_PACMAN="greetd sway grim foot dbus ttf-dejavu chromium"
  if command -v apt-get >/dev/null 2>&1; then
    $SUDO apt-get update -y
    # chromium vs chromium-browser differs by release; install whatever resolves, ignore the other.
    for pkg in $SUBSTRATE_APT; do
      $SUDO apt-get install -y --no-install-recommends "$pkg" 2>/dev/null || true
    done
  elif command -v dnf >/dev/null 2>&1; then
    $SUDO dnf install -y $SUBSTRATE_DNF
  elif command -v pacman >/dev/null 2>&1; then
    $SUDO pacman -Sy --noconfirm $SUBSTRATE_PACMAN
  else
    die "no supported package manager (apt-get/dnf/pacman) found to install the substrate"
  fi
fi

# Hand off to the agent's own setup CLI for the greetd/sway/Chromium wiring (deps already present).
log "running 'polyptic-agent setup --skip-deps' for the greetd/sway/Chromium wiring"
# shellcheck disable=SC2086
$SUDO /usr/local/bin/polyptic-agent setup \
  --skip-deps \
  --server-url "$WS_URL" \
  ${TOKEN:+--bootstrap-token "$TOKEN"} \
  $OUTPUT_ARGS

log "Stage B complete — the kiosk substrate is provisioned. Reboot to cold-boot straight into content."
