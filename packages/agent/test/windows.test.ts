/**
 * POL-18/POL-152/POL-153/POL-156 — agent-side web-window helpers: the apply-payload diff that decides
 * which windows to (re)place/tear down, the canvas → output pixel mapping the sway backend positions
 * with, the single-box span union, the self-verify geometry compare + tree read-back, and the Chrome
 * argv a placed window launches with. All pure — no compositor, no browser.
 */
import { describe, expect, test } from "bun:test";

import type { WindowPlacement } from "@polyptic/protocol";
import {
  diffWindows,
  findConRect,
  geometryMatches,
  regionToOutputRect,
  spanningOutputRect,
  windowPlacementCommand,
  windowSignature,
} from "../src/windows";
import type { PlacedWindow } from "../src/windows";
import { buildChromeWindowArgs, chromeWindowDataDir } from "../src/backends/chrome";

function win(
  id: string,
  url: string,
  x = 0,
  y = 0,
  w = 960,
  h = 540,
  zoom = 1,
): WindowPlacement {
  return {
    id,
    url,
    region: { x, y, w, h },
    canvas: { x: 0, y: 0, w: 1920, h: 1080 },
    zoom,
  };
}

/** A single-connector placed window at the signature the diff would compute for it. */
function placed(connector: string, w: WindowPlacement): PlacedWindow {
  return {
    connectors: [connector],
    signature: windowSignature(w.id, w.url, w.zoom, [
      { connector, region: w.region, canvas: w.canvas },
    ]),
  };
}

describe("diffWindows", () => {
  test("first apply places everything, nothing to remove", () => {
    const w = win("content-web", "https://dash.example/");
    const { toPlace, toRemove } = diffWindows(new Map(), [
      { connector: "HDMI-1", windows: [w] },
    ]);
    expect(toPlace.map((p) => p.id)).toEqual(["content-web"]);
    expect(toPlace[0]!.connectors).toEqual(["HDMI-1"]);
    expect(toRemove).toEqual([]);
  });

  test("an unchanged window is never touched (no relaunch on a repeat apply)", () => {
    const w = win("content-web", "https://dash.example/");
    const current = new Map([["content-web", placed("HDMI-1", w)]]);
    const { toPlace, toRemove } = diffWindows(current, [
      { connector: "HDMI-1", windows: [w] },
    ]);
    expect(toPlace).toEqual([]);
    expect(toRemove).toEqual([]);
  });

  test("a changed url re-places the SAME id; a vanished window is removed", () => {
    const before = win("content-web", "https://old.example/");
    const current = new Map([
      ["content-web", placed("HDMI-1", before)],
      ["stale", placed("HDMI-2", win("stale", "https://gone.example/"))],
    ]);
    const { toPlace, toRemove } = diffWindows(current, [
      { connector: "HDMI-1", windows: [win("content-web", "https://new.example/")] },
      { connector: "HDMI-2", windows: [] },
    ]);
    expect(toPlace.map((p) => p.id)).toEqual(["content-web"]);
    expect(toRemove).toEqual(["stale"]);
  });

  test("a moved region re-places; a window absent from the whole apply is removed", () => {
    const before = win("content-web", "https://dash.example/", 0, 0);
    const current = new Map([["content-web", placed("HDMI-1", before)]]);
    const moved = win("content-web", "https://dash.example/", 960, 0);
    expect(diffWindows(current, [{ connector: "HDMI-1", windows: [moved] }]).toPlace).toHaveLength(1);
    // An apply with no windows anywhere retires the placed one.
    const gone = diffWindows(current, [{ connector: "HDMI-1", windows: [] }]);
    expect(gone.toPlace).toEqual([]);
    expect(gone.toRemove).toEqual(["content-web"]);
  });

  // POL-153 — a zoom change re-places the window (Chrome's device scale factor is a launch flag).
  test("a changed zoom re-places the same id", () => {
    const before = win("content-web", "https://dash.example/", 0, 0, 960, 540, 1);
    const current = new Map([["content-web", placed("HDMI-1", before)]]);
    const zoomed = win("content-web", "https://dash.example/", 0, 0, 960, 540, 1.5);
    const { toPlace } = diffWindows(current, [{ connector: "HDMI-1", windows: [zoomed] }]);
    expect(toPlace.map((p) => p.id)).toEqual(["content-web"]);
  });

  // POL-156 — a wall spanning two of ONE box's outputs stamps the SAME id on every member; the diff
  // collapses them into ONE placement covering every member connector, sorted.
  describe("single-box wall span", () => {
    const spanLeft = { ...win("wall:w1", "https://grafana.example/d/sin"), region: { x: 0, y: 0, w: 1920, h: 1080 } };
    const spanRight = { ...win("wall:w1", "https://grafana.example/d/sin"), region: { x: 0, y: 0, w: 1920, h: 1080 } };

    test("same window id on two connectors → one placement across both, connectors sorted", () => {
      const { toPlace } = diffWindows(new Map(), [
        { connector: "HDMI-A-1", windows: [spanRight] },
        { connector: "DP-1", windows: [spanLeft] },
      ]);
      expect(toPlace).toHaveLength(1);
      expect(toPlace[0]!.id).toBe("wall:w1");
      expect(toPlace[0]!.connectors).toEqual(["DP-1", "HDMI-A-1"]);
    });

    test("the span is stable across a repeat apply (order-insensitive), then re-places if it shrinks", () => {
      const first = diffWindows(new Map(), [
        { connector: "DP-1", windows: [spanLeft] },
        { connector: "HDMI-A-1", windows: [spanRight] },
      ]);
      const placedMap = new Map<string, PlacedWindow>([
        ["wall:w1", { connectors: first.toPlace[0]!.connectors, signature: first.toPlace[0]!.signature }],
      ]);
      // Same two members, opposite screen order in the apply → no-op.
      const repeat = diffWindows(placedMap, [
        { connector: "HDMI-A-1", windows: [spanRight] },
        { connector: "DP-1", windows: [spanLeft] },
      ]);
      expect(repeat.toPlace).toEqual([]);
      // The wall loses a member (now single-output) → the span changed, so it re-places.
      const shrunk = diffWindows(placedMap, [{ connector: "DP-1", windows: [spanLeft] }]);
      expect(shrunk.toPlace.map((p) => p.connectors)).toEqual([["DP-1"]]);
    });
  });
});

