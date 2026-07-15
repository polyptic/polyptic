/**
 * The scene scheduler (POL-89 / D93) — contracts AND the resolver.
 *
 * D24 shipped an `at HH:MM` box on every scene row that was STORED, NOT FIRED — a decoy control on
 * the product's most-used view. This module is the real thing, and it lives in `protocol` for a
 * reason: "what plays when" must be answered IDENTICALLY by the server's ticker (which applies the
 * scene) and by the console's week strip (which promises the operator what the ticker will do). One
 * resolver, one answer — the console never re-implements the rules.
 *
 * The model:
 *   - a DAYPART is a named window of the day ("Opening hours", 08:00–18:00). `end <= start` wraps
 *     past midnight ("After hours", 18:00–08:00); `start == end` is an all-day (24h) window.
 *   - a SCHEDULE binds a scene to a daypart on a recurrence (weekdays + an optional date range),
 *     with an integer PRIORITY.
 *   - the DEFAULT SCENE is the always-on floor: whatever no window covers, it fills.
 *
 * RESOLUTION (total order — no coin-flips, ever). Every window covering the instant is a candidate;
 * the winner is the first by:
 *   1. higher `priority` wins;
 *   2. then the window that STARTED MOST RECENTLY wins (a lunch window inside opening hours is the
 *      newer thing on air — the operator's mental model is "the latest thing to come on wins");
 *   3. then the SHORTER window wins (the more specific one);
 *   4. then the OLDER schedule wins (`createdAt`, then `id`) — the first one the operator wrote.
 * Nothing covering the instant → the default scene → nothing at all (leave the wall alone).
 *
 * A window belongs to THE DAY IT STARTS ON: a 22:00–02:00 daypart armed on Fridays runs Friday
 * 22:00 → Saturday 02:00. The recurrence (weekday + date range) is tested against the START date.
 *
 * TIME + DST. Every evaluation is pure WALL-CLOCK containment in ONE operator-chosen IANA zone
 * (`SchedulerSettings.timezone`): "is the local time inside this window right now?" — never absolute
 * instant arithmetic, never a pre-computed fire time. That is what makes DST a non-event:
 *   - SPRING FORWARD (02:00→03:00): local times in the gap never occur, so a window that STARTS in
 *     the gap simply never runs that day (it cannot: there is no such wall-clock moment). A window
 *     that SPANS the gap (01:00–08:00) stays covered across the jump — it is not skipped.
 *   - FALL BACK (01:00–02:00 happens twice): containment is a state, not an edge, and the ticker
 *     applies only when the RESOLVED SCENE CHANGES — so a repeated local hour re-resolves to the
 *     same scene and fires nothing. No double-apply.
 */
import { z } from "zod";

/** `HH:MM`, 24h. The unit of a daypart boundary. */
export const TimeOfDay = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, "expected a 24h HH:MM time");
export type TimeOfDay = z.infer<typeof TimeOfDay>;

/** `YYYY-MM-DD` — a calendar date in the deployment's timezone (no instant, no offset). */
export const CalendarDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "expected a YYYY-MM-DD date");
export type CalendarDate = z.infer<typeof CalendarDate>;

/** Day of week, 0 = Sunday … 6 = Saturday (JS `getDay()` convention). */
export const Weekday = z.number().int().min(0).max(6);

/**
 * A named window of the day. `end <= start` WRAPS past midnight (18:00–08:00 = "after hours");
 * `start === end` is the all-day window (a 24h daypart). Dayparts are a library — several schedules
 * reuse "Opening hours" and moving it moves everything bound to it.
 */
export const Daypart = z.object({
  id: z.string(),
  name: z.string().min(1).max(60),
  start: TimeOfDay,
  end: TimeOfDay,
});
export type Daypart = z.infer<typeof Daypart>;

/** A scene bound to a daypart on a recurrence, at a priority. The unit the ticker resolves. */
export const Schedule = z.object({
  id: z.string(),
  sceneId: z.string(),
  daypartId: z.string(),
  /** Weekdays the window is armed on (0=Sun…6=Sat). All seven = "daily". */
  days: z.array(Weekday).min(1),
  /** Higher wins an overlap. Ties resolve deterministically (see the module header). */
  priority: z.number().int().min(0).max(999),
  enabled: z.boolean(),
  /** Optional date range, INCLUSIVE both ends, tested against the window's START date. */
  from: CalendarDate.nullable(),
  until: CalendarDate.nullable(),
  /** ISO-8601 creation instant — the tie-break of last resort (older schedule wins). */
  createdAt: z.string(),
});
export type Schedule = z.infer<typeof Schedule>;

