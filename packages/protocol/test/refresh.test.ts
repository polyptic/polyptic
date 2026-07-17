/**
 * POL-157 / D149 — the refresh-cadence contract AND the shared `isRefreshDue` resolver.
 *
 * This is the keystone: the player fires reloads from `isRefreshDue`, and any console preview reads
 * the same function, so the schema (valid/invalid, kind guards) and the resolver (interval spacing,
 * scheduled point-fires, DST spring-forward + fall-back, weekday/timezone filters) are proven here.
 */
import { describe, expect, test } from "bun:test";

import {
  ContentSource,
  CreateContentSourceBody,
  DashboardSurface,
  RefreshPolicy,
  WebSurface,
  isRefreshDue,
} from "../src/index";

const region = { x: 0, y: 0, w: 1920, h: 1080 };

/** Ms of a wall-clock local time in an IANA zone — a test helper only (production never converts a
 *  local time to an absolute instant; it compares tuples). Built by probing candidate UTC instants. */
function atZone(zone: string, y: number, mo: number, d: number, h: number, mi: number): number {
  // Search a ±26h window of minute-granular UTC instants for the one that reads back as the wanted
  // wall clock in `zone`. Good enough for tests; picks the FIRST match (the earlier of a fall-back
  // repeat), which is what we want for the DST cases.
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const want = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")} ${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
  const reads = (ms: number): string => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}`;
  };
  for (let off = -26 * 60; off <= 26 * 60; off += 1) {
    const ms = guess + off * 60_000;
    if (reads(ms) === want) return ms;
  }
  throw new Error(`no UTC instant reads as ${want} in ${zone} (probably a spring-forward gap)`);
}

describe("RefreshPolicy schema", () => {
  test("off / interval / scheduled all parse", () => {
    expect(RefreshPolicy.parse({ mode: "off" })).toEqual({ mode: "off" });
    expect(RefreshPolicy.parse({ mode: "interval", everySeconds: 300 }).mode).toBe("interval");
    const s = RefreshPolicy.parse({
      mode: "scheduled",
      atLocal: "04:00",
      days: [1, 2, 3, 4, 5],
      timezone: "Europe/London",
    });
    expect(s.mode).toBe("scheduled");
  });

  test("interval must be a positive integer number of seconds", () => {
    expect(RefreshPolicy.safeParse({ mode: "interval", everySeconds: 0 }).success).toBe(false);
    expect(RefreshPolicy.safeParse({ mode: "interval", everySeconds: -5 }).success).toBe(false);
    expect(RefreshPolicy.safeParse({ mode: "interval", everySeconds: 1.5 }).success).toBe(false);
  });

  test("scheduled rejects a bad time, no days, and a bogus timezone", () => {
    const base = { mode: "scheduled", atLocal: "04:00", days: [1], timezone: "UTC" };
    expect(RefreshPolicy.safeParse({ ...base, atLocal: "25:00" }).success).toBe(false);
    expect(RefreshPolicy.safeParse({ ...base, atLocal: "4:00" }).success).toBe(false);
    expect(RefreshPolicy.safeParse({ ...base, days: [] }).success).toBe(false);
    expect(RefreshPolicy.safeParse({ ...base, days: [7] }).success).toBe(false);
    expect(RefreshPolicy.safeParse({ ...base, timezone: "Mars/Olympus" }).success).toBe(false);
  });
});

describe("kind guards — a cadence only rides frameable content", () => {
  const url = "https://dash.test/panel";
  const cadence = { mode: "interval" as const, everySeconds: 600 };

  test("web + dashboard accept a real cadence", () => {
    expect(ContentSource.safeParse({ id: "s1", name: "d", kind: "web", url, refresh: cadence }).success).toBe(true);
    expect(ContentSource.safeParse({ id: "s2", name: "d", kind: "dashboard", url, refresh: cadence }).success).toBe(true);
  });

  test("image/video reject a real cadence but tolerate off", () => {
    expect(ContentSource.safeParse({ id: "s3", name: "i", kind: "image", url, refresh: cadence }).success).toBe(false);
    expect(ContentSource.safeParse({ id: "s4", name: "i", kind: "image", url, refresh: { mode: "off" } }).success).toBe(true);
  });

  test("the create body enforces the same guard", () => {
    expect(CreateContentSourceBody.safeParse({ name: "v", kind: "video", url, refresh: cadence }).success).toBe(false);
    expect(CreateContentSourceBody.safeParse({ name: "w", kind: "web", url, refresh: cadence }).success).toBe(true);
  });
});

describe("surfaces carry the policy on the wire", () => {
  test("WebSurface + DashboardSurface accept refresh; absent = never reload", () => {
    const web = WebSurface.parse({
      id: "content-web",
      region,
      type: "web",
      url: "https://a.test",
      refresh: { mode: "interval", everySeconds: 120 },
    });
    expect(web.refresh).toEqual({ mode: "interval", everySeconds: 120 });
    const dash = DashboardSurface.parse({ id: "content-web", region, type: "dashboard", url: "https://a.test" });
    expect(dash.refresh).toBeUndefined();
  });
});

describe("isRefreshDue — off", () => {
  test("never fires", () => {
    expect(isRefreshDue({ mode: "off" }, 0, 10 ** 12)).toBe(false);
  });
});

describe("isRefreshDue — interval", () => {
  const policy: RefreshPolicy = { mode: "interval", everySeconds: 300 };
  const t0 = Date.UTC(2026, 6, 17, 12, 0, 0);

  test("not due before the interval elapses", () => {
    expect(isRefreshDue(policy, t0, t0 + 299_000)).toBe(false);
  });
  test("due exactly at the interval, and after", () => {
    expect(isRefreshDue(policy, t0, t0 + 300_000)).toBe(true);
    expect(isRefreshDue(policy, t0, t0 + 10 * 300_000)).toBe(true);
  });
  test("spacing resets from the last reload, not from mount", () => {
    // reloaded at t0+300s; the next one is due 300s AFTER that, not immediately.
    const last = t0 + 300_000;
    expect(isRefreshDue(policy, last, last + 299_000)).toBe(false);
    expect(isRefreshDue(policy, last, last + 300_000)).toBe(true);
  });
});

describe("isRefreshDue — scheduled, plain UTC", () => {
  const zone = "UTC";
  const policy: RefreshPolicy = { mode: "scheduled", atLocal: "04:00", days: [0, 1, 2, 3, 4, 5, 6], timezone: zone };

  test("fires once when the clock crosses 04:00, not before, not twice", () => {
    const last = atZone(zone, 2026, 7, 17, 3, 0); // mounted at 03:00
    expect(isRefreshDue(policy, last, atZone(zone, 2026, 7, 17, 3, 59))).toBe(false); // before fire
    expect(isRefreshDue(policy, last, atZone(zone, 2026, 7, 17, 4, 0))).toBe(true); // AT fire
    // Once reloaded AT 04:00, the same day no longer fires.
    const reloaded = atZone(zone, 2026, 7, 17, 4, 0);
    expect(isRefreshDue(policy, reloaded, atZone(zone, 2026, 7, 17, 12, 0))).toBe(false);
    // Next day it fires again.
    expect(isRefreshDue(policy, reloaded, atZone(zone, 2026, 7, 18, 4, 0))).toBe(true);
  });

  test("a mount AFTER today's fire waits for tomorrow", () => {
    const mounted = atZone(zone, 2026, 7, 17, 10, 0); // after 04:00
    expect(isRefreshDue(policy, mounted, atZone(zone, 2026, 7, 17, 23, 59))).toBe(false);
    expect(isRefreshDue(policy, mounted, atZone(zone, 2026, 7, 18, 4, 0))).toBe(true);
  });
});

describe("isRefreshDue — scheduled, weekday filter", () => {
  // 2026-07-17 is a Friday. Fire 04:00 on weekdays only (Mon–Fri).
  const zone = "UTC";
  const weekdays: RefreshPolicy = { mode: "scheduled", atLocal: "04:00", days: [1, 2, 3, 4, 5], timezone: zone };

  test("does not fire on Saturday/Sunday", () => {
    const fridayReload = atZone(zone, 2026, 7, 17, 4, 0); // Fri fire consumed
    // Saturday 04:00 and Sunday 04:00 — not armed, so the latest armed fire is still Friday's.
    expect(isRefreshDue(weekdays, fridayReload, atZone(zone, 2026, 7, 18, 4, 0))).toBe(false); // Sat
    expect(isRefreshDue(weekdays, fridayReload, atZone(zone, 2026, 7, 19, 12, 0))).toBe(false); // Sun
    // Monday 04:00 fires again.
    expect(isRefreshDue(weekdays, fridayReload, atZone(zone, 2026, 7, 20, 4, 0))).toBe(true); // Mon
  });
});

describe("isRefreshDue — scheduled, timezone containment", () => {
  // The SAME absolute instants read differently by zone. Fire midnight daily.
  const midnight: RefreshPolicy = { mode: "scheduled", atLocal: "00:00", days: [0, 1, 2, 3, 4, 5, 6], timezone: "" };

  test("00:00 fires per the source's zone, not UTC", () => {
    const tokyo = { ...midnight, timezone: "Asia/Tokyo" } as RefreshPolicy;
    const london = { ...midnight, timezone: "Europe/London" } as RefreshPolicy;
    // Mount just after Tokyo midnight; probe an instant that is still the previous day in London but
    // already past a fresh Tokyo midnight the following calendar day.
    const tokyoMount = atZone("Asia/Tokyo", 2026, 7, 17, 0, 30);
    const tokyoNextMidnight = atZone("Asia/Tokyo", 2026, 7, 18, 0, 0);
    expect(isRefreshDue(tokyo, tokyoMount, tokyoNextMidnight)).toBe(true);
    // The identical instants under London's clock have NOT crossed a London midnight since the mount.
    const lonMount = atZone("Europe/London", 2026, 7, 17, 12, 0);
    expect(isRefreshDue(london, lonMount, lonMount + 60_000)).toBe(false);
  });
});

describe("isRefreshDue — scheduled, DST", () => {
  // Europe/London springs forward 2026-03-29 (01:00 → 02:00) and falls back 2026-10-25 (02:00→01:00).
  const zone = "Europe/London";

  test("fall back: 01:30 happens twice but the reload fires only once", () => {
    const policy: RefreshPolicy = { mode: "scheduled", atLocal: "01:30", days: [0, 1, 2, 3, 4, 5, 6], timezone: zone };
    const mounted = atZone(zone, 2026, 10, 25, 1, 0); // before the first 01:30 (BST)
    const firstFire = atZone(zone, 2026, 10, 25, 1, 30); // the FIRST 01:30 (atZone picks the earlier)
    expect(isRefreshDue(policy, mounted, firstFire)).toBe(true);
    // The clock repeats the 01:00–02:00 hour (now GMT). An instant an hour after the first 01:30 still
    // reads local 01:30 — it must NOT re-fire, because we already reloaded at 01:30.
    const secondPass = firstFire + 60 * 60_000;
    expect(isRefreshDue(policy, firstFire, secondPass)).toBe(false);
  });

  test("spring forward: 02:30 never occurs — the reload still fires once, right after the gap", () => {
    const policy: RefreshPolicy = { mode: "scheduled", atLocal: "02:30", days: [0, 1, 2, 3, 4, 5, 6], timezone: zone };
    const mounted = atZone(zone, 2026, 3, 29, 0, 30); // before the gap
    // 02:30 local does not exist on this date; the local clock jumps 00:59 GMT → 02:00 BST. The first
    // instant whose local minute-of-day is >= 02:30 is 02:30 BST (= 01:30 UTC). It fires there, once.
    const afterGap = atZone(zone, 2026, 3, 29, 2, 30); // this reads back fine (post-jump BST)
    expect(isRefreshDue(policy, mounted, afterGap)).toBe(true);
    // And it does not double-fire later the same day.
    expect(isRefreshDue(policy, afterGap, atZone(zone, 2026, 3, 29, 12, 0))).toBe(false);
  });
});
