/**
 * Refresh scheduler (POL-157 / D149) — the player's clock for per-source reload cadences.
 *
 * A web/dashboard surface may carry a `refresh` policy (its library source's cadence). This tiny
 * bookkeeper answers ONE question on a periodic tick: which surfaces are due to reload right now? It
 * owns no DOM and no reload mechanism — when a surface comes due it calls `onDue(id)`, and the player
 * hands that to the SurfaceProber's prove-then-swap path (surface-prober.ts `refreshDue`) so the
 * reload never black-flashes the wall.
 *
 * The DUE decision is the shared, DST-correct `isRefreshDue` resolver in `@polyptic/protocol` — the
 * same function a console preview would use. The scheduler only tracks, per surface, the policy and
 * the last-reload instant:
 *   - a surface first seen anchors `lastRefreshAt` to NOW — an interval counts from when it mounted,
 *     and a scheduled fire that already passed today waits for the next armed occurrence.
 *   - a surface whose policy CHANGES keeps its `lastRefreshAt` (turning a cadence on must not
 *     retroactively fire; turning it off simply stops firing).
 *   - firing sets `lastRefreshAt = now`, so the same interval window / the same scheduled minute
 *     cannot fire twice.
 *
 * Fully injected (clock + `onDue`) so tests drive it by calling `tick()` with a fake clock — no
 * timers, no DOM. The player owns the real interval and calls `tick()` on it.
 */
import { isRefreshDue, type RefreshPolicy } from "@polyptic/protocol";

/** One surface the scheduler watches: its id and the cadence its source carries. */
export interface RefreshTarget {
  id: string;
  policy: RefreshPolicy;
}

interface Tracked {
  policy: RefreshPolicy;
  /** Instant of the last (re)load on the box's clock — seeded to first-seen, reset on each fire. */
  lastRefreshAt: number;
}

export interface RefreshSchedulerOptions {
  /** Called when a surface's cadence has come due — the player re-proves + reloads it in place. */
  onDue: (id: string) => void;
  now?: () => number;
  log?: (msg: string) => void;
}

export class RefreshScheduler {
  private readonly tracked = new Map<string, Tracked>();
  private readonly onDue: (id: string) => void;
  private readonly now: () => number;
  private readonly log: (msg: string) => void;

  constructor(opts: RefreshSchedulerOptions) {
    this.onDue = opts.onDue;
    this.now = opts.now ?? ((): number => Date.now());
    this.log = opts.log ?? ((): void => {});
  }

  /**
   * Reconcile the watched set to the surfaces currently on screen that carry a (non-off) cadence.
   * New ids anchor their clock to now; an existing id updates its policy but KEEPS its last-reload
   * instant; ids no longer present (or that dropped their cadence) are forgotten.
   */
  sync(targets: RefreshTarget[]): void {
    const wanted = new Set<string>();
    for (const { id, policy } of targets) {
      if (policy.mode === "off") continue; // off = not watched at all
      wanted.add(id);
      const existing = this.tracked.get(id);
      if (existing) existing.policy = policy;
      else this.tracked.set(id, { policy, lastRefreshAt: this.now() });
    }
    for (const id of [...this.tracked.keys()]) {
      if (!wanted.has(id)) this.tracked.delete(id);
    }
  }

  /** Evaluate every watched surface; fire the ones that are due, and re-anchor their clock. */
  tick(): void {
    const at = this.now();
    for (const [id, t] of this.tracked) {
      if (!isRefreshDue(t.policy, t.lastRefreshAt, at)) continue;
      t.lastRefreshAt = at;
      this.log(`${id}: refresh cadence due — reloading`);
      this.onDue(id);
    }
  }

  /** Forget everything (player teardown). */
  stop(): void {
    this.tracked.clear();
  }
}
