/**
 * Playlist rotation logic (POL-34) — the pure, clock-in/answer-out half of the carousel, kept out of
 * the Vue component so it can be unit-tested without a DOM.
 *
 * Two rotation modes, decided by the entries themselves:
 *
 *   - FULLY TIMED (every entry has an effective duration): the on-air entry is DERIVED from the
 *     wall clock against the surface's shared `startedAt` anchor — (now − startedAt) mod cycle.
 *     Every member of a video wall lands on the same entry without talking to each other, and a
 *     rebooting box rejoins the rotation mid-cycle instead of restarting it. Scheduling re-derives
 *     at every boundary, so timer drift can never accumulate.
 *
 *   - SEQUENTIAL (any entry is an untimed video): "advance when the video ends" is an event only the
 *     playing element knows, so the position cannot come from a clock. The rotation walks the list
 *     from the top; timed entries hold for their duration, untimed videos yield on `ended`.
 */
import type { PlaylistEntry } from "@polyptic/protocol";

/** Fallback hold for an entry that should be timed but carries no duration (authoring-time drift).
 *  Mirrors the server's DEFAULT_PLAYLIST_ITEM_SECONDS — both ends must agree on what such an entry
 *  does, even though the server normally resolves the default in before it ever ships. */
export const FALLBACK_HOLD_SECONDS = 15;

/** Effective hold time for one entry in ms — undefined ONLY for an untimed video ("until it ends"). */
export function entryHoldMs(entry: PlaylistEntry): number | undefined {
  if (entry.durationSeconds !== undefined) return entry.durationSeconds * 1000;
  return entry.kind === "video" ? undefined : FALLBACK_HOLD_SECONDS * 1000;
}

/** True when every entry is timed — the clock-derivable mode. */
export function allTimed(items: PlaylistEntry[]): boolean {
  return items.every((entry) => entryHoldMs(entry) !== undefined);
}

/** For a FULLY TIMED playlist: the entry on air at `nowMs` and how long until it yields, derived
 *  from the shared anchor. A clock behind the anchor (skew, or a just-assigned playlist) still maps
 *  into the cycle deterministically. */
export function timedPosition(
  items: PlaylistEntry[],
  startedAtMs: number,
  nowMs: number,
): { index: number; remainingMs: number } {
  if (items.length === 0) return { index: 0, remainingMs: 0 };
  const holds = items.map((entry) => entryHoldMs(entry) ?? FALLBACK_HOLD_SECONDS * 1000);
  const total = holds.reduce((sum, hold) => sum + hold, 0);
  let offset = (nowMs - startedAtMs) % total;
  if (offset < 0) offset += total;
  let index = 0;
  while (offset >= (holds[index] ?? Infinity)) {
    offset -= holds[index] ?? 0;
    index += 1;
  }
  return { index, remainingMs: (holds[index] ?? 0) - offset };
}

/**
 * A stable signature of the rotation's IDENTITY — what makes it "the same playlist still playing".
 * The send-time auth stamp (POL-24) rewrites entry URLs with fresh tokens, and that must NOT restart
 * the rotation, so an entry is identified by its library source when it has one and only falls back
 * to its URL (query stripped) for the exotic sourceless case. Reordering, retiming, adding/removing
 * entries, or a re-assignment (new `startedAt`) all change the signature → the rotation restarts.
 */
export function rotationSignature(items: PlaylistEntry[], startedAt: string): string {
  return JSON.stringify([
    startedAt,
    items.map((entry) => [
      entry.kind,
      entry.sourceId ?? entry.url.split("?")[0],
      entry.durationSeconds ?? null,
    ]),
  ]);
}
