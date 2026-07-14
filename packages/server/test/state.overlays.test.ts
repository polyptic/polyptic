/**
 * POL-97 — the overlay layer in the control plane, driven directly against the MemoryStore.
 *
 * The claims worth pinning are the ones the whole feature rests on:
 *   - an overlay COMPOSITES: it rides its own `overlay` field on the slice, so the surfaces beneath
 *     are byte-for-byte what they were; applying and removing one never touches stored content;
 *   - PRECEDENCE is most-specific-wins: screen > wall > mural > fleet (the takeover's ordering);
 *   - only a PAGE can be an overlay (anything else would occlude what it is meant to sit above);
 *   - an overlay on a video-wall member SPANS the wall (same union-bbox math the content uses), so a
 *     logo bug lands once in the wall's corner — unless the operator addressed that one screen;
 *   - live-data elements work exactly as in a page: an overlay's feeds/weather are polled, and its
 *     embeds/feeds arrive resolved in the send-time `data` bundle;
 *   - deleting the page takes the overlay off the glass, and the assignment with it;
 *   - the assignments survive a restart.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output, PageDefinition } from "@polyptic/protocol";
import { ControlPlane, type RegisterMachineInput } from "../src/state";
import { MemoryStore } from "../src/store/memory";

function hello(machineId: string, ...connectors: string[]): RegisterMachineInput {
  return {
    machineId,
    agentVersion: "test",
    backend: "wayland-sway",
    outputs: connectors.map((connector) => ({ connector, width: 1920, height: 1080 }) satisfies Output),
    hostname: "test-box",
  };
}

/** A "logo bug in the corner" overlay — the canonical case. */
const LOGO: PageDefinition = {
  aspect: "16:9",
  bg: "#0b0b0e",
  elements: [
    { id: "logo", kind: "text", x: 84, y: 4, w: 14, h: 8, props: { text: "ACME", size: 40, color: "#fafafa", align: "right" } },
  ],
};

/** A banner overlay, so precedence tests can tell two overlays apart. */
const BANNER: PageDefinition = {
  aspect: "16:9",
  bg: "#0b0b0e",
  elements: [
    { id: "b", kind: "text", x: 0, y: 44, w: 100, h: 12, props: { text: "MEETING IN PROGRESS", size: 60, color: "#fafafa", align: "center" } },
  ],
};

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

async function page(name: string, definition: PageDefinition): Promise<string> {
  const created = await cp.createContentSource({ name, kind: "page", definition });
  if (!created.ok) throw new Error("page create failed");
  return created.source.id;
}

async function web(name: string, url: string): Promise<string> {
  const created = await cp.createContentSource({ name, kind: "web", url });
  if (!created.ok) throw new Error("source create failed");
  return created.source.id;
}

async function oneScreen(): Promise<string> {
  await cp.registerMachine(hello("m1", "HDMI-1"));
  return cp.getScreens()[0]!.id;
}

/** Two screens side by side on a mural, combined into a wall. Returns the ids. */
async function twoScreenWall(): Promise<{ muralId: string; wallId: string; a: string; b: string }> {
  await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
  const [a, b] = cp.getScreens().map((s) => s.id) as [string, string];
  const mural = await cp.createMural("Atrium");
  await cp.placeScreen(a, mural.id, 0, 0, 1920, 1080);
  await cp.placeScreen(b, mural.id, 1920, 0, 1920, 1080);
  const combined = await cp.combineScreens(mural.id, [a, b], "Atrium Wall");
  if (!combined.ok) throw new Error("combine failed");
  return { muralId: mural.id, wallId: combined.wall.id, a, b };
}

