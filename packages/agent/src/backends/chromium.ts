/**
 * chromium — kiosk-Chromium launch flags, crash-flag reset, per-output supervision.
 *
 * Phase 4. Shared by the wayland-sway and x11-i3 backends. We launch a **`.deb` Chromium**
 * (D27 — not the confined snap) in `--app`/`--kiosk` mode, one process per physical output,
 * each pinned to its own `--user-data-dir` (else a second launch just opens a tab in the
 * first — see docs/ARCHITECTURE.md "Gotchas").
 *
 * Supervision model (Model A): the AGENT owns its Chromium children and respawns them on exit;
 * systemd supervises the agent (Restart=always). Content never changes the Chromium URL — that
 * is fixed per screen and content flips happen inside the player over its own WS channel — so a
 * backend only (re)launches when the URL actually changes.
 *
 * The exact flag set + the `exit_type`/`exited_cleanly` Preferences reset come straight from
 * docs/ARCHITECTURE.md ("Chromium launch (per output)").
 */
import type { ChildProcess } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { escapeRegex, run, which } from "./proc";

/**
 * Popup / first-run / crash-bubble suppression set (docs/ARCHITECTURE.md). Keeping it as data
 * makes the launch flags auditable and identical across both backends.
 */
export const POPUP_SUPPRESSION_FLAGS: readonly string[] = [
  "--no-first-run",
  "--no-default-browser-check",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
  "--disable-infobars",
  "--noerrdialogs",
  "--disable-component-update",
  "--check-for-update-interval=31536000",
  "--disable-features=Translate,InfobarUI",
];

/** Candidate Chromium binary names, most-preferred first; `POLYPTIC_CHROMIUM` overrides. */
const CHROMIUM_CANDIDATES = [
  "chromium",
  "chromium-browser",
  "google-chrome-stable",
  "google-chrome",
  "chrome",
] as const;

// Supervision / respawn tuning.
const RESTART_BASE_MS = 750;
const RESTART_CAP_MS = 15_000;
const KILL_GRACE_MS = 4_000;

export interface ChromiumLaunchSpec {
  /** Player URL (already carrying `?screen=<id>`). Becomes `--app=<url>`. */
  url: string;
  /** Per-output profile directory → `--user-data-dir`. */
  profileDir: string;
  /** `wayland` (sway, native) or `x11` (X11/i3, or the XWayland placement fallback). */
  platform: "wayland" | "x11";
  /** `--force-device-scale-factor` (default 1, per ARCHITECTURE). */
  scaleFactor?: number;
  /**
   * WM class. X11: sets WM_CLASS so we can find the window (`--class=polyptic-<connector>`).
   * Wayland-native: Chromium reports `app_id="chromium"` regardless (placement keys on the
   * window's pid / launch order instead); only meaningful here for the XWayland fallback.
   */
  className?: string;
  /** X11 only — initial top-left in the root-window coordinate space (the output's offset). */
  position?: { x: number; y: number };
  /** X11 only — initial size (the output's resolution). */
  size?: { w: number; h: number };
  /**
   * GPU path. `"software"` appends `--disable-gpu` so Chromium's GPU process doesn't try (and fail
   * on) hardware GL on a no-3D GPU — e.g. a QEMU/UTM virtio-gpu without virgl. The compositor's
   * inherited `LIBGL_ALWAYS_SOFTWARE=1` does NOT reach Chromium's GPU process (Chromium defaults to
   * ANGLE and ignores it), so the flag must be explicit. `"hardware"` (default) leaves GPU accel on
   * so a real GPU wall is never handicapped. Verified on Ubuntu 26.04/arm64 virtio-gpu: with
   * `--disable-gpu` the player paints fullscreen; without it, no window ever appears.
   */
  render?: "hardware" | "software";
  /** Any extra flags (escape hatch, e.g. `--ignore-certificate-errors` in a lab). */
  extra?: string[];
}

/** Build the exact kiosk-Chromium argv for a given output. */
export function buildChromiumArgs(spec: ChromiumLaunchSpec): string[] {
  const scale = spec.scaleFactor ?? 1;
  const args: string[] = [
    `--ozone-platform=${spec.platform}`,
    `--app=${spec.url}`,
    "--kiosk",
    `--user-data-dir=${spec.profileDir}`,
    "--password-store=basic",
    `--force-device-scale-factor=${scale}`,
    ...POPUP_SUPPRESSION_FLAGS,
  ];
  // No-3D GPU: force software rendering for Chromium's GPU process (see ChromiumLaunchSpec.render).
  if (spec.render === "software") args.push("--disable-gpu");
  if (spec.className) args.push(`--class=${spec.className}`);
  if (spec.platform === "x11" && spec.position) {
    args.push(`--window-position=${spec.position.x},${spec.position.y}`);
  }
  if (spec.platform === "x11" && spec.size) {
    args.push(`--window-size=${spec.size.w},${spec.size.h}`);
  }
  if (spec.extra && spec.extra.length > 0) args.push(...spec.extra);
  return args;
}

