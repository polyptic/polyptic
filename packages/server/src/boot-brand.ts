/**
 * The control plane's own rasteriser for the boot lockup (POL-194).
 *
 * `GET /boot/logo.png` is the image the GRUB menu draws, and — through POL-80's `heal_boot_theme` —
 * the image every offline medium and installed ESP re-pulls onto itself each poll. When an operator
 * saves a brand, THIS is what turns their SVG into that PNG.
 *
 * TWO RULES, both learned the hard way.
 *
 * 1. NEVER SERVE A BITMAP GRUB CANNOT DECODE. A PNG that exists but does not *load* paints
 *    "error: null src bitmap … Press any key to continue" on a wall with no keyboard, and the box
 *    stops there. That is POL-87, and then POL-130 again. So the render is put through the SAME
 *    `grub-png-check.sh` the medium bake and the on-box self-heal use — the one gate, not a second
 *    opinion — and anything it rejects is thrown away in favour of the committed default.
 *
 * 2. NO RASTERISER IS A DEGRADATION, NOT A FAILURE. If `rsvg-convert` is missing (a server image
 *    built without `librsvg2-bin`), the route serves the committed `boot-logo.png` and the console
 *    says why in a sentence — D115's adapter posture. A boot path never 404s and never 500s over
 *    branding.
 *
 * The result is cached in memory, keyed by the brand it was rendered from: the GRUB menu, every
 * booting box and every polling medium hit this route, and none of them should cost a subprocess.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { SPLASH_COLORS, logoSvg } from "@polyptic/protocol";
import type { BootBrand } from "@polyptic/protocol";

import { BOOT_LOGO_HEIGHT, BOOT_LOGO_WIDTH } from "./boot-theme";

const run = promisify(execFile);

/** The shell gate every writer of GRUB theme bitmaps runs (POL-130). Shipped in the server image
 *  alongside the rest of `deploy/live`, so this resolves in the container and from the repo alike. */
const PNG_CHECK = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "..",
  "deploy/live/usr/local/lib/polyptic/grub-png-check.sh",
);

/** The sentence the console shows when this server cannot rasterise at all. */
export const NO_RASTERISER_NOTE =
  "This control plane has no SVG rasteriser, so boot screens are still showing the Polyptic logo. " +
  "Install librsvg2-bin in the server image (or use a build that ships it) and save again.";

/** The sentence for a render that came out as something GRUB would refuse to draw. */
export const UNRENDERABLE_NOTE =
  "The mark rendered to an image GRUB cannot draw, so boot screens are still showing the Polyptic " +
  "logo. Simplify the artwork — flatten filters and effects to plain paths — and save again.";

export interface RenderedBootLogo {
  /** The rasterised lockup, or null when the committed default should be served instead. */
  png: Buffer | null;
  /** Why `png` is null, or null when the render is the operator's brand. */
  note: string | null;
}

/**
 * Rasterises the boot lockup on demand and remembers the last answer.
 *
 * `rsvgCmd` is injectable for the same reason the document converter's binaries are: it is the seam
 * a deployment substitutes at, and a test can point it at something that is definitely absent.
 */
export class BootLogoRenderer {
  private availability?: Promise<boolean>;
  private cacheKey = "";
  private cached: RenderedBootLogo = { png: null, note: null };

  constructor(private readonly rsvgCmd: string = "rsvg-convert") {}

  /** Can this host rasterise at all? Probed once, then remembered (every boot hits this path). */
  available(): Promise<boolean> {
    this.availability ??= run(this.rsvgCmd, ["--version"], { timeout: 10_000 }).then(
      () => true,
      () => false,
    );
    return this.availability;
  }

  /** Drop the cached render — called on save, so the next fetch rasterises the new brand. */
  invalidate(): void {
    this.cacheKey = "";
    this.cached = { png: null, note: null };
  }

  /**
   * The PNG to serve for this brand, or `{ png: null }` to fall back to the committed default.
   *
   * A default brand (no mark, no wordmark) short-circuits: the committed raster IS that render, and
   * re-making it on a boot path would only add a subprocess and a way to fail.
   */
  async render(brand: BootBrand): Promise<RenderedBootLogo> {
    if (!brand.markSvg && !brand.wordmark.trim()) return { png: null, note: null };

    const key = `${brand.updatedAt ?? ""}|${brand.wordmark}|${brand.markSvg?.length ?? 0}`;
    if (key === this.cacheKey) return this.cached;

    const result = await this.rasterise(brand);
    this.cacheKey = key;
    this.cached = result;
    return result;
  }

  private async rasterise(brand: BootBrand): Promise<RenderedBootLogo> {
    if (!(await this.available())) return { png: null, note: NO_RASTERISER_NOTE };

    // The background is baked in (rather than left transparent, as Plymouth's copy is) so GRUB never
    // composites alpha over `desktop-color`; the two must be the same dark or the seam shows.
    const svg = logoSvg({
      markSvg: brand.markSvg,
      wordmark: brand.wordmark,
      background: SPLASH_COLORS.bg,
    });

    const dir = await mkdtemp(join(tmpdir(), "polyptic-boot-logo-"));
    const svgPath = join(dir, "logo.svg");
    const pngPath = join(dir, "logo.png");
    try {
      await writeFile(svgPath, svg, "utf8");
      await run(
        this.rsvgCmd,
        ["-w", String(BOOT_LOGO_WIDTH), "-h", String(BOOT_LOGO_HEIGHT), "-o", pngPath, svgPath],
        { timeout: 30_000 },
      );
      // "File exists" is not "file loads" — the POL-130 gate, run against our OWN output before it
      // can reach a wall.
      await run("sh", [PNG_CHECK, pngPath], { timeout: 20_000 });
      const png = await readFile(pngPath);
      return { png, note: null };
    } catch {
      return { png: null, note: UNRENDERABLE_NOTE };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
