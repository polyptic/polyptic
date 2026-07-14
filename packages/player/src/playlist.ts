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
/**
 * POL-110 — health, substitution and prewarm are layered ON TOP of that timeline, never into it.
 *
 * Each entry is proven reachable in its own right (the POL-86 prober, one target per entry), so a
 * playlist can no longer paint Chrome's sad face when one URL dies. The load-bearing rule is that a
 * dead entry does NOT re-time the rotation: the slot boundaries stay derived from the FULL item list,
 * exactly as before, and only the CONTENT of a dead slot changes — it is filled by the next healthy
 * entry in cyclic order (which is the very entry that takes over at the next boundary, so a dead slot
 * simply widens its neighbour's dwell — no flash, no duplicate cut).
 *
 * That is what keeps a video wall in phase. Health is a LOCAL, per-box observation: box A may have
 * proven entry 3 while box B is still probing it. If a dead entry were spliced out of the list, the
 * cycle length would differ between those boxes and they would drift apart forever. Because the
 * canonical timeline is computed from every entry regardless of health, two boxes that disagree about
 * one entry still agree about every boundary — they differ only in what that one slot shows, and
 * re-converge on the very next slot.
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

// ── POL-110: per-entry health ────────────────────────────────────────────────

/** Is the entry at this index PROVEN paintable right now? (The rotator answers from the prober.) */
export type EntryHealth = (index: number) => boolean;

/** The probe target id for one entry — the prober keys its state by this, so it survives re-renders. */
export function entryProbeId(surfaceId: string, index: number): string {
  return `${surfaceId}#${index}`;
}

/** The entry index inside a probe id, or undefined if it isn't one of ours. */
export function entryProbeIndex(surfaceId: string, id: string): number | undefined {
  if (!id.startsWith(`${surfaceId}#`)) return undefined;
  const index = Number(id.slice(surfaceId.length + 1));
  return Number.isInteger(index) && index >= 0 ? index : undefined;
}

/**
 * What actually goes on the glass for the canonical slot `index`: itself when it is healthy, else the
 * next healthy entry in cyclic order — the one that takes the screen at the next boundary anyway, so
 * the dead slot is absorbed into its dwell rather than cutting twice. `undefined` when NOTHING in the
 * rotation is currently provable (the region shows the calm placeholder and keeps probing).
 */
export function displayIndexFor(
  items: PlaylistEntry[],
  index: number,
  healthy: EntryHealth,
): number | undefined {
  const n = items.length;
  if (n === 0) return undefined;
  for (let step = 0; step < n; step += 1) {
    const candidate = (index + step) % n;
    if (healthy(candidate)) return candidate;
  }
  return undefined;
}

/**
 * SEQUENTIAL mode only: how long this slot holds the screen. The CANONICAL entry's own hold wins even
 * when it is dead — a dead slot must not stretch the rotation — and `undefined` means "wait for the
 * playing video's `ended`". A dead untimed video has no `ended` to wait for, so its slot falls back to
 * whatever is standing in for it (and to the fallback hold when nothing is).
 */
export function slotHoldMs(
  items: PlaylistEntry[],
  index: number,
  displayIndex: number | undefined,
): number | undefined {
  const canonical = items[index];
  if (!canonical) return FALLBACK_HOLD_SECONDS * 1000;
  const own = entryHoldMs(canonical);
  if (own !== undefined) return own;
  // Untimed video. If it is the entry actually PLAYING, its `ended` yields the slot.
  if (displayIndex === index) return undefined;
  const substitute = displayIndex === undefined ? undefined : items[displayIndex];
  if (!substitute) return FALLBACK_HOLD_SECONDS * 1000;
  return entryHoldMs(substitute); // undefined → the substitute is itself an untimed video: wait for it
}

/**
 * Which entry (if any) may buffer its video ahead of time. BOUNDED BY CONSTRUCTION: only the entry
 * that will be shown at the NEXT boundary, only when it is a video, only once inside the lead window,
 * and never the one already on the glass. So at most one hidden video element exists at any instant,
 * it is never played, and the rotation can never be more than one video "ahead" — D84's worry (two
 * live decoders on a kiosk GPU) cannot arise, and `enabled: false` removes even this.
 */
export function prewarmIndex(
  items: PlaylistEntry[],
  index: number,
  displayIndex: number | undefined,
  healthy: EntryHealth,
  opts: { enabled: boolean; remainingMs: number; leadMs: number },
): number | undefined {
  if (!opts.enabled || items.length < 2) return undefined;
  if (opts.remainingMs > opts.leadMs) return undefined;
  const nextCanonical = (index + 1) % items.length;
  const target = displayIndexFor(items, nextCanonical, healthy);
  if (target === undefined || target === displayIndex) return undefined;
  return items[target]?.kind === "video" ? target : undefined;
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