/** Resolve the Chromium binary (or throw a clear error). `POLYPTIC_CHROMIUM` wins. */
export async function resolveChromium(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const override = env.POLYPTIC_CHROMIUM?.trim();
  const candidates = override ? [override] : [...CHROMIUM_CANDIDATES];
  for (const c of candidates) {
    if (await which(c)) return c;
  }
  throw new Error(
    `no Chromium binary found (tried: ${candidates.join(", ")}). Install the .deb Chromium ` +
      `(D27) or set POLYPTIC_CHROMIUM to the browser path.`,
  );
}

/** Base directory holding the per-output profiles. `POLYPTIC_PROFILE_DIR` overrides. */
export function profileBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.POLYPTIC_PROFILE_DIR?.trim();
  if (override && override.length > 0) return override;
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir();
  return join(home, ".polyptic", "profiles");
}

/** Filesystem-safe profile directory for `connector` (e.g. `DP-1` → `<base>/DP-1`). */
export function profileDirFor(connector: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(profileBaseDir(env), sanitizeConnector(connector));
}

/** Make a connector name safe as a filename / WM class token. */
export function sanitizeConnector(connector: string): string {
  return connector.replace(/[^A-Za-z0-9_.-]/g, "_") || "output";
}

/**
 * Reset Chromium's "did it exit cleanly?" markers in `<profileDir>/Default/Preferences` so a
 * power cut / SIGKILL never surfaces the "Restore pages?" bubble on next boot. Done in-process
 * (robust JSON edit with a regex fallback) instead of shelling out to `sed`. No-op when the
 * profile is fresh (Preferences absent). Never throws — a launch must not be blocked by this.
 */
export async function resetCrashFlags(
  profileDir: string,
  log: (msg: string) => void = () => {},
): Promise<void> {
  const prefs = join(profileDir, "Default", "Preferences");
  let raw: string;
  try {
    raw = await readFile(prefs, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      log(`crash-flag reset skipped for ${profileDir}: ${(err as Error).message}`);
    }
    return; // fresh profile (or unreadable) — Chromium will start clean
  }
  let next: string;
  try {
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const profile =
      obj.profile && typeof obj.profile === "object"
        ? (obj.profile as Record<string, unknown>)
        : {};
    profile.exit_type = "Normal";
    profile.exited_cleanly = true;
    obj.profile = profile;
    next = JSON.stringify(obj);
  } catch {
    // Couldn't parse (partial write?) — fall back to a targeted textual patch.
    next = raw
      .replace(/"exit_type":\s*"[^"]*"/g, '"exit_type":"Normal"')
      .replace(/"exited_cleanly":\s*(?:true|false)/g, '"exited_cleanly":true');
  }
  try {
    const tmp = `${prefs}.polyptic.tmp`;
    await writeFile(tmp, next);
    await rename(tmp, prefs); // atomic replace
  } catch (err) {
    log(`crash-flag reset write failed for ${profileDir}: ${(err as Error).message}`);
  }
}

/** Ensure a directory exists (recursive `mkdir -p`). */
export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

/**
 * Best-effort: kill any untracked browser process whose command line carries the unique `token`
 * — e.g. an orphan left running after the agent itself crashed and systemd restarted it. Scoped
 * tightly by that token so it only ever touches *this* output's browser. Requires `pgrep`; a
 * silent no-op without it.
 *
 * Generalised from `killStaleForProfile` so cog (which has no `--user-data-dir` token) can key the
 * reap on its unique player URL instead.
 */
export async function killStaleByToken(
  token: string,
  log: (msg: string) => void = () => {},
): Promise<void> {
  if (!(await which("pgrep"))) return;
  const res = await run("pgrep", ["-f", "--", escapeRegex(token)]);
  if (res.code !== 0) return; // none found
  const pids = res.stdout
    .split(/\s+/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isInteger(n) && n > 0 && n !== process.pid);
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      log(`reaped stale browser pid ${pid} (matched ${token})`);
    } catch {
      // already gone / not ours
    }
  }
}

/**
 * Best-effort: kill any Chromium still bound to `profileDir` that we don't track. Thin wrapper over
 * {@link killStaleByToken} keyed on the unique `--user-data-dir=<profileDir>` token, so it only
 * ever touches *this* output's browser.
 */
