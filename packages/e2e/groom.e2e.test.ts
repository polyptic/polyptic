/**
 * @polyptic/e2e — POL-98 GROOMING (crop / scroll / dashboard refresh) against the REAL control plane.
 *
 * Grooming is how a page built for a desk is made to sit on a wall: chop the nav bar off, park the
 * page at the row that matters, and (for a dashboard) re-fetch it before anyone notices it is stale.
 * Three claims are load-bearing at the wire, and this suite pins all three:
 *
 *   1. INSTANT (D5). `PUT /screens/:id/groom` pushes a `server/render` whose surface keeps its stable
 *      id AND its url, with only the groom changed — so the player restyles the EXISTING iframe (and
 *      re-arms its refresh timer) rather than navigating. Anything that changed the id or the url
 *      would reload the page on the wall.
 *   2. REMEMBERED per (screen-or-wall, page), exactly like the zoom (POL-57): re-assigning a page a
 *      screen has groomed before brings the crop, the scroll and the cadence back with it — through
 *      a restart of the assignment and through another page in between — while the same page on
 *      another screen stays whole.
 *   3. THE CADENCE IS A DASHBOARD'S. `refreshSeconds` reaches the player on a dashboard surface and
 *      is dropped on a web one — the one knob that makes the kind mean something.
 *
 * Plus the refusals: media has nothing to groom (409 not-groomable), an empty screen has nothing at
 * all (409 no-content), a wall member defers to its combined surface (409 wall-member), a crop that
 * would leave nothing visible is a 400, and so is a cadence below the contract's floor.
 *
 * Harness (as the other suites): spawn `packages/server/src/index.ts` with STORE=memory on its own
 * port, OPEN enrollment, one fake agent reporting three outputs → three screens. A and B are placed
 * adjacent on the seeded "Wall" mural and combined; C stays single. Fake players receive the renders.
 *
 * Ports in use elsewhere: polyptych (8090), enrollment (8091), murals (8092), walls (8093),
 * content (8094), scenes (8095), auth (8096), preview (8097), media (8098), activity/static (8099),
 * remove (8100), zoom (8101), image-updates (8117). This suite owns 8261.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8261;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;

const MACHINE_ID = "groom-host-1";
const RES_W = 1920;
const RES_H = 1080;
const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";
const CONN_C = "HDMI-3";

const A_X = 0;
const B_X = RES_W;
const PLACE_Y = 0;
const SPAN_W = RES_W * 2;

const PAGE_ONE = "https://example.com/groom-one";
const PAGE_TWO = "https://example.com/groom-two";
const WALL_PAGE = "https://example.com/groom-wall";
const DASH_URL = "https://example.com/groom-dashboard";
const IMAGE_URL = "https://cdn.example.com/groom-image.png";

/** The crop an operator actually dials: chop the header, keep the chart. */
const CROP = { top: 12, right: 0, bottom: 0, left: 0, unit: "percent" as const };
const SCROLL = { x: 0, y: 420 };

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

/** PUT a groom and assert the status, returning the parsed body. */
async function setGroom(path: string, groom: unknown, expectStatus: number): Promise<Frame> {
  const res = await putJson(path, groom);
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

async function snapshot(label: string, timeoutMs = 4_000): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send(adminHello());
  const state = await admin.waitFor((m) => m.t === "admin/state", label, timeoutMs);
  admin.close();
  return state;
}

/** The next render for a screen whose surface satisfies `pred` — the url is always matched too, so a
 *  stale frame for a different page can never satisfy the wait. */
async function nextSurface(
  player: WsClient,
  screenId: string,
  url: string,
  pred: (s: Frame) => boolean,
  label: string,
): Promise<Frame> {
  const render = await player.waitFor(
    (m) =>
      m.t === "server/render" &&
      m.slice?.screenId === screenId &&
      m.slice?.surfaces?.[0]?.url === url &&
      pred(m.slice.surfaces[0]),
    `server/render for ${screenId} showing ${url} ${label}`,
    5_000,
  );
  return render.slice.surfaces[0];
}

