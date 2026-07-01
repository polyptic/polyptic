#!/usr/bin/env sh
# Pure-shell tests for the diskless identity layer (POL-33). Runs ANYWHERE (macOS/Linux/CI), no root,
# no squashfs, just fixtures. This is the part of the live-image build that IS verifiable off-box; the
# full squashfs build needs a Linux host (deploy/build-live-image.sh). Also wrapped by a bun test
# (packages/e2e/netboot-identity.test.ts) so it runs in `bun test` / CI.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIB="$HERE/../usr/local/lib/polyptic"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

sha256hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'
  else shasum -a 256 | awk '{print $1}'; fi
}

# 1) valid DMI uuid wins, lowercased.
printf '4C4C4544-0031-3010-8046-B4C04F4E4B32\n' > "$TMP/uuid_ok"
got="$(POLYPTIC_DMI_UUID_FILE="$TMP/uuid_ok" POLYPTIC_NET_DIR="$TMP/none" POLYPTIC_ROUTE_FILE="$TMP/none" sh "$LIB/derive-machine-id.sh")"
eq "dmi uuid wins (lowercased)" "dmi-4c4c4544-0031-3010-8046-b4c04f4e4b32" "$got"

# 2) all-zero uuid rejected -> stable MAC hash; lo + virtual ifaces skipped.
printf '00000000-0000-0000-0000-000000000000\n' > "$TMP/uuid_zero"
mkdir -p "$TMP/net/eth0" "$TMP/net/lo"
printf 'aa:bb:cc:dd:ee:ff\n' > "$TMP/net/eth0/address"; printf '2\n' > "$TMP/net/eth0/ifindex"
printf '00:00:00:00:00:00\n' > "$TMP/net/lo/address";   printf '1\n' > "$TMP/net/lo/ifindex"
want="mac-$(printf 'aa:bb:cc:dd:ee:ff' | sha256hex | cut -c1-32)"
got="$(POLYPTIC_DMI_UUID_FILE="$TMP/uuid_zero" POLYPTIC_NET_DIR="$TMP/net" POLYPTIC_ROUTE_FILE="$TMP/none" sh "$LIB/derive-machine-id.sh")"
eq "all-zero uuid -> mac hash" "$want" "$got"
got2="$(POLYPTIC_DMI_UUID_FILE="$TMP/uuid_zero" POLYPTIC_NET_DIR="$TMP/net" POLYPTIC_ROUTE_FILE="$TMP/none" sh "$LIB/derive-machine-id.sh")"
eq "mac hash stable across runs" "$got" "$got2"

# 3) parse-cmdline extracts the namespaced keys, ignores everything else (incl. polyptic.base/offload).
printf 'BOOT_IMAGE=/casper/vmlinuz boot=casper netboot=http polyptic.base=http://10.0.0.10 polyptic.server_url=ws://10.0.0.10/agent quiet polyptic.token=abc123 polyptic.offload=1 splash\n' > "$TMP/cmdline"
out="$(POLYPTIC_CMDLINE_FILE="$TMP/cmdline" sh "$LIB/parse-cmdline.sh")"
eq "server_url" "POLYPTIC_SERVER_URL=ws://10.0.0.10/agent" "$(printf '%s\n' "$out" | grep '^POLYPTIC_SERVER_URL=')"
eq "token"      "POLYPTIC_BOOTSTRAP_TOKEN=abc123"          "$(printf '%s\n' "$out" | grep '^POLYPTIC_BOOTSTRAP_TOKEN=')"
eq "no base/offload leakage" "" "$(printf '%s\n' "$out" | grep -E '^POLYPTIC_(BASE|OFFLOAD)=' || true)"

# 4) absent keys emit nothing (agent keeps its defaults).
printf 'boot=casper quiet splash\n' > "$TMP/cmdline2"
eq "no keys -> empty" "" "$(POLYPTIC_CMDLINE_FILE="$TMP/cmdline2" sh "$LIB/parse-cmdline.sh")"

# 5) write-agent-env composes the full env file atomically.
env_out="$TMP/agent.env"
POLYPTIC_LIB_DIR="$LIB" POLYPTIC_RUN_DIR="$TMP/run" POLYPTIC_ENV_FILE="$env_out" \
  POLYPTIC_ENV_OWNER="nobody:nogroup" POLYPTIC_DMI_UUID_FILE="$TMP/uuid_ok" \
  POLYPTIC_CMDLINE_FILE="$TMP/cmdline" sh "$LIB/write-agent-env.sh"
eq "agent.env machine id"   "POLYPTIC_MACHINE_ID=dmi-4c4c4544-0031-3010-8046-b4c04f4e4b32" "$(grep '^POLYPTIC_MACHINE_ID=' "$env_out")"
eq "agent.env server_url"   "POLYPTIC_SERVER_URL=ws://10.0.0.10/agent" "$(grep '^POLYPTIC_SERVER_URL=' "$env_out")"
eq "agent.env token"        "POLYPTIC_BOOTSTRAP_TOKEN=abc123" "$(grep '^POLYPTIC_BOOTSTRAP_TOKEN=' "$env_out")"

[ "$fails" = 0 ] && { echo "ALL PASS"; exit 0; } || { echo "$fails FAILED"; exit 1; }
