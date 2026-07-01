/**
 * The three WebSocket channels, multiplexed onto Fastify's underlying HTTP server.
 *
 *   /agent   (machine ↔ server): enrollment + status. On `agent/hello` the server authenticates the
 *            machine (Phase 2b) and acts on the decision:
 *              - OPEN MODE (no bootstrap token): register + auto-approve + ensure a Screen per output
 *                and reply `server/apply` — exactly Phase 2a.
 *              - GATED first contact (valid token, NEW machine): create it `pending`, issue a durable
 *                credential via `server/enrolled`, then `server/pending`. No screens, no apply.
 *              - valid credential + approved: admit (ensure screens, `server/apply`).
 *              - valid credential / token + pending: `server/pending` (socket stays open).
 *              - bad/absent token AND credential, or a `rejected` machine: `server/rejected` + CLOSE.
 *            The socket's lifetime marks the machine ONLINE for the admin UI; it is also tracked by
 *            machineId in the `AgentHub` so an operator's approve/reject reaches it live.
 *
 *   /player  (screen ↔ server): the instant content path. On `player/hello` we register the socket
 *            under its screenId and reply `server/render` with the screen's current slice. The
 *            socket's lifetime marks the screen ONLINE; `player/ack` records its observed revision.
 *
 *   /admin   (admin UI ↔ server): on connect we push a full `admin/state` snapshot, then a fresh
 *            snapshot on `admin/hello`. Thereafter the server broadcasts `admin/state` on every
 *            change (handled via the AdminBroadcaster wired into the agent/player flows + REST).
 *
 * Every inbound frame is parsed with the protocol's zod schemas at the edge; malformed frames are
 * logged and dropped, never trusted.
 */
import { WebSocket, WebSocketServer } from "ws";

import {
  AdminMessage,
  AgentMessage,
  PlayerMessage,
  ServerToAgentApply,
  ServerToAgentEnrolled,
  ServerToAgentPending,
  ServerToAgentRejected,
  ServerToPlayerRender,
  parseMessage,
} from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { Server } from "node:http";
import type { RawData } from "ws";

import { hashCredential } from "./enroll";
import type { Enrollment } from "./enroll";
import type { AuthService } from "./auth-local";
import type { CaptureCoordinator } from "./capture";
import type { ControlPlane, RegisterMachineInput, ScreenAssignment } from "./state";
import type { AgentHub, PlayerHub } from "./hub";
import type { AdminBroadcaster, AdminHub, Presence } from "./admin";
import type { ActivityLog } from "./activity";

interface WsDeps {
  server: Server;
  control: ControlPlane;
  enrollment: Enrollment;
  /** Local-auth service — gates the /admin upgrade on a valid session cookie (Phase 3f). */
  auth: AuthService;
  hub: PlayerHub;
  agentHub: AgentHub;
  adminHub: AdminHub;
  presence: Presence;
  broadcaster: AdminBroadcaster;
  /** Live Activity feed (D25) — presence emits machine + screen connect/drop lines here. */
  activity: ActivityLog;
  /** Live-preview capture (Phase 5) — ingests inbound `agent/thumbnail` frames. */
  capture: CaptureCoordinator;
  log: FastifyBaseLogger;
  /** Allowed browser origins for the /admin WS upgrade (anti-CSWSH); from CORS_ORIGIN. */
  allowedOrigins: string[];
}

