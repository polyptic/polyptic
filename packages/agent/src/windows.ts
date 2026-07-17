/**
 * POL-18 — pure helpers for web-window placement: the agent-side reconcile of the `windows` the
 * server rides on `server/apply`, and the canvas → output pixel mapping the sway backend places
 * with. Pure functions so the reconcile/scale logic is unit-testable without a compositor.
 */
import type { Geometry, WindowPlacement } from "@polyptic/protocol";

/** A placed window as the agent tracks it: which output(s) it lives on + the exact spec it satisfies.
 *  `connectors` is sorted; length 1 = an ordinary single-output window, length >1 = one window
 *  SPANNING a single box's outputs (POL-156). */
export interface PlacedWindow {
  connectors: string[];
  signature: string;
}

/** One window the reconcile decided to (re)place. `connectors` (sorted) is every output the window
 *  covers on THIS box: one for an ordinary window, many for a wall the box spans (POL-156). */
export interface WindowToPlace {
  id: string;
  connectors: string[];
  /** A representative spec (id + url + zoom; region/canvas of the first member). Every member of a
   *  spanning wall carries the same url/zoom by construction; the span covers full outputs, so the
   *  per-member region is not used for a multi-connector placement. */
  window: WindowPlacement;
  signature: string;
}

/**
 * The identity of a window PLACEMENT: same id + url + zoom + the exact set of (connector, region,
 * canvas) it covers = nothing to do. A changed url/zoom, a moved/resized region, or a change to the
 * set of outputs it spans re-launches/re-places that one window in place (same id); everything else
 * is untouched — the wall never blacks out for an unrelated change (D5's spirit on the agent channel).
 */
export function windowSignature(
  id: string,
  url: string,
  zoom: number,
  members: { connector: string; region: Geometry; canvas: Geometry }[],
): string {
  const g = (r: Geometry): string => `${r.x},${r.y},${r.w},${r.h}`;
  const parts = members
    .map((m) => `${m.connector}@${g(m.region)}/${g(m.canvas)}`)
    .sort();
  return [id, url, `z${zoom}`, ...parts].join(" ");
}

/**
 * Diff the currently placed windows against what an apply wants. Windows are keyed by their surface
 * id; a wall spanning several of one box's outputs carries the SAME id on each member (the server
 * stamps `wall:<id>` on every member), so those collapse into ONE placement covering every member's
 * connector (POL-156) — the agent floats a single Chrome across them. A window that moved connectors,
 * changed url/zoom, or changed its span is a remove + place of the same id.
 */
export function diffWindows(
  placed: ReadonlyMap<string, PlacedWindow>,
  wanted: { connector: string; windows: WindowPlacement[] }[],
): { toPlace: WindowToPlace[]; toRemove: string[] } {
  // Group every wanted window by its id, collecting each member (connector + its region/canvas).
  const grouped = new Map<
    string,
    { url: string; zoom: number; members: { connector: string; window: WindowPlacement }[] }
  >();
  for (const screen of wanted) {
    for (const w of screen.windows) {
      let g = grouped.get(w.id);
      if (!g) {
        g = { url: w.url, zoom: w.zoom, members: [] };
        grouped.set(w.id, g);
      }
      g.members.push({ connector: screen.connector, window: w });
    }
  }

  const toPlace: WindowToPlace[] = [];
  for (const [id, g] of grouped) {
    const members = g.members
      .map((m) => ({ connector: m.connector, region: m.window.region, canvas: m.window.canvas }))
      .sort((a, b) => (a.connector < b.connector ? -1 : a.connector > b.connector ? 1 : 0));
    const connectors = members.map((m) => m.connector);
    const signature = windowSignature(id, g.url, g.zoom, members);
    const prev = placed.get(id);
    if (!prev || prev.signature !== signature) {
      // The representative spec: the first member's window (url/zoom/region/canvas). Placement uses
      // `connectors` to decide single-output vs span; the region is only consulted for a single output.
      toPlace.push({ id, connectors, window: g.members[0]!.window, signature });
    }
  }

  const toRemove: string[] = [];
  for (const id of placed.keys()) {
    if (!grouped.has(id)) toRemove.push(id);
  }
  return { toPlace, toRemove };
}

/** An output's mode + position in the compositor's global coordinate space. */
export interface OutputRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A rect in sway's global pixel space, as a window is floated/sized/moved to. */
export interface PixelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Map a window's region (slice-canvas pixels) onto GLOBAL compositor pixels for its output. The
 * player runs fullscreen on the output, so the canvas maps onto the output's full mode; when they
 * differ (a 1080p canvas on a 4K panel) the region scales proportionally — the same mapping the
 * player's own percentage-based regionStyle performs. Rounded to whole pixels; sizes are kept ≥1.
 */
