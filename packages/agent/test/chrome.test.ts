/**
 * Chrome argv + browser selection (POL-67/D77).
 *
 * Things worth pinning, because getting them wrong is silent on a wall:
 *   - `--ozone-platform=wayland` is the whole point (native Wayland = GPU without Xwayland/DRI3);
 *     losing it silently reintroduces the CPU-pegging software-render path this ticket exists for.
 *   - one `--user-data-dir` PER CONNECTOR: with a shared dir Chrome dedupes into one process and
 *     the second output never gets a browser — and (Chrome 136+) the debugging port is refused on
 *     the default dir entirely.
 *   - the DevTools port must ride every launch (Chrome takes it only at startup).
 *   - selection: POLYPTIC_BROWSER wins; else Chrome-if-installed, surf otherwise.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildChromeArgs,
  buildChromeWindowArgs,
  chromeDataDir,
  chromeWindowDataDir,
  insecurePlayerOrigin,
  matchesChromeWindow,
  selectKioskBrowser,
} from "../src/backends/chrome";

const URL = "http://localhost:5173/player?screen=screen-1";
const ENV = { XDG_RUNTIME_DIR: "/run/user/1000" };

describe("buildChromeArgs", () => {
  const args = buildChromeArgs({ url: URL, connector: "DP-1", devtoolsPort: 9222 }, ENV);

  test("runs native Wayland — the flag this ticket exists for", () => {
    expect(args).toContain("--ozone-platform=wayland");
  });

  test("kiosk + --app carry the URL (no positional argument)", () => {
    expect(args).toContain("--kiosk");
    expect(args).toContain(`--app=${URL}`);
    expect(args.filter((a) => !a.startsWith("-"))).toHaveLength(0);
  });

  test("a per-connector user-data-dir isolates instances and keys the reaper", () => {
    expect(args).toContain(`--user-data-dir=/run/user/1000/polyptic-chrome-DP-1`);
    const other = buildChromeArgs({ url: URL, connector: "HDMI-A-2", devtoolsPort: 9223 }, ENV);
    expect(other).toContain(`--user-data-dir=/run/user/1000/polyptic-chrome-HDMI-A-2`);
  });

  test("the DevTools port rides every launch", () => {
    expect(args).toContain("--remote-debugging-port=9222");
  });

  test("POLYPTIC_BROWSER_ARGS is appended last, so it can override", () => {
    const withExtra = buildChromeArgs(
      { url: URL, connector: "DP-1", devtoolsPort: 9222 },
      { ...ENV, POLYPTIC_BROWSER_ARGS: "--force-dark-mode" },
    );
    expect(withExtra.at(-1)).toBe("--force-dark-mode");
  });

  test("chromeDataDir sanitises hostile connector names and falls back to /tmp", () => {
    expect(chromeDataDir("DP 1/../x", {})).toBe("/tmp/polyptic-chrome-DP_1_.._x");
  });

  // POL-132 — the shell service worker (reload-survives-outage) needs a secure context, and netboot
  // walls speak plain HTTP to the control plane by design (D47/D52). Exactly the player's own origin
  // is exempted — and ONLY for http; an https deploy must not grow a needless security carve-out.
  test("an http player origin is treated as secure so the shell service worker can register", () => {
    expect(args).toContain("--unsafely-treat-insecure-origin-as-secure=http://localhost:5173");
  });

  test("an https player URL gets no insecure-origin exemption", () => {
    const httpsArgs = buildChromeArgs(
      { url: "https://walls.example.org/player/?screen=s1", connector: "DP-1", devtoolsPort: 9222 },
      ENV,
    );
    expect(httpsArgs.some((a) => a.startsWith("--unsafely-treat-insecure-origin-as-secure"))).toBe(false);
  });

  test("insecurePlayerOrigin: http origin extracted, https/garbage → null", () => {
    expect(insecurePlayerOrigin("http://10.0.0.5:8080/player/?screen=s1")).toBe("http://10.0.0.5:8080");
    expect(insecurePlayerOrigin("https://walls.example.org/player/")).toBeNull();
    expect(insecurePlayerOrigin("not a url")).toBeNull();
  });
});

// POL-146 — the placed WEB-WINDOW (POL-18) is a SECOND Chrome the sway backend floats over the
// player. On real amdgpu, a window that software-rendered while the player ran on the GPU comes up
// BLACK — so it must carry the exact same GPU/native-Wayland launch posture as the player. These
// pin the flags that decide GPU-vs-software render so the two builders can never drift apart.
describe("buildChromeWindowArgs (POL-18 web-window)", () => {
  const args = buildChromeWindowArgs({ url: URL, windowId: "surface-7", devtoolsPort: 9230 }, ENV);

  test("runs native Wayland, same as the player — the flag that keeps it off the black software path", () => {
    expect(args).toContain("--ozone-platform=wayland");
  });

  test("carries the URL via --app, never a positional argument", () => {
    expect(args).toContain(`--app=${URL}`);
    expect(args.filter((a) => !a.startsWith("-"))).toHaveLength(0);
  });

  test("is NOT kiosk — it must stay a positionable floating surface", () => {
    expect(args).not.toContain("--kiosk");
  });

  test("a per-window user-data-dir isolates it from the player and every sibling window", () => {
    expect(args).toContain(`--user-data-dir=${chromeWindowDataDir("surface-7", ENV)}`);
    // Distinct from the player's connector-keyed dir → a separate process, its own GPU context.
    const playerDir = chromeDataDir("DP-1", ENV);
    expect(args).not.toContain(`--user-data-dir=${playerDir}`);
  });

  test("the DevTools port rides the launch (Chrome takes it only at startup)", () => {
    expect(args).toContain("--remote-debugging-port=9230");
  });

  test("shares the player's GPU/hygiene base flag-for-flag (only --kiosk / secure-origin differ)", () => {
    const playerArgs = buildChromeArgs({ url: URL, connector: "DP-1", devtoolsPort: 9230 }, ENV);
    // Everything except --kiosk, the per-instance data dir, and the player-only http exemption must
    // be identical — that shared spine is what guarantees the window renders on the GPU like the player.
    const strip = (a: string[]): string[] =>
      a.filter(
        (f) =>
          f !== "--kiosk" &&
          !f.startsWith("--user-data-dir=") &&
          !f.startsWith("--unsafely-treat-insecure-origin-as-secure="),
      );
    expect(strip(args)).toEqual(strip(playerArgs));
  });

  test("POLYPTIC_BROWSER_ARGS is appended last so a lab escape hatch can override", () => {
    const withExtra = buildChromeWindowArgs(
      { url: URL, windowId: "surface-7", devtoolsPort: 9230 },
      { ...ENV, POLYPTIC_BROWSER_ARGS: "--force-dark-mode" },
    );
    expect(withExtra.at(-1)).toBe("--force-dark-mode");
  });

  // POL-153 — the player scales an IFRAME surface by its zoom, but a web-window is a separate Chrome the
  // player never renders, so the agent must zoom it itself. Chrome's device scale factor is the launch
  // flag that makes a --app window render the whole page bigger, matching the iframe path.
  test("a zoom carries onto Chrome as --force-device-scale-factor", () => {
    const zoomed = buildChromeWindowArgs(
      { url: URL, windowId: "surface-7", devtoolsPort: 9230, zoom: 1.5 },
      ENV,
    );
    expect(zoomed).toContain("--force-device-scale-factor=1.5");
  });

  test("zoom 1 (or absent) adds NO scale flag — an unzoomed window's argv is unchanged", () => {
    const unity = buildChromeWindowArgs(
      { url: URL, windowId: "surface-7", devtoolsPort: 9230, zoom: 1 },
      ENV,
    );
    expect(unity.some((a) => a.startsWith("--force-device-scale-factor"))).toBe(false);
    expect(unity).toEqual(args); // identical to the no-zoom build above
  });
});

describe("matchesChromeWindow", () => {
  test("accepts Chrome's native-Wayland app ids, rejects others", () => {
    expect(matchesChromeWindow("google-chrome")).toBe(true);
    expect(matchesChromeWindow("Google-chrome")).toBe(true);
    expect(matchesChromeWindow("chrome-localhost__-Default")).toBe(true);
    expect(matchesChromeWindow("chromium")).toBe(true);
    expect(matchesChromeWindow("surf")).toBe(false);
    expect(matchesChromeWindow("firefox")).toBe(false);
  });
});

describe("selectKioskBrowser", () => {
  test("POLYPTIC_BROWSER forces the choice, installed or not", async () => {
    expect(await selectKioskBrowser({ POLYPTIC_BROWSER: "surf", PATH: "" })).toBe("surf");
    expect(await selectKioskBrowser({ POLYPTIC_BROWSER: "chrome", PATH: "" })).toBe("chrome");
  });

  test("an unknown POLYPTIC_BROWSER throws instead of silently falling back", async () => {
    await expect(selectKioskBrowser({ POLYPTIC_BROWSER: "netscape", PATH: "" })).rejects.toThrow(
      /POLYPTIC_BROWSER/,
    );
  });

  test("picks chrome when a candidate is on PATH, surf otherwise", async () => {
    const bin = mkdtempSync(join(tmpdir(), "polyptic-chrome-test-"));
    writeFileSync(join(bin, "google-chrome-stable"), "#!/bin/sh\n");
    chmodSync(join(bin, "google-chrome-stable"), 0o755);
    expect(await selectKioskBrowser({ PATH: bin })).toBe("chrome");
    expect(await selectKioskBrowser({ PATH: "/nonexistent" })).toBe("surf");
  });
});
