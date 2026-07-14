/**
 * @polyptic/e2e — POL-109 MEDIA INGEST against the REAL control plane.
 *
 * Phase 7 made upload a byte sink: any image/* or video/* was accepted, stored, and handed to a wall.
 * An AVI therefore became a black screen on the glass, an untimed playlist video had no duration to
 * plan with, and the library had no pictures. POL-109 turns the upload route into a PIPELINE — probe,
 * validate, poster — and this suite drives it end to end over REAL fixture files (the same ones the
 * server unit suite probes): an H.264 MP4 a wall can play, an MPEG-4-Part-2 AVI it cannot, and a PNG.
 *
 * What is pinned here (over HTTP + the real WS, not mocks):
 *   · POST /api/v1/media (AVI)  → 415, the message NAMES the format, and NOTHING lands in the library.
 *   · POST /api/v1/media (MP4)  → 201, and the source carries probed `media` (duration/size/codec).
 *   · GET  /media/<id>/poster   → 200 image/* — UNGATED, like the media route itself.
 *   · admin/state.contentSources carry the ingest decoration, so the console can show real thumbnails.
 *   · assigning the video → the player's `video` surface carries `poster` (the pre-buffer frame).
 *
 * TOOLCHAIN-OPTIONAL (D114). CI (and a dev laptop) may have no media toolchain. The suite detects that
 * ONCE and asserts the OTHER contract in that case: the upload is still ACCEPTED, marked unprobed, and
 * carries a warning — a server without the tool must never refuse an upload it cannot inspect. Both
 * branches are real assertions; neither is a skip.
 *
 * Own port (8130) + a fresh temp MEDIA_DIR + MemoryStore, like every other e2e suite.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8130;
const BASE = `http://localhost:${PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 20_000;

const MACHINE_ID = "ingest-host-1";
const CONN = "HDMI-1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");
const fixtures = resolve(repoRoot, "packages", "server", "test", "fixtures");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Does this host have the media toolchain the default prober shells out to? `MEDIA_PROBE=off` (the
 *  server's own kill switch) is honoured, which also lets a developer WITH the toolchain drive the
 *  no-toolchain branch of every assertion below: `MEDIA_PROBE=off bun test media-ingest`. */
async function hasToolchain(): Promise<boolean> {
  if ((process.env.MEDIA_PROBE ?? "").toLowerCase() === "off") return false;
  for (const cmd of ["ffprobe", "ffmpeg"]) {
    try {
      const p = Bun.spawn([cmd, "-version"], { stdout: "ignore", stderr: "ignore" });
      if ((await p.exited) !== 0) return false;
    } catch {
      return false;
    }
  }
  return true;
}

// ── a tiny buffering WS client (same shape as the other e2e suites) ──────────
type Frame = any;

class WsClient {
  readonly ws: WebSocket;
  private readonly queue: Frame[] = [];
  private readonly waiters: Array<{
    pred: (m: Frame) => boolean;
    resolve: (m: Frame) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];

  private constructor(ws: WebSocket) {
    this.ws = ws;
    ws.addEventListener("message", (ev: { data: unknown }) => this.ingest(ev.data));
  }

