/**
 * POL-191/D175 — what the SERVER ACTUALLY SENDS to an account with partial access.
 *
 * `mural-grants.test.ts` pins the decision (who may see which murals). This pins the CONSEQUENCE: the
 * bytes on the admin socket. They are different failures — a perfect permission table still leaks if
 * the projection forgets a field — and this is the file that catches the second kind.
 *
 * The projection is written as "derive everything from the visible mural set", so the tests are
 * mostly about the derivations: a screen appears because it is PLACED on a visible mural, a machine
 * because it carries such a screen, and a machine that carries screens for two tenants shows each of
 * them only their own.
 */
import { describe, expect, test } from "bun:test";

import { AdminHub, projectAdminState } from "../src/admin";
import type { ServerToAdminMessage } from "@polyptic/protocol";

const ATRIUM = "mural_atrium";
const FOYER = "mural_foyer";

/**
 * A deployment with two tenants and — deliberately — ONE BOX driving both walls, which is the case a
 * naive "filter the machines list" would get wrong.
 */
function fullState(): ServerToAdminMessage {
  return {
    t: "admin/state",
    revision: 7,
    machines: [
      {
        id: "box1",
        label: "Box One",
        online: true,
        status: "approved",
        tags: [],
        screens: [
          { id: "scr_atrium", friendlyName: "Atrium L", machineId: "box1", connector: "HDMI-1", online: true, revision: 7, surfaceCount: 1 },
          { id: "scr_foyer", friendlyName: "Foyer L", machineId: "box1", connector: "HDMI-2", online: true, revision: 7, surfaceCount: 1 },
          { id: "scr_tray", friendlyName: "Spare", machineId: "box1", connector: "HDMI-3", online: true, revision: 7, surfaceCount: 0 },
        ],
      },
      {
        id: "box2",
        label: "Box Two",
        online: false,
        status: "pending",
        tags: [],
        screens: [],
      },
    ],
    murals: [
      { id: ATRIUM, name: "Atrium" },
      { id: FOYER, name: "Foyer" },
    ],
    placements: [
      { muralId: ATRIUM, screenId: "scr_atrium", x: 0, y: 0, w: 1920, h: 1080 },
      { muralId: FOYER, screenId: "scr_foyer", x: 0, y: 0, w: 1920, h: 1080 },
    ],
    videoWalls: [],
    contentSources: [],
    scenes: [
      { id: "scene_atrium", name: "Atrium morning", muralId: ATRIUM, placements: [], walls: [], content: {} },
      { id: "scene_foyer", name: "Foyer morning", muralId: FOYER, placements: [], walls: [], content: {} },
    ],
    activeScenes: { [ATRIUM]: "scene_atrium", [FOYER]: "scene_foyer" },
    activity: [{ id: "a1", at: new Date(0).toISOString(), kind: "info", text: "box2 enrolled" }],
    settings: { showBadges: false },
    credentialProfiles: [],
    sourceStatus: [
      {
        sourceId: "src1",
        usage: { sourceId: "src1", screenIds: ["scr_atrium", "scr_foyer"], wallIds: [], playlistIds: [], pageIds: [] },
        health: "unknown",
        unreachableScreenIds: ["scr_foyer"],
      },
    ],
    dayparts: [],
    schedules: [],
    scheduler: { enabled: false, timezone: "UTC", defaultSceneId: null },
  } as unknown as ServerToAdminMessage;
}

/** Narrow to the Atrium tenant. */
function atriumOnly(): ServerToAdminMessage {
  return projectAdminState(fullState(), new Set([ATRIUM]));
}

describe("projectAdminState — `all` is the identity, and costs a fleet role nothing", () => {
  test("an `all` viewer gets the SAME OBJECT back, untouched — no copy, no walk", () => {
    const state = fullState();
    expect(projectAdminState(state, "all")).toBe(state);
  });
});

