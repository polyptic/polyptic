import { describe, expect, test } from "bun:test";
import { Schedule, CreateScheduleBody } from "../src/schedule";

describe("Schedule panels", () => {
  test("defaults to on so a stored schedule keeps today's behaviour", () => {
    const s = Schedule.parse({
      id: "schedule-1",
      sceneId: "scene-1",
      muralId: "mural-1",
      daypartId: "daypart-1",
      days: [1, 2, 3],
      priority: 0,
      enabled: true,
      from: null,
      until: null,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    expect(s.panels).toBe("on");
  });

  test("a power-only window carries no scene", () => {
    const s = Schedule.parse({
      id: "schedule-2",
      sceneId: null,
      muralId: null,
      daypartId: "daypart-1",
      days: [0, 1, 2, 3, 4, 5, 6],
      priority: 0,
      panels: "off",
      enabled: true,
      from: null,
      until: null,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    expect(s.sceneId).toBeNull();
    expect(s.muralId).toBeNull();
    expect(s.panels).toBe("off");
  });

  test("CreateScheduleBody accepts a power-only window and defaults panels to on", () => {
    const body = CreateScheduleBody.parse({ daypartId: "daypart-1", days: [1] });
    expect(body.sceneId).toBeNull();
    expect(body.muralId).toBeNull();
    expect(body.panels).toBe("on");
  });

  test("panels rejects anything but on/off", () => {
    expect(() => Schedule.parse({
      id: "s", sceneId: null, muralId: null, daypartId: "d", days: [1],
      priority: 0, panels: "dim", enabled: true, from: null, until: null,
      createdAt: "2026-07-27T00:00:00.000Z",
    })).toThrow();
  });
});
