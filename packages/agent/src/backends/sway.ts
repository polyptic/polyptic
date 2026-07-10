/**
 * wayland-sway — the real Wayland/sway placement backend (D9 default).
 *
 * Phase 4. For each output the control plane assigns, it ensures a kiosk surf is running and pinned
 * to that physical connector, supervises/respawns it, and can grab a `grim` thumbnail.
 *
 * Placement gotcha (docs/ARCHITECTURE.md): Wayland forbids client self-positioning, so we subscribe
 * to sway's `window` events BEFORE spawning, then move the matching new window onto the target output
 * via `swaymsg` IPC — keyed on the child's pid, with `app_id` / launch order as the fallback (the
 * agent applies screens sequentially, so a fresh `new` window is unambiguous). surf is an X11 client,
 * so under sway it arrives through XWayland (D48: the `xwayland` package must exist, and the sway
 * config imports DISPLAY into the systemd user environment).
 *
 * Content never changes surf's URL here — that is fixed per screen; content flips happen inside the
 * player over its own WS channel. So `showScreen` only (re)launches when the URL actually changes
 * (handled by SupervisedBrowser). The one other reason to relaunch is the Web Inspector (POL-50),
 * which surf can only be given at launch.
 */
import type { ChildProcess } from "node:child_process";
import type { DisplayBackend } from "./types";
import { openInspectorOnFocusedWindow, requireXdotool } from "./inspector";
import { buildSurfArgs, matchesSurfWindow, prelaunchSurf, resolveSurf } from "./surf";
import { SupervisedBrowser } from "./supervise";
import type { LaunchTarget } from "./supervise";
import { captureStdout, makeJsonStreamSplitter, run, spawnChild, which } from "./proc";

/** How long to wait for the freshly-launched browser window to appear on the sway tree. */
const PLACE_TIMEOUT_MS = 8_000;
/** Grace before we accept an `app_id`-only match, giving the exact pid match a chance to arrive. */
const APP_ID_GRACE_MS = 600;

function ts(): string {
  return new Date().toISOString();
}

/** A candidate `new`-window event observed on the sway IPC stream. */
interface WindowCandidate {
  id: number;
  pid: number;
  appId: string;
}

/** Loosely-typed view of a sway `window` event (we only read a few fields defensively). */
interface SwayWindowEvent {
  change?: unknown;
  container?: {
    id?: unknown;
    pid?: unknown;
    app_id?: unknown;
    window_properties?: { class?: unknown } | null;
  } | null;
}

/** A live `swaymsg -t subscribe -m '["window"]'` monitor we can query for the placed window. */
interface SwayWindowSub {
  /** Resolve with the sway container id of the new browser window, or throw on timeout. */
  waitForWindow(pid: number, timeoutMs: number): Promise<number>;
  /** Stop the monitor. */
  close(): void;
}

function startSwayWindowSubscription(
  matchesWindow: (appId: string) => boolean,
  log: (m: string) => void,
): SwayWindowSub {
  const proc = spawnChild("swaymsg", ["-t", "subscribe", "-m", '["window"]']);
  const candidates: WindowCandidate[] = [];
  let wake: (() => void) | null = null;

  const splitter = makeJsonStreamSplitter((obj) => {
    const ev = obj as SwayWindowEvent;
    if (ev.change !== "new" || !ev.container) return;
    const c = ev.container;
    if (typeof c.id !== "number") return;
    const appId =
      typeof c.app_id === "string"
        ? c.app_id
        : c.window_properties && typeof c.window_properties.class === "string"
          ? c.window_properties.class
          : "";
    candidates.push({
      id: c.id,
      pid: typeof c.pid === "number" ? c.pid : -1,
      appId,
    });
    const w = wake;
    wake = null;
    w?.();
  });

  proc.stdout?.on("data", (chunk: Buffer) => splitter.push(chunk));
  proc.on("error", (err) => log(`swaymsg subscribe failed: ${err.message}`));

  return {
    async waitForWindow(pid: number, timeoutMs: number): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      const startedAt = Date.now();
      for (;;) {
        let appIdCandidate: number | null = null;
        for (const c of candidates) {
          if (pid > 0 && c.pid === pid) return c.id; // best: exact pid match
          if (appIdCandidate === null && matchesWindow(c.appId)) appIdCandidate = c.id;
        }
        // Accept the app_id/launch-order match only after a short grace, so a pid match wins.
        if (appIdCandidate !== null && (pid <= 0 || Date.now() - startedAt >= APP_ID_GRACE_MS)) {
          return appIdCandidate;
        }
        if (Date.now() >= deadline) {
          if (appIdCandidate !== null) return appIdCandidate; // last resort
          throw new Error(`no browser window appeared on the sway tree within ${timeoutMs}ms`);
        }
        await new Promise<void>((resolve) => {
          const w = (): void => resolve();
          wake = w;
          setTimeout(() => {
            if (wake === w) wake = null;
            resolve();
          }, 150);
        });
      }
    },
    close(): void {
      try {
        proc.kill();
      } catch {
        // already gone
      }
    },
  };
}

