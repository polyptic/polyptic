/**
 * @polyptic/e2e — POL-97 OVERLAYS against the REAL control plane.
 *
 * An overlay is a page composited ABOVE whatever content a screen is showing — a logo bug, a ticker,
 * a banner — applied to a scope (fleet | mural | wall | screen), most specific wins. This suite drives
 * the whole claim over REST + the real WS channels, on two screens combined into a video wall:
 *
 *   - a fleet overlay reaches EVERY player, ABOVE the content each is already showing, and the
 *     content surfaces on the wire are byte-for-byte what they were (an overlay composites, it never
 *     replaces);
 *   - it SPANS the wall by the existing span math (each member gets its own offset into one 3840×1080
 *     composition), so a corner logo lands once;
 *   - precedence: a screen-scoped overlay beats the fleet's on that screen, and only that screen;
 *   - a page's live-data elements (feed/clock) arrive in the overlay's send-time `data` bundle;
 *   - removing the overlay removes it LIVE, and the content beneath is still there;
 *   - an overlay must be a page (a dashboard is refused) and unknown scopes/targets 404.
 *
 * Port 8251 (each e2e suite owns a port + fresh memory store).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8251;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "overlay-host-1";
const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── buffering WS client (same shape as the other e2e suites) ─────────────────
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
        } catch {}
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

  waitFor(pred: Predicate, label = "frame", timeoutMs = 4_000): Promise<Frame> {
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
    } catch {}
  }
}

// ── REST helpers ──────────────────────────────────────────────────────────────
function json(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${BASE}${path}`, {
    method,
    // A content-type with NO body makes Fastify 400 ("empty json body") — only send it with one.
    ...(body === undefined
      ? {}
      : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
  });
}

// ── lifecycle ─────────────────────────────────────────────────────────────────
let proc: ReturnType<typeof Bun.spawn> | null = null;
const openClients: WsClient[] = [];

let screenA = "";
let screenB = "";
let muralId = "";
let wallId = "";
let players: Record<string, WsClient> = {};

let dashSourceId = "";
let logoSourceId = "";
let bannerSourceId = "";

const DASH_URL = "https://dashboard.example.test/embed/kpi?kiosk";

/** The corner logo — the canonical overlay. A text element + a clock: no network, no probe. */
const LOGO_DEF = {
  aspect: "16:9",
  bg: "#0b0b0e",
  elements: [
    { id: "logo", kind: "text", x: 84, y: 4, w: 14, h: 8, props: { text: "ACME", size: 40, color: "#fafafa", align: "right" } },
    { id: "clk", kind: "clock", x: 84, y: 12, w: 14, h: 6, props: { format: "24h", seconds: false, color: "#fafafa" } },
  ],
};

/** A full-width banner, so precedence is visible on the wire. */
const BANNER_DEF = {
  aspect: "16:9",
  bg: "#0b0b0e",
  elements: [
    { id: "ban", kind: "text", x: 0, y: 44, w: 100, h: 12, props: { text: "MEETING IN PROGRESS", size: 60, color: "#fafafa", align: "center" } },
  ],
};

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

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`${BASE}/api/v1/state`);
      if (res.ok) {
        await res.body?.cancel();
        break;
      }
    } catch {}
    if (Date.now() > deadline) throw new Error("server did not become ready");
    await sleep(100);
  }

  const agent = await WsClient.connect(`${WS}/agent`);
  openClients.push(agent);
  agent.send({
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId: MACHINE_ID,
    agentVersion: "e2e",
    backend: "dev-open",
    outputs: [
      { connector: CONN_A, width: 1920, height: 1080 },
      { connector: CONN_B, width: 1920, height: 1080 },
    ],
  });
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply",
  );
  screenA = apply.screens.find((s: Frame) => s.connector === CONN_A).screenId;
  screenB = apply.screens.find((s: Frame) => s.connector === CONN_B).screenId;

  // A mural with both screens placed side by side, combined into one 3840×1080 wall — the span case.
  const mural = await json("POST", "/api/v1/murals", { name: "Atrium" });
  muralId = ((await mural.json()) as Frame).mural.id;
  for (const [screenId, x] of [
    [screenA, 0],
    [screenB, 1920],
  ] as [string, number][]) {
    const placed = await json("PUT", `/api/v1/screens/${screenId}/placement`, {
      muralId,
      x,
      y: 0,
      w: 1920,
      h: 1080,
    });
    await placed.body?.cancel();
  }
  const combined = await json("POST", `/api/v1/murals/${muralId}/walls`, {
    muralId,
    memberScreenIds: [screenA, screenB],
    name: "Atrium Wall",
  });
  wallId = ((await combined.json()) as Frame).wall.id;

  for (const screenId of [screenA, screenB]) {
    const player = await WsClient.connect(`${WS}/player`);
    openClients.push(player);
    player.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId });
    await player.waitFor(
      (m) => m.t === "server/render" && m.slice?.screenId === screenId,
      `initial render ${screenId}`,
    );
    players[screenId] = player;
  }
}, 30_000);

