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
 *   - a disabled scheduler applies nothing, and re-enabling re-asserts.
 *
 * The ControlPlane is real (against the MemoryStore); `apply` is a spy standing in for index.ts's
 * closure (applyScene + a `server/render` per touched screen), so the fan-out path itself is what the
 * e2e proves — here we prove WHEN it is called.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { SceneScheduler } from "../src/scheduler";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";

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

/** A scene is just a snapshot of a mural — an empty mural gives us a valid, appliable scene. */
async function makeScene(name: string): Promise<string> {
  const mural = await cp.createMural(name);
  const scene = await cp.snapshotScene(name, mural.id);
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
    const morning = await makeScene("Morning");
    const daypart = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    await cp.createSchedule({
      sceneId: morning,
      daypartId: daypart.id,
      days: [0, 1, 2, 3, 4, 5, 6],
      priority: 0,
      enabled: true,
      from: null,
      until: null,
    });

    // 07:59 — the window is shut. Nothing on the wall, nothing applied.
    const before = await scheduler.tick(at("2026-07-15T07:59"));
    expect(before.applied).toBeNull();
    expect(before.reason).toBe("nothing-scheduled");
    expect(cp.state.activeSceneId).toBeNull();

    // 08:00 — the boundary. The scheduler applies the scene through the ordinary apply path.
    const boundary = await scheduler.tick(at("2026-07-15T08:00"));
    expect(boundary.applied).toBe(morning);
    expect(boundary.reason).toBe("applied");
    expect(cp.state.activeSceneId).toBe(morning);
    expect(applied).toEqual([morning]);

    // Every later tick inside the window is a no-op — a wall is not re-rendered every 10 seconds.
    for (const t of ["08:00", "08:10", "12:00", "17:59"]) {
      const inside = await scheduler.tick(at(`2026-07-15T${t}`));
      expect(inside.applied).toBeNull();
      expect(inside.reason).toBe("unchanged");
    }
    expect(applied).toEqual([morning]);
  });

  test("a manual apply mid-window STANDS — and the next boundary takes the wall back", async () => {
    const morning = await makeScene("Morning");
    const evening = await makeScene("Evening");
    const adHoc = await makeScene("All-hands"); // never scheduled — the operator's own choice
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    const night = await cp.createDaypart({ name: "After hours", start: "18:00", end: "08:00" });
    const every = [0, 1, 2, 3, 4, 5, 6];
    await cp.createSchedule({ sceneId: morning, daypartId: opening.id, days: every, priority: 0, enabled: true, from: null, until: null });
    await cp.createSchedule({ sceneId: evening, daypartId: night.id, days: every, priority: 0, enabled: true, from: null, until: null });

    await scheduler.tick(at("2026-07-15T08:00"));
    expect(cp.state.activeSceneId).toBe(morning);

    // The operator puts an all-hands scene up at 10:00. The verdict has not changed, so the ticker
    // does NOT fight them — the schedule is a floor, not a leash.
    await cp.applyScene(adHoc);
    for (const t of ["10:00", "12:00", "17:59"]) {
      const inside = await scheduler.tick(at(`2026-07-15T${t}`));
      expect(inside.applied).toBeNull();
      expect(inside.reason).toBe("unchanged");
    }
    expect(cp.state.activeSceneId).toBe(adHoc);

    // …and the 18:00 boundary is a NEW verdict, so the wall goes back on schedule by itself.
    const boundary = await scheduler.tick(at("2026-07-15T18:00"));
    expect(boundary.applied).toBe(evening);
    expect(cp.state.activeSceneId).toBe(evening);
  });

  test("priority decides an overlap: the wall follows the winner in, and back out", async () => {
    const dashboards = await makeScene("Dashboards");
    const lunch = await makeScene("Lunch menu");
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    const lunchWindow = await cp.createDaypart({ name: "Lunch", start: "12:00", end: "13:00" });
    const every = [0, 1, 2, 3, 4, 5, 6];
    await cp.createSchedule({ sceneId: dashboards, daypartId: opening.id, days: every, priority: 0, enabled: true, from: null, until: null });
    await cp.createSchedule({ sceneId: lunch, daypartId: lunchWindow.id, days: every, priority: 10, enabled: true, from: null, until: null });

    await scheduler.tick(at("2026-07-15T09:00"));
    expect(cp.state.activeSceneId).toBe(dashboards);
    await scheduler.tick(at("2026-07-15T12:00"));
    expect(cp.state.activeSceneId).toBe(lunch); // the higher priority takes the wall
    await scheduler.tick(at("2026-07-15T13:00"));
    expect(cp.state.activeSceneId).toBe(dashboards); // …and hands it straight back
    expect(applied).toEqual([dashboards, lunch, dashboards]);
  });

  test("a gap falls through to the DEFAULT scene", async () => {
    const morning = await makeScene("Morning");
    const branding = await makeScene("Branding");
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    await cp.createSchedule({ sceneId: morning, daypartId: opening.id, days: [0, 1, 2, 3, 4, 5, 6], priority: 0, enabled: true, from: null, until: null });
    await cp.updateSchedulerSettings({ defaultSceneId: branding });

    const night = await scheduler.tick(at("2026-07-15T03:00"));
    expect(night.applied).toBe(branding);
    expect(night.resolution.source).toBe("default");

    await scheduler.tick(at("2026-07-15T08:00"));
    expect(cp.state.activeSceneId).toBe(morning);

    await scheduler.tick(at("2026-07-15T18:00"));
    expect(cp.state.activeSceneId).toBe(branding); // the floor takes it back at close
  });
});

