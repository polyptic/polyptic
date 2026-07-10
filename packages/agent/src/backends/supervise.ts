/**
 * supervise — per-output browser lifecycle, independent of which browser that is.
 *
 * Supervision model (Model A): the AGENT owns its browser children and respawns them on exit;
 * systemd supervises the agent (Restart=always). Content never changes the browser's URL — that is
 * fixed per screen and content flips happen inside the player over its own WS channel — so a backend
 * only (re)launches when the launch TARGET actually changes.
 *
 * The target is `(url, inspector)`: the second field exists because surf can only be given its Web
 * Inspector at launch (`-N`), so popping the inspector on a wall means relaunching that output's
 * browser. See ./inspector.ts.
 */
import type { ChildProcess } from "node:child_process";
import { escapeRegex, run, which } from "./proc";

// Supervision / respawn tuning.
const RESTART_BASE_MS = 750;
const RESTART_CAP_MS = 15_000;
const KILL_GRACE_MS = 4_000;

/** What one output should be showing, and how. A change to either field forces a relaunch. */
export interface LaunchTarget {
  /** Player URL (already carrying `?screen=<id>`). */
  url: string;
  /** Launch with the browser's Web Inspector enabled (surf `-N`), so it can be popped on the wall. */
  inspector: boolean;
}

/** Are two targets the same launch? */
function sameTarget(a: LaunchTarget | null, b: LaunchTarget | null): boolean {
  if (a === null || b === null) return a === b;
  return a.url === b.url && a.inspector === b.inspector;
}

/** Make a connector name safe as a filename / WM class token. */
export function sanitizeConnector(connector: string): string {
  return connector.replace(/[^A-Za-z0-9_.-]/g, "_") || "output";
}

/**
 * Best-effort: kill any untracked browser process whose command line carries the unique `token`
 * — e.g. an orphan left running after the agent itself crashed and systemd restarted it. Scoped
 * tightly by that token so it only ever touches *this* output's browser. Requires `pgrep`; a
 * silent no-op without it.
 *
 * surf has no per-instance flag to key on, so callers pass the unique player URL instead.
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

/** A backend-provided launcher: (re)launch+place the browser for one target, returning the child. */
export type LaunchFn = (target: LaunchTarget) => Promise<ChildProcess>;

/**
 * One supervised kiosk browser for one output. Owns the child's lifecycle:
 *   - `setTarget(t)` — no-op if already running that exact target, else (re)launch,
 *   - respawn-on-exit with capped exponential backoff while a target is still desired,
 *   - `stop()` — clear the desired target and terminate the child.
 *
 * A monotonically increasing generation guards against a just-killed child's `exit` handler
 * racing a fresh launch into a duplicate respawn.
 */
export class SupervisedBrowser {
  private child: ChildProcess | null = null;
  private desired: LaunchTarget | null = null;
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

  /** The live child's pid, or `null` when nothing is running (used to focus its window). */
  get pid(): number | null {
    return this.running ? (this.child?.pid ?? null) : null;
  }

  /** The URL this output is meant to show, or `null` if torn down. */
  get url(): string | null {
    return this.desired?.url ?? null;
  }

  /** Is this output's browser currently running with its Web Inspector enabled? */
  get inspector(): boolean {
    return this.desired?.inspector ?? false;
  }

  /** Point this output at `url`, preserving the current inspector setting. */
  async setUrl(url: string): Promise<void> {
    await this.setTarget({ url, inspector: this.inspector });
  }

  /**
   * Relaunch this output's browser with its Web Inspector enabled/disabled. Throws when nothing is
   * placed on the connector — there is no page to inspect.
   */
  async setInspector(on: boolean): Promise<void> {
    const url = this.url;
    if (url === null) throw new Error(`nothing is placed on ${this.connector}`);
    await this.setTarget({ url, inspector: on });
  }

  /** Launch (or relaunch) this output at `target`. Idempotent: a no-op when already running it. */
  async setTarget(target: LaunchTarget): Promise<void> {
    if (sameTarget(this.desired, target) && this.running) {
      this.log(`${this.connector}: already showing ${target.url} — no-op`);
      return;
    }
    this.desired = target;
    this.stopping = false;
    this.restartAttempt = 0;
    this.clearRestartTimer();
    await this.killChild();
    await this.spawnCycle();
  }

  /** Tear down this output's browser and stop supervising it. */
  async stop(): Promise<void> {
    this.stopping = true;
    this.desired = null;
    this.clearRestartTimer();
    await this.killChild();
  }

  private async spawnCycle(): Promise<void> {
    if (this.stopping) return;
    const target = this.desired;
    if (target === null) return;
    const myGen = ++this.currentGen;
    let child: ChildProcess;
    try {
      child = await this.launch(target);
    } catch (err) {
      this.log(`launch failed for ${this.connector}: ${(err as Error).message}`);
      // Transient failures (compositor busy, brief tool hiccup) recover via backoff; a hard
      // misconfig keeps failing slowly rather than hot-looping. Surface to the caller too.
      if (!this.stopping && this.desired !== null) this.scheduleRestart();
      throw err;
    }
    if (myGen !== this.currentGen) {
      // Superseded while we were launching (another setTarget/kill arrived) — kill this orphan.
      this.terminate(child);
      return;
    }
    this.child = child;
    this.restartAttempt = 0;
    child.once("exit", (code, signal) => {
      if (myGen !== this.currentGen) return; // intentional kill / superseded
      this.child = null;
      this.log(
        `browser for ${this.connector} exited (code=${code ?? "null"} signal=${signal ?? "null"})`,
      );
      if (this.stopping || this.desired === null) return;
      this.scheduleRestart();
    });
  }

  private scheduleRestart(): void {
    if (this.restartTimer || this.stopping || this.desired === null) return;
    const backoff = Math.min(RESTART_CAP_MS, RESTART_BASE_MS * 2 ** this.restartAttempt);
    const wait = backoff + Math.floor(Math.random() * 250);
    this.restartAttempt += 1;
    this.log(`respawning browser for ${this.connector} in ${wait}ms (attempt ${this.restartAttempt})`);
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
