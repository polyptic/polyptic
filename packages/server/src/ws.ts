/**
 * The three WebSocket channels, multiplexed onto Fastify's underlying HTTP server.
 *
 *   /agent   (machine ↔ server): enrollment + status. On `agent/hello` we register the machine
 *            (write-through to the Store), ensure a Screen per output, and reply `server/apply` with
 *            each output's screen id and player URL. The agent then opens those URLs via its backend.
 *            The socket's lifetime marks the machine ONLINE for the admin UI.
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
  ServerToPlayerRender,
  parseMessage,
} from "@polyptych/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { Server } from "node:http";
import type { RawData } from "ws";

import type { ControlPlane } from "./state";
import type { PlayerHub } from "./hub";
import type { AdminBroadcaster, AdminHub, Presence } from "./admin";

interface WsDeps {
  server: Server;
  control: ControlPlane;
  hub: PlayerHub;
  adminHub: AdminHub;
  presence: Presence;
  broadcaster: AdminBroadcaster;
  log: FastifyBaseLogger;
}

export function attachWebSockets(deps: WsDeps): void {
  const { server, control, hub, adminHub, presence, broadcaster, log } = deps;

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
      agentWss.handleUpgrade(req, socket, head, (ws) => agentWss.emit("connection", ws, req));
    } else if (pathname === "/player") {
      playerWss.handleUpgrade(req, socket, head, (ws) => playerWss.emit("connection", ws, req));
    } else if (pathname === "/admin") {
      adminWss.handleUpgrade(req, socket, head, (ws) => adminWss.emit("connection", ws, req));
    } else {
      socket.destroy();
    }
  });

  agentWss.on("connection", (ws: WebSocket) =>
    handleAgent(ws, control, presence, broadcaster, log),
  );
  playerWss.on("connection", (ws: WebSocket) =>
    handlePlayer(ws, control, hub, presence, broadcaster, log),
  );
  adminWss.on("connection", (ws: WebSocket) =>
    handleAdmin(ws, adminHub, broadcaster, log),
  );
}

function handleAgent(
  ws: WebSocket,
  control: ControlPlane,
  presence: Presence,
  broadcaster: AdminBroadcaster,
  log: FastifyBaseLogger,
): void {
  log.info({ event: "agent.connected" }, "agent socket opened");
  let machineId: string | null = null;
  let presenceMarked = false;

  ws.on("message", (data: RawData) => {
    let msg: AgentMessage;
    try {
      msg = parseMessage(AgentMessage, data.toString());
    } catch (err) {
      log.warn({ event: "agent.frame.invalid", err: String(err) }, "rejected invalid agent frame");
      return;
    }

    if (msg.t === "agent/hello") {
      machineId = msg.machineId;
      if (!presenceMarked) {
        presence.agentConnected(machineId);
        presenceMarked = true;
      }
      void (async () => {
        try {
          const { changed, assignments } = await control.registerMachine({
            machineId: msg.machineId,
            agentVersion: msg.agentVersion,
            backend: msg.backend,
            outputs: msg.outputs,
          });
          const apply = ServerToAgentApply.parse({
            t: "server/apply",
            revision: control.state.revision,
            machineId: msg.machineId,
            screens: assignments,
          });
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(apply));
          log.info(
            {
              event: "agent.hello",
              machineId: msg.machineId,
              agentVersion: msg.agentVersion,
              backend: msg.backend,
              outputs: msg.outputs.length,
              screens: assignments.map((a) => a.screenId),
              revision: control.state.revision,
              changed,
            },
            "agent registered",
          );
          // A machine (online) and possibly new screens — refresh the admin view.
          broadcaster.broadcast();
        } catch (err) {
          log.error(
            { event: "agent.register.error", machineId: msg.machineId, err: String(err) },
            "failed to register machine",
          );
        }
      })();
    } else if (msg.t === "agent/status") {
      log.info(
        { event: "agent.status", machineId: msg.machineId, observedRevision: msg.observedRevision },
        "agent status",
      );
    } else {
      // agent/thumbnail — captured but not yet stored (Phase 5).
      log.debug(
        { event: "agent.thumbnail", machineId: msg.machineId, connector: msg.connector, mime: msg.mime },
        "agent thumbnail",
      );
    }
  });

  ws.on("close", (code) => {
    if (machineId && presenceMarked) {
      presence.agentDisconnected(machineId);
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
      hub.add(screenId, ws);
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
      hub.remove(screenId, ws);
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
