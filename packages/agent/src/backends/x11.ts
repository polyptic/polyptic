/**
 * x11-i3 — the real X11 placement backend (D9 fallback for hosts where Wayland misbehaves,
 * e.g. some NVIDIA + wlroots combos — see docs/ARCHITECTURE.md "Gotchas").
 *
 * Phase 4. Replaces the throwing stub. Under X11 a client CAN self-position, so we launch
 * Chromium with `--class=polyptych-<connector>` + `--window-position/-size` matching the
 * output's geometry, then defensively re-place it with `xdotool`/`wmctrl` once the window is
 * mapped (and assert EWMH fullscreen on the correct monitor). Geometry comes from `xrandr`,
 * capture from ImageMagick `import` (→ JPEG on stdout) or `scrot`.
 *
 * Works under i3 or any EWMH-compliant window manager — we don't depend on i3 IPC, only on the
 * standard window-control tools, so the backend stays generic.
 */
import type { ChildProcess } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DisplayBackend } from "./types";
import {
  buildChromiumArgs,
  ensureDir,
  killStaleForProfile,
  profileDirFor,
  resetCrashFlags,
  resolveChromium,
  sanitizeConnector,
  SupervisedChromium,
} from "./chromium";
import { captureStdout, delay, run, spawnChild, which } from "./proc";

/** How long to wait for the freshly-launched Chromium window to be mapped + named. */
const PLACE_TIMEOUT_MS = 8_000;
const WINDOW_POLL_MS = 150;

function ts(): string {
  return new Date().toISOString();
}

/** A connected+enabled output's geometry, in root-window pixels. */
export interface OutputGeometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Parse `xrandr --query` for `connector`'s active geometry (`WxH+X+Y`). Returns `null` if the
 * connector is absent or connected-but-disabled (no mode → nothing to place onto).
 */
export function parseXrandrGeometry(xrandr: string, connector: string): OutputGeometry | null {
  for (const line of xrandr.split("\n")) {
    if (!line.startsWith(`${connector} `)) continue;
    if (!/\bconnected\b/.test(line)) return null; // disconnected
    const m = line.match(/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/);
    if (!m) return null; // connected but no active mode
    return {
      w: Number(m[1] ?? 0),
      h: Number(m[2] ?? 0),
      x: Number(m[3] ?? 0),
      y: Number(m[4] ?? 0),
    };
  }
  return null;
}

export class X11Backend implements DisplayBackend {
  readonly id = "x11-i3" as const;

  private readonly browsers = new Map<string, SupervisedChromium>();
  private chromiumPath: string | null = null;

  private log(msg: string): void {
    console.log(`[${ts()}] [x11] ${msg}`);
  }

  private async ensureChromium(): Promise<string> {
    if (this.chromiumPath) return this.chromiumPath;
    this.chromiumPath = await resolveChromium();
    return this.chromiumPath;
  }

  /** Resolve `connector`'s geometry via `xrandr`, or throw a clear error. */
  private async geometryFor(connector: string): Promise<OutputGeometry> {
    const res = await run("xrandr", ["--query"]);
    if (res.code !== 0) {
      throw new Error(
        `xrandr --query failed: ${res.stderr.trim() || `exit ${res.code}`} ` +
          `(is X running and DISPLAY set for this process?)`,
      );
    }
    const geom = parseXrandrGeometry(res.stdout, connector);
    if (!geom) {
      throw new Error(
        `connector "${connector}" not found as a connected, enabled output in xrandr`,
      );
    }
    return geom;
  }

