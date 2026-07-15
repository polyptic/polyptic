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
 *   /player  (screen ↔ server): the instant content path. On `player/hello` the server first checks
 *            the screen's bearer token (POL-54 — minted into the playerUrl the agent launched the
 *            browser with; enforced whenever auth is enabled, since a slice carries POL-24
 *            credential-stamped URLs). A bad/absent token is CLOSED (4401), never registered. An
 *            admitted hello registers the socket under its screenId and replies `server/render`
 *            with the screen's current slice; the socket is then BOUND to that screen — later
 *            frames claiming another screenId are dropped. The socket's lifetime marks the screen
 *            ONLINE; `player/ack` records its observed revision.
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
  ServerToPlayerCastPin,
  ServerToPlayerRender,
  ServerToPlayerSettings,
  parseMessage,
} from "@polyptic/protocol";
import type { MtlsBundle, OperatorRole, ServerToAdminShellMessage } from "@polyptic/protocol";
import type { FastifyBaseLogger } from "fastify";
import type { IncomingMessage, Server } from "node:http";
import type { Server as HttpsServer } from "node:https";
import type { RawData } from "ws";

import { hashCredential } from "./enroll";
import type { Enrollment } from "./enroll";
import type { AuthService } from "./auth-local";
import type { PlayerAuth } from "./player-auth";
import type { CaptureCoordinator } from "./capture";
import { pendingUrlFor } from "./state";
import type { ControlPlane, RegisterMachineInput, ScreenAssignment } from "./state";
import type { AgentHub, PlayerHub } from "./hub";
import type { AdminBroadcaster, AdminHub, Presence } from "./admin";
import type { ActivityLog } from "./activity";
import { ShellRelay } from "./shell-relay";
import type { DevtoolsRelay } from "./devtools-relay";
import type { SourceHealthTracker } from "./source-health";
import { powerAckLine } from "./panel-power";
import type { PanelPowerScheduler } from "./panel-power";

interface WsDeps {
  /** The main listener the three channels' upgrades hang off — plain HTTP, or the native-TLS
   *  HTTPS server (POL-70/D89); both expose the same `upgrade` seam. */
  server: Server | HttpsServer;
  control: ControlPlane;
  enrollment: Enrollment;
  /** Local-auth service — gates the /admin upgrade on a valid session cookie (Phase 3f). */
  auth: AuthService;
  /** POL-54 — gates `player/hello` on the screen's bearer token (minted into playerUrl). */
  playerAuth: PlayerAuth;
  hub: PlayerHub;
  agentHub: AgentHub;
  adminHub: AdminHub;
  presence: Presence;
  broadcaster: AdminBroadcaster;
  /** Live Activity feed (D25) — presence emits machine + screen connect/drop lines here. */
  activity: ActivityLog;
  /** Live-preview capture (Phase 5) — ingests inbound `agent/thumbnail` frames. */
  capture: CaptureCoordinator;
  /** POL-94 — per-source content health, fed by the players' `player/surface-health` reports. */
  health: SourceHealthTracker;
  /** Remote-DevTools relay (POL-67) — bridges an operator's DevTools frontend to a wall's Chrome. */
  devtoolsRelay: DevtoolsRelay;
  /** POL-101 — panel-hours scheduler; reconciles a box's panels to their window when it says hello. */
  panelPower: PanelPowerScheduler;
  log: FastifyBaseLogger;
  /** Allowed browser origins for the /admin WS upgrade (anti-CSWSH); from CORS_ORIGIN. */
  allowedOrigins: string[];
  /** POL-25 — the mTLS agent channel; undefined when AGENT_MTLS_PORT is unset. */
  agentMtls?: AgentMtlsChannel;
}

/**
 * POL-25 — everything the agent handler needs to run the mTLS channel policy. The `server` is the
 * dedicated TLS listener (already listening, `requestCert` + `rejectUnauthorized` against the
 * deployment's own CA), so any socket that reaches its `upgrade` event has ALREADY presented a
 * valid client cert — that is the transport-layer rejection the ticket demands. This context also
 * drives cert ISSUANCE on the plain channel: an authenticated hello carrying a CSR gets it signed
 * and receives the bundle in `server/enrolled.mtls`.
 */
export interface AgentMtlsChannel {
  /** The dedicated TLS listener; serves ONLY /agent (any other path is destroyed). */
  server: HttpsServer;
  /** The deployment CA (PEM) agents pin — sent inside every issued bundle. */
  caPem: string;
  /** Sign an agent CSR into a client cert, CN forced to `machineId`. Throws on a bad CSR. */
  signCsr(csrPem: string, machineId: string): Promise<string>;
  /** What `server/enrolled.mtls` advertises: the listener port (+ optional full URL override). */
  advertise: { port: number; url?: string };
  /**
   * When true the PLAIN /agent channel never admits a machine: it authenticates, issues the cert
   * bundle, answers, and CLOSES — every live agent session must ride the mTLS listener. When false
   * (roll-out mode) the plain channel keeps admitting while the fleet picks its certs up.
   *
   * POL-134 — a FUNCTION, not a flag: the posture promotes itself to required at runtime (once
   * every known machine has been seen on the mTLS listener), so the channel policy must read the
   * live value on every hello.
   */
  required(): boolean;
  /** POL-134 — called whenever a CSR is signed, so the machine's cert state is persisted. */
  noteCertIssued?(machineId: string): void;
  /** POL-134 — called on every authenticated hello that arrived OVER the mTLS listener: records
   *  first-seen (the "wall1 now on mTLS" feed line) and re-evaluates the require promotion. */
  noteMtlsHello?(machineId: string): void;
}

