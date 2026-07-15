/**
 * POL-109 — the media INGEST pipeline: probe → validate → poster.
 *
 * Two halves, both load-bearing:
 *
 *  1. THE POLICY (pure, always runs). `assessPlayability` is the actual product decision — what a wall
 *     browser can and cannot decode — so it is pinned on facts, with no toolchain and no filesystem.
 *
 *  2. THE REAL PROBE (skipped only where no toolchain exists). Mocks would happily "prove" that we
 *     reject AVI while the parser silently mis-reads every real file. So we probe REAL fixture files —
 *     committed, tiny (< 12 KB), generated once: an H.264/AAC MP4 that a wall CAN play, an MPEG-4-Part-2
 *     AVI that it CANNOT (the exact file this ticket exists for), and a PNG. The assertions are on what
 *     the pipeline concludes about the real bytes: duration, dimensions, codec, poster frame written,
 *     AVI rejected with a message that names it.
 *
 * The no-toolchain path (a dev laptop, a minimal container) is covered WITHOUT skipping, via the null
 * prober: the upload is still accepted, `probed` is false, the operator is warned, and an image still
 * gets a picture in the library. That is D129, and CI must keep it true whether or not a runner happens
 * to ship a media toolchain.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createReadStream } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ExternalToolMediaProber,
  NullMediaProber,
  assessPlayability,
  createMediaProber,
} from "../src/media-probe";
import { MediaStore, ingestUpload, kindForMime, mediaIdFromUrl } from "../src/media";

import type { ProbeResult } from "../src/media-probe";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures");
const PLAYABLE_MP4 = join(FIXTURES, "playable.mp4"); // H.264 + AAC, 160×120, ~2 s
const HOSTILE_AVI = join(FIXTURES, "hostile.avi"); // MPEG-4 Part 2 in AVI — plays in VLC, black on a wall
const PHOTO_PNG = join(FIXTURES, "photo.png"); // 64×64

const PUBLIC_BASE = "http://control-plane.test:8080";

// ─────────────────────────────────────────────────────────────────────────────
// 1. The policy — pure, no toolchain, no disk.
// ─────────────────────────────────────────────────────────────────────────────

const probe = (over: Partial<ProbeResult> = {}): ProbeResult => ({
  hasVideoStream: true,
  container: "mov,mp4,m4a,3gp,3g2,mj2",
  videoCodec: "h264",
  audioCodec: "aac",
  ...over,
});

describe("POL-109 playability policy", () => {
  test("an H.264/AAC MP4 is playable", () => {
    expect(assessPlayability(probe())).toEqual({ ok: true });
  });

  test("a VP9/Opus WebM is playable", () => {
    const verdict = assessPlayability(
      probe({ container: "matroska,webm", videoCodec: "vp9", audioCodec: "opus" }),
    );
    expect(verdict.ok).toBe(true);
  });

  test("an AVI is refused, and the message names the container and the fix", () => {
    const verdict = assessPlayability(probe({ container: "avi", videoCodec: "mpeg4" }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("codec");
    expect(verdict.message).toContain("AVI");
    expect(verdict.message).toContain("MP4");
  });

  test("a hostile VIDEO codec in a fine container is refused, and named", () => {
    const verdict = assessPlayability(probe({ videoCodec: "wmv3" }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("codec");
    expect(verdict.message).toContain("Windows Media Video 9");
  });

  test("a hostile AUDIO codec is refused — an undecodable track can fail the whole element", () => {
    const verdict = assessPlayability(probe({ audioCodec: "ac3" }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.message).toContain("Dolby Digital");
    expect(verdict.message).toContain("AAC");
  });

  test("a file with no video stream at all is 'undecodable', not 'codec'", () => {
    const verdict = assessPlayability(probe({ hasVideoStream: false }));
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("undecodable");
  });

  test("an UNKNOWN (not blacklisted) codec is accepted with a warning — we refuse on evidence only", () => {
    const verdict = assessPlayability(probe({ videoCodec: undefined, audioCodec: undefined }));
    expect(verdict.ok).toBe(true);
    if (!verdict.ok) throw new Error("unreachable");
    expect(verdict.warning).toBeDefined();
  });

  test("MEDIA_PROBE=off yields the null prober — probing is switchable off, never mandatory", async () => {
    const prober = createMediaProber({ MEDIA_PROBE: "off" });
    expect(await prober.available()).toBe(false);
  });

  test("a prober pointed at a binary that does not exist reports itself unavailable (never throws)", async () => {
    const prober = createMediaProber({
      MEDIA_PROBE_CMD: "polyptic-no-such-probe-binary",
      MEDIA_FRAME_CMD: "polyptic-no-such-frame-binary",
    });
    expect(await prober.available()).toBe(false);
  });

  test("mediaIdFromUrl finds our own upload ids, and only ours", () => {
    expect(mediaIdFromUrl(`${PUBLIC_BASE}/media/deadbeefcafe1234`)).toBe("deadbeefcafe1234");
    expect(mediaIdFromUrl(`${PUBLIC_BASE}/media/deadbeefcafe1234/poster`)).toBe("deadbeefcafe1234");
    expect(mediaIdFromUrl("https://example.com/pictures/cat.png")).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. Ingest with NO toolchain (D129) — always runs, and CI must keep it green.
// ─────────────────────────────────────────────────────────────────────────────

let dir = "";
let store: MediaStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "polyptic-ingest-"));
  store = new MediaStore(dir);
  await store.init();
});

afterAll(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Save a fixture through the real MediaStore (streamed to disk, exactly like an upload). */
async function save(path: string, mime: string, name: string) {
  return store.save(createReadStream(path), mime, name, 50 * 1024 * 1024);
}