export function regionToOutputRect(
  region: Geometry,
  canvas: Geometry,
  output: OutputRect,
): PixelRect {
  const sx = output.width / (canvas.w || 1);
  const sy = output.height / (canvas.h || 1);
  return {
    x: Math.round(output.x + (region.x - canvas.x) * sx),
    y: Math.round(output.y + (region.y - canvas.y) * sy),
    w: Math.max(1, Math.round(region.w * sx)),
    h: Math.max(1, Math.round(region.h * sy)),
  };
}

/**
 * POL-156 — the GLOBAL rect a spanning web-window covers: the bounding box (union) of the given
 * outputs' rects in sway's global coordinate space. A single window floated to this rect covers every
 * one of a box's wall outputs edge-to-edge (e.g. DP-1 + HDMI-A-1 side by side → the full 3840×1080),
 * which is what makes a framing-blocked page fill a single-box wall instead of a top strip. Throws if
 * any connector has no known output rect (the caller cannot place a span it can't measure).
 */
export function spanningOutputRect(
  connectors: string[],
  outputs: ReadonlyMap<string, OutputRect>,
): PixelRect {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const c of connectors) {
    const o = outputs.get(c);
    if (!o) throw new Error(`no output rect for ${c}`);
    minX = Math.min(minX, o.x);
    minY = Math.min(minY, o.y);
    maxX = Math.max(maxX, o.x + o.width);
    maxY = Math.max(maxY, o.y + o.height);
  }
  return { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };
}

/**
 * POL-162 — does this web-window cover an ENTIRE single output? Then it is placed EXACTLY like the
 * player: fullscreened (sway guarantees edge-to-edge, no math), NOT floated with a hand-computed
 * rect. The floating + geometry + self-verify path is kept ONLY for the two cases that genuinely
 * need it:
 *   1. a SUB-REGION window (covers part of one output, player content around it), and
 *   2. a single-box MULTI-OUTPUT SPAN (POL-156 — a fullscreen surface can't cross outputs, so the
 *      window must float across the union).
 * So the fullscreen path is exactly: one connector AND a full-canvas region.
 */
export function windowFillsSingleOutput(connectors: string[], win: WindowPlacement): boolean {
  return connectors.length === 1 && isFullCanvasRegion(win.region, win.canvas);
}

/** Does `region` cover the whole `canvas` — same origin, same size? A full-canvas region is a
 *  whole-screen web-window (the common, keeps-breaking case); anything smaller is a sub-region. */
export function isFullCanvasRegion(region: Geometry, canvas: Geometry): boolean {
  return (
    region.x === canvas.x &&
    region.y === canvas.y &&
    region.w === canvas.w &&
    region.h === canvas.h
  );
}

/**
 * POL-162 — the `swaymsg` that places a full-region single-output web-window EXACTLY like the
 * player: park its container on the target output, then make it that output's FULLSCREEN surface.
 * sway guarantees edge-to-edge — so there is NO `resize set`, NO `move absolute position`, no target
 * rect, and no self-verify loop. Enabling fullscreen here takes the workspace's fullscreen from the
 * player automatically (only one container is fullscreen per workspace), so the web-window becomes
 * the visible surface. Pure, so the "move + fullscreen, and nothing else" shape is unit-provable.
 */
export function windowFullscreenCommand(conId: number, output: string): string {
  return `[con_id=${conId}] move container to output ${output}, fullscreen enable`;
}

/**
 * The exact `swaymsg` command that FLOATS + SIZES + POSITIONS a placed web-window's container onto
 * its computed rect (POL-18/POL-150). Pure, so the whole region → sway-geometry mapping — not just
 * the pixel math — is unit-provable without a compositor.
 *
 * The window is first re-parented to a TARGET output (`move container to output`), exactly like the
 * player's own move-to-output: a Wayland client cannot self-position, and a fresh window appears on
 * whatever workspace is focused — which may be a DIFFERENT output — so relocating it first guarantees
 * the float/resize is applied in a known context (the fix for POL-150's origin offset). Then it is
 * floated (no border), sized to the rect, and its top-left moved to the rect origin in sway's GLOBAL
 * coordinate space (`move absolute position`). A full-output rect ⇒ edge-to-edge cover; a sub-region
 * rect ⇒ exactly that region's bounds; a multi-output UNION rect (POL-156) ⇒ the window spans them —
 * a floating window is not clipped to the output it was parented to.
 */
