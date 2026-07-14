/**
 * The adjacency rule + auto-pack (POL-96/POL-100, D95) — the pure geometry both the server (which
 * enforces "a wall is one contiguous region") and the console (which warns before the operator
 * commits, and offers to pack) reason with. If these are wrong, a video wall spans content across
 * canvas that no screen is showing.
 */
import { describe, expect, test } from "bun:test";

import { packRects, rectsAreAdjacent, rectsInContact, translateRect } from "../src/geometry";
import type { Rect } from "../src/geometry";

const screen = (x: number, y: number, w = 1920, h = 1080): Rect => ({ x, y, w, h });

describe("rectsInContact", () => {
  test("two screens sharing a vertical edge are in contact", () => {
    expect(rectsInContact(screen(0, 0), screen(1920, 0))).toBe(true);
  });

  test("two screens sharing a horizontal edge are in contact", () => {
    expect(rectsInContact(screen(0, 0), screen(0, 1080))).toBe(true);
  });

  test("a gap breaks contact", () => {
    expect(rectsInContact(screen(0, 0), screen(2000, 0))).toBe(false);
  });

  test("a corner-only touch is NOT contact (the union box would be half empty)", () => {
    expect(rectsInContact(screen(0, 0), screen(1920, 1080))).toBe(false);
  });

  test("overlapping screens are in contact — an overlap is never a hole", () => {
    expect(rectsInContact(screen(0, 0), screen(1000, 500))).toBe(true);
  });

  test("a sub-pixel gap is within tolerance (a snap can land a hair off)", () => {
    expect(rectsInContact(screen(0, 0), screen(1920.5, 0))).toBe(true);
  });

  test("edge-sharing needs a positive overlap along that edge", () => {
    // Side by side on x, but their y ranges only meet at a point.
    expect(rectsInContact(screen(0, 0, 100, 100), screen(100, 100, 100, 100))).toBe(false);
  });
});

describe("rectsAreAdjacent", () => {
  test("a 2×1 row is adjacent", () => {
    expect(rectsAreAdjacent([screen(0, 0), screen(1920, 0)])).toBe(true);
  });

  test("a 2×2 block is adjacent", () => {
    expect(
      rectsAreAdjacent([screen(0, 0), screen(1920, 0), screen(0, 1080), screen(1920, 1080)]),
    ).toBe(true);
  });

  test("an L of three screens is adjacent (contact graph is connected)", () => {
    expect(rectsAreAdjacent([screen(0, 0), screen(1920, 0), screen(0, 1080)])).toBe(true);
  });

  test("a chain is adjacent even though the ends never touch", () => {
    expect(rectsAreAdjacent([screen(0, 0), screen(1920, 0), screen(3840, 0)])).toBe(true);
  });

  test("one screen left behind across the room is NOT adjacent", () => {
    expect(rectsAreAdjacent([screen(0, 0), screen(1920, 0), screen(9000, 5000)])).toBe(false);
  });

  test("a gap in the middle of a row is NOT adjacent", () => {
    expect(rectsAreAdjacent([screen(0, 0), screen(2200, 0)])).toBe(false);
  });

  test("two screens meeting only at a corner are NOT adjacent", () => {
    expect(rectsAreAdjacent([screen(0, 0), screen(1920, 1080)])).toBe(false);
  });

  test("fewer than two rects is trivially adjacent", () => {
    expect(rectsAreAdjacent([])).toBe(true);
    expect(rectsAreAdjacent([screen(0, 0)])).toBe(true);
  });

  test("a rigid translation never changes adjacency (the wall-drag guarantee)", () => {
    const wall = [screen(0, 0), screen(1920, 0), screen(0, 1080)];
    const moved = wall.map((r) => translateRect(r, -640, 250));
    expect(rectsAreAdjacent(moved)).toBe(true);
  });
});

describe("packRects", () => {
  test("closes the gap in a loose row, bezel-tight, keeping the order", () => {
    const packed = packRects([screen(0, 0), screen(2400, 0)]);
    expect(packed[0]).toMatchObject({ x: 0, y: 0 });
    expect(packed[1]).toMatchObject({ x: 1920, y: 0 });
    expect(rectsAreAdjacent(packed)).toBe(true);
  });

  test("packs a loose 2×2 into a tight grid", () => {
    const packed = packRects([
      screen(100, 100),
      screen(2200, 130),
      screen(90, 1300),
      screen(2250, 1290),
    ]);
    expect(packed).toEqual([
      { x: 90, y: 100, w: 1920, h: 1080 },
      { x: 2010, y: 100, w: 1920, h: 1080 },
      { x: 90, y: 1180, w: 1920, h: 1080 },
      { x: 2010, y: 1180, w: 1920, h: 1080 },
    ]);
    expect(rectsAreAdjacent(packed)).toBe(true);
  });

  test("mixed resolutions still butt up (a band takes its widest/tallest member)", () => {
    const packed = packRects([screen(0, 0, 1920, 1080), screen(2500, 0, 1280, 720)]);
    expect(packed[1]).toMatchObject({ x: 1920, y: 0, w: 1280, h: 720 });
    expect(rectsAreAdjacent(packed)).toBe(true);
  });

  test("an already-tight wall is left exactly where it is", () => {
    const wall = [screen(300, 200), screen(2220, 200)];
    expect(packRects(wall)).toEqual(wall);
  });

  test("a diagonal pair packs to a corner touch — still NOT adjacent, so combine must refuse", () => {
    const packed = packRects([screen(0, 0), screen(2500, 1400)]);
    expect(rectsAreAdjacent(packed)).toBe(false);
  });

  test("no rects → no rects", () => {
    expect(packRects([])).toEqual([]);
  });
});