describe("overlay resolution + precedence (POL-97)", () => {
  test("a fleet overlay covers every screen", async () => {
    const screenId = await oneScreen();
    const logo = await page("Logo", LOGO);

    const applied = await cp.setOverlay("fleet", undefined, logo);
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;
    expect(applied.screenIds).toEqual([screenId]);

    const resolved = cp.resolveOverlay(screenId);
    expect(resolved?.scope).toBe("fleet");
    expect(resolved?.sourceId).toBe(logo);
  });

  test("screen beats wall beats mural beats fleet", async () => {
    const { muralId, wallId, a, b } = await twoScreenWall();
    const fleet = await page("Fleet logo", LOGO);
    const mural = await page("Mural banner", BANNER);
    const wall = await page("Wall banner", BANNER);
    const screen = await page("Screen banner", BANNER);

    await cp.setOverlay("fleet", undefined, fleet);
    expect(cp.resolveOverlay(a)?.sourceId).toBe(fleet);

    await cp.setOverlay("mural", muralId, mural);
    expect(cp.resolveOverlay(a)?.scope).toBe("mural");
    expect(cp.resolveOverlay(a)?.sourceId).toBe(mural);

    await cp.setOverlay("wall", wallId, wall);
    expect(cp.resolveOverlay(a)?.scope).toBe("wall");

    await cp.setOverlay("screen", a, screen);
    expect(cp.resolveOverlay(a)?.scope).toBe("screen");
    expect(cp.resolveOverlay(a)?.sourceId).toBe(screen);
    // …and the OTHER wall member, which no screen-scope overlay addresses, still takes the wall's.
    expect(cp.resolveOverlay(b)?.scope).toBe("wall");

    // Peel them off in order: each removal falls back to the next-widest scope, never to nothing.
    await cp.clearOverlay("screen", a);
    expect(cp.resolveOverlay(a)?.scope).toBe("wall");
    await cp.clearOverlay("wall", wallId);
    expect(cp.resolveOverlay(a)?.scope).toBe("mural");
    await cp.clearOverlay("mural", muralId);
    expect(cp.resolveOverlay(a)?.scope).toBe("fleet");
    await cp.clearOverlay("fleet");
    expect(cp.resolveOverlay(a)).toBeUndefined();
  });

  test("applying a narrower overlay only re-pushes the screens it actually changes", async () => {
    const { wallId, a, b } = await twoScreenWall();
    const fleet = await page("Fleet logo", LOGO);
    const banner = await page("Banner", BANNER);

    await cp.setOverlay("fleet", undefined, fleet);

    // A screen-scoped overlay on `a` changes `a` alone — `b` keeps the fleet's and must not re-push.
    const narrowed = await cp.setOverlay("screen", a, banner);
    expect(narrowed.ok).toBe(true);
    if (!narrowed.ok) return;
    expect(narrowed.screenIds).toEqual([a]);

    // Re-applying the SAME wall overlay the fleet already provides still changes both members (a
    // different scope won), but re-applying an identical assignment changes nobody.
    const again = await cp.setOverlay("fleet", undefined, fleet);
    expect(again.ok).toBe(true);
    if (!again.ok) return;
    expect(again.screenIds).toEqual([]);

    const wall = await cp.setOverlay("wall", wallId, fleet);
    expect(wall.ok).toBe(true);
    if (!wall.ok) return;
    // `a` is covered by its own screen scope, so only `b` sees the wall overlay arrive.
    expect(wall.screenIds).toEqual([b]);
  });

  test("only a page can be an overlay; unknown targets and sources are refused", async () => {
    const screenId = await oneScreen();
    const dash = await web("KPI", "https://dash.example.test/embed");
    const logo = await page("Logo", LOGO);

    const notAPage = await cp.setOverlay("fleet", undefined, dash);
    expect(notAPage).toEqual({ ok: false, error: "not-a-page" });

    const noSource = await cp.setOverlay("fleet", undefined, "source-999");
    expect(noSource).toEqual({ ok: false, error: "unknown-source" });

    const noTarget = await cp.setOverlay("screen", "screen-999", logo);
    expect(noTarget).toEqual({ ok: false, error: "unknown-target" });

    expect(cp.resolveOverlay(screenId)).toBeUndefined();
    // Clearing a scope with no overlay is a null, not a crash.
    expect(await cp.clearOverlay("fleet")).toBeNull();
  });

  test("assignments survive a restart", async () => {
    const screenId = await oneScreen();
    const logo = await page("Logo", LOGO);
    await cp.setOverlay("fleet", undefined, logo);
    await cp.setOverlay("screen", screenId, logo);

    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect(cp2.getOverlays().map((o) => o.scope)).toEqual(["screen", "fleet"]);
    expect(cp2.resolveOverlay(screenId)?.scope).toBe("screen");
  });
});