/** Which listener an agent socket arrived on (POL-25). */
type AgentChannel = "plain" | "mtls";

/** The CDP WebSocket path the proxied DevTools frontend connects back on (see devtools-routes.ts):
 *  /api/v1/screens/<screenId>/devtools/<box path>. Returns null for any other path. */
export function parseDevtoolsUpgradePath(pathname: string): { screenId: string; path: string } | null {
  const m = /^\/api\/v1\/screens\/([^/]+)\/devtools(\/.+)$/.exec(pathname);
  if (!m || !m[1] || !m[2]) return null;
  let screenId: string;
  try {
    screenId = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  return { screenId, path: m[2] };
}

/**
 * POL-104 — where an agent is dialling FROM, for the pending card. A forwarded-for header wins when
 * present (behind an ingress the socket's peer is the ingress, which tells an operator nothing about
 * which box is on the other end); otherwise the socket's own peer address. Best-effort: some runtimes
 * do not populate `remoteAddress` on an upgrade at all, and an absent IP is simply omitted from the
 * card — a fact we cannot establish is never invented.
 */
function peerAddress(req: IncomingMessage): string | undefined {
  const forwarded = req.headers["x-forwarded-for"];
  const first = (Array.isArray(forwarded) ? forwarded[0] : forwarded)?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : (req.socket?.remoteAddress ?? undefined);
}

export function attachWebSockets(deps: WsDeps): ShellRelay {
  const { server, control, enrollment, auth, playerAuth, hub, agentHub, adminHub, presence, broadcaster, activity, capture, health, devtoolsRelay, panelPower, log, allowedOrigins, agentMtls } =
    deps;

  // The remote-shell relay (POL-59) bridges an operator's /admin socket to a machine's /agent socket.
  // Returned so REST (arm/disarm) can close a box's sessions the moment it is disarmed.
  const shellRelay = new ShellRelay(agentHub, control, activity, broadcaster, log);

  const agentWss = new WebSocketServer({ noServer: true });
  const playerWss = new WebSocketServer({ noServer: true });
  const adminWss = new WebSocketServer({ noServer: true });
  const devtoolsWss = new WebSocketServer({ noServer: true });

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
      // POL-104: the peer address rides along so a pending card can say where the box is dialling from.
      agentWss.handleUpgrade(req, socket, head, (ws) =>
        agentWss.emit("connection", ws, "plain", peerAddress(req)),
      );
    } else if (pathname === "/player") {
      // Device channel — players carry no user session, but they are NOT anonymous: the agent
      // launched them at a server-minted URL carrying a per-screen bearer token, echoed back in
      // `player/hello` and verified there (POL-54). The upgrade itself passes; the hello is the gate.
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
      //
      // POL-107: the socket carries the operator's ROLE from here on. EVERY role may open it (it is how
      // a viewer receives state at all — read access), but the frames that DO something (the POL-59
      // remote shell) are re-checked against that role in `handleAdmin`. With auth disabled there is no
      // session and nothing is enforced anywhere, so the socket runs as `admin` — same as /auth/me.
      if (!auth.enabled) {
        adminWss.handleUpgrade(req, socket, head, (ws) => adminWss.emit("connection", ws, "admin"));
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
          adminWss.handleUpgrade(req, socket, head, (ws) => adminWss.emit("connection", ws, user.role));
        })
        .catch((err) => {
          log.warn({ event: "admin.ws.error", err: String(err) }, "error gating /admin upgrade");
          socket.destroy();
        });
    } else if (parseDevtoolsUpgradePath(pathname)) {
      // POL-67 — the proxied DevTools frontend's CDP socket. Gated EXACTLY like /admin (origin
      // check + session cookie), with one addition: the frontend page is served from THIS server's
      // own origin (via the /api/v1 proxy), which need not be in CORS_ORIGIN — same-host origins
      // are same-site by definition, so they pass.
      const target = parseDevtoolsUpgradePath(pathname);
      if (!target) {
        socket.destroy();
        return;
      }
      const origin = req.headers.origin;
      const sameHost = origin ? origin.endsWith(`//${req.headers.host ?? ""}`) : false;
      if (origin && !sameHost && !allowedOrigins.includes(origin)) {
        log.warn({ event: "devtools.ws.badorigin", origin }, "rejected devtools upgrade — origin not allowed");
        socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        socket.destroy();
        return;
      }
      const admit = (): void => {
        devtoolsWss.handleUpgrade(req, socket, head, (ws) =>
          devtoolsRelay.openFromClient(ws, target.screenId, target.path),
        );
      };
      if (!auth.enabled) {
        admit();
        return;
      }
      void auth
        .verifyCookieHeader(req.headers.cookie)
        .then((user) => {
          if (!user) {
            log.warn({ event: "devtools.ws.rejected" }, "rejected devtools upgrade — no valid session");
            socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          // POL-107 — a live remote debugger inside a wall's browser is an ADMIN capability, and the
          // CDP socket is a second door to it: the REST `/screens/:id/devtools*` routes are admin-only
          // by the gate's deny-by-default, and this upgrade must match them or the door is unlocked.
          if (user.role !== "admin") {
            log.warn(
              { event: "devtools.ws.forbidden", userId: user.id, role: user.role },
              "rejected devtools upgrade — role is not admin",
            );
            socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
            socket.destroy();
            return;
          }
          admit();
        })
        .catch((err) => {
          log.warn({ event: "devtools.ws.error", err: String(err) }, "error gating devtools upgrade");
          socket.destroy();
        });
    } else {
      socket.destroy();
    }
  });

  agentWss.on("connection", (ws: WebSocket, channel: AgentChannel, remoteAddress?: string) =>
    handleAgent(ws, channel ?? "plain", remoteAddress, agentMtls, control, enrollment, agentHub, hub, presence, broadcaster, activity, capture, shellRelay, devtoolsRelay, panelPower, log),
  );

  // POL-25 — the mTLS agent channel: a second listener whose TLS handshake already rejected any
  // client without a cert chaining to the deployment's CA. Only /agent lives here; the handler is
  // the SAME one as the plain channel, marked `mtls` so the require-mode policy can tell them apart.
  if (agentMtls) {
    agentMtls.server.on("upgrade", (req, socket, head) => {
      let pathname: string;
      try {
        pathname = new URL(req.url ?? "/", "http://localhost").pathname;
      } catch {
        socket.destroy();
        return;
      }
      if (pathname !== "/agent") {
        socket.destroy();
        return;
      }
      agentWss.handleUpgrade(req, socket, head, (ws) =>
        agentWss.emit("connection", ws, "mtls", peerAddress(req)),
      );
    });
  }
  playerWss.on("connection", (ws: WebSocket) =>
    handlePlayer(ws, playerAuth, control, hub, presence, broadcaster, activity, health, log),
  );
  adminWss.on("connection", (ws: WebSocket, role: OperatorRole) =>
    handleAdmin(ws, role ?? "admin", adminHub, broadcaster, control, shellRelay, log),
  );

  return shellRelay;
}

