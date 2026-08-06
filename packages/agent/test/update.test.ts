/**
 * POL-160 — the agent's runtime self-update, the safety-critical half. These pin the guards that stop
 * a bad update from wedging a box: never downgrade, never touch a non-binary dev run, verify before
 * swapping (size, sha, and a self-check that the new binary actually runs and reports the right
 * version), and roll a crash-looping new binary back to the one that worked.
 *
 * They also pin the two field bugs this feature shipped with:
 *   - "am I updatable" was answered from an environment variable that `--define` never substituted,
 *     so every compiled box declared itself a dev/source run. The answer now comes from the embedded
 *     filesystem, and test/update-compiled.test.ts asserts it against a REAL compiled binary.
 *   - the swap was a `rename()` into root-owned /usr/local/bin by an unprivileged agent, i.e. EACCES
 *     on every box. The swap now goes through the privileged request seam, which is tested here.
 */
import { describe, expect, test } from "bun:test";

import {
  applyUpdate,
  chooseSwapMode,
  decideStartupAction,
  directSwapPlan,
  helperSwapPlan,
  httpBaseFromServerUrl,
  isCompiledBinary,
  isEmbeddedModuleUrl,
  parseUpdateResult,
  planUpdate,
  renderUpdateRequest,
  requestHelperAction,
  resolveUpdateUrl,
  selfBinaryPath,
  MAX_UNSTABLE_BOOTS,
  UPDATE_REQUEST_DIR,
  UPDATE_REQUEST_PATH,
  UPDATE_RESULT_PATH,
  UPDATE_STAGE_PATH,
  type SwapMode,
  type UpdateIO,
  type UpdateMarker,
} from "../src/update";
import {
  AGENT_UPDATE_REQUEST_PATH,
  AGENT_UPDATE_RESULT_PATH,
  AGENT_UPDATE_STAGE_PATH,
  agentUpdatePathUnit,
  agentUpdateScript,
  agentUpdateServiceUnit,
} from "../src/setup/templates";

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

// ── isCompiledBinary / selfBinaryPath: the "am I updatable" gate ────────────────

describe("isCompiledBinary — answered from the embedded filesystem, not the environment", () => {
  test("a module URL inside a compiled binary's embedded FS is the compiled signal", () => {
    expect(isEmbeddedModuleUrl("file:///$bunfs/root/index.ts")).toBe(true);
    expect(isEmbeddedModuleUrl("file:///~BUN/root/index.ts")).toBe(true);
    expect(isEmbeddedModuleUrl("file:///Users/dev/polyptic/packages/agent/src/update.ts")).toBe(false);
  });

  test("a compiled binary is updatable even with a BLANK environment — the whole POL-160 field bug", () => {
    // The production process had POLYPTIC_BUILD_VERSION nowhere in its real environment (the define
    // substituted a literal at compile time, not a variable at runtime) and still declined 176
    // offers as a "dev/source run". The embedded-FS signal alone must carry it.
    expect(isCompiledBinary({ moduleUrl: "file:///$bunfs/root/index.ts", bakedVersion: "" })).toBe(true);
    expect(
      selfBinaryPath({
        env: {} as NodeJS.ProcessEnv,
        moduleUrl: "file:///$bunfs/root/index.ts",
        bakedVersion: "",
        execPath: "/usr/local/bin/polyptic-agent",
      }),
    ).toBe("/usr/local/bin/polyptic-agent");
  });

  test("a baked version is an independent second signal", () => {
    expect(isCompiledBinary({ moduleUrl: "file:///src/update.ts", bakedVersion: "0.3.6" })).toBe(true);
  });

  test("a dev/source run is NOT updatable", () => {
    expect(isCompiledBinary({ moduleUrl: "file:///src/update.ts", bakedVersion: "" })).toBe(false);
    expect(
      selfBinaryPath({ env: {} as NodeJS.ProcessEnv, moduleUrl: "file:///src/update.ts", bakedVersion: "" }),
    ).toBeNull();
  });

  test("an explicit override wins (used by the swap tests)", () => {
    expect(
      selfBinaryPath({ env: { POLYPTIC_AGENT_SELF_PATH: "/opt/agent" } as NodeJS.ProcessEnv }),
    ).toBe("/opt/agent");
  });
});

// ── chooseSwapMode: who is allowed to write the binary ──────────────────────────

