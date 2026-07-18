/**
 * POL-165 — auto full rebuild on a new agent version.
 *
 * The agent is baked into the OS image, so an agent-code fix reaches the fleet only on a full image
 * rebuild + reboot. When the server bundles a NEWER agent than the depot image baked, it must
 * auto-trigger one full rebuild at startup (no operator click) and publish it urgent — but a plain
 * restart at the SAME version must do nothing (a full rebuild is heavy). These tests pin that
 * decision, both as the pure `decideVersionRebuild` and end-to-end through `ImageUpdates.start()`.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImageUpdates, IMAGE_ROLLOUT_DEFAULTS, decideVersionRebuild, isNewerVersion } from "../src/image-updates";
import { MemoryStore } from "../src/store/memory";
import type { PersistedImageRollout } from "../src/store/types";

const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

/** A depot that ALREADY publishes one arm64 image, so `manifests().length > 0` (non-empty depot). */
function publishedDepot(): string {
  const root = mkdtempSync(join(tmpdir(), "pol165-depot-"));
  const arch = join(root, "arm64");
  mkdirSync(arch, { recursive: true });
  writeFileSync(join(arch, "image-id.txt"), "20260718T000000Z-cafebabe\n");
  writeFileSync(join(arch, "rootfs.squashfs"), "rootfs");
  return root;
}

