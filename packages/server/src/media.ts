/**
 * Phase 7 — MEDIA. Uploaded images/videos live on a disk VOLUME (MEDIA_DIR) and are served over plain
 * HTTP (GET /media/:id) so any wall player — on another host, with no session — can fetch them, exactly
 * like an external content URL. An upload becomes a Phase-3c `ContentSource` (kind image|video) whose
 * `url` is an ABSOLUTE link back to the serve route, so it slots straight into the 3c assignment plumbing.
 *
 * PERSISTENCE: a JSON sidecar (`index.json`) inside MEDIA_DIR maps each generated id → its record
 * ({filename, mime, size, sourceId, originalName}). Chosen over a DB table so the media catalogue travels
 * WITH the volume (move the volume, keep the catalogue) and the Store interface stays untouched. Writes
 * are atomic (temp file + rename) and serialized through a promise chain.
 *
 * SAFETY: the client filename is NEVER used for the on-disk path — we generate a random unguessable id
 * and derive the extension from the VALIDATED mime; the :id only ever indexes the sidecar, and the
 * resolved absolute path is asserted to stay INSIDE MEDIA_DIR (no traversal). Uploads stream to disk and
 * are served by streaming a (possibly ranged) read — large videos are never buffered whole in memory.
 */
import { randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";

import { MediaMetadata as MediaMetadataSchema } from "@polyptic/protocol";

import { documentExtForMime } from "./document-convert";
import { POSTER_WIDTH, THUMBNAIL_WIDTH, assessPlayability } from "./media-probe";

import type { ContentKind, Deck, MediaMetadata, MediaRejectionReason } from "@polyptic/protocol";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";
import type { MediaProber } from "./media-probe";

// ─────────────────────────────────────────────────────────────────────────────
// Mime → extension + kind. We accept ANY image/* or video/*; the table gives a friendly extension for
// the common types and we fall back to a sanitized subtype otherwise (the ext is cosmetic — the mime
// stored in the sidecar is the source of truth served back as Content-Type).
// ─────────────────────────────────────────────────────────────────────────────

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/x-icon": "ico",
  "video/mp4": "mp4",
  "video/webm": "webm",
  "video/ogg": "ogv",
  "video/quicktime": "mov",
  "video/x-matroska": "mkv",
  "video/mpeg": "mpeg",
  "video/x-msvideo": "avi",
  "video/3gpp": "3gp",
};

/** The content-library kind for an upload's mime, or null when it is neither image/* nor video/*. */
export function kindForMime(mime: string): ContentKind | null {
  const m = mime.toLowerCase();
  if (m.startsWith("image/")) return "image";
  if (m.startsWith("video/")) return "video";
  return null;
}

/** A safe file extension for a validated mime (table first, then a sanitized subtype, then "bin").
 *  POL-114 — document mimes come from the pipeline's own table (an Office mime's subtype is a 60-char
 *  monster; "pptx" is what the converter and the operator both call it). */
function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  const known = MIME_EXT[m] ?? documentExtForMime(m);
  if (known) return known;
  const subtype = m.split("/")[1] ?? "bin";
  const cleaned = subtype.replace(/[^a-z0-9]+/g, "").slice(0, 12);
  return cleaned.length > 0 ? cleaned : "bin";
}

/** True if an error is @fastify/multipart's "file exceeds the configured size limit" signal. */
export function isFileTooLargeError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const code = (err as { code?: unknown }).code;
  return code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT";
}

/** Thrown by `MediaStore.save` when the streamed upload exceeds the configured byte cap. */
export class MediaTooLargeError extends Error {
  constructor() {
    super("uploaded file exceeds the size limit");
    this.name = "MediaTooLargeError";
  }
}

/** Read a simple text field's value from @fastify/multipart's parsed `fields` bag. */
export function readField(fields: unknown, key: string): string | undefined {
  if (typeof fields !== "object" || fields === null) return undefined;
  const entry = (fields as Record<string, unknown>)[key];
  const pick = Array.isArray(entry) ? entry[0] : entry;
  if (pick && typeof pick === "object" && "value" in pick) {
    const v = (pick as { value?: unknown }).value;
    if (typeof v === "string") return v;
  }
  return undefined;
}

// ─────────────────────────────────────────────────────────────────────────────
// The sidecar record + store
// ─────────────────────────────────────────────────────────────────────────────

