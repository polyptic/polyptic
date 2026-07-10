/**
 * Page-zoom presentation helpers (POL-57), shared by the Inspector's screen and combined-surface
 * panels so the two controls step through exactly the same values.
 *
 * The steps mirror a desktop browser's zoom menu, clamped to the contract's `Zoom` bounds (25%–400%).
 * Stepping snaps to the nearest step rather than multiplying, so a zoom that arrived from elsewhere
 * (a remembered preference, a hand-rolled API call) still lands on the ladder on the next click.
 */

/** The zoom ladder, ascending. Must stay within the contract's Zoom bounds. */
export const ZOOM_STEPS = [0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4];

export const DEFAULT_ZOOM = 1;

const MIN_ZOOM = ZOOM_STEPS[0]!;
const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1]!;

/** "125%" — how a zoom factor reads to an operator. */
export function zoomLabel(zoom: number): string {
  return `${Math.round(zoom * 100)}%`;
}

/** The next step above `zoom`, or `zoom` itself when already at the top of the ladder. */
export function zoomIn(zoom: number): number {
  return ZOOM_STEPS.find((step) => step > zoom + 1e-6) ?? MAX_ZOOM;
}

/** The next step below `zoom`, or `zoom` itself when already at the bottom of the ladder. */
export function zoomOut(zoom: number): number {
  const below = ZOOM_STEPS.filter((step) => step < zoom - 1e-6);
  return below[below.length - 1] ?? MIN_ZOOM;
}

export function canZoomIn(zoom: number): boolean {
  return zoom < MAX_ZOOM - 1e-6;
}

export function canZoomOut(zoom: number): boolean {
  return zoom > MIN_ZOOM + 1e-6;
}
