/**
 * @polyptic/e2e — Phase 3b COMBINED SURFACES (video walls) suite against the REAL control plane.
 *
 * Phase 3b lets an operator **combine** adjacent placed screens into one logical surface so a single
 * piece of content **spans** across all of them; each member's player renders only its slice. The
 * admin snapshot (`admin/state`) now carries `videoWalls[]`, and a member's `server/render` surface
 * carries a `span` ({contentW, contentH, offsetX, offsetY}) describing the sub-rectangle that screen
 * shows of the spanning content.
 *
 * THE SPAN MATH (server computes; player renders — they MUST agree):
 *   - A VideoWall's content geometry = the UNION bounding box of its members' placements (canvas px):
 *       unionMinX=min(x), unionMinY=min(y), unionMaxX=max(x+w), unionMaxY=max(y+h);
 *       contentW=unionMaxX-unionMinX, contentH=unionMaxY-unionMinY.
 *   - With content set, EACH member's slice becomes ONE web surface whose region is the member's full
 *     screen canvas {x:0,y:0,w:member.w,h:member.h}, url = the wall content, and
 *       span = {contentW, contentH, offsetX: member.x-unionMinX, offsetY: member.y-unionMinY}.
 *
 * We spawn the actual server (`packages/server/src/index.ts`) against the MemoryStore (STORE=memory)
 * on its OWN PORT (8093). With NO `POLYPTIC_BOOTSTRAP_TOKEN` the server runs in OPEN mode (the Phase 2a
 * default): one fake agent reporting THREE outputs is auto-registered + auto-approved, giving us three
 * screens. We place two of them ADJACENT on the seeded "Wall" mural (the third stays a single screen),
 * connect a fake player per screen, then drive the 3b REST surface over `fetch` and assert:
 *
 *   - `admin/state` carries `videoWalls[]` and starts empty;
 *   - POST   /api/v1/murals/:id/walls {muralId, memberScreenIds}  → a VideoWall appears in
 *            admin/state.videoWalls (members = the two placed screens);
 *       · memberScreenIds < 2            → 400 (contract min(2));
 *       · an unknown member screen       → 404;
 *       · an unknown mural               → 4xx (no wall created);
 *   - PUT    /api/v1/walls/:id/content {url}  → EACH member's player gets a `server/render` whose one
 *            web surface has url = content, region = its full screen canvas, and the CORRECT `span`
 *            (contentW/contentH = the union of placements; per-member offsets). A second content push
 *            keeps the SAME surface id (in-place DOM swap — the INSTANT property, D5);
 *   - PUT    /api/v1/screens/:id/content {url} on a WALL MEMBER  → 409 (it's spanned by the wall);
 *            on a NON-member single screen  → 200 + a `server/render` whose surface has NO `span`;
 *   - POST   /api/v1/walls/:id/ident  → `server/ident-pulse` to ALL members' players;
 *   - DELETE /api/v1/walls/:id  → the wall disappears from admin/state.videoWalls (split), and a former
 *            member now accepts single-screen content again (200, no span).
 *
 * Robustness: every WS read is buffered (a frame that arrives between awaits is never missed) and
 * carries a per-message timeout. For each state assertion we open a FRESH `/admin` connection and read
 * its first `admin/state` — a brand-new client's snapshot always reflects CURRENT server state, so we
 * never race a stale broadcast that happens to satisfy an absence check. The server process is torn
 * down in `afterAll`.
 *
 * This suite is independent of polyptych.e2e.test.ts (8090), enrollment.e2e.test.ts (8091) and
 * murals.e2e.test.ts (8092): its own port, fresh memory store. All four must stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8093;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "wall-host-1";

// Three outputs at the same native resolution. Placing the wall members at this size keeps each
// member's PLACEMENT geometry equal to its SCREEN canvas, so "member.w/h" is unambiguous.
const RES_W = 1920;
const RES_H = 1080;

const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";
const CONN_C = "HDMI-3";

// Adjacent 2×1 placement with a NON-zero union origin (100,50) so the offsets must be computed as
// (member.x - unionMinX), not the raw placement x — a server that forgets to subtract unionMin fails.
//   A at (100,50,1920,1080)  → x..x = 100..2020
//   B at (2020,50,1920,1080) → x..x = 2020..3940   (touches A's right edge — adjacent)
// union: minX=100 minY=50 maxX=3940 maxY=1130  → contentW=3840 contentH=1080
//   A: offsetX = 100-100 = 0,    offsetY = 50-50 = 0
//   B: offsetX = 2020-100 = 1920, offsetY = 50-50 = 0
const A_X = 100;
const A_Y = 50;
const B_X = A_X + RES_W; // 2020 — abuts A
const B_Y = 50;

const EXPECT_CONTENT_W = 3840;
const EXPECT_CONTENT_H = 1080;
const A_OFFSET_X = 0;
const B_OFFSET_X = RES_W; // 1920
const OFFSET_Y = 0;

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
 * A brand-new client's first snapshot always reflects CURRENT server state, so absence checks
 * (a wall that should be GONE) can't be satisfied by a stale, already-queued broadcast.
 */
