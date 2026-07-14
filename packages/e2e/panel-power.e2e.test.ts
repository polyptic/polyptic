/**
 * @polyptic/e2e — PANEL POWER suite (POL-101) against the REAL control plane.
 *
 * Spawns the actual server (`packages/server/src/index.ts`) via `Bun.spawn` in OPEN mode (no
 * POLYPTIC_BOOTSTRAP_TOKEN → agents auto-register + auto-approve, screens created) on its own PORT
 * (8231) against the MemoryStore (STORE=memory), then drives the operator routes exactly as the
 * console does:
 *
 *   POST /api/v1/screens/:id/power {on}   — a `server/display-power` frame reaches THAT screen's
 *                                           machine, naming that screen's connector (and no other box).
 *   POST /api/v1/machines/:id/power {on}  — one frame per connector the box drives (bulk).
 *   202, not 200                          — delivered, not applied. Only the box knows whether the
 *                                           compositor took the DPMS command.
 *   agent/power-ack                       — the SOLE writer of `ScreenView.asleep`. A refusal must
 *                                           leave the screen AWAKE (never show a wall as dark when it
 *                                           might be lit) and explain itself in the feed.
 *   asleep ≠ offline                      — the load-bearing distinction: a sleeping screen's player is
 *                                           still ONLINE and still holding its content. An operator must
 *                                           never be sent to fix a wall that is doing what they asked.
 *   the flag is EPHEMERAL                 — a machine that drops comes back LIT (the compositor asserts
 *                                           `dpms on` at startup), so "asleep" must not survive it.
 *   PUT  /api/v1/screens/:id/panel-hours  — the daily window; persisted, and reported back on the
 *                                           screen's view.
 *   PUT  /api/v1/settings/panel-power     — the deployment timezone, validated (a typo is a 400 HERE,
 *                                           not a wall that sleeps at the wrong hour six weeks from now).
 *   409 offline / 404 unknown / 400 body.
 *
 * The agent's own refusal logic (dev-open owns no panel; a CEC bus that will not answer) is exercised
 * in the agent unit tests — here the "agent" is a raw socket, so it acks whatever we choose.
 *
 * Independent of the other e2e suites (own port + fresh store): polyptych (8090), enrollment (8091),
 * murals (8092), walls (8093), content (8094), remove (8100), reboot (8101), inspect (8102).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8231;
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

/** A hello carrying the POL-101 power capability, as a real POL-101 agent sends it. */
function agentHello(machineId: string, connectors: string[]): Frame {
  return {
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId,
    agentVersion: "e2e",
    backend: "wayland-sway",
    power: { dpms: true, cec: true },
    outputs: connectors.map((connector) => ({ connector, width: 1920, height: 1080 })),
  };
}

const openClients: WsClient[] = [];

/** Connect an agent driving several outputs; returns it plus the screenIds the server minted. */
async function openAgentMulti(
  machineId: string,
  connectors: string[],
): Promise<{ client: WsClient; screenIds: string[] }> {
  const client = await WsClient.connect(`${WS}/agent`);
  openClients.push(client);
  client.send(agentHello(machineId, connectors));
  const apply = await client.waitFor(
    (m) => m.t === "server/apply" && m.machineId === machineId && m.screens.length === connectors.length,
    `server/apply for ${machineId}`,
  );
  // Keep the caller's connector order, so screenIds line up with the connectors asked for.
  const byConnector = new Map<string, string>(
    apply.screens.map((s: Frame) => [s.connector, s.screenId]),
  );
  return { client, screenIds: connectors.map((c) => byConnector.get(c) as string) };
}

