/**
 * The GRUB boot theme a diskless box draws before it has an operating system (POL-47).
 *
 * THE PROBLEM. A wall screen's first frame used to be a bare text console reading
 * `Polyptic: streaming the amd64 live image into RAM ...` — a kernel-fetch narration written for
 * whoever built the netboot chain, shown to whoever walks past the wall. These are public signage
 * panels; the boot has to look like the product, not like a maintenance window.
 *
 * WHY IT CANNOT SIMPLY MOVE INTO THE PLYMOUTH SPLASH. Plymouth is a userspace daemon that starts
 * inside the initramfs — which GRUB has not fetched yet when it prints that line. Nothing in the
 * splash exists at the moment the message is written, so the message cannot be pushed into it. What
 * CAN happen is the reverse: GRUB paints its own screen, made to look like the splash, so the two
 * are continuous and the operator never sees the seam.
 *
 * WHY IT IS AFFORDABLE. GRUB is not usually a graphical thing, but Ubuntu's SIGNED network GRUB
 * (`grubnet{x64,aa64}.efi.signed`, the D47 loaders we pin and never rebuild) carries a squashfs
 * memdisk holding `fonts/unicode.pf2` — a full 2.4 MB Unicode PF2 — plus the `gfxterm`, `gfxmenu`
 * and `png` modules, on BOTH arches. So `loadfont (memdisk)/fonts/unicode.pf2` costs no network
 * round trip and needs no new file on the boot medium; the only thing the control plane has to serve
 * is this theme and the logo beside it. Secure Boot is untouched: a grub.cfg is not verified, and we
 * are not changing which binaries load.
 *
 * EVERY GRAPHICAL STEP IS GUARDED. The whole block hangs off `if loadfont ...; then`, so a GRUB that
 * cannot find the font, the modules, or a video mode simply keeps its text console and boots exactly
 * as before. A theme that fails to parse, or a `logo.png` that 404s, degrades to GRUB's plain menu.
 * Nothing here can stop a box from booting.
 */

/**
 * The rasterised lockup's pixel size (`packages/server/assets/boot-logo.png`, rebuilt by
 * `bun deploy/render-boot-logo.ts`). The theme paints it at exactly these dimensions so GRUB never
 * rescales it — a scaled PF2-era bitmap blit is visibly soft — which means the logo is a FIXED size
 * rather than a fraction of the panel. 480px reads as ~60% of the width on the 800x600 mode some
 * firmware hands GRUB, and ~25% on a 1080p panel: close to the 30% the Plymouth splash uses, and
 * legible either way for the few seconds this screen is up.
 */
export const BOOT_LOGO_WIDTH = 480;
export const BOOT_LOGO_HEIGHT = 210;

/**
 * Palette. These are the DARK Plymouth splash values (`packages/agent/src/setup/plymouth.ts`'s
 * `SPLASH_COLORS`) — `bg` above all, because GRUB's desktop and the splash's background meet at the
 * kernel hand-off and any difference reads as a flash. A test in `packages/e2e` imports both and
 * asserts they still agree, so this copy cannot silently drift.
 */
const BG = "#0b0b0d";
const MUTED = "#71717a";
const BRIGHT = "#fafafa";

/**
 * The font baked into the signed grubnet memdisk, by its declared PF2 `NAME`. If a future Ubuntu
 * grub2-signed build renames it, GRUB falls back to its built-in font: the theme still draws, the
 * labels just look different. (Read straight out of the pinned binary, not from documentation.)
 */
const FONT = "GNU Unifont Regular 16";

/**
 * The GRUB shell fragment that turns the text console into a graphical, Polyptic-branded one.
 * Emitted by BOTH stages of the boot chain — the boot medium's stage-1 config (which has no network
 * yet, so it gets the background but no theme) and the control plane's menu — because either can be
 * the first thing on screen: the dongle chains through stage 1, while UEFI HTTP Boot goes straight
 * to `/grub/grub.cfg`. Re-running it is harmless.
 *
 * `themeUrl` is a GRUB path (e.g. `$net/boot/theme.txt`); omit it for stage 1, which cannot fetch.
 *
 * `gfxmode=auto` + `gfxpayload=keep`, and NEVER a pinned resolution. Read `grub_video_gop_setup` before
 * touching either: `auto` means width=0/height=0, which makes GOP **keep the mode the firmware is
 * already in**, consulting EDID only when it must change modes and falling back to a hard-coded
 * 800x600 when that fails too. `keep` hands that same mode to the kernel, so the hand-off does not make
 * the panel re-sync. What the splash finally renders AT is D64's business, not ours: plymouth mode-sets
 * the connector's preferred mode once the real KMS driver loads, and re-lays-out when it does. GRUB's
 * mode only has to be *something sane*. (Under OVMF this all resolves to 800x600, because its GOP starts
 * there and offers no EDID. A VM artifact, not what a real panel does — hard-coding a size to "fix" it
 * is the thing D64 explicitly rejected, and it would be no more correct here.)
 */
