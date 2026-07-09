#!/bin/sh
# Emit ONE stable machine id to stdout for a diskless (netboot) live boot (POL-33).
#
# WHY: a casper/live image regenerates /etc/machine-id randomly on every boot, so a diskless box would
# look like a BRAND-NEW machine each power cycle, re-entering PENDING and losing its screen placement.
# Derive instead a value stable per PHYSICAL box:
#   1) dmi-<product_uuid>              (SMBIOS/DMI, stable per motherboard)
#   2) mac-<sha256(primary NIC MAC)>  (fallback for firmware that reports an all-zero/placeholder UUID)
#   3) unknown-<random machine-id>    (last resort, still enrollable, just not stable)
# The live image exports this as POLYPTIC_MACHINE_ID, which the agent honours ABOVE /etc/machine-id
# (readMachineId()); the server's enroll.ts case-4 then re-attaches the same approved machine every boot.
#
# PURE + TESTABLE: every input path is overridable, so this runs against fixtures on macOS/Linux/CI, 
#   POLYPTIC_DMI_UUID_FILE (/sys/class/dmi/id/product_uuid)
#   POLYPTIC_NET_DIR       (/sys/class/net)
#   POLYPTIC_ROUTE_FILE    (/proc/net/route)
# Deliberately NO `set -e`, it must NEVER wedge the boot; it always exits 0 with SOME value.

UUID_FILE="${POLYPTIC_DMI_UUID_FILE:-/sys/class/dmi/id/product_uuid}"
NET_DIR="${POLYPTIC_NET_DIR:-/sys/class/net}"
ROUTE_FILE="${POLYPTIC_ROUTE_FILE:-/proc/net/route}"

lc() { tr 'A-Z' 'a-z'; }

sha256hex() {
  if   command -v sha256sum >/dev/null 2>&1; then sha256sum    | awk '{print $1}'
  elif command -v shasum    >/dev/null 2>&1; then shasum -a 256 | awk '{print $1}'  # macOS/dev
  else cksum | awk '{print $1}'   # weak last resort; real boxes always have sha256sum
  fi
}

valid_uuid() {
  case "$1" in
    00000000-0000-0000-0000-000000000000) return 1 ;;  # firmware all-zero placeholder
    ffffffff-ffff-ffff-ffff-ffffffffffff) return 1 ;;  # firmware all-ones placeholder
  esac
  printf '%s' "$1" | grep -Eiq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
}

# 1) DMI product UUID.
if [ -r "$UUID_FILE" ]; then
  uuid="$(tr -d '[:space:]' < "$UUID_FILE" 2>/dev/null | lc)"
  if valid_uuid "$uuid"; then printf 'dmi-%s\n' "$uuid"; exit 0; fi
fi

# 2) primary-NIC MAC: the default-route iface, else the lowest-ifindex real (non-virtual) NIC.
iface=""
if [ -r "$ROUTE_FILE" ]; then
  iface="$(awk '$2=="00000000" && $8=="00000000" {print $1; exit}' "$ROUTE_FILE" 2>/dev/null)"
fi
mac=""
if [ -n "$iface" ] && [ -r "$NET_DIR/$iface/address" ]; then
  mac="$(lc < "$NET_DIR/$iface/address" 2>/dev/null)"
  # An all-zero MAC on the default-route iface is useless as an identity, fall through to the scan below.
  [ "$mac" = "00:00:00:00:00:00" ] && mac=""
fi
if [ -z "$mac" ]; then
  best_idx=""
  for d in "$NET_DIR"/*; do
    [ -e "$d/address" ] || continue
    name="${d##*/}"
    [ "$name" = "lo" ] && continue
    if [ -L "$d" ] && readlink "$d" 2>/dev/null | grep -q '/virtual/'; then continue; fi
    a="$(lc < "$d/address" 2>/dev/null)"
    [ -n "$a" ] || continue
    [ "$a" = "00:00:00:00:00:00" ] && continue
    idx="$(cat "$d/ifindex" 2>/dev/null)"; [ -n "$idx" ] || idx=9999
    if [ -z "$best_idx" ] || [ "$idx" -lt "$best_idx" ]; then best_idx="$idx"; mac="$a"; fi
  done
fi
if [ -n "$mac" ]; then
  printf 'mac-%s\n' "$(printf '%s' "$mac" | sha256hex | cut -c1-32)"; exit 0
fi

# 3) last resort, still enrollable, just not stable across reboots.
printf 'unknown-%s\n' "$(cat /etc/machine-id 2>/dev/null | tr -d '[:space:]')"
exit 0
