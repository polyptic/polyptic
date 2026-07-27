/**
 * Panel power (POL-101, re-sourced onto the scene schedule at POL-186) — the seam the scene ticker
 * drives, on an INJECTED clock (a test that has to wait until 19:00 is not a test).
 *
 * The properties worth pinning are the ones a wall is judged by:
 *   - a manual override HOLDS until the next boundary. The ticker now calls `applyMuralPower`
 *     UNCONDITIONALLY, every mural, every ~10s, so this seam is the ONLY edge-trigger left: if it
 *     re-asserted, the wall an operator just woke would go back to sleep ten seconds later, which is
 *     the bug that makes people disable the feature;
 *   - an UNGOVERNED mural (`panels === null`) is left exactly as it is — not woken, not slept;
 *   - a box that reboots inside an off window is re-slept when it says hello (it comes back LIT —
 *     the compositor asserts `dpms on` at startup);
 *   - reconcile never sends a redundant WAKE: a booting box is already lit, and a wasted frame on
 *     every reconnect of every box in the fleet is a real cost.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { AdminBroadcaster, AdminHub, Presence } from "../src/admin";
import { ActivityLog } from "../src/activity";
import { AgentHub, PlayerHub } from "../src/hub";
import { PanelPowerScheduler } from "../src/panel-power";
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

interface PanelFixture {
  control: ControlPlane;
  panelPower: PanelPowerScheduler;
  /** What went down the wire, as `[screenId, on]` — the only thing that can darken a panel. */
  sent: Array<[string, boolean]>;
  activity: ActivityLog;
  setNowMinutes: (minutes: number) => void;
}

/**
 * One machine (`machine-1`) with one screen (`screen-1`), placed on one mural (`mural-1`), governed
 * by a single POWER-ONLY window: 19:00–07:00, panels off ("After hours"). The mural is therefore
 * GOVERNED, so the daytime gap resolves to "on" — which is what wakes the wall at 07:00.
 *
 * `nowMinutes` is minutes since local midnight on a fixed Wednesday, in UTC, so the injected clock
 * reads plainly against the window above.
 */
