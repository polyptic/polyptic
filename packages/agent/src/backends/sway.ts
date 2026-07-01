/**
 * wayland-sway — the real Wayland/sway placement backend (D9 default).
 *
 * Phase 4. Replaces the throwing stub. For each output the control plane assigns, it ensures a
 * kiosk Chromium is running and pinned to that physical connector, supervises/respawns it, and
 * can grab a `grim` thumbnail.
 *
 * Placement gotcha (docs/ARCHITECTURE.md): Wayland forbids client self-positioning, and every
 * Chromium reports `app_id="chromium"`, so `for_window [app_id]` can't disambiguate multiple
 * browsers. We therefore subscribe to sway's `window` events BEFORE spawning, then move the
 * matching new window onto the target output via `swaymsg` IPC — keyed on the child's pid, with
 * launch-order / `app_id` as the fallback (the agent applies screens sequentially, so a fresh
 * `new` Chromium window is unambiguous). Forcing XWayland (`--ozone-platform=x11 --class=…`) is
 * the documented escape hatch if pid matching proves unreliable on a given GPU/build.
 *
 * Content never changes the Chromium URL here — that is fixed per screen; content flips happen
 * inside the player over its own WS channel. So `showScreen` only (re)launches/repoints when the
 * URL actually changes (handled by SupervisedChromium).
 */
import type { ChildProcess } from "node:child_process";
import type { DisplayBackend } from "./types";
import type { Browser } from "./browser";
import { profileDirFor, SupervisedChromium } from "./chromium";
import { selectBrowser } from "./browser";
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
  private readonly browsers = new Map<string, SupervisedChromium>();

  /** The kiosk browser (chromium default, or cog via POLYPTIC_BROWSER=cog). */
  private readonly browser: Browser = selectBrowser();

  /** Latched once `grim` is found missing, so we log the remediation hint once and then skip. */
  private captureUnavailable = false;
  /** Resolved once; reused for every (re)launch. */
  private browserBin: string | null = null;

  private log(msg: string): void {
    console.log(`[${ts()}] [sway] ${msg}`);
  }

  private async ensureBin(): Promise<string> {
    if (this.browserBin) return this.browserBin;
    this.browserBin = await this.browser.resolveBin();
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
   * Launch + place the browser for one (connector, url). `target` is the real sway output the
   * window is moved onto (it may differ from the requested `connector` under the single-output
   * fallback). Returns the live child for supervision.
   */
  private async launchAndPlace(
    connector: string,
    target: string,
    bin: string,
    profileDir: string,
    url: string,
  ): Promise<ChildProcess> {
    await this.browser.prelaunch(profileDir, url, (m) => this.log(m));

    // Subscribe BEFORE spawning so we never miss the window's `new` event.
    const sub = startSwayWindowSubscription((appId) => this.browser.matchesWindow(appId), (m) => this.log(m));
    let child: ChildProcess;
    try {
      // Chromium's GPU process needs an explicit --disable-gpu on a no-3D GPU. The compositor's
      // software-render choice reaches us as LIBGL_ALWAYS_SOFTWARE=1 (the sway config imports it into
      // the user session, which this agent service inherits), so key the browser's render off it.
      // cog/surf buildArgs ignore `render`; on a real GPU wall this stays "hardware" (no handicap).
      const render = process.env.LIBGL_ALWAYS_SOFTWARE === "1" ? "software" : "hardware";
      const args = this.browser.buildArgs({ url, profileDir, platform: "wayland", scaleFactor: 1, render });
      child = spawnChild(bin, args, { stdio: "ignore" });
      this.log(`spawned ${this.browser.name} pid=${child.pid ?? "?"} for ${connector} → ${url}`);
    } catch (err) {
      sub.close();
      throw err;
    }

    // Placement is best-effort: a browser showing on the wrong output beats no browser, so a
    // placement failure logs but does NOT fail the launch (and never kills the supervised child).
    try {
      const conId = await sub.waitForWindow(child.pid ?? -1, PLACE_TIMEOUT_MS);
      await this.moveToOutput(conId, target);
      this.log(`placed ${this.browser.name} (con_id=${conId}) on ${target}`);
    } catch (err) {
      this.log(`placement on ${target} failed: ${(err as Error).message} (left on default output)`);
    } finally {
      sub.close();
    }
    return child;
  }

  private ensureBrowser(connector: string, target: string, bin: string): SupervisedChromium {
    let b = this.browsers.get(connector);
    if (!b) {
      const profileDir = profileDirFor(connector);
      b = new SupervisedChromium(
        connector,
        (url) => this.launchAndPlace(connector, target, bin, profileDir, url),
        (m) => this.log(m),
      );
      this.browsers.set(connector, b);
    }
    return b;
  }

  async showScreen(connector: string, url: string): Promise<void> {
    const bin = await this.ensureBin();
    await requireSwaymsg();
    const target = await this.resolveConnector(connector);
    const supervised = this.ensureBrowser(connector, target, bin);
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
