/**
 * The POL-101 wire contract, and — more importantly — its BACK-COMPATIBILITY.
 *
 * A fleet is not upgraded atomically. A wall in a building somewhere will be running a pre-POL-101
 * agent for months, and a control plane that cannot parse its hello is a control plane that has just
 * bricked that wall. Every field this ticket adds is therefore OPTIONAL on the wire, and these tests
 * are what stop someone quietly making one required later.
 *
 * The other half is POL-186's deletion: the per-screen calendar this ticket once shipped is gone,
 * and the tests below are what stop it — and its second timezone — creeping back in.
 */
import { describe, expect, test } from "bun:test";

import * as protocol from "../src/index";
import {
  AgentHello,
  AgentMessage,
  AgentPowerAck,
  MachineView,
  PROTOCOL_VERSION,
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
      reason: "schedule: After hours",
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

/**
 * POL-186 — the per-screen calendar is GONE. A wall's waking hours are a schedule window
 * (`Schedule.panels`) aimed at a mural, read on the scheduler's one timezone. These tests exist so
 * that nobody quietly reintroduces the second calendar: an export that comes back is a second clock
 * coming back with it.
 */
describe("per-screen panel hours are gone", () => {
  test("the schemas no longer exist", () => {
    expect("PanelHours" in protocol).toBe(false);
    expect("PanelHoursBody" in protocol).toBe(false);
    expect("PanelPowerConfig" in protocol).toBe(false);
    expect("UpdatePanelPowerBody" in protocol).toBe(false);
  });

  test("manual wake/sleep survives untouched — it is a different feature", () => {
    const msg = protocol.ServerToAgentDisplayPower.parse({
      t: "server/display-power",
      connector: "HDMI-1",
      on: false,
      reason: "requested by an operator",
    });
    expect(msg.on).toBe(false);
    // What a box CAN do is not the same question as WHEN it does it: these stay.
    expect(protocol.PanelPowerMethod.parse("cec")).toBe("cec");
    expect(protocol.PowerCapabilities.parse({ dpms: true, cec: false })).toEqual({
      dpms: true,
      cec: false,
    });
    // …as does the manual body the wake/sleep buttons POST.
    expect(protocol.PanelPowerBody.parse({ on: true }).on).toBe(true);
  });

  test("a screen view no longer carries a window of its own", () => {
    const view = ScreenView.parse({
      id: "scr-1",
      friendlyName: "Atrium",
      machineId: "wall-1",
      connector: "DP-1",
      online: true,
      revision: 3,
      surfaceCount: 1,
      panelHours: { enabled: true, on: "07:00", off: "19:00" },
    } as never);
    expect("panelHours" in view).toBe(false); // stripped, not honoured — one calendar only
  });
});

describe("POL-101 the power frame itself", () => {
  test("`server/display-power` demands a connector and a boolean — no ambiguity reaches a wall", () => {
    expect(() => ServerToAgentDisplayPower.parse({ t: "server/display-power", on: false })).toThrow();
    expect(() =>
      ServerToAgentDisplayPower.parse({ t: "server/display-power", connector: "DP-1", on: "off" }),
    ).toThrow();
  });
});
