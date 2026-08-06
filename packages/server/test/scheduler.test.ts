/**
 * POL-89 — the scene scheduler's TICKER, driven by an INJECTED CLOCK (the `disarmExpiredShells(ttl,
 * nowMs, …)` seam): we step time across a window boundary instead of sleeping through one.
 *
 * The claims pinned here are the ones a wall's day depends on:
 *   - before the boundary nothing is applied; ON the boundary the scene applies, ONCE;
 *   - a manual apply mid-window STANDS (the verdict has not changed → the ticker says nothing) and
 *     the next boundary takes the wall back;
 *   - a gap falls through to the default scene;
 *   - priority decides an overlap, and the wall follows the winner in and back out again;
 *   - a fall-back DST hour cannot double-apply (the repeated local hour is the same verdict);
 *   - boot ASSERTS the schedule (first tick applies), but not when the right scene is already live;
 *   - a disabled scheduler applies nothing, and re-enabling re-asserts;
 *   - POL-186: every mural above resolves independently, keyed by mural id, and the ticker hands the
 *     panel-power seam an edge-triggered verdict per mural alongside content.
 *
 * The ControlPlane is real (against the MemoryStore); `apply` is a spy standing in for index.ts's
 * closure (applyScene + a `server/render` per touched screen), so the fan-out path itself is what the
 * e2e proves — here we prove WHEN it is called.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { SceneScheduler } from "../src/scheduler";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";

import type { SceneSchedulerDeps } from "../src/scheduler";
import type { FastifyBaseLogger } from "fastify";

const log = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
  trace: () => {},
  fatal: () => {},
} as unknown as FastifyBaseLogger;

let store: MemoryStore;
let cp: ControlPlane;
let applied: string[];
let scheduler: SceneScheduler;

const every = [0, 1, 2, 3, 4, 5, 6];

/** A fresh mural to snapshot scenes from — a wall an operator points a schedule at. */
async function makeMural(name: string): Promise<string> {
  const mural = await cp.createMural(name);
  return mural.id;
}

/** A scene is just a snapshot of a mural's current (empty) layout — enough to be appliable. Several
 *  scenes can share one mural, exactly as an operator's day alternates scenes on ONE wall. */
async function makeScene(name: string, muralId: string): Promise<string> {
  const scene = await cp.snapshotScene(name, muralId);
  if (!scene) throw new Error("failed to snapshot a scene");
  return scene.id;
}

const at = (iso: string): number => Date.parse(`${iso}:00Z`);

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
  applied = [];
  scheduler = new SceneScheduler({
    control: cp,
    log,
    apply: async (sceneId) => {
      const result = await cp.applyScene(sceneId);
      if (!result) return false;
      applied.push(sceneId);
      return true;
    },
  });
  // One timezone for the whole deployment — pinned to UTC here so the clock we inject reads plainly.
  await cp.updateSchedulerSettings({ enabled: true, timezone: "UTC" });
});

