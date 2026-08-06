/**
 * POL-192 — the agent's standing self-report on every hello: how it was launched, the binary it would
 * replace, and whether it can update itself at all.
 *
 * The property that matters most here is that the report is DERIVED from the update path rather than
 * re-deciding it: the reason a box gives the console must be the same sentence it puts on
 * `agent/update-status`, and a fix to the updatability gate must move both at once.
 *
 * POL-160 landed the second half of that question after this file was first written: being a compiled
 * binary is not enough, the box must also have a ROUTE to write it. Both halves are asserted here,
 * because a fleet that reports "updatable" while its binary sits in a directory it cannot write is the
 * exact false green this report exists to prevent.
 */
import { describe, expect, test } from "bun:test";

import { describeAgentRuntime } from "../src/runtime";
import { planUpdate, selfBinaryPath } from "../src/update";
import type { SelfBinaryProbe, UpdateIO } from "../src/update";

/** No baked version, no override, not an embedded module URL — a dev/source run. */
const SOURCE: SelfBinaryProbe = { moduleUrl: "file:///repo/packages/agent/src/runtime.ts" };

/** Only the two probes `detectSwapMode` uses; everything else would throw if it were reached. */
function io(opts: { binaryDirWritable: boolean; helperInstalled: boolean }): UpdateIO {
  return {
    dirWritable: async () => opts.binaryDirWritable,
    exists: async () => opts.helperInstalled,
  } as unknown as UpdateIO;
}

/** A box that writes its own binary directory (a dev host, a root-run agent). */
const CAN_WRITE = io({ binaryDirWritable: true, helperInstalled: false });
/** A kiosk box: unprivileged agent, root-owned binary directory, helper installed. */
const VIA_HELPER = io({ binaryDirWritable: false, helperInstalled: true });
/** The field fleet before POL-160: a real binary with no way on earth to replace itself. */
const NO_ROUTE = io({ binaryDirWritable: false, helperInstalled: false });

describe("describeAgentRuntime (POL-192)", () => {
  test("a compiled binary reports the path it would replace and calls itself updatable", async () => {
    const probe = { env: { POLYPTIC_AGENT_SELF_PATH: "/usr/local/bin/polyptic-agent" } };
    const runtime = await describeAgentRuntime("0.3.6", CAN_WRITE, probe);
    expect(runtime.launch).toBe("binary");
    expect(runtime.binaryPath).toBe("/usr/local/bin/polyptic-agent");
    expect(runtime.updatable).toBe(true);
    expect(runtime.reason).toBeUndefined();
  });

  test("a source run says so, names no binary, and carries the reason it cannot update", async () => {
    const runtime = await describeAgentRuntime("0.3.6", CAN_WRITE, SOURCE);
    expect(runtime.launch).toBe("source");
    expect(runtime.binaryPath).toBeUndefined();
    expect(runtime.updatable).toBe(false);
    expect(runtime.reason).toBeTruthy();
  });

  test("the reason is VERBATIM planUpdate's — one sentence for the console and the log line", async () => {
    const runtime = await describeAgentRuntime("0.3.6", CAN_WRITE, SOURCE);
    // What an actual offer would have produced, which is what `agent/update-status` reports.
    const plan = planUpdate({
      currentVersion: "0.3.6",
      offerVersion: "0.6.0",
      binaryPath: selfBinaryPath(SOURCE),
      swapMode: { kind: "none", reason: "" },
      attemptedVersions: new Set<string>(),
    });
    expect(plan.action).toBe("skip");
    expect(runtime.reason).toBe(plan.action === "skip" ? plan.reason : "");
  });

  test("the probe never mistakes a CURRENT box for an unupdatable one — updatability is about the launch, not the version", async () => {
    // A box already on the newest release is still perfectly able to take the next one.
    const probe = { env: { POLYPTIC_AGENT_SELF_PATH: "/opt/polyptic/agent" }, bakedVersion: "9.9.9" };
    const runtime = await describeAgentRuntime("9.9.9", CAN_WRITE, probe);
    expect(runtime.updatable).toBe(true);
  });

  test("a baked build version alone (no path override) reports the binary launch", async () => {
    const runtime = await describeAgentRuntime("0.6.0", CAN_WRITE, { bakedVersion: "0.6.0" });
    expect(runtime.launch).toBe("binary");
    expect(runtime.binaryPath).toBe(process.execPath);
    expect(runtime.updatable).toBe(true);
  });

  test("a kiosk box updates through the helper — unprivileged, root-owned binary dir, still updatable", async () => {
    const runtime = await describeAgentRuntime("0.6.0", VIA_HELPER, { bakedVersion: "0.6.0" });
    expect(runtime.launch).toBe("binary");
    expect(runtime.updatable).toBe(true);
    expect(runtime.reason).toBeUndefined();
  });

  test("a REAL binary with no route to write itself is NOT updatable, and says which piece is missing", async () => {
    // The field fleet: a compiled binary that knows its own version, in a directory it cannot write,
    // on a box with no helper installed. Reporting this as updatable is the false green that let a
    // fleet sit five releases behind.
    const runtime = await describeAgentRuntime("0.3.6", NO_ROUTE, { bakedVersion: "0.3.6" });
    expect(runtime.launch).toBe("binary");
    expect(runtime.updatable).toBe(false);
    expect(runtime.reason).toBeTruthy();
  });
});
