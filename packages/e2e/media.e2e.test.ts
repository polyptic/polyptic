/**
 * @polyptic/e2e — Phase 7 MEDIA suite against the REAL control plane.
 *
 * Phase 7 adds **uploadable** media on top of the Phase-3c content library. An upload is stored on a
 * DISK VOLUME (MEDIA_DIR) and served over plain HTTP so any wall player — on another host, with no
 * session — can fetch it. The upload becomes a `ContentSource` (kind image|video) whose `url` is an
 * ABSOLUTE URL to the media serve route, so it slots straight into the 3c assignment plumbing.
 *
 * THE TWO ROUTES (see the build prompt):
 *   - POST /api/v1/media  (GATED — operator only): multipart upload. Accept image/* and video/* only;
 *     enforce a size limit. On success it saves the file under MEDIA_DIR as <random-id>.<ext>, records
 *     it, creates a ContentSource {kind, name, url: `${PUBLIC_BASE}/media/${id}`} and returns it. The
 *     source then appears in admin/state.contentSources exactly like a linked 3c source.
 *   - GET /media/:id  (TOP-LEVEL, UNGATED): serves the file with the correct Content-Type, HTTP Range
 *     support (206 + Content-Range for a Range request — REQUIRED for video seeking), Accept-Ranges:
 *     bytes, and a sensible Cache-Control. 404 for an unknown id. No session required (ids are
 *     unguessable), just like any external content URL.
 *
 * LIFECYCLE: deleting a ContentSource that is backed by an uploaded file unlinks the file — so after a
 * delete the source is gone AND GET /media/:id → 404.
 *
 * We run with AUTH_ENABLED=false (the upload route is reachable without a session in the test) against
 * the MemoryStore on its OWN PORT (8098), with a FRESH temp MEDIA_DIR per run (cleaned in afterAll) and
 * MEDIA_PUBLIC_BASE pointing back at this server so the returned source url is loadable here. One fake
 * agent reporting ONE output is auto-registered + auto-approved, giving one screen we assign media to.
 *
 * Robustness mirrors content.e2e.ts: every WS read is buffered (a frame between awaits is never missed)
 * with a per-message timeout, and each state assertion opens a FRESH /admin connection and reads its
 * first admin/state. The server process + temp dir are torn down in afterAll.
 *
 * Independent of the other e2e suites (each on its own port + fresh store): polyptych (8090),
 * enrollment (8091), murals (8092), walls (8093), content (8094). All must stay green.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8098;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const PUBLIC_BASE = `http://localhost:${PORT}`;
const TEST_TIMEOUT = 10_000;

const MACHINE_ID = "media-host-1";
const RES_W = 1920;
const RES_H = 1080;
const CONN_A = "HDMI-1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A tiny, REAL 1×1 PNG (valid header → mime sniffing passes; bytes are exact so the
// served body can be compared byte-for-byte, including a Range slice).
// ─────────────────────────────────────────────────────────────────────────────

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, // signature
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, // IHDR length + "IHDR"
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, // 1×1
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, // IDAT length + "IDAT"
  0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00,
  0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, // IEND length + "IEND"
  0x42, 0x60, 0x82,
]);

// ─────────────────────────────────────────────────────────────────────────────
// A buffering WS client: never miss a frame between awaits. (Same as content.e2e.ts.)
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

// ─────────────────────────────────────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────────────────────────────────────

function putJson(path: string, body: unknown): Promise<Response> {
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

/** Upload bytes as multipart/form-data via FormData + Blob (real multipart, real network). */
async function uploadMedia(
  bytes: Uint8Array,
  mime: string,
  filename: string,
  name?: string,
): Promise<Response> {
  const form = new FormData();
  if (name !== undefined) form.set("name", name);
  // A fresh ArrayBuffer slice keeps the Blob independent of the shared Uint8Array buffer.
  form.set("file", new Blob([bytes.slice()], { type: mime }), filename);
  return fetch(`${BASE}/api/v1/media`, { method: "POST", body: form });
}

// ─────────────────────────────────────────────────────────────────────────────
// Wire-shape builders
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

