/**
 * Panel power against a connector the box is NOT reporting — and the rebind when it comes back.
 *
 * The field failure: a screen bound to `DP-1` on a box that advertises only `DP-2`. Every wake and
 * every sleep was sent anyway, and the box refused each one ("connector \"DP-1\" is not a known sway
 * output"), so the console showed a screen that would not wake instead of a screen whose output does
 * not exist. Two properties are pinned here:
 *
 *   - a command is NOT sent into a connector the (connected) box is not reporting. Nothing goes down
 *     the wire, and the operator gets the true statement instead of a refusal;
 *   - a screen whose connector CAME BACK has its power re-asserted on the hello. Ordinary reconcile
 *     deliberately sends only the sleep half (a booting box is already lit); a re-created output is a
 *     different thing — nothing survived its destruction, so both halves are in play for exactly
 *     those screens, and only where a window governs them.
 *
 * Kept in its own file (rather than bolted onto panel-power.test.ts) so the seam it exercises reads
 * on its own and the two files can move independently.
 */
import { describe, expect, test } from "bun:test";

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

interface Fixture {
  control: ControlPlane;
  presence: Presence;
  panelPower: PanelPowerScheduler;
  screenId: string;
  /** What actually went down the wire, as `[connector, on]`. */
  sent: Array<[string, boolean]>;
}

/**
 * One box (`machine-1`) advertising `DP-1` and `DP-2`, both screens placed on the seeded mural, with
 * a 19:00–07:00 panels-off window. The box is ONLINE — the connector check is deliberately gated on
 * that, because a stale output list from a box that has gone dark proves nothing.
 */
async function makeFixture(opts: { nowMinutes?: number; governed?: boolean } = {}): Promise<Fixture> {
  const control = new ControlPlane(new MemoryStore());
  await control.init();
  await control.registerMachine({
    machineId: "machine-1",
    agentVersion: "test",
    backend: "wayland-sway",
    power: { dpms: true, cec: false },
    outputs: [
      { connector: "DP-1", width: 1920, height: 1080 },
      { connector: "DP-2", width: 1920, height: 1080 },
    ],
  });
  const mural = control.getMurals()[0]!;
  for (const screen of control.getScreens()) {
    await control.placeScreen(screen.id, mural.id, 0, 0);
    await control.setDemoWeb(screen.id, "https://example.com/"); // used → POL-9 never prunes it
  }
  const screenId = control.getScreens().find((s) => s.connector === "DP-1")!.id;

  if (opts.governed !== false) {
    await control.updateSchedulerSettings({ enabled: true, timezone: "UTC" });
    const afterHours = await control.createDaypart({
      name: "After hours",
      start: "19:00",
      end: "07:00",
    });
    const created = await control.createSchedule({
      sceneId: null,
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
  }

  const sent: Fixture["sent"] = [];
  const agentHub = new AgentHub();
  agentHub.send = ((_machineId: string, msg: { connector: string; on: boolean }) => {
    sent.push([msg.connector, msg.on]);
    return 1;
  }) as unknown as AgentHub["send"];

  const presence = new Presence();
  presence.agentConnected("machine-1", "plain"); // the box is CONNECTED and telling us its outputs
  const activity = new ActivityLog();
  const now = new Date(Date.UTC(2026, 6, 15, 0, 0, 0) + (opts.nowMinutes ?? 12 * 60) * 60_000);

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

  return { control, presence, panelPower, screenId, sent };
}

/** The box re-hellos advertising only `connectors` — the DP link dropped, the output is gone. */
async function readvertise(control: ControlPlane, ...connectors: string[]): Promise<string[]> {
  const result = await control.registerMachine({
    machineId: "machine-1",
    agentVersion: "test",
    backend: "wayland-sway",
    power: { dpms: true, cec: false },
    outputs: connectors.map((connector) => ({ connector, width: 1920, height: 1080 })),
  });
  return result.reboundScreenIds;
}

describe("panel power never addresses a connector the box is not reporting", () => {
  test("a wake for a connector the box has stopped reporting goes nowhere", async () => {
    const { control, panelPower, screenId, sent } = await makeFixture();
    await readvertise(control, "DP-2");
    expect(panelPower.send(screenId, true, "requested by an operator")).toBe(0);
    expect(sent).toEqual([]); // nothing on the wire, so nothing to be refused
  });

  test("a box advertising ZERO outputs takes no power command at all", async () => {
    const { control, panelPower, screenId, sent } = await makeFixture();
    await readvertise(control); // 93 hellos' worth of nothing
    expect(panelPower.send(screenId, false, "schedule: After hours")).toBe(0);
    expect(sent).toEqual([]);
  });

  test("the connector the box DOES report is addressed as normal", async () => {
    const { control, panelPower, sent } = await makeFixture();
    await readvertise(control, "DP-2");
    const other = control.getScreens().find((s) => s.connector === "DP-2")!;
    expect(panelPower.send(other.id, true, "requested by an operator")).toBe(1);
    expect(sent).toEqual([["DP-2", true]]);
  });

  test("the schedule's sleep is withheld from a missing connector, and kept for its neighbour", async () => {
    const { control, panelPower, sent } = await makeFixture({ nowMinutes: 21 * 60 });
    await readvertise(control, "DP-2");
    panelPower.reconcileMachine("machine-1"); // the 21:00 re-sleep on a box that just said hello
    expect(sent).toEqual([["DP-2", false]]);
  });
});

describe("a returning connector is reconciled back to its desired state", () => {
  test("in hours, the rebound screen is WOKEN — its output was destroyed and re-created", async () => {
    const { control, panelPower, sent } = await makeFixture({ nowMinutes: 12 * 60 });
    await readvertise(control, "DP-2");
    const rebound = await readvertise(control, "DP-1", "DP-2");
    expect(rebound).toHaveLength(1);

    panelPower.reconcileMachine("machine-1", new Set(rebound));
    // ONLY the rebound screen: the ordinary reconcile still sends no redundant wake to DP-2.
    expect(sent).toEqual([["DP-1", true]]);
  });

  test("out of hours, the rebound screen is SLEPT again", async () => {
    const { control, panelPower, sent } = await makeFixture({ nowMinutes: 21 * 60 });
    await readvertise(control, "DP-2");
    const rebound = await readvertise(control, "DP-1", "DP-2");

    panelPower.reconcileMachine("machine-1", new Set(rebound));
    expect(sent).toContainEqual(["DP-1", false]);
  });

  test("an UNGOVERNED wall is left exactly as it is, even on a rebind", async () => {
    const { control, panelPower, sent } = await makeFixture({ governed: false });
    await readvertise(control, "DP-2");
    const rebound = await readvertise(control, "DP-1", "DP-2");
    expect(rebound).toHaveLength(1);

    panelPower.reconcileMachine("machine-1", new Set(rebound));
    expect(sent).toEqual([]); // no window governs it; a re-created output comes up lit anyway
  });
});
