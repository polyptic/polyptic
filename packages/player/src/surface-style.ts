/**
 * The size/transform of a CONTENT element (iframe/img/video) inside a surface — shared by the main
 * surface renderer (Player.vue) and the playlist rotator (POL-34), so a playlist entry composes with
 * a video-wall span exactly like a directly-assigned surface does.
 *
 * No span, no zoom → empty (CSS makes the element fill 100%×100% of the region).
 *
 * With span → the content is sized to the FULL spanning content (contentW×contentH px) and shifted
 * by -(offsetX,offsetY) px, so the region (overflow:hidden) reveals only this screen's slice. In a
 * production deployment the player runs fullscreen at the screen's native resolution, so canvas px
 * == viewport px and these literal pixels line up exactly. transform-origin:top-left keeps the
 * offset anchored to the region's top-left corner.
 *
 * With zoom (framed surfaces only, POL-57) → the element is laid out at 1/zoom of the box it must end
 * up filling and scaled back up, so the page inside sees a proportionally smaller CSS viewport. The
 * two compose: transforms apply right-to-left, so `translate(…) scale(…)` scales the frame FIRST and
 * then shifts the already-full-size result by the span offset — the translate stays in un-scaled
 * region pixels, exactly as the server's span math assumes.
 */
import type { CSSProperties } from "vue";

/** The Phase-3b spanning descriptor a surface may carry (see protocol `SurfaceBase.span`). */
export interface Span {
  contentW: number;
  contentH: number;
  offsetX: number;
  offsetY: number;
}

export function contentStyle(span: Span | undefined, zoom = 1): CSSProperties {
  if (!span) {
    if (zoom === 1) return {};
    return {
      width: `${100 / zoom}%`,
      height: `${100 / zoom}%`,
      transform: `scale(${zoom})`,
      transformOrigin: "top left",
    };
  }
  const shift = `translate(${-span.offsetX}px, ${-span.offsetY}px)`;
  return {
    width: `${span.contentW / zoom}px`,
    height: `${span.contentH / zoom}px`,
    maxWidth: "none",
    maxHeight: "none",
    transform: zoom === 1 ? shift : `${shift} scale(${zoom})`,
    transformOrigin: "top left",
  };
}
