/**
 * POL-34 — playlists: carousels of content, first-class in the library.
 *
 * These drive `ControlPlane` directly against the `MemoryStore` (no server/WS). They pin the model's
 * load-bearing claims: a playlist RESOLVES to one PlaylistSurface carrying the whole rotation (the
 * player advances it locally); authoring is validated (no nesting, no unknown steps, statics must be
 * timed); library edits and deletions RIPPLE through playlists onto the glass; and send-time auth
 * stamping works per ENTRY, since each step carries its own source's credential profile.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output, Surface } from "@polyptic/protocol";
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

/** The playlist surface on a screen, or throws — most tests want exactly that shape. */
function playlistOn(cp: ControlPlane, screenId: string) {
  const surface: Surface | undefined = cp.state.slices[screenId]?.surfaces[0];
  if (!surface || surface.type !== "playlist") {
    throw new Error(`expected a playlist surface on ${screenId}, got ${surface?.type}`);
  }
  return surface;
}

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

/** A dashboard + an image + a video in the library, ready to be composed into playlists. */
async function threeSources(): Promise<{ dash: string; image: string; video: string }> {
  const dash = await cp.createContentSource({
    name: "Grafana",
    kind: "dashboard",
    url: "https://grafana.test/d/abc",
  });
  const image = await cp.createContentSource({
    name: "Poster",
    kind: "image",
    url: "https://media.test/poster.png",
  });
  const video = await cp.createContentSource({
    name: "Promo",
    kind: "video",
    url: "https://media.test/promo.mp4",
  });
  if (!dash.ok || !image.ok || !video.ok) throw new Error("library seed failed");
  return { dash: dash.source.id, image: image.source.id, video: video.source.id };
}

