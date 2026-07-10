/**
 * @polyptic/e2e — POL-57 PAGE ZOOM against the REAL control plane.
 *
 * Zoom is a browser-style scale on the framed page a screen (or a combined surface) is showing. Two
 * claims are load-bearing, and this suite pins both at the wire:
 *
 *   1. INSTANT (D5). `PUT /screens/:id/zoom` pushes a `server/render` whose surface keeps its stable
 *      id and url, with only `zoom` changed — so the player rescales the EXISTING iframe rather than
 *      remounting it. Anything that changed the id or the url would reload the page on the wall.
 *   2. REMEMBERED per (screen-or-wall, page). Re-assigning a page a screen has zoomed before brings
 *      the zoom back with it — including after the pair has shown something else in between — while
 *      the same page on a different screen is untouched.
 *
 * Plus the refusals: media has no page to zoom (409 not-zoomable), an empty screen has nothing to
 * zoom (409 no-content), and a wall member defers to its combined surface (409 wall-member, so the
 * console knows to offer the control on the wall instead).
 *
 * Harness (as the other suites): spawn `packages/server/src/index.ts` with STORE=memory on its own
 * port, OPEN enrollment, one fake agent reporting three outputs → three screens. A and B are placed
 * adjacent on the seeded "Wall" mural and combined; C stays single. Fake players receive the renders.
 *
 * Ports in use elsewhere: polyptych (8090), enrollment (8091), murals (8092), walls (8093),
 * content (8094), scenes (8095), auth (8096), preview (8097), media (8098), activity/static (8099),
 * remove (8100), image-updates (8117). This suite owns 8101.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8101;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;

const MACHINE_ID = "zoom-host-1";
const RES_W = 1920;
const RES_H = 1080;
const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";
const CONN_C = "HDMI-3";

/** Two adjacent 1920×1080 panels → a 3840×1080 spanning content. */
const A_X = 0;
const B_X = RES_W;
const PLACE_Y = 0;
const SPAN_W = RES_W * 2;

const PAGE_ONE = "https://example.com/zoom-one";
const PAGE_TWO = "https://example.com/zoom-two";
const WALL_PAGE = "https://example.com/zoom-wall";
const IMAGE_URL = "https://cdn.example.com/zoom-image.png";

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
// REST + wire helpers
// ─────────────────────────────────────────────────────────────────────────────

function putJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function postJson(path: string, body: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

/** PUT a zoom and assert the status, draining the body. Returns the parsed body for error checks. */
async function setZoom(path: string, zoom: number, expectStatus: number): Promise<Frame> {
  const res = await putJson(path, { zoom });
  expect(res.status).toBe(expectStatus);
  return res.json();
}

const agentHello = (machineId: string, outputs: Frame[]) => ({
  t: "agent/hello",
  protocol: PROTOCOL_VERSION,
  machineId,
  agentVersion: "e2e",
  backend: "dev-open",
  outputs,
});
const playerHello = (screenId: string) => ({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId });
const adminHello = () => ({ t: "admin/hello", protocol: PROTOCOL_VERSION });

const openClients: WsClient[] = [];

/** Open a fake player and swallow its initial render, so later waits see only what we caused. */
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

/** A fresh /admin connection's first snapshot always reflects CURRENT server state. */
async function snapshot(label: string, timeoutMs = 4_000): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send(adminHello());
  const state = await admin.waitFor((m) => m.t === "admin/state", label, timeoutMs);
  admin.close();
  return state;
}

/**
 * The single surface on a screen's next render, once it carries the expected url AND zoom. Both are
 * matched: a render for the same url at a different zoom (or vice versa) is a real intermediate state
 * a test may have queued, and matching on only one would let a stale frame satisfy the wait.
 */
async function nextSurface(
  player: WsClient,
  screenId: string,
  url: string,
  zoom: number,
): Promise<Frame> {
  const render = await player.waitFor(
    (m) =>
      m.t === "server/render" &&
      m.slice?.screenId === screenId &&
      m.slice?.surfaces?.[0]?.url === url &&
      m.slice?.surfaces?.[0]?.zoom === zoom,
    `server/render for ${screenId} showing ${url} at zoom ${zoom}`,
    5_000,
  );
  return render.slice.surfaces[0];
}