export function bootGfxPreamble(themeUrl?: string): string[] {
  return [
    "# Paint the Polyptic splash rather than a text console (POL-47). The signed grubnet carries the",
    "# font + the gfx modules in its memdisk, so this costs no fetch. Guarded: a GRUB that cannot do",
    "# any of it keeps the plain console and boots identically.",
    "if loadfont (memdisk)/fonts/unicode.pf2 ; then",
    "  insmod all_video",
    "  insmod gfxterm",
    "  insmod gfxterm_background",
    "  insmod png",
    ...(themeUrl ? ["  insmod gfxmenu"] : []),
    "  set gfxmode=auto",
    "  set gfxpayload=keep",
    "  terminal_output gfxterm",
    `  background_color "${BG}"`,
    ...(themeUrl ? [`  set theme=${themeUrl}`] : ["  clear"]),
    "fi",
  ];
}

/**
 * The GRUB theme served at `GET /boot/theme.txt`. `logo.png` is deliberately relative: GRUB resolves
 * a theme's files against the theme's own directory, so it lands on `/boot/logo.png` of whichever
 * control plane the box is booting from, with no base URL baked in.
 *
 * `title-text: ""` deletes GRUB's "GNU GRUB version 2.12" banner. The `__timeout__` label is GRUB's
 * countdown hook (`%d` is the remaining seconds). Positions mix percentages and pixels so that the
 * lockup stays centred and the text below it keeps a constant gap from the lockup's bottom edge,
 * whatever mode the firmware hands us.
 */
export function buildBootThemeTxt(): string {
  const halfW = BOOT_LOGO_WIDTH / 2;
  // Constant offsets BELOW the logo's bottom edge (top = 24% + 210px), not fractions of the panel.
  const labelTop = `24%+${BOOT_LOGO_HEIGHT + 40}`;
  const menuTop = `24%+${BOOT_LOGO_HEIGHT + 90}`;
  // The 120px menu box holds the three flat entries D61 settled on (3x24 + 2x6 = 84px) with room for
  // a fourth before GRUB would need a scrollbar.
  //
  // GRUB left-aligns menu items inside their box and CLIPS what overflows, so the box has to fit the
  // longest title — measured, not computed: 400px cut "…without the USB st|ick" off, so Unifont's
  // effective advance here is ~9px, not the 8px a half-width cell suggests. 448px clears the 48-char
  // offload title with headroom. Wider than that and the (left-aligned) menu visibly drifts left of
  // the lockup it sits under.
  const menuWidth = 448;
  return `# Polyptic boot theme (POL-47), served by the control plane at /boot/theme.txt.
# GRUB draws this while it fetches the kernel; the Plymouth splash takes over from the same dark.
desktop-color: "${BG}"
title-text: ""
terminal-font: "${FONT}"

+ image {
    left = 50%-${halfW}
    top = 24%
    width = ${BOOT_LOGO_WIDTH}
    height = ${BOOT_LOGO_HEIGHT}
    file = "logo.png"
}

+ label {
    id = "__timeout__"
    text = "Starting in %d s"
    left = 0
    top = ${labelTop}
    width = 100%
    align = "center"
    color = "${MUTED}"
    font = "${FONT}"
}

+ boot_menu {
    left = 50%-${menuWidth / 2}
    top = ${menuTop}
    width = ${menuWidth}
    height = 120
    item_font = "${FONT}"
    item_color = "${MUTED}"
    selected_item_color = "${BRIGHT}"
    item_height = 24
    item_spacing = 6
    item_padding = 0
    item_icon_space = 0
    scrollbar = false
}
`;
}
