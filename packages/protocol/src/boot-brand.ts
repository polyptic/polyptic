/**
 * @polyptic/protocol/boot-brand — the boot lockup, and the operator's brand inside it (POL-194).
 *
 * WHY THIS LIVES IN THE SHARED CONTRACT. `logoSvg()` is the single source for every branded screen
 * the boot chain paints, and three separate processes render it:
 *
 *   - `polyptic-agent setup` rasterises it into the Plymouth theme on the box (POL-7);
 *   - `deploy/render-boot-logo.ts` rasterises the same function into the PNG the GRUB theme draws,
 *     and the CONTROL PLANE rasterises it again whenever an operator saves a brand (POL-194);
 *   - the console draws it straight into the DOM as the Settings ▸ Branding preview.
 *
 * They agree because they call one function, not because three copies were kept in step. It sat in
 * `packages/agent/src/setup/plymouth.ts` while the agent was its only renderer; the console and the
 * server cannot import the agent, so it moved HERE — the one package all four already depend on.
 * `plymouth.ts` re-exports it, so nothing that used to import it from there had to change.
 *
 * A CUSTOM BRAND IS TWO INPUTS AND NOTHING ELSE (the POL-194 no-gos). An SVG mark replaces the glyph;
 * a typed wordmark replaces "Polyptic". "DISPLAY NODE" stays, the palette stays, and the layout stays
 * — the GRUB theme paints this lockup at exactly 480x210 with no rescale, so its proportions are
 * load-bearing rather than decorative.
 */
import { z } from "zod";

