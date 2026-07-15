/**
 * POL-114 — DOCUMENT PIPELINE: the conversion seam.
 *
 * Slides and PDFs are the content operators ask for first, and the wall must NEVER render them live:
 * a document viewer on a kiosk is a scrollbar, a toolbar, a font substitution and a "trial expired"
 * dialog away from a broken screen (docs/DESIGN.md commits to pre-conversion, and this is that).
 * An uploaded PDF/PPTX is converted ONCE, server-side, into a sequence of page IMAGES — and an image
 * rotation is something the wall already does perfectly (POL-34's playlist surface, the offline media
 * cache, video-wall spanning, the <150 ms diff path). Nothing new reaches the player.
 *
 * THE SEAM (CLAUDE.md non-negotiables 5/6 — "no vendor names in core code paths", "buy the substrate,
 * build the brain"). Core (`documents.ts`, `media.ts`, `rest.ts`, `state.ts`) knows only a
 * `DocumentConverter`: it may be UNAVAILABLE, and when available it turns a file into N page PNGs in a
 * directory. The one implementation that shells out to an external office/raster toolchain lives HERE
 * and nowhere else — exactly like `MediaProber` (POL-109), `DisplayBackend` (sway/i3) and
 * `ContentSource`. A hosted conversion service, or an in-process renderer, drops in by implementing
 * two methods. Every binary is configurable (`DOC_OFFICE_CMD`, `DOC_RASTER_CMD`) so an operator can
 * point us at their own build without touching code, and `DOC_CONVERT=off` is the kill switch.
 *
 * REFUSE, DON'T PRETEND (D132). POL-109's prober ACCEPTS an unprobeable upload, because a file it
 * could not inspect is still a file the browser can probably render — silence is not evidence of
 * guilt. A converter is the opposite case: conversion is not an inspection, it is the CONTENT. With no
 * converter there are no page images, and a "deck" with no pages is a library row that provably cannot
 * paint — the exact black-screen class of bug POL-109 exists to kill. So a server with no converter
 * REFUSES a document upload, says why in one sentence, and advertises `capabilities.documents = false`
 * so the console never offers the affordance in the first place.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/** Hard ceiling on one tool invocation. A 200-page deck rasterizes in tens of seconds; a wedged
 *  office process must never wedge the server's job runner. */
const TOOL_TIMEOUT_MS = 10 * 60_000;

/** Pixel width of a rendered page. A wall panel is 1080p/4K; a page image wider than this is bytes
 *  the player downloads and the GPU downsamples for nothing. */
export const PAGE_WIDTH = 1920;

/** Never render more pages than this from one document — a runaway 5,000-page PDF is a denial of
 *  service against the media volume, not a deck anyone meant to show. */
export const MAX_PAGES = 300;

/** The document mimes we take, mapped to the extension the file is stored under. The list is the
 *  product's answer to "what does an operator drag in": slides first, then PDF, then the odd doc. */
const DOCUMENT_MIME_EXT: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/msword": "doc",
  "application/vnd.oasis.opendocument.text": "odt",
};

/** Human labels, so a refusal/library row names the format the operator recognises. */
const FORMAT_LABELS: Record<string, string> = {
  pdf: "PDF",
  pptx: "PowerPoint",
  ppt: "PowerPoint",
  odp: "OpenDocument slides",
  docx: "Word",
  doc: "Word",
  odt: "OpenDocument text",
};

/** The stored extension for a document mime, or null when the mime is not a document at all. PURE. */
export function documentExtForMime(mime: string): string | null {
  return DOCUMENT_MIME_EXT[mime.trim().toLowerCase()] ?? null;
}

/** True when an upload is a document (and therefore belongs to the deck pipeline, not to media). */
export function isDocumentMime(mime: string): boolean {
  return documentExtForMime(mime) !== null;
}

/** The friendly name of a document format ("pptx" → "PowerPoint"). */
export function documentFormatLabel(ext: string): string {
  return FORMAT_LABELS[ext.toLowerCase()] ?? ext.toUpperCase();
}

/** The mimes the console should offer in its file picker — derived from the same table, so the two
 *  ends of the upload can never disagree about what a document is. */
export const DOCUMENT_MIMES: string[] = Object.keys(DOCUMENT_MIME_EXT);