async function openAgent(
  machineId: string,
  connector: string,
): Promise<{ client: WsClient; screenId: string }> {
  const { client, screenIds } = await openAgentMulti(machineId, [connector]);
  return { client, screenId: screenIds[0] as string };
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

const MACHINE_A = "power-host-a";
const MACHINE_B = "power-host-b"; // a bystander: must never receive MACHINE_A's power frames
const CONNECTOR_A = "DP-1";
const CONNECTOR_A2 = "DP-2"; // machine A drives TWO panels, so the bulk route has something to prove

let agentA: WsClient;
let agentB: WsClient;
let screenA = "";
let screenA2 = "";
let screenB = "";

describe("POL-101 manual panel power (open mode)", () => {
  test(
    "POST /screens/:id/power delivers server/display-power to THAT machine + connector",
    async () => {
      const a = await openAgentMulti(MACHINE_A, [CONNECTOR_A, CONNECTOR_A2]);
      agentA = a.client;
      screenA = a.screenIds[0] as string;
      screenA2 = a.screenIds[1] as string;
      ({ client: agentB, screenId: screenB } = await openAgent(MACHINE_B, "HDMI-9"));

      const res = await postJson(`/api/v1/screens/${screenA}/power`, { on: false });
      // 202: delivered, not applied — the ack decides the outcome.
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ ok: true, screenId: screenA, on: false, delivered: 1 });

      const frame = await agentA.waitFor(
        (m) => m.t === "server/display-power",
        "server/display-power for machine-a",
      );
      expect(frame.connector).toBe(CONNECTOR_A);
      expect(frame.on).toBe(false);

      // Sleeping one wall must never darken another.
      expect(await agentB.sawWithin((m) => m.t === "server/display-power", 400)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "the screen is NOT marked asleep until the agent acks — the click is a request, not the truth",
    async () => {
      const admin = await connectAdmin();
      const before = await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");
      expect(screenIn(before, screenA)?.asleep).toBe(false);

      agentA.send({
        t: "agent/power-ack",
        machineId: MACHINE_A,
        connector: CONNECTOR_A,
        on: false,
        ok: true,
        methods: ["dpms", "cec"],
      });

      const after = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.asleep === true,
        "admin/state with the screen asleep",
        4_000,
      );
      const view = screenIn(after, screenA);
      expect(view?.asleep).toBe(true);
      // …and it is HONEST about which rung actually got there.
      expect(view?.powerMethods).toEqual(["dpms", "cec"]);
      // The bystander is untouched.
      expect(screenIn(after, screenB)?.asleep).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "ASLEEP IS NOT OFFLINE — the sleeping screen's machine is still online and healthy",
    async () => {
      const admin = await connectAdmin();
      const state = await admin.waitFor((m) => m.t === "admin/state", "admin/state");
      const machine = state.machines.find((m: Frame) => m.id === MACHINE_A);

      // The whole point of the feature, in one assertion: the box is up, the screen is asleep, and
      // nothing about that reads as a fault. An operator dispatched to "fix" this wall is a bug.
      expect(machine.online).toBe(true);
      expect(screenIn(state, screenA)?.asleep).toBe(true);
      expect(screenIn(state, screenA)?.powerError).toBeUndefined();
      // The feed says it is asleep, not that it broke.
      const line = state.activity.find((e: Frame) => String(e.text).includes("is asleep"));
      expect(line.severity).toBe("info");
    },
    TEST_TIMEOUT,
  );

  test(
    "a FAILED ack leaves the screen AWAKE and explains itself — never claim a dark wall",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      agentA.send({
        t: "agent/power-ack",
        machineId: MACHINE_A,
        connector: CONNECTOR_A2,
        on: false,
        ok: false,
        methods: [],
        reason: "swaymsg: no such output DP-2",
      });

      const state = await admin.waitFor(
        (m) =>
          m.t === "admin/state" &&
          Array.isArray(m.activity) &&
          m.activity.some((e: Frame) => String(e.text).includes("Could not sleep")),
        "admin/state carrying the refusal",
        4_000,
      );
      // A refusal must NOT mark the screen asleep — the safe direction is "it might still be lit".
      expect(screenIn(state, screenA2)?.asleep).toBe(false);
      expect(screenIn(state, screenA2)?.powerError).toContain("no such output");
      const refusal = state.activity.find((e: Frame) => String(e.text).includes("Could not sleep"));
      expect(refusal.severity).toBe("bad");
    },
    TEST_TIMEOUT,
  );

  test(
    "waking acks back to awake, and clears the refusal",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      const res = await postJson(`/api/v1/screens/${screenA}/power`, { on: true });
      expect(res.status).toBe(202);
      const frame = await agentA.waitFor(
        (m) => m.t === "server/display-power" && m.on === true,
        "wake frame",
      );
      expect(frame.connector).toBe(CONNECTOR_A);

      agentA.send({
        t: "agent/power-ack",
        machineId: MACHINE_A,
        connector: CONNECTOR_A,
        on: true,
        ok: true,
        methods: ["dpms"],
      });
      const awake = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.asleep === false,
        "asleep=false",
        4_000,
      );
      expect(screenIn(awake, screenA)?.powerError).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /machines/:id/power sleeps EVERY panel the box drives (one frame per connector)",
    async () => {
      const res = await postJson(`/api/v1/machines/${MACHINE_A}/power`, { on: false });
      expect(res.status).toBe(202);
      expect(await res.json()).toMatchObject({ ok: true, machineId: MACHINE_A, on: false, delivered: 2 });

      const seen = new Set<string>();
      for (let i = 0; i < 2; i++) {
        const frame = await agentA.waitFor(
          (m) => m.t === "server/display-power" && m.on === false && !seen.has(m.connector),
          "a bulk sleep frame",
        );
        seen.add(frame.connector);
      }
      expect([...seen].sort()).toEqual([CONNECTOR_A, CONNECTOR_A2]);
      expect(await agentB.sawWithin((m) => m.t === "server/display-power", 400)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "the asleep flag is EPHEMERAL: a box that drops comes back LIT, not badged asleep",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      agentA.send({
        t: "agent/power-ack",
        machineId: MACHINE_A,
        connector: CONNECTOR_A,
        on: false,
        ok: true,
        methods: ["dpms"],
      });
      await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.asleep === true,
        "asleep before the drop",
        4_000,
      );

      agentA.close();
      await agentA.waitForClose();

      // The compositor asserts `output * dpms on` at startup, so a box that comes back is LIT. A
      // remembered "asleep" here would leave the console describing a dark wall that is showing content.
      const dropped = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenA)?.asleep === false,
        "asleep cleared after the machine dropped",
        4_000,
      );
      expect(screenIn(dropped, screenA)?.powerError).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "409 when the screen's machine is OFFLINE — an undelivered sleep is not a delivered one",
    async () => {
      await sleep(150); // agentA closed above; let the server drop it from the agent hub
      const res = await postJson(`/api/v1/screens/${screenA}/power`, { on: false });
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toContain("offline");
    },
    TEST_TIMEOUT,
  );

  test(
    "404 on an unknown screen; 400 on a malformed body (every boundary is parsed)",
    async () => {
      expect((await postJson("/api/v1/screens/nope/power", { on: false })).status).toBe(404);
      expect((await postJson(`/api/v1/screens/${screenB}/power`, { on: "off" })).status).toBe(400);
      expect((await postJson("/api/v1/machines/nope/power", { on: true })).status).toBe(404);
    },
    TEST_TIMEOUT,
  );
});

