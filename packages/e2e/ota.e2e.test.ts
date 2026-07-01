/**
 * @polyptic/e2e — OTA rollout suite (POL-28) against the REAL control plane.
 *
 * Spawns the actual server (`packages/server/src/index.ts`) on its own PORT with STORE=memory and an
 * AGENT_DIST_DIR seeded with a manifest advertising agent 0.2.0, then drives the rollout the way a
 * fleet would: raw `/agent` WebSockets as fake agents (reporting versions + update states over
 * agent/status), `/admin` for the operator view, and REST for the fleet routes.
 *
 * Coverage:
 *   - GET /dist/agent/manifest.json serves the advertised release; admin/state carries agentRelease.
 *   - POST /api/v1/fleet/rollout (all) → the connected agent on the old version receives server/update
 *     with the target + per-arch artifacts; when it reports the new version healthy, the rollout completes.
 *   - Canary: only the canary box is offered; the rest wait until POST …/promote.
 *   - The provisioning-epoch gate flags a pre-OTA (no-epoch) box as needsInstaller instead of OTA'ing it.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8096;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 12_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── a tiny buffering WS client (mirrors enrollment.e2e) ──
type Frame = any;
class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Array<{ pred: (m: Frame) => boolean; resolve: (m: Frame) => void; timer: ReturnType<typeof setTimeout> }> = [];
  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
  }
  static connect(url: string, timeoutMs = 5000): Promise<WsClient> {
    return new Promise((res, rej) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => rej(new Error(`ws open timeout ${url}`)), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        res(new WsClient(ws));
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        rej(new Error(`ws error ${url}`));
      }, { once: true });
    });
  }
  private ingest(data: unknown): void {
    let msg: Frame;
    try {
      msg = JSON.parse(typeof data === "string" ? data : String(data));
    } catch {
      return;
    }
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
    } else {
      this.queue.push(msg);
    }
  }
  waitFor(pred: (m: Frame) => boolean, label = "frame", timeoutMs = 4000): Promise<Frame> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise((res, rej) => {
      const timer = setTimeout(() => {
        const i = this.waiters.findIndex((w) => w.timer === timer);
        if (i >= 0) this.waiters.splice(i, 1);
        rej(new Error(`timed out waiting for ${label}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: res, timer });
    });
  }
  async sawWithin(pred: (m: Frame) => boolean, timeoutMs: number): Promise<boolean> {
    try {
      await this.waitFor(pred, "probe", timeoutMs);
      return true;
    } catch {
      return false;
    }
  }
  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }
  close(): void {
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }
}

const openClients: WsClient[] = [];
async function openAgent(): Promise<WsClient> {
  const c = await WsClient.connect(`${WS}/agent`);
  openClients.push(c);
  return c;
}
async function connectAdmin(): Promise<WsClient> {
  const c = await WsClient.connect(`${WS}/admin`);
  openClients.push(c);
  c.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  return c;
}

function hello(machineId: string, agentVersion: string, provisionEpoch?: number): Frame {
  const h: Frame = {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion,
    backend: "dev-open",
    outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
  };
  if (provisionEpoch !== undefined) h.provisionEpoch = provisionEpoch;
  return h;
}
function status(machineId: string, agentVersion: string, updateState?: string): Frame {
  const s: Frame = {
    t: "agent/status",
    machineId,
    observedRevision: 0,
    screens: [],
    agentVersion,
    provisionEpoch: 1,
  };
  if (updateState) s.updateState = updateState;
  return s;
}

async function machineFromAdmin(admin: WsClient, id: string, pred: (m: Frame) => boolean, label: string): Promise<Frame> {
  const state = await admin.waitFor(
    (m) => m.t === "admin/state" && Array.isArray(m.machines) && m.machines.some((mm: Frame) => mm.id === id && pred(mm)),
    label,
    6000,
  );
  return state.machines.find((mm: Frame) => mm.id === id);
}

function postJson(path: string, body?: unknown): Promise<Response> {
  if (body === undefined) return fetch(`${BASE}${path}`, { method: "POST" });
  return fetch(`${BASE}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// ── server lifecycle ──
let proc: ReturnType<typeof Bun.spawn> | null = null;
let distDir: string;

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/state`);
      if (res.ok || res.status === 401) {
        await res.body?.cancel();
        return;
      }
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}`);
}

beforeAll(async () => {
  // Seed a depot dist dir with fake binaries + a manifest advertising 0.2.0.
  distDir = mkdtempSync(join(tmpdir(), "polyptic-ota-dist-"));
  const amd64 = "fake-agent-amd64-0.2.0";
  const arm64 = "fake-agent-arm64-0.2.0";
  writeFileSync(join(distDir, "polyptic-agent-amd64"), amd64);
  writeFileSync(join(distDir, "polyptic-agent-arm64"), arm64);
  const manifest = {
    version: "0.2.0",
    provisionEpoch: 1,
    artifacts: {
      amd64: { sha256: createHash("sha256").update(amd64).digest("hex"), size: amd64.length },
      arm64: { sha256: createHash("sha256").update(arm64).digest("hex"), size: arm64.length },
    },
  };
  writeFileSync(join(distDir, "manifest.json"), JSON.stringify(manifest));

  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      AUTH_ENABLED: "false",
      AGENT_DIST_DIR: distDir,
      PLAYER_BASE_URL: "http://localhost:5173",
      ROLLOUT_TICK_MS: "500",
      ROLLOUT_SOAK_MS: "1000",
      LOG_LEVEL: "error",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();
}, 30_000);

afterAll(async () => {
  for (const c of openClients) c.close();
  if (proc) {
    proc.kill();
    try {
      await proc.exited;
    } catch {
      /* gone */
    }
  }
  if (distDir) rmSync(distDir, { recursive: true, force: true });
}, 10_000);

