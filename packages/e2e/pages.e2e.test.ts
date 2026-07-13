/**
 * @polyptic/e2e — POL-42 PAGES suite against the REAL control plane.
 *
 * The pitch's architecture in one line: a page definition (element tree, % regions) travels INSIDE
 * the ScreenSlice as one `page` surface; embeds resolve (credential-free here — the stamping paths
 * are unit-tested against the token cache) into the surface's `data` bundle at SEND time; saving in
 * the Studio re-pushes the slice so the wall updates with no reload. This suite drives that wiring
 * end to end over REST + the real WS channels:
 *
 *   - POST /content-sources {kind:"page", definition} creates a page (no url), visible in admin/state;
 *   - PUT /screens/:id/content {sourceId} pushes ONE `page` surface whose definition matches and
 *     whose embed elements arrive RESOLVED in `data.embeds` (the stored definition stays by-id);
 *   - PATCH with a new definition re-pushes to the live player on the SAME stable surface id (D5);
 *   - PATCHing a source the page EMBEDS re-pushes the page's slice with the new resolution;
 *   - a page source refuses to be created url-style, and a page assignment refuses zoom;
 *   - DELETE clears the assignment (empty render), like every other source kind.
 *
 * Port 8103 (each e2e suite owns a port + fresh memory store).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8103;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "pages-host-1";
const CONN = "HDMI-1";

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

let screenId = "";
let player: WsClient;

let dashSourceId = ""; // the dashboard a page embed references
let pageSourceId = "";

const DASH_URL = "https://dashboard.example.test/embed/kpi?kiosk";
const DASH_URL_V2 = "https://dashboard.example.test/embed/kpi-v2?kiosk";

const DEFINITION_V1 = {
  aspect: "16:9",
  bg: "#0b0b0e",
  elements: [
    { id: "em1", kind: "embed", x: 0, y: 0, w: 100, h: 78, props: {} },
    {
      id: "tk1",
      kind: "ticker",
      x: 0,
      y: 90,
      w: 100,
      h: 10,
      props: { text: "Orders up 12% week-on-week", speed: 60, fg: "#fafafa", bg: "#101014" },
    },
    { id: "ck1", kind: "clock", x: 84, y: 80, w: 14, h: 8, props: { format: "24h", seconds: false, color: "#fafafa" } },
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
    outputs: [{ connector: CONN, width: 1920, height: 1080 }],
  });
  const apply = await agent.waitFor((m) => m.t === "server/apply" && m.machineId === MACHINE_ID, "server/apply");
  screenId = apply.screens[0].screenId;

  player = await WsClient.connect(`${WS}/player`);
  openClients.push(player);
  player.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId });
  await player.waitFor((m) => m.t === "server/render" && m.slice?.screenId === screenId, "initial render");
}, 30_000);

afterAll(() => {
  for (const c of openClients) c.close();
  proc?.kill();
});

describe("POL-42 pages over the real wire", () => {
  test(
    "a page source is created from a definition (no url) and refuses the url-only shape",
    async () => {
      const bad = await json("POST", "/api/v1/content-sources", {
        name: "Broken page",
        kind: "page",
        url: "https://not-how-pages-work.test/",
      });
      expect(bad.status).toBe(400);
      await bad.body?.cancel();

      const dash = await json("POST", "/api/v1/content-sources", {
        name: "KPI Wall",
        kind: "dashboard",
        url: DASH_URL,
      });
      expect(dash.status).toBe(201);
      dashSourceId = ((await dash.json()) as Frame).source.id;

      const definition = structuredClone(DEFINITION_V1);
      (definition.elements[0] as Frame).props.sourceId = dashSourceId;
      const created = await json("POST", "/api/v1/content-sources", {
        name: "Factory Morning Wall",
        kind: "page",
        definition,
      });
      expect(created.status).toBe(201);
      const body = (await created.json()) as Frame;
      pageSourceId = body.source.id;
      expect(body.source.url).toBeUndefined();
      expect(body.source.definition.elements.length).toBe(3);
    },
    TEST_TIMEOUT,
  );

  test(
    "assigning the page pushes ONE page surface with the definition + send-time-resolved embeds",
    async () => {
      const res = await json("PUT", `/api/v1/screens/${screenId}/content`, { sourceId: pageSourceId });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const render = await player.waitFor(
        (m) => m.t === "server/render" && m.slice?.surfaces?.[0]?.type === "page",
        "page render",
      );
      const surface = render.slice.surfaces[0];
      expect(render.slice.surfaces.length).toBe(1); // a page is still ONE surface — the scope fence
      expect(surface.id).toBe("content-web");
      expect(surface.definition.elements.map((e: Frame) => e.id)).toEqual(["em1", "tk1", "ck1"]);
      // The stored definition references the dashboard BY ID; the wire carries the resolution.
      expect(surface.definition.elements[0].props.sourceId).toBe(dashSourceId);
      expect(surface.data.embeds.em1).toEqual({ url: DASH_URL, kind: "dashboard" });
      expect(surface.zoom).toBeUndefined(); // pages carry no zoom
    },
    TEST_TIMEOUT,
  );

  test(
    "zoom on a page assignment is refused (pages scale by design)",
    async () => {
      const res = await json("PUT", `/api/v1/screens/${screenId}/zoom`, { zoom: 1.5 });
      expect([400, 409]).toContain(res.status);
      await res.body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "saving a new definition re-pushes the SAME stable surface — the Studio's <150ms live edit",
    async () => {
      const definition = structuredClone(DEFINITION_V1);
      (definition.elements[0] as Frame).props.sourceId = dashSourceId;
      (definition.elements[1] as Frame).props.text = "Visitors arrive 14:00";
      const res = await json("PATCH", `/api/v1/content-sources/${pageSourceId}`, { definition });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const render = await player.waitFor(
        (m) =>
          m.t === "server/render" &&
          m.slice?.surfaces?.[0]?.type === "page" &&
          m.slice.surfaces[0].definition?.elements?.[1]?.props?.text === "Visitors arrive 14:00",
        "re-pushed page render",
      );
      expect(render.slice.surfaces[0].id).toBe("content-web"); // same keyed node → in-place patch (D5)
    },
    TEST_TIMEOUT,
  );

  test(
    "editing the EMBEDDED dashboard re-pushes the page with the new resolution",
    async () => {
      const res = await json("PATCH", `/api/v1/content-sources/${dashSourceId}`, { url: DASH_URL_V2 });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const render = await player.waitFor(
        (m) =>
          m.t === "server/render" &&
          m.slice?.surfaces?.[0]?.type === "page" &&
          m.slice.surfaces[0].data?.embeds?.em1?.url === DASH_URL_V2,
        "page render with re-resolved embed",
      );
      // Still the page on air — the edit rode through the embed, not the assignment.
      expect(render.slice.surfaces[0].definition.elements[0].props.sourceId).toBe(dashSourceId);
    },
    TEST_TIMEOUT,
  );

  test(
    "deleting the page clears the screen, like any other source",
    async () => {
      const res = await json("DELETE", `/api/v1/content-sources/${pageSourceId}`);
      expect(res.status).toBe(200);
      await res.body?.cancel();
      await player.waitFor(
        (m) => m.t === "server/render" && m.slice?.surfaces?.length === 0,
        "cleared render",
      );
    },
    TEST_TIMEOUT,
  );
});
