/**
 * Unit tests for the POL-32 last-good-slice persistence — what lets a player that boots or reloads
 * during an outage paint its last-known content instead of an idle splash.
 *
 * The load path is the one that must be paranoid: whatever is in localStorage was written by SOME
 * build at SOME time, so it is validated against the shared protocol schemas and discarded (and
 * cleared) when it no longer parses — a stale snapshot must never crash the wall.
 */
import { describe, expect, test } from "bun:test";

import { loadLastSlice, saveLastSlice } from "../src/last-slice";
import type { KeyValueStorage } from "../src/last-slice";

/** A localStorage-shaped in-memory store; `failing` simulates quota/private-mode throws. */
function makeStorage(opts?: { failing?: boolean }): KeyValueStorage & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    getItem: (key) => {
      if (opts?.failing) throw new Error("storage unavailable");
      return map.get(key) ?? null;
    },
    setItem: (key, value) => {
      if (opts?.failing) throw new Error("quota exceeded");
      map.set(key, value);
    },
    removeItem: (key) => {
      map.delete(key);
    },
  };
}

const CANVAS = { x: 0, y: 0, w: 1920, h: 1080 };
const SURFACES = [
  {
    id: "s1",
    type: "image" as const,
    region: { x: 0, y: 0, w: 960, h: 1080 },
    src: "http://localhost:8080/media/abc123",
    fit: "cover" as const,
  },
  {
    id: "s2",
    type: "video" as const,
    region: { x: 960, y: 0, w: 960, h: 1080 },
    src: "http://localhost:8080/media/def456",
    loop: true,
    muted: true,
  },
];

const SNAPSHOT = {
  canvas: CANVAS,
  surfaces: SURFACES,
  revision: 42,
  friendlyName: "Lobby Left",
  showBadges: true,
  savedAt: 1_700_000_000_000,
};

describe("saveLastSlice / loadLastSlice", () => {
  test("round-trips a snapshot, keyed per screen", () => {
    const storage = makeStorage();
    saveLastSlice(storage, "screen-1", SNAPSHOT);

    const restored = loadLastSlice(storage, "screen-1");
    expect(restored?.revision).toBe(42);
    expect(restored?.friendlyName).toBe("Lobby Left");
    expect(restored?.surfaces.length).toBe(2);
    expect(restored?.surfaces[0]?.id).toBe("s1");
    // Another screen's slot is untouched.
    expect(loadLastSlice(storage, "screen-2")).toBeNull();
  });

  test("surfaces are re-validated through the protocol schemas (defaults re-applied)", () => {
    const storage = makeStorage();
    saveLastSlice(storage, "screen-1", SNAPSHOT);
    const restored = loadLastSlice(storage, "screen-1");
    const video = restored?.surfaces[1];
    expect(video?.type).toBe("video");
    if (video?.type === "video") {
      expect(video.loop).toBe(true);
      expect(video.muted).toBe(true);
    }
  });

  test("an empty slice (no surfaces) round-trips — a wall CLEARED on purpose stays cleared", () => {
    const storage = makeStorage();
    saveLastSlice(storage, "screen-1", { ...SNAPSHOT, surfaces: [] });
    const restored = loadLastSlice(storage, "screen-1");
    expect(restored).not.toBeNull();
    expect(restored?.surfaces).toEqual([]);
  });

  test("corrupt JSON is discarded AND cleared, never thrown", () => {
    const storage = makeStorage();
    storage.map.set("polyptic:last-slice:screen-1", "{not json");
    expect(loadLastSlice(storage, "screen-1")).toBeNull();
    expect(storage.map.has("polyptic:last-slice:screen-1")).toBe(false);
  });

  test("a schema-invalid snapshot (older build's shape) is discarded and cleared", () => {
    const storage = makeStorage();
    storage.map.set(
      "polyptic:last-slice:screen-1",
      JSON.stringify({ v: 1, canvas: CANVAS, surfaces: [{ id: "x", type: "hologram" }] }),
    );
    expect(loadLastSlice(storage, "screen-1")).toBeNull();
    expect(storage.map.has("polyptic:last-slice:screen-1")).toBe(false);
  });

  test("a future snapshot VERSION is not trusted", () => {
    const storage = makeStorage();
    storage.map.set(
      "polyptic:last-slice:screen-1",
      JSON.stringify({ ...SNAPSHOT, v: 2 }),
    );
    expect(loadLastSlice(storage, "screen-1")).toBeNull();
  });

  test("storage failures (quota, private mode) are swallowed on save AND load", () => {
    const storage = makeStorage({ failing: true });
    expect(() => saveLastSlice(storage, "screen-1", SNAPSHOT)).not.toThrow();
    expect(loadLastSlice(storage, "screen-1")).toBeNull();
  });
});