  /** Find the mapped window for `className`, preferring the one whose pid matches our child. */
  private async findWindow(className: string, pid: number, timeoutMs: number): Promise<string> {
    const hasXdotool = await which("xdotool");
    const hasWmctrl = await which("wmctrl");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (hasXdotool) {
        const res = await run("xdotool", ["search", "--class", className]);
        if (res.code === 0) {
          const ids = res.stdout.split(/\s+/).filter(Boolean);
          if (pid > 0) {
            for (const id of ids) {
              const pidRes = await run("xdotool", ["getwindowpid", id]);
              if (pidRes.code === 0 && pidRes.stdout.trim() === String(pid)) return id;
            }
          }
          const first = ids[0];
          if (first) return first;
        }
      } else if (hasWmctrl) {
        const res = await run("wmctrl", ["-lx"]);
        if (res.code === 0) {
          const line = res.stdout
            .split("\n")
            .find((l) => l.toLowerCase().includes(className.toLowerCase()));
          const wid = line?.split(/\s+/)[0];
          if (wid) return wid;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`no window with class ${className} appeared within ${timeoutMs}ms`);
      }
      await delay(WINDOW_POLL_MS);
    }
  }

  /** Reposition+resize the window to the output, then assert EWMH fullscreen there. */
  private async placeWindow(wid: string, geom: OutputGeometry): Promise<void> {
    const hasXdotool = await which("xdotool");
    const hasWmctrl = await which("wmctrl");
    // Drop fullscreen so the WM lets us move/size the window onto the target output.
    if (hasWmctrl) await run("wmctrl", ["-i", "-r", wid, "-b", "remove,fullscreen"]);
    if (hasXdotool) {
      await run("xdotool", ["windowmove", wid, String(geom.x), String(geom.y)]);
      await run("xdotool", ["windowsize", wid, String(geom.w), String(geom.h)]);
    } else if (hasWmctrl) {
      // wmctrl -e: gravity,x,y,w,h
      await run("wmctrl", ["-i", "-r", wid, "-e", `0,${geom.x},${geom.y},${geom.w},${geom.h}`]);
    }
    // Re-assert fullscreen; the window now lives on the target monitor so the WM fullscreens it
    // there. Without wmctrl we rely on Chromium's own `--kiosk` fullscreen after the move.
    if (hasWmctrl) await run("wmctrl", ["-i", "-r", wid, "-b", "add,fullscreen"]);
  }

  private async launchAndPlace(
    connector: string,
    chromium: string,
    profileDir: string,
    className: string,
    url: string,
  ): Promise<ChildProcess> {
    const geom = await this.geometryFor(connector);
    await ensureDir(profileDir);
    await killStaleForProfile(profileDir, (m) => this.log(m));
    await resetCrashFlags(profileDir, (m) => this.log(m));

    const args = buildChromiumArgs({
      url,
      profileDir,
      platform: "x11",
      scaleFactor: 1,
      className,
      position: { x: geom.x, y: geom.y },
      size: { w: geom.w, h: geom.h },
    });
    const child = spawnChild(chromium, args, { stdio: "ignore" });
    this.log(`spawned Chromium pid=${child.pid ?? "?"} class=${className} for ${connector} → ${url}`);

    // Best-effort defensive placement (Chromium's launch flags usually suffice; this corrects
    // misplacement without ever failing the launch).
    try {
      const wid = await this.findWindow(className, child.pid ?? -1, PLACE_TIMEOUT_MS);
      await this.placeWindow(wid, geom);
      this.log(
        `placed window ${wid} on ${connector} @ ${geom.w}x${geom.h}+${geom.x}+${geom.y}`,
      );
    } catch (err) {
      this.log(`placement on ${connector} failed: ${(err as Error).message} (relying on launch flags)`);
    }
    return child;
  }

  private ensureBrowser(connector: string, chromium: string): SupervisedChromium {
    let b = this.browsers.get(connector);
    if (!b) {
      const profileDir = profileDirFor(connector);
      const className = `polyptych-${sanitizeConnector(connector)}`;
      b = new SupervisedChromium(
        connector,
        (url) => this.launchAndPlace(connector, chromium, profileDir, className, url),
        (m) => this.log(m),
      );
      this.browsers.set(connector, b);
    }
    return b;
  }

  async showScreen(connector: string, url: string): Promise<void> {
    const chromium = await this.ensureChromium();
    await requireX11Tools();
    // Validate the connector eagerly so a bad name fails before we spawn anything.
    await this.geometryFor(connector);
    const browser = this.ensureBrowser(connector, chromium);
    await browser.setUrl(url);
  }

  async hideScreen(connector: string): Promise<void> {
    const browser = this.browsers.get(connector);
    if (!browser) {
      this.log(`hideScreen(${connector}): nothing placed`);
      return;
    }
    await browser.stop();
    this.browsers.delete(connector);
    this.log(`hideScreen(${connector}): torn down`);
  }

  async ident(on: boolean): Promise<void> {
    this.log(`ident ${on ? "on" : "off"} — visible ident is server→player; agent no-op`);
  }

  /** Crop the output's region out of the root window via ImageMagick `import`, else `scrot`. */
  async capture(connector: string): Promise<Buffer | null> {
    let geom: OutputGeometry;
    try {
      geom = await this.geometryFor(connector);
    } catch (err) {
      this.log(`capture(${connector}): ${(err as Error).message}`);
      return null;
    }
    const crop = `${geom.w}x${geom.h}+${geom.x}+${geom.y}`;

    // Preferred: ImageMagick import → JPEG on stdout (matches the agent's image/jpeg framing).
    if (await which("import")) {
      const buf = await captureStdout("import", [
        "-silent",
        "-window",
        "root",
        "-crop",
        crop,
        "+repage",
        "jpeg:-",
      ]);
      if (buf) return buf;
    }

    // Fallback: scrot grabs the area to a temp file (no stdout mode), which we read then remove.
    if (await which("scrot")) {
      const tmp = join(tmpdir(), `polyptych-${sanitizeConnector(connector)}-${Date.now()}.png`);
      const res = await run("scrot", ["-o", "-a", `${geom.x},${geom.y},${geom.w},${geom.h}`, tmp]);
      if (res.code === 0) {
        try {
          return await readFile(tmp);
        } catch (err) {
          this.log(`capture(${connector}): could not read scrot output: ${(err as Error).message}`);
        } finally {
          try {
            await unlink(tmp);
          } catch {
            // best-effort cleanup
          }
        }
      }
    }

    this.log(`capture(${connector}): neither ImageMagick 'import' nor 'scrot' succeeded`);
    return null;
  }
}

/** Assert the X11 placement tool-chain is present (Chromium + xrandr + a window controller). */
async function requireX11Tools(): Promise<void> {
  if (!(await which("xrandr"))) {
    throw new Error(
      "xrandr not found — the x11-i3 backend needs an X server and xrandr on PATH " +
        "(see docs/DEPLOY.md / `polyptych-agent setup`)",
    );
  }
  if (!(await which("xdotool")) && !(await which("wmctrl"))) {
    throw new Error(
      "neither xdotool nor wmctrl found — the x11-i3 backend needs one to place windows " +
        "(see docs/DEPLOY.md / `polyptych-agent setup`)",
    );
  }
}
