/**
 * AlertEngine (POL-91) — the thing that notices, so nobody has to walk past the console.
 *
 * The control plane already HOLDS every signal an operator cares about: an agent socket that dropped,
 * a screen with content but no player, an agent heartbeat whose per-connector report says the browser
 * is not on the glass, an image rebuild that failed. Until now those only ever became a line in a feed
 * nobody is watching. This engine turns them into ALERTS with a lifecycle, and hands the lifecycle to
 * NotificationService (webhook / SMTP).
 *
 * THE SHAPE, and why it survives the next signal:
 *   - A **probe** is `() => Problem[]` — the set of problems of one kind that exist RIGHT NOW. It is
 *     stateless and knows nothing about rules, debounce, delivery or history.
 *   - The **engine** diffs that set across ticks. It owns everything temporal: first-seen, debounce,
 *     firing, resolve, delivery, retry.
 *   Adding a signal is therefore one `AlertKind` in the contract plus one probe here — no engine
 *   change. That is deliberate: PR #81 (POL-92, machine vitals: cpu/mem/gpuAccel on the heartbeat) and
 *   PR #82 (POL-94, a player-reported per-source health signal) are both natural alert sources, and
 *   both land as a probe over state they already put in Presence/the control plane.
 *
 * DEBOUNCE. A problem must persist CONTINUOUSLY for a rule's `debounceSeconds` before that rule
 * delivers ("offline > 3 min"). A box that flaps for 20 seconds pages nobody. Debounce is per RULE
 * (one team wants a 30s webhook, another a 10-minute email), while the console's alert chip lights up
 * at the SHORTEST debounce among the enabled rules that would deliver the kind (or DEFAULT_DEBOUNCE_MS
 * when no rule covers it — an unwatched deployment still shows its own alerts).
 *
 * EXACTLY ONCE, AND IT CLEARS. Each (alert, rule) pair delivers ONE firing and, when the problem goes
 * away, ONE resolve — and only if that pair actually delivered the firing (an alert that clears while
 * you were never told about it is not news). A failed delivery is retried on the next tick, up to
 * MAX_ATTEMPTS, so a webhook sink that was briefly down still gets the page.
 *
 * Alerts are NOT persisted: they are a pure function of live signals, so a restart re-derives them
 * (with the debounce clock restarting — a control plane that just booted should not page you about a
 * box it has not heard from yet).
 */
import { randomUUID } from "node:crypto";

import { Alert, AlertEvent } from "@polyptic/protocol";
import type { Alert as AlertType, AlertKind, AlertSubject } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

import type { ActivityLog } from "./activity";
import type { Presence } from "./admin";
import type { PlayerHub } from "./hub";
import type { NotificationService } from "./notify";
import type { PersistedNotificationRule } from "./store";
import type { ControlPlane } from "./state";

/** One problem, as a probe sees it: no history, no delivery, just "this is wrong, right now". */
export interface Problem {
  kind: AlertKind;
  /** Unique within the kind — the machine id, the screen id, the failed build's start time. */
  key: string;
  title: string;
  detail?: string;
  subject: AlertSubject;
}

export type AlertProbe = () => Problem[] | Promise<Problem[]>;

/** How long a problem must persist before the CONSOLE calls it an alert, when no rule sets the pace. */
export const DEFAULT_DEBOUNCE_MS = 60_000;
/** Give up on a rule after this many failed attempts at one delivery (then log loudly and move on). */
const MAX_ATTEMPTS = 5;

interface Tracked {
  problem: Problem;
  /** Epoch ms the problem was first observed (the debounce clock's zero). */
  firstSeen: number;
  /** Epoch ms it passed the console's debounce and became a visible alert. */
  firedAt?: number;
  /** ruleId → delivery state for the FIRING event of this alert. */
  deliveries: Map<string, { delivered: boolean; attempts: number }>;
}

/** A firing that has cleared and now owes its resolve to the rules that were told about it. */
interface PendingResolve {
  alert: AlertType;
  ruleIds: Set<string>;
  attempts: number;
}

