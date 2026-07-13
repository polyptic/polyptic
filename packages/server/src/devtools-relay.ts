/**
 * Remote-DevTools relay (POL-67): the server's middle of an operator driving Chrome DevTools
 * against a wall screen's browser.
 *
 * Chrome on the box exposes its DevTools protocol on a LOOPBACK-ONLY port; the agent proxies it
 * (see the agent's ./devtools.ts) and this class bridges that to the operator's own browser — the
 * POL-59 shell-relay pattern, because the trust model is identical:
 *
 *   - DISARMED by default. Relaying happens only for a screen an operator armed via the existing
 *     inspect flow (`ScreenView.inspecting`, set ONLY by the agent's `agent/inspect-ack`).
 *     Disarming closes every live session for that screen; the agent re-checks the arm per frame.
 *   - OPERATOR-AUTHENTICATED. The HTTP proxy routes live under /api/v1 (session-gated) and the
 *     CDP WebSocket upgrade is cookie-gated in ws.ts, exactly like /admin.
 *   - SCOPED. One session binds one operator socket to one (machine, connector); no broadcast.
 *   - AUDITED. Open / refuse / close emit activity lines and structured logs.
 *
 * Two relay shapes, matching the two halves of the DevTools protocol:
 *   - one-shot HTTP GETs (the frontend's files, /json/list) — request/response over the agent WS,
 *   - the CDP WebSocket — a byte-for-byte bridged session.
 */
import { randomUUID } from "node:crypto";

import {
  ServerToAgentDevtoolsClose,
  ServerToAgentDevtoolsData,
  ServerToAgentDevtoolsOpen,
  ServerToAgentDevtoolsRequest,
} from "@polyptic/protocol";
import type { Screen } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { WebSocket } from "ws";

import type { ActivityLog } from "./activity";
import type { Presence } from "./admin";
import type { AgentHub } from "./hub";
import type { ControlPlane } from "./state";

/** One DevTools frontend tab holds one CDP socket; a few tabs per screen is plenty. */
const MAX_SESSIONS_PER_SCREEN = 4;
/** How long one proxied GET may take end-to-end (agent fetch is bounded tighter). */
const REQUEST_TIMEOUT_MS = 15_000;

/** The result of one proxied HTTP GET against the box's DevTools server. */
export interface DevtoolsHttpResponse {
  status: number;
  contentType?: string;
  body: Buffer;
}

interface PendingRequest {
  resolve(res: DevtoolsHttpResponse): void;
  reject(err: Error): void;
  timer: ReturnType<typeof setTimeout>;
  machineId: string;
}

interface Session {
  sessionId: string;
  screenId: string;
  machineId: string;
  client: WebSocket;
  /** Client frames buffered until the agent confirms the CDP socket is open. */
  buffered: string[];
  opened: boolean;
}

export class DevtoolsRelay {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly sessions = new Map<string, Session>();

  constructor(
    private readonly agentHub: AgentHub,
    private readonly control: ControlPlane,
    private readonly presence: Presence,
    private readonly activity: ActivityLog,
    private readonly log: FastifyBaseLogger,
  ) {}

  /**
   * The policy gate, shared by the HTTP proxy and the WS bridge: the screen must exist, its machine
   * must be approved and online, and an operator must have ARMED it (the agent's inspect-ack set
   * `inspecting`). Returns the screen or a human-readable refusal.
   */
  gate(screenId: string): { ok: true; screen: Screen } | { ok: false; reason: string } {
    const screen = this.control.getScreen(screenId);
    if (!screen) return { ok: false, reason: `unknown screen: ${screenId}` };
    const machine = this.control.getMachine(screen.machineId);
    if (!machine || machine.status !== "approved") {
      return { ok: false, reason: "the screen's machine is not approved" };
    }
    if (this.agentHub.count(screen.machineId) === 0) {
      return { ok: false, reason: "the screen's machine is offline" };
    }
    if (!this.presence.isScreenInspecting(screenId)) {
      return { ok: false, reason: "DevTools are not armed for this screen — use its Inspect/DevTools action first" };
    }
    return { ok: true, screen };
  }

