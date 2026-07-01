#!/usr/bin/env bash
# deploy/bundle-deps.sh — build the (OPT-IN) AIR-GAP SUBSTRATE BUNDLE for one distro+arch.
#
# The bundle is OPT-IN: install.sh installs the substrate ONLINE from apt/dnf/pacman by default;
# it only consumes this bundle when run with --offline (POLYPTIC_OFFLINE=1) for a true air-gap.
#
# Run this ON AN UBUNTU HOST OF THE TARGET ARCHITECTURE. It resolves the FULL dependency closure
# for the visual substrate (sway, greetd, surf [the suckless WebKitGTK kiosk browser], grim, wayvnc,
# dbus-user-session, fonts) and downloads every .deb into deploy/dist/deps/ubuntu-<VERSION_ID>/<arch>/,
# alongside a manifest.json the control plane serves at:
#
#     GET /dist/deps/ubuntu-<VERSION_ID>/<arch>/manifest.json
#     GET /dist/deps/ubuntu-<VERSION_ID>/<arch>/<file>.deb
#
# The served install script (deploy/install.sh, Stage B), when run with --offline, downloads the
# manifest, pulls each .deb, and `apt-get install -y ./*.deb` — NO INTERNET on the edge box. The
# server is the depot.
#
# ─ CROSS-ARCH CAVEAT ─────────────────────────────────────────────────────────────────────────────
# `apt-get` resolves the dependency closure for the HOST's architecture. There is NO reliable way to
# resolve a foreign-arch closure with `apt-get download` on a normal box (multiarch only adds a few
# co-installable libs, not a full foreign sway/cog stack). So:
#   • For an amd64 bundle → run this on an amd64 Ubuntu host (or container).
#   • For an arm64 bundle → run this on an arm64 Ubuntu host (or container).
# The easy portable recipe is a throwaway container of the target arch (binfmt/qemu makes this work
# from any host):
#   docker run --rm --platform linux/amd64 -v "$PWD":/repo -w /repo ubuntu:24.04 \
#       bash -c 'apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
#                deploy/bundle-deps.sh'
#   docker run --rm --platform linux/arm64 -v "$PWD":/repo -w /repo ubuntu:24.04 \
#       bash -c 'apt-get update && apt-get install -y --no-install-recommends ca-certificates && \
#                deploy/bundle-deps.sh'
#
# Idempotent: a clean download dir is rebuilt each run; re-running yields the same closure for the
# same Ubuntu point release. Override the package set with PKGS="…".
set -euo pipefail

# ── Must be apt-based ─────────────────────────────────────────────────────────────────────────────
if ! command -v apt-get >/dev/null 2>&1; then
  echo "bundle-deps: this script must run on a Debian/Ubuntu host (apt-get required)." >&2
  echo "             Use a target-arch Ubuntu container — see the cross-arch caveat in the header." >&2
  exit 1
fi
command -v dpkg >/dev/null 2>&1 || { echo "bundle-deps: dpkg required" >&2; exit 1; }

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

# ── Identify the host distro + arch (the bundle is FOR this host's arch) ──────────────────────────
DISTRO_ID="ubuntu"; DISTRO_VER=""
if [ -r /etc/os-release ]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  DISTRO_ID="${ID:-ubuntu}"
  DISTRO_VER="${VERSION_ID:-}"
fi
case "$DISTRO_ID" in
  ubuntu|debian) : ;;
  *) echo "bundle-deps: expected Ubuntu/Debian (got ID=${DISTRO_ID}). The install script's bundle" >&2
     echo "             path is .deb-based; bundle on Ubuntu/Debian of the target arch." >&2 ;;
esac
[ -n "$DISTRO_VER" ] || { echo "bundle-deps: could not read VERSION_ID from /etc/os-release" >&2; exit 1; }

DEB_ARCH="$(dpkg --print-architecture)"   # amd64 | arm64 (matches the install script's <arch>)
DISTRO_SLUG="${DISTRO_ID}-${DISTRO_VER}"  # e.g. ubuntu-24.04 (matches GET /dist/deps/<slug>/<arch>)

# ── The substrate package set (top-level; apt pulls the rest of the closure) ──────────────────────
# Browser: surf (suckless WebKitGTK), the kiosk browser — NOT Chromium. On Ubuntu the stock
# `chromium-browser` is just a snap shim (confined, useless air-gapped, won't run under the kiosk)
# and cog isn't packaged, so the bundle ships surf instead — a real `.deb` the agent launches with
# `surf <url>` (D27). plymouth + librsvg2-bin ship the boot splash (POL-7): the branded Plymouth
# theme and rsvg-convert to rasterise its (swappable) SVG logo — needed on the `--skip-deps` air-gap
# path where `polyptic-agent setup` does NOT touch the package manager.
DEFAULT_PKGS="sway greetd grim wayvnc dbus-user-session fonts-dejavu-core fonts-liberation surf plymouth librsvg2-bin"
PKGS="${PKGS:-$DEFAULT_PKGS}"

