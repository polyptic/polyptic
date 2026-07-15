/**
 * Panel power (POL-101) — manual wake/sleep, and the daily panel-hours schedule that drives it.
 *
 * The rule this file exists to keep, and must never be read as weakening:
 *
 *     A SCREEN THAT SHOULD BE SHOWING CONTENT MUST NEVER BLANK.
 *
 * Turning panels off OUTSIDE their hours is the feature. Blanking them DURING their hours is the bug
 * the on-device stack forbids structurally (`output * dpms on`, no swayidle, no lock — D41). Nothing
 * here is driven by idleness, load, connectivity, or any other inference about whether a wall "looks
 * used": a panel sleeps if and only if an operator asked for it, or a window an operator set says the
 * day is over. In hours, the only power command this scheduler ever sends is WAKE.
 *
 * ── Why the scheduler is EDGE-triggered ──────────────────────────────────────────────────────────
 *
 * The obvious implementation re-asserts the desired state on every tick ("out of hours → sleep"). It
 * is also wrong, in the way an operator finds out about at 19:05 on the evening of a visit: they wake
 * a wall by hand, and thirty seconds later the scheduler puts it back to sleep, forever, because it
 * cannot tell an operator's decision from a box that drifted. So we act on TRANSITIONS — a boundary
 * crossing (in-hours ⇄ out-of-hours) — and remember what we last asserted per screen. A manual
 * wake/sleep simply overwrites that memory, and therefore HOLDS until the next boundary, which is
 * exactly the behaviour "override until the next scheduled change" that every thermostat on earth has
 * taught people to expect.
 *
 * The one exception is a box we have never seen in this state: on the agent's hello we RECONCILE that
 * machine's screens to their desired state. That is what re-sleeps a panel whose box rebooted at 3am
 * (the compositor comes back asserting `dpms on`, so the panel is lit again and, out of hours, wrong).
 *
 * ── Convergence with the scene scheduler ─────────────────────────────────────────────────────────
 *
 * A separate ticket brings full recurrence (weekdays, exceptions, holidays) to SCENES. Panel hours
 * deliberately stay a single daily window per screen until it lands: two half-built calendars is the
 * worst of both worlds. The two are meant to converge on one recurrence engine — see D100.
 */
import type { PanelHours, PanelPowerMethod } from "@polyptic/protocol";
import { ServerToAgentDisplayPower } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

import type { AdminBroadcaster, Presence } from "./admin";
import type { ActivityLog } from "./activity";
import type { AgentHub } from "./hub";
import type { ControlPlane } from "./state";

/** How often the scheduler looks at the clock. A minute's granularity is what "HH:MM" promises; we
 *  tick at 30s so a boundary is never missed by rounding, and idempotence makes the extra tick free. */
export const PANEL_TICK_MS = 30_000;

/** Minutes since local midnight for an "HH:MM" string. */
export function minutesOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":");
  return Number(h) * 60 + Number(m);
}

/**
 * What time it is, in minutes since midnight, in `timezone` — NOT in the server's zone. A control
 * plane in eu-west-1 must sleep a wall in Sheffield on Sheffield's clock, and it must keep doing so
 * across a DST change, which is precisely why this reads the zone through `Intl` on every call rather
 * than caching an offset.
 *
 * An invalid zone throws in the formatter; we fall back to UTC and say so, because a bad zone must
 * never take the scheduler (or the server) down.
 */
export function minutesInZone(now: Date, timezone: string, onError?: (msg: string) => void): number {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: timezone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(now);
  } catch {
    onError?.(`unknown timezone "${timezone}" — falling back to UTC for panel hours`);
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  }
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  // "24" is a legal en-GB h23/h24 rendering of midnight in some runtimes; normalise it to 0.
  return (hour % 24) * 60 + minute;
}

