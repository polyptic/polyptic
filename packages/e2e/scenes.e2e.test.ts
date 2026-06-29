/**
 * @polyptic/e2e — Phase 3d SCENES suite against the REAL control plane.
 *
 * A **Scene** is a named SNAPSHOT of a mural's whole wall — its LAYOUT (placements), GROUPING (video
 * walls) and CONTENT (per placed-non-walled screen + per wall) — that an operator re-applies in one
 * click (optionally with an illustrative schedule time that is stored but NOT fired). Content is
 * captured as the ASSIGNMENT, so a library source resolves to its CURRENT url on apply:
 *   - a library source  → SceneContent {sourceId}
 *   - an ad-hoc link     → SceneContent {url}
 *   - nothing on air     → SceneContent null
 *
 * We spawn the actual server (`packages/server/src/index.ts`) against the MemoryStore (STORE=memory)
 * on its OWN PORT (8095). With NO `POLYPTIC_BOOTSTRAP_TOKEN` the server runs in OPEN mode: one fake
 * agent reporting THREE outputs is auto-registered + auto-approved, giving three screens. We build a
 * concrete CURRENT wall on the seeded "Wall" mural:
 *   - A (HDMI-1) + B (HDMI-2) placed ADJACENT and COMBINED into a video wall, spanning a LIBRARY source;
 *   - C (HDMI-3) placed as a single screen, showing an AD-HOC url.
 * A fake player per screen receives the live `server/render` pushes.
 *
 * The flow asserts (bun runs tests in source order, sequentially):
 *   - admin/state carries `scenes[]` and starts EMPTY;
 *   - POST   /api/v1/scenes {name, muralId}  snapshots the CURRENT wall → the scene appears in
 *            admin/state.scenes with the right placements (A,B,C), walls ({A,B} + {sourceId}) and
 *            screens (C + {url});
 *   - we then MUTATE the wall (move A, split the wall, change A's + C's content) — admin/state diverges;
 *   - POST   /api/v1/scenes/:id/apply  RESTORES it: admin/state placements + videoWalls match the
 *            snapshot AND the affected players get a fresh `server/render` with the restored content
 *            (A,B → a SPAN surface at the source's url again; C → its single-screen surface, no span);
 *            DesiredState.activeSceneId becomes the applied scene;
 *   - PATCH  /api/v1/scenes/:id {name, scheduleAt}  stores both (surfaced in admin/state);
 *   - POST   /api/v1/scenes/:id/apply for an UNKNOWN scene → 404;
 *   - DELETE /api/v1/scenes/:id  removes it from admin/state.scenes.
 *
 * Robustness: every WS read is buffered (a frame arriving between awaits is never missed) and carries
 * a per-message timeout. State assertions open a FRESH /admin connection and read its first
 * admin/state (a brand-new client's snapshot always reflects CURRENT server state, so an absence check
 * can't be satisfied by a stale broadcast). Live-render assertions filter on `revision >` the value
 * captured just before the mutating call, so a stale queued frame from an identical earlier url can
 * never satisfy the wait. The server process is torn down in `afterAll`.
 *
 * Independent of the other suites (its own port, fresh memory store). All must stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8095;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "scene-host-1";

const RES_W = 1920;
const RES_H = 1080;

const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";
const CONN_C = "HDMI-3";

// The CURRENT wall layout that the scene snapshots.
//   A at (100,50)  + B at (2020,50)  → ADJACENT 2×1 → combined into a video wall.
//   union: minX=100 minY=50 maxX=3940 maxY=1130 → contentW=3840 contentH=1080.
//     A: offsetX = 100-100 = 0,    offsetY = 0
//     B: offsetX = 2020-100 = 1920, offsetY = 0
//   C at (4000,50) → a single, NON-member screen.
const A_X = 100;
const A_Y = 50;
const B_X = A_X + RES_W; // 2020 — abuts A
const B_Y = 50;
const C_X = 4000;
const C_Y = 50;

const EXPECT_CONTENT_W = 3840;
const EXPECT_CONTENT_H = 1080;
const A_OFFSET_X = 0;
const B_OFFSET_X = RES_W; // 1920
const OFFSET_Y = 0;

// The CURRENT content of the wall (a LIBRARY source) and of screen C (an AD-HOC url).
const LIB_NAME = "Scene library source";
const LIB_URL = "https://example.com/scene-lib-source";
const C_URL = "https://example.com/scene-screen-c";

// The MUTATIONS that pull the live wall AWAY from the saved scene (apply must undo all of them).
const MOVED_A_X = 777;
const MOVED_A_Y = 777;
const MUT_A_URL = "https://example.com/mutation-a";
const MUT_C_URL = "https://example.com/mutation-c";

const SCENE_NAME = "Opening";
const SCENE_RENAME = "Morning Wall";
const SCENE_SCHEDULE = "08:30";

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

async function postJson(path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
}

async function putJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function patchJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(path: string): Promise<Response> {
  return fetch(`${BASE}${path}`, { method: "DELETE" });
}

/** Drain a response body so the socket is released (we never read most bodies). */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