export interface ConvertRequest {
  /** The uploaded document on disk. */
  input: string;
  /** Where the page images must land. The caller owns this directory. */
  outDir: string;
  /** Basename for the page files: the converter writes `<basename>-<n>.png`, 1-based, zero-padded. */
  basename: string;
  /** Never produce more than this many pages. */
  maxPages: number;
  /** Target pixel width of a page. */
  width: number;
  /** Called as pages land — real progress, counted off the output, for the job the console watches. */
  onPage?: (pagesDone: number) => void;
}

/** The page image filenames a conversion produced, IN PAGE ORDER (relative to `outDir`). */
export type ConvertResult =
  | { ok: true; pages: string[] }
  | { ok: false; message: string };

/**
 * The conversion seam. `available()` says whether this host can convert at all (cached — the upload
 * route asks on every request); `convert()` renders a document to page images and must never throw
 * for an ordinary bad file: a corrupt PPTX is an `{ ok: false, message }`, not a 500.
 */
export interface DocumentConverter {
  /** For logs + diagnostics only. Never branched on by core. */
  readonly name: string;
  available(): Promise<boolean>;
  convert(req: ConvertRequest): Promise<ConvertResult>;
}

/** The converter on a host with no toolchain: it can do nothing, and says so. Ingest then REFUSES the
 *  document (see the header) rather than minting a deck with no pages. */
export class NullDocumentConverter implements DocumentConverter {
  readonly name = "none";
  async available(): Promise<boolean> {
    return false;
  }
  async convert(): Promise<ConvertResult> {
    return { ok: false, message: NO_CONVERTER_MESSAGE };
  }
}

/** The sentence an operator sees when this server cannot convert documents (D132 — refuse, because a
 *  deck with no pages is a black screen with a name). */
export const NO_CONVERTER_MESSAGE =
  "This server can't convert documents — no document toolchain is installed. Export your slides to " +
  "PDF or images and upload those, or install the converter on the server.";

/** Natural (numeric) sort, so page 10 follows page 9 and not page 1. */
function byPageNumber(a: string, b: string): number {
  const na = Number(/(\d+)\.png$/i.exec(a)?.[1] ?? 0);
  const nb = Number(/(\d+)\.png$/i.exec(b)?.[1] ?? 0);
  return na - nb;
}

/**
 * The ONE implementation that shells out to an external toolchain: an office suite (any format → PDF)
 * followed by a PDF rasterizer (PDF → page PNGs). A PDF skips the first hop entirely, which is why a
 * PDF converts on a host that only has the rasterizer.
 *
 * Both binaries are configurable and both are asked for their version to establish availability. If
 * only the rasterizer is present the converter is still AVAILABLE — for PDFs. That partial capability
 * is real and worth having (a minimal container can ship a rasterizer but not an office suite), so
 * `available()` means "can convert something", and a PPTX on such a host is refused by name.
 */
export class ExternalToolDocumentConverter implements DocumentConverter {
  readonly name: string;
  private availability?: Promise<boolean>;
  private officeOk = false;

  constructor(
    private readonly officeCmd: string,
    private readonly rasterCmd: string,
  ) {
    this.name = `${officeCmd}/${rasterCmd}`;
  }

  available(): Promise<boolean> {
    this.availability ??= this.detect();
    return this.availability;
  }

  /** The rasterizer is the floor: without it there is no way to make a page image at all. */
  private async detect(): Promise<boolean> {
    this.officeOk = await this.probeBinary(this.officeCmd, ["--version"]);
    // The rasterizer's version flag is `-v` (it prints to stderr and exits 0) — try both spellings so
    // a substituted binary with the other convention still registers.
    const rasterOk =
      (await this.probeBinary(this.rasterCmd, ["-v"])) ||
      (await this.probeBinary(this.rasterCmd, ["--version"]));
    return rasterOk;
  }