function handleAgent(
  ws: WebSocket,
  channel: AgentChannel,
  /** POL-104 — the peer address this agent is dialling from (live-only: it is recorded in Presence,
   *  never persisted, because a stale IP on an offline box is a lie). */
  remoteAddress: string | undefined,
  agentMtls: AgentMtlsChannel | undefined,
  control: ControlPlane,
  enrollment: Enrollment,
  agentHub: AgentHub,
  playerHub: PlayerHub,
  presence: Presence,
  broadcaster: AdminBroadcaster,
  activity: ActivityLog,
  capture: CaptureCoordinator,
  shellRelay: ShellRelay,
  devtoolsRelay: DevtoolsRelay,
  panelPower: PanelPowerScheduler,
  log: FastifyBaseLogger,
): void {
  log.info({ event: "agent.connected", channel }, "agent socket opened");
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

  function sendEnrolled(
    targetMachineId: string,
    credential: string | undefined,
    status: "pending" | "approved",
    mtls?: MtlsBundle,
  ): void {
    const enrolled = ServerToAgentEnrolled.parse({
      t: "server/enrolled",
      machineId: targetMachineId,
      ...(credential ? { credential } : {}),
      status,
      ...(mtls ? { mtls } : {}),
    });
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(enrolled));
  }

  /** POL-46 — a pending machine keeps its WS open but has no screens, so nothing was ever shown and
   *  the wall sat BLACK (indistinguishable from a dead box). Hand the agent a player page to display
   *  on every output until an operator approves it. */
  function sendPending(reason?: string, targetMachineId?: string): void {
    const pending = ServerToAgentPending.parse({
      t: "server/pending",
      ...(reason ? { reason } : {}),
      ...(targetMachineId ? { machineId: targetMachineId } : {}),
      ...(targetMachineId ? { pendingUrl: pendingUrlFor(targetMachineId) } : {}),
    });
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
        {
          event: "agent.rejected",
          machineId: msg.machineId,
          reason,
          // POL-104 — when the token was RECOGNISED but refused (revoked/expired/used up), name it:
          // "invalid token" sends an operator hunting for a typo that isn't there.
          ...(decision.tokenId ? { tokenId: decision.tokenId, tokenName: decision.tokenName } : {}),
        },
        "agent enrollment rejected — closing socket",
      );
      ws.close();
      return;
    }

    // POL-25 — cert issuance rides the 2b seam: ANY hello that authenticated (we are past the reject
    // path, so it presented a valid token or credential — or arrived over the mTLS listener, whose
    // handshake already proved a fleet cert) gets its CSR signed. The CSR's subject is ignored; the
    // CN is forced to the machine id. A malformed CSR issues nothing and is never fatal. In OPEN
    // mode this hands a cert to any device that asks — open mode is explicitly the low-trust dev
    // default and its boot banner already owns that trade-off.
    let mtlsBundle: MtlsBundle | undefined;
    if (agentMtls && msg.csrPem) {
      try {
        const certPem = await agentMtls.signCsr(msg.csrPem, msg.machineId);
        mtlsBundle = {
          caPem: agentMtls.caPem,
          certPem,
          port: agentMtls.advertise.port,
          ...(agentMtls.advertise.url ? { url: agentMtls.advertise.url } : {}),
        };
      } catch (err) {
        log.warn(
          { event: "agent.csr.invalid", machineId: msg.machineId, err: String(err) },
          "could not sign agent CSR — no client cert issued",
        );
      }
    }

    // POL-25 require mode: the PLAIN channel exists only to authenticate + hand out cert bundles.
    // Nothing on it is admitted, marked online, or kept open past this hello's answer — every live
    // agent session must arrive through the mTLS listener.
    const issueOnly = channel === "plain" && agentMtls?.required() === true;

    // From here the connection is kept: mark presence + register the socket by machineId.
    machineId = msg.machineId;
    if (!issueOnly && !hubRegistered) {
      agentHub.add(machineId, ws);
      hubRegistered = true;
    }
    // True online edge: emit ONE "connected" line only when the machine goes 0→online (a second
    // overlapping agent socket for the same machine doesn't re-announce).
    let cameOnline = false;
    if (!issueOnly && !presenceMarked) {
      cameOnline = !presence.isMachineOnline(machineId);
      presence.agentConnected(machineId, channel);
      presenceMarked = true;
    }

    // POL-104 — the box's address, recorded live (never persisted) so a pending card can say where it
    // is dialling from. An operator commissioning a rack matches a card to a box by its IP as often as
    // by anything else.
    if (!issueOnly && remoteAddress) presence.noteMachineAddress(machineId, remoteAddress);

    const input: RegisterMachineInput = {
      machineId: msg.machineId,
      agentVersion: msg.agentVersion,
      backend: msg.backend,
      browser: msg.browser,
      // POL-101 — what this box can do about panel power, as IT reports it (dpms / cec). Re-read on
      // every hello, so a box that grows a CEC adapter (or loses one) tells the truth after a restart.
      power: msg.power,
      outputs: msg.outputs,
      hostname: msg.hostname,
      // POL-105 — the image the box BOOTED, on its very first frame: an operator watching a canary
      // reboot sees the new id land the moment the box is back, not a heartbeat later.
      imageId: msg.imageId,
      hardware: msg.hardware,
      enrolledTokenId: decision.tokenId,
      enrolledTokenName: decision.tokenName,
    };

    try {
      switch (decision.kind) {
        case "open":
        case "admit": {
          // OPEN MODE auto-approve, OR an approved machine (re)connecting. If a credential is being
          // re-issued (token re-enrol of an approved machine), persist its hash + announce it first.
          const credentialHash = decision.credential ? hashCredential(decision.credential) : undefined;
          const { changed, assignments } = await control.registerMachine(input, credentialHash);
          if (decision.credential || mtlsBundle) {
            sendEnrolled(msg.machineId, decision.credential, "approved", mtlsBundle);
          }
          if (issueOnly) {
            // POL-25 require mode: an admissible machine on the PLAIN channel gets its answer (and
            // its cert bundle, when it asked) but never a `server/apply` — it must come back through
            // the mTLS listener, where the handshake itself is the credential check the ticket wants.
            log.info(
              {
                event: "agent.mtls.issue_only",
                machineId: msg.machineId,
                decision: decision.kind,
                issuedCert: Boolean(mtlsBundle),
              },
              "mTLS required — answered on the plain channel without admitting; closing so the agent reconnects over mTLS",
            );
            ws.close();
            break;
          }
          sendApply(msg.machineId, assignments);
          // POL-101 — the box is back and its panels are LIT (the compositor asserts `dpms on` at
          // startup). If a screen is outside its panel hours right now, sleep it again; in hours,
          // this does nothing at all — a wall that should be showing content is never blanked.
          panelPower.reconcileMachine(msg.machineId);
          log.info(
            {
              event: "agent.hello",
              mode: enrollment.open ? "open" : "gated",
              channel,
              decision: decision.kind,
              reissued: Boolean(decision.credential),
              issuedCert: Boolean(mtlsBundle),
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
          // POL-104 — this box consumed one of the token's enrolments (the cap counts NEW machines; a
          // re-enrol of a box that already counted does not consume a second slot).
          if (decision.tokenId) await enrollment.recordUse(decision.tokenId);
          sendEnrolled(msg.machineId, credential, "pending", mtlsBundle);

          // POL-104 — did an operator declare this box before it ever booted? Pre-registration is
          // consulted ONLY here, AFTER the token gate: it is not a credential and admits nothing on
          // its own. It names the box, and — when the record says so — approves it, which is the
          // zero-click commissioning path (no blind pending card, no click).
          const preReg = await control.applyPreRegistration(msg.machineId, msg.hardware);
          const label = control.getMachine(msg.machineId)?.label ?? msg.machineId;
          if (preReg?.record.autoApprove && !issueOnly) {
            const approved = await control.approveMachine(msg.machineId);
            if (approved) {
              sendApply(msg.machineId, approved.assignments);
              activity.push(
                "good",
                `${label} enrolled and auto-approved (pre-registered, matched on ${preReg.matchedOn})`,
              );
              log.info(
                {
                  event: "agent.enrolled",
                  machineId: msg.machineId,
                  outputs: msg.outputs.length,
                  issuedCert: Boolean(mtlsBundle),
                  status: "approved",
                  preRegistrationId: preReg.record.id,
                  matchedOn: preReg.matchedOn,
                  tokenId: decision.tokenId,
                  screens: approved.assignments.map((a) => a.screenId),
                },
                "new machine enrolled — pre-registered, auto-approved",
              );
              break;
            }
          }

          sendPending(decision.reason, msg.machineId);
          log.info(
            {
              event: "agent.enrolled",
              machineId: msg.machineId,
              outputs: msg.outputs.length,
              issuedCert: Boolean(mtlsBundle),
              status: "pending",
              tokenId: decision.tokenId,
              tokenName: decision.tokenName,
              preRegistered: Boolean(preReg),
              ...(preReg ? { matchedOn: preReg.matchedOn } : {}),
            },
            "new machine enrolled — awaiting operator approval",
          );
          if (issueOnly) ws.close();
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
            sendEnrolled(msg.machineId, decision.credential, "pending", mtlsBundle);
          } else {
            await control.touchMachine(msg.machineId, msg.outputs);
            if (mtlsBundle) sendEnrolled(msg.machineId, undefined, "pending", mtlsBundle);
          }
          sendPending(decision.reason, msg.machineId);
          log.info(
            {
              event: "agent.pending",
              machineId: msg.machineId,
              reissued: Boolean(decision.credential),
              issuedCert: Boolean(mtlsBundle),
            },
            "agent pending — awaiting operator approval",
          );
          // POL-25 require mode: a pending machine parks on the mTLS channel, not here — close so it
          // reconnects with its fresh bundle (the pending board re-appears over the mTLS socket).
          if (issueOnly) ws.close();
          break;
        }
      }

      // POL-134 — persist the cert-issued timestamp AFTER the switch registered the machine, or a
      // first contact (machine row not yet created at signing time) would never record it.
      if (mtlsBundle) agentMtls?.noteCertIssued?.(msg.machineId);
      // POL-134 — an authenticated hello that arrived OVER the mTLS listener is proof this box
      // presents a working cert: record it (the first time narrates "now on mTLS" in the feed) and
      // let the posture re-evaluate its promotion to require.
      if (channel === "mtls") agentMtls?.noteMtlsHello?.(msg.machineId);

      // A machine came online (and possibly new screens / a status change) — refresh the admin view.
      if (cameOnline) {
        const label = control.getMachine(msg.machineId)?.label ?? msg.machineId;
        // POL-68 — closing the loop on an operator reboot reads "back online", not just "connected".
        const rebootRoundTrip = presence.consumeMachineRebooting(msg.machineId);
        activity.push("good", rebootRoundTrip ? `${label} back online` : `${label} connected`);
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
      // POL-119 — the status report doubles as the cast-session signal: `casting` is the box's own
      // account of whether its receiver owns a visible window (mirror or PIN prompt) on each
      // connector. Level-reported on every heartbeat AND immediately on change, so ingest is
      // idempotent; broadcast only on a real edge, or every heartbeat would fan out an admin/state.
      let castChanged = false;
      const screens = control.getScreens().filter((s) => s.machineId === msg.machineId);
      for (const entry of msg.screens) {
        // Pre-cast agents (no `casting`, no `castPin`) leave presence alone entirely.
        if (entry.casting === undefined && entry.castPin === undefined) continue;
        const screen = screens.find((s) => s.connector === entry.connector);
        if (!screen) continue;
        if (entry.casting !== undefined && presence.setScreenCasting(screen.id, entry.casting)) {
          castChanged = true;
          activity.push(
            "info",
            entry.casting
              ? `Casting to ${screen.friendlyName} started`
              : `Casting to ${screen.friendlyName} ended`,
          );
        }
        // POL-136 — the pairing PIN rides the same level report: on a real edge, paint (or clear)
        // the player's PIN overlay. The receiver prints the PIN to stdout only — the player overlay
        // is the ONLY thing that puts it on the glass, so an undeliverable overlay is feed-worthy:
        // the phone is asking for a code nobody can read.
        const pin = entry.castPin ?? null;
        if (presence.setScreenCastPin(screen.id, pin)) {
          castChanged = true;
          const overlay = ServerToPlayerCastPin.parse({ t: "server/cast-pin", pin });
          const delivered = playerHub.send(screen.id, overlay);
          // The PIN itself NEVER enters the feed: activity rides every admin/state snapshot (and
          // lingers in the ring long after pairing), so a code there would leak proof-of-physical-
          // presence to anyone who can see the console. The feed says what an operator can act on;
          // the PIN travels only the gated per-screen player channel and the box's own journal.
          if (pin !== null) {
            activity.push(
              delivered > 0 ? "info" : "bad",
              delivered > 0
                ? `AirPlay pairing on ${screen.friendlyName} — the PIN is on the panel`
                : `AirPlay pairing on ${screen.friendlyName} — NO player is connected to display the PIN (read it in the box's agent journal)`,
            );
          }
          log.info(
            { event: "cast.pin", screenId: screen.id, pairing: pin !== null, delivered },
            pin !== null ? "cast pairing PIN pushed to player" : "cast pairing PIN cleared",
          );
        }
      }
      if (castChanged) broadcaster.broadcast();

      // POL-92 — the heartbeat now carries the box's own vitals. Ring them in Presence (live-only,
      // never persisted) and broadcast, so the Machines view's stats strip is as live as the
      // heartbeat. A pre-POL-92 agent sends no `vitals`; the heartbeat is still recorded, so the box
      // has a last-seen for `polyptic_machine_last_seen_seconds` either way.
      const hadVitals = presence.machineVitals(msg.machineId) !== undefined;
      presence.noteHeartbeat(msg.machineId, msg.vitals);
      // POL-105 — the heartbeat also carries the box's booted image id. Persist it (and announce a
      // CHANGE) so the version distribution survives the box going offline. `hello` already reported
      // it; this keeps a long-lived session honest and covers an agent that heartbeats but never
      // re-hellos. Unchanged ids are silent — this arrives every few seconds.
      // Fire-and-forget like the hello path: a heartbeat is not a request/response, and a store blip
      // must never take the status frame (or the socket) down.
      if (msg.vitals?.imageId) {
        const reported = msg.vitals.imageId;
        void control
          .noteMachineImage(msg.machineId, reported)
          .then((changed) => {
            if (changed) broadcaster.broadcast();
          })
          .catch((err: unknown) => {
            log.warn(
              { event: "image.report.error", machineId: msg.machineId, err: String(err) },
              "could not record the image id this box reported",
            );
          });
      }
      // Coalesced downstream; the first sample matters most (it fills an empty strip).
      if (msg.vitals || hadVitals) broadcaster.broadcast();
      log.info(
        {
          event: "agent.status",
          machineId: msg.machineId,
          observedRevision: msg.observedRevision,
          cpu: msg.vitals?.cpuPercent,
          mem: msg.vitals?.memPercent,
          gpuAccel: msg.vitals?.browsers?.some((b) => b.gpuAccel === true),
        },
        "agent status",
      );
    } else if (msg.t === "agent/reboot-ack") {
      // POL-55 — the box's answer to `server/reboot`, sent just before it goes down. An ACCEPTED
      // reboot needs no feed line: the socket close that follows already emits "went unreachable",
      // then "connected" when it comes back. A REFUSAL is the interesting case — the box is still up
      // and the operator's click did nothing, so say so, and say why.
      const label = control.getMachine(msg.machineId)?.label ?? msg.machineId;
      if (!msg.accepted) {
        activity.push("bad", `${label} refused to reboot: ${msg.reason ?? "no reason given"}`);
        // Nothing else will broadcast: the box stayed up, so no presence edge follows.
        broadcaster.broadcast();
      } else {
        // POL-68 — the box goes dark ON PURPOSE a moment later: mark the reboot in flight so the
        // console can show "rebooting…" instead of a bare Offline until it dials back in.
        presence.setMachineRebooting(msg.machineId);
        broadcaster.broadcast();
      }
      log.info(
        { event: "agent.reboot_ack", machineId: msg.machineId, accepted: msg.accepted, reason: msg.reason },
        msg.accepted ? "agent accepted reboot" : "agent refused reboot",
      );
    } else if (msg.t === "agent/shell-opened") {
      shellRelay.openedFromAgent(msg.machineId, msg.sessionId, msg.ok, msg.reason);
    } else if (msg.t === "agent/shell-data") {
      shellRelay.dataFromAgent(msg.machineId, msg.sessionId, msg.dataBase64);
    } else if (msg.t === "agent/shell-closed") {
      shellRelay.closedFromAgent(msg.machineId, msg.sessionId, msg.reason);
    } else if (msg.t === "agent/devtools-response") {
      devtoolsRelay.responseFromAgent(msg.machineId, msg.reqId, msg.ok, msg.status, msg.contentType, msg.bodyBase64, msg.error);
    } else if (msg.t === "agent/devtools-opened") {
      devtoolsRelay.openedFromAgent(msg.machineId, msg.sessionId, msg.ok, msg.reason);
    } else if (msg.t === "agent/devtools-data") {
      devtoolsRelay.dataFromAgent(msg.machineId, msg.sessionId, msg.dataBase64);
    } else if (msg.t === "agent/devtools-closed") {
      devtoolsRelay.closedFromAgent(msg.machineId, msg.sessionId, msg.reason);
    } else if (msg.t === "agent/power-ack") {
      // POL-101 — the box's answer to `server/display-power`, and the ONLY writer of `asleep`. The
      // operator's click is a request; only the box knows whether the compositor took the DPMS command
      // and whether the CEC bus answered. A refusal therefore leaves the screen AWAKE in the console:
      // never show a wall as dark when it might still be lit.
      const screen = control
        .getScreens()
        .find((s) => s.machineId === msg.machineId && s.connector === msg.connector);
      if (screen) {
        presence.setScreenAsleep(screen.id, msg.ok && !msg.on, msg.methods);
        presence.setScreenPowerError(screen.id, msg.ok ? null : (msg.reason ?? "the box did not say why"));
        if (!msg.ok) {
          activity.push(
            "bad",
            `Could not ${msg.on ? "wake" : "sleep"} ${screen.friendlyName}: ${msg.reason ?? "no reason given"}`,
          );
        } else {
          // "info", not "warn": a sleeping panel is a HEALTHY panel doing what it was told. The feed
          // must not train an operator to read a scheduled sleep as a fault.
          activity.push("info", powerAckLine(screen.friendlyName, msg.on, msg.methods));
        }
        broadcaster.broadcast();
      }
      log.info(
        {
          event: "agent.power_ack",
          machineId: msg.machineId,
          connector: msg.connector,
          screenId: screen?.id,
          on: msg.on,
          ok: msg.ok,
          methods: msg.methods,
          reason: msg.reason,
        },
        msg.ok ? "agent applied panel power" : "agent could not apply panel power",
      );
    } else if (msg.t === "agent/inspect-ack") {
      // POL-50 — the box's answer to `server/inspect`, and the ONLY writer of the `inspecting` flag:
      // the operator's click is a request, but only the wall knows whether surf relaunched and took
      // the keystroke. A refusal therefore CLEARS the flag rather than setting it, so the console can
      // never claim an inspector that isn't on the panel.
      const screen = control
        .getScreens()
        .find((s) => s.machineId === msg.machineId && s.connector === msg.connector);
      if (screen) {
        presence.setScreenInspecting(screen.id, msg.ok && msg.on);
        // A refusal leaves `inspecting` false — unchanged — so the reason is what tells the console
        // anything happened at all. Without it the operator's button spins until it times out.
        presence.setScreenInspectError(
          screen.id,
          msg.ok ? null : (msg.reason ?? "the box did not say why"),
        );
        if (!msg.ok) {
          activity.push(
            "bad",
            `Could not open the inspector on ${screen.friendlyName}: ${msg.reason ?? "no reason given"}`,
          );
        } else {
          activity.push(
            "info",
            msg.on
              ? `Inspector open on ${screen.friendlyName} — read it at the screen`
              : `Inspector closed on ${screen.friendlyName}`,
          );
        }
        broadcaster.broadcast();
      }
      log.info(
        {
          event: "agent.inspect_ack",
          machineId: msg.machineId,
          connector: msg.connector,
          screenId: screen?.id,
          on: msg.on,
          ok: msg.ok,
          reason: msg.reason,
        },
        msg.ok ? "agent applied inspector state" : "agent could not apply inspector state",
      );
    } else {
      // agent/thumbnail — the frame is already AgentMessage-validated; hand it to the coordinator,
      // which resolves connector→screenId, decodes the payload and stores the latest preview (Phase 5).
      capture.ingest(msg);
    }
  });

  ws.on("close", (code) => {
    if (machineId) shellRelay.agentDisconnected(machineId);
    if (machineId) devtoolsRelay.agentDisconnected(machineId);
    if (machineId && hubRegistered) agentHub.remove(machineId, ws);
    if (machineId && presenceMarked) {
      // Resolve the machine BEFORE dropping presence; emit only on the true online→offline edge — and
      // NOT when the machine was just REMOVED (its socket close is expected; removal already logged it,
      // and it no longer resolves to a friendly label).
      const machine = control.getMachine(machineId);
      presence.agentDisconnected(machineId);
      if (machine && !presence.isMachineOnline(machineId)) {
        // An operator-requested reboot drops the socket ON PURPOSE — the feed already says
        // "Rebooting X", so a scary "went unreachable" here would be noise (POL-68).
        if (!presence.isMachineRebooting(machineId)) {
          activity.push("bad", `${machine.label} went unreachable`);
        }
        // POL-50 — the box is gone, so its panels are no longer showing an inspector. Drop the flag,
        // or a reboot-while-inspecting leaves the console badging a wall that came back sealed.
        const droppedScreens = control.getScreens().filter((s) => s.machineId === machineId);
        // POL-136 — a pairing died with the box's receiver: clear any PIN overlay its players still
        // show (the player has its own timeout backstop, but there is no reason to wait for it).
        for (const s of droppedScreens) {
          if (presence.screenCastPin(s.id) !== null) {
            playerHub.send(s.id, ServerToPlayerCastPin.parse({ t: "server/cast-pin", pin: null }));
          }
        }
        const screenIds = droppedScreens.map((s) => s.id);
        presence.clearScreensInspecting(screenIds);
        // POL-101 — likewise the power state: a box that comes back comes back LIT, so a remembered
        // "asleep" would strand the console showing a dark wall that is actually showing content. The
        // scheduler re-sleeps it on hello if it is still outside its hours.
        presence.clearScreensPower(screenIds);
      }
      broadcaster.broadcast();
    }
    log.info({ event: "agent.disconnected", machineId, code }, "agent socket closed");
  });
  ws.on("error", (err) =>
    log.warn({ event: "agent.error", machineId, err: String(err) }, "agent socket error"),
  );
}

