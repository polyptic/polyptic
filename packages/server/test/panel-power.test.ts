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
 *   - a screen DRAGGED OFF the wall that slept it wakes. Power hangs on the wall, so the move changed
 *     the schedule's opinion of that screen without either mural's verdict moving, and nothing else
 *     re-asserts — miss it and the panel is dark until someone presses Wake;
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
  /** The mural the screen is placed on. Returned rather than assumed: two of the tests below are
   *  NEGATIVE (nothing is sent), so a hardcoded id that stopped matching the seeded mural would make
   *  them pass for the wrong reason — the loudest failure mode a deletion test has. */
  muralId: string;
  /** What went down the wire, as `[screenId, on]` — the only thing that can darken a panel. */
  sent: Array<[string, boolean]>;
  activity: ActivityLog;
  setNowMinutes: (minutes: number) => void;
}

/**
 * One machine (`machine-1`) with one screen (`screen-1`), placed on the deployment's seeded mural,
 * governed by a single POWER-ONLY window: 19:00–07:00, panels off ("After hours"). The mural is
 * therefore GOVERNED, so the daytime gap resolves to "on" — which is what wakes the wall at 07:00.
 * The mural's id is RETURNED, never assumed: the negative tests below assert that nothing was sent,
 * and an id that quietly stopped matching would make them pass without exercising anything.
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
  // `init` seeds the default mural every deployment boots with — the wall this screen lives on, and
  // the one the tests below address, by the id the fixture hands back.
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
    muralId: mural.id,
    sent,
    activity,
    setNowMinutes: (minutes: number) => {
      now = new Date(Date.UTC(2026, 6, 15, 0, 0, 0) + minutes * 60_000);
    },
  };
}

describe("scheduled panel power", () => {
  test("a manual wake mid-window holds until the next boundary", async () => {
    const { panelPower, sent, muralId } = await makePanelFixture(); // a 19:00-07:00 off window
    panelPower.applyMuralPower(muralId, "on", "Opening hours");
    panelPower.applyMuralPower(muralId, "off", "After hours");
    expect(sent).toEqual([["screen-1", false]]);
    sent.length = 0;
    panelPower.send("screen-1", true, "requested by an operator"); // the operator's 19:05 wake
    sent.length = 0;
    panelPower.applyMuralPower(muralId, "off", "After hours"); // ticks keep arriving
    panelPower.applyMuralPower(muralId, "off", "After hours");
    expect(sent).toEqual([]); // the schedule's opinion has not changed, so it says nothing
  });

  test("an ungoverned mural is left exactly as it is", async () => {
    const { panelPower, sent, muralId } = await makePanelFixture();
    panelPower.applyMuralPower(muralId, null, "");
    panelPower.applyMuralPower(muralId, null, "");
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
    const { panelPower, sent, muralId } = await makePanelFixture();
    panelPower.applyMuralPower(muralId, "off", "After hours");
    expect(sent).toEqual([]); // absent memory = first sight of this screen: record, don't act
    panelPower.applyMuralPower(muralId, "off", "After hours");
    expect(sent).toEqual([]); // …and still nothing, because nothing changed
  });

  test("crossing OFF sleeps the wall; crossing back ON wakes it, once each", async () => {
    const { panelPower, sent, activity, muralId } = await makePanelFixture();
    panelPower.applyMuralPower(muralId, "on", "Opening hours"); // first sight: record "awake"
    expect(sent).toEqual([]);

    panelPower.applyMuralPower(muralId, "off", "After hours"); // the 19:00 boundary
    panelPower.applyMuralPower(muralId, "off", "After hours"); // …and every tick after it
    expect(sent).toEqual([["screen-1", false]]);

    panelPower.applyMuralPower(muralId, "on", "Opening hours"); // 07:00 the next morning
    panelPower.applyMuralPower(muralId, "on", "Opening hours");
    expect(sent).toEqual([
      ["screen-1", false],
      ["screen-1", true],
    ]);

    const lines = activity.recent().map((e) => e.text);
    expect(lines.some((m) => m.includes("is sleeping — After hours"))).toBe(true);
    expect(lines.some((m) => m.includes("woke — Opening hours"))).toBe(true);
  });

  test("an ungoverned tick FORGETS the memory, so re-enabling a window starts fresh", async () => {
    const { panelPower, sent, muralId } = await makePanelFixture();
    panelPower.applyMuralPower(muralId, "on", "Opening hours"); // records "awake"
    panelPower.applyMuralPower(muralId, null, ""); // the window was disabled: forget it
    panelPower.applyMuralPower(muralId, "off", "After hours"); // first sight again: record only
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

  /**
   * A SCREEN MOVED BETWEEN MURALS WHILE ASLEEP. This is the regression per-screen panel hours could
   * not have: a screen carried its own window and woke at its own 07:00. Now the window belongs to
   * the WALL, so dragging a sleeping screen onto another wall changes the schedule's opinion FOR THAT
   * SCREEN without either mural's own verdict changing — and the memory, which is keyed per screen,
   * has to see that edge. Nothing re-asserts otherwise: the ticker is the only caller on the hot
   * path, `reconcileMachine` only ever sends the SLEEP half, and no placement route touches power.
   * So a miss here is a panel dark until an operator finds the Wake button.
   */
  test("a screen asleep by A's window wakes when it is dragged onto an UNGOVERNED mural", async () => {
    const { control, panelPower, sent, muralId } = await makePanelFixture({ nowMinutes: 20 * 60 });
    panelPower.applyMuralPower(muralId, "on", "Opening hours"); // first sight: record "awake"
    panelPower.applyMuralPower(muralId, "off", "After hours"); // 19:00 — the wall sleeps
    expect(sent).toEqual([["screen-1", false]]);
    sent.length = 0;

    // 20:00: the operator drags the screen onto a wall no window governs.
    const other = await control.createMural("Atrium");
    await control.placeScreen("screen-1", other.id, 0, 0);

    // The next tick, in the order the ticker runs it: A no longer holds the screen, and B is
    // ungoverned. Under a plain "null = leave it alone" the screen would stay dark forever.
    panelPower.applyMuralPower(muralId, "off", "After hours");
    panelPower.applyMuralPower(other.id, null, "outside its scheduled windows");
    expect(sent).toEqual([["screen-1", true]]);
  });

  test("a screen asleep by A's window wakes when it is dragged onto a mural that is ON", async () => {
    const { control, panelPower, sent, muralId } = await makePanelFixture({ nowMinutes: 20 * 60 });
    panelPower.applyMuralPower(muralId, "on", "Opening hours");
    panelPower.applyMuralPower(muralId, "off", "After hours");
    expect(sent).toEqual([["screen-1", false]]);
    sent.length = 0;

    const other = await control.createMural("Atrium");
    await control.placeScreen("screen-1", other.id, 0, 0);
    panelPower.applyMuralPower(muralId, "off", "After hours");
    panelPower.applyMuralPower(other.id, "on", "Open day"); // B's own window keeps its wall lit
    expect(sent).toEqual([["screen-1", true]]);
  });

  test("a screen still asleep by ITS OWN mural's window is not woken by the move-wake", async () => {
    const { control, panelPower, sent, muralId } = await makePanelFixture({ nowMinutes: 20 * 60 });
    panelPower.applyMuralPower(muralId, "on", "Opening hours");
    panelPower.applyMuralPower(muralId, "off", "After hours");
    sent.length = 0;

    const other = await control.createMural("Atrium");
    await control.placeScreen("screen-1", other.id, 0, 0);
    panelPower.applyMuralPower(other.id, "off", "After hours"); // B says off too — it stays asleep
    expect(sent).toEqual([]);
  });

  /**
   * The tension the move-wake must not break: `panels === null` means "leave the wall exactly as it
   * is", so a screen an operator slept BY HAND stays asleep. A manual sleep never writes the memory,
   * so there is nothing recorded to wake from — and an ungoverned tick on the screen's OWN mural (a
   * window the operator just disabled) is "leave it alone" too, not a wake.
   */
  test("an ungoverned mural leaves a hand-slept screen asleep", async () => {
    const { panelPower, sent, muralId } = await makePanelFixture({ nowMinutes: 12 * 60 });
    panelPower.send("screen-1", false, "requested by an operator");
    sent.length = 0;
    panelPower.applyMuralPower(muralId, null, "outside its scheduled windows");
    panelPower.applyMuralPower(muralId, null, "outside its scheduled windows");
    expect(sent).toEqual([]);
  });

  test("disabling the window that slept a wall leaves it asleep — it has not moved", async () => {
    const { panelPower, sent, muralId } = await makePanelFixture({ nowMinutes: 20 * 60 });
    panelPower.applyMuralPower(muralId, "on", "Opening hours");
    panelPower.applyMuralPower(muralId, "off", "After hours");
    sent.length = 0;
    panelPower.applyMuralPower(muralId, null, ""); // the operator switched the window off
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

  /**
   * A DISABLED SCHEDULER CANNOT DARKEN A WALL. It holds because the shared resolver answers
   * `panels: null` when the scheduler is off — but that is a guarantee living one package away, and
   * this seam is the last thing between a resolver verdict and a dark panel in a lobby. Pin it HERE,
   * so a future change to the resolver's disabled branch fails on the file whose job it is to care.
   */
  test("a disabled scheduler cannot darken a wall — deep inside the off window", async () => {
    const { control, panelPower, sent } = await makePanelFixture({ nowMinutes: 21 * 60 });
    expect(panelPower.desiredFor("screen-1")).toBe(false); // …while it is switched ON

    await control.updateSchedulerSettings({ enabled: false });
    expect(panelPower.desiredFor("screen-1")).toBeNull(); // ungoverned: nobody has an opinion
    panelPower.reconcileMachine("machine-1"); // a box rebooting at 21:00 with the scheduler off
    expect(sent).toEqual([]); // nothing goes down the wire, so nothing goes dark
  });
});