/**
 * Deployment-wide scheduler settings. The TIMEZONE is explicit and configurable (a deployment has
 * exactly one — a wall is in one building), defaulting to the server's own zone; it is never implied
 * by the browser or by whoever last edited a schedule.
 */
export const SchedulerSettings = z.object({
  /** Master switch. Off = the ticker resolves nothing and never applies (schedules are still stored). */
  enabled: z.boolean(),
  /** IANA zone, e.g. "Europe/London". Every window is evaluated in this zone's wall-clock. */
  timezone: z.string().min(1).max(64),
  /** The always-on floor: what plays when no window covers the moment. Null = leave the wall alone. */
  defaultSceneId: z.string().nullable(),
});
export type SchedulerSettings = z.infer<typeof SchedulerSettings>;

/** Everything the resolver needs. The server holds it in the control plane; the console gets it in
 *  `admin/state` — so both sides answer "what plays when" with the same function over the same data. */
export interface ScheduleSet {
  dayparts: Daypart[];
  schedules: Schedule[];
  settings: SchedulerSettings;
}

// ── REST bodies ──────────────────────────────────────────────────────────────

export const CreateDaypartBody = z.object({
  name: z.string().min(1).max(60),
  start: TimeOfDay,
  end: TimeOfDay,
});
export type CreateDaypartBody = z.infer<typeof CreateDaypartBody>;

export const UpdateDaypartBody = z.object({
  name: z.string().min(1).max(60).optional(),
  start: TimeOfDay.optional(),
  end: TimeOfDay.optional(),
});
export type UpdateDaypartBody = z.infer<typeof UpdateDaypartBody>;

export const CreateScheduleBody = z.object({
  sceneId: z.string().min(1),
  daypartId: z.string().min(1),
  days: z.array(Weekday).min(1),
  priority: z.number().int().min(0).max(999).default(0),
  enabled: z.boolean().default(true),
  from: CalendarDate.nullable().default(null),
  until: CalendarDate.nullable().default(null),
});
export type CreateScheduleBody = z.infer<typeof CreateScheduleBody>;

export const UpdateScheduleBody = z.object({
  sceneId: z.string().min(1).optional(),
  daypartId: z.string().min(1).optional(),
  days: z.array(Weekday).min(1).optional(),
  priority: z.number().int().min(0).max(999).optional(),
  enabled: z.boolean().optional(),
  from: CalendarDate.nullable().optional(),
  until: CalendarDate.nullable().optional(),
});
export type UpdateScheduleBody = z.infer<typeof UpdateScheduleBody>;

export const UpdateSchedulerSettingsBody = z.object({
  enabled: z.boolean().optional(),
  timezone: z.string().min(1).max(64).optional(),
  defaultSceneId: z.string().nullable().optional(),
});
export type UpdateSchedulerSettingsBody = z.infer<typeof UpdateSchedulerSettingsBody>;

// ── Local wall-clock helpers (no instant arithmetic — see the DST note above) ─────────────────────

/** A moment as the deployment's timezone sees it: a calendar date + minutes past local midnight. */
export interface LocalInstant {
  /** `YYYY-MM-DD` in the deployment's zone. */
  date: CalendarDate;
  /** Minutes past local midnight, 0…1439. */
  minutes: number;
  /** 0 = Sunday … 6 = Saturday, derived from `date` (pure calendar — no zone maths). */
  weekday: number;
}

/** Whether a string names a real IANA zone this runtime knows (the settings gate). */
export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** `HH:MM` → minutes past midnight. */
export function minutesOfDay(time: TimeOfDay): number {
  const [h, m] = time.split(":");
  return Number(h) * 60 + Number(m);
}

