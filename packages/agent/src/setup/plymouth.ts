/**
 * Boot-splash (Plymouth) theme generators for the cold-boot chain (POL-7).
 *
 * On cold boot the wall would otherwise show raw kernel/systemd console text until the compositor
 * comes up — and the same raw text on the way DOWN at shutdown/reboot. This module generates a small
 * branded **Plymouth** theme — a scalable vector logo, the build version + hostname, and a LIVE
 * status line — shown continuously from early boot until the player paints, AND again through
 * shutdown/reboot (the script keys off `Plymouth.GetMode()` to show "Starting up" vs "Shutting
 * down"/"Restarting"). No kernel/console text at either end (see docs/ARCHITECTURE.md "Boot splash").
 *
 * Everything here is a pure string generator (like ./templates.ts): the agent single binary carries
 * the whole theme as source and `install.ts` writes it out + rasterises the SVGs to PNG at provision
 * time. That keeps the zero-touch `curl|sh` path (which downloads ONLY the binary — D35) able to lay
 * down the splash with no extra assets to fetch.
 *
 * Why a *script* theme, not a static image (answering the "can it be live?" question): Plymouth's
 * `script` plugin gives us live callbacks — `SetUpdateStatusFunction` (systemd's "Starting …" unit
 * messages as boot advances), `SetBootProgressFunction` (a 0..1 fraction), and `SetMessageFunction`
 * (anything pushed with `plymouth message --text=…`, e.g. by the agent). So the splash is a live
 * boot readout, not a frozen picture. The version + hostname are known at provision time and baked
 * into the vector stamp; they can also be refreshed live via `plymouth message`.
 *
 * Swappability (POL-7 acceptance): the logo is a plain **SVG** (`logo.svg`) rasterised to `logo.png`
 * at install. Drop in the final designed asset (SVG preferred, or a pre-rendered `logo.png`) and
 * re-run `polyptic-agent setup` — nothing else changes. It is vector, so it scales to any panel.
 */

/** Installed theme name (what `plymouth-set-default-theme` selects). */
export const PLYMOUTH_THEME_NAME = "polyptic";
/** The directory Plymouth searches for themes — `plymouthd.conf`'s `ThemeDir=`. */
export const PLYMOUTH_THEMES_DIR = "/usr/share/plymouth/themes";
/** Where the theme's files live once installed. */
export const PLYMOUTH_THEME_DIR = `${PLYMOUTH_THEMES_DIR}/${PLYMOUTH_THEME_NAME}`;

/** systemd drop-in that makes plymouth-quit retain the last splash frame (seamless handoff). */
export const PLYMOUTH_QUIT_DROPIN =
  "/etc/systemd/system/plymouth-quit.service.d/10-polyptic-retain-splash.conf";

/** Plymouth's runtime config — the theme selector BOTH plymouthd and dracut honour (`[Daemon] Theme=`). */
export const PLYMOUTHD_CONF_PATH = "/etc/plymouth/plymouthd.conf";

/** dracut drop-in that force-includes the theme + its script plugin into the initramfs (POL-7). */
export const PLYMOUTH_DRACUT_CONF_PATH = "/etc/dracut.conf.d/polyptic-splash.conf";

