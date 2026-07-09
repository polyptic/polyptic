#!/usr/bin/env bash
# deploy/test-rebuild-job.sh — run the CHART'S OWN rebuild-Job command locally, in Docker.
#
# WHY: the in-cluster rebuild Jobs are the one thing a normal `bun test` can't touch — they are a
# shell command rendered by Helm, executed in a privileged ubuntu container against a depot volume.
# Every failure so far has been in that seam (a script missing from the image, an apt package the
# command forgot to install), and each one cost a release + deploy + 15-minute rebuild to discover.
# This script closes that loop on a laptop: it renders the REAL command out of the chart and runs it
# against a scratch depot, so a missing package or script fails here in minutes.
#
# It is NOT a substitute for the cluster run (no k8s, no RBAC, no PVC) — it validates exactly the
# part that keeps breaking: does the command, with the packages it installs and the scripts the
# image ships, actually produce the artifacts.
#
# USAGE:
#   deploy/test-rebuild-job.sh [full|refresh] [amd64|arm64]
#     env: BASE_ISO   pre-downloaded casper ISO (STRONGLY recommended; else it downloads ~3GB)
#          DEPOT      scratch depot dir (default deploy/dist/test-depot; reused across runs)
#          MEDIA_ONLY=1  skip the image build and only exercise the live-ISO + boot-medium steps
#                        (needs a previous run's payload in the depot) — the fast inner loop
#
# EXAMPLE (native arch, cached ISO, ~15 min first run then ~2 min with MEDIA_ONLY=1):
#   BASE_ISO=~/Downloads/ubuntu-26.04-live-server-arm64.iso deploy/test-rebuild-job.sh full arm64
set -euo pipefail
REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_ROOT"

KIND="${1:-full}"
ARCH="${2:-arm64}"
case "$KIND" in full|refresh) ;; *) echo "usage: $0 [full|refresh] [amd64|arm64]" >&2; exit 2 ;; esac
case "$ARCH" in amd64) PLATFORM=linux/amd64 ;; arm64) PLATFORM=linux/arm64 ;; *) echo "bad arch $ARCH" >&2; exit 2 ;; esac
command -v docker >/dev/null || { echo "docker required" >&2; exit 1; }
command -v helm   >/dev/null || { echo "helm required (the command comes from the chart)" >&2; exit 1; }
command -v python3 >/dev/null || { echo "python3 required (to read the rendered JSON)" >&2; exit 1; }

DEPOT="${DEPOT:-$REPO_ROOT/deploy/dist/test-depot}"
mkdir -p "$DEPOT/cache" "$DEPOT/image/$ARCH" "$DEPOT/boot"

# A token stands in for the chart Secret's POLYPTIC_BOOTSTRAP_TOKEN (the live ISO bakes it).
TEST_TOKEN="${POLYPTIC_BOOTSTRAP_TOKEN:-test-token-local}"
TEST_BASE="http://polyptic-boot.test.local"

echo "==> render the REAL Job command from the chart (kind=$KIND arch=$ARCH)"
helm template polyptic deploy/helm/polyptic \
  --set imageUpdates.arch="$ARCH" \
  --set imageUpdates.bakeBase="$TEST_BASE" \
  -s templates/rebuild-jobs.yaml > "$DEPOT/rendered.yaml"
CMD="$(python3 - "$DEPOT/rendered.yaml" "$KIND" <<'PY'
import json, sys, yaml
doc = next(d for d in yaml.safe_load_all(open(sys.argv[1])) if d)
job = json.loads(doc["data"][f"{sys.argv[2]}.json"])
print(job["spec"]["template"]["spec"]["containers"][0]["command"][2])
PY
)"

# The initContainer copies the image's /app/deploy into /repo/deploy. Locally we mount the working
# tree there — same paths, and it also catches "script referenced but not in the repo".
MOUNTS=(-v "$REPO_ROOT/deploy:/repo/deploy" -v "$DEPOT:/depot")

# Seed the cache the way the Job would, so a local ISO is reused instead of re-downloaded.
if [ -n "${BASE_ISO:-}" ]; then
  [ -f "$BASE_ISO" ] || { echo "BASE_ISO=$BASE_ISO not found" >&2; exit 1; }
  # The command derives the cache name from the official URL; link ours to that name.
  WANT="$(printf '%s' "$CMD" | grep -o 'https://[^ )]*\.iso' | head -1)"
  DEST="$DEPOT/cache/$(basename "$WANT")"
  [ -f "$DEST" ] || { echo "==> seeding cache: $(basename "$DEST")"; cp "$BASE_ISO" "$DEST"; }
fi

if [ "${MEDIA_ONLY:-0}" = "1" ]; then
  echo "==> MEDIA_ONLY: strip the image build, keep only the media steps"
  # Everything from the first media step onward (the apt line is preserved by re-prefixing it).
  APT="$(printf '%s' "$CMD" | sed -n 's/^\(set -eu; export [^;]*; apt-get update[^;]*; apt-get install[^;]*;\).*/\1/p')"
  MEDIA="$(printf '%s' "$CMD" | sed -n 's/.*\(if \[ -n "[^"]*" \] && \[ -n "${POLYPTIC_BOOTSTRAP_TOKEN:-}" \]; then echo "==> downloadable live ISO.*\)/\1/p')"
  [ -n "$MEDIA" ] || { echo "could not isolate the media steps (command shape changed?)" >&2; exit 1; }
  CMD="$APT mkdir -p /depot/boot; $MEDIA"
fi

echo "==> run it: privileged $PLATFORM container, depot=$DEPOT"
echo "----------------------------------------------------------------"
set +e
docker run --rm --privileged --platform "$PLATFORM" \
  -e POLYPTIC_BOOTSTRAP_TOKEN="$TEST_TOKEN" \
  "${MOUNTS[@]}" ubuntu:24.04 bash -c "$CMD"
RC=$?
set -e
echo "----------------------------------------------------------------"

echo "==> depot after the run:"
ls -la "$DEPOT/image/$ARCH" "$DEPOT/boot" 2>/dev/null || true

if [ "$RC" -ne 0 ]; then
  echo "==> JOB COMMAND FAILED (exit $RC) — fix it here, not in a release." >&2
  exit "$RC"
fi

echo "==> checks:"
FAIL=0
check() { if [ -s "$1" ]; then echo "    ok   $(basename "$1")"; else echo "    MISS $1"; FAIL=1; fi; }
check "$DEPOT/image/$ARCH/polyptic.iso"
check "$DEPOT/image/$ARCH/image-id.txt"
check "$DEPOT/image/$ARCH/polyptic-live.iso"     # the console's "Download live ISO"
if [ "$KIND" = "full" ]; then
  check "$DEPOT/boot/polyptic-boot.img"          # the console's "Download boot medium"
  check "$DEPOT/boot/shimx64.efi"
  check "$DEPOT/boot/grubx64.efi"
fi
[ "$FAIL" = 0 ] || { echo "==> MISSING ARTIFACTS — the console's download buttons would 404." >&2; exit 1; }
echo "==> PASS: the Job command produces every artifact the console serves."
