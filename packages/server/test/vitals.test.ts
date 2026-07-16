/**
 * POL-92 — the server side of host vitals: Presence's per-machine ring, and what `admin/state`
 * actually carries to the console.
 *
 * The rules worth pinning:
 *   - the ring is BOUNDED (it is a fleet-sized in-memory structure, not a time-series database) and
 *     keeps the NEWEST samples;
 *   - `admin/state` carries vitals for an ONLINE machine and NOTHING for an offline one — a CPU
 *     reading from a box that has gone dark is an epitaph, not health data, and the console must be
 *     able to say "unavailable while offline" without second-guessing a stale number;
 *   - a heartbeat from a PRE-POL-92 agent still counts as a heartbeat (it proves liveness, which is
 *     what `polyptic_machine_last_seen_seconds` is for), it just carries no sample;
 *   - removing a machine forgets its vitals, so a re-enrolling box that reuses the id starts clean.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { MachineVitals } from "@polyptic/protocol";

import { buildAdminState, clockOffsetMs, Presence } from "../src/admin";
import { ActivityLog } from "../src/activity";
import { PlayerHub } from "../src/hub";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: [{ connector: "DP-1", width: 1920, height: 1080 }],
    hostname: "box",
  };
}

function vitals(over: Partial<MachineVitals> = {}): MachineVitals {
  return {
    at: new Date().toISOString(),
    cpuPercent: 34,
    cores: 4,
    memPercent: 41,
    diskPercent: 22,
    browsers: [{ connector: "DP-1", running: true, respawns: 0, gpuAccel: true }],
    ...over,
  };
}

let store: MemoryStore;
let cp: ControlPlane;
let presence: Presence;
let playerHub: PlayerHub;
let activity: ActivityLog;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
  await cp.registerMachine(hello("box-1"), undefined);
  await cp.approveMachine("box-1");
  presence = new Presence();
  playerHub = new PlayerHub();
  activity = new ActivityLog();
});

describe("Presence vitals ring", () => {
  test("keeps the newest sample and bounds the ring", () => {
    for (let i = 0; i < 60; i++) presence.noteHeartbeat("box-1", vitals({ cpuPercent: i }));
    expect(presence.machineVitals("box-1")?.cpuPercent).toBe(59);
    const series = presence.machineVitalsSeries("box-1");
    expect(series.length).toBe(30); // ~5 minutes at a 10s heartbeat
    expect(series[0]?.cpuPercent).toBe(30); // the oldest 30 fell off the back
  });

  test("a heartbeat with NO vitals still records liveness (a pre-POL-92 agent)", () => {
    presence.noteHeartbeat("old-box");
    expect(presence.machineVitals("old-box")).toBeUndefined();
    expect(presence.machineLastHeartbeat("old-box")).toBeGreaterThan(0);
  });

  test("forgetMachine drops everything about a removed box", () => {
    presence.agentConnected("box-1");
    presence.noteHeartbeat("box-1", vitals());
    presence.forgetMachine("box-1");
    expect(presence.machineVitals("box-1")).toBeUndefined();
    expect(presence.machineLastHeartbeat("box-1")).toBeUndefined();
    expect(presence.isMachineOnline("box-1")).toBe(false);
  });
});

// ── POL-148: the server-measured clock offset ────────────────────────────────
describe("clock offset (POL-148)", () => {
  test("clockOffsetMs is box − server, sign-honest, and guards a missing/bad timestamp", () => {
    const now = Date.parse("2026-07-16T12:00:00.000Z");
    // box a whole hour ahead → +3_600_000
    expect(clockOffsetMs("2026-07-16T13:00:00.000Z", now)).toBe(3_600_000);
    // box behind → negative
    expect(clockOffsetMs("2026-07-16T11:59:30.000Z", now)).toBe(-30_000);
    expect(clockOffsetMs(undefined, now)).toBeUndefined();
    expect(clockOffsetMs("not-a-date", now)).toBeUndefined();
  });

  test("Presence measures the skew at receipt and forgets it with the machine", () => {
    // A sample stamped an hour in the future relative to the server's clock.
    const future = new Date(Date.now() + 3_600_000).toISOString();
    presence.noteHeartbeat("box-1", vitals({ at: future }));
    const off = presence.machineClockOffsetMs("box-1");
    expect(off).toBeGreaterThan(3_500_000);
    expect(off).toBeLessThan(3_700_000);
    presence.forgetMachine("box-1");
    expect(presence.machineClockOffsetMs("box-1")).toBeUndefined();
  });

  test("a heartbeat with no vitals (or no `at`) leaves the offset unmeasured", () => {
    presence.noteHeartbeat("box-1"); // no vitals at all
    expect(presence.machineClockOffsetMs("box-1")).toBeUndefined();
    presence.noteHeartbeat("box-1", vitals({ at: undefined }));
    expect(presence.machineClockOffsetMs("box-1")).toBeUndefined();
  });

  test("admin/state carries the offset for an ONLINE box and drops it when offline", () => {
    presence.agentConnected("box-1");
    const future = new Date(Date.now() + 3_600_000).toISOString();
    presence.noteHeartbeat("box-1", vitals({ at: future, clockSynced: false }));

    let machine = buildAdminState(cp, playerHub, presence, activity).machines.find(
      (m) => m.id === "box-1",
    );
    expect(machine?.clockOffsetMs).toBeGreaterThan(3_500_000);
    expect(machine?.vitals?.clockSynced).toBe(false);

    presence.agentDisconnected("box-1");
    machine = buildAdminState(cp, playerHub, presence, activity).machines.find(
      (m) => m.id === "box-1",
    );
    expect(machine?.clockOffsetMs).toBeUndefined(); // a skew from a dark box is not health data
  });
});

describe("admin/state", () => {
  test("carries the latest vitals for an ONLINE machine", () => {
    presence.agentConnected("box-1");
    presence.noteHeartbeat("box-1", vitals({ cpuPercent: 91, memPercent: 93 }));

    const state = buildAdminState(cp, playerHub, presence, activity);
    const machine = state.machines.find((m) => m.id === "box-1");
    expect(machine?.online).toBe(true);
    expect(machine?.vitals?.cpuPercent).toBe(91);
    expect(machine?.vitals?.browsers?.[0]?.gpuAccel).toBe(true);
  });

  test("carries NO vitals for an offline machine, even though we still hold its last sample", () => {
    presence.agentConnected("box-1");
    presence.noteHeartbeat("box-1", vitals());
    presence.agentDisconnected("box-1");

    const state = buildAdminState(cp, playerHub, presence, activity);
    const machine = state.machines.find((m) => m.id === "box-1");
    expect(machine?.online).toBe(false);
    expect(machine?.vitals).toBeUndefined(); // the console says "unavailable while offline"
    expect(presence.machineVitals("box-1")).toBeDefined(); // …but the ring is intact for a reconnect
  });

  test("an online machine that has never sampled carries no vitals (and does not crash the parse)", () => {
    presence.agentConnected("box-1");
    presence.noteHeartbeat("box-1"); // an older agent's heartbeat
    const state = buildAdminState(cp, playerHub, presence, activity);
    expect(state.machines.find((m) => m.id === "box-1")?.vitals).toBeUndefined();
  });

  test("a software-rendering browser survives the round trip to the console (the D77 tell)", () => {
    presence.agentConnected("box-1");
    presence.noteHeartbeat(
      "box-1",
      vitals({ browsers: [{ connector: "DP-1", running: true, respawns: 3, gpuAccel: false }] }),
    );
    const machine = buildAdminState(cp, playerHub, presence, activity).machines.find(
      (m) => m.id === "box-1",
    );
    expect(machine?.vitals?.browsers?.[0]?.gpuAccel).toBe(false);
    expect(machine?.vitals?.browsers?.[0]?.respawns).toBe(3);
  });
});
