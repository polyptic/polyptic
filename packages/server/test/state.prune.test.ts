/**
 * POL-9 — the control plane reconciles away stale phantom screens on re-advertise.
 *
 * These drive `ControlPlane` directly against the `MemoryStore` (no server/WS). They pin the
 * server-side half of the fix: when a machine re-advertises a NON-EMPTY output set, screens for
 * connectors it no longer advertises are pruned — but ONLY if they're unused. A placed/used screen,
 * or an empty (compositor-not-up) advertise, must never wipe a screen.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output } from "@polyptic/protocol";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function outputs(...connectors: string[]): Output[] {
  return connectors.map((connector) => ({ connector, width: 1920, height: 1080 }));
}

function hello(machineId: string, ...connectors: string[]): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: outputs(...connectors),
    hostname: "test-box",
  };
}

const connectorsOf = (cp: ControlPlane): string[] =>
  cp
    .getScreens()
    .map((s) => s.connector)
    .sort();

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("ControlPlane phantom-screen pruning (POL-9)", () => {
  test("a fresh box advertising ZERO outputs gets no screen", async () => {
    await cp.registerMachine(hello("m1"));
    expect(cp.getScreens()).toEqual([]);
  });

  test("both real panels appear on a 2-output box", async () => {
    await cp.registerMachine(hello("m1", "Virtual-1", "HDMI-A-1"));
    expect(connectorsOf(cp)).toEqual(["HDMI-A-1", "Virtual-1"]);
  });

  test("a stale phantom is pruned when the machine re-advertises its real connector", async () => {
    // Pretend the OLD agent enrolled the box with a guessed HDMI-1 before the compositor existed.
    await cp.registerMachine(hello("m1", "HDMI-1"));
    expect(connectorsOf(cp)).toEqual(["HDMI-1"]);
    const phantomId = cp.getScreens()[0]!.id;

    // Compositor comes up; the agent now advertises the REAL connector.
    await cp.registerMachine(hello("m1", "Virtual-1"));
    expect(connectorsOf(cp)).toEqual(["Virtual-1"]);

    // The prune is written through, not just in memory: the phantom's screen AND content rows are gone.
    const persisted = await store.load();
    expect(persisted.screens.map((s) => s.connector)).toEqual(["Virtual-1"]);
    expect(persisted.screens.some((s) => s.id === phantomId)).toBe(false);
    expect(persisted.content.some((c) => c.screenId === phantomId)).toBe(false);
  });

  test("an empty (compositor-not-up) re-advertise never wipes existing screens", async () => {
    await cp.registerMachine(hello("m1", "Virtual-1"));
    expect(connectorsOf(cp)).toEqual(["Virtual-1"]);

    // The agent restarts before the compositor is ready and advertises nothing.
    await cp.registerMachine(hello("m1"));
    expect(connectorsOf(cp)).toEqual(["Virtual-1"]); // untouched — no info ≠ "it's gone"
  });

  test("a screen with content is NOT pruned even if its connector disappears", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens().find((s) => s.connector === "HDMI-1");
    expect(screen).toBeDefined();
    // Give it content → now it's "used".
    await cp.setDemoWeb(screen!.id, "https://example.com/");

    await cp.registerMachine(hello("m1", "Virtual-1"));
    expect(connectorsOf(cp)).toEqual(["HDMI-1", "Virtual-1"]); // used screen kept, real one added
  });

  test("a placed screen is NOT pruned even if its connector disappears", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens().find((s) => s.connector === "HDMI-1");
    const mural = await cp.createMural("Reception");
    await cp.placeScreen(screen!.id, mural.id, 0, 0);

    await cp.registerMachine(hello("m1", "Virtual-1"));
    expect(connectorsOf(cp)).toEqual(["HDMI-1", "Virtual-1"]); // placement protects it
  });

  test("only the re-advertising machine's phantoms are pruned; other machines are untouched", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    await cp.registerMachine(hello("m2", "HDMI-1")); // a different box, same guessed name

    await cp.registerMachine(hello("m1", "Virtual-1"));

    const byMachine = cp
      .getScreens()
      .map((s) => `${s.machineId}/${s.connector}`)
      .sort();
    expect(byMachine).toEqual(["m1/Virtual-1", "m2/HDMI-1"]);
  });

  test("the revision bumps when a phantom is pruned (players/console re-render)", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const before = cp.state.revision;
    await cp.registerMachine(hello("m1", "Virtual-1"));
    expect(cp.state.revision).toBeGreaterThan(before);
  });
});
