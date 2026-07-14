/**
 * Refresh cadence (POL-98) — a dashboard re-fetches itself, and never fights the prober doing it.
 *
 * Two halves, tested together because the interesting failures live in the seam:
 *
 *   THE SCHEDULER, on an injected clock: the cadence fires on time, a re-render does not reset it, a
 *   changed cadence re-arms, a dropped surface stops ticking, and a fleet of screens does not all
 *   fire at once (the jitter phase is deterministic per screen, so a wall of boxes fans out instead
 *   of hitting the dashboard server as one herd every five minutes, forever).
 *
 *   THE PROBER SEAM: a refresh is a RE-PROVE, not a reload. Reachable → reload in place. Unreachable
 *   → the prober's healing path takes it, the old page STAYS PAINTED (a refresh must never blank the
 *   wall), and the surface converges when the dashboard comes back. And a refresh that lands while
 *   the prober is already hunting a broken surface is dropped, not stacked on top of it.
 */
import { describe, expect, test } from "bun:test";

import { RefreshScheduler } from "../src/refresh-timer";
import { SurfaceProber } from "../src/surface-prober";

/** A clock the test owns: timers fire when we say they do, in due order. */
class FakeClock {
  private now = 0;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  readonly setTimer = (fn: () => void, ms: number): unknown => {
    const id = ++this.seq;
    this.timers.set(id, { at: this.now + ms, fn });
    return id;
  };

  readonly clearTimer = (handle: unknown): void => {
    this.timers.delete(handle as number);
  };

  /** Advance the clock, firing everything due — including timers armed while we advance. */
  advance(ms: number): void {
    const target = this.now + ms;
    for (;;) {
      let nextId: number | undefined;
      let nextAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= target && timer.at < nextAt) {
          nextAt = timer.at;
          nextId = id;
        }
      }
      if (nextId === undefined) break;
      const timer = this.timers.get(nextId)!;
      this.timers.delete(nextId);
      this.now = timer.at;
      timer.fn();
    }
    this.now = target;
  }

  get pending(): number {
    return this.timers.size;
  }
}

function harness(seed = "screen-1", jitterFraction = 0) {
  const clock = new FakeClock();
  const refreshed: string[] = [];
  const scheduler = new RefreshScheduler({
    refresh: (id) => refreshed.push(id),
    seed,
    jitterFraction,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  });
  return { clock, refreshed, scheduler };
}

const MINUTE = 60_000;

