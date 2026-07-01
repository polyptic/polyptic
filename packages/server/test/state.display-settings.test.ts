/**
 * POL-6 — fleet-wide on-screen badge toggle is a persisted runtime setting, not a build-time flag.
 *
 * These drive `ControlPlane` directly against the `MemoryStore` (no server/WS). They pin the
 * server-side contract the console + player rely on: setting the toggle persists it, reading it back
 * returns a defensive copy, and — the load-bearing claim — a persisted operator override is reloaded
 * on `init()` so an explicit choice survives a restart and supersedes the env-derived default.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("ControlPlane display settings (POL-6)", () => {
  test("getDisplaySettings starts at the env-derived default until an override is set", async () => {
    // Under the test runner NODE_ENV is not "production", so the default is badges ON. Either way the
    // fresh store holds no override, so this reflects the DEFAULT_SHOW_BADGES value, not a persisted one.
    expect(cp.getDisplaySettings()).toEqual({ showBadges: process.env.NODE_ENV !== "production" });
  });

  test("setDisplaySettings updates + returns the new value", async () => {
    const off = await cp.setDisplaySettings({ showBadges: false });
    expect(off).toEqual({ showBadges: false });
    expect(cp.getDisplaySettings()).toEqual({ showBadges: false });

    const on = await cp.setDisplaySettings({ showBadges: true });
    expect(on).toEqual({ showBadges: true });
    expect(cp.getDisplaySettings()).toEqual({ showBadges: true });
  });

  test("getDisplaySettings returns a defensive copy — callers can't mutate internal state", async () => {
    await cp.setDisplaySettings({ showBadges: true });
    const snapshot = cp.getDisplaySettings();
    snapshot.showBadges = false;
    expect(cp.getDisplaySettings()).toEqual({ showBadges: true });
  });

  test("a persisted override is reloaded on init and supersedes the default (survives a restart)", async () => {
    // Operator flips badges OFF, then the process restarts: a fresh ControlPlane over the SAME store.
    await cp.setDisplaySettings({ showBadges: false });
    const rebooted = new ControlPlane(store);
    await rebooted.init();
    expect(rebooted.getDisplaySettings()).toEqual({ showBadges: false });

    // And the other direction — an explicit ON also survives, independent of the env default.
    await rebooted.setDisplaySettings({ showBadges: true });
    const rebootedAgain = new ControlPlane(store);
    await rebootedAgain.init();
    expect(rebootedAgain.getDisplaySettings()).toEqual({ showBadges: true });
  });
});