export class SwayBackend implements DisplayBackend {
  readonly id = "wayland-sway" as const;

  /** connector → supervised kiosk browser. */
  private readonly browsers = new Map<string, SupervisedBrowser>();

  /** Latched once `grim` is found missing, so we log the remediation hint once and then skip. */
  private captureUnavailable = false;
  /** Resolved once; reused for every (re)launch. */
  private browserBin: string | null = null;
  /** connector → why the last inspector-opening attempt failed (null = it worked). Read by `inspect`
   *  so the operator's ack carries the real reason, since the opening happens inside the launch. */
  private readonly inspectErrors = new Map<string, string | null>();

  private log(msg: string): void {
    console.log(`[${ts()}] [sway] ${msg}`);
  }

  private async ensureBin(): Promise<string> {
    if (this.browserBin) return this.browserBin;
    this.browserBin = await resolveSurf();
    return this.browserBin;
  }

  /**
   * Real output names as reported by the live compositor (`swaymsg -t get_outputs`), for the
   * agent to advertise on `agent/hello`. Returns the names (possibly `[]` if sway is up but has no
   * outputs yet — the caller may retry), or `null` if swaymsg is unavailable / the query errors.
   */
  async discoverOutputs(): Promise<string[] | null> {
    if (!(await which("swaymsg"))) return null;
    try {
      return await this.getOutputs();
    } catch (err) {
      this.log(`discoverOutputs: ${(err as Error).message}`);
      return null;
    }
  }

