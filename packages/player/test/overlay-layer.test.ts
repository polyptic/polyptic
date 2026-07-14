/**
 * POL-97 — the player's overlay layer: what gets probed, and where the layer draws.
 *
 * The load-bearing claim is a NEGATIVE one: the POL-86 prober must not probe overlay content the way
 * it does not probe pages. An overlay is not a surface — it rides its own slice field — so it cannot
 * even reach the probe set, and a slow feed inside it can never gate the logo (or the content
 * beneath) on a reachability check. This suite pins that structurally: build a slice whose overlay
 * embeds a URL, and prove the probe set knows nothing about it.
 *
 * The positive claim is the span: an overlay from a scope wider than the screen is sized to the whole
 * video wall and shifted to this panel's window onto it, by the SAME helper the content path uses.
 */
import { describe, expect, test } from "bun:test";

import type { ScreenSlice } from "@polyptic/protocol";

import { overlayStyle, probeableSurfaces } from "../src/overlay-layer";

/** A slice with one framed surface, one playlist, one page — and an overlay whose page embeds a url. */
const SLICE: ScreenSlice = {
  screenId: "screen-1",
  canvas: { x: 0, y: 0, w: 1920, h: 1080 },
  surfaces: [
    {
      id: "content-web",
      region: { x: 0, y: 0, w: 1920, h: 1080 },
      type: "web",
      url: "https://dash.example.test/embed",
      placement: "iframe",
      interactive: false,
      zoom: 1,
    },
    {
      id: "content-playlist",
      region: { x: 0, y: 0, w: 960, h: 540 },
      type: "playlist",
      items: [{ kind: "image", url: "https://cdn.example.test/a.png", durationSeconds: 10 }],
      startedAt: "2026-07-14T09:00:00.000Z",
    },
    {
      id: "content-page",
      region: { x: 960, y: 0, w: 960, h: 540 },
      type: "page",
      definition: { aspect: "16:9", bg: "#0b0b0e", elements: [] },
    },
  ],
  overlay: {
    sourceId: "source-9",
    scope: "fleet",
    definition: {
      aspect: "16:9",
      bg: "#0b0b0e",
      elements: [
        { id: "em", kind: "embed", x: 0, y: 0, w: 30, h: 20, props: { url: "https://overlay.example.test/frame" } },
      ],
    },
    data: { embeds: { em: { url: "https://overlay.example.test/frame", kind: "web" } } },
  },
};

describe("the prober never sees the overlay (POL-97 × POL-86)", () => {
  test("probeable surfaces are content frames/media only — never a page, never a playlist", () => {
    const probeable = probeableSurfaces(SLICE.surfaces);
    expect(probeable.map((s) => s.id)).toEqual(["content-web"]);
  });

  test("nothing an overlay draws can enter the probe set — it is not a surface", () => {
    const probeable = probeableSurfaces(SLICE.surfaces);
    const urls = probeable.map((s) => (s.type === "web" || s.type === "dashboard" ? s.url : ""));
    // The overlay's embed url is on the glass, but it is NOT probed: a page renders locally and its
    // embeds carry their own calm placeholders. Gating the layer on a probe would let a slow feed
    // blank the logo — the exact failure an overlay exists to survive.
    expect(urls).not.toContain("https://overlay.example.test/frame");
    expect(probeable.some((s) => s.id === "overlay")).toBe(false);
  });

  test("an overlay changes nothing about what the prober is asked to prove", () => {
    const withOverlay = probeableSurfaces(SLICE.surfaces);
    const { overlay: _dropped, ...withoutOverlay } = SLICE;
    expect(probeableSurfaces(withoutOverlay.surfaces)).toEqual(withOverlay);
  });
});

describe("where the overlay layer draws (POL-97)", () => {
  test("no span → the layer fills the screen (no transform at all)", () => {
    expect(overlayStyle(SLICE.overlay!)).toEqual({});
  });

  test("a span → the layer is sized to the whole wall and shifted to this panel's window", () => {
    const style = overlayStyle({
      ...SLICE.overlay!,
      span: { contentW: 3840, contentH: 1080, offsetX: 1920, offsetY: 0 },
    });
    expect(style.width).toBe("3840px");
    expect(style.height).toBe("1080px");
    expect(style.transform).toBe("translate(-1920px, 0px)");
    expect(style.transformOrigin).toBe("top left");
  });
});