describe("POL-109 ingest degrades when no probing toolchain exists (D129)", () => {
  test("an unprobeable VIDEO is ACCEPTED, flagged unprobed, and the operator is told why", async () => {
    const record = await save(PLAYABLE_MP4, "video/mp4", "clip.mp4");
    const result = await ingestUpload(new NullMediaProber(), store, record, PUBLIC_BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.metadata.probed).toBe(false);
    expect(result.metadata.durationSeconds).toBeUndefined();
    expect(result.metadata.warning).toContain("no media toolchain");
    // No poster to serve — every consumer treats it as optional.
    expect(result.metadata.posterUrl).toBeUndefined();
  });

  test("an unprobeable IMAGE still gets a picture in the library: itself", async () => {
    const record = await save(PHOTO_PNG, "image/png", "photo.png");
    const result = await ingestUpload(new NullMediaProber(), store, record, PUBLIC_BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.metadata.probed).toBe(false);
    expect(result.metadata.posterUrl).toBe(`${PUBLIC_BASE}/media/${record.id}`);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Ingest with a REAL toolchain, over REAL files.
// ─────────────────────────────────────────────────────────────────────────────

const realProber = new ExternalToolMediaProber("ffprobe", "ffmpeg");
const toolchain = await realProber.available();

describe.if(toolchain)("POL-109 ingest probes real files", () => {
  test("a real H.264 MP4: duration, dimensions and codecs come off the actual bytes", async () => {
    const result = await realProber.probe(PLAYABLE_MP4);
    expect(result).not.toBeNull();
    expect(result!.hasVideoStream).toBe(true);
    expect(result!.videoCodec).toBe("h264");
    expect(result!.audioCodec).toBe("aac");
    expect(result!.width).toBe(160);
    expect(result!.height).toBe(120);
    expect(result!.durationSeconds).toBeGreaterThan(1.5);
    expect(result!.durationSeconds).toBeLessThan(3);
    expect(assessPlayability(result!).ok).toBe(true);
  });

  test("a real AVI (MPEG-4 Part 2): the file this ticket exists for is REFUSED, by name", async () => {
    const result = await realProber.probe(HOSTILE_AVI);
    expect(result).not.toBeNull();
    expect(result!.container).toContain("avi");
    expect(result!.videoCodec).toBe("mpeg4");

    const verdict = assessPlayability(result!);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error("unreachable");
    expect(verdict.reason).toBe("codec");
    expect(verdict.message).toContain("AVI");
  });

  test("ingesting the MP4 records the metadata and WRITES a real poster frame", async () => {
    const record = await save(PLAYABLE_MP4, "video/mp4", "clip.mp4");
    const result = await ingestUpload(realProber, store, record, PUBLIC_BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");

    expect(result.metadata.probed).toBe(true);
    expect(result.metadata.videoCodec).toBe("h264");
    expect(result.metadata.width).toBe(160);
    expect(result.metadata.height).toBe(120);
    expect(result.metadata.durationSeconds).toBeGreaterThan(1.5);
    expect(result.metadata.posterUrl).toBe(`${PUBLIC_BASE}/media/${record.id}/poster`);

    // The poster is a real file on disk with real bytes in it (a JPEG, not an empty placeholder).
    const posterPath = store.posterPathFor(record.id);
    expect(posterPath).toBeDefined();
    const st = await stat(posterPath!);
    expect(st.size).toBeGreaterThan(200);

    // …and the catalogue can answer "what do you know about this url?" — the seam the control plane
    // reads to decorate a ContentSource and to give a video surface its poster.
    const viaUrl = store.metadataForUrl(`${PUBLIC_BASE}/media/${record.id}`);
    expect(viaUrl?.durationSeconds).toBe(result.metadata.durationSeconds);
  });

  test("ingesting the AVI REJECTS it and unlinks nothing that the library can see", async () => {
    const record = await save(HOSTILE_AVI, "video/x-msvideo", "old-clip.avi");
    expect(kindForMime("video/x-msvideo")).toBe("video");

    const result = await ingestUpload(realProber, store, record, PUBLIC_BASE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toBe("codec");
    expect(result.message).toContain("AVI");
    // The upload route unlinks a rejected file; prove the store can, and that the id then 404s.
    expect(await store.deleteById(record.id)).toBe(true);
    expect(store.pathFor(record.id)).toBeUndefined();
  });

  test("ingesting an IMAGE writes a downscaled library thumbnail and reads its dimensions", async () => {
    const record = await save(PHOTO_PNG, "image/png", "photo.png");
    const result = await ingestUpload(realProber, store, record, PUBLIC_BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.metadata.probed).toBe(true);
    expect(result.metadata.width).toBe(64);
    expect(result.metadata.height).toBe(64);
    expect(result.metadata.posterUrl).toBe(`${PUBLIC_BASE}/media/${record.id}/poster`);
    const posterPath = store.posterPathFor(record.id);
    expect(posterPath?.endsWith(".thumb.png")).toBe(true);
    const st = await stat(posterPath!);
    expect(st.size).toBeGreaterThan(50);
  });

  test("the ingest survives a restart: the sidecar carries the metadata back", async () => {
    const record = await save(PLAYABLE_MP4, "video/mp4", "clip.mp4");
    await ingestUpload(realProber, store, record, PUBLIC_BASE);

    const reopened = new MediaStore(dir);
    await reopened.init();
    const back = reopened.get(record.id);
    expect(back?.metadata?.probed).toBe(true);
    expect(back?.metadata?.videoCodec).toBe("h264");
    expect(reopened.posterPathFor(record.id)).toBeDefined();
  });
});
