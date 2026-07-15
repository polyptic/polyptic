/**
 * The first-image bootstrap (POL-121).
 *
 * A fresh install starts with an EMPTY depot and nothing used to fill it: the nightly cycle only
 * REFRESHES an existing image, and the weekly full rebuild is up to seven days away — so the fleet
 * could not netboot a single screen, and the boot-medium install hook, finding no image, quietly
 * baked the LEAN wired-only medium (D68). `ImageUpdates.bootstrapFirstImage()` closes that by firing
 * ONE full build when it finds nothing published.
 *
 * The guardrails are the whole risk, so they are what these tests pin:
 *
 *   1. Empty depot + a configured hook → exactly one full build, and the depot ends up published.
 *   2. A depot that already has an image → no build, ever (we must never overwrite one).
 *   3. Idempotent across a RESTART: a second ImageUpdates over the same store (the pod that came back
 *      after a crash) sees the latch and stands down — no build storm.
 *   4. The full-rebuild cycle switched off, or no IMAGE_FULL_REBUILD_CMD (dev/laptop/`enabled: false`)
 *      → no build at all.
 *   5. The activity feed says what is happening, and what it means, on start and on finish.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImageUpdates } from "../src/image-updates";
import { MemoryStore } from "../src/store/memory";

const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

type Line = [severity: string, text: string];

/** An empty depot — a fresh `helm install`'s PVC, before anything has ever been built. */
function emptyDepot(): string {
  return mkdtempSync(join(tmpdir(), "pol121-depot-"));
}

/** A depot with one published arm64 image — an install that has built before. */
function depotWithImage(imageId = "20260714T000000Z-aabbccdd"): string {
  const root = emptyDepot();
  const arch = join(root, "arm64");
  mkdirSync(arch, { recursive: true });
  writeFileSync(join(arch, "image-id.txt"), `${imageId}\n`);
  writeFileSync(join(arch, "rootfs.squashfs"), "rootfs");
  return root;
}

/**
 * A stand-in for the k8s full-rebuild Job: publishes an arm64 image into the depot and touches a
 * marker per invocation, so a build STORM is countable, not merely inferred.
 */
function fakeFullRebuild(root: string, marker: string): string {
  const arch = join(root, "arm64");
  return (
    `sh -c 'mkdir -p ${arch}; ` +
    `printf "20260714T121212Z-beefcafe\\n" > ${arch}/image-id.txt; ` +
    `printf rootfs > ${arch}/rootfs.squashfs; ` +
    `printf x >> ${marker}; echo built'`
  );
}

/** How many times the fake hook ran (one byte per run). */
function runs(marker: string): number {
  return existsSync(marker) ? Bun.file(marker).size : 0;
}

function makeUpdates(
  store: MemoryStore,
  root: string,
  fullCmd: string | undefined,
  lines: Line[],
): ImageUpdates {
  return new ImageUpdates(store, root, undefined, log, fullCmd, 3, (severity, text) => lines.push([severity, text]));
}