describe("SceneScheduler — boot, the master switch, and DST", () => {
  test("the first tick ASSERTS the schedule on boot — unless the right scene is already live", async () => {
    const morning = await makeScene("Morning");
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    await cp.createSchedule({ sceneId: morning, daypartId: opening.id, days: [0, 1, 2, 3, 4, 5, 6], priority: 0, enabled: true, from: null, until: null });

    // A control plane that restarts at 09:05 puts the morning wall back up by itself.
    const boot = await scheduler.tick(at("2026-07-15T09:05"));
    expect(boot.applied).toBe(morning);

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
    expect(quiet.applied).toBeNull();
    expect(quiet.reason).toBe("already-live");
    expect(applied).toEqual([morning]);
  });

  test("a DISABLED scheduler applies nothing; re-enabling re-asserts the schedule", async () => {
    const morning = await makeScene("Morning");
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    await cp.createSchedule({ sceneId: morning, daypartId: opening.id, days: [0, 1, 2, 3, 4, 5, 6], priority: 0, enabled: true, from: null, until: null });

    await cp.updateSchedulerSettings({ enabled: false });
    const off = await scheduler.tick(at("2026-07-15T09:00"));
    expect(off.applied).toBeNull();
    expect(off.reason).toBe("disabled");
    expect(cp.state.activeSceneId).toBeNull();

    await cp.updateSchedulerSettings({ enabled: true });
    const on = await scheduler.tick(at("2026-07-15T09:01"));
    expect(on.applied).toBe(morning);
  });

  test("FALL BACK: the repeated local hour cannot double-apply", async () => {
    await cp.updateSchedulerSettings({ timezone: "Europe/London" });
    const night = await makeScene("Night");
    const overnight = await cp.createDaypart({ name: "Overnight", start: "23:00", end: "06:00" });
    await cp.createSchedule({ sceneId: night, daypartId: overnight.id, days: [0, 1, 2, 3, 4, 5, 6], priority: 0, enabled: true, from: null, until: null });

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
    const gone = await makeScene("Doomed");
    const opening = await cp.createDaypart({ name: "Opening hours", start: "08:00", end: "18:00" });
    const created = await cp.createSchedule({ sceneId: gone, daypartId: opening.id, days: [0, 1, 2, 3, 4, 5, 6], priority: 0, enabled: true, from: null, until: null });
    expect(created.ok).toBe(true);

    // Deleting the scene ALSO drops the schedule bound to it — nothing is left to resolve.
    await cp.deleteScene(gone);
    expect(cp.getSchedules()).toHaveLength(0);
    const tick = await scheduler.tick(at("2026-07-15T09:00"));
    expect(tick.applied).toBeNull();
    expect(tick.reason).toBe("nothing-scheduled");
  });
});
