/**
 * wayland-sway — the real Wayland/sway placement backend (D9 default).
 *
 * Phase 4. For each output the control plane assigns, it ensures a kiosk browser is running and
 * pinned to that physical connector, supervises/respawns it, and can grab a `grim` thumbnail.
 *
 * The browser is Chrome (native Wayland) where installed, surf as the fallback — selected once via
 * `selectKioskBrowser` (POL-67/D77; the same call the agent's hello reports). The launch mechanics
 * differ but the supervision model doesn't:
 *   - chrome: `--app=<url> --ozone-platform=wayland`, one process per output via a per-connector
 *     `--user-data-dir`, a loopback `--remote-debugging-port` each. `inspect` ARMS the remote
 *     DevTools tunnel for that output — no relaunch, nothing on the glass.
 *   - surf: X11 via Xwayland (D48 plumbing stays for the fallback), URL positional, inspector only
 *     at launch (`-N`) — so `inspect` relaunches that output and pops it on the panel (POL-50/D63).
 *
 * Placement gotcha (docs/ARCHITECTURE.md): Wayland forbids client self-positioning, so we subscribe
 * to sway's `window` events BEFORE spawning, then move the matching new window onto the target output
 * via `swaymsg` IPC — keyed on the child's pid, with `app_id` / launch order as the fallback (the
 * agent applies screens sequentially, so a fresh `new` window is unambiguous).
 *
 * Content never changes the browser's URL here — that is fixed per screen; content flips happen
 * inside the player over its own WS channel. So `showScreen` only (re)launches when the URL actually
 * changes (handled by SupervisedBrowser).
 */
import type { ChildProcess } from "node:child_process";
import { hostname as osHostname } from "node:os";
import type { KioskBrowser, PanelPowerMethod, PowerCapabilities, WindowPlacement } from "@polyptic/protocol";
import type { DisplayBackend } from "./types";
import { PanelPower, swayDpmsArgs } from "./power";
import { openInspectorOnFocusedWindow, requireXdotool } from "./inspector";
import { buildSurfArgs, matchesSurfWindow, prelaunchSurf, resolveSurf } from "./surf";
import {
  DEVTOOLS_PORT_BASE,
  buildChromeArgs,
  buildChromeWindowArgs,
  matchesChromeWindow,
  prelaunchChrome,
  prelaunchChromeWindow,
  resolveChrome,
  selectKioskBrowser,
} from "./chrome";
import { browserProbesFrom, SupervisedBrowser, SupervisedProcess, killStaleByToken } from "./supervise";
import type { LaunchTarget } from "./supervise";
import {
  findConRect,
  geometryMatches,
  regionToOutputRect,
  spanningOutputRect,
  visibleSurfaceFor,
  windowFillsSingleOutput,
  windowFullscreenCommand,
  windowPlacementCommand,
} from "../windows";
import type { OutputRect, PixelRect, SurfaceWindow } from "../windows";
import {
  CAST_PORT_BASE,
  CAST_PORT_STRIDE,
  CastPairingTracker,
  buildUxplayArgs,
  castDeviceMac,
  castRegFileFor,
  ensureCastStateDir,
  matchesUxplayWindow,
  resolveUxplay,
  sameCastTarget,
  wrapLineBuffered,
} from "./cast";
import type { CastTarget } from "./cast";
import { captureStdout, makeJsonStreamSplitter, run, spawnChild, which } from "./proc";
import type { BrowserProbe } from "../vitals";

/** How long to wait for the freshly-launched browser window to appear on the sway tree. */
const PLACE_TIMEOUT_MS = 8_000;
/** Grace before we accept an `app_id`-only match, giving the exact pid match a chance to arrive. */
const APP_ID_GRACE_MS = 600;
/** POL-152 — how many times a web-window placement is re-issued until the window's ACTUAL geometry
 *  matches the target rect. A fresh Wayland window can land on a default output at a default (often
 *  half-width) size and the compositor settles a beat later, so a single float/resize/move can lose
 *  the race — we read the geometry back and re-apply until it takes. */
const PLACE_VERIFY_ATTEMPTS = 5;
/** POL-152 — pause between a placement command and reading the geometry back (and between retries). */
const PLACE_VERIFY_DELAY_MS = 120;

function ts(): string {
  return new Date().toISOString();
}

/** A short awaitable pause (POL-152 placement self-verify). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Compact rect for a log line. */
function rectStr(r: { x: number; y: number; w: number; h: number }): string {
  return `${r.w}x${r.h}+${r.x}+${r.y}`;
}

/** Do two lists hold the same set of strings (order-insensitive)? Used to detect a web-window's span
 *  gaining/losing an output (POL-156), which forces a clean relaunch. */
function sameStringSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((x) => set.has(x));
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

/** A live, PERSISTENT window watch for one supervised pid (POL-119). Unlike the launch-time
 *  `waitForWindow` (one window, right after spawn, then closed), a cast receiver grows windows at
 *  MIRROR-START time — the PIN prompt is NOT a window (POL-136: it goes to stdout; see cast.ts) —
 *  so this stays subscribed for the receiver's whole life, calling back on every
 *  appearance/disappearance. The subscription child is respawned if it dies: losing it silently
 *  would freeze the console's "casting" signal. */
interface PidWindowWatch {
  close(): void;
}