describe("SceneScheduler — the boundary", () => {
  test("nothing before the window; the scene applies ON the boundary, exactly once", async () => {
    const wall = await makeMural("Wall");
    const morning = await makeScene("Morning", wall);
    const daypart = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    await cp.createSchedule({
      sceneId: morning,
      muralId: null,
      daypartId: daypart.id,
      days: every,
      priority: 0,
      enabled: true,
      from: null,
      until: null,
    });

    // 07:59 — the window is shut. Nothing on the wall, nothing applied.
    const before = await scheduler.tick(at("2026-07-15T07:59"));
    expect(before.applied).toEqual([]);
    expect(before.reasons[wall]).toBe("nothing-scheduled");
    expect(cp.getActiveSceneId(wall)).toBeNull();

    // 08:00 — the boundary. The scheduler applies the scene through the ordinary apply path.
    const boundary = await scheduler.tick(at("2026-07-15T08:00"));
    expect(boundary.applied).toEqual([morning]);
    expect(boundary.reasons[wall]).toBe("applied");
    expect(cp.getActiveSceneId(wall)).toBe(morning);
    expect(applied).toEqual([morning]);

    // Every later tick inside the window is a no-op — a wall is not re-rendered every 10 seconds.
    for (const t of ["08:00", "08:10", "12:00", "17:59"]) {
      const inside = await scheduler.tick(at(`2026-07-15T${t}`));
      expect(inside.applied).toEqual([]);
      expect(inside.reasons[wall]).toBe("unchanged");
    }
    expect(applied).toEqual([morning]);
  });

  test("a manual apply mid-window STANDS — and the next boundary takes the wall back", async () => {
    const wall = await makeMural("Wall");
    const morning = await makeScene("Morning", wall);
    const evening = await makeScene("Evening", wall);
    const adHoc = await makeScene("All-hands", wall); // never scheduled — the operator's own choice
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    const night = await cp.createDaypart({ name: "After hours", start: "18:00", end: "08:00" });
    await cp.createSchedule({ sceneId: morning, muralId: null, daypartId: opening.id, days: every, priority: 0, enabled: true, from: null, until: null });
    await cp.createSchedule({ sceneId: evening, muralId: null, daypartId: night.id, days: every, priority: 0, enabled: true, from: null, until: null });

    await scheduler.tick(at("2026-07-15T08:00"));
    expect(cp.getActiveSceneId(wall)).toBe(morning);

    // The operator puts an all-hands scene up at 10:00. The verdict has not changed, so the ticker
    // does NOT fight them — the schedule is a floor, not a leash.
    await cp.applyScene(adHoc);
    for (const t of ["10:00", "12:00", "17:59"]) {
      const inside = await scheduler.tick(at(`2026-07-15T${t}`));
      expect(inside.applied).toEqual([]);
      expect(inside.reasons[wall]).toBe("unchanged");
    }
    expect(cp.getActiveSceneId(wall)).toBe(adHoc);

    // …and the 18:00 boundary is a NEW verdict, so the wall goes back on schedule by itself.
    const boundary = await scheduler.tick(at("2026-07-15T18:00"));
    expect(boundary.applied).toEqual([evening]);
    expect(cp.getActiveSceneId(wall)).toBe(evening);
  });

  test("priority decides an overlap: the wall follows the winner in, and back out", async () => {
    const wall = await makeMural("Wall");
    const dashboards = await makeScene("Dashboards", wall);
    const lunch = await makeScene("Lunch menu", wall);
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    const lunchWindow = await cp.createDaypart({ name: "Lunch", start: "12:00", end: "13:00" });
    await cp.createSchedule({ sceneId: dashboards, muralId: null, daypartId: opening.id, days: every, priority: 0, enabled: true, from: null, until: null });
    await cp.createSchedule({ sceneId: lunch, muralId: null, daypartId: lunchWindow.id, days: every, priority: 10, enabled: true, from: null, until: null });

    await scheduler.tick(at("2026-07-15T09:00"));
    expect(cp.getActiveSceneId(wall)).toBe(dashboards);
    await scheduler.tick(at("2026-07-15T12:00"));
    expect(cp.getActiveSceneId(wall)).toBe(lunch); // the higher priority takes the wall
    await scheduler.tick(at("2026-07-15T13:00"));
    expect(cp.getActiveSceneId(wall)).toBe(dashboards); // …and hands it straight back
    expect(applied).toEqual([dashboards, lunch, dashboards]);
  });

  test("a gap falls through to the DEFAULT scene", async () => {
    const wall = await makeMural("Wall");
    const morning = await makeScene("Morning", wall);
    const branding = await makeScene("Branding", wall);
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    await cp.createSchedule({ sceneId: morning, muralId: null, daypartId: opening.id, days: every, priority: 0, enabled: true, from: null, until: null });
    await cp.updateSchedulerSettings({ defaultSceneId: branding });

    const night = await scheduler.tick(at("2026-07-15T03:00"));
    expect(night.applied).toEqual([branding]);
    expect(night.resolutions.find((r) => r.muralId === wall)?.source).toBe("default");

    await scheduler.tick(at("2026-07-15T08:00"));
    expect(cp.getActiveSceneId(wall)).toBe(morning);

    await scheduler.tick(at("2026-07-15T18:00"));
    expect(cp.getActiveSceneId(wall)).toBe(branding); // the floor takes it back at close
  });
});

