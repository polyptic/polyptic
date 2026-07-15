/**
 * @polyptic/e2e — POL-94: the content library's USAGE + live HEALTH, end to end against the REAL
 * control plane.
 *
 * The library was a pile: no way to see where a source is used, and no signal when its URL is dead —
 * the operator heard about a broken dashboard from a passer-by. Two folds, both in `admin/state`:
 *
 *   USAGE   a fold over desired state: which screens / walls / playlists / pages reference a source.
 *           This is what lets a delete confirmation name exactly what it will break.
 *   HEALTH  a fold over what the PLAYERS report. POL-86 gave the player a prober that PROVES a URL
 *           fetchable before painting it; POL-94 sends that verdict up as `player/surface-health`
 *           (on state CHANGE only). The server keys it by the source the surface was showing, which
 *           it can do because it now STAMPS `sourceId` onto every surface at send time.
 *
 * What this suite pins, in the order a wall lives it:
 *   1. a rendered surface carries the send-time `sourceId` stamp (the whole attribution path hangs
 *      off it) — and an ad-hoc URL does NOT (there is no library entry to attribute it to);
 *   2. a source nobody shows reads `unknown` — never a comforting green;
 *   3. usage counts the screens/walls/playlists that reference a source, by id;
 *   4. a player reporting `unreachable` turns that source's badge red, naming the screen;
 *   5. the same player reporting `reachable` heals it;
 *   6. a player that DROPS takes its verdict with it (an unplugged box proves nothing about a URL).
 *
 * Own port (8151) + its own memory store, like every other suite; OPEN mode (no bootstrap token),
 * AUTH off, so one fake agent auto-enrols and fake players may hello freely.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8151;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;

const MACHINE_ID = "health-host-1";
const RES_W = 1920;
const RES_H = 1080;

const DASH_URL = "https://dashboard.test/d/lobby";
const ADHOC_URL = "https://ad-hoc.test/page";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client (same shape as the other suites): never miss a frame.
// ─────────────────────────────────────────────────────────────────────────────

type Frame = any;

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Array<{
    pred: (m: Frame) => boolean;
    resolve: (m: Frame) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
  }

  static connect(url: string, timeoutMs = 5_000): Promise<WsClient> {
    return new Promise<WsClient>((resolveConn, rejectConn) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => {
        ws.close();
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

  waitFor(pred: (m: Frame) => boolean, label = "frame", timeoutMs = 4_000): Promise<Frame> {
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

const openClients: WsClient[] = [];

async function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function putJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** A FRESH /admin connection's first snapshot always reflects CURRENT server state. */
async function snapshot(label: string): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  const state = await admin.waitFor((m) => m.t === "admin/state", label);
  admin.close();
  return state;
}

const statusOf = (state: Frame, sourceId: string): Frame | undefined =>
  (state.sourceStatus ?? []).find((s: Frame) => s.sourceId === sourceId);

/** The health report a player sends when its prober's verdict changes (POL-94). */
function healthFrame(
  screenId: string,
  surfaceId: string,
  sourceId: string | undefined,
  state: "reachable" | "unreachable",
  detail?: string,
): unknown {
  return {
    t: "player/surface-health",
    screenId,
    surfaceId,
    ...(sourceId ? { sourceId } : {}),
    url: DASH_URL,
    state,
    at: new Date().toISOString(),
    ...(detail ? { detail } : {}),
  };
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

let screenA = "";
let screenB = "";
let sourceId = "";
let surfaceId = "";
let playerA: WsClient;

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

  const agent = await WsClient.connect(`${WS}/agent`);
  openClients.push(agent);
  agent.send({
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId: MACHINE_ID,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [
      { connector: "HDMI-1", width: RES_W, height: RES_H },
      { connector: "HDMI-2", width: RES_W, height: RES_H },
    ],
  });
  await agent.waitFor((m) => m.t === "server/apply", "server/apply for the fake agent", 6_000);

  const state = await snapshot("initial admin/state");
  const screens = state.machines.flatMap((m: Frame) => m.screens);
  screenA = screens[0].id;
  screenB = screens[1].id;

  const created = await postJson("/api/v1/content-sources", {
    name: "Lobby dashboard",
    kind: "dashboard",
    url: DASH_URL,
  });
  expect(created.status).toBe(201);
  sourceId = ((await created.json()) as Frame).source.id;
}, 30_000);