function startPidWindowWatch(
  opts: {
    /** Is this the watched process? Checked per event (the supervised pid changes on respawn). */
    matchesPid: (pid: number) => boolean;
    /** `app_id` fallback for the rare compositor path that reports no pid. */
    matchesAppId: (appId: string) => boolean;
    onWindow: (conId: number) => void;
    onClose: (conId: number) => void;
  },
  log: (m: string) => void,
): PidWindowWatch {
  let closed = false;
  let proc: ReturnType<typeof spawnChild> | null = null;
  /** con_ids currently attributed to the watched process, so `close` events can be filtered without
   *  trusting the (sometimes absent) pid on the closing container. */
  const owned = new Set<number>();

  const spawn = (): void => {
    if (closed) return;
    proc = spawnChild("swaymsg", ["-t", "subscribe", "-m", '["window"]']);
    const splitter = makeJsonStreamSplitter((obj) => {
      const ev = obj as SwayWindowEvent;
      if (!ev.container || typeof ev.container.id !== "number") return;
      const c = ev.container;
      const conId = c.id as number;
      const pid = typeof c.pid === "number" ? c.pid : -1;
      const appId =
        typeof c.app_id === "string"
          ? c.app_id
          : c.window_properties && typeof c.window_properties.class === "string"
            ? c.window_properties.class
            : "";
      if (ev.change === "new") {
        if ((pid > 0 && opts.matchesPid(pid)) || opts.matchesAppId(appId)) {
          owned.add(conId);
          opts.onWindow(conId);
        }
      } else if (ev.change === "close") {
        if (owned.delete(conId)) opts.onClose(conId);
      }
    });
    proc.stdout?.on("data", (chunk: Buffer) => splitter.push(chunk));
    proc.on("error", (err) => log(`cast window watch: swaymsg subscribe failed: ${err.message}`));
    proc.on("exit", () => {
      if (closed) return;
      log("cast window watch: swaymsg subscribe died — respawning in 2s");
      setTimeout(spawn, 2_000);
    });
  };
  spawn();

  return {
    close(): void {
      closed = true;
      try {
        proc?.kill();
      } catch {
        // already gone
      }
    },
  };
}

/** Everything the sway backend keeps per cast-enabled connector (POL-119). */
interface CastInstance {
  supervised: SupervisedProcess<CastTarget>;
  watch: PidWindowWatch;
  /** The receiver's live windows (the mirror; POL-136 established the PIN prompt is NOT a window).
   *  Non-empty = a session is on the glass. */
  windows: Set<number>;
  /** This connector's fixed UxPlay base port, stable across relaunches. */
  basePort: number;
  /** POL-136 — the PIN lifecycle, fed from the receiver's stdout/stderr. The receiver never draws
   *  its PIN (stdout only), so this is how the number reaches the panel at all. */
  tracker: CastPairingTracker;
}

export class SwayBackend implements DisplayBackend {
  readonly id = "wayland-sway" as const;

  /** connector → supervised kiosk browser. */
  private readonly browsers = new Map<string, SupervisedBrowser>();

  /** POL-146 — connector → the sway con_id its PLAYER was last placed as. Kept so a web-window
   *  placement can drop the player's fullscreen (else sway hides the floating window behind it) and
   *  restore it once the last window leaves. Set on every (re)placement; a respawn refreshes it. */
  private readonly playerConIds = new Map<string, number>();

  /** POL-18 — window id → its supervised second browser (the placed web-window). */
  private readonly windows = new Map<string, SupervisedBrowser>();
  /** POL-18 — window id → the LATEST placement spec; the launch fn reads it so a respawn after a
   *  crash comes back at the current geometry, not the one it was first launched with. `connectors`
   *  is one output for an ordinary window and SEVERAL (POL-156) for a wall this box spans — the
   *  window is then floated across the union of those outputs. */
  private readonly windowSpecs = new Map<
    string,
    { connectors: string[]; window: WindowPlacement }
  >();
  /** POL-18 — window id → the sway container id its window was placed as (re-position without a
   *  relaunch when only geometry changed). Cleared on relaunch. */
  private readonly windowConIds = new Map<string, number>();

  /** Latched once `grim` is found missing, so we log the remediation hint once and then skip. */
  private captureUnavailable = false;
  /** Which browser this box drives (chrome | surf), resolved once via selectKioskBrowser. */
  private browser: KioskBrowser | null = null;
  /** Resolved once; reused for every (re)launch. */
  private browserBin: string | null = null;
  /** connector → why the last inspector-opening attempt failed (null = it worked). surf only: read
   *  by `inspect` so the operator's ack carries the real reason, since the opening happens inside
   *  the launch. */
  private readonly inspectErrors = new Map<string, string | null>();
  /** connector → its Chrome instance's loopback DevTools port, assigned on first launch and stable
   *  across respawns (POL-67). */
  private readonly devtoolsPorts = new Map<string, number>();
  /** Connectors an operator has ARMED for the DevTools tunnel (`inspect on`, chrome only). */
  private readonly devtoolsArmed = new Set<string>();
  /** connector → its live cast receiver (POL-119). */
  private readonly casts = new Map<string, CastInstance>();
  /** connector → its UxPlay base port, assigned once in arrival order (the DevTools-port pattern)
   *  and kept across enable/disable so a toggled connector never lands on a sibling's ports. */
  private readonly castPorts = new Map<string, number>();
  /** The agent's cast-session listener — told when a connector's receiver gains/loses its windows. */
  private castSession: ((connector: string, active: boolean) => void) | null = null;
  /** POL-136 — the agent's PIN listener: told the PIN a pairing sender must type (null = clear). */
  private castPin: ((connector: string, pin: string | null) => void) | null = null;

