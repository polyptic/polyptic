/**
 * termFit — the integer-grid fit math behind the operator console's terminal (POL-131).
 *
 * The bug this replaces: FitAddon sizes the grid from `getComputedStyle(parent).height`, which —
 * under the app-wide `* { box-sizing: border-box }` reset — is the BORDER-BOX height, padding
 * included. `.term-host`'s 12px vertical padding was therefore counted as usable rows, the grid
 * overflowed the content box, and the bottom row (where the prompt lives) rendered half-clipped.
 * Browser zoom made it worse: at fractional devicePixelRatios xterm's CSS cell height is itself
 * fractional (e.g. 15.19px at 125%), so the overflow grew with zoom.
 *
 * The rule is the classic one: the terminal shows exactly `floor(content / cell)` whole cells and
 * the remainder is letterboxed, never clipped. The caller measures the CONTENT box (padding
 * excluded) and xterm's actual CSS cell size, and sends the SAME cols×rows to the PTY over the
 * relay, so `stty size` always agrees with what is visible.
 *
 * Pure math, no DOM — unit-tested in test/term-fit.test.ts.
 */

export interface CellSize {
  /** CSS pixel width of one terminal cell (fractional under zoom). */
  width: number;
  /** CSS pixel height of one terminal cell (fractional under zoom). */
  height: number;
}

export interface TermGrid {
  cols: number;
  rows: number;
}

/**
 * The largest whole-cell grid that fits inside a content box, or null when the inputs cannot
 * produce one (cell metrics not measured yet, collapsed container).
 *
 * @param contentWidth  content-box width in CSS px (padding/border EXCLUDED)
 * @param contentHeight content-box height in CSS px (padding/border EXCLUDED)
 * @param cell          xterm's measured CSS cell size (may be fractional at odd zooms)
 * @param scrollbarWidth width reserved for xterm's scrollbar, in CSS px
 */
export function fitGrid(contentWidth: number, contentHeight: number, cell: CellSize, scrollbarWidth = 0): TermGrid | null {
  if (!Number.isFinite(cell.width) || !Number.isFinite(cell.height) || cell.width <= 0 || cell.height <= 0) return null;
  if (!Number.isFinite(contentWidth) || !Number.isFinite(contentHeight)) return null;
  if (!Number.isFinite(scrollbarWidth) || scrollbarWidth < 0) scrollbarWidth = 0;

  // floor() is the whole fix: a partial row is EXCLUDED (letterboxed), never painted clipped.
  const cols = Math.floor((contentWidth - scrollbarWidth) / cell.width);
  const rows = Math.floor(contentHeight / cell.height);

  // A PTY cannot be 0-sized; clamp to the same floor xterm itself enforces (min 2 cols, 1 row).
  return { cols: Math.max(2, cols), rows: Math.max(1, rows) };
}
