/**
 * POL-81 — SSH arming in the ControlPlane, the twin of the POL-59 shell arming
 * (state.shell-arming.test.ts). Arming stamps a time + stores the operator's public key;
 * `disarmExpiredSshAccess` auto-disarms a box armed past the TTL (purely time-since-arm — an SSH
 * session is invisible to the control plane). `nowMs` is injected so the clock is deterministic.
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

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5 operator@laptop";
const TTL = 60 * 60 * 1000; // 1h

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
  await cp.registerMachine(hello("box-1"), undefined);
});

describe("SSH arming (POL-81)", () => {
  test("arming stamps a time + stores the key; disarming clears both", async () => {
    const armed = await cp.setSshEnabled("box-1", true, KEY);
    expect(armed?.sshEnabled).toBe(true);
    expect(typeof armed?.sshArmedAt).toBe("string");
    expect(cp.sshPublicKey("box-1")).toBe(KEY);

    const disarmed = await cp.setSshEnabled("box-1", false);
    expect(disarmed?.sshEnabled).toBe(false);
    expect(disarmed?.sshArmedAt).toBeUndefined();
    expect(cp.sshPublicKey("box-1")).toBeUndefined();
  });

  test("the stored key survives a store reload (reconcile across a server restart)", async () => {
    await cp.setSshEnabled("box-1", true, KEY);
    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect(cp2.isSshEnabled("box-1")).toBe(true);
    expect(cp2.sshPublicKey("box-1")).toBe(KEY);
  });

  test("a box armed past the TTL is auto-disarmed and its key removed", async () => {
    await cp.setSshEnabled("box-1", true, KEY);
    const armedAt = Date.parse(cp.getMachine("box-1")!.sshArmedAt!);
    const disarmed = await cp.disarmExpiredSshAccess(TTL, armedAt + TTL + 1);
    expect(disarmed.map((m) => m.id)).toEqual(["box-1"]);
    expect(cp.isSshEnabled("box-1")).toBe(false);
    expect(cp.sshPublicKey("box-1")).toBeUndefined();
  });

  test("a box still within the TTL is left armed", async () => {
    await cp.setSshEnabled("box-1", true, KEY);
    const armedAt = Date.parse(cp.getMachine("box-1")!.sshArmedAt!);
    const disarmed = await cp.disarmExpiredSshAccess(TTL, armedAt + TTL - 1);
    expect(disarmed).toHaveLength(0);
    expect(cp.isSshEnabled("box-1")).toBe(true);
  });

  test("ttl <= 0 disables the server sweep (box-side TTL still applies)", async () => {
    await cp.setSshEnabled("box-1", true, KEY);
    const disarmed = await cp.disarmExpiredSshAccess(0, Date.now() + 10 * TTL);
    expect(disarmed).toHaveLength(0);
    expect(cp.isSshEnabled("box-1")).toBe(true);
  });
});
