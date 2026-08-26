#!/usr/bin/env sh
# Pure-shell tests for DHCP client identity (2026-08-26 outage). Runs ANYWHERE (macOS/Linux/CI), no
# root: it reads the shipped network config and the image build script as text. What this pins: every
# DHCPv4 stanza the rootfs ships keys its lease on the MAC (never the machine-id-derived DUID, which a
# baked machine-id makes identical fleet-wide), and build-live-image.sh empties the machine-id AFTER
# its last chroot step and guards it right before mksquashfs. Wrapped by
# packages/e2e/netboot-dhcp-identity.test.ts so it runs in `bun test` / CI.
set -u
HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
LIVE="$HERE/.."
BUILD="$HERE/../../build-live-image.sh"
fails=0
ok()  { printf 'ok   - %s\n' "$1"; }
bad() { printf 'FAIL - %s\n       want=[%s] got=[%s]\n' "$1" "$2" "$3"; fails=$((fails+1)); }
eq()  { [ "$2" = "$3" ] && ok "$1" || bad "$1" "$2" "$3"; }

# 1) netplan: every `dhcp4: true` stanza carries `dhcp-identifier: mac`. Count both (must match and
#    be non-zero), then walk the stanzas so a stray identifier in one cannot cover for another.
NETPLAN="$LIVE/etc/netplan/01-polyptic-dhcp.yaml"
n_dhcp4="$(grep -c '^ *dhcp4: true' "$NETPLAN")"
n_mac="$(grep -c '^ *dhcp-identifier: mac' "$NETPLAN")"
[ "$n_dhcp4" -gt 0 ] && ok "netplan ships $n_dhcp4 dhcp4 stanza(s)" || bad "netplan ships dhcp4 stanzas" ">0" "$n_dhcp4"
eq "every netplan dhcp4 stanza has dhcp-identifier: mac" "$n_dhcp4" "$n_mac"
per_stanza="$(awk '
  /^    [a-z-]+:$/ { if (open && want && !seen) missing++; open=1; want=0; seen=0; next }
  /^ *dhcp4: true/ { want=1 }
  /^ *dhcp-identifier: mac/ { seen=1 }
  END { if (open && want && !seen) missing++; print missing+0 }' "$NETPLAN")"
eq "no netplan stanza lacks its own dhcp-identifier" "0" "$per_stanza"

# 2) the wl* networkd unit keys on the MAC too.
WLAN="$LIVE/etc/systemd/network/80-polyptic-wlan.network"
eq "wlan .network has ClientIdentifier=mac under [DHCPv4]" "ClientIdentifier=mac" \
  "$(awk '/^\[/{sec=$0} sec=="[DHCPv4]" && /^ClientIdentifier=/' "$WLAN")"

# 3) the netboot initramfs .network still keys on the MAC (the rootfs fix mirrors it).
NB="$LIVE/usr/lib/dracut/modules.d/50polyptic-live/polyptic-netboot.network"
eq "netboot .network has ClientIdentifier=mac" "ClientIdentifier=mac" "$(grep '^ClientIdentifier=' "$NB")"

# 4) build script: the machine-id wipe is after the LAST chroot call and before mksquashfs, the guard
#    follows the wipe, and there is no stale early copy that could lull a reader.
wipe="$(grep -n '^: > "\$ROOTFS/etc/machine-id"' "$BUILD" | cut -d: -f1 | tail -1)"
last_chroot="$(grep -n '^ *chroot "\$ROOTFS"' "$BUILD" | cut -d: -f1 | tail -1)"
squash="$(grep -n '^mksquashfs "\$ROOTFS"' "$BUILD" | cut -d: -f1 | tail -1)"
guard="$(grep -n 'refusing to seal: .*machine-id' "$BUILD" | cut -d: -f1 | tail -1)"
[ -n "$wipe" ] && ok "build script wipes the machine-id (line $wipe)" || bad "build script wipes the machine-id" "a line" ""
[ -n "$wipe" ] && [ "$wipe" -gt "$last_chroot" ] && ok "wipe ($wipe) is after the last chroot ($last_chroot)" \
  || bad "wipe is after the last chroot" ">$last_chroot" "${wipe:-none}"
[ -n "$wipe" ] && [ "$wipe" -lt "$squash" ] && ok "wipe ($wipe) is before mksquashfs ($squash)" \
  || bad "wipe is before mksquashfs" "<$squash" "${wipe:-none}"
[ -n "$guard" ] && [ "$guard" -gt "${wipe:-0}" ] && [ "$guard" -lt "$squash" ] \
  && ok "non-empty machine-id guard sits between wipe and mksquashfs (line $guard)" \
  || bad "guard between wipe and mksquashfs" "$wipe<guard<$squash" "${guard:-none}"
eq "the wipe appears exactly once (no stale early copy)" "1" "$(grep -c '^: > "\$ROOTFS/etc/machine-id"' "$BUILD")"

[ "$fails" = 0 ] && echo "ALL PASS" || { echo "$fails FAILED"; exit 1; }
