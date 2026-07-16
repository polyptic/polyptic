/**
 * POL-18 — agent-side web-window helpers: the apply-payload diff that decides which windows to
 * (re)place/tear down, the canvas → output pixel mapping the sway backend positions with, and the
 * Chrome argv a placed window launches with. All pure — no compositor, no browser.
 */
import { describe, expect, test } from "bun:test";

import type { WindowPlacement } from "@polyptic/protocol";
import {
  diffWindows,
  regionToOutputRect,
  windowPlacementCommand,
  windowSignature,
} from "../src/windows";
import type { PlacedWindow } from "../src/windows";
import { buildChromeWindowArgs, chromeWindowDataDir } from "../src/backends/chrome";

function win(id: string, url: string, x = 0, y = 0, w = 960, h = 540): WindowPlacement {
  return {
    id,
    url,
    region: { x, y, w, h },
    canvas: { x: 0, y: 0, w: 1920, h: 1080 },
  };
}

function placed(connector: string, w: WindowPlacement): PlacedWindow {
  return { connector, signature: windowSignature(connector, w) };
}

describe("diffWindows", () => {
  test("first apply places everything, nothing to remove", () => {
    const w = win("content-web", "https://dash.example/");
    const { toPlace, toRemove } = diffWindows(new Map(), [
      { connector: "HDMI-1", windows: [w] },
    ]);
    expect(toPlace.map((p) => p.window.id)).toEqual(["content-web"]);
    expect(toPlace[0]!.connector).toBe("HDMI-1");
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
    expect(toPlace.map((p) => p.window.id)).toEqual(["content-web"]);
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

  test("relocates to the target output so the float/resize applies in that output's context", () => {
    // The container is re-parented to its output BEFORE floating — the POL-150 origin-offset fix.
    const cmd = windowPlacementCommand(1, "DP-2", { x: 1920, y: 0, w: 1920, h: 1080 });
    expect(cmd.startsWith("[con_id=1] move container to output DP-2, floating enable")).toBe(true);
    expect(cmd.endsWith("move absolute position 1920 0")).toBe(true);
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