/**
 * Should this panel be ON at `nowMinutes`? The window may WRAP midnight (on 20:00 / off 06:00 is a
 * perfectly good overnight window for a 24-hour operations wall), so a naive `on <= t < off` is not
 * enough. Inclusive of the ON minute and exclusive of the OFF minute, so a wall wakes AT 07:00 and
 * sleeps AT 19:00, which is what an operator typing those numbers means.
 *
 * A DISABLED window means "the schedule does not govern this screen" — it is left exactly as it is,
 * which is not the same as "keep it awake": a screen an operator slept by hand stays asleep.
 */
export function panelShouldBeOn(hours: PanelHours, nowMinutes: number): boolean {
  const on = minutesOfDay(hours.on);
  const off = minutesOfDay(hours.off);
  if (on < off) return nowMinutes >= on && nowMinutes < off; // a normal daytime window
  return nowMinutes >= on || nowMinutes < off; // a window that wraps midnight
}

export interface PanelPowerDeps {
  control: ControlPlane;
  agentHub: AgentHub;
  presence: Presence;
  activity: ActivityLog;
  broadcaster: AdminBroadcaster;
  log: FastifyBaseLogger;
  /** Injected so schedule evaluation is testable without waiting for a wall clock to reach 19:00. */
  now?: () => Date;
  tickMs?: number;
}

/**
 * Evaluates panel hours and drives `server/display-power`. Owns the desired-state memory that makes
 * a manual override hold until the next boundary (see the header).
 */
export class PanelPowerScheduler {
  /**
   * screenId → what the SCHEDULE wanted at the previous evaluation. This is the memory that makes the
   * scheduler edge-triggered, and it deliberately records the SCHEDULE's opinion, never the panel's
   * actual state and never an operator's manual action:
   *
   *   - an operator's wake/sleep does NOT touch it. That is precisely what lets a manual override
   *     hold: the schedule's opinion has not changed, so no edge exists, so the next tick says nothing
   *     at all. (Recording the manual value here instead was the first thing I wrote, and it puts the
   *     wall an operator just woke straight back to sleep thirty seconds later — the exact behaviour
   *     that gets a scheduling feature switched off.)
   *   - absent = we have not evaluated this screen yet, so the first evaluation RECORDS without
   *     sending. A box coming online is reconciled by `reconcileMachine` on its hello, which is the
   *     bootstrap path that matters; a server restart therefore cannot spray the fleet with frames.
   */
  private readonly lastDesired = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly now: () => Date;
  private readonly tickMs: number;

  constructor(private readonly deps: PanelPowerDeps) {
    this.now = deps.now ?? (() => new Date());
    this.tickMs = deps.tickMs ?? PANEL_TICK_MS;
  }

