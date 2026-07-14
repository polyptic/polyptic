/**
 * POL-98 — grooming (crop / scroll / dashboard refresh) is remembered per (screen-or-wall, page).
 *
 * These drive `ControlPlane` directly against the `MemoryStore` (no server/WS). They pin what the
 * Inspector's caption promises an operator: a page cropped and parked for one screen comes back that
 * way when that page returns to that screen — and *only* there — and the surface it comes back on is
 * the SAME surface (same id, same url), so the wall restyles rather than reloads.
 *
 * The refusals mirror the zoom's, for the same reasons: media has no page to groom, a wall member
 * defers to its combined surface, and an empty screen has nothing to groom at all.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { Output, Surface, SurfaceGroom } from "@polyptic/protocol";
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

const CROP: SurfaceGroom["crop"] = { top: 12, right: 0, bottom: 0, left: 0, unit: "percent" };
const SCROLL: SurfaceGroom["scroll"] = { x: 0, y: 420 };
const GROOM: SurfaceGroom = { refreshSeconds: 300, crop: CROP, scroll: SCROLL };

/** The first surface on a screen — what the player actually receives. */
function surfaceOf(cp: ControlPlane, screenId: string): Surface | undefined {
  return cp.state.slices[screenId]?.surfaces[0];
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

/** A dashboard in the library — the only kind that carries a refresh cadence. */
async function dashboardSource(name: string, url: string): Promise<string> {
  const created = await cp.createContentSource({ name, kind: "dashboard", url });
  if (!created.ok) throw new Error("could not create the dashboard source");
  return created.source.id;
}

beforeEach(async () => {
  store = new MemoryStore();
  cp = new ControlPlane(store);
  await cp.init();
});

describe("screen grooming (POL-98)", () => {
  test("content lands ungroomed — the whole page, unparked, never refreshed", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    const surface = surfaceOf(cp, a);
    expect(surface?.type).toBe("web");
    expect(surface && "crop" in surface ? surface.crop : "absent").toBeUndefined();
    expect(surface && "scroll" in surface ? surface.scroll : "absent").toBeUndefined();
  });

  test("setScreenGroom restyles the SAME surface id and url — the player patches, it does not reload", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    const before = surfaceOf(cp, a)!;

    const result = await cp.setScreenGroom(a, { crop: CROP, scroll: SCROLL });
    expect(result.ok).toBe(true);

    const after = surfaceOf(cp, a)!;
    expect(after.id).toBe(before.id);
    expect(after.type).toBe("web");
    expect("url" in after && "url" in before ? after.url === before.url : false).toBe(true);
    expect("crop" in after ? after.crop : undefined).toEqual(CROP);
    expect("scroll" in after ? after.scroll : undefined).toEqual(SCROLL);
    // A restyle is a render change: players reconcile to it.
    expect(cp.state.revision).toBeGreaterThan(0);
  });

  test("refreshSeconds rides on a DASHBOARD — a web page has no cadence (that's what the kind means)", async () => {
    const { a, b } = await twoScreens();

    const dash = await dashboardSource("Ops board", "https://example.test/dash");
    await cp.setScreenContent(a, { sourceId: dash });
    await cp.setScreenGroom(a, GROOM);
    const dashboard = surfaceOf(cp, a)!;
    expect(dashboard.type).toBe("dashboard");
    expect(dashboard.type === "dashboard" ? dashboard.refreshSeconds : undefined).toBe(300);

    // The same groom on a web surface keeps the geometry and DROPS the cadence.
    await cp.setScreenContent(b, { url: "https://example.test/web" });
    await cp.setScreenGroom(b, GROOM);
    const web = surfaceOf(cp, b)!;
    expect(web.type).toBe("web");
    expect("refreshSeconds" in web).toBe(false);
    expect("crop" in web ? web.crop : undefined).toEqual(CROP);
  });

  test("a groom is remembered for the (screen, page) pair and restored on re-assignment", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.setScreenGroom(a, { crop: CROP, scroll: SCROLL });

    // Show something else: it has never been groomed here, so it lands whole.
    await cp.setScreenContent(a, { url: "https://example.test/other" });
    expect(surfaceOf(cp, a) && "crop" in surfaceOf(cp, a)! ? (surfaceOf(cp, a) as { crop?: unknown }).crop : undefined).toBeUndefined();

    // Bring the first page back — the operator's crop and scroll come with it.
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    const back = surfaceOf(cp, a)!;
    expect("crop" in back ? back.crop : undefined).toEqual(CROP);
    expect("scroll" in back ? back.scroll : undefined).toEqual(SCROLL);
  });

  test("the same page on a different screen is untouched — grooming belongs to the PAIR", async () => {
    const { a, b } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.setScreenGroom(a, { crop: CROP });

    await cp.setScreenContent(b, { url: "https://example.test/one" });
    const other = surfaceOf(cp, b)!;
    expect("crop" in other ? other.crop : undefined).toBeUndefined();
  });

  test("an explicit reset is REMEMBERED — 'back to the whole page' is a choice, not an absence", async () => {
    const { a } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.setScreenGroom(a, { crop: CROP });
    await cp.setScreenGroom(a, {});

    await cp.setScreenContent(a, { url: "https://example.test/other" });
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    const back = surfaceOf(cp, a)!;
    expect("crop" in back ? back.crop : undefined).toBeUndefined();
  });

  test("the groom survives a restart — it is written through, not held in memory", async () => {
    const { a } = await twoScreens();
    const dash = await dashboardSource("Ops board", "https://example.test/dash");
    await cp.setScreenContent(a, { sourceId: dash });
    await cp.setScreenGroom(a, GROOM);

    // A fresh control plane over the SAME store: the boot the operator never watches.
    const rebooted = new ControlPlane(store);
    await rebooted.init();
    await rebooted.setScreenContent(a, { url: "https://example.test/elsewhere" });
    await rebooted.setScreenContent(a, { sourceId: dash });

    const surface = surfaceOf(rebooted, a)!;
    expect(surface.type).toBe("dashboard");
    expect(surface.type === "dashboard" ? surface.refreshSeconds : undefined).toBe(300);
    expect("crop" in surface ? surface.crop : undefined).toEqual(CROP);
  });

  test("the console's read-out carries the live groom, and only for framed content", async () => {
    const { a, b } = await twoScreens();
    await cp.setScreenContent(a, { url: "https://example.test/one" });
    await cp.setScreenGroom(a, { crop: CROP });
    expect(cp.screenContentSummary(a)?.groom).toEqual({
      refreshSeconds: undefined,
      crop: CROP,
      scroll: undefined,
    });

    const image = await cp.createContentSource({
      name: "Poster",
      kind: "image",
      url: "https://cdn.example.test/poster.png",
    });
    expect(image.ok).toBe(true);
    if (!image.ok) return;
    await cp.setScreenContent(b, { sourceId: image.source.id });
    // Media has no page: no groom on the read-out, so the console hides the panel rather than
    // disabling it — exactly as it does for the zoom control.
    expect(cp.screenContentSummary(b)?.groom).toBeUndefined();
  });

  test("media is not groomable, an empty screen has nothing to groom, a wall member defers", async () => {
    const { a, b, muralId } = await twoScreens();

    const image = await cp.createContentSource({
      name: "Poster",
      kind: "image",
      url: "https://cdn.example.test/poster.png",
    });
    if (!image.ok) throw new Error("source");
    await cp.setScreenContent(a, { sourceId: image.source.id });
    const media = await cp.setScreenGroom(a, { crop: CROP });
    expect(media).toEqual({ ok: false, error: "not-groomable" });

    const empty = await cp.setScreenGroom(b, { crop: CROP });
    expect(empty).toEqual({ ok: false, error: "no-content" });

    const unknown = await cp.setScreenGroom("screen-404", { crop: CROP });
    expect(unknown).toEqual({ ok: false, error: "unknown-screen" });

    const combined = await cp.combineScreens(muralId, [a, b]);
    expect(combined.ok).toBe(true);
    if (!combined.ok) return;
    const member = await cp.setScreenGroom(a, { crop: CROP });
    expect(member.ok).toBe(false);
    if (member.ok) return;
    expect(member.error).toBe("wall-member");
    expect(member.wallId).toBe(combined.wall.id);
  });
});