  /** Is `screenId` armed for DevTools right now? (Used by routes to poll during the arm handshake.) */
  isArmed(screenId: string): boolean {
    return this.gate(screenId).ok;
  }

  // ── one-shot HTTP proxy ──────────────────────────────────────────────────────

  /** Proxy one GET to the armed screen's DevTools port. Rejects with the refusal/failure reason. */
  request(screenId: string, path: string): Promise<DevtoolsHttpResponse> {
    const gate = this.gate(screenId);
    if (!gate.ok) return Promise.reject(new Error(gate.reason));
    const { screen } = gate;

    const reqId = randomUUID();
    return new Promise<DevtoolsHttpResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(reqId);
        reject(new Error("the box did not answer in time"));
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(reqId, { resolve, reject, timer, machineId: screen.machineId });

      const frame = ServerToAgentDevtoolsRequest.parse({
        t: "server/devtools-request",
        reqId,
        connector: screen.connector,
        path,
      });
      if (this.agentHub.send(screen.machineId, frame) === 0) {
        clearTimeout(timer);
        this.pending.delete(reqId);
        reject(new Error("the screen's machine is offline"));
      }
    });
  }

  /** The agent's answer to one proxied GET. */
  responseFromAgent(
    machineId: string,
    reqId: string,
    ok: boolean,
    status?: number,
    contentType?: string,
    bodyBase64?: string,
    error?: string,
  ): void {
    const pending = this.pending.get(reqId);
    if (!pending || pending.machineId !== machineId) return;
    this.pending.delete(reqId);
    clearTimeout(pending.timer);
    if (!ok || status === undefined) {
      pending.reject(new Error(error ?? "the box refused the request"));
      return;
    }
    pending.resolve({
      status,
      contentType,
      body: Buffer.from(bodyBase64 ?? "", "base64"),
    });
  }

  // ── CDP WebSocket bridge ─────────────────────────────────────────────────────

  /**
   * An operator's DevTools frontend opened its CDP socket (already cookie-authenticated by the
   * upgrade in ws.ts). Bridge it to Chrome on the box via the agent. Any refusal closes the client
   * socket with the reason as the close frame's message, so the frontend shows why.
   */
  openFromClient(client: WebSocket, screenId: string, path: string): void {
    const gate = this.gate(screenId);
    const refuse = (reason: string): void => {
      this.log.warn({ event: "devtools.refused", screenId, reason }, "devtools session refused");
      try {
        client.close(1008, reason.slice(0, 120)); // 1008 = policy violation; reason capped per RFC6455
      } catch {
        client.terminate();
      }
    };
    if (!gate.ok) return refuse(gate.reason);
    const { screen } = gate;

    const live = [...this.sessions.values()].filter((s) => s.screenId === screenId);
    if (live.length >= MAX_SESSIONS_PER_SCREEN) return refuse("too many DevTools sessions open on this screen");

    const sessionId = randomUUID();
    const session: Session = {
      sessionId,
      screenId,
      machineId: screen.machineId,
      client,
      buffered: [],
      opened: false,
    };
    this.sessions.set(sessionId, session);

    client.on("message", (raw) => {
      // Re-gate on every operator frame: a disarm mid-session must go dark immediately.
      if (!this.presence.isScreenInspecting(screenId)) {
        this.close(sessionId, "DevTools disarmed");
        return;
      }
      const buf = Buffer.isBuffer(raw) ? raw : Array.isArray(raw) ? Buffer.concat(raw) : Buffer.from(raw);
      const dataBase64 = buf.toString("base64");
      if (!session.opened) {
        session.buffered.push(dataBase64);
        return;
      }
      this.agentHub.send(
        session.machineId,
        ServerToAgentDevtoolsData.parse({ t: "server/devtools-data", sessionId, dataBase64 }),
      );
    });
    client.on("close", () => {
      if (this.sessions.delete(sessionId)) {
        this.agentHub.send(
          session.machineId,
          ServerToAgentDevtoolsClose.parse({ t: "server/devtools-close", sessionId, reason: "operator closed DevTools" }),
        );
        this.log.info({ event: "devtools.close", screenId, sessionId }, "devtools session closed by operator");
      }
    });
    client.on("error", () => client.terminate());

    const open = ServerToAgentDevtoolsOpen.parse({
      t: "server/devtools-open",
      sessionId,
      connector: screen.connector,
      path,
    });
    if (this.agentHub.send(screen.machineId, open) === 0) {
      this.sessions.delete(sessionId);
      return refuse("the screen's machine is offline");
    }

    const name = this.control.getScreen(screenId)?.friendlyName ?? screenId;
    this.activity.push("warn", `Remote DevTools opened on ${name}`);
    this.log.info({ event: "devtools.open", screenId, machineId: screen.machineId, sessionId }, "devtools session opening");
  }

  /** The agent's answer to a devtools-open: flush buffered frames, or close the client with why. */
  openedFromAgent(machineId: string, sessionId: string, ok: boolean, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.machineId !== machineId) return;
    if (!ok) {
      this.sessions.delete(sessionId);
      this.log.warn({ event: "devtools.agent_refused", machineId, sessionId, reason }, "agent refused devtools");
      try {
        session.client.close(1011, (reason ?? "the box refused").slice(0, 120));
      } catch {
        session.client.terminate();
      }
      return;
    }
    session.opened = true;
    for (const dataBase64 of session.buffered.splice(0)) {
      this.agentHub.send(
        machineId,
        ServerToAgentDevtoolsData.parse({ t: "server/devtools-data", sessionId, dataBase64 }),
      );
    }
  }

  /** One CDP frame from Chrome → the operator's frontend (CDP frames are text). */
  dataFromAgent(machineId: string, sessionId: string, dataBase64: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.machineId !== machineId) return;
    if (session.client.readyState === session.client.OPEN) {
      session.client.send(Buffer.from(dataBase64, "base64").toString("utf8"));
    }
  }

  /** The CDP socket on the box ended. */
  closedFromAgent(machineId: string, sessionId: string, reason?: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.machineId !== machineId) return;
    this.sessions.delete(sessionId);
    try {
      session.client.close(1000, (reason ?? "closed on the box").slice(0, 120));
    } catch {
      session.client.terminate();
    }
  }

  /** The machine's agent socket dropped — every session on it is dead, and so is every pending GET. */
  agentDisconnected(machineId: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.machineId !== machineId) continue;
      this.sessions.delete(session.sessionId);
      try {
        session.client.close(1001, "machine went offline");
      } catch {
        session.client.terminate();
      }
    }
    for (const [reqId, pending] of [...this.pending.entries()]) {
      if (pending.machineId !== machineId) continue;
      this.pending.delete(reqId);
      clearTimeout(pending.timer);
      pending.reject(new Error("the screen's machine went offline"));
    }
  }

  /** Disarm hook: close every session on a screen the operator just disarmed. */
  closeScreenSessions(screenId: string, reason: string): void {
    for (const session of [...this.sessions.values()]) {
      if (session.screenId === screenId) this.close(session.sessionId, reason);
    }
  }

  /** Tear one session down: tell the box, tell the operator's frontend, forget it. */
  private close(sessionId: string, reason: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.delete(sessionId);
    this.agentHub.send(
      session.machineId,
      ServerToAgentDevtoolsClose.parse({ t: "server/devtools-close", sessionId, reason }),
    );
    try {
      session.client.close(1000, reason.slice(0, 120));
    } catch {
      session.client.terminate();
    }
    this.log.info(
      { event: "devtools.close", screenId: session.screenId, sessionId, reason },
      "devtools session closed",
    );
  }
}
