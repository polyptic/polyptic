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

import type { ContentKind } from "@polyptic/protocol";
import type { FastifyInstance } from "fastify";
import type { Readable } from "node:stream";

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

/** A safe file extension for a validated mime (table first, then a sanitized subtype, then "bin"). */
function extForMime(mime: string): string {
  const m = mime.toLowerCase();
  const known = MIME_EXT[m];
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
}

interface SidecarShape {
  version: number;
  records: Record<string, MediaRecord>;
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
            this.records.set(id, {
              id,
              filename: rec.filename,
              mime: rec.mime,
              size: typeof rec.size === "number" ? rec.size : 0,
              originalName: typeof rec.originalName === "string" ? rec.originalName : id,
              sourceId: typeof rec.sourceId === "string" ? rec.sourceId : null,
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

  /** Unlink an upload (file + sidecar record) by media id. Returns true if it existed. */
  async deleteById(id: string): Promise<boolean> {
    const rec = this.records.get(id);
    if (!rec) return false;
    this.records.delete(id);
    await this.persist();
    try {
      await rm(this.safeJoin(rec.filename), { force: true });
    } catch {
      // Best-effort unlink — the record is already gone from the catalogue.
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

/** Register GET /media/:id (UNgated). Pass the SAME MediaStore instance used by the upload route. */
export function registerMediaServeRoute(fastify: FastifyInstance, media: MediaStore): void {
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