/** The control plane's current revision (DesiredState.revision). Used to fence stale render frames. */
async function currentRevision(): Promise<number> {
  const res = await fetch(`${BASE}/api/v1/state`);
  const state = (await res.json()) as Frame;
  return state.revision as number;
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

/** Open a FRESH /admin connection, send admin/hello, return its first admin/state snapshot. */
async function snapshot(label: string, timeoutMs = 4_000): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send(adminHello());
  const state = await admin.waitFor((m) => m.t === "admin/state", label, timeoutMs);
  admin.close();
  return state;
}

// ── admin/state accessors ──────────────────────────────────────────────────
const scenesOf = (state: Frame): Frame[] => (Array.isArray(state.scenes) ? state.scenes : []);
const sceneById = (state: Frame, id: string): Frame | undefined =>
  scenesOf(state).find((s) => s.id === id);
const placementsOf = (state: Frame): Frame[] =>
  Array.isArray(state.placements) ? state.placements : [];
const placementFor = (state: Frame, screenId: string): Frame | undefined =>
  placementsOf(state).find((p) => p.screenId === screenId);
const wallsOf = (state: Frame): Frame[] => (Array.isArray(state.videoWalls) ? state.videoWalls : []);

/** The single web surface of a render slice (with its optional span). */
const surfaceOf = (render: Frame): Frame => render.slice.surfaces[0];

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

// Shared across the ordered flow below.
let screenA = ""; // wall member 1 (HDMI-1)
let screenB = ""; // wall member 2 (HDMI-2)
let screenC = ""; // single, NON-member screen (HDMI-3)
let wallMuralId = ""; // the seeded "Wall" mural
let wallId = ""; // the VideoWall created over REST (A+B)
let sourceId = ""; // the library content source the wall spans
let sceneId = ""; // the scene we snapshot

