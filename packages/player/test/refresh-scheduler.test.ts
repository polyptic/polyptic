/**
 * POL-157 / D149 — the player's refresh cadence, both halves:
 *   1. RefreshScheduler decides WHEN a surface is due (over the shared `isRefreshDue`), anchoring each
 *      surface's clock to when it was first seen and re-anchoring on every fire (no double fire).
 *   2. SurfaceProber.refreshDue reloads a due surface via the PROVE-THEN-SWAP path — it re-proves the
 *      URL and only reloads the element IN PLACE once it proves, and never CLEARS it. That is the
 *      no-black-flash guarantee: the old content stays on the glass until the new load is reachable.
 */
import { describe, expect, test } from "bun:test";

import type { RefreshPolicy } from "@polyptic/protocol";
import { RefreshScheduler } from "../src/refresh-scheduler";
import type { RefreshTarget } from "../src/refresh-scheduler";
import { SurfaceProber } from "../src/surface-prober";
import type { SurfaceProberOptions } from "../src/surface-prober";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── The scheduler ─────────────────────────────────────────────────────────────

function schedulerHarness(startAt: number) {
  let now = startAt;
  const due: string[] = [];
  const scheduler = new RefreshScheduler({ onDue: (id) => due.push(id), now: () => now });
  return {
    scheduler,
    due,
    set: (t: number) => {
      now = t;
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const t0 = Date.UTC(2026, 6, 17, 12, 0, 0);

describe("RefreshScheduler — interval", () => {
  const every5m: RefreshTarget = { id: "s1", policy: { mode: "interval", everySeconds: 300 } };

  test("fires once per interval, counted from first-seen, and re-anchored on each fire", () => {
    const h = schedulerHarness(t0);
    h.scheduler.sync([every5m]);

    h.advance(299_000);
    h.scheduler.tick();
    expect(h.due).toEqual([]); // not yet

    h.advance(1_000); // now exactly 300s since mount
    h.scheduler.tick();
    expect(h.due).toEqual(["s1"]);

    // Re-anchored: the next fire is 300s AFTER this one, not immediately.
    h.advance(299_000);
    h.scheduler.tick();
    expect(h.due).toEqual(["s1"]);

    h.advance(1_000);
    h.scheduler.tick();
    expect(h.due).toEqual(["s1", "s1"]);
  });

  test("an off policy is never watched, and dropping a surface stops it firing", () => {
    const h = schedulerHarness(t0);
    h.scheduler.sync([{ id: "s1", policy: { mode: "off" } }, every5m]);
    h.advance(10 * 300_000);
    h.scheduler.tick();
    expect(h.due).toEqual(["s1"]); // only the interval one; the off one is invisible

    h.due.length = 0;
    h.scheduler.sync([]); // s1 left the screen
    h.advance(10 * 300_000);
    h.scheduler.tick();
    expect(h.due).toEqual([]);
  });

  test("turning a cadence ON does not retroactively fire — it counts from now", () => {
    const h = schedulerHarness(t0);
    h.scheduler.sync([{ id: "s1", policy: { mode: "off" } }]);
    h.advance(10 * 300_000); // a long time passes with no cadence
    h.scheduler.sync([every5m]); // operator switches it on
    h.scheduler.tick();
    expect(h.due).toEqual([]); // must NOT fire immediately

    h.advance(300_000);
    h.scheduler.tick();
    expect(h.due).toEqual(["s1"]);
  });
});

describe("RefreshScheduler — scheduled", () => {
  const daily4am: RefreshPolicy = {
    mode: "scheduled",
    atLocal: "04:00",
    days: [0, 1, 2, 3, 4, 5, 6],
    timezone: "UTC",
  };

  test("fires when the wall clock crosses the scheduled minute, once", () => {
    const mount = Date.UTC(2026, 6, 17, 3, 0); // 03:00 UTC
    const h = schedulerHarness(mount);
    h.scheduler.sync([{ id: "s1", policy: daily4am }]);

    h.set(Date.UTC(2026, 6, 17, 3, 59));
    h.scheduler.tick();
    expect(h.due).toEqual([]);

    h.set(Date.UTC(2026, 6, 17, 4, 0));
    h.scheduler.tick();
    expect(h.due).toEqual(["s1"]);

    h.set(Date.UTC(2026, 6, 17, 4, 30));
    h.scheduler.tick();
    expect(h.due).toEqual(["s1"]); // already fired today — no repeat

    h.set(Date.UTC(2026, 6, 18, 4, 0));
    h.scheduler.tick();
    expect(h.due).toEqual(["s1", "s1"]); // next day fires again
  });
});

// ── The prober's prove-then-swap reload ───────────────────────────────────────

function proberHarness(overrides: Partial<SurfaceProberOptions> = {}) {
  const painted: Array<[string, string]> = [];
  const cleared: string[] = [];
  const reloaded: string[] = [];
  const prober = new SurfaceProber({
    paint: (id, url) => painted.push([id, url]),
    clear: (id) => cleared.push(id),
    reload: (id) => reloaded.push(id),
    probe: () => Promise.resolve(),
    probeBackoffMinMs: 5,
    probeBackoffMaxMs: 20,
    verifyDelaysMs: [],
    minReloadIntervalMs: 0,
    ...overrides,
  });
  return { prober, painted, cleared, reloaded };
}

describe("SurfaceProber.refreshDue — prove then swap", () => {
  test("a due surface re-proves and reloads IN PLACE, never clearing (no black flash)", async () => {
    const probes: string[] = [];
    const h = proberHarness({
      probe: (url) => {
        probes.push(url);
        return Promise.resolve();
      },
    });
    h.prober.sync([{ id: "s1", url: "http://dash/panel" }]);
    await sleep(20);
    expect(h.painted).toEqual([["s1", "http://dash/panel"]]);
    const probesBefore = probes.length;

    h.prober.refreshDue("s1", "cadence");
    await sleep(20);

    expect(probes.length).toBeGreaterThan(probesBefore); // it re-PROVED first
    expect(h.reloaded).toEqual(["s1"]); // then reloaded the element in place
    expect(h.cleared).toEqual([]); // and NEVER cleared it — the old frame stayed up throughout
  });

  test("if the re-prove FAILS, the surface is NOT reloaded (old content keeps showing)", async () => {
    let reachable = true;
    const h = proberHarness({
      probe: () => (reachable ? Promise.resolve() : Promise.reject(new Error("route black-holed"))),
    });
    h.prober.sync([{ id: "s1", url: "http://dash/panel" }]);
    await sleep(20);
    expect(h.painted).toEqual([["s1", "http://dash/panel"]]);

    reachable = false; // the source went unreachable
    h.prober.refreshDue("s1", "cadence");
    await sleep(30);

    expect(h.reloaded).toEqual([]); // a reload to a dead URL would black-flash — refused
    expect(h.cleared).toEqual([]); // the last-good content is left on the glass
    h.prober.stop();
  });
});
