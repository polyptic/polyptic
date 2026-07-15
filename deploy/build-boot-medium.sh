#!/usr/bin/env bash
# deploy/build-boot-medium.sh, build the Polyptic SIGNED BOOT MEDIUM (POL-33/D47; universal-with-
# local-payload v2, POL-63). Sibling of build-agent.sh; nothing is compiled or signed by us.
#
# Assembles a dd-able USB medium from the boot chain Canonical already ships for its own netboot
# installer: the firmware db (Microsoft UEFI CA 2011) verifies shim, shim's embedded Canonical cert
# verifies GRUB (grubnet, the ONLY Ubuntu signed GRUB with HTTP built in), and GRUB's shim_lock
# verifier checks the Canonical-signed kernel on the loaded buffer — HTTP or local FAT, same check.
# Secure Boot stays ON end to end. Output into deploy/dist/boot/:
#   shimx64.efi grubx64.efi shimaa64.efi grubaa64.efi   the signed loaders (offload + UEFI HTTP Boot)
#   polyptic-boot.img                                   UNIVERSAL dd-able FAT32 medium (amd64 AND arm64)
#   polyptic-boot.json                                  its SIDECAR MANIFEST (POL-122): lean or full, the
#                                                       arches + image ids baked in, whether a token is
#                                                       baked. The server parses it so the console can
#                                                       say what the download actually is.
# The server serves these UNGATED at GET /dist/boot/<file> and links the .img from Console > Settings >
# Onboard Screens (Download bootloader).
#
# ONE medium for the whole fleet (POL-63). Besides the loaders it carries a LOCAL BOOT PAYLOAD —
# kernel + initrd-wifi per arch, in A/B slots that the booted box refreshes itself on image updates —
# plus an editable polyptic/wifi.conf. Stage 1 is network-first: a wired box DHCPs and chains the
# server's live menu exactly as before; only when that fails does GRUB fall back to the local
# payload, whose initrd associates to Wi-Fi from wifi.conf and streams the OS image over the radio.
# A wired box ignores the Wi-Fi extras entirely, so one flashed stick works everywhere.
#
# THE PAYLOAD MAKES THE FILE A CREDENTIAL when a token is baked (the local menu cannot fetch the
# server's, so gated fleets need POLYPTIC_TOKEN); a leaked token still only lands NEW boxes as
# PENDING. LEAN=1 skips the payload and rebuilds the old tiny tokenless network-only dongle.
#
# WHY THE PINS: SBAT revocations brick older binaries (the GA noble grub build carries grub,4 and is
# already refused by updated firmware; shim 15.4 = *.signed.previous likewise), so the four .debs AND
# the four payload .efi files inside them are pinned by sha256: shim 15.8 (SBAT shim,4) + grub
# 2.12-1ubuntu7.3 (SBAT grub,5). To bump: take the newest shim-signed / grub2-signed from
# noble(-updates), update the 4 URLs + 8 sha256 pins below in one deliberate commit, rebuild, reflash.
# NEVER ship the bare shimx64.efi/shimaa64.efi (unsigned, empty cert table), *.signed.previous, or the
# non-net grubx64.efi.signed (no HTTP module). Superseded -updates debs are GC'd from the pool; the
# launchpad +files URL is the permanent fallback.
#
# Runs on macOS AND Linux, no root, no toolchain: downloads + text templates + mtools, nothing else.
#
# PREREQUISITES: curl, shasum -a 256 (or sha256sum), ar, tar, zstd (the grub debs are data.tar.zst;
# even macOS bsdtar shells out to it), mtools (mformat/mmd/mcopy).
#   macOS: brew install mtools zstd          Debian/Ubuntu: apt-get install -y curl binutils mtools zstd
#
# USAGE:
#   POLYPTIC_BASE=http://10.0.0.5:8080 POLYPTIC_TOKEN=fleet-token deploy/build-boot-medium.sh
#     env: POLYPTIC_BASE   (required) PLAIN http; baked into stage 1 AND the local menu
#          POLYPTIC_TOKEN  (recommended) enrolment token for the LOCAL menu; without it the local
#                          path only enrols on an OPEN-enrolment control plane (loud warning)
#          LEAN=1          ESCAPE HATCH, opt-in only (POL-122): the old v1 medium — tiny, tokenless,
#                          WIRED-ONLY (no payload, no Wi-Fi). Nothing selects it automatically any
#                          more (the helm Job used to, on a fresh install, and quietly shipped every
#                          new deployment a stick that boots no Wi-Fi screen). Pass it only when you
#                          genuinely want a wired-only dongle; the manifest marks it `lean` and the
#                          console says so out loud.
#          IMAGE_DIR_BASE  where per-arch payloads live (default deploy/dist/image; an arch missing
#                          locally is fetched from POLYPTIC_BASE's depot, else skipped)
#          POLYPTIC_WIFI_SSID/POLYPTIC_WIFI_PSK  bake simple PSK credentials (else an editable
#                          template ships); POLYPTIC_WIFI_CONF=<file> bakes a full wifi.conf
#                          (WPA-Enterprise etc.); POLYPTIC_WIFI_CERTS=<dir> bakes EAP cert files
set -euo pipefail