describe("playlist authoring (POL-34)", () => {
  test("a valid playlist lands in the library with its steps in order", async () => {
    const { dash, video } = await threeSources();
    const created = await cp.createContentSource({
      name: "Lobby rotation",
      kind: "playlist",
      items: [{ sourceId: dash, durationSeconds: 30 }, { sourceId: video }],
    });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.source.kind).toBe("playlist");
    expect(created.source.url).toBeUndefined();
    expect(created.source.items).toEqual([
      { sourceId: dash, durationSeconds: 30 },
      { sourceId: video },
    ]);
  });

  test("a step referencing an unknown source is rejected", async () => {
    const result = await cp.createContentSource({
      name: "Broken",
      kind: "playlist",
      items: [{ sourceId: "source-999", durationSeconds: 10 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("unknown-item-source");
    expect(result.itemSourceId).toBe("source-999");
  });

  test("playlists cannot nest", async () => {
    const { dash } = await threeSources();
    const inner = await cp.createContentSource({
      name: "Inner",
      kind: "playlist",
      items: [{ sourceId: dash, durationSeconds: 10 }],
    });
    if (!inner.ok) throw new Error("seed failed");
    const outer = await cp.createContentSource({
      name: "Outer",
      kind: "playlist",
      items: [{ sourceId: inner.source.id, durationSeconds: 10 }],
    });
    expect(outer.ok).toBe(false);
    if (outer.ok) return;
    expect(outer.error).toBe("nested-playlist");
  });

  test("a non-video step without a duration is rejected — statics are always timed", async () => {
    const { image } = await threeSources();
    const result = await cp.createContentSource({
      name: "Untimed",
      kind: "playlist",
      items: [{ sourceId: image }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("item-needs-duration");
  });

  test("updating a playlist's items is validated the same way", async () => {
    const { dash, image } = await threeSources();
    const created = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [{ sourceId: dash, durationSeconds: 20 }],
    });
    if (!created.ok) throw new Error("seed failed");
    const bad = await cp.updateContentSource(created.source.id, { items: [{ sourceId: image }] });
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error).toBe("item-needs-duration");
  });
});

describe("playlist resolution (POL-34)", () => {
  test("assigning a playlist ships ONE surface carrying the whole resolved rotation", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens()[0]!;
    const { dash, video } = await threeSources();
    const created = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [{ sourceId: dash, durationSeconds: 45 }, { sourceId: video }],
    });
    if (!created.ok) throw new Error("seed failed");

    const result = await cp.setScreenContent(screen.id, { sourceId: created.source.id });
    expect(result.ok).toBe(true);

    const surface = playlistOn(cp, screen.id);
    expect(surface.items).toEqual([
      { kind: "dashboard", url: "https://grafana.test/d/abc", durationSeconds: 45, sourceId: dash },
      { kind: "video", url: "https://media.test/promo.mp4", sourceId: video }, // untimed: plays out
    ]);
    // The rotation anchor is a real instant (wall members + reboots derive their phase from it).
    expect(Number.isFinite(Date.parse(surface.startedAt))).toBe(true);

    // The console reads this as the library source it is — and offers no zoom (not one page).
    const summary = cp.screenContentSummary(screen.id);
    expect(summary).toEqual({ name: "Rotation", kind: "playlist", zoom: undefined });
  });

  test("a playlist SPANS a video wall: every member carries the same rotation and anchor", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
    const [a, b] = cp.getScreens();
    const mural = await cp.createMural("Atrium");
    await cp.placeScreen(a!.id, mural.id, 0, 0, 1920, 1080);
    await cp.placeScreen(b!.id, mural.id, 1920, 0, 1920, 1080);
    const combined = await cp.combineScreens(mural.id, [a!.id, b!.id]);
    if (!combined.ok) throw new Error("combine failed");

    const { dash, image } = await threeSources();
    const created = await cp.createContentSource({
      name: "Wall rotation",
      kind: "playlist",
      items: [
        { sourceId: dash, durationSeconds: 30 },
        { sourceId: image, durationSeconds: 10 },
      ],
    });
    if (!created.ok) throw new Error("seed failed");

    const result = await cp.setWallContent(combined.wall.id, { sourceId: created.source.id });
    expect(result.ok).toBe(true);

    const left = playlistOn(cp, a!.id);
    const right = playlistOn(cp, b!.id);
    expect(left.items).toEqual(right.items);
    // One anchor for the whole wall — the members derive the SAME phase without talking.
    expect(left.startedAt).toBe(right.startedAt);
    expect(left.span).toEqual({ contentW: 3840, contentH: 1080, offsetX: 0, offsetY: 0 });
    expect(right.span).toEqual({ contentW: 3840, contentH: 1080, offsetX: 1920, offsetY: 0 });
  });

  test("zoom is refused on a playlist — it is not one page", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens()[0]!;
    const { dash } = await threeSources();
    const created = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [{ sourceId: dash, durationSeconds: 30 }],
    });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen.id, { sourceId: created.source.id });

    const result = await cp.setScreenZoom(screen.id, 1.5);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("not-zoomable");
  });
});

