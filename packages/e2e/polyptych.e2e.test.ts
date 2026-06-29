/**
 * @polyptych/e2e — end-to-end suite against the REAL control plane.
 *
 * We spawn the actual server (`packages/server/src/index.ts`) with `Bun.spawn`, point it at the
 * MemoryStore (STORE=memory) on PORT 8090, poll `/api/v1/state` until it answers, then drive it
 * exactly like a fleet would: agents over `/agent`, players over `/player`, and an operator UI
 * over `/admin`, plus REST mutations over `fetch`. Every WS frame is the contract's wire shape.
 *
 * Coverage:
 *   Phase 1 regression — agent/hello → server/apply assigns "screen-1"; player/hello → server/render;
 *     POST /demo/web pushes a render in < 150ms; a 2nd push keeps the stable "demo-web" id; a bad
 *     body → 400.
 *   Phase 2a — two agents (machine-a, machine-b) show up in admin/state with one screen each and
 *     both online; GET /api/v1/machines lists both; rename → a later admin/state carries the new
 *     friendlyName; ident {on:true} → that screen's player WS gets server/ident-pulse; ident with
 *     ttlMs auto-sends the off pulse; closing an agent WS → a later admin/state flips that machine
 *     online=false.
 *
 * NOTE: persistence-across-restart (a screen rename surviving a full server RESTART) is a
 * PostgreSQL-only guarantee. The MemoryStore used here is wiped when the process dies, so that DoD
 * is verified MANUALLY against Postgres per the runbook (docs), not in this suite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptych/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8090;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client: never miss a frame between awaits.
//
// Frames are parsed as soon as they arrive and either handed to a waiting predicate or queued.
// `waitFor` first scans the queue (so an already-delivered frame still satisfies a later wait),
// then parks a waiter with a per-message timeout. This makes order-independent assertions safe
// even when a broadcast races a REST response.
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

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
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
// REST helpers
// ─────────────────────────────────────────────────────────────────────────────

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire-shape builders (contract "t" values + field names, validated server-side)
// ─────────────────────────────────────────────────────────────────────────────

function agentHello(machineId: string, connector: string, width = 1920, height = 1080): unknown {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector, width, height }],
  };
}

function playerHello(screenId: string): unknown {
  return { t: "player/hello", protocol: PROTOCOL_VERSION, screenId };
}

function adminHello(): unknown {
  return { t: "admin/hello", protocol: PROTOCOL_VERSION };
}

// ─────────────────────────────────────────────────────────────────────────────
// Connection helpers
// ─────────────────────────────────────────────────────────────────────────────

const openClients: WsClient[] = [];

async function connectAgent(machineId: string, connector: string): Promise<{ client: WsClient; apply: Frame }> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  client.send(agentHello(machineId, connector));
  const apply = await client.waitFor(
    (m) => m.t === "server/apply" && m.machineId === machineId,
    `server/apply for ${machineId}`,
  );
  return { client, apply };
}

async function connectPlayer(screenId: string): Promise<{ client: WsClient; render: Frame }> {
  const client = await WsClient.connect(`${WS}/player`);
  openClients.push(client);
  client.send(playerHello(screenId));
  const render = await client.waitFor(
    (m) => m.t === "server/render" && m.slice?.screenId === screenId,
    `server/render for ${screenId}`,
  );
  return { client, render };
}

async function connectAdmin(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/admin`);
  openClients.push(client);
  client.send(adminHello());
  return client;
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
      PLAYER_BASE_URL: "http://localhost:5173",
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
      /* already gone */
    }
  }
}, 10_000);

// Shared across the ordered flow below (bun runs tests in source order, sequentially).
let agentA: WsClient;
let agentB: WsClient;
let playerScreenA: WsClient;
let admin: WsClient;
let screenA = "";
let screenB = "";

