/**
 * @polyptic/e2e — ON-SCREEN INSPECTOR suite (POL-50) against the REAL control plane.
 *
 * Spawns the actual server (`packages/server/src/index.ts`) via `Bun.spawn` in OPEN mode (no
 * POLYPTIC_BOOTSTRAP_TOKEN → agents auto-register + auto-approve, screens created) on its own PORT
 * (8102) against the MemoryStore (STORE=memory), then drives the operator route exactly as the
 * console does:
 *
 *   POST /api/v1/screens/:id/inspect {on}  — a `server/inspect` frame reaches THAT screen's machine,
 *                                            naming that screen's connector (and no other machine).
 *   202, not 200                           — the request is delivered, not applied. Only the box knows
 *                                            whether surf relaunched and took the keystroke.
 *   agent/inspect-ack                      — the SOLE writer of `ScreenView.inspecting`. An `ok:false`
 *                                            ack must CLEAR the flag and explain itself in the feed, so
 *                                            the console can never badge an inspector that isn't on the
 *                                            glass.
 *   the flag is ephemeral                  — a machine that drops loses it; its panels came back sealed.
 *   409 offline / 404 unknown / 400 body.
 *
 * The agent's own refusal logic (dev-open owns no browser; no xdotool) is exercised in the agent unit
 * tests — here the "agent" is a raw socket, so it acks whatever we choose.
 *
 * Independent of the other e2e suites (own port + fresh store): polyptych (8090), enrollment (8091),
 * murals (8092), walls (8093), content (8094), remove (8100), reboot (8101). All must stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8102;
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

const openClients: WsClient[] = [];

/** Connect an agent and return it plus the screenId the server minted for its single output. */
async function openAgent(machineId: string, connector: string): Promise<{ client: WsClient; screenId: string }> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  client.send(agentHello(machineId, connector));
  const apply = await client.waitFor(
    (m) => m.t === "server/apply" && m.machineId === machineId,
    `server/apply for ${machineId}`,
  );
  return { client, screenId: apply.screens[0].screenId };
}

async function connectAdmin(): Promise<WsClient> {
  const client = await WsClient.connect(`${WS}/admin`);
  openClients.push(client);
  client.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  return client;
}

