/**
 * POL-160 — the shared version guard that decides whether a box should self-update. It is the ONE
 * safety property both ends rely on: the server only offers when the served version is newer, and the
 * agent re-checks the same predicate before it installs anything, so an update can only move forward.
 */
import { describe, expect, test } from "bun:test";

import { isNewerAgentVersion, normalizeAgentVersion, sameAgentVersion } from "../src/index";

describe("normalizeAgentVersion / sameAgentVersion — the two ends spell a version differently", () => {
  test("the release tag's `v` is stripped, so `v0.6.0` and `0.6.0` are one version", () => {
    expect(normalizeAgentVersion("v0.6.0")).toBe("0.6.0");
    expect(normalizeAgentVersion("  0.6.0  ")).toBe("0.6.0");
    expect(sameAgentVersion("v0.6.0", "0.6.0")).toBe(true);
    expect(sameAgentVersion("v0.6.0", "0.6.1")).toBe(false);
  });

  test("a tagged offer orders against a bare running version, in both directions", () => {
    // The field case: the server offers the tag, the box reports the stripped form.
    expect(isNewerAgentVersion("v0.6.0", "0.3.6")).toBe(true);
    expect(isNewerAgentVersion("v0.3.6", "0.3.6")).toBe(false);
    expect(isNewerAgentVersion("0.3.6", "v0.6.0")).toBe(false);
    // Un-normalised, `v1` parsed as 0 and this said false — a box would never leave 0.9.9.
    expect(isNewerAgentVersion("v1.0.0", "0.9.9")).toBe(true);
  });
});

describe("isNewerAgentVersion (POL-160)", () => {
  test("a strictly newer version is newer", () => {
    expect(isNewerAgentVersion("0.2.41", "0.2.40")).toBe(true);
    expect(isNewerAgentVersion("0.3.0", "0.2.40")).toBe(true);
    expect(isNewerAgentVersion("1.0.0", "0.9.99")).toBe(true);
    expect(isNewerAgentVersion("0.2.41", "0.0.0")).toBe(true); // a dev/unknown box catches up
  });

  test("equal is NOT newer — the update path must be a no-op when the fleet matches the server", () => {
    expect(isNewerAgentVersion("0.2.41", "0.2.41")).toBe(false);
    expect(isNewerAgentVersion("1.2.3", "1.2.3")).toBe(false);
  });

  test("older is never newer — the core anti-downgrade guard", () => {
    expect(isNewerAgentVersion("0.2.40", "0.2.41")).toBe(false);
    expect(isNewerAgentVersion("0.2.9", "0.2.41")).toBe(false); // numeric, not lexicographic: 9 < 41
    expect(isNewerAgentVersion("0.0.0", "0.2.41")).toBe(false);
  });

  test("differing segment counts compare numerically, missing = 0", () => {
    expect(isNewerAgentVersion("0.2.41.1", "0.2.41")).toBe(true);
    expect(isNewerAgentVersion("0.2.41", "0.2.41.1")).toBe(false);
    expect(isNewerAgentVersion("1", "0.9.9")).toBe(true);
  });

  test("a pre-release/sha suffix counts as 0, so it never reads as newer than its release", () => {
    // "0.2.41-rc1" → [0,2,41,0]; "0.2.41" → [0,2,41] → equal, so not newer (we don't ship onto an rc).
    expect(isNewerAgentVersion("0.2.41-rc1", "0.2.41")).toBe(false);
    expect(isNewerAgentVersion("0.2.42-rc1", "0.2.41")).toBe(true);
  });
});
