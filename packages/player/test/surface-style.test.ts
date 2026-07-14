/**
 * Surface geometry (POL-98) — span × zoom × crop × scroll, composed.
 *
 * The player's one irreducible piece of maths. Four independent transforms land on the same iframe,
 * and every one of them is a lie the wall tells convincingly or not at all: the span makes six panels
 * pretend to be one page, zoom makes a desk page pretend to be a wall page, crop makes a nav bar
 * pretend not to exist, scroll makes the middle of a report pretend to be its top. Get the ORDER
 * wrong and it still "works" on a single un-zoomed screen — which is exactly the shape of bug that
 * ships and then falls over on the one 3×2 video wall that matters.
 *
 * So we test the geometry as numbers (`frameGeometry`), exhaustively across the product of the four,
 * against properties rather than golden values:
 *
 *   WINDOW      the page rectangle a screen shows is where crop + scroll say it is, at the size zoom
 *               says it is (`region / zoom` page px — zoom shows LESS page, bigger).
 *   CROP        the page's cropped-away bands are exactly the bands nobody can see: the visible
 *               window starts at the left/top crop and ends at the right/bottom crop, on every axis,
 *               in both units, at every zoom, with or without a span.
 *   CONTINUITY  two adjacent members of a video wall show exactly adjacent windows — no seam, no
 *               overlap — for every zoom/crop/scroll combination. This is the property a wall lives
 *               or dies by, and it is the one a wrong transform order breaks.
 *   CSS         the emitted style transcribes those numbers faithfully, with the span translate
 *               OUTSIDE the scale (region px) and the crop/scroll translates INSIDE it (page px).
 */
import { describe, expect, test } from "bun:test";

import { contentStyle, frameGeometry } from "../src/surface-style";
import type { Groom, Span } from "../src/surface-style";

const REGION = { w: 1920, h: 1080 };

/** The two-member wall the continuity property is proven on: 3840×1080 across two 1920 panels. */
const WALL_A: Span = { contentW: 3840, contentH: 1080, offsetX: 0, offsetY: 0 };
const WALL_B: Span = { contentW: 3840, contentH: 1080, offsetX: 1920, offsetY: 0 };

const ZOOMS = [0.5, 1, 1.25, 2];
const CROPS: (Groom["crop"] | undefined)[] = [
  undefined,
  { top: 10, right: 0, bottom: 0, left: 0, unit: "percent" },
  { top: 8, right: 5, bottom: 12, left: 3, unit: "percent" },
  { top: 64, right: 0, bottom: 0, left: 0, unit: "px" },
  { top: 64, right: 120, bottom: 40, left: 200, unit: "px" },
];
const SCROLLS: (Groom["scroll"] | undefined)[] = [
  undefined,
  { x: 0, y: 300 },
  { x: 120, y: 0 },
  { x: 75, y: 900 },
];

/** Every (zoom, crop, scroll) the suite sweeps — 80 combinations, run against each span shape. */
function combos(): { zoom: number; groom: Groom }[] {
  const out: { zoom: number; groom: Groom }[] = [];
  for (const zoom of ZOOMS) {
    for (const crop of CROPS) {
      for (const scroll of SCROLLS) out.push({ zoom, groom: { crop, scroll } });
    }
  }
  return out;
}

const near = (a: number, b: number): void => expect(Math.abs(a - b)).toBeLessThan(0.01);

