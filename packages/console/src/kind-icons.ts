/**
 * POL-175 — vendored SVG icons for the URL-backed content kinds, shown in the Add/Edit source
 * dialog's type picker (an icon well beside the dropdown). Raw-imported so they inline as markup
 * and inherit `currentColor` — an `<img src>` cannot be tinted per kind or per theme.
 *
 * Kept out of `content.ts` on purpose: that module is imported by unit tests running outside Vite,
 * where `?raw` asset imports do not resolve.
 */
import type { ContentKind } from "@polyptic/protocol";
import grafana from "./assets/kinds/grafana.svg?raw";
import globe from "./assets/kinds/globe.svg?raw";
import image from "./assets/kinds/image.svg?raw";
import video from "./assets/kinds/video.svg?raw";
import stream from "./assets/kinds/stream.svg?raw";

const ICONS: Partial<Record<ContentKind, string>> = {
  web: globe,
  dashboard: grafana,
  image,
  video,
  stream,
};

/** The inline SVG markup for a kind, or null for the kinds that never pass through the URL dialog
 *  (playlist/page/deck). */
export function kindIcon(kind: ContentKind): string | null {
  return ICONS[kind] ?? null;
}