  private async probeBinary(cmd: string, args: string[]): Promise<boolean> {
    try {
      await run(cmd, args, { timeout: 20_000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Can this host convert THIS format? (A rasterizer-only host does PDFs and nothing else.) */
  async supports(ext: string): Promise<boolean> {
    if (!(await this.available())) return false;
    return ext === "pdf" || this.officeOk;
  }

  async convert(req: ConvertRequest): Promise<ConvertResult> {
    const ext = extname(req.input).replace(/^\./, "").toLowerCase();
    if (!(await this.available())) return { ok: false, message: NO_CONVERTER_MESSAGE };

    let pdfPath = req.input;
    let scratch: string | null = null;

    try {
      if (ext !== "pdf") {
        if (!this.officeOk) {
          return {
            ok: false,
            message:
              `This server can only convert PDFs — it has no office toolchain to read ` +
              `${documentFormatLabel(ext)} files. Export the deck to PDF and upload that.`,
          };
        }
        scratch = await mkdtemp(join(tmpdir(), "polyptic-doc-"));
        const made = await this.toPdf(req.input, scratch);
        if (!made) {
          return {
            ok: false,
            message:
              `This ${documentFormatLabel(ext)} file couldn't be converted — it may be corrupt or ` +
              "password-protected. Open it, export it to PDF, and upload that.",
          };
        }
        pdfPath = made;
      }

      const pages = await this.rasterize(pdfPath, req);
      if (pages.length === 0) {
        return {
          ok: false,
          message:
            "This document produced no pages — it may be empty, corrupt, or password-protected. " +
            "Open it, export it to PDF, and upload that.",
        };
      }
      return { ok: true, pages };
    } catch (err) {
      // A wedged/killed tool (timeout) lands here. It is an ordinary failure of THIS upload, not a 500.
      return {
        ok: false,
        message:
          "Converting this document failed or took too long. Try a smaller document, or export it to " +
          `PDF and upload that. (${err instanceof Error ? err.message.slice(0, 120) : "unknown error"})`,
      };
    } finally {
      if (scratch) await rm(scratch, { recursive: true, force: true });
    }
  }

  /** Office format → PDF, in a scratch dir. Returns the produced PDF's path, or null. */
  private async toPdf(input: string, outDir: string): Promise<string | null> {
    try {
      await run(
        this.officeCmd,
        ["--headless", "--norestore", "--convert-to", "pdf", "--outdir", outDir, input],
        { timeout: TOOL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      );
    } catch {
      return null;
    }
    // The office tool names the output after the input's stem; find it rather than assume.
    const produced = (await readdir(outDir)).filter((f) => f.toLowerCase().endsWith(".pdf"));
    const stem = basename(input, extname(input));
    const match = produced.find((f) => basename(f, ".pdf") === stem) ?? produced[0];
    return match ? join(outDir, match) : null;
  }

  /**
   * PDF → page PNGs. The rasterizer writes `<prefix>-<n>.png` itself; we poll the output directory
   * while it runs so the job can report REAL page progress (a 60-slide deck is 30+ seconds — an
   * operator watching a still spinner has no way to tell "working" from "hung").
   */
  private async rasterize(pdf: string, req: ConvertRequest): Promise<string[]> {
    const prefix = join(req.outDir, req.basename);
    const proc = run(
      this.rasterCmd,
      [
        "-png",
        "-scale-to-x",
        String(Math.round(req.width)),
        "-scale-to-y",
        "-1", // keep the aspect ratio
        "-f",
        "1",
        "-l",
        String(req.maxPages),
        pdf,
        prefix,
      ],
      { timeout: TOOL_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
    );

    let done = false;
    const poll = (async () => {
      while (!done) {
        await new Promise((r) => setTimeout(r, 400));
        if (done) break;
        const n = (await this.producedPages(req)).length;
        if (n > 0) req.onPage?.(n);
      }
    })();

    try {
      await proc;
    } finally {
      done = true;
      await poll;
    }

    const pages = await this.producedPages(req);
    return pages.slice(0, req.maxPages);
  }

  /** The page files produced so far, in page order. */
  private async producedPages(req: ConvertRequest): Promise<string[]> {
    let entries: string[];
    try {
      entries = await readdir(req.outDir);
    } catch {
      return [];
    }
    return entries
      .filter((f) => f.startsWith(`${req.basename}-`) && f.toLowerCase().endsWith(".png"))
      .sort(byPageNumber);
  }
}

/**
 * Build the process-wide converter from the environment. `DOC_OFFICE_CMD` / `DOC_RASTER_CMD` name the
 * binaries (the defaults are the ubiquitous pair baked into our server image); `DOC_CONVERT=off`
 * disables document conversion entirely — the server then advertises `capabilities.documents = false`
 * and refuses document uploads with a sentence instead of storing a file nothing can show.
 * Nothing here can throw: a bad config degrades to the null converter.
 */
export function createDocumentConverter(
  env: Record<string, string | undefined> = process.env,
): DocumentConverter {
  if ((env.DOC_CONVERT ?? "").toLowerCase() === "off") return new NullDocumentConverter();
  const officeCmd = env.DOC_OFFICE_CMD?.trim() || "soffice";
  const rasterCmd = env.DOC_RASTER_CMD?.trim() || "pdftoppm";
  return new ExternalToolDocumentConverter(officeCmd, rasterCmd);
}
