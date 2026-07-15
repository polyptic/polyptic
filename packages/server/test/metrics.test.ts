/**
 * POL-92 — the `/metrics` exposition. Rendered without an HTTP round trip (`renderMetrics` takes the
 * same deps the route does), because what matters is the SHAPE:
 *
 *   - `polyptic_machine_up{machine=…}` exists for every APPROVED machine, 1 online / 0 offline. It
 *     must NOT vanish when a box goes dark: a series that disappears cannot fire an alert.
 *   - vitals gauges are emitted ONLY for online machines (stale numbers are not health data).
 *   - an ABSENT reading emits NO SAMPLE, never a zero — `gpuAccel: undefined` (an agent that could
 *     not tell) must not read as "software rendering" and page someone at 03:00.
 *   - respawns are a COUNTER (`_total`), so `increase()` works.
 *   - label values are escaped, so a machine an operator named `Foyer "big" \ wall` cannot corrupt
 *     the exposition.
 *   - the Phase-5 process gauges are all still there (this rewrote their exporter).
 */
import { beforeEach, describe, expect, test } from "bun:test";
import type { MachineVitals } from "@polyptic/protocol";

import { Presence } from "../src/admin";
import { ThumbnailStore } from "../src/capture";
import { AgentHub, PlayerHub } from "../src/hub";
import { CounterRegistry } from "../src/metrics";
import { renderMetrics, type OpsDeps } from "../src/ops";
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

/** One metric line, or undefined. `name{...}` matching is exact on the sample's label set prefix. */
function sample(body: string, prefix: string): string | undefined {
  return body.split("\n").find((l) => l.startsWith(prefix));
}

let cp: ControlPlane;
let presence: Presence;
let counters: CounterRegistry;
let deps: OpsDeps;

const FULL: MachineVitals = {
  at: new Date().toISOString(),
  cpuPercent: 91.5,
  memPercent: 40,
  memUsedBytes: 3_300_000_000,
  diskPercent: 22,
  tempC: 61.2,
  loadavg: [1.25, 0.9, 0.7],
  uptimeSec: 86_400,
  imageId: "20260714T101500Z-abcd",
  browsers: [
    { connector: "DP-1", running: true, respawns: 4, rssBytes: 512_000_000, gpuAccel: false },
    { connector: "DP-2", running: true, respawns: 0, rssBytes: 400_000_000 }, // gpuAccel UNKNOWN
  ],
};

beforeEach(async () => {
  cp = new ControlPlane(new MemoryStore());
  await cp.init();
  await cp.registerMachine(hello("box-1"), undefined);
  await cp.approveMachine("box-1");
  await cp.registerMachine(hello("box-2"), undefined);
  await cp.approveMachine("box-2");

  presence = new Presence();
  counters = new CounterRegistry();
  deps = {
    control: cp,
    agentHub: new AgentHub(),
    playerHub: new PlayerHub(),
    thumbnails: new ThumbnailStore(),
    presence,
    counters,
    images: {
      manifests: async () => [
        { arch: "amd64", imageId: "20260701T000000Z-aaaa", builtAt: new Date(Date.now() - 3600_000).toISOString() },
      ],
    },
    storeKind: "memory",
    version: "0.0.0-test",
    revision: "dev",
    startedAt: Date.now(),
  };
});

