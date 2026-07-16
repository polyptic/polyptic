/**
 * POL-18 — web-window resolution in the control plane: a framing-blocked (or operator-forced)
 * web/dashboard source resolves to `placement: "window"`, capability-gated per machine (only
 * wayland-sway places windows; everything else degrades to the iframe), never on a video wall,
 * and the agent's apply payload carries the placements (region + canvas, credential-stampable).
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { DisplayBackend, Output, Surface } from "@polyptic/protocol";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(
  machineId: string,
  backend: DisplayBackend,
  ...connectors: string[]
): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend,
    outputs: connectors.map(
      (connector) => ({ connector, width: 1920, height: 1080 }) satisfies Output,
    ),
    hostname: "test-box",
  };
}

function placementOf(cp: ControlPlane, screenId: string): string | undefined {
  const surface: Surface | undefined = cp.state.slices[screenId]?.surfaces[0];
  if (!surface) return undefined;
  return surface.type === "web" || surface.type === "dashboard" ? surface.placement : undefined;
}

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

/** One sway screen, ready for content. */
async function swayScreen(): Promise<string> {
  await cp.registerMachine(hello("sway-box", "wayland-sway", "HDMI-1"));
  return cp.getScreens()[0]!.id;
}

describe("placement resolution (POL-18)", () => {
  test("an unprobed web source frames as before (unknown ≠ blocked)", async () => {
    const screenId = await swayScreen();
    const created = await cp.createContentSource({ name: "Web", kind: "web", url: "https://a.example/" });
    if (!created.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: created.source.id });
    expect(placementOf(cp, screenId)).toBe("iframe");
  });

  test("a blocked verdict flips an auto source to a window — and re-resolves live targets", async () => {
    const screenId = await swayScreen();
    const created = await cp.createContentSource({ name: "Dash", kind: "dashboard", url: "https://d.example/" });
    if (!created.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: created.source.id });
    expect(placementOf(cp, screenId)).toBe("iframe");

    const result = await cp.setSourceFraming(created.source.id, "blocked");
    expect(result.changed).toBe(true);
    // The automatic fallback returned the touched slice for the caller to push.
    expect(result.slices.map((s) => s.screenId)).toEqual([screenId]);
    expect(placementOf(cp, screenId)).toBe("window");
    // The surface id is unchanged — the player patches the same keyed node (D5).
    expect(cp.state.slices[screenId]!.surfaces[0]!.id).toBe("content-web");
  });

  test("the verdict persists on the source and survives a restart", async () => {
    const screenId = await swayScreen();
    const created = await cp.createContentSource({ name: "Dash", kind: "dashboard", url: "https://d.example/" });
    if (!created.ok) throw new Error("create failed");
    await cp.setSourceFraming(created.source.id, "blocked");
    await cp.setScreenContent(screenId, { sourceId: created.source.id });
    expect(placementOf(cp, screenId)).toBe("window");

    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect(cp2.getContentSource(created.source.id)?.framing).toBe("blocked");
    expect(placementOf(cp2, screenId)).toBe("window");
  });

  test("operator override wins in both directions", async () => {
    const screenId = await swayScreen();
    const forcedWin = await cp.createContentSource({
      name: "Forced window",
      kind: "web",
      url: "https://frames-fine.example/",
      placementMode: "window",
    });
    if (!forcedWin.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: forcedWin.source.id });
    expect(placementOf(cp, screenId)).toBe("window");

    // Force-framed pins the iframe even when the probe says blocked (and the verdict change
    // reports nothing to push, because it cannot change the render).
    const forcedFrame = await cp.createContentSource({
      name: "Forced frame",
      kind: "web",
      url: "https://blocks.example/",
      placementMode: "iframe",
    });
    if (!forcedFrame.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: forcedFrame.source.id });
    const verdict = await cp.setSourceFraming(forcedFrame.source.id, "blocked");
    expect(verdict.changed).toBe(true);
    expect(verdict.slices).toEqual([]);
    expect(placementOf(cp, screenId)).toBe("iframe");
  });

  test("an unchanged verdict is a no-op", async () => {
    const created = await cp.createContentSource({ name: "W", kind: "web", url: "https://a.example/" });
    if (!created.ok) throw new Error("create failed");
    await cp.setSourceFraming(created.source.id, "blocked");
    const again = await cp.setSourceFraming(created.source.id, "blocked");
    expect(again.changed).toBe(false);
  });

  test("editing the URL drops the stored verdict (it described the old address)", async () => {
    const created = await cp.createContentSource({ name: "W", kind: "web", url: "https://a.example/" });
    if (!created.ok) throw new Error("create failed");
    await cp.setSourceFraming(created.source.id, "blocked");
    const updated = await cp.updateContentSource(created.source.id, { url: "https://b.example/" });
    if (!updated.ok) throw new Error("update failed");
    expect(updated.source.framing).toBeUndefined();
    // A rename alone keeps it.
    await cp.setSourceFraming(created.source.id, "blocked");
    const renamed = await cp.updateContentSource(created.source.id, { name: "W2" });
    if (!renamed.ok) throw new Error("rename failed");
    expect(renamed.source.framing).toBe("blocked");
  });
});

