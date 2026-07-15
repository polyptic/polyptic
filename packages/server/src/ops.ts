/**
 * Operational endpoints (Phase 5; per-machine fleet metrics in POL-92) — TOP-LEVEL, deliberately NOT
 * under /api/v1 so they are UNgated by the operator-session gate (scrapers / liveness probes carry no
 * cookie):
 *
 *   GET /healthz  → JSON liveness/readiness: { status, revision, uptimeSec, store, ... }.
 *   GET /metrics  → Prometheus text exposition (hand-formatted; see ./metrics.ts for why).
 *
 * Two layers of numbers:
 *
 *   1. PROCESS-level (Phase 5): what this control plane is doing — revision, connected agents and
 *      players, registry counts, thumbnails held.
 *   2. FLEET-level (POL-92): what each BOX is doing. `polyptic_machine_up{machine=…}` finally makes
 *      "is box 37 up?" a question the Prometheus stack a self-hoster already runs can answer, and the
 *      vitals the agent heartbeats (CPU, memory, disk, temperature, browser respawns, and the
 *      `/dev/dri` GPU tell from D77) come out as labelled gauges an operator can alert on. See
 *      `deploy/prometheus-alerts.example.yaml` for rules built on every one of them.
 *
 * Everything fleet-level is read LIVE from Presence's in-memory vitals ring — the exporter stores
 * nothing and adds nothing to the agent or player paths. Vitals are only emitted for machines that
 * are ONLINE: a CPU reading from a box that has since gone dark is not health data.
 *
 * An absent reading emits NO SAMPLE (rather than a zero). A missing series and a zero series mean
 * very different things to an alert, and only one of them would be true.
 */
import type { FastifyInstance } from "fastify";

import type { Presence } from "./admin";
import type { ThumbnailStore } from "./capture";
import type { AgentHub, PlayerHub } from "./hub";
import { counterVec, gauge, gaugeVec } from "./metrics";
import type { CounterRegistry, Sample } from "./metrics";
import type { ControlPlane } from "./state";

/** As much of `ImageUpdates` as the exporter needs (so the metrics can be unit-tested without a depot). */
export interface ImageManifestReader {
  manifests(): Promise<{ arch: string; imageId: string; builtAt: string }[]>;
}

export interface OpsDeps {
  control: ControlPlane;
  agentHub: AgentHub;
  playerHub: PlayerHub;
  thumbnails: ThumbnailStore;
  /** POL-92 — live machine presence + the per-machine host-vitals ring. */
  presence: Presence;
  /** POL-92 — cumulative counters (depot fetches, …), incremented by the routes that serve them. */
  counters: CounterRegistry;
  /** POL-92 — the netboot depot's published images, for the build-age gauges. Optional: a server
   *  with no depot simply exports no image metrics. */
  images?: ImageManifestReader;
  /** Store backend in use ("postgres" | "memory"), surfaced for health/diagnostics. */
  storeKind: string;
  /** Build version string (e.g. semver / image tag). */
  version: string;
  /** Build revision (git sha or "dev"). */
  revision: string;
  /** Process start time (ms epoch) for uptime. */
  startedAt: number;
}

/** Push a sample only when the reading actually exists. */
function push(into: Sample[], labels: Record<string, string>, value: number | undefined): void {
  if (value === undefined || !Number.isFinite(value)) return;
  into.push({ labels, value });
}

/**
 * Render the whole exposition body. Exported so tests can assert its SHAPE without an HTTP round
 * trip — and so nothing in here needs a Fastify instance to be exercised.
 */
