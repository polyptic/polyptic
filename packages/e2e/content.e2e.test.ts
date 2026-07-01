/**
 * @polyptic/e2e — Phase 3c CONTENT LIBRARY suite against the REAL control plane.
 *
 * Phase 3c adds a reusable, named **content library**: a set of `ContentSource` entries
 * ({id,name,kind,url}, kind ∈ web|dashboard|image|video) you manage once and assign to screens or
 * video walls by `sourceId` — replacing the ad-hoc URL field (which MUST keep working). The admin
 * snapshot (`admin/state`) now carries `contentSources[]`.
 *
 * THE MODEL (server resolves; players stay dumb):
 *   - A `ContentSource` is a library entry. CRUD over REST; it appears in admin/state.contentSources.
 *   - Assigning content to a screen / wall now takes EITHER a library `{sourceId}` OR an ad-hoc `{url}`
 *     (exactly one — the contract's refined SetContentBody):
 *       · {sourceId} → look the source up (404 if unknown) → build a surface of THAT kind with the
 *         source's url. web/dashboard → url field; image/video → src field (the renderable Surface
 *         types). For a SCREEN: one surface filling its region (no span). For a WALL: the SAME kind of
 *         surface but SPANNING (each member renders its slice — Surface.span, same union-bbox math 3b
 *         used for {url}).
 *       · {url} → an ad-hoc WEB surface, exactly as Phase 3b did (no regression).
 *   - LIVE library: the server remembers which source each screen/wall shows; UPDATING a source
 *     re-resolves and re-pushes `server/render` to every screen + wall displaying it — same stable
 *     surface id, so the player swaps in place (the INSTANT property, D5).
 *   - DELETING a source that is in use: the server EITHER clears those assignments (pushes an empty
 *     render) OR rejects with 409 — this suite reads the response and asserts whichever it implements.
 *
 * THE SPAN MATH (unchanged from 3b; server computes, player renders — they MUST agree):
 *   A wall's content geometry = the UNION bounding box of its members' placements (canvas px). Each
 *   member's surface region = its full screen canvas {0,0,member.w,member.h};
 *   span = {contentW, contentH, offsetX: member.x-unionMinX, offsetY: member.y-unionMinY}.
 *
 * We spawn the actual server (`packages/server/src/index.ts`) against the MemoryStore (STORE=memory)
 * on its OWN PORT (8094). With NO `POLYPTIC_BOOTSTRAP_TOKEN` the server runs in OPEN mode: one fake
 * agent reporting THREE outputs is auto-registered + auto-approved, giving three screens. We place two
 * of them ADJACENT on the seeded "Wall" mural and combine them into a video wall; the third stays a
 * single screen used for single-screen assignments. Then we drive the 3c REST surface over `fetch`.
 *
 * Robustness: every WS read is buffered (a frame that arrives between awaits is never missed) and
 * carries a per-message timeout. For each state assertion we open a FRESH `/admin` connection and read
 * its first `admin/state` — a brand-new client's snapshot always reflects CURRENT server state. The
 * server process is torn down in `afterAll`.
 *
 * This suite is independent of the other e2e suites (each on its own port + fresh memory store):
 * polyptych (8090), enrollment (8091), murals (8092), walls (8093). All must stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8094;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "content-host-1";

// Three outputs at the same native resolution: placing the wall members at this size keeps each
// member's PLACEMENT geometry equal to its SCREEN canvas, so "member.w/h" is unambiguous.
const RES_W = 1920;
const RES_H = 1080;

const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";
const CONN_C = "HDMI-3";

// Adjacent 2×1 placement with a NON-zero union origin (100,50) so the offsets must be computed as
// (member.x - unionMinX), not the raw placement x.
//   A at (100,50,1920,1080)  → 100..2020
//   B at (2020,50,1920,1080) → 2020..3940 (abuts A)
// union: minX=100 minY=50 maxX=3940 maxY=1130 → contentW=3840 contentH=1080
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

async function patchJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PATCH",
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
 * A brand-new client's first snapshot always reflects CURRENT server state.
 */
async function snapshot(label: string, timeoutMs = 4_000): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send(adminHello());
  const state = await admin.waitFor((m) => m.t === "admin/state", label, timeoutMs);
  admin.close();
  return state;
}

const sourcesOf = (state: Frame): Frame[] =>
  Array.isArray(state.contentSources) ? state.contentSources : [];
