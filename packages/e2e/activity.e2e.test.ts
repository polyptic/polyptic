/**
 * @polyptic/e2e — D25 LIVE ACTIVITY FEED suite against the REAL control plane.
 *
 * D25 adds a bounded, in-memory **ActivityLog** (a ring of ~50 entries, newest first) on the server.
 * The control plane pushes a short, human `ActivityEvent` at notable transitions — a machine going
 * online ("X connected") or unreachable ("X went unreachable"), a screen approved/rejected, content
 * assigned to a screen or wall ("<screen> → <content name>"), a scene applied, panels combined into a
 * wall or a wall split, a wall or screen renamed — and then triggers the existing admin/state
 * broadcast so the right-rail feed in the console updates live. The admin snapshot (`admin/state`) now
 * carries an OPTIONAL `activity: ActivityEvent[]` (newest first, bounded), so older expectations that
 * never mention it keep passing.
 *
 * CONTRACT (locked in packages/protocol):
 *   ActivityEvent = { id:string, at:string (ISO), severity: "info"|"good"|"warn"|"bad", text:string }
 *   ServerToAdminState.activity = ActivityEvent[]  (OPTIONAL; newest first; bounded)
 *
 * We spawn the actual server (`packages/server/src/index.ts`) against the MemoryStore (STORE=memory) on
 * its OWN PORT (8099). With NO `POLYPTIC_BOOTSTRAP_TOKEN` the server runs in OPEN mode: one fake agent
 * reporting TWO outputs is auto-registered + auto-approved, giving two screens — and those very
 * transitions (machine connect, screens existing) are themselves emitted into the activity log. We then
 * drive a real, notable action (assign ad-hoc content to a single screen via
 * `PUT /api/v1/screens/:id/content {url}`) and open a FRESH `/admin` snapshot to assert the feed.
 *
 * Assertions:
 *   - `admin/state.activity` is present and is a NON-EMPTY array (the agent connect alone seeds it);
 *   - EVERY entry is well-shaped: {id:non-empty string, at:non-empty ISO-parseable string,
 *     severity ∈ {info,good,warn,bad}, text:non-empty string};
 *   - the array is newest-first (timestamps are non-increasing);
 *   - after a content assignment, SOME entry mentions the target screen's friendly name (the
 *     "<screen> → <content name>" line), proving content assignment emits activity.
 *
 * Robustness: every WS read is buffered (a frame that arrives between awaits is never missed) and
 * carries a per-message timeout. For each state assertion we open a FRESH `/admin` connection and read
 * its first `admin/state` — a brand-new client's snapshot always reflects CURRENT server state. The
 * server process is torn down in `afterAll`.
 *
 * This suite is independent of the other e2e suites (each on its own port + fresh memory store):
 * polyptych (8090), enrollment (8091), murals (8092), walls (8093), content (8094). All must stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8099;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "activity-host-1";

const RES_W = 1920;
const RES_H = 1080;

const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";

const SEVERITIES = new Set(["info", "good", "warn", "bad"]);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client: never miss a frame between awaits.
//
// Frames are parsed as soon as they arrive and either handed to a waiting predicate or queued.
// `waitFor` first scans the queue (so an already-delivered frame still satisfies a later wait),
// then parks a waiter with a per-message timeout.
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

async function putJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Drain a response body so the socket is released (we never read most bodies). */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire-shape builders (contract "t" values + field names, validated server-side)
// ─────────────────────────────────────────────────────────────────────────────

function agentHello(
  machineId: string,
  outputs: Array<{ connector: string; width: number; height: number }>,
): unknown {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs,
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

async function openAgent(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  return client;
}

/** Open a fake player for a screen and read its initial server/render. */
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

/**
 * Open a FRESH /admin connection, send admin/hello, and return its first admin/state snapshot.
 * A brand-new client's first snapshot always reflects CURRENT server state, so we never race a stale
 * broadcast.
 */
async function snapshot(label: string, timeoutMs = 4_000): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send(adminHello());
  const state = await admin.waitFor((m) => m.t === "admin/state", label, timeoutMs);
  admin.close();
  return state;
}

/** Pull the friendly name of a screen out of an admin/state snapshot. */
function friendlyNameOf(state: Frame, screenId: string): string {
  for (const machine of state.machines ?? []) {
    for (const screen of machine.screens ?? []) {
      if (screen.id === screenId) return String(screen.friendlyName);
    }
  }
  throw new Error(`screen ${screenId} not found in admin/state`);
}

