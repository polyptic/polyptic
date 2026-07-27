/**
 * POL-186 — the control plane carries the resolver's MURAL context, and the Active badge is per mural.
 *
 * The scheduler resolves once per mural, so the control plane owes it two things the single-wall model
 * never had to say out loud: the list of murals to resolve, and which mural each scene belongs to (the
 * default-scene floor is scoped through that map). And because each mural is now on its own scene,
 * "which scene is the wall on?" stops being one global answer — it is one answer per mural, each set,
 * cleared and persisted independently of the others.
 *
 * A schedule window is stamped with the mural it governs at write time: a scene-bearing window takes
 * its scene's mural (a scene cannot move mural, so the stamp is stable), a POWER-ONLY window keeps the
 * mural the operator targeted, or null for every mural.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output } from "@polyptic/protocol";
import { ActivityLog } from "../src/activity";
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
let activity: ActivityLog;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  activity = new ActivityLog();
  cp = new ControlPlane(store, activity);
  await cp.init();
});

/** The divergence lines in the feed — what an operator is told when a badge is pulled. */
function divergenceLines(): string[] {
  return activity.recent().map((e) => e.text).filter((t) => t.includes("no longer matches scene"));
}

/** One screen placed on a fresh mural — the smallest thing a scene can photograph. */
async function muralWithScreen(name: string, machineId: string, connector: string): Promise<string> {
  await cp.registerMachine(hello(machineId, connector));
  const screen = cp.getScreens().find((s) => s.machineId === machineId)!;
  const mural = await cp.createMural(name);
  await cp.placeScreen(screen.id, mural.id, 0, 0, 1920, 1080);
  return mural.id;
}

