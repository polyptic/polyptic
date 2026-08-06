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
 *   - `null` PANELS MEAN UNGOVERNED, and ARRIVING there is an edge like any other. No enabled window
 *     targets that mural, so the schedule stops having an opinion, and the remembered state is
 *     FORGOTTEN — re-enabling a window later starts fresh rather than firing off a stale edge. But
 *     the schedule does not get to walk away leaving a wall dark: a screen the SCHEDULE slept is
 *     woken on the way out. That is the sequence an operator actually walks into — panels misbehave,
 *     so they switch the scheduler off and delete the windows, and every screen those windows had put
 *     to sleep stays asleep, with nothing left in the system able to wake it. What makes the wake
 *     safe is the one thing `lastDesired` has always recorded: the SCHEDULE's opinion, and only that.
 *     A screen an operator slept BY HAND has no entry at all, so it is left exactly as it is. Wake
 *     what the schedule slept; leave what a human slept.
 *   - THE MASTER SWITCH IS THE SAME EDGE. Switching the scheduler off is "delete every window" by
 *     another route, so the ticker drives this seam with `null` for every mural on a disabled tick
 *     instead of returning before it ever reaches here (`scheduler.ts`). Switching the feature off
 *     must never be the thing that strands the fleet dark.
 *   - THE MEMORY REMEMBERS WHICH WALL SPOKE. Because the window belongs to the wall, a screen dragged
 *     from one mural to another has had the schedule's opinion OF IT changed even though neither
 *     mural's verdict moved — so `lastDesired` records the mural alongside the verdict, and a screen
 *     asleep by a wall that no longer holds it is woken on the next tick. Without that, the one thing
 *     per-screen panel hours got right (a screen carried its own window, so it woke at its own 07:00)
 *     would be a regression: nothing else re-asserts, and the panel would stay dark until an operator
 *     pressed Wake by hand. See `applyMuralPower` for the line that draws it, and why it cannot be a
 *     blanket "wake on `null`".
 */
import type { PanelPowerMethod, PanelState } from "@polyptic/protocol";
import { ServerToAgentDisplayPower, resolveMuralAt } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

import type { AdminBroadcaster, Presence } from "./admin";
import type { ActivityLog } from "./activity";
import type { AgentHub } from "./hub";
import type { ControlPlane } from "./state";
import { serverEvent } from "./logs";
import type { FleetLogger } from "./logs";

export interface PanelPowerDeps {
  control: ControlPlane;
  agentHub: AgentHub;
  presence: Presence;
  activity: ActivityLog;
  broadcaster: AdminBroadcaster;
  log: FastifyBaseLogger;
  /**
   * POL-187 — the fleet log sink. For THE bug this logging ticket exists to explain ("we left them
   * asleep and working, and in the morning some were dark"), these are the highest-value lines in
   * the whole system: what the schedule decided, what we sent, and whether the box was there to
   * take it. They cost almost nothing and they file beside the box's own account of the same
   * moment. Optional so a test can build a scheduler without a log volume.
   */
  logs?: FleetLogger;
  /** Injected so schedule evaluation is testable without waiting for a wall clock to reach 19:00. */
  now?: () => Date;
}

/**
 * Turns the scene schedule's panel verdicts into `server/display-power`. Owns the desired-state
 * memory that makes a manual override hold until the next boundary (see the header).
 */
