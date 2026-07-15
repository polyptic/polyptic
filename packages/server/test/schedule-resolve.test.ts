/**
 * POL-89 — the SHARED schedule resolver (`@polyptic/protocol`), the single answer to "what plays
 * when". The server's ticker fires from it and the console's week strip is painted from it, so every
 * rule below is a promise made in two places at once.
 *
 * Pinned here: recurrence (weekdays + inclusive date ranges), daypart windows (normal, wrapping past
 * midnight, all-day), priority, the four-step tie-break, gaps falling through to the default scene,
 * a disabled scheduler resolving nothing — and the DST boundaries, in a zone that actually has them
 * (Europe/London): a window spanning the spring-forward gap must NOT be skipped, a window that
 * starts INSIDE the gap must not fire, and the repeated fall-back hour must resolve to the SAME
 * scene both times round (the ticker only fires on a change of verdict, so that is what "no
 * double-fire" means).
 */
import { describe, expect, test } from "bun:test";

import { resolveAt, resolveDay, resolveWeek, startOfWeek } from "@polyptic/protocol";
import type { Daypart, Schedule, ScheduleSet, SchedulerSettings } from "@polyptic/protocol";

const OPENING: Daypart = { id: "daypart-1", name: "Opening hours", start: "08:00", end: "18:00" };
const LUNCH: Daypart = { id: "daypart-2", name: "Lunch", start: "12:00", end: "13:00" };
const AFTER_HOURS: Daypart = { id: "daypart-3", name: "After hours", start: "22:00", end: "02:00" };
const ALL_DAY: Daypart = { id: "daypart-4", name: "All day", start: "00:00", end: "00:00" };

const EVERY_DAY = [0, 1, 2, 3, 4, 5, 6];
const WEEKDAYS = [1, 2, 3, 4, 5];

