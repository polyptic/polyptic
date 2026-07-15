/**
 * POL-133 — playlist step zoom: the D62 (target, content) model, one level down. A page playing as
 * a playlist STEP zooms per (screen, step source): the patch lands on the EXISTING surface (same id,
 * same startedAt — the rotation keeps its position), it is remembered across re-assignment and a
 * server restart, and the SAME source assigned directly to that screen shares the dialled-in value
 * (the pair identifies the content and the glass, not the route the content took).
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

/** The zoom of the entry resolved from `sourceId`, or throws. */
function entryZoom(cp: ControlPlane, screenId: string, sourceId: string): number | undefined {
  const entry = playlistOn(cp, screenId).items.find((e) => e.sourceId === sourceId);
  if (!entry) throw new Error(`no entry for ${sourceId}`);
  return entry.zoom;
}

let store: MemoryStore;
let cp: ControlPlane;

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

/** A dashboard + an image in the library, composed into a playlist; returns the ids. */
async function seed(): Promise<{ dash: string; image: string; playlist: string }> {
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
  if (!dash.ok || !image.ok) throw new Error("library seed failed");
  const playlist = await cp.createContentSource({
    name: "Lobby rotation",
    kind: "playlist",
    items: [
      { sourceId: dash.source.id, durationSeconds: 30 },
      { sourceId: image.source.id, durationSeconds: 20 },
    ],
  });
  if (!playlist.ok) throw new Error("playlist seed failed");
  return { dash: dash.source.id, image: image.source.id, playlist: playlist.source.id };
}

async function oneScreen(): Promise<string> {
  await cp.registerMachine(hello("m1", "HDMI-1"));
  return cp.getScreens()[0]!.id;
}