OUT_DIR="deploy/dist/deps/${DISTRO_SLUG}/${DEB_ARCH}"
MANIFEST="${OUT_DIR}/manifest.json"

echo "==> Bundling substrate for ${DISTRO_SLUG}/${DEB_ARCH}"
echo "    packages: ${PKGS}"

# Refresh the package index (cheap, and required so apt-get download sees current versions).
echo "==> apt-get update"
if [ "$(id -u)" -ne 0 ]; then SUDO="sudo"; else SUDO=""; fi
$SUDO apt-get update -y >/dev/null

# Sanity-check the surf browser is in this index (it's the kiosk browser; the bundle is useless
# without it). Don't hard-fail — PKGS may have been overridden — but warn loudly.
if ! apt-cache show surf >/dev/null 2>&1; then
  echo "WARN: no 'surf' .deb in the apt index. The bundle will lack a kiosk browser;" >&2
  echo "      enable 'universe' (Ubuntu) or add a repo that ships surf, then re-run — or set PKGS=…" >&2
fi

# ── Resolve the FULL dependency closure for the requested top-level packages ──────────────────────
# `apt-get install --reinstall -s` (simulate) prints the exact set apt WOULD install/configure. We
# scrape the "Inst <pkg> (<ver> …)" lines → that is the closure (top-level + every transitive dep),
# correctly version-pinned for THIS host's arch + Ubuntu point release.
echo "==> Resolving dependency closure (apt-get -s install)"
# shellcheck disable=SC2086
CLOSURE="$($SUDO apt-get install -y --no-install-recommends -s $PKGS \
  | awk '/^Inst /{print $2}' | sort -u)"

if [ -z "${CLOSURE}" ]; then
  echo "bundle-deps: empty closure — are the package names valid for ${DISTRO_SLUG}? (PKGS='${PKGS}')" >&2
  exit 1
fi
CLOSURE_COUNT="$(printf '%s\n' "$CLOSURE" | wc -l | tr -d ' ')"
echo "    closure: ${CLOSURE_COUNT} package(s)"

# ── Clean + (re)create the output dir, then download every .deb in the closure ───────────────────
echo "==> Preparing ${OUT_DIR} (clean rebuild)"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# `apt-get download` writes the .debs into the CWD, so download from inside OUT_DIR.
echo "==> apt-get download (${CLOSURE_COUNT} packages) → ${OUT_DIR}"
(
  cd "$OUT_DIR"
  # Download in one invocation so apt fetches a consistent set; fall back to per-package on any
  # transient failure so one bad mirror entry doesn't sink the whole run.
  # shellcheck disable=SC2086
  if ! apt-get download $CLOSURE 2>/tmp/bundle-deps-dl.err; then
    echo "    batch download hiccup; retrying per-package" >&2
    for p in $CLOSURE; do
      apt-get download "$p" || { echo "bundle-deps: failed to download '$p'" >&2; exit 1; }
    done
  fi
)

# ── Build manifest.json: the file list (apt resolves install order itself) + provenance ──────────
echo "==> Writing ${MANIFEST}"
GENERATED="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# Collect the downloaded .deb filenames (basename only — the install script forbids path separators).
FILES="$(cd "$OUT_DIR" && ls -1 ./*.deb 2>/dev/null | sed 's#^\./##' | sort)"
[ -n "$FILES" ] || { echo "bundle-deps: no .debs landed in ${OUT_DIR}" >&2; exit 1; }
FILE_COUNT="$(printf '%s\n' "$FILES" | wc -l | tr -d ' ')"

# Emit JSON by hand (no jq dependency). The install script reads the "files" array; "packages" and
# "install" are informational (apt-get install ./*.deb resolves the actual configure order).
{
  printf '{\n'
  printf '  "schema": 1,\n'
  printf '  "distro": "%s",\n' "$DISTRO_SLUG"
  printf '  "arch": "%s",\n' "$DEB_ARCH"
  printf '  "generated": "%s",\n' "$GENERATED"
  printf '  "note": "Air-gap substrate closure. Install offline with: apt-get install -y ./*.deb",\n'

  printf '  "packages": ['
  first=1
  for p in $PKGS; do
    if [ "$first" -eq 1 ]; then first=0; printf '\n'; else printf ',\n'; fi
    printf '    "%s"' "$p"
  done
  printf '\n  ],\n'

  printf '  "files": ['
  first=1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    if [ "$first" -eq 1 ]; then first=0; printf '\n'; else printf ',\n'; fi
    printf '    "%s"' "$f"
  done <<EOF
$FILES
EOF
  printf '\n  ]\n'
  printf '}\n'
} > "$MANIFEST"

echo
echo "==> Done. Bundle: ${OUT_DIR}"
echo "    ${FILE_COUNT} .deb file(s) + manifest.json"
echo "    Served at: /dist/deps/${DISTRO_SLUG}/${DEB_ARCH}/{manifest.json,<file>.deb}"
echo
echo "    Verify offline install on a matching box:"
echo "      sudo apt-get install -y ${OUT_DIR}/*.deb"
