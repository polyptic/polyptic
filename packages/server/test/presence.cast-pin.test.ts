/**
 * POL-136 — Presence holds the in-flight AirPlay pairing PIN per screen: edge detection (the caller
 * pushes the player overlay only on real changes, not every heartbeat), replay for a player that
 * (re)connects mid-pairing, and cleanup when the box drops (its receiver — and the pairing — died
 * with it).
 */
import { describe, expect, test } from "bun:test";

import { Presence } from "../src/admin";

describe("Presence.setScreenCastPin — level-set from agent/status, edges out (POL-136)", () => {
  test("reports a change only on real edges, not on every identical heartbeat", () => {
    const p = new Presence();
    expect(p.setScreenCastPin("s1", "0417")).toBe(true); // pairing began
    expect(p.setScreenCastPin("s1", "0417")).toBe(false); // heartbeat repeats the level
    expect(p.setScreenCastPin("s1", "9004")).toBe(true); // a retry minted a new PIN
    expect(p.setScreenCastPin("s1", null)).toBe(true); // pairing ended
    expect(p.setScreenCastPin("s1", null)).toBe(false); // and stays ended
  });

  test("holds the PIN for replay to a player that connects mid-pairing", () => {
    const p = new Presence();
    expect(p.screenCastPin("s1")).toBeNull();
    p.setScreenCastPin("s1", "0417");
    expect(p.screenCastPin("s1")).toBe("0417");
  });

  test("a dropped machine clears its screens' PINs along with the rest of their live state", () => {
    const p = new Presence();
    p.setScreenCastPin("s1", "0417");
    p.setScreenCastPin("s2", "1234");
    p.clearScreensInspecting(["s1"]);
    expect(p.screenCastPin("s1")).toBeNull();
    expect(p.screenCastPin("s2")).toBe("1234"); // another box's pairing is untouched
  });
});

describe("Presence cast-PIN TTL — a lost clear can never replay a stale code (PR #118 finding 3)", () => {
  const T0 = 1_000_000;
  const TTL = 120_000; // mirrors Presence.CAST_PIN_TTL_MS and the agent's own backstop

  test("a PIN nobody refreshed for the TTL reads as null (and is dropped)", () => {
    const p = new Presence();
    p.setScreenCastPin("s1", "0417", T0);
    expect(p.screenCastPin("s1", T0 + TTL)).toBe("0417"); // at the boundary: still live
    expect(p.screenCastPin("s1", T0 + TTL + 1)).toBeNull(); // past it: gone
    expect(p.screenCastPin("s1", T0 + TTL)).toBeNull(); // and dropped, not just hidden
  });

  test("heartbeats repeating the level refresh the TTL — a live pairing never expires", () => {
    const p = new Presence();
    p.setScreenCastPin("s1", "0417", T0);
    // Three 10s heartbeats later the level is re-set each time (no edge, but the clock moves).
    p.setScreenCastPin("s1", "0417", T0 + 110_000);
    expect(p.screenCastPin("s1", T0 + 110_000 + TTL)).toBe("0417");
  });

  test("setting over an expired PIN reads as a fresh edge, not a no-op", () => {
    const p = new Presence();
    p.setScreenCastPin("s1", "0417", T0);
    // Same pin re-reported long after expiry: the stored value equals it, but the expired entry
    // must read as null so this counts as a CHANGE and the overlay is re-pushed.
    expect(p.setScreenCastPin("s1", "0417", T0 + TTL + 60_000)).toBe(true);
  });
});
