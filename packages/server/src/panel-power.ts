/**
 * Panel power (POL-101, re-sourced onto the scene schedule at POL-186) — manual wake/sleep, and the
 * scheduled windows that drive it.
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
 * a wall by hand, and ten seconds later the scheduler puts it back to sleep, forever, because it
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
 * ── Convergence with the scene scheduler: DONE (POL-186) ─────────────────────────────────────────
 *
 * This file used to own a second calendar — one enabled `{on, off}` window PER SCREEN, evaluated by
 * its own 30s `setInterval` against its own timezone setting. That was always meant to be temporary
 * (D100): full recurrence — weekdays, date ranges, priorities, DST — lives in the SCENE schedule, and
 * two half-built calendars is the worst of both worlds. The convergence has now happened:
 *
 *   - THE WINDOW IS THE SCENE SCHEDULE'S. A schedule window carries `panels` ("on" | "off") and
 *     targets a MURAL, so power is a property of a wall, not of a screen an operator has to find in
 *     a list. `desiredFor` resolves the screen's mural through the shared resolver in
 *     `@polyptic/protocol` — the same function the console's week strip paints with, so the strip
 *     cannot lie about when a wall goes dark. The deployment's timezone and DST handling come with
 *     it; this file no longer reads a clock zone of its own.
 *   - THERE IS ONE CLOCK. The scene ticker (~10s) calls `applyMuralPower` once per mural per tick,
 *     UNCONDITIONALLY — it does not gate on its own verdict changing, because a screen dragged onto
 *     a mural mid-window would then never be recorded and would sit lit all night. So the seam below
 *     is the ONLY edge-trigger, keyed per SCREEN, and it must stay cheap enough to run every 10s and
 *     silent whenever the verdict is unchanged.
 *   - `null` PANELS MEAN UNGOVERNED. No enabled window targets that mural: leave the wall exactly as
 *     it is (a screen an operator slept by hand stays asleep), and FORGET the remembered state so
 *     re-enabling a window later starts fresh rather than firing off a stale edge.
 */
import type { PanelPowerMethod, PanelState } from "@polyptic/protocol";
import { ServerToAgentDisplayPower, resolveMuralAt } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

import type { AdminBroadcaster, Presence } from "./admin";
import type { ActivityLog } from "./activity";
import type { AgentHub } from "./hub";
import type { ControlPlane } from "./state";

export interface PanelPowerDeps {
  control: ControlPlane;
  agentHub: AgentHub;
  presence: Presence;
  activity: ActivityLog;
  broadcaster: AdminBroadcaster;
  log: FastifyBaseLogger;
  /** Injected so schedule evaluation is testable without waiting for a wall clock to reach 19:00. */
  now?: () => Date;
}

/**
 * Turns the scene schedule's panel verdicts into `server/display-power`. Owns the desired-state
 * memory that makes a manual override hold until the next boundary (see the header).
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
   *     wall an operator just woke straight back to sleep ten seconds later — the exact behaviour
   *     that gets a scheduling feature switched off.)
   *   - absent = we have not evaluated this screen yet, so the first evaluation RECORDS without
   *     sending. A box coming online is reconciled by `reconcileMachine` on its hello, which is the
   *     bootstrap path that matters; a server restart therefore cannot spray the fleet with frames.
   */
  private readonly lastDesired = new Map<string, boolean>();
  private readonly now: () => Date;

  constructor(private readonly deps: PanelPowerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  /**
   * The desired power for one screen right now, or `null` when no enabled window governs its mural.
   *
   * A screen's power belongs to the WALL it is part of, so this resolves the mural it is placed on
   * and asks the shared resolver — the deployment's timezone, DST, weekdays and date ranges all come
   * with that, because it is the same function the console's week strip paints with.
   */
  desiredFor(screenId: string): boolean | null {
    const muralId = this.deps.control.getPlacementMuralId(screenId);
    if (muralId === null) return null; // an unplaced screen belongs to no mural, so no window governs it
    const { panels } = resolveMuralAt(
      this.now().getTime(),
      this.deps.control.getScheduleSet(),
      muralId,
    );
    return panels === null ? null : panels === "on";
  }

  /**
   * The scene ticker's per-mural verdict, handed over on EVERY tick (~10s) for EVERY mural — the
   * ticker deliberately does not gate on its own verdict changing, because a screen dragged onto a
   * mural mid-window would then never be recorded and would sit lit all night. So this method is the
   * only edge-trigger in the system, and everything about it follows from that:
   *
   *   - it is one in-memory sweep of the screen list, cheap enough to run every 10s per mural;
   *   - it sends NOTHING when the verdict is unchanged. Re-asserting here would put the wall an
   *     operator just woke back to sleep ten seconds later, over and over;
   *   - the memory it consults is the SCHEDULE's opinion (see `lastDesired`), which an operator's
   *     manual wake/sleep never touches — that is what lets an override hold to the next boundary;
   *   - `panels === null` (nothing governs this mural) leaves the wall exactly as it is and FORGETS
   *     the remembered state, so re-enabling a window later starts fresh instead of firing a stale
   *     edge at a wall nobody asked to change.
   *
   * In hours the only command this can ever produce is WAKE. Nothing here infers power from
   * idleness, load or connectivity; that inference does not exist.
   */
  applyMuralPower(muralId: string, panels: PanelState | null, daypartName: string): void {
    for (const screen of this.deps.control.getScreens()) {
      if (this.deps.control.getPlacementMuralId(screen.id) !== muralId) continue;
      if (panels === null) {
        this.lastDesired.delete(screen.id);
        continue;
      }
      const desired = panels === "on";
      const previous = this.lastDesired.get(screen.id);
      this.lastDesired.set(screen.id, desired);
      if (previous === undefined) continue; // first sight of this screen — record, don't act
      if (previous === desired) continue; // no boundary crossed; the schedule has nothing to say
      this.send(screen.id, desired, `schedule: ${daypartName}`);
      this.deps.activity.push(
        "info",
        desired
          ? `${screen.friendlyName} woke — ${daypartName}`
          : `${screen.friendlyName} is sleeping — ${daypartName}`,
      );
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
      if (!desired) this.send(screen.id, false, "schedule (the box came back inside an off window)");
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
