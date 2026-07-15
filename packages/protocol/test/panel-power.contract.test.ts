/**
 * The POL-101 wire contract, and — more importantly — its BACK-COMPATIBILITY.
 *
 * A fleet is not upgraded atomically. A wall in a building somewhere will be running a pre-POL-101
 * agent for months, and a control plane that cannot parse its hello is a control plane that has just
 * bricked that wall. Every field this ticket adds is therefore OPTIONAL on the wire, and these tests
 * are what stop someone quietly making one required later.
 *
 * The other half is the shape of the schedule itself: "HH:MM", validated at the edge, because a
 * malformed time that reaches the scheduler is a wall that sleeps at the wrong hour — or never wakes.
 */
import { describe, expect, test } from "bun:test";

import {
  AgentHello,
  AgentMessage,
  AgentPowerAck,
  MachineView,
  PROTOCOL_VERSION,
  PanelHours,
  PanelPowerConfig,
  ScreenView,
  ServerToAgentDisplayPower,
  ServerToAgentMessage,
} from "../src/index";

const OLD_HELLO = {
  t: "agent/hello",
  protocol: PROTOCOL_VERSION,
  machineId: "wall-1",
  agentVersion: "0.2.20",
  backend: "wayland-sway",
  outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
} as const;

describe("POL-101 back-compat", () => {
  test("a PRE-POL-101 agent's hello still parses — it simply reports no power capability", () => {
    const parsed = AgentHello.parse(OLD_HELLO);
    expect(parsed.power).toBeUndefined();
  });

  test("a POL-101 agent reports what it can actually do", () => {
    const parsed = AgentHello.parse({ ...OLD_HELLO, power: { dpms: true, cec: false } });
    expect(parsed.power).toEqual({ dpms: true, cec: false });
  });

  test("a ScreenView without the power fields is still a valid ScreenView (older server → console)", () => {
    const view = ScreenView.parse({
      id: "scr-1",
      friendlyName: "Atrium",
      machineId: "wall-1",
      connector: "DP-1",
      online: true,
      revision: 3,
      surfaceCount: 1,
    });
    expect(view.asleep).toBeUndefined();
    expect(view.panelHours).toBeUndefined();
    expect(view.powerMethods).toBeUndefined();
  });

  test("a MachineView without `power` is valid — the console then offers no wake/sleep for it", () => {
    const view = MachineView.parse({
      id: "wall-1",
      label: "wall-1",
      online: true,
      status: "approved",
      outputCount: 1,
      screens: [],
    });
    expect(view.power).toBeUndefined();
  });

  test("both new frames are members of their unions (a real agent/server will route them)", () => {
    const power = ServerToAgentMessage.parse({
      t: "server/display-power",
      connector: "DP-1",
      on: false,
      reason: "panel hours",
    });
    expect(power.t).toBe("server/display-power");

    const ack = AgentMessage.parse({
      t: "agent/power-ack",
      machineId: "wall-1",
      connector: "DP-1",
      on: false,
      ok: true,
      methods: ["dpms", "cec"],
    });
    expect(ack.t).toBe("agent/power-ack");
  });

  test("an ack from an agent that omits `methods` defaults to [] rather than exploding", () => {
    const ack = AgentPowerAck.parse({
      t: "agent/power-ack",
      machineId: "wall-1",
      connector: "DP-1",
      on: true,
      ok: true,
    });
    expect(ack.methods).toEqual([]);
  });
});

describe("POL-101 schedule shape", () => {
  test("panel hours are 24-hour HH:MM — a malformed time is refused AT THE EDGE", () => {
    expect(PanelHours.parse({ enabled: true, on: "07:30", off: "19:15" })).toEqual({
      enabled: true,
      on: "07:30",
      off: "19:15",
    });
    for (const bad of ["7:30", "25:00", "19:60", "19h00", "", "0730"]) {
      expect(() => PanelHours.parse({ enabled: true, on: bad, off: "19:00" })).toThrow();
    }
  });

  test("a window whose on === off is meaningless, and is rejected", () => {
    expect(() => PanelHours.parse({ enabled: true, on: "09:00", off: "09:00" })).toThrow();
  });

  test("a window that WRAPS midnight is legal (a 24-hour operations wall)", () => {
    expect(PanelHours.parse({ enabled: true, on: "20:00", off: "06:00" }).on).toBe("20:00");
  });

  test("the panel-power config carries an explicit zone", () => {
    expect(PanelPowerConfig.parse({ timezone: "Europe/London" }).timezone).toBe("Europe/London");
    expect(() => PanelPowerConfig.parse({ timezone: "" })).toThrow();
  });

  test("`server/display-power` demands a connector and a boolean — no ambiguity reaches a wall", () => {
    expect(() => ServerToAgentDisplayPower.parse({ t: "server/display-power", on: false })).toThrow();
    expect(() =>
      ServerToAgentDisplayPower.parse({ t: "server/display-power", connector: "DP-1", on: "off" }),
    ).toThrow();
  });
});
