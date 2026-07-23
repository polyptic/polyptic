#!/bin/sh
# Render the DISK GRUB menu for one slot of an installed box → stdout (POL-176). This is the config
# on the box's own ESP after install-to-disk.sh has laid down A/B slots: the box boots its squashfs
# FROM DISK, no network in the loop, and netboot demotes to the recovery path.
#
#   usage: render-disk-grub.sh <arch> <slot> <hostport> <imageId> [token]
#
# Written by TWO writers, one renderer: install-to-disk.sh (at install, slot a) and update-poll.sh
# (slot switches when a newer image has been staged into the inactive slot). Everything is baked
# static — arch, slot, image id — because GRUB variables cost context bugs (D61) and the file is
# regenerated wholesale whenever any of it changes. The current slot/image are PARSEABLE back out of
# the header line (same sed patterns as render-local-grub.sh's), which is how update-poll knows what
# an installed box's ESP is committed to.
#
# MENULESS by design (the POL-176 pitch): a healthy installed box never shows a menu — hidden
# timeout, straight into the slot. `set fallback=netboot` is the recovery contract: if the committed
# slot's kernel fails to LOAD (torn commit, dead slot partition), GRUB falls through to the netboot
# entry and the box streams the OS from the control plane exactly as an uninstalled box does.

ARCH="${1:?usage: render-disk-grub.sh <arch> <slot> <hostport> <imageId> [token]}"
SLOT="${2:?missing slot}"
HOSTPORT="${3:?missing hostport}"
IMAGE_ID="${4:?missing imageId}"
TOKEN="${5:-}"

case "$SLOT" in
  a) OTHER=b ;;
  b) OTHER=a ;;
  *) echo "render-disk-grub: slot must be a or b (got '$SLOT')" >&2; exit 2 ;;
esac
# The slot partitions carry their slot letter UPPERCASE in the filesystem label (POLYPTIC-A/-B).
SLOT_UC="$(printf '%s' "$SLOT" | tr 'ab' 'AB')"
OTHER_UC="$(printf '%s' "$OTHER" | tr 'ab' 'AB')"

BOOT="/polyptic/boot/$ARCH/$SLOT"
BOOT_OTHER="/polyptic/boot/$ARCH/$OTHER"
# Where install-to-disk.sh bakes the POL-47 theme (theme.txt + logo.png + bg.png), copied from the
# booted medium, so the (rarely seen) menu paints the branded splash with no network (POL-74).
THEME_DIR="/polyptic/boot/theme"
tok=""
[ -z "$TOKEN" ] || tok=" polyptic.token=$TOKEN"
# The disk-boot cmdline (POL-176). The tail mirrors render-local-grub.sh's bootKernelCmdline tail
# minus ip=dhcp/rd.neednet=1 — a disk boot needs NO network in the initramfs; the agent brings the
# network up in the real root. rd.live.overlay.reset=1 is dracut's own per-boot overlay wipe on the
# scratch partition: statelessness by construction — every boot starts from the pristine squashfs,
# exactly the diskless contract D55 promised, just without re-downloading a gigabyte to get it.
# `polyptic.bootpath=disk` marks the boot for boot-path.sh (state-only all-clear) and update-poll.sh
# (the disk staging flow keys on it).
common="rd.live.overlay=LABEL=POLYPTIC-SCRATCH rd.live.overlay.overlayfs=1 rd.live.overlay.reset=1 polyptic.base=http://$HOSTPORT polyptic.server_url=ws://$HOSTPORT/agent$tok polyptic.bootpath=disk multipath=off quiet splash plymouth.ignore-serial-consoles"
this_root="root=live:LABEL=POLYPTIC-$SLOT_UC $common"
other_root="root=live:LABEL=POLYPTIC-$OTHER_UC $common"

