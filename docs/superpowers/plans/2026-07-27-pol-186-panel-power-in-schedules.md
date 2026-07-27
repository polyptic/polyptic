# POL-186 — Panel Power In The Schedule Window: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move panel power off the per-screen `PanelHours` model and onto the scene scheduler's recurrence engine, as a `panels: "on" | "off"` property of a schedule window, with resolution running per mural.

**Architecture:** `@polyptic/protocol`'s resolver gains a per-mural entry point that sorts the covering windows with the existing total order and reads that one sorted list twice — content from the best window carrying a `sceneId`, power from the overall winner. The server's scene ticker loops murals and drives the existing `panel-power.ts` seam, which keeps its edge-triggered memory and hello reconcile untouched. Per-screen panel hours are deleted, not migrated: nothing in the fleet has them set.

**Tech Stack:** TypeScript (strict, ESM), bun workspaces, zod contracts in `@polyptic/protocol`, Fastify + Postgres server, Vue 3 console.

## Global Constraints

- TS **strict**; ESM; 2-space indent; prefer `z.infer` types over hand-written ones.
- Every cross-process boundary is a zod schema in `packages/protocol`. **Change the contract there first.**
- Run tests with `bun test`. CI uses Bun 1.3.14; the local default is 1.2.2.
- `panels` defaults to `"on"` on every schema, so a stored schedule keeps today's behaviour.
- Postgres migrations are additive `ADD COLUMN IF NOT EXISTS` only. Never drop a column in this change.
- The four POL-101 guarantees are non-negotiable and must survive: edge-triggered sends, manual override holds until the next boundary, reconcile on hello, and in-hours the only command sent is WAKE.
- No vendor names in core code paths.

---

### Task 1: Protocol — `panels`, nullable `sceneId`, `muralId` on `Schedule`

**Files:**
- Modify: `packages/protocol/src/schedule.ts:69-108` (the `Schedule` schema, `ScheduleSet`)
- Modify: `packages/protocol/src/schedule.ts:126-146` (`CreateScheduleBody`, `UpdateScheduleBody`)
- Test: `packages/protocol/test/schedule.contract.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `PanelState` (`"on" | "off"`), `Schedule` with `sceneId: string | null`, `muralId: string | null`, `panels: PanelState`; `ScheduleSet` with `murals: string[]` and `sceneMurals: Record<string, string>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/test/schedule.contract.test.ts
import { describe, expect, test } from "bun:test";
import { Schedule, CreateScheduleBody } from "../src/schedule";

