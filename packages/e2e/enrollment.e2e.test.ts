/**
 * @polyptic/e2e — GATED enrollment suite (Phase 2b) against the REAL control plane.
 *
 * We spawn the actual server (`packages/server/src/index.ts`) with `Bun.spawn`, this time with
 * POLYPTIC_BOOTSTRAP_TOKEN set so the server runs in GATED mode (not the dev-default OPEN mode),
 * on its own PORT (8091) against the MemoryStore (STORE=memory). We poll `/api/v1/state` until it
 * answers, then drive the device-enrollment flow exactly like a fleet would: raw `/agent` WebSockets
 * as fake agents, `/admin` for the operator view, and REST mutations over `fetch`.
 *
 * NOTE: OPEN-mode behaviour (no bootstrap token → agents auto-registered AND auto-approved, screens
 * created, server/apply sent — the Phase 2a behaviour) is covered by polyptic.e2e.test.ts, which
 * runs the same server on PORT 8090 with NO POLYPTIC_BOOTSTRAP_TOKEN. This file deliberately only
 * exercises the GATED path, so the two suites stay independent and both must remain green.
 *
 * Coverage (GATED MODE):
 *   - new agent /agent hello with a VALID bootstrapToken (new machine) → server/enrolled (carrying a
 *     durable credential, status "pending") + server/pending, and NO server/apply; admin/state shows
 *     the machine status="pending", outputCount=1, screens=[].
 *   - POST /api/v1/machines/:id/approve → the still-connected fake agent receives server/apply (live
 *     admit); a later admin/state shows status="approved" with exactly one screen.
 *   - a fresh fake agent reconnecting with the issued credential (no bootstrapToken), machine already
 *     approved → server/apply directly.
 *   - hello with a WRONG bootstrapToken and no credential → server/rejected and the WS is closed by
 *     the server.
 *   - hello with NO token and NO credential → server/rejected and the WS is closed by the server.
 *   - POST /api/v1/machines/:id/reject on a live pending machine → that agent receives server/rejected
 *     and the server closes its WS.
 *   - POST approve / reject on an unknown machine → 404.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8091;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const BOOTSTRAP_TOKEN = "test-token";
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
// then parks a waiter with a per-message timeout. `waitForClose` lets a test assert that the SERVER
// closed the socket (the rejection path), independent of frame timing.
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
// REST helpers
// ─────────────────────────────────────────────────────────────────────────────

function postJson(path: string, body?: unknown): Promise<Response> {
  // A body-less POST (e.g. approve) is sent with NO content-type so Fastify's JSON parser does not
  // reject an empty body; only requests that actually carry JSON set content-type: application/json.
  if (body === undefined) {
    return fetch(`${BASE}${path}`, { method: "POST" });
  }
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire-shape builders (contract "t" values + field names, validated server-side)
// ─────────────────────────────────────────────────────────────────────────────

function baseHello(machineId: string, connector: string, width = 1920, height = 1080): Frame {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector, width, height }],
  };
}

function helloWithToken(machineId: string, connector: string, token: string): Frame {
  return { ...baseHello(machineId, connector), bootstrapToken: token };
}

function helloWithCredential(machineId: string, connector: string, credential: string): Frame {
  return { ...baseHello(machineId, connector), credential };
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

async function connectAdmin(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/admin`);
  openClients.push(client);
  client.send(adminHello());
  return client;
}

/** Wait for an admin/state snapshot whose machine `id` satisfies `pred`, then return that machine. */
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
      // The presence of this token is what flips the server from OPEN (dev) to GATED enrollment.
      POLYPTIC_BOOTSTRAP_TOKEN: BOOTSTRAP_TOKEN,
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

// Shared across the ordered flow below (bun runs tests in source order, sequentially).
const ENROLL_MACHINE_ID = "enroll-host-1";
const ENROLL_CONNECTOR = "HDMI-1";
let pendingAgent: WsClient; // the first agent — stays connected from enrol → live approve
let issuedCredential = ""; // the durable credential handed back by server/enrolled