let playerA: WsClient;
let playerB: WsClient;
let playerC: WsClient;

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // No POLYPTIC_BOOTSTRAP_TOKEN → OPEN mode: the fake agent is auto-registered + auto-approved.
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  // One agent, THREE outputs → three screens.
  const agent = await openAgent();
  agent.send(
    agentHello(MACHINE_ID, [
      { connector: CONN_A, width: RES_W, height: RES_H },
      { connector: CONN_B, width: RES_W, height: RES_H },
      { connector: CONN_C, width: RES_W, height: RES_H },
    ]),
  );
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply for scene-host-1",
    5_000,
  );
  expect(Array.isArray(apply.screens)).toBe(true);
  expect(apply.screens.length).toBe(3);

  const byConnector = (connector: string): string => {
    const entry = apply.screens.find((s: Frame) => s.connector === connector);
    expect(entry).toBeDefined();
    expect(typeof entry.screenId).toBe("string");
    expect(entry.screenId.length).toBeGreaterThan(0);
    return entry.screenId;
  };
  screenA = byConnector(CONN_A);
  screenB = byConnector(CONN_B);
  screenC = byConnector(CONN_C);

  // The seeded default "Wall" mural is where we place + combine + snapshot.
  const seeded = await snapshot("admin/state with seeded Wall mural");
  expect(Array.isArray(seeded.murals)).toBe(true);
  const wall = seeded.murals.find((m: Frame) => m.name === "Wall");
  expect(wall).toBeDefined();
  wallMuralId = wall.id;

  // Place A + B ADJACENT and C as a single screen (explicit w/h → deterministic geometry).
  for (const [screenId, x, y] of [
    [screenA, A_X, A_Y],
    [screenB, B_X, B_Y],
    [screenC, C_X, C_Y],
  ] as const) {
    const res = await putJson(`/api/v1/screens/${screenId}/placement`, {
      muralId: wallMuralId,
      x,
      y,
      w: RES_W,
      h: RES_H,
    });
    expect(res.ok).toBe(true);
    await drain(res);
  }

  // A fake player per screen so content pushes have somewhere to land.
  playerA = await connectPlayer(screenA);
  playerB = await connectPlayer(screenB);
  playerC = await connectPlayer(screenC);

  // A LIBRARY content source the wall will span (so the scene captures content as {sourceId}).
  const srcRes = await postJson(`/api/v1/content-sources`, {
    name: LIB_NAME,
    kind: "web",
    url: LIB_URL,
  });
  expect(srcRes.status).toBe(201);
  const srcBody = (await srcRes.json()) as Frame;
  expect(srcBody.source?.id).toBeDefined();
  sourceId = srcBody.source.id;

  // Combine A + B into a video wall and span the library source across it.
  const combine = await postJson(`/api/v1/murals/${wallMuralId}/walls`, {
    muralId: wallMuralId,
    memberScreenIds: [screenA, screenB],
  });
  expect(combine.status).toBeGreaterThanOrEqual(200);
  expect(combine.status).toBeLessThan(300);
  const combineBody = (await combine.json()) as Frame;
  expect(combineBody.wall?.id).toBeDefined();
  wallId = combineBody.wall.id;

  const wallContent = await putJson(`/api/v1/walls/${wallId}/content`, { sourceId });
  expect(wallContent.status).toBe(200);
  await drain(wallContent);

  // Give screen C an AD-HOC url (so the scene captures its content as {url}).
  const cContent = await putJson(`/api/v1/screens/${screenC}/content`, { url: C_URL });
  expect(cContent.status).toBe(200);
  await drain(cContent);
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
// Scenes — the heart of Phase 3d
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 3d scenes (saved wall snapshots)", () => {
  test(
    "admin/state carries scenes[] and starts empty",
    async () => {
      const state = await snapshot("admin/state with empty scenes");
      expect(Array.isArray(state.scenes)).toBe(true);
      expect(state.scenes.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /scenes snapshots the CURRENT wall (placements + walls + screens + content)",
    async () => {
      const res = await postJson(`/api/v1/scenes`, { name: SCENE_NAME, muralId: wallMuralId });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      const body = (await res.json()) as Frame;
      expect(body.scene?.id).toBeDefined();
      sceneId = body.scene.id;

      const state = await snapshot("admin/state with the saved scene");
      expect(state.scenes.length).toBe(1);
      const scene = sceneById(state, sceneId);
      expect(scene).toBeDefined();
      expect(scene.name).toBe(SCENE_NAME);
      expect(scene.muralId).toBe(wallMuralId);

      // LAYOUT — every placement on the mural (A, B, C) at its current geometry.
      expect(Array.isArray(scene.placements)).toBe(true);
      expect(scene.placements.length).toBe(3);
      const scenePlacement = (screenId: string): Frame => {
        const p = scene.placements.find((pp: Frame) => pp.screenId === screenId);
        expect(p).toBeDefined();
        return p;
      };
      expect(scenePlacement(screenA)).toMatchObject({ x: A_X, y: A_Y, w: RES_W, h: RES_H });
      expect(scenePlacement(screenB)).toMatchObject({ x: B_X, y: B_Y, w: RES_W, h: RES_H });
      expect(scenePlacement(screenC)).toMatchObject({ x: C_X, y: C_Y, w: RES_W, h: RES_H });

      // GROUPING + wall content — one wall {A,B} spanning the LIBRARY source → content {sourceId}.
      expect(Array.isArray(scene.walls)).toBe(true);
      expect(scene.walls.length).toBe(1);
      const sceneWall = scene.walls[0];
      expect(Array.isArray(sceneWall.memberScreenIds)).toBe(true);
      expect(sceneWall.memberScreenIds.length).toBe(2);
      expect(sceneWall.memberScreenIds).toContain(screenA);
      expect(sceneWall.memberScreenIds).toContain(screenB);
      expect(sceneWall.content).toBeDefined();
      expect(sceneWall.content.sourceId).toBe(sourceId);

      // Placed-but-NOT-walled screen content — C showing the AD-HOC url → content {url}.
      expect(Array.isArray(scene.screens)).toBe(true);
      expect(scene.screens.length).toBe(1);
      const sceneScreenC = scene.screens[0];
      expect(sceneScreenC.screenId).toBe(screenC);
      expect(sceneScreenC.content).toBeDefined();
      expect(sceneScreenC.content.url).toBe(C_URL);
    },
    TEST_TIMEOUT,
  );

  test(
    "mutating the wall diverges from the saved scene (move A, split, re-content)",
    async () => {
      // Move A elsewhere.
      const moveA = await putJson(`/api/v1/screens/${screenA}/placement`, {
        muralId: wallMuralId,
        x: MOVED_A_X,
        y: MOVED_A_Y,
        w: RES_W,
        h: RES_H,
      });
      expect(moveA.ok).toBe(true);
      await drain(moveA);

      // Split the wall (A+B become single screens again).
      const split = await del(`/api/v1/walls/${wallId}`);
      expect(split.status).toBeGreaterThanOrEqual(200);
      expect(split.status).toBeLessThan(300);
      await drain(split);

      // Change A's and C's content to something the scene does NOT carry.
      const aContent = await putJson(`/api/v1/screens/${screenA}/content`, { url: MUT_A_URL });
      expect(aContent.status).toBe(200);
      await drain(aContent);
      const cContent = await putJson(`/api/v1/screens/${screenC}/content`, { url: MUT_C_URL });
      expect(cContent.status).toBe(200);
      await drain(cContent);

      // admin/state now reflects the DIVERGED live wall, not the snapshot.
      const state = await snapshot("admin/state after diverging from the scene");
      expect(wallsOf(state).length).toBe(0); // split → no walls
      expect(placementFor(state, screenA)).toMatchObject({ x: MOVED_A_X, y: MOVED_A_Y });
      // The scene itself is untouched (it's a snapshot, not a live binding).
      const scene = sceneById(state, sceneId);
      expect(scene.placements.find((p: Frame) => p.screenId === screenA)).toMatchObject({
        x: A_X,
        y: A_Y,
      });
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /scenes/:id/apply restores layout + grouping + content and sets activeSceneId",
    async () => {
      // Fence: only renders with a HIGHER revision than this can be the result of the apply.
      const preRevision = await currentRevision();

      const res = await postJson(`/api/v1/scenes/${sceneId}/apply`);
      expect(res.status).toBe(200);
      await drain(res);

      // ── admin/state: placements + grouping match the snapshot again ──────────
      const state = await snapshot("admin/state after applying the scene");
      expect(placementFor(state, screenA)).toMatchObject({ x: A_X, y: A_Y, w: RES_W, h: RES_H });
      expect(placementFor(state, screenB)).toMatchObject({ x: B_X, y: B_Y, w: RES_W, h: RES_H });
      expect(placementFor(state, screenC)).toMatchObject({ x: C_X, y: C_Y, w: RES_W, h: RES_H });

      // The wall is recreated (a fresh id, but the same membership).
      const walls = wallsOf(state);
      expect(walls.length).toBe(1);
      expect(walls[0].memberScreenIds.length).toBe(2);
      expect(walls[0].memberScreenIds).toContain(screenA);
      expect(walls[0].memberScreenIds).toContain(screenB);

      // DesiredState.activeSceneId points at the applied scene.
      const desired = await (await fetch(`${BASE}/api/v1/state`)).json();
      expect((desired as Frame).activeSceneId).toBe(sceneId);

      // ── players: the restored content lands live ────────────────────────────
      // A + B → a SPAN surface at the LIBRARY source's url (the source resolved to its current url).
      const renderA = await playerA.waitFor(
        (m) =>
          m.t === "server/render" &&
          m.revision > preRevision &&
          m.slice?.surfaces?.length === 1 &&
          m.slice.surfaces[0]?.url === LIB_URL &&
          m.slice.surfaces[0]?.span !== undefined,
        "restored span render for A",
        5_000,
      );
      const renderB = await playerB.waitFor(
        (m) =>
          m.t === "server/render" &&
          m.revision > preRevision &&
          m.slice?.surfaces?.length === 1 &&
          m.slice.surfaces[0]?.url === LIB_URL &&
          m.slice.surfaces[0]?.span !== undefined,
        "restored span render for B",
        5_000,
      );
      const sA = surfaceOf(renderA);
      const sB = surfaceOf(renderB);
      for (const s of [sA, sB]) {
        expect(s.type).toBe("web");
        expect(s.url).toBe(LIB_URL);
        expect(s.region).toMatchObject({ x: 0, y: 0, w: RES_W, h: RES_H });
        expect(s.span.contentW).toBe(EXPECT_CONTENT_W);
        expect(s.span.contentH).toBe(EXPECT_CONTENT_H);
        expect(s.span.offsetY).toBe(OFFSET_Y);
      }
      expect(sA.span.offsetX).toBe(A_OFFSET_X);
      expect(sB.span.offsetX).toBe(B_OFFSET_X);

      // C → its single-screen surface at the AD-HOC url, NO span.
      const renderC = await playerC.waitFor(
        (m) =>
          m.t === "server/render" &&
          m.revision > preRevision &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => s.url === C_URL),
        "restored single-screen render for C",
        5_000,
      );
      const surfaceC = renderC.slice.surfaces.find((s: Frame) => s.url === C_URL);
      expect(surfaceC).toBeDefined();
      expect(surfaceC.type).toBe("web");
      expect(surfaceC.span).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "PATCH /scenes/:id sets name + scheduleAt (stored, surfaced in admin/state)",
    async () => {
      const res = await patchJson(`/api/v1/scenes/${sceneId}`, {
        name: SCENE_RENAME,
        scheduleAt: SCENE_SCHEDULE,
      });
      expect(res.status).toBe(200);
      await drain(res);

      const state = await snapshot("admin/state after patching the scene");
      const scene = sceneById(state, sceneId);
      expect(scene).toBeDefined();
      expect(scene.name).toBe(SCENE_RENAME);
      // Scheduling is ILLUSTRATIVE — stored, never fired — but it must be surfaced.
      expect(scene.scheduleAt).toBe(SCENE_SCHEDULE);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /scenes/:id/apply for an unknown scene → 404",
    async () => {
      const res = await postJson(`/api/v1/scenes/scene-does-not-exist/apply`);
      expect(res.status).toBe(404);
      await drain(res);
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE /scenes/:id removes it from admin/state.scenes",
    async () => {
      const res = await del(`/api/v1/scenes/${sceneId}`);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      await drain(res);

      const state = await snapshot("admin/state after deleting the scene");
      expect(sceneById(state, sceneId)).toBeUndefined();
      expect(state.scenes.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
