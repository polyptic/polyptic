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
 *   409 offline / 404 unknown / 400 body.
 *
 * The SCHEDULED half (POL-186) is the second suite below. The per-screen panel-hours PUT is gone: a
 * wall's waking hours are a schedule window aimed at a MURAL (`Schedule.panels`, on the scheduler's
 * one timezone), so the suite drives the schedule routes the console drives and watches the frames
 * actually reach the box.
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

/** Any JSON method — the schedule routes below need PUT/PATCH/DELETE as well as POST. */
function req(method: string, path: string, body?: unknown): Promise<Response> {
  if (body === undefined) return fetch(`${BASE}${path}`, { method });
  return fetch(`${BASE}${path}`, {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** "HH:MM" for a minute-of-day, wrapping — the schedule routes speak wall-clock times. */
function hhmm(minuteOfDay: number): string {
  const m = ((minuteOfDay % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** Now, as a minute of the day in UTC — the zone this suite pins the scheduler to. */
function nowMinutesUtc(): number {
  const d = new Date();
  return d.getUTCHours() * 60 + d.getUTCMinutes();
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

/**
 * POL-186 — the SCHEDULED half, driven the way the console drives it: a power-only window on a
 * MURAL's schedule. There is no per-screen calendar and no second timezone any more, so everything
 * below goes through the schedule routes, and the proof is always the frame that reaches the box.
 *
 * Every schedule mutation kicks the ticker (schedule-routes.ts), so no test here waits out a tick.
 * The window is moved ONTO and OFF the current minute to manufacture the two boundaries a wall
 * actually cares about — the 19:00 sleep and the 07:00 wake — without waiting for either.
 */
describe("POL-186 scheduled panel power (a window on the mural)", () => {
  let muralId = "";
  let otherMuralId = "";
  let daypartId = "";
  let scheduleId = "";
  let agentC: WsClient;
  let screenC = "";

  /** A window that does NOT cover now (two hours out), and one that squarely does. */
  const awayWindow = (): { start: string; end: string } => ({
    start: hhmm(nowMinutesUtc() + 120),
    end: hhmm(nowMinutesUtc() + 180),
  });
  const nowWindow = (): { start: string; end: string } => ({
    start: hhmm(nowMinutesUtc() - 60),
    end: hhmm(nowMinutesUtc() + 60),
  });

  test(
    "an off window that does not cover NOW leaves the wall lit — in hours, nothing is ever blanked",
    async () => {
      const admin = await connectAdmin();
      const seeded = await admin.waitFor((m) => m.t === "admin/state", "admin/state with the murals");
      muralId = seeded.murals[0].id;

      // The wall under test: machine B's panel, placed on the seeded mural. Power belongs to a WALL,
      // so a screen has to be ON one before any window can govern it.
      expect((await req("PUT", `/api/v1/screens/${screenB}/placement`, { muralId, x: 0, y: 0 })).status).toBe(200);

      // A bystander wall, with a box of its own and no schedule at all: the control that proves a
      // window darkens the mural it targets and nothing else.
      const other = await postJson("/api/v1/murals", { name: "Bystander" });
      expect(other.status).toBe(201);
      otherMuralId = ((await other.json()) as Frame).mural.id;
      ({ client: agentC, screenId: screenC } = await openAgent("power-host-c", "DP-9"));
      expect(
        (await req("PUT", `/api/v1/screens/${screenC}/placement`, { muralId: otherMuralId, x: 0, y: 0 })).status,
      ).toBe(200);

      // ONE clock: the scheduler's. There is no panel-power timezone any more.
      const settings = await req("PUT", "/api/v1/settings/scheduler", { enabled: true, timezone: "UTC" });
      expect(settings.status).toBe(200);

      const daypart = await postJson("/api/v1/dayparts", { name: "After hours", ...awayWindow() });
      expect(daypart.status).toBe(201);
      daypartId = ((await daypart.json()) as Frame).daypart.id;

      // A POWER-ONLY window: it says nothing about what plays, only what the panels do.
      const sched = await postJson("/api/v1/schedules", {
        sceneId: null,
        muralId,
        daypartId,
        days: [0, 1, 2, 3, 4, 5, 6],
        priority: 0,
        panels: "off",
        enabled: true,
      });
      expect(sched.status).toBe(201);
      scheduleId = ((await sched.json()) as Frame).schedule.id;

      // The POST kicked the ticker. The window is shut, so the mural resolves to "on" and the wall
      // stays exactly as it is — a screen that should be showing content is never blanked.
      expect(await agentB.sawWithin((m) => m.t === "server/display-power", 800)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "moving the window ONTO now sleeps that mural's panels — and only that mural's",
    async () => {
      const patched = await req("PATCH", `/api/v1/dayparts/${daypartId}`, nowWindow());
      expect(patched.status).toBe(200);

      const frame = await agentB.waitFor(
        (m) => m.t === "server/display-power",
        "the scheduled sleep frame",
        6_000,
      );
      expect(frame.connector).toBe("HDMI-9");
      expect(frame.on).toBe(false);
      // It names the window, so the box's log says WHY it went dark.
      expect(String(frame.reason)).toContain("After hours");

      // The bystander wall is on a mural no window governs: it is left exactly as it is.
      expect(await agentC.sawWithin((m) => m.t === "server/display-power", 600)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "the ack is what marks it asleep, and the feed names the window that did it",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      agentB.send({
        t: "agent/power-ack",
        machineId: MACHINE_B,
        connector: "HDMI-9",
        on: false,
        ok: true,
        methods: ["dpms", "cec"],
      });

      const state = await admin.waitFor(
        (m) => m.t === "admin/state" && screenIn(m, screenB)?.asleep === true,
        "admin/state with the scheduled screen asleep",
        4_000,
      );
      expect(screenIn(state, screenB)?.powerMethods).toEqual(["dpms", "cec"]);
      const line = state.activity.find((e: Frame) => String(e.text).includes("is sleeping —"));
      expect(String(line.text)).toContain("After hours");
      expect(line.severity).toBe("info");
    },
    TEST_TIMEOUT,
  );

  test(
    "moving the window OFF now wakes it, and the line names the GAP rather than a window that isn't there",
    async () => {
      const admin = await connectAdmin();
      await admin.waitFor((m) => m.t === "admin/state", "initial admin/state");

      const patched = await req("PATCH", `/api/v1/dayparts/${daypartId}`, awayWindow());
      expect(patched.status).toBe(200);

      const frame = await agentB.waitFor(
        (m) => m.t === "server/display-power" && m.on === true,
        "the scheduled wake frame",
        6_000,
      );
      expect(frame.connector).toBe("HDMI-9");

      // A gap between windows has NO covering window to name. "a scheduled window" would point at
      // one that does not exist, so the line names the gap itself.
      const state = await admin.waitFor(
        (m) =>
          m.t === "admin/state" &&
          m.activity.some((e: Frame) => String(e.text).includes("woke — outside its scheduled windows")),
        "the feed naming the gap",
        4_000,
      );
      expect(
        state.activity.some((e: Frame) => String(e.text).includes("woke — a scheduled window")),
      ).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a box that comes back INSIDE an off window is re-slept on its hello — it boots LIT",
    async () => {
      // Put the wall back inside the off window, and let the ticker record that verdict.
      expect((await req("PATCH", `/api/v1/dayparts/${daypartId}`, nowWindow())).status).toBe(200);
      await agentB.waitFor((m) => m.t === "server/display-power" && m.on === false, "the sleep frame");

      // The box reboots: the compositor asserts `dpms on` at startup, so it comes back LIT and wrong.
      agentB.close();
      await agentB.waitForClose();
      await sleep(200);
      const back = await openAgent(MACHINE_B, "HDMI-9");
      agentB = back.client;
      expect(back.screenId).toBe(screenB); // the same screen identity, the same wall

      const frame = await agentB.waitFor(
        (m) => m.t === "server/display-power" && m.on === false,
        "the reconcile sleep on hello",
        6_000,
      );
      expect(frame.connector).toBe("HDMI-9");
      expect(String(frame.reason)).toContain("off window");
    },
    TEST_TIMEOUT,
  );

  /**
   * DELETING THE WINDOWS MUST NOT STRAND THE WALL DARK. The wall is asleep on this schedule's verdict
   * (the test above put a rebooted box back inside the off window). Deleting the window is the move
   * an operator makes when the power feature misbehaves, and it used to be the move that left the
   * fleet dark with only the manual Wake button to recover it: nothing in the system asserted panel
   * power for an ungoverned mural, on a tick or on a hello.
   *
   * Losing the last window is an edge, and the schedule wakes what IT slept on the way out. It is
   * still not "wake everything" — a screen an operator slept BY HAND writes nothing to the schedule's
   * memory and is never woken by this, which the server suite pins directly.
   */
  test(
    "deleting the window WAKES the wall the schedule slept — and then says nothing more",
    async () => {
      const del = await req("DELETE", `/api/v1/schedules/${scheduleId}`);
      expect(del.status).toBe(200);
      await del.json();

      const frame = await agentB.waitFor(
        (m) => m.t === "server/display-power" && m.on === true,
        "the wake that follows the window's deletion",
        6_000,
      );
      expect(frame.connector).toBe("HDMI-9");
      expect(String(frame.reason)).toContain("no window governs its wall any more");

      // Once, not every ten seconds: the memory goes with the wake, so the ticks that follow are
      // silent — an ungoverned mural is not re-asserted.
      expect(await agentB.sawWithin((m) => m.t === "server/display-power", 800)).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a DISABLED scheduler cannot darken a wall, even standing inside an off window",
    async () => {
      // Set the trap properly, or this proves nothing: put the window AWAY first and let the ticker
      // record "on" for the screen, so that moving the window onto now IS an edge — the exact edge
      // that slept the wall two tests ago.
      expect((await req("PATCH", `/api/v1/dayparts/${daypartId}`, awayWindow())).status).toBe(200);
      const sched = await postJson("/api/v1/schedules", {
        sceneId: null,
        muralId,
        daypartId,
        days: [0, 1, 2, 3, 4, 5, 6],
        priority: 0,
        panels: "off",
        enabled: true,
      });
      expect(sched.status).toBe(201);
      await sched.json();

      // Now switch the whole scheduler off, and spring the trap.
      expect((await req("PUT", "/api/v1/settings/scheduler", { enabled: false })).status).toBe(200);
      expect((await req("PATCH", `/api/v1/dayparts/${daypartId}`, nowWindow())).status).toBe(200);

      // The resolver answers "ungoverned" for every mural while the scheduler is off, so no frame may
      // leave the building however deep inside the window the clock is standing.
      expect(await agentB.sawWithin((m) => m.t === "server/display-power", 1_000)).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