describe("library edits ripple through playlists (POL-34)", () => {
  test("editing a referenced source's url re-resolves every screen showing a playlist with it", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens()[0]!;
    const { dash, image } = await threeSources();
    const created = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [
        { sourceId: dash, durationSeconds: 30 },
        { sourceId: image, durationSeconds: 10 },
      ],
    });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen.id, { sourceId: created.source.id });
    const revBefore = cp.state.revision;

    const updated = await cp.updateContentSource(dash, { url: "https://grafana.test/d/NEW" });
    expect(updated.ok).toBe(true);
    if (!updated.ok) return;
    // The touched slice is returned for the caller to push — the instant path.
    expect(updated.slices.map((s) => s.screenId)).toContain(screen.id);
    expect(cp.state.revision).toBeGreaterThan(revBefore);

    const surface = playlistOn(cp, screen.id);
    expect(surface.items[0]!.url).toBe("https://grafana.test/d/NEW");
  });

  test("deleting a referenced source strips it from the rotation on the glass", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens()[0]!;
    const { dash, image } = await threeSources();
    const created = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [
        { sourceId: dash, durationSeconds: 30 },
        { sourceId: image, durationSeconds: 10 },
      ],
    });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen.id, { sourceId: created.source.id });

    const result = await cp.deleteContentSource(image);
    expect(result).not.toBeNull();
    expect(result!.slices.map((s) => s.screenId)).toContain(screen.id);

    // The playlist itself shrank …
    expect(cp.getContentSource(created.source.id)?.items).toEqual([
      { sourceId: dash, durationSeconds: 30 },
    ]);
    // … and so did the rotation on air. The screen still shows the playlist (assignment intact).
    const surface = playlistOn(cp, screen.id);
    expect(surface.items).toHaveLength(1);
    expect(surface.items[0]!.sourceId).toBe(dash);
  });

  test("deleting EVERY referenced source leaves an empty rotation, not a stale one", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens()[0]!;
    const { dash } = await threeSources();
    const created = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [{ sourceId: dash, durationSeconds: 30 }],
    });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen.id, { sourceId: created.source.id });

    await cp.deleteContentSource(dash);
    expect(playlistOn(cp, screen.id).items).toHaveLength(0);
  });

  test("deleting the playlist itself clears the screen", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens()[0]!;
    const { dash } = await threeSources();
    const created = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [{ sourceId: dash, durationSeconds: 30 }],
    });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen.id, { sourceId: created.source.id });

    const result = await cp.deleteContentSource(created.source.id);
    expect(result!.slices.map((s) => s.screenId)).toContain(screen.id);
    expect(cp.state.slices[screen.id]!.surfaces).toHaveLength(0);
  });

  test("a playlist survives a restart (persistence roundtrip incl. its on-air surface)", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens()[0]!;
    const { dash, video } = await threeSources();
    const created = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [{ sourceId: dash, durationSeconds: 30 }, { sourceId: video }],
    });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen.id, { sourceId: created.source.id });
    const before = playlistOn(cp, screen.id);

    const reborn = new ControlPlane(store);
    await reborn.init();

    const source = reborn.getContentSource(created.source.id);
    expect(source?.kind).toBe("playlist");
    expect(source?.items).toEqual(created.source.items!);
    // The stored slice — including the rotation anchor — reloads verbatim, so a server restart does
    // not restart every wall's carousel.
    const after = playlistOn(reborn, screen.id);
    expect(after.items).toEqual(before.items);
    expect(after.startedAt).toBe(before.startedAt);
  });
});

describe("send-time auth stamping per entry (POL-24 × POL-34)", () => {
  test("each entry stamps ITS OWN source's profile token; the stored slice keeps clean urls", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const screen = cp.getScreens()[0]!;

    const profile = await cp.createCredentialProfile({
      name: "IdP",
      tokenEndpoint: "https://idp.test/token",
      clientId: "kiosk",
      clientSecret: "s3cret",
    });
    const authed = await cp.createContentSource({
      name: "Protected dash",
      kind: "dashboard",
      url: "https://grafana.test/d/abc",
      credentialProfileId: profile.id,
    });
    const open = await cp.createContentSource({
      name: "Public page",
      kind: "web",
      url: "https://example.test/open",
    });
    if (!authed.ok || !open.ok) throw new Error("seed failed");

    const created = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [
        { sourceId: authed.source.id, durationSeconds: 30 },
        { sourceId: open.source.id, durationSeconds: 30 },
      ],
    });
    if (!created.ok) throw new Error("seed failed");
    await cp.setScreenContent(screen.id, { sourceId: created.source.id });

    cp.setTokenProvider({
      getToken: (id) => (id === profile.id ? "tok-123" : undefined),
      statusFor: () => ({ tokenStatus: "ok" }),
    });

    const sent = cp.decorateSliceForSend(cp.state.slices[screen.id]!);
    const sentSurface = sent.surfaces[0]!;
    if (sentSurface.type !== "playlist") throw new Error("expected playlist");
    expect(sentSurface.items[0]!.url).toBe("https://grafana.test/d/abc?auth_token=tok-123");
    expect(sentSurface.items[1]!.url).toBe("https://example.test/open"); // no profile, untouched

    // Stored state never carries a token (same rule as direct sources).
    expect(playlistOn(cp, screen.id).items[0]!.url).toBe("https://grafana.test/d/abc");

    // The token-usable edge knows this screen needs a re-push, via the playlist step.
    expect(cp.screenIdsUsingProfile(profile.id)).toContain(screen.id);
  });
});