describe("the control plane carries the resolver's mural context (POL-186)", () => {
  test("getScheduleSet lists every mural and the scene→mural map", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const atrium = await muralWithScreen("Atrium", "m2", "HDMI-1");
    const morning = await cp.snapshotScene("Morning", lobby);
    const evening = await cp.snapshotScene("Evening", atrium);

    const set = cp.getScheduleSet();
    expect(set.murals).toContain(lobby);
    expect(set.murals).toContain(atrium);
    expect(set.sceneMurals[morning!.id]).toBe(lobby);
    expect(set.sceneMurals[evening!.id]).toBe(atrium);
  });

  test("createSchedule stamps the mural from the scene", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const scene = await cp.snapshotScene("Morning", lobby);
    const daypart = await cp.createDaypart({ name: "Day", start: "07:00", end: "19:00" });

    const result = await cp.createSchedule({
      sceneId: scene!.id,
      muralId: null,
      daypartId: daypart.id,
      days: [1],
      priority: 0,
      panels: "on",
      enabled: true,
      from: null,
      until: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schedule.muralId).toBe(lobby);
  });

  test("a power-only window keeps the mural the operator targeted", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const daypart = await cp.createDaypart({ name: "Night", start: "19:00", end: "07:00" });

    const result = await cp.createSchedule({
      sceneId: null,
      muralId: lobby,
      daypartId: daypart.id,
      days: [1],
      priority: 0,
      panels: "off",
      enabled: true,
      from: null,
      until: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.sceneId).toBeNull();
      expect(result.schedule.muralId).toBe(lobby);
      expect(result.schedule.panels).toBe("off");
    }
  });

  test("a power-only window with no mural governs every mural", async () => {
    const daypart = await cp.createDaypart({ name: "Night", start: "19:00", end: "07:00" });
    const result = await cp.createSchedule({
      sceneId: null,
      muralId: null,
      daypartId: daypart.id,
      days: [1],
      priority: 0,
      panels: "off",
      enabled: true,
      from: null,
      until: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schedule.muralId).toBeNull();
  });

  test("a window aimed at a mural that does not exist is REFUSED", async () => {
    const daypart = await cp.createDaypart({ name: "Night", start: "19:00", end: "07:00" });
    const result = await cp.createSchedule({
      sceneId: null,
      muralId: "mural-nope",
      daypartId: daypart.id,
      days: [1],
      priority: 0,
      panels: "off",
      enabled: true,
      from: null,
      until: null,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toBe("unknown-mural");
  });

  test("moving a window onto another scene RE-STAMPS its mural", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const atrium = await muralWithScreen("Atrium", "m2", "HDMI-1");
    const morning = await cp.snapshotScene("Morning", lobby);
    const evening = await cp.snapshotScene("Evening", atrium);
    const daypart = await cp.createDaypart({ name: "Day", start: "07:00", end: "19:00" });

    const created = await cp.createSchedule({
      sceneId: morning!.id,
      muralId: null,
      daypartId: daypart.id,
      days: [1],
      priority: 0,
      panels: "on",
      enabled: true,
      from: null,
      until: null,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await cp.updateSchedule(created.schedule.id, { sceneId: evening!.id });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.schedule.muralId).toBe(atrium);
  });

  test("clearing a window's scene leaves it POWER-ONLY on the mural it already governed", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const morning = await cp.snapshotScene("Morning", lobby);
    const daypart = await cp.createDaypart({ name: "Day", start: "07:00", end: "19:00" });
    const created = await cp.createSchedule({
      sceneId: morning!.id,
      muralId: null,
      daypartId: daypart.id,
      days: [1],
      priority: 0,
      panels: "on",
      enabled: true,
      from: null,
      until: null,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const updated = await cp.updateSchedule(created.schedule.id, { sceneId: null, panels: "off" });
    expect(updated.ok).toBe(true);
    if (updated.ok) {
      expect(updated.schedule.sceneId).toBeNull();
      expect(updated.schedule.muralId).toBe(lobby);
      expect(updated.schedule.panels).toBe("off");
    }
  });
});

describe("the Active badge is per mural (POL-186)", () => {
  test("applying a scene marks ITS mural, and leaves the other alone", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const atrium = await muralWithScreen("Atrium", "m2", "HDMI-1");
    const morning = await cp.snapshotScene("Morning", lobby);
    const evening = await cp.snapshotScene("Evening", atrium);

    await cp.applyScene(morning!.id);
    expect(cp.getActiveSceneId(lobby)).toBe(morning!.id);
    expect(cp.getActiveSceneId(atrium)).toBeNull();

    await cp.applyScene(evening!.id);
    expect(cp.getActiveSceneId(lobby)).toBe(morning!.id);
    expect(cp.getActiveSceneId(atrium)).toBe(evening!.id);
  });

  test("a manual change on one mural clears only THAT mural's badge", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const atrium = await muralWithScreen("Atrium", "m2", "HDMI-1");
    const lobbyScreen = cp.getScreens().find((s) => s.machineId === "m1")!;
    const morning = await cp.snapshotScene("Morning", lobby);
    const evening = await cp.snapshotScene("Evening", atrium);
    await cp.applyScene(morning!.id);
    await cp.applyScene(evening!.id);

    await cp.setScreenContent(lobbyScreen.id, { url: "https://example.test/manual" });
    expect(cp.getActiveSceneId(lobby)).toBeNull();
    expect(cp.getActiveSceneId(atrium)).toBe(evening!.id);
  });

  test("every mural's badge SURVIVES a restart", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const atrium = await muralWithScreen("Atrium", "m2", "HDMI-1");
    const morning = await cp.snapshotScene("Morning", lobby);
    const evening = await cp.snapshotScene("Evening", atrium);
    await cp.applyScene(morning!.id);
    await cp.applyScene(evening!.id);

    const revived = new ControlPlane(store);
    await revived.init();
    expect(revived.getActiveSceneId(lobby)).toBe(morning!.id);
    expect(revived.getActiveSceneId(atrium)).toBe(evening!.id);
  });

  test("an apply that DRAGS A SCREEN OFF another mural clears that mural's badge too", async () => {
    // Lobby holds both screens when "Morning" is photographed; one of them is then moved to Atrium,
    // which gets a scene of its own and an apply. Re-applying Morning yanks that screen back — so
    // Atrium is now empty, and its badge has to go with it. The apply's own fence swallows the
    // reconcile its primitives would have triggered, which is exactly why the apply re-judges after.
    await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
    const [one, two] = cp.getScreens();
    const lobby = (await cp.createMural("Lobby")).id;
    const atrium = (await cp.createMural("Atrium")).id;
    await cp.placeScreen(one!.id, lobby, 0, 0, 1920, 1080);
    await cp.placeScreen(two!.id, lobby, 1920, 0, 1920, 1080);
    const morning = await cp.snapshotScene("Morning", lobby);

    await cp.placeScreen(two!.id, atrium, 0, 0, 1920, 1080);
    const evening = await cp.snapshotScene("Evening", atrium);
    await cp.applyScene(evening!.id);
    expect(cp.getActiveSceneId(atrium)).toBe(evening!.id);

    await cp.applyScene(morning!.id);
    expect(cp.getActiveSceneId(lobby)).toBe(morning!.id); // the applied mural IS its scene
    expect(cp.diffScene(evening!.id)?.identical).toBe(false); // Atrium is empty now…
    expect(cp.getActiveSceneId(atrium)).toBeNull(); // …so its badge cannot stand

    // And the operator is TOLD which wall lost its badge — once.
    expect(divergenceLines()).toEqual(["Atrium no longer matches scene Evening"]);
  });

  test("an apply that touches nothing else leaves every other badge — and the feed — alone", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const atrium = await muralWithScreen("Atrium", "m2", "HDMI-1");
    const morning = await cp.snapshotScene("Morning", lobby);
    const evening = await cp.snapshotScene("Evening", atrium);
    await cp.applyScene(evening!.id);

    await cp.applyScene(morning!.id);
    expect(cp.getActiveSceneId(lobby)).toBe(morning!.id);
    expect(cp.getActiveSceneId(atrium)).toBe(evening!.id);
    expect(divergenceLines()).toEqual([]);
  });

  test("each divergence line names ITS wall, and one change narrates only one wall", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const atrium = await muralWithScreen("Atrium", "m2", "HDMI-1");
    const lobbyScreen = cp.getScreens().find((s) => s.machineId === "m1")!;
    const atriumScreen = cp.getScreens().find((s) => s.machineId === "m2")!;
    const morning = await cp.snapshotScene("Morning", lobby);
    const evening = await cp.snapshotScene("Evening", atrium);
    await cp.applyScene(morning!.id);
    await cp.applyScene(evening!.id);

    await cp.setScreenContent(lobbyScreen.id, { url: "https://example.test/one" });
    expect(divergenceLines()).toEqual(["Lobby no longer matches scene Morning"]);

    await cp.setScreenContent(atriumScreen.id, { url: "https://example.test/two" });
    expect(divergenceLines().sort()).toEqual([
      "Atrium no longer matches scene Evening",
      "Lobby no longer matches scene Morning",
    ]);
  });

  test("deleting a mural takes its badge with it", async () => {
    const lobby = await muralWithScreen("Lobby", "m1", "HDMI-1");
    const morning = await cp.snapshotScene("Morning", lobby);
    await cp.applyScene(morning!.id);
    expect(cp.getActiveSceneId(lobby)).toBe(morning!.id);

    await cp.deleteMural(lobby);
    expect(cp.getActiveSceneId(lobby)).toBeNull();

    const revived = new ControlPlane(store);
    await revived.init();
    expect(revived.getActiveSceneId(lobby)).toBeNull();
  });
});
