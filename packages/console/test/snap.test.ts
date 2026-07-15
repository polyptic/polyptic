/**
 * Canvas snapping + alignment guides (POL-100) — the Wall canvas's half of the Studio's ergonomics.
 *
 * These are the numbers behind "drag a screen at its neighbour and it clicks bezel-tight against it"
 * and "arrow-key a screen and it still lands flush". Pure arithmetic, so it's pinned here rather
 * than in a browser.
 */
import { describe, expect, test } from "bun:test";
import type { Rect } from "@polyptic/protocol";

import {
  GRID_PX,
  SNAP_PX,
  nudgeRect,
  snapCandidates,
  snapRect,
  unionBounds,
} from "../src/components/canvas/snap";

const screen = (x: number, y: number, w = 1920, h = 1080): Rect => ({ x, y, w, h });

describe("snapCandidates", () => {
  test("every sibling contributes its near edge, centre and far edge on both axes", () => {
    const { cx, cy } = snapCandidates([screen(0, 0)]);
    expect(cx).toEqual([0, 960, 1920]);
    expect(cy).toEqual([0, 540, 1080]);
  });

  test("the canvas bounds add the wall's own edges + centre (a lone tile still has something)", () => {
    const { cx } = snapCandidates([], { x: 0, y: 0, w: 3840, h: 1080 });
    expect(cx).toEqual([0, 1920, 3840]);
  });
});

describe("snapRect", () => {
  const neighbour = [screen(0, 0)];
  const candidates = snapCandidates(neighbour);

  test("a tile dragged near a neighbour's right edge snaps flush against it — a bezel-tight join", () => {
    const dragged = screen(1920 - 12, 4); // a few px shy of butting up
    const result = snapRect(dragged, candidates);
    expect(result.x).toBe(1920);
    expect(result.y).toBe(0);
    expect(result.guideX).toBe(1920);
    expect(result.guideY).toBe(0);
  });

  test("centres align to centres (the guide names the line, not the tile)", () => {
    const dragged: Rect = { x: 960 - 960 + 8, y: 4000, w: 1920, h: 1080 };
    const result = snapRect(dragged, candidates);
    expect(result.x).toBe(0); // its LEFT edge caught the neighbour's left edge
    expect(result.guideX).toBe(0);
  });

  test("beyond the threshold nothing snaps — the axis falls back to the grid", () => {
    const dragged = screen(1920 + SNAP_PX + 5, 1080 + SNAP_PX + 5);
    const result = snapRect(dragged, candidates);
    expect(result.guideX).toBeNull();
    expect(result.guideY).toBeNull();
    expect(result.x % GRID_PX).toBe(0);
    expect(result.y % GRID_PX).toBe(0);
  });

  test("grid 0 leaves an unsnapped axis exactly where it was dropped", () => {
    const dragged = screen(5003, 7007);
    const result = snapRect(dragged, candidates, { grid: 0 });
    expect(result).toMatchObject({ x: 5003, y: 7007, guideX: null, guideY: null });
  });

  test("with no siblings at all, everything falls to the grid", () => {
    const result = snapRect(screen(133, 77), snapCandidates([]));
    expect(result.guideX).toBeNull();
    expect(result.x).toBe(120);
    expect(result.y).toBe(120);
  });
});

describe("nudgeRect", () => {
  const candidates = snapCandidates([screen(0, 0)]);

  test("a nudge that lands within reach of a neighbour snaps flush (no one-pixel-shy walls)", () => {
    // 1920 - 30 + 20 = 1910 → within SNAP_PX of the neighbour's right edge → 1920.
    const result = nudgeRect(screen(1920 - 30, 0), 20, 0, candidates);
    expect(result.x).toBe(1920);
    expect(result.guideX).toBe(1920);
  });

  test("a nudge in open canvas is exactly the step — not re-gridded", () => {
    const result = nudgeRect(screen(6001, 6001), 20, -20, candidates);
    expect(result).toMatchObject({ x: 6021, y: 5981, guideX: null, guideY: null });
  });

  test("a tile flush against a neighbour can still be nudged AWAY (the snap never pulls it back)", () => {
    // Found live: a screen sitting exactly on a candidate re-snapped to it on every keypress, so it
    // could never leave the wall — the arrow key did nothing at all.
    const flush = screen(1920, 0); // butted against the neighbour's right edge
    const result = nudgeRect(flush, 20, 0, candidates);
    expect(result.x).toBe(1940);
    expect(result.guideX).toBeNull();
  });

  test("only the nudged axis moves — a snap on the other axis can't teleport the tile sideways", () => {
    const result = nudgeRect(screen(1920 - 30, 4000), 20, 0, candidates);
    expect(result.x).toBe(1920); // snapped flush on the axis we pressed
    expect(result.y).toBe(4000); // untouched
  });
});

describe("unionBounds", () => {
  test("is the bounding box of the lot", () => {
    expect(unionBounds([screen(0, 0), screen(1920, 1080)])).toEqual({
      x: 0,
      y: 0,
      w: 3840,
      h: 2160,
    });
  });

  test("nothing in, nothing out", () => {
    expect(unionBounds([])).toBeUndefined();
  });
});