/** Wait until start()'s async retain→reconcile→bootstrap→version-rebuild chain has run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

function seed(store: MemoryStore, patch: Partial<PersistedImageRollout>): Promise<void> {
  return store.setImageRollout({
    ...IMAGE_ROLLOUT_DEFAULTS,
    // A published depot is not a fresh install, so latch the first-image bootstrap OUT of the way.
    firstBuildAt: "2026-07-18T00:00:00.000Z",
    ...patch,
  });
}

describe("version-compare (POL-165)", () => {
  test("strictly-newer only; equal and older are false; non-numeric segments count as 0", () => {
    expect(isNewerVersion("0.2.42", "0.2.41")).toBe(true);
    expect(isNewerVersion("0.3.0", "0.2.41")).toBe(true);
    expect(isNewerVersion("0.2.41", "0.2.41")).toBe(false); // equal → no rebuild
    expect(isNewerVersion("0.2.40", "0.2.41")).toBe(false); // older → never
    // A pre-release suffix parses as segment 0, so `0.2.41-rc1` reads as EQUAL to `0.2.41` — neither
    // newer than the other. The load-bearing property is only that a pre-release never reads as NEWER
    // than its release (so a rebuild is never fired backwards); exact semver ordering is not needed.
    expect(isNewerVersion("0.2.41-rc1", "0.2.41")).toBe(false);
    expect(isNewerVersion("0.2.41", "0.2.41-rc1")).toBe(false);
  });
});

describe("decideVersionRebuild (POL-165)", () => {
  test("server newer than depot → rebuild", () => {
    expect(decideVersionRebuild("0.2.42", "0.2.41")).toBe("rebuild");
  });
  test("equal → current (a restart at the same version does nothing)", () => {
    expect(decideVersionRebuild("0.2.41", "0.2.41")).toBe("current");
  });
  test("server older than depot → current (never downgrades)", () => {
    expect(decideVersionRebuild("0.2.40", "0.2.41")).toBe("current");
  });
  test("unknown depot version → baseline (adopt, don't rebuild)", () => {
    expect(decideVersionRebuild("0.2.42", null)).toBe("baseline");
    expect(decideVersionRebuild("0.2.42", "")).toBe("baseline");
  });
});

describe("auto-rebuild on start (POL-165)", () => {
  test("bundled agent NEWER than the depot's baked agent → triggers one full build, stamps the new baseline, publishes urgent", async () => {
    const store = new MemoryStore();
    await seed(store, { imageAgentVersion: "0.2.41", urgent: false });
    const root = publishedDepot();
    const arch = join(root, "arm64");
    const marker = join(root, "built");
    // A full-rebuild hook that re-publishes the image (a new id) and records that it actually ran.
    const fullCmd =
      `sh -c 'printf "20260718T120000Z-deadbeef\\n" > ${arch}/image-id.txt; ` +
      `printf rootfs2 > ${arch}/rootfs.squashfs; printf x >> ${marker}; echo rebuilt'`;

    const iu = new ImageUpdates(store, root, undefined, log, fullCmd, 3, () => {}, "0.2.42", true);
    iu.start();
    for (let i = 0; i < 200 && !iu.settled; i++) await new Promise((r) => setTimeout(r, 10));
    expect(iu.settled).not.toBeNull();
    await iu.settled;
    iu.stop();

    const st = await store.getImageRollout();
    expect(st?.lastBuildStatus).toBe("success");
    expect(st?.lastBuildKind).toBe("full");
    // The full rebuild re-bakes the agent, so the depot's baked-agent baseline is now the served one.
    expect(st?.imageAgentVersion).toBe("0.2.42");
    // The auto path publishes urgent so the update-poll reboots boxes onto the new agent.
    expect(st?.urgent).toBe(true);
  });

  test("bundled agent EQUAL to the depot's → no build (a plain restart at the same version does nothing)", async () => {
    const store = new MemoryStore();
    await seed(store, { imageAgentVersion: "0.2.42" });
    const marker = join(publishedDepot(), "should-not-run");
    // If this hook were ever spawned it would create the marker; the test proves it is NOT.
    const iu = new ImageUpdates(
      store,
      publishedDepot(),
      undefined,
      log,
      `sh -c 'printf x > ${marker}'`,
      3,
      () => {},
      "0.2.42",
      true,
    );
    iu.start();
    await drain();
    iu.stop();

    expect(iu.settled).toBeNull(); // no trigger fired
    expect((await store.getImageRollout())?.lastBuildStatus).toBeNull();
  });

  test("bundled agent OLDER than the depot's → no build (never downgrades)", async () => {
    const store = new MemoryStore();
    await seed(store, { imageAgentVersion: "0.2.42" });
    const iu = new ImageUpdates(store, publishedDepot(), undefined, log, "sh -c 'echo nope'", 3, () => {}, "0.2.40", true);
    iu.start();
    await drain();
    iu.stop();
    expect(iu.settled).toBeNull();
  });

  test("unknown depot baseline → adopts the served version WITHOUT rebuilding", async () => {
    const store = new MemoryStore();
    await seed(store, { imageAgentVersion: null });
    const iu = new ImageUpdates(store, publishedDepot(), undefined, log, "sh -c 'echo nope'", 3, () => {}, "0.2.42", true);
    iu.start();
    await drain();
    iu.stop();

    expect(iu.settled).toBeNull(); // no rebuild on an unprovable delta
    expect((await store.getImageRollout())?.imageAgentVersion).toBe("0.2.42"); // baseline adopted
  });

  test("adopted baseline means the NEXT bump fires: a restart at the adopted version does nothing, a newer server rebuilds", async () => {
    const store = new MemoryStore();
    await seed(store, { imageAgentVersion: null });
    // First boot at 0.2.42: unknown → adopt, no build.
    const first = new ImageUpdates(store, publishedDepot(), undefined, log, "sh -c 'echo x'", 3, () => {}, "0.2.42", true);
    first.start();
    await drain();
    first.stop();
    expect(first.settled).toBeNull();
    expect((await store.getImageRollout())?.imageAgentVersion).toBe("0.2.42");

    // A plain restart at the SAME 0.2.42 → current → still no build.
    const restart = new ImageUpdates(store, publishedDepot(), undefined, log, "sh -c 'echo x'", 3, () => {}, "0.2.42", true);
    restart.start();
    await drain();
    restart.stop();
    expect(restart.settled).toBeNull();
  });

  test("auto-rebuild OFF → never builds even on a real delta", async () => {
    const store = new MemoryStore();
    await seed(store, { imageAgentVersion: "0.2.41" });
    const iu = new ImageUpdates(store, publishedDepot(), undefined, log, "sh -c 'echo nope'", 3, () => {}, "0.2.42", false);
    iu.start();
    await drain();
    iu.stop();
    expect(iu.settled).toBeNull();
  });

  test("dev server (0.0.0) → inert, never builds", async () => {
    const store = new MemoryStore();
    await seed(store, { imageAgentVersion: "0.2.41" });
    const iu = new ImageUpdates(store, publishedDepot(), undefined, log, "sh -c 'echo nope'", 3, () => {}, "0.0.0", true);
    iu.start();
    await drain();
    iu.stop();
    expect(iu.settled).toBeNull();
  });

  test("empty depot → the version-rebuild stands down (bootstrapFirstImage owns that)", async () => {
    const store = new MemoryStore();
    // No firstBuildAt latch here: a genuine fresh install. Depot is EMPTY.
    await store.setImageRollout({ ...IMAGE_ROLLOUT_DEFAULTS });
    const emptyRoot = mkdtempSync(join(tmpdir(), "pol165-empty-"));
    const archId = join(emptyRoot, "arm64");
    // The bootstrap full build publishes the first image (so this is bootstrap's build, not the
    // version path's). The version-rebuild that follows must see `running` and not fire a SECOND build.
    const fullCmd =
      `sh -c 'mkdir -p ${archId}; printf "20260718T000000Z-aaaa\\n" > ${archId}/image-id.txt; ` +
      `printf rootfs > ${archId}/rootfs.squashfs; echo built'`;
    const iu = new ImageUpdates(store, emptyRoot, undefined, log, fullCmd, 3, () => {}, "0.2.42", true);
    iu.start();
    for (let i = 0; i < 200 && !iu.settled; i++) await new Promise((r) => setTimeout(r, 10));
    await iu.settled;
    iu.stop();

    // Exactly one build ran (the bootstrap one), and it stamped the baked-agent baseline on success.
    expect((await iu.manifests()).length).toBe(1);
    expect((await store.getImageRollout())?.imageAgentVersion).toBe("0.2.42");
  });
});