const sourceById = (state: Frame, id: string): Frame | undefined =>
  sourcesOf(state).find((s) => s.id === id);
const sourceByName = (state: Frame, name: string): Frame | undefined =>
  sourcesOf(state).find((s) => s.name === name);

/** A renderable surface's content URL lives in `url` (web/dashboard) or `src` (image/video). */
const surfUrl = (s: Frame): string | undefined => (s?.url !== undefined ? s.url : s?.src);

/** Assert a single-screen surface renders the source's kind + url (mapped to url/src by kind). */
function expectSurfaceContent(s: Frame, kind: string, url: string): void {
  expect(s.type).toBe(kind);
  if (kind === "image" || kind === "video") {
    expect(s.src).toBe(url);
  } else {
    expect(s.url).toBe(url);
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Shared across the ordered flow (bun runs tests in source order, sequentially).
// ─────────────────────────────────────────────────────────────────────────────

let screenA = ""; // wall member 1 (HDMI-1)
let screenB = ""; // wall member 2 (HDMI-2)
let screenC = ""; // single, NON-member screen (HDMI-3) — used for single-screen assignments
let wallMuralId = ""; // the seeded "Wall" mural
let wallId = ""; // the VideoWall created over REST

// Library sources, distinct urls so a player render can be matched by its content url.
const WEB_URL = "https://example.com/lib-web";
const DASH_URL = "https://dashboard.example.com/embed/abc?kiosk";
const IMAGE_URL = "https://cdn.example.com/lib-image.png";
const VIDEO_URL = "https://cdn.example.com/lib-video.mp4";
const WEB_URL_V2 = "https://example.com/lib-web-updated"; // PATCH target — proves a live re-resolve
const IMAGE_URL_V2 = "https://cdn.example.com/lib-image-updated.png";
const ADHOC_URL = "https://example.com/adhoc-web"; // 3b ad-hoc path (no regression)

let srcWeb: Frame; // {id,name,kind,url}
let srcDashboard: Frame;
let srcImage: Frame;
let srcVideo: Frame;

let screenWebSurfaceId = ""; // C's surface id for the assigned web source — stable across a live update
let wallSurfaceIdA = ""; // A's wall surface id — stable across a live update

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
      AUTH_ENABLED: "false",
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
    "server/apply for content-host-1",
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

  // A fake player per screen so content pushes have somewhere to land.
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
// The content library — CRUD over REST, surfaced in admin/state.contentSources
// ─────────────────────────────────────────────────────────────────────────────

/** Create a source over REST and resolve it from a fresh admin snapshot (response-shape agnostic). */
async function createSource(name: string, kind: string, url: string): Promise<Frame> {
  const res = await postJson(`/api/v1/content-sources`, { name, kind, url });
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  await drain(res);

  const state = await snapshot(`admin/state after creating source ${name}`);
  const src = sourceByName(state, name);
  expect(src).toBeDefined();
  expect(typeof src!.id).toBe("string");
  expect(src!.id.length).toBeGreaterThan(0);
  expect(src!.kind).toBe(kind);
  expect(src!.url).toBe(url);
  return src!;
}

describe("phase 3c content library CRUD", () => {
  test(
    "admin/state carries contentSources[] and starts empty",
    async () => {
      const state = await snapshot("admin/state with empty contentSources");
      expect(Array.isArray(state.contentSources)).toBe(true);
      expect(state.contentSources.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /content-sources creates a source of each kind (web, dashboard, image, video)",
    async () => {
      srcWeb = await createSource("Lobby Web", "web", WEB_URL);
      srcDashboard = await createSource("Ops Dashboard", "dashboard", DASH_URL);
      srcImage = await createSource("Brand Image", "image", IMAGE_URL);
      srcVideo = await createSource("Promo Video", "video", VIDEO_URL);

      const state = await snapshot("admin/state with four library sources");
      expect(state.contentSources.length).toBe(4);
      // Each created id is present and distinct.
      const ids = [srcWeb.id, srcDashboard.id, srcImage.id, srcVideo.id];
      expect(new Set(ids).size).toBe(4);
      for (const id of ids) expect(sourceById(state, id)).toBeDefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "PATCH /content-sources/:id updates a source (rename) — reflected in admin/state",
    async () => {
      const res = await patchJson(`/api/v1/content-sources/${srcWeb.id}`, { name: "Lobby Web 2" });
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      await drain(res);

      const state = await snapshot("admin/state after renaming a source");
      const updated = sourceById(state, srcWeb.id);
      expect(updated).toBeDefined();
      expect(updated!.name).toBe("Lobby Web 2");
      // kind + url untouched by a name-only patch.
      expect(updated!.kind).toBe("web");
      expect(updated!.url).toBe(WEB_URL);
      srcWeb = updated!;
    },
    TEST_TIMEOUT,
  );

  test(
    "PATCH /content-sources/:id on an unknown id → 404",
    async () => {
      const res = await patchJson(`/api/v1/content-sources/source-does-not-exist`, {
        name: "ghost",
      });
      expect(res.status).toBe(404);
      await drain(res);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Assigning a library source to a SINGLE screen (resolves to one surface, no span)
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 3c assign a library source to a single screen", () => {
  test(
    "PUT /screens/:id/content {sourceId} resolves to a surface of the source's kind + url",
    async () => {
      const cases = [
        { src: () => srcWeb, kind: "web", url: WEB_URL },
        { src: () => srcDashboard, kind: "dashboard", url: DASH_URL },
        { src: () => srcImage, kind: "image", url: IMAGE_URL },
        { src: () => srcVideo, kind: "video", url: VIDEO_URL },
      ];

      for (const c of cases) {
        const source = c.src();
        const res = await putJson(`/api/v1/screens/${screenC}/content`, { sourceId: source.id });
        expect(res.status).toBe(200);
        await drain(res);

        const render = await playerC.waitFor(
          (m) =>
            m.t === "server/render" &&
            Array.isArray(m.slice?.surfaces) &&
            m.slice.surfaces.some((s: Frame) => surfUrl(s) === c.url),
          `single-screen ${c.kind} render for C`,
        );
        const surface = render.slice.surfaces.find((s: Frame) => surfUrl(s) === c.url);
        expect(surface).toBeDefined();
        expectSurfaceContent(surface, c.kind, c.url);
        // A single-screen tile fills its region and carries NO span.
        expect(surface.region).toMatchObject({ x: 0, y: 0, w: RES_W, h: RES_H });
        expect(surface.span).toBeUndefined();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT /screens/:id/content {sourceId} with an unknown source → 404 (no render)",
    async () => {
      const res = await putJson(`/api/v1/screens/${screenC}/content`, {
        sourceId: "source-does-not-exist",
      });
      expect(res.status).toBe(404);
      await drain(res);
    },
    TEST_TIMEOUT,
  );

  test(
    "updating an ASSIGNED source re-pushes server/render (new url, SAME surface id — in-place, D5)",
    async () => {
      // Make the (renamed) web source C's CURRENT assignment, and capture its stable surface id.
      const assign = await putJson(`/api/v1/screens/${screenC}/content`, { sourceId: srcWeb.id });
      expect(assign.status).toBe(200);
      await drain(assign);
      const before = await playerC.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => surfUrl(s) === WEB_URL),
        "web source render for C (pre-update)",
      );
      const beforeSurface = before.slice.surfaces.find((s: Frame) => surfUrl(s) === WEB_URL);
      expect(beforeSurface).toBeDefined();
      expect(typeof beforeSurface.id).toBe("string");
      expect(beforeSurface.id.length).toBeGreaterThan(0);
      screenWebSurfaceId = beforeSurface.id;

      // PATCH the source's url → the server RE-RESOLVES and RE-PUSHES to the screen showing it.
      const started = Date.now();
      const patch = await patchJson(`/api/v1/content-sources/${srcWeb.id}`, { url: WEB_URL_V2 });
      expect(patch.status).toBeGreaterThanOrEqual(200);
      expect(patch.status).toBeLessThan(300);
      await drain(patch);

      const after = await playerC.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => surfUrl(s) === WEB_URL_V2),
        "web source render for C (post-update)",
      );
      const elapsed = Date.now() - started;
      const afterSurface = after.slice.surfaces.find((s: Frame) => surfUrl(s) === WEB_URL_V2);
      expect(afterSurface).toBeDefined();
      expect(afterSurface.type).toBe("web");
      expect(afterSurface.url).toBe(WEB_URL_V2);
      // SAME keyed surface id → the player mutates the existing element rather than remounting it.
      expect(afterSurface.id).toBe(screenWebSurfaceId);
      // The live re-push lands promptly (the INSTANT property — generous bound).
      expect(elapsed).toBeLessThan(1_000);

      // Keep srcWeb's url in sync with the server for any later assertions.
      srcWeb = { ...srcWeb, url: WEB_URL_V2 };
    },
    TEST_TIMEOUT,
  );

  test(
    "ad-hoc {url} content path STILL works (web surface, no span — 3b no regression)",
    async () => {
      const res = await putJson(`/api/v1/screens/${screenC}/content`, { url: ADHOC_URL });
      expect(res.status).toBe(200);
      await drain(res);

      const render = await playerC.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => s.url === ADHOC_URL),
        "ad-hoc web render for C",
      );
      const surface = render.slice.surfaces.find((s: Frame) => s.url === ADHOC_URL);
      expect(surface).toBeDefined();
      expect(surface.type).toBe("web");
      expect(surface.url).toBe(ADHOC_URL);
      expect(surface.span).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT /screens/:id/content with BOTH sourceId and url → 400 (contract: exactly one)",
    async () => {
      const res = await putJson(`/api/v1/screens/${screenC}/content`, {
        sourceId: srcImage.id,
        url: ADHOC_URL,
      });
      expect(res.status).toBe(400);
      await drain(res);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Assigning a library source to a WALL (the same kind of surface, SPANNING)
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 3c assign a library source to a video wall (spanning)", () => {
  test(
    "combine A + B into a video wall",
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
      expect(created.memberScreenIds).toContain(screenA);
      expect(created.memberScreenIds).toContain(screenB);
      wallId = created.id;
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT /walls/:id/content {sourceId} gives EACH member a SPANNING surface of the source's kind",
    async () => {
      // An IMAGE source so we also prove image→src mapping survives the spanning path.
      const res = await putJson(`/api/v1/walls/${wallId}/content`, { sourceId: srcImage.id });
      expect(res.status).toBe(200);
      await drain(res);

      const matchMember = (m: Frame): boolean =>
        m.t === "server/render" &&
        Array.isArray(m.slice?.surfaces) &&
        m.slice.surfaces.length === 1 &&
        surfUrl(m.slice.surfaces[0]) === IMAGE_URL &&
        m.slice.surfaces[0]?.span !== undefined;

      const renderA = await playerA.waitFor(matchMember, "wall image render for A");
      const renderB = await playerB.waitFor(matchMember, "wall image render for B");
      const sA = renderA.slice.surfaces[0];
      const sB = renderB.slice.surfaces[0];

      for (const s of [sA, sB]) {
        // The source's KIND drives the surface type; image maps its url to `src`.
        expect(s.type).toBe("image");
        expect(s.src).toBe(IMAGE_URL);
        // region = the member's FULL screen canvas; the player translates the span within it.
        expect(s.region).toMatchObject({ x: 0, y: 0, w: RES_W, h: RES_H });
        // The spanning content is the UNION bounding box of the members' placements.
        expect(s.span.contentW).toBe(EXPECT_CONTENT_W);
        expect(s.span.contentH).toBe(EXPECT_CONTENT_H);
        expect(s.span.offsetY).toBe(OFFSET_Y);
      }
      expect(sA.span.offsetX).toBe(A_OFFSET_X);
      expect(sB.span.offsetX).toBe(B_OFFSET_X);

      expect(typeof sA.id).toBe("string");
      expect(sA.id.length).toBeGreaterThan(0);
      wallSurfaceIdA = sA.id;
    },
    TEST_TIMEOUT,
  );

  test(
    "updating the wall's assigned source re-pushes to BOTH members (new src, SAME surface id)",
    async () => {
      const patch = await patchJson(`/api/v1/content-sources/${srcImage.id}`, {
        url: IMAGE_URL_V2,
      });
      expect(patch.status).toBeGreaterThanOrEqual(200);
      expect(patch.status).toBeLessThan(300);
      await drain(patch);

      const matchUpdated = (m: Frame): boolean =>
        m.t === "server/render" &&
        Array.isArray(m.slice?.surfaces) &&
        m.slice.surfaces.length === 1 &&
        surfUrl(m.slice.surfaces[0]) === IMAGE_URL_V2;

      const renderA = await playerA.waitFor(matchUpdated, "updated wall image render for A");
      const renderB = await playerB.waitFor(matchUpdated, "updated wall image render for B");
      const sA = renderA.slice.surfaces[0];
      const sB = renderB.slice.surfaces[0];

      // SAME stable wall surface id on A → in-place swap; span geometry unchanged by a content swap.
      expect(sA.id).toBe(wallSurfaceIdA);
      expect(sA.type).toBe("image");
      expect(sA.src).toBe(IMAGE_URL_V2);
      expect(sA.span.contentW).toBe(EXPECT_CONTENT_W);
      expect(sA.span.offsetX).toBe(A_OFFSET_X);
      expect(sB.src).toBe(IMAGE_URL_V2);
      expect(sB.span.offsetX).toBe(B_OFFSET_X);

      srcImage = { ...srcImage, url: IMAGE_URL_V2 };
    },
    TEST_TIMEOUT,
  );

  test(
    "PUT /walls/:id/content {sourceId} with an unknown source → 404",
    async () => {
      const res = await putJson(`/api/v1/walls/${wallId}/content`, {
        sourceId: "source-does-not-exist",
      });
      expect(res.status).toBe(404);
      await drain(res);
    },
    TEST_TIMEOUT,
  );

  test(
    "ad-hoc {url} wall content STILL spans across members (3b no regression)",
    async () => {
      const url = "https://example.com/adhoc-wall";
      const res = await putJson(`/api/v1/walls/${wallId}/content`, { url });
      expect(res.status).toBe(200);
      await drain(res);

      const matchMember = (m: Frame): boolean =>
        m.t === "server/render" &&
        Array.isArray(m.slice?.surfaces) &&
        m.slice.surfaces.length === 1 &&
        m.slice.surfaces[0]?.url === url &&
        m.slice.surfaces[0]?.span !== undefined;

      const renderA = await playerA.waitFor(matchMember, "ad-hoc wall render for A");
      const renderB = await playerB.waitFor(matchMember, "ad-hoc wall render for B");
      const sA = renderA.slice.surfaces[0];
      const sB = renderB.slice.surfaces[0];

      // Ad-hoc wall content is a WEB surface (exactly as Phase 3b), still spanning.
      for (const s of [sA, sB]) {
        expect(s.type).toBe("web");
        expect(s.url).toBe(url);
        expect(s.span.contentW).toBe(EXPECT_CONTENT_W);
        expect(s.span.contentH).toBe(EXPECT_CONTENT_H);
      }
      expect(sA.span.offsetX).toBe(A_OFFSET_X);
      expect(sB.span.offsetX).toBe(B_OFFSET_X);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Deleting a library source — the server EITHER clears in-use assignments OR 409s.
// We read the response and assert whichever behaviour it implements (consistently).
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 3c delete a content source", () => {
  test(
    "DELETE /content-sources/:id clears in-use assignments OR rejects with 409 (per the server)",
    async () => {
      // Make the VIDEO source the CURRENT assignment on the single screen C, so it is in use.
      const assign = await putJson(`/api/v1/screens/${screenC}/content`, { sourceId: srcVideo.id });
      expect(assign.status).toBe(200);
      await drain(assign);
      await playerC.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => surfUrl(s) === VIDEO_URL),
        "video source render for C (pre-delete)",
      );

      const res = await del(`/api/v1/content-sources/${srcVideo.id}`);

      if (res.status === 409) {
        // In-use guard: the source must REMAIN in the library and stay assigned.
        await drain(res);
        const state = await snapshot("admin/state after rejected in-use delete");
        expect(sourceById(state, srcVideo.id)).toBeDefined();
        expect(state.contentSources.length).toBe(4);
      } else {
        // Clear-on-delete: the source is GONE and the screen showing it gets an EMPTY render.
        expect(res.status).toBeGreaterThanOrEqual(200);
        expect(res.status).toBeLessThan(300);
        await drain(res);

        const cleared = await playerC.waitFor(
          (m) =>
            m.t === "server/render" &&
            Array.isArray(m.slice?.surfaces) &&
            m.slice.surfaces.length === 0,
          "cleared render for C after source delete",
        );
        expect(cleared.slice.surfaces.length).toBe(0);

        const state = await snapshot("admin/state after clearing in-use source");
        expect(sourceById(state, srcVideo.id)).toBeUndefined();
        expect(state.contentSources.length).toBe(3);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE /content-sources/:id on an unknown id → 404",
    async () => {
      const res = await del(`/api/v1/content-sources/source-does-not-exist`);
      expect(res.status).toBe(404);
      await drain(res);
    },
    TEST_TIMEOUT,
  );
});
