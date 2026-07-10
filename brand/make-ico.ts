/**
 * Pack the rasterized PNGs into a multi-resolution `favicon.ico`.
 *
 * Called by generate.sh after rsvg-convert has written png/icon-<size>.png. We build the ICO by hand
 * rather than shelling out to ImageMagick so the generator's only binary dependency stays librsvg.
 *
 * The container stores each size as a whole PNG stream (PNG-in-ICO). That's the modern encoding —
 * understood by every browser we target and by Windows Vista+ — and it means we can embed the
 * already-generated PNGs verbatim instead of re-encoding them as BMP + AND-mask.
 *
 * The ICO carries the CANONICAL mark (dark holder, light panels): it is the fallback for browsers
 * that ignore the colour-scheme-aware favicon.svg, and a light-on-dark mark reads on either tab strip.
 *
 * Layout (little-endian):
 *   ICONDIR       6 bytes   reserved=0, type=1 (icon), count
 *   ICONDIRENTRY  16 bytes  × count
 *   image data              the PNG streams, in directory order
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Sizes embedded in the .ico. 16/32 cover tab + bookmark bar; 48 covers Windows shortcuts. */
const SIZES = [16, 32, 48] as const;

const ICONDIR_BYTES = 6;
const ICONDIRENTRY_BYTES = 16;

const images = SIZES.map((size) => ({ size, png: readFileSync(join(here, "png", `icon-${size}.png`)) }));

const dir = Buffer.alloc(ICONDIR_BYTES + ICONDIRENTRY_BYTES * images.length);
dir.writeUInt16LE(0, 0); // reserved
dir.writeUInt16LE(1, 2); // type: 1 = icon
dir.writeUInt16LE(images.length, 4);

// Image data begins immediately after the directory; each entry points at its own PNG stream.
let offset = dir.length;
images.forEach(({ size, png }, i) => {
  const at = ICONDIR_BYTES + ICONDIRENTRY_BYTES * i;
  dir.writeUInt8(size === 256 ? 0 : size, at); // width  (0 encodes 256)
  dir.writeUInt8(size === 256 ? 0 : size, at + 1); // height (0 encodes 256)
  dir.writeUInt8(0, at + 2); // palette size: 0 = truecolour
  dir.writeUInt8(0, at + 3); // reserved
  dir.writeUInt16LE(1, at + 4); // colour planes
  dir.writeUInt16LE(32, at + 6); // bits per pixel (RGBA)
  dir.writeUInt32LE(png.length, at + 8);
  dir.writeUInt32LE(offset, at + 12);
  offset += png.length;
});

const out = join(here, "favicon.ico");
writeFileSync(out, Buffer.concat([dir, ...images.map((i) => i.png)]));
console.log(`Wrote ${out} (${SIZES.join(", ")} px, ${offset} bytes)`);
