/**
 * POL-96 + POL-100 — bulk canvas operations, the explicit clear, and the wall-adjacency invariant.
 *
 * Driven straight against `ControlPlane` + `MemoryStore` (no HTTP, no WS). What they pin:
 *   - CLEAR is a real mutation, not "assign something else": the slice empties, the library-source
 *     assignment is dropped, and the screen falls back to the idle splash (D39).
 *   - BULK is the same primitives under one emit: N targets, one call, every slice returned for the
 *     fan-out — and a target that can't take the change is skipped and NAMED, never silently dropped.
 *   - A wall is ONE CONTIGUOUS REGION, always. Combine refuses a gappy selection (or packs it), a
 *     wall drags rigidly (adjacency preserved by construction, re-checked anyway), and no move —
 *     wall drag, nudge, or a single member's placement — can leave a wall with a hole in it.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output } from "@polyptic/protocol";
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

const surfacesOn = (cp: ControlPlane, screenId: string): number =>
  cp.state.slices[screenId]?.surfaces.length ?? 0;

let store: MemoryStore;
let cp: ControlPlane;

/** Four screens; A+B placed adjacent (a 2×1), C off to one side with a GAP, D unplaced. */
async function canvas(): Promise<{ a: string; b: string; c: string; muralId: string }> {
  await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2", "HDMI-3"));
  const [a, b, c] = cp.getScreens();
  const mural = await cp.createMural("Atrium");
  await cp.placeScreen(a!.id, mural.id, 0, 0, 1920, 1080);
  await cp.placeScreen(b!.id, mural.id, 1920, 0, 1920, 1080);
  await cp.placeScreen(c!.id, mural.id, 6000, 0, 1920, 1080); // a long way off — not adjacent
  return { a: a!.id, b: b!.id, c: c!.id, muralId: mural.id };
}

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("clearing content (POL-96)", () => {
  test("clearScreenContent empties the slice — the screen shows nothing at all", async () => {
    const { a } = await canvas();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    expect(surfacesOn(cp, a)).toBe(1);

    const result = await cp.clearScreenContent(a);
    expect(result.ok).toBe(true);
    expect(surfacesOn(cp, a)).toBe(0);
    if (result.ok) expect(result.slices.map((s) => s.screenId)).toEqual([a]);
  });

  test("a clear survives a restart (it is persisted, not just forgotten in memory)", async () => {
    const { a } = await canvas();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.clearScreenContent(a);

    const revived = new ControlPlane(store);
    await revived.init();
    expect(surfacesOn(revived, a)).toBe(0);
  });

  test("clearing bumps the revision — the players are told", async () => {
    const { a } = await canvas();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    const before = cp.state.revision;
    await cp.clearScreenContent(a);
    expect(cp.state.revision).toBeGreaterThan(before);
  });

  test("a wall member refuses to be cleared on its own — the WALL is what gets cleared", async () => {
    const { a, b, muralId } = await canvas();
    const combined = await cp.combineScreens(muralId, [a, b]);
    expect(combined.ok).toBe(true);

    const result = await cp.clearScreenContent(a);
    expect(result).toMatchObject({ ok: false, error: "wall-member" });
  });

  test("clearWallContent blanks every member and keeps the wall itself", async () => {
    const { a, b, muralId } = await canvas();
    const combined = await cp.combineScreens(muralId, [a, b]);
    if (!combined.ok) throw new Error("combine failed");
    await cp.setWallContent(combined.wall.id, { url: "https://example.test/spanning" });
    expect(surfacesOn(cp, a)).toBe(1);
    expect(surfacesOn(cp, b)).toBe(1);

    const result = await cp.clearWallContent(combined.wall.id);
    expect(result.ok).toBe(true);
    expect(surfacesOn(cp, a)).toBe(0);
    expect(surfacesOn(cp, b)).toBe(0);
    expect(cp.getVideoWall(combined.wall.id)).toBeDefined(); // the grouping outlives its content
  });

  test("an unknown target is a clean refusal", async () => {
    expect(await cp.clearScreenContent("screen-404")).toMatchObject({ error: "unknown-screen" });
    expect(await cp.clearWallContent("wall-404")).toMatchObject({ error: "unknown-wall" });
  });
});

