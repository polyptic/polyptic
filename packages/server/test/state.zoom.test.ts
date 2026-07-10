/**
 * POL-57 — page zoom is remembered per (screen-or-wall, page) pair.
 *
 * These drive `ControlPlane` directly against the `MemoryStore` (no server/WS). They pin the claim the
 * console's caption makes to the operator: a zoom dialled in for one page on one screen comes back
 * when that page returns to that screen — and *only* there. The other half of the contract is what
 * cannot be zoomed (media, a wall member) and what happens across a restart.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output, Surface } from "@polyptic/protocol";
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

/** The zoom on a screen's first surface — undefined when it frames nothing zoomable. */
function zoomOf(cp: ControlPlane, screenId: string): number | undefined {
  const surface: Surface | undefined = cp.state.slices[screenId]?.surfaces[0];
  if (!surface) return undefined;
  return surface.type === "web" || surface.type === "dashboard" ? surface.zoom : undefined;
}

let store: MemoryStore;
let cp: ControlPlane;

/** Two screens on one machine, and a two-panel mural to combine them on. */
async function twoScreens(): Promise<{ a: string; b: string; muralId: string }> {
  await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
  const [a, b] = cp.getScreens();
  const mural = await cp.createMural("Atrium");
  await cp.placeScreen(a!.id, mural.id, 0, 0, 1920, 1080);
  await cp.placeScreen(b!.id, mural.id, 1920, 0, 1920, 1080);
  return { a: a!.id, b: b!.id, muralId: mural.id };
}

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("screen zoom (POL-57)", () => {
  test("content lands unzoomed at 100%", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    expect(zoomOf(cp, a)).toBe(1);
  });

  test("setScreenZoom restyles the SAME surface id — the player patches, it does not remount", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    const before = cp.state.slices[a]!.surfaces[0]!;

    const result = await cp.setScreenZoom(a, 1.5);
    expect(result.ok).toBe(true);

    const after = cp.state.slices[a]!.surfaces[0]!;
    expect(after.id).toBe(before.id);
    expect(after.type).toBe("web");
    expect(zoomOf(cp, a)).toBe(1.5);
    // A zoom is a render change, so the revision must move (players reconcile to it).
    expect(cp.state.revision).toBeGreaterThan(0);
  });

  test("a zoom is remembered for the (screen, page) pair and restored on re-assignment", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.setScreenZoom(a, 1.25);

    // Show something else, then come back to the original page.
    await cp.setScreenContent(a, { url: "https://example.test/other" });
    expect(zoomOf(cp, a)).toBe(1); // a page never zoomed here starts at 100%

    await cp.setScreenContent(a, { url: "https://example.test/one" });
    expect(zoomOf(cp, a)).toBe(1.25);
  });

  test("the SAME page on another screen keeps its own zoom", async () => {
    const { a, b } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.setScreenContent(b, { url: "https://example.test/one" });

    await cp.setScreenZoom(a, 2);
    expect(zoomOf(cp, a)).toBe(2);
    expect(zoomOf(cp, b)).toBe(1);
  });

  test("a library source is remembered by ID, so re-pointing its URL keeps the screen's zoom", async () => {
    const { a } = await twoScreens();
    const created = await cp.createContentSource({
      name: "Ops",
      kind: "dashboard",
      url: "https://grafana.test/d/one",
    });
    expect(created.ok).toBe(true);
    const sourceId = created.ok ? created.source.id : "";

    await cp.setScreenContent(a, { sourceId });
    await cp.setScreenZoom(a, 1.75);

    // Operator re-points the source at a different URL — the screen's dialled-in zoom must survive.
    const updated = await cp.updateContentSource(sourceId, { url: "https://grafana.test/d/two" });
    expect(updated.ok).toBe(true);
    expect(zoomOf(cp, a)).toBe(1.75);
  });

  test("resetting to 100% is remembered as a choice, not as the absence of one", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.setScreenZoom(a, 2);
    await cp.setScreenZoom(a, 1);

    await cp.setScreenContent(a, { url: "https://example.test/other" });
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    expect(zoomOf(cp, a)).toBe(1);
  });

  test("a remembered zoom survives a server restart", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.setScreenZoom(a, 1.5);

    // Same store, fresh control plane — the boot path must reload both the slice and the preference.
    const rebooted = new ControlPlane(store);
    await rebooted.init();
    expect(zoomOf(rebooted, a)).toBe(1.5);

    // And the preference (not just the persisted surface) is what drives a re-assignment.
    await rebooted.setScreenContent(a, { url: "https://example.test/other" });
    await rebooted.setScreenContent(a, { url: "https://example.test/one" });
    expect(zoomOf(rebooted, a)).toBe(1.5);
  });

  test("media has no page to zoom", async () => {
    const { a } = await twoScreens();
    const created = await cp.createContentSource({
      name: "Logo",
      kind: "image",
      url: "https://cdn.test/logo.png",
    });
    const sourceId = created.ok ? created.source.id : "";
    await cp.setScreenContent(a, { sourceId });

    const result = await cp.setScreenZoom(a, 1.5);
    expect(result).toEqual({ ok: false, error: "not-zoomable" });
  });

  test("an empty screen and an unknown screen are both rejected", async () => {
    const { a } = await twoScreens();
    expect(await cp.setScreenZoom(a, 1.5)).toEqual({ ok: false, error: "no-content" });
    expect(await cp.setScreenZoom("screen-404", 1.5)).toEqual({ ok: false, error: "unknown-screen" });
  });

  test("a screen's remembered zooms are forgotten when the screen is removed", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.setScreenZoom(a, 2);
    expect((await store.listZoomPreferences()).length).toBe(1);

    await cp.removeScreen(a);
    expect(await store.listZoomPreferences()).toEqual([]);
  });
});

