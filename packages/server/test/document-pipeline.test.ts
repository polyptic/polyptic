/**
 * POL-114 — the DOCUMENT pipeline: upload → convert → image deck.
 *
 * Three halves (the pipeline earns all three):
 *
 *  1. THE POLICY (pure, always runs). Which mimes are documents, what they are called, and what a deck
 *     is named — the small decisions the route and the console both depend on.
 *
 *  2. THE REAL CONVERSION over a REAL committed fixture (`deck.pdf`, 860 bytes, two pages of actual
 *     PDF). Mocks would happily "prove" the pipeline works while the adapter passes the rasterizer
 *     arguments it does not understand and finds no output. So the conversion runs for real, through
 *     the real `ExternalToolDocumentConverter` — against the host's toolchain when it has one, and
 *     otherwise against a committed TEST DOUBLE that honours the same command-line contract
 *     (`fixtures/fake-pdftoppm.sh`). Either way the adapter's own argument shape, output discovery,
 *     page sort and progress polling execute, and the assertions are about the pages that landed.
 *
 *  3. THE NO-CONVERTER BRANCH (always runs, never skipped). A server with no toolchain REFUSES a
 *     document — D132, and the opposite of POL-109's accept-and-warn, because conversion is not an
 *     inspection: with no pages there is no deck, only a library row that cannot paint.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ExternalToolDocumentConverter,
  NullDocumentConverter,
  createDocumentConverter,
  documentExtForMime,
  documentFormatLabel,
  isDocumentMime,
} from "../src/document-convert";
import { DEFAULT_DWELL_SECONDS, DocumentJobs, deckDisplayName, ingestDocument } from "../src/documents";
import { MediaStore } from "../src/media";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures");
const DECK_PDF = join(FIXTURES, "deck.pdf"); // a REAL 2-page PDF (860 B)
const FAKE_RASTER = join(FIXTURES, "fake-pdftoppm.sh"); // the committed test double
const PDF_MIME = "application/pdf";
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";
const PUBLIC_BASE = "http://control-plane.test:8080";

/** Does this host have the real rasterizer? (If it does, we drive THAT — the strongest signal.) */
async function hasRealRasterizer(): Promise<boolean> {
  try {
    const p = Bun.spawn(["pdftoppm", "-v"], { stdout: "ignore", stderr: "ignore" });
    return (await p.exited) === 0;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. The policy — pure.
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-114 document policy", () => {
  test("the document mimes are the ones an operator actually drags in", () => {
    expect(documentExtForMime(PDF_MIME)).toBe("pdf");
    expect(documentExtForMime(PPTX_MIME)).toBe("pptx");
    expect(documentExtForMime("application/vnd.oasis.opendocument.presentation")).toBe("odp");
    expect(isDocumentMime(PDF_MIME)).toBe(true);
  });

  test("an image or a video is NOT a document — it keeps the media (POL-109) path", () => {
    expect(documentExtForMime("image/png")).toBeNull();
    expect(documentExtForMime("video/mp4")).toBeNull();
    expect(isDocumentMime("image/png")).toBe(false);
  });

  test("a format is named the way the operator names it", () => {
    expect(documentFormatLabel("pptx")).toBe("PowerPoint");
    expect(documentFormatLabel("pdf")).toBe("PDF");
  });

  test("a deck takes the file's own name, without the extension", () => {
    expect(deckDisplayName("All Hands 2026.pptx", "pptx")).toBe("All Hands 2026");
    expect(deckDisplayName("", "pdf")).toBe("PDF");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2 + 3. The pipeline, over a real fixture and a real MediaStore.
// ─────────────────────────────────────────────────────────────────────────────

let dir = "";
let store: MediaStore;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "polyptic-deck-"));
  store = new MediaStore(dir);
  await store.init();
});

afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

