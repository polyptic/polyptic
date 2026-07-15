/**
 * POL-112 — audio end-to-end, control-plane half.
 *
 * These drive `ControlPlane` directly against the `MemoryStore` (no server/WS). They pin the three
 * promises the feature makes:
 *
 *   1. SILENCE IS THE DEFAULT. Content lands muted, always, on a screen and on a wall — the only way a
 *      wall makes a noise is an operator asking for it.
 *   2. THE ONE-UNMUTED-PANEL GUARD IS SERVER-SIDE. A combined surface unmutes exactly ONE member,
 *      whatever a client asks for; the others stay muted, so the room never hears N copies.
 *   3. AUDIO IS REMEMBERED PER (target, content) PAIR — like zoom (POL-57) — and survives a restart,
 *      but NEW content on that target still arrives muted.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { AudioIntent, Output, Surface } from "@polyptic/protocol";
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

/** The audio on a screen's first surface — undefined when it shows nothing audible. */
function audioOf(cp: ControlPlane, screenId: string): AudioIntent | undefined {
  const surface: Surface | undefined = cp.state.slices[screenId]?.surfaces[0];
  if (!surface) return undefined;
  if (surface.type !== "video" && surface.type !== "playlist") return undefined;
  return { muted: surface.muted, volume: surface.volume };
}

let store: MemoryStore;
let cp: ControlPlane;

async function twoScreens(): Promise<{ a: string; b: string; muralId: string }> {
  await cp.registerMachine(hello("m1", "HDMI-1", "HDMI-2"));
  const [a, b] = cp.getScreens();
  const mural = await cp.createMural("Atrium");
  await cp.placeScreen(a!.id, mural.id, 0, 0, 1920, 1080);
  await cp.placeScreen(b!.id, mural.id, 1920, 0, 1920, 1080);
  return { a: a!.id, b: b!.id, muralId: mural.id };
}