describe("playlist step zoom (POL-133)", () => {
  test("a playlist lands with every step unzoomed (100%)", async () => {
    const { dash, image, playlist } = await seed();
    const screenId = await oneScreen();
    await cp.setScreenContent(screenId, { sourceId: playlist });
    expect(entryZoom(cp, screenId, dash)).toBe(1);
    expect(entryZoom(cp, screenId, image)).toBe(1);
  });

  test("zooming a framed step patches the SAME surface — same id, same startedAt (no rotation restart)", async () => {
    const { dash, playlist } = await seed();
    const screenId = await oneScreen();
    await cp.setScreenContent(screenId, { sourceId: playlist });
    const before = playlistOn(cp, screenId);

    const result = await cp.setScreenPlaylistEntryZoom(screenId, dash, 1.5);
    expect(result.ok).toBe(true);

    const after = playlistOn(cp, screenId);
    expect(after.id).toBe(before.id);
    expect(after.startedAt).toBe(before.startedAt); // rotation identity untouched
    expect(entryZoom(cp, screenId, dash)).toBe(1.5);
    expect(cp.state.revision).toBeGreaterThan(0);
  });

  test("a media step cannot be zoomed (unknown-entry) and other steps are untouched", async () => {
    const { dash, image, playlist } = await seed();
    const screenId = await oneScreen();
    await cp.setScreenContent(screenId, { sourceId: playlist });

    const media = await cp.setScreenPlaylistEntryZoom(screenId, image, 2);
    expect(media.ok).toBe(false);
    if (!media.ok) expect(media.error).toBe("unknown-entry");

    await cp.setScreenPlaylistEntryZoom(screenId, dash, 2);
    expect(entryZoom(cp, screenId, image)).toBe(1);
  });

  test("a screen showing a NON-playlist refuses (not-zoomable); nothing on air refuses (no-content)", async () => {
    const { dash } = await seed();
    const screenId = await oneScreen();

    const empty = await cp.setScreenPlaylistEntryZoom(screenId, dash, 2);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.error).toBe("no-content");

    await cp.setScreenContent(screenId, { url: "https://example.test/page" });
    const direct = await cp.setScreenPlaylistEntryZoom(screenId, dash, 2);
    expect(direct.ok).toBe(false);
    if (!direct.ok) expect(direct.error).toBe("not-zoomable");
  });

  test("the zoom is remembered per (screen, step) and restored when the playlist is re-assigned", async () => {
    const { dash, playlist } = await seed();
    const screenId = await oneScreen();
    await cp.setScreenContent(screenId, { sourceId: playlist });
    await cp.setScreenPlaylistEntryZoom(screenId, dash, 1.25);

    // Show something else, then bring the playlist back — the step returns dialled in.
    await cp.setScreenContent(screenId, { url: "https://example.test/other" });
    await cp.setScreenContent(screenId, { sourceId: playlist });
    expect(entryZoom(cp, screenId, dash)).toBe(1.25);
  });

  test("…and only on THAT screen — a second screen shows the same step at 100%", async () => {
    const { dash, playlist } = await seed();
    await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
    const [a, b] = cp.getScreens().map((s) => s.id);
    await cp.setScreenContent(a!, { sourceId: playlist });
    await cp.setScreenContent(b!, { sourceId: playlist });

    await cp.setScreenPlaylistEntryZoom(a!, dash, 2);
    expect(entryZoom(cp, a!, dash)).toBe(2);
    expect(entryZoom(cp, b!, dash)).toBe(1);
  });

  test("the step zoom survives a server RESTART (persisted slice + persisted preference)", async () => {
    const { dash, playlist } = await seed();
    const screenId = await oneScreen();
    await cp.setScreenContent(screenId, { sourceId: playlist });
    await cp.setScreenPlaylistEntryZoom(screenId, dash, 1.75);

    // A new ControlPlane over the SAME store is a restart.
    const cp2 = new ControlPlane(store);
    await cp2.init();
    expect(entryZoom(cp2, screenId, dash)).toBe(1.75);

    // And the preference itself survives re-assignment after the restart too.
    await cp2.setScreenContent(screenId, { url: "https://example.test/other" });
    await cp2.setScreenContent(screenId, { sourceId: playlist });
    expect(entryZoom(cp2, screenId, dash)).toBe(1.75);
  });

  test("the D62 pair is the content, not the route: a direct assignment of the step shares the zoom", async () => {
    const { dash, playlist } = await seed();
    const screenId = await oneScreen();
    await cp.setScreenContent(screenId, { sourceId: playlist });
    await cp.setScreenPlaylistEntryZoom(screenId, dash, 1.5);

    // Assign the SAME dashboard source directly — same (screen, source) pair, same zoom.
    await cp.setScreenContent(screenId, { sourceId: dash });
    const surface = cp.state.slices[screenId]!.surfaces[0]!;
    expect(surface.type).toBe("dashboard");
    if (surface.type === "dashboard") expect(surface.zoom).toBe(1.5);
  });

  test("editing a referenced source re-resolves the playlist WITHOUT losing the step zoom", async () => {
    const { dash, playlist } = await seed();
    const screenId = await oneScreen();
    await cp.setScreenContent(screenId, { sourceId: playlist });
    await cp.setScreenPlaylistEntryZoom(screenId, dash, 2);

    // Re-point the dashboard at a new URL — the ripple re-resolves the rotation on the glass.
    const updated = await cp.updateContentSource(dash, { url: "https://grafana.test/d/xyz" });
    expect(updated.ok).toBe(true);
    const entry = playlistOn(cp, screenId).items.find((e) => e.sourceId === dash);
    expect(entry?.url).toBe("https://grafana.test/d/xyz");
    expect(entry?.zoom).toBe(2); // keyed on the source ID, so the new URL keeps the zoom (D62)
  });

  test("the console read-out carries the steps with their live zooms", async () => {
    const { dash, image, playlist } = await seed();
    const screenId = await oneScreen();
    await cp.setScreenContent(screenId, { sourceId: playlist });
    await cp.setScreenPlaylistEntryZoom(screenId, dash, 1.25);

    const summary = cp.screenContentSummary(screenId);
    expect(summary?.kind).toBe("playlist");
    expect(summary?.entries).toEqual([
      { sourceId: dash, name: "Grafana", kind: "dashboard", zoom: 1.25 },
      { sourceId: image, name: "Poster", kind: "image" },
    ]);
  });

  test("a wall member defers to the wall; the wall re-stamps the step on EVERY member", async () => {
    const { dash, playlist } = await seed();
    await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
    const [a, b] = cp.getScreens().map((s) => s.id);
    const mural = await cp.createMural("Atrium");
    await cp.placeScreen(a!, mural.id, 0, 0, 1920, 1080);
    await cp.placeScreen(b!, mural.id, 1920, 0, 1920, 1080);
    const combined = await cp.combineScreens(mural.id, [a!, b!]);
    if (!combined.ok) throw new Error("combine failed");
    await cp.setWallContent(combined.wall.id, { sourceId: playlist });

    const member = await cp.setScreenPlaylistEntryZoom(a!, dash, 2);
    expect(member.ok).toBe(false);
    if (!member.ok) expect(member.error).toBe("wall-member");

    const result = await cp.setWallPlaylistEntryZoom(combined.wall.id, dash, 1.5);
    expect(result.ok).toBe(true);
    expect(entryZoom(cp, a!, dash)).toBe(1.5);
    expect(entryZoom(cp, b!, dash)).toBe(1.5);

    // …and a wall re-assignment restores it on every member.
    await cp.setWallContent(combined.wall.id, { url: "https://example.test/other" });
    await cp.setWallContent(combined.wall.id, { sourceId: playlist });
    expect(entryZoom(cp, a!, dash)).toBe(1.5);
    expect(entryZoom(cp, b!, dash)).toBe(1.5);
  });
});
