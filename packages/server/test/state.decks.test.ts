/**
 * POL-114 — a DECK resolves to a PLAYLIST of images, and nothing else in the system learns a new trick.
 *
 * This is the load-bearing claim of the whole ticket: the wall never renders a document. A `deck`
 * source (an uploaded PDF/PPTX, converted server-side to page images) resolves — at assignment time,
 * in the control plane — into the playlist surface POL-34 already ships, with each page as an `image`
 * entry timed by the deck's dwell. So the player, the offline media cache and video-wall spanning
 * carry it with code that already exists, and the player never sees the kind `deck` at all.
 *
 * Driven straight against ControlPlane + MemoryStore (no server, no WS, no converter): the pages come
 * from a fake media provider standing in for the catalogue, which is exactly the seam the real
 * MediaStore fills.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";

import type { Deck, PlaylistSurface } from "@polyptic/protocol";
import type { MediaMetadataProvider } from "../src/state";

const BASE = "http://control-plane.test:8080";
const DECK_MEDIA_ID = "aabbccddeeff0011";
const DECK_URL = `${BASE}/media/${DECK_MEDIA_ID}`;

/** The media catalogue's read seam, as the MediaStore implements it after a conversion. */
class FakeCatalogue implements MediaMetadataProvider {
  constructor(private deck: Deck) {}
  metadataForUrl(): undefined {
    return undefined;
  }
  deckForUrl(url: string): Deck | undefined {
    return url === DECK_URL ? this.deck : undefined;
  }
  setDwell(dwellSeconds: number): void {
    this.deck = { ...this.deck, dwellSeconds };
  }
}

const threePageDeck = (dwellSeconds = 10): Deck => ({
  pageCount: 3,
  pageUrls: [1, 2, 3].map((n) => `${DECK_URL}/page/${n}`),
  dwellSeconds,
  posterUrl: `${DECK_URL}/page/1`,
  format: "pptx",
});

let store: MemoryStore;
let cp: ControlPlane;
let catalogue: FakeCatalogue;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
  catalogue = new FakeCatalogue(threePageDeck());
  cp.setMediaProvider(catalogue);
});

async function registerScreen(): Promise<string> {
  const result = await cp.registerMachine({
    machineId: "m-1",
    agentVersion: "test",
    backend: "dev-open",
    outputs: [{ connector: "HDMI-A-1", width: 1920, height: 1080 }],
  });
  const screenId = result.assignments[0]?.screenId;
  if (!screenId) throw new Error("expected a screen");
  return screenId;
}

async function createDeck() {
  const created = await cp.createContentSource({ name: "All Hands", kind: "deck", url: DECK_URL });
  if (!created.ok) throw new Error("expected the deck to be created");
  return created.source;
}

describe("POL-114 decks in the control plane", () => {
  test("a deck source is DECORATED with its converted pages, read from the catalogue", async () => {
    const deck = await createDeck();
    const read = cp.getContentSource(deck.id);
    expect(read?.kind).toBe("deck");
    expect(read?.deck?.pageCount).toBe(3);
    expect(read?.deck?.posterUrl).toBe(`${DECK_URL}/page/1`);
    // Derived, never stored: the persisted row knows only the id/name/kind/url.
    const persisted = (await store.listContentSources()).find((s) => s.id === deck.id);
    expect(persisted).toBeDefined();
    expect(JSON.stringify(persisted)).not.toContain("page/1");
  });

  test("assigning a deck renders a PLAYLIST of images — the player never sees a document", async () => {
    const screenId = await registerScreen();
    const deck = await createDeck();

    const result = await cp.setScreenContent(screenId, { sourceId: deck.id });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);

    const surfaces = result.slice.surfaces;
    expect(surfaces).toHaveLength(1);
    const surface = surfaces[0] as PlaylistSurface;
    expect(surface.type).toBe("playlist");
    expect(surface.items).toHaveLength(3);
    expect(surface.items.map((i) => i.kind)).toEqual(["image", "image", "image"]);
    expect(surface.items.map((i) => i.url)).toEqual([
      `${DECK_URL}/page/1`,
      `${DECK_URL}/page/2`,
      `${DECK_URL}/page/3`,
    ]);
    // Every page is TIMED (a deck has no video to end by itself), so the rotation is clock-derivable
    // and every member of a video wall stays in phase — POL-34's whole reason for `startedAt`.
    expect(surface.items.every((i) => i.durationSeconds === 10)).toBe(true);
    expect(typeof surface.startedAt).toBe("string");
  });

  test("changing the dwell re-times the rotation and re-pushes the screens showing it", async () => {
    const screenId = await registerScreen();
    const deck = await createDeck();
    await cp.setScreenContent(screenId, { sourceId: deck.id });

    catalogue.setDwell(30); // what MediaStore.setDeckDwell does to the catalogue
    const slices = await cp.refreshSource(deck.id);

    expect(slices).toHaveLength(1);
    const surface = slices[0]!.surfaces[0] as PlaylistSurface;
    expect(surface.items.every((i) => i.durationSeconds === 30)).toBe(true);
  });

  test("a deck cannot be a playlist STEP — it is already a rotation", async () => {
    const deck = await createDeck();
    const result = await cp.createContentSource({
      name: "Lobby loop",
      kind: "playlist",
      items: [{ sourceId: deck.id, durationSeconds: 20 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.error).toBe("nested-playlist");
  });

  test("a deck whose pages are GONE renders nothing, rather than a broken surface", async () => {
    const screenId = await registerScreen();
    const deck = await createDeck();
    // A catalogue that knows nothing about this url (media volume swapped, conversion lost).
    cp.setMediaProvider({ metadataForUrl: () => undefined, deckForUrl: () => undefined });

    const result = await cp.setScreenContent(screenId, { sourceId: deck.id });
    if ("error" in result) throw new Error(`unexpected error: ${result.error}`);
    const surface = result.slice.surfaces[0] as PlaylistSurface;
    expect(surface.type).toBe("playlist");
    expect(surface.items).toHaveLength(0); // the player treats an empty playlist as nothing to show
  });
});
