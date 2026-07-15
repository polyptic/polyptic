/**
 * Staged (canary) roll-outs in the depot (POL-105).
 *
 * The depot answers `manifest.json` PER MACHINE now: `resolveFor(arch, tags)` is what a box's
 * 5-minute poll ultimately reads, so these tests pin the things that would either strand a box or
 * fan a canary build out across a whole fleet:
 *
 *   1. A ring must name a build the depot still RETAINS — you cannot pin a boot that 404s.
 *   2. A tagged box resolves to the ring's build (with the ring's own urgency); an untagged box, and
 *      an unknown box, resolve to the fleet's ACTIVE build. A ring only ever narrows.
 *   3. Retention stays a dumb count (D105 rejected pin-aware retention): pruning a ring's build out
 *      from under it degrades that ring's machines back onto the active build, loudly.
 *   4. PROMOTE = activate the ring's build + retire the ring, in one action with one activity line.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImageUpdates } from "../src/image-updates";
import { MemoryStore } from "../src/store/memory";

const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

const OLD = "20260710T010000Z-cccccccc";
const FLEET = "20260714T010000Z-aaaaaaaa";
const NEW = "20260714T020000Z-bbbbbbbb";

/** A depot with `builds/<id>/` for each id (oldest first) and the LAST one published at the root. */
function depot(...imageIds: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "pol105-depot-"));
  const arch = join(root, "amd64");
  mkdirSync(arch, { recursive: true });
  imageIds.forEach((imageId, i) => {
    const dir = join(arch, "builds", imageId);
    mkdirSync(dir, { recursive: true });
    for (const name of ["rootfs.squashfs", "vmlinuz", "initrd"]) writeFileSync(join(dir, name), `${name}-${imageId}`);
    writeFileSync(join(dir, "SHA256SUMS"), `sum-${imageId}  rootfs.squashfs\n`);
    // Build order comes from the payload's mtime; space them a minute apart so it is unambiguous.
    const t = new Date(Date.UTC(2026, 6, 14, 1, i));
    utimesSync(join(dir, "rootfs.squashfs"), t, t);
  });
  return root;
}

interface Fixture {
  root: string;
  updates: ImageUpdates;
  feed: { severity: string; text: string }[];
}

/** A depot holding `imageIds`, with `activeImageId` served at the arch root (+ image-id.txt). */
async function depotWith(activeImageId: string, ...imageIds: string[]): Promise<Fixture> {
  const root = depot(...imageIds);
  const feed: { severity: string; text: string }[] = [];
  const updates = new ImageUpdates(new MemoryStore(), root, undefined, log, undefined, 3, (severity, text) =>
    feed.push({ severity, text }),
  );
  await updates.activate("amd64", activeImageId);
  return { root, updates, feed };
}

const ring = (imageId: string, over: Record<string, unknown> = {}) => ({
  selector: "tag=canary",
  arch: "amd64" as const,
  imageId,
  urgent: false,
  ...over,
});

