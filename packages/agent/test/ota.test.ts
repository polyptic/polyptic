/**
 * OTA (POL-28) slot-management + update-flow unit tests.
 *
 * These drive the REAL filesystem logic against a temp dir (symlinks, version dirs, markers) — only
 * the network/reboot/clock are faked via the OtaSys seam. They cover the safety-critical paths: verify
 * before swap, atomic A/B flip, retained-slot activation (rollback path), and the standalone rollback
 * guard's deadline gating.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentVersion,
  hasStagedVersion,
  performUpdate,
  previousVersion,
  readMarker,
  rollbackIfExpired,
  seedSlot,
  slotBin,
  stagedVersions,
} from "../src/ota";
import type { OtaSys } from "../src/ota";

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

let root: string;

interface FakeSys {
  sys: OtaSys;
  downloads(): number;
  rebooted(): boolean;
}

/** Build a fake OtaSys whose download writes `content` and whose clock returns `now`. */
function fakeSys(content: string, now = 1_000_000): FakeSys {
  let downloads = 0;
  let didReboot = false;
  const sys: OtaSys = {
    now: () => now,
    download: async (_url, dest) => {
      downloads += 1;
      writeFileSync(dest, content);
    },
    sha256: async (path) => sha256(readFileSync(path, "utf8")),
    reboot: () => {
      didReboot = true;
    },
  };
  return { sys, downloads: () => downloads, rebooted: () => didReboot };
}

/** Manually stage a version's binary (as if a prior update had retained it). */
function stage(version: string, content: string): void {
  const dest = slotBin(root, version);
  mkdirSync(join(root, "versions", version), { recursive: true });
  writeFileSync(dest, content);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "polyptic-ota-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("slot seeding", () => {
  test("seedSlot installs the binary + points current at it; idempotent", () => {
    const src = join(root, "src-agent");
    writeFileSync(src, "v1-bytes");
    seedSlot(root, "0.1.0", src);

    expect(currentVersion(root)).toBe("0.1.0");
    expect(hasStagedVersion(root, "0.1.0")).toBe(true);
    expect(readFileSync(slotBin(root, "0.1.0"), "utf8")).toBe("v1-bytes");

    // Re-seeding a NEW version does not clobber an existing current (only seeds when current is unset).
    const src2 = join(root, "src-agent-2");
    writeFileSync(src2, "v2-bytes");
    seedSlot(root, "0.2.0", src2);
    expect(currentVersion(root)).toBe("0.1.0"); // unchanged
    expect(hasStagedVersion(root, "0.2.0")).toBe(true); // but the binary is staged
  });
});

