/**
 * POL-95 — the ACTIVE scene is server-authoritative, and the apply-preview diff.
 *
 * These drive `ControlPlane` directly against the `MemoryStore` (no server/WS). They pin the two
 * claims the console's Active badge and its apply-preview card make to an operator:
 *
 *   1. The badge is the CONTROL PLANE's answer, not a console's memory of its own last click. It is
 *      set by apply, PERSISTED (it survives a restart), and CLEARED the moment a manual change makes
 *      the wall stop being that scene — because a console that lies about which scene is live corrodes
 *      trust in everything else it shows.
 *   2. The diff says what apply WOULD do, in the same terms apply reconciles in (content, placement,
 *      combine/split, cleared) — and, being the same engine the badge is judged by, it can never
 *      disagree with the badge: right after an apply the diff is `identical`.
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

let store: MemoryStore;
let cp: ControlPlane;

/** Three screens placed side by side on one mural — enough for a wall (A+B) plus a loner (C). */
async function threeScreens(): Promise<{ a: string; b: string; c: string; muralId: string }> {
  await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2", "HDMI-3"));
  const [a, b, c] = cp.getScreens();
  const mural = await cp.createMural("Atrium");
  await cp.placeScreen(a!.id, mural.id, 0, 0, 1920, 1080);
  await cp.placeScreen(b!.id, mural.id, 1920, 0, 1920, 1080);
  await cp.placeScreen(c!.id, mural.id, 4000, 0, 1920, 1080);
  return { a: a!.id, b: b!.id, c: c!.id, muralId: mural.id };
}

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("the active scene is server-authoritative (POL-95)", () => {
  test("nothing is active until a scene is applied", async () => {
    const { muralId } = await threeScreens();
    const scene = await cp.snapshotScene("Opening", muralId);
    expect(scene).not.toBeNull();
    // Saving a scene does NOT make it active — the wall was not applied, it was photographed.
    expect(cp.state.activeSceneId).toBeNull();
  });

  test("applying a scene sets the active scene, and it SURVIVES a restart", async () => {
    const { a, muralId } = await threeScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    const scene = await cp.snapshotScene("Opening", muralId);
    await cp.applyScene(scene!.id);
    expect(cp.state.activeSceneId).toBe(scene!.id);

    // A control-plane restart against the same store: the badge is desired state, so it comes back.
    const revived = new ControlPlane(store);
    await revived.init();
    expect(revived.state.activeSceneId).toBe(scene!.id);
  });

  test("a manual content change CLEARS the badge (the wall is no longer that scene)", async () => {
    const { a, muralId } = await threeScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    const scene = await cp.snapshotScene("Opening", muralId);
    await cp.applyScene(scene!.id);
    expect(cp.state.activeSceneId).toBe(scene!.id);

    await cp.setScreenContent(a, { url: "https://example.test/two" });
    expect(cp.state.activeSceneId).toBeNull();
  });

  test("a manual MOVE clears it; a no-op re-place of the same geometry does not", async () => {
    const { a, muralId } = await threeScreens();
    const scene = await cp.snapshotScene("Opening", muralId);
    await cp.applyScene(scene!.id);

    // Placing A exactly where it already is changes nothing on the wall — the badge stands.
    await cp.placeScreen(a, muralId, 0, 0, 1920, 1080);
    expect(cp.state.activeSceneId).toBe(scene!.id);

    await cp.placeScreen(a, muralId, 500, 500, 1920, 1080);
    expect(cp.state.activeSceneId).toBeNull();
  });

  test("combining and splitting clear it (grouping is part of the scene)", async () => {
    const { a, b, muralId } = await threeScreens();
    const scene = await cp.snapshotScene("Opening", muralId);
    await cp.applyScene(scene!.id);

    const combined = await cp.combineScreens(muralId, [a, b]);
    expect(combined.ok).toBe(true);
    expect(cp.state.activeSceneId).toBeNull();

    // Apply again (the scene has no walls) → the wall is split back and the badge returns.
    await cp.applyScene(scene!.id);
    expect(cp.state.activeSceneId).toBe(scene!.id);
    expect(cp.getVideoWalls().length).toBe(0);
  });

  test("the badge clears when its scene is deleted — and the clearance is persisted", async () => {
    const { muralId } = await threeScreens();
    const scene = await cp.snapshotScene("Opening", muralId);
    await cp.applyScene(scene!.id);

    expect(await cp.deleteScene(scene!.id)).toBe(true);
    expect(cp.state.activeSceneId).toBeNull();

    const revived = new ControlPlane(store);
    await revived.init();
    expect(revived.state.activeSceneId).toBeNull();
  });

  test("applying a scene is IDEMPOTENT — re-applying the active one keeps the badge", async () => {
    const { a, b, muralId } = await threeScreens();
    await cp.combineScreens(muralId, [a, b]);
    const wall = cp.getVideoWalls()[0]!;
    await cp.setWallContent(wall.id, { url: "https://example.test/span" });
    const scene = await cp.snapshotScene("Opening", muralId);

    await cp.applyScene(scene!.id);
    expect(cp.state.activeSceneId).toBe(scene!.id);
    await cp.applyScene(scene!.id);
    expect(cp.state.activeSceneId).toBe(scene!.id);
    expect(cp.diffScene(scene!.id)?.identical).toBe(true);
  });
});

