/**
 * POL-42 — authored pages in the control plane, driven directly against the MemoryStore.
 *
 * Pins the load-bearing claims of the pitch:
 *   - a page is a library source with a DEFINITION (no url) and renders as ONE `page` surface, so
 *     span math and the stable-id in-place swap (D5) work unchanged;
 *   - the STORED slice stays clean — embeds resolve (credential-stamped) into `data` at SEND time;
 *   - editing a page re-resolves its slices; editing/deleting a source a page EMBEDS re-pushes the
 *     pages' slices without corrupting their assignment;
 *   - pages take no zoom; unassigned pages create no polling requirements; definitions survive a
 *     restart.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output, PageDefinition, Surface } from "@polyptic/protocol";
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

function definitionWith(elements: PageDefinition["elements"]): PageDefinition {
  return { aspect: "16:9", bg: "#0b0b0e", elements };
}

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

async function oneScreen(): Promise<string> {
  await cp.registerMachine(hello("m1", "HDMI-1"));
  return cp.getScreens()[0]!.id;
}

describe("page sources (POL-42)", () => {
  test("create carries the definition and no url; the row round-trips through the store", async () => {
    const definition = definitionWith([
      { id: "e1", kind: "clock", x: 80, y: 80, w: 14, h: 10, props: { format: "24h", seconds: false, color: "#fafafa" } },
    ]);
    const created = await cp.createContentSource({ name: "Morning Wall", kind: "page", definition });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source.url).toBeUndefined();
    expect(created.source.definition?.elements.length).toBe(1);

    // Restart on the same store: the definition survives, url stays absent.
    const cp2 = new ControlPlane(store);
    await cp2.init();
    const reloaded = cp2.getContentSource(created.source.id);
    expect(reloaded?.kind).toBe("page");
    expect(reloaded?.url).toBeUndefined();
    expect(reloaded?.definition?.elements[0]?.id).toBe("e1");
  });

  test("a patch cannot strand the source unrenderable (page without definition / web without url)", async () => {
    const page = await cp.createContentSource({ name: "P", kind: "page", definition: definitionWith([]) });
    if (!page.ok) throw new Error("create failed");
    const toWeb = await cp.updateContentSource(page.source.id, { kind: "web" });
    expect(toWeb.ok).toBe(false);
    if (!toWeb.ok) expect(toWeb.error).toBe("invalid-shape");

    const web = await cp.createContentSource({ name: "W", kind: "web", url: "https://a.test/" });
    if (!web.ok) throw new Error("create failed");
    const toPage = await cp.updateContentSource(web.source.id, { kind: "page" });
    expect(toPage.ok).toBe(false);
  });

  test("assigning a page renders ONE stable-id page surface carrying the clean definition", async () => {
    const screenId = await oneScreen();
    const definition = definitionWith([
      { id: "t1", kind: "ticker", x: 0, y: 90, w: 100, h: 10, props: { text: "hi", speed: 60, fg: "#fff", bg: "#000" } },
    ]);
    const page = await cp.createContentSource({ name: "P", kind: "page", definition });
    if (!page.ok) throw new Error("create failed");

    const result = await cp.setScreenContent(screenId, { sourceId: page.source.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slice.surfaces.length).toBe(1);
    const surface = result.slice.surfaces[0]!;
    expect(surface.type).toBe("page");
    expect(surface.id).toBe("content-web"); // the same stable content id every kind uses (D5)
    if (surface.type !== "page") return;
    expect(surface.definition.elements[0]?.id).toBe("t1");
    expect(surface.data).toBeUndefined(); // stored slices never carry the live half
  });

  test("a page spans a video wall like any other surface (one surface per member, with span)", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
    const [a, b] = cp.getScreens();
    const mural = await cp.createMural("Atrium");
    await cp.placeScreen(a!.id, mural.id, 0, 0, 1920, 1080);
    await cp.placeScreen(b!.id, mural.id, 1920, 0, 1920, 1080);
    const combined = await cp.combineScreens(mural.id, [a!.id, b!.id]);
    if (!combined.ok) throw new Error("combine failed");

    const page = await cp.createContentSource({ name: "P", kind: "page", definition: definitionWith([]) });
    if (!page.ok) throw new Error("create failed");
    const result = await cp.setWallContent(combined.wall.id, { sourceId: page.source.id });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.slices.length).toBe(2);
    for (const slice of result.slices) {
      const surface = slice.surfaces[0]!;
      expect(surface.type).toBe("page");
      expect(surface.span?.contentW).toBe(3840);
      expect(surface.span?.contentH).toBe(1080);
    }
  });

  test("pages take no zoom (not-zoomable, by design)", async () => {
    const screenId = await oneScreen();
    const page = await cp.createContentSource({ name: "P", kind: "page", definition: definitionWith([]) });
    if (!page.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: page.source.id });
    const zoomed = await cp.setScreenZoom(screenId, 1.5);
    expect(zoomed.ok).toBe(false);
    if (!zoomed.ok) expect(zoomed.error).toBe("not-zoomable");
  });

  test("screenContentSummary names the page and carries no zoom", async () => {
    const screenId = await oneScreen();
    const page = await cp.createContentSource({ name: "Factory Wall", kind: "page", definition: definitionWith([]) });
    if (!page.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: page.source.id });
    const summary = cp.screenContentSummary(screenId);
    expect(summary).toEqual({ name: "Factory Wall", kind: "page", zoom: undefined });
  });
});

describe("send-time page data (decorateSliceForSend)", () => {
  test("embeds resolve to their source's url with the credential token stamped; images resolve to src", async () => {
    const screenId = await oneScreen();
    const profile = await cp.createCredentialProfile({
      name: "IdP",
      tokenEndpoint: "https://idp.test/token",
      clientId: "kiosk",
      clientSecret: "s3cret",
    });
    const dash = await cp.createContentSource({
      name: "KPI Wall",
      kind: "dashboard",
      url: "https://grafana.test/d/abc?kiosk",
      credentialProfileId: profile.id,
    });
    const logo = await cp.createContentSource({
      name: "Logo",
      kind: "image",
      url: "http://localhost:8080/media/logo",
    });
    if (!dash.ok || !logo.ok) throw new Error("create failed");

    cp.setTokenProvider({
      getToken: (id) => (id === profile.id ? "tok-123" : undefined),
      statusFor: () => ({ tokenStatus: "ok" as const }),
    });

    const page = await cp.createContentSource({
      name: "Composite",
      kind: "page",
      definition: definitionWith([
        { id: "em1", kind: "embed", x: 0, y: 0, w: 100, h: 78, props: { sourceId: dash.source.id } },
        { id: "em2", kind: "embed", x: 0, y: 78, w: 50, h: 10, props: { url: "https://raw.test/page" } },
        { id: "im1", kind: "image", x: 90, y: 90, w: 8, h: 8, props: { sourceId: logo.source.id, fit: "contain" } },
      ]),
    });
    if (!page.ok) throw new Error("create failed");
    const assigned = await cp.setScreenContent(screenId, { sourceId: page.source.id });
    if (!assigned.ok) throw new Error("assign failed");

    const decorated = cp.decorateSliceForSend(assigned.slice);
    const surface = decorated.surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    expect(surface.data?.embeds?.em1).toEqual({
      url: "https://grafana.test/d/abc?kiosk=&auth_token=tok-123",
      kind: "dashboard",
    });
    // A raw ad-hoc embed frames as web and NEVER gets credentials.
    expect(surface.data?.embeds?.em2).toEqual({ url: "https://raw.test/page", kind: "web" });
    expect(surface.data?.images?.im1).toEqual({ src: "http://localhost:8080/media/logo" });

    // The STORED slice is untouched — decorate returns a copy.
    const stored = cp.state.slices[screenId]!.surfaces[0]!;
    expect(stored.type === "page" && stored.data).toBeFalsy();
  });

  test("feed/weather data flows in from the page-data provider, keyed by element id", async () => {
    const screenId = await oneScreen();
    const page = await cp.createContentSource({
      name: "News",
      kind: "page",
      definition: definitionWith([
        { id: "f1", kind: "feed", x: 0, y: 0, w: 26, h: 42, props: { url: "feeds.example.test/rss", items: 4 } },
        { id: "w1", kind: "weather", x: 80, y: 0, w: 18, h: 13, props: { location: "Sheffield", units: "C" } },
      ]),
    });
    if (!page.ok) throw new Error("create failed");
    const assigned = await cp.setScreenContent(screenId, { sourceId: page.source.id });
    if (!assigned.ok) throw new Error("assign failed");

    cp.setPageDataProvider({
      feedFor: (url) =>
        url === "feeds.example.test/rss"
          ? { items: [{ title: "Headline" }], fetchedAt: "2026-07-11T10:00:00Z" }
          : undefined,
      weatherFor: (location) =>
        location === "Sheffield"
          ? { tempC: 18, code: 2, description: "partly cloudy", location: "Sheffield", fetchedAt: "2026-07-11T10:00:00Z" }
          : undefined,
    });

    const decorated = cp.decorateSliceForSend(cp.state.slices[screenId]!);
    const surface = decorated.surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    expect(surface.data?.feeds?.f1?.items[0]?.title).toBe("Headline");
    expect(surface.data?.weather?.w1?.tempC).toBe(18);
  });

  test("a dangling or page-kind embed resolves to nothing (placeholder on the wall)", async () => {
    const screenId = await oneScreen();
    const inner = await cp.createContentSource({ name: "Inner", kind: "page", definition: definitionWith([]) });
    if (!inner.ok) throw new Error("create failed");
    const page = await cp.createContentSource({
      name: "Outer",
      kind: "page",
      definition: definitionWith([
        { id: "gone", kind: "embed", x: 0, y: 0, w: 50, h: 50, props: { sourceId: "source-does-not-exist" } },
        { id: "nested", kind: "embed", x: 50, y: 0, w: 50, h: 50, props: { sourceId: inner.source.id } },
      ]),
    });
    if (!page.ok) throw new Error("create failed");
    const assigned = await cp.setScreenContent(screenId, { sourceId: page.source.id });
    if (!assigned.ok) throw new Error("assign failed");
    const decorated = cp.decorateSliceForSend(assigned.slice);
    const surface = decorated.surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    expect(surface.data?.embeds ?? {}).toEqual({});
  });
});

describe("live library semantics around pages", () => {
  test("editing a page's definition re-resolves and returns its screens' slices", async () => {
    const screenId = await oneScreen();
    const page = await cp.createContentSource({ name: "P", kind: "page", definition: definitionWith([]) });
    if (!page.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: page.source.id });

    const updated = await cp.updateContentSource(page.source.id, {
      definition: definitionWith([
        { id: "n1", kind: "text", x: 10, y: 10, w: 34, h: 10, props: { text: "Hello", size: 44, color: "#fff", align: "left" } },
      ]),
    });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.slices.map((s) => s.screenId)).toEqual([screenId]);
    const surface = updated.slices[0]!.surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    expect(surface.definition.elements[0]?.id).toBe("n1");
  });

  test("editing a source EMBEDDED by an on-air page re-pushes the page's slice without corrupting its assignment", async () => {
    const screenId = await oneScreen();
    const dash = await cp.createContentSource({ name: "D", kind: "dashboard", url: "https://g.test/1" });
    if (!dash.ok) throw new Error("create failed");
    const page = await cp.createContentSource({
      name: "P",
      kind: "page",
      definition: definitionWith([
        { id: "em", kind: "embed", x: 0, y: 0, w: 100, h: 100, props: { sourceId: dash.source.id } },
      ]),
    });
    if (!page.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: page.source.id });

    const updated = await cp.updateContentSource(dash.source.id, { url: "https://g.test/2" });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    expect(updated.slices.map((s) => s.screenId)).toEqual([screenId]);

    // The screen still shows the PAGE (send-time resolution picks the new url up).
    expect(cp.screenContentSummary(screenId)?.name).toBe("P");
    const decorated = cp.decorateSliceForSend(cp.state.slices[screenId]!);
    const surface = decorated.surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    expect(surface.data?.embeds?.em?.url).toBe("https://g.test/2");
  });

  test("deleting an embedded source re-pushes the page's slice; the embed resolves to nothing", async () => {
    const screenId = await oneScreen();
    const dash = await cp.createContentSource({ name: "D", kind: "dashboard", url: "https://g.test/1" });
    if (!dash.ok) throw new Error("create failed");
    const page = await cp.createContentSource({
      name: "P",
      kind: "page",
      definition: definitionWith([
        { id: "em", kind: "embed", x: 0, y: 0, w: 100, h: 100, props: { sourceId: dash.source.id } },
      ]),
    });
    if (!page.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: page.source.id });

    const deleted = await cp.deleteContentSource(dash.source.id);
    expect(deleted?.slices.map((s) => s.screenId)).toEqual([screenId]);
    // The page is still on air (only the embed inside it lost its target).
    const slice = cp.state.slices[screenId]!;
    expect(slice.surfaces[0]?.type).toBe("page");
    const decorated = cp.decorateSliceForSend(slice);
    const surface = decorated.surfaces[0]!;
    if (surface.type !== "page") throw new Error("expected a page surface");
    expect(surface.data?.embeds ?? {}).toEqual({});
  });

  test("pageDataRequirements covers only pages assigned to ≥1 screen", async () => {
    const screenId = await oneScreen();
    const assignedPage = await cp.createContentSource({
      name: "On air",
      kind: "page",
      definition: definitionWith([
        { id: "f1", kind: "feed", x: 0, y: 0, w: 26, h: 42, props: { url: "feeds.a.test/rss", items: 4 } },
        { id: "w1", kind: "weather", x: 80, y: 0, w: 18, h: 13, props: { location: "Sheffield", units: "C" } },
      ]),
    });
    const draftPage = await cp.createContentSource({
      name: "Draft",
      kind: "page",
      definition: definitionWith([
        { id: "f2", kind: "feed", x: 0, y: 0, w: 26, h: 42, props: { url: "feeds.b.test/rss", items: 4 } },
      ]),
    });
    if (!assignedPage.ok || !draftPage.ok) throw new Error("create failed");
    await cp.setScreenContent(screenId, { sourceId: assignedPage.source.id });

    const req = cp.pageDataRequirements();
    expect([...req.feeds]).toEqual(["feeds.a.test/rss"]);
    expect([...req.locations]).toEqual(["Sheffield"]);
    expect([...(req.sourcesByFeed.get("feeds.a.test/rss") ?? [])]).toEqual([assignedPage.source.id]);
    expect(cp.slicesShowingSources(new Set([assignedPage.source.id])).map((s) => s.screenId)).toEqual([screenId]);
  });
});