const sourcesOf = (state: Frame): Frame[] =>
  Array.isArray(state.contentSources) ? state.contentSources : [];
const sourceById = (state: Frame, id: string): Frame | undefined =>
  sourcesOf(state).find((s) => s.id === id);

/** A renderable surface's content URL lives in `url` (web/dashboard) or `src` (image/video). */
const surfUrl = (s: Frame): string | undefined => (s?.url !== undefined ? s.url : s?.src);

const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// Server process + temp MEDIA_DIR lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;
let mediaDir = "";

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

let screenA = ""; // the single screen we assign uploaded media to
let playerA: WsClient;

let imageSource: Frame; // the ContentSource created by the PNG upload
let imageId = ""; // the <id> in /media/<id>

beforeAll(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "polyptic-media-e2e-"));

  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
      MEDIA_DIR: mediaDir,
      MEDIA_PUBLIC_BASE: PUBLIC_BASE,
      PUBLIC_BASE_URL: PUBLIC_BASE,
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();

  // One agent, ONE output → one screen.
  const agent = await openAgent();
  agent.send(agentHello(MACHINE_ID, [{ connector: CONN_A, width: RES_W, height: RES_H }]));
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply for media-host-1",
    5_000,
  );
  expect(Array.isArray(apply.screens)).toBe(true);
  expect(apply.screens.length).toBe(1);
  const entry = apply.screens.find((s: Frame) => s.connector === CONN_A);
  expect(entry).toBeDefined();
  screenA = entry.screenId;
  expect(typeof screenA).toBe("string");
  expect(screenA.length).toBeGreaterThan(0);

  playerA = await connectPlayer(screenA);
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
  if (mediaDir) {
    try {
      await rm(mediaDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  }
}, 10_000);