/** A library video source (the only kind an operator can actually assign a clip from). */
async function videoSource(name = "Showreel", url = "https://cdn.test/reel.mp4"): Promise<string> {
  const created = await cp.createContentSource({ name, kind: "video", url });
  return created.ok ? created.source.id : "";
}

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("screen audio (POL-112)", () => {
  test("a video lands MUTED — sound is opt-in, never a surprise", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { sourceId: await videoSource() });
    expect(audioOf(cp, a)).toEqual({ muted: true, volume: 1 });
  });

  test("a playlist lands muted too, and the flag it carries is the SERVER's, not a player hardcode", async () => {
    const { a } = await twoScreens();
    const clip = await videoSource();
    const playlist = await cp.createContentSource({
      name: "Lobby loop",
      kind: "playlist",
      items: [{ sourceId: clip }],
    });
    const playlistId = playlist.ok ? playlist.source.id : "";
    await cp.setScreenContent(a, { sourceId: playlistId });
    expect(audioOf(cp, a)).toEqual({ muted: true, volume: 1 });

    const result = await cp.setScreenAudio(a, { muted: false, volume: 0.4 });
    expect(result.ok).toBe(true);
    expect(audioOf(cp, a)).toEqual({ muted: false, volume: 0.4 });
  });

  test("setScreenAudio patches the SAME surface id — the clip does not restart when sound comes on", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { sourceId: await videoSource() });
    const before = cp.state.slices[a]!.surfaces[0]!;

    const result = await cp.setScreenAudio(a, { muted: false, volume: 0.6 });
    expect(result.ok).toBe(true);

    const after = cp.state.slices[a]!.surfaces[0]!;
    expect(after.id).toBe(before.id);
    expect(after.type).toBe("video");
    expect(audioOf(cp, a)).toEqual({ muted: false, volume: 0.6 });
    // Audio is a render change: players must reconcile to it.
    expect(cp.state.revision).toBeGreaterThan(0);
  });

  test("volume survives a re-mute — unmuting restores the level, it does not jump to full", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { sourceId: await videoSource() });
    await cp.setScreenAudio(a, { muted: false, volume: 0.3 });
    await cp.setScreenAudio(a, { muted: true, volume: 0.3 });
    expect(audioOf(cp, a)).toEqual({ muted: true, volume: 0.3 });

    await cp.setScreenAudio(a, { muted: false, volume: 0.3 });
    expect(audioOf(cp, a)).toEqual({ muted: false, volume: 0.3 });
  });

  test("audio is remembered for the (screen, content) pair — but NEW content still arrives muted", async () => {
    const { a } = await twoScreens();
    const reel = await videoSource();
    const safety = await videoSource("Safety briefing", "https://cdn.test/safety.mp4");

    await cp.setScreenContent(a, { sourceId: reel });
    await cp.setScreenAudio(a, { muted: false, volume: 0.5 });

    // Different content on the same screen: never inherits the sound.
    await cp.setScreenContent(a, { sourceId: safety });
    expect(audioOf(cp, a)).toEqual({ muted: true, volume: 1 });

    // The original clip returning restores exactly what the operator dialled in.
    await cp.setScreenContent(a, { sourceId: reel });
    expect(audioOf(cp, a)).toEqual({ muted: false, volume: 0.5 });
  });

  test("the SAME clip on another screen keeps its own (muted) audio", async () => {
    const { a, b } = await twoScreens();
    const reel = await videoSource();
    await cp.setScreenContent(a, { sourceId: reel });
    await cp.setScreenContent(b, { sourceId: reel });

    await cp.setScreenAudio(a, { muted: false, volume: 0.8 });
    expect(audioOf(cp, a)).toEqual({ muted: false, volume: 0.8 });
    expect(audioOf(cp, b)).toEqual({ muted: true, volume: 1 });
  });

  test("editing the source does not silently mute a screen that is already sounding it", async () => {
    const { a } = await twoScreens();
    const reel = await videoSource();
    await cp.setScreenContent(a, { sourceId: reel });
    await cp.setScreenAudio(a, { muted: false, volume: 0.7 });

    const updated = await cp.updateContentSource(reel, { url: "https://cdn.test/reel-v2.mp4" });
    expect(updated.ok).toBe(true);
    expect(audioOf(cp, a)).toEqual({ muted: false, volume: 0.7 });
  });

  test("a remembered audio intent survives a server restart", async () => {
    const { a } = await twoScreens();
    const reel = await videoSource();
    await cp.setScreenContent(a, { sourceId: reel });
    await cp.setScreenAudio(a, { muted: false, volume: 0.25 });

    const rebooted = new ControlPlane(store);
    await rebooted.init();
    expect(audioOf(rebooted, a)).toEqual({ muted: false, volume: 0.25 });

    // And the PREFERENCE (not just the persisted surface) drives a re-assignment after the reboot.
    await rebooted.setScreenContent(a, { url: "https://example.test/page" });
    await rebooted.setScreenContent(a, { sourceId: reel });
    expect(audioOf(rebooted, a)).toEqual({ muted: false, volume: 0.25 });
  });

  test("content that cannot make sound has no audio to set", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/dashboard" });

    expect(await cp.setScreenAudio(a, { muted: false, volume: 1 })).toEqual({
      ok: false,
      error: "not-audible",
    });
    expect(audioOf(cp, a)).toBeUndefined();
  });

  test("an empty screen and an unknown screen are both rejected", async () => {
    const { a } = await twoScreens();
    const audio: AudioIntent = { muted: false, volume: 1 };
    expect(await cp.setScreenAudio(a, audio)).toEqual({ ok: false, error: "no-content" });
    expect(await cp.setScreenAudio("screen-404", audio)).toEqual({ ok: false, error: "unknown-screen" });
  });

  test("a screen's remembered audio is forgotten when the screen is removed", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { sourceId: await videoSource() });
    await cp.setScreenAudio(a, { muted: false, volume: 0.5 });
    expect((await store.listAudioPreferences()).length).toBe(1);

    await cp.removeScreen(a);
    expect(await store.listAudioPreferences()).toEqual([]);
  });
});