  start(): void {
    if (this.timer) return;
    // An immediate first pass would fight a fleet that is still connecting (no agent sockets yet), so
    // the schedule's real entry point for a box is its hello (`reconcileMachine`); the interval then
    // carries the boundaries from there.
    this.timer = setInterval(() => this.tick(), this.tickMs);
    // Never hold the process open for a timer whose whole job is to wait (matters to tests + shutdown).
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** The desired power for one screen right now, or `null` when no ENABLED window governs it. */
  desiredFor(screenId: string): boolean | null {
    const hours = this.deps.control.getPanelHours(screenId);
    if (!hours || !hours.enabled) return null;
    const { timezone } = this.deps.control.getPanelPowerConfig();
    const nowMinutes = minutesInZone(this.now(), timezone, (msg) =>
      this.deps.log.warn({ event: "panel.timezone.invalid", timezone }, msg),
    );
    return panelShouldBeOn(hours, nowMinutes);
  }

  /**
   * One pass over every screen with an enabled window. Sends a power command ONLY on a transition —
   * see the header for why level-triggering would trample an operator's manual override.
   */
  tick(): void {
    for (const { screenId } of this.deps.control.listPanelHours()) {
      const desired = this.desiredFor(screenId);
      if (desired === null) {
        // The window was disabled/removed: forget it, so re-enabling it later starts fresh.
        this.lastDesired.delete(screenId);
        continue;
      }
      const previous = this.lastDesired.get(screenId);
      this.lastDesired.set(screenId, desired);
      if (previous === undefined) continue; // first sight of this screen — record, don't act
      if (previous === desired) continue; // no boundary crossed; the schedule has nothing to say
      this.send(screenId, desired, "panel hours");
    }
  }

  /**
   * A box just said hello: put its screens where the schedule says they belong. This is what re-sleeps
   * a panel whose box rebooted out of hours (it comes back LIT — the compositor asserts `dpms on` at
   * startup, by design, because a wall that boots dark is indistinguishable from a broken one).
   *
   * Reconciling on hello also means the console's power state is never a guess: the box acks, and the
   * ack is what the operator sees.
   */
  reconcileMachine(machineId: string): void {
    const screens = this.deps.control.getScreens().filter((s) => s.machineId === machineId);
    for (const screen of screens) {
      const desired = this.desiredFor(screen.id);
      if (desired === null) continue;
      this.lastDesired.set(screen.id, desired);
      // Only ever SEND the sleep half here. A box that just booted is already awake (the compositor
      // asserts `dpms on` at startup), so re-asserting "on" would be a wasted frame on every reconnect
      // of every box in the fleet — but a box that booted OUT of hours genuinely needs the sleep.
      if (!desired) this.send(screen.id, false, "panel hours (box came back outside its hours)");
    }
  }

  /**
   * Record that the schedule's current opinion has just been applied by someone else (the panel-hours
   * REST route, which brings a screen to its new window immediately). Without this, the next tick
   * would see a stale previous value, call it an edge, and send a redundant second frame.
   *
   * Deliberately NOT called for a manual wake/sleep: an operator's override must leave the schedule's
   * memory untouched, which is exactly what lets the override hold until the next boundary.
   */
  noteScheduleApplied(screenId: string, desired: boolean): void {
    this.lastDesired.set(screenId, desired);
  }

  /** Send one `server/display-power`. Returns how many agents took it (0 = the box is offline). */
  send(screenId: string, on: boolean, reason: string): number {
    const screen = this.deps.control.getScreen(screenId);
    if (!screen) return 0;
    const machine = this.deps.control.getMachine(screen.machineId);
    if (!machine || machine.status !== "approved") return 0;

    const delivered = this.deps.agentHub.send(
      machine.id,
      ServerToAgentDisplayPower.parse({
        t: "server/display-power",
        connector: screen.connector,
        on,
        reason,
      }),
    );
    this.deps.log.info(
      {
        event: "panel.power.push",
        screenId,
        machineId: machine.id,
        connector: screen.connector,
        on,
        reason,
        delivered,
      },
      on ? "pushed panel wake to agent" : "pushed panel sleep to agent",
    );
    if (delivered === 0) {
      // An offline box cannot be slept, and pretending otherwise would leave the console showing a
      // dark screen that is, in fact, unreachable. It reconciles on its next hello.
      this.deps.log.warn(
        { event: "panel.power.undelivered", screenId, machineId: machine.id, on },
        "panel power not delivered — the machine is offline (it will reconcile when it reconnects)",
      );
    }
    return delivered;
  }
}

/** The activity line for an ack, phrased so an operator reads a HEALTHY sleeping panel, not a fault. */
export function powerAckLine(
  friendlyName: string,
  on: boolean,
  methods: PanelPowerMethod[],
): string {
  if (on) return `${friendlyName} is awake`;
  // Be honest about which rung we got: DPMS-only leaves many panels lit-but-black, and an operator
  // standing in front of one deserves to know that is expected rather than broken.
  return methods.includes("cec")
    ? `${friendlyName} is asleep — the panel was powered down over HDMI-CEC`
    : `${friendlyName} is asleep — its output is dark (DPMS; this box has no HDMI-CEC, so the panel itself may stay lit)`;
}
