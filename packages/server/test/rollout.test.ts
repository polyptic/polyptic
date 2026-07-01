/**
 * OTA (POL-28) rollout-controller decision + gating tests.
 *
 * Exercises the "brain" directly against a MemoryStore-backed ControlPlane with a fake AgentHub (to
 * capture offers) and an injected clock (for soak timing). Covers: who gets offered an update, the
 * provisioning-epoch gate, canary waves + manual/auto promotion, halt-on-failure, completion, and
 * rollback.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentManifest, ServerToAgentMessage } from "@polyptic/protocol";

import { ActivityLog } from "../src/activity";
import { Presence } from "../src/admin";
import type { AgentHub } from "../src/hub";
import { RolloutController } from "../src/rollout";
import { ControlPlane } from "../src/state";
import { MemoryStore } from "../src/store/memory";

const SHA = "a".repeat(64);
const MANIFEST: AgentManifest = {
  version: "0.2.0",
  provisionEpoch: 1,
  artifacts: { amd64: { sha256: SHA }, arm64: { sha256: SHA } },
};

let store: MemoryStore;
let control: ControlPlane;
let presence: Presence;
let activity: ActivityLog;
let sent: Array<{ machineId: string; msg: ServerToAgentMessage }>;
let agentHub: AgentHub;
let clock: number;

function makeController(manifest: AgentManifest | null = MANIFEST, soakMs = 1000): RolloutController {
  return new RolloutController({
    store,
    control,
    presence,
    agentHub,
    activity,
    manifest,
    soakMs,
    now: () => clock,
  });
}

/** Register an approved machine (open mode), online, reporting `version` at `epoch` (null = pre-OTA). */
async function addMachine(id: string, version = "0.1.0", epoch: number | null = 1): Promise<void> {
  await control.registerMachine({
    machineId: id,
    agentVersion: version,
    provisionEpoch: epoch ?? undefined,
    backend: "dev-open",
    outputs: [{ connector: "HDMI-1", width: 1920, height: 1080 }],
  });
  presence.agentConnected(id);
}

/** The offers sent to a machine so far. */
function offersTo(id: string): ServerToAgentMessage[] {
  return sent.filter((s) => s.machineId === id).map((s) => s.msg);
}

beforeEach(async () => {
  store = new MemoryStore();
  await store.migrate();
  control = new ControlPlane(store, undefined);
  await control.init();
  presence = new Presence();
  activity = new ActivityLog();
  sent = [];
  clock = 1_000_000;
  agentHub = {
    send: (machineId: string, msg: ServerToAgentMessage) => {
      sent.push({ machineId, msg });
      return 1;
    },
  } as unknown as AgentHub;
});

describe("decideForMachine", () => {
  test("no rollout → no offer", async () => {
    await addMachine("m1");
    const rollout = makeController();
    expect(rollout.decideForMachine("m1").action).toBe("none");
  });

  test("all-at-once rollout → offers the target (with checksummed artifacts) to a behind box", async () => {
    await addMachine("m1", "0.1.0", 1);
    const rollout = makeController();
    await rollout.start({ version: "0.2.0", strategy: "all", canaryMachineIds: [], promotion: "manual" });

    const decision = rollout.decideForMachine("m1");
    expect(decision.action).toBe("offer");
    if (decision.action === "offer") {
      expect(decision.update.t).toBe("server/update");
      expect(decision.update.targetVersion).toBe("0.2.0");
      expect(decision.update.artifacts.amd64?.sha256).toBe(SHA);
    }
    // The REST layer calls evaluate() right after start(), which pushes the offer to the in-wave box.
    await rollout.evaluate();
    expect(offersTo("m1").length).toBeGreaterThan(0);
  });

  test("a box already on the target is not offered", async () => {
    await addMachine("m1", "0.2.0", 1);
    const rollout = makeController();
    await rollout.start({ version: "0.2.0", strategy: "all", canaryMachineIds: [], promotion: "manual" });
    expect(rollout.decideForMachine("m1").action).toBe("none");
  });

  test("provisioning-epoch gate: a pre-OTA / lower-epoch box is flagged needs-installer, not OTA'd", async () => {
    await addMachine("m1", "0.1.0", null); // pre-OTA agent — no epoch (treated as 0)
    const rollout = makeController(); // manifest epoch = 1
    await rollout.start({ version: "0.2.0", strategy: "all", canaryMachineIds: [], promotion: "manual" });
    expect(rollout.decideForMachine("m1").action).toBe("needs-installer");
    expect(rollout.needsInstaller(control.getMachine("m1")!)).toBe(true);
  });

  test("a paused rollout offers nothing", async () => {
    await addMachine("m1", "0.1.0", 1);
    const rollout = makeController();
    await rollout.start({ version: "0.2.0", strategy: "all", canaryMachineIds: [], promotion: "manual" });
    await rollout.pause();
    expect(rollout.decideForMachine("m1").action).toBe("none");
  });

  test("an in-flight box (downloading) is not re-offered", async () => {
    await addMachine("m1", "0.1.0", 1);
    const rollout = makeController();
    await rollout.start({ version: "0.2.0", strategy: "all", canaryMachineIds: [], promotion: "manual" });
    await control.recordAgentReport("m1", { updateState: "downloading" });
    expect(rollout.decideForMachine("m1").action).toBe("none");
  });
});