describe("Schedule panels", () => {
  test("defaults to on so a stored schedule keeps today's behaviour", () => {
    const s = Schedule.parse({
      id: "schedule-1",
      sceneId: "scene-1",
      muralId: "mural-1",
      daypartId: "daypart-1",
      days: [1, 2, 3],
      priority: 0,
      enabled: true,
      from: null,
      until: null,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    expect(s.panels).toBe("on");
  });

  test("a power-only window carries no scene", () => {
    const s = Schedule.parse({
      id: "schedule-2",
      sceneId: null,
      muralId: null,
      daypartId: "daypart-1",
      days: [0, 1, 2, 3, 4, 5, 6],
      priority: 0,
      panels: "off",
      enabled: true,
      from: null,
      until: null,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    expect(s.sceneId).toBeNull();
    expect(s.muralId).toBeNull();
    expect(s.panels).toBe("off");
  });

  test("CreateScheduleBody accepts a power-only window and defaults panels to on", () => {
    const body = CreateScheduleBody.parse({ daypartId: "daypart-1", days: [1] });
    expect(body.sceneId).toBeNull();
    expect(body.muralId).toBeNull();
    expect(body.panels).toBe("on");
  });

  test("panels rejects anything but on/off", () => {
    expect(() => Schedule.parse({
      id: "s", sceneId: null, muralId: null, daypartId: "d", days: [1],
      priority: 0, panels: "dim", enabled: true, from: null, until: null,
      createdAt: "2026-07-27T00:00:00.000Z",
    })).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/test/schedule.contract.test.ts`
Expected: FAIL — `Schedule` has no `panels`/`muralId`, and `sceneId` rejects null.

- [ ] **Step 3: Write minimal implementation**

In `packages/protocol/src/schedule.ts`, add above `Daypart`:

```ts
/**
 * POL-186 — what the panels do while a window is on air. `"on"` is the default on every schema, so
 * a schedule written before this existed keeps behaving exactly as it did.
 */
export const PanelState = z.enum(["on", "off"]);
export type PanelState = z.infer<typeof PanelState>;
```

Replace the `Schedule` schema:

```ts
/** A daypart window at a priority, optionally carrying a scene and a panel state. The unit the
 *  ticker resolves. */
export const Schedule = z.object({
  id: z.string(),
  /** The scene this window puts up, or `null` for a POWER-ONLY window: don't change what plays,
   *  only set the panels. */
  sceneId: z.string().nullable(),
  /** Which mural the window governs. Stamped from the scene for scene-bearing windows (a scene
   *  cannot move mural); the operator's explicit target for a power-only one. `null` = every mural. */
  muralId: z.string().nullable(),
  daypartId: z.string(),
  /** Weekdays the window is armed on (0=Sun…6=Sat). All seven = "daily". */
  days: z.array(Weekday).min(1),
  /** Higher wins an overlap. Ties resolve deterministically (see the module header). */
  priority: z.number().int().min(0).max(999),
  /** While this window is on air, the panels are this. */
  panels: PanelState.default("on"),
  enabled: z.boolean(),
  /** Optional date range, INCLUSIVE both ends, tested against the window's START date. */
  from: CalendarDate.nullable(),
  until: CalendarDate.nullable(),
  /** ISO-8601 creation instant — the tie-break of last resort (older schedule wins). */
  createdAt: z.string(),
});
export type Schedule = z.infer<typeof Schedule>;
```

Replace `ScheduleSet`:

```ts
export interface ScheduleSet {
  dayparts: Daypart[];
  schedules: Schedule[];
  settings: SchedulerSettings;
  /** Every mural id in the deployment — resolution runs once per mural. */
  murals: string[];
  /** scene id → the mural it snapshots. The default-scene floor is scoped through this. */
  sceneMurals: Record<string, string>;
}
```

Replace the two REST bodies:

```ts
export const CreateScheduleBody = z.object({
  sceneId: z.string().min(1).nullable().default(null),
  muralId: z.string().min(1).nullable().default(null),
  daypartId: z.string().min(1),
  days: z.array(Weekday).min(1),
  priority: z.number().int().min(0).max(999).default(0),
  panels: PanelState.default("on"),
  enabled: z.boolean().default(true),
  from: CalendarDate.nullable().default(null),
  until: CalendarDate.nullable().default(null),
});
export type CreateScheduleBody = z.infer<typeof CreateScheduleBody>;

export const UpdateScheduleBody = z.object({
  sceneId: z.string().min(1).nullable().optional(),
  muralId: z.string().min(1).nullable().optional(),
  daypartId: z.string().min(1).optional(),
  days: z.array(Weekday).min(1).optional(),
  priority: z.number().int().min(0).max(999).optional(),
  panels: PanelState.optional(),
  enabled: z.boolean().optional(),
  from: CalendarDate.nullable().optional(),
  until: CalendarDate.nullable().optional(),
});
export type UpdateScheduleBody = z.infer<typeof UpdateScheduleBody>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/test/schedule.contract.test.ts`
Expected: PASS (4 tests). Type errors in `state.ts`/`Scenes.vue` are expected at this point and are fixed in Tasks 5 and 9.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/schedule.ts packages/protocol/test/schedule.contract.test.ts
git commit -m "POL-186: panels, a nullable scene and a mural target on Schedule"
```

---

### Task 2: Protocol — per-mural resolution, reading one sorted list twice

**Files:**
- Modify: `packages/protocol/src/schedule.ts:221-336` (`ScheduleCandidate`, `ScheduleResolution`, `resolveAtLocal`, `resolveAt`)
- Test: `packages/protocol/test/schedule.test.ts`

**Interfaces:**
- Consumes: `PanelState`, `Schedule`, `ScheduleSet` from Task 1.
- Produces: `MuralResolution { muralId, sceneId, scheduleId, source, panels, powerScheduleId, candidates }`; `resolveMuralAtLocal(at: LocalInstant, set: ScheduleSet, muralId: string): MuralResolution`; `resolveMuralAt(atMs: number, set: ScheduleSet, muralId: string): MuralResolution`. `ScheduleCandidate` gains `sceneId: string | null` and `panels: PanelState`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/test/schedule.test.ts — append
import { resolveMuralAt } from "../src/schedule";
import type { ScheduleSet } from "../src/schedule";

const AT = (hhmm: string): number => Date.parse(`2026-07-28T${hhmm}:00.000Z`); // a Tuesday, UTC

function setOf(schedules: ScheduleSet["schedules"]): ScheduleSet {
  return {
    dayparts: [
      { id: "dp-night", name: "After hours", start: "19:00", end: "07:00" },
      { id: "dp-day", name: "Opening hours", start: "07:00", end: "19:00" },
      { id: "dp-all", name: "All day", start: "00:00", end: "00:00" },
    ],
    schedules,
    settings: { enabled: true, timezone: "UTC", defaultSceneId: null },
    murals: ["mural-1", "mural-2"],
    sceneMurals: { "scene-1": "mural-1", "scene-2": "mural-2" },
  };
}

const base = {
  days: [0, 1, 2, 3, 4, 5, 6],
  enabled: true,
  from: null,
  until: null,
  createdAt: "2026-07-01T00:00:00.000Z",
};

describe("per-mural power resolution", () => {
  const nightOff = { ...base, id: "s-night", sceneId: null, muralId: "mural-1", daypartId: "dp-night", priority: 0, panels: "off" as const };
  const dayScene = { ...base, id: "s-day", sceneId: "scene-1", muralId: "mural-1", daypartId: "dp-day", priority: 0, panels: "on" as const };

  test("inside the off window the panels are off and content is untouched", () => {
    const r = resolveMuralAt(AT("21:00"), setOf([nightOff, dayScene]), "mural-1");
    expect(r.panels).toBe("off");
    expect(r.powerScheduleId).toBe("s-night");
    expect(r.sceneId).toBeNull(); // no scene-bearing window covers 21:00
  });

  test("the gap between windows resolves to on — this is what wakes the wall at 07:00", () => {
    const r = resolveMuralAt(AT("07:30"), setOf([nightOff, dayScene]), "mural-1");
    expect(r.panels).toBe("on");
    expect(r.sceneId).toBe("scene-1");
  });

  test("a higher-priority window keeps the screens lit straight through the off window", () => {
    const openDay = { ...base, id: "s-open", sceneId: "scene-1", muralId: "mural-1", daypartId: "dp-all", priority: 10, panels: "on" as const };
    const r = resolveMuralAt(AT("21:00"), setOf([nightOff, dayScene, openDay]), "mural-1");
    expect(r.panels).toBe("on");
    expect(r.powerScheduleId).toBe("s-open");
    expect(r.sceneId).toBe("scene-1");
  });

  test("content comes from the best SCENE-BEARING window even when a power-only window wins overall", () => {
    const allDayScene = { ...base, id: "s-bg", sceneId: "scene-1", muralId: "mural-1", daypartId: "dp-all", priority: 0, panels: "on" as const };
    const r = resolveMuralAt(AT("21:00"), setOf([nightOff, allDayScene]), "mural-1");
    expect(r.powerScheduleId).toBe("s-night"); // the shorter window wins the order
    expect(r.panels).toBe("off");
    expect(r.sceneId).toBe("scene-1"); // and the wall keeps its scene underneath
  });

  test("a mural no window governs is ungoverned — leave the wall exactly as it is", () => {
    const r = resolveMuralAt(AT("21:00"), setOf([nightOff, dayScene]), "mural-2");
    expect(r.panels).toBeNull();
    expect(r.sceneId).toBeNull();
  });

  test("a null muralId governs every mural", () => {
    const fleetOff = { ...nightOff, id: "s-fleet", muralId: null };
    expect(resolveMuralAt(AT("21:00"), setOf([fleetOff]), "mural-1").panels).toBe("off");
    expect(resolveMuralAt(AT("21:00"), setOf([fleetOff]), "mural-2").panels).toBe("off");
  });

  test("the default scene floors only the mural that owns it", () => {
    const set = setOf([]);
    set.settings.defaultSceneId = "scene-1";
    expect(resolveMuralAt(AT("12:00"), set, "mural-1").sceneId).toBe("scene-1");
    expect(resolveMuralAt(AT("12:00"), set, "mural-2").sceneId).toBeNull();
  });

  test("a disabled scheduler governs nothing at all", () => {
    const set = setOf([nightOff]);
    set.settings.enabled = false;
    const r = resolveMuralAt(AT("21:00"), set, "mural-1");
    expect(r.panels).toBeNull();
    expect(r.sceneId).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/test/schedule.test.ts`
Expected: FAIL — `resolveMuralAt` is not exported.

- [ ] **Step 3: Write minimal implementation**

In `packages/protocol/src/schedule.ts`, extend `ScheduleCandidate` with two fields:

```ts
export interface ScheduleCandidate {
  scheduleId: string;
  /** `null` on a power-only window. */
  sceneId: string | null;
  /** What this window says the panels do while it is on air. */
  panels: PanelState;
  daypartId: string;
  daypartName: string;
  priority: number;
  startDate: CalendarDate;
  startMinutes: number;
  endMinutes: number;
  durationMinutes: number;
  runningForMinutes: number;
}
```

Add the mural filter and the resolution type:

```ts
/** Does this window govern `muralId`? A `null` target governs every mural. */
function governs(schedule: Schedule, muralId: string): boolean {
  return schedule.muralId === null || schedule.muralId === muralId;
}

/**
 * What ONE mural is doing at an instant: what it plays, and what its panels do.
 *
 * Both answers come from the SAME sorted candidate list, read twice — content from the best window
 * that carries a scene, power from the overall winner. That is why an "Open day" window at a higher
 * priority keeps the screens lit straight through a nightly off window with no special-casing: it
 * simply sorts first.
 */
export interface MuralResolution {
  muralId: string;
  sceneId: string | null;
  /** The winning CONTENT schedule, or null when the default scene (or nothing) is on. */
  scheduleId: string | null;
  source: "schedule" | "default" | "none";
  /** The panel state, or `null` when NO enabled window governs this mural — ungoverned, so the wall
   *  is left exactly as it is (a screen an operator slept by hand stays asleep). */
  panels: PanelState | null;
  /** The window the panel state came from, or null when nothing covers the instant. */
  powerScheduleId: string | null;
  /** Every covering window, best-first. */
  candidates: ScheduleCandidate[];
}

/** Resolve ONE mural at a LOCAL moment. The ticker calls this per mural; so does the week strip. */
export function resolveMuralAtLocal(
  at: LocalInstant,
  set: ScheduleSet,
  muralId: string,
): MuralResolution {
  const none: MuralResolution = {
    muralId,
    sceneId: null,
    scheduleId: null,
    source: "none",
    panels: null,
    powerScheduleId: null,
    candidates: [],
  };
  if (!set.settings.enabled) return none;

  const dayparts = new Map(set.dayparts.map((d) => [d.id, d]));
  const candidates: ScheduleCandidate[] = [];
  let governed = false;

  for (const schedule of set.schedules) {
    if (!schedule.enabled) continue;
    if (!governs(schedule, muralId)) continue;
    const daypart = dayparts.get(schedule.daypartId);
    if (!daypart) continue; // a schedule whose daypart was deleted covers nothing
    // This mural HAS an enabled window, so its gaps are "on" rather than ungoverned — that is what
    // wakes the wall at the far edge of a nightly off window.
    governed = true;

    const start = minutesOfDay(daypart.start);
    const end = minutesOfDay(daypart.end);
    const duration = start === end ? 1440 : end > start ? end - start : 1440 - start + end;

    for (const startedYesterday of [false, true]) {
      const startDate = startedYesterday ? shiftDate(at.date, -1) : at.date;
      const elapsed = at.minutes - start + (startedYesterday ? 1440 : 0);
      if (elapsed < 0 || elapsed >= duration) continue;
      if (!schedule.days.includes(weekdayOf(startDate))) continue;
      if (!inDateRange(schedule, startDate)) continue;
      candidates.push({
        scheduleId: schedule.id,
        sceneId: schedule.sceneId,
        panels: schedule.panels,
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

  if (!governed) return none;

  const order = new Map(set.schedules.map((s) => [s.id, `${s.createdAt} ${s.id}`]));
  const orderOf = (id: string): string => order.get(id) ?? id;
  candidates.sort((a, b) => better(a, b, orderOf));

  // POWER: the overall winner, power-only windows included. No covering window = the gap, which on a
  // governed mural is "on" — the only power command a gap can produce is WAKE.
  const powerWinner = candidates[0];
  const panels: PanelState = powerWinner ? powerWinner.panels : "on";

  // CONTENT: the best window that actually carries a scene, then the default floor for THIS mural.
  const contentWinner = candidates.find((c) => c.sceneId !== null);
  if (contentWinner) {
    return {
      muralId,
      sceneId: contentWinner.sceneId,
      scheduleId: contentWinner.scheduleId,
      source: "schedule",
      panels,
      powerScheduleId: powerWinner?.scheduleId ?? null,
      candidates,
    };
  }

  const fallback = set.settings.defaultSceneId;
  const fallbackOnThisMural = fallback !== null && set.sceneMurals[fallback] === muralId;
  return {
    muralId,
    sceneId: fallbackOnThisMural ? fallback : null,
    scheduleId: null,
    source: fallbackOnThisMural ? "default" : "none",
    panels,
    powerScheduleId: powerWinner?.scheduleId ?? null,
    candidates,
  };
}

/** Resolve one mural at an absolute instant, in the deployment's zone. What the ticker calls. */
export function resolveMuralAt(atMs: number, set: ScheduleSet, muralId: string): MuralResolution {
  return resolveMuralAtLocal(localInstant(atMs, set.settings.timezone), set, muralId);
}
```

Delete `resolveAtLocal`, `resolveAt` and `ScheduleResolution` — every caller moves to the mural form in Tasks 3 and 6.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/test/schedule.test.ts`
Expected: PASS. Existing `resolveAt` tests in that file must be rewritten onto `resolveMuralAt` with a `murals`/`sceneMurals` set — do that in this step rather than deleting them.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/schedule.ts packages/protocol/test/schedule.test.ts
git commit -m "POL-186: resolve per mural, reading one sorted list for content and power"
```

---

### Task 3: Protocol — the week strip resolves per mural and carries `panels`

**Files:**
- Modify: `packages/protocol/src/schedule.ts:338-412` (`ScheduleSegment`, `resolveDay`, `resolveWeek`)
- Test: `packages/protocol/test/schedule.test.ts`

**Interfaces:**
- Consumes: `resolveMuralAtLocal`, `MuralResolution` from Task 2.
- Produces: `ScheduleSegment` with `panels: PanelState | null`; `resolveDay(date, set, muralId)`; `resolveWeek(startDate, set, muralId)`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/test/schedule.test.ts — append
import { resolveDay } from "../src/schedule";

describe("week strip segments carry the panel state", () => {
  test("the off window is its own segment and is marked off", () => {
    const set = setOf([
      { ...base, id: "s-night", sceneId: null, muralId: "mural-1", daypartId: "dp-night", priority: 0, panels: "off" as const },
      { ...base, id: "s-day", sceneId: "scene-1", muralId: "mural-1", daypartId: "dp-day", priority: 0, panels: "on" as const },
    ]);
    const day = resolveDay("2026-07-28", set, "mural-1");
    const dark = day.segments.filter((s) => s.panels === "off");
    expect(dark.length).toBe(2); // 00:00-07:00 and 19:00-24:00
    expect(dark[0]?.startMinutes).toBe(0);
    expect(dark[0]?.endMinutes).toBe(420);
    expect(dark[1]?.startMinutes).toBe(1140);
    const lit = day.segments.find((s) => s.startMinutes === 420);
    expect(lit?.panels).toBe("on");
    expect(lit?.sceneId).toBe("scene-1");
  });

  test("segments do not coalesce across a change in panel state alone", () => {
    const set = setOf([
      { ...base, id: "s-a", sceneId: "scene-1", muralId: "mural-1", daypartId: "dp-day", priority: 0, panels: "on" as const },
      { ...base, id: "s-b", sceneId: null, muralId: "mural-1", daypartId: "dp-night", priority: 0, panels: "off" as const },
    ]);
    const day = resolveDay("2026-07-28", set, "mural-1");
    for (let i = 1; i < day.segments.length; i += 1) {
      const prev = day.segments[i - 1];
      const cur = day.segments[i];
      expect(prev?.panels === cur?.panels && prev?.sceneId === cur?.sceneId).toBe(false);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/test/schedule.test.ts`
Expected: FAIL — `resolveDay` takes two arguments and `ScheduleSegment` has no `panels`.

- [ ] **Step 3: Write minimal implementation**

```ts
export interface ScheduleSegment {
  startMinutes: number;
  endMinutes: number;
  sceneId: string | null;
  scheduleId: string | null;
  source: "schedule" | "default" | "none";
  /** POL-186 — what the panels do across this stretch. `null` = ungoverned. The strip PAINTS this:
   *  it must never show a lit window the wall will run dark. */
  panels: PanelState | null;
  overriddenScheduleIds: string[];
}
```

In `resolveDay`, take `muralId`, skip windows that do not govern it when collecting cuts, resolve with `resolveMuralAtLocal`, carry `panels` into the segment, and add `panels` to the coalesce guard:

```ts
export function resolveDay(date: CalendarDate, set: ScheduleSet, muralId: string): ScheduleDay {
  const dayparts = new Map(set.dayparts.map((d) => [d.id, d]));
  const cuts = new Set<number>([0, 1440]);
  for (const schedule of set.schedules) {
    if (!governs(schedule, muralId)) continue;
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
    const res = resolveMuralAtLocal(at, set, muralId);
    const overridden = res.candidates.slice(1).map((c) => c.scheduleId);
    const previous = segments[segments.length - 1];
    if (
      previous &&
      previous.sceneId === res.sceneId &&
      previous.scheduleId === res.scheduleId &&
      previous.panels === res.panels &&
      previous.overriddenScheduleIds.join(",") === overridden.join(",")
    ) {
      previous.endMinutes = endMinutes;
      continue;
    }
    segments.push({
      startMinutes,
      endMinutes,
      sceneId: res.sceneId,
      scheduleId: res.scheduleId,
      source: res.source,
      panels: res.panels,
      overriddenScheduleIds: overridden,
    });
  }
  return { date, weekday: weekdayOf(date), segments };
}

/** Seven resolved days from `startDate` for ONE mural — the console's week strip. */
export function resolveWeek(startDate: CalendarDate, set: ScheduleSet, muralId: string): ScheduleDay[] {
  const out: ScheduleDay[] = [];
  for (let i = 0; i < 7; i += 1) out.push(resolveDay(shiftDate(startDate, i), set, muralId));
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/protocol/`
Expected: PASS across the protocol package.

- [ ] **Step 5: Commit**

```bash
git add packages/protocol/src/schedule.ts packages/protocol/test/schedule.test.ts
git commit -m "POL-186: week-strip segments carry the panel state, per mural"
```

---

### Task 4: Persistence — new columns, per-mural active scene, and the backfill

**Files:**
- Modify: `packages/server/src/store/types.ts:268-300` (`PersistedSchedule`), `:508` (`activeSceneId`), `:577` (`setActiveSceneId`)
- Modify: `packages/server/src/store/postgres.ts:419-426` (murals table), `:546-557` (schedules table), `:1137` (active scene write), `:1461-1480` (`upsertSchedule`)
- Modify: `packages/server/src/store/memory.ts:97-110`, `:205`
- Test: `packages/server/test/store-schedule.test.ts`

**Interfaces:**
- Consumes: `PanelState` from Task 1.
- Produces: `PersistedSchedule` with `sceneId: string | null`, `muralId: string | null`, `panels: PanelState`; `Store.setActiveSceneId(muralId: string, sceneId: string | null)`; `Store.listActiveScenes(): Promise<Record<string, string>>`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/store-schedule.test.ts
import { describe, expect, test } from "bun:test";
import { MemoryStore } from "../src/store/memory";

describe("store round-trips POL-186 schedule fields", () => {
  test("a power-only fleet-wide window survives a round trip", async () => {
    const store = new MemoryStore();
    await store.upsertSchedule({
      id: "schedule-1",
      sceneId: null,
      muralId: null,
      daypartId: "daypart-1",
      days: [1, 2, 3, 4, 5],
      priority: 0,
      panels: "off",
      enabled: true,
      from: null,
      until: null,
      createdAt: "2026-07-27T00:00:00.000Z",
    });
    const [row] = await store.listSchedules();
    expect(row?.sceneId).toBeNull();
    expect(row?.muralId).toBeNull();
    expect(row?.panels).toBe("off");
  });

  test("the active scene is per mural", async () => {
    const store = new MemoryStore();
    await store.setActiveSceneId("mural-1", "scene-1");
    await store.setActiveSceneId("mural-2", "scene-9");
    await store.setActiveSceneId("mural-1", null);
    expect(await store.listActiveScenes()).toEqual({ "mural-2": "scene-9" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/store-schedule.test.ts`
Expected: FAIL — `setActiveSceneId` takes one argument; `PersistedSchedule` has no `muralId`/`panels`.

- [ ] **Step 3: Write minimal implementation**

`store/types.ts` — extend `PersistedSchedule` with `sceneId: string | null`, `muralId: string | null`, `panels: "on" | "off"`; replace `setActiveSceneId(sceneId)` with:

```ts
  /** POL-186 — the active scene for ONE mural. `null` clears it. */
  setActiveSceneId(muralId: string, sceneId: string | null): Promise<void>;
  /** POL-186 — mural id → its active scene id. Murals with no active scene are absent. */
  listActiveScenes(): Promise<Record<string, string>>;
```

Remove `activeSceneId` from the persisted-snapshot interface at `:508` and add `activeScenes: Record<string, string>`.

`store/postgres.ts` — in the migration block after the schedules table:

```ts
    // POL-186 — panel power moved onto the schedule window. All additive: a schedule written before
    // this keeps `panels = 'on'` and a scene-derived mural, so nothing changes for a live wall.
    await sql`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS panels text NOT NULL DEFAULT 'on'`;
    await sql`ALTER TABLE schedules ADD COLUMN IF NOT EXISTS mural_id text`;
    await sql`ALTER TABLE schedules ALTER COLUMN scene_id DROP NOT NULL`;
    await sql`UPDATE schedules s SET mural_id = sc.mural_id
                FROM scenes sc WHERE sc.id = s.scene_id AND s.mural_id IS NULL`;
    await sql`ALTER TABLE murals ADD COLUMN IF NOT EXISTS active_scene_id text`;
    // Carry the single global active scene onto whichever mural owned it, then stop writing meta.
    await sql`UPDATE murals m SET active_scene_id = meta.active_scene_id
                FROM meta, scenes sc
                WHERE meta.id = 1 AND sc.id = meta.active_scene_id AND sc.mural_id = m.id
                  AND m.active_scene_id IS NULL`;
```

Update `upsertSchedule` to write `mural_id` and `panels`, `listSchedules` to read them, and replace the `meta.active_scene_id` write at `:1137` with a `murals` update plus a `listActiveScenes` reader.

`store/memory.ts` — replace the `activeSceneId` field with `private activeScenes = new Map<string, string>()`, implement both new methods, and add `muralId`/`panels` to the stored schedule shape.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/store-schedule.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/store packages/server/test/store-schedule.test.ts
git commit -m "POL-186: persist panels, the mural target, and a per-mural active scene"
```

---

### Task 5: Control plane — per-mural active scene, mural list, stamped `muralId`

**Files:**
- Modify: `packages/server/src/state.ts:506` (initial state), `:900-910` (hydrate), `:4830-4860` (`setActiveScene`, `reconcileActiveScene`), `:5313-5320` (`getScheduleSet`), `:5361-5405` (`createSchedule`, `updateSchedule`), `:4933-5000` (`applyScene`)
- Modify: `packages/server/src/admin.ts:613`
- Modify: `packages/protocol/src/index.ts:976`, `:2694`
- Test: `packages/server/test/scene-power.test.ts`

**Interfaces:**
- Consumes: store methods from Task 4; `PanelState` from Task 1.
- Produces: `ControlPlane.getScheduleSet(): ScheduleSet` (now carrying `murals` + `sceneMurals`); `ControlPlane.getActiveSceneId(muralId: string): string | null`; `DesiredState.activeScenes: Record<string, string>` replacing `activeSceneId`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/scene-power.test.ts
import { describe, expect, test } from "bun:test";
import { makeControlPlane } from "./helpers/control"; // existing test helper

describe("control plane carries the resolver's mural context", () => {
  test("getScheduleSet lists murals and the scene→mural map", async () => {
    const control = await makeControlPlane();
    const mural = await control.createMural("Lobby");
    const scene = await control.snapshotScene("Morning", mural.id);
    const set = control.getScheduleSet();
    expect(set.murals).toContain(mural.id);
    expect(set.sceneMurals[scene!.id]).toBe(mural.id);
  });

  test("createSchedule stamps the mural from the scene", async () => {
    const control = await makeControlPlane();
    const mural = await control.createMural("Lobby");
    const scene = await control.snapshotScene("Morning", mural.id);
    const daypart = await control.createDaypart({ name: "Day", start: "07:00", end: "19:00" });
    const result = await control.createSchedule({
      sceneId: scene!.id, muralId: null, daypartId: daypart.id,
      days: [1], priority: 0, panels: "on", enabled: true, from: null, until: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.schedule.muralId).toBe(mural.id);
  });

  test("a power-only window keeps the mural the operator targeted", async () => {
    const control = await makeControlPlane();
    const mural = await control.createMural("Lobby");
    const daypart = await control.createDaypart({ name: "Night", start: "19:00", end: "07:00" });
    const result = await control.createSchedule({
      sceneId: null, muralId: mural.id, daypartId: daypart.id,
      days: [1], priority: 0, panels: "off", enabled: true, from: null, until: null,
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.schedule.sceneId).toBeNull();
      expect(result.schedule.muralId).toBe(mural.id);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/scene-power.test.ts`
Expected: FAIL — `getScheduleSet` returns no `murals`, and `createSchedule` rejects a null `sceneId`.

- [ ] **Step 3: Write minimal implementation**

In `state.ts`:

```ts
  getScheduleSet(): ScheduleSet {
    const sceneMurals: Record<string, string> = {};
    for (const scene of this.scenes.values()) sceneMurals[scene.id] = scene.muralId;
    return {
      dayparts: this.getDayparts(),
      schedules: this.getSchedules(),
      settings: this.getSchedulerSettings(),
      murals: [...this.murals.keys()],
      sceneMurals,
    };
  }
```

`createSchedule` validates the two shapes and stamps the mural:

```ts
    // A window either carries a scene (and takes that scene's mural) or is POWER-ONLY and targets a
    // mural the operator names — or every mural, with null.
    if (body.sceneId !== null && !this.scenes.has(body.sceneId)) return { ok: false, error: "unknown-scene" };
    if (body.muralId !== null && !this.murals.has(body.muralId)) return { ok: false, error: "unknown-mural" };
    if (!this.dayparts.has(body.daypartId)) return { ok: false, error: "unknown-daypart" };
    const muralId = body.sceneId !== null
      ? (this.scenes.get(body.sceneId)?.muralId ?? null)
      : body.muralId;
```

…and passes `muralId` plus `panels: body.panels` into `Schedule.parse`. Widen the error union with `"unknown-mural"`. `updateSchedule` re-stamps `muralId` whenever `sceneId` changes.

Replace `state.activeSceneId` with `state.activeScenes: Record<string, string>`; `setActiveScene(muralId, sceneId)` writes through per mural; `reconcileActiveScene` re-diffs only the mural it is given; `applyScene` sets the active scene for `scene.muralId`. Update the hydrate path and `admin.ts:613` to send `activeScenes`, and swap the protocol field at `index.ts:976` and `:2694`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/scene-power.test.ts && bun test packages/server/`
Expected: PASS. Existing scheduler/scene tests referencing `activeSceneId` are updated in this step.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/state.ts packages/server/src/admin.ts packages/protocol/src/index.ts packages/server/test/scene-power.test.ts
git commit -m "POL-186: per-mural active scene and mural-aware schedule creation"
```

---

### Task 6: Ticker — per-mural verdicts, and the power hand-off

**Files:**
- Modify: `packages/server/src/scheduler.ts` (whole file)
- Test: `packages/server/test/scheduler.test.ts`

**Interfaces:**
- Consumes: `resolveMuralAt`/`MuralResolution` from Task 2; `getScheduleSet` from Task 5.
- Produces: `SceneSchedulerDeps.panelPower?: { applyMuralPower(muralId: string, panels: PanelState | null, daypartName: string): void }`; `TickOutcome { resolutions: MuralResolution[]; applied: string[]; reasons: Record<string, TickReason> }`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/scheduler.test.ts — append
describe("the ticker drives panel power per mural", () => {
  test("crossing into an off window hands 'off' to the panel-power seam once", async () => {
    const calls: Array<[string, string | null]> = [];
    const { scheduler } = await makeSchedulerFixture({
      panelPower: { applyMuralPower: (m, p) => { calls.push([m, p]); } },
    });
    await scheduler.tick(AT("18:30")); // in hours
    await scheduler.tick(AT("19:30")); // crossed the boundary
    await scheduler.tick(AT("19:40")); // no boundary — must say nothing new
    expect(calls).toEqual([["mural-1", "on"], ["mural-1", "off"]]);
  });

  test("two murals resolve independently", async () => {
    const calls: Array<[string, string | null]> = [];
    const { scheduler } = await makeSchedulerFixture({
      twoMurals: true,
      panelPower: { applyMuralPower: (m, p) => { calls.push([m, p]); } },
    });
    await scheduler.tick(AT("21:00"));
    expect(calls).toContainEqual(["mural-1", "off"]);
    expect(calls).toContainEqual(["mural-2", "on"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/scheduler.test.ts`
Expected: FAIL — `SceneSchedulerDeps` has no `panelPower`.

- [ ] **Step 3: Write minimal implementation**

Replace `lastVerdict` with `private readonly lastVerdicts = new Map<string, string | null>()`, and in `evaluate` loop the murals:

```ts
  private async evaluate(nowMs: number): Promise<TickOutcome> {
    const control = this.deps.control;
    const set = control.getScheduleSet();
    const resolutions: MuralResolution[] = [];
    const applied: string[] = [];

    if (!set.settings.enabled) {
      this.lastVerdicts.clear();
      return { resolutions, applied, reasons: {} };
    }

    const reasons: Record<string, TickReason> = {};
    for (const muralId of set.murals) {
      const resolution = resolveMuralAt(nowMs, set, muralId);
      resolutions.push(resolution);

      // POWER first: the seam is edge-triggered itself, so handing it the same value twice is free.
      this.deps.panelPower?.applyMuralPower(
        muralId,
        resolution.panels,
        resolution.candidates[0]?.daypartName ?? "a scheduled window",
      );

      const target = resolution.sceneId;
      if (target === null) { this.lastVerdicts.set(muralId, null); reasons[muralId] = "nothing-scheduled"; continue; }
      if (this.lastVerdicts.get(muralId) === target) { reasons[muralId] = "unchanged"; continue; }
      if (!control.getScene(target)) { this.lastVerdicts.set(muralId, target); reasons[muralId] = "missing-scene"; continue; }
      if (control.getActiveSceneId(muralId) === target) { this.lastVerdicts.set(muralId, target); reasons[muralId] = "already-live"; continue; }

      this.lastVerdicts.set(muralId, target);
      if (await this.deps.apply(target)) {
        applied.push(target);
        reasons[muralId] = "applied";
        const sceneName = control.getScene(target)?.name ?? target;
        const window = resolution.source === "default"
          ? "the default scene"
          : (resolution.candidates[0]?.daypartName ?? "a scheduled window");
        this.deps.activity?.push("info", `Schedule: ${sceneName} — ${window}`);
      } else {
        reasons[muralId] = "missing-scene";
      }
    }
    return { resolutions, applied, reasons };
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/scheduler.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/scheduler.ts packages/server/test/scheduler.test.ts
git commit -m "POL-186: the scene ticker resolves per mural and drives panel power"
```

---

### Task 7: `panel-power.ts` — re-source `desiredFor`, retire the second clock

**Files:**
- Modify: `packages/server/src/panel-power.ts` (whole file)
- Modify: `packages/server/src/index.ts:449-457`, `:669+` (wiring order)
- Test: `packages/server/test/panel-power.test.ts`

**Interfaces:**
- Consumes: `resolveMuralAt` (Task 2), `getScheduleSet`/placement lookup (Task 5).
- Produces: `PanelPowerScheduler.applyMuralPower(muralId, panels, daypartName)`; `desiredFor(screenId): boolean | null` unchanged in shape; `reconcileMachine(machineId)` unchanged in shape. `tick()` and `PANEL_TICK_MS` removed.

- [ ] **Step 1: Write the failing test**

```ts
// packages/server/test/panel-power.test.ts — replace the panel-hours suites with these
describe("scheduled panel power", () => {
  test("a manual wake mid-window holds until the next boundary", async () => {
    const { panelPower, sent } = await makePanelFixture(); // mural-1 has a 19:00-07:00 off window
    panelPower.applyMuralPower("mural-1", "on", "Opening hours");
    panelPower.applyMuralPower("mural-1", "off", "After hours");
    expect(sent).toEqual([["screen-1", false]]);
    sent.length = 0;
    panelPower.send("screen-1", true, "requested by an operator"); // the operator's 19:05 wake
    sent.length = 0;
    panelPower.applyMuralPower("mural-1", "off", "After hours"); // ticks keep arriving
    panelPower.applyMuralPower("mural-1", "off", "After hours");
    expect(sent).toEqual([]); // the schedule's opinion has not changed, so it says nothing
  });

  test("an ungoverned mural is left exactly as it is", async () => {
    const { panelPower, sent } = await makePanelFixture();
    panelPower.applyMuralPower("mural-1", null, "");
    panelPower.applyMuralPower("mural-1", null, "");
    expect(sent).toEqual([]);
  });

  test("hello reconcile re-sleeps a box that rebooted inside an off window", async () => {
    const { panelPower, sent } = await makePanelFixture({ nowMinutes: 21 * 60 });
    panelPower.reconcileMachine("machine-1");
    expect(sent).toEqual([["screen-1", false]]);
  });

  test("reconcile never sends a redundant wake — a booting box is already lit", async () => {
    const { panelPower, sent } = await makePanelFixture({ nowMinutes: 12 * 60 });
    panelPower.reconcileMachine("machine-1");
    expect(sent).toEqual([]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/server/test/panel-power.test.ts`
Expected: FAIL — `applyMuralPower` does not exist.

- [ ] **Step 3: Write minimal implementation**

Rewrite the module header's "Convergence" section to say the convergence has happened, then:

```ts
  /** The desired power for one screen right now, or `null` when no window governs its mural. */
  desiredFor(screenId: string): boolean | null {
    const muralId = this.deps.control.getPlacementMuralId(screenId);
    if (muralId === null) return null; // an unplaced screen belongs to no mural, so no window governs it
    const { panels } = resolveMuralAt(this.now().getTime(), this.deps.control.getScheduleSet(), muralId);
    return panels === null ? null : panels === "on";
  }

  /**
   * The scene ticker's per-mural verdict. Edge-triggered exactly as the panel-hours tick was: we
   * remember what the SCHEDULE wanted last time, and say nothing at all until that changes. An
   * operator's manual wake/sleep deliberately does NOT touch this memory, which is what lets an
   * override hold until the next boundary.
   */
  applyMuralPower(muralId: string, panels: PanelState | null, daypartName: string): void {
    for (const screen of this.deps.control.getScreens()) {
      if (this.deps.control.getPlacementMuralId(screen.id) !== muralId) continue;
      if (panels === null) { this.lastDesired.delete(screen.id); continue; }
      const desired = panels === "on";
      const previous = this.lastDesired.get(screen.id);
      this.lastDesired.set(screen.id, desired);
      if (previous === undefined) continue; // first sight of this screen — record, don't act
      if (previous === desired) continue;   // no boundary crossed
      this.send(screen.id, desired, `schedule: ${daypartName}`);
      this.deps.activity.push(
        "info",
        desired
          ? `${screen.friendlyName} woke — ${daypartName}`
          : `${screen.friendlyName} is sleeping — ${daypartName}`,
      );
    }
  }
```

Delete `tick()`, `PANEL_TICK_MS`, `start()`, `stop()`, `panelShouldBeOn`, `minutesOfDay`, `minutesInZone` and the `timer` field; `reconcileMachine`, `noteScheduleApplied` and `send` stay exactly as they are. Remove `panelPower.start()` from `index.ts:457`, and pass `panelPower` into the `SceneScheduler` constructor at `:669`.

Add `getPlacementMuralId(screenId: string): string | null` to `ControlPlane` — `this.placements.get(screenId)?.muralId ?? null`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/server/test/panel-power.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/server/src/panel-power.ts packages/server/src/index.ts packages/server/src/state.ts packages/server/test/panel-power.test.ts
git commit -m "POL-186: panel power reads the schedule resolver, on one clock"
```

---

### Task 8: Remove per-screen panel hours end to end

**Files:**
- Modify: `packages/protocol/src/index.ts` (`PanelHours`, `PanelHoursBody`, `PanelPowerConfig`, `UpdatePanelPowerBody`, `ScreenState.panelHours`, `AdminState.panelPower`)
- Modify: `packages/server/src/rest.ts` (the panel-hours route), `packages/server/src/state.ts` (the four accessors + two cascade call sites), `packages/server/src/store/*` (the `hours` blob)
- Modify: `packages/console/src/api.ts`, `packages/console/src/stores/console.ts`, `packages/console/src/components/ScreenRow.vue`, `packages/console/src/components/canvas/Inspector.vue`
- Test: `packages/protocol/test/panel-power.contract.test.ts`, `packages/e2e/panel-power.e2e.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `PanelPowerConfig` deleted; the deployment's one timezone is `SchedulerSettings.timezone`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/protocol/test/panel-power.contract.test.ts — replace the PanelHours suites
import * as protocol from "../src/index";

describe("per-screen panel hours are gone", () => {
  test("the schema no longer exists", () => {
    expect("PanelHours" in protocol).toBe(false);
    expect("PanelHoursBody" in protocol).toBe(false);
    expect("PanelPowerConfig" in protocol).toBe(false);
  });

  test("manual wake/sleep survives untouched", () => {
    const msg = protocol.ServerToAgentDisplayPower.parse({
      t: "server/display-power", connector: "HDMI-1", on: false, reason: "requested by an operator",
    });
    expect(msg.on).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/protocol/test/panel-power.contract.test.ts`
Expected: FAIL — the schemas are still exported.

- [ ] **Step 3: Write minimal implementation**

Delete `PanelHours`, `PanelHoursBody`, `PanelPowerConfig`, `UpdatePanelPowerBody`, `ScreenState.panelHours` and `AdminState.panelPower` from the protocol; delete the `PUT /api/v1/screens/:screenId/panel-hours` and `PUT /api/v1/settings/panel-power` routes from `rest.ts`; delete `getPanelHours`, `listPanelHours`, `setPanelHours`, `forgetPanelHours`, `getPanelPowerConfig` and the two cascade call sites at `state.ts:1716` and `:2247`; drop the `hours` field from the store's panel-power row (leave the table). In the console, delete the panel-hours editor and `hoursSummary` chip from `ScreenRow.vue`, the panel-hours block in `Inspector.vue`, and the `setPanelHours`/`panelHours` members of `api.ts` and `stores/console.ts`. Keep the manual wake/sleep toggle, the "asleep" chip, `powerAckLine`, and `usePanelPower.ts`.

Rewrite `packages/e2e/panel-power.e2e.test.ts` to drive a schedule window instead of a panel-hours PUT.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test && bun run --cwd packages/console build`
Expected: PASS, and the console builds with no dangling references.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "POL-186: remove per-screen panel hours; one deployment timezone"
```

---

### Task 9: Console — the Panels control and power-only windows

**Files:**
- Modify: `packages/console/src/views/Scenes.vue:170-234` (editor state + save), `:486-542` (the modal), `:456-468` (the schedule rows)
- Modify: `packages/console/src/stores/console.ts` (`createSchedule` signature)
- Test: manual, via the isolated verify stack

**Interfaces:**
- Consumes: `CreateScheduleBody` from Task 1.
- Produces: nothing later tasks depend on.

- [ ] **Step 1: Add the editor state**

```ts
const edPanels = ref<"on" | "off">("on");
const edSceneId = ref<string | null>(null); // null = a power-only window
const edMuralId = ref<string | null>(null); // null = every mural

function openEditor(sceneId: string | null) {
  editorSceneId.value = sceneId;
  edSceneId.value = sceneId;
  edMuralId.value = sceneId ? null : (store.activeMuralId ?? null);
  edPanels.value = "on";
  edDaypartId.value = dayparts.value[0]?.id ?? "";
  edDays.value = [...ALL_DAYS];
  edPriority.value = 0;
  edFrom.value = "";
  edUntil.value = "";
  edError.value = "";
}
```

`saveSchedule` sends `sceneId: edSceneId.value`, `muralId: edMuralId.value`, `panels: edPanels.value`.

- [ ] **Step 2: Add the control to the modal**

```html
<div class="field-row">
  <span class="field-label">Panels</span>
  <div class="days">
    <button class="day-btn" :class="{ on: edPanels === 'on' }" @click="edPanels = 'on'">On</button>
    <button class="day-btn" :class="{ on: edPanels === 'off' }" @click="edPanels = 'off'">Off</button>
  </div>
  <span class="hint">
    While this window is on air the screens sleep. A higher-priority window keeps them lit.
  </span>
</div>
```

- [ ] **Step 3: Add the power-only entry point**

A `+ Power window` button beside `+ Save current wall` in the header calls `openEditor(null)`; the modal title reads `Power window` when `editorSceneId` is null, and shows a mural select (`This mural` / `Every mural`) in place of the scene.

- [ ] **Step 4: Mark dark windows on the schedule rows**

```html
<span v-if="sc.panels === 'off'" class="sched-panels" title="The screens sleep while this window is on air">Panels off</span>
```

- [ ] **Step 5: Verify and commit**

Run the isolated verify stack (alt ports, `STORE=memory`), create a nightly off window, confirm it appears on the row.

```bash
git add packages/console/src/views/Scenes.vue packages/console/src/stores/console.ts
git commit -m "POL-186: schedule a window that turns the panels off"
```

---

### Task 10: Console — the week strip paints the off windows, per mural

**Files:**
- Modify: `packages/console/src/views/Scenes.vue:42-46` (`scheduleSet`), `:98-118` (`week`, `segmentTitle`), `:359-393` (the strip), `:783-842` (styles)
- Test: manual, screenshotted in light and dark for the PR

**Interfaces:**
- Consumes: `resolveWeek(startDate, set, muralId)` and `ScheduleSegment.panels` from Task 3.

- [ ] **Step 1: Resolve for the active mural**

```ts
const scheduleSet = computed<ScheduleSet | null>(() => {
  if (!scheduler.value) return null;
  const sceneMurals: Record<string, string> = {};
  for (const s of store.scenes) sceneMurals[s.id] = s.muralId;
  return {
    dayparts: store.dayparts,
    schedules: store.schedules,
    settings: scheduler.value,
    murals: store.murals.map((m) => m.id),
    sceneMurals,
  };
});

const week = computed(() =>
  scheduleSet.value && store.activeMuralId
    ? resolveWeek(weekStart.value, scheduleSet.value, store.activeMuralId)
    : [],
);
```

- [ ] **Step 2: Paint the dark segments**

```html
<div
  v-for="seg in day.segments"
  :key="`${day.date}-${seg.startMinutes}`"
  class="seg"
  :class="{ empty: seg.source === 'none' && seg.panels !== 'off', dark: seg.panels === 'off', conflict: seg.overriddenScheduleIds.length > 0 }"
  :style="{
    top: `${(seg.startMinutes / 1440) * 100}%`,
    height: `${((seg.endMinutes - seg.startMinutes) / 1440) * 100}%`,
    background: seg.panels === 'off' ? undefined : (seg.sceneId ? sceneColor(seg.sceneId) : undefined),
  }"
  :title="segmentTitle(seg)"
>
  <span v-if="seg.endMinutes - seg.startMinutes >= 75" class="seg-label">
    {{ seg.panels === "off" ? "Off" : seg.source === "none" ? "—" : sceneName(seg.sceneId) }}
  </span>
</div>
```

```css
/* POL-186 — a scheduled OFF window. The strip's promise is that it cannot show the operator
   something the wall will not do, so a dark window has to read as dark. */
.seg.dark {
  background: var(--fg);
  opacity: 0.82;
}
.seg.dark .seg-label {
  color: var(--card);
  text-shadow: none;
}
```

- [ ] **Step 3: Say it in the title and the legend**

`segmentTitle` appends ` · panels off` when `seg.panels === "off"`; add a legend item: `dark = the screens are asleep`.

- [ ] **Step 4: Verify in the browser, both themes**

Isolated verify stack; screenshot the strip light and dark into `docs/pr-screenshots/pol-186/`.

- [ ] **Step 5: Commit**

```bash
git add packages/console/src/views/Scenes.vue docs/pr-screenshots/pol-186
git commit -m "POL-186: the week strip paints the windows the wall runs dark"
```

---

## Self-Review

**Spec coverage.** `panels` on `Schedule` → Task 1. Resolver returning power alongside the scene → Task 2. Week strip painting off windows → Tasks 3 and 10. Ticker driving power through the `panel-power.ts` seam, keeping the asserted-state memory and hello reconcile → Tasks 6 and 7. Activity lines in POL-101's phrasing → Task 7. Two timezones collapsing to one → Task 8. Per-mural resolution and the per-mural active scene → Tasks 2, 4, 5. Power-only and fleet-wide windows → Tasks 1, 2, 9. The default scene scoped to its own mural → Task 2.

**Type consistency.** `PanelState` is the one name for `"on" | "off"` from Task 1 through Task 10. `resolveMuralAt` / `resolveMuralAtLocal` / `resolveDay(date, set, muralId)` / `resolveWeek(startDate, set, muralId)` keep their signatures across Tasks 2, 3, 7 and 10. `applyMuralPower(muralId, panels, daypartName)` is defined in Task 7 and called in Task 6 — Task 6 lands first, so it defines the dep as an optional interface and Task 7 satisfies it. `getPlacementMuralId` and `getActiveSceneId` are added in Tasks 7 and 5 respectively and used in 7 and 6.

**Known risk.** Task 5 is the largest single edit (`state.ts` is 5,437 lines and `activeSceneId` threads through hydrate, apply, delete and broadcast). If it does not land cleanly, split it: per-mural active scene first, then the mural-aware `createSchedule`.
