/**
 * The Studio's element LIBRARY metadata: one entry per page-element kind — display name, glyph, a
 * one-line hint, and the default geometry/props a fresh drop gets. Lives in the shared elements
 * package (next to the renderers) so the palette can never offer a kind the renderer doesn't have.
 */
import type { PageElement, PageElementKind } from "@polyptic/protocol";

export interface ElementLibraryEntry {
  kind: PageElementKind;
  name: string;
  glyph: string;
  hint: string;
}

export const ELEMENT_LIBRARY: ElementLibraryEntry[] = [
  { kind: "embed", name: "Embed", glyph: "▤", hint: "A content source or URL in a region — composites a dashboard onto the page" },
  { kind: "ticker", name: "Ticker", glyph: "⇢", hint: "Scrolling text strip" },
  { kind: "feed", name: "Feed", glyph: "≡", hint: "RSS / Atom headlines, polled server-side" },
  { kind: "image", name: "Image", glyph: "▦", hint: "Uploaded media" },
  { kind: "text", name: "Text", glyph: "T", hint: "Text block" },
  { kind: "clock", name: "Clock", glyph: "◷", hint: "Live clock — updates once a minute" },
  { kind: "shape", name: "Shape", glyph: "▢", hint: "Background shape" },
  { kind: "weather", name: "Weather", glyph: "☁", hint: "Local conditions via Open-Meteo" },
  { kind: "qr", name: "QR code", glyph: "▩", hint: "Static QR code, encoded client-side" },
  { kind: "countdown", name: "Countdown", glyph: "◔", hint: "Time to a target" },
];

export function libraryEntry(kind: PageElementKind): ElementLibraryEntry {
  return ELEMENT_LIBRARY.find((entry) => entry.kind === kind) ?? ELEMENT_LIBRARY[0]!;
}

/** The element a fresh library drop creates, centred on nothing yet — the Studio positions it. */
export function defaultElement(kind: PageElementKind, id: string): PageElement {
  switch (kind) {
    case "embed":
      return { id, kind, x: 0, y: 0, w: 56, h: 52, props: {} };
    case "ticker":
      return {
        id,
        kind,
        x: 0,
        y: 0,
        w: 100,
        h: 9,
        props: {
          text: "Welcome to Polyptic · edit this ticker in the inspector",
          speed: 60,
          fg: "#fafafa",
          bg: "#101014",
        },
      };
    case "feed":
      return { id, kind, x: 0, y: 0, w: 26, h: 42, props: { url: "feeds.bbci.co.uk/news/rss.xml", items: 4 } };
    case "image":
      return { id, kind, x: 0, y: 0, w: 14, h: 16, props: { fit: "contain" } };
    case "text":
      return { id, kind, x: 0, y: 0, w: 34, h: 10, props: { text: "Good morning", size: 44, color: "#fafafa", align: "left" } };
    case "clock":
      return { id, kind, x: 0, y: 0, w: 14, h: 10, props: { format: "24h", seconds: false, color: "#fafafa" } };
    case "shape":
      return { id, kind, x: 0, y: 0, w: 24, h: 24, props: { fill: "#18181b", radius: 12, opacity: 100 } };
    case "weather":
      return { id, kind, x: 0, y: 0, w: 18, h: 13, props: { location: "Sheffield", units: "C" } };
    case "qr":
      return { id, kind, x: 0, y: 0, w: 9, h: 16, props: { url: "https://example.com" } };
    case "countdown":
      return { id, kind, x: 0, y: 0, w: 20, h: 12, props: { label: "Next shift change", target: "17:00", color: "#fafafa" } };
  }
}
