/**
 * POL-94 — the HEALTH fold + the protocol's back-compat guarantees.
 *
 * Health is what the GLASS reports: the POL-86 prober proves a URL fetchable before it paints it, and
 * now says so over the wire (`player/surface-health`, on state CHANGE only). The server folds those
 * reports per library source. The claims worth pinning are the ones that decide whether an operator
 * can trust the badge:
 *   - one broken screen makes the source broken (a wall broken on one panel IS broken);
 *   - a screen that drops takes its verdict with it (an unplugged box knows nothing about a URL);
 *   - a source nobody shows is `unknown`, never a comforting green.
 *
 * Plus the contract's back-compat: an OLD player (no surface-health, no sourceId on a surface) and an
 * OLD console (no sourceStatus in the snapshot) must both still validate against the new schemas.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  PlayerMessage,
  ServerToAdminState,
  ServerToPlayerRender,
  Surface,
} from "@polyptic/protocol";
import type { SourceUsage } from "@polyptic/protocol";

import { SourceHealthTracker } from "../src/source-health";

let health: SourceHealthTracker;

beforeEach(() => {
  health = new SourceHealthTracker();
});

const usage = (sourceId: string): SourceUsage => ({
  sourceId,
  screenIds: [],
  wallIds: [],
  playlistIds: [],
  pageIds: [],
});

describe("source health fold (POL-94)", () => {
  test("a source nobody is showing is unknown — never a comforting green", () => {
    expect(health.statusFor("source-1")).toEqual({ health: "unknown", unreachableScreenIds: [] });
  });

  test("a screen that proved the URL fetchable makes it reachable, with the time it said so", () => {
    health.record({
      screenId: "screen-1",
      surfaceId: "content-web",
      sourceId: "source-1",
      state: "reachable",
      at: "2026-07-14T09:00:00.000Z",
    });
    expect(health.statusFor("source-1")).toEqual({
      health: "reachable",
      lastSeenAt: "2026-07-14T09:00:00.000Z",
      unreachableScreenIds: [],
    });
  });

  test("ONE screen that cannot fetch it makes the source unreachable, even if others can", () => {
    health.record({
      screenId: "screen-1",
      surfaceId: "content-web",
      sourceId: "source-1",
      state: "reachable",
      at: "2026-07-14T09:00:00.000Z",
    });
    health.record({
      screenId: "screen-2",
      surfaceId: "content-web",
      sourceId: "source-1",
      state: "unreachable",
      at: "2026-07-14T09:05:00.000Z",
      detail: "Failed to fetch",
    });

    const status = health.statusFor("source-1");
    expect(status.health).toBe("unreachable");
    expect(status.unreachableScreenIds).toEqual(["screen-2"]);
    expect(status.detail).toBe("Failed to fetch");
    expect(status.lastSeenAt).toBe("2026-07-14T09:05:00.000Z"); // when it BROKE, not when it was last fine
  });

  test("a screen's newer report replaces its older one — a heal turns the badge green again", () => {
    health.record({
      screenId: "screen-1",
      surfaceId: "content-web",
      sourceId: "source-1",
      state: "unreachable",
      at: "2026-07-14T09:00:00.000Z",
      detail: "Failed to fetch",
    });
    expect(health.statusFor("source-1").health).toBe("unreachable");

    health.record({
      screenId: "screen-1",
      surfaceId: "content-web",
      sourceId: "source-1",
      state: "reachable",
      at: "2026-07-14T09:01:00.000Z",
    });
    const status = health.statusFor("source-1");
    expect(status.health).toBe("reachable");
    expect(status.unreachableScreenIds).toEqual([]);
    expect(status.detail).toBeUndefined();
  });

  test("a screen that drops takes its verdict with it — an unplugged box proves nothing", () => {
    health.record({
      screenId: "screen-1",
      surfaceId: "content-web",
      sourceId: "source-1",
      state: "unreachable",
      at: "2026-07-14T09:00:00.000Z",
    });
    expect(health.statusFor("source-1").health).toBe("unreachable");

    health.forgetScreen("screen-1");
    expect(health.statusFor("source-1").health).toBe("unknown");
  });

  test("a deleted source's reports go with it — a re-used id can never inherit them", () => {
    health.record({
      screenId: "screen-1",
      surfaceId: "content-web",
      sourceId: "source-1",
      state: "unreachable",
      at: "2026-07-14T09:00:00.000Z",
    });
    health.forgetSource("source-1");
    expect(health.statusFor("source-1").health).toBe("unknown");
  });

  test("statusList marries each source's usage fold to its health fold", () => {
    health.record({
      screenId: "screen-1",
      surfaceId: "content-web",
      sourceId: "source-2",
      state: "unreachable",
      at: "2026-07-14T09:00:00.000Z",
      detail: "Failed to fetch",
    });

    const list = health.statusList([usage("source-1"), usage("source-2")]);
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ sourceId: "source-1", health: "unknown" });
    expect(list[1]).toMatchObject({
      sourceId: "source-2",
      health: "unreachable",
      unreachableScreenIds: ["screen-1"],
      detail: "Failed to fetch",
    });
  });
});

describe("protocol back-compat (POL-94)", () => {
  test("an OLD player's frames still validate — the new message is additive", () => {
    expect(
      PlayerMessage.safeParse({ t: "player/hello", protocol: 1, screenId: "screen-1" }).success,
    ).toBe(true);
    expect(
      PlayerMessage.safeParse({ t: "player/ack", screenId: "screen-1", revision: 4 }).success,
    ).toBe(true);
    expect(
      PlayerMessage.safeParse({
        t: "player/diag",
        screenId: "screen-1",
        at: "2026-07-14T09:00:00.000Z",
        msg: "hello",
      }).success,
    ).toBe(true);
  });

  test("a NEW player's health frame validates, with and without a library source", () => {
    const withSource = PlayerMessage.safeParse({
      t: "player/surface-health",
      screenId: "screen-1",
      surfaceId: "content-web",
      sourceId: "source-1",
      url: "https://grafana.test/d/abc",
      state: "unreachable",
      at: "2026-07-14T09:00:00.000Z",
      detail: "Failed to fetch",
    });
    expect(withSource.success).toBe(true);

    // Ad-hoc URL: no library source to attribute it to. Still a legal frame (the server drops it).
    const adHoc = PlayerMessage.safeParse({
      t: "player/surface-health",
      screenId: "screen-1",
      surfaceId: "content-web",
      url: "https://ad-hoc.test/",
      state: "reachable",
      at: "2026-07-14T09:00:00.000Z",
    });
    expect(adHoc.success).toBe(true);

    // A state we never promised is refused at the edge, like everything else.
    expect(
      PlayerMessage.safeParse({
        t: "player/surface-health",
        screenId: "screen-1",
        surfaceId: "content-web",
        url: "https://x.test/",
        state: "probably-fine",
        at: "2026-07-14T09:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  test("a surface without the new send-time sourceId still parses (older server → newer player)", () => {
    const legacy = Surface.safeParse({
      id: "content-web",
      type: "web",
      region: { x: 0, y: 0, w: 1920, h: 1080 },
      url: "https://grafana.test/d/abc",
    });
    expect(legacy.success).toBe(true);
    if (legacy.success) expect(legacy.data.sourceId).toBeUndefined();

    const stamped = ServerToPlayerRender.safeParse({
      t: "server/render",
      revision: 3,
      friendlyName: "Lobby 1",
      slice: {
        screenId: "screen-1",
        canvas: { x: 0, y: 0, w: 1920, h: 1080 },
        surfaces: [
          {
            id: "content-web",
            type: "web",
            region: { x: 0, y: 0, w: 1920, h: 1080 },
            url: "https://grafana.test/d/abc",
            sourceId: "source-1",
          },
        ],
      },
    });
    expect(stamped.success).toBe(true);
  });

  test("an admin snapshot without sourceStatus still parses (older server → newer console)", () => {
    const snapshot = ServerToAdminState.safeParse({
      t: "admin/state",
      revision: 1,
      machines: [],
      murals: [],
      placements: [],
      videoWalls: [],
      contentSources: [],
      scenes: [],
    });
    expect(snapshot.success).toBe(true);
    if (snapshot.success) expect(snapshot.data.sourceStatus).toBeUndefined();
  });
});