/** Pull one screen's view out of an `admin/state` snapshot. */
function screenIn(state: Frame, screenId: string): Frame | undefined {
  for (const m of state.machines) {
    const s = m.screens.find((x: Frame) => x.id === screenId);
    if (s) return s;
  }
  return undefined;
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
      CAPTURE_INTERVAL_MS: "0",
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

const MACHINE_A = "inspect-host-a";
const MACHINE_B = "inspect-host-b"; // a bystander: must never see MACHINE_A's inspect
const CONNECTOR_A = "DP-3";

let agentA: WsClient;
let agentB: WsClient;
let screenA = "";
let screenB = "";

// ─────────────────────────────────────────────────────────────────────────────
// On-screen inspector — POL-50
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-50 on-screen inspector (open mode)", () => {
  test(
    "POST /screens/:id/inspect delivers server/inspect to THAT machine, naming that screen's connector",
    async () => {
      ({ client: agentA, screenId: screenA } = await openAgent(MACHINE_A, CONNECTOR_A));
      ({ client: agentB, screenId: screenB } = await openAgent(MACHINE_B, "HDMI-9"));

      const res = await postJson(`/api/v1/screens/${screenA}/inspect`, { on: true });
      // 202: delivered, not applied — the ack decides the outcome.
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ ok: true, screenId: screenA, on: true, delivered: 1 });

      const frame = await agentA.waitFor((m) => m.t === "server/inspect", "server/inspect for machine-a");
      expect(frame.connector).toBe(CONNECTOR_A);
      expect(frame.on).toBe(true);

      // Popping an inspector on one wall must not pop it on another.
      expect(await agentB.sawWithin((m) => m.t === "server/inspect", 400)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "the screen is NOT marked inspecting until the agent acks — the click is a request, not the truth",
    async () => {
      const admin = await connectAdmin();
      const before = await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");
      expect(screenIn(before, screenA)?.inspecting).toBe(false);

      agentA.send({
        t: "agent/inspect-ack",
        machineId: MACHINE_A,
        connector: CONNECTOR_A,
        on: true,
        ok: true,
      });

      const after = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.inspecting === true,
        "admin/state with the screen inspecting",
        4_000,
      );
      expect(screenIn(after, screenA)?.inspecting).toBe(true);
      // The bystander screen is untouched.
      expect(screenIn(after, screenB)?.inspecting).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a FAILED ack clears the flag and explains itself — the console never badges an absent inspector",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      agentA.send({
        t: "agent/inspect-ack",
        machineId: MACHINE_A,
        connector: CONNECTOR_A,
        on: false,
        ok: false,
        reason: "xdotool not found",
      });

      const state = await admin.waitFor(
        (m) =>
          m.t === "admin/state" &&
          Array.isArray(m.activity) &&
          m.activity.some((e: Frame) => String(e.text).includes("Could not open the inspector")),
        "admin/state carrying the refusal",
        4_000,
      );
      expect(screenIn(state, screenA)?.inspecting).toBe(false);
      const refusal = state.activity.find((e: Frame) =>
        String(e.text).includes("Could not open the inspector"),
      );
      expect(refusal.severity).toBe("bad");
      expect(refusal.text).toContain("xdotool not found");

      // …and the reason is carried ON THE SCREEN, not just in the feed. A refusal leaves `inspecting`
      // false — unchanged — so this field is the only edge the console can see; without it its Inspect
      // button spins until it times out.
      expect(screenIn(state, screenA)?.inspectError).toContain("xdotool not found");
    },
    TEST_TIMEOUT,
  );

  test(
    "a fresh request CLEARS the previous refusal, so the operator sees this attempt, not the last one",
    async () => {
      const admin = await connectAdmin();
      const start = await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");
      expect(screenIn(start, screenA)?.inspectError).toContain("xdotool");

      const res = await postJson(`/api/v1/screens/${screenA}/inspect`, { on: true });
      expect(res.status).toBe(202);

      const cleared = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.inspectError === undefined,
        "admin/state with the stale refusal cleared",
        4_000,
      );
      expect(screenIn(cleared, screenA)?.inspectError).toBeUndefined();
      await agentA.waitFor((m) => m.t === "server/inspect", "the re-request reached the agent");
    },
    TEST_TIMEOUT,
  );

  test(
    "turning it off acks back to not-inspecting",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      // On…
      agentA.send({ t: "agent/inspect-ack", machineId: MACHINE_A, connector: CONNECTOR_A, on: true, ok: true });
      await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.inspecting === true,
        "inspecting=true",
        4_000,
      );

      // …and off.
      const res = await postJson(`/api/v1/screens/${screenA}/inspect`, { on: false });
      expect(res.status).toBe(202);
      const frame = await agentA.waitFor((m) => m.t === "server/inspect" && m.on === false, "inspect off");
      expect(frame.connector).toBe(CONNECTOR_A);

      agentA.send({ t: "agent/inspect-ack", machineId: MACHINE_A, connector: CONNECTOR_A, on: false, ok: true });
      const off = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.inspecting === false,
        "inspecting=false",
        4_000,
      );
      expect(screenIn(off, screenA)?.inspecting).toBe(false);
      expect(screenIn(off, screenA)?.inspectError).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "the flag is EPHEMERAL: a machine that drops comes back sealed, not badged",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      agentA.send({ t: "agent/inspect-ack", machineId: MACHINE_A, connector: CONNECTOR_A, on: true, ok: true });
      await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.inspecting === true,
        "inspecting=true before the drop",
        4_000,
      );

      agentA.close();
      await agentA.waitForClose();

      const dropped = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.inspecting === false,
        "inspecting cleared after the machine dropped",
        4_000,
      );
      expect(screenIn(dropped, screenA)?.inspecting).toBe(false);
      expect(screenIn(dropped, screenA)?.inspectError).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "409 when the screen's machine is OFFLINE — an undelivered request is not a delivered one",
    async () => {
      await sleep(150); // agentA closed above; let the server drop it from the agent hub
      const res = await postJson(`/api/v1/screens/${screenA}/inspect`, { on: true });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain("offline");
    },
    TEST_TIMEOUT,
  );

  test(
    "404 on an unknown screen",
    async () => {
      const res = await postJson("/api/v1/screens/no-such-screen/inspect", { on: true });
      expect(res.status).toBe(404);
      expect(await errorOf(res)).toContain("unknown screen");
    },
    TEST_TIMEOUT,
  );

  test(
    "400 on a malformed body (the boundary is parsed, like every other)",
    async () => {
      const res = await postJson(`/api/v1/screens/${screenB}/inspect`, { on: "yes" });
      expect(res.status).toBe(400);
    },
    TEST_TIMEOUT,
  );
});