describe("frameGeometry — the window onto the page", () => {
  test("ungroomed, unzoomed, unspanned: the element is the region and shows the page from its origin", () => {
    const g = frameGeometry({ region: REGION });
    expect(g.frameW).toBe(1920);
    expect(g.frameH).toBe(1080);
    expect(g.visible).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("zoom shows LESS page, laid out bigger — a browser's zoom, not a scale on a screenshot", () => {
    const g = frameGeometry({ region: REGION, zoom: 2 });
    expect(g.frameW).toBe(960); // the page is handed a 960px viewport…
    expect(g.visible.w).toBe(960); // …and the screen shows all 960 of them, at 2×
  });

  test("a scroll parks the page at the offset, in the page's own pixels", () => {
    const g = frameGeometry({ region: REGION, groom: { scroll: { x: 0, y: 400 } } });
    expect(g.visible.y).toBe(400);
    expect(g.visible.h).toBe(1080);
    // The frame GREW by the offset, so nothing is lost off the bottom — the page still fills the panel.
    expect(g.frameH).toBe(1480);
  });

  test("a percent crop hides exactly the cropped bands, and the rest still fills the panel", () => {
    const groom: Groom = { crop: { top: 10, right: 20, bottom: 0, left: 5, unit: "percent" } };
    const g = frameGeometry({ region: REGION, groom });
    // The window starts at the left/top crop of the frame…
    near(g.visible.x, 0.05 * g.frameW);
    near(g.visible.y, 0.1 * g.frameH);
    // …and ends exactly where the right/bottom crop begins.
    near(g.visible.x + g.visible.w, (1 - 0.2) * g.frameW);
    near(g.visible.y + g.visible.h, g.frameH);
    // The visible window is still the whole panel: the crop grew the frame, it did not shrink the page.
    expect(g.visible.w).toBe(1920);
  });

  test("a px crop chops the header you measured — 64 page px, not 64 screen px", () => {
    const g = frameGeometry({ region: REGION, zoom: 2, groom: { crop: { top: 64, right: 0, bottom: 0, left: 0, unit: "px" } } });
    expect(g.visible.y).toBe(64); // in the PAGE's pixels, whatever the zoom
    expect(g.frameH).toBe(1080 / 2 + 64); // the frame grew by the band it must hide
  });

  test("crop and scroll stack: the page is cropped, THEN parked below the crop", () => {
    const g = frameGeometry({
      region: REGION,
      groom: { crop: { top: 100, right: 0, bottom: 0, left: 0, unit: "px" }, scroll: { x: 0, y: 250 } },
    });
    expect(g.visible.y).toBe(350);
  });
});

describe("frameGeometry — composition (exhaustive: span × zoom × crop × scroll)", () => {
  test("the visible window is always region/zoom page px — every combination", () => {
    for (const span of [undefined, WALL_A, WALL_B]) {
      for (const { zoom, groom } of combos()) {
        const g = frameGeometry({ region: REGION, span, zoom, groom });
        near(g.visible.w, REGION.w / zoom);
        near(g.visible.h, REGION.h / zoom);
        expect(g.frameW).toBeGreaterThan(0);
        expect(g.frameH).toBeGreaterThan(0);
      }
    }
  });

  test("the cropped bands are never visible — on any axis, in either unit, at any zoom, spanned or not", () => {
    for (const span of [undefined, WALL_A]) {
      for (const { zoom, groom } of combos()) {
        const g = frameGeometry({ region: REGION, span, zoom, groom });
        const c = groom.crop;
        if (!c) continue;
        const bandL = c.unit === "percent" ? (c.left / 100) * g.frameW : c.left;
        const bandT = c.unit === "percent" ? (c.top / 100) * g.frameH : c.top;
        const bandR = c.unit === "percent" ? (c.right / 100) * g.frameW : c.right;
        const bandB = c.unit === "percent" ? (c.bottom / 100) * g.frameH : c.bottom;
        const scrollX = groom.scroll?.x ?? 0;
        const scrollY = groom.scroll?.y ?? 0;

        // The window starts after the near band (plus the operator's scroll offset)…
        near(g.shiftX, bandL + scrollX);
        near(g.shiftY, bandT + scrollY);
        // …and the FULL page window (across every member of a span) ends before the far band. On a
        // wall that is the union of the members: contentW/zoom of page, starting at the shift.
        const spannedW = (span ? span.contentW : REGION.w) / zoom;
        const spannedH = (span ? span.contentH : REGION.h) / zoom;
        near(g.shiftX + spannedW, g.frameW - bandR);
        near(g.shiftY + spannedH, g.frameH - bandB);
      }
    }
  });

  test("VIDEO-WALL CONTINUITY: adjacent members show adjacent windows — no seam, no overlap, ever", () => {
    for (const { zoom, groom } of combos()) {
      const a = frameGeometry({ region: REGION, span: WALL_A, zoom, groom });
      const b = frameGeometry({ region: REGION, span: WALL_B, zoom, groom });

      // Same page, same crop, same scroll: the two frames are laid out identically…
      expect(b.frameW).toBe(a.frameW);
      expect(b.frameH).toBe(a.frameH);
      // …and B's window begins exactly where A's ends. A gap here is a visible seam on the wall; an
      // overlap is a duplicated column. Both are what a mis-ordered transform actually looks like.
      near(b.visible.x, a.visible.x + a.visible.w);
      near(b.visible.y, a.visible.y);
      // Together they show the whole (cropped) page: end-to-end is the spanning content at this zoom.
      near(b.visible.x + b.visible.w - a.visible.x, WALL_A.contentW / zoom);
    }
  });

  test("a crop on a wall crops the SPANNING page once, not each panel", () => {
    const groom: Groom = { crop: { top: 0, right: 10, bottom: 0, left: 10, unit: "percent" } };
    const a = frameGeometry({ region: REGION, span: WALL_A, groom });
    const b = frameGeometry({ region: REGION, span: WALL_B, groom });
    // The left crop is hidden at the wall's left edge (panel A), the right crop at its right edge
    // (panel B) — and nothing is cropped away in the middle, where the panels meet.
    near(a.visible.x, 0.1 * a.frameW);
    near(b.visible.x + b.visible.w, 0.9 * b.frameW);
  });
});

describe("contentStyle — the CSS transcribes the geometry", () => {
  test("no span, no zoom, no groom → no styles at all (the element just fills its region)", () => {
    expect(contentStyle(undefined)).toEqual({});
    expect(contentStyle(undefined, 1, {})).toEqual({});
    expect(contentStyle(undefined, 1, { crop: { top: 0, right: 0, bottom: 0, left: 0, unit: "percent" } })).toEqual({});
  });

  test("zoom alone is unchanged by POL-98 (the 1/zoom layout + scale-back, as POL-57 shipped it)", () => {
    expect(contentStyle(undefined, 2)).toEqual({
      width: "50%",
      height: "50%",
      transform: "scale(2)",
      transformOrigin: "top left",
    });
  });

  test("span alone is unchanged by POL-98 (the Phase-3b px sizing + region-px shift)", () => {
    expect(contentStyle(WALL_B, 1)).toEqual({
      width: "3840px",
      height: "1080px",
      transform: "translate(-1920px, 0px)",
      transformOrigin: "top left",
      maxWidth: "none",
      maxHeight: "none",
    });
  });

  test("ORDER: span translate OUTSIDE the scale, crop/scroll translates INSIDE it", () => {
    const style = contentStyle(WALL_B, 2, {
      crop: { top: 10, right: 0, bottom: 0, left: 5, unit: "percent" },
      scroll: { x: 0, y: 300 },
    });
    // Transforms apply right-to-left: crop/scroll (page px) → scale (zoom) → span (region px).
    expect(style.transform).toBe(
      "translate(-1920px, 0px) scale(2) translate(-5%, -10%) translate(0px, -300px)",
    );
    // A percent translate resolves against the element's own box — which is exactly what "5% of the
    // frame" means — so the CSS and `frameGeometry` agree without the player ever measuring the DOM.
    const g = frameGeometry({ region: REGION, span: WALL_B, zoom: 2, groom: { crop: { top: 10, right: 0, bottom: 0, left: 5, unit: "percent" }, scroll: { x: 0, y: 300 } } });
    expect(style.width).toBe(`${g.frameW}px`);
    expect(style.height).toBe(`${g.frameH}px`);
  });

  test("unspanned sizes stay percentage-native (a non-fullscreen preview still fits its box)", () => {
    const style = contentStyle(undefined, 1, {
      crop: { top: 0, right: 0, bottom: 0, left: 0, unit: "px" },
      scroll: { x: 0, y: 200 },
    });
    expect(style.width).toBe("100%");
    expect(style.height).toBe("calc((100% + 200px) * 1)");
    expect(style.transform).toBe("translate(0px, -200px)");
    expect(style.maxHeight).toBe("none");
  });

  test("a percent crop grows the unspanned frame by exactly the hidden fraction", () => {
    const style = contentStyle(undefined, 1, {
      crop: { top: 0, right: 25, bottom: 0, left: 25, unit: "percent" },
    });
    // 50% hidden ⇒ the frame is 2× the region wide, and the middle half of it is what the wall shows.
    expect(style.width).toBe("calc((100% + 0px) * 2)");
    expect(style.transform).toBe("translate(-25%, 0%)");
  });
});