/** POL-54 — app-level close codes on the /player channel (4000–4999 are free for applications).
 *  The player's reconnect loop treats any close the same way (backoff + retry), so a wall whose
 *  token becomes valid (agent relaunch after a secret rotation) self-heals with no special casing. */
export const PLAYER_CLOSE_UNAUTHORIZED = 4401;
export const PLAYER_CLOSE_PROTOCOL = 4400;

function handlePlayer(
  ws: WebSocket,
  playerAuth: PlayerAuth,
  control: ControlPlane,
  hub: PlayerHub,
  presence: Presence,
  broadcaster: AdminBroadcaster,
  activity: ActivityLog,
  health: SourceHealthTracker,
  log: FastifyBaseLogger,
): void {
  log.info({ event: "player.connected" }, "player socket opened");
  /** Set ONLY by an admitted hello — the screen this socket is bound to. Frames claiming any other
   *  screenId (spoofed acks/diag, a second hello for a different screen) never reach the registry. */
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
      // A socket is bound to ONE screen for its lifetime — a re-hello for another screen is a
      // protocol violation (and would let one authorized token register extra screens).
      if (screenId !== null && screenId !== msg.screenId) {
        log.warn(
          { event: "player.hello.rebind", boundScreenId: screenId, claimedScreenId: msg.screenId },
          "player tried to re-hello as a different screen — closing",
        );
        ws.close(PLAYER_CLOSE_PROTOCOL, "socket already bound to a screen");
        return;
      }
      // POL-54 — THE GATE. Enforced whenever auth is enabled (the same switch as REST + /admin):
      // the hello must carry the exact token the server minted into this screen's playerUrl. A miss
      // is closed and NEVER registered — no render, no presence, no activity line, no enumeration
      // signal beyond the close itself. The token itself is never logged.
      if (playerAuth.required && !playerAuth.verify(msg.screenId, msg.token)) {
        log.warn(
          { event: "player.hello.unauthorized", screenId: msg.screenId, hadToken: Boolean(msg.token) },
          "rejected player hello — missing or invalid player token",
        );
        ws.close(PLAYER_CLOSE_UNAUTHORIZED, "invalid or missing player token");
        return;
      }
      screenId = msg.screenId;
      // True online edge: this socket takes the screen from 0→online (no player was connected before).
      const cameOnline = hub.count(screenId) === 0;
      hub.add(screenId, ws);
      if (cameOnline) {
        const name = control.getScreen(screenId)?.friendlyName ?? screenId;
        activity.push("good", `${name} connected`);
      }
      // POL-24: stamp the current auth token into web/dashboard URLs at SEND time — a reconnecting or
      // cold-booting screen always loads with a live token (the stored slice keeps the clean url).
      const slice = control.decorateSliceForSend(control.sliceForPlayer(screenId));
      const render = ServerToPlayerRender.parse({
        t: "server/render",
        revision: control.state.revision,
        // Stamp the current friendly name so the player labels itself with it, not the raw id (POL-29).
        friendlyName: control.getScreen(screenId)?.friendlyName ?? screenId,
        // POL-119: stamp the cast toggle the same way, for the badge's cast glyph.
        castEnabled: control.getScreen(screenId)?.castEnabled ?? false,
        slice,
      });
      ws.send(JSON.stringify(render));
      // POL-6 — hand the player the current fleet-wide display settings (badge visibility) right after
      // its first render, so a freshly-connected screen honours the global toggle without waiting for
      // the next operator change.
      const settings = ServerToPlayerSettings.parse({
        t: "server/settings",
        settings: control.getDisplaySettings(),
      });
      ws.send(JSON.stringify(settings));
      // POL-136 — replay an in-flight pairing PIN: a player that (re)connects mid-pairing (cold
      // boot, network blip) must still show the code the phone is asking for. Level-held in
      // Presence from the agent's status reports, so this needs no extra round trip.
      const castPin = presence.screenCastPin(screenId);
      if (castPin !== null) {
        ws.send(JSON.stringify(ServerToPlayerCastPin.parse({ t: "server/cast-pin", pin: castPin })));
      }
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
    } else if (screenId === null || msg.screenId !== screenId) {
      // POL-54 — everything after hello is scoped to the BOUND screen. A frame before any admitted
      // hello, or one claiming a different screenId, is dropped: an authorized player for screen A
      // must not be able to write screen B's observed revision or speak in B's name in the log.
      log.warn(
        { event: "player.frame.unbound", boundScreenId: screenId, claimedScreenId: msg.screenId, t: msg.t },
        "dropped player frame — no admitted hello for that screen on this socket",
      );
    } else if (msg.t === "player/diag") {
      // POL-86: the player's own account of what happened on the glass — probe failures, aborted
      // loads, heals — with the box's timestamps. This line in the pod log is how a broken boot is
      // diagnosed without SSH or DevTools. The player rate-caps itself; we just record it.
      log.info(
        { event: "player.diag", screenId, playerAt: msg.at },
        `player diag: ${msg.msg}`,
      );
    } else if (msg.t === "player/surface-health") {
      // POL-94: the box's verdict on a surface's URL — the POL-86 prober's knowledge, addressed by
      // library source instead of buried in the diag trail. Sent only on a state CHANGE (and re-sent
      // on reconnect, since a dropped screen is forgotten below), so this path is cheap by design.
      // An ad-hoc URL carries no sourceId: there is no library entry to attribute it to, so we log
      // it and stop — the console's badge is a LIBRARY badge.
      log.info(
        {
          event: "player.surface-health",
          screenId,
          surfaceId: msg.surfaceId,
          sourceId: msg.sourceId,
          state: msg.state,
          url: msg.url, // redacted player-side (origin + path) — never a stamped token
          playerAt: msg.at,
        },
        `player surface health: ${msg.sourceId ?? "ad-hoc"} is ${msg.state}${msg.detail ? ` (${msg.detail})` : ""}`,
      );
      if (msg.sourceId && control.getContentSource(msg.sourceId)) {
        health.record({
          screenId,
          surfaceId: msg.surfaceId,
          sourceId: msg.sourceId,
          state: msg.state,
          at: msg.at,
          ...(msg.detail ? { detail: msg.detail } : {}),
        });
        broadcaster.broadcast();
      }
    } else {
      // player/ack — record the revision this screen has observed.
      presence.setScreenObservedRevision(screenId, msg.revision);
      log.debug(
        { event: "player.ack", screenId, revision: msg.revision },
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
        // POL-94 — an offline screen knows nothing about a URL's reachability. Forget what it told
        // us, or a source stays red forever on the word of a box that has been unplugged for a week.
        health.forgetScreen(screenId);
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
  /** The role of the operator who opened this socket (POL-107) — fixed for its lifetime. */
  role: OperatorRole,
  adminHub: AdminHub,
  broadcaster: AdminBroadcaster,
  control: ControlPlane,
  shellRelay: ShellRelay,
  log: FastifyBaseLogger,
): void {
  adminHub.add(ws);
  log.info({ event: "admin.connected", role, admins: adminHub.count() }, "admin socket opened");

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
      return;
    }

    // POL-107 — every remaining frame is a SHELL frame: a root PTY on a wall box. That is the single
    // most powerful thing this socket can do, so it is ADMIN-only, enforced here rather than in the
    // console. A non-admin that forges the frame is told the session was refused (the same shape the
    // relay uses when a box isn't armed) and nothing is relayed to the machine.
    if (role !== "admin") {
      log.warn(
        { event: "admin.shell.forbidden", role, frame: msg.t },
        "refused a shell frame — role is not admin",
      );
      if (msg.t === "admin/shell-open" && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            t: "server/shell-opened",
            machineId: msg.machineId,
            sessionId: "refused",
            ok: false,
            reason: "your role may not open a console on a machine",
          } satisfies ServerToAdminShellMessage),
        );
      }
      return;
    }

    if (msg.t === "admin/shell-open") {
      // POL-59: the operator opened a terminal on a box. The relay enforces armed + approved + online.
      shellRelay.openFromAdmin(ws, msg.machineId, msg.cols, msg.rows);
    } else if (msg.t === "admin/shell-data") {
      shellRelay.dataFromAdmin(ws, msg.machineId, msg.sessionId, msg.dataBase64);
    } else if (msg.t === "admin/shell-resize") {
      shellRelay.resizeFromAdmin(ws, msg.machineId, msg.sessionId, msg.cols, msg.rows);
    } else if (msg.t === "admin/shell-close") {
      shellRelay.closeFromAdmin(ws, msg.machineId, msg.sessionId);
    }
  });

  ws.on("close", (code) => {
    shellRelay.adminDisconnected(ws);
    adminHub.remove(ws);
    log.info({ event: "admin.disconnected", code, admins: adminHub.count() }, "admin socket closed");
  });
  ws.on("error", (err) =>
    log.warn({ event: "admin.error", err: String(err) }, "admin socket error"),
  );
}