function schedule(over: Partial<Schedule> & Pick<Schedule, "id" | "sceneId" | "daypartId">): Schedule {
  return {
    days: EVERY_DAY,
    priority: 0,
    enabled: true,
    from: null,
    until: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function settings(over: Partial<SchedulerSettings> = {}): SchedulerSettings {
  return { enabled: true, timezone: "UTC", defaultSceneId: null, ...over };
}

function set(schedules: Schedule[], over: Partial<SchedulerSettings> = {}, dayparts = [OPENING, LUNCH, AFTER_HOURS, ALL_DAY]): ScheduleSet {
  return { dayparts, schedules, settings: settings(over) };
}

/** An instant, spelled as UTC (the default test zone) — `at("2026-07-15T09:30")` is Wednesday. */
const at = (iso: string): number => Date.parse(`${iso}:00Z`);

describe("schedule resolution — windows + recurrence", () => {
  test("a scene plays inside its daypart and not outside it", () => {
    const s = set([schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id })]);
    expect(resolveAt(at("2026-07-15T07:59"), s).sceneId).toBeNull();
    expect(resolveAt(at("2026-07-15T08:00"), s).sceneId).toBe("scene-open"); // start is INCLUSIVE
    expect(resolveAt(at("2026-07-15T17:59"), s).sceneId).toBe("scene-open");
    expect(resolveAt(at("2026-07-15T18:00"), s).sceneId).toBeNull(); // end is EXCLUSIVE
  });

  test("weekday recurrence: a weekdays-only schedule is silent at the weekend", () => {
    const s = set([
      schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id, days: WEEKDAYS }),
    ]);
    expect(resolveAt(at("2026-07-17T10:00"), s).sceneId).toBe("scene-open"); // Friday
    expect(resolveAt(at("2026-07-18T10:00"), s).sceneId).toBeNull(); // Saturday
    expect(resolveAt(at("2026-07-20T10:00"), s).sceneId).toBe("scene-open"); // Monday
  });

  test("a date range is inclusive at both ends and silent outside it", () => {
    const s = set([
      schedule({
        id: "schedule-1",
        sceneId: "scene-summer",
        daypartId: OPENING.id,
        from: "2026-07-15",
        until: "2026-07-17",
      }),
    ]);
    expect(resolveAt(at("2026-07-14T10:00"), s).sceneId).toBeNull();
    expect(resolveAt(at("2026-07-15T10:00"), s).sceneId).toBe("scene-summer");
    expect(resolveAt(at("2026-07-17T10:00"), s).sceneId).toBe("scene-summer");
    expect(resolveAt(at("2026-07-18T10:00"), s).sceneId).toBeNull();
  });

  test("a WRAPPING daypart runs past midnight, and belongs to the day it STARTED on", () => {
    // "After hours" 22:00–02:00, armed on FRIDAY only: it must run Friday 22:00 → Saturday 02:00,
    // and must NOT run on Saturday evening (Saturday is not an armed start day).
    const s = set([
      schedule({ id: "schedule-1", sceneId: "scene-night", daypartId: AFTER_HOURS.id, days: [5] }),
    ]);
    expect(resolveAt(at("2026-07-17T21:59"), s).sceneId).toBeNull(); // Fri, before the window
    expect(resolveAt(at("2026-07-17T22:00"), s).sceneId).toBe("scene-night"); // Fri night
    expect(resolveAt(at("2026-07-18T01:59"), s).sceneId).toBe("scene-night"); // Sat, still Friday's window
    expect(resolveAt(at("2026-07-18T02:00"), s).sceneId).toBeNull(); // Sat, the window closed
    expect(resolveAt(at("2026-07-18T23:00"), s).sceneId).toBeNull(); // Sat night — not armed
  });

  test("an all-day daypart (start === end) covers the whole 24h", () => {
    const s = set([schedule({ id: "schedule-1", sceneId: "scene-always", daypartId: ALL_DAY.id })]);
    for (const t of ["00:00", "06:30", "12:00", "23:59"]) {
      expect(resolveAt(at(`2026-07-15T${t}`), s).sceneId).toBe("scene-always");
    }
  });

  test("a disabled schedule — and a disabled scheduler — resolve to nothing", () => {
    const off = set([
      schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id, enabled: false }),
    ]);
    expect(resolveAt(at("2026-07-15T10:00"), off).sceneId).toBeNull();

    const masterOff = set(
      [schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id })],
      { enabled: false, defaultSceneId: "scene-floor" },
    );
    const r = resolveAt(at("2026-07-15T10:00"), masterOff);
    expect(r.sceneId).toBeNull();
    expect(r.source).toBe("none");
  });

  test("a schedule whose daypart was deleted covers nothing", () => {
    const s: ScheduleSet = {
      dayparts: [], // the library was emptied out from under it
      schedules: [schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id })],
      settings: settings(),
    };
    expect(resolveAt(at("2026-07-15T10:00"), s).sceneId).toBeNull();
  });
});