/** Minutes past midnight → `HH:MM` (wraps at 1440 so a window end renders as 00:00, not 24:00). */
export function timeOfDay(minutes: number): TimeOfDay {
  const m = ((minutes % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The weekday of a `YYYY-MM-DD` (0=Sun…6=Sat). Pure calendar arithmetic — UTC is just the vehicle. */
export function weekdayOf(date: CalendarDate): number {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay();
}

/** The calendar date `days` before/after `date` (pure calendar arithmetic). */
export function shiftDate(date: CalendarDate, days: number): CalendarDate {
  const [y, m, d] = date.split("-").map(Number);
  const at = new Date(Date.UTC(y as number, (m as number) - 1, d as number));
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
}

/** Read an absolute instant as the deployment's zone sees it. The ONE place a timezone is applied. */
export function localInstant(atMs: number, timezone: string): LocalInstant {
  const zone = isValidTimeZone(timezone) ? timezone : "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).formatToParts(new Date(atMs));
  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? "00";
  const date = `${get("year")}-${get("month")}-${get("day")}`;
  const minutes = Number(get("hour")) * 60 + Number(get("minute"));
  return { date, minutes, weekday: weekdayOf(date) };
}

// ── Resolution ───────────────────────────────────────────────────────────────

/** One window covering the instant under test — a candidate for the glass. */
export interface ScheduleCandidate {
  scheduleId: string;
  sceneId: string;
  daypartId: string;
  daypartName: string;
  priority: number;
  /** The date the window STARTED on (yesterday's, for a wrapped window still running past midnight). */
  startDate: CalendarDate;
  /** Minutes past midnight of the window's start (on `startDate`) and end (may exceed 1440 = next day). */
  startMinutes: number;
  endMinutes: number;
  /** How long the window runs, in minutes (1…1440). */
  durationMinutes: number;
  /** How long ago (in minutes) this window began, at the instant under test. */
  runningForMinutes: number;
}

/** What plays at an instant, and what lost to it. */
export interface ScheduleResolution {
  sceneId: string | null;
  /** The winning schedule, or null when the default scene (or nothing) is on. */
  scheduleId: string | null;
  source: "schedule" | "default" | "none";
  /** Every covering window, best-first. `[0]` is the winner; the rest are the priority conflicts. */
  candidates: ScheduleCandidate[];
}

/** Total order over covering windows. See the module header — this is THE rule, in one place. */
function better(a: ScheduleCandidate, b: ScheduleCandidate, orderOf: (id: string) => string): number {
  if (a.priority !== b.priority) return b.priority - a.priority; // 1. higher priority
  if (a.runningForMinutes !== b.runningForMinutes) {
    return a.runningForMinutes - b.runningForMinutes; // 2. started most recently
  }
  if (a.durationMinutes !== b.durationMinutes) return a.durationMinutes - b.durationMinutes; // 3. shorter
  return orderOf(a.scheduleId).localeCompare(orderOf(b.scheduleId)); // 4. older schedule
}

/** Is `date` inside the schedule's (inclusive) date range? Both ends are optional. */
function inDateRange(schedule: Schedule, date: CalendarDate): boolean {
  if (schedule.from && date < schedule.from) return false;
  if (schedule.until && date > schedule.until) return false;
  return true;
}

/**
 * Resolve what plays at a LOCAL moment. This is the whole scheduler: the ticker calls it every few
 * seconds with "now", and the console's week strip calls it across a week — the same function, so the
 * strip cannot lie about what the wall will do.
 */
export function resolveAtLocal(at: LocalInstant, set: ScheduleSet): ScheduleResolution {
  const none: ScheduleResolution = { sceneId: null, scheduleId: null, source: "none", candidates: [] };
  if (!set.settings.enabled) return none;

  const dayparts = new Map(set.dayparts.map((d) => [d.id, d]));
  const candidates: ScheduleCandidate[] = [];

  for (const schedule of set.schedules) {
    if (!schedule.enabled) continue;
    const daypart = dayparts.get(schedule.daypartId);
    if (!daypart) continue; // a schedule whose daypart was deleted covers nothing

    const start = minutesOfDay(daypart.start);
    const end = minutesOfDay(daypart.end);
    // start === end is the ALL-DAY window; end <= start otherwise wraps past midnight.
    const duration = start === end ? 1440 : end > start ? end - start : 1440 - start + end;

    // A window can be covering `at` in two ways: it started TODAY, or it started YESTERDAY and is
    // still running past midnight. Both are tested; the recurrence is checked against the START day.
    for (const startedYesterday of [false, true]) {
      const startDate = startedYesterday ? shiftDate(at.date, -1) : at.date;
      const elapsed = at.minutes - start + (startedYesterday ? 1440 : 0);
      if (elapsed < 0 || elapsed >= duration) continue; // this occurrence does not cover `at`
      if (!schedule.days.includes(weekdayOf(startDate))) continue;
      if (!inDateRange(schedule, startDate)) continue;
      candidates.push({
        scheduleId: schedule.id,
        sceneId: schedule.sceneId,
        daypartId: daypart.id,
        daypartName: daypart.name,
        priority: schedule.priority,
        startDate,
        startMinutes: start,
        endMinutes: start + duration,
        durationMinutes: duration,
        runningForMinutes: elapsed,
      });
    }
  }

  if (candidates.length === 0) {
    return set.settings.defaultSceneId
      ? { sceneId: set.settings.defaultSceneId, scheduleId: null, source: "default", candidates: [] }
      : none;
  }

  // Tie-break of last resort: creation order, then id — a stable, total order over the set.
  const order = new Map(set.schedules.map((s) => [s.id, `${s.createdAt} ${s.id}`]));
  const orderOf = (id: string): string => order.get(id) ?? id;
  candidates.sort((a, b) => better(a, b, orderOf));

  const winner = candidates[0] as ScheduleCandidate;
  return {
    sceneId: winner.sceneId,
    scheduleId: winner.scheduleId,
    source: "schedule",
    candidates,
  };
}

/** Resolve what plays at an absolute instant, in the deployment's zone. What the ticker calls. */
export function resolveAt(atMs: number, set: ScheduleSet): ScheduleResolution {
  return resolveAtLocal(localInstant(atMs, set.settings.timezone), set);
}

/** One contiguous stretch of a day on which the resolution does not change — a week-strip block. */
export interface ScheduleSegment {
  /** Minutes past local midnight (start inclusive, end exclusive; end may be 1440). */
  startMinutes: number;
  endMinutes: number;
  sceneId: string | null;
  scheduleId: string | null;
  source: "schedule" | "default" | "none";
  /** The losing candidates over this stretch — the priority conflicts the strip marks. */
  overriddenScheduleIds: string[];
}

/** One day of the week strip: the date, its weekday, and the resolved segments across the 24h. */
export interface ScheduleDay {
  date: CalendarDate;
  weekday: number;
  segments: ScheduleSegment[];
}

/**
 * Resolve a whole day into contiguous segments. Cuts the day at every window edge (including edges
 * inherited from yesterday's wrapped windows), resolves the midpoint of each slice with the SAME
 * resolver the ticker uses, then coalesces neighbours that resolve identically.
 */
export function resolveDay(date: CalendarDate, set: ScheduleSet): ScheduleDay {
  const dayparts = new Map(set.dayparts.map((d) => [d.id, d]));
  const cuts = new Set<number>([0, 1440]);
  for (const schedule of set.schedules) {
    const daypart = dayparts.get(schedule.daypartId);
    if (!daypart) continue;
    const start = minutesOfDay(daypart.start);
    const end = minutesOfDay(daypart.end);
    const duration = start === end ? 1440 : end > start ? end - start : 1440 - start + end;
    for (const edge of [start, start + duration, start - 1440, start + duration - 1440]) {
      if (edge > 0 && edge < 1440) cuts.add(edge);
    }
  }
  const edges = [...cuts].sort((a, b) => a - b);

  const segments: ScheduleSegment[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const startMinutes = edges[i] as number;
    const endMinutes = edges[i + 1] as number;
    const mid = Math.floor((startMinutes + endMinutes) / 2);
    const at: LocalInstant = { date, minutes: mid, weekday: weekdayOf(date) };
    const res = resolveAtLocal(at, set);
    const overridden = res.candidates.slice(1).map((c) => c.scheduleId);
    const previous = segments[segments.length - 1];
    if (
      previous &&
      previous.sceneId === res.sceneId &&
      previous.scheduleId === res.scheduleId &&
      previous.overriddenScheduleIds.join(",") === overridden.join(",")
    ) {
      previous.endMinutes = endMinutes; // same verdict — coalesce
      continue;
    }
    segments.push({
      startMinutes,
      endMinutes,
      sceneId: res.sceneId,
      scheduleId: res.scheduleId,
      source: res.source,
      overriddenScheduleIds: overridden,
    });
  }
  return { date, weekday: weekdayOf(date), segments };
}

/** Seven resolved days from `startDate` — the console's "what plays when" week strip. */
export function resolveWeek(startDate: CalendarDate, set: ScheduleSet): ScheduleDay[] {
  const out: ScheduleDay[] = [];
  for (let i = 0; i < 7; i += 1) out.push(resolveDay(shiftDate(startDate, i), set));
  return out;
}

/** The Monday-of-week (or the day itself, per `weekStartsOn`) for a date — the strip's left edge. */
export function startOfWeek(date: CalendarDate, weekStartsOn = 1): CalendarDate {
  const shift = (weekdayOf(date) - weekStartsOn + 7) % 7;
  return shiftDate(date, -shift);
}