describe("OTA depot + rollout signal (POL-28)", () => {
  test(
    "GET /dist/agent/manifest.json advertises the release",
    async () => {
      const res = await fetch(`${BASE}/dist/agent/manifest.json`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { version: string; provisionEpoch: number; artifacts: Record<string, unknown> };
      expect(body.version).toBe("0.2.0");
      expect(body.provisionEpoch).toBe(1);
      expect(body.artifacts.amd64).toBeDefined();
      expect(body.artifacts.arm64).toBeDefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "admin/state carries the agentRelease",
    async () => {
      const admin = await connectAdmin();
      const state = await admin.waitFor((m) => m.t === "admin/state" && m.agentRelease != null, "admin/state with release");
      expect(state.agentRelease.version).toBe("0.2.0");
    },
    TEST_TIMEOUT,
  );

  test(
    "all-at-once rollout offers server/update to the box on the old version, then completes when it reports the new one",
    async () => {
      const agent = await openAgent();
      agent.send(hello("ota-box-1", "0.1.0", 1));
      // Open mode → auto-approved → server/apply.
      await agent.waitFor((m) => m.t === "server/apply" && m.machineId === "ota-box-1", "server/apply");

      // Start the rollout.
      const res = await postJson("/api/v1/fleet/rollout", { version: "0.2.0", strategy: "all" });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      // The agent is offered the update with the target + per-arch checksums.
      const update = await agent.waitFor((m) => m.t === "server/update", "server/update", 6000);
      expect(update.targetVersion).toBe("0.2.0");
      expect(update.artifacts.amd64.sha256).toMatch(/^[0-9a-f]{64}$/);

      // Simulate the box coming back on 0.2.0, healthy — the rollout should complete.
      agent.send(status("ota-box-1", "0.2.0", "healthy"));

      const admin = await connectAdmin();
      const machine = await machineFromAdmin(admin, "ota-box-1", (mm) => mm.agentVersion === "0.2.0", "box on 0.2.0");
      expect(machine.agentVersion).toBe("0.2.0");

      const done = await admin.waitFor(
        (m) => m.t === "admin/state" && m.rollout != null && m.rollout.stage === "complete",
        "rollout complete",
        6000,
      );
      expect(done.rollout.targetVersion).toBe("0.2.0");

      // Clear the rollout for the next test.
      await (await fetch(`${BASE}/api/v1/fleet/rollout`, { method: "DELETE" })).body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "canary offers only the canary box; the rest wait until promote",
    async () => {
      const canary = await openAgent();
      const rest = await openAgent();
      canary.send(hello("canary-box", "0.1.0", 1));
      rest.send(hello("rest-box", "0.1.0", 1));
      await canary.waitFor((m) => m.t === "server/apply" && m.machineId === "canary-box", "apply canary");
      await rest.waitFor((m) => m.t === "server/apply" && m.machineId === "rest-box", "apply rest");

      const res = await postJson("/api/v1/fleet/rollout", {
        version: "0.2.0",
        strategy: "canary",
        canaryMachineIds: ["canary-box"],
        promotion: "manual",
      });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      // Canary is offered; the rest is NOT (within a window that covers a couple of ticks).
      await canary.waitFor((m) => m.t === "server/update", "canary update", 6000);
      const restOffered = await rest.sawWithin((m) => m.t === "server/update", 1500);
      expect(restOffered).toBe(false);

      // Promote → the rest is now offered.
      const promo = await postJson("/api/v1/fleet/rollout/promote");
      expect(promo.status).toBe(200);
      await promo.body?.cancel();
      await rest.waitFor((m) => m.t === "server/update", "rest update after promote", 6000);

      await (await fetch(`${BASE}/api/v1/fleet/rollout`, { method: "DELETE" })).body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "a pre-OTA box (no provision epoch) is flagged needsInstaller and never offered an update",
    async () => {
      const admin = await connectAdmin();
      const legacy = await openAgent();
      // No provisionEpoch on hello → treated as epoch 0, below the release's epoch 1.
      legacy.send(hello("legacy-box", "0.1.0"));
      await legacy.waitFor((m) => m.t === "server/apply" && m.machineId === "legacy-box", "apply legacy");

      const res = await postJson("/api/v1/fleet/rollout", { version: "0.2.0", strategy: "all" });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      // It must be flagged needsInstaller, and never receive a server/update.
      const machine = await machineFromAdmin(admin, "legacy-box", (mm) => mm.needsInstaller === true, "legacy needsInstaller");
      expect(machine.needsInstaller).toBe(true);
      const offered = await legacy.sawWithin((m) => m.t === "server/update", 1500);
      expect(offered).toBe(false);

      await (await fetch(`${BASE}/api/v1/fleet/rollout`, { method: "DELETE" })).body?.cancel();
    },
    TEST_TIMEOUT,
  );
});