describe("capability gating (POL-18)", () => {
  test("a dev-open machine degrades a window-wanting source to the iframe", async () => {
    await cp.registerMachine(hello("dev-box", "dev-open", "HDMI-1"));
    const screenId = cp.getScreens()[0]!.id;
    const created = await cp.createContentSource({
      name: "Forced window",
      kind: "web",
      url: "https://blocks.example/",
      placementMode: "window",
    });
    if (!created.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: created.source.id });
    expect(placementOf(cp, screenId)).toBe("iframe");
    expect(cp.windowsForScreen(screenId)).toEqual([]);
  });

  test("a mixed fleet resolves per machine: sway windows, x11 frames", async () => {
    await cp.registerMachine(hello("sway-box", "wayland-sway", "HDMI-1"));
    await cp.registerMachine(hello("x11-box", "x11-i3", "HDMI-1"));
    const [swayScreenId, x11ScreenId] = cp.getScreens().map((s) => s.id);
    const created = await cp.createContentSource({
      name: "Blocked",
      kind: "web",
      url: "https://blocks.example/",
      placementMode: "window",
    });
    if (!created.ok) throw new Error("create failed");
    await cp.setScreenContent(swayScreenId!, { sourceId: created.source.id });
    await cp.setScreenContent(x11ScreenId!, { sourceId: created.source.id });
    expect(placementOf(cp, swayScreenId!)).toBe("window");
    expect(placementOf(cp, x11ScreenId!)).toBe("iframe");
  });

  test("a video wall never windows — members frame with the usual span math", async () => {
    await cp.registerMachine(hello("sway-box", "wayland-sway", "HDMI-1", "HDMI-2"));
    const [a, b] = cp.getScreens().map((s) => s.id);
    const mural = await cp.createMural("Atrium");
    await cp.placeScreen(a!, mural.id, 0, 0, 1920, 1080);
    await cp.placeScreen(b!, mural.id, 1920, 0, 1920, 1080);
    const combined = await cp.combineScreens(mural.id, [a!, b!]);
    if (!combined.ok) throw new Error("combine failed");

    const created = await cp.createContentSource({
      name: "Blocked",
      kind: "web",
      url: "https://blocks.example/",
      placementMode: "window",
    });
    if (!created.ok) throw new Error("create failed");
    const result = await cp.setWallContent(combined.wall.id, { sourceId: created.source.id });
    expect(result.ok).toBe(true);
    expect(placementOf(cp, a!)).toBe("iframe");
    expect(placementOf(cp, b!)).toBe("iframe");
    expect(cp.state.slices[a!]!.surfaces[0]!.span).toBeDefined();
    expect(cp.state.slices[b!]!.surfaces[0]!.span).toBeDefined();
    // POL-146 — the CRITICAL guarantee for the multi-box wall: the agent is asked to place NO
    // top-level window on either member. A single box cannot span a window across two physical
    // panels, so a leaked window here is exactly the field bug (a small unspanned window with black
    // filling the rest of the wall). Both members must degrade to the spanning iframe instead.
    expect(cp.windowsForScreen(a!)).toEqual([]);
    expect(cp.windowsForScreen(b!)).toEqual([]);
    // And the per-machine apply the agent actually receives carries no `windows` for either output.
    const apply = cp.assignmentsForMachine("sway-box");
    expect(apply.every((asg) => (asg.windows?.length ?? 0) === 0)).toBe(true);
  });

  // POL-146 — a wall whose members sit on DIFFERENT boxes is the reported repro (two Dell panels).
  // The degrade must hold there too: neither box may be handed a window to place.
  test("a wall spanning two SEPARATE machines still places no window on either box", async () => {
    await cp.registerMachine(hello("box-1", "wayland-sway", "HDMI-1"));
    await cp.registerMachine(hello("box-2", "wayland-sway", "HDMI-1"));
    const [a, b] = cp.getScreens().map((s) => s.id);
    const mural = await cp.createMural("Concourse");
    await cp.placeScreen(a!, mural.id, 0, 0, 1920, 1080);
    await cp.placeScreen(b!, mural.id, 1920, 0, 1920, 1080);
    const combined = await cp.combineScreens(mural.id, [a!, b!]);
    if (!combined.ok) throw new Error("combine failed");

    const created = await cp.createContentSource({
      name: "Blocked",
      kind: "web",
      url: "https://blocks.example/",
      placementMode: "window",
    });
    if (!created.ok) throw new Error("create failed");
    const result = await cp.setWallContent(combined.wall.id, { sourceId: created.source.id });
    expect(result.ok).toBe(true);
    expect(cp.windowsForScreen(a!)).toEqual([]);
    expect(cp.windowsForScreen(b!)).toEqual([]);
    expect(cp.assignmentsForMachine("box-1").every((x) => (x.windows?.length ?? 0) === 0)).toBe(true);
    expect(cp.assignmentsForMachine("box-2").every((x) => (x.windows?.length ?? 0) === 0)).toBe(true);
  });
});