describe("combined-surface zoom (POL-57)", () => {
  test("a wall member is rejected — zoom belongs to the combined surface", async () => {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    expect(combined.ok).toBe(true);
    await cp.setWallContent(combined.ok ? combined.wall.id : "", { url: "https://example.test/one" });

    const result = await cp.setScreenZoom(a, 1.5);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("wall-member");
  });

  test("setWallZoom applies the same zoom to every member, leaving the span math untouched", async () => {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    const wallId = combined.ok ? combined.wall.id : "";
    await cp.setWallContent(wallId, { url: "https://example.test/one" });

    const spanBefore = cp.state.slices[b]!.surfaces[0]!.span;
    const result = await cp.setWallZoom(wallId, 1.5);
    expect(result.ok).toBe(true);
    expect(result.ok && result.slices.length).toBe(2);

    expect(zoomOf(cp, a)).toBe(1.5);
    expect(zoomOf(cp, b)).toBe(1.5);
    // The span describes the wall's geometry, not the page's scale — zoom must not disturb it.
    expect(cp.state.slices[b]!.surfaces[0]!.span).toEqual(spanBefore);
  });

  test("a wall's zoom is remembered per page and restored on re-assignment", async () => {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    const wallId = combined.ok ? combined.wall.id : "";

    await cp.setWallContent(wallId, { url: "https://example.test/one" });
    await cp.setWallZoom(wallId, 2);

    await cp.setWallContent(wallId, { url: "https://example.test/other" });
    expect(zoomOf(cp, a)).toBe(1);

    await cp.setWallContent(wallId, { url: "https://example.test/one" });
    expect(zoomOf(cp, a)).toBe(2);
    expect(zoomOf(cp, b)).toBe(2);
  });

  test("splitting a wall forgets its remembered zooms", async () => {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    const wallId = combined.ok ? combined.wall.id : "";
    await cp.setWallContent(wallId, { url: "https://example.test/one" });
    await cp.setWallZoom(wallId, 2);
    expect((await store.listZoomPreferences()).length).toBe(1);

    await cp.splitWall(wallId);
    expect(await store.listZoomPreferences()).toEqual([]);
  });

  test("an unknown wall, and a wall showing nothing, are both rejected", async () => {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    const wallId = combined.ok ? combined.wall.id : "";

    expect(await cp.setWallZoom("wall-404", 1.5)).toEqual({ ok: false, error: "unknown-wall" });
    // Combining clears the members' slices, so a fresh wall frames nothing yet.
    expect(await cp.setWallZoom(wallId, 1.5)).toEqual({ ok: false, error: "no-content" });
  });
});
