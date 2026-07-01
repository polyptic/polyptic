/**
 * reconcileNodes — the console's keyed diff for the Vue Flow canvas.
 *
 * The store replaces its `machines`/`placements`/`videoWalls` arrays wholesale on every `admin/state`
 * broadcast (the reducer in stores/console.ts). If we rebuilt the Vue Flow node list from scratch on
 * each push, every tile would re-mount and the canvas would visibly flash. Instead we reconcile the
 * live node array against a freshly-computed DESIRED spec list, mutating IN PLACE so node identity —
 * and therefore each mounted `ScreenNode`/`WallNode` component — survives:
 *
 *   • a node whose id is still wanted keeps its EXISTING object (never replaced);
 *   • each mutable field (data / style / position) is written ONLY when it actually changed, so an
 *     unchanged tile isn't re-rendered at all on an unrelated heartbeat;
 *   • new specs are appended; vanished ids are removed.
 *
 * This is the console's equivalent of the player's keyed `v-for` (Player.vue): stable keys → patch in
 * place, never remount — the "instant, no flash" property from DECISIONS D5/D30.
 *
 * The function is deliberately pure (no store / Vue Flow runtime access) so it can be unit-tested and
 * reasoned about on its own; WallCanvas builds the specs from the store and hands them over.
 */
import type { Node } from "@vue-flow/core";

export interface NodeSpec {
  id: string;
  type: "screen" | "wall";
  position: { x: number; y: number };
  data: Record<string, unknown>;
  style: Record<string, string>;
  draggable: boolean;
  selectable: boolean;
}

export interface ReconcileOptions {
  /** Node ids whose position must NOT be moved this pass (an in-progress drag owns it). */
  freezePosition?: Set<string>;
}

/** Positions within half a display pixel are "the same" — avoids churn from float round-trips. */
const POSITION_EPSILON = 0.5;

function positionsMatch(a: { x: number; y: number } | undefined, b: { x: number; y: number }): boolean {
  return Math.abs((a?.x ?? 0) - b.x) <= POSITION_EPSILON && Math.abs((a?.y ?? 0) - b.y) <= POSITION_EPSILON;
}

/**
 * Structural equality for the plain data/style objects WallCanvas builds. These are JSON-shaped
 * (primitives, nulls, nested plain objects/arrays) and constructed with a fixed key order, so a
 * serialize-and-compare is both correct and cheaper than the re-render it saves.
 */
function shallowEqualJson(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Reconcile `nodes` (mutated in place) to match `desired`, preserving node identity and touching only
 * fields that changed. Order: existing nodes stay put, new nodes are appended.
 */
export function reconcileNodes(nodes: Node[], desired: NodeSpec[], opts: ReconcileOptions = {}): void {
  const freeze = opts.freezePosition;
  const wanted = new Set(desired.map((d) => d.id));

  // Drop nodes that are no longer wanted (unplaced, walled, or a vanished wall).
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (n && !wanted.has(n.id)) nodes.splice(i, 1);
  }

  for (const spec of desired) {
    const existing = nodes.find((n) => n.id === spec.id);
    if (!existing) {
      nodes.push({
        id: spec.id,
        type: spec.type,
        position: { ...spec.position },
        data: spec.data,
        style: spec.style,
        draggable: spec.draggable,
        selectable: spec.selectable,
      } as Node);
      continue;
    }
    // Patch ONLY what changed — an untouched field means no re-render for that tile.
    if (!shallowEqualJson(existing.data, spec.data)) existing.data = spec.data;
    if (!shallowEqualJson(existing.style, spec.style)) existing.style = spec.style;
    if (!freeze?.has(spec.id) && !positionsMatch(existing.position, spec.position)) {
      existing.position = { ...spec.position };
    }
  }
}