/**
 * A dracut drop-in that force-bundles the given files into the initramfs, and puts the real KMS
 * drivers in there alongside them.
 *
 * WHY `install_items` (POL-7): dracut's `plymouth` module bundles the theme by running
 * `plymouth-populate-initrd`, and on Ubuntu 26.04 that script needs `plymouthd.conf` to name a
 * `ThemeDir=` as well as a `Theme=` before it will find ours (see `plymouthdConf`). Naming the files
 * here as well means the theme + its `script` plugin land in the initramfs verbatim, whatever that
 * script decides — a belt-and-braces path that does not depend on Plymouth's own theme resolution.
 *
 * WHY `add_dracutmodules+=" drm "` (POL-53): without it the splash renders at the firmware's
 * framebuffer resolution — commonly 1024×768 — and the panel upscales it, so a 1440p/4K wall shows a
 * soft, blocky logo. The chain: Ubuntu's `plymouthd.defaults` sets `UseSimpledrm=1`; dracut's
 * `plymouth` module reads that key and, when set, `depends()` on `simpledrm` INSTEAD of `drm`; the
 * `drm` module's own `check()` returns 255, so nothing else ever pulls it in. `simpledrm` is built
 * into Ubuntu's kernel (`CONFIG_DRM_SIMPLEDRM=y`) — a fixed-mode shim over whatever framebuffer the
 * firmware left behind, which cannot mode-set — while i915/amdgpu/… are modules the initramfs then
 * does not carry. So the console never leaves the firmware's mode, and by the time the real driver
 * loads off the root filesystem, plymouth has already read `Window.GetWidth()` once and laid the
 * whole splash out for the small framebuffer.
 *
 * Naming `drm` here puts the real KMS drivers in the initramfs; udev autoloads one by PCI modalias,
 * plymouth drops the simpledrm renderer for a real DRM one
 * (`create_devices_for_terminal_and_renderer_type` → `free_simpledrm_renderer`) and mode-sets the
 * connector's PREFERRED mode — so the panel is already at its native resolution before plymouth
 * starts.
 *
 * Cost: ~47 MiB of initramfs (73 → 120 MiB, measured on 26.04/amd64; ~13 MiB on arm64, which has no
 * Intel/AMD graphics firmware), all of it GPU modules plus the firmware they declare. A driver whose
 * firmware is outside the image's curated set simply fails to probe and the splash falls back to
 * simpledrm exactly as it does today — `FULL_FIRMWARE=1` (see deploy/build-live-image.sh) ships the
 * lot for hardware we did not anticipate.
 */
export function plymouthDracutConf(includePaths: readonly string[]): string {
  return `# ${MANAGED}
# Force the Polyptic splash theme + its script plugin into the dracut initramfs (POL-7). Belt and
# braces: plymouth-populate-initrd should bundle them off plymouthd.conf's Theme=/ThemeDir=, but
# naming them here means the theme lands whatever that script makes of our config.
install_items+=" ${includePaths.join(" ")} "

# Pull the real KMS drivers into the initramfs (POL-53). dracut's plymouth module depends on
# 'simpledrm' rather than 'drm' whenever plymouthd.defaults says UseSimpledrm=1 (Ubuntu's default),
# and 'drm' is never auto-detected — so without this line the only DRM driver in the initramfs is a
# fixed-mode shim over the firmware's framebuffer, and the splash is stuck at ~1024x768 on any panel.
# With a real driver loaded, plymouth mode-sets the connector's preferred (native) resolution.
add_dracutmodules+=" drm "
`;
}

const MANAGED = "generated by `polyptic-agent setup` — re-running setup may overwrite this file.";

// ── palette (the DARK variant of the Console Boot Splash design; 8-bit sRGB) ─────────────────────
// A wall powers on in a room that is often dim; a dark splash avoids a jarring white flash and
// matches the product's dark surfaces. Light-on-white is the design's alternate (not shipped).
const COLORS = {
  bg: "#0b0b0d", // page background
  holder: "#fafafa", // rounded logo holder
  glyph: "#161618", // the mark inside the holder
  glyphOpacity: 0.55, // side panels of the mark (centre bar is full opacity)
  wordmark: "#fafafa",
  subtitle: "#71717a",
  status: "#a1a1aa", // the live boot-status line
  stampHost: "#4b4d54",
  stampVersion: "#a1a1aa",
  track: "#26262b", // progress-bar track
  accent: "#2563eb", // progress-bar fill
} as const;

/** #rrggbb → "r, g, b" as Plymouth 0..1 floats (its colour args are normalised). */
function toPlymouthRgb(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const f = (n: number): string => n.toFixed(3);
  return `${f(r)}, ${f(g)}, ${f(b)}`;
}

// ── asset specs: which SVGs to rasterise, and to what pixel width (aspect preserved) ─────────────
// Rasterised generously above the on-screen size so the script's proportional down-scale stays crisp
// on a 4K panel. `height` is only set where the aspect must be forced (the thin solid bars).
export interface SplashAsset {
  /** Base filename (without extension) under the theme dir. */
  base: string;
  /** SVG source. */
  svg: string;
  /** Rasterise width in px. */
  width: number;
  /** Rasterise height in px (bars only — omit to preserve the SVG aspect ratio). */
  height?: number;
}