describe("SceneScheduler — boot, the master switch, and DST", () => {
  test("the first tick ASSERTS the schedule on boot — unless the right scene is already live", async () => {
    const wall = await makeMural("Wall");
    const morning = await makeScene("Morning", wall);
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    await cp.createSchedule({ sceneId: morning, muralId: null, daypartId: opening.id, days: every, priority: 0, enabled: true, from: null, until: null });

    // A control plane that restarts at 09:05 puts the morning wall back up by itself.
    const boot = await scheduler.tick(at("2026-07-15T09:05"));
    expect(boot.applied).toEqual([morning]);

    // A FRESH scheduler over a control plane already showing the right scene re-renders nothing.
    const second = new SceneScheduler({
      control: cp,
      log,
      apply: async (sceneId) => {
        applied.push(sceneId);
        return true;
      },
    });
    const quiet = await second.tick(at("2026-07-15T09:06"));
    expect(quiet.applied).toEqual([]);
    expect(quiet.reasons[wall]).toBe("already-live");
    expect(applied).toEqual([morning]);
  });

  test("a DISABLED scheduler applies nothing; re-enabling re-asserts the schedule", async () => {
    const wall = await makeMural("Wall");
    const morning = await makeScene("Morning", wall);
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    await cp.createSchedule({ sceneId: morning, muralId: null, daypartId: opening.id, days: every, priority: 0, enabled: true, from: null, until: null });

    await cp.updateSchedulerSettings({ enabled: false });
    const off = await scheduler.tick(at("2026-07-15T09:00"));
    expect(off.applied).toEqual([]);
    expect(off.reasons).toEqual({});
    expect(cp.getActiveSceneId(wall)).toBeNull();

    await cp.updateSchedulerSettings({ enabled: true });
    const on = await scheduler.tick(at("2026-07-15T09:01"));
    expect(on.applied).toEqual([morning]);
    expect(on.reasons[wall]).toBe("applied");
  });

  test("FALL BACK: the repeated local hour cannot double-apply", async () => {
    await cp.updateSchedulerSettings({ timezone: "Europe/London" });
    const wall = await makeMural("Wall");
    const night = await makeScene("Night", wall);
    const overnight = await cp.createDaypart({ name: "Overnight", start: "23:00", end: "06:00" });
    await cp.createSchedule({ sceneId: night, muralId: null, daypartId: overnight.id, days: every, priority: 0, enabled: true, from: null, until: null });

    // 2026-10-25: London runs 01:00–02:00 twice. Tick through both passes, minute by minute.
    await scheduler.tick(Date.parse("2026-10-24T23:30:00+01:00")); // inside the window — applies once
    expect(applied).toEqual([night]);
    for (let m = 0; m <= 180; m += 10) {
      await scheduler.tick(Date.parse("2026-10-25T00:00:00Z") + m * 60_000); // 01:00 BST → 03:00 GMT
    }
    // The verdict never changed across the rewind, so the wall was never re-applied.
    expect(applied).toEqual([night]);
  });

  test("a schedule pointing at a deleted scene applies nothing (and says so)", async () => {
    const wall = await makeMural("Wall");
    const gone = await makeScene("Doomed", wall);
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    const created = await cp.createSchedule({ sceneId: gone, muralId: null, daypartId: opening.id, days: every, priority: 0, enabled: true, from: null, until: null });
    expect(created.ok).toBe(true);

    // Deleting the scene ALSO drops the schedule bound to it — nothing is left to resolve.
    await cp.deleteScene(gone);
    expect(cp.getSchedules()).toHaveLength(0);
    const tick = await scheduler.tick(at("2026-07-15T09:00"));
    expect(tick.applied).toEqual([]);
    expect(tick.reasons[wall]).toBe("nothing-scheduled");
  });
});