describe("regionToOutputRect", () => {
  const canvas = { x: 0, y: 0, w: 1920, h: 1080 };

  test("canvas == output mode: region maps 1:1, offset by the output's global position", () => {
    const rect = regionToOutputRect(
      { x: 960, y: 0, w: 960, h: 540 },
      canvas,
      { x: 1920, y: 0, width: 1920, height: 1080 },
    );
    expect(rect).toEqual({ x: 2880, y: 0, w: 960, h: 540 });
  });

  test("a 1080p canvas on a 4K output scales the region up 2×", () => {
    const rect = regionToOutputRect(
      { x: 480, y: 270, w: 960, h: 540 },
      canvas,
      { x: 0, y: 0, width: 3840, height: 2160 },
    );
    expect(rect).toEqual({ x: 960, y: 540, w: 1920, h: 1080 });
  });

  test("sizes never collapse below one pixel", () => {
    const rect = regionToOutputRect(
      { x: 0, y: 0, w: 1, h: 1 },
      { x: 0, y: 0, w: 10000, h: 10000 },
      { x: 0, y: 0, width: 100, height: 100 },
    );
    expect(rect.w).toBeGreaterThanOrEqual(1);
    expect(rect.h).toBeGreaterThanOrEqual(1);
  });

  // POL-150 — the whole-screen case is the reported bug: a full-canvas region must cover the output
  // EXACTLY (origin + full size), edge to edge, whatever the output's origin or resolution.
  test("a full-canvas region covers the whole output edge to edge (single screen at origin)", () => {
    const rect = regionToOutputRect(
      { x: 0, y: 0, w: 1920, h: 1080 },
      canvas,
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    expect(rect).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("a full-canvas region on a 4K output covers it edge to edge (scaled up, still origin 0,0)", () => {
    const rect = regionToOutputRect(
      { x: 0, y: 0, w: 1920, h: 1080 },
      canvas,
      { x: 0, y: 0, width: 3840, height: 2160 },
    );
    expect(rect).toEqual({ x: 0, y: 0, w: 3840, h: 2160 });
  });

  test("a full-canvas region lands at the output's own origin on a multi-output box", () => {
    // Screen 3 is the rightmost of three 1080p outputs: its rect origin is global (3840,0). The
    // window must cover THAT output exactly — origin at the output, size = the output — not (0,0).
    const rect = regionToOutputRect(
      { x: 0, y: 0, w: 1920, h: 1080 },
      canvas,
      { x: 3840, y: 0, width: 1920, height: 1080 },
    );
    expect(rect).toEqual({ x: 3840, y: 0, w: 1920, h: 1080 });
  });

  test("a right-half sub-region lands on that region's bounds within the output", () => {
    const rect = regionToOutputRect(
      { x: 960, y: 0, w: 960, h: 1080 },
      canvas,
      { x: 0, y: 0, width: 1920, height: 1080 },
    );
    expect(rect).toEqual({ x: 960, y: 0, w: 960, h: 1080 });
  });
});

// POL-156 — a single top-level window that fills a single-box wall covers the UNION (bounding box) of
// its member outputs in sway's global pixel space.
describe("spanningOutputRect", () => {
  test("two 1080p outputs side by side → the full 3840×1080, origin at the leftmost", () => {
    const outputs = new Map([
      ["DP-1", { x: 0, y: 0, width: 1920, height: 1080 }],
      ["HDMI-A-1", { x: 1920, y: 0, width: 1920, height: 1080 }],
    ]);
    expect(spanningOutputRect(["DP-1", "HDMI-A-1"], outputs)).toEqual({ x: 0, y: 0, w: 3840, h: 1080 });
  });

  test("a 2×1 wall whose left output is offset — union starts at the leftmost origin", () => {
    const outputs = new Map([
      ["DP-2", { x: 1920, y: 0, width: 1920, height: 1080 }],
      ["DP-3", { x: 3840, y: 0, width: 1920, height: 1080 }],
    ]);
    expect(spanningOutputRect(["DP-3", "DP-2"], outputs)).toEqual({ x: 1920, y: 0, w: 3840, h: 1080 });
  });

  test("a stacked (2 high) wall unions vertically too", () => {
    const outputs = new Map([
      ["DP-1", { x: 0, y: 0, width: 1920, height: 1080 }],
      ["DP-2", { x: 0, y: 1080, width: 1920, height: 1080 }],
    ]);
    expect(spanningOutputRect(["DP-1", "DP-2"], outputs)).toEqual({ x: 0, y: 0, w: 1920, h: 2160 });
  });

  test("throws when a member output has no known rect (cannot place a span it can't measure)", () => {
    const outputs = new Map([["DP-1", { x: 0, y: 0, width: 1920, height: 1080 }]]);
    expect(() => spanningOutputRect(["DP-1", "HDMI-A-1"], outputs)).toThrow(/HDMI-A-1/);
  });
});

describe("windowPlacementCommand", () => {
  // POL-150 — pin the FULL rect → swaymsg mapping, not just the pixel math: the window is relocated
  // to its target output, floated with no border, sized to the rect, and moved to the rect origin in
  // sway's global coordinate space. A full-output rect ⇒ edge-to-edge cover.
  test("a whole-screen rect floats + sizes + positions to cover the output exactly", () => {
    const cmd = windowPlacementCommand(42, "DP-3", { x: 0, y: 0, w: 1920, h: 1080 });
    expect(cmd).toBe(
      "[con_id=42] move container to output DP-3, floating enable, border none, " +
        "resize set width 1920 px height 1080 px, move absolute position 0 0",
    );
  });

  test("a sub-region rect positions at the region origin with the region's size", () => {
    const cmd = windowPlacementCommand(7, "HDMI-1", { x: 960, y: 0, w: 960, h: 540 });
    expect(cmd).toBe(
      "[con_id=7] move container to output HDMI-1, floating enable, border none, " +
        "resize set width 960 px height 540 px, move absolute position 960 0",
    );
  });

  // POL-156 — a UNION rect wider than the output it is parented to: a FLOATING window is not clipped
  // to that output, so sizing it 3840 wide and moving it to (0,0) spans both.
  test("a spanning union rect sizes the window across two outputs", () => {
    const cmd = windowPlacementCommand(9, "DP-1", { x: 0, y: 0, w: 3840, h: 1080 });
    expect(cmd).toBe(
      "[con_id=9] move container to output DP-1, floating enable, border none, " +
        "resize set width 3840 px height 1080 px, move absolute position 0 0",
    );
  });

  test("relocates to the target output so the float/resize applies in that output's context", () => {
    const cmd = windowPlacementCommand(1, "DP-2", { x: 1920, y: 0, w: 1920, h: 1080 });
    expect(cmd.startsWith("[con_id=1] move container to output DP-2, floating enable")).toBe(true);
    expect(cmd.endsWith("move absolute position 1920 0")).toBe(true);
  });
});

// POL-152 — the self-verifying place loop: read the window's ACTUAL geometry back and retry until it
// matches the target. These pin the two pure pieces that loop is built from.
describe("geometryMatches", () => {
  test("exact match", () => {
    expect(geometryMatches({ x: 0, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 })).toBe(true);
  });

  test("within a 2px tolerance is a match (sway rounds a floating window a pixel or two)", () => {
    expect(geometryMatches({ x: 1, y: 0, w: 1919, h: 1081 }, { x: 0, y: 0, w: 1920, h: 1080 })).toBe(true);
  });

  test("the reported flake — a half-width window — is NOT a match, so the loop retries", () => {
    // Landed on the right HALF of a 1920 output instead of covering it: this is exactly the POL-152
    // symptom the read-back must reject.
    expect(geometryMatches({ x: 960, y: 0, w: 960, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 })).toBe(false);
  });

  test("a window that landed on the WRONG output is not a match", () => {
    expect(geometryMatches({ x: 1920, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 })).toBe(false);
  });

  test("a custom tolerance is honoured", () => {
    expect(geometryMatches({ x: 5, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 }, 5)).toBe(true);
    expect(geometryMatches({ x: 6, y: 0, w: 1920, h: 1080 }, { x: 0, y: 0, w: 1920, h: 1080 }, 5)).toBe(false);
  });
});

describe("findConRect", () => {
  // A trimmed sway `get_tree`: a workspace with one tiled node (the player) and one floating node
  // (the web-window we placed) — the shape the read-back walks.
  const tree = {
    id: 1,
    rect: { x: 0, y: 0, width: 3840, height: 1080 },
    nodes: [
      {
        id: 2,
        rect: { x: 0, y: 0, width: 1920, height: 1080 },
        nodes: [{ id: 10, rect: { x: 0, y: 0, width: 1920, height: 1080 }, nodes: [] }],
        floating_nodes: [
          { id: 42, rect: { x: 0, y: 0, width: 3840, height: 1080 }, nodes: [], floating_nodes: [] },
        ],
      },
    ],
  };

  test("finds a floating window's rect deep in the tree", () => {
    expect(findConRect(tree, 42)).toEqual({ x: 0, y: 0, w: 3840, h: 1080 });
  });

  test("finds a tiled node's rect too", () => {
    expect(findConRect(tree, 10)).toEqual({ x: 0, y: 0, w: 1920, h: 1080 });
  });

  test("an id not in the tree (vanished / raced) is null", () => {
    expect(findConRect(tree, 999)).toBeNull();
  });

  test("a garbage tree is null, never a throw", () => {
    expect(findConRect(null, 1)).toBeNull();
    expect(findConRect("nope", 1)).toBeNull();
    expect(findConRect({ id: 1 }, 1)).toBeNull(); // present but no usable rect
  });
});

describe("windowSignature", () => {
  test("is order-insensitive across the members of a span", () => {
    const region = { x: 0, y: 0, w: 1920, h: 1080 };
    const canvas = { x: 0, y: 0, w: 1920, h: 1080 };
    const a = windowSignature("wall:w1", "https://x/", 1, [
      { connector: "DP-1", region, canvas },
      { connector: "HDMI-A-1", region, canvas },
    ]);
    const b = windowSignature("wall:w1", "https://x/", 1, [
      { connector: "HDMI-A-1", region, canvas },
      { connector: "DP-1", region, canvas },
    ]);
    expect(a).toBe(b);
  });

  test("changes on url, zoom, or member set", () => {
    const region = { x: 0, y: 0, w: 1920, h: 1080 };
    const canvas = { x: 0, y: 0, w: 1920, h: 1080 };
    const base = windowSignature("w", "https://x/", 1, [{ connector: "DP-1", region, canvas }]);
    expect(windowSignature("w", "https://y/", 1, [{ connector: "DP-1", region, canvas }])).not.toBe(base);
    expect(windowSignature("w", "https://x/", 1.5, [{ connector: "DP-1", region, canvas }])).not.toBe(base);
    expect(
      windowSignature("w", "https://x/", 1, [
        { connector: "DP-1", region, canvas },
        { connector: "DP-2", region, canvas },
      ]),
    ).not.toBe(base);
  });
});

describe("buildChromeWindowArgs", () => {
  const env = { XDG_RUNTIME_DIR: "/run/user/1000" } as NodeJS.ProcessEnv;

  test("a placed window is an --app window with its own profile — and NEVER --kiosk", () => {
    const args = buildChromeWindowArgs(
      { url: "https://dash.example/d/abc", windowId: "content-web", devtoolsPort: 9321 },
      env,
    );
    expect(args).toContain("--ozone-platform=wayland");
    expect(args).toContain("--app=https://dash.example/d/abc");
    expect(args).toContain(`--user-data-dir=${chromeWindowDataDir("content-web", env)}`);
    expect(args).toContain("--remote-debugging-port=9321");
    // The one thing that must differ from the player's launch: kiosk would fullscreen the window
    // over the whole output, defeating the region placement.
    expect(args).not.toContain("--kiosk");
  });

  test("the window profile dir differs from any connector's player profile dir", () => {
    // A window id can collide textually with a connector name; the "win-" prefix keeps the
    // profile (and the stale-reap token) distinct from the player's.
    expect(chromeWindowDataDir("HDMI-1", env)).toBe("/run/user/1000/polyptic-chrome-win-HDMI-1");
    expect(chromeWindowDataDir("HDMI-1", env)).not.toBe(
      "/run/user/1000/polyptic-chrome-HDMI-1",
    );
  });
});
