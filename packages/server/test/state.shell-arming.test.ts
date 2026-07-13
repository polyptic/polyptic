/**
 * POL-59 hardening — the remote-shell arming TTL sweep, driven directly against the ControlPlane.
 *
 * Arming stamps a time; `disarmExpiredShells` auto-disarms a box armed-and-idle past the TTL, but
 * spares one with a live session and one whose arm time was refreshed. `nowMs` is injected so the
 * clock is deterministic.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    hostname: "box",
  };
}

const TTL = 60 * 60 * 1000; // 1h
const never = () => false;

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
  await cp.registerMachine(hello("box-1"), undefined);
});

describe("remote-shell arming TTL (POL-59)", () => {
  test("arming stamps a time; disarming clears it", async () => {
    const armed = await cp.setShellEnabled("box-1", true);
    expect(armed?.shellEnabled).toBe(true);
    expect(typeof armed?.shellArmedAt).toBe("string");
    const disarmed = await cp.setShellEnabled("box-1", false);
    expect(disarmed?.shellEnabled).toBe(false);
    expect(disarmed?.shellArmedAt).toBeUndefined();
  });

  test("a box idle past the TTL is auto-disarmed", async () => {
    await cp.setShellEnabled("box-1", true);
    const armedAt = Date.parse(cp.getMachine("box-1")!.shellArmedAt!);
    const disarmed = await cp.disarmExpiredShells(TTL, armedAt + TTL + 1, never);
    expect(disarmed.map((m) => m.id)).toEqual(["box-1"]);
    expect(cp.isShellEnabled("box-1")).toBe(false);
  });

  test("a box still within the TTL is left armed", async () => {
    await cp.setShellEnabled("box-1", true);
    const armedAt = Date.parse(cp.getMachine("box-1")!.shellArmedAt!);
    const disarmed = await cp.disarmExpiredShells(TTL, armedAt + TTL - 1, never);
    expect(disarmed).toHaveLength(0);
    expect(cp.isShellEnabled("box-1")).toBe(true);
  });

  test("a box with a LIVE session is spared even past the TTL", async () => {
    await cp.setShellEnabled("box-1", true);
    const armedAt = Date.parse(cp.getMachine("box-1")!.shellArmedAt!);
    const disarmed = await cp.disarmExpiredShells(TTL, armedAt + TTL + 1, (id) => id === "box-1");
    expect(disarmed).toHaveLength(0);
    expect(cp.isShellEnabled("box-1")).toBe(true);
  });

  test("refreshing the arm time extends the window", async () => {
    await cp.setShellEnabled("box-1", true);
    const armedAt = Date.parse(cp.getMachine("box-1")!.shellArmedAt!);
    // Just before it would expire, a terminal opens → refresh.
    await cp.refreshShellArmed("box-1");
    const refreshedAt = Date.parse(cp.getMachine("box-1")!.shellArmedAt!);
    expect(refreshedAt).toBeGreaterThanOrEqual(armedAt);
    // The old expiry moment no longer disarms it.
    const disarmed = await cp.disarmExpiredShells(TTL, refreshedAt + TTL - 1, never);
    expect(disarmed).toHaveLength(0);
    expect(cp.isShellEnabled("box-1")).toBe(true);
  });

  test("ttl <= 0 disables the sweep (arming stays sticky)", async () => {
    await cp.setShellEnabled("box-1", true);
    const disarmed = await cp.disarmExpiredShells(0, Date.now() + 10 * TTL, never);
    expect(disarmed).toHaveLength(0);
    expect(cp.isShellEnabled("box-1")).toBe(true);
  });
});
