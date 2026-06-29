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
import {
  buildChromiumArgs,
  ensureDir,
  killStaleForProfile,
  profileDirFor,
  resetCrashFlags,
  resolveChromium,
  SupervisedChromium,
} from "./chromium";
import { captureStdout, makeJsonStreamSplitter, run, spawnChild, which } from "./proc";

/** How long to wait for the freshly-launched Chromium window to appear on the sway tree. */
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

function looksLikeChromium(appId: string): boolean {
  return /chrom|polyptych/i.test(appId);
}

/** A live `swaymsg -t subscribe -m '["window"]'` monitor we can query for the placed window. */
interface SwayWindowSub {
  /** Resolve with the sway container id of the new Chromium window, or throw on timeout. */
  waitForChromiumWindow(pid: number, timeoutMs: number): Promise<number>;
  /** Stop the monitor. */
  close(): void;
}

function startSwayWindowSubscription(log: (m: string) => void): SwayWindowSub {
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
    async waitForChromiumWindow(pid: number, timeoutMs: number): Promise<number> {
      const deadline = Date.now() + timeoutMs;
      const startedAt = Date.now();
      for (;;) {
        let chromCandidate: number | null = null;
        for (const c of candidates) {
          if (pid > 0 && c.pid === pid) return c.id; // best: exact pid match
          if (chromCandidate === null && looksLikeChromium(c.appId)) chromCandidate = c.id;
        }
        // Accept the app_id/launch-order match only after a short grace, so a pid match wins.
        if (chromCandidate !== null && (pid <= 0 || Date.now() - startedAt >= APP_ID_GRACE_MS)) {
          return chromCandidate;
        }
        if (Date.now() >= deadline) {
          if (chromCandidate !== null) return chromCandidate; // last resort
          throw new Error(`no Chromium window appeared on the sway tree within ${timeoutMs}ms`);
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

  /** connector → supervised kiosk Chromium. */
  private readonly browsers = new Map<string, SupervisedChromium>();
  /** Resolved once; reused for every (re)launch. */
  private chromiumPath: string | null = null;

  private log(msg: string): void {
    console.log(`[${ts()}] [sway] ${msg}`);
  }

  private async ensureChromium(): Promise<string> {
    if (this.chromiumPath) return this.chromiumPath;
    this.chromiumPath = await resolveChromium();
    return this.chromiumPath;
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

  private async validateConnector(connector: string): Promise<void> {
    const outputs = await this.getOutputs();
    if (!outputs.includes(connector)) {
      throw new Error(
        `connector "${connector}" is not a known sway output [${outputs.join(", ") || "none"}]`,
      );
    }
  }

  /** Move the placed container onto `connector` and (re)assert fullscreen there. */
  private async moveToOutput(conId: number, connector: string): Promise<void> {
    // Disable fullscreen first so sway will relocate the container, then re-enable on the target.
    const cmd =
      `[con_id=${conId}] fullscreen disable, ` +
      `move container to output ${connector}, ` +
      `fullscreen enable`;
    const res = await run("swaymsg", [cmd]);
    if (res.code !== 0) {
      throw new Error(`swaymsg move failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
  }

  /** Launch + place Chromium for one (connector, url). Returns the live child for supervision. */
  private async launchAndPlace(
    connector: string,
    chromium: string,
    profileDir: string,
    url: string,
  ): Promise<ChildProcess> {
    await ensureDir(profileDir);
    await killStaleForProfile(profileDir, (m) => this.log(m));
    await resetCrashFlags(profileDir, (m) => this.log(m));

    // Subscribe BEFORE spawning so we never miss the window's `new` event.
    const sub = startSwayWindowSubscription((m) => this.log(m));
    let child: ChildProcess;
    try {
      const args = buildChromiumArgs({ url, profileDir, platform: "wayland", scaleFactor: 1 });
      child = spawnChild(chromium, args, { stdio: "ignore" });
      this.log(`spawned Chromium pid=${child.pid ?? "?"} for ${connector} → ${url}`);
    } catch (err) {
      sub.close();
      throw err;
    }

    // Placement is best-effort: a Chromium showing on the wrong output beats no Chromium, so a
    // placement failure logs but does NOT fail the launch (and never kills the supervised child).
    try {
      const conId = await sub.waitForChromiumWindow(child.pid ?? -1, PLACE_TIMEOUT_MS);
      await this.moveToOutput(conId, connector);
      this.log(`placed Chromium (con_id=${conId}) on ${connector}`);
    } catch (err) {
      this.log(`placement on ${connector} failed: ${(err as Error).message} (left on default output)`);
    } finally {
      sub.close();
    }
    return child;
  }

  private ensureBrowser(connector: string, chromium: string): SupervisedChromium {
    let b = this.browsers.get(connector);
    if (!b) {
      const profileDir = profileDirFor(connector);
      b = new SupervisedChromium(
        connector,
        (url) => this.launchAndPlace(connector, chromium, profileDir, url),
        (m) => this.log(m),
      );
      this.browsers.set(connector, b);
    }
    return b;
  }

  async showScreen(connector: string, url: string): Promise<void> {
    const chromium = await this.ensureChromium();
    await requireSwaymsg();
    await this.validateConnector(connector);
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

  /**
   * Agent-side ident is best-effort and secondary: the VISIBLE "which panel is this?" overlay is
   * server → player. We only log here (a future enhancement could flash a sway color/border).
   */
  async ident(on: boolean): Promise<void> {
    this.log(`ident ${on ? "on" : "off"} — visible ident is server→player; agent no-op`);
  }

  /** Grab a thumbnail of `connector` via `grim`. Returns JPEG bytes (or PNG), `null` on failure. */
  async capture(connector: string): Promise<Buffer | null> {
    if (!(await which("grim"))) {
      this.log(`capture(${connector}): grim not installed`);
      return null;
    }
    // JPEG to match the agent's `image/jpeg` thumbnail framing (grim ≥ 1.4); PNG fallback for
    // older grim builds that lack `-t jpeg`.
    let buf = await captureStdout("grim", ["-t", "jpeg", "-q", "80", "-o", connector, "-"]);
    if (!buf) buf = await captureStdout("grim", ["-o", connector, "-"]);
    if (!buf) this.log(`capture(${connector}): grim produced no data`);
    return buf;
  }
}

/** Assert `swaymsg` is present, with a clear remediation hint. */
async function requireSwaymsg(): Promise<void> {
  if (!(await which("swaymsg"))) {
    throw new Error(
      "swaymsg not found — the wayland-sway backend needs sway running and swaymsg on PATH " +
        "(see docs/DEPLOY.md / `polyptych-agent setup`)",
    );
  }
}
