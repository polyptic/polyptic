/**
 * @polyptic/e2e — WEB-WINDOW (POL-18) suite against the REAL control plane.
 *
 * The escape hatch for framing-blocked content: a web/dashboard source that refuses to be framed
 * (CSP `frame-ancestors` / `X-Frame-Options`) renders as a TOP-LEVEL window placed by the agent
 * over the player, instead of a dead iframe tile. This suite proves the whole server-side story
 * over the real wire:
 *
 *   - a `placementMode: "window"` source resolves to a `placement: "window"` surface on the
 *     player channel, and the AGENT channel's `server/apply` carries the matching `windows[]`
 *     placement (id + credential-stampable url + region + canvas) for the right connector;
 *   - the AUTO fallback: a source pointing at a live local HTTP server that answers
 *     `X-Frame-Options: DENY` is probed by the server, verdict `blocked` lands on the source
 *     (admin/state), and assignment resolves it to a window with no operator involvement;
 *   - the operator override pins both ways (force-framed stays an iframe even when blocked);
 *   - clearing the content retires the window from the next apply;
 *   - the console surface: ScreenView.content.windowed = true while windowed.
 *
 * The fake agent reports backend `wayland-sway` — window placement is capability-gated on it
 * (dev-open/x11-i3 degrade to the iframe; that path is pinned by the state unit tests).
 *
 * Own port (8140) + fresh memory store, like every other e2e suite; the framing-header origin
 * runs in-process on 8141.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8140;
const HEADER_PORT = 8141;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "web-window-host-1";
const CONN_A = "HDMI-1";
const CONN_B = "HDMI-2";
const RES_W = 1920;
const RES_H = 1080;

const BLOCKED_URL = `http://localhost:${HEADER_PORT}/blocked`;
const OK_URL = `http://localhost:${HEADER_PORT}/ok`;
const FORCED_URL = "https://frames-fine.example/dashboard";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ── buffering WS client (the house pattern — never miss a frame between awaits) ──

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

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {}
}

const openClients: WsClient[] = [];

async function snapshot(label: string): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  const state = await admin.waitFor((m) => m.t === "admin/state", label);
  admin.close();
  return state;
}

async function createSource(body: Record<string, unknown>): Promise<Frame> {
  const res = await postJson("/api/v1/content-sources", body);
  expect(res.status).toBe(201);
  const json = (await res.json()) as { source: Frame };
  return json.source;
}

// ── processes / servers ───────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;
let headerServer: ReturnType<typeof Bun.serve> | null = null;

let agent: WsClient;
let playerA: WsClient;
let screenA = "";
let screenB = "";

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

beforeAll(async () => {
  // A real HTTP origin whose /blocked answers with X-Frame-Options: DENY — what the server's
  // framing probe reads. /ok carries no framing headers at all.
  headerServer = Bun.serve({
    port: HEADER_PORT,
    fetch(req) {
      const path = new URL(req.url).pathname;
      if (path === "/blocked") {
        return new Response("<html>no frames</html>", {
          headers: { "content-type": "text/html", "x-frame-options": "DENY" },
        });
      }
      return new Response("<html>frame away</html>", {
        headers: { "content-type": "text/html" },
      });
    },
  });

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

  // One fake agent, TWO outputs, backend wayland-sway (the capability the server gates windows on).
  agent = await WsClient.connect(`${WS}/agent`);
  openClients.push(agent);
  agent.send({
    t: "agent/hello",
    protocol: PROTOCOL_VERSION,
    machineId: MACHINE_ID,
    agentVersion: "e2e",
    backend: "wayland-sway",
    outputs: [
      { connector: CONN_A, width: RES_W, height: RES_H },
      { connector: CONN_B, width: RES_W, height: RES_H },
    ],
  });
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "initial server/apply",
    5_000,
  );
  expect(apply.screens.length).toBe(2);
  screenA = apply.screens.find((s: Frame) => s.connector === CONN_A).screenId;
  screenB = apply.screens.find((s: Frame) => s.connector === CONN_B).screenId;

  playerA = await WsClient.connect(`${WS}/player`);
  openClients.push(playerA);
  playerA.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId: screenA });
  await playerA.waitFor(
    (m) => m.t === "server/render" && m.slice?.screenId === screenA,
    "initial render for A",
    5_000,
  );
}, 30_000);

afterAll(async () => {
  for (const c of openClients) c.close();
  headerServer?.stop(true);
  if (proc) {
    proc.kill();
    try {
      await proc.exited;
    } catch {}
  }
}, 10_000);

// ── forced window: surface + agent placement ─────────────────────────────────

describe("web-window: forced placement (POL-18)", () => {
  test(
    "a placementMode:'window' source renders a window surface AND the agent gets the placement",
    async () => {
      const source = await createSource({
        name: "Forced Window",
        kind: "web",
        url: FORCED_URL,
        placementMode: "window",
      });

      const res = await putJson(`/api/v1/screens/${screenA}/content`, { sourceId: source.id });
      expect(res.status).toBe(200);
      await drain(res);

      // Player channel: the surface arrives as a WINDOW — the player will leave a hole, not probe.
      const render = await playerA.waitFor(
        (m) =>
          m.t === "server/render" &&
          m.slice?.surfaces?.some((s: Frame) => s.url === FORCED_URL),
        "windowed render for A",
      );
      const surface = render.slice.surfaces.find((s: Frame) => s.url === FORCED_URL);
      expect(surface.type).toBe("web");
      expect(surface.placement).toBe("window");

      // Agent channel: a fresh server/apply rides the placement for the RIGHT connector.
      const apply = await agent.waitFor(
        (m) =>
          m.t === "server/apply" &&
          m.screens?.some((s: Frame) => (s.windows?.length ?? 0) > 0),
        "server/apply with windows",
      );
      const onA = apply.screens.find((s: Frame) => s.connector === CONN_A);
      const onB = apply.screens.find((s: Frame) => s.connector === CONN_B);
      expect(onA.windows).toHaveLength(1);
      expect(onA.windows[0]).toMatchObject({
        id: surface.id,
        url: FORCED_URL,
        region: { x: 0, y: 0, w: RES_W, h: RES_H },
        canvas: { x: 0, y: 0, w: RES_W, h: RES_H },
      });
      expect(onB.windows ?? []).toHaveLength(0);

      // Console surface: the screen reads as windowed.
      const state = await snapshot("admin/state while windowed");
      const machine = state.machines.find((m: Frame) => m.id === MACHINE_ID);
      const viewA = machine.screens.find((s: Frame) => s.id === screenA);
      expect(viewA.content?.windowed).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "clearing the screen retires the window from the next apply",
    async () => {
      const res = await postJson(`/api/v1/screens/${screenA}/surfaces`, { surfaces: [] });
      expect(res.status).toBe(200);
      await drain(res);

      const apply = await agent.waitFor(
        (m) =>
          m.t === "server/apply" &&
          m.screens?.every((s: Frame) => (s.windows?.length ?? 0) === 0),
        "server/apply with the window retired",
      );
      expect(apply.machineId).toBe(MACHINE_ID);
    },
    TEST_TIMEOUT,
  );
});

// ── the auto fallback: probe → blocked → windowed ─────────────────────────────

describe("web-window: automatic framing fallback (POL-18)", () => {
  let blockedSource: Frame;

  test(
    "the server probes a new source and stores the 'blocked' verdict",
    async () => {
      blockedSource = await createSource({
        name: "Blocks Framing",
        kind: "dashboard",
        url: BLOCKED_URL,
      });

      // The create-time probe is async; the explicit re-probe route is deterministic — use it to
      // both exercise the endpoint and synchronise the test.
      const probe = await postJson(`/api/v1/content-sources/${blockedSource.id}/probe-framing`, {});
      expect(probe.status).toBe(200);
      const verdict = (await probe.json()) as { ok: boolean; framing: string };
      expect(verdict.framing).toBe("blocked");

      const state = await snapshot("admin/state with the blocked verdict");
      const src = state.contentSources.find((s: Frame) => s.id === blockedSource.id);
      expect(src.framing).toBe("blocked");
    },
    TEST_TIMEOUT,
  );

  test(
    "assigning the blocked source resolves to a window automatically",
    async () => {
      const res = await putJson(`/api/v1/screens/${screenA}/content`, {
        sourceId: blockedSource.id,
      });
      expect(res.status).toBe(200);
      await drain(res);

      const render = await playerA.waitFor(
        (m) =>
          m.t === "server/render" &&
          m.slice?.surfaces?.some((s: Frame) => s.url === BLOCKED_URL),
        "auto-windowed render for A",
      );
      const surface = render.slice.surfaces.find((s: Frame) => s.url === BLOCKED_URL);
      expect(surface.type).toBe("dashboard");
      expect(surface.placement).toBe("window");

      const apply = await agent.waitFor(
        (m) =>
          m.t === "server/apply" &&
          m.screens?.some((s: Frame) =>
            (s.windows ?? []).some((w: Frame) => w.url === BLOCKED_URL),
          ),
        "server/apply with the auto window",
      );
      expect(apply.machineId).toBe(MACHINE_ID);
    },
    TEST_TIMEOUT,
  );

  test(
    "a source that frames fine stays an iframe (verdict ok)",
    async () => {
      const okSource = await createSource({ name: "Frames Fine", kind: "web", url: OK_URL });
      const probe = await postJson(`/api/v1/content-sources/${okSource.id}/probe-framing`, {});
      const verdict = (await probe.json()) as { framing: string };
      expect(verdict.framing).toBe("ok");

      const res = await putJson(`/api/v1/screens/${screenB}/content`, { sourceId: okSource.id });
      expect(res.status).toBe(200);
      await drain(res);

      const state = await snapshot("admin/state after assigning the ok source");
      const machine = state.machines.find((m: Frame) => m.id === MACHINE_ID);
      const viewB = machine.screens.find((s: Frame) => s.id === screenB);
      expect(viewB.content?.windowed).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  test(
    "the operator override pins force-framed even when the verdict is blocked",
    async () => {
      const pinned = await createSource({
        name: "Pinned Frame",
        kind: "web",
        url: BLOCKED_URL,
        placementMode: "iframe",
      });
      const probe = await postJson(`/api/v1/content-sources/${pinned.id}/probe-framing`, {});
      const verdict = (await probe.json()) as { framing: string };
      expect(verdict.framing).toBe("blocked");

      const res = await putJson(`/api/v1/screens/${screenA}/content`, { sourceId: pinned.id });
      expect(res.status).toBe(200);
      await drain(res);

      const render = await playerA.waitFor(
        (m) =>
          m.t === "server/render" &&
          m.slice?.surfaces?.some(
            (s: Frame) => s.url === BLOCKED_URL && s.placement === "iframe",
          ),
        "pinned-iframe render for A",
      );
      const surface = render.slice.surfaces[0];
      expect(surface.placement).toBe("iframe");
    },
    TEST_TIMEOUT,
  );
});
