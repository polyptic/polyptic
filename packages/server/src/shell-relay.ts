/**
 * Remote-shell relay (POL-59): the server's middle of an operator terminal.
 *
 * A kiosk box dials OUT to the control plane (D12), so there is nothing to SSH into; the operator's
 * terminal is tunnelled over two WS channels the server already authenticates — the `/admin` socket
 * (gated on the operator session) and the machine's `/agent` socket (gated on its enrolment
 * credential). This class owns the sessions that bridge them and relays bytes VERBATIM: it never
 * interprets terminal data, it only routes it, scoped to a single machine.
 *
 * The security posture (the reason this is safe to have at all):
 *   - DISARMED by default. A session can only OPEN against a box an operator armed
 *     (`Machine.shellEnabled`); disarming closes every live session for that box.
 *   - UNPRIVILEGED. The agent runs the PTY as the kiosk user; nothing here changes that.
 *   - SCOPED. Every frame carries a machineId; a session is bound to the one admin socket that
 *     opened it and the one agent socket serving it. No broadcast, no cross-machine leakage.
 *   - AUDITED. Open / refuse / close each emit an activity line and a structured log.
 */
import { randomUUID } from "node:crypto";

import {
  ServerToAgentShellClose,
  ServerToAgentShellData,
  ServerToAgentShellOpen,
  ServerToAgentShellResize,
} from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";

import type { ActivityLog } from "./activity";
import type { AgentHub } from "./hub";
import type { ControlPlane } from "./state";

/** No operator needs more than a couple of live terminals against one box. */
const MAX_SESSIONS_PER_MACHINE = 2;

interface Session {
  sessionId: string;
  machineId: string;
  admin: WebSocket;
}

export class ShellRelay {
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly agentHub: AgentHub,
    private readonly control: ControlPlane,
    private readonly activity: ActivityLog,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Send a server→admin shell frame if the socket is still open. */
  private toAdmin(admin: WebSocket, msg: Record<string, unknown>): void {
    if (admin.readyState === admin.OPEN) admin.send(JSON.stringify(msg));
  }

  // ── operator (admin socket) → box ────────────────────────────────────────────

  /**
   * An operator opened a terminal on `machineId`. Mint a session and ask the agent to start a PTY —
   * but only when the box is APPROVED, ARMED, and ONLINE. Any failure replies `server/shell-opened`
   * with `ok:false` and a reason, so the console shows why instead of a dead terminal.
   */
  openFromAdmin(admin: WebSocket, machineId: string, cols: number, rows: number): void {
    const machine = this.control.getMachine(machineId);
    const refuse = (reason: string): void => {
      this.toAdmin(admin, { t: "server/shell-opened", machineId, sessionId: "", ok: false, reason });
      this.log.warn({ event: "shell.refused", machineId, reason }, "remote shell refused");
    };

    if (!machine) return refuse("unknown machine");
    if (machine.status !== "approved") return refuse(`machine is ${machine.status}, not approved`);
    if (!this.control.isShellEnabled(machineId)) {
      return refuse("the console is not enabled for this machine — enable it first");
    }
    const live = [...this.sessions.values()].filter((s) => s.machineId === machineId);
    if (live.length >= MAX_SESSIONS_PER_MACHINE) return refuse("too many shell sessions open on this machine");

    const sessionId = randomUUID();
    const open = ServerToAgentShellOpen.parse({ t: "server/shell-open", sessionId, cols, rows });
    const delivered = this.agentHub.send(machineId, open);
    if (delivered === 0) return refuse("machine is offline");

    this.sessions.set(sessionId, { sessionId, machineId, admin });
    this.activity.push("accent", `Console session opened on ${machine.label}`);
    this.log.info({ event: "shell.open", machineId, sessionId }, "remote shell session opening");
  }

  /** Operator keystrokes → the box. Dropped unless the session is this admin's and still armed. */
  dataFromAdmin(admin: WebSocket, machineId: string, sessionId: string, dataBase64: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.admin !== admin || session.machineId !== machineId) return;
    if (!this.control.isShellEnabled(machineId)) {
      this.close(sessionId, "console disabled");
      return;
    }
    this.agentHub.send(machineId, ServerToAgentShellData.parse({ t: "server/shell-data", sessionId, dataBase64 }));
  }

  resizeFromAdmin(admin: WebSocket, machineId: string, sessionId: string, cols: number, rows: number): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.admin !== admin) return;
    this.agentHub.send(machineId, ServerToAgentShellResize.parse({ t: "server/shell-resize", sessionId, cols, rows }));
  }

  /** Operator closed the terminal. */
  closeFromAdmin(admin: WebSocket, machineId: string, sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.admin !== admin) return;
    this.close(sessionId, "closed by operator");
  }

  /** An admin socket dropped — end every session it opened (a shell is authorised by the live UI). */
  adminDisconnected(admin: WebSocket): void {
    for (const session of [...this.sessions.values()]) {
      if (session.admin === admin) this.close(session.sessionId, "operator disconnected");
    }
  }

  // ── box (agent socket) → operator ────────────────────────────────────────────

  /** The agent's answer to a shell-open: relay it to the operator, and drop the session if it failed. */
  openedFromAgent(machineId: string, sessionId: string, ok: boolean, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.machineId !== machineId) return;
    this.toAdmin(session.admin, { t: "server/shell-opened", machineId, sessionId, ok, reason });
    if (!ok) {
      this.sessions.delete(sessionId);
      this.log.warn({ event: "shell.agent_refused", machineId, sessionId, reason }, "agent refused shell");
    }
  }

  /** PTY output → the operator's terminal. */
  dataFromAgent(machineId: string, sessionId: string, dataBase64: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.machineId !== machineId) return;
    this.toAdmin(session.admin, { t: "server/shell-data", machineId, sessionId, dataBase64 });
  }

  /** The PTY exited on the box. */
  closedFromAgent(machineId: string, sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.machineId !== machineId) return;
    this.sessions.delete(sessionId);
    this.toAdmin(session.admin, { t: "server/shell-closed", machineId, sessionId, reason: reason ?? "shell exited" });
  }

  /** The machine's agent socket dropped — every session on it is dead. */
  agentDisconnected(machineId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.machineId === machineId) {
        this.sessions.delete(session.sessionId);
        this.toAdmin(session.admin, {
          t: "server/shell-closed",
          machineId,
          sessionId: session.sessionId,
          reason: "machine went offline",
        });
      }
    }
  }

  /** Disarm hook: close every session on a machine an operator just disarmed. */
  closeMachineSessions(machineId: string, reason: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.machineId === machineId) this.close(session.sessionId, reason);
    }
  }

  /** Tear a session down: tell the box to kill the PTY, tell the operator it's over, forget it. */
  private close(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.agentHub.send(session.machineId, ServerToAgentShellClose.parse({ t: "server/shell-close", sessionId, reason }));
    this.toAdmin(session.admin, { t: "server/shell-closed", machineId: session.machineId, sessionId, reason });
    this.log.info({ event: "shell.close", machineId: session.machineId, sessionId, reason }, "remote shell session closed");
  }
}