export function windowPlacementCommand(
  conId: number,
  output: string,
  rect: PixelRect,
): string {
  return (
    `[con_id=${conId}] move container to output ${output}, ` +
    `floating enable, border none, ` +
    `resize set width ${rect.w} px height ${rect.h} px, ` +
    `move absolute position ${rect.x} ${rect.y}`
  );
}

/**
 * POL-152 — does a window's ACTUAL geometry (read back from the compositor) match the target rect,
 * within a small tolerance? Sway can round a floating window a pixel or two (fractional scale, border
 * math), so an exact compare would loop forever; `tol` (default 2px) is the slack. This is the test
 * the self-verifying place loop retries against — the deterministic answer to "did the float/resize
 * actually take, or did the window land half-width / on the wrong output?".
 */
export function geometryMatches(actual: PixelRect, target: PixelRect, tol = 2): boolean {
  return (
    Math.abs(actual.x - target.x) <= tol &&
    Math.abs(actual.y - target.y) <= tol &&
    Math.abs(actual.w - target.w) <= tol &&
    Math.abs(actual.h - target.h) <= tol
  );
}

/** A loosely-typed sway tree node (we read only `id` and `rect`, defensively). */
interface SwayTreeNode {
  id?: unknown;
  rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } | null;
  nodes?: unknown;
  floating_nodes?: unknown;
}

/**
 * POL-152 — find a container's on-screen rect in a parsed `swaymsg -t get_tree` tree. Walks both the
 * tiled (`nodes`) and floating (`floating_nodes`) children — a placed web-window is a floating node —
 * and returns its global-pixel rect, or `null` if the id isn't in the tree (the window vanished, or
 * the read raced its creation). Pure, so the read-back → compare step is unit-provable.
 */
export function findConRect(tree: unknown, conId: number): PixelRect | null {
  const node = tree as SwayTreeNode | null;
  if (!node || typeof node !== "object") return null;
  if (node.id === conId) {
    const r = node.rect;
    if (
      r &&
      typeof r.x === "number" &&
      typeof r.y === "number" &&
      typeof r.width === "number" &&
      typeof r.height === "number"
    ) {
      return { x: r.x, y: r.y, w: r.width, h: r.height };
    }
    return null;
  }
  for (const key of ["nodes", "floating_nodes"] as const) {
    const kids = node[key];
    if (Array.isArray(kids)) {
      for (const kid of kids) {
        const found = findConRect(kid, conId);
        if (found) return found;
      }
    }
  }
  return null;
}

/** A placed web-window as the surface resolver reasons about it (id + the outputs it covers + its
 *  region/canvas, so full-region vs sub-region is decidable). */
export interface SurfaceWindow {
  id: string;
  connectors: string[];
  window: WindowPlacement;
}

/**
 * POL-162/POL-146/POL-154 — the ONE rule for WHICH surface owns a connector's glass, so ident,
 * teardown, placement and respawn all agree instead of two fullscreen mechanisms fighting. Given the
 * web-windows currently placed on this box, decide the standing state for one connector:
 *
 *   - `window-fullscreen` — a FULL-region single-output web-window IS the output's fullscreen surface
 *     (the POL-162 path); nothing else is drawn there.
 *   - `player-windowed` — a floating (sub-region / multi-output span) web-window covers PART of the
 *     output, so the player stays windowed (a tiled view that fills the glass) with the floater
 *     composited above it (POL-146).
 *   - `player-fullscreen` — no web-window here, so the player reclaims the whole output as a
 *     fullscreen surface (the backend's standing invariant).
 *
 * Pure, so the surface state machine is unit-pinned without a compositor. The agent maps each result
 * to the matching swaymsg toggle (fullscreen the window, un-fullscreen the player, or fullscreen the
 * player).
 */
export type VisibleSurface =
  | { kind: "window-fullscreen"; windowId: string }
  | { kind: "player-windowed" }
  | { kind: "player-fullscreen" };

export function visibleSurfaceFor(
  connector: string,
  windows: readonly SurfaceWindow[],
): VisibleSurface {
  // A full-region single-output web-window is the fullscreen surface (POL-162).
  for (const w of windows) {
    if (windowFillsSingleOutput(w.connectors, w.window) && w.connectors[0] === connector) {
      return { kind: "window-fullscreen", windowId: w.id };
    }
  }
  // A floating (sub-region / span) web-window covers this output — the player stays windowed beneath.
  for (const w of windows) {
    if (w.connectors.includes(connector)) return { kind: "player-windowed" };
  }
  // Nothing floated here — the player owns the whole glass.
  return { kind: "player-fullscreen" };
}
