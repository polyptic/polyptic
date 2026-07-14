/**
 * POL-119 — the cast receiver's launch mechanics: argv pinning (the pitch's no-gos are FLAGS here,
 * so they get pinned), the deterministic per-connector device id, and the registration-file path.
 */
import { describe, expect, test } from "bun:test";

import {
  CAST_PORT_BASE,
  CAST_PORT_STRIDE,
  buildUxplayArgs,
  castDeviceMac,
  castRegFileFor,
  matchesUxplayWindow,
  sameCastTarget,
} from "../src/backends/cast";

const ARGS = buildUxplayArgs({
  name: "Boardroom Left",
  basePort: CAST_PORT_BASE,
  regFile: "/home/kiosk/.local/state/polyptic/uxplay-reg-DP-1",
  mac: "02:aa:bb:cc:dd:ee",
});

function valueOf(flag: string): string | undefined {
  const i = ARGS.indexOf(flag);
  return i >= 0 ? ARGS[i + 1] : undefined;
}

describe("buildUxplayArgs — the pitch's no-gos are argv, so they are pinned (POL-119)", () => {
  test("advertises the friendly name verbatim, without the hostname suffix", () => {
    expect(valueOf("-n")).toBe("Boardroom Left");
    expect(ARGS).toContain("-nh");
  });

  test("PIN mode is ALWAYS on — there is no PIN-less code path", () => {
    expect(ARGS).toContain("-pin");
  });

  test("PIN registrations persist to the connector's reg file", () => {
    expect(valueOf("-reg")).toBe("/home/kiosk/.local/state/polyptic/uxplay-reg-DP-1");
  });

  test("video only: the audio sink is disabled (walls are silent by design)", () => {
    expect(valueOf("-as")).toBe("0");
  });

  test("renders via waylandsink natively — never an Xwayland sink (POL-67)", () => {
    expect(valueOf("-vs")).toBe("waylandsink");
    expect(ARGS).toContain("-fs");
  });

  test("takes a fixed base port so multiple instances on one box never collide", () => {
    expect(valueOf("-p")).toBe(String(CAST_PORT_BASE));
    // UxPlay claims base..base+2; the stride must leave room for that plus headroom.
    expect(CAST_PORT_STRIDE).toBeGreaterThan(2);
  });

  test("pins the per-instance device id", () => {
    expect(valueOf("-m")).toBe("02:aa:bb:cc:dd:ee");
  });
});

describe("castDeviceMac — stable per-connector receiver identity", () => {
  test("deterministic: same seed, same MAC (a respawn keeps its registrations)", () => {
    expect(castDeviceMac("box:DP-1")).toBe(castDeviceMac("box:DP-1"));
  });

  test("distinct per connector: two receivers on one box never collide", () => {
    expect(castDeviceMac("box:DP-1")).not.toBe(castDeviceMac("box:DP-2"));
  });

  test("locally administered unicast (02:…), valid MAC shape", () => {
    const mac = castDeviceMac("anything");
    expect(mac).toMatch(/^02(:[0-9a-f]{2}){5}$/);
  });
});

describe("castRegFileFor — the registration file path", () => {
  test("lives under XDG_STATE_HOME when set, with the connector sanitized", () => {
    const p = castRegFileFor("DP 1/weird", { XDG_STATE_HOME: "/var/state", HOME: "/home/k" });
    expect(p).toBe("/var/state/polyptic/uxplay-reg-DP_1_weird");
  });

  test("falls back to ~/.local/state", () => {
    const p = castRegFileFor("DP-1", { HOME: "/home/kiosk" });
    expect(p).toBe("/home/kiosk/.local/state/polyptic/uxplay-reg-DP-1");
  });
});

describe("window matching + target identity", () => {
  test("matchesUxplayWindow accepts UxPlay app ids and rejects the browsers'", () => {
    expect(matchesUxplayWindow("uxplay")).toBe(true);
    expect(matchesUxplayWindow("UxPlay")).toBe(true);
    expect(matchesUxplayWindow("google-chrome")).toBe(false);
    expect(matchesUxplayWindow("surf")).toBe(false);
    expect(matchesUxplayWindow("")).toBe(false);
  });

  test("sameCastTarget: only a name change forces a relaunch", () => {
    expect(sameCastTarget({ name: "A" }, { name: "A" })).toBe(true);
    expect(sameCastTarget({ name: "A" }, { name: "B" })).toBe(false);
    expect(sameCastTarget(null, { name: "A" })).toBe(false);
    expect(sameCastTarget(null, null)).toBe(true);
  });
});
