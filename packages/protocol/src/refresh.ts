/**
 * Per-source refresh cadence (POL-89 sibling; POL-157 / D149) — contract AND the resolver.
 *
 * A content SOURCE may carry an opt-in policy that makes every screen showing it RELOAD on a schedule
 * the operator controls. Two modes ship:
 *   - INTERVAL   — reload every N seconds (the console offers minutes/hours/days; it stores seconds).
 *   - SCHEDULED  — reload at a wall-clock time (04:00) on chosen weekdays, in one IANA zone.
 * The default is OFF: no policy, or `{ mode: "off" }` — the wall never reloads, exactly as it did
 * before this feature (parity). A policy is meaningful only on FRAMEABLE kinds (web/dashboard); the
 * contract rejects it elsewhere (an image/video/playlist/page has nothing to re-navigate).
 *
 * Like the scene scheduler (schedule.ts), this lives in `protocol` for ONE reason: "should this
 * source reload right now" must be answered IDENTICALLY by the PLAYER (which fires the reload) and by
 * any console preview. One resolver, one answer — `isRefreshDue`. It reuses schedule.ts's wall-clock
 * discipline verbatim: `localInstant` reads an absolute instant as the deployment zone sees it, and
 * SCHEDULED firing is decided by comparing wall-clock (date, minute) TUPLES — never by converting a
 * local time back to an absolute instant. That is what makes DST a non-event:
 *   - FALL BACK (01:30 happens twice): the fire tuple is `(date, 90)`; once we have refreshed, the
 *     last-refresh instant reads back as `(date, 90)` too, so the repeated hour re-resolves to "not
 *     strictly after the last fire" and fires NOTHING. No double reload.
 *   - SPRING FORWARD (02:30 never occurs): the local clock jumps 01:59 → 03:00, so the first tick
 *     after the gap reads a minute-of-day PAST the fire minute and reloads once, a beat late. A
 *     point-fire that lands slightly late beats one that silently vanishes for the year (this is the
 *     one place the point-fire deliberately differs from a schedule.ts WINDOW, which skips the gap).
 */
import { z } from "zod";
import { TimeOfDay, Weekday, isValidTimeZone, localInstant, minutesOfDay, shiftDate, weekdayOf } from "./schedule";

/**
 * The refresh cadence of one content source. A discriminated union on `mode` — the boundary where the
 * player and console both parse, then trust the type within.
 *   off        never reload (the default; identical to carrying no policy at all).
 *   interval   reload every `everySeconds` (the player anchors the clock to when it mounted the surface).
 *   scheduled  reload at `atLocal` on the given `days`, evaluated in `timezone`'s wall clock.
 */
export const RefreshPolicy = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({
    mode: z.literal("interval"),
    /** Seconds between reloads (> 0). The console dials minutes/hours/days and multiplies to seconds. */
    everySeconds: z.number().int().positive(),
  }),
  z.object({
    mode: z.literal("scheduled"),
    /** `HH:MM`, 24h — the wall-clock minute the reload fires at (reuses the scheduler's time unit). */
    atLocal: TimeOfDay,
    /** Weekdays the reload is armed on (0=Sun…6=Sat; the same model as `Schedule.days`). */
    days: z.array(Weekday).min(1),
    /** IANA zone the `atLocal`/`days` are read in — never the browser's, never the last editor's. */
    timezone: z.string().min(1).max(64).refine(isValidTimeZone, "expected a valid IANA timezone"),
  }),
]);
export type RefreshPolicy = z.infer<typeof RefreshPolicy>;

/** A policy that reloads nothing — the shape an operator's "Off" choice takes on the wire. */
export const REFRESH_OFF: RefreshPolicy = { mode: "off" };

/**
 * The whole resolver: "should the surface carrying this policy reload NOW?" — pure, and the SAME
 * function the player fires from and a console preview reads. `lastRefreshAtMs` is when the content
 * last (re)loaded on the box's clock (the player seeds it to the surface's mount time); `nowMs` is
 * the instant under test. OFF never fires; INTERVAL fires once `everySeconds` has elapsed; SCHEDULED
 * fires once when the wall clock crosses `atLocal` on an armed day (see the module header for DST).
 */
export function isRefreshDue(policy: RefreshPolicy, lastRefreshAtMs: number, nowMs: number): boolean {
  switch (policy.mode) {
    case "off":
      return false;
    case "interval":
      return nowMs - lastRefreshAtMs >= policy.everySeconds * 1000;
    case "scheduled":
      return scheduledDue(policy, lastRefreshAtMs, nowMs);
  }
}

/**
 * SCHEDULED firing, entirely in wall-clock (date, minute) tuples. Find the most recent armed fire
 * moment at-or-before `now`; it is due iff that moment is strictly AFTER the last refresh. Comparing
 * tuples (never absolute instants derived from local times) is what keeps DST a non-event — see the
 * module header.
 */
function scheduledDue(
  policy: Extract<RefreshPolicy, { mode: "scheduled" }>,
  lastRefreshAtMs: number,
  nowMs: number,
): boolean {
  const now = localInstant(nowMs, policy.timezone);
  const last = localInstant(lastRefreshAtMs, policy.timezone);
  const fireMinute = minutesOfDay(policy.atLocal);
  const armed = new Set(policy.days);

  // The latest fire moment at-or-before `now`: today's, if today is armed and its fire minute has
  // already passed in the local clock; otherwise the most recent earlier armed day (whose fire is
  // strictly before today, hence necessarily before `now`).
  let fireDate: string | null = null;
  if (armed.has(now.weekday) && now.minutes >= fireMinute) {
    fireDate = now.date;
  } else {
    for (let back = 1; back <= 7; back += 1) {
      const date = shiftDate(now.date, -back);
      if (armed.has(weekdayOf(date))) {
        fireDate = date;
        break;
      }
    }
  }
  if (fireDate === null) return false; // no armed weekday at all (min(1) makes this unreachable)

  // Due iff the fire tuple (fireDate, fireMinute) is strictly after the last-refresh tuple. A fall-back
  // repeat re-reads the last refresh as the SAME tuple, so `>` (not `>=`) fires it exactly once.
  if (fireDate > last.date) return true;
  if (fireDate < last.date) return false;
  return fireMinute > last.minutes;
}