: "${POLYPTIC_BASE:?set POLYPTIC_BASE, e.g. http://10.0.0.5:8080 (baked into the medium)}"
case "$POLYPTIC_BASE" in
  https://*) echo "build-boot-medium: POLYPTIC_BASE is https, but GRUB speaks PLAIN HTTP only (no TLS).
The boot depot is plain-http by contract: keep it on the LAN / management VLAN and pass http://host:port." >&2; exit 2 ;;
  http://*) ;;
  *) echo "build-boot-medium: POLYPTIC_BASE must look like http://host[:port] (got '$POLYPTIC_BASE')" >&2; exit 2 ;;
esac
# GRUB's device syntax wants bare host:port, `(http,HOST:PORT)`; no scheme, no path.
HOSTPORT="${POLYPTIC_BASE#http://}"; HOSTPORT="${HOSTPORT%/}"
case "$HOSTPORT" in
  "")  echo "build-boot-medium: empty host in POLYPTIC_BASE" >&2; exit 2 ;;
  */*) echo "build-boot-medium: POLYPTIC_BASE must not carry a path, the boot depot lives at the server root" >&2; exit 2 ;;
esac

for t in curl ar tar zstd mformat mmd mcopy; do
  command -v "$t" >/dev/null 2>&1 || { echo "build-boot-medium: '$t' not found (see PREREQUISITES in this script)" >&2; exit 1; }
done
if   command -v shasum    >/dev/null 2>&1; then sha256() { shasum -a 256 "$1" | awk '{print $1}'; }
elif command -v sha256sum >/dev/null 2>&1; then sha256() { sha256sum "$1" | awk '{print $1}'; }
else echo "build-boot-medium: neither 'shasum' nor 'sha256sum' found" >&2; exit 1; fi

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/.." && pwd)"   # HERE is deploy/; the repo assets (boot theme + logo) live one level up
DIST="$HERE/dist/boot"
TMPL="$HERE/dongle-grub.cfg.tmpl"
[ -f "$TMPL" ] || { echo "build-boot-medium: missing $TMPL" >&2; exit 1; }
mkdir -p "$DIST"
WORK="$(mktemp -d)"; trap 'rm -rf "$WORK"' EXIT

verify() { # verify <file> <expected-sha256> <label>; any mismatch is a hard stop
  local got; got="$(sha256 "$1")"
  [ "$got" = "$2" ] && return 0
  { echo "build-boot-medium: sha256 MISMATCH for $3"
    echo "  expected $2"
    echo "  got      $got"
    echo "  refusing to ship it. If Ubuntu published a new signed build, bump the pins deliberately (see header)."
  } >&2
  exit 1
}

fetch_and_extract() { # <deb-url> <deb-sha256> <member-in-data-tar> <payload-sha256> <install-name>
  local url="$1" deb_sha="$2" member="$3" efi_sha="$4" name="$5"
  local deb="$WORK/$(basename "$url")" dir="$WORK/x-$5"
  echo "==> $name  <-  $(basename "$url")"
  # -updates debs vanish from the pool once superseded; launchpad's +files URL is permanent (a 303
  # redirect, hence -L). Only the BUILD HOST follows redirects here, GRUB never sees these URLs.
  curl -fL -o "$deb" "$url" \
    || curl -fL -o "$deb" "https://launchpad.net/ubuntu/+archive/primary/+files/$(basename "$url")"
  verify "$deb" "$deb_sha" "$(basename "$url")"     # BEFORE unpacking
  mkdir -p "$dir"
  ( cd "$dir"
    ar -x "$deb"    # a .deb is an ar archive: debian-binary + control.tar.* + data.tar.*
    # shim-signed debs carry data.tar.xz (tar reads it natively on both OSes); grub2-signed debs carry
    # data.tar.zst, which stock macOS bsdtar only opens by shelling out to zstd, so pipe explicitly.
    if   [ -f data.tar.zst ]; then zstd -d -q < data.tar.zst | tar -xf -
    elif [ -f data.tar.xz  ]; then tar -xf data.tar.xz
    else echo "build-boot-medium: no data.tar.{zst,xz} inside $(basename "$deb")" >&2; exit 1; fi )
  [ -f "$dir/$member" ] || { echo "build-boot-medium: $member not found inside $(basename "$deb")" >&2; exit 1; }
  verify "$dir/$member" "$efi_sha" "$name ($member)"   # defense in depth: pin the payload too
  install -m 0644 "$dir/$member" "$DIST/$name"
}

# ── Pins: 4 debs + the exact signed payload inside each (8 sha256s; see header to bump) ──────────
#    <deb url>  <deb sha256>  <payload member>  <payload sha256>  <installed name>
while read -r url deb_sha member efi_sha name; do
  [ -n "$url" ] || continue
  fetch_and_extract "$url" "$deb_sha" "$member" "$efi_sha" "$name"
done <<'PINS'
http://archive.ubuntu.com/ubuntu/pool/main/s/shim-signed/shim-signed_1.58+15.8-0ubuntu1_amd64.deb ba9b5d80e5d886c30664f2bebfb5c2fcce3b9b40f16fc46cba49c19a91c8059c usr/lib/shim/shimx64.efi.signed.latest 6fe6e1bcbe6cf6baec8e056d40361ca1aa715cc04ddcc2855351de060b84350b shimx64.efi
http://ports.ubuntu.com/ubuntu-ports/pool/main/s/shim-signed/shim-signed_1.58+15.8-0ubuntu1_arm64.deb 58b0f8a0f43bdff2122af8f52b05a5eb73b1964079e36e3eed8d06b4d5164917 usr/lib/shim/shimaa64.efi.signed.latest 706f15b9578f780a2fddda8ee0806cd15b59124692cc297db320414a5a40fe44 shimaa64.efi
http://archive.ubuntu.com/ubuntu/pool/main/g/grub2-signed/grub-efi-amd64-signed_1.202.5+2.12-1ubuntu7.3_amd64.deb 8bd5cd99c3af82aab23af0f15f54c91799f343416412e122df661ef36a44a511 usr/lib/grub/x86_64-efi-signed/grubnetx64.efi.signed b457801e0f4cfd77fe375ecf8dcf098786e540706d81f552c8e58949755c62e8 grubx64.efi
http://ports.ubuntu.com/ubuntu-ports/pool/main/g/grub2-signed/grub-efi-arm64-signed_1.202.5+2.12-1ubuntu7.3_arm64.deb 728d506c28c56d3e4372f5f5b143d837d96b202c82ed05cbbd3ec27a5d4de955 usr/lib/grub/arm64-efi-signed/grubnetaa64.efi.signed f9bf85d005a6be54313a478f33728825515bc6c87509ce39f4fec7212a1b1305 grubaa64.efi
PINS

echo "==> Rendering the stage-1 config ((http,$HOSTPORT), from $(basename "$TMPL"))"
# Sentinel -> literal via sed. The template's $net is a GRUB RUNTIME var and must reach the dongle
# verbatim, which is why nothing here goes through shell expansion.
sed "s|@@POLYPTIC_BASE_HOSTPORT@@|$HOSTPORT|g" "$TMPL" > "$WORK/grub.cfg"

# ── The local boot payload (POL-63; skipped by LEAN=1) ────────────────────────────────────────────
# Per arch: vmlinuz + initrd-wifi + the build's image id, from the local dist dir when this machine
# built the image, else from the control plane's depot (the same ungated routes the boxes use). An
# arch with no payload anywhere is skipped — the medium still boots it over the WIRED chain.
LEAN="${LEAN:-0}"
IMAGE_DIR_BASE="${IMAGE_DIR_BASE:-$HERE/dist/image}"
RENDER="$HERE/live/usr/local/lib/polyptic/render-local-grub.sh"
WIFI_CONF_SH="$HERE/live/usr/local/lib/polyptic/wifi-conf.sh"
WIFI_EXAMPLE="$HERE/wifi.conf.example"
PAYLOAD_ARCHES=()
PAYLOAD_BYTES=0
MAX_ARCH_BYTES=0

fsize() { wc -c < "$1" | tr -d '[:space:]'; }

if [ "$LEAN" != "1" ]; then
  [ -x "$RENDER" ] || [ -f "$RENDER" ] || { echo "build-boot-medium: missing $RENDER" >&2; exit 1; }
  if [ -z "${POLYPTIC_TOKEN:-}" ]; then
    echo "build-boot-medium: WARNING — no POLYPTIC_TOKEN. The LOCAL boot path (Wi-Fi boxes) carries no
enrolment token, so it can only enrol against an OPEN-enrolment control plane. Gated fleets: rebuild
with POLYPTIC_TOKEN=<enrolment token> (Console > Settings > Enrolment token)." >&2
  fi
  for arch in amd64 arm64; do
    src="$IMAGE_DIR_BASE/$arch"; vml=""; ird=""; iid=""
    if [ -f "$src/vmlinuz" ] && [ -f "$src/initrd-wifi" ] && [ -f "$src/image-id.txt" ]; then
      vml="$src/vmlinuz"; ird="$src/initrd-wifi"; iid="$(head -n1 "$src/image-id.txt" | tr -d '[:space:]')"
      echo "==> Local payload ($arch): $src (image $iid)"
    else
      # The depot serves manifest.json + the artifacts ungated; a control plane without this arch
      # (or an old image with no initrd-wifi) 404s and the arch is skipped.
      man="$(curl -fsS --max-time 10 "$POLYPTIC_BASE/dist/image/$arch/manifest.json" 2>/dev/null || true)"
      iid="$(printf '%s' "$man" | sed -n 's/.*"imageId":"\([^"]*\)".*/\1/p')"
      if [ -n "$iid" ] \
        && curl -fsS -o "$WORK/vmlinuz-$arch" "$POLYPTIC_BASE/dist/image/$arch/vmlinuz" 2>/dev/null \
        && curl -fsS -o "$WORK/initrd-$arch"  "$POLYPTIC_BASE/dist/image/$arch/initrd-wifi" 2>/dev/null; then
        vml="$WORK/vmlinuz-$arch"; ird="$WORK/initrd-$arch"
        echo "==> Local payload ($arch): fetched from $POLYPTIC_BASE (image $iid)"
      else
        echo "==> Local payload ($arch): none locally or at $POLYPTIC_BASE — this arch boots over the wired chain only"
        continue
      fi
    fi
    PAYLOAD_ARCHES+=("$arch")
    eval "PAYLOAD_VML_$arch=\$vml PAYLOAD_IRD_$arch=\$ird PAYLOAD_IID_$arch=\$iid"
    bytes=$(( $(fsize "$vml") + $(fsize "$ird") ))
    PAYLOAD_BYTES=$((PAYLOAD_BYTES + bytes))
    [ "$bytes" -gt "$MAX_ARCH_BYTES" ] && MAX_ARCH_BYTES=$bytes
  done
  [ "${#PAYLOAD_ARCHES[@]}" -gt 0 ] \
    || { echo "build-boot-medium: no local payload for ANY arch (build the live image first — deploy/build-live-image.sh — or pass LEAN=1 for the network-only dongle)" >&2; exit 1; }

  # Wi-Fi credentials: a full file, the SSID/PSK shorthand, or the editable template. Whatever ships
  # is validated with the SAME parser the box runs, so a typo fails HERE, not on a wall.
  if [ -n "${POLYPTIC_WIFI_CONF:-}" ]; then
    [ -f "$POLYPTIC_WIFI_CONF" ] || { echo "POLYPTIC_WIFI_CONF not found: $POLYPTIC_WIFI_CONF" >&2; exit 1; }
    cp "$POLYPTIC_WIFI_CONF" "$WORK/wifi.conf"
  elif [ -n "${POLYPTIC_WIFI_SSID:-}" ]; then
    : "${POLYPTIC_WIFI_PSK:?POLYPTIC_WIFI_SSID is set, so POLYPTIC_WIFI_PSK is required (open/EAP need a full POLYPTIC_WIFI_CONF)}"
    printf 'WIFI_SSID=%s\nWIFI_PSK=%s\n' "$POLYPTIC_WIFI_SSID" "$POLYPTIC_WIFI_PSK" > "$WORK/wifi.conf"
  else
    cp "$WIFI_EXAMPLE" "$WORK/wifi.conf"   # all comments: edit polyptic/wifi.conf on the flashed stick
  fi
  sh "$WIFI_CONF_SH" "$WORK/wifi.conf" >/dev/null \
    || { echo "build-boot-medium: the Wi-Fi config is invalid (message above); nothing was built" >&2; exit 1; }

  # The arch dispatcher: static, tiny; the per-arch menus are rendered fully baked (D61: GRUB
  # variables cost context bugs, so state lives in regenerated files, not in GRUB vars).
  cat > "$WORK/local.cfg" <<'LOCALCFG'
