/**
 * termFit (POL-131) — the operator console's integer-grid fit math.
 *
 * The invariant these pin: the rendered grid NEVER exceeds the content box — the last row is
 * always whole (the prompt row was rendering half-clipped on real hardware). The regression case
 * is the measured one from the live repro: FitAddon read the border-box height (644px) instead of
 * the content box (620px) under the app's `* { box-sizing: border-box }` reset, proposed 42 rows
 * = 630px, and clipped the prompt; fractional cell heights at 125%/150% browser zoom widened the
 * clip to a full line.
 */
import { describe, expect, test } from "bun:test";

import { fitGrid } from "../src/components/termFit";

describe("fitGrid (POL-131)", () => {
  test("the regression: content box 620px at cell 15px gives 41 whole rows, not FitAddon's 42", () => {
    // Measured live: .term-host border-box 644px, padding 12px top+bottom → content 620px.
    // FitAddon fit floor(644/15) = 42 rows = 630px and clipped the prompt by 10px.
    const grid = fitGrid(872, 620, { width: 7.823008849557522, height: 15 });
    expect(grid).not.toBeNull();
    expect(grid!.rows).toBe(41);
    expect(grid!.rows * 15).toBeLessThanOrEqual(620);
  });

  test.each([
    // [zoom label, fractional cell height measured live at that devicePixelRatio]
    ["125%", 15.19047619047619],
    ["150%", 15.333333333333334],
    ["110%", 15.454545454545455],
    ["90%", 15.555555555555555],
  ])("fractional cell height at %s browser zoom still yields a grid inside the box", (_zoom, cellH) => {
    const grid = fitGrid(872, 620, { width: 7.8, height: cellH });
    expect(grid).not.toBeNull();
    expect(grid!.rows * cellH).toBeLessThanOrEqual(620);
    // And the NEXT row would not have fit — we letterbox the remainder, we don't waste a whole row.
    expect((grid!.rows + 1) * cellH).toBeGreaterThan(620);
  });

  test("property: grid never exceeds the content box across a sweep of heights and cells", () => {
    for (let h = 1; h <= 2000; h += 7) {
      for (const cellH of [12, 15, 15.19047619047619, 17.36, 21.000001]) {
        const grid = fitGrid(800, h, { width: 8, height: cellH });
        expect(grid).not.toBeNull();
        // rows*cell fits — except when the clamp to 1 row kicks in (a PTY cannot be 0-sized).
        if (h >= cellH) expect(grid!.rows * cellH).toBeLessThanOrEqual(h);
        else expect(grid!.rows).toBe(1);
      }
    }
  });

  test("cols subtract the scrollbar and floor to whole cells", () => {
    // 872 content − 15 scrollbar = 857; 857 / 7.823 = 109.55 → 109 whole columns.
    const grid = fitGrid(872, 620, { width: 7.823008849557522, height: 15 }, 15);
    expect(grid!.cols).toBe(109);
    expect(grid!.cols * 7.823008849557522 + 15).toBeLessThanOrEqual(872);
  });

  test("clamps to xterm's minimums (2 cols, 1 row) rather than proposing a 0-sized PTY", () => {
    expect(fitGrid(5, 5, { width: 8, height: 15 })).toEqual({ cols: 2, rows: 1 });
    expect(fitGrid(0, 0, { width: 8, height: 15 })).toEqual({ cols: 2, rows: 1 });
  });

  test("returns null while cell metrics are unusable (renderer not measured yet)", () => {
    expect(fitGrid(800, 600, { width: 0, height: 15 })).toBeNull();
    expect(fitGrid(800, 600, { width: 8, height: 0 })).toBeNull();
    expect(fitGrid(800, 600, { width: NaN, height: 15 })).toBeNull();
    expect(fitGrid(800, 600, { width: 8, height: Number.POSITIVE_INFINITY })).toBeNull();
  });

  test("non-finite container measurements are refused, a bogus scrollbar width is ignored", () => {
    expect(fitGrid(NaN, 600, { width: 8, height: 15 })).toBeNull();
    expect(fitGrid(800, NaN, { width: 8, height: 15 })).toBeNull();
    expect(fitGrid(800, 600, { width: 8, height: 15 }, NaN)).toEqual(fitGrid(800, 600, { width: 8, height: 15 }, 0));
    expect(fitGrid(800, 600, { width: 8, height: 15 }, -5)).toEqual(fitGrid(800, 600, { width: 8, height: 15 }, 0));
  });
});