/** One uploaded file's metadata. `filename` is `<id>.<ext>`, relative to MEDIA_DIR. */
export interface MediaRecord {
  id: string;
  filename: string;
  mime: string;
  size: number;
  originalName: string;
  /** The ContentSource this upload backs, once created (null between save and attach). */
  sourceId: string | null;
  /** POL-109 — what ingest probed (absent on records written before the pipeline existed, and on a
   *  server with no prober; consumers always treat it as optional). */
  metadata?: MediaMetadata;
  /** POL-109 — the generated poster/thumbnail, relative to MEDIA_DIR (`<id>.poster.jpg` / `.thumb.png`). */
  poster?: string;
  /** POL-114 — a DOCUMENT upload that was converted to page images. `pages` are filenames relative to
   *  MEDIA_DIR, in page order; `pageUrls` their absolute serve URLs; `dwellSeconds` the one authored
   *  field of a deck (how long each page holds the screen). Lives in the catalogue, not the DB — the
   *  pages travel with the media volume, and no migration is needed for a new content kind. */
  deck?: DeckRecord;
}

/** POL-114 — the deck half of a media record (see `MediaRecord.deck`). */
export interface DeckRecord {
  pages: string[];
  pageUrls: string[];
  dwellSeconds: number;
  /** The uploaded document's format, e.g. "pdf" / "pptx" — for the library row. */
  format: string;
}

interface SidecarShape {
  version: number;
  records: Record<string, MediaRecord>;
}

/** Is this sidecar fragment a well-formed deck? (A hand-edited index must not inject a bad shape.) */
function isDeckRecord(value: unknown): value is DeckRecord {
  if (typeof value !== "object" || value === null) return false;
  const d = value as Partial<DeckRecord>;
  return (
    Array.isArray(d.pages) &&
    d.pages.every((p) => typeof p === "string") &&
    Array.isArray(d.pageUrls) &&
    d.pageUrls.every((u) => typeof u === "string") &&
    typeof d.dwellSeconds === "number" &&
    d.dwellSeconds > 0 &&
    typeof d.format === "string"
  );
}

/**
 * A disk-backed catalogue of uploaded media over MEDIA_DIR. Ensures the directory, saves streamed
 * uploads, serves them (with traversal-safe path resolution), and unlinks them on lifecycle delete.
 */
