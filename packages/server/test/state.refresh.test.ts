/**
 * POL-157 / D149 — the per-source refresh cadence, server side.
 *
 * The policy is authored on a web/dashboard SOURCE and must ride onto every surface that renders it,
 * unchanged, all the way through the send-time decoration the player receives — that is what lets the
 * player fire the reload locally. An OFF (or absent) policy must carry NOTHING: a wall with no cadence
 * behaves exactly as it did before the feature. And the policy must survive a persist/reload round
 * trip, because an operator's cadence is desired state, not a runtime whim.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output, RefreshPolicy, Surface } from "@polyptic/protocol";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string, ...connectors: string[]): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: connectors.map((connector) => ({ connector, width: 1920, height: 1080 }) satisfies Output),
    hostname: "test-box",
  };
}

function frameOn(cp: ControlPlane, screenId: string): Extract<Surface, { type: "web" | "dashboard" }> {
  const slice = cp.decorateSliceForSend(cp.sliceForPlayer(screenId));
  const surface = slice.surfaces[0];
  if (!surface || (surface.type !== "web" && surface.type !== "dashboard")) {
    throw new Error(`expected a framed surface on ${screenId}, got ${surface?.type}`);
  }
  return surface;
}

const URL = "https://dash.test/panel";
const EVERY_10M: RefreshPolicy = { mode: "interval", everySeconds: 600 };
const DAILY_4AM: RefreshPolicy = {
  mode: "scheduled",
  atLocal: "04:00",
  days: [1, 2, 3, 4, 5],
  timezone: "Europe/London",
};

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("a source's refresh cadence rides onto its surface", () => {
  test("interval policy reaches the player-bound slice verbatim", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const [screen] = cp.getScreens();
    const created = await cp.createContentSource({ name: "Panel", kind: "web", url: URL, refresh: EVERY_10M });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await cp.setScreenContent(screen!.id, { sourceId: created.source.id });
    expect(result.ok).toBe(true);

    expect(frameOn(cp, screen!.id).refresh).toEqual(EVERY_10M);
  });

  test("dashboard scheduled policy rides through too", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const [screen] = cp.getScreens();
    const created = await cp.createContentSource({ name: "Board", kind: "dashboard", url: URL, refresh: DAILY_4AM });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await cp.setScreenContent(screen!.id, { sourceId: created.source.id });

    expect(frameOn(cp, screen!.id).refresh).toEqual(DAILY_4AM);
  });
});

describe("off / absent carries nothing — parity with pre-feature walls", () => {
  test("a source with no cadence produces a surface with no refresh", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const [screen] = cp.getScreens();
    const created = await cp.createContentSource({ name: "Plain", kind: "web", url: URL });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen!.id, { sourceId: created.source.id });

    expect(frameOn(cp, screen!.id).refresh).toBeUndefined();
  });

  test("an explicit off is dropped, not carried as an off surface", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const [screen] = cp.getScreens();
    const created = await cp.createContentSource({ name: "Off", kind: "web", url: URL, refresh: { mode: "off" } });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen!.id, { sourceId: created.source.id });

    expect(frameOn(cp, screen!.id).refresh).toBeUndefined();
  });
});

describe("editing the cadence propagates live", () => {
  test("adding then turning off a cadence re-resolves the assigned screen", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const [screen] = cp.getScreens();
    const created = await cp.createContentSource({ name: "Panel", kind: "web", url: URL });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen!.id, { sourceId: created.source.id });
    expect(frameOn(cp, screen!.id).refresh).toBeUndefined();

    const on = await cp.updateContentSource(created.source.id, { refresh: EVERY_10M });
    expect(on.ok).toBe(true);
    expect(on.ok && on.slices.some((s) => s.screenId === screen!.id)).toBe(true);
    expect(frameOn(cp, screen!.id).refresh).toEqual(EVERY_10M);

    const off = await cp.updateContentSource(created.source.id, { refresh: { mode: "off" } });
    expect(off.ok).toBe(true);
    expect(frameOn(cp, screen!.id).refresh).toBeUndefined();
  });
});

describe("the cadence is desired state — it survives a reload", () => {
  test("a persisted source restores its policy on a fresh control plane", async () => {
    const created = await cp.createContentSource({ name: "Panel", kind: "web", url: URL, refresh: EVERY_10M });
    if (!created.ok) throw new Error("seed failed");

    const cp2 = new ControlPlane(store);
    await cp2.init();
    const restored = cp2.getContentSource(created.source.id);
    expect(restored?.refresh).toEqual(EVERY_10M);
  });
});
