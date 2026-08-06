/**
 * POL-160 — the test with teeth: compile a REAL agent binary through the real build script and ask
 * it about itself.
 *
 * The bug this exists to catch shipped with a green suite. update.test.ts passed `binaryPath: null`
 * as a fake and asserted the skip, so it tested the branch and never whether a genuinely compiled
 * binary reaches it. It did not: `selfBinaryPath` read `POLYPTIC_BUILD_VERSION` off a PARAMETER,
 * which `bun build --define` (a textual substitution of one literal expression) never rewrites, so
 * every box in the field reported its baked version AND declared itself "not running as an updatable
 * binary (dev/source run)" — 176 offers, 176 declines, over 48h.
 *
 * Nothing short of compiling can tell those apart, so this test compiles. It is gated behind
 * POLYPTIC_COMPILE_TEST=1 (a compile is ~10-30s, too slow for every `bun test`) and CI sets it.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const enabled = (process.env.POLYPTIC_COMPILE_TEST ?? "").trim() === "1";
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BAKED_VERSION = "9.9.9-compiletest";

let workDir: string | null = null;

afterAll(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

/** Compile the agent through deploy/build-agent.sh — the same script and the same `--define` that
 *  produce every binary the depot serves. Returns the binary's path. */
function compileAgent(): string {
  workDir = mkdtempSync(join(tmpdir(), "polyptic-agent-compile-"));
  const built = spawnSync("bash", [join(repoRoot, "deploy", "build-agent.sh"), "host"], {
    cwd: repoRoot,
    env: { ...process.env, VERSION: BAKED_VERSION, SKIP_INSTALL: "1", OUT_DIR: workDir },
    encoding: "utf8",
    timeout: 300_000,
  });
  if (built.status !== 0) {
    throw new Error(`build-agent.sh host failed (${built.status}):\n${built.stderr}\n${built.stdout}`);
  }
  return join(workDir, "polyptic-agent-host");
}

function run(binary: string, arg: string): string {
  const res = spawnSync(binary, [arg], { encoding: "utf8", timeout: 60_000 });
  if (res.status !== 0) throw new Error(`${binary} ${arg} exited ${res.status}: ${res.stderr}`);
  return res.stdout.trim();
}

describe.skipIf(!enabled)("a REAL compiled agent binary (POLYPTIC_COMPILE_TEST=1)", () => {
  const binary = enabled ? compileAgent() : "";

  test("`--version` prints exactly the version the build baked in", () => {
    expect(run(binary, "--version")).toBe(BAKED_VERSION);
  });

  test("it knows it is a compiled binary and can be updated — the whole POL-160 field bug", () => {
    const report = JSON.parse(run(binary, "--updatable")) as {
      version: string;
      compiled: boolean;
      updatable: boolean;
      binaryPath: string | null;
      swap: string;
      reason?: string;
    };
    expect(report.version).toBe(BAKED_VERSION);
    expect(report.compiled).toBe(true);
    // The binary sits in a writable temp dir here, so it swaps directly. On a wall box the same
    // probe finds root-owned /usr/local/bin and picks the privileged helper instead.
    expect(report.updatable).toBe(true);
    // endsWith, not toBe: macOS resolves /var to /private/var under the binary's own execPath.
    expect(report.binaryPath).toEndWith("/polyptic-agent-host");
    expect(report.swap).toBe("direct");
    expect(report.reason).toBeUndefined();
  });

  test("knowing its version and being updatable are ONE answer, never a contradiction", () => {
    // The field report was a process that could print `0.3.6` and simultaneously claim to be a
    // dev/source run. Assert both answers off the same binary, together, because separately they
    // both looked fine.
    const version = run(binary, "--version");
    const report = JSON.parse(run(binary, "--updatable")) as { version: string; compiled: boolean };
    expect(report.version).toBe(version);
    expect(report.compiled).toBe(true);
  });
});
