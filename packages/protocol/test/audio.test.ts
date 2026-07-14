/**
 * POL-112 — the audio contract itself.
 *
 * Every cross-process message is defined here and parsed at the edge, so the safe posture has to be
 * baked into the SCHEMA, not into the components that read it: a payload that says nothing about
 * audio must decode to silence, and a volume outside 0–1 must not reach a wall at all.
 */
import { describe, expect, test } from "bun:test";

import { PlaylistSurface, SetAudioBody, VideoSurface, Volume } from "../src/index";

const region = { x: 0, y: 0, w: 1920, h: 1080 };

describe("VideoSurface audio", () => {
  test("defaults to MUTED at full level — an audio-less payload is silent, never loud", () => {
    const surface = VideoSurface.parse({
      id: "content-web",
      region,
      type: "video",
      src: "https://cdn.test/a.mp4",
    });
    expect(surface.muted).toBe(true);
    expect(surface.volume).toBe(1);
  });

  test("carries an explicit intent through", () => {
    const surface = VideoSurface.parse({
      id: "content-web",
      region,
      type: "video",
      src: "https://cdn.test/a.mp4",
      muted: false,
      volume: 0.35,
    });
    expect(surface.muted).toBe(false);
    expect(surface.volume).toBe(0.35);
  });

  test("a volume outside 0–1 is rejected at the edge", () => {
    const bad = { id: "s", region, type: "video", src: "https://cdn.test/a.mp4", volume: 1.5 };
    expect(VideoSurface.safeParse(bad).success).toBe(false);
    expect(VideoSurface.safeParse({ ...bad, volume: -0.1 }).success).toBe(false);
  });
});

describe("PlaylistSurface audio", () => {
  test("a rotation carries ONE audio intent, muted by default", () => {
    const surface = PlaylistSurface.parse({
      id: "content-web",
      region,
      type: "playlist",
      items: [{ kind: "video", url: "https://cdn.test/a.mp4" }],
      startedAt: "2026-07-14T00:00:00.000Z",
    });
    expect(surface.muted).toBe(true);
    expect(surface.volume).toBe(1);
  });
});

describe("SetAudioBody", () => {
  test("both halves always travel together", () => {
    expect(SetAudioBody.parse({ muted: false, volume: 0.5 })).toEqual({ muted: false, volume: 0.5 });
    expect(SetAudioBody.safeParse({ muted: false }).success).toBe(false);
    expect(SetAudioBody.safeParse({ volume: 0.5 }).success).toBe(false);
  });

  test("Volume bounds are the contract, not a UI convention", () => {
    expect(Volume.safeParse(0).success).toBe(true);
    expect(Volume.safeParse(1).success).toBe(true);
    expect(Volume.safeParse(1.01).success).toBe(false);
  });
});
