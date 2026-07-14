/**
 * Inverse actions (POL-93) — the honest half of "Undo".
 *
 * There is NO server-side undo journal, and we did not invent one. An Undo affordance is offered
 * only where the console can name a TRUE INVERSE it can call through the existing REST API with
 * state it already holds:
 *
 *   - a rename            → rename back to the previous name (exact);
 *   - an unplace          → place the screen back at the placement we captured (exact);
 *   - a content swap      → re-assign the source that WAS on the screen/wall (see below);
 *   - a deleted source    → re-create it from the copy we held (NOT exact — see below).
 *
 * Where an inverse does not exist, the toast reports what happened and offers no button. Deleting a
 * machine or a screen is a real deletion (the box must re-enrol); deleting a scene throws away a
 * snapshot the console cannot rebuild (POST /scenes snapshots the CURRENT wall, not the old one);
 * deleting a credential profile throws away a client secret the console has never been allowed to
 * hold; deleting a mural takes its placements with it. Pretending otherwise would be worse than
 * saying nothing.
 *
 * Two caveats are stated out loud rather than papered over:
 *   - RE-CREATING A DELETED SOURCE mints a NEW id. The library entry comes back; the screens the
 *     server cleared when it was deleted do not re-arm themselves.
 *   - THE PREVIOUS ASSIGNMENT is reconstructed from what admin/state actually carries: a screen's
 *     `content` read-out is `{name, kind}`, not the assignment. When exactly one library source has
 *     that name+kind, the inverse is unambiguous and Undo is offered. An ad-hoc URL (whose name is
 *     derived) or an ambiguous name yields no Undo rather than a guess at what the wall had on it.
 */
import type { ContentSource, Placement, ScreenView } from "@polyptic/protocol";
import type { ContentAssignment } from "./stores/console";

/** The content read-out admin/state carries for a screen — a name + kind, never the assignment. */
export type ScreenContent = NonNullable<ScreenView["content"]>;

/**
 * The assignment that was on a screen/wall before we changed it, reconstructed from the library —
 * or null when it cannot be known for certain (nothing was showing; an ad-hoc URL; two sources
 * share the name+kind). Null means: no Undo button.
 */
export function previousAssignment(
  content: ScreenContent | null | undefined,
  sources: readonly ContentSource[],
): ContentAssignment | null {
  if (!content) return null;
  const matches = sources.filter((s) => s.name === content.name && s.kind === content.kind);
  const only = matches.length === 1 ? matches[0] : undefined;
  return only ? { sourceId: only.id } : null;
}

/** The body that re-creates a deleted library source (new id, same substance). */
export function recreateSourceBody(source: ContentSource): Record<string, unknown> {
  const { id: _id, ...rest } = source;
  return rest;
}

/** The body that puts an unplaced screen back exactly where it was. */
export function restorePlacementBody(p: Placement): {
  muralId: string;
  x: number;
  y: number;
  w: number;
  h: number;
} {
  return { muralId: p.muralId, x: p.x, y: p.y, w: p.w, h: p.h };
}

/**
 * The previous name for a rename's inverse — or null when there is nothing to put back (no previous
 * name, or the rename was a no-op). Keeps "Undo" off a toast that would do nothing.
 */
export function previousName(before: string | undefined, after: string): string | null {
  const trimmed = (before ?? "").trim();
  if (!trimmed || trimmed === after) return null;
  return trimmed;
}