# polyptic-local dispatcher (POL-63): pick this CPU's fully-baked local menu.
if [ "$grub_cpu" = "x86_64" ]; then set arch=amd64; else set arch=arm64; fi
if [ -e /grub/local-$arch.cfg ]; then
  configfile /grub/local-$arch.cfg
fi
echo "Polyptic: this medium carries no local payload for $arch (it was built without that arch's image)."
echo "The box can still netboot over a WIRED network. Rebooting in 15s ..."
sleep 15
reboot
LOCALCFG
  for arch in "${PAYLOAD_ARCHES[@]}"; do
    eval "iid=\$PAYLOAD_IID_$arch"
    sh "$RENDER" "$arch" a "$HOSTPORT" "$iid" "${POLYPTIC_TOKEN:-}" > "$WORK/local-$arch.cfg"
  done

  # Bake the POL-47 boot theme so the OFFLINE menu paints the branded splash with no network to fetch
  # it from (POL-74). DETERMINISTIC, by COPYING two COMMITTED assets — no curl, no `bun`, no runtime
  # (POL-82). History: POL-74 fetched theme.txt+logo.png from POLYPTIC_BASE at build time, so a medium
  # built before the server was reachable silently shipped a plain (theme-less) medium (homelab). POL-80
  # replaced that with a build-time `bun` GENERATION of theme.txt — but the cluster's medium-baking Jobs
  # are ubuntu:24.04 containers with the repo files under /repo but NO `bun` on PATH, so generation
  # failed and the medium shipped PLAIN again. So the theme is now a committed file exactly like
  # boot-logo.png (regenerate with `bun deploy/render-boot-theme.ts`; a test pins it == the served
  # theme). Both are byte-identical to the wired path (the theme references logo.png relatively, no base
  # URL). Guarded: a missing asset degrades to a plain-but-booting menu with a LOUD line — never a silent
  # plain medium, never a hard build failure; render-local-grub's file-exists guard then falls back to a
  # plain menu on the correct dark background.
  HAVE_THEME=0
  THEME_SRC="$REPO_ROOT/packages/server/assets/boot-theme.txt"
  LOGO_SRC="$REPO_ROOT/packages/server/assets/boot-logo.png"
  BG_SRC="$REPO_ROOT/packages/server/assets/boot-bg.png"
  PNG_CHECK="$REPO_ROOT/deploy/live/usr/local/lib/polyptic/grub-png-check.sh"
  mkdir -p "$WORK/theme"
  if [ ! -f "$THEME_SRC" ]; then
    rm -rf "$WORK/theme"
    echo "==> Boot theme: missing $THEME_SRC (run 'bun deploy/render-boot-theme.ts') — offline menu will be plain (still boots)" >&2
  elif [ ! -f "$LOGO_SRC" ]; then
    rm -rf "$WORK/theme"
    echo "==> Boot theme: missing $LOGO_SRC (run 'bun deploy/render-boot-logo.ts') — offline menu will be plain (still boots)" >&2
  elif [ ! -f "$BG_SRC" ]; then
    rm -rf "$WORK/theme"
    echo "==> Boot theme: missing $BG_SRC (run 'bun deploy/render-boot-theme.ts') — offline menu will be plain (still boots)" >&2
  else
    # A PNG that EXISTS but that GRUB 2.12's decoder cannot LOAD (interlaced, greyscale, palette,
    # torn) passes every file-exists guard and still paints "error: null src bitmap ... Press any
    # key to continue" on the wall (POL-130). That is a repo/asset bug, so it FAILS the build with
    # a message naming the file — a medium that errors on the glass must be unbuildable, and a
    # silently-plain medium would hide the defect (POL-121's lesson about quiet degradation).
    for png in "$LOGO_SRC" "$BG_SRC"; do
      if ! sh "$PNG_CHECK" "$png"; then
        echo "build-boot-medium: $png is not a PNG GRUB can decode (needs 8/16-bit truecolour, non-interlaced — see deploy/live/usr/local/lib/polyptic/grub-png-check.sh). Regenerate it: bun deploy/render-boot-logo.ts && bun deploy/render-boot-theme.ts" >&2
        exit 1
      fi
    done
    # Bitmaps first, theme.txt last (POL-87 discipline shared by every theme writer): theme.txt is
    # the file the GRUB guard keys on, so everything it references must exist before it, always.
    cp "$LOGO_SRC"  "$WORK/theme/logo.png"
    cp "$BG_SRC"    "$WORK/theme/bg.png"
    cp "$THEME_SRC" "$WORK/theme/theme.txt"
    HAVE_THEME=1
    echo "==> Boot theme: baked from committed repo assets (offline menu shows the branded splash)"
  fi