describe("chooseSwapMode (POL-160 bug 2)", () => {
  const binaryPath = "/usr/local/bin/polyptic-agent";

  test("a box that can write its own binary's directory swaps directly (dev / root-run)", () => {
    expect(chooseSwapMode({ binaryDirWritable: true, helperInstalled: false, binaryPath }).kind).toBe("direct");
  });

  test("a kiosk box (root-owned /usr/local/bin) hands the write to the privileged helper", () => {
    expect(chooseSwapMode({ binaryDirWritable: false, helperInstalled: true, binaryPath }).kind).toBe("helper");
  });

  test("neither route: the skip names the directory AND the missing helper", () => {
    const mode = chooseSwapMode({ binaryDirWritable: false, helperInstalled: false, binaryPath });
    expect(mode.kind).toBe("none");
    if (mode.kind === "none") {
      expect(mode.reason).toContain("/usr/local/bin");
      expect(mode.reason).toContain(UPDATE_REQUEST_DIR);
      expect(mode.reason).toContain("polyptic-agent setup");
    }
  });
});

// ── planUpdate: the pre-flight decision ─────────────────────────────────────────

describe("planUpdate (POL-160)", () => {
  const base = {
    currentVersion: "0.2.40",
    binaryPath: "/opt/agent",
    swapMode: { kind: "direct" } as SwapMode,
    attemptedVersions: new Set<string>(),
  };

  test("applies when the offer is strictly newer and this box can install it", () => {
    expect(planUpdate({ ...base, offerVersion: "0.2.41" })).toEqual({
      action: "apply",
      binaryPath: "/opt/agent",
      swap: { kind: "direct" },
    });
  });
  test("a tagged offer against a bare running version still applies (v0.6.0 vs 0.3.6)", () => {
    expect(planUpdate({ ...base, currentVersion: "0.3.6", offerVersion: "v0.6.0" }).action).toBe("apply");
  });
  test("skips an equal or older offer (never downgrade), tag or no tag", () => {
    expect(planUpdate({ ...base, offerVersion: "0.2.40" }).action).toBe("skip");
    expect(planUpdate({ ...base, offerVersion: "0.2.39" }).action).toBe("skip");
    expect(planUpdate({ ...base, currentVersion: "0.6.0", offerVersion: "v0.6.0" }).action).toBe("skip");
  });
  test("skips when this process is not a compiled binary", () => {
    const plan = planUpdate({ ...base, binaryPath: null, offerVersion: "0.2.41" });
    expect(plan.action).toBe("skip");
    if (plan.action === "skip") expect(plan.reason).toContain("dev/source run");
  });
  test("skips a version already attempted this session (no re-download loop)", () => {
    expect(
      planUpdate({ ...base, offerVersion: "0.2.41", attemptedVersions: new Set(["0.2.41"]) }).action,
    ).toBe("skip");
  });
  test("skips with the REASON when nothing on this box can write the binary", () => {
    const plan = planUpdate({
      ...base,
      offerVersion: "0.2.41",
      swapMode: { kind: "none", reason: "cannot write /usr/local/bin and no helper" },
    });
    expect(plan.action).toBe("skip");
    if (plan.action === "skip") expect(plan.reason).toContain("cannot write /usr/local/bin");
  });
});

// ── applyUpdate: download → verify → swap, with fakes ────────────────────────────

/** A scriptable UpdateIO that records the call order, so a test can assert the swap only happens
 *  after every verification passed. */
function fakeIO(
  overrides: Partial<UpdateIO> & {
    downloadedBytes?: number;
    reportedVersion?: string;
    sha?: string;
    result?: string | null;
  } = {},
): { io: UpdateIO; calls: string[]; written: Map<string, string> } {
  const calls: string[] = [];
  const written = new Map<string, string>();
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
    async writeText(path, text) {
      calls.push(`write ${path}`);
      written.set(path, text);
    },
    async waitForText(path) {
      calls.push(`wait ${path}`);
      return overrides.result === undefined ? "ok\n" : overrides.result;
    },
    async exists() {
      return true;
    },
    async dirWritable() {
      return true;
    },
    ...overrides,
  };
  return { io, calls, written };
}