/** The zoom the admin snapshot reports for a screen (what the console's control reads). */
function snapshotZoom(state: Frame, screenId: string): number | undefined {
  for (const machine of state.machines ?? []) {
    for (const screen of machine.screens ?? []) {
      if (screen.id === screenId) return screen.content?.zoom;
    }
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

let screenA = ""; // wall member
let screenB = ""; // wall member
let screenC = ""; // single screen
let muralId = "";
let wallId = "";

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
  agent.send(
    agentHello(MACHINE_ID, [
      { connector: CONN_A, width: RES_W, height: RES_H },
      { connector: CONN_B, width: RES_W, height: RES_H },
      { connector: CONN_C, width: RES_W, height: RES_H },
    ]),
  );
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply",
    5_000,
  );
  const byConnector = (connector: string): string =>
    apply.screens.find((s: Frame) => s.connector === connector).screenId;
  screenA = byConnector(CONN_A);
  screenB = byConnector(CONN_B);
  screenC = byConnector(CONN_C);

  const seeded = await snapshot("admin/state with seeded Wall mural");
  muralId = seeded.murals.find((m: Frame) => m.name === "Wall").id;

  for (const [screenId, x] of [
    [screenA, A_X],
    [screenB, B_X],
  ] as const) {
    const res = await putJson(`/api/v1/screens/${screenId}/placement`, {
      muralId,
      x,
      y: PLACE_Y,
      w: RES_W,
      h: RES_H,
    });
    expect(res.ok).toBe(true);
    await drain(res);
  }

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
// Single-screen zoom
// ─────────────────────────────────────────────────────────────────────────────

describe("single-screen page zoom", () => {
  test("a freshly-assigned page renders at 100%", async () => {
    const res = await putJson(`/api/v1/screens/${screenC}/content`, { url: PAGE_ONE });
    expect(res.ok).toBe(true);
    await drain(res);

    const surface = await nextSurface(playerC, screenC, PAGE_ONE, 1);
    expect(surface.type).toBe("web");
  });

  test("zooming pushes a render that changes ONLY the zoom — same surface id, same url", async () => {
    const before = await snapshot("state before zoom");
    expect(snapshotZoom(before, screenC)).toBe(1);

    const body = await setZoom(`/api/v1/screens/${screenC}/zoom`, 1.5, 200);
    expect(body.ok).toBe(true);
    expect(body.zoom).toBe(1.5);

    const surface = await nextSurface(playerC, screenC, PAGE_ONE, 1.5);
    // The stable id is what makes the player patch the existing iframe instead of remounting it (D5).
    expect(surface.id).toBe("content-web");
    expect(surface.span).toBeUndefined();

    // The console reads the live zoom off the admin snapshot.
    const after = await snapshot("state after zoom");
    expect(snapshotZoom(after, screenC)).toBe(1.5);
  });

  test("the zoom is remembered for this (screen, page) pair", async () => {
    // Show a different page: it has never been zoomed here, so it lands at 100%.
    const two = await putJson(`/api/v1/screens/${screenC}/content`, { url: PAGE_TWO });
    expect(two.ok).toBe(true);
    await drain(two);
    await nextSurface(playerC, screenC, PAGE_TWO, 1);

    // Bring the first page back — its zoom comes with it, without the operator touching the control.
    const one = await putJson(`/api/v1/screens/${screenC}/content`, { url: PAGE_ONE });
    expect(one.ok).toBe(true);
    await drain(one);
    await nextSurface(playerC, screenC, PAGE_ONE, 1.5);
  });

  test("the same page on a different screen keeps its own zoom", async () => {
    // screenA is not yet a wall member; give it the page screenC has zoomed to 150%.
    const res = await putJson(`/api/v1/screens/${screenA}/content`, { url: PAGE_ONE });
    expect(res.ok).toBe(true);
    await drain(res);

    await nextSurface(playerA, screenA, PAGE_ONE, 1);
  });

  test("media is not zoomable (409), and neither is an empty screen", async () => {
    // Turn A into an image surface via a library source (ad-hoc urls are always web).
    const created = await postJson("/api/v1/content-sources", {
      name: "Zoom image",
      kind: "image",
      url: IMAGE_URL,
    });
    expect(created.status).toBe(201);
    const { source } = (await created.json()) as Frame;

    const assigned = await putJson(`/api/v1/screens/${screenA}/content`, { sourceId: source.id });
    expect(assigned.ok).toBe(true);
    await drain(assigned);
    await playerA.waitFor(
      (m) => m.t === "server/render" && m.slice?.surfaces?.[0]?.type === "image",
      "image render on A",
      5_000,
    );

    const rejected = await setZoom(`/api/v1/screens/${screenA}/zoom`, 1.5, 409);
    expect(rejected.error).toBe("not-zoomable");

    // screenB has never been given content.
    const empty = await setZoom(`/api/v1/screens/${screenB}/zoom`, 1.5, 409);
    expect(empty.error).toBe("no-content");
  });

  test("an out-of-range zoom is a 400, and an unknown screen a 404", async () => {
    const tooBig = await putJson(`/api/v1/screens/${screenC}/zoom`, { zoom: 12 });
    expect(tooBig.status).toBe(400);
    await drain(tooBig);

    const unknown = await putJson(`/api/v1/screens/screen-404/zoom`, { zoom: 1.5 });
    expect(unknown.status).toBe(404);
    await drain(unknown);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined-surface zoom
// ─────────────────────────────────────────────────────────────────────────────

describe("combined-surface page zoom", () => {
  test("combining A + B, then spanning a page across them", async () => {
    const combined = await postJson(`/api/v1/murals/${muralId}/walls`, {
      muralId,
      memberScreenIds: [screenA, screenB],
    });
    expect(combined.status).toBe(201);
    const { wall } = (await combined.json()) as Frame;
    wallId = wall.id;
    expect(typeof wallId).toBe("string");

    const res = await putJson(`/api/v1/walls/${wallId}/content`, { url: WALL_PAGE });
    expect(res.ok).toBe(true);
    await drain(res);

    const surface = await nextSurface(playerA, screenA, WALL_PAGE, 1);
    expect(surface.span.contentW).toBe(SPAN_W);
  });

  test("a wall member defers to its combined surface (409 wall-member)", async () => {
    const rejected = await setZoom(`/api/v1/screens/${screenA}/zoom`, 1.5, 409);
    expect(rejected.wallId).toBe(wallId);
  });

  test("zooming the wall scales every member equally and leaves the span math untouched", async () => {
    const spanBefore = (await snapshotSpan()) as Frame;

    const body = await setZoom(`/api/v1/walls/${wallId}/zoom`, 2, 200);
    expect(body.ok).toBe(true);
    expect(body.screens.sort()).toEqual([screenA, screenB].sort());

    const a = await nextSurface(playerA, screenA, WALL_PAGE, 2);
    const b = await nextSurface(playerB, screenB, WALL_PAGE, 2);
    // The span is the wall's GEOMETRY; zoom scales the page inside it, so the span must not move.
    expect(a.span).toEqual(spanBefore);
    expect(b.span.offsetX).toBe(RES_W);
  });

  /** A's current span, read back off the live state endpoint. */
  async function snapshotSpan(): Promise<unknown> {
    const res = await fetch(`${BASE}/api/v1/state`);
    const state = (await res.json()) as Frame;
    return state.slices[screenA].surfaces[0].span;
  }

  test("the wall's zoom is remembered per page and restored on re-assignment", async () => {
    const other = await putJson(`/api/v1/walls/${wallId}/content`, { url: PAGE_TWO });
    expect(other.ok).toBe(true);
    await drain(other);
    await nextSurface(playerA, screenA, PAGE_TWO, 1);

    const back = await putJson(`/api/v1/walls/${wallId}/content`, { url: WALL_PAGE });
    expect(back.ok).toBe(true);
    await drain(back);
    await nextSurface(playerA, screenA, WALL_PAGE, 2);
  });

  test("an unknown wall is a 404", async () => {
    const res = await putJson(`/api/v1/walls/wall-404/zoom`, { zoom: 1.5 });
    expect(res.status).toBe(404);
    await drain(res);
  });
});