export function attachWebSockets(deps: WsDeps): void {
  const { server, control, enrollment, auth, hub, agentHub, adminHub, presence, broadcaster, activity, capture, log, allowedOrigins } =
    deps;

  const agentWss = new WebSocketServer({ noServer: true });
  const playerWss = new WebSocketServer({ noServer: true });
  const adminWss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req, socket, head) => {
    let pathname: string;
    try {
      pathname = new URL(req.url ?? "/", "http://localhost").pathname;
    } catch {
      socket.destroy();
      return;
    }

    if (pathname === "/agent") {
      // Device channel — authenticated via enrollment credentials on agent/hello, NOT a user session.
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
    } else if (pathname === "/player") {
      // Device channel — players carry no user session; not gated.
      playerWss.handleUpgrade(req, socket, head, (ws) => playerWss.emit("connection", ws, req));
    } else if (pathname === "/admin") {
      // Anti-CSWSH: a browser WS handshake sends the page's Origin and the cookie is auto-attached, so
      // reject a cross-site origin BEFORE the cookie check (SameSite doesn't cover WS upgrades). A
      // non-browser client (the e2e) sends no Origin and passes through.
      const origin = req.headers.origin;
      if (origin && !allowedOrigins.includes(origin)) {
        log.warn({ event: "admin.ws.badorigin", origin }, "rejected /admin upgrade — origin not allowed");
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      // Operator channel — gate on a valid signed session cookie (Phase 3f). When auth is disabled the
      // check is skipped (mirrors the REST gate). Reject the upgrade outright if there is no session.
      if (!auth.enabled) {
        adminWss.handleUpgrade(req, socket, head, (ws) => adminWss.emit("connection", ws, req));
        return;
      }
      void auth
        .verifyCookieHeader(req.headers.cookie)
        .then((user) => {
          if (!user) {
            log.warn({ event: "admin.ws.rejected" }, "rejected /admin upgrade — no valid session");
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          adminWss.handleUpgrade(req, socket, head, (ws) => adminWss.emit("connection", ws, req));
        })
        .catch((err) => {
          log.warn({ event: "admin.ws.error", err: String(err) }, "error gating /admin upgrade");
          socket.destroy();
        });
    } else {
      socket.destroy();
    }
  });

  agentWss.on("connection", (ws: WebSocket) =>
    handleAgent(ws, control, enrollment, agentHub, presence, broadcaster, activity, capture, log),
  );
  playerWss.on("connection", (ws: WebSocket) =>
    handlePlayer(ws, control, hub, presence, broadcaster, activity, log),
  );
  adminWss.on("connection", (ws: WebSocket) =>
    handleAdmin(ws, adminHub, broadcaster, log),
  );
}