describe("combined-surface audio + the one-unmuted-panel guard (POL-112)", () => {
  async function wallShowingAVideo(): Promise<{ a: string; b: string; wallId: string }> {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    const wallId = combined.ok ? combined.wall.id : "";
    await cp.setWallContent(wallId, { sourceId: await videoSource() });
    return { a, b, wallId };
  }

  test("a wall's video lands muted on every panel", async () => {
    const { a, b } = await wallShowingAVideo();
    expect(audioOf(cp, a)).toEqual({ muted: true, volume: 1 });
    expect(audioOf(cp, b)).toEqual({ muted: true, volume: 1 });
  });

  test("unmuting a wall unmutes exactly ONE panel — the others stay muted, so the room cannot echo", async () => {
    const { a, b, wallId } = await wallShowingAVideo();

    const result = await cp.setWallAudio(wallId, { muted: false, volume: 0.5 });
    expect(result.ok).toBe(true);
    expect(result.ok && result.slices.length).toBe(2);

    expect(audioOf(cp, a)).toEqual({ muted: false, volume: 0.5 }); // the anchor member sounds
    expect(audioOf(cp, b)).toEqual({ muted: true, volume: 0.5 }); // …and only the anchor member
  });

  test("the guard survives a re-push: re-assigning the same content still sounds only one panel", async () => {
    const { a, b, wallId } = await wallShowingAVideo();
    await cp.setWallAudio(wallId, { muted: false, volume: 0.5 });

    const reel = cp.getContentSources().find((s) => s.kind === "video")!;
    await cp.setWallContent(wallId, { sourceId: reel.id });

    expect(audioOf(cp, a)).toEqual({ muted: false, volume: 0.5 });
    expect(audioOf(cp, b)).toEqual({ muted: true, volume: 0.5 });
    // Exactly one sounding panel, restated as the invariant the room actually cares about.
    const sounding = [a, b].filter((id) => audioOf(cp, id)?.muted === false);
    expect(sounding).toEqual([a]);
  });

  test("a wall's span math is untouched by an audio change", async () => {
    const { b, wallId } = await wallShowingAVideo();
    const spanBefore = cp.state.slices[b]!.surfaces[0]!.span;
    await cp.setWallAudio(wallId, { muted: false, volume: 1 });
    expect(cp.state.slices[b]!.surfaces[0]!.span).toEqual(spanBefore);
  });

  test("a wall member is rejected — audio belongs to the combined surface", async () => {
    const { a } = await wallShowingAVideo();
    const result = await cp.setScreenAudio(a, { muted: false, volume: 1 });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error).toBe("wall-member");
  });

  test("splitting a wall forgets its remembered audio", async () => {
    const { wallId } = await wallShowingAVideo();
    await cp.setWallAudio(wallId, { muted: false, volume: 0.5 });
    expect((await store.listAudioPreferences()).length).toBe(1);

    await cp.splitWall(wallId);
    expect(await store.listAudioPreferences()).toEqual([]);
  });

  test("an unknown wall, a silent wall and an empty wall are all rejected", async () => {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    const wallId = combined.ok ? combined.wall.id : "";
    const audio: AudioIntent = { muted: false, volume: 1 };

    expect(await cp.setWallAudio("wall-404", audio)).toEqual({ ok: false, error: "unknown-wall" });
    // Combining clears the members' slices, so a fresh wall shows nothing at all.
    expect(await cp.setWallAudio(wallId, audio)).toEqual({ ok: false, error: "no-content" });

    await cp.setWallContent(wallId, { url: "https://example.test/page" });
    expect(await cp.setWallAudio(wallId, audio)).toEqual({ ok: false, error: "not-audible" });
  });
});

describe("the console's audio read-out (POL-112)", () => {
  test("it is present for audible content and ABSENT for everything else — that is how the control hides", async () => {
    const { a } = await twoScreens();
    expect(cp.screenContentSummary(a)).toBeNull(); // empty screen

    await cp.setScreenContent(a, { url: "https://example.test/dashboard" });
    expect(cp.screenContentSummary(a)?.audio).toBeUndefined();

    await cp.setScreenContent(a, { sourceId: await videoSource() });
    expect(cp.screenContentSummary(a)?.audio).toEqual({ muted: true, volume: 1 });
  });

  test("a wall member reports the wall's INTENT, not the guard's per-panel consequence", async () => {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    const wallId = combined.ok ? combined.wall.id : "";
    await cp.setWallContent(wallId, { sourceId: await videoSource() });
    await cp.setWallAudio(wallId, { muted: false, volume: 0.5 });

    // The console reads the wall's audio off ANY member; a muted non-anchor panel must not make the
    // Inspector claim the wall is silent when the operator has just turned the sound on.
    expect(cp.screenContentSummary(a)?.audio).toEqual({ muted: false, volume: 0.5 });
    expect(cp.screenContentSummary(b)?.audio).toEqual({ muted: false, volume: 0.5 });
  });
});
