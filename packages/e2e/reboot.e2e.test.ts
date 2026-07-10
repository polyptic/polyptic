/**
 * @polyptic/e2e — REBOOT-FROM-THE-CONTROL-PLANE suite (POL-55) against the REAL control plane.
 *
 * Spawns the actual server (`packages/server/src/index.ts`) via `Bun.spawn` in OPEN mode (no
 * POLYPTIC_BOOTSTRAP_TOKEN → agents auto-register + auto-approve, screens created) on its own PORT
 * (8101) against the MemoryStore (STORE=memory), then drives the new operator route exactly as the
 * console does:
 *
 *   POST /api/v1/machines/:id/reboot  — a `server/reboot` frame reaches THAT machine's live agent
 *                                       socket (and no other), carrying the operator's reason.
 *   the agent's `agent/reboot-ack`    — an ACCEPTED ack is quiet; a REFUSED one (the box declined, e.g.
 *                                       a dev backend with no privileged helper) lands in the activity
 *                                       feed with its reason, because the operator's click did nothing.
 *   409 on an OFFLINE machine         — an undelivered reboot must never look like a delivered one.
 *   404 on an unknown machine.
 *
 * The real agent's own refusal logic (dev-open never reboots a developer's laptop) is unit-tested in
 * packages/agent/test/host.test.ts — here the "agent" is a raw socket, so it acks whatever we choose.
 *
 * Independent of the other e2e suites (own port + fresh store): polyptych (8090), enrollment (8091),
 * murals (8092), walls (8093), content (8094), remove (8100). All must stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8101;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client: never miss a frame between awaits. (Same shape as the other suites.)
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

/** A REST error body: every 4xx/409 in this suite answers `{ error: "<a sentence for the operator>" }`. */
async function errorOf(res: Response): Promise<string> {
  const payload = (await res.json()) as { error?: unknown };
  return String(payload.error ?? "");
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

function adminHello(): unknown {
  return { t: "admin/hello", protocol: PROTOCOL_VERSION };
}

const openClients: WsClient[] = [];

async function openAgent(machineId: string): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  client.send(agentHello(machineId, "HDMI-1"));
  await client.waitFor(
    (m) => m.t === "server/apply" && m.machineId === machineId,
    `server/apply for ${machineId}`,
  );
  return client;
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

const MACHINE_A = "reboot-host-a"; // the machine we reboot
const MACHINE_B = "reboot-host-b"; // a bystander: must never see MACHINE_A's reboot
let agentA: WsClient;
let agentB: WsClient;

// ─────────────────────────────────────────────────────────────────────────────
// Reboot from the control plane — POL-55
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-55 reboot from the control plane (open mode)", () => {
  test(
    "POST /machines/:id/reboot delivers server/reboot to THAT agent only, with the operator's reason",
    async () => {
      agentA = await openAgent(MACHINE_A);
      agentB = await openAgent(MACHINE_B);

      const res = await postJson(`/api/v1/machines/${MACHINE_A}/reboot`, {
        reason: "wedged after a power blip",
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ ok: true, machineId: MACHINE_A, delivered: 1 });

      const frame = await agentA.waitFor((m) => m.t === "server/reboot", "server/reboot for machine-a");
      expect(frame.reason).toBe("wedged after a power blip");

      // The reboot is addressed at one box: the other machine's agent must not be power-cycled too.
      expect(await agentB.sawWithin((m) => m.t === "server/reboot", 400)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a reboot with no reason still reaches the agent, carrying the server's default",
    async () => {
      const res = await postJson(`/api/v1/machines/${MACHINE_A}/reboot`);
      expect(res.status).toBe(200);

      const frame = await agentA.waitFor((m) => m.t === "server/reboot", "default-reason server/reboot");
      expect(frame.reason).toContain("operator");
    },
    TEST_TIMEOUT,
  );

  test(
    "an ACCEPTED agent/reboot-ack is quiet — the box is going down, and its socket close speaks for it",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      agentA.send({ t: "agent/reboot-ack", machineId: MACHINE_A, accepted: true });

      // No "refused" line may appear. (The "Rebooting …" line the REST route pushes is separate, and
      // is asserted below — here we only care that an accepted ack adds no failure noise.)
      const sawRefusal = await admin.sawWithin(
        (m) =>
          m.t === "admin/state" &&
          Array.isArray(m.activity) &&
          m.activity.some((e: Frame) => String(e.text).includes("refused to reboot")),
        600,
      );
      expect(sawRefusal).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a REFUSED agent/reboot-ack surfaces in the activity feed, with the box's reason",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      agentA.send({
        t: "agent/reboot-ack",
        machineId: MACHINE_A,
        accepted: false,
        reason: "the dev-open backend runs on a developer's own machine",
      });

      // A refused reboot leaves the box up, so no presence edge follows to carry the news: the refusal
      // must broadcast an admin/state by itself, or the operator never learns their click did nothing.
      const state = await admin.waitFor(
        (m) =>
          m.t === "admin/state" &&
          Array.isArray(m.activity) &&
          m.activity.some((e: Frame) => String(e.text).includes("refused to reboot")),
        "admin/state carrying the refusal",
        4_000,
      );
      const refusal = state.activity.find((e: Frame) => String(e.text).includes("refused to reboot"));
      expect(refusal.severity).toBe("bad");
      expect(refusal.text).toContain("developer's own machine");

      // …and the operator's own clicks (the reboots above) were logged as they happened.
      expect(state.activity.some((e: Frame) => String(e.text).startsWith("Rebooting "))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "409 when the machine is approved but OFFLINE — an undelivered reboot is not a delivered one",
    async () => {
      agentB.close();
      await agentB.waitForClose();
      await sleep(150); // let the server drop it from the agent hub

      const res = await postJson(`/api/v1/machines/${MACHINE_B}/reboot`);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain("offline");
    },
    TEST_TIMEOUT,
  );

  test(
    "404 on an unknown machine",
    async () => {
      const res = await postJson("/api/v1/machines/no-such-box/reboot");
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toContain("unknown machine");
    },
    TEST_TIMEOUT,
  );

  test(
    "400 on a malformed body (the reason is parsed at the edge, like every other boundary)",
    async () => {
      const res = await postJson(`/api/v1/machines/${MACHINE_A}/reboot`, { reason: 42 });
      expect(res.status).toBe(400);
    },
    TEST_TIMEOUT,
  );
});
