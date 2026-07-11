/**
 * Presentation helpers for content kinds (Phase 3c), shared by the Content library view, the Wall's
 * left library panel and the Inspector source picker so a kind looks the same everywhere.
 *
 * Mirrors docs/design/console.dc.html (kindName / glyph / iconVar). The kinds themselves come from
 * the contract's `ContentKind` enum — keep this map exhaustive over it.
 */
import type { ContentKind } from "@polyptic/protocol";

/** The URL-backed kinds, in the order they're offered in the Add-source type picker. A playlist
 *  (POL-34) is deliberately NOT here — it is authored in its own modal, not typed as an address —
 *  and neither is `page` (POL-42), which is composed in the Studio ("New page"). */
export const CONTENT_KINDS: ContentKind[] = ["web", "dashboard", "image", "video"];

const LABELS: Record<ContentKind, string> = {
  web: "Web page",
  dashboard: "Dashboard",
  image: "Image",
  video: "Video",
  playlist: "Playlist",
  page: "Page",
};

const SHORT_LABELS: Record<ContentKind, string> = {
  web: "Web",
  dashboard: "Dashboard",
  image: "Image",
  video: "Video",
  playlist: "Playlist",
  page: "Page",
};

const GLYPHS: Record<ContentKind, string> = {
  web: "W",
  dashboard: "D",
  image: "▦",
  video: "▷",
  playlist: "≣",
  page: "▣",
};

/** A CSS custom-property name carrying the accent colour for a kind's glyph badge. */
const COLOR_VARS: Record<ContentKind, string> = {
  web: "--accent",
  dashboard: "--ok",
  image: "--accent-fg",
  video: "--warn",
  playlist: "--accent",
  page: "--accent",
};

export function kindLabel(kind: ContentKind): string {
  return LABELS[kind];
}

export function kindShortLabel(kind: ContentKind): string {
  return SHORT_LABELS[kind];
}

export function kindGlyph(kind: ContentKind): string {
  return GLYPHS[kind];
}

export function kindColorVar(kind: ContentKind): string {
  return COLOR_VARS[kind];
}
