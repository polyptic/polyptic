/**
 * POL-160 — the agent's runtime self-update, the safety-critical half. These pin the guards that stop
 * a bad update from wedging a box: never downgrade, never touch a non-binary dev run, verify before
 * swapping (size, sha, and a self-check that the new binary actually runs and reports the right
 * version), and roll a crash-looping new binary back to the one that worked.
 */
import { describe, expect, test } from "bun:test";

import {
  applyUpdate,
  decideStartupAction,
  httpBaseFromServerUrl,
  planUpdate,
  resolveUpdateUrl,
  selfBinaryPath,
  MAX_UNSTABLE_BOOTS,
  type UpdateIO,
  type UpdateMarker,
} from "../src/update";

// ── URL / path resolution ──────────────────────────────────────────────────────

describe("resolveUpdateUrl / httpBaseFromServerUrl", () => {
  test("ws→http and wss→https, same host", () => {
    expect(httpBaseFromServerUrl("ws://box.local:8080/agent")).toBe("http://box.local:8080");
    expect(httpBaseFromServerUrl("wss://ctrl:8443/agent")).toBe("https://ctrl:8443");
  });
  test("a same-origin path is resolved against the server URL", () => {
    expect(resolveUpdateUrl("ws://box.local:8080/agent", "/dist/agent/arm64")).toBe(
      "http://box.local:8080/dist/agent/arm64",
    );
  });
  test("an absolute URL in the offer is used verbatim", () => {
    expect(resolveUpdateUrl("ws://box.local:8080/agent", "https://cdn/x")).toBe("https://cdn/x");
  });
});

// ── selfBinaryPath: the "am I updatable" gate ────────────────────────────────────

describe("selfBinaryPath", () => {
  test("a dev/source run (no baked build version) is NOT updatable", () => {
    expect(selfBinaryPath({} as NodeJS.ProcessEnv)).toBeNull();
  });
  test("a baked binary (POLYPTIC_BUILD_VERSION set) reports execPath", () => {
    expect(selfBinaryPath({ POLYPTIC_BUILD_VERSION: "0.2.41" } as NodeJS.ProcessEnv)).toBe(process.execPath);
  });
  test("an explicit override wins (used by the swap tests)", () => {
    expect(selfBinaryPath({ POLYPTIC_AGENT_SELF_PATH: "/opt/agent" } as NodeJS.ProcessEnv)).toBe("/opt/agent");
  });
});

// ── planUpdate: the pre-flight decision ─────────────────────────────────────────

describe("planUpdate (POL-160)", () => {
  const base = { currentVersion: "0.2.40", binaryPath: "/opt/agent", attemptedVersions: new Set<string>() };

  test("applies when the offer is strictly newer and we are an updatable binary", () => {
    expect(planUpdate({ ...base, offerVersion: "0.2.41" })).toEqual({ action: "apply", binaryPath: "/opt/agent" });
  });
  test("skips an equal or older offer (never downgrade)", () => {
    expect(planUpdate({ ...base, offerVersion: "0.2.40" }).action).toBe("skip");
    expect(planUpdate({ ...base, offerVersion: "0.2.39" }).action).toBe("skip");
  });
  test("skips when this process is not an updatable binary", () => {
    expect(planUpdate({ ...base, binaryPath: null, offerVersion: "0.2.41" }).action).toBe("skip");
  });
  test("skips a version already attempted this session (no re-download loop)", () => {
    expect(
      planUpdate({ ...base, offerVersion: "0.2.41", attemptedVersions: new Set(["0.2.41"]) }).action,
    ).toBe("skip");
  });
});

// ── applyUpdate: download → verify → swap, with fakes ────────────────────────────

/** A scriptable UpdateIO that records the call order, so a test can assert the swap only happens
 *  after every verification passed. */
function fakeIO(overrides: Partial<UpdateIO> & { downloadedBytes?: number; reportedVersion?: string; sha?: string }): {
  io: UpdateIO;
  calls: string[];
} {
  const calls: string[] = [];
  const io: UpdateIO = {
    async download(_url, dest) {
      calls.push(`download→${dest}`);
      return overrides.downloadedBytes ?? 100;
    },
    async sha256() {
      calls.push("sha256");
      return overrides.sha ?? "abc";
    },
    async size() {
      calls.push("size");
      return overrides.downloadedBytes ?? 100;
    },
    async selfCheck() {
      calls.push("selfCheck");
      if (overrides.reportedVersion === undefined) throw new Error("selfCheck not scripted");
      return overrides.reportedVersion;
    },
    async makeExecutable() {
      calls.push("makeExecutable");
    },
    async copy(_from, to) {
      calls.push(`copy→${to}`);
    },
    async rename(from, to) {
      calls.push(`rename ${from}→${to}`);
    },
    async remove(path) {
      calls.push(`remove ${path}`);
    },
    ...overrides,
  };
  return { io, calls };
}

