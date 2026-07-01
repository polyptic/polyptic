/**
 * OTA (POL-28) — the fleet ROLLOUT CONTROLLER: the brain that decides which boxes are offered a new
 * agent version, and when a canary promotes to the rest of the fleet.
 *
 * It holds the rollout INTENT (target version, strategy, canary set, promotion mode, paused, promoted)
 * and persists ONLY that intent (single row) so a server restart resumes the rollout. All live progress
 * — who is on the target, whether the canary is healthy, the soak clock — is DERIVED from the versions +
 * update states agents report on `agent/hello`/`agent/status`, never invented. That keeps the rollout
 * honest across restarts and makes the whole thing testable with a fake clock.
 *
 * Two safety layers (the pitch):
 *   - box-level: every box keeps its previous binary and auto-reverts if the new one fails to come back
 *     healthy (that lives in the AGENT; here we just observe the `rolled-back`/`failed` it reports).
 *   - fleet-level: with a canary, one wave goes first; the rest wait until it is healthy on the target
 *     (operator Promote, or auto after a soak window). A canary that reports `failed`/`rolled-back`
 *     halts the rollout (kill-switch flips on) so a bad build can't march across the wall.
 */
import {
  RolloutView,
  ServerToAgentUpdate,
} from "@polyptic/protocol";
import type { AgentManifest, AgentRelease, Machine, StartRolloutBody } from "@polyptic/protocol";

import type { ActivityLog } from "./activity";
import type { Presence } from "./admin";
import type { AgentHub } from "./hub";
import type { ControlPlane } from "./state";
import type { PersistedRollout, Store } from "./store/types";

/** Default canary soak window before auto-promotion (~20 min; the pitch's default). */
const DEFAULT_SOAK_MS = 20 * 60 * 1000;
/** Don't re-offer the same target to a machine more often than this (heartbeats are frequent). */
const OFFER_COOLDOWN_MS = 20 * 1000;
/** A canary offline this long after being offered — without ever landing on the target — is a failure. */
const DEFAULT_OFFLINE_FAIL_MS = 5 * 60 * 1000;

/** What to do with one machine on this heartbeat/tick. */
export type RolloutDecision =
  | { action: "none" }
  | { action: "needs-installer" }
  | { action: "offer"; update: ReturnType<typeof ServerToAgentUpdate.parse> };

export interface RolloutDeps {
  store: Store;
  control: ControlPlane;
  presence: Presence;
  agentHub: AgentHub;
  activity: ActivityLog;
  /** The depot's advertised release (latest servable version + checksums), or null when none. */
  manifest: AgentManifest | null;
  /** Invoked whenever the controller changes intent or pushes activity, so the caller can broadcast. */
  broadcast?: () => void;
  /** Canary soak window before auto-promotion (ms). */
  soakMs?: number;
  /** Canary offline-failure timeout (ms). */
  offlineFailMs?: number;
  /** Injectable clock (ms) — defaults to Date.now; overridden in tests. */
  now?: () => number;
}

export type StartResult =
  | { ok: true; view: RolloutView }
  | { ok: false; error: "no-release" | "unknown-version" | "already-on-version" };

export class RolloutController {
  private rollout: PersistedRollout | null = null;
  private manifest: AgentManifest | null;
  private readonly soakMs: number;
  private readonly offlineFailMs: number;
  private readonly now: () => number;

  /** In-memory (reset on restart): when the whole canary first became healthy on the target. */
  private canaryHealthySince: number | null = null;
  /** In-memory: last time we offered a (machineId → {version, at}) so we don't spam server/update. */
  private readonly lastOffer = new Map<string, { version: string; at: number }>();
  /** In-memory: machineId → when we first offered the current target (for the offline-failure check). */
  private readonly offeredAt = new Map<string, number>();
  private completeEmitted = false;
  private haltEmitted = false;

  constructor(private readonly deps: RolloutDeps) {
    this.manifest = deps.manifest;
    this.soakMs = deps.soakMs ?? DEFAULT_SOAK_MS;
    this.offlineFailMs = deps.offlineFailMs ?? DEFAULT_OFFLINE_FAIL_MS;
    this.now = deps.now ?? (() => Date.now());
  }

  /** Load any persisted rollout intent on boot. */
  async init(): Promise<void> {
    this.rollout = (await this.deps.store.getRollout()) ?? null;
  }

  /** The depot's advertised release, for the console. */
  release(): AgentRelease | null {
    if (!this.manifest) return null;
    return { version: this.manifest.version, provisionEpoch: this.manifest.provisionEpoch };
  }

