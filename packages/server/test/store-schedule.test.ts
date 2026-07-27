import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../src/store/memory";

describe("store round-trips POL-186 schedule fields", () => {
  test("a power-only fleet-wide window survives a round trip", async () => {
    const store = new MemoryStore();
    await store.upsertSchedule({
      id: "schedule-1",
      sceneId: null,
      muralId: null,
      daypartId: "daypart-1",
      days: [1, 2, 3, 4, 5],
      priority: 0,
      panels: "off",
      enabled: true,
      from: null,
      until: null,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const [row] = await store.listSchedules();
    expect(row?.sceneId).toBeNull();
    expect(row?.muralId).toBeNull();
    expect(row?.panels).toBe("off");
  });

  // Read back through `load()` — the snapshot the control plane actually rebuilds from on boot, and
  // the only reader of these rows there has ever been.
  test("the active scene is per mural", async () => {
    const store = new MemoryStore();
    await store.setActiveSceneId("mural-1", "scene-1");
    await store.setActiveSceneId("mural-2", "scene-9");
    await store.setActiveSceneId("mural-1", null);
    expect((await store.load()).activeScenes).toEqual({ "mural-2": "scene-9" });
  });
});