fi

IMG="$DIST/polyptic-boot.img"
MANIFEST="$DIST/polyptic-boot.json"
BUILT_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
MEDIUM_ID="medium-$(date -u +%Y%m%dT%H%M%SZ)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' \n')"
echo "==> Assembling the universal FAT32 medium -> $IMG"
# FAT32 needs >= 65,525 data clusters or a spec-strict UEFI FAT driver (EDK2/OVMF, incl. arm64 UTM
# VMs) counts clusters, decides FAT16, misreads the BPB, and never finds \EFI\BOOT\<name> — the USB
# silently fails to boot on strict firmware. 64 MiB at 512-byte clusters (-c 1) clears the floor for
# the lean medium; the payload medium is sized to fit every arch's payload PLUS one spare slot (the
# A/B refresh target update-poll writes) and uses 4 KiB clusters (-c 8), which keeps the cluster
# count above the floor for any size this can produce (>= 384 MiB). mtools only: runs unprivileged
# on macOS AND Linux (no mkfs.vfat, no root, no loop mounts).
rm -f "$IMG"
if [ "$LEAN" = "1" ]; then
  SIZE_MIB=64; CLUSTER=1; LABEL=POLYPTIC
else
  # loaders+configs+slack (48 MiB) + every payload + one spare slot sized for the largest arch.
  SIZE_MIB=$(( (PAYLOAD_BYTES + MAX_ARCH_BYTES) / 1048576 + 48 ))
  [ "$SIZE_MIB" -lt 384 ] && SIZE_MIB=384
  CLUSTER=8; LABEL=POLYPTIC-BT   # FAT labels max 11 chars; find-boot-medium.sh knows this one