  /** Replace the advertised release (if the manifest is (re)loaded). */
  setManifest(manifest: AgentManifest | null): void {
    this.manifest = manifest;
  }

  current(): PersistedRollout | null {
    return this.rollout;
  }

  // ── operator actions ──────────────────────────────────────────────────────────

  /**
   * Start (or replace) a rollout to `body.version`. Only the depot's current release is servable
   * (its checksums are what we hand out), so the version must match the manifest. Captures the fleet's
   * current majority version as the rollback target.
   */
  async start(body: StartRolloutBody): Promise<StartResult> {
    if (!this.manifest) return { ok: false, error: "no-release" };
    if (body.version !== this.manifest.version) return { ok: false, error: "unknown-version" };

    const previousVersion = this.majorityVersion(body.version);
    const rollout: PersistedRollout = {
      targetVersion: body.version,
      strategy: body.strategy,
      promotion: body.promotion,
      canaryMachineIds: body.strategy === "canary" ? body.canaryMachineIds : [],
      promoted: body.strategy === "all",
      paused: false,
      previousVersion,
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.persist(rollout);
    this.resetProgress();
    this.emit("info", `Rollout started → agent ${body.version} (${body.strategy})`);
    this.deps.broadcast?.();
    return { ok: true, view: this.view()! };
  }

  /** Promote the canary wave to the rest of the fleet (operator click). */
  async promote(): Promise<boolean> {
    if (!this.rollout || this.rollout.promoted) return false;
    this.rollout.promoted = true;
    await this.persist(this.rollout);
    this.emit("good", `Rollout promoted to the rest of the fleet → agent ${this.rollout.targetVersion}`);
    this.deps.broadcast?.();
    return true;
  }

  /** Kill-switch: stop offering updates. Boxes already updating are unaffected. */
  async pause(): Promise<boolean> {
    if (!this.rollout || this.rollout.paused) return false;
    this.rollout.paused = true;
    await this.persist(this.rollout);
    this.emit("warn", `Rollout paused → agent ${this.rollout.targetVersion}`);
    this.deps.broadcast?.();
    return true;
  }

  /** Resume a paused rollout. */
  async resume(): Promise<boolean> {
    if (!this.rollout || !this.rollout.paused) return false;
    this.rollout.paused = false;
    await this.persist(this.rollout);
    this.canaryHealthySince = null; // re-soak from now
    this.haltEmitted = false;
    this.emit("info", `Rollout resumed → agent ${this.rollout.targetVersion}`);
    this.deps.broadcast?.();
    return true;
  }

  /**
   * Roll back the fleet to the version it was on before this rollout. Boxes reactivate their retained
   * `previous` slot (no re-download). Fails if there is no known previous version.
   */
  async rollback(): Promise<{ ok: true; view: RolloutView } | { ok: false; error: "no-rollout" | "no-previous" }> {
    if (!this.rollout) return { ok: false, error: "no-rollout" };
    const previous = this.rollout.previousVersion;
    if (!previous) return { ok: false, error: "no-previous" };

    const from = this.rollout.targetVersion;
    const rollback: PersistedRollout = {
      targetVersion: previous,
      strategy: "all",
      promotion: "manual",
      canaryMachineIds: [],
      promoted: true,
      paused: false,
      // A rollback's "previous" is the version we're reverting FROM, so it can be rolled forward again.
      previousVersion: from,
      createdAt: new Date(this.now()).toISOString(),
    };
    await this.persist(rollback);
    this.resetProgress();
    this.emit("warn", `Rolling back the fleet → agent ${previous} (from ${from})`);
    this.deps.broadcast?.();
    return { ok: true, view: this.view()! };
  }

  /** Clear the rollout entirely (dismiss a completed one, or abandon it — boxes stay where they are). */
  async cancel(): Promise<boolean> {
    if (!this.rollout) return false;
    await this.deps.store.clearRollout();
    this.rollout = null;
    this.resetProgress();
    this.emit("info", "Rollout cleared");
    this.deps.broadcast?.();
    return true;
  }

  // ── decisions ───────────────────────────────────────────────────────────────

  /** Pure decision for one machine: offer an update, flag needs-installer, or do nothing. */
  decideForMachine(machineId: string): RolloutDecision {
    const rollout = this.rollout;
    if (!rollout || rollout.paused) return { action: "none" };

    const machine = this.deps.control.getMachine(machineId);
    if (!machine || machine.status !== "approved") return { action: "none" };

    const target = rollout.targetVersion;
    if (machine.agentVersion === target) return { action: "none" }; // already there

    const inWave =
      rollout.strategy === "all" ||
      rollout.promoted ||
      rollout.canaryMachineIds.includes(machineId);
    if (!inWave) return { action: "none" }; // waiting for the canary to promote

    // A FORWARD update targets the depot's current release; a rollback targets a retained local slot.
    const forward = this.manifest !== null && this.manifest.version === target;

    // Provisioning-epoch gate: a release that changes provisioning beyond this box's epoch cannot be
    // applied by the unprivileged agent — flag it for an installer re-run instead of OTA'ing it.
    if (forward && this.manifest!.provisionEpoch > (machine.provisionEpoch ?? 0)) {
      return { action: "needs-installer" };
    }

    // A forward update needs a servable artifact; without one we cannot offer (a rollback has none —
    // the box uses its retained slot).
    const artifacts = forward ? this.manifest!.artifacts : {};
    if (forward && !artifacts.amd64 && !artifacts.arm64) return { action: "none" };

    // Don't re-offer while an update is already in flight on the box.
    const st = this.deps.control.agentReport(machineId)?.updateState;
    if (st === "downloading" || st === "staged" || st === "updating") return { action: "none" };

    const update = ServerToAgentUpdate.parse({ t: "server/update", targetVersion: target, artifacts });
    return { action: "offer", update };
  }

  /**
   * Offer an update to a machine if the decision says so (rate-limited). Called after each hello-admit
   * and each heartbeat. Returns the decision taken.
   */
  maybeOffer(machineId: string): RolloutDecision {
    const decision = this.decideForMachine(machineId);
    if (decision.action !== "offer") return decision;

    const target = decision.update.targetVersion;
    const last = this.lastOffer.get(machineId);
    const now = this.now();
    if (last && last.version === target && now - last.at < OFFER_COOLDOWN_MS) return decision; // cooling

    const delivered = this.deps.agentHub.send(machineId, decision.update);
    if (delivered > 0) {
      this.lastOffer.set(machineId, { version: target, at: now });
      if (!this.offeredAt.has(machineId)) this.offeredAt.set(machineId, now);
    }
    return decision;
  }

  /**
   * Recompute derived progress across the fleet: auto-promotion after soak, halt on a canary failure,
   * completion, and re-offering to in-wave machines. Called on a periodic tick AND after each heartbeat.
   */
  async evaluate(): Promise<void> {
    const rollout = this.rollout;
    if (!rollout) return;

    const approved = this.deps.control.getMachines().filter((m) => m.status === "approved");

    // Halt on a canary failure (reported failed/rolled-back, or offline-past-timeout without landing).
    if (rollout.strategy === "canary" && !rollout.promoted && !rollout.paused) {
      const failed = rollout.canaryMachineIds.filter((id) => this.isFailure(id, rollout));
      if (failed.length > 0) {
        rollout.paused = true;
        await this.persist(rollout);
        if (!this.haltEmitted) {
          this.haltEmitted = true;
          this.emit("bad", `Canary failed on agent ${rollout.targetVersion} — rollout halted`);
        }
        this.deps.broadcast?.();
        return;
      }
    }

    // Canary soak → auto-promotion.
    if (rollout.strategy === "canary" && !rollout.promoted && !rollout.paused) {
      const allHealthy =
        rollout.canaryMachineIds.length > 0 &&
        rollout.canaryMachineIds.every((id) => this.isHealthyOnTarget(id, rollout.targetVersion));
      if (allHealthy) {
        if (this.canaryHealthySince === null) {
          this.canaryHealthySince = this.now();
          this.emit(
            "good",
            `Canary healthy on agent ${rollout.targetVersion}` +
              (rollout.promotion === "auto" ? ` — soaking ${Math.round(this.soakMs / 60000)}m` : ""),
          );
          this.deps.broadcast?.();
        } else if (rollout.promotion === "auto" && this.now() - this.canaryHealthySince >= this.soakMs) {
          await this.promote();
        }
      } else if (this.canaryHealthySince !== null) {
        this.canaryHealthySince = null; // a canary wobbled — restart the soak
      }
    }

    // Completion: every approved box on the target.
    const total = approved.length;
    const onTarget = approved.filter((m) => m.agentVersion === rollout.targetVersion).length;
    if (total > 0 && onTarget === total && !this.completeEmitted) {
      this.completeEmitted = true;
      this.emit("good", `Fleet updated to agent ${rollout.targetVersion}`);
      this.deps.broadcast?.();
    }

    // Re-offer to any in-wave machine still behind (covers a just-promoted wave 2 + resumed rollouts).
    for (const m of approved) this.maybeOffer(m.id);
  }

  /** Convenience: fold a machine's heartbeat into the rollout, then re-evaluate. */
  async onHeartbeat(machineId: string): Promise<void> {
    this.maybeOffer(machineId);
    await this.evaluate();
  }

  // ── views ───────────────────────────────────────────────────────────────────

  /** Build the RolloutView for the console (intent + derived stage + soak countdown). */
  view(): RolloutView | null {
    const rollout = this.rollout;
    if (!rollout) return null;

    const approved = this.deps.control.getMachines().filter((m) => m.status === "approved");
    const total = approved.length;
    const onTarget = approved.filter((m) => m.agentVersion === rollout.targetVersion).length;

    const stage: RolloutView["stage"] =
      total > 0 && onTarget === total
        ? "complete"
        : rollout.strategy === "canary" && !rollout.promoted
          ? "canary"
          : "fleet";

    let soakRemainingMs: number | undefined;
    if (
      rollout.strategy === "canary" &&
      !rollout.promoted &&
      !rollout.paused &&
      rollout.promotion === "auto" &&
      this.canaryHealthySince !== null
    ) {
      soakRemainingMs = Math.max(0, this.soakMs - (this.now() - this.canaryHealthySince));
    }

    return RolloutView.parse({
      targetVersion: rollout.targetVersion,
      strategy: rollout.strategy,
      promotion: rollout.promotion,
      canaryMachineIds: rollout.canaryMachineIds,
      promoted: rollout.promoted,
      paused: rollout.paused,
      stage,
      createdAt: rollout.createdAt,
      ...(soakRemainingMs !== undefined ? { soakRemainingMs } : {}),
    });
  }

  /** The version an approved machine is destined for under the current rollout (for MachineView). */
  targetFor(machineId: string): string | undefined {
    const rollout = this.rollout;
    if (!rollout) return undefined;
    const machine = this.deps.control.getMachine(machineId);
    if (!machine || machine.status !== "approved") return undefined;
    if (machine.agentVersion === rollout.targetVersion) return undefined; // already there
    return rollout.targetVersion;
  }

  /**
   * Whether a machine is behind the depot's release BECAUSE its provisioning epoch is too low — it must
   * re-run the installer to gain the new provisioning; OTA can't apply it. Independent of a rollout, so
   * the console can flag it as soon as a provisioning-changing release lands.
   */
  needsInstaller(machine: Machine): boolean {
    const manifest = this.manifest;
    if (!manifest) return false;
    if (machine.agentVersion === manifest.version) return false;
    return manifest.provisionEpoch > (machine.provisionEpoch ?? 0);
  }

  // ── internals ───────────────────────────────────────────────────────────────

  /** A machine is "healthy on target" when online, reporting the target version, and not mid-flight. */
  private isHealthyOnTarget(machineId: string, target: string): boolean {
    if (!this.deps.presence.isMachineOnline(machineId)) return false;
    const machine = this.deps.control.getMachine(machineId);
    if (!machine || machine.agentVersion !== target) return false;
    const st = this.deps.control.agentReport(machineId)?.updateState;
    return st === undefined || st === "idle" || st === "healthy";
  }

  /** A canary failure: it reported failed/rolled-back, or it's been offline too long without landing. */
  private isFailure(machineId: string, rollout: PersistedRollout): boolean {
    const st = this.deps.control.agentReport(machineId)?.updateState;
    if (st === "failed" || st === "rolled-back") return true;

    const machine = this.deps.control.getMachine(machineId);
    if (machine?.agentVersion === rollout.targetVersion) return false; // it landed — not a failure

    const offeredAt = this.offeredAt.get(machineId);
    if (offeredAt === undefined) return false; // never offered yet
    const online = this.deps.presence.isMachineOnline(machineId);
    return !online && this.now() - offeredAt > this.offlineFailMs;
  }

  /** The fleet's current majority agent version (excluding `exclude`), or null if none — the rollback target. */
  private majorityVersion(exclude: string): string | null {
    const counts = new Map<string, number>();
    for (const m of this.deps.control.getMachines()) {
      if (m.status !== "approved") continue;
      const v = m.agentVersion;
      if (!v || v === exclude) continue;
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestN = 0;
    for (const [v, n] of counts) {
      if (n > bestN) {
        best = v;
        bestN = n;
      }
    }
    return best;
  }

  private async persist(rollout: PersistedRollout): Promise<void> {
    this.rollout = rollout;
    await this.deps.store.setRollout(rollout);
  }

  private resetProgress(): void {
    this.canaryHealthySince = null;
    this.completeEmitted = false;
    this.haltEmitted = false;
    this.lastOffer.clear();
    this.offeredAt.clear();
  }

  private emit(severity: "info" | "good" | "warn" | "bad", text: string): void {
    this.deps.activity.push(severity, text);
  }
}