async function makePanelFixture(opts: { nowMinutes?: number } = {}): Promise<PanelFixture> {
  const control = new ControlPlane(new MemoryStore());
  await control.init();
  await control.registerMachine({
    machineId: "machine-1",
    agentVersion: "test",
    backend: "wayland-sway",
    power: { dpms: true, cec: false },
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
  });
  const screenId = control.getScreens()[0]!.id;
  // `init` seeds the default mural (`mural-1`) every deployment boots with — the wall this screen
  // lives on, and the one the tests below address by name.
  const mural = control.getMurals()[0]!;
  await control.placeScreen(screenId, mural.id, 0, 0);

  await control.updateSchedulerSettings({ enabled: true, timezone: "UTC" });
  const afterHours = await control.createDaypart({ name: "After hours", start: "19:00", end: "07:00" });
  const created = await control.createSchedule({
    sceneId: null, // POWER-ONLY: it says nothing about what plays, only what the panels do
    muralId: mural.id,
    daypartId: afterHours.id,
    days: [0, 1, 2, 3, 4, 5, 6],
    priority: 0,
    panels: "off",
    enabled: true,
    from: null,
    until: null,
  });
  if (!created.ok) throw new Error(`failed to create the schedule: ${created.error}`);

  const sent: PanelFixture["sent"] = [];
  const agentHub = new AgentHub();
  // Stand in for a live agent socket: record what would have gone down the wire, by SCREEN (the
  // wire carries a connector, and a connector on a machine is exactly one screen).
  agentHub.send = ((machineId: string, msg: { connector: string; on: boolean }) => {
    const screen = control
      .getScreens()
      .find((s) => s.machineId === machineId && s.connector === msg.connector);
    sent.push([screen?.id ?? `${machineId}/${msg.connector}`, msg.on]);
    return 1;
  }) as unknown as AgentHub["send"];

  const presence = new Presence();
  const activity = new ActivityLog();
  // A fixed Wednesday; only the time of day matters to the window above.
  let now = new Date(Date.UTC(2026, 6, 15, 0, 0, 0) + (opts.nowMinutes ?? 12 * 60) * 60_000);

  const panelPower = new PanelPowerScheduler({
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
    panelPower,
    sent,
    activity,
    setNowMinutes: (minutes: number) => {
      now = new Date(Date.UTC(2026, 6, 15, 0, 0, 0) + minutes * 60_000);
    },
  };
}

describe("scheduled panel power", () => {
  test("a manual wake mid-window holds until the next boundary", async () => {
    const { panelPower, sent } = await makePanelFixture(); // mural-1 has a 19:00-07:00 off window
    panelPower.applyMuralPower("mural-1", "on", "Opening hours");
    panelPower.applyMuralPower("mural-1", "off", "After hours");
    expect(sent).toEqual([["screen-1", false]]);
    sent.length = 0;
    panelPower.send("screen-1", true, "requested by an operator"); // the operator's 19:05 wake
    sent.length = 0;
    panelPower.applyMuralPower("mural-1", "off", "After hours"); // ticks keep arriving
    panelPower.applyMuralPower("mural-1", "off", "After hours");
    expect(sent).toEqual([]); // the schedule's opinion has not changed, so it says nothing
  });

  test("an ungoverned mural is left exactly as it is", async () => {
    const { panelPower, sent } = await makePanelFixture();
    panelPower.applyMuralPower("mural-1", null, "");
    panelPower.applyMuralPower("mural-1", null, "");
    expect(sent).toEqual([]);
  });

  test("hello reconcile re-sleeps a box that rebooted inside an off window", async () => {
    const { panelPower, sent } = await makePanelFixture({ nowMinutes: 21 * 60 });
    panelPower.reconcileMachine("machine-1");
    expect(sent).toEqual([["screen-1", false]]);
  });

  test("reconcile never sends a redundant wake — a booting box is already lit", async () => {
    const { panelPower, sent } = await makePanelFixture({ nowMinutes: 12 * 60 });
    panelPower.reconcileMachine("machine-1");
    expect(sent).toEqual([]);
  });

  test("the FIRST verdict records without sending — a server restart never sprays the fleet", async () => {
    const { panelPower, sent } = await makePanelFixture();
    panelPower.applyMuralPower("mural-1", "off", "After hours");
    expect(sent).toEqual([]); // absent memory = first sight of this screen: record, don't act
    panelPower.applyMuralPower("mural-1", "off", "After hours");
    expect(sent).toEqual([]); // …and still nothing, because nothing changed
  });

  test("crossing OFF sleeps the wall; crossing back ON wakes it, once each", async () => {
    const { panelPower, sent, activity } = await makePanelFixture();
    panelPower.applyMuralPower("mural-1", "on", "Opening hours"); // first sight: record "awake"
    expect(sent).toEqual([]);

    panelPower.applyMuralPower("mural-1", "off", "After hours"); // the 19:00 boundary
    panelPower.applyMuralPower("mural-1", "off", "After hours"); // …and every tick after it
    expect(sent).toEqual([["screen-1", false]]);

    panelPower.applyMuralPower("mural-1", "on", "Opening hours"); // 07:00 the next morning
    panelPower.applyMuralPower("mural-1", "on", "Opening hours");
    expect(sent).toEqual([
      ["screen-1", false],
      ["screen-1", true],
    ]);

    const lines = activity.recent().map((e) => e.text);
    expect(lines.some((m) => m.includes("is sleeping — After hours"))).toBe(true);
    expect(lines.some((m) => m.includes("woke — Opening hours"))).toBe(true);
  });

  test("an ungoverned tick FORGETS the memory, so re-enabling a window starts fresh", async () => {
    const { panelPower, sent } = await makePanelFixture();
    panelPower.applyMuralPower("mural-1", "on", "Opening hours"); // records "awake"
    panelPower.applyMuralPower("mural-1", null, ""); // the window was disabled: forget it
    panelPower.applyMuralPower("mural-1", "off", "After hours"); // first sight again: record only
    expect(sent).toEqual([]);
  });

  test("a mural's verdict never touches a screen placed on ANOTHER mural", async () => {
    const { control, panelPower, sent } = await makePanelFixture();
    const other = await control.createMural("Other wall");
    // The verdict is addressed to a mural this screen is not on, so nothing may leave the building.
    panelPower.applyMuralPower(other.id, "on", "Opening hours");
    panelPower.applyMuralPower(other.id, "off", "After hours");
    expect(sent).toEqual([]);
  });

  test("an UNPLACED screen belongs to no mural, so no window governs it", async () => {
    const { control, panelPower, sent } = await makePanelFixture({ nowMinutes: 21 * 60 });
    await control.unplaceScreen("screen-1");
    expect(panelPower.desiredFor("screen-1")).toBeNull();
    panelPower.reconcileMachine("machine-1");
    expect(sent).toEqual([]);
  });

  test("desiredFor reads the mural's window: asleep at 21:00, awake at noon", async () => {
    const night = await makePanelFixture({ nowMinutes: 21 * 60 });
    expect(night.panelPower.desiredFor("screen-1")).toBe(false);
    night.setNowMinutes(12 * 60);
    expect(night.panelPower.desiredFor("screen-1")).toBe(true); // the gap on a governed mural is ON
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
