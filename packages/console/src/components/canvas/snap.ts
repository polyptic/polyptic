/**
 * Canvas snapping + alignment guides (POL-100) — the Wall canvas's half of the Studio's ergonomics.
 *
 * The Studio (POL-42) already drags elements against the page's edges/centres and its siblings, with
 * a dashed guide showing what you're aligned to and a plain grid when you're aligned to nothing. The
 * wall canvas now does exactly the same thing, in canvas pixels instead of page percent, so the two
 * surfaces feel like one product: candidates are every OTHER tile's left/centre/right (and
 * top/middle/bottom) edges, the moving tile snaps by whichever of ITS three edges lands closest, and
 * an unsnapped axis falls back to a coarse grid.
 *
 * Snapping a tile's LEFT edge onto a neighbour's RIGHT edge is what makes a bezel-tight wall — you
 * drag a screen at the wall and it clicks into place against the one next to it. Same maths, both
 * axes, both directions.
 *
 * Pure functions: no Vue, no Vue Flow, no DOM — the canvas component owns the pixels, this owns the
 * arithmetic (and the tests own this).
 */
import type { Rect } from "@polyptic/protocol";

/** Snap threshold in CANVAS px (≈ 2% of a 1080p screen's width — a few px on screen at wall zoom). */
export const SNAP_PX = 40;

/** Grid the drag falls back to when an axis snaps to nothing (canvas px; ≈ 1/16 of a 1080p screen). */
export const GRID_PX = 120;

/** Keyboard nudge steps (canvas px): a nudge you can see, and a Shift-nudge that crosses the canvas. */
export const NUDGE_PX = 20;
export const NUDGE_BIG_PX = 200;

/** The alignment candidates on each axis: every sibling's near edge, centre and far edge. */
export interface SnapCandidates {
  cx: number[];
  cy: number[];
}

/** What a snap resolved to: the position to use, plus the guide line to draw on each axis (if any). */
export interface SnapResult {
  x: number;
  y: number;
  /** Canvas-x of the vertical guide the tile latched onto, or null when it snapped to nothing. */
  guideX: number | null;
  /** Canvas-y of the horizontal guide, or null. */
  guideY: number | null;
}

/**
 * Alignment candidates from the tiles the moving one is being dragged past, plus (optionally) the
 * bounds of everything on the canvas — its outer edges and centre — so a lone tile still has the
 * wall itself to align to.
 */
export function snapCandidates(siblings: readonly Rect[], canvasBounds?: Rect): SnapCandidates {
  const cx: number[] = [];
  const cy: number[] = [];
  for (const s of siblings) {
    cx.push(s.x, s.x + s.w / 2, s.x + s.w);
    cy.push(s.y, s.y + s.h / 2, s.y + s.h);
  }
  if (canvasBounds) {
    const b = canvasBounds;
    cx.push(b.x, b.x + b.w / 2, b.x + b.w);
    cy.push(b.y, b.y + b.h / 2, b.y + b.h);
  }
  return { cx, cy };
}

/** The union bounding box of some rects, or undefined when there are none. */
export function unionBounds(rects: readonly Rect[]): Rect | undefined {
  if (rects.length === 0) return undefined;
  const minX = Math.min(...rects.map((r) => r.x));
  const minY = Math.min(...rects.map((r) => r.y));
  const maxX = Math.max(...rects.map((r) => r.x + r.w));
  const maxY = Math.max(...rects.map((r) => r.y + r.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/** Snap one axis: try the moving edge, then its centre, then its far edge, against each candidate. */
function snapAxis(
  value: number,
  size: number,
  candidates: readonly number[],
  threshold: number,
): { value: number; guide: number | null } {
  for (const c of candidates) {
    if (Math.abs(value - c) < threshold) return { value: c, guide: c };
    if (Math.abs(value + size / 2 - c) < threshold) return { value: c - size / 2, guide: c };
    if (Math.abs(value + size - c) < threshold) return { value: c - size, guide: c };
  }
  return { value, guide: null };
}

export interface SnapOptions {
  threshold?: number;
  /** Grid to fall back to on an axis that snapped to nothing. Pass 0 to leave the axis untouched. */
  grid?: number;
}

/**
 * Snap a moving rectangle against the given candidates. An axis that latches onto a candidate returns
 * the guide to draw; an axis that latches onto nothing falls back to the grid (Studio's exact rule).
 */
export function snapRect(
  rect: Rect,
  candidates: SnapCandidates,
  options: SnapOptions = {},
): SnapResult {
  const threshold = options.threshold ?? SNAP_PX;
  const grid = options.grid ?? GRID_PX;

  const sx = snapAxis(rect.x, rect.w, candidates.cx, threshold);
  const sy = snapAxis(rect.y, rect.h, candidates.cy, threshold);

  const x = sx.guide === null && grid > 0 ? Math.round(sx.value / grid) * grid : sx.value;
  const y = sy.guide === null && grid > 0 ? Math.round(sy.value / grid) * grid : sy.value;

  return { x, y, guideX: sx.guide, guideY: sy.guide };
}

/**
 * A keyboard nudge: step the rect by (dx, dy) and then let it snap, so arrow-keying a screen towards
 * its neighbour still lands bezel-tight instead of one pixel shy. The nudge itself is NOT re-gridded
 * (a deliberate step must stay that step), so the fallback grid is off here.
 *
 * Two rules the drag path doesn't need, found by driving it in a browser:
 *   - only the axis being nudged may move (a snap on the OTHER axis would teleport the tile sideways);
 *   - a snap may never pull the tile BACK where it came from. A screen already flush against its
 *     neighbour is sitting exactly on a candidate, so a naive re-snap would swallow every nudge and
 *     the tile could never leave the wall. A snap that doesn't travel in the direction you pressed is
 *     discarded, and you get the plain step.
 */
export function nudgeRect(
  rect: Rect,
  dx: number,
  dy: number,
  candidates: SnapCandidates,
  threshold = SNAP_PX,
): SnapResult {
  const moved: Rect = { ...rect, x: rect.x + dx, y: rect.y + dy };
  const snapped = snapRect(moved, candidates, { threshold, grid: 0 });

  const keep = (
    axisStep: number,
    from: number,
    to: number,
    guide: number | null,
  ): { value: number; guide: number | null } => {
    if (axisStep === 0) return { value: from, guide: null }; // this axis isn't being nudged
    const travelled = to - from;
    // The snap must move the tile, and move it the way the operator pressed.
    if (travelled === 0 || Math.sign(travelled) !== Math.sign(axisStep)) {
      return { value: from + axisStep, guide: null };
    }
    return { value: to, guide };
  };

  const x = keep(dx, rect.x, snapped.x, snapped.guideX);
  const y = keep(dy, rect.y, snapped.y, snapped.guideY);
  return { x: x.value, y: y.value, guideX: x.guide, guideY: y.guide };
}