  /** Names of sway's connected outputs (validates connectors; surfaces a clear error). */
  private async getOutputs(): Promise<string[]> {
    const res = await run("swaymsg", ["-r", "-t", "get_outputs"]);
    if (res.code !== 0) {
      throw new Error(
        `swaymsg -t get_outputs failed: ${res.stderr.trim() || `exit ${res.code}`} ` +
          `(is sway running and SWAYSOCK set for this process?)`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      throw new Error("could not parse swaymsg get_outputs JSON");
    }
    if (!Array.isArray(parsed)) throw new Error("unexpected swaymsg get_outputs payload");
    const names: string[] = [];
    for (const o of parsed) {
      if (o && typeof o === "object" && typeof (o as { name?: unknown }).name === "string") {
        names.push((o as { name: string }).name);
      }
    }
    return names;
  }

  /**
   * Resolve the requested `connector` to a real sway output name. Exact matches pass through.
   * For a single-output host (e.g. QEMU/virtio-gpu where the agent advertised "HDMI-1" but the
   * compositor's only output is "Virtual-1"), fall back to that sole output so the kiosk still
   * renders despite the name mismatch. With 2+ outputs an exact match is still required, and 0
   * outputs still errors.
   */
  private async resolveConnector(connector: string): Promise<string> {
    const outputs = await this.getOutputs();
    if (outputs.includes(connector)) return connector;
    if (outputs.length === 1 && outputs[0]) {
      this.log(
        `connector "${connector}" not among sway outputs [${outputs.join(", ")}]; ` +
          `using the sole output "${outputs[0]}"`,
      );
      return outputs[0];
    }
    throw new Error(
      `connector "${connector}" is not a known sway output [${outputs.join(", ") || "none"}]`,
    );
  }

  /** Move the placed container onto `output` and (re)assert fullscreen there. */
  private async moveToOutput(conId: number, output: string): Promise<void> {
    // Disable fullscreen first so sway will relocate the container, then re-enable on the target.
    const cmd =
      `[con_id=${conId}] fullscreen disable, ` +
      `move container to output ${output}, ` +
      `fullscreen enable`;
    const res = await run("swaymsg", [cmd]);
    if (res.code !== 0) {
      throw new Error(`swaymsg move failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
  }

  /**
   * Launch + place surf for one (connector, target). `output` is the real sway output the window is
   * moved onto (it may differ from the requested `connector` under the single-output fallback).
   * Returns the live child for supervision.
   */
  private async launchAndPlace(
    connector: string,
    output: string,
    bin: string,
    target: LaunchTarget,
  ): Promise<ChildProcess> {
    await prelaunchSurf(target.url, (m) => this.log(m));

    // Subscribe BEFORE spawning so we never miss the window's `new` event.
    const sub = startSwayWindowSubscription(matchesSurfWindow, (m) => this.log(m));
    let child: ChildProcess;
    try {
      const args = buildSurfArgs({ url: target.url, inspector: target.inspector });
      child = spawnChild(bin, args, { stdio: "ignore" });
      this.log(
        `spawned surf pid=${child.pid ?? "?"} for ${connector} → ${target.url}` +
          (target.inspector ? " (Web Inspector enabled)" : ""),
      );
    } catch (err) {
      sub.close();
      throw err;
    }

    // Placement is best-effort: a browser showing on the wrong output beats no browser, so a
    // placement failure logs but does NOT fail the launch (and never kills the supervised child).
    try {
      const conId = await sub.waitForWindow(child.pid ?? -1, PLACE_TIMEOUT_MS);
      await this.moveToOutput(conId, output);
      this.log(`placed surf (con_id=${conId}) on ${output}`);
    } catch (err) {
      this.log(`placement on ${output} failed: ${(err as Error).message} (left on default output)`);
    } finally {
      sub.close();
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
      // XTEST input lands on whatever holds X focus, so focus surf's window first. Under sway the
      // XWayland surface is an ordinary container; focusing it by pid focuses it for the seat.
      const focus = await run("swaymsg", [`[pid=${pid}] focus`]);
      if (focus.code !== 0) {
        throw new Error(`could not focus surf: ${focus.stderr.trim() || `exit ${focus.code}`}`);
      }
      await openInspectorOnFocusedWindow((m) => this.log(m));
    } catch (err) {
      const reason = (err as Error).message;
      this.inspectErrors.set(connector, reason);
      this.log(`inspector on ${connector} not opened: ${reason}`);
    }
  }

  private ensureBrowser(connector: string, output: string, bin: string): SupervisedBrowser {
    let b = this.browsers.get(connector);
    if (!b) {
      b = new SupervisedBrowser(
        connector,
        (target) => this.launchAndPlace(connector, output, bin, target),
        (m) => this.log(m),
      );
      this.browsers.set(connector, b);
    }
    return b;
  }

  async showScreen(connector: string, url: string): Promise<void> {
    const bin = await this.ensureBin();
    await requireSwaymsg();
    const output = await this.resolveConnector(connector);
    const supervised = this.ensureBrowser(connector, output, bin);
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

  /**
   * Agent-side ident is best-effort and secondary: the VISIBLE "which panel is this?" overlay is
   * server → player. We only log here (a future enhancement could flash a sway color/border).
   */
  async ident(on: boolean): Promise<void> {
    this.log(`ident ${on ? "on" : "off"} — visible ident is server→player; agent no-op`);
  }

  /**
   * Pop surf's Web Inspector on the panel driven by `connector` (POL-50). Relaunches that output's
   * surf with `-N` — the only way surf takes the inspector — which places it again and opens the
   * inspector as part of the launch. Turning it off relaunches without `-N`, which both closes the
   * inspector and re-seals the kiosk.
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

  /** Grab a thumbnail of `connector` via `grim`. Returns JPEG bytes (or PNG), `null` on failure. */
  async capture(connector: string): Promise<Buffer | null> {
    if (this.captureUnavailable) return null;
    if (!(await which("grim"))) {
      this.captureUnavailable = true;
      this.log("capture: grim not installed — preview thumbnails disabled; install grim to enable");
      return null;
    }
    // Resolve to the real output (single-output fallback) but never let that break capture —
    // fall back to the requested name if resolution fails.
    const target = await this.resolveConnector(connector).catch(() => connector);
    // JPEG to match the agent's `image/jpeg` thumbnail framing (grim ≥ 1.4); PNG fallback for
    // older grim builds that lack `-t jpeg`.
    let buf = await captureStdout("grim", ["-t", "jpeg", "-q", "80", "-o", target, "-"]);
    if (!buf) buf = await captureStdout("grim", ["-o", target, "-"]);
    if (!buf) this.log(`capture(${connector}): grim produced no data`);
    return buf;
  }
}

/** Assert `swaymsg` is present, with a clear remediation hint. */
async function requireSwaymsg(): Promise<void> {
  if (!(await which("swaymsg"))) {
    throw new Error(
      "swaymsg not found — the wayland-sway backend needs sway running and swaymsg on PATH " +
        "(see docs/DEPLOY.md / `polyptic-agent setup`)",
    );
  }
}