  /** POL-101 — DPMS via sway IPC, plus CEC if this box has an adapter. The browser is NOT torn down
   *  when a panel sleeps, which is what makes the wake instant and content-preserving. */
  private readonly power = new PanelPower(async (connector, on) => {
    await requireSwaymsg();
    const output = await this.resolveConnector(connector);
    const res = await run("swaymsg", swayDpmsArgs(output, on));
    if (res.code !== 0) {
      throw new Error(
        `swaymsg output ${output} dpms ${on ? "on" : "off"} failed: ` +
          `${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
    this.log(`panel ${on ? "woken" : "slept"} on ${output} (dpms ${on ? "on" : "off"})`);
  });

  private log(msg: string): void {
    console.log(`[${ts()}] [sway] ${msg}`);
  }

  /**
   * Forward the browser's stdout/stderr into the agent's log, so a wall can explain itself in
   * `journalctl --user -u polyptic-agent` (POL-86).
   *
   * Bounded on purpose. Chrome writes a great deal of noise nobody will ever read (font warnings,
   * Vulkan probes, dbus chatter), and the journal on a RAM-only diskless box is not free — so we keep
   * the lines that describe a FAILURE, drop the rest, and cap the rate so a browser stuck in a
   * warning loop cannot fill it. `POLYPTIC_BROWSER_LOG=all` lifts the filter for a lab session.
   *
   * This was `stdio: "ignore"`, which is why a broken wall was mute: the browser's own account of the
   * failure was thrown away, and the only way to read its mind was to open DevTools against it. It is
   * also, pointedly, how surf's `DRI3 error` line — the entire POL-67 finding — stayed invisible.
   */
  private pipeBrowserOutput(child: ChildProcess, browser: string, connector: string): void {
    const verbose = process.env.POLYPTIC_BROWSER_LOG?.trim() === "all";
    // Worth reading on a wall that is misbehaving: renderer/GPU deaths, the EGL/DRI3 class that
    // started POL-67, aborted loads, sandbox refusals, plain errors.
    const interesting =
      /error|fail|crash|denied|refus|fatal|EGL|GPU|DRI3|sandbox|ERR_|net::|cannot|unable/i;
    const MAX_LINES_PER_MIN = 60;
    let windowStart = Date.now();
    let emitted = 0;
    let suppressed = 0;

    const sink =
      (stream: "out" | "err") =>
      (chunk: Buffer): void => {
        for (const raw of chunk.toString("utf8").split("\n")) {
          const line = raw.trim();
          if (!line) continue;
          if (!verbose && !interesting.test(line)) continue;

          const now = Date.now();
          if (now - windowStart >= 60_000) {
            if (suppressed > 0) {
              this.log(`[${browser}:${connector}] … ${suppressed} more line(s) suppressed`);
            }
            windowStart = now;
            emitted = 0;
            suppressed = 0;
          }
          if (emitted >= MAX_LINES_PER_MIN) {
            suppressed += 1;
            continue;
          }
          emitted += 1;
          this.log(`[${browser}:${connector}:${stream}] ${line.slice(0, 500)}`);
        }
      };

    child.stdout?.on("data", sink("out"));
    child.stderr?.on("data", sink("err"));
    // A pipe nobody drains would eventually block the browser; a stream error must never kill a wall.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
  }

  private async ensureBrowserKind(): Promise<KioskBrowser> {
    if (this.browser) return this.browser;
    this.browser = await selectKioskBrowser();
    this.log(`kiosk browser: ${this.browser}`);
    return this.browser;
  }

  private async ensureBin(): Promise<string> {
    if (this.browserBin) return this.browserBin;
    const browser = await this.ensureBrowserKind();
    this.browserBin = browser === "chrome" ? await resolveChrome() : await resolveSurf();
    return this.browserBin;
  }

  /** This connector's DevTools port — assigned once, in arrival order from the base (POL-67). */
  private devtoolsPortFor(connector: string): number {
    let port = this.devtoolsPorts.get(connector);
    if (port === undefined) {
      port = DEVTOOLS_PORT_BASE + this.devtoolsPorts.size;
      this.devtoolsPorts.set(connector, port);
    }
    return port;
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

  /**
   * Move the placed container onto `output`. Fullscreen there UNLESS a web-window occupies this
   * output (POL-146): sway hides floating windows behind a workspace-fullscreen view, so a player
   * left fullscreen would occlude the POL-18 web-window floated over it — the operator sees the
   * player's black `.stage` through the window-hole, not the content. A non-fullscreen player is
   * still the sole tiled window on its output, so it fills the glass all the same; the floating
   * web-window now composites ABOVE it.
   */
  private async moveToOutput(conId: number, output: string, fullscreen = true): Promise<void> {
    // Disable fullscreen first so sway will relocate the container, then re-assert it on the target
    // only when nothing floats above (fullscreen is also the move MECHANISM — a fullscreen container
    // can't cross outputs until it's dropped).
    const cmd =
      `[con_id=${conId}] fullscreen disable, ` +
      `move container to output ${output}` +
      (fullscreen ? ", fullscreen enable" : "");
    const res = await run("swaymsg", [cmd]);
    if (res.code !== 0) {
      throw new Error(`swaymsg move failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
  }

  /** POL-146 — does an output currently host a placed web-window (as one of its own outputs, or as a
   *  member of a wall this box spans)? Its player must then stay OUT of workspace-fullscreen, or sway
   *  hides the floating window behind it (black glass). */
  private connectorHasWindow(connector: string): boolean {
    for (const spec of this.windowSpecs.values()) {
      if (spec.connectors.includes(connector)) return true;
    }
    return false;
  }

  /**
   * POL-146 — (un)fullscreen the PLAYER on `connector` so a POL-18 web-window floated over it is
   * visible (`on=false`) or, once the last window leaves, so the player reclaims the full glass as a
   * fullscreen view again (`on=true`). Best-effort and keyed on the player's tracked con_id: if we
   * never learned it (an earlier placement failure) there is nothing to toggle, and a wall rendering
   * content beats a wall stuck black on a swaymsg hiccup — so a failure only logs.
   */
  private async setPlayerFullscreen(connector: string, on: boolean): Promise<void> {
    const conId = this.playerConIds.get(connector);
    if (conId === undefined) return;
    const res = await run("swaymsg", [`[con_id=${conId}] fullscreen ${on ? "enable" : "disable"}`]);
    if (res.code !== 0) {
      this.log(
        `player fullscreen ${on ? "enable" : "disable"} on ${connector} failed: ` +
          `${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
  }

  /**
   * POL-162 — (un)fullscreen a placed web-window (the POL-162 full-region path's own visible-surface
   * toggle, mirroring `setPlayerFullscreen`). Best-effort and keyed on the tracked con_id: if we
   * never learned it there is nothing to toggle, and a failure only logs — content on the glass beats
   * a wall stuck on a swaymsg hiccup.
   */
  private async setWindowFullscreen(id: string, on: boolean): Promise<void> {
    const conId = this.windowConIds.get(id);
    if (conId === undefined) return;
    const res = await run("swaymsg", [`[con_id=${conId}] fullscreen ${on ? "enable" : "disable"}`]);
    if (res.code !== 0) {
      this.log(
        `web-window ${id} fullscreen ${on ? "enable" : "disable"} failed: ` +
          `${res.stderr.trim() || `exit ${res.code}`}`,
      );
    }
  }

  /** POL-162 — park a web-window's container on `output` and make it that output's FULLSCREEN surface,
   *  exactly like the player (`windowFullscreenCommand`): no resize/move/geometry math. Enabling
   *  fullscreen here takes the workspace's fullscreen from the player automatically. */
  private async fullscreenWindow(conId: number, output: string): Promise<void> {
    const res = await run("swaymsg", [windowFullscreenCommand(conId, output)]);
    if (res.code !== 0) {
      throw new Error(`swaymsg web-window fullscreen failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
  }

  /** The web-windows currently placed on this box, as the pure surface resolver reasons about them. */
  private surfaceWindows(): SurfaceWindow[] {
    return [...this.windowSpecs.entries()].map(([id, spec]) => ({
      id,
      connectors: spec.connectors,
      window: spec.window,
    }));
  }

  /**
   * POL-162 — place ONE web-window's container to its standing surface state, choosing the path from
   * its placement spec (the explicit, well-commented branch this ticket is about). This is the single
   * entry point both the launch and the geometry-only reposition use, so a window switching modes
   * (full-region ↔ sub-region) is handled the same way everywhere.
   *
   *   - FULL single output → FULLSCREEN, like the player. `move container to output` + `fullscreen
   *     enable`; sway guarantees edge-to-edge, so no rect, no resize/move, no self-verify loop.
   *   - SUB-region or single-box MULTI-OUTPUT SPAN → the FLOATING + hand-computed geometry +
   *     self-verify path (POL-150/POL-152/POL-156), which those two cases genuinely need.
   */
  private async placeWindowSurface(id: string, conId: number): Promise<void> {
    const spec = this.windowSpecs.get(id);
    if (!spec) return;
    if (windowFillsSingleOutput(spec.connectors, spec.window)) {
      // FULLSCREEN path (POL-162): the exact primitive that already works flawlessly for the player.
      const output = await this.resolveConnector(spec.connectors[0]!);
      await this.fullscreenWindow(conId, output);
      this.log(`web-window ${id}: fullscreened on ${output} (POL-162 player-style placement)`);
      return;
    }
    // FLOATING path (sub-region / multi-output span): drop any prior fullscreen (a mode switch from
    // full-region), reveal the floater by un-fullscreening each underlying player (POL-146: sway hides
    // floaters behind a fullscreen view; POL-150: it also frees the window's geometry), then place +
    // self-verify the hand-computed rect (POL-152).
    await this.setWindowFullscreen(id, false);
    for (const connector of spec.connectors) {
      await this.setPlayerFullscreen(connector, false);
    }
    await this.positionWindow(id, conId, spec.connectors, spec.window);
    this.log(`web-window ${id}: floated over ${spec.connectors.join("+")}`);
  }

  /**
   * POL-162/POL-146/POL-154 — restore a connector to its standing visible surface after ident ends or
   * a window is torn down: fullscreen the web-window that owns it (POL-162 full-region), else
   * un-fullscreen the player so a floating window composites above (POL-146), else fullscreen the
   * player to reclaim the whole glass. The ONE reconciled toggle, resolved by the pure state machine.
   */
  private async restoreVisibleSurface(connector: string): Promise<void> {
    const surface = visibleSurfaceFor(connector, this.surfaceWindows());
    switch (surface.kind) {
      case "window-fullscreen":
        await this.setWindowFullscreen(surface.windowId, true);
        break;
      case "player-windowed":
        await this.setPlayerFullscreen(connector, false);
        break;
      case "player-fullscreen":
        await this.setPlayerFullscreen(connector, true);
        break;
    }
  }

  /**
   * Launch + place the kiosk browser for one (connector, target). `output` is the real sway output
   * the window is moved onto (it may differ from the requested `connector` under the single-output
   * fallback). Returns the live child for supervision.
   */
  private async launchAndPlace(
    connector: string,
    output: string,
    bin: string,
    target: LaunchTarget,
  ): Promise<ChildProcess> {
    const browser = await this.ensureBrowserKind();
    if (browser === "chrome") await prelaunchChrome(connector, (m) => this.log(m));
    else await prelaunchSurf(target.url, (m) => this.log(m));

    // Subscribe BEFORE spawning so we never miss the window's `new` event.
    const matches = browser === "chrome" ? matchesChromeWindow : matchesSurfWindow;
    const sub = startSwayWindowSubscription(matches, (m) => this.log(m));
    let child: ChildProcess;
    try {
      const args =
        browser === "chrome"
          ? buildChromeArgs({
              url: target.url,
              connector,
              devtoolsPort: this.devtoolsPortFor(connector),
            })
          : buildSurfArgs({ url: target.url, inspector: target.inspector });
      // Pipe the browser's stdio instead of discarding it (POL-86). It used to be `stdio: "ignore"`,
      // which meant the browser's own diagnosis of a failure never reached the journal — during the
      // POL-67 hardware bring-up the box was mute about a broken wall and the only way to read the
      // browser's mind was to open DevTools against it. It is also how surf's DRI3 warning (the whole
      // POL-67 finding) would have surfaced years earlier. Browsers are chatty, so the sink filters
      // and rate-limits rather than firehosing the journal (see pipeBrowserOutput).
      child = spawnChild(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      this.pipeBrowserOutput(child, browser, connector);
      this.log(
        `spawned ${browser} pid=${child.pid ?? "?"} for ${connector} → ${target.url}` +
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
      // POL-146 — a player sharing its output with a web-window must NOT be fullscreen, or sway hides
      // the floating window behind it. Decide from the current window set so a respawn comes back at
      // the right fullscreen state (a window placed while the player was dead stays visible).
      await this.moveToOutput(conId, output, !this.connectorHasWindow(connector));
      this.playerConIds.set(connector, conId);
      this.log(`placed ${browser} (con_id=${conId}) on ${output}`);
    } catch (err) {
      this.log(`placement on ${output} failed: ${(err as Error).message} (left on default output)`);
    } finally {
      sub.close();
    }

    // surf only: opening the on-panel inspector belongs to the LAUNCH, not to the operator's click —
    // a supervised browser that crashes and respawns while being inspected must come back inspected,
    // or the console would badge an inspector that is no longer on the panel. `inspect()` reads the
    // outcome below. (Chrome never takes this path: its target.inspector is always false.)
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
    this.devtoolsArmed.delete(connector); // an unplaced output has nothing left to inspect
    if (!supervised) {
      this.log(`hideScreen(${connector}): nothing placed`);
      return;
    }
    await supervised.stop();
    this.browsers.delete(connector);
    this.playerConIds.delete(connector); // POL-146 — nothing left to (un)fullscreen on this output
    this.log(`hideScreen(${connector}): torn down`);
  }

  // ── Web-windows (POL-18) ─────────────────────────────────────────────────────
  //
  // A `placement: "window"` surface is a SECOND, supervised kiosk browser window floated over the
  // player at the surface's region. Same launch/supervise machinery as the per-output player
  // browser (SupervisedBrowser + the pre-spawn sway window subscription); the only new mechanics
  // are the floating placement (`floating enable` + `resize set` + `move absolute position` —
  // Wayland clients cannot self-position, so sway does it, exactly like the player's own
  // move-to-output) and the canvas → output pixel scale (../windows.ts).

  /** Output name → its mode + position in sway's global coordinate space (POL-18 placement). */
  private async getOutputRects(): Promise<Map<string, OutputRect>> {
    const res = await run("swaymsg", ["-r", "-t", "get_outputs"]);
    if (res.code !== 0) {
      throw new Error(`swaymsg -t get_outputs failed: ${res.stderr.trim() || `exit ${res.code}`}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.stdout);
    } catch {
      throw new Error("could not parse swaymsg get_outputs JSON");
    }
    const rects = new Map<string, OutputRect>();
    if (!Array.isArray(parsed)) return rects;
    for (const o of parsed) {
      if (!o || typeof o !== "object") continue;
      const name = (o as { name?: unknown }).name;
      const rect = (o as { rect?: { x?: unknown; y?: unknown; width?: unknown; height?: unknown } })
        .rect;
      if (
        typeof name === "string" &&
        rect &&
        typeof rect.x === "number" &&
        typeof rect.y === "number" &&
        typeof rect.width === "number" &&
        typeof rect.height === "number"
      ) {
        rects.set(name, { x: rect.x, y: rect.y, width: rect.width, height: rect.height });
      }
    }
    return rects;
  }

  /** POL-152 — read a container's CURRENT on-screen rect from the live sway tree, or `null` if it
   *  isn't there (vanished, or the read raced its creation). The self-verify loop compares this to
   *  the target rect to decide whether the float/resize actually took. */
  private async readWindowRect(conId: number): Promise<PixelRect | null> {
    const res = await run("swaymsg", ["-r", "-t", "get_tree"]);
    if (res.code !== 0) return null;
    let tree: unknown;
    try {
      tree = JSON.parse(res.stdout);
    } catch {
      return null;
    }
    return findConRect(tree, conId);
  }

  /**
   * Float + size + move a placed web-window's container to its target rect (POL-18/POL-150/POL-152),
   * then VERIFY it landed and re-issue until it does.
   *
   * The target rect is deterministic: ONE connector ⇒ its region scaled onto that output's mode
   * (`regionToOutputRect`); SEVERAL connectors ⇒ the union of those outputs (POL-156), so one window
   * fills a single-box wall edge-to-edge. Either way sway places a floating window, which is not
   * clipped to the output it was parented to.
   *
   * POL-150 — the caller MUST drop the underlying player's sway fullscreen BEFORE this runs: sway
   * constrains geometry ops on a workspace that holds a fullscreen container, so positioning over a
   * still-fullscreen player left it offset/undersized.
   *
   * POL-152 — a fresh Wayland window can appear on a DEFAULT output at a DEFAULT (often half-width)
   * size, and the compositor settles a beat after our command, so a single float/resize/move can lose
   * the race (the field's "renders on the right, then flips to the left / to full" flake). So after
   * issuing the command we read the window's ACTUAL geometry back and re-issue until it matches — the
   * placement becomes self-correcting instead of fire-and-hope.
   */
  private async positionWindow(
    id: string,
    conId: number,
    connectors: string[],
    win: WindowPlacement,
  ): Promise<void> {
    const rects = await this.getOutputRects();
    const outputs = await Promise.all(connectors.map((c) => this.resolveConnector(c)));
    const target = this.windowTargetRect(outputs, rects, win);
    // Parent to the FIRST resolved output; a floating window then spans the rest via absolute coords.
    const primary = outputs[0]!;
    const cmd = windowPlacementCommand(conId, primary, target);

    let lastActual: PixelRect | null = null;
    for (let attempt = 1; attempt <= PLACE_VERIFY_ATTEMPTS; attempt++) {
      const res = await run("swaymsg", [cmd]);
      if (res.code !== 0) {
        throw new Error(
          `swaymsg window placement failed: ${res.stderr.trim() || `exit ${res.code}`}`,
        );
      }
      await delay(PLACE_VERIFY_DELAY_MS);
      lastActual = await this.readWindowRect(conId);
      if (lastActual && geometryMatches(lastActual, target)) {
        if (attempt > 1) {
          this.log(`web-window ${id}: placement settled after ${attempt} attempts`);
        }
        return;
      }
    }
    // Exhausted the retries — leave the window where it last landed (content on the glass beats none)
    // but say so loudly: a persistent mismatch is a real bug, not a transient race.
    this.log(
      `web-window ${id}: placement did NOT converge after ${PLACE_VERIFY_ATTEMPTS} attempts ` +
        `(target ${rectStr(target)}, last ${lastActual ? rectStr(lastActual) : "unreadable"})`,
    );
  }

  /** The global-pixel rect a web-window must cover: a single output's region-rect, or the union of
   *  several outputs for a single-box wall span (POL-156). Pure inputs, so the choice is trivial to
   *  reason about; the math itself is the unit-pinned `regionToOutputRect` / `spanningOutputRect`. */
  private windowTargetRect(
    outputs: string[],
    rects: ReadonlyMap<string, OutputRect>,
    win: WindowPlacement,
  ): PixelRect {
    if (outputs.length === 1) {
      const rect = rects.get(outputs[0]!);
      if (!rect) throw new Error(`no output rect for ${outputs[0]}`);
      return regionToOutputRect(win.region, win.canvas, rect);
    }
    return spanningOutputRect(outputs, rects);
  }

  /** Launch + float one web-window (POL-18). Placement is best-effort like the player's own: a
   *  window on the wrong spot beats no window, so a positioning failure logs but never kills the
   *  supervised child. */
  private async launchAndPlaceWindow(
    id: string,
    bin: string,
    target: LaunchTarget,
  ): Promise<ChildProcess> {
    const spec = this.windowSpecs.get(id);
    if (!spec) throw new Error(`no placement spec for web-window ${id}`);
    const browser = await this.ensureBrowserKind();
    if (browser === "chrome") await prelaunchChromeWindow(id, (m) => this.log(m));
    else await prelaunchSurf(target.url, (m) => this.log(m));

    // Subscribe BEFORE spawning so we never miss the window's `new` event (same as the player's).
    const matches = browser === "chrome" ? matchesChromeWindow : matchesSurfWindow;
    const sub = startSwayWindowSubscription(matches, (m) => this.log(m));
    let child: ChildProcess;
    try {
      const args =
        browser === "chrome"
          ? buildChromeWindowArgs({
              url: target.url,
              windowId: id,
              devtoolsPort: this.devtoolsPortFor(`win:${id}`),
              // POL-153 — carry the source's page zoom onto the placed Chrome (device scale factor),
              // so a web-window matches the iframe path's zoom.
              zoom: spec.window.zoom,
            })
          : buildSurfArgs({ url: target.url, inspector: false });
      child = spawnChild(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      this.pipeBrowserOutput(child, browser, `win:${id}`);
      this.log(`spawned ${browser} web-window pid=${child.pid ?? "?"} (${id}) → ${target.url}`);
    } catch (err) {
      sub.close();
      throw err;
    }

    this.windowConIds.delete(id);
    try {
      const conId = await sub.waitForWindow(child.pid ?? -1, PLACE_TIMEOUT_MS);
      // Record the con_id first so the surface toggles (fullscreen path) can address it, then place
      // to the standing surface state — FULLSCREEN like the player for a full single output (POL-162),
      // FLOATING + self-verify for a sub-region / multi-output span (POL-150/POL-152/POL-156).
      this.windowConIds.set(id, conId);
      await this.placeWindowSurface(id, conId);
      this.log(`placed web-window ${id} (con_id=${conId}) over ${spec.connectors.join("+")}`);
    } catch (err) {
      this.log(`web-window ${id} placement failed: ${(err as Error).message}`);
    } finally {
      sub.close();
    }
    return child;
  }

  async showWindow(win: WindowPlacement, connectors: string[]): Promise<void> {
    const bin = await this.ensureBin();
    await requireSwaymsg();
    const prev = this.windowSpecs.get(win.id);
    this.windowSpecs.set(win.id, { connectors, window: win });

    let supervised = this.windows.get(win.id);
    if (!supervised) {
      supervised = new SupervisedBrowser(
        `web-window ${win.id}`,
        (target) => this.launchAndPlaceWindow(win.id, bin, target),
        (m) => this.log(m),
      );
      this.windows.set(win.id, supervised);
    }

    // POL-153 — a zoom change is a LAUNCH change: Chrome's device scale factor is a launch flag, so a
    // new zoom must relaunch (like a url change), not just reposition. The connector set changing (a
    // wall span gained/lost an output) also needs a relaunch so the window is re-parented cleanly.
    const zoomChanged = (prev?.window.zoom ?? 1) !== win.zoom;
    const connectorsChanged = !sameStringSet(prev?.connectors ?? [], connectors);
    const conId = this.windowConIds.get(win.id);

    // Geometry-only change on a live window: re-place the existing container in place — no relaunch,
    // no flash (the agent-channel echo of D5). placeWindowSurface re-picks the path from the NEW spec
    // (already stored above), so a region change that flips full-region ↔ sub-region switches between
    // the POL-162 fullscreen path and the floating self-verify path cleanly.
    if (supervised.running && supervised.url === win.url && !zoomChanged && !connectorsChanged) {
      if (conId !== undefined) {
        await this.placeWindowSurface(win.id, conId);
        this.log(`web-window ${win.id}: re-placed over ${connectors.join("+")}`);
        return;
      }
      // Same target but we never learned its container id (an earlier placement failure) —
      // setTarget would no-op, so force a clean relaunch to get a placeable window back.
      await supervised.stop();
    } else if (supervised.running && (zoomChanged || connectorsChanged)) {
      // A url change relaunches via setTarget on its own; a zoom/span change with the SAME url would
      // otherwise be a no-op (SupervisedBrowser keys on the target), so stop first to force it.
      await supervised.stop();
    }
    await supervised.setTarget({ url: win.url, inspector: false });
  }

  async hideWindow(id: string): Promise<void> {
    const supervised = this.windows.get(id);
    // Capture the connectors BEFORE dropping the spec, so we can restore each player's fullscreen.
    const connectors = this.windowSpecs.get(id)?.connectors ?? [];
    this.windowSpecs.delete(id);
    this.windowConIds.delete(id);
    if (!supervised) {
      this.log(`hideWindow(${id}): nothing placed`);
      return;
    }
    await supervised.stop();
    this.windows.delete(id);
    // POL-162/POL-146 — the window is gone (its spec already dropped above); restore each output it
    // covered to its standing surface. Usually that fullscreens the player again (it reclaims the whole
    // glass), but if another web-window still covers the output the resolver keeps that one visible —
    // the SAME reconciled toggle POL-154's ident-off uses, so teardown and ident never disagree.
    for (const connector of connectors) {
      await this.restoreVisibleSurface(connector);
    }
    this.log(`hideWindow(${id}): torn down`);
  }

  /**
   * POL-154 — make a screen's ident flash visible even when a web-window (POL-18) occupies it. The
   * visible "which panel is this?" overlay is drawn by the PLAYER (server → player), but an OS-level
   * web-window floats ABOVE the player and hides it — page z-order loses to the compositor. So for the
   * flash we fullscreen THAT connector's player over the window (sway hides the floating window behind
   * a workspace-fullscreen view — the same mechanism POL-146 works around), let the player draw its
   * ident, then restore the window when the flash ends.
   *
   * Restore returns the player to its pre-ident state deterministically: fullscreen only if the output
   * no longer hosts a window (the backend's standing invariant), else back to windowed so the
   * web-window composites above again. Without a `connector` (the legacy machine-wide frame) this stays
   * the no-op it always was — the player overlay covers every other screen with nothing floated above.
   */
  async ident(on: boolean, connector?: string): Promise<void> {
    if (!connector) {
      this.log(`ident ${on ? "on" : "off"} — visible ident is server→player; agent no-op`);
      return;
    }
    if (on) {
      // Raise the player over any web-window for the duration of the flash. Fullscreening the player
      // takes the workspace's fullscreen from a full-region web-window (POL-162) or hides a floating
      // one (POL-146), so the player-drawn ident is visible either way.
      await this.setPlayerFullscreen(connector, true);
      this.log(`ident on (${connector}) — player raised over web-window for the flash`);
    } else {
      // Flash over: restore whichever surface should own this connector — a full-region web-window is
      // re-fullscreened, a floating one is revealed (player windowed), or the player reclaims the glass.
      // POL-154 reconciled with POL-162: ONE toggle, so a fullscreen web-window comes back fullscreen
      // (not left un-fullscreened as an un-reconciled `setPlayerFullscreen(false)` would leave it).
      await this.restoreVisibleSurface(connector);
      this.log(`ident off (${connector}) — web-window restored`);
    }
  }

  /**
   * Enable/disable inspection of `connector`'s page — browser-dependent (POL-50 / POL-67):
   *
   *   - chrome: ARM/DISARM the remote DevTools tunnel for this output. No relaunch, nothing on the
   *     glass; from here the agent honours `server/devtools-*` frames for this connector (see
   *     `devtoolsEndpoint`) and the operator drives DevTools from their own browser.
   *   - surf: relaunch with/without `-N` and pop the Web Inspector ON the panel — the only
   *     inspector WebKitGTK has (D63); the page reloads.
   */
  async inspect(connector: string, on: boolean): Promise<void> {
    const supervised = this.browsers.get(connector);
    if (!supervised) {
      throw new Error(`nothing is placed on ${connector} — no page to inspect`);
    }

    if ((await this.ensureBrowserKind()) === "chrome") {
      if (!supervised.running) {
        throw new Error(`the browser on ${connector} is not running — nothing to inspect`);
      }
      if (on) this.devtoolsArmed.add(connector);
      else this.devtoolsArmed.delete(connector);
      this.log(`inspect(${connector}): remote DevTools ${on ? "armed" : "disarmed"}`);
      return;
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

  /**
   * The loopback DevTools endpoint the agent may proxy to for `connector` (POL-67): non-null only
   * for a RUNNING Chrome on an output an operator ARMED. The port itself always listens (Chrome
   * takes it only at launch); this gate is what keeps it reachable strictly through the armed,
   * operator-authenticated tunnel.
   */
  devtoolsEndpoint(connector: string): { port: number } | null {
    if (this.browser !== "chrome") return null;
    if (!this.devtoolsArmed.has(connector)) return null;
    if (!this.browsers.get(connector)?.running) return null;
    const port = this.devtoolsPorts.get(connector);
    return port === undefined ? null : { port };
  }

  /** POL-101 — DPMS is always available under sway; CEC only if the box has an adapter (probed once). */
  powerCapabilities(): Promise<PowerCapabilities> {
    return this.power.capabilities();
  }

  /** POL-101 — sleep/wake this output's panel. See ./power.ts for why DPMS and CEC are two rungs. */
  setPower(connector: string, on: boolean): Promise<PanelPowerMethod[]> {
    return this.power.apply(connector, on);
  }

  // ── casting (POL-119) ─────────────────────────────────────────────────────────

  onCastSession(listener: (connector: string, active: boolean) => void): void {
    this.castSession = listener;
  }

  onCastPin(listener: (connector: string, pin: string | null) => void): void {
    this.castPin = listener;
  }

  /**
   * Reconcile one connector's cast receiver to `spec`. `{ name }` ensures a supervised UxPlay is
   * running and advertised under that name (a name change relaunches it — the mDNS rename);
   * `null` tears the receiver down, killing any live session with it. Idempotent both ways.
   */
  async setCast(connector: string, spec: { name: string } | null): Promise<void> {
    if (spec === null) {
      const inst = this.casts.get(connector);
      if (!inst) return;
      this.casts.delete(connector);
      inst.watch.close();
      inst.tracker.processEnded(); // clears any on-glass PIN with the receiver (POL-136)
      await inst.supervised.stop();
      if (inst.windows.size > 0) {
        // The operator pulled the plug mid-session: the windows die with the receiver, but sway's
        // close events land on a watch we just closed — report the session over ourselves.
        inst.windows.clear();
        this.castSession?.(connector, false);
      }
      this.log(`cast(${connector}): receiver torn down`);
      return;
    }
    await requireSwaymsg();
    const output = await this.resolveConnector(connector);
    const inst = this.ensureCast(connector, output);
    await inst.supervised.setTarget({ name: spec.name });
  }

  /** This connector's UxPlay base port — assigned once, in arrival order from the base. */
  private castPortFor(connector: string): number {
    let port = this.castPorts.get(connector);
    if (port === undefined) {
      port = CAST_PORT_BASE + CAST_PORT_STRIDE * this.castPorts.size;
      this.castPorts.set(connector, port);
    }
    return port;
  }

  private ensureCast(connector: string, output: string): CastInstance {
    let inst = this.casts.get(connector);
    if (inst) return inst;
    const basePort = this.castPortFor(connector);
    const created: CastInstance = {
      supervised: new SupervisedProcess<CastTarget>(
        connector,
        (target) => this.launchCast(connector, target, basePort),
        sameCastTarget,
        (t) => `cast receiver "${t.name}"`,
        "cast receiver",
        (m) => this.log(m),
      ),
      // The watch outlives any single receiver process (it respawns): match on the CURRENT
      // supervised pid per event. The app_id fallback is only safe when this is the box's sole
      // receiver — with two instances an anonymous "uxplay" window can't be attributed.
      watch: startPidWindowWatch(
        {
          matchesPid: (pid) => this.casts.get(connector)?.supervised.pid === pid,
          matchesAppId: (appId) => this.casts.size === 1 && matchesUxplayWindow(appId),
          onWindow: (conId) => this.onCastWindow(connector, output, conId),
          onClose: (conId) => this.onCastWindowClosed(connector, conId),
        },
        (m) => this.log(m),
      ),
      windows: new Set(),
      basePort,
      // POL-136 — the receiver prints its per-pairing PIN to stdout and never draws it, so the PIN
      // lifecycle rides the process output we supervise. Both callbacks are deliberately LOUD: a
      // pairing the panel can't explain is this ticket's whole failure mode.
      tracker: new CastPairingTracker({
        onPinChange: (pin) => {
          this.log(
            pin === null
              ? `cast(${connector}): pairing PIN cleared`
              : `cast(${connector}): sender pairing — PIN ${pin} must be visible on the panel now`,
          );
          this.castPin?.(connector, pin);
        },
        onPinMissing: () => {
          this.log(
            `cast(${connector}): *** a sender started pairing but NO PIN could be learned from the ` +
              `receiver's output — the phone is asking for a code the wall cannot show ` +
              `(uxplay output format changed?)`,
          );
        },
      }),
    };
    this.casts.set(connector, created);
    return created;
  }

  /** Launch one connector's UxPlay. No launch-time window wait: receiver windows appear at
   *  SENDER-CONNECT time (and per session), so placement rides the persistent watch instead. */
  private async launchCast(
    connector: string,
    target: CastTarget,
    basePort: number,
  ): Promise<ChildProcess> {
    const bin = await resolveUxplay();
    const regFile = castRegFileFor(connector);
    ensureCastStateDir(regFile);
    // Reap any receiver we don't track that still advertises this connector (an orphan from an
    // agent crash would hold the ports and the mDNS name). The reg-file path is this instance's
    // unique argv token, exactly like Chrome's --user-data-dir.
    await killStaleByToken(regFile, (m) => this.log(m));

    const args = buildUxplayArgs({
      name: target.name,
      basePort,
      regFile,
      mac: castDeviceMac(`${osHostname()}:${connector}`),
    });
    // POL-136 — the PIN only ever exists on the receiver's stdout, and UxPlay never flushes: into a
    // pipe, libc block-buffers its printf output at ~4 KiB, which can hold the PIN lines back past
    // the whole pairing window. `stdbuf -oL -eL` forces line buffering (and execs uxplay, so the
    // pid and cmdline stay pid-match/reap compatible). coreutils is Essential on the image, but a
    // box without stdbuf must still cast — just with the delayed-PIN risk called out LOUDLY.
    const hasStdbuf = await which("stdbuf");
    if (!hasStdbuf) {
      this.log(
        `cast(${connector}): *** stdbuf not found — the receiver's stdout will be block-buffered ` +
          `and pairing PINs may reach neither the panel nor the journal in time (install coreutils)`,
      );
    }
    const { cmd, argv } = wrapLineBuffered(bin, args, hasStdbuf);
    const child = spawnChild(cmd, argv, { stdio: ["ignore", "pipe", "pipe"] });
    this.pipeBrowserOutput(child, "uxplay", connector);
    // POL-136 — the PIN pairing lifecycle lives in the receiver's output (see cast.ts): feed every
    // line to this connector's tracker. This is SEPARATE from pipeBrowserOutput above, whose
    // "interesting lines only" journal filter would drop the PIN lines (none of them look like an
    // error — which is exactly how this stayed invisible in the logs too).
    this.pipeCastPairingOutput(child, connector);
    child.on("exit", () => this.casts.get(connector)?.tracker.processEnded());
    this.log(
      `spawned uxplay pid=${child.pid ?? "?"} for ${connector} — advertising "${target.name}" ` +
        `(ports ${basePort}-${basePort + 2}, PIN mode)`,
    );
    return child;
  }

  /** Feed the receiver's stdout+stderr, line by line, to its connector's pairing tracker. */
  private pipeCastPairingOutput(child: ChildProcess, connector: string): void {
    const sink = (): ((chunk: Buffer) => void) => {
      let buf = "";
      return (chunk: Buffer): void => {
        buf += chunk.toString("utf8");
        for (;;) {
          const nl = buf.indexOf("\n");
          if (nl < 0) break;
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          this.casts.get(connector)?.tracker.onLine(line);
        }
        // An unterminated tail longer than any real log line is noise (or binary). Keep the TAIL
        // rather than dropping wholesale, so a PIN line arriving right after a large newline-less
        // burst isn't truncated with it; the classifier shrugs at the garbled joint line.
        if (buf.length > 8192) buf = buf.slice(-4096);
      };
    };
    child.stdout?.on("data", sink());
    child.stderr?.on("data", sink());
  }

  /** A receiver window appeared (the mirror — POL-136 established the PIN prompt never is one):
   *  fullscreen it on the right output and, on the first window, report the session live.
   *  Placement is best-effort, like the browsers'. */
  private onCastWindow(connector: string, output: string, conId: number): void {
    const inst = this.casts.get(connector);
    if (!inst) return;
    inst.windows.add(conId);
    inst.tracker.windowAppeared(); // mirroring is starting — the pairing PIN has served its purpose
    if (inst.windows.size === 1) this.castSession?.(connector, true);
    void this.moveToOutput(conId, output)
      .then(() => this.log(`cast(${connector}): placed receiver window con_id=${conId} on ${output}`))
      .catch((err: Error) =>
        this.log(`cast(${connector}): placement of con_id=${conId} failed: ${err.message}`),
      );
  }

  /** A receiver window closed (sender disconnected / PIN done): report only when the LAST one goes —
   *  the scene content underneath is simply revealed, nothing to re-render. */
  private onCastWindowClosed(connector: string, conId: number): void {
    const inst = this.casts.get(connector);
    if (!inst) return;
    inst.windows.delete(conId);
    if (inst.windows.size === 0) this.castSession?.(connector, false);
  }

  /** POL-92 — the browsers this backend supervises, for the heartbeat's vitals sampler. */
  browserProbes(): BrowserProbe[] {
    return browserProbesFrom(this.browsers);
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
