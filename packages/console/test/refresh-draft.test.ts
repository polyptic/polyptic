/**
 * POL-157 / D149 — the content-source refresh control's draft ↔ policy round trip.
 *
 * The form speaks minutes/hours/days and weekday buttons; the wire speaks seconds and one IANA zone.
 * These pin that the console produces exactly the policy an operator dialled in, and reads a stored
 * one back into the same fields — off, interval, and scheduled.
 */
import { describe, expect, test } from "bun:test";

import type { RefreshPolicy } from "@polyptic/protocol";
import {
  defaultRefreshDraft,
  draftFromPolicy,
  policyFromDraft,
} from "../src/refresh-draft";

describe("policyFromDraft", () => {
  test("off produces an off policy", () => {
    const d = defaultRefreshDraft("Europe/London");
    expect(policyFromDraft(d)).toEqual({ mode: "off" });
  });

  test("interval multiplies the amount by its unit to seconds", () => {
    const d = { ...defaultRefreshDraft("UTC"), mode: "interval" as const, every: 10, unit: "minutes" as const };
    expect(policyFromDraft(d)).toEqual({ mode: "interval", everySeconds: 600 });
    expect(policyFromDraft({ ...d, every: 2, unit: "hours" })).toEqual({ mode: "interval", everySeconds: 7200 });
    expect(policyFromDraft({ ...d, every: 1, unit: "days" })).toEqual({ mode: "interval", everySeconds: 86_400 });
  });

  test("interval rejects a non-positive or fractional amount", () => {
    const d = { ...defaultRefreshDraft("UTC"), mode: "interval" as const, unit: "minutes" as const };
    expect(policyFromDraft({ ...d, every: 0 })).toBeNull();
    expect(policyFromDraft({ ...d, every: -3 })).toBeNull();
    expect(policyFromDraft({ ...d, every: 1.5 })).toBeNull();
  });

  test("scheduled carries the time, sorted days, and the zone", () => {
    const d = {
      ...defaultRefreshDraft("Europe/London"),
      mode: "scheduled" as const,
      time: "04:30",
      days: [5, 1, 3],
    };
    expect(policyFromDraft(d)).toEqual({
      mode: "scheduled",
      atLocal: "04:30",
      days: [1, 3, 5],
      timezone: "Europe/London",
    });
  });

  test("scheduled rejects no days and a bad time", () => {
    const d = { ...defaultRefreshDraft("UTC"), mode: "scheduled" as const };
    expect(policyFromDraft({ ...d, days: [] })).toBeNull();
    expect(policyFromDraft({ ...d, time: "9:99" })).toBeNull();
  });
});

describe("draftFromPolicy — round trip", () => {
  test("off / absent both read back as an off draft", () => {
    expect(draftFromPolicy(undefined, "UTC").mode).toBe("off");
    expect(draftFromPolicy({ mode: "off" }, "UTC").mode).toBe("off");
  });

  test("interval seconds show in the largest clean unit", () => {
    expect(draftFromPolicy({ mode: "interval", everySeconds: 600 }, "UTC")).toMatchObject({
      mode: "interval",
      every: 10,
      unit: "minutes",
    });
    expect(draftFromPolicy({ mode: "interval", everySeconds: 7200 }, "UTC")).toMatchObject({
      every: 2,
      unit: "hours",
    });
    expect(draftFromPolicy({ mode: "interval", everySeconds: 172_800 }, "UTC")).toMatchObject({
      every: 2,
      unit: "days",
    });
  });

  test("a full interval round trip is stable", () => {
    const policy: RefreshPolicy = { mode: "interval", everySeconds: 1800 };
    expect(policyFromDraft(draftFromPolicy(policy, "UTC"))).toEqual(policy);
  });

  test("a full scheduled round trip is stable", () => {
    const policy: RefreshPolicy = {
      mode: "scheduled",
      atLocal: "06:15",
      days: [1, 2, 3, 4, 5],
      timezone: "America/New_York",
    };
    expect(policyFromDraft(draftFromPolicy(policy, "UTC"))).toEqual(policy);
  });
});
