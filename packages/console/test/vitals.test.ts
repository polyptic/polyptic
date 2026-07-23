/**
 * POL-92 — the stats strip's logic (POL-68 §1's spec, minus the mock's bug).
 *
 * The design fixes the thresholds (< 70 ok · 70–89 warn · >= 90 bad) and the overload banner's copy,
 * and then adds one instruction the mock itself failed: DON'T FLICKER. A box hovering at 89.6/90.1
 * flipped the mock's banner on every sample. Hysteresis — arm at 90, clear at 85 — is the whole fix
 * and it is exactly the kind of thing that quietly regresses, so it is pinned here.
 *
 * The other rule with teeth: an UNKNOWN `gpuAccel` is not a software-rendering verdict. Only an
 * agent that looked and found no /dev/dri fd gets to accuse a box.
 */
import { describe, expect, test } from "bun:test";
import type { MachineVitals } from "@polyptic/protocol";

import {
  clockBadge,
  cpuTooltip,
  diskTooltip,
  factsFor,
  formatBytes,
  formatClockOffset,
  formatPercent,
  formatUptime,
  memoryTooltip,
  meterLevel,
  metersFor,
  nextOverloaded,
  overloadPeak,
  softwareRenderingConnectors,
  totalBrowserRss,
  totalRespawns,
} from "../src/vitals";

describe("meter thresholds", () => {
  test("< 70 ok · 70-89 warn · >= 90 bad", () => {
    expect(meterLevel(0)).toBe("ok");
    expect(meterLevel(69.9)).toBe("ok");
    expect(meterLevel(70)).toBe("warn");
    expect(meterLevel(89.9)).toBe("warn");
    expect(meterLevel(90)).toBe("bad");
    expect(meterLevel(100)).toBe("bad");
  });

  test("an unknown reading draws nothing and claims nothing", () => {
    expect(meterLevel(undefined)).toBe("ok");
    expect(formatPercent(undefined)).toBe("—"); // never "0%"
    expect(formatPercent(34.4)).toBe("34%");
  });
});

describe("the overload banner's hysteresis", () => {
  test("arms at 90 and does NOT clear until below 85 — the mock's flicker, fixed", () => {
    let on = false;
    on = nextOverloaded(on, 89.9);
    expect(on).toBe(false); // not armed yet
    on = nextOverloaded(on, 90);
    expect(on).toBe(true); // armed
    on = nextOverloaded(on, 88);
    expect(on).toBe(true); // still on — this is the sample the mock flickered on
    on = nextOverloaded(on, 85);
    expect(on).toBe(true);
    on = nextOverloaded(on, 84.9);
    expect(on).toBe(false); // finally clear
  });

  test("it watches the WORSE of CPU and memory, and stays silent without a reading", () => {
    expect(overloadPeak({ cpuPercent: 40, memPercent: 95 })).toBe(95);
    expect(overloadPeak({ cpuPercent: 95 })).toBe(95);
    expect(overloadPeak({ diskPercent: 99 })).toBeUndefined(); // disk is not what drops frames
    expect(overloadPeak(undefined)).toBeUndefined();
    expect(nextOverloaded(true, undefined)).toBe(false); // an offline box is not "overloaded"
  });
});

describe("the software-rendering tell (D77)", () => {
  const vitals = (browsers: MachineVitals["browsers"]): MachineVitals => ({ browsers });

  test("only a definite false accuses a box", () => {
    expect(
      softwareRenderingConnectors(
        vitals([
          { connector: "DP-1", running: true, gpuAccel: false },
          { connector: "DP-2", running: true, gpuAccel: true },
          { connector: "DP-3", running: true }, // the agent could not tell — NOT an accusation
        ]),
      ),
    ).toEqual(["DP-1"]);
    expect(softwareRenderingConnectors(undefined)).toEqual([]);
  });

  test("respawns sum across a machine's outputs", () => {
    expect(
      totalRespawns(
        vitals([
          { connector: "DP-1", running: true, respawns: 3 },
          { connector: "DP-2", running: false, respawns: 4 },
        ]),
      ),
    ).toBe(7);
    expect(totalRespawns(vitals([{ connector: "DP-1", running: true }]))).toBe(0);
  });
});

