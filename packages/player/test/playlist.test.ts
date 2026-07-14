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
  displayIndexFor,
  entryHoldMs,
  entryProbeId,
  entryProbeIndex,
  prewarmIndex,
  rotationSignature,
  slotHoldMs,
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

// ─────────────────────────────────────────────────────────────────────────────
// POL-110 — per-entry health: skip a dead entry, rejoin a healed one, KEEP THE PHASE
// ─────────────────────────────────────────────────────────────────────────────

const image = (url: string, durationSeconds: number): PlaylistEntry => ({
  kind: "image",
  url,
  durationSeconds,
  sourceId: `src-${url}`,
});

/** A box's local view of which entries have proven reachable. */
const health = (...alive: number[]): ((i: number) => boolean) => (i) => alive.includes(i);

describe("entryProbeId — one prober target per entry", () => {
  test("round-trips the entry index", () => {
    const id = entryProbeId("surface-7", 3);
    expect(entryProbeIndex("surface-7", id)).toBe(3);
  });

  test("ignores an id belonging to another surface", () => {
    expect(entryProbeIndex("surface-7", entryProbeId("surface-8", 3))).toBeUndefined();
    expect(entryProbeIndex("surface-7", "surface-7")).toBeUndefined();
  });
});

describe("displayIndexFor — a dead entry is SKIPPED, never painted", () => {
  const items = [
    image("https://a.test/1.png", 10),
    image("https://dead.test/2.png", 10),
    image("https://c.test/3.png", 10),
  ];

  test("a healthy slot shows itself", () => {
    expect(displayIndexFor(items, 0, health(0, 1, 2))).toBe(0);
  });

  test("a dead slot is filled by the next healthy entry — the one that takes over anyway", () => {
    expect(displayIndexFor(items, 1, health(0, 2))).toBe(2);
  });

  test("the search wraps: a dead LAST entry falls back to the top of the rotation", () => {
    expect(displayIndexFor(items, 2, health(0, 1))).toBe(0);
  });

  test("a healed entry REJOINS: the same slot shows itself again once it proves", () => {
    expect(displayIndexFor(items, 1, health(0, 2))).toBe(2);
    expect(displayIndexFor(items, 1, health(0, 1, 2))).toBe(1);
  });

  test("nothing provable → nothing painted (the calm placeholder, not a broken frame)", () => {
    expect(displayIndexFor(items, 0, health())).toBeUndefined();
    expect(displayIndexFor([], 0, health(0))).toBeUndefined();
  });

  test("a ten-item playlist with one dead URL shows the other NINE, in order", () => {
    const ten = Array.from({ length: 10 }, (_, i) => image(`https://e${i}.test/x.png`, 10));
    const alive = [0, 1, 2, 3, 5, 6, 7, 8, 9]; // entry 4 is dead
    const shown = ten.map((_, slot) => displayIndexFor(ten, slot, health(...alive)));
    expect(shown).toEqual([0, 1, 2, 3, 5, 5, 6, 7, 8, 9]); // slot 4 is absorbed by entry 5's dwell
    expect(new Set(shown)).toEqual(new Set(alive)); // every healthy entry still gets the screen
    expect(shown).not.toContain(4); // and the dead one NEVER paints
  });
});

