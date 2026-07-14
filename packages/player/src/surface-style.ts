/**
 * The size/transform of a CONTENT element (iframe/img/video) inside a surface — shared by the main
 * surface renderer (Player.vue) and the playlist rotator (POL-34), so a playlist entry composes with
 * a video-wall span exactly like a directly-assigned surface does.
 *
 * Four things compose here, and the ORDER is the whole game:
 *
 *   span  (Phase 3b, video walls) — the element is sized to the FULL spanning content and shifted by
 *         -(offsetX,offsetY) REGION pixels, so the region (overflow:hidden) reveals only this
 *         screen's slice. In production the player runs fullscreen at the screen's native
 *         resolution, so canvas px == viewport px and these literal pixels line up exactly.
 *   zoom  (POL-57) — the element is laid out at 1/zoom of the box it must fill and scaled back up,
 *         so the embedded page sees a proportionally SMALLER CSS viewport and lays itself out
 *         bigger (media queries, vw units and rem sizing respond as they would at that browser zoom).
 *   crop  (POL-98) — an inset chopped off each edge of the framed page. The frame is GROWN by the
 *         insets and shifted, so the cropped bands fall outside the region's clip: the nav bar is
 *         gone and the rest of the page still fills the panel.
 *   scroll(POL-98) — the page parked at an offset. A cross-origin document cannot be scripted, so
 *         this is geometry too: grow the frame by the offset, shift it by the offset.
 *
 * Transforms apply RIGHT-TO-LEFT (a transform list is a matrix product; `translate(T) scale(s)` maps
 * a point p to T + s·p), which fixes the order exactly:
 *
 *     translate(-span px)  scale(zoom)  translate(-crop%)  translate(-(cropPx + scroll) px)
 *     └─ region px ─────┘               └──── the page's OWN px, scaled by zoom ─────────────┘
 *
 * The span shift must stay OUTSIDE the scale (it is in un-scaled region pixels, exactly as the
 * server's span math assumes); the crop/scroll shifts must stay INSIDE it (they are in the page's
 * own pixels, and must be scaled with the page). Put a percent crop outside the scale and it
 * under-shifts by a factor of zoom — the bug this ordering exists to prevent.
 *
 * `frameGeometry` below is the same math in NUMBERS (no CSS), and is what the tests prove
 * composition against — including the wall-continuity property: for any zoom/crop/scroll, two
 * adjacent members of a video wall show exactly adjacent windows onto the same page, with no seam
 * and no overlap.
 */
import type { CSSProperties } from "vue";
import type { SurfaceCrop, SurfaceScroll } from "@polyptic/protocol";

/** The Phase-3b spanning descriptor a surface may carry (see protocol `SurfaceBase.span`). */
export interface Span {
  contentW: number;
  contentH: number;
  offsetX: number;
  offsetY: number;
}

/** The POL-98 grooming geometry a framed surface may carry. `refreshSeconds` is not a style, so it
 *  is not here — it lives on the refresh scheduler. */
export interface Groom {
  crop?: SurfaceCrop;
  scroll?: SurfaceScroll;
}

/** One axis of the groom, reduced to the four numbers the CSS (and the geometry) needs.
 *  - `k`      the frame is stretched by this factor to make room for a PERCENT crop (1 when none).
 *  - `padPx`  page px added to the frame's layout size (a PX crop's two insets, plus the scroll).
 *  - `shiftPct` / `shiftPx`  how far the frame is pulled back, split by unit exactly as CSS wants:
 *    a percent translate resolves against the element's own (final) box, which is precisely the
 *    "percent of the frame" a percent crop means — so the two units never need to meet. */
interface AxisGroom {
  k: number;
  padPx: number;
  shiftPct: number;
  shiftPx: number;
}

const NEUTRAL: AxisGroom = { k: 1, padPx: 0, shiftPct: 0, shiftPx: 0 };

function axis(near: number, far: number, unit: "percent" | "px", scroll: number): AxisGroom {
  if (unit === "percent") {
    const hidden = (near + far) / 100;
    // The contract caps a percent pair at 95%, so this can neither divide by zero nor go negative.
    const k = 1 / Math.max(1 - hidden, 0.05);
    return { k, padPx: scroll, shiftPct: near, shiftPx: scroll };
  }
  return { k: 1, padPx: near + far + scroll, shiftPct: 0, shiftPx: near + scroll };
}

function axesFor(groom: Groom | undefined): { x: AxisGroom; y: AxisGroom } {
  if (!groom) return { x: NEUTRAL, y: NEUTRAL };
  const c = groom.crop;
  const s = groom.scroll;
  const unit = c?.unit ?? "percent";
  return {
    x: axis(c?.left ?? 0, c?.right ?? 0, unit, s?.x ?? 0),
    y: axis(c?.top ?? 0, c?.bottom ?? 0, unit, s?.y ?? 0),
  };
}