describe("schedule resolution — priority, ties and the default floor", () => {
  test("higher priority wins the overlap; the loser is surfaced as a candidate", () => {
    const s = set([
      schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id, priority: 0 }),
      schedule({ id: "schedule-2", sceneId: "scene-lunch", daypartId: LUNCH.id, priority: 10 }),
    ]);
    const noon = resolveAt(at("2026-07-15T12:30"), s);
    expect(noon.sceneId).toBe("scene-lunch");
    expect(noon.scheduleId).toBe("schedule-2");
    expect(noon.candidates).toHaveLength(2);
    expect(noon.candidates[1]?.scheduleId).toBe("schedule-1"); // outranked, but visible to the strip

    // Either side of lunch, opening hours has the wall back — no leftovers.
    expect(resolveAt(at("2026-07-15T11:59"), s).sceneId).toBe("scene-open");
    expect(resolveAt(at("2026-07-15T13:00"), s).sceneId).toBe("scene-open");
  });

  test("EQUAL priority: the window that STARTED MOST RECENTLY wins", () => {
    const s = set([
      schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id, priority: 5 }),
      schedule({ id: "schedule-2", sceneId: "scene-lunch", daypartId: LUNCH.id, priority: 5 }),
    ]);
    // At 12:30 opening hours has been running 4½ hours; lunch started 30 minutes ago → lunch wins.
    expect(resolveAt(at("2026-07-15T12:30"), s).sceneId).toBe("scene-lunch");
  });

  test("EQUAL priority + same start: the SHORTER window wins, then the OLDER schedule", () => {
    const longWindow: Daypart = { id: "dp-long", name: "Morning", start: "08:00", end: "12:00" };
    const shortWindow: Daypart = { id: "dp-short", name: "Standup", start: "08:00", end: "09:00" };
    const s = set(
      [
        schedule({ id: "schedule-1", sceneId: "scene-morning", daypartId: longWindow.id }),
        schedule({ id: "schedule-2", sceneId: "scene-standup", daypartId: shortWindow.id }),
      ],
      {},
      [longWindow, shortWindow],
    );
    expect(resolveAt(at("2026-07-15T08:30"), s).sceneId).toBe("scene-standup");

    // Identical window, identical priority → the OLDER schedule (createdAt, then id) wins. Fully
    // deterministic: the same set resolves the same way on every server, every time.
    const twins = set(
      [
        schedule({
          id: "schedule-9",
          sceneId: "scene-first",
          daypartId: longWindow.id,
          createdAt: "2026-01-01T00:00:00.000Z",
        }),
        schedule({
          id: "schedule-2",
          sceneId: "scene-second",
          daypartId: longWindow.id,
          createdAt: "2026-02-01T00:00:00.000Z",
        }),
      ],
      {},
      [longWindow],
    );
    expect(resolveAt(at("2026-07-15T08:30"), twins).sceneId).toBe("scene-first");
    expect(resolveAt(at("2026-07-15T08:30"), twins).sceneId).toBe("scene-first"); // stable
  });

  test("a GAP falls through to the default scene — and to nothing when there is none", () => {
    const withFloor = set(
      [schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id })],
      { defaultSceneId: "scene-branding" },
    );
    const night = resolveAt(at("2026-07-15T03:00"), withFloor);
    expect(night.sceneId).toBe("scene-branding");
    expect(night.source).toBe("default");
    expect(night.scheduleId).toBeNull();
    // Inside the window the schedule still wins — the default is a floor, not an override.
    expect(resolveAt(at("2026-07-15T09:00"), withFloor).sceneId).toBe("scene-open");

    const bare = set([schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id })]);
    expect(resolveAt(at("2026-07-15T03:00"), bare).source).toBe("none");
  });
});