describe("first-image bootstrap (POL-121)", () => {
  test("an EMPTY depot triggers exactly one full build, and the depot ends up published", async () => {
    const root = emptyDepot();
    const marker = join(root, "runs");
    const store = new MemoryStore();
    const lines: Line[] = [];
    const iu = makeUpdates(store, root, fakeFullRebuild(root, marker), lines);

    expect(await iu.manifests()).toEqual([]);
    await iu.bootstrapFirstImage();
    await iu.settled;

    expect(runs(marker)).toBe(1);
    const images = await iu.manifests();
    expect(images).toHaveLength(1);
    expect(images[0]?.imageId).toBe("20260714T121212Z-beefcafe");

    const st = await iu.state();
    expect(st.firstBuildAt).not.toBeNull();
    // It goes down the FULL path — the one whose Job re-bakes the boot medium, so the download stops
    // being the LEAN fallback baked against an empty depot.
    expect(st.lastBuildKind).toBe("full");
    expect(st.lastBuildStatus).toBe("success");
  });

  test("a depot that already has an image is never rebuilt over", async () => {
    const root = depotWithImage();
    const marker = join(root, "runs");
    const store = new MemoryStore();
    const iu = makeUpdates(store, root, fakeFullRebuild(root, marker), []);

    await iu.bootstrapFirstImage();
    await iu.settled;

    expect(runs(marker)).toBe(0);
    expect((await iu.manifests())[0]?.imageId).toBe("20260714T000000Z-aabbccdd");
    expect((await iu.state()).firstBuildAt).toBeNull();
  });

  test("idempotent across a restart: a pod that comes back does NOT launch a second build", async () => {
    const root = emptyDepot();
    const marker = join(root, "runs");
    // The store is the durable state — the same Postgres row a restarted pod reads back.
    const store = new MemoryStore();
    const cmd = fakeFullRebuild(root, marker);

    const first = makeUpdates(store, root, cmd, []);
    await first.bootstrapFirstImage();
    await first.settled;
    expect(runs(marker)).toBe(1);

    // …the pod dies and comes back, twice, on a fresh ImageUpdates each time.
    for (let i = 0; i < 2; i++) {
      const restarted = makeUpdates(store, root, cmd, []);
      await restarted.bootstrapFirstImage();
      await restarted.settled;
    }
    expect(runs(marker)).toBe(1);
  });

  test("a crash-loop that never let the build finish still only ever builds once (the latch is claimed BEFORE the hook)", async () => {
    const root = emptyDepot();
    const marker = join(root, "runs");
    const store = new MemoryStore();
    const cmd = fakeFullRebuild(root, marker);

    // The first pod claims the latch and spawns the build, then is killed mid-flight: we simply never
    // await `settled`, and start a fresh instance over the same store — the depot is STILL empty from
    // the next pod's point of view, which is exactly the shape of a build storm.
    const dying = makeUpdates(store, root, cmd, []);
    await dying.bootstrapFirstImage();

    const next = makeUpdates(store, root, cmd, []);
    await next.bootstrapFirstImage();
    expect(next.settled).toBeNull(); // it stood down without spawning anything

    await dying.settled;
    expect(runs(marker)).toBe(1);
  });

  test("the full-rebuild cycle switched off means no build, ever", async () => {
    const root = emptyDepot();
    const marker = join(root, "runs");
    const store = new MemoryStore();
    const iu = makeUpdates(store, root, fakeFullRebuild(root, marker), []);
    await iu.updateSettings({ fullScheduleEnabled: false });

    await iu.bootstrapFirstImage();
    await iu.settled;

    expect(runs(marker)).toBe(0);
    expect((await iu.state()).firstBuildAt).toBeNull();
    expect(await iu.manifests()).toEqual([]);
  });

  test("no rebuild hook configured (dev stack, laptop server, imageUpdates.enabled: false) means no build", async () => {
    const root = emptyDepot();
    const store = new MemoryStore();
    const lines: Line[] = [];
    const iu = makeUpdates(store, root, undefined, lines);

    await iu.bootstrapFirstImage();
    await iu.settled;

    expect(iu.settled).toBeNull();
    expect((await iu.state()).firstBuildAt).toBeNull();
    expect(lines).toEqual([]); // nothing to announce — there is nothing the operator can do here
  });

  test("start() runs the bootstrap, and the activity feed narrates it start to finish", async () => {
    const root = emptyDepot();
    const marker = join(root, "runs");
    const store = new MemoryStore();
    const lines: Line[] = [];
    const iu = makeUpdates(store, root, fakeFullRebuild(root, marker), lines);

    iu.start();
    // start() reconciles the depot, then bootstraps — both async, so wait for the build to be claimed.
    for (let i = 0; i < 200 && !iu.settled; i++) await new Promise((r) => setTimeout(r, 10));
    await iu.settled;
    iu.stop();

    expect(runs(marker)).toBe(1);
    expect(lines[0]?.[0]).toBe("warn");
    expect(lines[0]?.[1]).toContain("Building the first OS image");
    expect(lines[0]?.[1]).toContain("can't netboot");
    expect(lines[1]?.[0]).toBe("good");
    expect(lines[1]?.[1]).toContain("First OS image built");
  });

  test("a failed first build is announced as failed — and is not retried behind the operator's back", async () => {
    const root = emptyDepot();
    const store = new MemoryStore();
    const lines: Line[] = [];
    const iu = makeUpdates(store, root, "sh -c 'echo boom >&2; exit 1'", lines);

    await iu.bootstrapFirstImage();
    await iu.settled;

    expect((await iu.state()).lastBuildStatus).toBe("failure");
    expect(lines[1]?.[0]).toBe("bad");
    expect(lines[1]?.[1]).toContain("First OS image build failed");

    // The depot is still empty — and the latch still holds, so a restart does not retry into a storm.
    const restarted = makeUpdates(store, root, "sh -c 'echo boom >&2; exit 1'", []);
    await restarted.bootstrapFirstImage();
    expect(restarted.settled).toBeNull();
  });
});
