/**
 * x11-i3 — the real X11 placement backend (D9 fallback for hosts where Wayland misbehaves,
 * e.g. some NVIDIA + wlroots combos — see docs/ARCHITECTURE.md "Gotchas").
 *
 * Phase 4. surf has no self-positioning flags (it is chromeless by design), so placement here is
 * entirely external: launch it, find its window by pid, then move/size it onto the output's geometry
 * with `xdotool`/`wmctrl` and assert EWMH fullscreen there. Geometry comes from `xrandr`, capture
 * from ImageMagick `import` (→ JPEG on stdout) or `scrot`.
 *
 * Works under i3 or any EWMH-compliant window manager — we don't depend on i3 IPC, only on the
 * standard window-control tools, so the backend stays generic.
 */
import type { ChildProcess } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PanelPowerMethod, PowerCapabilities } from "@polyptic/protocol";
import type { DisplayBackend } from "./types";
import { PanelPower, x11DpmsCommands } from "./power";
import { openInspectorOnFocusedWindow, requireXdotool } from "./inspector";
import { buildSurfArgs, prelaunchSurf, resolveSurf } from "./surf";
import { browserProbesFrom, sanitizeConnector, SupervisedBrowser } from "./supervise";
import type { LaunchTarget } from "./supervise";
import type { BrowserProbe } from "../vitals";
import { captureStdout, delay, run, spawnChild, which } from "./proc";

/** How long to wait for the freshly-launched browser window to be mapped + named. */
const PLACE_TIMEOUT_MS = 8_000;
const WINDOW_POLL_MS = 150;

