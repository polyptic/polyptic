/**
 * POL-171 — the control plane records WHICH boot chain each box came up through.
 *
 * The 2026-07-21 field failure: a wired box silently booted the stick's local Wi-Fi fallback all
 * day (its GRUB DHCP fails on that NIC), rendering the stale image the local menu PINS, and nothing
 * anywhere said so. A Live Activity line scrolls away, so the state lives on the MACHINE record —
 * persisted, hello-proof, and self-clearing on the box's own next wired boot. So:
 *
 *   - a boot report sets the path + timestamp + the box's own sentence;
 *   - a re-hello never erases it (the agent knows nothing about boot chains);
 *   - the recovery `local-fallback` → `wired` is announced — it closes the story the fallback
 *     warning opened — and every other transition is silent (a line per boot is a metronome);
 *   - it survives a restart, i.e. it is store state;
 *   - an unknown machineId records nothing and reports `false` (the /boot/report route still puts
 *     the warn line in the feed for a box the registry has never met).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { ActivityLog } from "../src/activity";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    hostname: "wall1",
  };
}

let store: MemoryStore;
let cp: ControlPlane;
let activity: ActivityLog;

const feed = (): string[] => activity.recent().map((e) => e.text);

beforeEach(async () => {
  store = new MemoryStore();
  activity = new ActivityLog();
  cp = new ControlPlane(store, activity);
  await cp.init();
});

describe("the boot path a box reported (POL-171)", () => {
  test("a fallback report records path, timestamp and the box's own sentence", async () => {
    await cp.registerMachine(hello("box-1"));
    const known = await cp.noteBootPath("box-1", "local-fallback", "image pinned at 20260721T-abc");
    expect(known).toBe(true);
    const m = cp.getMachine("box-1");
    expect(m?.bootPath).toBe("local-fallback");
    expect(m?.bootPathDetail).toBe("image pinned at 20260721T-abc");
    expect(typeof m?.bootPathAt).toBe("string");
  });

  test("a re-hello never erases it — the agent knows nothing about boot chains", async () => {
    await cp.registerMachine(hello("box-1"));
    await cp.noteBootPath("box-1", "local-fallback", "image pinned at 20260721T-abc");
    await cp.registerMachine(hello("box-1"));
    expect(cp.getMachine("box-1")?.bootPath).toBe("local-fallback");
  });

  test("the recovery local-fallback → wired is announced; the fallback itself is not (the route owns that line)", async () => {
    await cp.registerMachine(hello("box-1"));
    await cp.noteBootPath("box-1", "local-fallback", "image pinned at 20260721T-abc");
    expect(feed().some((t) => t.includes("wired boot chain"))).toBe(false);
    await cp.noteBootPath("box-1", "wired", "");
    expect(feed().some((t) => t.includes("back on the wired boot chain"))).toBe(true);
  });

  test("healthy boots are silent — wired after wired, Wi-Fi after Wi-Fi, no metronome", async () => {
    await cp.registerMachine(hello("box-1"));
    const before = feed().length;
    await cp.noteBootPath("box-1", "wired", "");
    await cp.noteBootPath("box-1", "wired", "");
    await cp.noteBootPath("box-1", "local-wifi", "image pinned at x");
    await cp.noteBootPath("box-1", "local-wifi", "image pinned at x");
    expect(feed().length).toBe(before);
  });

  test("it survives a restart (store state, like the image id)", async () => {
    await cp.registerMachine(hello("box-1"));
    await cp.noteBootPath("box-1", "local-fallback", "image pinned at 20260721T-abc");

    const reloaded = new ControlPlane(store, new ActivityLog());
    await reloaded.init();
    const m = reloaded.getMachine("box-1");
    expect(m?.bootPath).toBe("local-fallback");
    expect(m?.bootPathDetail).toBe("image pinned at 20260721T-abc");
  });

  test("an unknown machine records nothing and says so", async () => {
    expect(await cp.noteBootPath("never-seen", "local-fallback", "")).toBe(false);
  });
});