describe("roll-out rings", () => {
  test("a ring must name a RETAINED build, and its selector must parse", async () => {
    const { root, updates } = await depotWith(FLEET, FLEET, NEW);
    try {
      await expect(updates.setRings([ring("20260101T000000Z-nope")])).rejects.toThrow(/no retained amd64 build/);
      await expect(updates.setRings([ring(NEW, { selector: "everything" })])).rejects.toThrow(/unrecognised term/);
      await expect(updates.setRings([ring(NEW, { selector: "" })])).rejects.toThrow(/empty selector/);
      // Two rings for the same selector+arch would give one machine two answers.
      await expect(updates.setRings([ring(NEW), ring(FLEET)])).rejects.toThrow(/one answer/);
      expect(await updates.rings()).toEqual([]); // nothing was persisted by a rejected write
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a tagged box boots the ring's build; everyone else boots the fleet's", async () => {
    const { root, updates } = await depotWith(FLEET, OLD, FLEET, NEW);
    try {
      await updates.setRings([ring(NEW, { urgent: true })]);

      const canary = await updates.resolveFor("amd64", ["canary"]);
      expect(canary?.imageId).toBe(NEW);
      expect(canary?.urgent).toBe(true); // the RING's urgency — the fleet is not urgent
      expect(canary?.sha256).toBe(`sum-${NEW}`); // its own checksum, from its own build dir

      const rest = await updates.resolveFor("amd64", ["atrium"]);
      expect(rest?.imageId).toBe(FLEET);
      expect(rest?.urgent).toBe(false);

      // A box the server has never heard of sends no tags → the fleet build. This is the pre-POL-105
      // answer, and it is what a pre-POL-105 box (which sends no machineId at all) gets too.
      expect((await updates.resolveFor("amd64", []))?.imageId).toBe(FLEET);

      // Wrong arch: an arm64 poll is never answered with an amd64 ring's build.
      expect(await updates.resolveFor("arm64", ["canary"])).toBeNull(); // no arm64 image at all here
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a ring's build pruned out from under it → its boxes rejoin the fleet build, loudly", async () => {
    // The D105 call, executed: retention is a dumb count and is NOT pin-aware, so a ring pinned to an
    // ageing build eventually loses it. That must degrade, never 404 a boot.
    const root = depot(OLD, FLEET, NEW);
    const store = new MemoryStore();
    const feed: { severity: string; text: string }[] = [];
    const updates = new ImageUpdates(store, root, undefined, log, undefined, 3, (severity, text) =>
      feed.push({ severity, text }),
    );
    try {
      await updates.activate("amd64", FLEET);
      // Pin an AGEING build — the only pin retention can actually take away. (A canary pins the
      // NEWEST build, and prune keeps the newest by construction; the active build is never pruned.
      // So this is the one interaction that bites, and it is a stale ring by definition.)
      await updates.setRings([ring(OLD)]);

      // A depot that keeps only ONE build per arch now prunes OLD out from under the ring.
      const tight = new ImageUpdates(store, root, undefined, log, undefined, 1, () => {});
      await tight.prune("amd64");
      const left = (await updates.builds("amd64")).map((b) => b.imageId);
      expect(left).toContain(FLEET); // the active build is never pruned
      expect(left).toContain(NEW); // nor is the newest — a fresh canary's build is safe
      expect(left).not.toContain(OLD); // the ring's build is gone

      const canary = await updates.resolveFor("amd64", ["canary"]);
      expect(canary?.imageId).toBe(FLEET); // NOT a 404, and NOT the pruned id
      expect(canary?.urgent).toBe(false);
      expect(feed.some((l) => l.severity === "warn" && l.text.includes("pruned"))).toBe(true);
      // Announced once, not every five minutes per box.
      await updates.resolveFor("amd64", ["canary"]);
      expect(feed.filter((l) => l.text.includes("pruned")).length).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("promote = activate the ring's build AND retire the ring, with an activity line", async () => {
    const { root, updates, feed } = await depotWith(FLEET, OLD, FLEET, NEW);
    try {
      await updates.setRings([ring(NEW)]);
      await updates.promote("amd64", "tag=canary", true);

      expect((await updates.manifest("amd64"))?.imageId).toBe(NEW); // the fleet now serves it
      expect(await updates.rings()).toEqual([]); // the canary is retired, not left pinned
      expect((await updates.state()).urgent).toBe(true);
      expect(feed.some((l) => l.severity === "good" && l.text.includes("whole fleet"))).toBe(true);

      // Everyone — canary-tagged or not — now resolves to the same build. That is the promotion.
      expect((await updates.resolveFor("amd64", ["canary"]))?.imageId).toBe(NEW);
      expect((await updates.resolveFor("amd64", []))?.imageId).toBe(NEW);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("promoting a ring that does not exist is an error, not a silent fleet-wide activate", async () => {
    const { root, updates } = await depotWith(FLEET, FLEET, NEW);
    try {
      await expect(updates.promote("amd64", "tag=ghost", false)).rejects.toThrow(/no roll-out ring/);
      expect((await updates.manifest("amd64"))?.imageId).toBe(FLEET);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rings survive a restart (they are store state, not process state)", async () => {
    const root = depot(FLEET, NEW);
    const store = new MemoryStore();
    try {
      const first = new ImageUpdates(store, root, undefined, log);
      await first.activate("amd64", FLEET);
      await first.setRings([ring(NEW, { urgent: true })]);

      const second = new ImageUpdates(store, root, undefined, log);
      expect((await second.resolveFor("amd64", ["canary"]))?.imageId).toBe(NEW);
      expect((await second.rings())[0]?.urgent).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