export class MediaStore {
  private readonly records = new Map<string, MediaRecord>();
  /** Serializes sidecar writes so concurrent uploads/deletes never interleave a half-written index. */
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly dir: string) {}

  /** The configured media directory (absolute or cwd-relative as provided). */
  get directory(): string {
    return this.dir;
  }

  private indexPath(): string {
    return join(this.dir, "index.json");
  }

  /** Ensure the directory exists and load any existing sidecar. Call once on boot. */
  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    try {
      const raw = await readFile(this.indexPath(), "utf8");
      const parsed = JSON.parse(raw) as Partial<SidecarShape>;
      if (parsed && parsed.records && typeof parsed.records === "object") {
        for (const [id, rec] of Object.entries(parsed.records)) {
          if (rec && typeof rec.filename === "string" && typeof rec.mime === "string") {
            // POL-109 — the ingest half is parsed through the contract: a sidecar written by an older
            // build simply has none of it, and a hand-edited one can't inject a bad shape.
            const metadata = MediaMetadataSchema.safeParse(rec.metadata);
            this.records.set(id, {
              id,
              filename: rec.filename,
              mime: rec.mime,
              size: typeof rec.size === "number" ? rec.size : 0,
              originalName: typeof rec.originalName === "string" ? rec.originalName : id,
              sourceId: typeof rec.sourceId === "string" ? rec.sourceId : null,
              ...(metadata.success ? { metadata: metadata.data } : {}),
              ...(typeof rec.poster === "string" ? { poster: rec.poster } : {}),
              // POL-114 — a deck's pages (a sidecar from before the pipeline simply has none).
              ...(isDeckRecord(rec.deck) ? { deck: rec.deck } : {}),
            });
          }
        }
      }
    } catch {
      // No sidecar yet (fresh dir) or it was unreadable — start with an empty catalogue.
    }
  }

  /** Atomically persist the sidecar (temp file + rename), serialized through the write chain. */
  private persist(): Promise<void> {
    const snapshot: SidecarShape = { version: 1, records: Object.fromEntries(this.records) };
    const body = JSON.stringify(snapshot, null, 2);
    const target = this.indexPath();
    const tmp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
    this.writeChain = this.writeChain.then(async () => {
      await writeFile(tmp, body, "utf8");
      await rename(tmp, target);
    });
    return this.writeChain;
  }

  /** Resolve a stored filename to an absolute path, asserting it stays INSIDE MEDIA_DIR. */
  private safeJoin(filename: string): string {
    const root = resolve(this.dir);
    const abs = resolve(this.dir, filename);
    if (abs !== root && !abs.startsWith(root + sep)) {
      throw new Error(`path escapes MEDIA_DIR: ${filename}`);
    }
    return abs;
  }

  /** The record for a media id, if known. */
  get(id: string): MediaRecord | undefined {
    return this.records.get(id);
  }

  /** Absolute, traversal-safe path for a media id, or undefined if unknown. */
  pathFor(id: string): string | undefined {
    const rec = this.records.get(id);
    if (!rec) return undefined;
    return this.safeJoin(rec.filename);
  }

  /**
   * Stream an upload to `<id>.<ext>` under MEDIA_DIR, enforcing the byte cap, and record it. The caller
   * must have validated the mime first (image/* or video/*). Throws `MediaTooLargeError` if the stream
   * exceeds `maxBytes` (the partial file is unlinked). Returns the record (sourceId still null).
   */
  async save(
    stream: Readable,
    mime: string,
    originalName: string,
    maxBytes: number,
  ): Promise<MediaRecord> {
    const id = randomBytes(16).toString("hex");
    const ext = extForMime(mime);
    const filename = `${id}.${ext}`;
    const abs = this.safeJoin(filename);

    let size = 0;
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });

    try {
      await pipeline(stream, createWriteStream(abs));
    } catch (err) {
      await rm(abs, { force: true });
      if (isFileTooLargeError(err)) throw new MediaTooLargeError();
      throw err;
    }

    // Belt-and-braces: even if the stream was truncated WITHOUT throwing, enforce the cap.
    const truncated = (stream as Readable & { truncated?: boolean }).truncated === true;
    if (truncated || (maxBytes > 0 && size > maxBytes)) {
      await rm(abs, { force: true });
      throw new MediaTooLargeError();
    }

    const record: MediaRecord = { id, filename, mime, size, originalName, sourceId: null };
    this.records.set(id, record);
    await this.persist();
    return record;
  }

  /** Record which ContentSource an upload now backs (so a source delete can unlink the file). */
  async attachSource(id: string, sourceId: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.sourceId = sourceId;
    await this.persist();
  }

  /** POL-109 — record what ingest learned (and the still it generated) against an upload. */
  async setIngest(id: string, metadata: MediaMetadata, posterFilename?: string): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.metadata = metadata;
    if (posterFilename) rec.poster = posterFilename;
    else delete rec.poster;
    await this.persist();
  }

  /** POL-109 — where ingest should WRITE a still (absolute, traversal-safe). The name is generated
   *  from the media id, never from anything the client sent. */
  posterTargetPath(filename: string): string {
    return this.safeJoin(filename);
  }

  /** POL-109 — absolute, traversal-safe path of an upload's poster/thumbnail, if one was generated. */
  posterPathFor(id: string): string | undefined {
    const rec = this.records.get(id);
    if (!rec?.poster) return undefined;
    return this.safeJoin(rec.poster);
  }

  /**
   * POL-109 — the probed metadata behind a content URL, if that URL is one of OUR uploads. This is the
   * seam the control plane reads at send/read time to decorate a ContentSource (`media`) and to hand
   * the player a video's poster: the catalogue stays the single source of truth and the DB schema is
   * untouched. A foreign URL (a linked image on someone else's server) returns undefined — we never
   * probed it, so we claim nothing about it.
   */
  metadataForUrl(url: string): MediaMetadata | undefined {
    const id = mediaIdFromUrl(url);
    if (!id) return undefined;
    return this.records.get(id)?.metadata;
  }

  // ── POL-114 — decks ────────────────────────────────────────────────────────

  /** The file-name stem the converter writes a document's page images under (`<id>.page-<n>.png`).
   *  Derived from the generated media id, NEVER from anything the client sent. */
  deckBasename(id: string): string {
    return `${id}.page`;
  }

  /** Record a converted document's pages (and make page 1 the record's poster: a deck's library tile
   *  is its first slide, served by the poster route POL-109 already registered). */
  async setDeck(id: string, deck: DeckRecord): Promise<void> {
    const rec = this.records.get(id);
    if (!rec) return;
    rec.deck = deck;
    const first = deck.pages[0];
    if (first) rec.poster = first;
    await this.persist();
  }

  /** Change a deck's per-page dwell (the ONE authored field of a deck). False for a non-deck id. */
  async setDeckDwell(id: string, dwellSeconds: number): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec?.deck) return false;
    rec.deck = { ...rec.deck, dwellSeconds };
    await this.persist();
    return true;
  }

  /** Absolute, traversal-safe path of a deck's page image (1-based), or undefined. */
  pagePathFor(id: string, page: number): string | undefined {
    const rec = this.records.get(id);
    const name = rec?.deck?.pages[page - 1];
    if (!name) return undefined;
    return this.safeJoin(name);
  }

  /** The deck behind a content URL, if that URL is one of OUR document uploads — the read seam the
   *  control plane uses to decorate a `deck` source and to resolve it to an image rotation. */
  deckForUrl(url: string): Deck | undefined {
    const id = mediaIdFromUrl(url);
    const rec = id ? this.records.get(id) : undefined;
    if (!rec?.deck) return undefined;
    const { pages, pageUrls, dwellSeconds, format } = rec.deck;
    const poster = pageUrls[0];
    return {
      pageCount: pages.length,
      pageUrls,
      dwellSeconds,
      ...(poster ? { posterUrl: poster } : {}),
      ...(format ? { format } : {}),
    };
  }

  /** Unlink an upload (file + poster + deck pages + sidecar record) by media id. */
  async deleteById(id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.records.delete(id);
    await this.persist();
    for (const name of [rec.filename, rec.poster, ...(rec.deck?.pages ?? [])]) {
      if (!name) continue;
      try {
        await rm(this.safeJoin(name), { force: true });
      } catch {
        // Best-effort unlink — the record is already gone from the catalogue.
      }
    }
    return true;
  }

  /** Unlink the upload backing a ContentSource, if any. Returns true if one was removed. */
  async deleteBySourceId(sourceId: string): Promise<boolean> {
    for (const rec of this.records.values()) {
      if (rec.sourceId === sourceId) return this.deleteById(rec.id);
    }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POL-109 — the INGEST pipeline. Runs between "the bytes are on disk" and "it is a ContentSource":
// probe → validate → still. Its verdict decides whether the upload becomes a library source at all.
// ─────────────────────────────────────────────────────────────────────────────

/** The media id inside one of our own serve URLs (`…/media/<id>` or `…/media/<id>/poster`), else null. */
export function mediaIdFromUrl(url: string): string | null {
  const m = /\/media\/([a-f0-9]{8,})(?:\/|$|\?)/i.exec(url);
  return m?.[1] ?? null;
}

/** The ingest verdict: a file becomes a source (with what we learned), or it never lands in the library. */
export type IngestResult =
  | { ok: true; metadata: MediaMetadata }
  | { ok: false; reason: MediaRejectionReason; message: string };

/** The sentence an operator sees when the server has no probing toolchain (D129 — accept, don't guess). */
const UNPROBED_WARNING =
  "This server has no media toolchain installed, so the file couldn't be checked — if a screen shows " +
  "it as black, the file's codec is the likely cause.";

/** How far into a video the poster frame is taken (early, but past the black/fade-in first frame). */
const POSTER_SEEK_SECONDS = 1;

/**
 * Ingest one saved upload. Returns the metadata to record (and, when it made one, the poster's
 * filename) — or a REJECTION, which the caller turns into a 415 and an unlink: a file we know the wall
 * cannot play must not reach the library, because the library is a promise that a source will show.
 *
 * Degradation is the whole game here (D129):
 *  · no prober on this host          → accept, `probed: false`, warning, no poster (images still get a
 *                                      picture: their own url).
 *  · prober present, file unreadable → for a VIDEO that is evidence of a broken file: reject. For an
 *                                      IMAGE it is not (SVG, exotic formats a decoder skips but a
 *                                      browser renders natively) — accept, and let the browser judge.
 *  · prober present, codec hostile   → reject with the codec named.
 */
export async function ingestUpload(
  prober: MediaProber,
  media: MediaStore,
  record: MediaRecord,
  publicBase: string,
): Promise<IngestResult> {
  const kind = kindForMime(record.mime);
  const ownUrl = `${publicBase}/media/${record.id}`;
  const posterUrl = `${publicBase}/media/${record.id}/poster`;
  const path = media.pathFor(record.id);

  if (kind === null || path === undefined) {
    // Unreachable (the route validated the mime and just saved the file) — but stay honest.
    return { ok: true, metadata: { probed: false, warning: UNPROBED_WARNING } };
  }

  if (!(await prober.available())) {
    const metadata: MediaMetadata = {
      probed: false,
      warning: UNPROBED_WARNING,
      // An image is its own thumbnail when we can't downscale one — the library is never empty.
      ...(kind === "image" ? { posterUrl: ownUrl } : {}),
    };
    // Recorded, not just returned: the catalogue is what the control plane reads to decorate the
    // source, so "we know nothing about this file" has to be a REMEMBERED fact, not a lost one.
    await media.setIngest(record.id, metadata);
    return { ok: true, metadata };
  }

  const probe = await prober.probe(path);

  if (kind === "video") {
    if (probe === null) {
      return {
        ok: false,
        reason: "undecodable",
        message:
          "This file couldn't be read as a video — it may be corrupt or not really a video file. " +
          "Re-export it as MP4 (H.264 + AAC) and upload it again.",
      };
    }
    const verdict = assessPlayability(probe);
    if (!verdict.ok) return { ok: false, reason: verdict.reason, message: verdict.message };

    const at = probe.durationSeconds !== undefined
      ? Math.min(POSTER_SEEK_SECONDS, probe.durationSeconds / 2)
      : POSTER_SEEK_SECONDS;
    const posterName = `${record.id}.poster.jpg`;
    const made = await prober.poster(path, media.posterTargetPath(posterName), {
      atSeconds: at,
      maxWidth: POSTER_WIDTH,
    });

    const metadata: MediaMetadata = {
      probed: true,
      ...(probe.durationSeconds !== undefined ? { durationSeconds: probe.durationSeconds } : {}),
      ...(probe.width !== undefined ? { width: probe.width } : {}),
      ...(probe.height !== undefined ? { height: probe.height } : {}),
      ...(probe.container !== undefined ? { container: probe.container } : {}),
      ...(probe.videoCodec !== undefined ? { videoCodec: probe.videoCodec } : {}),
      ...(probe.audioCodec !== undefined ? { audioCodec: probe.audioCodec } : {}),
      ...(made ? { posterUrl } : {}),
      ...(verdict.warning ? { warning: verdict.warning } : {}),
    };
    await media.setIngest(record.id, metadata, made ? posterName : undefined);
    return { ok: true, metadata };
  }

  // ── images ────────────────────────────────────────────────────────────────
  // An image is never rejected on codec grounds: the browser, not the decoder, is the judge (SVG is
  // the standing counter-example — no frame to extract, renders perfectly on a wall).
  const thumbName = `${record.id}.thumb.png`;
  const made =
    probe !== null &&
    (await prober.poster(path, media.posterTargetPath(thumbName), { maxWidth: THUMBNAIL_WIDTH }));

  const metadata: MediaMetadata = {
    probed: true,
    ...(probe?.width !== undefined ? { width: probe.width } : {}),
    ...(probe?.height !== undefined ? { height: probe.height } : {}),
    ...(probe?.container !== undefined ? { container: probe.container } : {}),
    // Fall back to the image itself so an image source ALWAYS has a picture in the library.
    posterUrl: made ? posterUrl : ownUrl,
  };
  await media.setIngest(record.id, metadata, made ? thumbName : undefined);
  return { ok: true, metadata };
}

// ─────────────────────────────────────────────────────────────────────────────
// Serve route — TOP-LEVEL, UNGATED (registered OUTSIDE the /api/v1 gate, like /healthz). Players + the
// public wall must load media WITHOUT a session, exactly like any external content URL (ids are
// unguessable). Full single-range HTTP support (206 + Content-Range) — REQUIRED for video seeking.
// ─────────────────────────────────────────────────────────────────────────────

type ParsedRange = { start: number; end: number } | "unsatisfiable" | null;

/** Parse a single byte-range request against a known size. Returns null for "no/!understood range". */
function parseRange(header: string, size: number): ParsedRange {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const startRaw = match[1] ?? "";
  const endRaw = match[2] ?? "";
  if (startRaw === "" && endRaw === "") return null;
  if (size <= 0) return "unsatisfiable";

  let start: number;
  let end: number;
  if (startRaw === "") {
    // Suffix range: the final N bytes.
    const n = Number(endRaw);
    if (!Number.isFinite(n) || n <= 0) return "unsatisfiable";
    start = Math.max(0, size - n);
    end = size - 1;
  } else {
    start = Number(startRaw);
    end = endRaw === "" ? size - 1 : Number(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    if (end > size - 1) end = size - 1;
  }
  if (start < 0 || start >= size || start > end) return "unsatisfiable";
  return { start, end };
}

/** Register GET /media/:id (+ POL-109's /media/:id/poster) — UNgated. Pass the SAME MediaStore
 *  instance used by the upload route. */
export function registerMediaServeRoute(fastify: FastifyInstance, media: MediaStore): void {
  // POL-109 — the ingest's poster frame / library thumbnail. Same posture as the media route itself:
  // ungated (a wall paints it with no session), immutable, hard-cached. 404 when ingest made none
  // (no toolchain, or a still it couldn't extract) — every consumer already treats it as optional.
  fastify.get("/media/:id/poster", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    if (!/^[a-f0-9]{8,}$/i.test(id)) return reply.code(404).send({ error: "unknown media" });

    const abs = media.posterPathFor(id);
    if (!abs) return reply.code(404).send({ error: "no poster for this media" });

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "no poster for this media" });
    }
    if (!st.isFile()) return reply.code(404).send({ error: "no poster for this media" });

    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type(abs.endsWith(".png") ? "image/png" : "image/jpeg");
    reply.header("Content-Length", String(st.size));
    return reply.send(createReadStream(abs));
  });

  // POL-114 — one page image of a converted document deck (1-based). Same posture as every other
  // media route: UNGATED (the wall paints it with no session), immutable, hard-cached, CORS-open so
  // the player's OFFLINE blob cache can fetch it. This is why a deck works offline for free — its
  // pages are just media URLs, cached exactly like any other image.
  fastify.get("/media/:id/page/:n", async (request, reply) => {
    const params = request.params as { id?: string; n?: string };
    const id = params.id ?? "";
    const page = Number(params.n);
    if (!/^[a-f0-9]{8,}$/i.test(id) || !Number.isInteger(page) || page < 1) {
      return reply.code(404).send({ error: "unknown page" });
    }

    const abs = media.pagePathFor(id, page);
    if (!abs) return reply.code(404).send({ error: "unknown page" });

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "unknown page" });
    }
    if (!st.isFile()) return reply.code(404).send({ error: "unknown page" });

    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type("image/png");
    reply.header("Content-Length", String(st.size));
    return reply.send(createReadStream(abs));
  });

  fastify.get("/media/:id", async (request, reply) => {
    const id = (request.params as { id?: string }).id ?? "";
    // ids are 32 hex chars (randomBytes(16)). Reject anything else up front — also blocks traversal.
    if (!/^[a-f0-9]{8,}$/i.test(id)) {
      return reply.code(404).send({ error: "unknown media" });
    }

    const rec = media.get(id);
    const abs = media.pathFor(id);
    if (!rec || !abs) {
      return reply.code(404).send({ error: "unknown media" });
    }

    let st;
    try {
      st = await stat(abs);
    } catch {
      return reply.code(404).send({ error: "unknown media" });
    }
    if (!st.isFile()) {
      return reply.code(404).send({ error: "unknown media" });
    }

    const total = st.size;
    reply.header("Accept-Ranges", "bytes");
    // Content is immutable (a stored upload never changes) and the id is unguessable → cache hard.
    reply.header("Cache-Control", "public, max-age=31536000, immutable");
    // POL-32 — the player's offline blob cache downloads media with fetch(), which (unlike an
    // <img>/<video> tag) is CORS-gated when the dev player (:5173) fetches the server (:8080).
    // This route is public by design (ids are unguessable, no session — see above), so allowing
    // any origin changes nothing about its security posture.
    reply.header("Access-Control-Allow-Origin", "*");
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type(rec.mime);

    const rangeHeader = request.headers.range;
    if (rangeHeader) {
      const parsed = parseRange(rangeHeader, total);
      if (parsed === "unsatisfiable") {
        reply.header("Content-Range", `bytes */${total}`);
        return reply.code(416).send();
      }
      if (parsed) {
        const { start, end } = parsed;
        reply.code(206);
        reply.header("Content-Range", `bytes ${start}-${end}/${total}`);
        reply.header("Content-Length", String(end - start + 1));
        return reply.send(createReadStream(abs, { start, end }));
      }
      // A malformed/unsupported Range header → fall through to a normal 200 full-body response.
    }

    reply.code(200);
    reply.header("Content-Length", String(total));
    return reply.send(createReadStream(abs));
  });
}