export async function renderMetrics(deps: OpsDeps): Promise<string> {
  const { control, agentHub, playerHub, thumbnails, presence, counters, images, version, revision } =
    deps;

  const machines = control.getMachines();
  const screens = control.getScreens();
  const nowSec = Date.now() / 1000;

  // ── fleet: one series per machine ─────────────────────────────────────────
  const up: Sample[] = [];
  const lastSeen: Sample[] = [];
  const cpu: Sample[] = [];
  const mem: Sample[] = [];
  const memBytes: Sample[] = [];
  const disk: Sample[] = [];
  const temp: Sample[] = [];
  const load1: Sample[] = [];
  const uptime: Sample[] = [];
  const gpuAccel: Sample[] = [];
  const respawns: Sample[] = [];
  const browserRss: Sample[] = [];
  const imageInfo: Sample[] = [];
  const screensPerMachine: Sample[] = [];

  for (const machine of machines) {
    const labels = { machine: machine.id, label: machine.label };
    const online = presence.isMachineOnline(machine.id);

    // Every APPROVED machine gets an `up` series, online or not — that is the whole point: a box that
    // vanishes must go to 0, not disappear from the exposition (an absent series cannot fire an alert
    // by itself). Pending/rejected boxes are not part of the fleet, so they carry none.
    if (machine.status === "approved") up.push({ labels, value: online ? 1 : 0 });

    // Last seen, as unix seconds (node_exporter convention), so the alert reads
    // `time() - polyptic_machine_last_seen_seconds > 60`. The live heartbeat wins over the persisted
    // lastSeen (which is only written on connect).
    const beat = presence.machineLastHeartbeat(machine.id);
    const persisted = machine.lastSeen ? Date.parse(machine.lastSeen) : Number.NaN;
    const seenMs = Math.max(beat ?? 0, Number.isFinite(persisted) ? persisted : 0);
    if (seenMs > 0) push(lastSeen, labels, Math.round(seenMs / 1000));

    push(screensPerMachine, labels, screens.filter((s) => s.machineId === machine.id).length);

    if (!online) continue; // stale vitals are not health data
    const v = presence.machineVitals(machine.id);
    if (!v) continue;

    push(cpu, labels, v.cpuPercent);
    push(mem, labels, v.memPercent);
    push(memBytes, labels, v.memUsedBytes);
    push(disk, labels, v.diskPercent);
    push(temp, labels, v.tempC);
    push(load1, labels, v.loadavg?.[0]);
    push(uptime, labels, v.uptimeSec);
    if (v.imageId) imageInfo.push({ labels: { ...labels, image_id: v.imageId }, value: 1 });

    for (const b of v.browsers ?? []) {
      const bl = { ...labels, connector: b.connector };
      push(respawns, bl, b.respawns);
      push(browserRss, bl, b.rssBytes);
      // The D77 tell. Emitted ONLY when the agent could actually determine it — an unknown must not
      // read as "software rendering" and page someone at 03:00.
      if (b.gpuAccel !== undefined) gpuAccel.push({ labels: bl, value: b.gpuAccel ? 1 : 0 });
    }
  }

  // ── depot: how old is the image the fleet is being served? ────────────────
  const imageAge: Sample[] = [];
  const imageBuiltAt: Sample[] = [];
  if (images) {
    try {
      for (const m of await images.manifests()) {
        const built = Date.parse(m.builtAt);
        if (!Number.isFinite(built)) continue;
        const labels = { arch: m.arch, image_id: m.imageId };
        imageAge.push({ labels, value: Math.max(0, Math.round(nowSec - built / 1000)) });
        imageBuiltAt.push({ labels, value: Math.round(built / 1000) });
      }
    } catch {
      // A depot read that fails must never fail the scrape — every other number still matters.
    }
  }

  return (
    // ── process-level (Phase 5; names unchanged) ──
    gauge("polyptic_build_info", "Build metadata; constant 1, version/revision as labels.", 1, {
      version,
      revision,
    }) +
    gauge(
      "polyptic_revision",
      "Current desired-state revision (increments on every applied change).",
      control.state.revision,
    ) +
    gauge(
      "polyptic_agents_connected",
      "Machines with at least one live agent WebSocket.",
      agentHub.machineCount(),
    ) +
    gauge(
      "polyptic_players_connected",
      "Screens with at least one live player WebSocket.",
      playerHub.screenCount(),
    ) +
    gauge("polyptic_machines_total", "Machines in the registry.", machines.length) +
    gauge("polyptic_screens_total", "Screens in the registry.", screens.length) +
    gauge(
      "polyptic_thumbnails_stored",
      "Live-preview thumbnails currently held in memory.",
      thumbnails.size,
    ) +
    // ── fleet-level (POL-92) ──
    gaugeVec(
      "polyptic_machine_up",
      "1 when an approved machine's agent is connected, 0 when it is not.",
      up,
    ) +
    gaugeVec(
      "polyptic_machine_last_seen_seconds",
      "Unix time of the last contact from this machine (heartbeat or connect).",
      lastSeen,
    ) +
    gaugeVec("polyptic_machine_cpu_percent", "Host CPU busy percent (0-100).", cpu) +
    gaugeVec("polyptic_machine_memory_percent", "Host memory used percent (0-100).", mem) +
    gaugeVec("polyptic_machine_memory_used_bytes", "Host memory used, bytes.", memBytes) +
    gaugeVec("polyptic_machine_disk_percent", "Root filesystem used percent (0-100).", disk) +
    gaugeVec("polyptic_machine_temperature_celsius", "Hottest thermal zone, degrees C.", temp) +
    gaugeVec("polyptic_machine_load1", "1-minute load average.", load1) +
    gaugeVec("polyptic_machine_uptime_seconds", "Seconds since the box booted.", uptime) +
    gaugeVec(
      "polyptic_machine_gpu_accelerated",
      "1 when this output's kiosk browser holds a /dev/dri fd (GPU rendering), 0 when it is rendering the wall in software.",
      gpuAccel,
    ) +
    gaugeVec(
      "polyptic_machine_browser_memory_bytes",
      "Resident memory of this output's kiosk browser process tree, bytes.",
      browserRss,
    ) +
    gaugeVec(
      "polyptic_machine_image_info",
      "The live image id this box is RUNNING; constant 1, image_id as a label.",
      imageInfo,
    ) +
    gaugeVec("polyptic_machine_screens", "Screens driven by this machine.", screensPerMachine) +
    counterVec(
      "polyptic_machine_browser_respawns_total",
      "Times the agent has respawned this output's kiosk browser since it started supervising it.",
      respawns,
    ) +
    // ── depot (POL-92) ──
    gaugeVec(
      "polyptic_image_build_age_seconds",
      "Age of the live image the depot currently publishes for this architecture.",
      imageAge,
    ) +
    gaugeVec(
      "polyptic_image_built_at_seconds",
      "Unix time the depot's published live image for this architecture was built.",
      imageBuiltAt,
    ) +
    // ── cumulative counters (depot fetches, …) ──
    counters.render()
  );
}

export function registerOpsRoutes(fastify: FastifyInstance, deps: OpsDeps): void {
  const { control, storeKind, version, revision, startedAt } = deps;

  // GET /healthz — liveness/readiness; intentionally cheap and dependency-light.
  fastify.get("/healthz", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
    return {
      status: "ok",
      revision,
      version,
      uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
      store: storeKind,
      stateRevision: control.state.revision,
    };
  });

  // GET /metrics — Prometheus text exposition format v0.0.4.
  fastify.get("/metrics", async (_request, reply) => {
    const body = await renderMetrics(deps);
    reply.header("Cache-Control", "no-store");
    reply.type("text/plain; version=0.0.4; charset=utf-8");
    return body;
  });
}