export interface AlertEngineDeps {
  notifications: NotificationService;
  log: FastifyBaseLogger;
  activity?: ActivityLog;
  /** Fired when the ACTIVE alert set changes — the wiring re-broadcasts admin/state. */
  onChange?: () => void;
  /** Injected clock (ms). The whole suite drives debounce and quiet hours through this. */
  now?: () => number;
  /** The signal sources. `defaultProbes()` builds the four the control plane already has. */
  probes: AlertProbe[];
  deployment?: string;
  /** Console-visible debounce when no enabled rule covers the kind. */
  defaultDebounceMs?: number;
}

export class AlertEngine {
  private readonly tracked = new Map<string, Tracked>();
  private readonly pendingResolves = new Map<string, PendingResolve>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;

  constructor(private readonly deps: AlertEngineDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** The alerts the console shows: the problems that have outlived their debounce. Newest first. */
  active(): AlertType[] {
    return [...this.tracked.values()]
      .filter((t) => t.firedAt !== undefined)
      .sort((a, b) => (b.firedAt ?? 0) - (a.firedAt ?? 0))
      .map((t) => this.alertOf(t));
  }

  /** Run the evaluation loop. `intervalMs` 0 disables it (tests drive `tick()` by hand). */
  start(intervalMs: number): void {
    if (this.timer || intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * One evaluation: probe → diff → debounce → deliver. Re-entrant-safe (a slow webhook must not let
   * the next interval interleave two passes over the same state).
   */
  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.evaluate();
    } catch (err) {
      this.deps.log.error({ event: "alert.tick.failed", err: String(err) }, "alert evaluation failed");
    } finally {
      this.ticking = false;
    }
  }

  private async evaluate(): Promise<void> {
    const now = this.now();

    const problems: Problem[] = [];
    for (const probe of this.deps.probes) {
      try {
        problems.push(...(await probe()));
      } catch (err) {
        // A broken probe must not take the other signals down with it.
        this.deps.log.warn({ event: "alert.probe.failed", err: String(err) }, "an alert probe threw");
      }
    }

    const seen = new Map<string, Problem>();
    for (const problem of problems) seen.set(alertIdOf(problem), problem);

    let changed = false;

    // ── Gone: everything we were tracking that no longer shows up in the probe set. ──
    for (const [id, tracked] of [...this.tracked]) {
      if (seen.has(id)) continue;
      this.tracked.delete(id);
      if (tracked.firedAt === undefined) continue; // it never became an alert — nothing to clear
      changed = true;

      const alert = { ...this.alertOf(tracked), state: "resolved" as const };
      this.deps.activity?.push("good", `Alert cleared: ${alert.title}`);
      const owed = new Set(
        [...tracked.deliveries.entries()].filter(([, d]) => d.delivered).map(([ruleId]) => ruleId),
      );
      // Only the rules that were TOLD get the all-clear. Nothing was sent → nothing to unsend.
      if (owed.size > 0) this.pendingResolves.set(id, { alert, ruleIds: owed, attempts: 0 });
    }

    // ── Present: track, debounce, deliver. ──
    for (const [id, problem] of seen) {
      let tracked = this.tracked.get(id);
      if (!tracked) {
        tracked = { problem, firstSeen: now, deliveries: new Map() };
        this.tracked.set(id, tracked);
        // A problem that reappears before its resolve went out: the resolve is now a lie, drop it and
        // let the (still-delivered) firing stand — the wall never actually came back.
        this.pendingResolves.delete(id);
      } else {
        tracked.problem = problem; // titles/details can sharpen while the problem persists
      }

      const elapsed = now - tracked.firstSeen;
      const rules = this.deps.notifications.rulesFor(problem.kind);

      if (tracked.firedAt === undefined && elapsed >= this.consoleDebounceMs(rules)) {
        tracked.firedAt = now;
        changed = true;
        this.deps.activity?.push("bad", problem.title);
      }

      for (const rule of rules) {
        const state = tracked.deliveries.get(rule.id) ?? { delivered: false, attempts: 0 };
        tracked.deliveries.set(rule.id, state);
        if (state.delivered || state.attempts >= MAX_ATTEMPTS) continue;
        if (elapsed < rule.debounceSeconds * 1000) continue;
        // Quiet hours DEFER: we simply don't deliver now. If the problem is still there when the
        // window ends, the next tick delivers it; if it cleared inside the window, it never fires at
        // all — which is exactly why an operator sets quiet hours.
        if (this.deps.notifications.isQuiet(rule)) continue;

        await this.attempt(rule, state, tracked, id);
      }
    }

    // ── Owed resolves (including ones held over from an earlier tick's failure). ──
    for (const [id, pending] of [...this.pendingResolves]) {
      const event = this.eventOf(pending.alert, "resolved");
      for (const ruleId of [...pending.ruleIds]) {
        const rule = this.ruleById(ruleId);
        if (!rule) {
          pending.ruleIds.delete(ruleId); // the rule was deleted mid-incident — nothing to tell
          continue;
        }
        try {
          await this.deps.notifications.deliver(rule, event);
          pending.ruleIds.delete(ruleId);
        } catch {
          // Already logged by the service. Retried on the next tick.
        }
      }
      pending.attempts += 1;
      if (pending.ruleIds.size === 0 || pending.attempts >= MAX_ATTEMPTS) {
        if (pending.ruleIds.size > 0) {
          this.deps.log.error(
            { event: "alert.resolve.abandoned", alert: id, rules: [...pending.ruleIds] },
            "giving up on delivering an alert resolve — the notifier stayed unreachable",
          );
        }
        this.pendingResolves.delete(id);
      }
    }

    if (changed) this.deps.onChange?.();
  }

  private async attempt(
    rule: PersistedNotificationRule,
    state: { delivered: boolean; attempts: number },
    tracked: Tracked,
    id: string,
  ): Promise<void> {
    state.attempts += 1;
    const event = this.eventOf({ ...this.alertOf(tracked), state: "firing" }, "firing");
    try {
      await this.deps.notifications.deliver(rule, event);
      state.delivered = true;
    } catch {
      if (state.attempts >= MAX_ATTEMPTS) {
        this.deps.log.error(
          { event: "alert.delivery.abandoned", alert: id, ruleId: rule.id },
          `giving up on ${rule.name} for this alert after ${MAX_ATTEMPTS} attempts`,
        );
      }
    }
  }

  /** The debounce the CONSOLE uses to call a problem an alert: the shortest any enabled rule would. */
  private consoleDebounceMs(rules: PersistedNotificationRule[]): number {
    if (rules.length === 0) return this.deps.defaultDebounceMs ?? DEFAULT_DEBOUNCE_MS;
    return Math.min(...rules.map((r) => r.debounceSeconds * 1000));
  }

  private ruleById(id: string): PersistedNotificationRule | undefined {
    return this.deps.notifications.enabledRules().find((r) => r.id === id);
  }

  private alertOf(tracked: Tracked): AlertType {
    return Alert.parse({
      id: alertIdOf(tracked.problem),
      kind: tracked.problem.kind,
      state: "firing",
      title: tracked.problem.title,
      ...(tracked.problem.detail ? { detail: tracked.problem.detail } : {}),
      subject: tracked.problem.subject,
      since: new Date(tracked.firstSeen).toISOString(),
      ...(tracked.firedAt !== undefined ? { firedAt: new Date(tracked.firedAt).toISOString() } : {}),
    });
  }

  private eventOf(alert: AlertType, state: "firing" | "resolved") {
    return AlertEvent.parse({
      version: 1,
      id: randomUUID(),
      at: new Date(this.now()).toISOString(),
      state,
      alert: { ...alert, state },
      ...(this.deps.deployment ? { deployment: this.deps.deployment } : {}),
    });
  }
}

/** The alert id — stable for the life of the problem, so a firing and its resolve correlate. */
function alertIdOf(problem: Problem): string {
  return `${problem.kind}:${problem.key}`;
}

export interface ProbeDeps {
  control: ControlPlane;
  presence: Presence;
  playerHub: PlayerHub;
  /** POL-41 image rebuilds. Returns the last run, or null when nothing has ever been built. */
  lastImageBuild?: () => Promise<{
    status: "running" | "success" | "failure" | null;
    startedAt: string | null;
    logTail: string | null;
  } | null>;
}

/**
 * The four probes over the signals the control plane ALREADY has. Every one of them is a read of live
 * state — none adds a message, a poll, or a byte on the player's path (non-negotiable: no player
 * impact).
 */
export function defaultProbes(deps: ProbeDeps): AlertProbe[] {
  const { control, presence, playerHub } = deps;

  /** A box we admitted, whose agent socket is gone — and that did not go dark because we asked it to. */
  const machineOffline: AlertProbe = () =>
    control
      .getMachines()
      .filter(
        (m) =>
          m.status === "approved" &&
          !presence.isMachineOnline(m.id) &&
          !presence.isMachineRebooting(m.id),
      )
      .map((m) => ({
        kind: "machine-offline" as const,
        key: m.id,
        title: `${m.label} is offline`,
        detail: m.lastSeen ? `The control plane last heard from it at ${m.lastSeen}.` : undefined,
        subject: { machineId: m.id, machineLabel: m.label },
      }));

  /** A screen that is SUPPOSED to be showing something, on a box that is up, with no player attached.
   *  (A screen on an offline box is not its own alert — the box's alert already says it.) */
  const screenDark: AlertProbe = () =>
    control
      .getScreens()
      .filter((s) => {
        const machine = control.getMachine(s.machineId);
        if (!machine || machine.status !== "approved") return false;
        if (!presence.isMachineOnline(machine.id) || presence.isMachineRebooting(machine.id)) return false;
        const slice = control.getSlice(s.id);
        if (!slice || slice.surfaces.length === 0) return false; // nothing assigned = nothing to miss
        return playerHub.count(s.id) === 0;
      })
      .map((s) => ({
        kind: "screen-dark" as const,
        key: s.id,
        title: `${s.friendlyName} has content but no player`,
        detail: "The box is online, but nothing is rendering this screen's content.",
        subject: {
          screenId: s.id,
          screenName: s.friendlyName,
          machineId: s.machineId,
          machineLabel: control.getMachine(s.machineId)?.label,
        },
      }));

  /** The agent's own per-connector verdict from `agent/status` — the browser is not where it should
   *  be (it died, it won't stay up, it can't be placed). The box's `note` is the whole detail. */
  const placementFailed: AlertProbe = () =>
    control
      .getScreens()
      .flatMap((s) => {
        const placement = presence.screenPlacement(s.id);
        if (!placement || placement.ok) return [];
        return [
          {
            kind: "screen-placement-failed" as const,
            key: s.id,
            title: `${s.friendlyName} is not showing its content`,
            detail: placement.note ?? "The agent reported the browser is not on this output.",
            subject: {
              screenId: s.id,
              screenName: s.friendlyName,
              machineId: s.machineId,
              machineLabel: control.getMachine(s.machineId)?.label,
            },
          },
        ];
      });

  /** The image rebuild (POL-41/POL-43) failed. Keyed on the run's start time, so a NEW failure after a
   *  success is a NEW alert rather than a silent continuation of the old one. */
  const imageBuildFailed: AlertProbe = async () => {
    if (!deps.lastImageBuild) return [];
    const build = await deps.lastImageBuild();
    if (!build || build.status !== "failure" || !build.startedAt) return [];
    return [
      {
        kind: "image-build-failed" as const,
        key: build.startedAt,
        title: "The netboot image rebuild failed",
        detail: (build.logTail ?? "").trim().split("\n").slice(-3).join(" · ").slice(0, 300) || undefined,
        subject: {},
      },
    ];
  };

  return [machineOffline, screenDark, placementFailed, imageBuildFailed];
}