// ─────────────────────────────────────────────────────────────────────────────
// Gated enrollment — the heart of Phase 2b
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 2b enrollment (gated mode)", () => {
  test(
    "a new agent with a valid bootstrap token enrolls as pending (enrolled + pending, NO apply)",
    async () => {
      pendingAgent = await openAgent();
      pendingAgent.send(helloWithToken(ENROLL_MACHINE_ID, ENROLL_CONNECTOR, BOOTSTRAP_TOKEN));

      const enrolled = await pendingAgent.waitFor(
        (m) => m.t === "server/enrolled" && m.machineId === ENROLL_MACHINE_ID,
        "server/enrolled",
      );
      expect(enrolled.t).toBe("server/enrolled");
      expect(enrolled.machineId).toBe(ENROLL_MACHINE_ID);
      expect(enrolled.status).toBe("pending");
      expect(typeof enrolled.credential).toBe("string");
      // Durable credential is random 32-byte hex (node:crypto randomBytes(32).toString("hex")).
      expect(enrolled.credential).toMatch(/^[0-9a-f]{64}$/);
      issuedCredential = enrolled.credential;

      const pending = await pendingAgent.waitFor((m) => m.t === "server/pending", "server/pending");
      expect(pending.t).toBe("server/pending");

      // A pending machine must NOT be admitted: no screens, no server/apply on this socket.
      const sawApply = await pendingAgent.sawWithin((m) => m.t === "server/apply", 700);
      expect(sawApply).toBe(false);

      // The connection stays open while it waits for operator approval.
      expect(pendingAgent.isClosed).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "admin/state shows the machine online + pending, outputCount=1, screens=[]",
    async () => {
      const admin = await connectAdmin();
      const machine = await machineFromAdmin(
        admin,
        ENROLL_MACHINE_ID,
        (mm) => mm.status === "pending",
        "admin/state with pending machine",
      );
      expect(machine.status).toBe("pending");
      expect(machine.online).toBe(true);
      expect(machine.outputCount).toBe(1);
      expect(Array.isArray(machine.screens)).toBe(true);
      expect(machine.screens.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /machines/:id/approve live-admits the still-connected agent with server/apply",
    async () => {
      const res = await postJson(`/api/v1/machines/${ENROLL_MACHINE_ID}/approve`);
      expect(res.status).toBe(200);
      await res.body?.cancel();

      // The agent that has been parked in `pending` now receives its placement.
      const apply = await pendingAgent.waitFor(
        (m) => m.t === "server/apply" && m.machineId === ENROLL_MACHINE_ID,
        "server/apply after approve",
        5_000,
      );
      expect(apply.t).toBe("server/apply");
      expect(apply.machineId).toBe(ENROLL_MACHINE_ID);
      expect(Array.isArray(apply.screens)).toBe(true);
      expect(apply.screens.length).toBe(1);
      expect(apply.screens[0].connector).toBe(ENROLL_CONNECTOR);
      expect(typeof apply.screens[0].screenId).toBe("string");
      expect(typeof apply.screens[0].playerUrl).toBe("string");
    },
    TEST_TIMEOUT,
  );

  test(
    "a later admin/state shows the machine approved with exactly one screen",
    async () => {
      const admin = await connectAdmin();
      const machine = await machineFromAdmin(
        admin,
        ENROLL_MACHINE_ID,
        (mm) => mm.status === "approved" && Array.isArray(mm.screens) && mm.screens.length === 1,
        "admin/state with approved machine",
      );
      expect(machine.status).toBe("approved");
      expect(machine.online).toBe(true);
      expect(machine.outputCount).toBe(1);
      expect(machine.screens.length).toBe(1);
      expect(machine.screens[0].connector).toBe(ENROLL_CONNECTOR);
    },
    TEST_TIMEOUT,
  );

  test(
    "a fresh agent reconnecting with the issued credential (approved) gets server/apply directly",
    async () => {
      expect(issuedCredential).toMatch(/^[0-9a-f]{64}$/);
      const agent = await openAgent();
      // No bootstrapToken this time — just the durable credential, as a re-booted agent would present.
      agent.send(helloWithCredential(ENROLL_MACHINE_ID, ENROLL_CONNECTOR, issuedCredential));

      const apply = await agent.waitFor(
        (m) => m.t === "server/apply" && m.machineId === ENROLL_MACHINE_ID,
        "server/apply for credential reconnect",
      );
      expect(apply.machineId).toBe(ENROLL_MACHINE_ID);
      expect(apply.screens.length).toBe(1);
      expect(apply.screens[0].connector).toBe(ENROLL_CONNECTOR);

      // Reconnecting with a valid credential for an approved machine must not re-enrol it.
      const sawEnrolled = await agent.sawWithin((m) => m.t === "server/enrolled", 400);
      expect(sawEnrolled).toBe(false);
      expect(agent.isClosed).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a WRONG bootstrap token (and no credential) is rejected and the server closes the WS",
    async () => {
      const agent = await openAgent();
      agent.send(helloWithToken("reject-wrong-token", "HDMI-1", "definitely-not-the-token"));

      const rejected = await agent.waitFor((m) => m.t === "server/rejected", "server/rejected");
      expect(rejected.t).toBe("server/rejected");
      expect(typeof rejected.reason).toBe("string");

      await agent.waitForClose();
      expect(agent.isClosed).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "NO token and NO credential is rejected and the server closes the WS",
    async () => {
      const agent = await openAgent();
      agent.send(baseHello("reject-no-creds", "HDMI-1"));

      const rejected = await agent.waitFor((m) => m.t === "server/rejected", "server/rejected");
      expect(rejected.t).toBe("server/rejected");
      expect(typeof rejected.reason).toBe("string");

      await agent.waitForClose();
      expect(agent.isClosed).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /machines/:id/reject on a live pending machine rejects + closes that agent's WS",
    async () => {
      const rejectMachineId = "reject-live-1";
      const agent = await openAgent();
      agent.send(helloWithToken(rejectMachineId, "HDMI-1", BOOTSTRAP_TOKEN));

      // It enrols as pending first (credential issued, parked awaiting approval).
      await agent.waitFor(
        (m) => m.t === "server/enrolled" && m.machineId === rejectMachineId,
        "server/enrolled for reject-live",
      );
      await agent.waitFor((m) => m.t === "server/pending", "server/pending for reject-live");

      const res = await postJson(`/api/v1/machines/${rejectMachineId}/reject`, {
        reason: "e2e rejection",
      });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const rejected = await agent.waitFor(
        (m) => m.t === "server/rejected",
        "server/rejected after operator reject",
        5_000,
      );
      expect(rejected.t).toBe("server/rejected");
      expect(typeof rejected.reason).toBe("string");

      await agent.waitForClose();
      expect(agent.isClosed).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST approve on an unknown machine returns 404",
    async () => {
      const res = await postJson("/api/v1/machines/machine-does-not-exist/approve");
      expect(res.status).toBe(404);
      await res.body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "POST reject on an unknown machine returns 404",
    async () => {
      const res = await postJson("/api/v1/machines/machine-does-not-exist/reject", {
        reason: "ghost",
      });
      expect(res.status).toBe(404);
      await res.body?.cancel();
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// POL-117 — manual naming + pre-approval ident
//
// Every netbooted box reports the hostname `localhost.localdomain` (the shared live image), so the
// hostname is never adopted as the machine's label — and a still-PENDING machine can be named and
// told to flash its holding board (over the AGENT channel: `server/pending` re-sent with `&ident=1`
// on the board URL) so the operator knows which physical panel they are approving. Everything ELSE
// stays refused pre-approval: reboot and the shell arm both 409.
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-117 — naming + pre-approval ident", () => {
  const BOX = "dmi-pol117-aabbcc";
  let boxAgent: WsClient;

  test(
    "a live-image hostname is never adopted as the label (admin/state shows the id sentinel)",
    async () => {
      boxAgent = await openAgent();
      boxAgent.send({
        ...helloWithToken(BOX, "DP-1", BOOTSTRAP_TOKEN),
        hostname: "localhost.localdomain",
      });
      await boxAgent.waitFor((m) => m.t === "server/pending", "server/pending for pol117 box");

      const admin = await connectAdmin();
      const machine = await machineFromAdmin(
        admin,
        BOX,
        (mm) => mm.status === "pending",
        "admin/state with pol117 pending machine",
      );
      // The label must NOT be the meaningless hostname — it stays = the machine id (the unnamed
      // sentinel the console renders as "Unnamed box · <tail>").
      expect(machine.label).not.toBe("localhost.localdomain");
      expect(machine.label).toBe(BOX);
    },
    TEST_TIMEOUT,
  );

  test(
    "pending ident reaches the agent channel: server/pending with ident=1, then auto-off",
    async () => {
      const res = await postJson(`/api/v1/machines/${BOX}/ident`, { on: true, ttlMs: 800 });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { ok: boolean; delivered: number };
      expect(payload.ok).toBe(true);
      expect(payload.delivered).toBe(1); // the fake agent's socket

      const on = await boxAgent.waitFor(
        (m) => m.t === "server/pending" && typeof m.pendingUrl === "string" && m.pendingUrl.includes("ident=1"),
        "server/pending with ident=1",
      );
      expect(on.machineId).toBe(BOX);
      expect(on.pendingUrl).toContain(`pending=${encodeURIComponent(BOX)}`);

      // The TTL restores the plain holding board — same frame, no ident marker.
      const off = await boxAgent.waitFor(
        (m) => m.t === "server/pending" && typeof m.pendingUrl === "string" && !m.pendingUrl.includes("ident="),
        "server/pending without ident (ttl off)",
        4_000,
      );
      expect(off.machineId).toBe(BOX);
    },
    TEST_TIMEOUT,
  );

  test(
    "everything else is refused pre-approval: reboot 409, shell arm 409",
    async () => {
      const reboot = await postJson(`/api/v1/machines/${BOX}/reboot`, {});
      expect(reboot.status).toBe(409);
      await reboot.body?.cancel();

      const shell = await postJson(`/api/v1/machines/${BOX}/shell`, { enabled: true });
      expect(shell.status).toBe(409);
      await shell.body?.cancel();

      // ... and the agent saw none of it — no reboot or shell frame slipped through.
      const sawForbidden = await boxAgent.sawWithin(
        (m) => m.t === "server/reboot" || m.t === "server/shell-open",
        600,
      );
      expect(sawForbidden).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "renaming a PENDING machine round-trips: REST 200, admin/state broadcasts the new label live",
    async () => {
      const admin = await connectAdmin();
      const res = await postJson(`/api/v1/machines/${BOX}/rename`, { label: "Lobby Left" });
      expect(res.status).toBe(200);
      const payload = (await res.json()) as { ok: boolean; machine: { label: string } };
      expect(payload.ok).toBe(true);
      expect(payload.machine.label).toBe("Lobby Left");

      // The rename is a registry mutation: every open console hears it on the next broadcast.
      const machine = await machineFromAdmin(
        admin,
        BOX,
        (mm) => mm.label === "Lobby Left",
        "admin/state with renamed machine",
      );
      expect(machine.label).toBe("Lobby Left");
      expect(machine.status).toBe("pending"); // naming never changes enrollment status
    },
    TEST_TIMEOUT,
  );

  test(
    "the operator's name survives the box's next hello (hostname never wins it back)",
    async () => {
      // Re-hello with the same meaningless hostname on a fresh socket (credential re-issue path).
      const again = await openAgent();
      again.send({
        ...helloWithToken(BOX, "DP-1", BOOTSTRAP_TOKEN),
        hostname: "localhost.localdomain",
      });
      await again.waitFor((m) => m.t === "server/pending", "server/pending on re-hello");

      const admin = await connectAdmin();
      const machine = await machineFromAdmin(
        admin,
        BOX,
        (mm) => mm.label === "Lobby Left",
        "admin/state keeps the operator name",
      );
      expect(machine.label).toBe("Lobby Left");
    },
    TEST_TIMEOUT,
  );

  test(
    "rename on an unknown machine returns 404; an empty label is a 400",
    async () => {
      const missing = await postJson("/api/v1/machines/machine-does-not-exist/rename", {
        label: "Ghost",
      });
      expect(missing.status).toBe(404);
      await missing.body?.cancel();

      const empty = await postJson(`/api/v1/machines/${BOX}/rename`, { label: "   " });
      expect(empty.status).toBe(400);
      await empty.body?.cancel();
    },
    TEST_TIMEOUT,
  );
});