describe("combined-surface grooming (POL-98)", () => {
  test("a wall's groom applies to EVERY member, and the span math is untouched", async () => {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    if (!combined.ok) throw new Error("combine");
    const wallId = combined.wall.id;

    await cp.setWallContent(wallId, { url: "https://example.test/wall" });
    const spanBefore = surfaceOf(cp, a)!.span;

    const result = await cp.setWallGroom(wallId, { crop: CROP, scroll: SCROLL });
    expect(result.ok).toBe(true);

    for (const screenId of [a, b]) {
      const surface = surfaceOf(cp, screenId)!;
      expect("crop" in surface ? surface.crop : undefined).toEqual(CROP);
      expect("scroll" in surface ? surface.scroll : undefined).toEqual(SCROLL);
    }
    // The crop is dialled against the SPANNING page — it must not move the wall's geometry.
    expect(surfaceOf(cp, a)!.span).toEqual(spanBefore);
    expect(surfaceOf(cp, b)!.span?.offsetX).toBe(1920);
  });

  test("a wall's groom is remembered per page and restored on re-assignment", async () => {
    const { a, b, muralId } = await twoScreens();
    const combined = await cp.combineScreens(muralId, [a, b]);
    if (!combined.ok) throw new Error("combine");
    const wallId = combined.wall.id;

    await cp.setWallContent(wallId, { url: "https://example.test/wall" });
    await cp.setWallGroom(wallId, { crop: CROP });

    await cp.setWallContent(wallId, { url: "https://example.test/other" });
    expect("crop" in surfaceOf(cp, a)! ? (surfaceOf(cp, a) as { crop?: unknown }).crop : undefined).toBeUndefined();

    await cp.setWallContent(wallId, { url: "https://example.test/wall" });
    expect("crop" in surfaceOf(cp, a)! ? (surfaceOf(cp, a) as { crop?: unknown }).crop : undefined).toEqual(CROP);
  });

  test("an unknown wall is refused", async () => {
    const result = await cp.setWallGroom("wall-404", { crop: CROP });
    expect(result).toEqual({ ok: false, error: "unknown-wall" });
  });
});
