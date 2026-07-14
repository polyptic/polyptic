/**
 * @polyptic/protocol/geometry — the canvas geometry both sides of the wire agree on (POL-96/POL-100).
 *
 * A combined surface (video wall) spans ONE piece of content across several placed screens, so the
 * members must form a single CONTIGUOUS region: if they don't, the union bounding box the span math
 * uses covers canvas nobody is showing, and the wall would render a picture with holes in it. These
 * are the pure predicates that decide that question, shared by the server (which enforces the
 * invariant — combine and wall-move both re-check it, so no code path can leave an invalid wall) and
 * the console (which warns BEFORE the operator commits, and offers to pack the gaps out).
 *
 * THE ADJACENCY RULE (D95)
 *   Two members are IN CONTACT when their rectangles touch along an edge with a positive overlap, or
 *   when they intersect. A gap (beyond `tolerance`) is not contact, and neither is touching at a
 *   corner alone — a corner join leaves the wall's union box half empty.
 *   A set of members is ADJACENT when its contact graph is CONNECTED (every member reachable from
 *   every other). Overlap counts as contact deliberately: an overlapping member is showing part of
 *   the picture twice, which is odd but never a hole — a GAP is the failure mode that breaks the
 *   span math, and it's the one the rule forbids.
 *
 * All coordinates are canvas pixels (the same space as `Placement`).
 */

/** A rectangle in canvas pixels — the geometry half of a `Placement`. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Slop, in canvas px, for "touching": placements are integers, but a snap can land a hair off. */
export const CONTACT_TOLERANCE = 1;

/** Overlap of two 1-D intervals: > 0 = they overlap, ≈ 0 = they touch, < 0 = the gap between them. */
function overlap1d(aMin: number, aMax: number, bMin: number, bMax: number): number {
  return Math.min(aMax, bMax) - Math.max(aMin, bMin);
}

/**
 * Are two rectangles in contact — sharing an edge (with positive overlap along it) or intersecting?
 * A corner-only touch is NOT contact: two rects meeting at a point leave the union box half empty.
 */
export function rectsInContact(a: Rect, b: Rect, tolerance = CONTACT_TOLERANCE): boolean {
  const ox = overlap1d(a.x, a.x + a.w, b.x, b.x + b.w);
  const oy = overlap1d(a.y, a.y + a.h, b.y, b.y + b.h);
  if (ox < -tolerance || oy < -tolerance) return false; // a gap on either axis
  return ox > 0 || oy > 0; // a corner-only touch (both ≈ 0) is not contact
}

/**
 * Do these rectangles form ONE contiguous region — i.e. is their contact graph connected? Fewer than
 * two rects is trivially contiguous (there is nothing to disconnect).
 */
export function rectsAreAdjacent(rects: readonly Rect[], tolerance = CONTACT_TOLERANCE): boolean {
  if (rects.length < 2) return true;

  const seen = new Set<number>([0]);
  const queue: number[] = [0];
  while (queue.length > 0) {
    const i = queue.pop()!;
    const a = rects[i]!;
    for (let j = 0; j < rects.length; j++) {
      if (seen.has(j)) continue;
      if (rectsInContact(a, rects[j]!, tolerance)) {
        seen.add(j);
        queue.push(j);
      }
    }
  }
  return seen.size === rects.length;
}

/** Translate a rectangle by a delta (canvas px). */
export function translateRect(rect: Rect, dx: number, dy: number): Rect {
  return { ...rect, x: rect.x + dx, y: rect.y + dy };
}

/**
 * Cluster near-equal values (within `tolerance`) into ascending representatives — the column (or row)
 * lines of a loose grid of rectangles. Each returned value is the SMALLEST member of its cluster,
 * which is all `packRects` needs (it only uses the clusters to bucket rects, never their value).
 */
function clusterValues(values: readonly number[], tolerance: number): number[] {
  const sorted = [...values].sort((a, b) => a - b);
  const reps: number[] = [];
  for (const v of sorted) {
    const last = reps[reps.length - 1];
    if (last === undefined || v - last > tolerance) reps.push(v);
  }
  return reps;
}

/** The index of the cluster a value belongs to (the last representative it is within tolerance of). */
function clusterIndex(reps: readonly number[], value: number, tolerance: number): number {
  let idx = 0;
  for (let i = 0; i < reps.length; i++) {
    if (value >= reps[i]! - tolerance) idx = i;
  }
  return idx;
}

/**
 * AUTO-PACK: close the gaps in a loose grid of rectangles, bezel-tight, without reordering anything.
 *
 * Rects are bucketed into columns (by left edge) and rows (by top edge) with a generous tolerance
 * (half the smallest member), each column takes the width of its widest member and each row the
 * height of its tallest, and the cells are then laid butt-to-butt from the union's top-left origin.
 * A screen that was roughly second-from-left on the top row stays exactly that — it just loses the
 * gap. The result is NOT guaranteed adjacent (rects arranged diagonally still only meet at corners),
 * so the caller re-checks with `rectsAreAdjacent` and refuses if packing didn't save it.
 */
export function packRects(rects: readonly Rect[]): Rect[] {
  if (rects.length === 0) return [];

  const originX = Math.min(...rects.map((r) => r.x));
  const originY = Math.min(...rects.map((r) => r.y));
  const tolX = Math.min(...rects.map((r) => r.w)) / 2;
  const tolY = Math.min(...rects.map((r) => r.h)) / 2;

  const colReps = clusterValues(rects.map((r) => r.x), tolX);
  const rowReps = clusterValues(rects.map((r) => r.y), tolY);

  const colOf = rects.map((r) => clusterIndex(colReps, r.x, tolX));
  const rowOf = rects.map((r) => clusterIndex(rowReps, r.y, tolY));

  // Column widths / row heights = the largest member of each band (mixed resolutions still butt up).
  const colW = colReps.map((_, c) =>
    Math.max(...rects.filter((_r, i) => colOf[i] === c).map((r) => r.w), 0),
  );
  const rowH = rowReps.map((_, r) =>
    Math.max(...rects.filter((_x, i) => rowOf[i] === r).map((x) => x.h), 0),
  );

  // Running offsets: cell (c, r) starts where every band before it ends.
  const colX: number[] = [];
  const rowY: number[] = [];
  let cx = originX;
  for (const w of colW) {
    colX.push(cx);
    cx += w;
  }
  let cy = originY;
  for (const h of rowH) {
    rowY.push(cy);
    cy += h;
  }

  return rects.map((r, i) => ({
    ...r,
    x: colX[colOf[i]!] ?? r.x,
    y: rowY[rowOf[i]!] ?? r.y,
  }));
}
