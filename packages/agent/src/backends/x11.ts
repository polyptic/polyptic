/**
 * x11-i3 — the real X11 placement backend (D9 fallback for hosts where Wayland misbehaves,
 * e.g. some NVIDIA + wlroots combos — see docs/ARCHITECTURE.md "Gotchas").
 *
 * Phase 4. Replaces the throwing stub. Under X11 a client CAN self-position, so we launch
 * Chromium with `--class=polyptic-<connector>` + `--window-position/-size` matching the
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
import type { Browser } from "./browser";
import { profileDirFor, sanitizeConnector, SupervisedChromium } from "./chromium";
import { selectBrowser } from "./browser";
import { captureStdout, delay, run, spawnChild, which } from "./proc";

/** How long to wait for the freshly-launched browser window to be mapped + named. */
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

/**
 * Names of the connected, enabled outputs (those with an active mode) in `xrandr --query`.
 * Used by the single-output fallback to find the sole real output when the requested connector
 * name doesn't match.
 */
export function parseXrandrOutputs(xrandr: string): string[] {
  const names: string[] = [];
  for (const line of xrandr.split("\n")) {
    const m = line.match(/^(\S+) connected\b/);
    if (!m || !m[1]) continue;
    if (!/(\d+)x(\d+)\+(-?\d+)\+(-?\d+)/.test(line)) continue; // connected but no active mode
    names.push(m[1]);
  }
  return names;
}

export class X11Backend implements DisplayBackend {
  readonly id = "x11-i3" as const;

  private readonly browsers = new Map<string, SupervisedChromium>();

  /** The kiosk browser (chromium default, or cog via POLYPTIC_BROWSER=cog). */
  private readonly browser: Browser = selectBrowser();
  private browserBin: string | null = null;

  /** Latched once neither `import` nor `scrot` is found, so we log the hint once and then skip. */
  private captureUnavailable = false;

  private log(msg: string): void {
    console.log(`[${ts()}] [x11] ${msg}`);
  }

  private async ensureBin(): Promise<string> {
    if (this.browserBin) return this.browserBin;
    this.browserBin = await this.browser.resolveBin();
    return this.browserBin;
  }

  /**
   * Real output names as reported by X (`xrandr --query`): the connected outputs with an active
   * mode, for the agent to advertise on `agent/hello`. Returns the names (possibly `[]` if X is up
   * but nothing is enabled yet — the caller may retry), or `null` if xrandr is unavailable / errors.
   */
  async discoverOutputs(): Promise<string[] | null> {
    if (!(await which("xrandr"))) return null;
    const res = await run("xrandr", ["--query"]);
    if (res.code !== 0) {
      this.log(`discoverOutputs: xrandr --query failed: ${res.stderr.trim() || `exit ${res.code}`}`);
      return null;
    }
    return parseXrandrOutputs(res.stdout);
  }