describe("bulk content (POL-96)", () => {
  test("one source lands on every selected screen in ONE call", async () => {
    const { a, b, c } = await canvas();
    const result = await cp.applyBulkContent(
      { screenIds: [a, b, c], wallIds: [] },
      { url: "https://example.test/all" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toMatchObject({ screens: 3, walls: 0 });
    expect(result.slices.map((s) => s.screenId).sort()).toEqual([a, b, c].sort());
    for (const id of [a, b, c]) expect(surfacesOn(cp, id)).toBe(1);
  });

  test("content:null clears the whole selection", async () => {
    const { a, b, c } = await canvas();
    await cp.applyBulkContent({ screenIds: [a, b, c], wallIds: [] }, { url: "https://example.test/all" });

    const result = await cp.applyBulkContent({ screenIds: [a, b, c], wallIds: [] }, null);
    expect(result.ok).toBe(true);
    for (const id of [a, b, c]) expect(surfacesOn(cp, id)).toBe(0);
  });

  test("screens and walls can be named together — the wall's members span, the screens don't", async () => {
    const { a, b, c, muralId } = await canvas();
    const combined = await cp.combineScreens(muralId, [a, b]);
    if (!combined.ok) throw new Error("combine failed");

    const result = await cp.applyBulkContent(
      { screenIds: [c], wallIds: [combined.wall.id] },
      { url: "https://example.test/both" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied).toMatchObject({ screens: 1, walls: 1 });

    const spanning = cp.state.slices[a]?.surfaces[0];
    const solo = cp.state.slices[c]?.surfaces[0];
    expect(spanning && "span" in spanning ? spanning.span : undefined).toBeDefined();
    expect(solo && "span" in solo ? solo.span : undefined).toBeUndefined();
  });

  test("a target that cannot take the change is skipped and NAMED — the rest still lands", async () => {
    const { a, b, c, muralId } = await canvas();
    await cp.combineScreens(muralId, [a, b]); // a is now a wall member

    const result = await cp.applyBulkContent(
      { screenIds: [a, c, "screen-404"], wallIds: [] },
      { url: "https://example.test/partial" },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.applied.screens).toBe(1); // only c
    expect(result.skipped.map((s) => s.id).sort()).toEqual([a, "screen-404"].sort());
    expect(surfacesOn(cp, c)).toBe(1);
  });

  test("an unknown library source changes NOTHING at all (fail fast, not half-applied)", async () => {
    const { a, b } = await canvas();
    const result = await cp.applyBulkContent(
      { screenIds: [a, b], wallIds: [] },
      { sourceId: "source-404" },
    );
    expect(result).toMatchObject({ ok: false, error: "unknown-source" });
    expect(surfacesOn(cp, a)).toBe(0);
    expect(surfacesOn(cp, b)).toBe(0);
  });

  test("bulk unplace returns the lot to the tray, dissolving any wall it touches", async () => {
    const { a, b, c, muralId } = await canvas();
    const combined = await cp.combineScreens(muralId, [a, b]);
    if (!combined.ok) throw new Error("combine failed");

    const result = await cp.unplaceScreens([a, c]);
    expect(result.unplaced.sort()).toEqual([a, c].sort());
    expect(cp.getPlacement(a)).toBeUndefined();
    expect(cp.getPlacement(c)).toBeUndefined();
    expect(cp.getVideoWall(combined.wall.id)).toBeUndefined(); // a wall can't outlive a member
    expect(cp.getPlacement(b)).toBeDefined(); // the surviving member stays put, just uncombined
  });
});

describe("the adjacency rule on combine (POL-100)", () => {
  test("adjacent screens combine", async () => {
    const { a, b, muralId } = await canvas();
    expect((await cp.combineScreens(muralId, [a, b])).ok).toBe(true);
  });

  test("a gappy selection is REFUSED — a wall with a hole in it is not a wall", async () => {
    const { a, c, muralId } = await canvas();
    const result = await cp.combineScreens(muralId, [a, c]);
    expect(result).toMatchObject({ ok: false, error: "not-adjacent" });
    expect(cp.getVideoWalls()).toHaveLength(0);
  });

  test("pack:true closes the gap first, then combines — and the placements really moved", async () => {
    const { a, c, muralId } = await canvas();
    const result = await cp.combineScreens(muralId, [a, c], undefined, true);
    expect(result.ok).toBe(true);

    const packed = cp.getPlacement(c);
    expect(packed).toMatchObject({ x: 1920, y: 0 }); // butted up against a's right edge
    expect(cp.getVideoWalls()).toHaveLength(1);
  });

  test("packing that still leaves a corner-only join is refused (nothing is created)", async () => {
    const { a, c, muralId } = await canvas();
    await cp.placeScreen(c, muralId, 6000, 4000, 1920, 1080); // diagonally away
    const result = await cp.combineScreens(muralId, [a, c], undefined, true);
    expect(result).toMatchObject({ ok: false, error: "not-adjacent" });
    expect(cp.getVideoWalls()).toHaveLength(0);
  });
});

describe("the atomic canvas move (POL-100)", () => {
  test("a wall moves as ONE unit — every member shifts by the same delta", async () => {
    const { a, b, muralId } = await canvas();
    const combined = await cp.combineScreens(muralId, [a, b]);
    if (!combined.ok) throw new Error("combine failed");

    const result = await cp.moveTargets(muralId, { screenIds: [], wallIds: [combined.wall.id] }, 500, -240);
    expect(result.ok).toBe(true);
    expect(cp.getPlacement(a)).toMatchObject({ x: 500, y: -240 });
    expect(cp.getPlacement(b)).toMatchObject({ x: 2420, y: -240 });
    expect(cp.getVideoWall(combined.wall.id)).toBeDefined(); // still a wall, still adjacent
  });

  test("moving a wall pushes NO render — the span offsets are union-relative, so the slices stand", async () => {
    const { a, b, muralId } = await canvas();
    const combined = await cp.combineScreens(muralId, [a, b]);
    if (!combined.ok) throw new Error("combine failed");
    await cp.setWallContent(combined.wall.id, { url: "https://example.test/spanning" });

    const before = structuredClone(cp.state.slices[a]);
    const revision = cp.state.revision;
    await cp.moveTargets(muralId, { screenIds: [], wallIds: [combined.wall.id] }, 300, 300);
    expect(cp.state.slices[a]).toEqual(before!);
    expect(cp.state.revision).toBe(revision); // nothing to re-render
  });

  test("a multi-screen nudge is one mutation across the selection", async () => {
    const { a, b, c, muralId } = await canvas();
    const result = await cp.moveTargets(muralId, { screenIds: [a, b, c], wallIds: [] }, -20, 20);
    expect(result.ok).toBe(true);
    expect(cp.getPlacement(a)).toMatchObject({ x: -20, y: 20 });
    expect(cp.getPlacement(b)).toMatchObject({ x: 1900, y: 20 });
    expect(cp.getPlacement(c)).toMatchObject({ x: 5980, y: 20 });
  });

  test("a move that would tear a wall apart is REFUSED, and nothing is written", async () => {
    const { a, b, muralId } = await canvas();
    const combined = await cp.combineScreens(muralId, [a, b]);
    if (!combined.ok) throw new Error("combine failed");

    // Move ONE member of the wall far away: the wall would stop being contiguous.
    const result = await cp.moveTargets(muralId, { screenIds: [a], wallIds: [] }, 9000, 0);
    expect(result).toMatchObject({ ok: false, error: "breaks-wall", wallId: combined.wall.id });
    expect(cp.getPlacement(a)).toMatchObject({ x: 0, y: 0 }); // untouched
    expect(cp.getVideoWall(combined.wall.id)).toBeDefined();
  });

  test("unknown targets are refused before anything moves", async () => {
    const { a, muralId } = await canvas();
    expect(await cp.moveTargets("mural-404", { screenIds: [a], wallIds: [] }, 10, 0)).toMatchObject({
      error: "unknown-mural",
    });
    expect(await cp.moveTargets(muralId, { screenIds: ["screen-404"], wallIds: [] }, 10, 0)).toMatchObject({
      error: "unknown-screen",
    });
    expect(await cp.moveTargets(muralId, { screenIds: [], wallIds: ["wall-404"] }, 10, 0)).toMatchObject({
      error: "unknown-wall",
    });
    expect(cp.getPlacement(a)).toMatchObject({ x: 0, y: 0 });
  });

  test("wallBrokenByPlacement names the wall a single-screen drag would break (and only then)", async () => {
    const { a, b, muralId } = await canvas();
    const combined = await cp.combineScreens(muralId, [a, b]);
    if (!combined.ok) throw new Error("combine failed");

    // Still touching b → fine. Dragged across the canvas → breaks the wall.
    expect(cp.wallBrokenByPlacement(a, { x: 0, y: 900, w: 1920, h: 1080 })).toBeNull();
    expect(cp.wallBrokenByPlacement(a, { x: 9000, y: 0, w: 1920, h: 1080 })?.id).toBe(combined.wall.id);
    // A screen in no wall can never break one.
    expect(cp.wallBrokenByPlacement("screen-404", { x: 0, y: 0, w: 1, h: 1 })).toBeNull();
  });
});