/** Assert one ActivityEvent is well-shaped per the locked contract. */
function expectWellShaped(ev: Frame): void {
  expect(typeof ev.id).toBe("string");
  expect(ev.id.length).toBeGreaterThan(0);
  expect(typeof ev.at).toBe("string");
  expect(ev.at.length).toBeGreaterThan(0);
  // `at` is an ISO timestamp → must parse to a real instant.
  expect(Number.isNaN(Date.parse(ev.at))).toBe(false);
  expect(typeof ev.severity).toBe("string");
  expect(SEVERITIES.has(ev.severity)).toBe(true);
  expect(typeof ev.text).toBe("string");
  expect(ev.text.length).toBeGreaterThan(0);
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

// Shared across the ordered flow below (bun runs tests in source order, sequentially).
let screenA = "";
let screenB = "";
let nameA = "";

let playerA: WsClient;

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // No POLYPTIC_BOOTSTRAP_TOKEN → OPEN mode: the fake agent is auto-registered + auto-approved,
      // so its screens exist and the connect transition seeds the activity log.
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  // One agent, TWO outputs → two screens (server/apply lists both).
  const agent = await openAgent();
  agent.send(
    agentHello(MACHINE_ID, [
      { connector: CONN_A, width: RES_W, height: RES_H },
      { connector: CONN_B, width: RES_W, height: RES_H },
    ]),
  );
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply for activity-host-1",
    5_000,
  );
  expect(Array.isArray(apply.screens)).toBe(true);
  expect(apply.screens.length).toBe(2);

  const byConnector = (connector: string): string => {
    const entry = apply.screens.find((s: Frame) => s.connector === connector);
    expect(entry).toBeDefined();
    expect(typeof entry.screenId).toBe("string");
    expect(entry.screenId.length).toBeGreaterThan(0);
    return entry.screenId;
  };
  screenA = byConnector(CONN_A);
  screenB = byConnector(CONN_B);

  // A fake player for screen A so the content push has somewhere to land.
  playerA = await connectPlayer(screenA);

  const seeded = await snapshot("admin/state for screen friendly names");
  nameA = friendlyNameOf(seeded, screenA);
  expect(nameA.length).toBeGreaterThan(0);
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
// D25 — the Live Activity feed
// ─────────────────────────────────────────────────────────────────────────────

describe("D25 live activity feed", () => {
  test(
    "admin/state carries a non-empty activity[] of well-shaped, newest-first events",
    async () => {
      // The agent connect (machine online) + its screens existing already seeded the log.
      const state = await snapshot("admin/state with seeded activity");
      expect(Array.isArray(state.activity)).toBe(true);
      expect(state.activity.length).toBeGreaterThan(0);

      for (const ev of state.activity) expectWellShaped(ev);

      // Newest first → timestamps are non-increasing down the list.
      const times = state.activity.map((e: Frame) => Date.parse(e.at));
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "assigning content to a screen emits an activity event naming that screen",
    async () => {
      const url = "https://example.com/activity-content-a";
      const res = await putJson(`/api/v1/screens/${screenA}/content`, { url });
      expect(res.status).toBe(200);
      await drain(res);

      // The player gets its render (confirms the action really happened end-to-end).
      await playerA.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => s.url === url),
        "content render for A",
      );

      const state = await snapshot("admin/state after content assignment");
      expect(Array.isArray(state.activity)).toBe(true);
      expect(state.activity.length).toBeGreaterThan(0);
      for (const ev of state.activity) expectWellShaped(ev);

      // The newest entry is the freshest event — and the assignment is recorded as a line that names
      // the target screen ("<screen> → <content name>", per the D25 model).
      const mentionsScreen = state.activity.some((e: Frame) => e.text.includes(nameA));
      expect(mentionsScreen).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "the activity feed is bounded (a sane ring, not an unbounded log)",
    async () => {
      // Hammer a series of real content swaps; the ring keeps newest-first and stays bounded (~50).
      for (let i = 0; i < 12; i++) {
        const put = await putJson(`/api/v1/screens/${screenA}/content`, {
          url: `https://example.com/activity-burst-${i}`,
        });
        expect(put.status).toBe(200);
        await drain(put);
      }

      const state = await snapshot("admin/state after a burst of activity");
      expect(Array.isArray(state.activity)).toBe(true);
      expect(state.activity.length).toBeGreaterThan(0);
      // Bounded ring: never grows without limit. 200 is a generous ceiling around the ~50 target.
      expect(state.activity.length).toBeLessThanOrEqual(200);
      for (const ev of state.activity) expectWellShaped(ev);

      // Still newest-first after the burst.
      const times = state.activity.map((e: Frame) => Date.parse(e.at));
      for (let i = 1; i < times.length; i++) {
        expect(times[i - 1]).toBeGreaterThanOrEqual(times[i]);
      }
    },
    TEST_TIMEOUT,
  );
});
