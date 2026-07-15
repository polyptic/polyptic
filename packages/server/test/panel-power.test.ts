/**
 * Panel hours (POL-101) — schedule evaluation and the scheduler's edge-triggered behaviour, on an
 * INJECTED clock (a test that has to wait until 19:00 is not a test).
 *
 * The properties worth pinning are the ones a wall is judged by:
 *   - in hours, the scheduler NEVER sends a sleep — the non-negotiable, asserted rather than asserted-
 *     about;
 *   - a window that wraps midnight is a legal overnight window;
 *   - a manual override HOLDS until the next boundary (a level-triggered scheduler would put the wall
 *     an operator just woke straight back to sleep, which is the bug that makes people disable the
 *     feature);
 *   - a box that reboots outside its hours is re-slept when it says hello (it comes back LIT — the
 *     compositor asserts `dpms on` at startup);
 *   - the deployment's timezone decides, not the server's.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { AdminBroadcaster, AdminHub, Presence } from "../src/admin";
import { ActivityLog } from "../src/activity";
import { AgentHub, PlayerHub } from "../src/hub";
import { PanelPowerScheduler, minutesInZone, panelShouldBeOn } from "../src/panel-power";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";

const OFFICE = { enabled: true, on: "08:00", off: "18:00" } as const;

// ── pure evaluation ───────────────────────────────────────────────────────────

describe("POL-101 panelShouldBeOn", () => {
  const at = (hhmm: string): number => {
    const [h, m] = hhmm.split(":");
    return Number(h) * 60 + Number(m);
  };

  test("a daytime window: awake from the ON minute, asleep from the OFF minute", () => {
    expect(panelShouldBeOn(OFFICE, at("07:59"))).toBe(false);
    expect(panelShouldBeOn(OFFICE, at("08:00"))).toBe(true); // inclusive: it wakes AT 08:00
    expect(panelShouldBeOn(OFFICE, at("13:00"))).toBe(true);
    expect(panelShouldBeOn(OFFICE, at("17:59"))).toBe(true);
    expect(panelShouldBeOn(OFFICE, at("18:00"))).toBe(false); // exclusive: it sleeps AT 18:00
    expect(panelShouldBeOn(OFFICE, at("23:30"))).toBe(false);
  });

  test("a window that WRAPS midnight is a legal overnight window (a 24h ops wall)", () => {
    const overnight = { enabled: true, on: "20:00", off: "06:00" };
    expect(panelShouldBeOn(overnight, at("19:59"))).toBe(false);
    expect(panelShouldBeOn(overnight, at("20:00"))).toBe(true);
    expect(panelShouldBeOn(overnight, at("03:00"))).toBe(true);
    expect(panelShouldBeOn(overnight, at("05:59"))).toBe(true);
    expect(panelShouldBeOn(overnight, at("06:00"))).toBe(false);
  });
});

describe("POL-101 minutesInZone", () => {
  test("reads the DEPLOYMENT's clock, not the server's", () => {
    // 2026-07-14T09:30:00Z — the same instant is a different hour in each building.
    const instant = new Date("2026-07-14T09:30:00Z");
    expect(minutesInZone(instant, "UTC")).toBe(9 * 60 + 30);
    expect(minutesInZone(instant, "Europe/London")).toBe(10 * 60 + 30); // BST, +1
    expect(minutesInZone(instant, "America/New_York")).toBe(5 * 60 + 30); // EDT, −4
  });

  test("DST is handled by the zone, not by an offset we cached", () => {
    const winter = new Date("2026-01-14T09:30:00Z"); // GMT
    const summer = new Date("2026-07-14T09:30:00Z"); // BST
    expect(minutesInZone(winter, "Europe/London")).toBe(9 * 60 + 30);
    expect(minutesInZone(summer, "Europe/London")).toBe(10 * 60 + 30);
  });

  test("an unknown zone degrades to UTC and SAYS so — it never takes the scheduler down", () => {
    const warnings: string[] = [];
    const t = minutesInZone(new Date("2026-07-14T09:30:00Z"), "Mars/Olympus", (m) => warnings.push(m));
    expect(t).toBe(9 * 60 + 30);
    expect(warnings[0]).toContain("Mars/Olympus");
  });
});

// ── the scheduler ─────────────────────────────────────────────────────────────

interface Harness {
  control: ControlPlane;
  agentHub: AgentHub;
  presence: Presence;
  scheduler: PanelPowerScheduler;
  sent: Array<{ machineId: string; connector: string; on: boolean }>;
  screenId: string;
  setNow: (iso: string) => void;
}

async function harness(hours = OFFICE, timezone = "Europe/London"): Promise<Harness> {
  const control = new ControlPlane(new MemoryStore());
  await control.init();
  await control.registerMachine({
    machineId: "wall-1",
    agentVersion: "test",
    backend: "wayland-sway",
    power: { dpms: true, cec: false },
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
  });
  const screenId = control.getScreens()[0]!.id;
  await control.setPanelTimezone(timezone);
  await control.setPanelHours(screenId, { ...hours });

  const sent: Harness["sent"] = [];
  const agentHub = new AgentHub();
  // Stand in for a live agent socket: record what would have gone down the wire.
  agentHub.send = ((machineId: string, msg: { connector: string; on: boolean }) => {
    sent.push({ machineId, connector: msg.connector, on: msg.on });
    return 1;
  }) as unknown as AgentHub["send"];

  const presence = new Presence();
  const activity = new ActivityLog();
  const log = {
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  } as unknown as Parameters<typeof PanelPowerScheduler.prototype.constructor>[0]["log"];

  let now = new Date("2026-07-14T09:00:00Z");
  const scheduler = new PanelPowerScheduler({
    control,
    agentHub,
    presence,
    activity,
    broadcaster: new AdminBroadcaster({
      control,
      playerHub: new PlayerHub(),
      presence,
      adminHub: new AdminHub(),
      activity,
      log,
    }),
    log,
    now: () => now,
  });

  return {
    control,
    agentHub,
    presence,
    scheduler,
    sent,
    screenId,
    setNow: (iso: string) => {
      now = new Date(iso);
    },
  };
}

describe("POL-101 PanelPowerScheduler", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  test("IN HOURS the scheduler never sends a sleep — the whole non-negotiable, asserted", () => {
    // Walk the entire working day, tick by tick. Not one sleep may leave the building.
    for (const hhmm of ["08:00", "09:30", "12:00", "15:45", "17:59"]) {
      h.setNow(`2026-07-14T${hhmm}:00+01:00`);
      h.scheduler.tick();
    }
    expect(h.sent.filter((s) => !s.on)).toEqual([]);
  });

  test("the FIRST evaluation records without sending — a server restart never sprays the fleet", () => {
    h.setNow("2026-07-14T10:00:00+01:00");
    h.scheduler.tick();
    expect(h.sent).toEqual([]); // in hours, already awake: there is nothing to say
  });

  test("crossing the OFF boundary sleeps the panel; crossing ON wakes it", () => {
    h.setNow("2026-07-14T10:00:00+01:00");
    h.scheduler.tick(); // first sight: records "should be awake"

    h.setNow("2026-07-14T18:00:00+01:00"); // the boundary
    h.scheduler.tick();
    expect(h.sent).toEqual([{ machineId: "wall-1", connector: "DP-1", on: false }]);

    h.setNow("2026-07-14T22:00:00+01:00"); // still out of hours — no repeat
    h.scheduler.tick();
    expect(h.sent).toHaveLength(1);

    h.setNow("2026-07-15T08:00:00+01:00"); // next morning
    h.scheduler.tick();
    expect(h.sent[1]).toEqual({ machineId: "wall-1", connector: "DP-1", on: true });
  });

  test("a MANUAL wake out of hours HOLDS until the next boundary (no fighting the operator)", () => {
    h.setNow("2026-07-14T17:59:00+01:00");
    h.scheduler.tick(); // first sight, in hours
    h.setNow("2026-07-14T18:00:00+01:00");
    h.scheduler.tick(); // the boundary → sleep
    expect(h.sent).toEqual([{ machineId: "wall-1", connector: "DP-1", on: false }]);

    // The operator wakes it by hand for an evening visit. This is the REST path: it sends, and it
    // deliberately does NOT touch the scheduler's memory.
    h.scheduler.send(h.screenId, true, "requested by an operator from the console");
    expect(h.sent.at(-1)?.on).toBe(true);

    // Thirty seconds later — and for the rest of the evening — the scheduler leaves it alone. Recording
    // the manual value in the schedule's memory instead would put this wall back to sleep right here,
    // which is the bug that gets a scheduling feature switched off for good.
    h.setNow("2026-07-14T19:00:30+01:00");
    h.scheduler.tick();
    h.setNow("2026-07-14T23:30:00+01:00");
    h.scheduler.tick();
    expect(h.sent.filter((s) => !s.on)).toHaveLength(1); // still only the 18:00 sleep

    // …and the schedule resumes at the next boundary, as promised.
    h.setNow("2026-07-15T08:00:00+01:00");
    h.scheduler.tick();
    expect(h.sent.at(-1)).toEqual({ machineId: "wall-1", connector: "DP-1", on: true });
  });

  test("a box that reboots OUT of hours is re-slept when it says hello (it comes back lit)", () => {
    h.setNow("2026-07-14T23:00:00+01:00");
    h.scheduler.reconcileMachine("wall-1");
    expect(h.sent).toEqual([{ machineId: "wall-1", connector: "DP-1", on: false }]);
  });

  test("a box that reboots IN hours is left alone on hello — no wake frame, and never a sleep", () => {
    h.setNow("2026-07-14T10:00:00+01:00");
    h.scheduler.reconcileMachine("wall-1");
    expect(h.sent).toEqual([]); // it booted awake; there is nothing to do
  });

  test("a screen with NO window is never touched — every pre-POL-101 wall keeps running 24/7", async () => {
    await h.control.setPanelHours(h.screenId, null);
    for (const hour of ["03:00", "10:00", "19:00", "23:59"]) {
      h.setNow(`2026-07-14T${hour}:00+01:00`);
      h.scheduler.tick();
    }
    h.scheduler.reconcileMachine("wall-1");
    expect(h.sent).toEqual([]);
  });

  test("a DISABLED window governs nothing (and does not silently force a wake)", async () => {
    await h.control.setPanelHours(h.screenId, { enabled: false, on: "08:00", off: "18:00" });
    h.setNow("2026-07-14T23:00:00+01:00");
    h.scheduler.tick();
    expect(h.sent).toEqual([]);
    expect(h.scheduler.desiredFor(h.screenId)).toBeNull();
  });

  test("the DEPLOYMENT's timezone decides, not the server's", async () => {
    // The SAME instant, 20:00 UTC, judged by two buildings' clocks against the same 08:00–18:00 window.
    // In New York it is 16:00 — the wall is in hours and must NOT be slept. In London it is 21:00 —
    // out of hours, and the box comes back to a sleep. Same server, same code, different building.
    const ny = await harness(OFFICE, "America/New_York");
    ny.setNow("2026-07-14T20:00:00Z");
    ny.scheduler.reconcileMachine("wall-1");
    expect(ny.sent).toEqual([]);

    const london = await harness(OFFICE, "Europe/London");
    london.setNow("2026-07-14T20:00:00Z");
    london.scheduler.reconcileMachine("wall-1");
    expect(london.sent).toEqual([{ machineId: "wall-1", connector: "DP-1", on: false }]);
  });
});

describe("POL-101 panel hours persistence", () => {
  test("hours + timezone survive a control-plane restart on the same store", async () => {
    const store = new MemoryStore();
    const first = new ControlPlane(store);
    await first.init();
    await first.registerMachine({
      machineId: "wall-1",
      agentVersion: "test",
      backend: "wayland-sway",
      outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    });
    const screenId = first.getScreens()[0]!.id;
    await first.setPanelTimezone("America/New_York");
    await first.setPanelHours(screenId, { enabled: true, on: "07:30", off: "19:15" });

    const second = new ControlPlane(store);
    await second.init();
    expect(second.getPanelPowerConfig()).toEqual({ timezone: "America/New_York" });
    expect(second.getPanelHours(screenId)).toEqual({ enabled: true, on: "07:30", off: "19:15" });
  });

  test("removing a screen forgets its schedule — no ghost window on a re-created screen", async () => {
    const store = new MemoryStore();
    const control = new ControlPlane(store);
    await control.init();
    await control.registerMachine({
      machineId: "wall-1",
      agentVersion: "test",
      backend: "wayland-sway",
      outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    });
    const screenId = control.getScreens()[0]!.id;
    await control.setPanelHours(screenId, { enabled: true, on: "08:00", off: "18:00" });

    await control.removeScreen(screenId);
    expect(control.getPanelHours(screenId)).toBeUndefined();
    expect(control.listPanelHours()).toEqual([]);
  });
});