fi
dd if=/dev/zero of="$IMG" bs=1048576 count=0 seek="$SIZE_MIB" 2>/dev/null \
  || dd if=/dev/zero of="$IMG" bs=1048576 count="$SIZE_MIB"   # sparse when the host dd allows it
mformat -i "$IMG" -F -c "$CLUSTER" -v "$LABEL" ::
# One medium boots BOTH arches: firmware picks \EFI\BOOT\BOOT{X64,AA64}.EFI to match its own CPU, and
# shim then loads grub{x64,aa64}.efi by name from ITS OWN directory. grubnet's baked-in prefix is /grub
# on the device it loaded from, so the stage-1 config lives at the VOLUME ROOT, not beside the binaries.
mmd   -i "$IMG" ::/EFI ::/EFI/BOOT ::/grub
mcopy -i "$IMG" "$DIST/shimx64.efi"  ::/EFI/BOOT/BOOTX64.EFI
mcopy -i "$IMG" "$DIST/grubx64.efi"  ::/EFI/BOOT/grubx64.efi
mcopy -i "$IMG" "$DIST/shimaa64.efi" ::/EFI/BOOT/BOOTAA64.EFI
mcopy -i "$IMG" "$DIST/grubaa64.efi" ::/EFI/BOOT/grubaa64.efi
mcopy -i "$IMG" "$WORK/grub.cfg"     ::/grub/grub.cfg

