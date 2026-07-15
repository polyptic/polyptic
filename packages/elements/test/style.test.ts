/**
 * POL-133 — the shared renderer's presentation math, pinned as pure functions (the SFC consumes
 * these verbatim, so this IS the render output for both the Studio preview and the wall — D74).
 */
import { describe, expect, test } from "bun:test";

import { PageElement } from "@polyptic/protocol";
import { embedZoomStyle, feedFontSizes } from "../src/style";
import { defaultElement } from "../src/library";
import { qrSvgPath, qrModuleCount } from "../src/qr";

describe("embed zoom (POL-133)", () => {
  test("zoom 1 is a no-op — a pre-POL-133 composition renders byte-identically", () => {
    expect(embedZoomStyle(1)).toEqual({});
  });

  test("zoom lays the frame out at 1/zoom and scales it back up (the D62 browser-zoom math)", () => {
    expect(embedZoomStyle(2)).toEqual({
      width: "50%",
      height: "50%",
      transform: "scale(2)",
      transformOrigin: "top left",
    });
    expect(embedZoomStyle(0.5)).toEqual({
      width: "200%",
      height: "200%",
      transform: "scale(0.5)",
      transformOrigin: "top left",
    });
  });
});

describe("feed font size (POL-133)", () => {
  test("fontScale 100 is EXACTLY the pre-POL-133 sizing (same cq factors, same pixel floors)", () => {
    // The old template: header max(8px, h*0.05 cqh), title max(10px, h*0.055), meta max(8px, h*0.042).
    expect(feedFontSizes(42, 100)).toEqual({
      header: "max(8px, 2.10cqh)",
      title: "max(10px, 2.31cqh)",
      meta: "max(8px, 1.76cqh)",
    });
  });

  test("the scale multiplies all three sizes together, keeping the card's proportions", () => {
    const at150 = feedFontSizes(42, 150);
    expect(at150.header).toBe("max(8px, 3.15cqh)");
    expect(at150.title).toBe(`max(10px, ${(42 * 0.055 * 1.5).toFixed(2)}cqh)`);
    expect(at150.meta).toBe("max(8px, 2.65cqh)");
  });
});

describe("element library defaults round-trip the contract (POL-133)", () => {
  test("every fresh drop parses, and the new knobs land at their neutral defaults", () => {
    for (const kind of ["embed", "feed", "qr", "ticker", "text", "clock", "shape", "weather", "image", "countdown"] as const) {
      const el = PageElement.parse(defaultElement(kind, `pe-${kind}`));
      expect(el.kind).toBe(kind);
    }
    const embed = PageElement.parse(defaultElement("embed", "pe-e"));
    if (embed.kind === "embed") expect(embed.props.zoom).toBe(1);
    const feed = PageElement.parse(defaultElement("feed", "pe-f"));
    if (feed.kind === "feed") expect(feed.props.fontScale).toBe(100);
    const qr = PageElement.parse(defaultElement("qr", "pe-q"));
    if (qr.kind === "qr") {
      expect(qr.props.fg).toBe("#09090b");
      expect(qr.props.bg).toBe("#ffffff");
    }
  });
});

describe("qr encoding still renders regardless of colour (colour is styling, not encoding)", () => {
  test("the module path and count are colour-independent", () => {
    const path = qrSvgPath("https://example.com");
    expect(path).toBeTruthy();
    expect(qrModuleCount("https://example.com")).toBeGreaterThan(0);
  });
});