  static connect(url: string, timeoutMs = 5_000): Promise<WsClient> {
    return new Promise<WsClient>((res, rej) => {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => rej(new Error(`ws open timeout: ${url}`)), timeoutMs);
      ws.addEventListener("open", () => {
        clearTimeout(timer);
        res(new WsClient(ws));
      }, { once: true });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        rej(new Error(`ws error before open: ${url}`));
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

  waitFor(pred: (m: Frame) => boolean, label = "frame", timeoutMs = 5_000): Promise<Frame> {
    const qi = this.queue.findIndex(pred);
    if (qi >= 0) return Promise.resolve(this.queue.splice(qi, 1)[0]);
    return new Promise<Frame>((res, rej) => {
      const timer = setTimeout(() => rej(new Error(`timed out waiting for ${label}`)), timeoutMs);
      this.waiters.push({ pred, resolve: res, timer });
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

const openClients: WsClient[] = [];

async function snapshot(label: string): Promise<Frame> {
  const admin = await WsClient.connect(`${WS}/admin`);
  openClients.push(admin);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  const state = await admin.waitFor((m) => m.t === "admin/state", label);
  admin.close();
  return state;
}

async function upload(fixture: string, mime: string, name: string): Promise<Response> {
  const bytes = await readFile(join(fixtures, fixture));
  const form = new FormData();
  form.set("name", name);
  form.set("file", new Blob([bytes], { type: mime }), fixture);
  return fetch(`${BASE}/api/v1/media`, { method: "POST", body: form });
}

let proc: ReturnType<typeof Bun.spawn> | null = null;
let mediaDir = "";
let screenId = "";
let player: WsClient;
let probing = false;

let videoSource: Frame;
let videoMediaId = "";
let imageSource: Frame;

beforeAll(async () => {
  probing = await hasToolchain();
  mediaDir = await mkdtemp(join(tmpdir(), "polyptic-ingest-e2e-"));

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
      MEDIA_PUBLIC_BASE: BASE,
      PUBLIC_BASE_URL: BASE,
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
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("server did not start");
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
  const apply = await agent.waitFor(
    (m) => m.t === "server/apply" && m.machineId === MACHINE_ID,
    "server/apply",
  );
  screenId = apply.screens[0].screenId;

  player = await WsClient.connect(`${WS}/player`);
  openClients.push(player);
  player.send({ t: "player/hello", protocol: PROTOCOL_VERSION, screenId });
  await player.waitFor((m) => m.t === "server/render", "initial render");
}, 40_000);

afterAll(async () => {
  for (const c of openClients) c.close();
  proc?.kill();
  if (proc) {
    try {
      await proc.exited;
    } catch {
      /* gone */
    }
  }
  if (mediaDir) await rm(mediaDir, { recursive: true, force: true });
}, 10_000);

describe("POL-109 ingest at the upload route", () => {
  test(
    "a wall-hostile AVI is REJECTED at upload with a message that names it — never reaches the library",
    async () => {
      const res = await upload("hostile.avi", "video/x-msvideo", "Old Conference Clip");
      const body = (await res.json()) as Frame;

      if (probing) {
        expect(res.status).toBe(415);
        expect(String(body.error)).toContain("AVI");
        expect(body.reason).toBe("codec");
      } else {
        // D114 — a server with no toolchain knows nothing, so it accepts and SAYS so. It must not
        // refuse an upload it could not inspect.
        expect(res.status).toBe(201);
        expect(String(body.warning)).toContain("toolchain");
      }

      const state = await snapshot("admin/state after the AVI");
      const landed = (state.contentSources as Frame[]).some(
        (s) => s.name === "Old Conference Clip",
      );
      expect(landed).toBe(!probing);
    },
    TEST_TIMEOUT,
  );

  test(
    "a playable MP4 is accepted, and the source carries what ingest PROBED",
    async () => {
      const res = await upload("playable.mp4", "video/mp4", "Lobby Loop");
      expect(res.status).toBe(201);
      const body = (await res.json()) as Frame;
      videoSource = body.source;
      expect(videoSource.kind).toBe("video");
      videoMediaId = /\/media\/([a-f0-9]+)$/.exec(videoSource.url)![1]!;

      if (probing) {
        expect(videoSource.media.probed).toBe(true);
        expect(videoSource.media.videoCodec).toBe("h264");
        expect(videoSource.media.width).toBe(160);
        expect(videoSource.media.height).toBe(120);
        // The duration the console auto-fills a playlist step with — the fixture is ~2 s.
        expect(videoSource.media.durationSeconds).toBeGreaterThan(1.5);
        expect(videoSource.media.posterUrl).toBe(`${BASE}/media/${videoMediaId}/poster`);
      } else {
        expect(videoSource.media.probed).toBe(false);
        expect(String(body.warning)).toContain("toolchain");
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "an image gets a library picture either way (a real thumbnail when probed, itself when not)",
    async () => {
      const res = await upload("photo.png", "image/png", "Brand Photo");
      expect(res.status).toBe(201);
      const body = (await res.json()) as Frame;
      imageSource = body.source;
      expect(imageSource.kind).toBe("image");
      expect(typeof imageSource.media.posterUrl).toBe("string");
      expect(imageSource.media.posterUrl.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /media/<id>/poster is served UNGATED (the wall paints it with no session)",
    async () => {
      const res = await fetch(`${BASE}/media/${videoMediaId}/poster`);
      if (probing) {
        expect(res.status).toBe(200);
        expect(res.headers.get("content-type")).toContain("image/");
        const bytes = new Uint8Array(await res.arrayBuffer());
        expect(bytes.length).toBeGreaterThan(200);
      } else {
        // Nothing was extracted, so there is nothing to serve — an honest 404, not a broken image.
        expect(res.status).toBe(404);
        await res.body?.cancel();
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "admin/state carries the ingest decoration, so the console can show real thumbnails",
    async () => {
      const state = await snapshot("admin/state with ingested sources");
      const found = (state.contentSources as Frame[]).find((s) => s.id === videoSource.id);
      expect(found).toBeDefined();
      expect(found!.media).toBeDefined();
      expect(found!.media.probed).toBe(probing);
    },
    TEST_TIMEOUT,
  );

  test(
    "assigning the video puts its POSTER on the player's video surface (no black pre-buffer flash)",
    async () => {
      const res = await fetch(`${BASE}/api/v1/screens/${screenId}/content`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: videoSource.id }),
      });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const render = await player.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => s.type === "video"),
        "video render",
      );
      const surface = render.slice.surfaces.find((s: Frame) => s.type === "video");
      expect(surface.src).toBe(videoSource.url);
      if (probing) {
        expect(surface.poster).toBe(`${BASE}/media/${videoMediaId}/poster`);
      } else {
        expect(surface.poster).toBeUndefined();
      }
    },
    TEST_TIMEOUT,
  );
});