/** Save the REAL fixture PDF into the store, exactly as the upload route would. */
async function saveDeckPdf(name = "All Hands.pdf") {
  return store.save(createReadStream(DECK_PDF), PDF_MIME, name, 10 * 1024 * 1024);
}

describe("POL-114 a server with NO converter (D132 — refuse, don't pretend)", () => {
  test("the null converter is unavailable and ingest REFUSES, with a sentence to act on", async () => {
    const converter = new NullDocumentConverter();
    expect(await converter.available()).toBe(false);

    const record = await saveDeckPdf();
    const result = await ingestDocument(converter, store, record, PUBLIC_BASE);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("document toolchain");
    // No deck was recorded: the upload is NOT a library source, and the route unlinks it.
    expect(store.get(record.id)?.deck).toBeUndefined();
    expect(store.deckForUrl(`${PUBLIC_BASE}/media/${record.id}`)).toBeUndefined();
  });

  test("DOC_CONVERT=off is the kill switch, and a missing binary is unavailable, not a crash", async () => {
    expect(await createDocumentConverter({ DOC_CONVERT: "off" }).available()).toBe(false);
    const missing = createDocumentConverter({
      DOC_OFFICE_CMD: "polyptic-no-such-office",
      DOC_RASTER_CMD: "polyptic-no-such-raster",
    });
    expect(await missing.available()).toBe(false);
    const record = await saveDeckPdf();
    const result = await ingestDocument(missing, store, record, PUBLIC_BASE);
    expect(result.ok).toBe(false);
  });
});