describe("performUpdate — download + verify + A/B flip", () => {
  test("downloads, verifies the checksum, installs + flips current, records previous, arms the marker", async () => {
    seedSlot(root, "0.1.0", writeSrc("v1"));
    const content = "brand-new-agent-v2";
    const { sys } = fakeSys(content, 5_000);

    const result = await performUpdate(root, sys, {
      targetVersion: "0.2.0",
      artifact: { sha256: sha256(content) },
      downloadUrl: "http://server/dist/agent/amd64",
      confirmWindowMs: 60_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usedLocalSlot).toBe(false);
    expect(currentVersion(root)).toBe("0.2.0");
    expect(previousVersion(root)).toBe("0.1.0");
    expect(readFileSync(slotBin(root, "0.2.0"), "utf8")).toBe(content);

    const marker = readMarker(root);
    expect(marker?.version).toBe("0.2.0");
    expect(marker?.deadlineMs).toBe(5_000 + 60_000);
  });

  test("a checksum MISMATCH aborts — current stays put, no new slot, no marker", async () => {
    seedSlot(root, "0.1.0", writeSrc("v1"));
    const { sys } = fakeSys("tampered-bytes");

    const result = await performUpdate(root, sys, {
      targetVersion: "0.2.0",
      artifact: { sha256: "00".repeat(32) }, // deliberately wrong
      downloadUrl: "http://server/dist/agent/amd64",
      confirmWindowMs: 60_000,
    });

    expect(result.ok).toBe(false);
    expect(currentVersion(root)).toBe("0.1.0"); // untouched
    expect(hasStagedVersion(root, "0.2.0")).toBe(false);
    expect(readMarker(root)).toBeNull();
  });
});

describe("performUpdate — retained-slot activation (rollback / re-offer)", () => {
  test("activates a locally-present verified slot without downloading", async () => {
    seedSlot(root, "0.2.0", writeSrc("v2")); // current = 0.2.0
    stage("0.1.0", "v1-bytes"); // a retained older slot
    const state = fakeSys("should-not-be-used");

    // Offer a rollback to 0.1.0 with NO artifact — the box must use its retained slot.
    const result = await performUpdate(root, state.sys, {
      targetVersion: "0.1.0",
      downloadUrl: "http://server/dist/agent/amd64",
      confirmWindowMs: 60_000,
    });

    expect(result.ok).toBe(true);
    if (result.ok) expect(result.usedLocalSlot).toBe(true);
    expect(state.downloads()).toBe(0); // never downloaded
    expect(currentVersion(root)).toBe("0.1.0");
    expect(previousVersion(root)).toBe("0.2.0");
    expect(readMarker(root)?.version).toBe("0.1.0");
  });

  test("no retained slot AND no artifact → fails cleanly", async () => {
    seedSlot(root, "0.1.0", writeSrc("v1"));
    const { sys } = fakeSys("x");
    const result = await performUpdate(root, sys, {
      targetVersion: "9.9.9",
      downloadUrl: "http://server/dist/agent/amd64",
      confirmWindowMs: 60_000,
    });
    expect(result.ok).toBe(false);
    expect(currentVersion(root)).toBe("0.1.0");
  });
});

describe("rollbackIfExpired — the standalone guard", () => {
  test("reverts current→previous when the marker is past its deadline and we're still on the target", async () => {
    seedSlot(root, "0.1.0", writeSrc("v1"));
    stage("0.2.0", "v2-bytes");
    // Simulate a staged update to 0.2.0: current→0.2.0, previous→0.1.0, marker deadline in the past.
    const { sys } = fakeSys("x", 1000);
    await performUpdate(root, sys, {
      targetVersion: "0.2.0",
      downloadUrl: "u",
      confirmWindowMs: 100, // deadline = 1100
    });
    expect(currentVersion(root)).toBe("0.2.0");

    // The trial boot never committed; the guard fires AFTER the deadline.
    const crumb = rollbackIfExpired(root, 5000);
    expect(crumb).not.toBeNull();
    expect(crumb?.revertedFrom).toBe("0.2.0");
    expect(crumb?.revertedTo).toBe("0.1.0");
    expect(currentVersion(root)).toBe("0.1.0"); // reverted
    expect(readMarker(root)).toBeNull(); // marker cleared
  });

  test("does nothing while still within the grace period", async () => {
    seedSlot(root, "0.1.0", writeSrc("v1"));
    stage("0.2.0", "v2-bytes");
    const { sys } = fakeSys("x", 1000);
    await performUpdate(root, sys, { targetVersion: "0.2.0", downloadUrl: "u", confirmWindowMs: 10_000 });

    const crumb = rollbackIfExpired(root, 2000); // 2000 < deadline 11000
    expect(crumb).toBeNull();
    expect(currentVersion(root)).toBe("0.2.0"); // untouched
    expect(readMarker(root)?.version).toBe("0.2.0");
  });

  test("clears a stale marker (current no longer the guarded version) without reverting", async () => {
    seedSlot(root, "0.1.0", writeSrc("v1"));
    stage("0.2.0", "v2-bytes");
    const { sys } = fakeSys("x", 1000);
    await performUpdate(root, sys, { targetVersion: "0.2.0", downloadUrl: "u", confirmWindowMs: 100 });
    // Simulate that a rollback already happened (current is back on 0.1.0) but the marker lingers.
    rollbackIfExpired(root, 5000); // reverts to 0.1.0, clears marker, writes breadcrumb
    // Re-write a lingering marker for 0.2.0 while current is 0.1.0.
    writeFileSync(join(root, "confirm.json"), JSON.stringify({ version: "0.2.0", deadlineMs: 0 }));

    const crumb = rollbackIfExpired(root, 9999);
    expect(crumb).toBeNull(); // no double-revert
    expect(currentVersion(root)).toBe("0.1.0");
    expect(readMarker(root)).toBeNull(); // stale marker cleared
  });
});

describe("pruneSlots (via performUpdate)", () => {
  test("keeps exactly current + previous after an update", async () => {
    seedSlot(root, "0.1.0", writeSrc("v1"));
    // Two sequential downloaded updates: 0.1.0 → 0.2.0 → 0.3.0.
    for (const [v, c] of [["0.2.0", "c2"], ["0.3.0", "c3"]] as const) {
      const { sys } = fakeSys(c, 1000);
      await performUpdate(root, sys, {
        targetVersion: v,
        artifact: { sha256: sha256(c) },
        downloadUrl: "u",
        confirmWindowMs: 1000,
      });
    }
    const versions = stagedVersions(root).sort();
    expect(currentVersion(root)).toBe("0.3.0");
    expect(previousVersion(root)).toBe("0.2.0");
    expect(versions).toEqual(["0.2.0", "0.3.0"]); // 0.1.0 pruned
  });
});

// helper: write a source binary file, returning its path
function writeSrc(tag: string): string {
  const p = join(root, `src-${tag}`);
  writeFileSync(p, `${tag}-bytes`);
  return p;
}
