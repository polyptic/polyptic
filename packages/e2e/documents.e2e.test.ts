/**
 * @polyptic/e2e — POL-114 THE DOCUMENT PIPELINE against the REAL control plane.
 *
 * Slides and PDFs are the content operators ask for first, and a wall must never run an Office viewer
 * (DESIGN.md). So the server CONVERTS an uploaded document, once, into page images, and the library
 * source that lands is a `deck` — which resolves to the playlist surface the player already has.
 *
 * What is pinned here (over real HTTP + the real agent/player/admin sockets):
 *   · POST /api/v1/media (PDF)   → 202 + a JOB (never a blocking request — conversion is slow), and
 *                                  the job's progress arrives on `admin/state`, which is the whole
 *                                  progress channel the console watches.
 *   · the deck lands in the library ONLY once pages exist, carrying pageCount + page urls + dwell.
 *   · GET /media/<id>/page/<n>   → 200 image/png, UNGATED (a wall paints it with no session).
 *   · assigning the deck         → the player receives a PLAYLIST of IMAGE entries, one per page,
 *                                  every one TIMED. No new surface type reaches the glass.
 *   · PATCH dwellSeconds         → the rotation re-times and the wall is re-pushed, instantly.
 *   · a format the server cannot convert → the job FAILS with a sentence naming the format, and
 *                                  nothing appears in the library.
 *   · a server with NO converter → 415 at upload with a reason, and `capabilities.documents: false`
 *                                  so the console never offers the affordance (D115).
 *
 * TOOLCHAIN-FREE BY CONSTRUCTION. CI has no document toolchain, so the converting server is pointed
 * at the committed TEST DOUBLE (`packages/server/test/fixtures/fake-pdftoppm.sh`) via DOC_RASTER_CMD —
 * the same command-line contract the real binary honours, so the real adapter code runs — and its
 * office command is pointed at a binary that does not exist, which is what makes the PPTX refusal
 * deterministic on every host, toolchain or not. The document itself is a REAL 2-page PDF.
 *
 * Two servers, own ports (8131 converting, 8132 with conversion off), fresh temp MEDIA_DIRs, MemoryStore.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "@polyptic/protocol";

const PORT = 8131;
const OFF_PORT = 8132;
const BASE = `http://localhost:${PORT}`;
const OFF_BASE = `http://localhost:${OFF_PORT}`;
const WS = `ws://localhost:${PORT}`;
const TEST_TIMEOUT = 30_000;

const MACHINE_ID = "deck-host-1";
const CONN = "HDMI-1";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");
const fixtures = resolve(repoRoot, "packages", "server", "test", "fixtures");
const FAKE_RASTER = join(fixtures, "fake-pdftoppm.sh");

const PDF_MIME = "application/pdf";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

  waitFor(pred: (m: Frame) => boolean, label = "frame", timeoutMs = 10_000): Promise<Frame> {
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

async function snapshot(wsBase: string, label: string): Promise<Frame> {
  const admin = await WsClient.connect(`${wsBase}/admin`);
  admin.send({ t: "admin/hello", protocol: PROTOCOL_VERSION });
  const state = await admin.waitFor((m) => m.t === "admin/state", label);
  admin.close();
  return state;
}

async function upload(base: string, fixture: string, mime: string, name: string): Promise<Response> {
  const bytes = await readFile(join(fixtures, fixture));
  const form = new FormData();
  form.set("name", name);
  form.set("file", new Blob([bytes], { type: mime }), fixture);
  return fetch(`${base}/api/v1/media`, { method: "POST", body: form });
}

/** Wait for a conversion job to reach a terminal state, reading the SAME admin/state the console does. */
async function awaitJob(jobId: string, timeoutMs = 20_000): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await snapshot(WS, "admin/state while converting");
    const job = (state.documentJobs as Frame[] | undefined)?.find((j) => j.id === jobId);
    if (job && (job.status === "ready" || job.status === "failed")) return job;
    if (Date.now() > deadline) throw new Error(`job ${jobId} never finished (last: ${job?.status})`);
    await sleep(150);
  }
}