describe("canary waves", () => {
  test("canary offers only the canary box; the rest wait until promotion", async () => {
    await addMachine("canary", "0.1.0", 1);
    await addMachine("rest", "0.1.0", 1);
    const rollout = makeController();
    await rollout.start({ version: "0.2.0", strategy: "canary", canaryMachineIds: ["canary"], promotion: "manual" });

    expect(rollout.decideForMachine("canary").action).toBe("offer");
    expect(rollout.decideForMachine("rest").action).toBe("none");

    // Manual promote → the rest are now offered too.
    await rollout.promote();
    expect(rollout.decideForMachine("rest").action).toBe("offer");
  });

  test("auto-after-soak promotes once the canary is healthy on the target for the soak window", async () => {
    await addMachine("canary", "0.1.0", 1);
    await addMachine("rest", "0.1.0", 1);
    const rollout = makeController(MANIFEST, 1000);
    await rollout.start({ version: "0.2.0", strategy: "canary", canaryMachineIds: ["canary"], promotion: "auto" });

    // Canary lands on the target, healthy.
    await control.recordAgentReport("canary", { agentVersion: "0.2.0", updateState: "healthy" });
    await rollout.evaluate();
    expect(rollout.current()?.promoted).toBe(false); // soak just started

    clock += 1500; // past the 1000ms soak window
    await rollout.evaluate();
    expect(rollout.current()?.promoted).toBe(true); // auto-promoted
    expect(rollout.decideForMachine("rest").action).toBe("offer");
  });

  test("a canary that reports 'failed' halts the rollout (kill-switch flips on)", async () => {
    await addMachine("canary", "0.1.0", 1);
    await addMachine("rest", "0.1.0", 1);
    const rollout = makeController();
    await rollout.start({ version: "0.2.0", strategy: "canary", canaryMachineIds: ["canary"], promotion: "auto" });

    await control.recordAgentReport("canary", { agentVersion: "0.1.0", updateState: "failed" });
    await rollout.evaluate();
    expect(rollout.current()?.paused).toBe(true);
    expect(activity.recent().some((e) => e.severity === "bad" && /canary failed/i.test(e.text))).toBe(true);
  });
});

describe("completion + rollback", () => {
  test("completes when every approved box is on the target", async () => {
    await addMachine("m1", "0.1.0", 1);
    await addMachine("m2", "0.1.0", 1);
    const rollout = makeController();
    await rollout.start({ version: "0.2.0", strategy: "all", canaryMachineIds: [], promotion: "manual" });

    await control.recordAgentReport("m1", { agentVersion: "0.2.0", updateState: "healthy" });
    await control.recordAgentReport("m2", { agentVersion: "0.2.0", updateState: "healthy" });
    await rollout.evaluate();

    expect(rollout.view()?.stage).toBe("complete");
    expect(activity.recent().some((e) => /fleet updated to agent 0\.2\.0/i.test(e.text))).toBe(true);
  });

  test("rollback targets the previous majority version and offers it without an artifact", async () => {
    await addMachine("m1", "0.1.0", 1);
    const rollout = makeController();
    await rollout.start({ version: "0.2.0", strategy: "all", canaryMachineIds: [], promotion: "manual" });
    // The box moved to 0.2.0.
    await control.recordAgentReport("m1", { agentVersion: "0.2.0", updateState: "healthy" });

    const result = await rollout.rollback();
    expect(result.ok).toBe(true);
    expect(rollout.current()?.targetVersion).toBe("0.1.0"); // back to the pre-rollout version

    const decision = rollout.decideForMachine("m1");
    expect(decision.action).toBe("offer");
    if (decision.action === "offer") {
      // A rollback target isn't the manifest version → no download artifact (box uses its retained slot).
      expect(decision.update.artifacts.amd64).toBeUndefined();
      expect(decision.update.targetVersion).toBe("0.1.0");
    }
  });

  test("start fails when the requested version isn't the depot's release", async () => {
    await addMachine("m1", "0.1.0", 1);
    const rollout = makeController();
    const res = await rollout.start({ version: "9.9.9", strategy: "all", canaryMachineIds: [], promotion: "manual" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("unknown-version");
  });

  test("no manifest → start reports no-release", async () => {
    await addMachine("m1", "0.1.0", 1);
    const rollout = makeController(null);
    const res = await rollout.start({ version: "0.2.0", strategy: "all", canaryMachineIds: [], promotion: "manual" });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toBe("no-release");
  });
});

describe("persistence", () => {
  test("a rollout survives a controller restart (intent re-loaded from the store)", async () => {
    await addMachine("m1", "0.1.0", 1);
    const rollout = makeController();
    await rollout.start({ version: "0.2.0", strategy: "canary", canaryMachineIds: ["m1"], promotion: "auto" });

    // A fresh controller (as after a server restart) loads the persisted intent.
    const revived = makeController();
    await revived.init();
    expect(revived.current()?.targetVersion).toBe("0.2.0");
    expect(revived.current()?.strategy).toBe("canary");
    expect(revived.current()?.canaryMachineIds).toEqual(["m1"]);
  });
});