describe("POL-101 panel hours", () => {
  test(
    "PUT /screens/:id/panel-hours persists a daily window and reports it on the screen",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      const res = await fetch(`${BASE}/api/v1/screens/${screenB}/panel-hours`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hours: { enabled: true, on: "07:30", off: "19:15" } }),
      });
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        ok: true,
        screenId: screenB,
        hours: { enabled: true, on: "07:30", off: "19:15" },
      });

      const state = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenB)?.panelHours !== undefined,
        "admin/state carrying the window",
        4_000,
      );
      expect(screenIn(state, screenB)?.panelHours).toEqual({
        enabled: true,
        on: "07:30",
        off: "19:15",
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "clearing it (hours: null) puts the screen back to 24/7 — the pre-POL-101 default",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      const res = await fetch(`${BASE}/api/v1/screens/${screenB}/panel-hours`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ hours: null }),
      });
      expect(res.status).toBe(200);

      const state = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenB)?.panelHours === undefined,
        "admin/state with the window cleared",
        4_000,
      );
      expect(screenIn(state, screenB)?.panelHours).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "a malformed window is refused at the edge (400) — a bad time is a wall asleep at the wrong hour",
    async () => {
      for (const hours of [
        { enabled: true, on: "7:30", off: "19:00" }, // not HH:MM
        { enabled: true, on: "25:00", off: "19:00" }, // not a time
        { enabled: true, on: "09:00", off: "09:00" }, // a window of zero length means nothing
      ]) {
        const res = await fetch(`${BASE}/api/v1/screens/${screenB}/panel-hours`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ hours }),
        });
        expect(res.status).toBe(400);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "the deployment timezone is settable, EXPLICIT, and validated (a typo is a 400, not a 19:00 surprise)",
    async () => {
      const ok = await fetch(`${BASE}/api/v1/settings/panel-power`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timezone: "America/New_York" }),
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({ timezone: "America/New_York" });

      const read = await fetch(`${BASE}/api/v1/settings/panel-power`);
      expect(await read.json()).toEqual({ timezone: "America/New_York" });

      const bad = await fetch(`${BASE}/api/v1/settings/panel-power`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ timezone: "Mars/Olympus" }),
      });
      expect(bad.status).toBe(400);
      expect(await errorOf(bad)).toContain("unknown timezone");
    },
    TEST_TIMEOUT,
  );

  test(
    "the timezone reaches the console over admin/state",
    async () => {
      const admin = await connectAdmin();
      const state = await admin.waitFor(
        (m) => m.t === "admin/state" && m.panelPower?.timezone === "America/New_York",
        "admin/state carrying the timezone",
        4_000,
      );
      expect(state.panelPower.timezone).toBe("America/New_York");
    },
    TEST_TIMEOUT,
  );
});
