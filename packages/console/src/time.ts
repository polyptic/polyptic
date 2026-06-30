/**
 * Small presentation helpers for relative timestamps, shared by the Machines view and the cold-start
 * wizard so a machine's "last seen" reads the same everywhere.
 *
 * Mirrors the old SolidJS admin's formatLastSeen: a coarse, human-friendly relative string computed
 * against a ticking clock (the caller passes `nowMs` from a 1s interval so the value stays fresh).
 */

/** Human-friendly "last seen" relative to a ticking clock (so the value stays fresh on screen). */
export function formatLastSeen(iso: string | undefined, nowMs: number): string {
  if (!iso) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "unknown";
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 5) return "just now";
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

/**
 * Compact relative timestamp for the Live Activity feed (D25): "now", "4m", "1h", "2d" — terse
 * enough to sit in a narrow gutter. Like `formatLastSeen`, it's computed against a caller-supplied
 * ticking `nowMs` so the value stays fresh as the feed sits on screen.
 */
export function formatRelativeShort(iso: string | undefined, nowMs: number): string {
  if (!iso) return "";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const secs = Math.max(0, Math.round((nowMs - then) / 1000));
  if (secs < 45) return "now";
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${Math.max(1, mins)}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

/** "2 screens" / "1 screen". */
export function countLabel(count: number, singular: string): string {
  return `${count} ${count === 1 ? singular : `${singular}s`}`;
}