afterAll(() => {
  for (const c of openClients) c.close();
  proc?.kill();
});

describe("POL-97 overlays over the real wire", () => {
  test(
    "the wall is showing content, and no screen carries an overlay yet",
    async () => {
      const dash = await json("POST", "/api/v1/content-sources", {
        name: "KPI Wall",
        kind: "dashboard",
        url: DASH_URL,
      });
      expect(dash.status).toBe(201);
      dashSourceId = ((await dash.json()) as Frame).source.id;

      const assigned = await json("PUT", `/api/v1/walls/${wallId}/content`, { sourceId: dashSourceId });
      expect(assigned.status).toBe(200);
      await assigned.body?.cancel();

      for (const screenId of [screenA, screenB]) {
        const render = await players[screenId]!.waitFor(
          (m) => m.t === "server/render" && m.slice?.surfaces?.[0]?.type === "dashboard",
          `wall content on ${screenId}`,
        );
        expect(render.slice.overlay).toBeUndefined();
        expect(render.slice.surfaces[0].span.contentW).toBe(3840);
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "an overlay must be a page — a dashboard is refused",
    async () => {
      const bad = await json("PUT", "/api/v1/overlays", {
        scope: "fleet",
        sourceId: dashSourceId,
      });
      expect(bad.status).toBe(400);
      await bad.body?.cancel();

      const missing = await json("PUT", "/api/v1/overlays", {
        scope: "screen",
        targetId: "screen-999",
        sourceId: dashSourceId,
      });
      expect([400, 404]).toContain(missing.status);
      await missing.body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "a FLEET overlay appears above the live content on every player — and the content is untouched",
    async () => {
      const created = await json("POST", "/api/v1/content-sources", {
        name: "Corner logo",
        kind: "page",
        definition: LOGO_DEF,
      });
      expect(created.status).toBe(201);
      logoSourceId = ((await created.json()) as Frame).source.id;

      const applied = await json("PUT", "/api/v1/overlays", {
        scope: "fleet",
        sourceId: logoSourceId,
      });
      expect(applied.status).toBe(200);
      const appliedBody = (await applied.json()) as Frame;
      expect(appliedBody.screens.sort()).toEqual([screenA, screenB].sort());

      for (const [screenId, offsetX] of [
        [screenA, 0],
        [screenB, 1920],
      ] as [string, number][]) {
        const render = await players[screenId]!.waitFor(
          (m) => m.t === "server/render" && m.slice?.overlay !== undefined,
          `overlay render on ${screenId}`,
        );
        // The overlay arrived…
        expect(render.slice.overlay.sourceId).toBe(logoSourceId);
        expect(render.slice.overlay.scope).toBe("fleet");
        expect(render.slice.overlay.definition.elements.map((e: Frame) => e.id)).toEqual(["logo", "clk"]);
        // …ABOVE the dashboard, which is still on the wire exactly as it was (no blanking, no reload).
        expect(render.slice.surfaces.length).toBe(1);
        expect(render.slice.surfaces[0].type).toBe("dashboard");
        expect(render.slice.surfaces[0].id).toBe(`wall:${wallId}`); // same keyed node → in-place (D5)
        expect(render.slice.surfaces[0].url).toBe(DASH_URL);
        // …and it SPANS the wall by the existing span math: one composition, each panel's window.
        expect(render.slice.overlay.span).toEqual({
          contentW: 3840,
          contentH: 1080,
          offsetX,
          offsetY: 0,
        });
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "screen scope beats fleet scope — on that screen alone",
    async () => {
      const created = await json("POST", "/api/v1/content-sources", {
        name: "Meeting banner",
        kind: "page",
        definition: BANNER_DEF,
      });
      expect(created.status).toBe(201);
      bannerSourceId = ((await created.json()) as Frame).source.id;

      const applied = await json("PUT", "/api/v1/overlays", {
        scope: "screen",
        targetId: screenA,
        sourceId: bannerSourceId,
      });
      expect(applied.status).toBe(200);
      // Only screen A changed — B still wears the fleet's logo and must not be re-pushed for this.
      expect(((await applied.json()) as Frame).screens).toEqual([screenA]);

      const render = await players[screenA]!.waitFor(
        (m) => m.t === "server/render" && m.slice?.overlay?.sourceId === bannerSourceId,
        "screen-scoped overlay",
      );
      expect(render.slice.overlay.scope).toBe("screen");
      // A screen-scoped overlay is NOT spanned — the operator addressed this one panel.
      expect(render.slice.overlay.span).toBeUndefined();
      // The content beneath is still the wall's spanning dashboard.
      expect(render.slice.surfaces[0].type).toBe("dashboard");

      // Removing it falls BACK to the fleet's logo (never to nothing) — precedence, live.
      const cleared = await json("DELETE", `/api/v1/overlays/screen/${screenA}`);
      expect(cleared.status).toBe(200);
      await cleared.body?.cancel();
      const back = await players[screenA]!.waitFor(
        (m) => m.t === "server/render" && m.slice?.overlay?.sourceId === logoSourceId,
        "fallback to the fleet overlay",
      );
      expect(back.slice.overlay.scope).toBe("fleet");
    },
    TEST_TIMEOUT,
  );

  test(
    "an overlay's live-data elements resolve like a page's (its embed arrives resolved)",
    async () => {
      const definition = structuredClone(LOGO_DEF) as Frame;
      definition.elements.push({
        id: "em",
        kind: "embed",
        x: 0,
        y: 0,
        w: 30,
        h: 20,
        props: { sourceId: dashSourceId },
      });
      const res = await json("PATCH", `/api/v1/content-sources/${logoSourceId}`, { definition });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      // A Studio save on the overlay's page reaches the wall by re-push alone — no content edit.
      const render = await players[screenB]!.waitFor(
        (m) => m.t === "server/render" && m.slice?.overlay?.data?.embeds?.em !== undefined,
        "overlay with a resolved embed",
      );
      expect(render.slice.overlay.data.embeds.em).toEqual({ url: DASH_URL, kind: "dashboard" });
      expect(render.slice.surfaces[0].type).toBe("dashboard"); // still the content beneath
    },
    TEST_TIMEOUT,
  );

  test(
    "removing the fleet overlay removes it live — and the content beneath is still there",
    async () => {
      const cleared = await json("DELETE", "/api/v1/overlays/fleet");
      expect(cleared.status).toBe(200);
      await cleared.body?.cancel();

      for (const screenId of [screenA, screenB]) {
        const render = await players[screenId]!.waitFor(
          (m) => m.t === "server/render" && m.slice?.overlay === undefined,
          `overlay removed on ${screenId}`,
        );
        expect(render.slice.surfaces.length).toBe(1);
        expect(render.slice.surfaces[0].type).toBe("dashboard");
        expect(render.slice.surfaces[0].url).toBe(DASH_URL);
      }

      // A second removal is a 404 — there is nothing left to take off.
      const again = await json("DELETE", "/api/v1/overlays/fleet");
      expect(again.status).toBe(404);
      await again.body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "deleting the page a MURAL overlay draws takes it off the glass",
    async () => {
      const applied = await json("PUT", "/api/v1/overlays", {
        scope: "mural",
        targetId: muralId,
        sourceId: bannerSourceId,
      });
      expect(applied.status).toBe(200);
      await applied.body?.cancel();
      await players[screenA]!.waitFor(
        (m) => m.t === "server/render" && m.slice?.overlay?.scope === "mural",
        "mural overlay",
      );

      const deleted = await json("DELETE", `/api/v1/content-sources/${bannerSourceId}`);
      expect(deleted.status).toBe(200);
      await deleted.body?.cancel();

      const render = await players[screenA]!.waitFor(
        (m) => m.t === "server/render" && m.slice?.overlay === undefined,
        "overlay gone with its page",
      );
      expect(render.slice.surfaces[0].type).toBe("dashboard");

      const overlays = await json("GET", "/api/v1/overlays");
      const body = (await overlays.json()) as Frame;
      expect(body.overlays).toEqual([]);
      expect(body.coverage).toEqual([]);
    },
    TEST_TIMEOUT,
  );
});