function handleAgent(
  ws: WebSocket,
  control: ControlPlane,
  enrollment: Enrollment,
  agentHub: AgentHub,
  presence: Presence,
  broadcaster: AdminBroadcaster,
  activity: ActivityLog,
  capture: CaptureCoordinator,
  log: FastifyBaseLogger,
): void {
  log.info({ event: "agent.connected" }, "agent socket opened");
  let machineId: string | null = null;
  let presenceMarked = false;
  let hubRegistered = false;

  // ── small typed senders, all validated against the contract before they leave ──

  function sendApply(targetMachineId: string, assignments: ScreenAssignment[]): void {
    const apply = ServerToAgentApply.parse({
      t: "server/apply",
      revision: control.state.revision,
      machineId: targetMachineId,
      screens: assignments,
    });
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(apply));
  }

  function sendEnrolled(targetMachineId: string, credential: string, status: "pending" | "approved"): void {
    const enrolled = ServerToAgentEnrolled.parse({
      t: "server/enrolled",
      machineId: targetMachineId,
      credential,
      status,
    });
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(enrolled));
  }

  function sendPending(reason?: string): void {
    const pending = ServerToAgentPending.parse(
      reason ? { t: "server/pending", reason } : { t: "server/pending" },
    );
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(pending));
  }

  function sendRejected(reason: string): void {
    const rejected = ServerToAgentRejected.parse({ t: "server/rejected", reason });
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(rejected));
  }

  async function onHello(msg: Extract<AgentMessage, { t: "agent/hello" }>): Promise<void> {
    const existing = control.getMachine(msg.machineId);
    const decision = enrollment.authenticate(
      msg,
      existing
        ? { status: existing.status, credentialHash: control.getCredentialHash(msg.machineId) }
        : undefined,
    );

    // Reject path: tell the agent why and CLOSE — never mark presence, never admit.
    if (decision.kind === "reject") {
      const reason = decision.reason ?? "enrollment rejected";
      sendRejected(reason);
      log.info(
        { event: "agent.rejected", machineId: msg.machineId, reason },
        "agent enrollment rejected — closing socket",
      );
      ws.close();
      return;
    }

    // From here the connection is kept: mark presence + register the socket by machineId.
    machineId = msg.machineId;
    if (!hubRegistered) {
      agentHub.add(machineId, ws);
      hubRegistered = true;
    }
    // True online edge: emit ONE "connected" line only when the machine goes 0→online (a second
    // overlapping agent socket for the same machine doesn't re-announce).
    let cameOnline = false;
    if (!presenceMarked) {
      cameOnline = !presence.isMachineOnline(machineId);
      presence.agentConnected(machineId);
      presenceMarked = true;
    }

    const input: RegisterMachineInput = {
      machineId: msg.machineId,
      agentVersion: msg.agentVersion,
      backend: msg.backend,
      outputs: msg.outputs,
      hostname: msg.hostname,
    };

    try {
      switch (decision.kind) {
        case "open":
        case "admit": {
          // OPEN MODE auto-approve, OR an approved machine (re)connecting. If a credential is being
          // re-issued (token re-enrol of an approved machine), persist its hash + announce it first.
          const credentialHash = decision.credential ? hashCredential(decision.credential) : undefined;
          const { changed, assignments } = await control.registerMachine(input, credentialHash);
          if (decision.credential) {
            sendEnrolled(msg.machineId, decision.credential, "approved");
          }
          sendApply(msg.machineId, assignments);
          log.info(
            {
              event: "agent.hello",
              mode: enrollment.open ? "open" : "gated",
              decision: decision.kind,
              reissued: Boolean(decision.credential),
              machineId: msg.machineId,
              agentVersion: msg.agentVersion,
              backend: msg.backend,
              outputs: msg.outputs.length,
              screens: assignments.map((a) => a.screenId),
              revision: control.state.revision,
              changed,
            },
            "agent admitted",
          );
          break;
        }

        case "enroll-pending": {
          // GATED first contact: create the machine pending, persist outputs + the new credential
          // hash, hand the agent its durable credential, then park it pending. No screens, no apply.
          const credential = decision.credential ?? "";
          await control.enrollPending(input, hashCredential(credential));
          sendEnrolled(msg.machineId, credential, "pending");
          sendPending(decision.reason);
          log.info(
            {
              event: "agent.enrolled",
              machineId: msg.machineId,
              outputs: msg.outputs.length,
              status: "pending",
            },
            "new machine enrolled — awaiting operator approval",
          );
          break;
        }

        case "pending": {
          // Recognised but still pending. A credential present here is a token re-enrol of a pending
          // machine (lost its credential): persist the new hash + announce it before parking.
          if (decision.credential) {
            await control.setMachineCredential(
              msg.machineId,
              hashCredential(decision.credential),
              msg.outputs,
            );
            sendEnrolled(msg.machineId, decision.credential, "pending");
          } else {
            await control.touchMachine(msg.machineId, msg.outputs);
          }
          sendPending(decision.reason);
          log.info(
            {
              event: "agent.pending",
              machineId: msg.machineId,
              reissued: Boolean(decision.credential),
            },
            "agent pending — awaiting operator approval",
          );
          break;
        }
      }

      // A machine came online (and possibly new screens / a status change) — refresh the admin view.
      if (cameOnline) {
        const label = control.getMachine(msg.machineId)?.label ?? msg.machineId;
        activity.push("good", `${label} connected`);
      }
      broadcaster.broadcast();
    } catch (err) {
      log.error(
        { event: "agent.hello.error", machineId: msg.machineId, decision: decision.kind, err: String(err) },
        "failed to process agent hello",
      );
    }
  }

  ws.on("message", (data: RawData) => {
    let msg: AgentMessage;
    try {
      msg = parseMessage(AgentMessage, data.toString());
    } catch (err) {
      log.warn({ event: "agent.frame.invalid", err: String(err) }, "rejected invalid agent frame");
      return;
    }

    if (msg.t === "agent/hello") {
      void onHello(msg);
    } else if (msg.t === "agent/status") {
      log.info(
        { event: "agent.status", machineId: msg.machineId, observedRevision: msg.observedRevision },
        "agent status",
      );
    } else {
      // agent/thumbnail — the frame is already AgentMessage-validated; hand it to the coordinator,
      // which resolves connector→screenId, decodes the payload and stores the latest preview (Phase 5).
      capture.ingest(msg);
    }
  });

  ws.on("close", (code) => {
    if (machineId && hubRegistered) agentHub.remove(machineId, ws);
    if (machineId && presenceMarked) {
      // Resolve the machine BEFORE dropping presence; emit only on the true online→offline edge — and
      // NOT when the machine was just REMOVED (its socket close is expected; removal already logged it,
      // and it no longer resolves to a friendly label).
      const machine = control.getMachine(machineId);
      presence.agentDisconnected(machineId);
      if (machine && !presence.isMachineOnline(machineId)) {
        activity.push("bad", `${machine.label} went unreachable`);
      }
      broadcaster.broadcast();
    }
    log.info({ event: "agent.disconnected", machineId, code }, "agent socket closed");
  });
  ws.on("error", (err) =>
    log.warn({ event: "agent.error", machineId, err: String(err) }, "agent socket error"),
  );
}

