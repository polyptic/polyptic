/**
 * Operator SSH access (POL-81): the server's half of arming a real, encrypted, root-capable session
 * on a box — the complement to the POL-59 unprivileged remote shell.
 *
 * A kiosk box dials OUT to the control plane (D12), so the SERVER never SSHes into it. What this class
 * does is drive the box's own sshd, over the agent WS the server already authenticates:
 *
 *   - ARM   → push `server/ssh-arm { enabled:true, publicKey, debugUser, port, ttlMs }`. The agent
 *             hands it to a root-owned helper (the POL-55 escalation pattern), which installs the key
 *             for the dedicated debug user, starts sshd, and arms a box-side TTL timer.
 *   - DISARM → push `server/ssh-arm { enabled:false }`. The helper stops sshd + removes the key.
 *   - RECONCILE → on agent (re)connect, re-push the current arm so a box that dropped and came back
 *             converges to the armed state (the key rides along — it is public, never a secret).
 *   - SWEEP → auto-disarm a box left armed past the TTL. This reuses the SAME sweep mechanism as the
 *             shell (`ControlPlane.disarmExpired*` + one 60s tick driven from the ShellRelay), so
 *             there is ONE auto-disarm implementation for both surfaces, not two timers.
 *
 * The registry intent + persistence live in {@link ControlPlane}; the box's live status (armed,
 * listening, host/port, TTL) is reported back by the agent (`agent/ssh-status`) and kept in Presence.
 * The security posture (default-closed, key-only, root locked, TTL) is enforced on the BOX — see the
 * agent's ./ssh.ts and setup's sshd hardening. This class is the plumbing that arms it.
 */
import { ServerToAgentSshArm, SSH_DEBUG_USER, SSH_DEFAULT_PORT } from "@polyptic/protocol";
import type { SshStatus } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";

import type { ActivityLog } from "./activity";
import type { AdminBroadcaster } from "./admin";
import type { Presence } from "./admin";
import type { AgentHub } from "./hub";
import type { ControlPlane } from "./state";

export interface SshAccessConfig {
  /** The dedicated debug user the operator logs in as (never the kiosk user). */
  debugUser: string;
  /** The port sshd listens on while armed. */
  port: number;
  /** Box-side auto-disarm horizon in ms (also the server-sweep TTL). 0 disables both. */
  ttlMs: number;
}

export const DEFAULT_SSH_CONFIG: SshAccessConfig = {
  debugUser: SSH_DEBUG_USER,
  port: SSH_DEFAULT_PORT,
  ttlMs: 60 * 60 * 1000,
};

export class SshAccessManager {
  constructor(
    private readonly agentHub: AgentHub,
    private readonly control: ControlPlane,
    private readonly activity: ActivityLog,
    private readonly presence: Presence,
    private readonly broadcaster: AdminBroadcaster,
    private readonly log: FastifyBaseLogger,
    private readonly config: SshAccessConfig = DEFAULT_SSH_CONFIG,
  ) {}

  /** Push an arm to the box. `delivered === 0` when the agent is offline (the box reconciles on its
   *  next connect from the persisted intent). */
  arm(machineId: string, publicKey: string): number {
    const delivered = this.agentHub.send(
      machineId,
      ServerToAgentSshArm.parse({
        t: "server/ssh-arm",
        enabled: true,
        publicKey,
        debugUser: this.config.debugUser,
        port: this.config.port,
        ttlMs: this.config.ttlMs,
      }),
    );
    this.log.info({ event: "ssh.arm", machineId, delivered }, "pushed ssh-arm to agent");
    return delivered;
  }

  /** Push a disarm to the box. Best-effort: a disarm the offline box never received is enforced anyway
   *  by the box-side TTL and by sshd not being enabled at boot (default-closed on reboot). */
  disarm(machineId: string): number {
    const delivered = this.agentHub.send(
      machineId,
      ServerToAgentSshArm.parse({
        t: "server/ssh-arm",
        enabled: false,
        debugUser: this.config.debugUser,
        port: this.config.port,
        ttlMs: this.config.ttlMs,
      }),
    );
    this.log.info({ event: "ssh.disarm", machineId, delivered }, "pushed ssh-disarm to agent");
    return delivered;
  }

  /** Reconcile a (re)connected box to its persisted SSH intent (POL-81 / non-negotiable #2). Re-pushes
   *  the arm with the stored public key so a box that dropped mid-arm re-installs the key + sshd. */
  reconcile(machineId: string): void {
    const publicKey = this.control.sshPublicKey(machineId);
    if (!publicKey) return;
    this.arm(machineId, publicKey);
    this.log.info({ event: "ssh.reconcile", machineId }, "reconciled ssh arm to reconnected box");
  }

  /** The box's answer to an arm/disarm (`agent/ssh-status`) — the truth about whether sshd came up.
   *  Stored in Presence and broadcast so the console shows the real connection details. */
  onStatusFromAgent(machineId: string, status: SshStatus): void {
    this.presence.setSshStatus(machineId, status);
    const label = this.control.getMachine(machineId)?.label ?? machineId;
    if (status.armed && status.listening) {
      this.activity.push("accent", `SSH is open on ${label} (${status.user}@${status.host ?? "?"}:${status.port ?? "?"})`);
    } else if (status.armed && !status.listening) {
      this.activity.push("bad", `SSH could not open on ${label}: ${status.reason ?? "sshd did not start"}`);
    }
    this.broadcaster.broadcast();
    this.log.info(
      { event: "ssh.status", machineId, armed: status.armed, listening: status.listening, reason: status.reason },
      "agent ssh status",
    );
  }

  /**
   * Auto-disarm boxes armed past the TTL (POL-81). Called from the ONE arming sweep tick shared with
   * the shell (see index.ts). Disarms in the registry, pushes a disarm to each box, and broadcasts.
   * Returns the disarmed machine ids (for logging/tests).
   */
  async sweepExpired(nowMs: number): Promise<string[]> {
    const disarmed = await this.control.disarmExpiredSshAccess(this.config.ttlMs, nowMs);
    if (disarmed.length === 0) return [];
    for (const m of disarmed) {
      this.disarm(m.id);
      // The box may already be gone; drop the stale live status so the console stops showing "open".
      this.presence.setSshStatus(m.id, { armed: false, listening: false });
    }
    this.broadcaster.broadcast();
    return disarmed.map((m) => m.id);
  }
}