describe("applyUpdate — direct swap (a dev/root box writes its own binary)", () => {
  const opts = { url: "http://s/dist/agent/arm64", targetVersion: "0.2.41", sizeBytes: 100 };

  test("happy path: verifies size + sha + self-check, backs up, then atomically renames", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 100, reportedVersion: "0.2.41", sha: "deadbeef" });
    const res = await applyUpdate({ ...opts, sha256: "deadbeef" }, io, directSwapPlan("/opt/agent", io));
    expect(res.ok).toBe(true);
    // The rename (the actual swap) must come AFTER the self-check and the backup copy.
    const swapIdx = calls.findIndex((c) => c.startsWith("rename"));
    expect(calls.indexOf("selfCheck")).toBeLessThan(swapIdx);
    expect(calls.findIndex((c) => c.startsWith("copy→/opt/agent.bak"))).toBeLessThan(swapIdx);
    expect(calls).toContain("rename /opt/agent.new→/opt/agent");
  });

  test("the staging path is a SIBLING of the binary, so the install is a same-directory rename", () => {
    const { io } = fakeIO();
    expect(directSwapPlan("/opt/agent", io).stagePath).toBe("/opt/agent.new");
  });

  test("a size mismatch aborts BEFORE any swap and cleans up the staged file", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 50, reportedVersion: "0.2.41" });
    const res = await applyUpdate(opts, io, directSwapPlan("/opt/agent", io));
    expect(res.ok).toBe(false);
    expect(calls.some((c) => c.startsWith("rename"))).toBe(false);
    expect(calls).toContain("remove /opt/agent.new");
  });

  test("a sha256 mismatch aborts before any swap", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 100, reportedVersion: "0.2.41", sha: "wrong" });
    const res = await applyUpdate({ ...opts, sha256: "expected" }, io, directSwapPlan("/opt/agent", io));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("sha256 mismatch");
    expect(calls.some((c) => c.startsWith("rename"))).toBe(false);
  });

  test("the DECISIVE guard: a binary that runs but reports the WRONG version is never swapped in", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 100, reportedVersion: "0.2.40" }); // not the target
    const res = await applyUpdate(opts, io, directSwapPlan("/opt/agent", io));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("self-check version mismatch");
    expect(calls.some((c) => c.startsWith("rename"))).toBe(false);
    expect(calls).toContain("remove /opt/agent.new");
  });

  test("the self-check accepts the SAME version spelled with the release tag's v", async () => {
    // The server offers `v0.6.0`; the binary bakes `0.6.0`. Compared literally this failed EVERY
    // update — the trap waiting behind both field bugs.
    const { io } = fakeIO({ downloadedBytes: 100, reportedVersion: "0.6.0" });
    const res = await applyUpdate(
      { ...opts, targetVersion: "v0.6.0" },
      io,
      directSwapPlan("/opt/agent", io),
    );
    expect(res.ok).toBe(true);
  });

  test("a binary that cannot even run --version is never swapped in", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 100 }); // selfCheck throws (not scripted)
    const res = await applyUpdate(opts, io, directSwapPlan("/opt/agent", io));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("self-check failed to run");
    expect(calls.some((c) => c.startsWith("rename"))).toBe(false);
  });

  test("a zero-byte download aborts", async () => {
    const { io } = fakeIO({ downloadedBytes: 0, reportedVersion: "0.2.41" });
    const res = await applyUpdate({ ...opts, sizeBytes: undefined }, io, directSwapPlan("/opt/agent", io));
    expect(res.ok).toBe(false);
  });
});

