/**
 * The scene scheduler's ticker (POL-89 / D93, per-mural + panel power at POL-186) — the half that
 * actually fires.
 *
 * Every few seconds it asks the SHARED resolver (`@polyptic/protocol`, the same function the
 * console's week strip paints with) one question PER MURAL: "what should this wall be doing right
 * now?" — and the answer has two parts, content and power. That is the whole design:
 *
 *   - RESOLUTION IS PER MURAL. A deployment is a fleet of walls, not one wall; each mural keeps its
 *     own remembered CONTENT verdict (`lastVerdicts`, keyed by mural id), so a schedule on one wall
 *     never fires, skips, or double-applies because of what another wall is doing.
 *   - CONTENT fan-out is unchanged. `apply` is the same code the operator's Apply button runs, so a
 *     scene reaches the glass over the ordinary `server/render` WS push, in the ordinary <150ms, with
 *     no reload. Agents and players learn nothing new; nothing in either package changed for this.
 *   - CONTENT fires on a CHANGE OF VERDICT, never on a timer edge, per mural. Two consequences, both
 *     wanted:
 *       (a) an operator who applies a scene by hand mid-window KEEPS it — the resolver's verdict for
 *           that mural has not changed, so the ticker has nothing to say — until the next boundary
 *           takes the wall back. The schedule is the floor, not a leash.
 *       (b) DST cannot double-fire. When the clocks go back and 01:30 happens twice, the verdict at
 *           the second 01:30 is the verdict from the first one, so nothing is re-applied. And it
 *           cannot skip: a window that SPANS a spring-forward gap still contains the local time on
 *           the other side. (A window that starts INSIDE the gap has no wall-clock moment to fire
 *           on at all, and correctly does not run that day.)
 *   - POWER is the new half (POL-186): the same per-mural resolution also carries `panels` — `"on"`,
 *     `"off"`, or `null` when no enabled window governs the mural (leave it exactly as it is). The
 *     ticker hands that verdict to the OPTIONAL `panelPower` seam UNCONDITIONALLY, every mural, every
 *     tick — there is no gate here. Edge-triggering for power lives entirely in the seam itself
 *     (`panel-power.ts`'s `lastDesired`), which is keyed PER SCREEN, not per mural: a mural's verdict
 *     is a poor place to dedupe from, because a screen can join or leave a mural (an operator drags it
 *     onto a different wall) without the mural's own verdict ever changing, and a mural-level gate
 *     would leave that screen unrecorded and unactioned until the next boundary — and the seam's
 *     memory records WHICH mural spoke, so a screen dragged off the wall that slept it is woken here
 *     rather than left dark. Calling
 *     `applyMuralPower` every ~10s per mural is one cheap in-memory sweep; the seam already does a
 *     sweep of this shape across the whole fleet every 30s. In hours, the only command this can ever
 *     produce is WAKE — nothing here infers power from idleness, load, or connectivity; that
 *     inference does not exist. A DISABLED tick still calls the seam, once per mural, with `null`:
 *     switching the scheduler off governs nothing, and the seam is where a screen the schedule had
 *     slept is woken on its way out of being governed. Returning before the seam — which is what
 *     this used to do — made "turn the schedule off" the one action that could strand a wall dark.
 *   - on BOOT it asserts every mural's schedule once: the first tick applies what the schedule says
 *     for each mural (content) and sends each mural's power verdict (power), unless the right scene
 *     is already live. A control plane that restarts at 09:05 puts the morning wall back up by
 *     itself, on every screen it owns — and a box that reconnects later reconciles on hello (POL-186
 *     panel-power.ts), independent of the ticker's edge-triggering.
 *
 * The clock is INJECTED (`now`), so the boundary behaviour is tested by driving time rather than by
 * sleeping through it — the same seam as `disarmExpiredShells(ttl, nowMs, …)`.
 */
import { resolveMuralAt } from "@polyptic/protocol";
import type { MuralResolution, PanelState } from "@polyptic/protocol";

import type { FastifyBaseLogger } from "fastify";