function isNeutral(a: AxisGroom): boolean {
  return a.k === 1 && a.padPx === 0 && a.shiftPct === 0 && a.shiftPx === 0;
}

/** Trim float noise so the CSS (and the tests) read like the numbers a human wrote. */
function round(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}

// ── The geometry, in numbers ──────────────────────────────────────────────────

export interface FrameGeometryInput {
  /** The screen's region, in region (canvas == viewport) pixels. */
  region: { w: number; h: number };
  span?: Span;
  zoom?: number;
  groom?: Groom;
}

export interface FrameGeometry {
  /** The element's layout box, in the PAGE's own CSS pixels — the viewport the framed page sees. */
  frameW: number;
  frameH: number;
  /** How far the frame is pulled back inside the (scaled) span window, in page px. */
  shiftX: number;
  shiftY: number;
  /** The rectangle of the PAGE this screen actually shows, in page px. This is the property that
   *  matters: crop/scroll/zoom/span are correct exactly when this window is where it should be. */
  visible: { x: number; y: number; w: number; h: number };
}

/**
 * What the browser will end up doing, as numbers. The CSS below is a faithful transcription of this
 * — same k, same pads, same shifts — so proving this proves the style.
 *
 * The frame is laid out at `(base/zoom + pad) * k` page px, where `base` is the span's content box
 * (or the region, unspanned). The region shows `region/zoom` page px of it, starting at the shift
 * plus this member's own span offset (converted from region px to page px by /zoom).
 */
export function frameGeometry(input: FrameGeometryInput): FrameGeometry {
  const zoom = input.zoom ?? 1;
  const { x, y } = axesFor(input.groom);
  const baseW = input.span ? input.span.contentW : input.region.w;
  const baseH = input.span ? input.span.contentH : input.region.h;
  const offsetX = input.span ? input.span.offsetX : 0;
  const offsetY = input.span ? input.span.offsetY : 0;

  const frameW = (baseW / zoom + x.padPx) * x.k;
  const frameH = (baseH / zoom + y.padPx) * y.k;
  // A percent crop's shift is a percentage OF THE FRAME — which is what CSS's percent translate
  // resolves against, so the two stay identical without the player ever measuring the DOM.
  const shiftX = (x.shiftPct / 100) * frameW + x.shiftPx;
  const shiftY = (y.shiftPct / 100) * frameH + y.shiftPx;

  return {
    frameW: round(frameW),
    frameH: round(frameH),
    shiftX: round(shiftX),
    shiftY: round(shiftY),
    visible: {
      x: round(shiftX + offsetX / zoom),
      y: round(shiftY + offsetY / zoom),
      w: round(input.region.w / zoom),
      h: round(input.region.h / zoom),
    },
  };
}

// ── The same geometry, as CSS ─────────────────────────────────────────────────

/** A CSS length for one axis of the frame's layout box: percentage-native when there is no span (so
 *  a non-fullscreen preview still fits its box), literal px when there is (the span math is in px). */
function sizeCss(base: number | null, zoom: number, a: AxisGroom): string {
  if (base !== null) return `${round((base / zoom + a.padPx) * a.k)}px`;
  const inner = zoom === 1 ? "100%" : `100% / ${zoom}`;
  if (a.padPx === 0 && a.k === 1) return zoom === 1 ? "100%" : `${round(100 / zoom)}%`;
  return `calc((${inner} + ${round(a.padPx)}px) * ${round(a.k)})`;
}

export function contentStyle(span: Span | undefined, zoom = 1, groom?: Groom): CSSProperties {
  const { x, y } = axesFor(groom);
  const groomed = !isNeutral(x) || !isNeutral(y);
  if (!span && zoom === 1 && !groomed) return {};

  // Right-to-left: the page's own px first (crop + scroll), then zoom, then the span's region px.
  const transform: string[] = [];
  if (span) transform.push(`translate(${round(-span.offsetX)}px, ${round(-span.offsetY)}px)`);
  if (zoom !== 1) transform.push(`scale(${zoom})`);
  if (x.shiftPct !== 0 || y.shiftPct !== 0) {
    transform.push(`translate(${round(-x.shiftPct)}%, ${round(-y.shiftPct)}%)`);
  }
  if (x.shiftPx !== 0 || y.shiftPx !== 0) {
    transform.push(`translate(${round(-x.shiftPx)}px, ${round(-y.shiftPx)}px)`);
  }

  const style: CSSProperties = {
    width: sizeCss(span ? span.contentW : null, zoom, x),
    height: sizeCss(span ? span.contentH : null, zoom, y),
    transform: transform.join(" "),
    transformOrigin: "top left",
  };
  // A grown frame must be allowed to exceed its box — the region's overflow:hidden is the clip.
  if (span || groomed) {
    style.maxWidth = "none";
    style.maxHeight = "none";
  }
  return style;
}
