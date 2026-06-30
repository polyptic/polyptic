/**
 * The Live Activity feed (D25) — a bounded, in-memory ring of human-readable events.
 *
 * Notable transitions across the control plane (a machine coming online, a screen renamed, content
 * assigned, a scene applied, …) push a short `ActivityEvent` here; `recent()` is folded into every
 * `admin/state` snapshot so the console's right-rail stream updates live. This is deliberately
 * EPHEMERAL — it is NOT persisted; on a server restart the feed starts empty (the registry it
 * describes is what's durable). The ring is capped so it can never grow without bound.
 *
 * Each `push` stamps a fresh id + ISO timestamp and prepends (newest first). A small dedupe guard
 * collapses an identical event (same severity + text) that recurs within a short window, so a burst
 * of repeated pushes — e.g. a flapping socket or a re-resolve that touches several slices — does not
 * spam the feed with carbon copies.
 */
import { ActivityEvent } from "@polyptic/protocol";
import type { ActivityEvent as ActivityEventType } from "@polyptic/protocol";

/** Severity of an activity line — mirrors the contract's enum. */
export type ActivitySeverity = ActivityEventType["severity"];

export class ActivityLog {
  private readonly events: ActivityEventType[] = [];

  /**
   * @param capacity      max events retained (oldest dropped past this) — defaults to 50.
   * @param dedupeWindowMs window within which an identical (severity+text) event is suppressed.
   */
  constructor(
    private readonly capacity = 50,
    private readonly dedupeWindowMs = 1500,
  ) {}

  /**
   * Record an event. Stamps a random id + current ISO time, validates against the contract, and
   * prepends it (newest first), trimming the ring to capacity. Returns the stored event, or null if
   * it was suppressed as a rapid duplicate of the most recent line.
   */
  push(severity: ActivitySeverity, text: string): ActivityEventType | null {
    const trimmed = text.trim();
    if (trimmed.length === 0) return null;

    const now = Date.now();
    const latest = this.events[0];
    if (
      latest &&
      latest.severity === severity &&
      latest.text === trimmed &&
      now - Date.parse(latest.at) < this.dedupeWindowMs
    ) {
      return null;
    }

    const event = ActivityEvent.parse({
      id: randomId(),
      at: new Date(now).toISOString(),
      severity,
      text: trimmed,
    });

    this.events.unshift(event);
    if (this.events.length > this.capacity) this.events.length = this.capacity;
    return event;
  }

  /** The current feed, newest first (a defensive copy so callers can't mutate the ring). */
  recent(): ActivityEventType[] {
    return [...this.events];
  }

  /** How many events are currently held. */
  size(): number {
    return this.events.length;
  }
}

/** A short, collision-resistant id. Uses crypto.randomUUID when available, else a random fallback. */
function randomId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
