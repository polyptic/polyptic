/**
 * POL-112 — the player's audio rules.
 *
 * The hardcode this ticket deleted lived in PlaylistRotator (`muted` as a literal attribute), which
 * made the protocol's flag decorative. These pin what replaced it: the wire is the whole truth, the
 * default is silence, and an unmuted autoplay a browser refuses degrades to MUTED PLAYBACK rather
 * than to a frozen wall.
 */
import { describe, expect, test } from "bun:test";
import type { Surface } from "@polyptic/protocol";

import { applyAudio, clampVolume, ensurePlaying, surfaceAudio, type MediaElementLike } from "../src/audio";

const region = { x: 0, y: 0, w: 1920, h: 1080 };

function video(muted: boolean, volume: number): Surface {
  return { id: "content-web", region, type: "video", src: "https://cdn.test/a.mp4", loop: true, muted, volume };
}
function playlist(muted: boolean, volume: number): Surface {
  return {
    id: "content-web",
    region,
    type: "playlist",
    items: [{ kind: "video", url: "https://cdn.test/a.mp4" }],
    startedAt: new Date().toISOString(),
    muted,
    volume,
  };
}

/** A fake media element: the two properties and the one promise this module actually touches. */
function fakeEl(opts: { rejectUnmuted?: boolean; rejectAlways?: boolean } = {}): MediaElementLike & {
  plays: number;
} {
  return {
    muted: false,
    volume: 1,
    plays: 0,
    play(): Promise<void> {
      this.plays += 1;
      if (opts.rejectAlways) return Promise.reject(new Error("NotAllowedError"));
      if (opts.rejectUnmuted && !this.muted) return Promise.reject(new Error("NotAllowedError"));
      return Promise.resolve();
    },
  };
}

describe("surfaceAudio", () => {
  test("a video's flags travel from the wire, unchanged", () => {
    expect(surfaceAudio(video(false, 0.4))).toEqual({ muted: false, volume: 0.4 });
    expect(surfaceAudio(video(true, 0.9))).toEqual({ muted: true, volume: 0.9 });
  });

  test("a playlist carries ONE audio intent for the whole rotation (the deleted hardcode)", () => {
    expect(surfaceAudio(playlist(false, 0.6))).toEqual({ muted: false, volume: 0.6 });
  });

  test("a surface that cannot make sound is silent", () => {
    const web: Surface = {
      id: "content-web",
      region,
      type: "web",
      url: "https://example.test/",
      placement: "iframe",
      interactive: false,
      zoom: 1,
    };
    expect(surfaceAudio(web)).toEqual({ muted: true, volume: 1 });
  });

  test("an audio-less (legacy) payload decodes to SILENCE, never to noise", () => {
    // A surface from an older server: no muted/volume at all. The failure mode must be quiet.
    const legacy = { id: "content-web", region, type: "video", src: "https://cdn.test/a.mp4", loop: true };
    expect(surfaceAudio(legacy as unknown as Surface)).toEqual({ muted: true, volume: 1 });
  });
});

describe("clampVolume", () => {
  test("clamps to the contract's 0–1 range and survives junk", () => {
    expect(clampVolume(0.5)).toBe(0.5);
    expect(clampVolume(-1)).toBe(0);
    expect(clampVolume(9)).toBe(1);
    expect(clampVolume(Number.NaN)).toBe(1);
    expect(clampVolume(undefined)).toBe(1);
  });
});

describe("applyAudio", () => {
  test("sets the level even while muted, so unmuting later is instant", () => {
    const el = fakeEl();
    applyAudio(el, { muted: true, volume: 0.3 });
    expect(el.muted).toBe(true);
    expect(el.volume).toBe(0.3);
  });
});

describe("ensurePlaying — picture beats sound", () => {
  test("an allowed unmuted play just plays", async () => {
    const el = fakeEl();
    el.muted = false;
    expect(await ensurePlaying(el)).toBe("playing");
    expect(el.muted).toBe(false);
    expect(el.plays).toBe(1);
  });

  test("a browser that refuses UNMUTED autoplay gets muted playback, not a frozen wall", async () => {
    // This is the surf/Xwayland (and any no-flag Chrome) path: the wall keeps its picture.
    const el = fakeEl({ rejectUnmuted: true });
    el.muted = false;
    expect(await ensurePlaying(el)).toBe("muted-fallback");
    expect(el.muted).toBe(true);
    expect(el.plays).toBe(2);
  });

  test("a browser that refuses everything is reported, and we do not loop on it", async () => {
    const el = fakeEl({ rejectAlways: true });
    el.muted = false;
    expect(await ensurePlaying(el)).toBe("blocked");
    expect(el.plays).toBe(2); // one unmuted attempt, one muted retry — then stop
  });

  test("an already-muted element that is refused does not retry (there is nothing left to give up)", async () => {
    const el = fakeEl({ rejectAlways: true });
    el.muted = true;
    expect(await ensurePlaying(el)).toBe("blocked");
    expect(el.plays).toBe(1);
  });
});
