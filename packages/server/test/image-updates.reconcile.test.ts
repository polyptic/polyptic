/**
 * POL-161 — a server restart mid-build must not leave `lastBuildStatus` stuck "running".
 *
 * `trigger()` writes `lastBuildStatus: "running"` before spawning the hook and only closes the row
 * out in a completion continuation. A `helm upgrade` restarts the pod mid-build, so that continuation
 * never runs and the row stays "running" forever — greying the console's rebuild buttons (they read
 * the persisted status) and making `bootstrapFirstImage` skip the first build. `start()` must
 * reconcile that on boot: a build cannot survive a process restart, so a "running" row with nothing
 * in flight is orphaned and gets closed out to "failure".
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImageUpdates, IMAGE_ROLLOUT_DEFAULTS } from "../src/image-updates";
import { MemoryStore } from "../src/store/memory";

const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

function emptyDepot(): string {
  return mkdtempSync(join(tmpdir(), "pol161-depot-"));
}

/** Wait until start()'s async retain→reconcile→bootstrap chain has run. */
async function drain(): Promise<void> {
  for (let i = 0; i < 50; i++) await new Promise((r) => setTimeout(r, 0));
}

describe("stale build reconcile on start (POL-161)", () => {
  test("a store stuck 'running' with nothing in flight is reconciled to 'failure' on start()", async () => {
    const store = new MemoryStore();
    // The durable row a pod that died mid-build left behind: "running", never closed out.
    await store.setImageRollout({
      ...IMAGE_ROLLOUT_DEFAULTS,
      firstBuildAt: "2026-07-17T00:00:00.000Z", // latched, so bootstrap won't fire and muddy the test
      lastBuildStartedAt: "2026-07-17T01:00:00.000Z",
      lastBuildStatus: "running",
      lastBuildKind: "full",
    });

    // No rebuild hook configured → nothing can actually be in flight in THIS process.
    const iu = new ImageUpdates(store, emptyDepot(), undefined, log, undefined, 3);
    iu.start();
    await drain();
    iu.stop();

    const st = await store.getImageRollout();
    expect(st?.lastBuildStatus).toBe("failure");
    expect(st?.lastBuildFinishedAt).not.toBeNull();
    // The rest of the row is left intact — only the terminal state and finish time changed.
    expect(st?.lastBuildStartedAt).toBe("2026-07-17T01:00:00.000Z");
    expect(st?.lastBuildKind).toBe("full");
  });

  test("a genuinely in-flight build (this.running true) is left alone", async () => {
    const store = new MemoryStore();
    const root = emptyDepot();
    // A hook that stays in flight across the reconcile window, then exits cleanly (no dangling child).
    const iu = new ImageUpdates(store, root, "sh -c 'sleep 2'", log, "sh -c 'sleep 2'", 3);

    // Kick off a real run: this.running becomes true and the row goes "running".
    await iu.trigger("manual", "refresh");
    expect((await store.getImageRollout())?.lastBuildStatus).toBe("running");

    // start()'s reconcile must NOT close out the row this process actually owns.
    iu.start();
    await drain();
    iu.stop();
    expect((await store.getImageRollout())?.lastBuildStatus).toBe("running");

    // Let the real run finish so nothing is left dangling; it closes the row out itself.
    await iu.settled;
    expect((await store.getImageRollout())?.lastBuildStatus).toBe("success");
  });

  test("reconcile runs BEFORE bootstrap, so a fresh install whose first build was interrupted still bootstraps", async () => {
    const store = new MemoryStore();
    const root = emptyDepot();
    const marker = join(root, "runs");
    const arch = join(root, "arm64");
    // A first-image build that was interrupted: latch NOT claimed (the crash beat the claim in this
    // shape is fine either way — what matters is the stale "running" no longer blocks bootstrap).
    await store.setImageRollout({
      ...IMAGE_ROLLOUT_DEFAULTS,
      lastBuildStartedAt: "2026-07-17T01:00:00.000Z",
      lastBuildStatus: "running",
      lastBuildKind: "full",
    });
    const fullCmd =
      `sh -c 'mkdir -p ${arch}; printf "20260717T000000Z-deadbeef\\n" > ${arch}/image-id.txt; ` +
      `printf rootfs > ${arch}/rootfs.squashfs; printf x >> ${marker}; echo built'`;

    const iu = new ImageUpdates(store, root, undefined, log, fullCmd, 3);
    iu.start();
    for (let i = 0; i < 200 && !iu.settled; i++) await new Promise((r) => setTimeout(r, 10));
    await iu.settled;
    iu.stop();

    // The stale row was reconciled and did NOT strand the first build: the depot is now published.
    expect((await iu.manifests()).length).toBe(1);
    expect((await store.getImageRollout())?.lastBuildStatus).toBe("success");
  });
});