// ─────────────────────────────────────────────────────────────────────────────
// Upload — POST /api/v1/media with a real in-memory PNG
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 7 media upload", () => {
  test(
    "POST /api/v1/media with a PNG → 2xx + a ContentSource of kind image, url ending /media/<id>",
    async () => {
      const res = await uploadMedia(PNG_BYTES, "image/png", "logo.png", "Brand Logo");
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      const body = await res.json();

      // The response carries the created source (under {source} per the build prompt, but tolerate a
      // bare source object too).
      const source: Frame = (body as Frame)?.source ?? body;
      expect(source).toBeDefined();
      expect(typeof source.id).toBe("string");
      expect(source.id.length).toBeGreaterThan(0);
      expect(source.kind).toBe("image");
      expect(typeof source.url).toBe("string");

      // url must be an ABSOLUTE url to the media route ending /media/<id>.
      const m = /\/media\/([^/?#]+)$/.exec(source.url);
      expect(m).not.toBeNull();
      imageId = m![1]!;
      expect(imageId.length).toBeGreaterThan(0);
      expect(source.url).toBe(`${PUBLIC_BASE}/media/${imageId}`);

      // The name came from the form field (falls back to the filename if omitted).
      expect(source.name).toBe("Brand Logo");

      imageSource = source;
    },
    TEST_TIMEOUT,
  );

  test(
    "the uploaded source appears in admin/state.contentSources",
    async () => {
      const state = await snapshot("admin/state with the uploaded image source");
      const found = sourceById(state, imageSource.id);
      expect(found).toBeDefined();
      expect(found!.kind).toBe("image");
      expect(found!.url).toBe(`${PUBLIC_BASE}/media/${imageId}`);
    },
    TEST_TIMEOUT,
  );

  test(
    "a real file was written under MEDIA_DIR (named by the generated id, not the client filename)",
    async () => {
      const files = await readdir(mediaDir);
      // The stored file is named <id>.<ext> — never the client-supplied "logo.png".
      expect(files.some((f) => f.startsWith(imageId))).toBe(true);
      expect(files).not.toContain("logo.png");
    },
    TEST_TIMEOUT,
  );

  test(
    "POST /api/v1/media with a non-image/video (text/plain) → 415 (or 400)",
    async () => {
      const res = await uploadMedia(
        new TextEncoder().encode("not media"),
        "text/plain",
        "notes.txt",
        "Notes",
      );
      expect([400, 415]).toContain(res.status);
      await drain(res);

      // No source was created for the rejected upload.
      const state = await snapshot("admin/state after rejected non-media upload");
      expect(sourcesOf(state).some((s) => s.name === "Notes")).toBe(false);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Serve — GET /media/:id (TOP-LEVEL, UNGATED), with HTTP Range support
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 7 media serving", () => {
  test(
    "GET /media/<id> (NO auth) → 200, Content-Type image/png, Accept-Ranges, exact bytes",
    async () => {
      const res = await fetch(`${BASE}/media/${imageId}`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("image/png");
      expect(res.headers.get("accept-ranges")).toBe("bytes");

      const got = new Uint8Array(await res.arrayBuffer());
      expect(got.length).toBe(PNG_BYTES.length);
      expect(bytesEqual(got, PNG_BYTES)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /media/<id> with Range: bytes=0-9 → 206 + Content-Range + exactly 10 bytes",
    async () => {
      const res = await fetch(`${BASE}/media/${imageId}`, {
        headers: { range: "bytes=0-9" },
      });
      expect(res.status).toBe(206);
      expect(res.headers.get("accept-ranges")).toBe("bytes");

      const contentRange = res.headers.get("content-range");
      expect(contentRange).not.toBeNull();
      // bytes 0-9/<total>
      expect(contentRange).toBe(`bytes 0-9/${PNG_BYTES.length}`);

      const got = new Uint8Array(await res.arrayBuffer());
      expect(got.length).toBe(10);
      expect(bytesEqual(got, PNG_BYTES.slice(0, 10))).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /media/unknown → 404",
    async () => {
      const res = await fetch(`${BASE}/media/this-id-does-not-exist`);
      expect(res.status).toBe(404);
      await drain(res);
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Assign — the uploaded source resolves to an image surface on a screen (3c plumbing)
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 7 uploaded media assigns like any source", () => {
  test(
    "PUT /screens/:id/content {sourceId} → the player render has an image surface with the media url",
    async () => {
      const mediaUrl = `${PUBLIC_BASE}/media/${imageId}`;
      const res = await putJson(`/api/v1/screens/${screenA}/content`, { sourceId: imageSource.id });
      expect(res.status).toBe(200);
      await drain(res);

      const render = await playerA.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => surfUrl(s) === mediaUrl),
        "image render for A from uploaded media",
      );
      const surface = render.slice.surfaces.find((s: Frame) => surfUrl(s) === mediaUrl);
      expect(surface).toBeDefined();
      expect(surface.type).toBe("image");
      expect(surface.src).toBe(mediaUrl);
      // A single-screen tile fills its region and carries NO span.
      expect(surface.region).toMatchObject({ x: 0, y: 0, w: RES_W, h: RES_H });
      expect(surface.span).toBeUndefined();
    },
    TEST_TIMEOUT,
  );
});

// ─────────────────────────────────────────────────────────────────────────────
// Lifecycle — deleting the source unlinks the file (GET → 404)
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 7 deleting an uploaded source unlinks the file", () => {
  test(
    "DELETE /content-sources/:id → the source is gone AND GET /media/<id> → 404 (file unlinked)",
    async () => {
      // The serve route works right up until the delete.
      const before = await fetch(`${BASE}/media/${imageId}`);
      expect(before.status).toBe(200);
      await drain(before);

      const res = await del(`/api/v1/content-sources/${imageSource.id}`);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      await drain(res);

      // The source is gone from the library.
      const state = await snapshot("admin/state after deleting the uploaded source");
      expect(sourceById(state, imageSource.id)).toBeUndefined();

      // The file was unlinked → the serve route now 404s.
      const after = await fetch(`${BASE}/media/${imageId}`);
      expect(after.status).toBe(404);
      await drain(after);

      // And the file is gone from disk.
      const files = await readdir(mediaDir);
      expect(files.some((f) => f.startsWith(imageId))).toBe(false);
    },
    TEST_TIMEOUT,
  );
});