describe("the scene apply-preview diff (POL-95)", () => {
  test("an unknown scene has no diff", () => {
    expect(cp.diffScene("scene-nope")).toBeNull();
  });

  test("right after an apply the diff is IDENTICAL (the badge and the preview agree)", async () => {
    const { a, b, c, muralId } = await threeScreens();
    await cp.combineScreens(muralId, [a, b]);
    await cp.setWallContent(cp.getVideoWalls()[0]!.id, { url: "https://example.test/span" });
    await cp.setScreenContent(c, { url: "https://example.test/c" });
    const scene = await cp.snapshotScene("Opening", muralId);

    await cp.applyScene(scene!.id);
    const diff = cp.diffScene(scene!.id)!;
    expect(diff.identical).toBe(true);
    expect(diff.entries.length).toBe(0);
    expect(diff.summary.unchanged).toBeGreaterThan(0);
  });

  test("content, placement, combine and split all show up — with the from → to read-out", async () => {
    const { a, b, c, muralId } = await threeScreens();
    const created = await cp.createContentSource({
      name: "Ops dashboard",
      kind: "web",
      url: "https://example.test/ops",
    });
    expect(created.ok).toBe(true);
    const source = created.ok ? created.source : null;
    expect(source).not.toBeNull();

    // The SAVED wall: A+B combined spanning the library source; C showing an ad-hoc url.
    await cp.combineScreens(muralId, [a, b]);
    await cp.setWallContent(cp.getVideoWalls()[0]!.id, { sourceId: source!.id });
    await cp.setScreenContent(c, { url: "https://example.test/c" });
    const scene = await cp.snapshotScene("Opening", muralId);

    // Now DIVERGE the live wall: split A+B, move A, give A other content, clear C.
    await cp.splitWall(cp.getVideoWalls()[0]!.id);
    await cp.placeScreen(a, muralId, 900, 900, 1920, 1080);
    await cp.setScreenContent(a, { url: "https://example.test/mutation" });
    await cp.setScreenSurfaces(c, []);

    const diff = cp.diffScene(scene!.id)!;
    expect(diff.identical).toBe(false);

    // A moves back, and is swept into the wall (its ad-hoc content is the wall's now).
    const entryA = diff.entries.find((e) => e.id === a)!;
    expect(entryA.target).toBe("screen");
    expect(entryA.changes).toContain("move");

    // The wall is re-formed and spans the library source again — named, not id'd, in the read-out.
    const wallEntry = diff.entries.find((e) => e.target === "wall")!;
    expect(wallEntry.changes).toContain("combine");
    expect(wallEntry.changes).toContain("content");
    expect(wallEntry.screenIds.sort()).toEqual([a, b].sort());
    expect(wallEntry.to?.sourceId).toBe(source!.id);
    expect(wallEntry.to?.label).toBe("Ops dashboard");

    // C gets its ad-hoc url back (it is empty right now).
    const entryC = diff.entries.find((e) => e.id === c)!;
    expect(entryC.changes).toContain("content");
    expect(entryC.from).toBeNull();
    expect(entryC.to?.url).toBe("https://example.test/c");

    expect(diff.summary.combines).toBe(1);
    expect(diff.summary.moves).toBe(1);
    expect(diff.summary.contentChanges).toBeGreaterThanOrEqual(2);
  });

  test("a live wall the scene does not keep is reported as a SPLIT", async () => {
    const { a, b, muralId } = await threeScreens();
    const scene = await cp.snapshotScene("Opening", muralId); // no walls in the snapshot
    await cp.combineScreens(muralId, [a, b]);
    await cp.setWallContent(cp.getVideoWalls()[0]!.id, { url: "https://example.test/span" });

    const diff = cp.diffScene(scene!.id)!;
    const splitEntry = diff.entries.find((e) => e.changes.includes("split"))!;
    expect(splitEntry.target).toBe("wall");
    expect(splitEntry.from?.url).toBe("https://example.test/span");
    expect(diff.summary.splits).toBe(1);
  });

  test("a screen the scene omits is unplaced and CLEARED", async () => {
    const { a, c, muralId } = await threeScreens();
    await cp.setScreenContent(c, { url: "https://example.test/c" });
    await cp.unplaceScreen(c);
    const scene = await cp.snapshotScene("Opening", muralId); // captured WITHOUT c

    // Bring C back onto the mural with content — the scene would take it off again.
    await cp.placeScreen(c, muralId, 4000, 0, 1920, 1080);
    await cp.setScreenContent(c, { url: "https://example.test/c-again" });
    void a;

    const diff = cp.diffScene(scene!.id)!;
    const entryC = diff.entries.find((e) => e.id === c)!;
    expect(entryC.changes).toContain("unplace");
    expect(entryC.changes).toContain("cleared");
    expect(entryC.to).toBeNull();
    expect(diff.summary.unplaced).toBe(1);
    expect(diff.summary.cleared).toBe(1);
  });

  test("a captured source that has since been DELETED warns, and previews as empty", async () => {
    const { a, muralId } = await threeScreens();
    const created = await cp.createContentSource({
      name: "Doomed",
      kind: "web",
      url: "https://example.test/doomed",
    });
    expect(created.ok).toBe(true);
    const source = created.ok ? created.source : null;
    expect(source).not.toBeNull();
    await cp.setScreenContent(a, { sourceId: source!.id });
    const scene = await cp.snapshotScene("Opening", muralId);

    await cp.deleteContentSource(source!.id); // the library entry is gone; the scene still names it

    const diff = cp.diffScene(scene!.id)!;
    // Apply would leave A empty — and the preview says so, rather than promising content.
    const entryA = diff.entries.find((e) => e.id === a);
    expect(entryA?.to ?? null).toBeNull();
    expect(diff.warnings.length).toBeGreaterThan(0);
    expect(diff.warnings.some((w) => w.includes("deleted"))).toBe(true);
  });
});