describe("the agent's window payload (POL-18)", () => {
  test("windowsForScreen carries the surface's region + the slice canvas", async () => {
    const screenId = await swayScreen();
    const created = await cp.createContentSource({
      name: "Windowed",
      kind: "web",
      url: "https://blocks.example/",
      placementMode: "window",
    });
    if (!created.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: created.source.id });

    const windows = cp.windowsForScreen(screenId);
    expect(windows).toHaveLength(1);
    expect(windows[0]).toMatchObject({
      id: "content-web",
      url: "https://blocks.example/",
      region: { x: 0, y: 0, w: 1920, h: 1080 },
      canvas: { x: 0, y: 0, w: 1920, h: 1080 },
    });
  });

  test("assignmentsForMachine rides the windows on the right connector — and drops them when cleared", async () => {
    await cp.registerMachine(hello("sway-box", "wayland-sway", "HDMI-1", "HDMI-2"));
    const [a] = cp.getScreens().map((s) => s.id);
    const created = await cp.createContentSource({
      name: "Windowed",
      kind: "web",
      url: "https://blocks.example/",
      placementMode: "window",
    });
    if (!created.ok) throw new Error("create failed");
    await cp.setScreenContent(a!, { sourceId: created.source.id });

    const assignments = cp.assignmentsForMachine("sway-box");
    expect(assignments).toHaveLength(2);
    const onA = assignments.find((x) => x.connector === "HDMI-1")!;
    const onB = assignments.find((x) => x.connector === "HDMI-2")!;
    expect(onA.windows).toHaveLength(1);
    expect(onB.windows).toBeUndefined();

    // Clearing the screen (empty surface set) retires the window from the payload.
    await cp.setScreenSurfaces(a!, []);
    const after = cp.assignmentsForMachine("sway-box");
    expect(after.find((x) => x.connector === "HDMI-1")!.windows).toBeUndefined();
  });
});
