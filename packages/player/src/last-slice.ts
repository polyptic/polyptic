/**
 * POL-32 — last-good slice persistence: a player that starts while the control plane is unreachable
 * renders what it last knew instead of an idle splash.
 *
 * On every `server/render` the player snapshots its slice (canvas + surfaces + name) into
 * localStorage, keyed by screen id. On startup the snapshot is restored BEFORE the WS connects, so:
 *
 *   - a normal boot paints last-known content instantly instead of waiting a round-trip (the first
 *     real render reconciles it moments later — same keyed DOM diff, no flash), and
 *   - a boot/reload during an outage shows the wall's last-good content (media comes from the
 *     POL-32 IndexedDB blob cache, so images AND videos render fully offline) with the status badge
 *     honestly reading "connecting".
 *
 * The restored slice is display-only: the player never ACKs a restored revision — acks are reserved
 * for renders the server actually delivered.
 *
 * Snapshots are validated against the SHARED protocol schemas on load — a snapshot written by an
 * older build that no longer parses is discarded (and cleared), never trusted; the player just
 * waits for the live render as before. All storage errors (quota, private mode) are swallowed:
 * persistence is an enhancement, its absence is only ever the pre-POL-32 behaviour.
 */
import { Geometry, Surface } from "@polyptic/protocol";
import { z } from "zod";

/** localStorage-shaped seam so tests can inject a plain object store. */
export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const SNAPSHOT_VERSION = 1;

export const SliceSnapshot = z.object({
  v: z.literal(SNAPSHOT_VERSION),
  canvas: Geometry,
  surfaces: z.array(Surface),
  revision: z.number().int().nonnegative(),
  friendlyName: z.string(),
  showBadges: z.boolean().optional(),
  /** POL-119 — cast-enabled at save time, so the badge's cast glyph survives an outage boot. */
  castEnabled: z.boolean().optional(),
  savedAt: z.number(),
});
export type SliceSnapshot = z.infer<typeof SliceSnapshot>;

function keyFor(screenId: string): string {
  return `polyptic:last-slice:${screenId}`;
}

/** Persist the current slice for this screen. Best-effort — storage errors are swallowed. */
export function saveLastSlice(
  storage: KeyValueStorage,
  screenId: string,
  snapshot: Omit<SliceSnapshot, "v">,
): void {
  try {
    storage.setItem(keyFor(screenId), JSON.stringify({ v: SNAPSHOT_VERSION, ...snapshot }));
  } catch {
    // Quota / private mode — the wall just won't have a restore point.
  }
}

/** Load (and validate) the persisted slice for this screen, or null. Corrupt/stale-schema
 *  snapshots are cleared so they aren't re-parsed on every boot. */
export function loadLastSlice(storage: KeyValueStorage, screenId: string): SliceSnapshot | null {
  let raw: string | null;
  try {
    raw = storage.getItem(keyFor(screenId));
  } catch {
    return null;
  }
  if (raw === null) return null;
  try {
    return SliceSnapshot.parse(JSON.parse(raw));
  } catch {
    try {
      storage.removeItem(keyFor(screenId));
    } catch {
      // Best-effort cleanup.
    }
    return null;
  }
}
