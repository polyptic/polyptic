/**
 * Build retention + activation in the image depot (POL-45).
 *
 * The depot is the source of truth: `<arch>/builds/<imageId>/` holds every retained build, and the
 * arch root holds the ACTIVE one (hardlinked for the ISOs, copied for the artifacts the build
 * scripts rewrite in place). These tests pin the three things that would silently corrupt a fleet:
 *
 *   1. Adopting a pre-POL-45 depot must not lose the published image.
 *   2. Activating a build must repoint the arch root AND image-id.txt — that is the rollback path,
 *      because every netbooted box compares manifest.json's imageId to its own every 5 minutes.
 *   3. Pruning must never delete the active build, and `SHA256SUMS` must never be shared by
 *      hardlink — `refresh-live-image.sh` writes it with shell `>`, which truncates in place and
 *      would rewrite a retained build's checksums through the link.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ImageUpdates } from "../src/image-updates";
import { MemoryStore } from "../src/store/memory";

// The class only ever calls .info/.warn/.error on its logger.
const log = { info: () => {}, warn: () => {}, error: () => {} } as never;

/** A depot with one published image at the arch root, exactly as a pre-POL-45 build left it. */
function depotWithPublished(imageId: string): string {
  const root = mkdtempSync(join(tmpdir(), "pol45-depot-"));
  const arch = join(root, "arm64");
  mkdirSync(arch, { recursive: true });
  writeFileSync(join(arch, "image-id.txt"), `${imageId}\n`);
  writeFileSync(join(arch, "rootfs.squashfs"), `rootfs-${imageId}`);
  writeFileSync(join(arch, "vmlinuz"), `vmlinuz-${imageId}`);
  writeFileSync(join(arch, "initrd"), `initrd-${imageId}`);
  writeFileSync(join(arch, "SHA256SUMS"), `deadbeef  rootfs.squashfs\n`);
  return root;
}

/** Write a retained build directly into builds/, as a completed hook + adopt would leave it. */
function seedBuild(root: string, imageId: string, opts: { liveIso?: boolean } = {}): void {
  const dir = join(root, "arm64", "builds", imageId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "rootfs.squashfs"), `rootfs-${imageId}`);
  writeFileSync(join(dir, "vmlinuz"), `vmlinuz-${imageId}`);
  writeFileSync(join(dir, "initrd"), `initrd-${imageId}`);
  writeFileSync(join(dir, "SHA256SUMS"), `sha-${imageId}  rootfs.squashfs\n`);
  if (opts.liveIso) writeFileSync(join(dir, "polyptic-live.iso"), `live-${imageId}`);
}

/** builds() sorts on the payload's mtime, so give the seeded builds distinct, ordered times. */
function stampMtime(root: string, imageId: string, epochSeconds: number): void {
  const payload = join(root, "arm64", "builds", imageId, "rootfs.squashfs");
  const t = new Date(epochSeconds * 1000);
  utimesSync(payload, t, t);
}

function makeUpdates(root: string, retain = 3): ImageUpdates {
  return new ImageUpdates(new MemoryStore(), root, undefined, log, undefined, retain);
}