if [ "$LEAN" != "1" ]; then
  mmd   -i "$IMG" ::/polyptic ::/polyptic/boot
  mcopy -i "$IMG" "$WORK/local.cfg" ::/grub/local.cfg
  # The marker find-boot-medium.sh trusts (identity by CONTENT, the label is just the fast path).
  printf '%s\n' "$MEDIUM_ID" > "$WORK/medium-id"
  mcopy -i "$IMG" "$WORK/medium-id" ::/polyptic/medium-id
  mcopy -i "$IMG" "$WORK/wifi.conf" ::/polyptic/wifi.conf
  if [ -n "${POLYPTIC_WIFI_CERTS:-}" ]; then
    [ -d "$POLYPTIC_WIFI_CERTS" ] || { echo "POLYPTIC_WIFI_CERTS is not a directory: $POLYPTIC_WIFI_CERTS" >&2; exit 1; }
    mmd -i "$IMG" ::/polyptic/certs
    ( cd "$POLYPTIC_WIFI_CERTS" && for f in *; do [ -f "$f" ] && mcopy -i "$IMG" "$f" "::/polyptic/certs/$f"; done )
  fi
  for arch in "${PAYLOAD_ARCHES[@]}"; do
    eval "vml=\$PAYLOAD_VML_$arch ird=\$PAYLOAD_IRD_$arch"
    mmd   -i "$IMG" "::/polyptic/boot/$arch" "::/polyptic/boot/$arch/a"
    mcopy -i "$IMG" "$WORK/local-$arch.cfg" "::/grub/local-$arch.cfg"
    mcopy -i "$IMG" "$vml" "::/polyptic/boot/$arch/a/vmlinuz"
    mcopy -i "$IMG" "$ird" "::/polyptic/boot/$arch/a/initrd"
  done
  # The offline splash theme (POL-74), at the path render-local-grub.sh points `set theme=` at.
  # Bitmaps before theme.txt, same POL-87 ordering as every other writer.
  if [ "${HAVE_THEME:-0}" = 1 ]; then
    mmd   -i "$IMG" ::/polyptic/boot/theme
    mcopy -i "$IMG" "$WORK/theme/logo.png"  ::/polyptic/boot/theme/logo.png
    mcopy -i "$IMG" "$WORK/theme/bg.png"    ::/polyptic/boot/theme/bg.png
    mcopy -i "$IMG" "$WORK/theme/theme.txt" ::/polyptic/boot/theme/theme.txt
  fi
