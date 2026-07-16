/**
 * POL-92 — the `agent/status` contract, and the back-compat promise that hangs off it.
 *
 * A fleet is upgraded one box at a time (and a netbooted box only takes a new agent when it next
 * reboots), so the wire has to carry BOTH shapes at once: a status frame from an agent that knows
 * nothing about vitals must keep parsing, forever. That is a property of the schema, not of anyone's
 * good intentions, so it gets a test.
 *
 * The reverse also matters: every vitals field is optional, so a partial sample (a VM with no thermal
 * zone, a box whose first heartbeat has no CPU delta yet) is valid — but a NONSENSE one (114% CPU, a
 * two-element loadavg) is not, because a bad number that reaches the console draws a bad meter.
 */
import { describe, expect, test } from "bun:test";

import { AgentMessage, AgentStatus, MachineVitals, parseMessage } from "../src/index";

describe("agent/status vitals (POL-92)", () => {
  test("a PRE-POL-92 status frame (no vitals) still parses", () => {
    const legacy = {
      t: "agent/status",
      machineId: "box-1",
      observedRevision: 12,
      screens: [{ connector: "DP-1", ok: true }],
    };
    const parsed = AgentStatus.parse(legacy);
    expect(parsed.vitals).toBeUndefined();
    // …and through the discriminated union the server actually parses with:
    const viaUnion = parseMessage(AgentMessage, JSON.stringify(legacy));
    expect(viaUnion.t).toBe("agent/status");
  });

  test("a full sample round-trips", () => {
    const frame = {
      t: "agent/status" as const,
      machineId: "box-1",
      observedRevision: 12,
      screens: [{ connector: "DP-1", ok: true }],
      vitals: {
        at: "2026-07-14T10:15:00.000Z",
        cpuPercent: 34.2,
        cores: 4,
        loadavg: [1.2, 0.9, 0.7],
        memUsedBytes: 3_300_000_000,
        memTotalBytes: 8_000_000_000,
        memPercent: 41,
        diskUsedBytes: 8_000_000_000,
        diskTotalBytes: 100_000_000_000,
        diskPercent: 8,
        tempC: 61.2,
        uptimeSec: 86_400,
        imageId: "20260714T101500Z-abcd",
        clockSynced: true,
        browsers: [
          { connector: "DP-1", running: true, pid: 4242, rssBytes: 512_000_000, respawns: 0, gpuAccel: true },
        ],
      },
    };
    const parsed = AgentStatus.parse(frame);
    expect(parsed.vitals?.cpuPercent).toBe(34.2);
    expect(parsed.vitals?.clockSynced).toBe(true);
    expect(parsed.vitals?.browsers?.[0]?.gpuAccel).toBe(true);
  });

  test("clockSynced (POL-148) round-trips and stays optional", () => {
    expect(MachineVitals.parse({ clockSynced: false }).clockSynced).toBe(false);
    expect(MachineVitals.parse({}).clockSynced).toBeUndefined();
    expect(() => MachineVitals.parse({ clockSynced: "yes" })).toThrow();
  });

  test("a PARTIAL sample is valid — every field is optional", () => {
    // A first heartbeat: no CPU delta yet, a VM with no thermal zone, an agent with no browsers.
    const partial = MachineVitals.parse({ at: "2026-07-14T10:15:00.000Z", memPercent: 41 });
    expect(partial.cpuPercent).toBeUndefined();
    expect(partial.tempC).toBeUndefined();
    expect(MachineVitals.parse({})).toEqual({});
  });

  test("nonsense readings are REJECTED at the edge, not drawn as meters", () => {
    expect(() => MachineVitals.parse({ cpuPercent: 114 })).toThrow();
    expect(() => MachineVitals.parse({ memPercent: -3 })).toThrow();
    expect(() => MachineVitals.parse({ loadavg: [1, 2] })).toThrow(); // must be 1/5/15
    expect(() => MachineVitals.parse({ memUsedBytes: -1 })).toThrow();
  });
});
