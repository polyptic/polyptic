/**
 * POL-119 — the per-screen cast (AirPlay receiver) toggle, driven directly against the ControlPlane.
 *
 * castEnabled is PERSISTENT desired state with no TTL (unlike the shell arm): it must survive a
 * server restart, ride the apply assignments to the agent (with the friendly name the receiver
 * advertises), and never bump the revision — it isn't render data.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [
      { connector: "DP-1", width: 1920, height: 1080 },
      { connector: "DP-2", width: 1920, height: 1080 },
    ],
    hostname: "box",
  };
}

let store: MemoryStore;
let cp: ControlPlane;
let screenId: string;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
  await cp.registerMachine(hello("box-1"), undefined);
  screenId = cp.getScreens().find((s) => s.connector === "DP-1")!.id;
});

describe("per-screen cast toggle (POL-119)", () => {
  test("screens are born un-castable", () => {
    for (const s of cp.getScreens()) expect(s.castEnabled).toBe(false);
  });

  test("enabling sets the flag; disabling clears it; unknown screen → null", async () => {
    const on = await cp.setScreenCastEnabled(screenId, true);
    expect(on?.castEnabled).toBe(true);
    const off = await cp.setScreenCastEnabled(screenId, false);
    expect(off?.castEnabled).toBe(false);
    expect(await cp.setScreenCastEnabled("screen-nope", true)).toBeNull();
  });

  test("toggling does NOT bump the revision (not render data)", async () => {
    const before = cp.state.revision;
    await cp.setScreenCastEnabled(screenId, true);
    expect(cp.state.revision).toBe(before);
  });

  test("the flag persists across a control-plane restart (no TTL, survives reboots)", async () => {
    await cp.setScreenCastEnabled(screenId, true);
    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect(cp2.getScreen(screenId)?.castEnabled).toBe(true);
  });

  test("a rename never disturbs the flag (both ride upsertScreen)", async () => {
    await cp.setScreenCastEnabled(screenId, true);
    await cp.renameScreen(screenId, "Boardroom Left");
    const cp2 = new ControlPlane(store);
    await cp2.init();
    const screen = cp2.getScreen(screenId);
    expect(screen?.friendlyName).toBe("Boardroom Left");
    expect(screen?.castEnabled).toBe(true);
  });

  test("assignmentsFor carries castEnabled + the advertised friendly name, per connector", async () => {
    await cp.setScreenCastEnabled(screenId, true);
    await cp.renameScreen(screenId, "Boardroom Left");
    const assignments = cp.assignmentsFor("box-1");
    expect(assignments).toHaveLength(2);
    const dp1 = assignments.find((a) => a.connector === "DP-1");
    const dp2 = assignments.find((a) => a.connector === "DP-2");
    expect(dp1?.castEnabled).toBe(true);
    expect(dp1?.friendlyName).toBe("Boardroom Left");
    expect(dp2?.castEnabled).toBe(false);
  });

  test("re-registration (agent reconnect) keeps the flag in the apply assignments", async () => {
    await cp.setScreenCastEnabled(screenId, true);
    const result = await cp.registerMachine(hello("box-1"), undefined);
    const dp1 = result.assignments.find((a) => a.connector === "DP-1");
    expect(dp1?.castEnabled).toBe(true);
  });
});
