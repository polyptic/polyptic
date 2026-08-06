/**
 * POL-192 — the agent's standing self-report: how it was launched, which binary it would replace,
 * and whether it considers itself updatable at all.
 *
 * POL-160 already computed this answer — once per offer, inside {@link planUpdate}, and then spent it
 * on a `skipped` frame that only ever reached a pod log. On the production wall that log line was the
 * ONLY evidence that every box would sit on agent 0.3.6 forever while the server offered v0.6.0. So
 * the same answer is now attached to every hello, where the console can show it.
 *
 * The point of care here: this module DERIVES its answer from the existing update path rather than
 * re-deciding it. It asks {@link planUpdate} about a sentinel offer so high that only the
 * "is this an updatable binary" guard can bite, and reports back whatever that guard said, verbatim.
 * There is one definition of "can this box update itself" and one wording for why not — fix the gate
 * and this report follows it, with no second copy of the rule to drift.
 */
import { planUpdate, selfBinaryPath } from "./update";

import type { AgentRuntime } from "@polyptic/protocol";

/**
 * A version no release will ever reach, used ONLY as a probe: against it the version guard is always
 * satisfied, so whatever {@link planUpdate} still refuses is a property of this PROCESS (no binary to
 * replace), which is exactly the question being asked.
 */
const PROBE_VERSION = "999999.0.0";

/** Nothing has been attempted — the probe asks about capability, not about this session's history. */
const NO_ATTEMPTS: ReadonlySet<string> = new Set<string>();

/**
 * What this agent is, for the hello. `launch` is read straight off whether we hold a binary path, so
 * it stays honest even if the plan refuses for some other reason; `reason` is {@link planUpdate}'s own
 * sentence, so the console and the `agent/update-status` skip line say the same thing.
 */
export function describeAgentRuntime(
  currentVersion: string,
  env: NodeJS.ProcessEnv = process.env,
): AgentRuntime {
  const binaryPath = selfBinaryPath(env);
  const plan = planUpdate({
    currentVersion,
    offerVersion: PROBE_VERSION,
    binaryPath,
    attemptedVersions: NO_ATTEMPTS,
  });
  const launch = binaryPath ? "binary" : "source";
  if (plan.action === "apply") {
    return { launch, binaryPath: plan.binaryPath, updatable: true };
  }
  return {
    launch,
    ...(binaryPath ? { binaryPath } : {}),
    updatable: false,
    reason: plan.reason,
  };
}
