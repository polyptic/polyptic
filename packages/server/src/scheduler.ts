/**
 * The scene scheduler's ticker (POL-89 / D93) — the half that actually fires.
 *
 * Every few seconds it asks the SHARED resolver (`@polyptic/protocol`, the same function the
 * console's week strip paints with) one question: "what scene should be on the wall right now?" —
 * and when the answer CHANGES, it calls the EXISTING applyScene path. That is the whole design:
 *
 *   - fan-out is unchanged. `apply` is the same code the operator's Apply button runs, so the scene
 *     reaches the glass over the ordinary `server/render` WS push, in the ordinary <150ms, with no
 *     reload. Agents and players learn nothing new; nothing in either package changed for this.
 *   - it fires on a CHANGE OF VERDICT, never on a timer edge. Two consequences, both wanted:
 *       (a) an operator who applies a scene by hand mid-window KEEPS it — the resolver's verdict has
 *           not changed, so the ticker has nothing to say — until the next boundary takes the wall
 *           back. The schedule is the floor, not a leash.
 *       (b) DST cannot double-fire. When the clocks go back and 01:30 happens twice, the verdict at
 *           the second 01:30 is the verdict from the first one, so nothing is re-applied. And it
 *           cannot skip: a window that SPANS a spring-forward gap still contains the local time on
 *           the other side. (A window that starts INSIDE the gap has no wall-clock moment to fire
 *           on at all, and correctly does not run that day.)
 *   - on BOOT it asserts the schedule once: the first tick applies what the schedule says unless
 *     the right scene is already live. A control plane that restarts at 09:05 puts the morning wall
 *     back up by itself.
 *
 * The clock is INJECTED (`now`), so the boundary behaviour is tested by driving time rather than by
 * sleeping through it — the same seam as `disarmExpiredShells(ttl, nowMs, …)`.
 */
import { resolveAt } from "@polyptic/protocol";
import type { ScheduleResolution } from "@polyptic/protocol";

import type { FastifyBaseLogger } from "fastify";

import type { ActivityLog } from "./activity";
import type { ControlPlane } from "./state";

/** How often the ticker re-resolves. A scene lands within this of its window boundary (DoD: seconds). */
export const DEFAULT_TICK_MS = 10_000;

export interface SceneSchedulerDeps {
  control: ControlPlane;
  /**
   * Apply a scene and fan it out — the SAME closure the REST apply route runs (applyScene + a
   * `server/render` per touched screen + an admin broadcast). Returns false when the scene is gone.
   */
  apply: (sceneId: string) => Promise<boolean>;
  log: FastifyBaseLogger;
  activity?: ActivityLog;
  /** Injected clock (tests drive it; production passes `Date.now`). */
  now?: () => number;
  tickMs?: number;
}

/** What one tick decided — returned for tests and for the log line. */
export interface TickOutcome {
  resolution: ScheduleResolution;
  /** The scene this tick applied, or null when it applied nothing (no change / nothing to play). */
  applied: string | null;
  reason: "applied" | "unchanged" | "already-live" | "disabled" | "nothing-scheduled" | "missing-scene";
}

export class SceneScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** The last verdict the ticker acted on. `undefined` = it has never resolved (boot). */
  private lastVerdict: string | null | undefined = undefined;

  private readonly now: () => number;
  private readonly tickMs: number;

  constructor(private readonly deps: SceneSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.tickMs = deps.tickMs ?? DEFAULT_TICK_MS;
  }

  /** Start ticking (idempotent). The first tick runs immediately, so a boot asserts the schedule. */
  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => {
      void this.tick();
    }, this.tickMs);
    // Never hold the process open for the scheduler alone (tests, CLIs).
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Re-resolve NOW. Called by the REST layer after any schedule/daypart/settings mutation, so a
   * schedule the operator just saved takes the wall immediately instead of on the next tick.
   */
  kick(): void {
    void this.tick();
  }

  /** One evaluation. `nowMs` is injectable so tests drive the clock instead of sleeping. */
  async tick(nowMs: number = this.now()): Promise<TickOutcome> {
    if (this.running) {
      // A previous tick is still applying (an apply is several awaits). Skipping is correct: the
      // next tick re-resolves from scratch against a fresh clock.
      const resolution = resolveAt(nowMs, this.deps.control.getScheduleSet());
      return { resolution, applied: null, reason: "unchanged" };
    }
    this.running = true;
    try {
      return await this.evaluate(nowMs);
    } catch (err) {
      this.deps.log.error(
        { event: "scheduler.tick_error", err: (err as Error).message },
        "scene scheduler tick failed",
      );
      const resolution = resolveAt(nowMs, this.deps.control.getScheduleSet());
      return { resolution, applied: null, reason: "unchanged" };
    } finally {
      this.running = false;
    }
  }

  private async evaluate(nowMs: number): Promise<TickOutcome> {
    const control = this.deps.control;
    const set = control.getScheduleSet();
    const resolution = resolveAt(nowMs, set);

    if (!set.settings.enabled) {
      // A disabled scheduler forgets its verdict, so switching it back on re-asserts the schedule.
      this.lastVerdict = undefined;
      return { resolution, applied: null, reason: "disabled" };
    }

    const target = resolution.sceneId;
    if (target === null) {
      // No window covers this moment and there is no default scene — leave the wall exactly as it is.
      this.lastVerdict = null;
      return { resolution, applied: null, reason: "nothing-scheduled" };
    }

    if (this.lastVerdict === target) {
      // Same verdict as last tick: an operator's manual Apply stands until the next boundary.
      return { resolution, applied: null, reason: "unchanged" };
    }

    if (!control.getScene(target)) {
      this.lastVerdict = target;
      this.deps.log.warn(
        { event: "scheduler.missing_scene", sceneId: target, scheduleId: resolution.scheduleId },
        "the schedule resolves to a scene that no longer exists — nothing applied",
      );
      return { resolution, applied: null, reason: "missing-scene" };
    }

    // The verdict changed but the wall is already showing it (a boot into the right scene, or an
    // operator who pre-applied it) — record the verdict, spare the fleet a pointless re-render.
    if (control.state.activeSceneId === target) {
      this.lastVerdict = target;
      return { resolution, applied: null, reason: "already-live" };
    }

    this.lastVerdict = target;
    const applied = await this.deps.apply(target);
    if (!applied) {
      this.deps.log.warn(
        { event: "scheduler.apply_failed", sceneId: target },
        "the scheduled scene could not be applied",
      );
      return { resolution, applied: null, reason: "missing-scene" };
    }

    const sceneName = control.getScene(target)?.name ?? target;
    const window =
      resolution.source === "default"
        ? "the default scene"
        : (resolution.candidates[0]?.daypartName ?? "a scheduled window");
    this.deps.log.info(
      {
        event: "scheduler.applied",
        sceneId: target,
        scheduleId: resolution.scheduleId,
        source: resolution.source,
        overridden: resolution.candidates.slice(1).map((c) => c.scheduleId),
        timezone: set.settings.timezone,
      },
      "scene scheduler applied a scene",
    );
    // applyScene already pushes its own "Applied scene X" line; this one says WHY it happened.
    this.deps.activity?.push("info", `Schedule: ${sceneName} — ${window}`);
    return { resolution, applied: target, reason: "applied" };
  }
}