  /**
   * Resolve the requested `connector` to a real X11 output + its geometry via `xrandr`.
   * Exact matches pass through. For a single-output host (e.g. QEMU/virtio-gpu where the agent
   * advertised "HDMI-1" but the only enabled output is "Virtual-1"), fall back to that sole
   * output so the kiosk still renders despite the name mismatch. With 2+ outputs an exact match
   * is still required, and 0 enabled outputs still errors.
   */
  private async resolveConnector(
    connector: string,
  ): Promise<{ name: string; geom: OutputGeometry }> {
    const res = await run("xrandr", ["--query"]);
    if (res.code !== 0) {
      throw new Error(
        `xrandr --query failed: ${res.stderr.trim() || `exit ${res.code}`} ` +
          `(is X running and DISPLAY set for this process?)`,
      );
    }
    const geom = parseXrandrGeometry(res.stdout, connector);
    if (geom) return { name: connector, geom };

    const outputs = parseXrandrOutputs(res.stdout);
    if (outputs.length === 1 && outputs[0]) {
      const soleGeom = parseXrandrGeometry(res.stdout, outputs[0]);
      if (soleGeom) {
        this.log(
          `connector "${connector}" not among xrandr outputs [${outputs.join(", ")}]; ` +
            `using the sole output "${outputs[0]}"`,
        );
        return { name: outputs[0], geom: soleGeom };
      }
    }
    throw new Error(
      `connector "${connector}" not found as a connected, enabled output in xrandr ` +
        `[${outputs.join(", ") || "none"}]`,
    );
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
    bin: string,
    profileDir: string,
    className: string,
    url: string,
  ): Promise<ChildProcess> {
    // `target` may differ from the requested `connector` under the single-output fallback; X11
    // placement is geometric, so we just use the resolved output's geometry.
    const { name: target, geom } = await this.resolveConnector(connector);
    await this.browser.prelaunch(profileDir, url, (m) => this.log(m));

    const args = this.browser.buildArgs({
      url,
      profileDir,
      platform: "x11",
      scaleFactor: 1,
      className,
      position: { x: geom.x, y: geom.y },
      size: { w: geom.w, h: geom.h },
    });
    const child = spawnChild(bin, args, { stdio: "ignore" });
    this.log(`spawned ${this.browser.name} pid=${child.pid ?? "?"} class=${className} for ${target} → ${url}`);

    // Best-effort defensive placement (Chromium's launch flags usually suffice; this corrects
    // misplacement without ever failing the launch).
    try {
      const wid = await this.findWindow(className, child.pid ?? -1, PLACE_TIMEOUT_MS);
      await this.placeWindow(wid, geom);
      this.log(
        `placed window ${wid} on ${target} @ ${geom.w}x${geom.h}+${geom.x}+${geom.y}`,
      );
    } catch (err) {
      this.log(`placement on ${target} failed: ${(err as Error).message} (relying on launch flags)`);
    }
    return child;
  }

  private ensureBrowser(connector: string, bin: string): SupervisedChromium {
    let b = this.browsers.get(connector);
    if (!b) {
      const profileDir = profileDirFor(connector);
      const className = `polyptic-${sanitizeConnector(connector)}`;
      b = new SupervisedChromium(
        connector,
        (url) => this.launchAndPlace(connector, bin, profileDir, className, url),
        (m) => this.log(m),
      );
      this.browsers.set(connector, b);
    }
    return b;
  }

  async showScreen(connector: string, url: string): Promise<void> {
    const bin = await this.ensureBin();
    await requireX11Tools();
    // Resolve the connector eagerly (with the single-output fallback) so a bad name fails before
    // we spawn anything.
    await this.resolveConnector(connector);
    const supervised = this.ensureBrowser(connector, bin);
    await supervised.setUrl(url);
  }

  async hideScreen(connector: string): Promise<void> {
    const supervised = this.browsers.get(connector);
    if (!supervised) {
      this.log(`hideScreen(${connector}): nothing placed`);
      return;
    }
    await supervised.stop();
    this.browsers.delete(connector);
    this.log(`hideScreen(${connector}): torn down`);
  }

  async ident(on: boolean): Promise<void> {
    this.log(`ident ${on ? "on" : "off"} — visible ident is server→player; agent no-op`);
  }

  /** Crop the output's region out of the root window via ImageMagick `import`, else `scrot`. */
  async capture(connector: string): Promise<Buffer | null> {
    if (this.captureUnavailable) return null;

    const hasImport = await which("import");
    const hasScrot = await which("scrot");
    if (!hasImport && !hasScrot) {
      this.captureUnavailable = true;
      this.log(
        "capture: neither ImageMagick 'import' nor 'scrot' installed — preview thumbnails disabled; install one to enable",
      );
      return null;
    }

    let geom: OutputGeometry;
    try {
      geom = (await this.resolveConnector(connector)).geom;
    } catch (err) {
      this.log(`capture(${connector}): ${(err as Error).message}`);
      return null;
    }
    const crop = `${geom.w}x${geom.h}+${geom.x}+${geom.y}`;

    // Preferred: ImageMagick import → JPEG on stdout (matches the agent's image/jpeg framing).
    if (hasImport) {
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
    if (hasScrot) {
      const tmp = join(tmpdir(), `polyptic-${sanitizeConnector(connector)}-${Date.now()}.png`);
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
        "(see docs/DEPLOY.md / `polyptic-agent setup`)",
    );
  }
  if (!(await which("xdotool")) && !(await which("wmctrl"))) {
    throw new Error(
      "neither xdotool nor wmctrl found — the x11-i3 backend needs one to place windows " +
        "(see docs/DEPLOY.md / `polyptic-agent setup`)",
    );
  }
}