describe("tooltips (the design's detail strings)", () => {
  test("cpu / memory / disk", () => {
    const v: MachineVitals = {
      cores: 4,
      loadavg: [1.2, 0.9, 0.7],
      tempC: 61.2,
      memUsedBytes: 3.3 * 1024 ** 3,
      memTotalBytes: 8 * 1024 ** 3,
      diskUsedBytes: 8 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
    };
    expect(cpuTooltip(v)).toBe("4 cores · load 1.20, 0.90, 0.70 · 61.2°C");
    expect(memoryTooltip(v)).toBe("3.3 GB / 8 GB");
    expect(diskTooltip(v)).toBe("92 GB free of 100 GB");
  });

  // POL-185 — the meter that said "90%" without saying WHAT. A RAM disk filling (POL-184's Chrome
  // profile on tmpfs) and a leaking browser draw the identical bar and want opposite remedies.
  test("the memory tooltip names the tmpfs share when the box reports one", () => {
    expect(
      memoryTooltip({
        memUsedBytes: 3.3 * 1024 ** 3,
        memTotalBytes: 8 * 1024 ** 3,
        shmemBytes: 1.2 * 1024 ** 3,
      }),
    ).toBe("3.3 GB / 8 GB · 1.2 GB tmpfs");
  });

  test("a pre-POL-185 agent reports no Shmem, so the tooltip keeps the old two-number line", () => {
    expect(memoryTooltip({ memUsedBytes: 3.3 * 1024 ** 3, memTotalBytes: 8 * 1024 ** 3 })).toBe(
      "3.3 GB / 8 GB",
    );
  });

  test("formatBytes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(8 * 1024 ** 3)).toBe("8 GB");
    expect(formatBytes(undefined)).toBe("—");
  });

  test("uptime shows the two most significant units", () => {
    expect(formatUptime(6 * 86400 + 4 * 3600 + 59 * 60)).toBe("6d 4h");
    expect(formatUptime(3 * 3600 + 12 * 60 + 30)).toBe("3h 12m");
    expect(formatUptime(45 * 60)).toBe("45m");
    expect(formatUptime(0)).toBe("0m");
    expect(formatUptime(undefined)).toBe("—");
  });

  test("browser RSS sums only the browsers that reported one", () => {
    expect(
      totalBrowserRss({
        browsers: [
          { connector: "DP-1", running: true, rssBytes: 300 * 1024 ** 2 },
          { connector: "DP-2", running: true, rssBytes: 112 * 1024 ** 2 },
          { connector: "DP-3", running: false }, // no reading — not a zero
        ],
      }),
    ).toBe(412 * 1024 ** 2);
    expect(totalBrowserRss({ browsers: [{ connector: "DP-1", running: false }] })).toBeUndefined();
    expect(totalBrowserRss(undefined)).toBeUndefined();
  });

  test("a machine with no readings still produces sane tooltips", () => {
    expect(cpuTooltip(undefined)).toBe("CPU busy across all cores");
    expect(memoryTooltip({})).toBe("Memory in use");
    expect(diskTooltip({})).toBe("Root filesystem in use");
  });
});

// ── POL-137: the redesigned band's view-model ────────────────────────────────
//
// The two-row band (labelled bars over an icon'd facts row) is built as DATA so the D112 rule —
// a vital the box didn't report renders NOTHING — is pinned here, not left to a template.