describe("/metrics (POL-92)", () => {
  test("the Phase-5 process gauges survive the rewrite", async () => {
    const body = await renderMetrics(deps);
    for (const name of [
      "polyptic_build_info",
      "polyptic_revision",
      "polyptic_agents_connected",
      "polyptic_players_connected",
      "polyptic_machines_total",
      "polyptic_screens_total",
      "polyptic_thumbnails_stored",
    ]) {
      expect(body).toContain(`# TYPE ${name} gauge`);
    }
  });

  test("polyptic_machine_up is 1 online, 0 offline — and an offline box does NOT vanish", async () => {
    presence.agentConnected("box-1");
    const body = await renderMetrics(deps);
    expect(sample(body, 'polyptic_machine_up{machine="box-1"')).toContain(" 1");
    expect(sample(body, 'polyptic_machine_up{machine="box-2"')).toContain(" 0");
    expect(body).toContain("# TYPE polyptic_machine_up gauge");
  });

  test("vitals gauges are emitted for an online machine", async () => {
    presence.agentConnected("box-1");
    presence.noteHeartbeat("box-1", FULL);
    const body = await renderMetrics(deps);

    expect(sample(body, 'polyptic_machine_cpu_percent{machine="box-1"')).toContain(" 91.5");
    expect(sample(body, 'polyptic_machine_memory_percent{machine="box-1"')).toContain(" 40");
    expect(sample(body, 'polyptic_machine_disk_percent{machine="box-1"')).toContain(" 22");
    expect(sample(body, 'polyptic_machine_temperature_celsius{machine="box-1"')).toContain(" 61.2");
    expect(sample(body, 'polyptic_machine_load1{machine="box-1"')).toContain(" 1.25");
    expect(sample(body, 'polyptic_machine_uptime_seconds{machine="box-1"')).toContain(" 86400");
    expect(body).toContain('image_id="20260714T101500Z-abcd"');
    expect(sample(body, 'polyptic_machine_last_seen_seconds{machine="box-1"')).toBeDefined();
  });

  test("the GPU tell: a definite false is a 0; an UNKNOWN emits no sample at all", async () => {
    presence.agentConnected("box-1");
    presence.noteHeartbeat("box-1", FULL);
    const body = await renderMetrics(deps);

    // DP-1 said "no /dev/dri fd" — that is a 0, and an alertable one.
    const dp1 = body
      .split("\n")
      .find((l) => l.startsWith("polyptic_machine_gpu_accelerated") && l.includes('connector="DP-1"'));
    expect(dp1?.endsWith(" 0")).toBe(true);
    // DP-2's agent could not tell. Silence — NOT a zero.
    expect(
      body.split("\n").some((l) => l.startsWith("polyptic_machine_gpu_accelerated") && l.includes('connector="DP-2"')),
    ).toBe(false);
  });

  test("respawns are a counter, per connector", async () => {
    presence.agentConnected("box-1");
    presence.noteHeartbeat("box-1", FULL);
    const body = await renderMetrics(deps);
    expect(body).toContain("# TYPE polyptic_machine_browser_respawns_total counter");
    const line = body
      .split("\n")
      .find((l) => l.startsWith("polyptic_machine_browser_respawns_total") && l.includes('connector="DP-1"'));
    expect(line?.endsWith(" 4")).toBe(true);
  });

  test("an OFFLINE machine's stale vitals are not exported", async () => {
    presence.noteHeartbeat("box-1", FULL); // sampled, then the box dropped (never agentConnected)
    const body = await renderMetrics(deps);
    expect(body.includes("polyptic_machine_cpu_percent")).toBe(false);
    expect(sample(body, 'polyptic_machine_up{machine="box-1"')).toContain(" 0");
  });

  test("depot counters and the image build age", async () => {
    counters.inc("polyptic_depot_fetches_total", "Netboot depot artifacts served.", {
      arch: "amd64",
      file: "rootfs.squashfs",
    });
    counters.inc("polyptic_depot_fetches_total", "Netboot depot artifacts served.", {
      arch: "amd64",
      file: "rootfs.squashfs",
    });
    const body = await renderMetrics(deps);
    expect(body).toContain("# TYPE polyptic_depot_fetches_total counter");
    expect(
      body.split("\n").find((l) => l.startsWith("polyptic_depot_fetches_total"))?.endsWith(" 2"),
    ).toBe(true);

    const age = sample(body, "polyptic_image_build_age_seconds");
    expect(age).toBeDefined();
    expect(Number(age?.split(" ").pop())).toBeGreaterThanOrEqual(3500); // ~1h old
  });

  test("a hostname full of quotes cannot corrupt the exposition", async () => {
    await cp.registerMachine({ ...hello("box-3"), hostname: 'Foyer "big" \\ wall' }, undefined);
    await cp.approveMachine("box-3");
    presence.agentConnected("box-3");
    const body = await renderMetrics(deps);
    // Quotes and backslashes escaped, so the sample line stays parseable.
    expect(body).toContain('label="Foyer \\"big\\" \\\\ wall"');
  });

  test("a depot that throws does not fail the scrape", async () => {
    deps.images = {
      manifests: async () => {
        throw new Error("depot volume unmounted");
      },
    };
    const body = await renderMetrics(deps);
    expect(body).toContain("polyptic_build_info");
    expect(body).not.toContain("polyptic_image_build_age_seconds");
  });
});
