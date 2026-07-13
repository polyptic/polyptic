/**
 * POL-34 — the pure half of the playlist rotation (see src/playlist.ts).
 *
 * The load-bearing claims: an untimed VIDEO is the only entry without a hold (it yields on `ended`);
 * a fully-timed rotation's position is DERIVED from the shared anchor, so any two players (wall
 * members, or one box before and after a reboot) agree on the entry without coordinating; and the
 * rotation's identity ignores send-time token stamps but tracks every authored change.
 */
import { describe, expect, test } from "bun:test";

import type { PlaylistEntry } from "@polyptic/protocol";
import {
  FALLBACK_HOLD_SECONDS,
  allTimed,
  entryHoldMs,
  rotationSignature,
  timedPosition,
} from "../src/playlist";

const web = (url: string, durationSeconds?: number): PlaylistEntry => ({
  kind: "web",
  url,
  ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  sourceId: `src-${url}`,
});
const video = (url: string, durationSeconds?: number): PlaylistEntry => ({
  kind: "video",
  url,
  ...(durationSeconds !== undefined ? { durationSeconds } : {}),
  sourceId: `src-${url}`,
});

describe("entryHoldMs", () => {
  test("a timed entry holds for its duration", () => {
    expect(entryHoldMs(web("https://a.test", 30))).toBe(30_000);
    expect(entryHoldMs(video("https://v.test", 12))).toBe(12_000);
  });

  test("an untimed video is the ONLY open-ended entry", () => {
    expect(entryHoldMs(video("https://v.test"))).toBeUndefined();
  });

  test("an untimed static falls back to the default hold (authoring drift, not a valid state)", () => {
    expect(entryHoldMs(web("https://a.test"))).toBe(FALLBACK_HOLD_SECONDS * 1000);
  });
});

describe("allTimed", () => {
  test("true when every entry has an effective hold", () => {
    expect(allTimed([web("https://a.test", 10), video("https://v.test", 20)])).toBe(true);
    expect(allTimed([web("https://a.test")])).toBe(true); // fallback still counts as timed
  });

  test("false as soon as one video plays out", () => {
    expect(allTimed([web("https://a.test", 10), video("https://v.test")])).toBe(false);
  });
});

describe("timedPosition — the clock-derived rotation", () => {
  const items = [web("https://a.test", 10), web("https://b.test", 20), web("https://c.test", 30)]; // 60s cycle

  test("walks the schedule from the anchor", () => {
    expect(timedPosition(items, 0, 0)).toEqual({ index: 0, remainingMs: 10_000 });
    expect(timedPosition(items, 0, 9_999)).toEqual({ index: 0, remainingMs: 1 });
    expect(timedPosition(items, 0, 10_000)).toEqual({ index: 1, remainingMs: 20_000 });
    expect(timedPosition(items, 0, 45_000)).toEqual({ index: 2, remainingMs: 15_000 });
  });

  test("wraps around the cycle — a reboot 90s in rejoins mid-rotation, not at the top", () => {
    expect(timedPosition(items, 0, 60_000)).toEqual({ index: 0, remainingMs: 10_000 });
    // 90s ≡ 30s into the 60s cycle → exactly the start of entry c.
    expect(timedPosition(items, 0, 90_000)).toEqual({ index: 2, remainingMs: 30_000 });
  });

  test("two players with the same anchor agree, whenever they each boot", () => {
    const anchor = 1_700_000_000_000;
    const a = timedPosition(items, anchor, anchor + 123_456);
    const b = timedPosition(items, anchor, anchor + 123_456);
    expect(a).toEqual(b);
  });

  test("a clock BEHIND the anchor still maps into the cycle deterministically", () => {
    const pos = timedPosition(items, 60_000, 55_000); // now 5s before the anchor
    expect(pos.index).toBe(2); // −5s ≡ 55s into the 60s cycle → entry c
    expect(pos.remainingMs).toBe(5_000);
  });

  test("an empty rotation degrades to a harmless zero position", () => {
    expect(timedPosition([], 0, 12_345)).toEqual({ index: 0, remainingMs: 0 });
  });
});

describe("rotationSignature — what restarts the rotation and what must not", () => {
  const startedAt = "2026-07-10T12:00:00.000Z";

  test("a send-time token re-stamp does NOT change the identity", () => {
    const clean = [web("https://grafana.test/d/abc", 30)];
    const stamped = [{ ...clean[0]!, url: "https://grafana.test/d/abc?auth_token=tok-999" }];
    expect(rotationSignature(stamped, startedAt)).toBe(rotationSignature(clean, startedAt));
  });

  test("reordering, retiming, or membership changes DO", () => {
    const base = [web("https://a.test", 10), web("https://b.test", 20)];
    expect(rotationSignature([base[1]!, base[0]!], startedAt)).not.toBe(
      rotationSignature(base, startedAt),
    );
    expect(rotationSignature([web("https://a.test", 15), base[1]!], startedAt)).not.toBe(
      rotationSignature(base, startedAt),
    );
    expect(rotationSignature([base[0]!], startedAt)).not.toBe(rotationSignature(base, startedAt));
  });

  test("a re-assignment's fresh anchor restarts the rotation", () => {
    const items = [web("https://a.test", 10)];
    expect(rotationSignature(items, startedAt)).not.toBe(
      rotationSignature(items, "2026-07-10T13:00:00.000Z"),
    );
  });
});