fi

# ── The sidecar manifest: the medium describes itself (POL-122/D110) ─────────────────────────────
# A lean medium and a full one wear the SAME filename at the SAME URL. Without this, nothing
# downstream — server, console, operator — can tell which one it just downloaded, and a wired-only
# stick gets flashed for a Wi-Fi screen that then never boots. The server parses this file (zod,
# at the edge) and the console says what the download actually is. It rides to the depot with the
# image: the boot-medium Job copies deploy/dist/boot/* wholesale.
MANIFEST_PAIRS=()
if [ "$LEAN" != "1" ]; then
  for arch in "${PAYLOAD_ARCHES[@]}"; do
    eval "iid=\$PAYLOAD_IID_$arch"
    MANIFEST_PAIRS+=("$arch:$iid")
  done
fi
sh "$HERE/write-boot-manifest.sh" "$MANIFEST" \
  "$([ "$LEAN" = "1" ] && echo 1 || echo 0)" \
  "$MEDIUM_ID" "$BUILT_AT" \
  "$([ "$LEAN" != "1" ] && [ -n "${POLYPTIC_TOKEN:-}" ] && echo 1 || echo 0)" \
  "$(wc -c < "$IMG" | tr -d '[:space:]')" \
  "${MANIFEST_PAIRS[@]+"${MANIFEST_PAIRS[@]}"}"