describe("projectAdminState — one tenant's slice", () => {
  test("murals, placements and scenes are its own", () => {
    const s = atriumOnly();
    expect(s.murals.map((m) => m.id)).toEqual([ATRIUM]);
    expect(s.placements.map((p) => p.screenId)).toEqual(["scr_atrium"]);
    expect(s.scenes.map((sc) => sc.id)).toEqual(["scene_atrium"]);
    expect(s.activeScenes).toEqual({ [ATRIUM]: "scene_atrium" });
  });

  test("THE SHARED BOX: one machine, and it carries only this tenant's screen", () => {
    const s = atriumOnly();
    expect(s.machines.map((m) => m.id)).toEqual(["box1"]);
    expect(s.machines[0]?.screens.map((sc) => sc.id)).toEqual(["scr_atrium"]);
  });

  test("an UNPLACED screen is not theirs — the tray belongs to no canvas", () => {
    const ids = atriumOnly().machines.flatMap((m) => m.screens.map((s) => s.id));
    expect(ids).not.toContain("scr_tray");
  });

  test("a machine carrying NONE of their screens disappears entirely — including a pending one", () => {
    expect(atriumOnly().machines.map((m) => m.id)).not.toContain("box2");
  });

  test("the ACTIVITY FEED is dropped wholesale — it narrates the fleet in prose, not rows", () => {
    expect(atriumOnly().activity).toEqual([]);
  });

  test("source usage is narrowed to their screens, so a delete warning cannot count another tenant's", () => {
    const entry = atriumOnly().sourceStatus?.[0];
    expect(entry?.usage.screenIds).toEqual(["scr_atrium"]);
    expect(entry?.unreachableScreenIds).toEqual([]);
  });

  test("the shared library itself is NOT hidden — a mural owner has to be able to use it", () => {
    const s = projectAdminState(
      { ...fullState(), contentSources: [{ id: "src1" }] } as unknown as ServerToAdminMessage,
      new Set([ATRIUM]),
    );
    expect(s.contentSources).toHaveLength(1);
  });

  test("a viewer with NO murals gets a coherent, empty deployment — not a broken one", () => {
    const s = projectAdminState(fullState(), new Set());
    expect(s.murals).toEqual([]);
    expect(s.machines).toEqual([]);
    expect(s.scenes).toEqual([]);
    expect(s.placements).toEqual([]);
    expect(s.activeScenes).toEqual({});
    expect(s.revision).toBe(7); // still a real snapshot, not a null one
  });
});

describe("AdminHub — each socket gets its own slice, and shared ones are serialized once", () => {
  /** A fake socket that records what it was sent. `readyState` 1 = OPEN. */
  function socket(): { readyState: number; sent: string[]; send(data: string): void } {
    return {
      readyState: 1,
      sent: [],
      send(data: string) {
        this.sent.push(data);
      },
    };
  }

  test("two tenants on one hub receive DIFFERENT payloads", () => {
    const hub = new AdminHub();
    const a = socket();
    const b = socket();
    hub.add(a as never, { visible: new Set([ATRIUM]) });
    hub.add(b as never, { visible: new Set([FOYER]) });

    expect(hub.broadcast(fullState())).toBe(2);
    const seenByA = JSON.parse(a.sent[0]!) as ServerToAdminMessage;
    const seenByB = JSON.parse(b.sent[0]!) as ServerToAdminMessage;
    expect(seenByA.murals.map((m) => m.id)).toEqual([ATRIUM]);
    expect(seenByB.murals.map((m) => m.id)).toEqual([FOYER]);
    // The load-bearing negative: neither payload mentions the other tenant's screen anywhere in it.
    expect(a.sent[0]).not.toContain("scr_foyer");
    expect(b.sent[0]).not.toContain("scr_atrium");
  });

  test("two sockets on the SAME murals share one serialization (identical string)", () => {
    const hub = new AdminHub();
    const a = socket();
    const b = socket();
    hub.add(a as never, { visible: new Set([ATRIUM]) });
    hub.add(b as never, { visible: new Set([ATRIUM]) });
    hub.broadcast(fullState());
    expect(a.sent[0]).toBe(b.sent[0]);
  });

  test("a socket registered with no viewer sees everything — what a fleet role gets", () => {
    const hub = new AdminHub();
    const a = socket();
    hub.add(a as never);
    hub.broadcast(fullState());
    const seen = JSON.parse(a.sent[0]!) as ServerToAdminMessage;
    expect(seen.murals).toHaveLength(2);
  });

  test("a CLOSED socket is skipped rather than counted", () => {
    const hub = new AdminHub();
    const dead = socket();
    dead.readyState = 3; // CLOSED
    hub.add(dead as never);
    expect(hub.broadcast(fullState())).toBe(0);
    expect(dead.sent).toHaveLength(0);
  });
});