async function snapshot(label: string, timeoutMs = 4_000): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send(adminHello());
  const state = await admin.waitFor((m) => m.t === "admin/state", label, timeoutMs);
  admin.close();
  return state;
}

const wallsOf = (state: Frame): Frame[] => (Array.isArray(state.videoWalls) ? state.videoWalls : []);
const wallById = (state: Frame, id: string): Frame | undefined =>
  wallsOf(state).find((w) => w.id === id);

/** The single web surface of a wall-member render, with its span. */
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

// Shared across the ordered flow below (bun runs tests in source order, sequentially).
let screenA = ""; // wall member 1 (HDMI-1)
let screenB = ""; // wall member 2 (HDMI-2)
let screenC = ""; // a single, NON-member screen (HDMI-3)
let wallMuralId = ""; // the seeded "Wall" mural
let wallId = ""; // the VideoWall created over REST
let wallSurfaceIdA = ""; // player A's wall surface id — must stay stable across content swaps (D5)

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
      // No POLYPTIC_BOOTSTRAP_TOKEN → OPEN mode: the fake agent is auto-registered + auto-approved,
      // so its screens exist to place + combine. (Gated enrollment is covered elsewhere.)
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  // One agent, THREE outputs → three screens (server/apply lists all three).
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
    "server/apply for wall-host-1",
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

  // The seeded default "Wall" mural is where we place + combine.
  const seeded = await snapshot("admin/state with seeded Wall mural");
  expect(Array.isArray(seeded.murals)).toBe(true);
  const wall = seeded.murals.find((m: Frame) => m.name === "Wall");
  expect(wall).toBeDefined();
  wallMuralId = wall.id;

  // Place the two wall members ADJACENT (explicit w/h so the geometry is deterministic).
  const placeA = await putJson(`/api/v1/screens/${screenA}/placement`, {
    muralId: wallMuralId,
    x: A_X,
    y: A_Y,
    w: RES_W,
    h: RES_H,
  });
  expect(placeA.ok).toBe(true);
  await drain(placeA);
  const placeB = await putJson(`/api/v1/screens/${screenB}/placement`, {
    muralId: wallMuralId,
    x: B_X,
    y: B_Y,
    w: RES_W,
    h: RES_H,
  });
  expect(placeB.ok).toBe(true);
  await drain(placeB);

  // A fake player per screen so content/ident pushes have somewhere to land.
  playerA = await connectPlayer(screenA);
  playerB = await connectPlayer(screenB);
  playerC = await connectPlayer(screenC);
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
// Combined surfaces — the heart of Phase 3b
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 3b combined surfaces (video walls)", () => {
  test(
    "admin/state carries videoWalls[] and starts empty",
    async () => {
      const state = await snapshot("admin/state with empty videoWalls");
      expect(Array.isArray(state.videoWalls)).toBe(true);
      expect(state.videoWalls.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /murals/:id/walls with < 2 members is rejected (400) — no wall created",
    async () => {
      const res = await postJson(`/api/v1/murals/${wallMuralId}/walls`, {
        muralId: wallMuralId,
        memberScreenIds: [screenA], // contract requires min(2)
      });
      expect(res.status).toBe(400);
      await drain(res);

      const state = await snapshot("admin/state after rejected <2 combine");
      expect(state.videoWalls.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /murals/:id/walls with an unknown member screen → 404 — no wall created",
    async () => {
      const res = await postJson(`/api/v1/murals/${wallMuralId}/walls`, {
        muralId: wallMuralId,
        memberScreenIds: [screenA, "screen-does-not-exist"],
      });
      expect(res.status).toBe(404);
      await drain(res);

      const state = await snapshot("admin/state after rejected unknown-member combine");
      expect(state.videoWalls.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /murals/:id/walls onto an unknown mural → 4xx — no wall created",
    async () => {
      const res = await postJson(`/api/v1/murals/mural-does-not-exist/walls`, {
        muralId: "mural-does-not-exist",
        memberScreenIds: [screenA, screenB],
      });
      expect(res.status).toBeGreaterThanOrEqual(400);
      expect(res.status).toBeLessThan(500);
      await drain(res);

      const state = await snapshot("admin/state after rejected unknown-mural combine");
      expect(state.videoWalls.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /murals/:id/walls combines two screens into a VideoWall in admin/state.videoWalls",
    async () => {
      const res = await postJson(`/api/v1/murals/${wallMuralId}/walls`, {
        muralId: wallMuralId,
        memberScreenIds: [screenA, screenB],
      });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      await drain(res);

      const state = await snapshot("admin/state with the combined wall");
      expect(state.videoWalls.length).toBe(1);
      const created = state.videoWalls[0];
      expect(typeof created.id).toBe("string");
      expect(created.id.length).toBeGreaterThan(0);
      expect(created.muralId).toBe(wallMuralId);
      expect(Array.isArray(created.memberScreenIds)).toBe(true);
      expect(created.memberScreenIds.length).toBe(2);
      expect(created.memberScreenIds).toContain(screenA);
      expect(created.memberScreenIds).toContain(screenB);
      wallId = created.id;
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT /walls/:id/content pushes a server/render with the correct span to EACH member",
    async () => {
      const url = "https://example.com/wall-content-1";
      const started = Date.now();
      const res = await putJson(`/api/v1/walls/${wallId}/content`, { url });
      expect(res.status).toBe(200);
      await drain(res);

      // Member A — left slice: offsetX 0.
      const renderA = await playerA.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.length === 1 &&
          m.slice.surfaces[0]?.url === url &&
          m.slice.surfaces[0]?.span !== undefined,
        "wall content render for A",
      );
      // Member B — right slice: offsetX 1920.
      const renderB = await playerB.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.length === 1 &&
          m.slice.surfaces[0]?.url === url &&
          m.slice.surfaces[0]?.span !== undefined,
        "wall content render for B",
      );
      const elapsed = Date.now() - started;

      const sA = surfaceOf(renderA);
      const sB = surfaceOf(renderB);

      // Both members: one full-screen web surface pointing at the wall content.
      for (const s of [sA, sB]) {
        expect(s.type).toBe("web");
        expect(s.url).toBe(url);
        // region = the member's FULL screen canvas (the player then translates the span within it).
        expect(s.region).toMatchObject({ x: 0, y: 0, w: RES_W, h: RES_H });
        // The spanning content is the UNION bounding box of the members' placements.
        expect(s.span.contentW).toBe(EXPECT_CONTENT_W);
        expect(s.span.contentH).toBe(EXPECT_CONTENT_H);
        expect(s.span.offsetY).toBe(OFFSET_Y);
      }
      // Per-member offsets: A shows the left half, B the right half.
      expect(sA.span.offsetX).toBe(A_OFFSET_X);
      expect(sB.span.offsetX).toBe(B_OFFSET_X);

      // Instant path: the push lands promptly (generous bound — D5 targets < ~150ms).
      expect(elapsed).toBeLessThan(1_000);

      // Remember A's surface id to assert the in-place swap (no remount) on the next push.
      expect(typeof sA.id).toBe("string");
      expect(sA.id.length).toBeGreaterThan(0);
      wallSurfaceIdA = sA.id;
    },
    TEST_TIMEOUT,
  );

  test(
    "a second /walls/:id/content push keeps the same surface id (in-place swap — D5)",
    async () => {
      const url = "https://example.com/wall-content-2";
      const res = await putJson(`/api/v1/walls/${wallId}/content`, { url });
      expect(res.status).toBe(200);
      await drain(res);

      const renderA = await playerA.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.length === 1 &&
          m.slice.surfaces[0]?.url === url,
        "second wall content render for A",
      );
      const sA = surfaceOf(renderA);
      // Same keyed surface id → the player mutates the existing element instead of remounting it.
      expect(sA.id).toBe(wallSurfaceIdA);
      expect(sA.url).toBe(url);
      // Span geometry is unchanged by a pure content swap.
      expect(sA.span.contentW).toBe(EXPECT_CONTENT_W);
      expect(sA.span.contentH).toBe(EXPECT_CONTENT_H);
      expect(sA.span.offsetX).toBe(A_OFFSET_X);
      expect(sA.span.offsetY).toBe(OFFSET_Y);
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT /screens/:id/content on a WALL MEMBER returns 409 (spanned by the wall)",
    async () => {
      const res = await putJson(`/api/v1/screens/${screenA}/content`, {
        url: "https://example.com/should-be-rejected",
      });
      expect(res.status).toBe(409);
      await drain(res);
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT /screens/:id/content on a NON-member screen → 200 + render with NO span",
    async () => {
      const url = "https://example.com/single-screen-c";
      const res = await putJson(`/api/v1/screens/${screenC}/content`, { url });
      expect(res.status).toBe(200);
      await drain(res);

      const renderC = await playerC.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => s.url === url),
        "single-screen content render for C",
      );
      const surface = renderC.slice.surfaces.find((s: Frame) => s.url === url);
      expect(surface).toBeDefined();
      expect(surface.type).toBe("web");
      // A plain single-screen tile carries NO span — it fills its region as today.
      expect(surface.span).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /walls/:id/ident pushes server/ident-pulse to ALL members' players",
    async () => {
      const res = await postJson(`/api/v1/walls/${wallId}/ident`, { on: true });
      expect(res.status).toBe(200);
      await drain(res);

      const pulseA = await playerA.waitFor(
        (m) => m.t === "server/ident-pulse" && m.on === true,
        "ident pulse for A",
      );
      const pulseB = await playerB.waitFor(
        (m) => m.t === "server/ident-pulse" && m.on === true,
        "ident pulse for B",
      );
      // Each member flashes its OWN friendly name.
      expect(typeof pulseA.friendlyName).toBe("string");
      expect(pulseA.friendlyName.length).toBeGreaterThan(0);
      expect(typeof pulseB.friendlyName).toBe("string");
      expect(pulseB.friendlyName.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE /walls/:id splits the wall (gone from admin/state) and frees its members",
    async () => {
      const res = await del(`/api/v1/walls/${wallId}`);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      await drain(res);

      const state = await snapshot("admin/state after split");
      expect(wallById(state, wallId)).toBeUndefined();
      expect(state.videoWalls.length).toBe(0);

      // A former member is a single screen again: single-screen content is accepted (was 409),
      // and the resulting surface has NO span.
      const url = "https://example.com/post-split-a";
      const put = await putJson(`/api/v1/screens/${screenA}/content`, { url });
      expect(put.status).toBe(200);
      await drain(put);

      const renderA = await playerA.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => s.url === url),
        "post-split single-screen render for A",
      );
      const surface = renderA.slice.surfaces.find((s: Frame) => s.url === url);
      expect(surface).toBeDefined();
      expect(surface.span).toBeUndefined();
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Wall lifecycle edge cases (regression for the post-build review's low findings):
// a wall must not outlive the spatial facts it depends on. Unplacing a member, or deleting the
// member's mural, DISSOLVES the wall and CLEARS each member's (now-meaningless) span slice — so no
// player is left rendering a stale fragment of content. A brand-new player's initial render reflects
// the member's CURRENT slice, which is the unambiguous proof the slice was cleared.
// ─────────────────────────────────────────────────────────────────────────────

/** Connect a fresh player and return its initial server/render slice (reflects current server state). */
async function freshInitialSlice(screenId: string): Promise<Frame> {
  const p = await WsClient.connect(`${WS}/player`);
  openClients.push(p);
  p.send(playerHello(screenId));
  const render = await p.waitFor(
    (m) => m.t === "server/render" && m.slice?.screenId === screenId,
    `fresh initial render for ${screenId}`,
    5_000,
  );
  return render.slice;
}

/** Re-combine A+B on the Wall mural, give it spanning content, and return the new wall id. */
async function recombineWithContent(url: string): Promise<string> {
  const combine = await postJson(`/api/v1/murals/${wallMuralId}/walls`, {
    muralId: wallMuralId,
    memberScreenIds: [screenA, screenB],
  });
  expect(combine.status).toBeGreaterThanOrEqual(200);
  expect(combine.status).toBeLessThan(300);
  await drain(combine);
  const state = await snapshot("admin/state with the re-combined wall");
  expect(state.videoWalls.length).toBe(1);
  const id = state.videoWalls[0].id;
  const content = await putJson(`/api/v1/walls/${id}/content`, { url });
  expect(content.status).toBe(200);
  await drain(content);
  return id;
}

describe("phase 3b wall lifecycle edge cases (regression)", () => {
  test(
    "unplacing a wall member DISSOLVES the wall and clears every member's slice",
    async () => {
      // After the split test both members are still placed — re-combine them with content.
      await recombineWithContent("https://example.com/dissolve-by-unplace");

      // Unplace member A → the combined surface can no longer exist.
      const unplace = await del(`/api/v1/screens/${screenA}/placement`);
      expect(unplace.status).toBe(200);
      await drain(unplace);

      const state = await snapshot("admin/state after unplacing a wall member");
      expect(state.videoWalls.length).toBe(0); // dissolved, not left degenerate
      expect(state.placements.some((p: Frame) => p.screenId === screenA)).toBe(false); // A → tray

      // Both members' CURRENT slices are empty (the span content was cleared, not left stale).
      const sliceA = await freshInitialSlice(screenA);
      const sliceB = await freshInitialSlice(screenB);
      expect(sliceA.surfaces.length).toBe(0);
      expect(sliceB.surfaces.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "deleting a mural DISSOLVES its walls and clears the members",
    async () => {
      // Re-place A adjacent to B (A was unplaced by the previous test), then re-combine with content.
      const placeA = await putJson(`/api/v1/screens/${screenA}/placement`, {
        muralId: wallMuralId,
        x: A_X,
        y: A_Y,
        w: RES_W,
        h: RES_H,
      });
      expect(placeA.ok).toBe(true);
      await drain(placeA);
      await recombineWithContent("https://example.com/dissolve-by-mural-delete");

      // Delete the whole mural → its walls go with it and the members are cleared.
      const delMural = await del(`/api/v1/murals/${wallMuralId}`);
      expect(delMural.status).toBeGreaterThanOrEqual(200);
      expect(delMural.status).toBeLessThan(300);
      await drain(delMural);

      const state = await snapshot("admin/state after deleting the wall's mural");
      expect(state.murals.some((m: Frame) => m.id === wallMuralId)).toBe(false);
      expect(state.videoWalls.length).toBe(0);
      expect(state.placements.some((p: Frame) => p.screenId === screenA)).toBe(false);
      expect(state.placements.some((p: Frame) => p.screenId === screenB)).toBe(false);

      // The former members render nothing now (no stale span fragment).
      const sliceA = await freshInitialSlice(screenA);
      const sliceB = await freshInitialSlice(screenB);
      expect(sliceA.surfaces.length).toBe(0);
      expect(sliceB.surfaces.length).toBe(0);
    },
    TEST_TIMEOUT,
  );
});
