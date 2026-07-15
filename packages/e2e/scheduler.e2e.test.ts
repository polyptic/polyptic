/**
 * @polyptic/e2e — POL-89 SCENE SCHEDULER against the REAL control plane (port 8161).
 *
 * The claim under test is the one D24 never made good on: a scene with a window of the day APPLIES
 * ITSELF at the window's boundary, and reaches the glass over the ORDINARY fan-out — the same
 * `server/render` push an operator's Apply button produces, with no reload and nothing new on the
 * agent or player side.
 *
 * Driving the clock, not sleeping through it. A daypart's boundary is an HH:MM, so waiting for a
 * real one would mean waiting up to a minute. Instead the server's scheduler clock is OFFSET by a
 * test seam (`SCHEDULER_CLOCK_OFFSET_MS`, unset in every real deployment) so that a genuine whole
 * minute — a real window boundary, evaluated by the real ticker in the real process — lands a known
 * few seconds from now. We then prove:
 *
 *   - BEFORE the boundary the scheduled scene has NOT been applied (the window is shut);
 *   - AT the boundary the ticker applies it, and the fake player receives a `server/render` carrying
 *     that scene's content, within a tick of the boundary instant;
 *   - the wall's `activeSceneId` follows.
 *
 * Also covered: REST CRUD for dayparts + schedules + settings (including the 409 that stops an
 * operator silently unscheduling a wall by tidying its daypart library, and the 400 that stops a
 * mistyped timezone moving every window an hour), and the DEFAULT SCENE — the always-on floor —
 * taking a wall that no window covers.
 *
 * Its own port + a fresh memory store, so it is independent of every other suite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8161;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 15_000;

const MACHINE_ID = "sched-host-1";
const CONN = "HDMI-1";
const RES_W = 1920;
const RES_H = 1080;

const DAY_URL = "https://example.com/day-wall";
const NIGHT_URL = "https://example.com/night-wall";

/** The ticker's cadence for the test — the scene must land within a tick of the boundary. */
const TICK_MS = 500;

// ── The injected clock ───────────────────────────────────────────────────────
// The scheduler's clock runs OFFSET from the wall clock, chosen so that a real whole-minute boundary
// (in the scheduler's UTC-configured zone) falls exactly BOUNDARY_LEAD_MS from the server's spawn.
// Everything else in the process — HTTP, WS, the store — is untouched: only the ticker's `now`.
const BOUNDARY_LEAD_MS = 20_000;
const SPAWN_AT = Date.now();
/** Real instant the window opens. */
const BOUNDARY_REAL = SPAWN_AT + BOUNDARY_LEAD_MS;
/** …which the scheduler sees as this whole minute. */
const BOUNDARY_FAKE = Math.ceil(BOUNDARY_REAL / 60_000) * 60_000;
const CLOCK_OFFSET_MS = BOUNDARY_FAKE - BOUNDARY_REAL; // 0…59_999 ms

const hhmm = (ms: number): string => new Date(ms).toISOString().slice(11, 16); // UTC HH:MM
/** The window: opens at the boundary minute, runs two hours (wrapping past midnight is fine). */
const WINDOW_START = hhmm(BOUNDARY_FAKE);
const WINDOW_END = hhmm(BOUNDARY_FAKE + 2 * 60 * 60_000);

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client (same shape as the other suites): never miss a frame.
// ─────────────────────────────────────────────────────────────────────────────

type Frame = any;
type Predicate = (m: Frame) => boolean;

