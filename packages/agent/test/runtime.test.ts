/**
 * POL-192 — the agent's standing self-report on every hello: how it was launched, the binary it would
 * replace, and whether it can update itself at all.
 *
 * The property that matters most here is that the report is DERIVED from the update path rather than
 * re-deciding it: the reason a box gives the console must be the same sentence it puts on
 * `agent/update-status`, and a fix to the updatability gate must move both at once.
 */
import { describe, expect, test } from "bun:test";

import { describeAgentRuntime } from "../src/runtime";
import { planUpdate, selfBinaryPath } from "../src/update";

const SOURCE_ENV: NodeJS.ProcessEnv = {}; // no baked build version, no override — a dev/source run

describe("describeAgentRuntime (POL-192)", () => {
  test("a compiled binary reports the path it would replace and calls itself updatable", () => {
    const env = { POLYPTIC_AGENT_SELF_PATH: "/usr/local/bin/polyptic-agent" };
    const runtime = describeAgentRuntime("0.3.6", env);
    expect(runtime.launch).toBe("binary");
    expect(runtime.binaryPath).toBe("/usr/local/bin/polyptic-agent");
    expect(runtime.updatable).toBe(true);
    expect(runtime.reason).toBeUndefined();
  });

  test("a source run says so, names no binary, and carries the reason it cannot update", () => {
    const runtime = describeAgentRuntime("0.3.6", SOURCE_ENV);
    expect(runtime.launch).toBe("source");
    expect(runtime.binaryPath).toBeUndefined();
    expect(runtime.updatable).toBe(false);
    expect(runtime.reason).toBeTruthy();
  });

  test("the reason is VERBATIM planUpdate's — one sentence for the console and the log line", () => {
    const runtime = describeAgentRuntime("0.3.6", SOURCE_ENV);
    // What an actual offer would have produced, which is what `agent/update-status` reports.
    const plan = planUpdate({
      currentVersion: "0.3.6",
      offerVersion: "0.6.0",
      binaryPath: selfBinaryPath(SOURCE_ENV),
      attemptedVersions: new Set<string>(),
    });
    expect(plan.action).toBe("skip");
    expect(runtime.reason).toBe(plan.action === "skip" ? plan.reason : "");
  });

  test("the probe never mistakes a CURRENT box for an unupdatable one — updatability is about the launch, not the version", () => {
    // A box already on the newest release is still perfectly able to take the next one.
    const env = { POLYPTIC_AGENT_SELF_PATH: "/opt/polyptic/agent", POLYPTIC_BUILD_VERSION: "9.9.9" };
    expect(describeAgentRuntime("9.9.9", env).updatable).toBe(true);
  });

  test("a baked build version alone (no path override) reports the binary launch", () => {
    const runtime = describeAgentRuntime("0.6.0", { POLYPTIC_BUILD_VERSION: "0.6.0" });
    expect(runtime.launch).toBe("binary");
    expect(runtime.binaryPath).toBe(process.execPath);
    expect(runtime.updatable).toBe(true);
  });
});