afterAll(() => {
  for (const c of openClients) c.close();
  proc?.kill();
});

test("a source nobody is showing reads unknown, used nowhere", async () => {
  const state = await snapshot("state with an unused source");
  const status = statusOf(state, sourceId);
  expect(status).toBeDefined();
  expect(status.health).toBe("unknown");
  expect(status.usage).toEqual({
    sourceId,
    screenIds: [],
    wallIds: [],
    playlistIds: [],
    pageIds: [],
  });
});

test("assigning the source stamps its id onto the rendered surface, and lands in usage", async () => {
  playerA = await WsClient.connect(`${WS}/player`);
  openClients.push(playerA);
  playerA.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId: screenA });
  await playerA.waitFor((m) => m.t === "server/render", "initial render for screen A");

  const res = await putJson(`/api/v1/screens/${screenA}/content`, { sourceId });
  expect(res.ok).toBe(true);
  await res.body?.cancel();

  const render = await playerA.waitFor(
    (m) => m.t === "server/render" && m.slice?.surfaces?.length === 1,
    "render carrying the assigned source",
  );
  const surface = render.slice.surfaces[0];
  surfaceId = surface.id;
  // THE attribution hook: without this stamp the player cannot say WHICH library source it just
  // failed to fetch, and the console's badge has nothing to hang off.
  expect(surface.sourceId).toBe(sourceId);

  const state = await snapshot("state with the source assigned");
  expect(statusOf(state, sourceId).usage.screenIds).toEqual([screenA]);
  expect(statusOf(state, sourceId).health).toBe("unknown"); // assigned, but nothing has reported yet
});

test("a player reporting unreachable turns the source red and names the screen", async () => {
  playerA.send(healthFrame(screenA, surfaceId, sourceId, "unreachable", "Failed to fetch"));
  await sleep(150);

  const status = statusOf(await snapshot("state after a failed probe"), sourceId);
  expect(status.health).toBe("unreachable");
  expect(status.unreachableScreenIds).toEqual([screenA]);
  expect(status.detail).toBe("Failed to fetch");
  expect(status.lastSeenAt).toBeTruthy();
});

test("the same player reporting reachable heals the badge", async () => {
  playerA.send(healthFrame(screenA, surfaceId, sourceId, "reachable"));
  await sleep(150);

  const status = statusOf(await snapshot("state after the probe passes again"), sourceId);
  expect(status.health).toBe("reachable");
  expect(status.unreachableScreenIds).toEqual([]);
  expect(status.detail).toBeUndefined();
});

test("a report for an ad-hoc URL (no sourceId) is attributed to nothing", async () => {
  // Screen B shows an ad-hoc URL — a legitimate assignment with no library entry behind it.
  const res = await putJson(`/api/v1/screens/${screenB}/content`, { url: ADHOC_URL });
  expect(res.ok).toBe(true);
  await res.body?.cancel();

  const playerB = await WsClient.connect(`${WS}/player`);
  openClients.push(playerB);
  playerB.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId: screenB });
  const render = await playerB.waitFor(
    (m) => m.t === "server/render" && m.slice?.surfaces?.length === 1,
    "render for screen B",
  );
  expect(render.slice.surfaces[0].sourceId).toBeUndefined(); // nothing in the library to stamp

  playerB.send(healthFrame(screenB, render.slice.surfaces[0].id, undefined, "unreachable", "Failed to fetch"));
  await sleep(150);

  // The library source is untouched — screen B's misery belongs to no library entry.
  const status = statusOf(await snapshot("state after an ad-hoc failure"), sourceId);
  expect(status.health).toBe("reachable");
  expect(status.unreachableScreenIds).toEqual([]);
  playerB.close();
});

test("a screen that drops takes its verdict with it — an unplugged box proves nothing", async () => {
  playerA.send(healthFrame(screenA, surfaceId, sourceId, "unreachable", "Failed to fetch"));
  await sleep(150);
  expect(statusOf(await snapshot("red before the drop"), sourceId).health).toBe("unreachable");

  playerA.close();
  await sleep(250);

  const status = statusOf(await snapshot("state after the player dropped"), sourceId);
  expect(status.health).toBe("unknown");
  expect(status.unreachableScreenIds).toEqual([]);
  // Usage is desired state, not presence: an offline screen is still ASSIGNED the source.
  expect(status.usage.screenIds).toEqual([screenA]);
});