// ─────────────────────────────────────────────────────────────────────────────
// Phase 1 regression — the instant vertical slice must keep working
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 1 regression", () => {
  test(
    "agent/hello registers the first output as screen-1",
    async () => {
      const { client, apply } = await connectAgent("machine-a", "HDMI-1");
      agentA = client;
      expect(apply.t).toBe("server/apply");
      expect(apply.machineId).toBe("machine-a");
      expect(Array.isArray(apply.screens)).toBe(true);
      expect(apply.screens.length).toBe(1);
      expect(apply.screens[0].connector).toBe("HDMI-1");
      expect(apply.screens[0].screenId).toBe("screen-1");
      expect(typeof apply.screens[0].playerUrl).toBe("string");
      screenA = apply.screens[0].screenId;
    },
    TEST_TIMEOUT,
  );

  test(
    "player/hello gets an initial server/render for its screen",
    async () => {
      const { client, render } = await connectPlayer(screenA);
      playerScreenA = client;
      expect(render.t).toBe("server/render");
      expect(render.slice.screenId).toBe(screenA);
      expect(Array.isArray(render.slice.surfaces)).toBe(true);
      expect(typeof render.revision).toBe("number");
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /demo/web pushes a server/render to the player in < 150ms",
    async () => {
      const url = "https://example.com/dashboard-1";
      const started = Date.now();
      const res = await postJson("/api/v1/demo/web", { screenId: screenA, url });
      expect(res.status).toBe(200);
      const render = await playerScreenA.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => s.id === "demo-web" && s.url === url),
        "demo/web render",
      );
      const elapsed = Date.now() - started;
      expect(render.slice.surfaces.length).toBe(1);
      expect(render.slice.surfaces[0].id).toBe("demo-web");
      expect(render.slice.surfaces[0].url).toBe(url);
      expect(elapsed).toBeLessThan(150);
    },
    TEST_TIMEOUT,
  );

  test(
    "a second /demo/web push keeps the stable 'demo-web' id (in-place swap)",
    async () => {
      const url = "https://example.com/dashboard-2";
      const res = await postJson("/api/v1/demo/web", { screenId: screenA, url });
      expect(res.status).toBe(200);
      const render = await playerScreenA.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => s.id === "demo-web" && s.url === url),
        "second demo/web render",
      );
      expect(render.slice.surfaces.length).toBe(1);
      expect(render.slice.surfaces[0].id).toBe("demo-web");
      expect(render.slice.surfaces[0].url).toBe(url);
    },
    TEST_TIMEOUT,
  );

  test(
    "an invalid /demo/web body is rejected with 400",
    async () => {
      // Missing `url` — fails the body schema at the edge.
      const res = await postJson("/api/v1/demo/web", { screenId: screenA });
      expect(res.status).toBe(400);
      await res.body?.cancel();
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase 2a — multi-machine registry, admin channel, rename, ident, offline
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 2a", () => {
  test(
    "two machines appear in admin/state, one screen each, both online",
    async () => {
      // machine-a is already connected (phase 1). Bring up a second machine.
      const second = await connectAgent("machine-b", "HDMI-1");
      agentB = second.client;
      screenB = second.apply.screens[0].screenId;
      expect(screenB).toBe("screen-2"); // ids stay sequential GLOBALLY across machines

      admin = await connectAdmin();
      const state = await admin.waitFor(
        (m) =>
          m.t === "admin/state" &&
          Array.isArray(m.machines) &&
          m.machines.some((mm: Frame) => mm.id === "machine-a") &&
          m.machines.some((mm: Frame) => mm.id === "machine-b"),
        "admin/state listing both machines",
      );

      const a = state.machines.find((mm: Frame) => mm.id === "machine-a");
      const b = state.machines.find((mm: Frame) => mm.id === "machine-b");
      expect(a.online).toBe(true);
      expect(b.online).toBe(true);
      expect(a.screens.length).toBe(1);
      expect(b.screens.length).toBe(1);
      expect(a.screens[0].id).toBe(screenA);
      expect(b.screens[0].id).toBe(screenB);
      expect(typeof state.revision).toBe("number");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /api/v1/machines lists both machines",
    async () => {
      const res = await fetch(`${BASE}/api/v1/machines`);
      expect(res.status).toBe(200);
      const machines = (await res.json()) as Frame[];
      expect(Array.isArray(machines)).toBe(true);
      const ids = machines.map((m) => m.id);
      expect(ids).toContain("machine-a");
      expect(ids).toContain("machine-b");
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /screens/:id/rename is reflected in a later admin/state broadcast",
    async () => {
      const friendlyName = "Nessie";
      const res = await postJson(`/api/v1/screens/${screenB}/rename`, { friendlyName });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const state = await admin.waitFor(
        (m) =>
          m.t === "admin/state" &&
          Array.isArray(m.machines) &&
          m.machines.some((mm: Frame) =>
            mm.screens?.some((s: Frame) => s.id === screenB && s.friendlyName === friendlyName),
          ),
        "admin/state with renamed screen",
      );
      const renamed = state.machines
        .flatMap((mm: Frame) => mm.screens)
        .find((s: Frame) => s.id === screenB);
      expect(renamed.friendlyName).toBe(friendlyName);
    },
    TEST_TIMEOUT,
  );

  test(
    "renaming an unknown screen returns 404",
    async () => {
      const res = await postJson("/api/v1/screens/screen-does-not-exist/rename", {
        friendlyName: "Ghost",
      });
      expect(res.status).toBe(404);
      await res.body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /screens/:id/ident {on:true} pushes server/ident-pulse to that screen's player",
    async () => {
      // A player must be watching screen-b to receive the visible ident pulse (server → player).
      const { client: playerB } = await connectPlayer(screenB);
      const res = await postJson(`/api/v1/screens/${screenB}/ident`, { on: true });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const pulse = await playerB.waitFor(
        (m) => m.t === "server/ident-pulse" && m.on === true,
        "server/ident-pulse on",
      );
      expect(pulse.on).toBe(true);
      expect(typeof pulse.friendlyName).toBe("string");
      expect(pulse.friendlyName.length).toBeGreaterThan(0);
      expect(typeof pulse.color).toBe("string");
    },
    TEST_TIMEOUT,
  );

  test(
    "ident with ttlMs auto-sends the off pulse",
    async () => {
      const { client: playerB } = await connectPlayer(screenB);
      const res = await postJson(`/api/v1/screens/${screenB}/ident`, { on: true, ttlMs: 120 });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      // The on-pulse fires immediately; the auto-off lands after the ttl.
      await playerB.waitFor((m) => m.t === "server/ident-pulse" && m.on === true, "ttl ident on");
      const off = await playerB.waitFor(
        (m) => m.t === "server/ident-pulse" && m.on === false,
        "ttl ident auto-off",
        4_000,
      );
      expect(off.on).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "ident on an unknown screen returns 404",
    async () => {
      const res = await postJson("/api/v1/screens/screen-does-not-exist/ident", { on: true });
      expect(res.status).toBe(404);
      await res.body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "closing an agent WS flips that machine to online=false in a later admin/state",
    async () => {
      agentB.close();
      const state = await admin.waitFor(
        (m) =>
          m.t === "admin/state" &&
          Array.isArray(m.machines) &&
          m.machines.some((mm: Frame) => mm.id === "machine-b" && mm.online === false),
        "admin/state with machine-b offline",
        5_000,
      );
      const b = state.machines.find((mm: Frame) => mm.id === "machine-b");
      expect(b.online).toBe(false);
      // machine-a's agent is still connected, so it must remain online.
      const a = state.machines.find((mm: Frame) => mm.id === "machine-a");
      expect(a.online).toBe(true);
    },
    TEST_TIMEOUT,
  );
});
