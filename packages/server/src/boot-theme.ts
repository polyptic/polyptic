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
 * The theme's desktop background image, `bg.png` — a tiny solid-`BG` PNG GRUB stretches over the
 * whole panel (POL-130). It exists because of how GRUB 2.12's gfxmenu initialises: EVERY view draw
 * runs `init_background()`, which hands `view->raw_desktop_image` to
 * `grub_video_bitmap_create_scaled()` UNCONDITIONALLY — and for a theme that sets only
 * `desktop-color`, that image is NULL. The scaler stashes `GRUB_ERR_BUG` ("null src bitmap in
 * grub_video_bitmap_create_scaled") in `grub_errno`, the menu still paints fine off `desktop-color`,
 * and the pending error then SURFACES the instant the chosen entry executes: an error line plus
 * "Press any key to continue" on a wall with no keyboard (the POL-87/POL-130 symptom, reproduced
 * frame-by-frame under OVMF — the menu is pixel-perfect at "Starting in 1 s" and errors at 0).
 * A real, decodable desktop-image is the only config-level fix; visually it is identical to the
 * `desktop-color` fill it replaces. `desktop-color` stays as the fallback for a GRUB that fails the
 * stretch for some other reason.
 *
 * The bytes are built HERE, dependency-free and byte-deterministic (a stored/uncompressed DEFLATE
 * block, so no zlib version can change the output): 8x8, 8-bit truecolour (colour type 2),
 * non-interlaced — the exact profile GRUB 2.12's `png.c` decodes. Committed as
 * `packages/server/assets/boot-bg.png` (regenerate with `bun deploy/render-boot-theme.ts`) and
 * served at `GET /boot/bg.png`; a test pins committed == generated.
 */
export const BOOT_BG_SIZE = 8;

export function bootBgPng(): Uint8Array {
  const [r, g, b] = [1, 3, 5].map((i) => Number.parseInt(BG.slice(i, i + 2), 16));
  const size = BOOT_BG_SIZE;

  const crcTable = new Uint32Array(256).map((_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c;
  });
  const crc32 = (bytes: Uint8Array): number => {
    let c = 0xffffffff;
    for (const byte of bytes) c = (crcTable[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const be32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
  const chunk = (type: string, data: number[]): number[] => {
    const body = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)).concat(data));
    return [...be32(data.length), ...body, ...be32(crc32(body))];
  };

  // Raw scanlines: each row is one filter byte (0 = None) + size solid-BG pixels.
  const raw: number[] = [];
  for (let y = 0; y < size; y++) {
    raw.push(0);
    for (let x = 0; x < size; x++) raw.push(r as number, g as number, b as number);
  }
  // zlib stream around ONE stored (uncompressed) DEFLATE block: header, BFINAL=1/BTYPE=00,
  // LEN/NLEN little-endian, the raw bytes, then the Adler-32 of them. GRUB's own inflate
  // handles stored blocks explicitly (png.c INFLATE_STORED).
  let a1 = 1;
  let a2 = 0;
  for (const byte of raw) {
    a1 = (a1 + byte) % 65521;
    a2 = (a2 + a1) % 65521;
  }
  const idat = [
    0x78, 0x01, 0x01,
    raw.length & 0xff, (raw.length >>> 8) & 0xff,
    ~raw.length & 0xff, (~raw.length >>> 8) & 0xff,
    ...raw,
    ...be32(((a2 << 16) | a1) >>> 0),
  ];

  return new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", [...be32(size), ...be32(size), 8, 2, 0, 0, 0]),
    ...chunk("IDAT", idat),
    ...chunk("IEND", []),
  ]);
}

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
# desktop-image is LOAD-BEARING, not decoration (POL-130): GRUB 2.12's gfxmenu scales the desktop
# image on EVERY view draw, and a theme with only desktop-color hands the scaler a NULL bitmap —
# the stashed error then paints "error: null src bitmap ... Press any key to continue" on the wall
# the moment the menu entry boots. bg.png is a tiny solid-colour PNG stretched over the panel;
# visually identical to the desktop-color fill, which stays as the fallback.
desktop-color: "${BG}"
desktop-image: "bg.png"
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
