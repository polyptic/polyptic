/**
 * @polyptic/e2e — REMOVAL suite (POL-14) against the REAL control plane.
 *
 * Spawns the actual server (`packages/server/src/index.ts`) via `Bun.spawn` in OPEN mode (no
 * POLYPTIC_BOOTSTRAP_TOKEN → agents auto-register + auto-approve, screens created) on its own PORT
 * (8100) against the MemoryStore (STORE=memory), then drives the two new DELETE endpoints exactly as
 * the console does:
 *
 *   DELETE /api/v1/screens/:id   — forget a single screen: it leaves admin/state, its player is sent
 *                                  an empty server/render (cleared), the machine stays.
 *   DELETE /api/v1/machines/:id  — forget a whole machine: it (and its screens) leave admin/state and
 *                                  the server closes its live agent socket. Re-connecting in OPEN mode
 *                                  re-registers it as a brand-new machine (removal is a clean forget).
 *   404s on unknown ids.
 *
 * Uses the same buffering WsClient pattern as the enrollment suite so frame-order races are safe.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8100;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client: never miss a frame between awaits.
// ─────────────────────────────────────────────────────────────────────────────

type Frame = any;
type Predicate = (m: Frame) => boolean;

interface Waiter {
  pred: Predicate;
  resolve: (m: Frame) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Waiter[] = [];
  private closed = false;
  private closeResolvers: Array<() => void> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
    ws.addEventListener("close", () => {
      this.closed = true;
      const resolvers = this.closeResolvers;
      this.closeResolvers = [];
      for (const r of resolvers) r();
    });
  }

  static connect(url: string, timeoutMs = 5_000): Promise<WsClient> {
    return new Promise<WsClient>((resolveConn, rejectConn) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (err) {
        rejectConn(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        rejectConn(new Error(`ws open timeout: ${url}`));
      }, timeoutMs);
      ws.addEventListener(
        "open",
        () => {
          clearTimeout(timer);
          resolveConn(new WsClient(ws));
        },
        { once: true },
      );
      ws.addEventListener(
        "error",
        () => {
          clearTimeout(timer);
          rejectConn(new Error(`ws error before open: ${url}`));
        },
        { once: true },
      );
    });
  }

  private ingest(data: unknown): void {
    const text = typeof data === "string" ? data : String(data);
    let msg: Frame;
    try {
      msg = JSON.parse(text);
    } catch {
      return; // never trust a malformed frame
    }
    const idx = this.waiters.findIndex((w) => w.pred(msg));
    if (idx >= 0) {
      const w = this.waiters.splice(idx, 1)[0]!;
      clearTimeout(w.timer);
      w.resolve(msg);
      return;
    }
    this.queue.push(msg);
  }

  /** Resolve with the first frame (queued or future) that matches `pred`, or reject on timeout. */
  waitFor(pred: Predicate, label = "frame", timeoutMs = 3_000): Promise<Frame> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise<Frame>((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        rejectMsg(new Error(`timed out waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolveMsg, timer, label });
    });
  }

  /** True iff a `pred`-matching frame arrives within `timeoutMs`; never throws (for absence checks). */
  async sawWithin(pred: Predicate, timeoutMs: number): Promise<boolean> {
    try {
      await this.waitFor(pred, "presence-probe", timeoutMs);
      return true;
    } catch {
      return false;
    }
  }

  /** Resolve once the socket is closed (by either side), or reject on timeout. */
  waitForClose(timeoutMs = 4_000): Promise<void> {
    if (this.closed) return Promise.resolve();
    return new Promise<void>((resolveClose, rejectClose) => {
      const timer = setTimeout(
        () => rejectClose(new Error(`timed out waiting for ws close after ${timeoutMs}ms`)),
        timeoutMs,
      );
      this.closeResolvers.push(() => {
        clearTimeout(timer);
        resolveClose();
      });
    });
  }

  get isClosed(): boolean {
    return this.closed;
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

// ─────────────────────────────────────────────────────────────────────────────
// REST + wire helpers
// ─────────────────────────────────────────────────────────────────────────────

function del(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: "DELETE" });
}

function postJson(path: string, body?: unknown): Promise<Response> {
  if (body === undefined) return fetch(`${BASE}${path}`, { method: "POST" });
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function agentHello(machineId: string, connector: string): Frame {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector, width: 1920, height: 1080 }],
  };
}

function playerHello(screenId: string): Frame {
  return { t: "player/hello", protocol: PROTOCOL_VERSION, screenId };
}

function adminHello(): unknown {
  return { t: "admin/hello", protocol: PROTOCOL_VERSION };
}

const openClients: WsClient[] = [];

async function openAgent(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  return client;
}

async function openPlayer(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/player`);
  openClients.push(client);
  return client;
}

async function connectAdmin(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/admin`);
  openClients.push(client);
  client.send(adminHello());
  return client;
}

/** Wait for an admin/state whose machine `id` satisfies `pred`, then return that machine. */
async function machineFromAdmin(
  admin: WsClient,
  id: string,
  pred: (mm: Frame) => boolean,
  label: string,
  timeoutMs = 4_000,
): Promise<Frame> {
  const state = await admin.waitFor(
    (m) =>
      m.t === "admin/state" &&
      Array.isArray(m.machines) &&
      m.machines.some((mm: Frame) => mm.id === id && pred(mm)),
    label,
    timeoutMs,
  );
  return state.machines.find((mm: Frame) => mm.id === id);
}

/** Wait for an admin/state that does NOT list machine `id` at all. */
async function stateWithoutMachine(admin: WsClient, id: string, label: string): Promise<Frame> {
  return admin.waitFor(
    (m) =>
      m.t === "admin/state" &&
      Array.isArray(m.machines) &&
      !m.machines.some((mm: Frame) => mm.id === id),
    label,
    4_000,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Server process lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/state`);
      if (res.ok) {
        await res.body?.cancel();
        return;
      }
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}: ${lastErr}`);
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // No POLYPTIC_BOOTSTRAP_TOKEN → OPEN mode (auto-register + auto-approve, screens created).
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
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
      /* already gone */
    }
  }
}, 10_000);

// Shared across the ordered flow (bun runs tests in source order, sequentially).
const MACHINE_A = "remove-host-a"; // used for the SCREEN-removal test (machine stays)
const MACHINE_B = "remove-host-b"; // used for the MACHINE-removal test (whole machine goes)
const CONNECTOR = "HDMI-1";
let agentA: WsClient;
let agentB: WsClient;
let screenAId = "";
let screenBId = "";

// ─────────────────────────────────────────────────────────────────────────────
// Removal — POL-14
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-14 removal (open mode)", () => {
  test(
    "two agents auto-register with one screen each; admin/state lists both online",
    async () => {
      agentA = await openAgent();
      agentA.send(agentHello(MACHINE_A, CONNECTOR));
      const applyA = await agentA.waitFor(
        (m) => m.t === "server/apply" && m.machineId === MACHINE_A,
        "server/apply for machine-a",
      );
      screenAId = applyA.screens[0].screenId;
      expect(screenAId).toMatch(/^screen-\d+$/);

      agentB = await openAgent();
      agentB.send(agentHello(MACHINE_B, CONNECTOR));
      const applyB = await agentB.waitFor(
        (m) => m.t === "server/apply" && m.machineId === MACHINE_B,
        "server/apply for machine-b",
      );
      screenBId = applyB.screens[0].screenId;
      expect(screenBId).toMatch(/^screen-\d+$/);

      const admin = await connectAdmin();
      const a = await machineFromAdmin(
        admin,
        MACHINE_A,
        (mm) => mm.status === "approved" && mm.screens.length === 1,
        "admin/state with machine-a approved",
      );
      expect(a.online).toBe(true);
      const b = await machineFromAdmin(
        admin,
        MACHINE_B,
        (mm) => mm.status === "approved" && mm.screens.length === 1,
        "admin/state with machine-b approved",
      );
      expect(b.online).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE /screens/:id forgets a screen: it clears its player + leaves admin/state, machine stays",
    async () => {
      // A player watches screen-a; give it content so the post-remove clear is observable.
      const player = await openPlayer();
      player.send(playerHello(screenAId));
      await player.waitFor((m) => m.t === "server/render", "initial render for screen-a");

      const contentRes = await postJson("/api/v1/demo/web", {
        screenId: screenAId,
        url: "https://example.com/",
      });
      expect(contentRes.status).toBe(200);
      await contentRes.body?.cancel();
      await player.waitFor(
        (m) => m.t === "server/render" && m.slice.surfaces.length === 1,
        "render with one surface",
      );

      // Remove the screen.
      const admin = await connectAdmin();
      const res = await del(`/api/v1/screens/${screenAId}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; screenId: string };
      expect(body.ok).toBe(true);
      expect(body.screenId).toBe(screenAId);

      // The player is told to render nothing (surfaces cleared).
      const cleared = await player.waitFor(
        (m) => m.t === "server/render" && m.slice.surfaces.length === 0,
        "cleared render after screen removal",
        5_000,
      );
      expect(cleared.slice.surfaces.length).toBe(0);

      // machine-a survives but now drives zero screens; machine-b is untouched.
      const a = await machineFromAdmin(
        admin,
        MACHINE_A,
        (mm) => mm.screens.length === 0,
        "admin/state with machine-a screenless",
      );
      expect(a.status).toBe("approved");
      const b = await machineFromAdmin(admin, MACHINE_B, (mm) => mm.screens.length === 1, "machine-b intact");
      expect(b.screens[0].id).toBe(screenBId);
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE /machines/:id forgets the machine + closes its live agent socket + leaves admin/state",
    async () => {
      const admin = await connectAdmin();

      const res = await del(`/api/v1/machines/${MACHINE_B}`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; machineId: string; closed: number };
      expect(body.ok).toBe(true);
      expect(body.machineId).toBe(MACHINE_B);
      // The still-connected agent-b socket is closed by the server.
      expect(body.closed).toBeGreaterThanOrEqual(1);
      await agentB.waitForClose();
      expect(agentB.isClosed).toBe(true);

      // machine-b (and its screen) vanish from admin/state; machine-a is still listed.
      const state = await stateWithoutMachine(admin, MACHINE_B, "admin/state without machine-b");
      expect(state.machines.some((mm: Frame) => mm.id === MACHINE_A)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "a removed machine re-registers as brand new on reconnect (open mode) — a clean forget",
    async () => {
      const admin = await connectAdmin();
      const agentB2 = await openAgent();
      agentB2.send(agentHello(MACHINE_B, CONNECTOR));
      const apply = await agentB2.waitFor(
        (m) => m.t === "server/apply" && m.machineId === MACHINE_B,
        "server/apply for re-registered machine-b",
      );
      // A fresh screen id (the old one was deleted; the global counter never rewinds).
      expect(apply.screens[0].screenId).not.toBe(screenBId);

      const b = await machineFromAdmin(
        admin,
        MACHINE_B,
        (mm) => mm.status === "approved" && mm.screens.length === 1,
        "admin/state with machine-b re-registered",
      );
      expect(b.online).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE on an unknown machine or screen returns 404",
    async () => {
      const m = await del("/api/v1/machines/machine-does-not-exist");
      expect(m.status).toBe(404);
      await m.body?.cancel();

      const s = await del("/api/v1/screens/screen-does-not-exist");
      expect(s.status).toBe(404);
      await s.body?.cancel();
    },
    TEST_TIMEOUT,
  );
});