export class PanelPowerScheduler {
  /**
   * screenId → what the SCHEDULE wanted at the previous evaluation, and WHICH MURAL said so. This is
   * the memory that makes the scheduler edge-triggered, and it deliberately records the SCHEDULE's
   * opinion, never the panel's actual state and never an operator's manual action:
   *
   *   - an operator's wake/sleep does NOT touch it. That is precisely what lets a manual override
   *     hold: the schedule's opinion has not changed, so no edge exists, so the next tick says nothing
   *     at all. (Recording the manual value here instead was the first thing I wrote, and it puts the
   *     wall an operator just woke straight back to sleep ten seconds later — the exact behaviour
   *     that gets a scheduling feature switched off.)
   *   - absent = we have not evaluated this screen yet, so the first evaluation RECORDS without
   *     sending. A box coming online is reconciled by `reconcileMachine` on its hello, which is the
   *     bootstrap path that matters; a server restart therefore cannot spray the fleet with frames.
   *   - the MURAL is here because power hangs on the wall, not the screen: it is the only way to tell
   *     "this wall's window slept you" from "another wall's window slept you, and you have since been
   *     dragged off it" — which is a real edge for the screen even though no mural's verdict changed.
   */
  private readonly lastDesired = new Map<string, { muralId: string; desired: boolean }>();
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
   *   - `panels === null` (nothing governs this mural) FORGETS the remembered state, so re-enabling a
   *     window later starts fresh instead of firing a stale edge at a wall nobody asked to change —
   *     and on the way out it WAKES ANY SCREEN THE SCHEDULE HAD SLEPT. Three routes lead here and all
   *     three are the same edge: the window that slept the wall was deleted, the screen was dragged
   *     onto a wall no window governs, or the master switch was turned off. In every one of them the
   *     wall is dark and nothing in the system still claims to want it dark.
   *   - it is still NOT a blanket "wake on `null`", and must never become one. `null` also covers the
   *     operator who slept a screen BY HAND, and that screen must stay asleep. What separates the two
   *     is the memory itself: a manual sleep writes nothing here at all, so there is no recorded
   *     sleep to wake from. The RECORDED MURAL then only picks the words — "the wall that slept it no
   *     longer holds it" for a screen that moved, the caller's reason for a wall that lost its
   *     windows — because the decision has already been made by whether an entry exists.
   *   - a wake that reached NOBODY does not clear the memory. An offline box cannot be woken, so the
   *     recorded sleep is kept and the wake is re-sent when the box says hello. Forgetting there was
   *     the subtler half of the same hole: delete the windows while a wall is off for the night, and
   *     the only record that the schedule had slept it is gone before the box is ever back.
   *
   * In hours the only command this can ever produce is WAKE. Nothing here infers power from
   * idleness, load or connectivity; that inference does not exist.
   */
  applyMuralPower(
    muralId: string,
    panels: PanelState | null,
    daypartName: string,
    ungovernedReason = "no window governs its wall any more",
  ): void {
    for (const screen of this.deps.control.getScreens()) {
      if (this.deps.control.getPlacementMuralId(screen.id) !== muralId) continue;
      const previous = this.lastDesired.get(screen.id);
      if (panels === null) {
        this.releaseScreen(screen.id, screen.friendlyName, previous, muralId, ungovernedReason);
        continue;
      }
      const desired = panels === "on";
      this.lastDesired.set(screen.id, { muralId, desired });
      if (previous === undefined) continue; // first sight of this screen — record, don't act
      // A screen that moved murals compares against the verdict that put it where it is, whichever
      // wall said so: same state, nothing to say; different state, a genuine boundary for this screen.
      if (previous.desired === desired) continue; // no boundary crossed; the schedule has nothing to say
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
   * The screen has just become UNGOVERNED — no enabled window has an opinion about it any more,
   * whichever route it took there (its wall's last window deleted, the master switch off, or the
   * screen dragged onto a wall nothing governs).
   *
   * Wake what the SCHEDULE slept; leave what a human slept. The test is simply whether a recorded
   * sleep exists: `lastDesired` is written only by this file's own two writers, so a hand-slept
   * screen has no entry and is left exactly as it is. The recorded mural only chooses the words.
   *
   * A wake nobody took KEEPS the memory. An offline box cannot be woken, and if the record went
   * anyway then nothing would remain to say the schedule had slept that wall — the box would come
   * back dark with no one left to argue otherwise. Keeping it means `reconcileMachine` finishes the
   * job on the next hello.
   */
  private releaseScreen(
    screenId: string,
    friendlyName: string,
    previous: { muralId: string; desired: boolean } | undefined,
    muralId: string,
    ungovernedReason: string,
  ): void {
    if (previous && !previous.desired) {
      const reason =
        previous.muralId === muralId ? ungovernedReason : "the wall that slept it no longer holds it";
      if (this.wake(screenId, friendlyName, reason) === 0) return; // offline: keep the record, retry on hello
    }
    this.lastDesired.delete(screenId);
  }

  /** One WAKE with its activity line — the sleep half always has a daypart to name, this half
   *  sometimes has only a reason (a screen that outlived the window that slept it). Returns how many
   *  agents took it, because a wake that reached nobody must not be recorded as done. */
  private wake(screenId: string, friendlyName: string, reason: string): number {
    const delivered = this.send(screenId, true, `schedule: ${reason}`);
    this.deps.activity.push("info", `${friendlyName} woke — ${reason}`);
    return delivered;
  }

  /**
   * A box just said hello: put its screens where the schedule says they belong. This is what re-sleeps
   * a panel whose box rebooted out of hours (it comes back LIT — the compositor asserts `dpms on` at
   * startup, by design, because a wall that boots dark is indistinguishable from a broken one).
   *
   * Reconciling on hello also means the console's power state is never a guess: the box acks, and the
   * ack is what the operator sees.
   *
   * TIMING IS THE WHOLE PROBLEM HERE. A box says hello as soon as its agent is up, which is BEFORE
   * the compositor has finished bringing up its outputs — the first hello of a boot routinely reports
   * zero of them. Reconciling into that box refuses every command it is sent ("connector is not a
   * known sway output"), and, worse, used to stamp the memory as though the commands had landed, so
   * the panel was then wrong until the next real boundary hours later. A box advertising no outputs
   * cannot act, so there is nothing to reconcile TO yet: skip it and wait. The agent hellos again
   * once its outputs are up, and that hello is the one that can do the work.
   */
  reconcileMachine(machineId: string, reassertScreenIds?: ReadonlySet<string>): void {
    const machine = this.deps.control.getMachine(machineId);
    if (!machine) return;
    if (machine.outputs.length === 0) {
      // Not a fault, and not a wall to worry about: the compositor is still coming up. Say so plainly
      // so the morning-after reading of the log does not show a silent gap where a reconcile was due.
      this.deps.log.info(
        { event: "panel.power.reconcile_deferred", machineId },
        "panel power reconcile deferred — the machine advertises no outputs yet (it hellos again once they are up)",
      );
      this.deps.logs?.record(
        serverEvent(
          "info",
          "panel-power",
          "reconcile deferred — the box advertises no outputs yet, so no panel can take a command",
          { machineId },
        ),
      );
      return;
    }
    const screens = this.deps.control.getScreens().filter((s) => s.machineId === machineId);
    for (const screen of screens) {
      // A screen whose connector the box had STOPPED reporting and is reporting again: the output was
      // destroyed and re-created underneath us, so nothing has asserted the desired state onto it and
      // "it booted lit" is not a promise anyone made. Send BOTH halves for these — this is the only
      // caller that may send a WAKE from a reconcile, and it is deliberately the narrow case.
      // `null` still means UNGOVERNED and is still left alone — a re-created output comes up lit
      // (the compositor asserts `dpms on`), so there is nothing for a wake to fix and an operator's
      // hand-slept panel keeps the state they chose.
      if (reassertScreenIds?.has(screen.id)) {
        const desired = this.desiredFor(screen.id);
        if (desired === null) continue;
        const muralId = this.deps.control.getPlacementMuralId(screen.id);
        if (muralId === null) continue;
        this.lastDesired.set(screen.id, { muralId, desired });
        this.send(screen.id, desired, "the box is reporting this connector again");
        continue;
      }
      const desired = this.desiredFor(screen.id);
      // `desiredFor` only answers non-null for a PLACED screen, so the mural is there to record — and
      // it must be, or the next tick would read this as "a verdict from another wall" and wake it.
      const muralId = this.deps.control.getPlacementMuralId(screen.id);
      if (desired === null || muralId === null) {
        // Ungoverned, by the same three routes `applyMuralPower` handles — and reached here when the
        // tick's wake could not be delivered because this very box was offline. Same rule, same
        // words: wake what the schedule slept, leave what a human slept.
        this.releaseScreen(
          screen.id,
          screen.friendlyName,
          this.lastDesired.get(screen.id),
          muralId ?? "",
          "no window governs its wall any more",
        );
        continue;
      }
      // Only ever SEND the sleep half here. A box that just booted is already awake (the compositor
      // asserts `dpms on` at startup), so re-asserting "on" would be a wasted frame on every reconnect
      // of every box in the fleet — but a box that booted OUT of hours genuinely needs the sleep.
      // Record only what actually went to an agent: a sleep nobody took leaves the memory absent, so
      // the next tick treats this screen as first sight rather than believing a dark panel it has.
      if (!desired && this.send(screen.id, false, "schedule (the box came back inside an off window)") === 0) {
        continue;
      }
      this.lastDesired.set(screen.id, { muralId, desired });
    }
  }

  /**
   * The box REFUSED a power command (`agent/power-ack` with `ok: false`), so whatever we believed
   * about that panel is not true. Drop the record rather than carry a lie: an unrecorded screen is
   * re-read from scratch on the next tick, where a real boundary re-sends, and no verdict is ever
   * skipped on the strength of a command that never took.
   */
  noteRefused(screenId: string): void {
    this.lastDesired.delete(screenId);
  }

  // POL-186 — `noteScheduleApplied` lived here, for the one caller that applied the schedule's
  // opinion out of band: the panel-hours PUT route. That route is gone, and with it the only way an
  // edit could stamp this memory behind an operator's back. The memory is still only ever WRITTEN by
  // this file's own two schedule paths, `applyMuralPower` and `reconcileMachine` — and only with a
  // command an agent actually took. It is CLEARED by `releaseScreen` (the screen is ungoverned now)
  // and by `noteRefused` (the box said the command did not take); a cleared screen is simply read
  // afresh on the next tick. Nothing outside this file can put a value in.

  /** Send one `server/display-power`. Returns how many agents took it (0 = the box is offline). */
  send(screenId: string, on: boolean, reason: string): number {
    const screen = this.deps.control.getScreen(screenId);
    if (!screen) return 0;
    const machine = this.deps.control.getMachine(screen.machineId);
    if (!machine || machine.status !== "approved") return 0;

    // Never address a connector the box is not reporting. A DisplayPort panel switched off drops its
    // link and its connector leaves the compositor's output list; from that moment the box refuses
    // every frame aimed at it ("DP-1 is not a known sway output") and the console reads a screen that
    // "will not wake" instead of a screen with no output behind it. Say the true thing instead — and
    // only when the box is CONNECTED, because a stale output list from an offline box proves nothing
    // (that case falls through to the offline branch below, which already has the right words).
    if (
      this.deps.presence.isMachineOnline(machine.id) &&
      !this.deps.control.isConnectorAdvertised(machine.id, screen.connector)
    ) {
      this.deps.log.warn(
        {
          event: "panel.power.connector_absent",
          screenId,
          machineId: machine.id,
          connector: screen.connector,
          on,
          reason,
        },
        "panel power not sent — the box is not reporting that connector",
      );
      this.deps.logs?.record(
        serverEvent(
          "warn",
          "panel-power",
          `${on ? "wake" : "sleep"} for ${screen.friendlyName} was not sent — ${machine.label} is not reporting connector ${screen.connector}`,
          {
            machineId: machine.id,
            screenId,
            fields: {
              connector: screen.connector,
              on,
              reason: reason.slice(0, 300),
              advertised: machine.outputs.map((o) => o.connector).join(",") || "none",
            },
          },
        ),
      );
      return 0;
    }

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
    this.deps.logs?.record(
      serverEvent(
        "info",
        "panel-power",
        `${on ? "wake" : "sleep"} sent to ${screen.friendlyName} on ${screen.connector} — ${reason}`,
        {
          machineId: machine.id,
          screenId,
          fields: { connector: screen.connector, on, reason: reason.slice(0, 300), delivered },
        },
      ),
    );
    if (delivered === 0) {
      // An offline box cannot be slept, and pretending otherwise would leave the console showing a
      // dark screen that is, in fact, unreachable. It reconciles on its next hello.
      this.deps.log.warn(
        { event: "panel.power.undelivered", screenId, machineId: machine.id, on },
        "panel power not delivered — the machine is offline (it will reconcile when it reconnects)",
      );
      // The morning-after question is "did anything even reach that box?". This is the line that
      // answers it, and it is a WARN because a command that reached nobody is a wall that did not
      // do what the schedule said.
      this.deps.logs?.record(
        serverEvent(
          "warn",
          "panel-power",
          `${on ? "wake" : "sleep"} for ${screen.friendlyName} reached NO agent — the machine is offline (it reconciles on its next hello)`,
          { machineId: machine.id, screenId, fields: { connector: screen.connector, on } },
        ),
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