describe("applyUpdate (POL-160)", () => {
  const opts = { binaryPath: "/opt/agent", url: "http://s/dist/agent/arm64", targetVersion: "0.2.41", sizeBytes: 100 };

  test("happy path: verifies size + sha + self-check, backs up, then atomically renames", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 100, reportedVersion: "0.2.41", sha: "deadbeef" });
    const res = await applyUpdate({ ...opts, sha256: "deadbeef" }, io);
    expect(res.ok).toBe(true);
    // The rename (the actual swap) must come AFTER the self-check and the backup copy.
    const swapIdx = calls.findIndex((c) => c.startsWith("rename"));
    expect(calls.indexOf("selfCheck")).toBeLessThan(swapIdx);
    expect(calls.findIndex((c) => c.startsWith("copy→/opt/agent.bak"))).toBeLessThan(swapIdx);
    expect(calls).toContain("rename /opt/agent.new→/opt/agent");
  });

  test("a size mismatch aborts BEFORE any swap and cleans up the temp file", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 50, reportedVersion: "0.2.41" });
    const res = await applyUpdate(opts, io);
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.startsWith("rename"))).toBe(false);
    expect(calls).toContain("remove /opt/agent.new");
  });

  test("a sha256 mismatch aborts before any swap", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 100, reportedVersion: "0.2.41", sha: "wrong" });
    const res = await applyUpdate({ ...opts, sha256: "expected" }, io);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("sha256 mismatch");
    expect(calls.some((c) => c.startsWith("rename"))).toBe(false);
  });

  test("the DECISIVE guard: a binary that runs but reports the WRONG version is never swapped in", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 100, reportedVersion: "0.2.40" }); // not the target
    const res = await applyUpdate(opts, io);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("self-check version mismatch");
    expect(calls.some((c) => c.startsWith("rename"))).toBe(false);
    expect(calls).toContain("remove /opt/agent.new");
  });

  test("a binary that cannot even run --version is never swapped in", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 100 }); // selfCheck throws (not scripted)
    const res = await applyUpdate(opts, io);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("self-check failed to run");
    expect(calls.some((c) => c.startsWith("rename"))).toBe(false);
  });

  test("a zero-byte download aborts", async () => {
    const { io } = fakeIO({ downloadedBytes: 0, reportedVersion: "0.2.41" });
    const res = await applyUpdate({ ...opts, sizeBytes: undefined }, io);
    expect(res.ok).toBe(false);
  });
});

// ── decideStartupAction: the crash-loop rollback brain ──────────────────────────

describe("decideStartupAction (POL-160)", () => {
  const marker = (over: Partial<UpdateMarker>): UpdateMarker => ({
    targetVersion: "0.2.41",
    previousVersion: "0.2.40",
    swappedAt: "2026-07-17T00:00:00.000Z",
    boots: 1,
    committed: false,
    ...over,
  });

  test("no marker → nothing to do", () => {
    expect(decideStartupAction(null, "0.2.41").kind).toBe("none");
  });

  test("running the freshly-updated version, first boots → COMMIT (let it prove itself)", () => {
    expect(decideStartupAction(marker({ boots: 1 }), "0.2.41").kind).toBe("commit");
    expect(decideStartupAction(marker({ boots: MAX_UNSTABLE_BOOTS }), "0.2.41").kind).toBe("commit");
  });

  test("booted too many times without staying up → ROLLBACK", () => {
    expect(decideStartupAction(marker({ boots: MAX_UNSTABLE_BOOTS + 1 }), "0.2.41").kind).toBe("rollback");
  });

  test("an already-committed marker → nothing (the update is done)", () => {
    expect(decideStartupAction(marker({ committed: true, boots: 99 }), "0.2.41").kind).toBe("none");
  });

  test("a marker for a version we are NOT running → nothing (a rollback already happened)", () => {
    // We are back on the previous version, so the marker's target isn't what's running: clear it.
    expect(decideStartupAction(marker({ boots: 99 }), "0.2.40").kind).toBe("none");
  });
});