export interface StampParams {
  hostname: string;
  version: string;
}

/**
 * The placeholder logo — the Polyptic mark (two hinged side panels + a squared centre panel on a
 * rounded holder, matching packages/console Logo.vue) plus the wordmark + "display node" subtitle.
 * This is THE swappable asset (POL-7): replace logo.svg (or logo.png) with the final designed lockup
 * and re-run setup. Vector, so it scales to any panel.
 */
export function logoSvg(): string {
  const holder = 136;
  const holderX = (640 - holder) / 2; // 252
  // glyph: the 32×32 Logo.vue viewBox scaled to 98px, centred in the 136px holder.
  const glyphScale = 98 / 32;
  const glyphX = holderX + (holder - 98) / 2;
  const glyphY = (holder - 98) / 2;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED} Placeholder Polyptic logo lockup — swap for the final designed asset (keep it SVG). -->
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="280" viewBox="0 0 640 280" fill="none">
  <rect x="${holderX}" y="0" width="${holder}" height="${holder}" rx="33" fill="${COLORS.holder}"/>
  <g transform="translate(${glyphX} ${glyphY}) scale(${glyphScale})">
    <polygon points="6.6,11 12.3,8.2 12.3,23.8 6.6,21" fill="${COLORS.glyph}" opacity="${COLORS.glyphOpacity}"/>
    <polygon points="25.4,11 19.7,8.2 19.7,23.8 25.4,21" fill="${COLORS.glyph}" opacity="${COLORS.glyphOpacity}"/>
    <rect x="13.1" y="8" width="5.8" height="16" fill="${COLORS.glyph}"/>
  </g>
  <text x="320" y="216" text-anchor="middle" font-family="'Geist','Inter','Helvetica Neue',Arial,'DejaVu Sans',sans-serif" font-size="52" font-weight="600" letter-spacing="-1.4" fill="${COLORS.wordmark}">Polyptic</text>
  <text x="320" y="252" text-anchor="middle" font-family="'Geist Mono','DejaVu Sans Mono',monospace" font-size="16" font-weight="500" letter-spacing="5" fill="${COLORS.subtitle}">DISPLAY NODE</text>
</svg>
`;
}

/**
 * The bottom stamp: "<hostname> · v<version>", rendered from the build + host so the two facts Alex
 * called out are on-screen from early boot. Baked at provision time; also refreshable live via
 * `plymouth message`.
 */
export function stampSvg(p: StampParams): string {
  // Basic XML-escape so an exotic hostname can't break the SVG.
  const esc = (s: string): string =>
    s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const host = esc(p.hostname);
  const version = esc(p.version.startsWith("v") ? p.version : `v${p.version}`);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED} hostname + build version stamp. -->
<svg xmlns="http://www.w3.org/2000/svg" width="640" height="30" viewBox="0 0 640 30" fill="none">
  <text x="320" y="22" text-anchor="middle" font-family="'Geist Mono','DejaVu Sans Mono',monospace" font-size="20" letter-spacing="0.5">
    <tspan fill="${COLORS.stampHost}">${host}</tspan><tspan fill="${COLORS.stampHost}">   ·   </tspan><tspan fill="${COLORS.stampVersion}">${version}</tspan>
  </text>
</svg>
`;
}

function barSvg(fill: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED} -->
<svg xmlns="http://www.w3.org/2000/svg" width="260" height="4" viewBox="0 0 260 4" fill="none">
  <rect x="0" y="0" width="260" height="4" rx="2" fill="${fill}"/>
</svg>
`;
}

/** All SVG assets the theme needs, with their rasterise targets. */
export function splashAssets(stamp: StampParams): SplashAsset[] {
  return [
    { base: "logo", svg: logoSvg(), width: 1600 },
    { base: "stamp", svg: stampSvg(stamp), width: 1200 },
    { base: "bar-track", svg: barSvg(COLORS.track), width: 520, height: 8 },
    { base: "bar-fill", svg: barSvg(COLORS.accent), width: 520, height: 8 },
  ];
}

/** The theme descriptor Plymouth reads (`<name>.plymouth`). */
export function plymouthTheme(): string {
  return `# ${PLYMOUTH_THEME_NAME}.plymouth — ${MANAGED}
