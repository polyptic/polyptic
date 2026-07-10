#!/usr/bin/env bun
/**
 * Regenerate `packages/server/assets/boot-logo.png`, the one image the GRUB boot theme draws (POL-47).
 *
 *     bun deploy/render-boot-logo.ts
 *
 * WHY A CHECKED-IN RASTER. Everything else in the boot chain paints from vector: the Plymouth theme
 * ships `logo.svg` and `polyptic-agent setup` rasterises it on the box. GRUB has no SVG renderer and
 * no rasteriser — its theme engine takes PNG/JPEG only — and the control plane serves the theme over
 * plain HTTP to a machine with no operating system yet, so there is nowhere to render at boot. The
 * PNG is therefore built here, from the SAME `logoSvg()` the splash uses, and committed.
 *
 * The background is baked in (rather than left transparent, as Plymouth's copy is) so GRUB never has
 * to composite alpha over `desktop-color`; the two must be the same dark or the seam shows.
 *
 * Re-run this whenever `logoSvg()` or the palette changes — `bun test` fails if the committed PNG
 * stops matching the source's declared dimensions, but it cannot see a stale drawing.
 *
 * PREREQUISITE: `rsvg-convert` (brew install librsvg / apt-get install librsvg2-bin). Any DejaVu-class
 * sans is fine: the lockup names Geist/Inter first and falls back exactly as the box does.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { logoSvg, SPLASH_COLORS } from "../packages/agent/src/setup/plymouth.ts";
import { BOOT_LOGO_HEIGHT, BOOT_LOGO_WIDTH } from "../packages/server/src/boot-theme.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(REPO_ROOT, "packages/server/assets/boot-logo.png");

const tmp = resolve(REPO_ROOT, "packages/server/assets/.boot-logo.svg");
await mkdir(dirname(OUT), { recursive: true });
await writeFile(tmp, logoSvg({ background: SPLASH_COLORS.bg }), "utf8");

const proc = Bun.spawn(
  ["rsvg-convert", "-w", String(BOOT_LOGO_WIDTH), "-h", String(BOOT_LOGO_HEIGHT), "-o", OUT, tmp],
  { stderr: "inherit" },
);
const code = await proc.exited;
await rm(tmp, { force: true });
if (code !== 0) {
  console.error("render-boot-logo: rsvg-convert failed (is librsvg installed?)");
  process.exit(1);
}
console.log(`render-boot-logo: wrote ${OUT} (${BOOT_LOGO_WIDTH}x${BOOT_LOGO_HEIGHT})`);