// ── palette (the DARK variant of the Console Boot Splash design; 8-bit sRGB) ─────────────────────
// A wall powers on in a room that is often dim; a dark splash avoids a jarring white flash and
// matches the product's dark surfaces. Light-on-white is the design's alternate (not shipped).
//
// Exported as SPLASH_COLORS for the two other things that paint a Polyptic boot screen: the Plymouth
// theme (which bakes these into its script) and the GRUB boot menu (POL-47), which runs before
// Plymouth exists and renders its own splash from a theme the control plane serves. The two screens
// must be the same dark or the hand-off flashes; a test in `packages/e2e` imports both and asserts it.
export const SPLASH_COLORS = {
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

/** The lockup's own coordinate system. GRUB paints the raster at 480x210 (BOOT_LOGO_*), so this is
 *  a fixed drawing, not a responsive one — the mark's slot is 136x136 and cannot grow. */
const LOCKUP_WIDTH = 640;
const LOCKUP_HEIGHT = 280;
const MARK_SLOT = 136;

/**
 * How many characters a wordmark may carry.
 *
 * There are NO font metrics on any of the three rasterisers, so a long company name cannot be
 * measured against the 640-wide lockup — it can only be bounded. 28 characters at the stepped-down
 * size below stays inside the drawing with room to spare; past that the cap refuses rather than
 * letting the wordmark run off the edge of a wall.
 */
export const BOOT_BRAND_WORDMARK_MAX = 28;

/** The largest an uploaded mark may be. A logo is paths; a quarter of a megabyte of them is already
 *  far more than any brand team ships, and the cap stops a pathological file reaching a rasteriser. */
export const BOOT_BRAND_MARK_MAX_BYTES = 256 * 1024;

/** Basic XML-escape so an exotic wordmark can't break the SVG (shared with `stampSvg`'s hostname). */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * The wordmark's type size, stepped down for a long name.
 *
 * "Polyptic" and anything else short keeps the designed 52px. Beyond that the size shrinks so the
 * string stays inside ~560px of the 640-wide lockup, using a crude 0.55-em average advance for a
 * 600-weight sans — crude because there are no metrics to be precise with, and deliberately
 * conservative so the estimate errs small. 24px is the floor: below that the wordmark stops being
 * legible on a wall, and the character cap is what stops anything reaching it.
 */
export function wordmarkFontSize(wordmark: string): number {
  const len = Math.max(wordmark.trim().length, 1);
  const fitted = 560 / (0.55 * len);
  return Math.max(24, Math.min(52, Math.round(fitted * 10) / 10));
}

export interface BrandInputs {
  /** The operator's mark, as SVG source. Validated by `validateBrandMark` BEFORE it gets here. */
  markSvg?: string | null;
  /** The word beside/below the mark. Empty or absent keeps "Polyptic". */
  wordmark?: string | null;
}

export interface LogoSvgOptions extends BrandInputs {
  /** Paint an opaque field behind the lockup (GRUB wants a tile; Plymouth composites transparency). */
  background?: string;
}

/**
 * The boot lockup: a mark, a wordmark, and the "DISPLAY NODE" subtitle, on the splash dark.
 *
 * With no brand this is the Polyptic mark (two hinged side panels + a squared centre panel on a
 * rounded white holder, matching packages/console Logo.vue) and the Polyptic wordmark.
 *
 * With a custom mark THE WHITE ROUNDED HOLDER DISAPPEARS (POL-194). The holder exists to give the
 * Polyptic glyph — which is dark — something to sit on; keeping it under someone else's mark would
 * make a light logo invisible, and deciding per-upload which way round to paint it would mean
 * inspecting the customer's artwork and guessing. The mark sits directly on the splash dark and owns
 * its own background, which is the thing a brand team can actually control.
 *
 * Plymouth composites the lockup over its own background and wants it transparent; GRUB's theme
 * engine is happier with an opaque tile, so `background` paints the field behind it (POL-47, used by
 * `deploy/render-boot-logo.ts` and by the control plane's own render).
 */
export function logoSvg(opts: LogoSvgOptions = {}): string {
  const markX = (LOCKUP_WIDTH - MARK_SLOT) / 2; // 252
  const field = opts.background
    ? `\n  <rect x="0" y="0" width="${LOCKUP_WIDTH}" height="${LOCKUP_HEIGHT}" fill="${opts.background}"/>`
    : "";
  const wordmark = (opts.wordmark ?? "").trim() || "Polyptic";
  const fontSize = wordmarkFontSize(wordmark);
  // The designed tracking is -1.4 at 52px; scaling it with the type keeps a stepped-down wordmark
  // looking like the same drawing rather than a differently-spaced one.
  const tracking = Math.round((-1.4 * fontSize) / 52 / 0.1) * 0.1;
  const mark = opts.markSvg ? customMark(opts.markSvg, markX) : polypticMark(markX);
  return `<?xml version="1.0" encoding="UTF-8"?>
<!-- ${MANAGED} -->
<svg xmlns="http://www.w3.org/2000/svg" width="${LOCKUP_WIDTH}" height="${LOCKUP_HEIGHT}" viewBox="0 0 ${LOCKUP_WIDTH} ${LOCKUP_HEIGHT}" fill="none">${field}
${mark}
  <text x="320" y="216" text-anchor="middle" font-family="'Geist','Inter','Helvetica Neue',Arial,'DejaVu Sans',sans-serif" font-size="${fontSize}" font-weight="600" letter-spacing="${tracking.toFixed(1)}" fill="${SPLASH_COLORS.wordmark}">${escapeXml(wordmark)}</text>
  <text x="320" y="252" text-anchor="middle" font-family="'Geist Mono','DejaVu Sans Mono',monospace" font-size="16" font-weight="500" letter-spacing="5" fill="${SPLASH_COLORS.subtitle}">DISPLAY NODE</text>
</svg>
`;
}

const MANAGED =
  "generated by @polyptic/protocol logoSvg() — the ONE source for every branded boot screen (POL-7/POL-47/POL-194).";

/** The shipped Polyptic lockup: the glyph on its rounded white holder. */
function polypticMark(markX: number): string {
  // glyph: the 32x32 Logo.vue viewBox scaled to 98px, centred in the 136px holder.
  const glyphScale = 98 / 32;
  const glyphX = markX + (MARK_SLOT - 98) / 2;
  const glyphY = (MARK_SLOT - 98) / 2;
  return `  <rect x="${markX}" y="0" width="${MARK_SLOT}" height="${MARK_SLOT}" rx="33" fill="${SPLASH_COLORS.holder}"/>
  <g transform="translate(${glyphX} ${glyphY}) scale(${glyphScale})">
    <polygon points="6.6,11 12.3,8.2 12.3,23.8 6.6,21" fill="${SPLASH_COLORS.glyph}" opacity="${SPLASH_COLORS.glyphOpacity}"/>
    <polygon points="25.4,11 19.7,8.2 19.7,23.8 25.4,21" fill="${SPLASH_COLORS.glyph}" opacity="${SPLASH_COLORS.glyphOpacity}"/>
    <rect x="13.1" y="8" width="5.8" height="16" fill="${SPLASH_COLORS.glyph}"/>
  </g>`;
}

/**
 * The operator's mark, dropped into the 136x136 slot as a NESTED `<svg>`.
 *
 * A nested `<svg>` is the whole trick: it establishes its own viewport, so the uploaded artwork
 * scales and centres itself against its own `viewBox` with `preserveAspectRatio="xMidYMid meet"` and
 * nothing has to be parsed out of it. Only the ROOT tag is rewritten — its sizing attributes are
 * replaced with the slot's, every other attribute (xmlns, xmlns:xlink, fill, stroke, style, …) is
 * carried through untouched, and the artwork inside is copied verbatim.
 *
 * `validateBrandMark` has already refused anything that could make that dangerous or unrenderable:
 * scripts, foreignObject, text, entities, and any reference that is not a `#fragment` or a `data:`
 * URI. This function assumes a validated string and does no checking of its own.
 */
function customMark(markSvg: string, markX: number): string {
  const stripped = stripPreamble(markSvg);
  const open = /<svg\b([^>]*)>/i.exec(stripped);
  if (!open) return "";
  const attrs = parseAttrs(open[1] ?? "");
  const viewBox = attrs.get("viewbox") ?? "0 0 100 100";
  const keep = rawAttrs(open[1] ?? "")
    .filter(({ name }) => !DROPPED_ROOT_ATTRS.has(name.toLowerCase()))
    .map(({ raw }) => ` ${raw}`)
    .join("");
  const body = stripped.slice((open.index ?? 0) + open[0].length);
  const closed = body.replace(/<\/svg\s*>\s*$/i, "");
  return `  <svg x="${markX}" y="0" width="${MARK_SLOT}" height="${MARK_SLOT}" viewBox="${escapeXml(viewBox)}" preserveAspectRatio="xMidYMid meet"${keep}>${closed}</svg>`;
}

/** Root-tag attributes the slot supplies itself — anything else the artwork declared is carried. */
const DROPPED_ROOT_ATTRS = new Set([
  "x",
  "y",
  "width",
  "height",
  "viewbox",
  "preserveaspectratio",
  "version",
  "baseprofile",
  "id",
]);

/** Drop the XML declaration, any doctype, and comments — none of them nest inside another `<svg>`. */
function stripPreamble(svg: string): string {
  return svg
    .replace(/<\?xml[\s\S]*?\?>/gi, "")
    .replace(/<!DOCTYPE[\s\S]*?>/gi, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .trim();
}

interface RawAttr {
  name: string;
  raw: string;
}

/** Attributes of one open tag, as `name` + the verbatim `name="value"` source. Deliberately a
 *  tokeniser and not a parser: the value is carried through byte-for-byte, never re-quoted. */
function rawAttrs(source: string): RawAttr[] {
  const out: RawAttr[] = [];
  const re = /([A-Za-z_:][-.\w:]*)\s*=\s*("[^"]*"|'[^']*')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    out.push({ name: m[1] as string, raw: `${m[1]}=${m[2]}` });
  }
  return out;
}

/** The same attributes as a lower-cased name → unquoted-value map. */
function parseAttrs(source: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const { raw } of rawAttrs(source)) {
    const eq = raw.indexOf("=");
    const name = raw.slice(0, eq).toLowerCase();
    out.set(name, raw.slice(eq + 2, -1));
  }
  return out;
}