describe("metersFor — the bar row", () => {
  test("only reported meters get a bar; a partial box reflows, it never draws a dead track", () => {
    const partial: MachineVitals = { cpuPercent: 34, memPercent: 41 }; // no diskPercent
    expect(metersFor(partial).map((m) => m.key)).toEqual(["cpu", "memory"]);
    expect(metersFor({ diskPercent: 22 }).map((m) => m.key)).toEqual(["disk"]);
  });

  test("a pre-POL-92 agent (no vitals) and an empty sample both yield no bars at all", () => {
    expect(metersFor(undefined)).toEqual([]);
    expect(metersFor({})).toEqual([]);
  });

  test("design order is fixed: CPU · MEMORY · DISK, labels verbatim", () => {
    const full: MachineVitals = { cpuPercent: 1, memPercent: 2, diskPercent: 3 };
    expect(metersFor(full).map((m) => m.label)).toEqual(["CPU", "MEMORY", "DISK"]);
  });
});

describe("factsFor — the facts row", () => {
  test("each fact appears only when the heartbeat carried it, in the design's order", () => {
    const full: MachineVitals = {
      uptimeSec: 2 * 86400 + 3600, // "up 2d 1h" — the design's example, verbatim
      loadavg: [1.2, 0.9, 0.7],
      tempC: 61.2,
      browsers: [{ connector: "DP-1", running: true, rssBytes: 412 * 1024 ** 2 }],
    };
    const facts = factsFor(full);
    expect(facts.map((f) => f.key)).toEqual(["up", "load", "temp", "rss"]);
    expect(facts.map((f) => f.icon)).toEqual(["clock", "gauge", "thermometer", "browser"]);
    expect(facts[0]?.text).toBe("up 2d 1h");
    expect(facts[1]?.text).toBe("load 1.20");
    expect(facts[2]?.text).toBe("61°C");
    expect(facts[3]?.text).toBe("browser 412 MB");
  });

  test("an omitted vital contributes nothing — no empty icon slot", () => {
    expect(factsFor({ tempC: 48 }).map((f) => f.key)).toEqual(["temp"]);
    expect(factsFor({})).toEqual([]);
    expect(factsFor(undefined)).toEqual([]);
  });

  test("a browser with no RSS reading is not a zero-byte fact", () => {
    expect(factsFor({ browsers: [{ connector: "DP-1", running: true }] })).toEqual([]);
  });
});

// ── POL-148: the clock-health badge ──────────────────────────────────────────
describe("formatClockOffset", () => {
  test("signed, two most-significant units", () => {
    expect(formatClockOffset(3_720_000)).toBe("+1h02m"); // 1h 2m
    expect(formatClockOffset(-45_000)).toBe("-45s");
    expect(formatClockOffset(125_000)).toBe("+2m05s");
    expect(formatClockOffset(0)).toBe("+0s");
    expect(formatClockOffset(undefined)).toBe("—");
  });
});

describe("clockBadge", () => {
  test("null when the clock is fine or unknown", () => {
    expect(clockBadge(500, true)).toBeNull(); // synced, sub-second skew
    expect(clockBadge(undefined, true)).toBeNull(); // synced, no measurement
    expect(clockBadge(undefined, undefined)).toBeNull(); // nothing known (pre-POL-148 agent)
    expect(clockBadge(12_000, true)).toBeNull(); // synced and under the 30s warn floor
  });

  test("a large skew is BAD and names the offset — the hour-ahead failure", () => {
    const badge = clockBadge(3_720_000, false);
    expect(badge?.level).toBe("bad");
    expect(badge?.text).toBe("clock +1h02m · not synced");
  });

  test("a small skew but not-yet-synced is a WARN, without inventing a number", () => {
    const badge = clockBadge(400, false); // sub-floor skew → no number
    expect(badge?.level).toBe("warn");
    expect(badge?.text).toBe("clock · not synced");
  });

  test("a synced box that is nonetheless drifting large reads BAD · synced", () => {
    const badge = clockBadge(-40_000, true);
    expect(badge?.level).toBe("bad");
    expect(badge?.text).toBe("clock -40s · synced");
  });
});