import type { ActivityLog } from "./activity";
import type { ControlPlane } from "./state";
import { serverEvent } from "./logs";
import type { FleetLogger } from "./logs";

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
  /**
   * POL-186 — the panel-power seam (Task 7's `panel-power.ts` in production; a fake in tests). Called
   * once per mural per tick with that mural's resolved panel state (`null` = ungoverned — pass it
   * straight through, never coerce it) and the daypart name driving the verdict, for the seam's own
   * log line. Called for every mural on a DISABLED tick too, with `null`: the master switch is
   * "no window governs anything" by another route, and the seam is where a screen the schedule slept
   * gets woken on the way out. `ungovernedReason` names that route in the operator's activity line
   * ("Atrium woke — the scheduler is switched off"); it is only ever read on a `null` verdict.
   * Optional so a deployment that hasn't wired power control yet keeps working exactly as before.
   */
  panelPower?: {
    applyMuralPower(
      muralId: string,
      panels: PanelState | null,
      daypartName: string,
      ungovernedReason?: string,
    ): void;
  };
  /**
   * POL-187 — the fleet log sink. The ticker's verdicts are the control plane's account of what a
   * wall was SUPPOSED to be doing at 03:00, which is the other half of every "why was that panel
   * dark" investigation. Optional so a test builds a scheduler without a log volume.
   */
  logs?: FleetLogger;
  /** Injected clock (tests drive it; production passes `Date.now`). */
  now?: () => number;
  tickMs?: number;
}

/** Why the ticker did (or didn't) apply a scene to one mural this tick. */
export type TickReason = "applied" | "unchanged" | "already-live" | "nothing-scheduled" | "missing-scene";

/** What one tick decided, across every mural — returned for tests and for the log line. */
export interface TickOutcome {
  /** Every mural's resolution this tick, content and power both — best-first candidates included. */
  resolutions: MuralResolution[];
  /** The scenes this tick actually applied (one entry per mural that changed content). */
  applied: string[];
  /** Mural id → why. Empty when the scheduler is disabled (nothing was evaluated at all). */
  reasons: Record<string, TickReason>;
}

