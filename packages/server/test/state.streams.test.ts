/**
 * POL-108 — the live-stream (`stream`) content kind, server side.
 *
 * These pin the contract the player leans on: a stream source resolves to ONE StreamSurface carrying
 * the playlist url + the transport enum (the vendor-neutral seam — RTSP is restreamed OUTSIDE the
 * control plane, so no vendor ever reaches core code); it SPANS a video wall like any other content,
 * because a NOC's 2×2 of one feed is the whole point; and it is refused where it cannot work — as a
 * playlist step (a rotation over a never-ending feed) and as a page embed (an iframe cannot mount an
 * MSE pipeline). A drifted authoring must fail LOUDLY at the API, not silently on the glass.
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

function streamOn(cp: ControlPlane, screenId: string) {
  const surface: Surface | undefined = cp.state.slices[screenId]?.surfaces[0];
  if (!surface || surface.type !== "stream") {
    throw new Error(`expected a stream surface on ${screenId}, got ${surface?.type}`);
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

const CAM = "https://restream.test/cam-1/index.m3u8";

async function camSource(name = "Loading bay camera"): Promise<string> {
  const created = await cp.createContentSource({ name, kind: "stream", url: CAM });
  if (!created.ok) throw new Error("seed failed");
  return created.source.id;
}

describe("live streams (POL-108)", () => {
  test("a stream source resolves to a StreamSurface with the HLS transport", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const [screen] = cp.getScreens();
    const id = await camSource();

    const result = await cp.setScreenContent(screen!.id, { sourceId: id });
    expect(result.ok).toBe(true);

    const surface = streamOn(cp, screen!.id);
    expect(surface.url).toBe(CAM);
    expect(surface.protocol).toBe("hls"); // the seam: whep is declared, hls is what ships
    expect(surface.muted).toBe(true); // a wall is silent unless someone asks otherwise

    // The console reads it as the library source it is, and offers no zoom (there is no page to zoom).
    expect(cp.screenContentSummary(screen!.id)).toEqual({
      name: "Loading bay camera",
      kind: "stream",
      zoom: undefined,
    });
  });

  test("a stream SPANS a video wall — one feed across combined screens", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
    const [a, b] = cp.getScreens();
    const mural = await cp.createMural("NOC");
    await cp.placeScreen(a!.id, mural.id, 0, 0, 1920, 1080);
    await cp.placeScreen(b!.id, mural.id, 1920, 0, 1920, 1080);
    const combined = await cp.combineScreens(mural.id, [a!.id, b!.id]);
    if (!combined.ok) throw new Error("combine failed");

    const id = await camSource();
    expect((await cp.setWallContent(combined.wall.id, { sourceId: id })).ok).toBe(true);

    const left = streamOn(cp, a!.id);
    const right = streamOn(cp, b!.id);
    expect(left.url).toBe(CAM);
    expect(right.url).toBe(CAM);
    expect(left.span).toEqual({ contentW: 3840, contentH: 1080, offsetX: 0, offsetY: 0 });
    expect(right.span).toEqual({ contentW: 3840, contentH: 1080, offsetX: 1920, offsetY: 0 });
  });

  test("a live stream cannot be a playlist step — it is rejected, not silently dropped", async () => {
    const cam = await camSource();
    const result = await cp.createContentSource({
      name: "Rotation with a camera in it",
      kind: "playlist",
      items: [{ sourceId: cam, durationSeconds: 20 }],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("live-stream-step");
    expect(result.itemSourceId).toBe(cam);
  });

  test("an existing playlist cannot be UPDATED to contain a live stream either", async () => {
    const cam = await camSource();
    const image = await cp.createContentSource({
      name: "Poster",
      kind: "image",
      url: "https://media.test/poster.png",
    });
    if (!image.ok) throw new Error("seed failed");
    const playlist = await cp.createContentSource({
      name: "Rotation",
      kind: "playlist",
      items: [{ sourceId: image.source.id, durationSeconds: 10 }],
    });
    if (!playlist.ok) throw new Error("seed failed");

    const updated = await cp.updateContentSource(playlist.source.id, {
      items: [{ sourceId: cam, durationSeconds: 10 }],
    });
    expect(updated.ok).toBe(false);
    if (updated.ok) return;
    expect(updated.error).toBe("live-stream-step");
  });

  test("a page embed pointed at a stream resolves to nothing — an iframe cannot mount MSE", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const [screen] = cp.getScreens();
    const cam = await camSource();
    const page = await cp.createContentSource({
      name: "Composed page",
      kind: "page",
      definition: {
        aspect: "16:9",
        bg: "#0b0b0e",
        elements: [
          {
            id: "el-1",
            kind: "embed",
            x: 0,
            y: 0,
            w: 100,
            h: 100,
            props: { sourceId: cam },
          },
        ],
      },
    });
    if (!page.ok) throw new Error("seed failed");
    expect((await cp.setScreenContent(screen!.id, { sourceId: page.source.id })).ok).toBe(true);

    const slice = cp.decorateSliceForSend(cp.state.slices[screen!.id]!);
    const surface = slice.surfaces[0];
    if (!surface || surface.type !== "page") throw new Error("expected a page surface");
    // The embed resolves to nothing at all, so the element paints its own placeholder rather than
    // framing an .m3u8 URL Chrome would render as a download prompt / blank frame.
    expect(surface.data?.embeds).toBeUndefined();
  });

  test("a scene snapshot captures a screen showing a stream", async () => {
    await cp.registerMachine(hello("m1", "HDMI-1"));
    const [screen] = cp.getScreens();
    const mural = await cp.createMural("NOC");
    await cp.placeScreen(screen!.id, mural.id, 0, 0, 1920, 1080);
    const cam = await camSource();
    expect((await cp.setScreenContent(screen!.id, { sourceId: cam })).ok).toBe(true);

    const scene = await cp.snapshotScene("Cameras", mural.id);
    expect(scene?.screens).toEqual([{ screenId: screen!.id, content: { sourceId: cam } }]);

    // The operator puts something else on the screen; re-applying the scene brings the feed back.
    expect((await cp.setScreenContent(screen!.id, { url: "https://elsewhere.test/" })).ok).toBe(true);
    expect(await cp.applyScene(scene!.id)).not.toBeNull();
    expect(streamOn(cp, screen!.id).url).toBe(CAM);
  });
});