interface Waiter {
  pred: Predicate;
  resolve: (m: Frame) => void;
  timer: ReturnType<typeof setTimeout>;
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
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        try {
          ws.close();
        } catch {
          /* noop */
        }
        rejectConn(new Error(`ws open timeout: ${url}`));
      }, timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        resolveConn(new WsClient(ws));
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        rejectConn(new Error(`ws error before open: ${url}`));
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
      return;
    }
    this.queue.push(msg);
  }

  waitFor(pred: Predicate, label = "frame", timeoutMs = 5_000): Promise<Frame> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise<Frame>((resolveMsg, rejectMsg) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        rejectMsg(new Error(`timed out waiting for ${label} after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve: resolveMsg, timer });
    });
  }

  /** True if a matching frame is ALREADY queued (an absence check — never waits). */
  seen(pred: Predicate): boolean {
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

// ── REST helpers ─────────────────────────────────────────────────────────────

const json = async (method: string, path: string, body?: unknown): Promise<Response> =>
  fetch(`${BASE}${path}`, {
    method,
    // Fastify refuses an empty body that CLAIMS to be json — a bodiless DELETE sends no content-type.
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

async function body<T = any>(res: Response): Promise<T> {
  return (await res.json()) as T;
}

// ── Server lifecycle ─────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;
const openClients: WsClient[] = [];

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

async function snapshot(label: string): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  const state = await admin.waitFor((m) => m.t === "admin/state", label);
  admin.close();
  return state;
}

let screenId = "";
let muralId = "";
let dayScene = "";
let nightScene = "";
let player: WsClient;

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
      // The scheduler ticks fast and its clock is offset onto a boundary a few seconds out.
      SCHEDULER_TICK_MS: String(TICK_MS),
      SCHEDULER_CLOCK_OFFSET_MS: String(CLOCK_OFFSET_MS),
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  // One machine, one screen.
  const agent = await WsClient.connect(`${WS}/agent`);
  openClients.push(agent);
  agent.send({
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId: MACHINE_ID,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [{ connector: CONN, width: RES_W, height: RES_H }],
  });
  const apply = await agent.waitFor((m) => m.t === "server/apply" && m.machineId === MACHINE_ID, "server/apply");
  screenId = apply.screens[0].screenId;

  const seeded = await snapshot("admin/state with the seeded mural");
  muralId = seeded.murals.find((m: Frame) => m.name === "Wall").id;

  // Place the screen, then snapshot TWO scenes off it — a "Day" wall and a "Night" wall.
  await drain(
    await json("PUT", `/api/v1/screens/${screenId}/placement`, { muralId, x: 0, y: 0, w: RES_W, h: RES_H }),
  );
  await drain(await json("PUT", `/api/v1/screens/${screenId}/content`, { url: DAY_URL }));
  dayScene = (await body(await json("POST", "/api/v1/scenes", { name: "Day wall", muralId }))).scene.id;
  await drain(await json("PUT", `/api/v1/screens/${screenId}/content`, { url: NIGHT_URL }));
  nightScene = (await body(await json("POST", "/api/v1/scenes", { name: "Night wall", muralId }))).scene.id;

  // The player that will receive the scheduled fan-out.
  player = await WsClient.connect(`${WS}/player`);
  openClients.push(player);
  player.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId });
  await player.waitFor((m) => m.t === "server/render" && m.slice?.screenId === screenId, "initial render");
});

afterAll(async () => {
  for (const c of openClients) c.close();
  proc?.kill();
  await sleep(100);
});

describe("POL-89 — the scene scheduler", () => {
  test(
    "admin/state carries the scheduler: an empty daypart library and the deployment's settings",
    async () => {
      const state = await snapshot("admin/state with the scheduler");
      expect(state.dayparts).toEqual([]);
      expect(state.schedules).toEqual([]);
      expect(state.scheduler).toBeDefined();
      expect(state.scheduler.enabled).toBe(true);
      expect(typeof state.scheduler.timezone).toBe("string"); // the server's own zone, made explicit
      expect(state.scheduler.defaultSceneId).toBeNull();
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT /settings/scheduler pins the deployment timezone — and REFUSES a bogus one (400)",
    async () => {
      const bad = await json("PUT", "/api/v1/settings/scheduler", { timezone: "Mars/Olympus_Mons" });
      expect(bad.status).toBe(400);
      await drain(bad);

      const ok = await json("PUT", "/api/v1/settings/scheduler", { timezone: "UTC", enabled: true });
      expect(ok.status).toBe(200);
      expect((await body(ok)).scheduler.timezone).toBe("UTC");
    },
    TEST_TIMEOUT,
  );

  test(
    "dayparts + schedules CRUD, incl. the 409 that stops a tidy-up silently unscheduling a wall",
    async () => {
      // A malformed window is rejected at the edge.
      const bad = await json("POST", "/api/v1/dayparts", { name: "Nonsense", start: "25:00", end: "18:00" });
      expect(bad.status).toBe(400);
      await drain(bad);

      const created = await json("POST", "/api/v1/dayparts", { name: "Quiet hours", start: "03:00", end: "04:00" });
      expect(created.status).toBe(201);
      const daypartId = (await body(created)).daypart.id;

      const patched = await json("PATCH", `/api/v1/dayparts/${daypartId}`, { name: "Very quiet hours" });
      expect(patched.status).toBe(200);
      expect((await body(patched)).daypart.name).toBe("Very quiet hours");

      // A schedule needs a scene AND a daypart that exist.
      const noScene = await json("POST", "/api/v1/schedules", { sceneId: "scene-404", daypartId, days: [1] });
      expect(noScene.status).toBe(404);
      await drain(noScene);
      const noDaypart = await json("POST", "/api/v1/schedules", { sceneId: dayScene, daypartId: "daypart-404", days: [1] });
      expect(noDaypart.status).toBe(404);
      await drain(noDaypart);

      // Bound (but DISABLED, so this CRUD fixture can never take the wall out from under the boundary
      // test that follows).
      const sched = await json("POST", "/api/v1/schedules", {
        sceneId: dayScene,
        daypartId,
        days: [0, 1, 2, 3, 4, 5, 6],
        priority: 3,
        enabled: false,
      });
      expect(sched.status).toBe(201);
      const scheduleId = (await body(sched)).schedule.id;

      // Deleting a daypart that a schedule still uses is a 409 — the library cannot be tidied into
      // silently unscheduling a wall.
      const conflict = await json("DELETE", `/api/v1/dayparts/${daypartId}`);
      expect(conflict.status).toBe(409);
      expect((await body(conflict)).schedules).toBe(1);

      const state = await snapshot("admin/state with the CRUD fixtures");
      expect(state.dayparts.some((d: Frame) => d.id === daypartId)).toBe(true);
      expect(state.schedules.find((s: Frame) => s.id === scheduleId).priority).toBe(3);

      // Unbind, then the daypart deletes cleanly.
      const delSchedule = await json("DELETE", `/api/v1/schedules/${scheduleId}`);
      expect(delSchedule.status).toBe(200);
      await drain(delSchedule);
      const delDaypart = await json("DELETE", `/api/v1/dayparts/${daypartId}`);
      expect(delDaypart.status).toBe(200);
      await drain(delDaypart);

      const clean = await snapshot("admin/state after the CRUD teardown");
      expect(clean.dayparts).toEqual([]);
      expect(clean.schedules).toEqual([]);
    },
    TEST_TIMEOUT,
  );

  test(
    "the DEFAULT SCENE is the always-on floor: it takes a wall no window covers",
    async () => {
      // Nothing is scheduled at all — so the moment a default scene exists, the ticker asserts it.
      const res = await json("PUT", "/api/v1/settings/scheduler", { defaultSceneId: dayScene });
      expect(res.status).toBe(200);
      await drain(res);

      const render = await player.waitFor(
        (m) => m.t === "server/render" && m.slice?.surfaces?.[0]?.url === DAY_URL,
        "the default scene's render",
        5_000,
      );
      expect(render.slice.screenId).toBe(screenId);

      const state = await body(await fetch(`${BASE}/api/v1/state`));
      expect(state.activeSceneId).toBe(dayScene);
    },
    TEST_TIMEOUT,
  );

  test(
    "a scheduled scene applies AT its window boundary, over the standard fan-out",
    async () => {
      const daypart = await json("POST", "/api/v1/dayparts", {
        name: "Evening",
        start: WINDOW_START,
        end: WINDOW_END,
      });
      expect(daypart.status).toBe(201);
      const daypartId = (await body(daypart)).daypart.id;

      const sched = await json("POST", "/api/v1/schedules", {
        sceneId: nightScene,
        daypartId,
        days: [0, 1, 2, 3, 4, 5, 6],
        priority: 10,
        enabled: true,
      });
      expect(sched.status).toBe(201);
      await drain(sched);

      // We must still be BEFORE the boundary for this test to mean anything (the schedule POST kicks
      // the ticker, so the window being shut is what keeps the wall on the Day scene).
      const beforeBy = BOUNDARY_REAL - Date.now();
      expect(beforeBy).toBeGreaterThan(2_000);

      // …and the ticker, having just run, has NOT applied it: no Night render, and the Day scene is
      // still the live one.
      await sleep(TICK_MS * 2);
      expect(player.seen((m) => m.t === "server/render" && m.slice?.surfaces?.[0]?.url === NIGHT_URL)).toBe(false);
      const preState = await body(await fetch(`${BASE}/api/v1/state`));
      expect(preState.activeSceneId).toBe(dayScene);

      // The boundary. The ticker resolves the new window and applies the scene through the ORDINARY
      // apply path — so the proof is a `server/render` on the player's own socket.
      const render = await player.waitFor(
        (m) => m.t === "server/render" && m.slice?.surfaces?.[0]?.url === NIGHT_URL,
        "the scheduled scene's render",
        BOUNDARY_LEAD_MS + 10_000,
      );
      const arrivedAt = Date.now();

      expect(render.slice.screenId).toBe(screenId);
      expect(render.slice.surfaces[0].type).toBe("web");
      // It fired AT the boundary: never early, and within a tick (+ the apply) of it.
      expect(arrivedAt).toBeGreaterThanOrEqual(BOUNDARY_REAL);
      expect(arrivedAt - BOUNDARY_REAL).toBeLessThan(TICK_MS + 3_000);

      const state = await body(await fetch(`${BASE}/api/v1/state`));
      expect(state.activeSceneId).toBe(nightScene);
      expect(state.slices[screenId].surfaces[0].url).toBe(NIGHT_URL);
    },
    40_000,
  );

  test(
    "deleting a scene takes its schedules with it (a schedule can never point at nothing)",
    async () => {
      const before = await snapshot("admin/state before deleting the scheduled scene");
      expect(before.schedules.filter((s: Frame) => s.sceneId === nightScene)).toHaveLength(1);

      const res = await json("DELETE", `/api/v1/scenes/${nightScene}`);
      expect(res.status).toBe(200);
      await drain(res);

      const after = await snapshot("admin/state after deleting the scheduled scene");
      expect(after.scenes.some((s: Frame) => s.id === nightScene)).toBe(false);
      expect(after.schedules).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