// ── the validator ────────────────────────────────────────────────────────────────────────────────

export type BrandMarkCheck = { ok: true } | { ok: false; reason: string };

/**
 * Decide whether an uploaded SVG may become a boot mark, and say WHY when it may not.
 *
 * Every refusal below names the thing that is wrong and what to do about it, because the operator
 * cannot see what the rasteriser saw and "invalid file" leaves them guessing at a brand asset they
 * did not author.
 *
 * The rules are not stylistic. `rsvg-convert` RESOLVES EXTERNAL REFERENCES: an `<image href="https://…">`,
 * a remote stylesheet or a webfont makes the *server* fetch an attacker-chosen URL from inside the
 * cluster when it rasterises, and makes the *box* fetch something that cannot exist on an offline
 * boot. `<text>` renders in whatever fonts the rasteriser happens to have, and that is a different
 * set on the server than in the build chroot, so the same mark would come out differently on the two
 * screens it is supposed to make identical. And a mark with no `viewBox` has nothing to scale
 * against in the fixed 136x136 slot the GRUB theme paints at exactly 480x210.
 */
export function validateBrandMark(source: string): BrandMarkCheck {
  const bytes = new TextEncoder().encode(source).length;
  if (bytes === 0) return { ok: false, reason: "That file is empty." };
  if (bytes > BOOT_BRAND_MARK_MAX_BYTES) {
    return {
      ok: false,
      reason: `That SVG is ${Math.round(bytes / 1024)} KB. The boot mark is capped at ${
        BOOT_BRAND_MARK_MAX_BYTES / 1024
      } KB — export it with the artwork flattened and the editor's metadata dropped.`,
    };
  }

  // An entity declaration is the XXE vector, and no drawing tool emits one. Refused before anything
  // else looks at the file, including the `<svg` check — a doctype is where it would hide.
  if (/<!ENTITY\b/i.test(source)) {
    return {
      ok: false,
      reason: "That SVG declares an XML entity. Re-export it from your editor without a doctype.",
    };
  }

  const stripped = stripPreamble(source);
  const open = /<svg\b([^>]*)>/i.exec(stripped);
  if (!open || open.index !== 0) {
    return {
      ok: false,
      reason: "That file is not an SVG. The boot screen draws vector artwork — a PNG or a JPEG cannot go on it.",
    };
  }

  if (/<script\b/i.test(stripped)) {
    return { ok: false, reason: "That SVG contains a <script> element. Remove it and upload again." };
  }
  if (/<foreignObject\b/i.test(stripped)) {
    return {
      ok: false,
      reason: "That SVG contains a <foreignObject>. It draws HTML, which no boot renderer has — remove it.",
    };
  }
  if (/<(text|tspan|textPath)\b/i.test(stripped)) {
    return {
      ok: false,
      reason:
        "That SVG contains live text. The fonts on a booting box are not the fonts on your machine, so it " +
        "would render in something else or not at all. Convert text to paths and upload again.",
    };
  }
  // No renderer on the boot chain runs JavaScript, so an event handler is inert THERE — but the
  // console previews the same string, and a stored `onload=` would be an XSS payload waiting for the
  // one place that ever puts an SVG in a document. Refused at the door instead.
  if (/\son[a-z]+\s*=/i.test(stripped)) {
    return {
      ok: false,
      reason: "That SVG carries an event handler (an on… attribute). Remove it and upload again.",
    };
  }
  if (/@import\b/i.test(stripped)) {
    return {
      ok: false,
      reason: "That SVG imports an external stylesheet. Inline the styles and upload again.",
    };
  }

  const external = firstExternalReference(stripped);
  if (external) {
    return {
      ok: false,
      reason:
        `That SVG references ${external}. A box boots with no network and the control plane must not fetch ` +
        "a remote URL to draw a logo — inline the reference, or embed it as a data: URI.",
    };
  }

  const attrs = parseAttrs(open[1] ?? "");
  const viewBox = attrs.get("viewbox");
  if (!viewBox || !/^\s*-?[\d.]+[\s,]+-?[\d.]+[\s,]+[\d.]+[\s,]+[\d.]+\s*$/.test(viewBox)) {
    return {
      ok: false,
      reason:
        "That SVG has no viewBox. The mark is drawn into a fixed 136x136 slot, and without a viewBox there " +
        "is nothing to scale it against. Re-export it with a viewBox set.",
    };
  }

  return { ok: true };
}