describe("RefreshScheduler", () => {
  test("a dashboard refreshes on its cadence, again and again", () => {
    const h = harness();
    h.scheduler.sync([{ id: "s1", seconds: 300 }]);

    h.clock.advance(4 * MINUTE);
    expect(h.refreshed).toEqual([]); // not yet — the cadence is the operator's, not ours

    h.clock.advance(1 * MINUTE);
    expect(h.refreshed).toEqual(["s1"]);

    h.clock.advance(15 * MINUTE);
    expect(h.refreshed).toEqual(["s1", "s1", "s1", "s1"]); // every 5 minutes, forever
  });

  test("a re-render does NOT reset the timer — a busy wall must still reach its cadence", () => {
    const h = harness();
    h.scheduler.sync([{ id: "s1", seconds: 300 }]);
    h.clock.advance(4 * MINUTE);

    // The slice is replaced wholesale on every server/render; the same surface with the same cadence
    // must keep its running timer. (Re-arming here is how a wall refreshes exactly never.)
    for (let i = 0; i < 5; i += 1) h.scheduler.sync([{ id: "s1", seconds: 300 }]);

    h.clock.advance(1 * MINUTE);
    expect(h.refreshed).toEqual(["s1"]);
  });

  test("a changed cadence re-arms from now; a cleared one stops ticking", () => {
    const h = harness();
    h.scheduler.sync([{ id: "s1", seconds: 300 }]);
    h.clock.advance(4 * MINUTE);

    h.scheduler.sync([{ id: "s1", seconds: 60 }]);
    h.clock.advance(1 * MINUTE);
    expect(h.refreshed).toEqual(["s1"]);

    h.scheduler.sync([]); // the operator turned refresh off (or the content changed)
    h.clock.advance(60 * MINUTE);
    expect(h.refreshed).toEqual(["s1"]);
    expect(h.clock.pending).toBe(0);
  });

  test("stop() disarms everything — a player being torn down does not tick", () => {
    const h = harness();
    h.scheduler.sync([{ id: "s1", seconds: 60 }, { id: "s2", seconds: 60 }]);
    h.scheduler.stop();
    h.clock.advance(10 * MINUTE);
    expect(h.refreshed).toEqual([]);
    expect(h.clock.pending).toBe(0);
  });

  test("the fleet fans out: same cadence, different screens, different first tick", () => {
    // Jitter is a deterministic hash of (screen, surface), so it is stable across reboots — the same
    // panel always takes the same slot — while fifty panels sharing a cadence do NOT arrive together.
    const firsts = ["screen-1", "screen-2", "screen-3", "screen-4"].map((seed) => {
      const h = harness(seed, 0.1);
      h.scheduler.sync([{ id: "content-web", seconds: 300 }]);
      h.clock.advance(299_000); // just short of the un-jittered cadence
      let fired = -1;
      for (let step = 299; step < 340 && fired < 0; step += 1) {
        h.clock.advance(1_000);
        if (h.refreshed.length > 0) fired = step;
      }
      return fired;
    });
    expect(new Set(firsts).size).toBeGreaterThan(1); // they do not land on the same second
    // …and every one of them lands within the jitter window, not after it: the cadence stays honest.
    for (const first of firsts) expect(first).toBeGreaterThanOrEqual(299);
    for (const first of firsts) expect(first).toBeLessThan(331);
  });

  test("after the first (jittered) tick the period is exact — the jitter is a phase, not a drift", () => {
    const h = harness("screen-1", 0.1);
    h.scheduler.sync([{ id: "s1", seconds: 300 }]);
    h.clock.advance(6 * MINUTE); // past the first, jittered, tick
    expect(h.refreshed.length).toBe(1);

    h.clock.advance(5 * MINUTE);
    expect(h.refreshed.length).toBe(2);
    h.clock.advance(5 * MINUTE);
    expect(h.refreshed.length).toBe(3);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The seam: a refresh goes THROUGH the prober, and cannot blank the wall.
// ─────────────────────────────────────────────────────────────────────────────

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 5));

function proberHarness(probe: () => Promise<void>) {
  const painted: Array<[string, string]> = [];
  const cleared: string[] = [];
  const reloaded: string[] = [];
  const prober = new SurfaceProber({
    paint: (id, url) => painted.push([id, url]),
    clear: (id) => cleared.push(id),
    reload: (id) => reloaded.push(id),
    probe,
    probeBackoffMinMs: 5,
    probeBackoffMaxMs: 10,
    verifyDelaysMs: [],
    minReloadIntervalMs: 0,
    errorRetryMinMs: 5,
  });
  return { prober, painted, cleared, reloaded };
}

describe("refresh × prober", () => {
  test("a refresh of a reachable dashboard reloads it IN PLACE — same element, no remount", async () => {
    const h = proberHarness(() => Promise.resolve());
    h.prober.sync([{ id: "s1", url: "https://dash/x" }]);
    await settle();
    expect(h.painted).toEqual([["s1", "https://dash/x"]]);

    h.prober.refresh("s1");
    await settle();

    expect(h.reloaded).toEqual(["s1"]); // reloaded, not repainted…
    expect(h.painted.length).toBe(1); //  …so the keyed iframe was never remounted (D5)
    expect(h.cleared).toEqual([]); //     …and nothing was ever unmounted
  });

  test("a refresh onto a DEAD url never blanks the wall — the old page stays up and the prober heals it", async () => {
    let reachable = true;
    const h = proberHarness(() => (reachable ? Promise.resolve() : Promise.reject(new Error("ENOTFOUND"))));
    h.prober.sync([{ id: "s1", url: "https://dash/x" }]);
    await settle();
    expect(h.painted.length).toBe(1);

    // The dashboard server dies. The refresh cadence comes due anyway — this is the overnight case.
    reachable = false;
    h.prober.refresh("s1");
    await settle();

    // Nothing was cleared and nothing was reloaded: the wall still shows the last good dashboard.
    expect(h.cleared).toEqual([]);
    expect(h.reloaded).toEqual([]);

    // The dashboard comes back. The prober's own backoff — not the refresh timer — is what finds it,
    // and it heals the surface in place. One healing path, not two racing ones.
    reachable = true;
    await new Promise((r) => setTimeout(r, 40));
    expect(h.reloaded).toEqual(["s1"]);
    expect(h.cleared).toEqual([]);
  });

  test("a refresh that lands while the prober is already hunting is dropped, not stacked", async () => {
    let gate!: () => void;
    const pending = new Promise<void>((r) => (gate = r));
    const h = proberHarness(() => pending);
    h.prober.sync([{ id: "s1", url: "https://dash/x" }]);
    await settle();
    expect(h.painted).toEqual([]); // still proving the FIRST paint

    h.prober.refresh("s1"); // the cadence fires before the surface has ever painted
    h.prober.refresh("s1");
    gate();
    await settle();

    // Exactly one paint, no reloads: the refreshes deferred to the prove that was already in flight.
    expect(h.painted).toEqual([["s1", "https://dash/x"]]);
    expect(h.reloaded).toEqual([]);
  });

  test("a refresh of an unknown surface is a no-op (the slice changed under the timer)", () => {
    const h = proberHarness(() => Promise.resolve());
    expect(() => h.prober.refresh("gone")).not.toThrow();
    expect(h.reloaded).toEqual([]);
  });
});