export async function killStaleForProfile(
  profileDir: string,
  log: (msg: string) => void = () => {},
): Promise<void> {
  await killStaleByToken(`--user-data-dir=${profileDir}`, log);
}

/** A backend-provided launcher: (re)launch+place Chromium for one URL, returning the child. */
export type LaunchFn = (url: string) => Promise<ChildProcess>;

/**
 * One supervised kiosk-Chromium for one output. Owns the child's lifecycle:
 *   - `setUrl(url)` — no-op if already running that URL, else (re)launch (relaunch = repoint;
 *     a fixed-per-screen URL means this is rare),
 *   - respawn-on-exit with capped exponential backoff while a URL is still desired,
 *   - `stop()` — clear the desired URL and terminate the child.
 *
 * A monotonically increasing generation guards against a just-killed child's `exit` handler
 * racing a fresh launch into a duplicate respawn.
 */
export class SupervisedChromium {
  private child: ChildProcess | null = null;
  private desiredUrl: string | null = null;
  private stopping = false;
  private currentGen = 0;
  private restartAttempt = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly connector: string,
    private readonly launch: LaunchFn,
    private readonly log: (msg: string) => void,
  ) {}

  /** Is a child currently alive? */
  get running(): boolean {
    const c = this.child;
    return c !== null && c.exitCode === null && c.signalCode === null && !c.killed;
  }

  /** The URL this output is meant to show, or `null` if torn down. */
  get url(): string | null {
    return this.desiredUrl;
  }

  /** Point this output at `url`. Idempotent: a no-op when already running that exact URL. */
  async setUrl(url: string): Promise<void> {
    if (this.desiredUrl === url && this.running) {
      this.log(`showScreen(${this.connector}): already showing ${url} — no-op`);
      return;
    }
    this.desiredUrl = url;
    this.stopping = false;
    this.restartAttempt = 0;
    this.clearRestartTimer();
    await this.killChild();
    await this.spawnCycle();
  }

  /** Tear down this output's Chromium and stop supervising it. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.desiredUrl = null;
    this.clearRestartTimer();
    await this.killChild();
  }

  private async spawnCycle(): Promise<void> {
    if (this.stopping) return;
    const url = this.desiredUrl;
    if (url === null) return;
    const myGen = ++this.currentGen;
    let child: ChildProcess;
    try {
      child = await this.launch(url);
    } catch (err) {
      this.log(`launch failed for ${this.connector}: ${(err as Error).message}`);
      // Transient failures (compositor busy, brief tool hiccup) recover via backoff; a hard
      // misconfig keeps failing slowly rather than hot-looping. Surface to the caller too.
      if (!this.stopping && this.desiredUrl !== null) this.scheduleRestart();
      throw err;
    }
    if (myGen !== this.currentGen) {
      // Superseded while we were launching (another setUrl/kill arrived) — kill this orphan.
      this.terminate(child);
      return;
    }
    this.child = child;
    this.restartAttempt = 0;
    child.once("exit", (code, signal) => {
      if (myGen !== this.currentGen) return; // intentional kill / superseded
      this.child = null;
      this.log(
        `Chromium for ${this.connector} exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
      );
      if (this.stopping || this.desiredUrl === null) return;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping || this.desiredUrl === null) return;
    const backoff = Math.min(RESTART_CAP_MS, RESTART_BASE_MS * 2 ** this.restartAttempt);
    const wait = backoff + Math.floor(Math.random() * 250);
    this.restartAttempt += 1;
    this.log(`respawning Chromium for ${this.connector} in ${wait}ms (attempt ${this.restartAttempt})`);
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      void this.spawnCycle().catch(() => {
        // already logged; the next exit / scheduleRestart keeps the retry loop alive
      });
    }, wait);
  }

  private clearRestartTimer(): void {
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
  }

  /** Terminate + await the tracked child, escalating SIGTERM → SIGKILL. */
  private async killChild(): Promise<void> {
    this.currentGen++; // invalidate the current child's exit handler (no respawn from this kill)
    const child = this.child;
    this.child = null;
    if (!child || child.exitCode !== null || child.signalCode !== null || child.killed) return;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        clearTimeout(killTimer);
        resolve();
      };
      child.once("exit", finish);
      const killTimer = setTimeout(() => {
        try {
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        } catch {
          // already gone
        }
      }, KILL_GRACE_MS);
      try {
        child.kill("SIGTERM");
      } catch {
        finish();
      }
    });
  }

  /** Fire-and-forget terminate of an untracked/orphaned child (superseded launch). */
  private terminate(child: ChildProcess): void {
    try {
      child.kill("SIGTERM");
    } catch {
      return;
    }
    setTimeout(() => {
      try {
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      } catch {
        // gone
      }
    }, KILL_GRACE_MS);
  }
}