describe("schedule resolution — DST (Europe/London)", () => {
  const LONDON = { timezone: "Europe/London" };

  test("SPRING FORWARD: a window spanning the 01:00→02:00 gap is not skipped", () => {
    // 2026-03-29: London jumps 01:00 GMT → 02:00 BST. "Opening hours" is 08:00–18:00 local, which is
    // well clear of the gap — the point is that local containment still holds on the far side, i.e.
    // the day is not shifted an hour by the jump.
    const s = set([schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id })], LONDON);
    expect(resolveAt(Date.parse("2026-03-29T08:30:00+01:00"), s).sceneId).toBe("scene-open"); // 08:30 BST
    // The window follows the LOCAL clock, not the UTC one: 07:00Z is 08:00 BST — open — while 06:30Z
    // is 07:30 BST, still shut. A resolver doing instant arithmetic would be an hour out here.
    expect(resolveAt(Date.parse("2026-03-29T07:00:00Z"), s).sceneId).toBe("scene-open");
    expect(resolveAt(Date.parse("2026-03-29T06:30:00Z"), s).sceneId).toBeNull();
    expect(resolveAt(Date.parse("2026-03-29T00:30:00Z"), s).sceneId).toBeNull(); // 00:30 GMT, before

    // An overnight window that CONTAINS the gap keeps playing straight through it.
    const overnight: Daypart = { id: "dp-night", name: "Overnight", start: "23:00", end: "08:00" };
    const spans = set(
      [schedule({ id: "schedule-1", sceneId: "scene-night", daypartId: overnight.id })],
      LONDON,
      [overnight],
    );
    expect(resolveAt(Date.parse("2026-03-29T00:59:00Z"), spans).sceneId).toBe("scene-night"); // 00:59 GMT
    expect(resolveAt(Date.parse("2026-03-29T01:00:00Z"), spans).sceneId).toBe("scene-night"); // = 02:00 BST
    expect(resolveAt(Date.parse("2026-03-29T05:00:00Z"), spans).sceneId).toBe("scene-night"); // = 06:00 BST
  });

  test("SPRING FORWARD: a window that STARTS inside the gap never runs that day (and runs the next)", () => {
    // 01:30 local does not exist on 2026-03-29 — no wall-clock moment can be inside a 01:30–01:45
    // window, so nothing fires. The following day it runs normally.
    const gapWindow: Daypart = { id: "dp-gap", name: "Ghost", start: "01:30", end: "01:45" };
    const s = set([schedule({ id: "schedule-1", sceneId: "scene-ghost", daypartId: gapWindow.id })], LONDON, [gapWindow]);
    for (let m = 0; m < 120; m += 5) {
      const instant = Date.parse("2026-03-29T00:00:00Z") + m * 60_000;
      expect(resolveAt(instant, s).sceneId).toBeNull();
    }
    expect(resolveAt(Date.parse("2026-03-30T01:35:00+01:00"), s).sceneId).toBe("scene-ghost");
  });

  test("FALL BACK: the repeated 01:00–02:00 hour resolves to the SAME scene both times (no double-fire)", () => {
    // 2026-10-25: London repeats 01:00–02:00 (BST, then GMT). A window covering it must give the same
    // verdict on both passes — the ticker fires on a CHANGE of verdict, so an unchanged verdict is
    // exactly "nothing happens the second time round".
    const overnight: Daypart = { id: "dp-night", name: "Overnight", start: "23:00", end: "06:00" };
    const s = set(
      [schedule({ id: "schedule-1", sceneId: "scene-night", daypartId: overnight.id })],
      LONDON,
      [overnight],
    );
    const firstPass = resolveAt(Date.parse("2026-10-25T00:30:00Z"), s); // 01:30 BST
    const secondPass = resolveAt(Date.parse("2026-10-25T01:30:00Z"), s); // 01:30 GMT — the same wall clock
    expect(firstPass.sceneId).toBe("scene-night");
    expect(secondPass.sceneId).toBe("scene-night");
    expect(secondPass.scheduleId).toBe(firstPass.scheduleId);
    // …and the containment never lapses across the rewind, so there is no gap to re-enter through.
    expect(resolveAt(Date.parse("2026-10-25T00:59:00Z"), s).sceneId).toBe("scene-night");
    expect(resolveAt(Date.parse("2026-10-25T01:00:00Z"), s).sceneId).toBe("scene-night");
  });
});

describe("the week strip resolves from the same rules", () => {
  test("a day is cut into contiguous segments, with the conflicts marked", () => {
    const s = set(
      [
        schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id, priority: 0 }),
        schedule({ id: "schedule-2", sceneId: "scene-lunch", daypartId: LUNCH.id, priority: 10 }),
      ],
      { defaultSceneId: "scene-branding" },
    );
    const day = resolveDay("2026-07-15", s);

    // 00:00 branding · 08:00 open · 12:00 lunch (outranking open) · 13:00 open · 18:00 branding
    expect(day.segments.map((seg) => [seg.startMinutes, seg.sceneId])).toEqual([
      [0, "scene-branding"],
      [8 * 60, "scene-open"],
      [12 * 60, "scene-lunch"],
      [13 * 60, "scene-open"],
      [18 * 60, "scene-branding"],
    ]);
    // The lunch block is where the conflict lives — the strip stripes exactly this one.
    expect(day.segments[2]?.overriddenScheduleIds).toEqual(["schedule-1"]);
    expect(day.segments[1]?.overriddenScheduleIds).toEqual([]);
    // Segments tile the whole 24h with no holes.
    expect(day.segments[day.segments.length - 1]?.endMinutes).toBe(1440);
  });

  test("resolveWeek returns seven consecutive days from the week's start", () => {
    const s = set([schedule({ id: "schedule-1", sceneId: "scene-open", daypartId: OPENING.id, days: WEEKDAYS })]);
    const week = resolveWeek(startOfWeek("2026-07-15"), s); // Monday 2026-07-13
    expect(week).toHaveLength(7);
    expect(week[0]?.date).toBe("2026-07-13");
    expect(week[6]?.date).toBe("2026-07-19");
    // Saturday is unscheduled end to end; Monday has the window.
    expect(week[5]?.segments.every((seg) => seg.sceneId === null)).toBe(true);
    expect(week[0]?.segments.some((seg) => seg.sceneId === "scene-open")).toBe(true);
  });
});