async function startServer(port: number, mediaDir: string, env: Record<string, string>) {
  const proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(port),
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
      AUTH_ENABLED: "false",
      MEDIA_DIR: mediaDir,
      MEDIA_PUBLIC_BASE: `http://localhost:${port}`,
      PUBLIC_BASE_URL: `http://localhost:${port}`,
      // No media prober is needed for decks, and CI has none — keep it off so the two pipelines are
      // provably independent (a deck must convert on a server with no media toolchain at all).
      MEDIA_PROBE: "off",
      ...env,
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  const deadline = Date.now() + 20_000;
  for (;;) {
    try {
      const res = await fetch(`http://localhost:${port}/api/v1/state`);
      if (res.ok) {
        await res.body?.cancel();
        break;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`server on ${port} did not start`);
    await sleep(100);
  }
  return proc;
}

let proc: ReturnType<typeof Bun.spawn> | null = null;
let offProc: ReturnType<typeof Bun.spawn> | null = null;
let mediaDir = "";
let offMediaDir = "";
let screenId = "";
let player: WsClient;

let deckSource: Frame;
let deckMediaId = "";

beforeAll(async () => {
  mediaDir = await mkdtemp(join(tmpdir(), "polyptic-deck-e2e-"));
  offMediaDir = await mkdtemp(join(tmpdir(), "polyptic-deck-off-e2e-"));

  proc = await startServer(PORT, mediaDir, {
    // The adapter's real code, driven against a stand-in binary at the same contract (see the header).
    DOC_RASTER_CMD: FAKE_RASTER,
    // Pinned ABSENT so "this host cannot read a PowerPoint" is deterministic on every runner.
    DOC_OFFICE_CMD: "polyptic-no-such-office",
  });
  offProc = await startServer(OFF_PORT, offMediaDir, { DOC_CONVERT: "off" });

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
}, 60_000);

afterAll(async () => {
  for (const c of openClients) c.close();
  for (const p of [proc, offProc]) {
    p?.kill();
    if (p) {
      try {
        await p.exited;
      } catch {
        /* gone */
      }
    }
  }
  for (const d of [mediaDir, offMediaDir]) {
    if (d) await rm(d, { recursive: true, force: true });
  }
}, 15_000);

describe("POL-114 the document pipeline", () => {
  test(
    "the server ADVERTISES whether it can convert documents at all",
    async () => {
      const on = await snapshot(WS, "admin/state (converting server)");
      expect(on.capabilities?.documents).toBe(true);

      const off = await snapshot(`ws://localhost:${OFF_PORT}`, "admin/state (no converter)");
      expect(off.capabilities?.documents).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "a server with NO converter REFUSES a document at upload, with a reason (D115)",
    async () => {
      const res = await upload(OFF_BASE, "deck.pdf", PDF_MIME, "All Hands");
      expect(res.status).toBe(415);
      const body = (await res.json()) as Frame;
      expect(body.reason).toBe("no-converter");
      expect(String(body.error)).toContain("document toolchain");

      // Nothing lands: a deck with no pages would be a library row that provably cannot paint.
      const state = await snapshot(`ws://localhost:${OFF_PORT}`, "admin/state after the refusal");
      expect((state.contentSources as Frame[]).length).toBe(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "a PDF upload answers 202 with a JOB — conversion never blocks the request",
    async () => {
      const res = await upload(BASE, "deck.pdf", PDF_MIME, "All Hands");
      expect(res.status).toBe(202);
      const body = (await res.json()) as Frame;
      expect(body.ok).toBe(true);
      expect(typeof body.job.id).toBe("string");
      expect(["converting", "rendering"]).toContain(body.job.status);

      // The job's progress rides admin/state — the console's whole window into the conversion.
      const job = await awaitJob(body.job.id);
      expect(job.status).toBe("ready");
      expect(job.pageCount).toBe(2); // the REAL page count of the REAL fixture PDF
      expect(typeof job.sourceId).toBe("string");

      const state = await snapshot(WS, "admin/state with the deck");
      deckSource = (state.contentSources as Frame[]).find((s) => s.id === job.sourceId);
      expect(deckSource).toBeDefined();
      expect(deckSource.kind).toBe("deck");
      expect(deckSource.name).toBe("All Hands");
      expect(deckSource.deck.pageCount).toBe(2);
      expect(deckSource.deck.dwellSeconds).toBe(10);
      deckMediaId = /\/media\/([a-f0-9]+)$/.exec(deckSource.url)![1]!;
      expect(deckSource.deck.pageUrls).toEqual([
        `${BASE}/media/${deckMediaId}/page/1`,
        `${BASE}/media/${deckMediaId}/page/2`,
      ]);
    },
    TEST_TIMEOUT,
  );

  test(
    "each page is served UNGATED as an image — which is why a deck caches offline for free",
    async () => {
      const res = await fetch(`${BASE}/media/${deckMediaId}/page/1`);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("image/png");
      expect(res.headers.get("access-control-allow-origin")).toBe("*");
      const bytes = new Uint8Array(await res.arrayBuffer());
      expect(bytes.length).toBeGreaterThan(100);

      const missing = await fetch(`${BASE}/media/${deckMediaId}/page/9`);
      expect(missing.status).toBe(404);
      await missing.body?.cancel();
    },
    TEST_TIMEOUT,
  );

  test(
    "assigning the deck sends the player a PLAYLIST of images — no document reaches the glass",
    async () => {
      const res = await fetch(`${BASE}/api/v1/screens/${screenId}/content`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sourceId: deckSource.id }),
      });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const render = await player.waitFor(
        (m) =>
          m.t === "server/render" &&
          Array.isArray(m.slice?.surfaces) &&
          m.slice.surfaces.some((s: Frame) => s.type === "playlist"),
        "deck render",
      );
      const surface = render.slice.surfaces.find((s: Frame) => s.type === "playlist");
      expect(surface.items).toHaveLength(2);
      expect(surface.items.map((i: Frame) => i.kind)).toEqual(["image", "image"]);
      expect(surface.items[0].url).toBe(`${BASE}/media/${deckMediaId}/page/1`);
      // Every page is TIMED, so the rotation is clock-derivable and a video wall stays in phase.
      expect(surface.items.every((i: Frame) => i.durationSeconds === 10)).toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "changing the per-page dwell re-times the rotation on the wall, instantly",
    async () => {
      const res = await fetch(`${BASE}/api/v1/content-sources/${deckSource.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dwellSeconds: 30 }),
      });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const render = await player.waitFor(
        (m) =>
          m.t === "server/render" &&
          m.slice?.surfaces?.some(
            (s: Frame) => s.type === "playlist" && s.items?.[0]?.durationSeconds === 30,
          ),
        "re-timed deck render",
      );
      const surface = render.slice.surfaces.find((s: Frame) => s.type === "playlist");
      expect(surface.items.every((i: Frame) => i.durationSeconds === 30)).toBe(true);

      const state = await snapshot(WS, "admin/state after the dwell change");
      const source = (state.contentSources as Frame[]).find((s) => s.id === deckSource.id);
      expect(source.deck.dwellSeconds).toBe(30);
    },
    TEST_TIMEOUT,
  );

  test(
    "a format this server cannot convert FAILS the job by name — and never reaches the library",
    async () => {
      const res = await upload(BASE, "deck.pdf", PPTX_MIME, "Quarterly Review");
      expect(res.status).toBe(202); // it is accepted for conversion — the failure is discovered there
      const body = (await res.json()) as Frame;

      const job = await awaitJob(body.job.id);
      expect(job.status).toBe("failed");
      expect(String(job.error)).toContain("PowerPoint");
      expect(String(job.error)).toContain("PDF");

      const state = await snapshot(WS, "admin/state after the failed conversion");
      const landed = (state.contentSources as Frame[]).some((s) => s.name === "Quarterly Review");
      expect(landed).toBe(false);
    },
    TEST_TIMEOUT,
  );

  test(
    "deleting the deck clears the wall and unlinks its pages",
    async () => {
      const res = await fetch(`${BASE}/api/v1/content-sources/${deckSource.id}`, { method: "DELETE" });
      expect(res.status).toBe(200);
      await res.body?.cancel();

      const page = await fetch(`${BASE}/media/${deckMediaId}/page/1`);
      expect(page.status).toBe(404);
      await page.body?.cancel();
    },
    TEST_TIMEOUT,
  );
});