/**
 * The first reference in the document that is neither a `#fragment` nor a `data:` URI, quoted back
 * for the refusal. Covers both spellings a reference takes: an `href`/`xlink:href` attribute and a
 * CSS `url(…)` anywhere (a `style` attribute, a `<style>` block, a presentation attribute).
 */
function firstExternalReference(svg: string): string | null {
  const local = (value: string): boolean => {
    const v = value.trim().replace(/^['"]|['"]$/g, "");
    return v === "" || v.startsWith("#") || /^data:/i.test(v);
  };
  const href = /(?:xlink:)?href\s*=\s*("[^"]*"|'[^']*')/gi;
  let m: RegExpExecArray | null;
  while ((m = href.exec(svg)) !== null) {
    const value = (m[1] as string).slice(1, -1);
    if (!local(value)) return quoteRef(value);
  }
  const url = /url\(\s*([^)]*)\)/gi;
  while ((m = url.exec(svg)) !== null) {
    const value = m[1] as string;
    if (!local(value)) return quoteRef(value);
  }
  return null;
}

/** A reference, trimmed to something readable in a one-line refusal. */
function quoteRef(value: string): string {
  const clean = value.trim().replace(/^['"]|['"]$/g, "");
  return clean.length > 60 ? `"${clean.slice(0, 57)}…"` : `"${clean}"`;
}

// ── the wire contract ────────────────────────────────────────────────────────────────────────────

/**
 * The fleet's boot branding (POL-194), read and written in Console ▸ Settings ▸ Branding.
 *
 * ONE brand per control plane — not per machine, per site or per screen. `markSvg` is the operator's
 * uploaded mark (null = the Polyptic mark); `wordmark` is what stands in for "Polyptic" ("" = the
 * default). `note` carries a degradation the operator has to know about — a control plane with no
 * rasteriser serves the committed default logo and says so here rather than 404ing a boot path.
 */
export const BootBrand = z.object({
  markSvg: z.string().nullable(),
  wordmark: z.string(),
  /** ISO timestamp of the last change; null while the fleet is still on the Polyptic lockup. */
  updatedAt: z.string().nullable(),
  /** A sentence about why the served logo is NOT this brand, or null when it is. */
  note: z.string().nullable(),
});
export type BootBrand = z.infer<typeof BootBrand>;

/**
 * Replace the fleet's boot branding. The body is the whole desired state, so Remove is a PUT with
 * `markSvg: null` and an empty wordmark rather than a second verb.
 */
export const UpdateBootBrandBody = z.object({
  markSvg: z.string().max(BOOT_BRAND_MARK_MAX_BYTES).nullable(),
  wordmark: z.string().max(BOOT_BRAND_WORDMARK_MAX),
});
export type UpdateBootBrandBody = z.infer<typeof UpdateBootBrandBody>;
