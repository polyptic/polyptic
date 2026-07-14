/**
 * @polyptic/e2e — POL-96 + POL-100: bulk canvas operations, the explicit CLEAR, and the wall-adjacency
 * invariant, against the REAL control plane.
 *
 * The operator complaints this suite pins:
 *   - you could never turn a screen OFF (content could only be replaced) → DELETE /screens/:id/content
 *     and DELETE /walls/:id/content really empty the slice, and the player is told (an empty render);
 *   - assigning one source to five screens was five interactions and five broadcasts → POST
 *     /content/assign takes target arrays, fans out to every player, and `content: null` is the bulk
 *     clear;
 *   - a video wall could not be MOVED (split, drag each panel, recombine, re-assign) → POST
 *     /murals/:id/move translates a whole wall atomically, and its members' span slices are untouched
 *     (the offsets are union-relative, so a rigid translation changes no pixel on the glass);
 *   - Combine happily unioned screens with a gap between them → a non-adjacent selection is REFUSED
 *     (400 not-adjacent), `pack: true` closes the gaps and combines, and no move of any kind may leave
 *     a wall non-contiguous (dragging one member out of its wall → 409).
 *
 * Own server process, own port (8181), MemoryStore, open enrollment — independent of every other e2e.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8181;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "bulk-host-1";
const RES_W = 1920;
const RES_H = 1080;

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

type Frame = any;
type Predicate = (m: Frame) => boolean;

interface Waiter {
  pred: Predicate;
  resolve: (m: Frame) => void;
  timer: ReturnType<typeof setTimeout>;
  label: string;
}

/** A buffering WS client: a frame that lands between awaits is queued, never missed. */
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

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

const openClients: WsClient[] = [];

/** A fresh /admin connection's first snapshot always reflects CURRENT server state. */
async function snapshot(label: string, timeoutMs = 4_000): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  const state = await admin.waitFor((m) => m.t === "admin/state", label, timeoutMs);
  admin.close();
  return state;
}

/** A fresh player's initial render — the unambiguous read of what a screen is CURRENTLY showing. */
async function currentSlice(screenId: string): Promise<Frame> {
  const p = await WsClient.connect(`${WS}/player`);
  openClients.push(p);
  p.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId });
  const render = await p.waitFor(
    (m) => m.t === "server/render" && m.slice?.screenId === screenId,
    `current slice for ${screenId}`,
    5_000,
  );
  p.close();
  return render.slice;
}

const placementFor = (state: Frame, screenId: string): Frame | undefined =>
  (state.placements ?? []).find((p: Frame) => p.screenId === screenId);

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

// Layout: A and B abut (a 2×1 wall waiting to happen); C sits far away with a GAP.
let screenA = "";
let screenB = "";
let screenC = "";
let muralId = "";
let playerA: WsClient;
let playerB: WsClient;
let playerC: WsClient;

async function place(screenId: string, x: number, y: number): Promise<Response> {
  return putJson(`/api/v1/screens/${screenId}/placement`, {
    muralId,
    x,
    y,
    w: RES_W,
    h: RES_H,
  });
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
      { connector: "HDMI-3", width: RES_W, height: RES_H },
    ],
  });
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply",
    5_000,
  );
  const byConnector = (connector: string): string =>
    apply.screens.find((s: Frame) => s.connector === connector).screenId;
  screenA = byConnector("HDMI-1");
  screenB = byConnector("HDMI-2");
  screenC = byConnector("HDMI-3");

  const seeded = await snapshot("admin/state with the seeded Wall mural");
  muralId = seeded.murals.find((m: Frame) => m.name === "Wall").id;

  for (const [screenId, x, y] of [
    [screenA, 0, 0],
    [screenB, RES_W, 0],
    [screenC, 6000, 0], // a long way off — not adjacent to anything
  ] as const) {
    const res = await place(screenId, x, y);
    expect(res.ok).toBe(true);
    await drain(res);
  }

  const connectPlayer = async (screenId: string): Promise<WsClient> => {
    const client = await WsClient.connect(`${WS}/player`);
    openClients.push(client);
    client.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId });
    await client.waitFor(
      (m) => m.t === "server/render" && m.slice?.screenId === screenId,
      `initial render for ${screenId}`,
      5_000,
    );
    return client;
  };
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
// Bulk assign + the explicit clear (POL-96)
// ─────────────────────────────────────────────────────────────────────────────