function handlePlayer(
  ws: WebSocket,
  control: ControlPlane,
  hub: PlayerHub,
  presence: Presence,
  broadcaster: AdminBroadcaster,
  activity: ActivityLog,
  log: FastifyBaseLogger,
): void {
  log.info({ event: "player.connected" }, "player socket opened");
  let screenId: string | null = null;

  ws.on("message", (data: RawData) => {
    let msg: PlayerMessage;
    try {
      msg = parseMessage(PlayerMessage, data.toString());
    } catch (err) {
      log.warn({ event: "player.frame.invalid", err: String(err) }, "rejected invalid player frame");
      return;
    }

    if (msg.t === "player/hello") {
      screenId = msg.screenId;
      // True online edge: this socket takes the screen from 0→online (no player was connected before).
      const cameOnline = hub.count(screenId) === 0;
      hub.add(screenId, ws);
      if (cameOnline) {
        const name = control.getScreen(screenId)?.friendlyName ?? screenId;
        activity.push("good", `${name} connected`);
      }
      const slice = control.sliceForPlayer(screenId);
      const render = ServerToPlayerRender.parse({
        t: "server/render",
        revision: control.state.revision,
        slice,
      });
      ws.send(JSON.stringify(render));
      log.info(
        {
          event: "player.hello",
          screenId,
          revision: control.state.revision,
          surfaces: slice.surfaces.length,
          sockets: hub.count(screenId),
        },
        "player registered",
      );
      // Screen just came online — refresh the admin view.
      broadcaster.broadcast();
    } else {
      // player/ack — record the revision this screen has observed.
      presence.setScreenObservedRevision(msg.screenId, msg.revision);
      log.debug(
        { event: "player.ack", screenId: msg.screenId, revision: msg.revision },
        "player ack",
      );
      broadcaster.broadcast();
    }
  });

  ws.on("close", (code) => {
    if (screenId) {
      // Resolve the name BEFORE removing; emit only on the true online→offline edge (last socket gone).
      const name = control.getScreen(screenId)?.friendlyName ?? screenId;
      hub.remove(screenId, ws);
      if (hub.count(screenId) === 0) {
        activity.push("bad", `${name} went unreachable`);
      }
      // Screen may have gone offline (no sockets left) — refresh the admin view.
      broadcaster.broadcast();
    }
    log.info({ event: "player.disconnected", screenId, code }, "player socket closed");
  });
  ws.on("error", (err) =>
    log.warn({ event: "player.error", screenId, err: String(err) }, "player socket error"),
  );
}

function handleAdmin(
  ws: WebSocket,
  adminHub: AdminHub,
  broadcaster: AdminBroadcaster,
  log: FastifyBaseLogger,
): void {
  adminHub.add(ws);
  log.info({ event: "admin.connected", admins: adminHub.count() }, "admin socket opened");

  // On connect: push the current registry snapshot straight away.
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(broadcaster.snapshot()));
  }

  ws.on("message", (data: RawData) => {
    let msg: AdminMessage;
    try {
      msg = parseMessage(AdminMessage, data.toString());
    } catch (err) {
      log.warn({ event: "admin.frame.invalid", err: String(err) }, "rejected invalid admin frame");
      return;
    }

    if (msg.t === "admin/hello") {
      // Re-send a fresh snapshot so the client has state regardless of connect/hello timing.
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(broadcaster.snapshot()));
      }
      log.info({ event: "admin.hello" }, "admin registered");
    }
  });

  ws.on("close", (code) => {
    adminHub.remove(ws);
    log.info({ event: "admin.disconnected", code, admins: adminHub.count() }, "admin socket closed");
  });
  ws.on("error", (err) =>
    log.warn({ event: "admin.error", err: String(err) }, "admin socket error"),
  );
}