[Plymouth Theme]
Name=Polyptic
Description=Polyptic display node — branded boot splash with a live status line.
ModuleName=script

[script]
ImageDir=${PLYMOUTH_THEME_DIR}
ScriptFile=${PLYMOUTH_THEME_DIR}/${PLYMOUTH_THEME_NAME}.script
`;
}

/**
 * The Plymouth `script`-plugin program. Draws the centred logo, an animated progress bar, the live
 * boot-status line, and the hostname/version stamp — resolution-independent (everything is sized off
 * Window.GetWidth()/GetHeight()). Colours are baked from the palette above.
 *
 * NOTE: the Plymouth scripting language is a small C/JS-like DSL (fun/if/while, `.` members, colour
 * args as 0..1 floats). Two traps live in it. Text from Image.Text renders at the plugin's default
 * point size, so we proportionally Scale() it rather than depend on the (version-varying) font
 * argument. And `x = 1` inside a `fun` creates a function-LOCAL unless `x` already exists in an
 * enclosing scope — so every name layout() shares with the draw_* functions is initialised at the top
 * level first, or the readers silently see nothing and draw nothing.
 *
 * The whole layout lives in `layout()` and is re-run whenever the window changes size (POL-53). Top-
 * level script code runs ONCE, so a theme that reads `Window.GetWidth()` there and never looks again
 * is frozen at whatever the first framebuffer was. That is a live race, not a hypothetical: plymouthd
 * starts from `sysinit.target` while udev is still probing, so on a fast box it can paint before the
 * KMS driver has taken over from `simpledrm` — and the mode then changes underneath it. Sprites keep
 * their old sizes and positions, and the splash ends up small and off-centre in the corner of the
 * panel. Watching the window size on every refresh costs two integer reads a frame and makes the
 * theme correct whichever order that race resolves in.
 */
export function plymouthScript(): string {
  return `# ${PLYMOUTH_THEME_NAME}.script — ${MANAGED}
#
# A LIVE boot splash: the logo + version/host stamp are static branding; the status line and the
# progress bar update from Plymouth's boot callbacks as systemd brings the box up.

# ── background (${COLORS.bg}) ──────────────────────────────────────────────────
Window.SetBackgroundTopColor(${toPlymouthRgb(COLORS.bg)});
Window.SetBackgroundBottomColor(${toPlymouthRgb(COLORS.bg)});

# The same theme covers BOTH cold boot AND machine shutdown/reboot (systemd runs plymouth on the way
# down too), so no kernel/console text shows at either end. Pick the right status + only show the
# boot progress bar when actually booting.
boot_mode = Plymouth.GetMode();
initial_status = "Starting up";
show_bar = 1;
if (boot_mode == "shutdown") {
  initial_status = "Shutting down";
  show_bar = 0;
}
if (boot_mode == "reboot") {
  initial_status = "Restarting";
  show_bar = 0;
}
if (boot_mode == "updates") {
  initial_status = "Applying updates";
}

# ── text sizing ──────────────────────────────────────────────────────────────
# Image.Text renders at the label plugin's default point size, so we proportionally Scale() it for
# wall legibility rather than depend on the (version-varying) font argument. That leaves the status
# line a bitmap blown up ~2.3x on a 1440p panel — the softest thing on an otherwise crisp splash.
# Naming a Pango size in Image.Text would fix it, and is a follow-up: a first attempt stopped the
# line rendering at all, and this is a boot path where a mistake is a black screen on the wall.
fun scale_text(img, factor) {
  if (factor < 1) {
    factor = 1;
  }
  return img.Scale(img.GetWidth() * factor, img.GetHeight() * factor);
}