describe("applyUpdate — helper swap (an unprivileged agent on a kiosk box)", () => {
  const opts = { url: "http://s/dist/agent/arm64", targetVersion: "0.6.0", sizeBytes: 100 };

  test("stages in the kiosk-writable directory and asks the privileged side to install it", async () => {
    const { io, calls, written } = fakeIO({ downloadedBytes: 100, reportedVersion: "0.6.0", sha: "beef" });
    const plan = helperSwapPlan({ targetVersion: "0.6.0", sha256: "beef" }, io);
    expect(plan.stagePath).toBe(UPDATE_STAGE_PATH);
    const res = await applyUpdate({ ...opts, sha256: "beef" }, io, plan);
    expect(res.ok).toBe(true);
    // The agent NEVER renames anything into the binary's directory on this route.
    expect(calls.some((c) => c.startsWith("rename"))).toBe(false);
    // The request is written only after the staged binary passed its self-check.
    expect(calls.indexOf("selfCheck")).toBeLessThan(calls.indexOf(`write ${UPDATE_REQUEST_PATH}`));
    expect(written.get(UPDATE_REQUEST_PATH)).toBe("action=swap\nversion=0.6.0\nsha256=beef\n");
    expect(calls).toContain(`wait ${UPDATE_RESULT_PATH}`);
  });

  test("a refusal from the privileged side is the failure reason the operator sees", async () => {
    const { io } = fakeIO({
      downloadedBytes: 100,
      reportedVersion: "0.6.0",
      result: "failed: no /usr/local/bin/polyptic-agent.bak to roll back to\n",
    });
    const res = await applyUpdate(opts, io, helperSwapPlan({ targetVersion: "0.6.0" }, io));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("no /usr/local/bin/polyptic-agent.bak");
  });

  test("a helper that never answers fails with a reason and leaves the box on its binary", async () => {
    const { io, calls } = fakeIO({ downloadedBytes: 100, reportedVersion: "0.6.0", result: null });
    const res = await applyUpdate(opts, io, helperSwapPlan({ targetVersion: "0.6.0", timeoutMs: 1_000 }, io));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain("did not answer");
    expect(calls).toContain(`remove ${UPDATE_REQUEST_PATH}`); // the unanswered request is withdrawn
    expect(calls).toContain(`remove ${UPDATE_STAGE_PATH}`); // and the staged binary cleaned up
  });

  test("rollback and commit are the same seam, one verb each and no paths", async () => {
    const { io, written } = fakeIO({});
    expect((await requestHelperAction("rollback", io)).ok).toBe(true);
    expect(written.get(UPDATE_REQUEST_PATH)).toBe("action=rollback\n");
    expect((await requestHelperAction("commit", io)).ok).toBe(true);
    expect(written.get(UPDATE_REQUEST_PATH)).toBe("action=commit\n");
  });
});

describe("the request/result wire between the agent and the privileged helper", () => {
  test("only `ok` is success — an unparseable answer is a failure, never a silent pass", () => {
    expect(parseUpdateResult("ok\n")).toEqual({ ok: true });
    expect(parseUpdateResult("failed: sha256 mismatch")).toEqual({ ok: false, reason: "sha256 mismatch" });
    expect(parseUpdateResult("").ok).toBe(false);
    expect(parseUpdateResult("half a wor").ok).toBe(false);
  });

  test("the request carries a verb and a version — never a path for the root side to follow", () => {
    const body = renderUpdateRequest({ action: "swap", version: "0.6.0", sha256: "abc" });
    expect(body).toBe("action=swap\nversion=0.6.0\nsha256=abc\n");
    expect(body).not.toContain("/");
  });

  test("the agent and setup agree on every path — drift here is an update that silently does nothing", () => {
    expect(AGENT_UPDATE_REQUEST_PATH).toBe(UPDATE_REQUEST_PATH);
    expect(AGENT_UPDATE_STAGE_PATH).toBe(UPDATE_STAGE_PATH);
    expect(AGENT_UPDATE_RESULT_PATH).toBe(UPDATE_RESULT_PATH);
    expect(UPDATE_REQUEST_DIR.startsWith("/run/")).toBe(true); // tmpfs: no request outlives a reboot
  });

  test("the .path unit watches the exact file the agent writes and starts the swap service", () => {
    expect(agentUpdatePathUnit()).toContain(`PathExists=${UPDATE_REQUEST_PATH}`);
    expect(agentUpdatePathUnit()).toContain("Unit=polyptic-agent-update.service");
    expect(agentUpdateServiceUnit()).toContain("ExecStart=/usr/local/lib/polyptic/agent-update.sh");
  });

  test("the swap script consumes the request first, re-verifies, and installs by rename", () => {
    const script = agentUpdateScript({ agentBin: "/usr/local/bin/polyptic-agent", user: "kiosk" });
    // Consumed before any work: a failure must not re-arm the .path unit into a loop.
    expect(script).toContain(`rm -f "$REQ"`);
    // It re-runs the self-check as the kiosk user — never as root, the content came from there.
    expect(script).toContain(`runuser -u "$RUN_AS" -- "$STAGE" --version`);
    // Backup, then same-directory rename: the live binary is never momentarily absent.
    expect(script).toContain(`cp -f "$BIN" "$BIN.bak"`);
    expect(script).toContain(`mv -f "$BIN.part" "$BIN"`);
    // Paths come from setup, never from the request.
    expect(script).toContain("BIN=/usr/local/bin/polyptic-agent");
    expect(script).toContain(`STAGE=${UPDATE_STAGE_PATH}`);
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

  test("the marker's target matches the running version tag-or-not", () => {
    expect(decideStartupAction(marker({ targetVersion: "v0.2.41" }), "0.2.41").kind).toBe("commit");
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
