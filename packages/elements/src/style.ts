/**
 * POL-133 — pure style math for the authorable presentation knobs (embed zoom, feed font size),
 * extracted from PageElementView so the exact render output is pinned by tests without a DOM. The
 * SFC consumes these verbatim; the D74 invariant (Studio preview == wall) holds because BOTH render
 * through this one module.
 */
import type { CSSProperties } from "vue";

/**
 * Browser-style zoom for an embed's live frame: lay the iframe out at 1/zoom of the element's box
 * and scale it back up (the D62 math, applied inside a page element), so the embedded page sees a
 * proportionally smaller CSS viewport and genuinely re-lays-out — media queries, `vw`, `rem` all
 * respond. `zoom === 1` returns {} so a pre-POL-133 composition renders byte-identically.
 */
export function embedZoomStyle(zoom: number): CSSProperties {
  if (zoom === 1) return {};
  return {
    width: `${100 / zoom}%`,
    height: `${100 / zoom}%`,
    transform: `scale(${zoom})`,
    transformOrigin: "top left",
  };
}

/**
 * The three font sizes of a feed card — masthead, headline, age — for an element of height `h`
 * (% of the page) at `fontScale` percent. At 100 these are EXACTLY the pre-POL-133 sizes (the same
 * cq factors and pixel floors), so an old composition cannot drift; the scale multiplies all three
 * together so the card keeps its own proportions.
 */
export function feedFontSizes(
  h: number,
  fontScale: number,
): { header: string; title: string; meta: string } {
  const f = fontScale / 100;
  const cq = (factor: number) => `${(h * factor * f).toFixed(2)}cqh`;
  return {
    header: `max(8px, ${cq(0.05)})`,
    title: `max(10px, ${cq(0.055)})`,
    meta: `max(8px, ${cq(0.042)})`,
  };
}