# ── sprites: created ONCE, sized and placed by layout() ──────────────────────
# Every sprite is born WITH an image. An image-less Sprite() is refreshed every frame by the script
# plugin, and plymouth 5.x (Ubuntu 26.04) SEGFAULTS compositing one (script_lib_sprite_refresh) —
# which crashed plymouthd and killed the splash on a normal boot (POL-7).
logo.image = Image("logo.png");
logo.have = 0;
if (logo.image.GetWidth() > 0) {
  logo.have = 1;
  logo.sprite = Sprite(logo.image);
  logo.sprite.SetZ(10);
}

bar.track_img = Image("bar-track.png");
bar.fill_img = Image("bar-fill.png");
bar.have = 0;
if (show_bar == 1) {
  if (bar.track_img.GetWidth() > 0) {
    bar.have = 1;
    bar.track = Sprite(bar.track_img);
    bar.track.SetZ(11);
    bar.fill = Sprite(bar.fill_img);
    bar.fill.SetZ(12);
  }
}

stamp.image = Image("stamp.png");
stamp.have = 0;
if (stamp.image.GetHeight() > 0) {
  stamp.have = 1;
  stamp.sprite = Sprite(stamp.image);
  stamp.sprite.SetZ(11);
}

status.sprite = Sprite(Image.Text(initial_status, ${toPlymouthRgb(COLORS.status)}));
status.sprite.SetZ(11);
status.text = initial_status;

# operator/agent pushes: \`plymouth message --text="…"\` show just under the status line. The sprite is
# created lazily on the first message — on a normal boot none ever arrives.
message.have = 0;
message.text = "";

target_progress = 0;
progress = 0;

# Declared HERE, at the top level, on purpose. Plymouth's DSL creates a function-LOCAL on assignment
# unless the name already exists in an enclosing scope: were these first assigned inside layout(),
# draw_status() and draw_fill() would read an unset global and silently draw nothing (they did).
sw = 0;
sh = 0;
cx = 0;

fun draw_fill(p) {
  if (bar.have == 1) {
    if (p < 0) {
      p = 0;
    }
    if (p > 1) {
      p = 1;
    }
    w = bar.w * p;
    if (w < 1) {
      w = 1;
    }
    bar.fill.SetImage(bar.fill_img.Scale(w, bar.h));
  }
}

fun draw_status() {
  if (status.text != "") {
    img = scale_text(Image.Text(status.text, ${toPlymouthRgb(COLORS.status)}), sh / 620);
    # Never hand a sprite a null/zero image: systemd pushes an empty status when a job settles, and an
    # image-less sprite segfaults the script plugin on the next frame (POL-7). Keep the last good line.
    if (img.GetHeight() > 0) {
      # keep a long systemd status string from spilling past the panel edges
      if (img.GetWidth() > sw * 0.8) {
        img = img.Scale(sw * 0.8, img.GetHeight() * (sw * 0.8) / img.GetWidth());
      }
      status.sprite.SetImage(img);
      status.sprite.SetX(cx - img.GetWidth() / 2);
      status.sprite.SetY(status.y);
    }
  }
}

fun draw_message() {
  if (message.text != "") {
    img = scale_text(Image.Text(message.text, ${toPlymouthRgb(COLORS.status)}), sh / 700);
    if (img.GetHeight() > 0) {
      if (message.have == 0) {
        message.sprite = Sprite(img);
        message.have = 1;
        message.sprite.SetZ(11);
      } else {
        message.sprite.SetImage(img);
      }
      message.sprite.SetX(cx - img.GetWidth() / 2);
      message.sprite.SetY(message.y);
    }
  }
}

