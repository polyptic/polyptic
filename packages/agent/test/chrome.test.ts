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
  chromeDataDir,
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