describe("slice composition (POL-97)", () => {
  test("the overlay rides ALONGSIDE the surfaces — the content beneath is untouched", async () => {
    const screenId = await oneScreen();
    const dash = await web("KPI", "https://dash.example.test/embed");
    const logo = await page("Logo", LOGO);

    await cp.setScreenContent(screenId, { sourceId: dash });
    const stored = cp.getSlice(screenId)!;
    const before = structuredClone(stored);

    await cp.setOverlay("fleet", undefined, logo);

    // The STORED slice never learns about the overlay — applying one is not a content edit.
    expect(cp.getSlice(screenId)).toEqual(before);

    const sent = cp.decorateSliceForSend(cp.sliceForPlayer(screenId));
    expect(sent.surfaces).toEqual(before.surfaces); // the content, byte for byte
    expect(sent.overlay?.sourceId).toBe(logo);
    expect(sent.overlay?.scope).toBe("fleet");
    expect(sent.overlay?.definition.elements[0]?.id).toBe("logo");
    expect(sent.overlay?.span).toBeUndefined(); // not a wall member

    // Removing it leaves exactly the same content, minus the layer.
    await cp.clearOverlay("fleet");
    const after = cp.decorateSliceForSend(cp.sliceForPlayer(screenId));
    expect(after.overlay).toBeUndefined();
    expect(after.surfaces).toEqual(before.surfaces);
  });

  test("an idle screen (no content) still wears its overlay", async () => {
    const screenId = await oneScreen();
    const logo = await page("Logo", LOGO);
    await cp.setOverlay("fleet", undefined, logo);

    const sent = cp.decorateSliceForSend(cp.sliceForPlayer(screenId));
    expect(sent.surfaces).toEqual([]);
    expect(sent.overlay?.sourceId).toBe(logo);
  });

  test("a wide-scoped overlay SPANS a video wall; a screen-scoped one does not", async () => {
    const { wallId, a, b } = await twoScreenWall();
    const logo = await page("Logo", LOGO);
    const banner = await page("Banner", BANNER);

    await cp.setOverlay("wall", wallId, logo);
    const sentA = cp.decorateSliceForSend(cp.sliceForPlayer(a));
    const sentB = cp.decorateSliceForSend(cp.sliceForPlayer(b));

    // The same union bbox the content spans by: 3840×1080, each member at its own offset.
    expect(sentA.overlay?.span).toEqual({ contentW: 3840, contentH: 1080, offsetX: 0, offsetY: 0 });
    expect(sentB.overlay?.span).toEqual({ contentW: 3840, contentH: 1080, offsetX: 1920, offsetY: 0 });

    // An overlay aimed at ONE panel of the wall is not spanned — the operator addressed that screen.
    await cp.setOverlay("screen", a, banner);
    const narrowed = cp.decorateSliceForSend(cp.sliceForPlayer(a));
    expect(narrowed.overlay?.scope).toBe("screen");
    expect(narrowed.overlay?.span).toBeUndefined();
  });

  test("live-data elements work in an overlay exactly as in a page", async () => {
    const screenId = await oneScreen();
    const dash = await web("KPI", "https://dash.example.test/embed");
    const ticker = await page("Ticker", {
      aspect: "16:9",
      bg: "#0b0b0e",
      elements: [
        { id: "fd", kind: "feed", x: 0, y: 88, w: 100, h: 12, props: { url: "https://news.example.test/rss", items: 4 } },
        { id: "wx", kind: "weather", x: 80, y: 2, w: 18, h: 10, props: { location: "Sheffield", units: "C" } },
        { id: "em", kind: "embed", x: 0, y: 0, w: 40, h: 30, props: { sourceId: dash } },
      ],
    });

    // Unassigned, the overlay's page costs no polling…
    expect(cp.pageDataRequirements().feeds.size).toBe(0);

    await cp.setOverlay("fleet", undefined, ticker);

    // …applied, its feed + weather are polled exactly like an assigned page's (it is on the glass).
    const req = cp.pageDataRequirements();
    expect([...req.feeds]).toEqual(["https://news.example.test/rss"]);
    expect([...req.locations]).toEqual(["Sheffield"]);

    // And the poller's data reaches it through the same send-time bundle a page surface gets.
    cp.setPageDataProvider({
      feedFor: (url) =>
        url === "https://news.example.test/rss"
          ? { items: [{ title: "Line 3 back up" }], fetchedAt: "2026-07-14T09:00:00.000Z" }
          : undefined,
      weatherFor: (location) =>
        location === "Sheffield"
          ? { tempC: 17, code: 3, description: "Overcast", location: "Sheffield", fetchedAt: "2026-07-14T09:00:00.000Z" }
          : undefined,
    });

    const sent = cp.decorateSliceForSend(cp.sliceForPlayer(screenId));
    expect(sent.overlay?.data?.feeds?.fd?.items[0]?.title).toBe("Line 3 back up");
    expect(sent.overlay?.data?.weather?.wx?.tempC).toBe(17);
    expect(sent.overlay?.data?.embeds?.em?.url).toBe("https://dash.example.test/embed");
  });

  test("editing the overlay's page re-pushes the screens wearing it (content untouched)", async () => {
    const screenId = await oneScreen();
    const dash = await web("KPI", "https://dash.example.test/embed");
    const logo = await page("Logo", LOGO);
    await cp.setScreenContent(screenId, { sourceId: dash });
    await cp.setOverlay("fleet", undefined, logo);

    const edited = await cp.updateContentSource(logo, { definition: BANNER });
    expect(edited.ok).toBe(true);
    if (!edited.ok) return;
    // The screen wearing it is in the re-push set even though its CONTENT assignment is the dashboard.
    expect(edited.slices.map((s) => s.screenId)).toContain(screenId);

    const sent = cp.decorateSliceForSend(cp.sliceForPlayer(screenId));
    expect(sent.overlay?.definition.elements[0]?.id).toBe("b");
    expect(sent.surfaces[0]?.type).toBe("web"); // the dashboard beneath never moved
  });

  test("deleting the page takes the overlay off the glass and drops the assignment", async () => {
    const screenId = await oneScreen();
    const dash = await web("KPI", "https://dash.example.test/embed");
    const logo = await page("Logo", LOGO);
    await cp.setScreenContent(screenId, { sourceId: dash });
    await cp.setOverlay("fleet", undefined, logo);

    const deleted = await cp.deleteContentSource(logo);
    expect(deleted?.slices.map((s) => s.screenId)).toContain(screenId);
    expect(cp.getOverlays()).toEqual([]);

    const sent = cp.decorateSliceForSend(cp.sliceForPlayer(screenId));
    expect(sent.overlay).toBeUndefined();
    // The content the overlay sat above is still there — an overlay never owned it.
    expect(sent.surfaces[0]?.type).toBe("web");
  });
});