describe("image build retention (POL-45)", () => {
  test("adopt() folds a pre-POL-45 depot into builds/ without losing the published image", async () => {
    const root = depotWithPublished("20260701T000000Z-aaaaaaaa");
    const iu = makeUpdates(root);

    expect(await iu.builds("arm64")).toEqual([]);
    await iu.adopt("arm64");

    const builds = await iu.builds("arm64");
    expect(builds).toHaveLength(1);
    expect(builds[0]!.imageId).toBe("20260701T000000Z-aaaaaaaa");
    expect(builds[0]!.active).toBe(true);
    expect(builds[0]!.hasLiveIso).toBe(false);
    // The arch root is untouched — the boot chain still serves what it always did.
    expect(readFileSync(join(root, "arm64", "rootfs.squashfs"), "utf8")).toBe("rootfs-20260701T000000Z-aaaaaaaa");
  });

  test("adopt() is idempotent and a no-op on an arch with no published image", async () => {
    const root = depotWithPublished("20260701T000000Z-aaaaaaaa");
    const iu = makeUpdates(root);
    await iu.adopt("arm64");
    await iu.adopt("arm64");
    expect(await iu.builds("arm64")).toHaveLength(1);

    await iu.adopt("amd64"); // no depot for this arch at all
    expect(await iu.builds("amd64")).toEqual([]);
  });

  test("the ISO is hardlinked (shared) but SHA256SUMS is copied, so an in-place `>` cannot corrupt history", async () => {
    const root = depotWithPublished("20260701T000000Z-aaaaaaaa");
    const iu = makeUpdates(root);
    await iu.adopt("arm64");

    const archRoot = join(root, "arm64");
    const buildDir = join(archRoot, "builds", "20260701T000000Z-aaaaaaaa");

    // rootfs.squashfs: same inode → the big artifact costs nothing twice.
    expect(statSync(join(archRoot, "rootfs.squashfs")).ino).toBe(statSync(join(buildDir, "rootfs.squashfs")).ino);
    // SHA256SUMS: distinct inodes → truncating the root copy leaves the build's intact.
    expect(statSync(join(archRoot, "SHA256SUMS")).ino).not.toBe(statSync(join(buildDir, "SHA256SUMS")).ino);

    // Simulate refresh-live-image.sh's `sha256sum … > SHA256SUMS` on the arch root.
    writeFileSync(join(archRoot, "SHA256SUMS"), "cafebabe  rootfs.squashfs\n");
    expect(readFileSync(join(buildDir, "SHA256SUMS"), "utf8")).toBe("deadbeef  rootfs.squashfs\n");
  });

  test("activate() repoints the arch root and republishes the id — the fleet rollback path", async () => {
    const root = depotWithPublished("20260703T000000Z-newnewnn");
    const iu = makeUpdates(root);
    await iu.adopt("arm64");
    seedBuild(root, "20260701T000000Z-oldoldoo", { liveIso: true });
    stampMtime(root, "20260701T000000Z-oldoldoo", 1_760_000_000);

    await iu.activate("arm64", "20260701T000000Z-oldoldoo");

    const archRoot = join(root, "arm64");
    // What every netbooted box polls, and what dracut streams, are both the older build now.
    expect(readFileSync(join(archRoot, "image-id.txt"), "utf8").trim()).toBe("20260701T000000Z-oldoldoo");
    expect(readFileSync(join(archRoot, "rootfs.squashfs"), "utf8")).toBe("rootfs-20260701T000000Z-oldoldoo");
    expect((await iu.manifest("arm64"))!.imageId).toBe("20260701T000000Z-oldoldoo");

    const builds = await iu.builds("arm64");
    expect(builds.find((b) => b.imageId === "20260701T000000Z-oldoldoo")!.active).toBe(true);
    expect(builds.find((b) => b.imageId === "20260703T000000Z-newnewnn")!.active).toBe(false);
    // Rolling back did not destroy the build we rolled back FROM.
    expect(readFileSync(join(archRoot, "builds", "20260703T000000Z-newnewnn", "rootfs.squashfs"), "utf8")).toBe(
      "rootfs-20260703T000000Z-newnewnn",
    );
  });

  test("activate() drops a stale root live ISO when the newly active build has none", async () => {
    const root = depotWithPublished("20260703T000000Z-newnewnn");
    writeFileSync(join(root, "arm64", "polyptic-live.iso"), "live-new");
    const iu = makeUpdates(root);
    await iu.adopt("arm64");
    seedBuild(root, "20260701T000000Z-oldoldoo"); // no live ISO

    await iu.activate("arm64", "20260701T000000Z-oldoldoo");
    expect(() => statSync(join(root, "arm64", "polyptic-live.iso"))).toThrow();
  });

  test("activate() rejects a build the depot does not retain", async () => {
    const root = depotWithPublished("20260703T000000Z-newnewnn");
    const iu = makeUpdates(root);
    await iu.adopt("arm64");
    expect(iu.activate("arm64", "20260101T000000Z-nosuchhh")).rejects.toThrow(/no retained build/);
    expect(iu.activate("riscv", "20260703T000000Z-newnewnn")).rejects.toThrow(/unknown architecture/);
  });

  test("prune() keeps the newest N and never loses the active build, even when it is the oldest", async () => {
    const root = depotWithPublished("20260701T000000Z-oldoldoo"); // active = the OLDEST
    const iu = makeUpdates(root, 2);
    await iu.adopt("arm64");
    stampMtime(root, "20260701T000000Z-oldoldoo", 1_700_000_000);
    for (const [id, t] of [
      ["20260702T000000Z-bbbbbbbb", 1_700_000_100],
      ["20260703T000000Z-cccccccc", 1_700_000_200],
      ["20260704T000000Z-dddddddd", 1_700_000_300],
    ] as const) {
      seedBuild(root, id);
      stampMtime(root, id, t);
    }

    await iu.prune("arm64");
    const kept = (await iu.builds("arm64")).map((b) => b.imageId).sort();

    // retain=2 keeps the two newest; the active build survives on top of that quota rather than
    // being pruned out from under the boot chain that is serving it right now.
    expect(kept).toEqual(["20260701T000000Z-oldoldoo", "20260703T000000Z-cccccccc", "20260704T000000Z-dddddddd"]);
    expect(readFileSync(join(root, "arm64", "image-id.txt"), "utf8").trim()).toBe("20260701T000000Z-oldoldoo");
  });

  test("builds() reports newest first, flags the active one, and detects the live ISO", async () => {
    const root = depotWithPublished("20260702T000000Z-bbbbbbbb");
    const iu = makeUpdates(root);
    await iu.adopt("arm64");
    stampMtime(root, "20260702T000000Z-bbbbbbbb", 1_700_000_100);
    seedBuild(root, "20260703T000000Z-cccccccc", { liveIso: true });
    stampMtime(root, "20260703T000000Z-cccccccc", 1_700_000_200);

    const builds = await iu.builds("arm64");
    expect(builds.map((b) => b.imageId)).toEqual(["20260703T000000Z-cccccccc", "20260702T000000Z-bbbbbbbb"]);
    expect(builds[0]!.hasLiveIso).toBe(true);
    expect(builds[0]!.active).toBe(false);
    expect(builds[1]!.active).toBe(true);
    expect(builds[1]!.sha256).toBe("deadbeef");
  });

  test("a directory without a payload root image is not a build", async () => {
    const root = depotWithPublished("20260702T000000Z-bbbbbbbb");
    mkdirSync(join(root, "arm64", "builds", "half-written"), { recursive: true });
    const iu = makeUpdates(root);
    await iu.adopt("arm64");
    expect((await iu.builds("arm64")).map((b) => b.imageId)).toEqual(["20260702T000000Z-bbbbbbbb"]);
  });
});