# ── layout: everything sized off the CURRENT window, re-run whenever it changes ──
fun layout() {
  sw = Window.GetWidth();
  sh = Window.GetHeight();
  cx = sw / 2;

  # logo lockup (centred, ~30% of screen width)
  content_bottom = sh * 0.45;
  if (logo.have == 1) {
    s = (sw * 0.30) / logo.image.GetWidth();
    img = logo.image.Scale(logo.image.GetWidth() * s, logo.image.GetHeight() * s);
    logo.sprite.SetImage(img);
    logo.y = sh * 0.30 - img.GetHeight() / 2;
    logo.sprite.SetX(cx - img.GetWidth() / 2);
    logo.sprite.SetY(logo.y);
    content_bottom = logo.y + img.GetHeight();
  }

  # progress bar (determinate; driven by SetBootProgressFunction)
  bar.w = sw * 0.135;
  bar.h = sh * 0.0037;
  if (bar.h < 3) {
    bar.h = 3;
  }
  bar.x = cx - bar.w / 2;
  bar.y = content_bottom + sh * 0.10;
  if (bar.have == 1) {
    bar.track.SetImage(bar.track_img.Scale(bar.w, bar.h));
    bar.track.SetX(bar.x);
    bar.track.SetY(bar.y);
    bar.fill.SetX(bar.x);
    bar.fill.SetY(bar.y);
    draw_fill(progress);
  }

  # live boot-status line, and any operator message just under it
  status.y = bar.y + sh * 0.055;
  draw_status();
  message.y = status.y + sh * 0.05;
  if (message.have == 1) {
    draw_message();
  }

  # hostname / version stamp: sized by height (~2.6% of screen) so it reads the same on any panel
  if (stamp.have == 1) {
    s = (sh * 0.026) / stamp.image.GetHeight();
    img = stamp.image.Scale(stamp.image.GetWidth() * s, stamp.image.GetHeight() * s);
    stamp.sprite.SetImage(img);
    stamp.sprite.SetX(cx - img.GetWidth() / 2);
    stamp.sprite.SetY(sh - sh * 0.06 - img.GetHeight() / 2);
  }
}
layout();

# ── live callbacks ────────────────────────────────────────────────────────────
Plymouth.SetBootProgressFunction(fun (duration, prog) {
  target_progress = prog;
});

# systemd pushes an EMPTY status when a job settles. Ignoring it keeps the last real line on screen
# instead of blinking the splash's only live element in and out on every unit transition.
Plymouth.SetUpdateStatusFunction(fun (text) {
  if (text != "") {
    if (text != status.text) {
      status.text = text;
      draw_status();
    }
  }
});

Plymouth.SetMessageFunction(fun (text) {
  if (text != "") {
    message.text = text;
    draw_message();
  }
});

# Re-lay-out the moment the window changes size — the KMS driver can take over from simpledrm (and
# mode-set to the panel's native resolution) after plymouth has already painted. Then ease the bar
# towards the latest target so it never jumps.
Plymouth.SetRefreshFunction(fun () {
  if (Window.GetWidth() != sw) {
    layout();
  }
  if (Window.GetHeight() != sh) {
    layout();
  }
  progress = progress + (target_progress - progress) * 0.08;
  draw_fill(progress);
});
`;
}

/**
 * The `plymouthd.conf` that selects our theme — the PORTABLE, authoritative selector.
 *
 * Modern Plymouth reads `[Daemon] Theme=` here, and (crucially) **dracut** copies the theme named
 * here into the initramfs when it builds it. Ubuntu 26.04 ships NO `plymouth-set-default-theme`
 * helper and builds its initramfs with dracut, so writing this file is the ONLY reliable way to
 * select the theme there — the Debian `default.plymouth` alternative that the helper managed is an
 * initramfs-tools-only mechanism dracut ignores. (Depending on the helper is what left the splash
 * on the stock theme — POL-7.) Harmless on initramfs-tools boxes, which also honour this key.
 *
 * `ThemeDir=` is what makes this file live up to "authoritative" (POL-53). `plymouth-populate-initrd`
 * — the script dracut's `plymouth` module shells out to — resolves the theme in `set_theme_dir()`,
 * and it only believes `plymouthd.conf` when **both** `ThemeDir` and `Theme` are set and the directory
 * exists. With `Theme=` alone it falls through to `update-alternatives --query default.plymouth`. That
 * works today only because install.ts registers that alternative (step 2b) — and it does so with
 * `allowFail`. Should the registration ever not take, the theme resolves to the literal name `none`,
 * `ModuleName` comes back empty, and the script exits 1 with "The default plymouth plugin () doesn't
 * exist" — an error dracut throws away (`2> /dev/null`). It dies BEFORE the block that installs
 * plymouth's systemd units, so `plymouth-start.service` would never reach the initramfs: plymouthd
 * would not run there at all, the screen would sit on console text until switch-root, and POL-35's
 * `plymouth display-message` narration hooks would address a daemon that does not exist. Verified in
 * a 26.04 container: with no alternative registered, `Theme=` alone exits 1 and installs zero units,
 * while `Theme=` + `ThemeDir=` exits 0 and installs all ten. One extra key, one less thing to depend on.
 */
export function plymouthdConf(): string {
  return `# ${MANAGED}