# Entry names + tone mirror the server menu (provision.ts buildBootGrubCfg, POL-47/D65): wall-facing
# strings stay plain English; the technical detail belongs to entries nobody reaches by accident.
cat <<EOF
# polyptic-disk arch=$ARCH slot=$SLOT image=$IMAGE_ID
# Disk boot menu (POL-176): kernel + initrd + OS image all read from THIS box's own disk. Regenerated
# by update-poll on image updates — do not hand-edit; edits are overwritten at the next update.
#
# Paint the Polyptic splash (POL-47) from the theme baked onto THIS ESP (POL-74). Same guard
# discipline as the server's bootGfxPreamble (packages/server/src/boot-theme.ts): the whole block
# hangs off loadfont, and \`set theme\` only fires when all THREE theme files exist (POL-87/POL-130
# — a theme missing a bitmap paints "error: null src bitmap" on a keyboard-less screen). A theme-less
# ESP still boots on the correct dark background. Nested ifs, not -a: plain [ -f ] is the only test
# form every GRUB build has.
if loadfont (memdisk)/fonts/unicode.pf2 ; then
  insmod all_video
  insmod gfxterm
  insmod gfxterm_background
  insmod png
  insmod gfxmenu
  set gfxmode=auto
  set gfxpayload=keep
  terminal_output gfxterm
  background_color "#0b0b0d"
  if [ -f (\$root)$THEME_DIR/theme.txt ]; then if [ -f (\$root)$THEME_DIR/logo.png ]; then if [ -f (\$root)$THEME_DIR/bg.png ]; then set theme=(\$root)$THEME_DIR/theme.txt ; fi ; fi ; fi
fi
# MENULESS happy path (POL-176): a healthy installed box paints no menu at all. The hidden timeout
# still honours a keypress — pressing any key during the 1-second window opens the menu below, which
# is the ONLY way to reach live-other/netboot/debug by hand. \`fallback=netboot\` is the automatic
# recovery: if this slot's kernel fails to load, GRUB boots the netboot entry instead, and the box
# streams the OS from the control plane like an uninstalled box.
set timeout_style=hidden
set timeout=1
set default=live
set fallback=netboot
menuentry "Polyptic" --id live {
  echo "Starting Polyptic ..."
  linux  $BOOT/vmlinuz $this_root
  initrd $BOOT/initrd
}
# The OTHER slot, for a keyboard operator: after a bad update commit, the previous image is still
# intact in the inactive slot — this entry boots it without touching the control plane. (The
# automatic fallback deliberately goes to netboot instead: GRUB cannot tell a stale slot from a good
# one, but the control plane always serves a known-good image.)
menuentry "Polyptic (previous image - slot $OTHER)" --id live-other {
  echo "Starting Polyptic from the previous image ..."
  linux  $BOOT_OTHER/vmlinuz $other_root
  initrd $BOOT_OTHER/initrd
}
menuentry "Polyptic (from the network)" --id netboot {
  echo "Starting Polyptic from the network ..."
  set net=(http,$HOSTPORT)
EOF
# The stage-1 wired walk, VERBATIM from deploy/dongle-grub.cfg.tmpl (one card at a time, first lease
# wins — POL-118), chaining into the server's own menu. Kept lockstep by a test
# (deploy/live/test/render-disk-grub.test.sh) so the two texts cannot drift. Deliberately short: no
# pager/debug dump here — once chained, the netboot path paints its own failure handling.
cat <<'EOF'
set nic_ip=
set nic_next=1
net_dhcp efinet0 ; set nic_rc="$?"
if [ "$nic_rc" = 0 ]; then set nic_ip="$net_efinet0_dhcp_ip" ; set nic_next= ; fi
if [ "$nic_rc" = 36 ]; then set nic_next= ; fi
if [ -n "$nic_next" ]; then
  net_dhcp efinet1 ; set nic_rc="$?"
  if [ "$nic_rc" = 0 ]; then set nic_ip="$net_efinet1_dhcp_ip" ; set nic_next= ; fi
  if [ "$nic_rc" = 36 ]; then set nic_next= ; fi
fi
if [ -n "$nic_next" ]; then
  net_dhcp efinet2 ; set nic_rc="$?"
  if [ "$nic_rc" = 0 ]; then set nic_ip="$net_efinet2_dhcp_ip" ; set nic_next= ; fi
  if [ "$nic_rc" = 36 ]; then set nic_next= ; fi
fi
if [ -n "$nic_next" ]; then
  net_dhcp efinet3 ; set nic_rc="$?"
  if [ "$nic_rc" = 0 ]; then set nic_ip="$net_efinet3_dhcp_ip" ; fi
fi
# Plain English, on the happy path, because a wall that is slow but talking is not a wall that has
# died (POL-118). This is progress, not diagnostics — D65 banned the second, not the first.
if [ -n "$nic_ip" ]; then echo "Got an address ($nic_ip) - fetching the boot menu ..." ; fi
configfile $net/boot/grub.cfg
EOF
cat <<EOF
}
# Reachable only via the hidden menu: press any key during the 1-second hidden timeout to open it.
menuentry "Debug console" --id debug {
  echo "Starting Polyptic with a root shell on tty9 (Ctrl+Alt+F9) ..."
  linux  $BOOT/vmlinuz $this_root systemd.debug-shell=1
  initrd $BOOT/initrd
}
EOF
exit 0