// ── POL-79: the active build must ALWAYS have a builds/<id>/ mirror ──────────────────────────────
//
// The local boot medium PINS `root=live:…/dist/image/<arch>/builds/<active-id>/rootfs.squashfs`
// (POL-63/D67), so a box 404s and retries forever if the active build reached the arch root by a
// path that never ran a reconcile — an externally-run rebuild Job, or a partially-failed multi-arch
// hook run whose non-zero exit skipped the post-rebuild retain. These tests reproduce that gap (the
// homelab's exact state: builds/ held the OLDER builds but not the ACTIVE one) and prove the heal.

describe("active build is always mirrored into builds/ (POL-79)", () => {
  /** Overwrite the arch root with a brand-new active build, as an EXTERNAL rebuild (a Job run
   *  directly, bypassing the server's execute→retain) would leave it: new artifacts + image-id.txt
   *  at the root, and NO builds/<new-id>/ mirror.
   *
   *  Faithful to `build-live-image.sh` (`rm -f "$OUT_DIR/rootfs.squashfs"` then `mksquashfs`, line
   *  321): a real rebuild ALLOCATES A NEW INODE for the payload, so an already-adopted OLDER build
   *  keeps its own inode + mtime. Writing in place (writeFileSync without the rm) would instead
   *  TRUNCATE the inode the old mirror is hardlinked to, corrupting its content and collapsing its
   *  mtime onto the new build's — a nondeterministic tie that made this suite pass on macOS but flip
   *  on Linux's readdir order. The explicit newest-mtime stamp then makes the freshly-published build
   *  sort ahead of any retained older one, deterministically. */
  function externalRebuildAtRoot(root: string, imageId: string, epochSeconds = 1_800_000_000): void {
    const arch = join(root, "arm64");
    for (const name of ["image-id.txt", "rootfs.squashfs", "vmlinuz", "initrd", "initrd-wifi", "SHA256SUMS"]) {
      rmSync(join(arch, name), { force: true }); // fresh inode, exactly like the build script's `rm -f`
    }
    writeFileSync(join(arch, "image-id.txt"), `${imageId}\n`);
    writeFileSync(join(arch, "rootfs.squashfs"), `rootfs-${imageId}`);
    writeFileSync(join(arch, "vmlinuz"), `vmlinuz-${imageId}`);
    writeFileSync(join(arch, "initrd"), `initrd-${imageId}`);
    writeFileSync(join(arch, "initrd-wifi"), `initrd-wifi-${imageId}`);
    writeFileSync(join(arch, "SHA256SUMS"), `sha-${imageId}  rootfs.squashfs\n`);
    const t = new Date(epochSeconds * 1000);
    utimesSync(join(arch, "rootfs.squashfs"), t, t); // adopt() hardlinks this, so the mirror inherits it
  }

  test("ensureActiveBuild() heals a depot whose active build reached the arch root with no mirror", async () => {
    // Start with an adopted history, then simulate an external rebuild bumping the arch root.
    const root = depotWithPublished("20260709T000000Z-oldbuild");
    const iu = makeUpdates(root);
    await iu.adopt("arm64"); // builds/<old>/ exists; old is active
    stampMtime(root, "20260709T000000Z-oldbuild", 1_700_000_000);

    externalRebuildAtRoot(root, "20260711T191928Z-981386cb"); // the homelab's active id shape

    // The gap: the active build is only at the arch root — its pinned builds/<id>/ path is a 404.
    expect(statSync(join(root, "arm64", "rootfs.squashfs"), { throwIfNoEntry: false })).toBeDefined();
    expect(statSync(join(root, "arm64", "builds", "20260711T191928Z-981386cb"), { throwIfNoEntry: false })).toBeUndefined();

    await iu.ensureActiveBuild("arm64");

    // The mirror now exists and carries every artifact the netboot chain streams.
    const dir = join(root, "arm64", "builds", "20260711T191928Z-981386cb");
    expect(readFileSync(join(dir, "rootfs.squashfs"), "utf8")).toBe("rootfs-20260711T191928Z-981386cb");
    expect(readFileSync(join(dir, "vmlinuz"), "utf8")).toBe("vmlinuz-20260711T191928Z-981386cb");
    expect(readFileSync(join(dir, "initrd"), "utf8")).toBe("initrd-20260711T191928Z-981386cb");
    expect(readFileSync(join(dir, "initrd-wifi"), "utf8")).toBe("initrd-wifi-20260711T191928Z-981386cb");
    expect(readFileSync(join(dir, "SHA256SUMS"), "utf8")).toBe("sha-20260711T191928Z-981386cb  rootfs.squashfs\n");

    // rootfs.squashfs is shared by hardlink — the mirror costs no extra bytes.
    expect(statSync(join(root, "arm64", "rootfs.squashfs")).ino).toBe(statSync(join(dir, "rootfs.squashfs")).ino);

    // builds() now flags the new build active, and the old one survives as (inactive) history.
    const builds = await iu.builds("arm64");
    expect(builds.find((b) => b.imageId === "20260711T191928Z-981386cb")!.active).toBe(true);
    expect(builds.find((b) => b.imageId === "20260709T000000Z-oldbuild")!.active).toBe(false);
  });

  test("ensureActiveBuild() is idempotent — a second call is a no-op that keeps the same inode", async () => {
    const root = depotWithPublished("20260711T191928Z-981386cb");
    const iu = makeUpdates(root);

    await iu.ensureActiveBuild("arm64");
    const dir = join(root, "arm64", "builds", "20260711T191928Z-981386cb");
    const inoAfterFirst = statSync(join(dir, "rootfs.squashfs")).ino;

    await iu.ensureActiveBuild("arm64");
    expect((await iu.builds("arm64"))).toHaveLength(1);
    expect(statSync(join(dir, "rootfs.squashfs")).ino).toBe(inoAfterFirst); // untouched, not re-linked
  });

  test("retain() heals every arch and never prunes the freshly-mirrored active build", async () => {
    const root = depotWithPublished("20260709T000000Z-oldbuild");
    const iu = makeUpdates(root, 1); // retain just ONE — the active build must still survive
    await iu.adopt("arm64");
    stampMtime(root, "20260709T000000Z-oldbuild", 1_700_000_000);
    externalRebuildAtRoot(root, "20260711T191928Z-981386cb");

    await iu.retain(); // the post-rebuild / startup reconcile

    const builds = await iu.builds("arm64");
    // The active build was mirrored AND kept despite retain=1; the older one is pruned out.
    expect(builds.map((b) => b.imageId)).toEqual(["20260711T191928Z-981386cb"]);
    expect(builds[0]!.active).toBe(true);
  });
});