/** surf's WM class, used only as a fallback when the pid lookup finds nothing. */
const SURF_WM_CLASS = "surf";

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

  private readonly browsers = new Map<string, SupervisedBrowser>();

  private browserBin: string | null = null;

  /** Latched once neither `import` nor `scrot` is found, so we log the hint once and then skip. */
  private captureUnavailable = false;
  /** connector → why the last inspector-opening attempt failed (null = it worked). Read by `inspect`
   *  so the operator's ack carries the real reason, since the opening happens inside the launch. */
  private readonly inspectErrors = new Map<string, string | null>();

  /**
   * POL-101 — panel power on the X11 fallback.
   *
   * CAVEAT, and it is a real one: `xset` drives DPMS for the whole X DISPLAY, not per connector — X
   * has no per-output DPMS (`xrandr --output … --off` would disable the output, rearranging the
   * layout and moving the kiosk windows, which is a cure worse than the disease). So on a MULTI-output
   * x11-i3 box, sleeping one screen sleeps every panel that box drives. Single-output boxes — the
   * common case for the fallback — behave exactly as intended. Wayland/sway (the default backend,
   * D9/D77) has genuine per-output DPMS and is where a mixed-hours wall belongs.
   */
  private readonly power = new PanelPower(async (connector, on) => {
    if (!(await which("xset"))) {
      throw new Error(
        "xset not found — the x11-i3 backend needs it to power panels (it ships with xserver-xorg)",
      );
    }
    for (const { cmd, args } of x11DpmsCommands(on)) {
      const res = await run(cmd, args);
      if (res.code !== 0) {
        throw new Error(
          `${cmd} ${args.join(" ")} failed: ${res.stderr.trim() || `exit ${res.code}`} ` +
            `(is DISPLAY set for this process?)`,
        );
      }
    }
    this.log(
      `panel ${on ? "woken" : "slept"} for ${connector} via xset — NB: X11 DPMS is per-DISPLAY, so ` +
        `every output this box drives is now ${on ? "awake" : "asleep"}`,
    );
  });

  private log(msg: string): void {
    console.log(`[${ts()}] [x11] ${msg}`);
  }

  private async ensureBin(): Promise<string> {
    if (this.browserBin) return this.browserBin;
    this.browserBin = await resolveSurf();
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

  /**
   * Find the mapped window belonging to `pid`. surf has no flag to set a per-output WM class, so the
   * pid IS the identity: with one surf per output, matching on WM class alone would pick an arbitrary
   * sibling. The class scan stays only as a last resort, for a window whose pid X never learned.
   */
  private async findWindow(pid: number, timeoutMs: number): Promise<string> {
    const hasXdotool = await which("xdotool");
    const hasWmctrl = await which("wmctrl");
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (hasXdotool) {
        if (pid > 0) {
          const byPid = await run("xdotool", ["search", "--pid", String(pid)]);
          const id = byPid.code === 0 ? byPid.stdout.split(/\s+/).filter(Boolean).pop() : undefined;
          if (id) return id;
        }
        const byClass = await run("xdotool", ["search", "--class", SURF_WM_CLASS]);
        if (byClass.code === 0) {
          const first = byClass.stdout.split(/\s+/).filter(Boolean)[0];
          if (first) return first;
        }
      } else if (hasWmctrl) {
        const res = await run("wmctrl", ["-lx"]);
        if (res.code === 0) {
          const line = res.stdout
            .split("\n")
            .find((l) => l.toLowerCase().includes(SURF_WM_CLASS));
          const wid = line?.split(/\s+/)[0];
          if (wid) return wid;
        }
      }
      if (Date.now() >= deadline) {
        throw new Error(`no surf window for pid ${pid} appeared within ${timeoutMs}ms`);
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
    // Re-assert fullscreen; the window now lives on the target monitor so the WM fullscreens it there.
    if (hasWmctrl) await run("wmctrl", ["-i", "-r", wid, "-b", "add,fullscreen"]);
  }

  private async launchAndPlace(
    connector: string,
    bin: string,
    target: LaunchTarget,
  ): Promise<ChildProcess> {
    // `output` may differ from the requested `connector` under the single-output fallback; X11
    // placement is geometric, so we just use the resolved output's geometry.
    const { name: output, geom } = await this.resolveConnector(connector);
    await prelaunchSurf(target.url, (m) => this.log(m));

    const args = buildSurfArgs({ url: target.url, inspector: target.inspector });
    const child = spawnChild(bin, args, { stdio: "ignore" });
    this.log(
      `spawned surf pid=${child.pid ?? "?"} for ${output} → ${target.url}` +
        (target.inspector ? " (Web Inspector enabled)" : ""),
    );

    // Placement is best-effort: it corrects misplacement without ever failing the launch.
    try {
      const wid = await this.findWindow(child.pid ?? -1, PLACE_TIMEOUT_MS);
      await this.placeWindow(wid, geom);
      this.log(`placed window ${wid} on ${output} @ ${geom.w}x${geom.h}+${geom.x}+${geom.y}`);
    } catch (err) {
      this.log(`placement on ${output} failed: ${(err as Error).message}`);
    }

    // Opening the inspector belongs to the LAUNCH, not to the operator's click: a supervised browser
    // that crashes and respawns while being inspected must come back inspected, or the console would
    // badge an inspector that is no longer on the panel. `inspect()` reads the outcome below.
    if (target.inspector) await this.openInspector(connector, child.pid ?? -1);
    return child;
  }

  /**
   * Focus this output's surf and pop its Web Inspector. Best-effort: it must never fail a launch —
   * a wall rendering without an inspector still beats a wall rendering nothing — so the reason is
   * stashed per connector for `inspect()` to report back to the operator.
   */
  private async openInspector(connector: string, pid: number): Promise<void> {
    this.inspectErrors.set(connector, null);
    try {
      if (pid <= 0) throw new Error("the freshly launched surf reported no pid");
      // XTEST input lands on whatever holds X focus, so focus surf's window first.
      const wid = await this.findWindow(pid, PLACE_TIMEOUT_MS);
      await run("xdotool", ["windowactivate", "--sync", wid]);
      await run("xdotool", ["windowfocus", "--sync", wid]);
      await openInspectorOnFocusedWindow((m) => this.log(m));
    } catch (err) {
      const reason = (err as Error).message;
      this.inspectErrors.set(connector, reason);
      this.log(`inspector on ${connector} not opened: ${reason}`);
    }
  }

  private ensureBrowser(connector: string, bin: string): SupervisedBrowser {
    let b = this.browsers.get(connector);
    if (!b) {
      b = new SupervisedBrowser(
        connector,
        (target) => this.launchAndPlace(connector, bin, target),
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

  /** POL-18 — not implemented on the i3 fallback yet (the server capability-gates on wayland-sway
   *  and degrades such content to the iframe there, with a console note). Defence in depth: an
   *  unexpected window placement is refused loudly, never silently dropped. */
  async showWindow(connector: string): Promise<void> {
    throw new Error(
      `web-window placement is not implemented by the x11-i3 backend (connector ${connector})`,
    );
  }

  async hideWindow(id: string): Promise<void> {
    this.log(`hideWindow(${id}): nothing placed (x11-i3 places no windows)`);
  }

  async ident(on: boolean): Promise<void> {
    this.log(`ident ${on ? "on" : "off"} — visible ident is server→player; agent no-op`);
  }

  /**
   * Pop surf's Web Inspector on the panel driven by `connector` (POL-50). Same shape as the sway
   * backend: relaunch with `-N`, which places the window and opens the inspector as part of the launch.
   */
  async inspect(connector: string, on: boolean): Promise<void> {
    const supervised = this.browsers.get(connector);
    if (!supervised) {
      throw new Error(`nothing is placed on ${connector} — no page to inspect`);
    }
    if (supervised.inspector === on && supervised.running) {
      this.log(`inspect(${connector}): already ${on ? "on" : "off"} — no-op`);
      return;
    }
    if (on) await requireXdotool(); // fail before we disturb the wall

    await supervised.setInspector(on);
    if (!on) {
      this.log(`inspect(${connector}): relaunched without the Web Inspector`);
      return;
    }

    // The relaunch opened it (or tried to). Surface the real reason, so the operator's ack is honest.
    const failure = this.inspectErrors.get(connector);
    if (failure) throw new Error(failure);
    this.log(`inspect(${connector}): Web Inspector open on the wall`);
  }

  /** x11-i3 drives surf, which has no tunnel-able remote inspector (D63) — never a DevTools port. */
  devtoolsEndpoint(): { port: number } | null {
    return null;
  }

  /** POL-101 — DPMS via xset (per-display, see the caveat on `power`); CEC if the box has an adapter. */
  powerCapabilities(): Promise<PowerCapabilities> {
    return this.power.capabilities();
  }

  /** POL-101 — sleep/wake the panel(s). See the `power` field for the per-display X11 caveat. */
  setPower(connector: string, on: boolean): Promise<PanelPowerMethod[]> {
    return this.power.apply(connector, on);
  }

  /** POL-119 — casting is sway-only for now: the receiver renders via waylandsink natively, and
   *  POL-67 rules out the Xwayland/X11 software sinks (they peg the CPU on real boxes). Disabling
   *  (`null`) is always safe; enabling refuses with the reason the console shows the operator. */
  async setCast(connector: string, spec: { name: string } | null): Promise<void> {
    if (spec === null) return;
    throw new Error(`casting needs the wayland-sway backend (this box runs x11-i3)`);
  }

  onCastSession(): void {
    // Never fires: no receiver can run here.
  }

  onCastPin(): void {
    // Never fires: no receiver can run here (POL-136).
  }

  /** POL-92 — the browsers this backend supervises, for the heartbeat's vitals sampler. On X11 that
   *  is surf under Xwayland, the very stack whose lost DRI3 path (D77) the GPU tell exists to catch. */
  browserProbes(): BrowserProbe[] {
    return browserProbesFrom(this.browsers);
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

/** Assert the X11 placement tool-chain is present (xrandr + a window controller). */
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