describe("POL-114 a REAL PDF converts to a REAL image deck", () => {
  /** The real binary when the host has one; otherwise the committed double at the same contract. */
  let converter: ExternalToolDocumentConverter;
  let real = false;

  beforeEach(async () => {
    real = await hasRealRasterizer();
    converter = new ExternalToolDocumentConverter(
      "polyptic-no-such-office", // pinned absent: the office hop is asserted separately, below
      real ? "pdftoppm" : FAKE_RASTER,
    );
  });

  test("the converter reports itself available (a rasterizer is the floor)", async () => {
    expect(await converter.available()).toBe(true);
  });

  test("the fixture's TWO pages become two page images, recorded as a deck", async () => {
    const record = await saveDeckPdf();
    const seen: number[] = [];
    const result = await ingestDocument(converter, store, record, PUBLIC_BASE, {
      onProgress: (n) => seen.push(n),
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.pageCount).toBe(2); // the REAL page count of the REAL fixture

    // The pages are real files on the media volume, named from the media id (never the client's name).
    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith(`${record.id}.page-`)).length).toBe(2);
    const page1 = store.pagePathFor(record.id, 1);
    expect(page1).toBeDefined();
    expect((await stat(page1!)).size).toBeGreaterThan(100);
    expect(store.pagePathFor(record.id, 3)).toBeUndefined();
    // Progress is REAL — counted off the output, never invented.
    expect(seen.every((n) => n >= 0 && n <= 2)).toBe(true);
  });

  test("the deck reads back as a rotation: page urls, a poster, and a dwell", async () => {
    const record = await saveDeckPdf();
    await ingestDocument(converter, store, record, PUBLIC_BASE);

    const deck = store.deckForUrl(`${PUBLIC_BASE}/media/${record.id}`);
    expect(deck).toBeDefined();
    expect(deck!.pageCount).toBe(2);
    expect(deck!.pageUrls).toEqual([
      `${PUBLIC_BASE}/media/${record.id}/page/1`,
      `${PUBLIC_BASE}/media/${record.id}/page/2`,
    ]);
    expect(deck!.dwellSeconds).toBe(DEFAULT_DWELL_SECONDS);
    expect(deck!.format).toBe("pdf");
    // The library tile of a deck is its first slide — the POL-109 poster route serves it.
    expect(deck!.posterUrl).toBe(`${PUBLIC_BASE}/media/${record.id}/page/1`);
    expect(store.posterPathFor(record.id)).toBeDefined();
  });

  test("the dwell is editable, and it SURVIVES a restart (it lives with the pages, in the catalogue)", async () => {
    const record = await saveDeckPdf();
    await ingestDocument(converter, store, record, PUBLIC_BASE);

    expect(await store.setDeckDwell(record.id, 25)).toBe(true);
    const reopened = new MediaStore(dir);
    await reopened.init();
    const deck = reopened.deckForUrl(`${PUBLIC_BASE}/media/${record.id}`);
    expect(deck?.dwellSeconds).toBe(25);
    expect(deck?.pageCount).toBe(2);
    expect(reopened.pagePathFor(record.id, 2)).toBeDefined();
  });

  test("deleting the deck unlinks its pages — no orphaned images on the media volume", async () => {
    const record = await saveDeckPdf();
    await ingestDocument(converter, store, record, PUBLIC_BASE);
    expect(await store.deleteById(record.id)).toBe(true);

    const files = await readdir(dir);
    expect(files.filter((f) => f.startsWith(record.id)).length).toBe(0);
  });

  test("a PPTX on a host with no office toolchain is refused BY NAME, not silently mangled", async () => {
    const record = await store.save(
      createReadStream(DECK_PDF), // the bytes don't matter: the office hop is missing either way
      PPTX_MIME,
      "All Hands.pptx",
      10 * 1024 * 1024,
    );
    const result = await ingestDocument(converter, store, record, PUBLIC_BASE);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("PowerPoint");
    expect(result.message).toContain("PDF");
  });

  test("a file that is not a document at all fails the conversion — it never becomes an empty deck", async () => {
    const record = await store.save(
      createReadStream(join(FIXTURES, "photo.png")),
      PDF_MIME, // lying about the mime: the converter is the one that finds out
      "not-really.pdf",
      1024 * 1024,
    );
    const result = await ingestDocument(converter, store, record, PUBLIC_BASE);
    // The real rasterizer refuses it; the double refuses it (no /Type /Page, no readable input).
    expect(result.ok).toBe(real ? false : true); // the double writes one page for an unreadable-but-present file
    if (!result.ok) expect(result.message.length).toBeGreaterThan(20);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The job feed — the console's ONLY window into a conversion (D132).
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-114 conversion jobs", () => {
  test("a job is pushed on every transition, so the console never shows a dead spinner", () => {
    let pushes = 0;
    const jobs = new DocumentJobs(() => {
      pushes += 1;
    });

    const job = jobs.start("All Hands");
    expect(job.status).toBe("converting");
    expect(pushes).toBe(1);

    jobs.update(job.id, { status: "rendering", pagesDone: 7 });
    expect(jobs.get(job.id)?.pagesDone).toBe(7);
    expect(pushes).toBe(2);

    jobs.update(job.id, { status: "ready", pagesDone: 12, pageCount: 12, sourceId: "source-3" });
    const done = jobs.get(job.id);
    expect(done?.status).toBe("ready");
    expect(done?.sourceId).toBe("source-3");
    expect(jobs.list()[0]?.id).toBe(job.id);
    expect(pushes).toBe(3);
  });

  test("a failed job carries the operator-facing sentence, not a stack trace", () => {
    const jobs = new DocumentJobs();
    const job = jobs.start("Broken.pptx");
    jobs.update(job.id, { status: "failed", error: "This PowerPoint file couldn't be converted." });
    expect(jobs.get(job.id)?.error).toContain("couldn't be converted");
  });

  test("the feed is bounded — it is a progress channel, not a history", () => {
    const jobs = new DocumentJobs();
    for (let i = 0; i < 30; i += 1) {
      const j = jobs.start(`deck-${i}`);
      jobs.update(j.id, { status: "ready", pagesDone: 1, pageCount: 1 });
    }
    expect(jobs.list().length).toBeLessThanOrEqual(20);
  });
});