/** The groom the admin snapshot reports for a screen (what the console's panel reads). */
function snapshotGroom(state: Frame, screenId: string): Frame | undefined {
  for (const machine of state.machines ?? []) {
    for (const screen of machine.screens ?? []) {
      if (screen.id === screenId) return screen.content?.groom;
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
let dashboardSourceId = "";

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

  const dash = await postJson("/api/v1/content-sources", {
    name: "Ops board",
    kind: "dashboard",
    url: DASH_URL,
  });
  expect(dash.status).toBe(201);
  dashboardSourceId = ((await dash.json()) as Frame).source.id;

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
// Single-screen grooming
// ─────────────────────────────────────────────────────────────────────────────

describe("single-screen grooming", () => {
  test("a freshly-assigned page arrives whole — no crop, no scroll, no cadence", async () => {
    const res = await putJson(`/api/v1/screens/${screenC}/content`, { url: PAGE_ONE });
    expect(res.ok).toBe(true);
    await drain(res);

    const surface = await nextSurface(playerC, screenC, PAGE_ONE, (s) => s.type === "web", "ungroomed");
    expect(surface.crop).toBeUndefined();
    expect(surface.scroll).toBeUndefined();
  });

  test("grooming pushes a render that changes ONLY the groom — same surface id, same url", async () => {
    const body = await setGroom(`/api/v1/screens/${screenC}/groom`, { crop: CROP, scroll: SCROLL }, 200);
    expect(body.ok).toBe(true);

    const surface = await nextSurface(playerC, screenC, PAGE_ONE, (s) => !!s.crop, "cropped");
    // The stable id is what makes the player restyle the existing iframe instead of remounting it (D5).
    expect(surface.id).toBe("content-web");
    expect(surface.crop).toEqual(CROP);
    expect(surface.scroll).toEqual(SCROLL);
    expect(surface.zoom).toBe(1); // grooming is orthogonal to zoom; it must not disturb it

    // The console reads the live groom off the admin snapshot, on the same read-out as the zoom.
    const after = await snapshot("state after groom");
    expect(snapshotGroom(after, screenC)?.crop).toEqual(CROP);
  });

  test("the groom is remembered for this (screen, page) pair", async () => {
    const two = await putJson(`/api/v1/screens/${screenC}/content`, { url: PAGE_TWO });
    expect(two.ok).toBe(true);
    await drain(two);
    await nextSurface(playerC, screenC, PAGE_TWO, (s) => s.crop === undefined, "whole");

    const one = await putJson(`/api/v1/screens/${screenC}/content`, { url: PAGE_ONE });
    expect(one.ok).toBe(true);
    await drain(one);
    const back = await nextSurface(playerC, screenC, PAGE_ONE, (s) => !!s.crop, "cropped again");
    expect(back.crop).toEqual(CROP);
    expect(back.scroll).toEqual(SCROLL);
  });

  test("a DASHBOARD carries the refresh cadence to the player; a web page does not", async () => {
    const assigned = await putJson(`/api/v1/screens/${screenC}/content`, {
      sourceId: dashboardSourceId,
    });
    expect(assigned.ok).toBe(true);
    await drain(assigned);
    await nextSurface(playerC, screenC, DASH_URL, (s) => s.type === "dashboard", "dashboard");

    const body = await setGroom(
      `/api/v1/screens/${screenC}/groom`,
      { refreshSeconds: 300, crop: CROP },
      200,
    );
    expect(body.ok).toBe(true);

    const dash = await nextSurface(
      playerC,
      screenC,
      DASH_URL,
      (s) => s.refreshSeconds === 300,
      "refreshing every 5m",
    );
    expect(dash.type).toBe("dashboard");
    expect(dash.crop).toEqual(CROP);

    // The same cadence on a WEB page is dropped: a refresh cadence is what the dashboard kind means.
    const web = await putJson(`/api/v1/screens/${screenC}/content`, { url: PAGE_TWO });
    expect(web.ok).toBe(true);
    await drain(web);
    const surface = await nextSurface(playerC, screenC, PAGE_TWO, (s) => s.type === "web", "web again");
    await setGroom(`/api/v1/screens/${screenC}/groom`, { refreshSeconds: 300, crop: CROP }, 200);
    const groomed = await nextSurface(playerC, screenC, PAGE_TWO, (s) => !!s.crop, "cropped web");
    expect(groomed.id).toBe(surface.id);
    expect(groomed.refreshSeconds).toBeUndefined();
  });

  test("media is not groomable (409), and neither is an empty screen", async () => {
    const created = await postJson("/api/v1/content-sources", {
      name: "Groom image",
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

    const rejected = await setGroom(`/api/v1/screens/${screenA}/groom`, { crop: CROP }, 409);
    expect(rejected.error).toBe("not-groomable");

    const empty = await setGroom(`/api/v1/screens/${screenB}/groom`, { crop: CROP }, 409);
    expect(empty.error).toBe("no-content");
  });

  test("an impossible crop is a 400, a sub-floor cadence is a 400, an unknown screen a 404", async () => {
    // A crop that leaves nothing visible would ask the browser for an infinitely wide frame.
    const impossible = await putJson(`/api/v1/screens/${screenC}/groom`, {
      crop: { top: 60, right: 0, bottom: 60, left: 0, unit: "percent" },
    });
    expect(impossible.status).toBe(400);
    await drain(impossible);

    // A 5-second cadence from every panel on a wall is an outage, not a feature: the floor is 30s.
    const hammer = await putJson(`/api/v1/screens/${screenC}/groom`, { refreshSeconds: 5 });
    expect(hammer.status).toBe(400);
    await drain(hammer);

    const unknown = await putJson(`/api/v1/screens/screen-404/groom`, { crop: CROP });
    expect(unknown.status).toBe(404);
    await drain(unknown);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Combined-surface grooming
// ─────────────────────────────────────────────────────────────────────────────

describe("combined-surface grooming", () => {
  test("combining A + B, then spanning a page across them", async () => {
    const combined = await postJson(`/api/v1/murals/${muralId}/walls`, {
      muralId,
      memberScreenIds: [screenA, screenB],
    });
    expect(combined.status).toBe(201);
    const { wall } = (await combined.json()) as Frame;
    wallId = wall.id;

    const res = await putJson(`/api/v1/walls/${wallId}/content`, { url: WALL_PAGE });
    expect(res.ok).toBe(true);
    await drain(res);

    const surface = await nextSurface(playerA, screenA, WALL_PAGE, (s) => !!s.span, "spanning");
    expect(surface.span.contentW).toBe(SPAN_W);
  });

  test("a wall member defers to its combined surface (409 wall-member)", async () => {
    const rejected = await setGroom(`/api/v1/screens/${screenA}/groom`, { crop: CROP }, 409);
    expect(rejected.wallId).toBe(wallId);
  });

  test("grooming the wall grooms every member identically and leaves the span math untouched", async () => {
    const res = await fetch(`${BASE}/api/v1/state`);
    const spanBefore = ((await res.json()) as Frame).slices[screenA].surfaces[0].span;

    const body = await setGroom(`/api/v1/walls/${wallId}/groom`, { crop: CROP, scroll: SCROLL }, 200);
    expect(body.ok).toBe(true);
    expect(body.screens.sort()).toEqual([screenA, screenB].sort());

    const a = await nextSurface(playerA, screenA, WALL_PAGE, (s) => !!s.crop, "cropped");
    const b = await nextSurface(playerB, screenB, WALL_PAGE, (s) => !!s.crop, "cropped");
    expect(a.crop).toEqual(CROP);
    expect(b.crop).toEqual(CROP);
    expect(b.scroll).toEqual(SCROLL);
    // The crop is dialled against the SPANNING page — the wall's geometry must not move.
    expect(a.span).toEqual(spanBefore);
    expect(b.span.offsetX).toBe(RES_W);
  });

  test("the wall's groom is remembered per page and restored on re-assignment", async () => {
    const other = await putJson(`/api/v1/walls/${wallId}/content`, { url: PAGE_TWO });
    expect(other.ok).toBe(true);
    await drain(other);
    await nextSurface(playerA, screenA, PAGE_TWO, (s) => s.crop === undefined, "whole");

    const back = await putJson(`/api/v1/walls/${wallId}/content`, { url: WALL_PAGE });
    expect(back.ok).toBe(true);
    await drain(back);
    const surface = await nextSurface(playerA, screenA, WALL_PAGE, (s) => !!s.crop, "cropped again");
    expect(surface.crop).toEqual(CROP);
  });

  test("an unknown wall is a 404", async () => {
    const res = await putJson(`/api/v1/walls/wall-404/groom`, { crop: CROP });
    expect(res.status).toBe(404);
    await drain(res);
  });
});
