/**
 * POL-114 — DOCUMENT PIPELINE: the core half (no vendor lives here — see `document-convert.ts`).
 *
 * Two things:
 *
 * 1. `DocumentJobs` — conversion is SLOW. A 60-slide deck is an office process, a rasterizer and
 *    tens of seconds; holding an HTTP request open for it means meeting a reverse proxy's read
 *    timeout (nginx's default is 60 s) and answering an operator's "is it working?" with nothing.
 *    So the upload route answers **202 + a job**, and the job's progress is pushed on the `admin/state`
 *    broadcast the console is ALREADY listening to (D115). No new WS channel, no polling, no job
 *    table: pages appear as they land. Jobs are in-memory and bounded — they describe an upload in
 *    flight, not a fact about the world; a server restart mid-conversion loses the job, and the
 *    half-converted file with it (the deck never existed, so nothing dangles in the library).
 *
 * 2. `ingestDocument` — the pipeline that runs a saved document upload through the converter and,
 *    only if pages actually landed, turns it into a `deck` record in the media catalogue. It is the
 *    exact sibling of POL-109's `ingestUpload`: same seam (an adapter that may be unavailable), same
 *    place in the flow (between "the bytes are on disk" and "it is a ContentSource"), same rule that a
 *    file which cannot be shown never reaches the library.
 */
import { randomBytes } from "node:crypto";

import type { DocumentJob } from "@polyptic/protocol";
import type { DocumentConverter } from "./document-convert";
import type { MediaRecord, MediaStore } from "./media";

import { MAX_PAGES, PAGE_WIDTH, documentFormatLabel } from "./document-convert";

/** How long each page of a freshly converted deck holds the screen, until an operator says otherwise.
 *  Long enough to read a slide, short enough that a 20-page deck is a 3-minute loop. */
export const DEFAULT_DWELL_SECONDS = 10;

/** Terminal jobs are kept so the console can show "done"/"failed" after the fact; the list is bounded
 *  because it is a progress feed, not a history. */
const MAX_JOBS = 20;

/**
 * The in-memory registry of document conversions. Every mutation calls `onChange`, which the server
 * wires to the admin broadcaster — that is the whole progress channel.
 */
export class DocumentJobs {
  private readonly jobs = new Map<string, DocumentJob>();

  constructor(private readonly onChange: () => void = () => {}) {}

  /** Open a job for a document that is about to be converted. */
  start(name: string): DocumentJob {
    const now = new Date().toISOString();
    const job: DocumentJob = {
      id: randomBytes(8).toString("hex"),
      name: name.slice(0, 120),
      status: "converting",
      pagesDone: 0,
      startedAt: now,
      updatedAt: now,
    };
    this.jobs.set(job.id, job);
    this.trim();
    this.onChange();
    return job;
  }

  /** Merge a patch into a job (no-op for an unknown/evicted id) and push the new state. */
  update(id: string, patch: Partial<Omit<DocumentJob, "id" | "startedAt">>): void {
    const job = this.jobs.get(id);
    if (!job) return;
    this.jobs.set(id, { ...job, ...patch, updatedAt: new Date().toISOString() });
    this.onChange();
  }

  get(id: string): DocumentJob | undefined {
    return this.jobs.get(id);
  }

  /** Newest first — what `admin/state.documentJobs` carries. */
  list(): DocumentJob[] {
    return [...this.jobs.values()].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  /** Evict the oldest TERMINAL jobs once the feed is over its cap (never an in-flight one). */
  private trim(): void {
    if (this.jobs.size <= MAX_JOBS) return;
    const terminal = [...this.jobs.values()]
      .filter((j) => j.status === "ready" || j.status === "failed")
      .sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    for (const job of terminal) {
      if (this.jobs.size <= MAX_JOBS) break;
      this.jobs.delete(job.id);
    }
  }
}

/** The pipeline's verdict for one document upload. */
export type DocumentIngestResult =
  | { ok: true; pageCount: number }
  | { ok: false; message: string };

/**
 * Convert a saved document upload into a page-image deck, recorded against its media record.
 *
 * The pages land in MEDIA_DIR beside the document itself (`<id>.page-<n>.png`), so they are served by
 * the media route the player and its OFFLINE CACHE already use — a deck is offline-capable for free.
 * Page 1 doubles as the media record's poster, so the library tile of a deck is its first slide.
 *
 * Failure is total: no pages, no deck, and the caller unlinks the upload. A `deck` source with no
 * pages would be a library row that provably cannot paint, which is the bug this pipeline exists to
 * prevent — not one it may introduce.
 */
export async function ingestDocument(
  converter: DocumentConverter,
  media: MediaStore,
  record: MediaRecord,
  publicBase: string,
  opts: { dwellSeconds?: number; onProgress?: (pagesDone: number) => void } = {},
): Promise<DocumentIngestResult> {
  const path = media.pathFor(record.id);
  if (!path) return { ok: false, message: "The uploaded document could not be read back." };

  const result = await converter.convert({
    input: path,
    outDir: media.directory,
    basename: media.deckBasename(record.id),
    maxPages: MAX_PAGES,
    width: PAGE_WIDTH,
    ...(opts.onProgress ? { onPage: opts.onProgress } : {}),
  });

  if (!result.ok) return { ok: false, message: result.message };
  if (result.pages.length === 0) {
    return { ok: false, message: "This document produced no pages — nothing could be shown on a wall." };
  }

  const format = record.filename.split(".").pop() ?? "";
  const pageUrls = result.pages.map((_, i) => `${publicBase}/media/${record.id}/page/${i + 1}`);
  await media.setDeck(record.id, {
    pages: result.pages,
    pageUrls,
    dwellSeconds: opts.dwellSeconds ?? DEFAULT_DWELL_SECONDS,
    format,
  });

  return { ok: true, pageCount: result.pages.length };
}

/** The library name a converted document takes when the operator supplied none — the filename, with
 *  the format spelled out so a deck reads as a deck in the library. */
export function deckDisplayName(originalName: string, format: string): string {
  const stem = originalName.replace(/\.[^.]+$/, "").trim();
  const base = stem.length > 0 ? stem : documentFormatLabel(format);
  return base.slice(0, 120);
}