describe("the ticker drives panel power per mural", () => {
  const AT = (time: string): number => Date.parse(`2026-07-15T${time}:00Z`);

  /** A scheduler wired for panel-power tests: power-only windows (no scenes involved), so the tests
   *  isolate the power hand-off from the content path proven above. */
  async function makeSchedulerFixture(
    opts: { twoMurals?: boolean; ungoverned?: boolean; panelPower?: SceneSchedulerDeps["panelPower"] } = {},
  ): Promise<{ scheduler: SceneScheduler; cp: ControlPlane }> {
    const fixtureStore = new MemoryStore();
    const fixtureCp = new ControlPlane(fixtureStore);
    await fixtureCp.init(); // seeds the default mural, "mural-1"
    await fixtureCp.updateSchedulerSettings({ enabled: true, timezone: "UTC" });

    if (opts.ungoverned) {
      // No schedule targets "mural-1" at all — resolveMuralAt must answer `panels: null`, not "on".
    } else if (opts.twoMurals) {
      const second = await fixtureCp.createMural("Second"); // "mural-2"
      const allDay = await fixtureCp.createDaypart({ name: "All day", start: "00:00", end: "00:00" });
      await fixtureCp.createSchedule({
        sceneId: null,
        muralId: "mural-1",
        daypartId: allDay.id,
        days: every,
        priority: 0,
        panels: "off",
        enabled: true,
        from: null,
        until: null,
      });
      await fixtureCp.createSchedule({
        sceneId: null,
        muralId: second.id,
        daypartId: allDay.id,
        days: every,
        priority: 0,
        panels: "on",
        enabled: true,
        from: null,
        until: null,
      });
    } else {
      const day = await fixtureCp.createDaypart({ name: "Day", start: "00:00", end: "19:00" });
      const nightWindow = await fixtureCp.createDaypart({ name: "Night", start: "19:00", end: "00:00" });
      await fixtureCp.createSchedule({
        sceneId: null,
        muralId: "mural-1",
        daypartId: day.id,
        days: every,
        priority: 0,
        panels: "on",
        enabled: true,
        from: null,
        until: null,
      });
      await fixtureCp.createSchedule({
        sceneId: null,
        muralId: "mural-1",
        daypartId: nightWindow.id,
        days: every,
        priority: 0,
        panels: "off",
        enabled: true,
        from: null,
        until: null,
      });
    }

    const fixtureScheduler = new SceneScheduler({
      control: fixtureCp,
      log,
      apply: async (sceneId) => {
        const result = await fixtureCp.applyScene(sceneId);
        return result !== null;
      },
      panelPower: opts.panelPower,
    });

    return { scheduler: fixtureScheduler, cp: fixtureCp };
  }

  test("the seam is called EVERY tick, unconditionally — edge-triggering is its job, not the ticker's", async () => {
    const calls: Array<[string, string | null, string]> = [];
    const { scheduler: fixtureScheduler } = await makeSchedulerFixture({
      panelPower: { applyMuralPower: (m, p, d) => { calls.push([m, p, d]); } },
    });
    await fixtureScheduler.tick(AT("18:30")); // in hours
    await fixtureScheduler.tick(AT("19:30")); // crossed the boundary
    await fixtureScheduler.tick(AT("19:40")); // no boundary, but STILL called — same verdict, third call
    expect(calls).toEqual([
      ["mural-1", "on", "Day"],
      ["mural-1", "off", "Night"],
      ["mural-1", "off", "Night"],
    ]);
  });

  test("two murals resolve independently", async () => {
    const calls: Array<[string, string | null]> = [];
    const { scheduler: fixtureScheduler } = await makeSchedulerFixture({
      twoMurals: true,
      panelPower: { applyMuralPower: (m, p) => { calls.push([m, p]); } },
    });
    await fixtureScheduler.tick(AT("21:00"));
    expect(calls).toContainEqual(["mural-1", "off"]);
    expect(calls).toContainEqual(["mural-2", "on"]);
  });

  /**
   * A DISABLED TICK STILL DRIVES THE SEAM. The master switch is "no window governs anything" by
   * another route, and the ticker used to return before power was ever handed over — so switching
   * the scheduler off, the very thing an operator does when panels misbehave, left every screen the
   * schedule had slept with nothing able to wake it. Content is still untouched (`applied` empty,
   * `reasons` empty); only power crosses the seam.
   */
  test("a DISABLED tick hands 'null' for every mural, so the seam can wake what it slept", async () => {
    const calls: Array<[string, string | null, string, string | undefined]> = [];
    const { scheduler: fixtureScheduler, cp: fixtureCp } = await makeSchedulerFixture({
      panelPower: { applyMuralPower: (m, p, d, u) => { calls.push([m, p, d, u]); } },
    });
    await fixtureScheduler.tick(AT("21:00"));
    expect(calls).toEqual([["mural-1", "off", "Night", undefined]]);

    await fixtureCp.updateSchedulerSettings({ enabled: false });
    const off = await fixtureScheduler.tick(AT("21:10"));
    expect(off.applied).toEqual([]);
    expect(off.reasons).toEqual({});
    expect(calls[1]).toEqual([
      "mural-1",
      null,
      "the scheduler is switched off",
      "the scheduler is switched off",
    ]);
  });

  test("a mural with no enabled window hands 'null' — leave it exactly as it is", async () => {
    const calls: Array<[string, string | null]> = [];
    const { scheduler: fixtureScheduler } = await makeSchedulerFixture({
      ungoverned: true,
      panelPower: { applyMuralPower: (m, p) => { calls.push([m, p]); } },
    });
    await fixtureScheduler.tick(AT("12:00"));
    // Exactly one call, for the one mural that exists, and it is `null` — not "on", not "off". A
    // screen an operator slept by hand on this mural must stay asleep: `null` is the only verdict
    // that says "send nothing," and it must never be silently coerced to "on".
    expect(calls).toEqual([["mural-1", null]]);
  });
});