export class SceneScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  /** The last CONTENT verdict the ticker acted on, per mural. Unset = never resolved (boot). */
  private readonly lastVerdicts = new Map<string, string | null>();

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

  /** Every mural resolved at `nowMs`, with no side effects — the read-only view used when a tick is
   *  skipped (already running) or errors, so callers still see a fresh resolution. */
  private resolveAll(nowMs: number): MuralResolution[] {
    const set = this.deps.control.getScheduleSet();
    return set.murals.map((muralId) => resolveMuralAt(nowMs, set, muralId));
  }

  /** One evaluation. `nowMs` is injectable so tests drive the clock instead of sleeping. */
  async tick(nowMs: number = this.now()): Promise<TickOutcome> {
    if (this.running) {
      // A previous tick is still applying (an apply is several awaits). Skipping is correct: the
      // next tick re-resolves every mural from scratch against a fresh clock.
      return { resolutions: this.resolveAll(nowMs), applied: [], reasons: {} };
    }
    this.running = true;
    try {
      return await this.evaluate(nowMs);
    } catch (err) {
      this.deps.log.error(
        { event: "scheduler.tick_error", err: (err as Error).message },
        "scene scheduler tick failed",
      );
      return { resolutions: this.resolveAll(nowMs), applied: [], reasons: {} };
    } finally {
      this.running = false;
    }
  }

  private async evaluate(nowMs: number): Promise<TickOutcome> {
    const control = this.deps.control;
    const set = control.getScheduleSet();
    const resolutions: MuralResolution[] = [];
    const applied: string[] = [];
    const reasons: Record<string, TickReason> = {};

    if (!set.settings.enabled) {
      // A disabled scheduler forgets every mural's CONTENT verdict, so switching it back on
      // re-asserts the schedule on every wall instead of trusting stale memory. Power has no
      // scheduler-side memory to forget — see below.
      this.lastVerdicts.clear();
      // POWER STILL GOES THROUGH THE SEAM. Switching the scheduler off is "no window governs any
      // mural" by another route, and it is exactly what an operator does when panels misbehave — so
      // returning here, as this used to, meant the one action taken to stop the schedule darkening
      // walls was the action that left them dark with nothing able to wake them. `null` for every
      // mural is the truth of a disabled scheduler, and the seam already knows what a screen entering
      // ungoverned deserves: a wake if the SCHEDULE slept it, silence if a human did.
      for (const muralId of set.murals) {
        this.deps.panelPower?.applyMuralPower(muralId, null, "the scheduler is switched off", "the scheduler is switched off");
      }
      return { resolutions, applied, reasons };
    }

    for (const muralId of set.murals) {
      const resolution = resolveMuralAt(nowMs, set, muralId);
      resolutions.push(resolution);

      // POWER, resolved and handed off independently of content, UNCONDITIONALLY — no gate here.
      // Edge-triggering for power belongs to the seam, keyed per SCREEN (a mural-level gate would
      // miss a screen that joins or moves onto this mural without the mural's own verdict changing).
      // The name below is the second half of an operator-facing activity line ("Atrium woke — …"),
      // so it has to say something. A GAP between windows has no candidates at all, and that is the
      // 07:00 wake: nothing is scheduled over this hour, which is precisely why the wall is lit.
      // Naming that beats "a scheduled window", which points at a window that does not exist.
      this.deps.panelPower?.applyMuralPower(
        muralId,
        resolution.panels,
        resolution.candidates[0]?.daypartName ?? "outside its scheduled windows",
      );

      // CONTENT.
      const target = resolution.sceneId;
      if (target === null) {
        // No window covers this moment and there is no default scene for THIS mural — leave the
        // wall exactly as it is.
        this.lastVerdicts.set(muralId, null);
        reasons[muralId] = "nothing-scheduled";
        continue;
      }

      if (this.lastVerdicts.get(muralId) === target) {
        // Same verdict as last tick: an operator's manual Apply stands until the next boundary.
        reasons[muralId] = "unchanged";
        continue;
      }

      const scene = control.getScene(target);
      if (!scene) {
        this.lastVerdicts.set(muralId, target);
        this.deps.log.warn(
          { event: "scheduler.missing_scene", muralId, sceneId: target, scheduleId: resolution.scheduleId },
          "the schedule resolves to a scene that no longer exists — nothing applied",
        );
        this.deps.logs?.record(
          serverEvent("warn", "scheduler", "the schedule resolves to a scene that no longer exists — nothing applied", {
            fields: { muralId, sceneId: target },
          }),
        );
        reasons[muralId] = "missing-scene";
        continue;
      }

      // The verdict changed but the wall is already showing it (a boot into the right scene, or an
      // operator who pre-applied it) — record the verdict, spare the fleet a pointless re-render.
      if (control.getActiveSceneId(muralId) === target) {
        this.lastVerdicts.set(muralId, target);
        reasons[muralId] = "already-live";
        continue;
      }

      this.lastVerdicts.set(muralId, target);
      const ok = await this.deps.apply(target);
      if (!ok) {
        this.deps.log.warn(
          { event: "scheduler.apply_failed", muralId, sceneId: target },
          "the scheduled scene could not be applied",
        );
        this.deps.logs?.record(
          serverEvent("warn", "scheduler", "a scheduled scene could not be applied", {
            fields: { muralId, sceneId: target },
          }),
        );
        reasons[muralId] = "missing-scene";
        continue;
      }

      applied.push(target);
      reasons[muralId] = "applied";
      const window =
        resolution.source === "default"
          ? "the default scene"
          : (resolution.candidates[0]?.daypartName ?? "a scheduled window");
      this.deps.log.info(
        {
          event: "scheduler.applied",
          muralId,
          sceneId: target,
          scheduleId: resolution.scheduleId,
          source: resolution.source,
          overridden: resolution.candidates.slice(1).map((c) => c.scheduleId),
          timezone: set.settings.timezone,
        },
        "scene scheduler applied a scene",
      );
      this.deps.logs?.record(
        serverEvent("info", "scheduler", `applied scene "${scene.name}" to a mural — ${window}`, {
          fields: {
            muralId,
            sceneId: target,
            source: resolution.source,
            timezone: set.settings.timezone,
          },
        }),
      );
      // applyScene already pushes its own "Applied scene X" line; this one says WHY it happened.
      this.deps.activity?.push("info", `Schedule: ${scene.name} — ${window}`);
    }

    return { resolutions, applied, reasons };
  }
}
