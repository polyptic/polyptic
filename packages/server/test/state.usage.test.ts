/**
 * POL-94 — the library's USAGE fold: for every source, everything in desired state that references it.
 *
 * This is what turns the content library from a pile into an inventory, and it is what lets a delete
 * confirmation say "this will clear 2 screens and remove a step from 1 playlist" instead of the old,
 * true-but-useless "any screen currently showing it will be cleared". The claims worth pinning are
 * the ones an operator would be burned by if we got them wrong: a reference hiding in a playlist step
 * or a page element counts; a video wall counts as ONE wall (not as its member screens); and the fold
 * keeps up with every mutation — assign, reassign, split, delete.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output } from "@polyptic/protocol";
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

let store: MemoryStore;
let cp: ControlPlane;

/** Three screens on one machine, placed side by side on a mural (so two can be combined). */
async function threeScreens(): Promise<{ a: string; b: string; c: string; muralId: string }> {
  await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2", "HDMI-3"));
  const [a, b, c] = cp.getScreens();
  const mural = await cp.createMural("Atrium");
  await cp.placeScreen(a!.id, mural.id, 0, 0, 1920, 1080);
  await cp.placeScreen(b!.id, mural.id, 1920, 0, 1920, 1080);
  await cp.placeScreen(c!.id, mural.id, 3840, 0, 1920, 1080);
  return { a: a!.id, b: b!.id, c: c!.id, muralId: mural.id };
}

async function source(name: string, url: string): Promise<string> {
  const created = await cp.createContentSource({ name, kind: "dashboard", url });
  if (!created.ok) throw new Error(`seed failed: ${created.error}`);
  return created.source.id;
}

/** The usage entry for one source (throws when the library doesn't know it — a test bug, not a case). */
function usageOf(sourceId: string) {
  const entry = cp.getContentSourceUsage().find((u) => u.sourceId === sourceId);
  if (!entry) throw new Error(`no usage entry for ${sourceId}`);
  return entry;
}

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("content-source usage (POL-94)", () => {
  test("every library source has an entry, and an unused one is used nowhere", async () => {
    const id = await source("Grafana", "https://grafana.test/d/abc");
    expect(cp.getContentSourceUsage().map((u) => u.sourceId)).toEqual([id]);
    expect(usageOf(id)).toEqual({
      sourceId: id,
      screenIds: [],
      wallIds: [],
      playlistIds: [],
      pageIds: [],
    });
  });

  test("a source assigned to screens lists exactly those screens", async () => {
    const { a, b, c } = await threeScreens();
    const dash = await source("Grafana", "https://grafana.test/d/abc");
    const other = await source("Status", "https://status.test/");

    await cp.setScreenContent(a, { sourceId: dash });
    await cp.setScreenContent(b, { sourceId: dash });
    await cp.setScreenContent(c, { sourceId: other });

    expect(usageOf(dash).screenIds.sort()).toEqual([a, b].sort());
    expect(usageOf(other).screenIds).toEqual([c]);
  });

  test("an ad-hoc URL is not a library reference — it uses no source", async () => {
    const { a } = await threeScreens();
    const dash = await source("Grafana", "https://grafana.test/d/abc");
    await cp.setScreenContent(a, { url: "https://ad-hoc.test/page" });
    expect(usageOf(dash).screenIds).toEqual([]);
  });

  test("a video wall counts as ONE wall, not as its member screens", async () => {
    const { a, b, muralId } = await threeScreens();
    const dash = await source("Grafana", "https://grafana.test/d/abc");
    const wall = await cp.combineScreens(muralId, [a, b], "Atrium Wall");
    if (!wall.ok) throw new Error("combine failed");
    await cp.setWallContent(wall.wall.id, { sourceId: dash });

    // The operator assigned content to a WALL; telling them "used on 2 screens" would be a lie of shape.
    expect(usageOf(dash).wallIds).toEqual([wall.wall.id]);
    expect(usageOf(dash).screenIds).toEqual([]);
  });

  test("a playlist step counts, and a source used twice in one playlist is listed once", async () => {
    const dash = await source("Grafana", "https://grafana.test/d/abc");
    const created = await cp.createContentSource({
      name: "Lobby rotation",
      kind: "playlist",
      items: [
        { sourceId: dash, durationSeconds: 30 },
        { sourceId: dash, durationSeconds: 15 },
      ],
    });
    if (!created.ok) throw new Error("playlist seed failed");

    expect(usageOf(dash).playlistIds).toEqual([created.source.id]);
  });

  test("a page that embeds a source counts it, once per page", async () => {
    const dash = await source("Grafana", "https://grafana.test/d/abc");
    const created = await cp.createContentSource({
      name: "Reception board",
      kind: "page",
      definition: {
        aspect: "16:9",
        background: "#101014",
        elements: [
          { id: "e1", kind: "embed", x: 0, y: 0, w: 50, h: 50, props: { sourceId: dash } },
          { id: "e2", kind: "embed", x: 50, y: 0, w: 50, h: 50, props: { sourceId: dash } },
          { id: "e3", kind: "text", x: 0, y: 60, w: 40, h: 10, props: { text: "Hello" } },
        ],
      },
    });
    if (!created.ok) throw new Error("page seed failed");

    expect(usageOf(dash).pageIds).toEqual([created.source.id]);
    // The page itself is a library source too — and it is used nowhere yet.
    expect(usageOf(created.source.id).screenIds).toEqual([]);
  });

  test("the fold keeps up: reassigning a screen moves the reference", async () => {
    const { a } = await threeScreens();
    const first = await source("Grafana", "https://grafana.test/d/abc");
    const second = await source("Status", "https://status.test/");

    await cp.setScreenContent(a, { sourceId: first });
    expect(usageOf(first).screenIds).toEqual([a]);

    await cp.setScreenContent(a, { sourceId: second });
    expect(usageOf(first).screenIds).toEqual([]);
    expect(usageOf(second).screenIds).toEqual([a]);
  });

  test("deleting a referenced source strips it out of the playlists that used it", async () => {
    const dash = await source("Grafana", "https://grafana.test/d/abc");
    const video = await cp.createContentSource({
      name: "Promo",
      kind: "video",
      url: "https://media.test/promo.mp4",
    });
    if (!video.ok) throw new Error("seed failed");
    const playlist = await cp.createContentSource({
      name: "Lobby rotation",
      kind: "playlist",
      items: [{ sourceId: dash, durationSeconds: 30 }, { sourceId: video.source.id }],
    });
    if (!playlist.ok) throw new Error("playlist seed failed");
    expect(usageOf(video.source.id).playlistIds).toEqual([playlist.source.id]);

    await cp.deleteContentSource(dash);

    // The deleted source has no entry at all now, and the survivor's usage is unchanged.
    expect(cp.getContentSourceUsage().some((u) => u.sourceId === dash)).toBe(false);
    expect(usageOf(video.source.id).playlistIds).toEqual([playlist.source.id]);
  });
});