echo "==> Manifest -> $MANIFEST ($([ "$LEAN" = "1" ] && echo "LEAN, wired-only" || echo "full: ${PAYLOAD_ARCHES[*]}"))"

echo
echo "==> Done. Point BOOT_DIST_DIR at $DIST/ ; the server serves GET /dist/boot/<file>:"
ls -1 "$DIST"/polyptic-boot.img "$DIST"/polyptic-boot.json "$DIST"/shim*.efi "$DIST"/grub*.efi
if [ "$LEAN" = "1" ]; then
  cat <<EOF

Write it:  dd if=$IMG of=/dev/<usb-disk> bs=1048576   (the whole device, not a partition)
Boot the box from USB with Secure Boot ON; it DHCPs, then chains http://$HOSTPORT/boot/grub.cfg.
(LEAN medium: wired netboot only — no local payload, no Wi-Fi.)
EOF
else
  cat <<EOF

Write it:  dd if=$IMG of=/dev/<usb-disk> bs=1048576   (the whole device, not a partition)
Boot the box from USB with Secure Boot ON. Wired: it DHCPs and chains http://$HOSTPORT/boot/grub.cfg
exactly as before. No wire: it boots the local payload (arches: ${PAYLOAD_ARCHES[*]}) and joins Wi-Fi
from polyptic/wifi.conf — edit that file on the flashed stick from any laptop (plain FAT32). The
booted box refreshes the payload itself on image updates (A/B slots), so the stick never goes stale.
EOF
  if [ -n "${POLYPTIC_TOKEN:-}" ]; then
    echo "The baked token makes the IMAGE FILE a credential: share it like one."
  fi
fi