describe("phase preservation — a skipped entry must not desync a video wall", () => {
  const items = [
    image("https://a.test/1.png", 10),
    image("https://dead.test/2.png", 20),
    image("https://c.test/3.png", 30),
  ];
  const anchor = Date.parse("2026-07-10T12:00:00.000Z");
  const cycleMs = 60_000;

  test("the canonical timeline is derived from EVERY entry, healthy or not", () => {
    // Health is not an input to timedPosition — that is the whole point. Two wall members that
    // disagree about entry 1 still compute identical slot boundaries.
    for (let t = 0; t < cycleMs * 2; t += 1_000) {
      const pos = timedPosition(items, anchor, anchor + t);
      const expected = t % cycleMs < 10_000 ? 0 : t % cycleMs < 30_000 ? 1 : 2;
      expect(pos.index).toBe(expected);
    }
  });

  test("two members disagreeing about one entry's health share every boundary, and re-converge", () => {
    const boxA = health(0, 1, 2); // proved all three
    const boxB = health(0, 2); // entry 1 not (yet) reachable from this box
    const boundariesA: number[] = [];
    const boundariesB: number[] = [];
    const shownA: (number | undefined)[] = [];
    const shownB: (number | undefined)[] = [];
    for (let t = 0; t < cycleMs; t += 1_000) {
      const pos = timedPosition(items, anchor, anchor + t);
      boundariesA.push(t + pos.remainingMs);
      boundariesB.push(t + pos.remainingMs);
      shownA.push(displayIndexFor(items, pos.index, boxA));
      shownB.push(displayIndexFor(items, pos.index, boxB));
    }
    // Same slot turnovers, to the millisecond.
    expect(boundariesA).toEqual(boundariesB);
    // They differ ONLY while the dead entry's slot is on air (10s–30s), and agree everywhere else.
    for (let i = 0; i < shownA.length; i += 1) {
      const inDeadSlot = i >= 10 && i < 30;
      if (inDeadSlot) expect(shownB[i]).toBe(2);
      else expect(shownB[i]).toBe(shownA[i]);
    }
    // ...and from the very next slot they are identical again: no accumulating drift.
    expect(shownB.slice(30)).toEqual(shownA.slice(30));
  });

  test("the counterfactual: SPLICING the dead entry out would desync the wall forever", () => {
    // If a box removed what it can't reach, its cycle would be 40s while its neighbour's is 60s —
    // the two would drift apart without bound. This test pins WHY the timeline stays canonical.
    const spliced = [items[0]!, items[2]!];
    const late = anchor + 5 * cycleMs;
    expect(timedPosition(items, anchor, late + 35_000).index).toBe(2);
    expect(timedPosition(spliced, anchor, late + 35_000).index).not.toBe(
      timedPosition(items, anchor, late + 35_000).index,
    );
  });
});

describe("slotHoldMs — a dead slot never stretches (or stalls) the rotation", () => {
  test("the canonical entry's own hold wins, even when it is the dead one", () => {
    const items = [image("https://a.test/1.png", 10), image("https://dead.test/2.png", 25)];
    expect(slotHoldMs(items, 1, 0)).toBe(25_000); // showing entry 0, still yielding on 1's clock
  });

  test("a PLAYING untimed video yields on `ended` (no hold)", () => {
    const items = [video("https://v.test/a.mp4"), image("https://b.test/1.png", 10)];
    expect(slotHoldMs(items, 0, 0)).toBeUndefined();
  });

  test("a DEAD untimed video has no `ended` to wait for — it borrows its stand-in's hold", () => {
    const items = [video("https://dead.test/a.mp4"), image("https://b.test/1.png", 10)];
    expect(slotHoldMs(items, 0, 1)).toBe(10_000);
  });

  test("a dead untimed video with nothing healthy still ticks (the fallback hold)", () => {
    const items = [video("https://dead.test/a.mp4"), image("https://b.test/1.png", 10)];
    expect(slotHoldMs(items, 0, undefined)).toBe(FALLBACK_HOLD_SECONDS * 1000);
  });
});

describe("prewarmIndex — bounded to ONE video, one slot ahead, and disable-able", () => {
  const items = [
    image("https://a.test/1.png", 30),
    video("https://v.test/b.mp4", 30),
    image("https://c.test/2.png", 30),
  ];
  const opts = { enabled: true, remainingMs: 3_000, leadMs: 6_000 };

  test("the next slot's video warms once we are inside the lead window", () => {
    expect(prewarmIndex(items, 0, 0, health(0, 1, 2), opts)).toBe(1);
  });

  test("outside the lead window nothing warms — a rotation is never more than one video ahead", () => {
    expect(prewarmIndex(items, 0, 0, health(0, 1, 2), { ...opts, remainingMs: 20_000 })).toBeUndefined();
  });

  test("disabled means disabled (D84's kiosk-GPU escape hatch)", () => {
    expect(prewarmIndex(items, 0, 0, health(0, 1, 2), { ...opts, enabled: false })).toBeUndefined();
  });

  test("only videos warm — frames and images have their own (existing) pre-warm", () => {
    expect(prewarmIndex(items, 1, 1, health(0, 1, 2), opts)).toBeUndefined(); // next is an image
  });

  test("an UNPROVEN next video is not warmed (probe first, fetch second)", () => {
    expect(prewarmIndex(items, 0, 0, health(0, 2), opts)).toBeUndefined();
  });

  test("the entry already on the glass is never 'warmed' twice", () => {
    const two = [video("https://v.test/b.mp4", 30), image("https://dead.test/2.png", 30)];
    // Slot 1 is dead, so the next slot would show entry 0 — which IS the live one. Nothing to warm.
    expect(prewarmIndex(two, 0, 0, health(0), opts)).toBeUndefined();
  });

  test("a single-entry playlist never warms anything", () => {
    expect(prewarmIndex([items[1]!], 0, 0, health(0), opts)).toBeUndefined();
  });
});
