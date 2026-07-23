/**
 * POL-176 — the install-to-disk helpers behind the Machines card and dialog.
 *
 * The rules with teeth, pinned here:
 *   • A REMOVABLE disk is never an install target — the dialog must not offer the very USB stick
 *     the box booted from.
 *   • "Update ready" compares the staged id against the RUNNING id (live vitals first, persisted
 *     imageId as the fallback), and stays quiet while ANY install state is on the card.
 *   • `done` and `failed` are outcomes, not activity — activeInstall() must not report them.
 */
import { describe, expect, test } from "bun:test";
import type { MachineDisk } from "@polyptic/protocol";

import {
  activeInstall,
  formatDiskSize,
  formatImageId,
  installProgressText,
  installTargets,
  updateReady,
} from "../src/install";

const GIB = 1024 ** 3;

describe("formatDiskSize", () => {
  test("a typical SSD reads in whole GiB", () => {
    expect(formatDiskSize(238 * GIB + 5_000_000)).toBe("238 GiB");
  });
  test("a small disk keeps one decimal", () => {
    expect(formatDiskSize(7.5 * GIB)).toBe("7.5 GiB");
  });
  test("a sub-GiB medium falls back to MiB, never 0 GiB", () => {
    expect(formatDiskSize(512 * 1024 ** 2)).toBe("512 MiB");
  });
});

describe("formatImageId", () => {
  test("splits the build id at its LAST dash (the timestamp holds none)", () => {
    expect(formatImageId("20260709T110917Z-1bdb6281")).toBe("20260709T110917Z · 1bdb6281");
  });
  test("an id with no dash passes through untouched", () => {
    expect(formatImageId("deadbeef")).toBe("deadbeef");
  });
});

const disks: MachineDisk[] = [
  { device: "/dev/sda", sizeBytes: 238 * GIB, model: "Samsung 870", removable: false, contents: "ext4 (Ubuntu 24.04)" },
  { device: "/dev/sdb", sizeBytes: 14 * GIB, removable: true, contents: "vfat (POLYPTIC)" },
];

describe("installTargets", () => {
  test("drops removable media — the boot stick is never an install target", () => {
    expect(installTargets(disks).map((d) => d.device)).toEqual(["/dev/sda"]);
  });
  test("no inventory means no targets, not a crash", () => {
    expect(installTargets(undefined)).toEqual([]);
  });
});

describe("activeInstall", () => {
  test("a running phase is active", () => {
    const installing = { phase: "fetching" as const, percent: 42, at: "2026-07-23T10:00:00Z" };
    expect(activeInstall({ installing })).toEqual(installing);
  });
  test("done and failed are outcomes, not activity", () => {
    expect(activeInstall({ installing: { phase: "done", at: "2026-07-23T10:00:00Z" } })).toBeNull();
    expect(activeInstall({ installing: { phase: "failed", at: "2026-07-23T10:00:00Z" } })).toBeNull();
    expect(activeInstall({})).toBeNull();
  });
});

describe("installProgressText", () => {
  test("names the phase and carries the percentage", () => {
    expect(installProgressText({ phase: "fetching", percent: 42, at: "" })).toBe(
      "Installing to disk — fetching the image (42%)",
    );
  });
  test("omits the percentage when the phase reports none", () => {
    expect(installProgressText({ phase: "wiping", at: "" })).toBe(
      "Installing to disk — wiping the disk",
    );
  });
});

describe("updateReady", () => {
  const staged = "20260723T090000Z-aabbccdd";
  const running = "20260709T110917Z-1bdb6281";

  test("staged differs from the running image → ready", () => {
    expect(updateReady({ stagedImageId: staged, imageId: running })).toBe(true);
  });
  test("staged equals the running image → nothing to apply", () => {
    expect(updateReady({ stagedImageId: running, imageId: running })).toBe(false);
  });
  test("the LIVE vitals id outranks the persisted one", () => {
    // Persisted imageId is stale (pre-reboot); the box's heartbeat already reports the staged build.
    expect(
      updateReady({ stagedImageId: staged, imageId: running, vitals: { imageId: staged } }),
    ).toBe(false);
  });
  test("no staged image → not ready", () => {
    expect(updateReady({ imageId: running })).toBe(false);
  });
  test("quiet while install state is on the card — one story at a time", () => {
    expect(
      updateReady({
        stagedImageId: staged,
        imageId: running,
        installing: { phase: "fetching", at: "" },
      }),
    ).toBe(false);
  });
});