# Selects the Polyptic boot splash. Read by plymouthd AND by dracut when it builds the initramfs.
# ThemeDir accompanies Theme on purpose: plymouth-populate-initrd ignores a Theme= it cannot pair with
# a ThemeDir=, and falls back to the default.plymouth alternative. With neither, it resolves the theme
# to 'none' and aborts before installing plymouth's systemd units into the initramfs — which would
# leave plymouthd unable to start there at all (POL-53).
[Daemon]
Theme=${PLYMOUTH_THEME_NAME}
ThemeDir=${PLYMOUTH_THEMES_DIR}
`;
}

/** The plymouth-quit drop-in: retain the last splash frame so sway can paint over it (no flash). */
export function plymouthQuitDropin(): string {
  return `# ${MANAGED}
# Keep the final splash frame on screen when Plymouth quits, so the compositor paints straight over
# it with no flash of a blank console between the splash and the player (POL-7 clean hand-off).
[Service]
ExecStart=
ExecStart=-/usr/bin/plymouth quit --retain-splash
`;
}

// ── kernel cmdline merge (pure + testable) ───────────────────────────────────────────────────────

/** Tokens that route boot output to the splash instead of the console. */
export const SPLASH_CMDLINE_TOKENS = ["quiet", "splash", "plymouth.ignore-serial-consoles"] as const;

/**
 * Ensure `GRUB_CMDLINE_LINUX_DEFAULT` in an /etc/default/grub body contains every splash token,
 * without disturbing anything else the operator set. Returns the (possibly unchanged) new body.
 * Idempotent — running it twice is a no-op. If the key is absent it is appended.
 */
export function mergeGrubCmdline(body: string, tokens: readonly string[] = SPLASH_CMDLINE_TOKENS): string {
  const key = "GRUB_CMDLINE_LINUX_DEFAULT";
  const lineRe = new RegExp(`^(\\s*${key}\\s*=\\s*)(["'])([\\s\\S]*?)\\2(\\s*)$`, "m");
  const m = lineRe.exec(body);
  if (!m) {
    const existing = new Set<string>();
    const added = tokens.filter((t) => !existing.has(t));
    const line = `${key}="${added.join(" ")}"`;
    return body.endsWith("\n") || body.length === 0 ? `${body}${line}\n` : `${body}\n${line}\n`;
  }
  const [, prefix, quote, current] = m;
  const present = new Set((current ?? "").split(/\s+/).filter((t) => t.length > 0));
  const missing = tokens.filter((t) => !present.has(t));
  if (missing.length === 0) return body; // already complete
  const merged = [...(current ?? "").split(/\s+/).filter((t) => t.length > 0), ...missing].join(" ");
  return body.replace(lineRe, `${prefix}${quote}${merged}${quote}`);
}

/**
 * Ensure a bare kernel cmdline file (Raspberry Pi / u-boot `cmdline.txt`, a single space-separated
 * line) contains every splash token. Returns the (possibly unchanged) new body.
 */
export function mergeCmdlineTxt(body: string, tokens: readonly string[] = SPLASH_CMDLINE_TOKENS): string {
  const line = body.split(/\r?\n/).find((l) => l.trim().length > 0) ?? "";
  const present = new Set(line.split(/\s+/).filter((t) => t.length > 0));
  const missing = tokens.filter((t) => !present.has(t));
  if (missing.length === 0) return body;
  const merged = [...line.split(/\s+/).filter((t) => t.length > 0), ...missing].join(" ");
  if (line.length === 0) return `${merged}\n`;
  return body.replace(line, merged);
}