describe("bulk content + clear (POL-96)", () => {
  test(
    "POST /content/assign puts ONE source on THREE screens — every player renders it",
    async () => {
      const url = "https://example.com/bulk-one";
      const started = Date.now();
      const res = await postJson(`/api/v1/content/assign`, {
        screenIds: [screenA, screenB, screenC],
        content: { url },
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Frame;
      expect(body.applied).toMatchObject({ screens: 3, walls: 0 });

      for (const [player, label] of [
        [playerA, "A"],
        [playerB, "B"],
        [playerC, "C"],
      ] as const) {
        await player.waitFor(
          (m) => m.t === "server/render" && m.slice?.surfaces?.[0]?.url === url,
          `bulk render for ${label}`,
        );
      }
      // One call, one fan-out — well inside the instant budget (D5 targets < ~150ms).
      expect(Date.now() - started).toBeLessThan(1_000);
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE /screens/:id/content clears ONE screen — it shows nothing (the idle splash)",
    async () => {
      const res = await del(`/api/v1/screens/${screenC}/content`);
      expect(res.status).toBe(200);
      await drain(res);

      await playerC.waitFor(
        (m) => m.t === "server/render" && m.slice?.surfaces?.length === 0,
        "cleared render for C",
      );
      const slice = await currentSlice(screenC);
      expect(slice.surfaces.length).toBe(0);

      // The others are untouched — a clear is surgical, not a blanket blackout.
      const sliceA = await currentSlice(screenA);
      expect(sliceA.surfaces.length).toBe(1);
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /content/assign with content:null is the BULK clear",
    async () => {
      const res = await postJson(`/api/v1/content/assign`, {
        screenIds: [screenA, screenB],
        content: null,
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Frame;
      expect(body.applied).toMatchObject({ screens: 2 });

      for (const id of [screenA, screenB]) {
        const slice = await currentSlice(id);
        expect(slice.surfaces.length).toBe(0);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "an unknown source changes nothing (404), and an empty target list is a 400",
    async () => {
      const bad = await postJson(`/api/v1/content/assign`, {
        screenIds: [screenA],
        content: { sourceId: "source-404" },
      });
      expect(bad.status).toBe(404);
      await drain(bad);
      expect((await currentSlice(screenA)).surfaces.length).toBe(0);

      const empty = await postJson(`/api/v1/content/assign`, { content: null });
      expect(empty.status).toBe(400);
      await drain(empty);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Adjacency-checked combine (POL-100)
// ─────────────────────────────────────────────────────────────────────────────

let wallId = "";

describe("adjacency-checked combine (POL-100)", () => {
  test(
    "combining screens with a GAP between them is refused (400 not-adjacent) — no wall created",
    async () => {
      const res = await postJson(`/api/v1/murals/${muralId}/walls`, {
        muralId,
        memberScreenIds: [screenA, screenC], // C is 6000px away
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as Frame;
      expect(body.error).toBe("not-adjacent");
      expect(typeof body.message).toBe("string"); // a sentence the console can show

      const state = await snapshot("admin/state after the refused combine");
      expect(state.videoWalls.length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "pack:true closes the gap first — the placement really moves, and the wall exists",
    async () => {
      const res = await postJson(`/api/v1/murals/${muralId}/walls`, {
        muralId,
        memberScreenIds: [screenA, screenC],
        pack: true,
        name: "Packed Wall",
      });
      expect(res.status).toBe(201);
      await drain(res);

      const state = await snapshot("admin/state with the packed wall");
      expect(state.videoWalls.length).toBe(1);
      expect(state.videoWalls[0].name).toBe("Packed Wall");
      // C was at x=6000; packing butts it against A's right edge.
      expect(placementFor(state, screenC)).toMatchObject({ x: RES_W, y: 0 });

      // Restore: split, and put C back out of the way for the move suite.
      const split = await del(`/api/v1/walls/${state.videoWalls[0].id}`);
      expect(split.status).toBe(200);
      await drain(split);
      const back = await place(screenC, 6000, 0);
      expect(back.ok).toBe(true);
      await drain(back);
    },
    TEST_TIMEOUT,
  );

  test(
    "adjacent screens still combine exactly as before (no regression)",
    async () => {
      const res = await postJson(`/api/v1/murals/${muralId}/walls`, {
        muralId,
        memberScreenIds: [screenA, screenB],
      });
      expect(res.status).toBe(201);
      const body = (await res.json()) as Frame;
      wallId = body.wall.id;
      expect(body.wall.memberScreenIds.length).toBe(2);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// The atomic canvas move (POL-100)
// ─────────────────────────────────────────────────────────────────────────────

describe("the atomic canvas move (POL-100)", () => {
  test(
    "POST /murals/:id/move drags a WALL as one unit — both members shift, the wall survives",
    async () => {
      const content = await putJson(`/api/v1/walls/${wallId}/content`, {
        url: "https://example.com/spanning",
      });
      expect(content.status).toBe(200);
      await drain(content);
      const before = await currentSlice(screenA);

      const res = await postJson(`/api/v1/murals/${muralId}/move`, {
        wallIds: [wallId],
        dx: 400,
        dy: -240,
      });
      expect(res.status).toBe(200);
      await drain(res);

      const state = await snapshot("admin/state after the wall move");
      expect(placementFor(state, screenA)).toMatchObject({ x: 400, y: -240 });
      expect(placementFor(state, screenB)).toMatchObject({ x: 400 + RES_W, y: -240 });
      expect(state.videoWalls.length).toBe(1); // still one wall, still contiguous

      // A rigid translation changes nothing on the glass: the span offsets are union-relative.
      const after = await currentSlice(screenA);
      expect(after.surfaces).toEqual(before.surfaces);
    },
    TEST_TIMEOUT,
  );

  test(
    "a nudge moves a whole multi-screen selection in ONE call",
    async () => {
      const res = await postJson(`/api/v1/murals/${muralId}/move`, {
        screenIds: [screenC],
        dx: -20,
        dy: 20,
      });
      expect(res.status).toBe(200);
      await drain(res);

      const state = await snapshot("admin/state after the nudge");
      expect(placementFor(state, screenC)).toMatchObject({ x: 5980, y: 20 });
    },
    TEST_TIMEOUT,
  );

  test(
    "dragging ONE member out of its wall is refused (409) — a wall is never left with a hole",
    async () => {
      // Via the move endpoint …
      const move = await postJson(`/api/v1/murals/${muralId}/move`, {
        screenIds: [screenA],
        dx: 9000,
        dy: 0,
      });
      expect(move.status).toBe(409);
      await drain(move);

      // … and via the raw placement route (the single-screen drag path).
      const drag = await putJson(`/api/v1/screens/${screenA}/placement`, {
        muralId,
        x: 9000,
        y: 9000,
        w: RES_W,
        h: RES_H,
      });
      expect(drag.status).toBe(409);
      await drain(drag);

      const state = await snapshot("admin/state after the refused member drags");
      expect(placementFor(state, screenA)).toMatchObject({ x: 400, y: -240 }); // untouched
      expect(state.videoWalls.length).toBe(1);
    },
    TEST_TIMEOUT,
  );

  test(
    "DELETE /walls/:id/content clears a combined surface; the wall itself survives",
    async () => {
      const res = await del(`/api/v1/walls/${wallId}/content`);
      expect(res.status).toBe(200);
      await drain(res);

      for (const id of [screenA, screenB]) {
        const slice = await currentSlice(id);
        expect(slice.surfaces.length).toBe(0);
      }
      const state = await snapshot("admin/state after clearing the wall");
      expect(state.videoWalls.length).toBe(1); // the grouping is not the content
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /screens/unplace returns a selection to the tray in one call (dissolving the wall)",
    async () => {
      const res = await postJson(`/api/v1/screens/unplace`, {
        screenIds: [screenA, screenC],
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as Frame;
      expect(body.unplaced.sort()).toEqual([screenA, screenC].sort());

      const state = await snapshot("admin/state after the bulk unplace");
      expect(placementFor(state, screenA)).toBeUndefined();
      expect(placementFor(state, screenC)).toBeUndefined();
      expect(state.videoWalls.length).toBe(0); // a wall cannot outlive a member
      expect(placementFor(state, screenB)).toBeDefined(); // the survivor stays put
    },
    TEST_TIMEOUT,
  );
});
