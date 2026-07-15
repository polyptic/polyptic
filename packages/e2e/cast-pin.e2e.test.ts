/**
 * @polyptic/e2e — POL-136 AIRPLAY PAIRING PIN suite against the REAL control plane.
 *
 * The receiver prints its pairing PIN to stdout only — it never draws a window until MIRRORING
 * starts — so the agent learns it there and the PLAYER paints it (D117, correcting D111's "the PIN
 * prompt is a window too"). This suite pins the server glue between those two ends:
 *
 *   agent/status.screens[].castPin  →  Presence  →  server/cast-pin  →  the player overlay
 *
 * Assertions:
 *   - a status report carrying `castPin` pushes `server/cast-pin {pin}` to that screen's player;
 *   - the level report is edge-detected: repeating the same PIN pushes nothing new;
 *   - a player that connects MID-pairing receives the replayed PIN right after its first render
 *     (cold boot / reconnect during pairing must still show the code);
 *   - the activity feed carries the pairing line (a remote operator can relay the PIN);
 *   - a status report withOUT `castPin` clears the overlay (`pin: null`) on every player;
 *   - the agent socket DYING mid-pairing clears the overlay too (the receiver died with the box).
 *
 * We spawn the actual server (`packages/server/src/index.ts`) against the MemoryStore (STORE=memory)
 * on its OWN PORT (8118). With NO `POLYPTIC_BOOTSTRAP_TOKEN` the server runs in OPEN mode: one fake
 * agent reporting ONE output is auto-registered + auto-approved, giving one screen.
 *
 * Robustness: every WS read is buffered (a frame that arrives between awaits is never missed) and
 * carries a per-message timeout. The server process is torn down in `afterAll`. This suite is
 * independent of the other e2e suites (each on its own port + fresh memory store).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8118;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "cast-pin-host-1";
const CONN = "HDMI-1";
const PIN = "0417"; // leading zero on purpose — the wire must not eat the padding

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

  /** True when a matching frame is ALREADY queued (checks nothing in the future). */
  hasQueued(pred: Predicate): boolean {
    return this.queue.some(pred);
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
// Wire-shape builders
// ─────────────────────────────────────────────────────────────────────────────

function agentHello(): unknown {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId: MACHINE_ID,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector: CONN, width: 1920, height: 1080 }],
  };
}

/** An agent status frame, optionally carrying a pairing PIN for the sole connector. */
function agentStatus(castPin?: string): unknown {
  return {
    t: "agent/status",
    machineId: MACHINE_ID,
    observedRevision: 0,
    screens: [{ connector: CONN, ok: true, casting: false, ...(castPin ? { castPin } : {}) }],
  };
}

function playerHello(screenId: string): unknown {
  return { t: "player/hello", protocol: PROTOCOL_VERSION, screenId };
}

const isCastPin = (pin: string | null): Predicate =>
  (m) => m.t === "server/cast-pin" && m.pin === pin;

// ─────────────────────────────────────────────────────────────────────────────
// Server + connection lifecycle
// ─────────────────────────────────────────────────────────────────────────────

const openClients: WsClient[] = [];

async function connectPlayer(screenId: string): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/player`);
  openClients.push(client);
  client.send(playerHello(screenId));
  await client.waitFor(
    (m) => m.t === "server/render" && m.slice?.screenId === screenId,
    `initial server/render for ${screenId}`,
    5_000,
  );
  return client;
}

async function connectAdmin(): Promise<WsClient> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  await admin.waitFor((m) => m.t === "admin/state", "first admin/state", 4_000);
  return admin;
}

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

// Shared across the ordered flow (bun runs tests in source order, sequentially).
let agent: WsClient;
let player: WsClient;
let screenId = "";

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  agent = await WsClient.connect(`${WS}/agent`);
  openClients.push(agent);
  agent.send(agentHello());
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply",
    5_000,
  );
  screenId = apply.screens[0].screenId;
  expect(screenId.length).toBeGreaterThan(0);

  player = await connectPlayer(screenId);
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

// ─────────────────────────────────────────────────────────────────────────────
// POL-136 — the PIN's journey from a status report to the glass
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-136 cast pairing PIN: agent/status → server/cast-pin → player", () => {
  test(
    "a status report carrying castPin paints the player overlay, zero-padding intact",
    async () => {
      agent.send(agentStatus(PIN));
      const frame = await player.waitFor(isCastPin(PIN), `server/cast-pin ${PIN}`);
      expect(frame.pin).toBe(PIN); // "0417", never 417
    },
    TEST_TIMEOUT,
  );

  test(
    "the level report is edge-detected: repeating the same PIN pushes nothing new",
    async () => {
      agent.send(agentStatus(PIN)); // the heartbeat repeats the level
      await sleep(300); // give a (wrong) duplicate time to arrive
      expect(player.hasQueued((m) => m.t === "server/cast-pin")).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a player connecting MID-pairing gets the PIN replayed right after its first render",
    async () => {
      const latecomer = await connectPlayer(screenId);
      const frame = await latecomer.waitFor(isCastPin(PIN), "replayed server/cast-pin");
      expect(frame.pin).toBe(PIN);
      latecomer.close();
    },
    TEST_TIMEOUT,
  );

  test(
    "the activity feed announces the pairing but NEVER carries the PIN itself",
    async () => {
      // The feed rides every admin/state snapshot and lingers in the ring long after pairing —
      // a PIN there would leak proof-of-physical-presence to anyone who can see the console
      // (PR #118 finding 2). The code travels the gated player channel and the box journal only.
      const admin = await connectAdmin();
      const state = await (async () => {
        admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
        return admin.waitFor((m) => m.t === "admin/state", "admin/state with pairing line", 4_000);
      })();
      const texts = (state.activity ?? []).map((e: Frame) => String(e.text));
      expect(texts.some((t: string) => t.includes("AirPlay pairing"))).toBe(true);
      expect(texts.some((t: string) => t.includes(PIN))).toBe(false);
      admin.close();
    },
    TEST_TIMEOUT,
  );

  test(
    "a status report without castPin clears the overlay",
    async () => {
      agent.send(agentStatus()); // pairing over — the level report simply stops carrying the PIN
      const frame = await player.waitFor(isCastPin(null), "server/cast-pin clear");
      expect(frame.pin).toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "the agent socket dying mid-pairing clears the overlay (the receiver died with the box)",
    async () => {
      agent.send(agentStatus(PIN)); // a new pairing begins…
      await player.waitFor(isCastPin(PIN), "server/cast-pin before the box dies");
      agent.close(); // …and the box drops mid-pairing
      const frame = await player.waitFor(isCastPin(null), "server/cast-pin clear on agent close", 5_000);
      expect(frame.pin).toBeNull();
    },
    TEST_TIMEOUT,
  );
});
