/**
 * REST surface of the control plane. Every body/param is parsed with the protocol's zod schemas
 * (or zod built from them) at the edge. A content mutation bumps the revision, persists through the
 * Store, and immediately pushes a `server/render` to the affected screen's player socket(s) — the
 * instant path. Registry mutations (rename) and content mutations also trigger a coalesced
 * `admin/state` broadcast so the Admin UI stays live.
 *
 * Phase 2a routes (all alongside the unchanged Phase 1 routes):
 *   GET  /api/v1/machines                     -> Machine[]
 *   POST /api/v1/screens/:screenId/rename     -> rename + persist + broadcast; 404 unknown
 *   POST /api/v1/screens/:screenId/ident      -> server/ident-pulse to that screen; 404 unknown
 *   POST /api/v1/machines/:machineId/ident    -> ident every screen on a machine; 404 unknown
 *
 * Phase 2b operator routes (enrollment):
 *   POST /api/v1/machines/:machineId/approve  -> pending→approved; create screens; live server/apply
 *                                                if the agent is connected; broadcast; 404 unknown
 *   POST /api/v1/machines/:machineId/reject   -> status→rejected; server/rejected + close if connected;
 *                                                broadcast; optional body {reason?}; 404 unknown
 *
 * POL-55 operator route:
 *   POST /api/v1/machines/:machineId/reboot   -> server/reboot to a connected, approved agent;
 *                                                404 unknown; 409 not-approved or offline
 *
 * POL-50 operator route:
 *   POST /api/v1/screens/:screenId/inspect    -> server/inspect: pop the kiosk browser's Web Inspector
 *                                                ON that panel; 202 delivered (the agent's ack decides
 *                                                the outcome), 404 unknown, 409 not-approved or offline
 */
import { z } from "zod";

import type { ShellRelay } from "./shell-relay";
import type { DevtoolsRelay } from "./devtools-relay";

import {
  CombineScreensBody,
  CreateContentSourceBody,
  CreateCredentialProfileBody,
  CreateMuralBody,
  CreateSceneBody,
  IdentBody,
  InspectBody,
  OverlayScope,
  PlaceScreenBody,
  RebootBody,
  ShellArmBody,
  RenameMuralBody,
  RenameScreenBody,
  RenameVideoWallBody,
  ServerToAgentApply,
  ServerToAgentInspect,
  ServerToAgentReboot,
  ServerToAgentRejected,
  ServerToPlayerIdent,
  ServerToPlayerRender,
  ServerToPlayerSettings,
  SetContentBody,
  SetOverlayBody,
  SetZoomBody,
  Surface,
  UpdateContentSourceBody,
  UpdateCredentialProfileBody,
  UpdateDisplaySettingsBody,
  UpdateSceneBody,
} from "@polyptic/protocol";
import type { FastifyInstance } from "fastify";
import type { Screen, ScreenSlice } from "@polyptic/protocol";

import { MediaTooLargeError, isFileTooLargeError, kindForMime, readField } from "./media";

import type { ActivityLog } from "./activity";
import type { CaptureCoordinator } from "./capture";
import type { ControlPlane } from "./state";
import type { AgentHub, PlayerHub } from "./hub";
import type { AdminBroadcaster, Presence } from "./admin";
import type { MediaStore } from "./media";
import type { TokenService } from "./tokens";

/** Phase 7 — where uploaded media lands + how its serve URL is built. Wired from env in index.ts. */
export interface MediaConfig {
  /** Absolute public base for the serve route, e.g. http://host:8080 → url `${publicBase}/media/<id>`. */
  publicBase: string;
  /** Byte cap enforced on an upload (mirrors the multipart fileSize limit). */
  maxBytes: number;
}

const ScreenParams = z.object({ screenId: z.string().min(1) });
const MachineParams = z.object({ machineId: z.string().min(1) });
const MuralParams = z.object({ id: z.string().min(1) });
const MuralIdParams = z.object({ muralId: z.string().min(1) });
const WallParams = z.object({ wallId: z.string().min(1) });
const ContentSourceParams = z.object({ id: z.string().min(1) });

/** A plain sentence for each playlist authoring error (POL-34), shown to the operator verbatim. */
function playlistItemErrorDetail(
  error: "unknown-item-source" | "nested-playlist" | "item-needs-duration",
  itemSourceId?: string,
): string {
  switch (error) {
    case "unknown-item-source":
      return `playlist item references an unknown source: ${itemSourceId}`;
    case "nested-playlist":
      return `a playlist cannot contain another playlist (${itemSourceId})`;
    case "item-needs-duration":
      return `playlist items that are not videos need a duration (${itemSourceId})`;
  }
}
const CredentialProfileParams = z.object({ id: z.string().min(1) });
/** POL-97 — DELETE /api/v1/overlays/:scope[/:targetId]; the fleet scope carries no target. */
const OverlayParams = z.object({
  scope: OverlayScope,
  targetId: z.string().min(1).optional(),
});
const SceneParams = z.object({ id: z.string().min(1) });
const SurfacesBody = z.object({ surfaces: z.array(Surface) });
const DemoWebBody = z.object({ screenId: z.string().min(1), url: z.string().url() });
const RejectBody = z.object({ reason: z.string().optional() });

export function registerRestRoutes(
  fastify: FastifyInstance,
  control: ControlPlane,
  hub: PlayerHub,
  agentHub: AgentHub,
  broadcaster: AdminBroadcaster,
  capture: CaptureCoordinator,
  media: MediaStore,
  mediaConfig: MediaConfig,
  tokens: TokenService,
  activity: ActivityLog,
  presence: Presence,
  shellRelay: ShellRelay,
  devtoolsRelay: DevtoolsRelay,
): void {
  function pushRender(screenId: string, slice: ScreenSlice): number {
    const message = ServerToPlayerRender.parse({
      t: "server/render",
      revision: control.state.revision,
      // Stamp the screen's current friendly name so the player labels itself with it, not the raw id.
      friendlyName: control.getScreen(screenId)?.friendlyName ?? screenId,
      // POL-24: stamp the current auth token into web/dashboard URLs at SEND time (stored slices keep
      // the clean url, so the DB never holds a token and every load gets a live one).
      slice: control.decorateSliceForSend(slice),
    });
    const delivered = hub.send(screenId, message);
    fastify.log.info(
      {
        event: "render.push",
        screenId,
        revision: control.state.revision,
        surfaces: slice.surfaces.length,
        delivered,
      },
      "pushed render to player(s)",
    );
    return delivered;
  }

  /** Fan the current fleet-wide display settings out to EVERY connected player (POL-6). */
  function broadcastDisplaySettings(): number {
    const message = ServerToPlayerSettings.parse({
      t: "server/settings",
      settings: control.getDisplaySettings(),
    });
    const delivered = hub.broadcastAll(message);
    fastify.log.info(
      { event: "settings.broadcast", showBadges: message.settings.showBadges, delivered },
      "broadcast display settings to player(s)",
    );
    return delivered;
  }

  /** Flash (or clear) a screen's friendly name on its player overlay. Returns sockets delivered. */
  function sendIdentPulse(screen: Screen, on: boolean): number {
    const pulse = ServerToPlayerIdent.parse({
      t: "server/ident-pulse",
      on,
      friendlyName: screen.friendlyName,
      // color omitted → schema default "#00c2ff" fills it, so the wire frame carries {on, friendlyName, color}.
    });
    const delivered = hub.send(screen.id, pulse);
    fastify.log.info(
      { event: "ident.pulse", screenId: screen.id, friendlyName: screen.friendlyName, on, delivered },
      "pushed ident pulse to player(s)",
    );
    return delivered;
  }

  /** Schedule the auto-off pulse after ttlMs (re-resolving the screen so a rename mid-window is honoured). */
  function scheduleIdentOff(screenId: string, ttlMs: number): void {
    setTimeout(() => {
      const screen = control.getScreen(screenId);
      if (screen) sendIdentPulse(screen, false);
    }, ttlMs);
  }

  // ── Phase 1 routes (unchanged behaviour) ────────────────────────────────────

  // GET /api/v1/state -> DesiredState
  fastify.get("/api/v1/state", async () => control.state);

  // GET /api/v1/screens -> Screen[]
  fastify.get("/api/v1/screens", async () => control.getScreens());

  // ── Phase 5 — live preview ──────────────────────────────────────────────────

  // GET /api/v1/screens/:screenId/thumbnail
  //   200 image/* with the latest captured bytes (Cache-Control: no-store), or 204 if none yet.
  //   Gated (operator-only) — it lives under /api/v1. A 404 distinguishes an unknown screen from a
  //   known screen with no capture yet (204).
  fastify.get("/api/v1/screens/:screenId/thumbnail", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const screen = control.getScreen(params.data.screenId);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }
    const thumb = capture.thumbnails.get(params.data.screenId);
    reply.header("Cache-Control", "no-store");
    if (!thumb) {
      // No preview captured yet — 204 lets the console show a placeholder without erroring.
      return reply.code(204).send();
    }
    reply.header("X-Captured-At", thumb.takenAt);
    // Don't reflect an agent-supplied mime verbatim — whitelist to known image types and forbid
    // content-type sniffing, so a hostile/garbled capture can't be served as something executable.
    const safeMime = /^image\/(jpeg|png|webp|avif)$/.test(thumb.mime)
      ? thumb.mime
      : "application/octet-stream";
    reply.header("X-Content-Type-Options", "nosniff");
    reply.type(safeMime);
    return reply.send(thumb.bytes);
  });

  // POST /api/v1/screens/:screenId/capture
  //   Force an on-demand refresh: ask the screen's machine to re-capture that output now. 404 unknown.
  //   Returns { ok, requested } — `requested` is the number of agent sockets the request reached
  //   (0 means the machine's agent is offline; the next sweep / reconnect will refresh).
  fastify.post("/api/v1/screens/:screenId/capture", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const screen = control.getScreen(params.data.screenId);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }
    const requested = capture.captureNow(screen.machineId, screen.connector);
    fastify.log.info(
      { event: "capture.ondemand", screenId: screen.id, machineId: screen.machineId, requested },
      "requested on-demand capture",
    );
    return reply.send({ ok: true, requested });
  });

  // POST /api/v1/screens/:screenId/surfaces  { surfaces: Surface[] }
  fastify.post("/api/v1/screens/:screenId/surfaces", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SurfacesBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const slice = await control.setScreenSurfaces(params.data.screenId, body.data.surfaces);
    if (!slice) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    fastify.log.info(
      {
        event: "revision.bump",
        reason: "surfaces",
        screenId: params.data.screenId,
        surfaces: slice.surfaces.length,
        revision: control.state.revision,
      },
      "revision bumped",
    );
    pushRender(params.data.screenId, slice);
    broadcaster.broadcast(); // surfaceCount changed
    return { ok: true, revision: control.state.revision, slice };
  });

  // POST /api/v1/demo/web  { screenId, url }  -> single full-canvas web surface
  fastify.post("/api/v1/demo/web", async (request, reply) => {
    const body = DemoWebBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const slice = await control.setDemoWeb(body.data.screenId, body.data.url);
    if (!slice) {
      return reply.code(404).send({ error: `unknown screen: ${body.data.screenId}` });
    }

    fastify.log.info(
      {
        event: "revision.bump",
        reason: "demo/web",
        screenId: body.data.screenId,
        url: body.data.url,
        revision: control.state.revision,
      },
      "revision bumped",
    );
    pushRender(body.data.screenId, slice);
    broadcaster.broadcast(); // surfaceCount changed
    return { ok: true, revision: control.state.revision, slice };
  });

  // ── Phase 2a routes ─────────────────────────────────────────────────────────

  // GET /api/v1/machines -> Machine[]
  fastify.get("/api/v1/machines", async () => control.getMachines());

  // POST /api/v1/screens/:screenId/rename  { friendlyName }
  fastify.post("/api/v1/screens/:screenId/rename", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = RenameScreenBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const screen = await control.renameScreen(params.data.screenId, body.data.friendlyName);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    // Re-push the screen's current slice so its player relabels its idle splash / badge live (POL-29).
    // renameScreen deliberately does NOT bump the revision (the name isn't render data), so this
    // re-sends the SAME revision with the new name — an instant relabel, no reload, no "behind" ack.
    pushRender(screen.id, control.sliceForPlayer(screen.id));

    fastify.log.info(
      { event: "screen.rename", screenId: screen.id, friendlyName: screen.friendlyName },
      "screen renamed",
    );
    broadcaster.broadcast();
    return { ok: true, screen };
  });

  // POST /api/v1/screens/:screenId/ident  { on, ttlMs? }
  fastify.post("/api/v1/screens/:screenId/ident", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = IdentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const screen = control.getScreen(params.data.screenId);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    const delivered = sendIdentPulse(screen, body.data.on);
    if (body.data.on && body.data.ttlMs) {
      scheduleIdentOff(screen.id, body.data.ttlMs);
    }
    return { ok: true, screenId: screen.id, on: body.data.on, delivered };
  });

  // POST /api/v1/machines/:machineId/ident  { on, ttlMs? }  -> ident every screen on the machine
  fastify.post("/api/v1/machines/:machineId/ident", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = IdentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const machine = control.getMachine(params.data.machineId);
    if (!machine) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }

    const screens = control.getScreens().filter((s) => s.machineId === machine.id);
    let delivered = 0;
    for (const screen of screens) {
      delivered += sendIdentPulse(screen, body.data.on);
      if (body.data.on && body.data.ttlMs) {
        scheduleIdentOff(screen.id, body.data.ttlMs);
      }
    }
    return {
      ok: true,
      machineId: machine.id,
      on: body.data.on,
      screens: screens.map((s) => s.id),
      delivered,
    };
  });

  // POST /api/v1/machines/:machineId/reboot  { reason? }  -> power-cycle one wedged box (POL-55)
  //
  // The fleet-wide image roll-out already reboots stale boxes, but each box decides that for itself by
  // polling the manifest. This is the opposite direction and the reason it needs its own route: a box
  // that has wedged (compositor dead, browser hung) still holds a live agent socket, so the control
  // plane can reach it even though nothing on the wall has moved for an hour.
  //
  // 409 rather than 202 when the agent is not connected: a reboot that was never delivered must not
  // look like one that was. The agent answers `agent/reboot-ack` (handled in ws.ts) — which is where
  // a REFUSAL (dev backend, no privileged helper) surfaces, since only the box knows that.
  fastify.post("/api/v1/machines/:machineId/reboot", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = RebootBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const machine = control.getMachine(params.data.machineId);
    if (!machine) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }
    if (machine.status !== "approved") {
      return reply
        .code(409)
        .send({ error: `machine ${machine.id} is ${machine.status}, not approved — cannot reboot it` });
    }

    const reason = body.data.reason?.trim() || "requested by an operator from the console";
    const delivered = agentHub.send(
      machine.id,
      ServerToAgentReboot.parse({ t: "server/reboot", reason }),
    );
    if (delivered === 0) {
      return reply.code(409).send({ error: `machine ${machine.id} is offline — nothing to reboot` });
    }

    // The feed only reaches the console folded into an admin/state, and a reboot mutates no state that
    // would otherwise trigger one — so broadcast, or the operator's click leaves no trace until the
    // box drops off the network seconds later.
    activity.push("accent", `Rebooting ${machine.label}`);
    broadcaster.broadcast();
    fastify.log.info(
      { event: "machine.reboot", machineId: machine.id, reason, delivered },
      "pushed reboot to agent",
    );
    return { ok: true, machineId: machine.id, delivered };
  });

  // POST /api/v1/machines/:machineId/shell  { enabled }  -> arm/disarm the remote shell (POL-59)
  //
  // GATED (under /api/v1). Arming lets an operator open a terminal on the box over the agent WS;
  // it is OFF by default per box so a console compromise can't silently reach a shell on the fleet.
  // Disarming immediately closes any live session (the relay also re-checks armed on every byte).
  fastify.post("/api/v1/machines/:machineId/shell", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    const body = ShellArmBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "invalid body", issues: body.error.issues });

    const machine = await control.setShellEnabled(params.data.machineId, body.data.enabled);
    if (!machine) return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });

    // Disarming must not leave a terminal open on a box the operator just locked down.
    if (!body.data.enabled) shellRelay.closeMachineSessions(machine.id, "console disabled");

    broadcaster.broadcast();
    fastify.log.info(
      { event: "machine.shell", machineId: machine.id, enabled: body.data.enabled },
      body.data.enabled ? "remote shell armed" : "remote shell disarmed",
    );
    return { ok: true, machineId: machine.id, shellEnabled: machine.shellEnabled ?? false };
  });

  // POST /api/v1/screens/:screenId/inspect  { on }  -> pop the Web Inspector ON that panel (POL-50)
  //
  // Not a remote dev-tools tunnel, because there is nothing to tunnel: surf (WebKitGTK, D63) exposes
  // no browser-openable remote inspector. So the operator asks from here and someone at the wall
  // reads the console/network. Honouring it RELAUNCHES that output's browser (surf takes `-N` only at
  // launch), so the page reloads — which is also what makes a failing page load observable at all.
  //
  // 202, not 200: the request has been delivered, not applied. The agent's `agent/inspect-ack` (ws.ts)
  // is what sets the screen's `inspecting` flag, because only the box knows whether surf came back and
  // took the keystroke. A REFUSAL surfaces there too, in the activity feed.
  fastify.post("/api/v1/screens/:screenId/inspect", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = InspectBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const screen = control.getScreen(params.data.screenId);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }
    const machine = control.getMachine(screen.machineId);
    if (!machine || machine.status !== "approved") {
      return reply.code(409).send({
        error: `screen ${screen.id} belongs to a machine that is not approved — cannot inspect it`,
      });
    }

    const delivered = agentHub.send(
      machine.id,
      ServerToAgentInspect.parse({
        t: "server/inspect",
        connector: screen.connector,
        on: body.data.on,
      }),
    );
    if (delivered === 0) {
      return reply
        .code(409)
        .send({ error: `${machine.label} is offline — nothing to show an inspector on` });
    }

    // POL-67 — disarming must not leave a DevTools session bridged to a screen the operator just
    // sealed. (For a chrome box `inspect off` IS the DevTools disarm; harmless no-op for surf.)
    if (!body.data.on) devtoolsRelay.closeScreenSessions(screen.id, "DevTools disarmed");

    // Drop any previous refusal now that a fresh request is in flight, so the console shows this
    // attempt's outcome rather than re-reporting the last one.
    presence.setScreenInspectError(screen.id, null);
    broadcaster.broadcast();

    fastify.log.info(
      {
        event: "screen.inspect",
        screenId: screen.id,
        machineId: machine.id,
        connector: screen.connector,
        on: body.data.on,
        delivered,
      },
      "pushed inspector request to agent",
    );
    return reply.code(202).send({ ok: true, screenId: screen.id, on: body.data.on, delivered });
  });

  // ── Phase 2b operator routes (enrollment) ─────────────────────────────────────

  // POST /api/v1/machines/:machineId/approve  -> pending → approved; create screens; live apply.
  fastify.post("/api/v1/machines/:machineId/approve", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.approveMachine(params.data.machineId);
    if (!result) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }

    // Live admit: if the agent is connected NOW, push it server/apply for its (new) screens.
    const apply = ServerToAgentApply.parse({
      t: "server/apply",
      revision: control.state.revision,
      machineId: params.data.machineId,
      screens: result.assignments,
    });
    const delivered = agentHub.send(params.data.machineId, apply);

    fastify.log.info(
      {
        event: "machine.approve",
        machineId: params.data.machineId,
        screens: result.assignments.map((a) => a.screenId),
        revision: control.state.revision,
        changed: result.changed,
        delivered,
      },
      "machine approved",
    );
    broadcaster.broadcast();
    return {
      ok: true,
      machineId: params.data.machineId,
      status: "approved",
      screens: result.assignments.map((a) => a.screenId),
      revision: control.state.revision,
      delivered,
    };
  });

  // POST /api/v1/machines/:machineId/reject  { reason? }  -> status → rejected; close if connected.
  fastify.post("/api/v1/machines/:machineId/reject", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    // Body is optional; tolerate an absent/empty body, only read a {reason?} when present.
    const parsedBody = RejectBody.safeParse(request.body ?? {});
    const reason = parsedBody.success ? parsedBody.data.reason : undefined;

    const ok = await control.rejectMachine(params.data.machineId);
    if (!ok) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }

    // If the agent is connected NOW, tell it why and close its socket — it will never be admitted.
    const rejected = ServerToAgentRejected.parse({
      t: "server/rejected",
      reason: reason ?? "rejected by operator",
    });
    const delivered = agentHub.send(params.data.machineId, rejected);
    const closed = agentHub.close(params.data.machineId);

    fastify.log.info(
      { event: "machine.reject", machineId: params.data.machineId, reason, delivered, closed },
      "machine rejected",
    );
    broadcaster.broadcast();
    return {
      ok: true,
      machineId: params.data.machineId,
      status: "rejected",
      delivered,
      closed,
    };
  });

  // ── Removal (POL-14) — permanently forget a machine or a single screen ────────
  //
  // Unlike reject/revoke (a remembered "rejected" state) or unplace (return-to-tray), these DELETEs
  // FORGET the entity: the machine (with all its screens, layout + content) or one stale screen. Both
  // dissolve any combined surface an affected screen belonged to and push the cleared slices to the
  // surviving members' players (the instant path), then broadcast a fresh admin/state.

  // DELETE /api/v1/machines/:machineId  -> forget the machine + all its screens; close its agent socket
  fastify.delete("/api/v1/machines/:machineId", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.removeMachine(params.data.machineId);
    if (!result) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }

    // If the agent is connected NOW, close its socket — the machine is gone, so it must re-enrol to
    // return (a lingering socket would otherwise sit idle until its next reconnect).
    const closed = agentHub.close(params.data.machineId);

    // Dissolving its screens' walls cleared surviving members' slices — push the (now empty) renders.
    for (const slice of result.slices) pushRender(slice.screenId, slice);

    fastify.log.info(
      {
        event: "machine.remove",
        machineId: params.data.machineId,
        screens: result.slices.map((s) => s.screenId),
        closed,
        revision: control.state.revision,
      },
      "machine removed",
    );
    broadcaster.broadcast();
    return { ok: true, machineId: params.data.machineId, closed };
  });

  // DELETE /api/v1/screens/:screenId  -> forget a single screen (dissolves its wall, clears its player)
  fastify.delete("/api/v1/screens/:screenId", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.removeScreen(params.data.screenId);
    if (!result) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    // Push the cleared slices — the removed screen's own (empty) render clears a still-connected player,
    // and any dissolved wall's surviving members clear their span fragment.
    for (const slice of result.slices) pushRender(slice.screenId, slice);

    fastify.log.info(
      {
        event: "screen.remove",
        screenId: params.data.screenId,
        screens: result.slices.map((s) => s.screenId),
        revision: control.state.revision,
      },
      "screen removed",
    );
    broadcaster.broadcast();
    return { ok: true, screenId: params.data.screenId };
  });

  // ── Display settings (POL-6) ──────────────────────────────────────────────────
  //
  // Fleet-wide on-screen badge visibility. GET reports the current value; PUT sets + persists it and
  // fans the new settings out to EVERY connected player over the player WS (instant, fleet-wide) plus
  // a fresh admin/state so the console reflects it live. Not part of any render slice → no revision bump.

  // GET /api/v1/settings/display -> DisplaySettings { showBadges }
  fastify.get("/api/v1/settings/display", async () => control.getDisplaySettings());

  // PUT /api/v1/settings/display  { showBadges }  -> DisplaySettings
  fastify.put("/api/v1/settings/display", async (request, reply) => {
    const body = UpdateDisplaySettingsBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const settings = await control.setDisplaySettings({ showBadges: body.data.showBadges });
    const delivered = broadcastDisplaySettings();
    fastify.log.info(
      { event: "settings.display.set", showBadges: settings.showBadges, delivered },
      "display settings updated",
    );
    broadcaster.broadcast();
    return settings;
  });

  // ── Phase 3 routes (murals & placement) ───────────────────────────────────────
  //
  // Murals + placement are spatial layout metadata for the console, not part of any player's render
  // slice, so these routes do NOT push server/render or bump the revision — they mutate, persist, and
  // broadcast a fresh admin/state (which carries murals[] + placements[]).

  // GET /api/v1/murals -> Mural[]
  fastify.get("/api/v1/murals", async () => control.getMurals());

  // POST /api/v1/murals  { name }  -> Mural
  fastify.post("/api/v1/murals", async (request, reply) => {
    const body = CreateMuralBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const mural = await control.createMural(body.data.name);
    fastify.log.info({ event: "mural.create", muralId: mural.id, name: mural.name }, "mural created");
    broadcaster.broadcast();
    return reply.code(201).send({ ok: true, mural });
  });

  // POST /api/v1/murals/:id/rename  { name }
  fastify.post("/api/v1/murals/:id/rename", async (request, reply) => {
    const params = MuralParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = RenameMuralBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const mural = await control.renameMural(params.data.id, body.data.name);
    if (!mural) {
      return reply.code(404).send({ error: `unknown mural: ${params.data.id}` });
    }

    fastify.log.info({ event: "mural.rename", muralId: mural.id, name: mural.name }, "mural renamed");
    broadcaster.broadcast();
    return { ok: true, mural };
  });

  // DELETE /api/v1/murals/:id  -> delete the mural; unplace its screens
  fastify.delete("/api/v1/murals/:id", async (request, reply) => {
    const params = MuralParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.deleteMural(params.data.id);
    if (!result) {
      return reply.code(404).send({ error: `unknown mural: ${params.data.id}` });
    }

    fastify.log.info({ event: "mural.delete", muralId: params.data.id }, "mural deleted");
    broadcaster.broadcast();
    // A deleted mural dissolves its video walls — push the cleared slices to those members' players.
    for (const slice of result.slices) pushRender(slice.screenId, slice);
    return { ok: true, muralId: params.data.id };
  });

  // PUT /api/v1/screens/:screenId/placement  { muralId, x, y, w?, h? }  -> place or move a screen
  fastify.put("/api/v1/screens/:screenId/placement", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = PlaceScreenBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    // Distinguish an unknown screen from an unknown mural for a clearer 404.
    if (!control.getScreen(params.data.screenId)) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }
    if (!control.getMural(body.data.muralId)) {
      return reply.code(404).send({ error: `unknown mural: ${body.data.muralId}` });
    }

    const placement = await control.placeScreen(
      params.data.screenId,
      body.data.muralId,
      body.data.x,
      body.data.y,
      body.data.w,
      body.data.h,
    );
    // placeScreen only returns null when the screen/mural is unknown, both already handled above.
    if (!placement) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    fastify.log.info(
      {
        event: "screen.place",
        screenId: placement.screenId,
        muralId: placement.muralId,
        x: placement.x,
        y: placement.y,
        w: placement.w,
        h: placement.h,
      },
      "screen placed",
    );
    broadcaster.broadcast();
    return { ok: true, placement };
  });

  // DELETE /api/v1/screens/:screenId/placement  -> unplace a screen (back to the tray)
  fastify.delete("/api/v1/screens/:screenId/placement", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    if (!control.getScreen(params.data.screenId)) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    const result = await control.unplaceScreen(params.data.screenId);
    const wasPlaced = result !== false;
    fastify.log.info(
      { event: "screen.unplace", screenId: params.data.screenId, wasPlaced },
      "screen unplaced",
    );
    broadcaster.broadcast();
    // Unplacing a wall member dissolves the wall — push the cleared slices to all its members' players.
    if (result !== false) for (const slice of result.slices) pushRender(slice.screenId, slice);
    return { ok: true, screenId: params.data.screenId, wasPlaced };
  });

  // ── Phase 3b routes (combined surfaces / video walls) ─────────────────────────
  //
  // Combine/split CLEAR the members' slices and setting wall content recomputes spans — all are
  // render changes, so these routes push `server/render` to every affected member's player (the
  // instant path) and broadcast a fresh admin/state (which now carries videoWalls[]).

  // GET /api/v1/walls -> VideoWall[]
  fastify.get("/api/v1/walls", async () => control.getVideoWalls());

  // POST /api/v1/murals/:muralId/walls  { muralId, memberScreenIds }  -> combine into a VideoWall (201)
  fastify.post("/api/v1/murals/:muralId/walls", async (request, reply) => {
    const params = MuralIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = CombineScreensBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    // The path mural and the body mural must agree (the body carries it per the contract).
    if (body.data.muralId !== params.data.muralId) {
      return reply.code(400).send({
        error: `mural mismatch: path ${params.data.muralId} ≠ body ${body.data.muralId}`,
      });
    }

    const result = await control.combineScreens(
      params.data.muralId,
      body.data.memberScreenIds,
      body.data.name,
    );
    if (!result.ok) {
      const status =
        result.error === "unknown-mural" || result.error === "unknown-screen"
          ? 404
          : result.error === "already-combined"
            ? 409
            : 400;
      return reply.code(status).send({ error: result.error, screenId: result.screenId, wallId: result.wallId });
    }

    // Combining clears the members' previous content — push the (now empty) slice to each player.
    for (const slice of result.slices) pushRender(slice.screenId, slice);

    fastify.log.info(
      {
        event: "wall.combine",
        wallId: result.wall.id,
        muralId: result.wall.muralId,
        members: result.wall.memberScreenIds,
        revision: control.state.revision,
      },
      "screens combined into a video wall",
    );
    broadcaster.broadcast();
    return reply.code(201).send({ ok: true, wall: result.wall, revision: control.state.revision });
  });

  // DELETE /api/v1/walls/:wallId  -> split the wall back into individual screens
  fastify.delete("/api/v1/walls/:wallId", async (request, reply) => {
    const params = WallParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.splitWall(params.data.wallId);
    if (!result) {
      return reply.code(404).send({ error: `unknown wall: ${params.data.wallId}` });
    }

    // Splitting clears each member's slice — push the (now empty) slice to each player.
    for (const slice of result.slices) pushRender(slice.screenId, slice);

    fastify.log.info(
      {
        event: "wall.split",
        wallId: params.data.wallId,
        members: result.wall.memberScreenIds,
        revision: control.state.revision,
      },
      "video wall split",
    );
    broadcaster.broadcast();
    return { ok: true, wallId: params.data.wallId, revision: control.state.revision };
  });

  // POST /api/v1/walls/:wallId/rename  { name }  -> rename the combined surface (no render change)
  fastify.post("/api/v1/walls/:wallId/rename", async (request, reply) => {
    const params = WallParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = RenameVideoWallBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const wall = await control.renameVideoWall(params.data.wallId, body.data.name);
    if (!wall) {
      return reply.code(404).send({ error: `unknown wall: ${params.data.wallId}` });
    }

    fastify.log.info({ event: "wall.rename", wallId: wall.id, name: wall.name }, "video wall renamed");
    // No render change (content is unaffected) — just re-broadcast admin/state so the console relabels.
    broadcaster.broadcast();
    return { ok: true, wall };
  });

  // PUT /api/v1/walls/:wallId/content  { url }  -> recompute spans + push render to all members
  fastify.put("/api/v1/walls/:wallId/content", async (request, reply) => {
    const params = WallParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SetContentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.setWallContent(params.data.wallId, body.data);
    if (!result.ok) {
      // unknown-wall / unknown-source → 404; no-placements → 409.
      const status =
        result.error === "unknown-wall" || result.error === "unknown-source" ? 404 : 409;
      return reply.code(status).send({ error: result.error, wallId: params.data.wallId });
    }

    for (const slice of result.slices) pushRender(slice.screenId, slice);

    fastify.log.info(
      {
        event: "wall.content",
        wallId: params.data.wallId,
        sourceId: body.data.sourceId,
        url: body.data.url,
        screens: result.slices.map((s) => s.screenId),
        revision: control.state.revision,
      },
      "video wall content set",
    );
    broadcaster.broadcast(); // surfaceCount changed
    return {
      ok: true,
      wallId: params.data.wallId,
      revision: control.state.revision,
      screens: result.slices.map((s) => s.screenId),
    };
  });

  // PUT /api/v1/screens/:screenId/content  { url }  -> single-screen web surface (409 if wall member)
  fastify.put("/api/v1/screens/:screenId/content", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SetContentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.setScreenContent(params.data.screenId, body.data);
    if (!result.ok) {
      if (result.error === "wall-member") {
        return reply.code(409).send({
          error: `screen ${params.data.screenId} is a member of video wall ${result.wallId}; set content on the wall`,
          wallId: result.wallId,
        });
      }
      if (result.error === "unknown-source") {
        return reply.code(404).send({ error: `unknown content source: ${body.data.sourceId}` });
      }
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    fastify.log.info(
      {
        event: "screen.content",
        screenId: params.data.screenId,
        sourceId: body.data.sourceId,
        url: body.data.url,
        revision: control.state.revision,
      },
      "screen content set",
    );
    pushRender(params.data.screenId, result.slice);
    broadcaster.broadcast(); // surfaceCount changed
    return { ok: true, revision: control.state.revision, slice: result.slice };
  });

  // ── Page zoom (POL-57) ───────────────────────────────────────────────────────
  //
  // Zoom the framed page on a screen or a combined surface. The server remembers the value against
  // the (target, page) pair, so re-assigning that page there restores it. The push is a re-styled
  // surface with the SAME id — the player rescales the existing iframe, it does not reload.

  // PUT /api/v1/screens/:screenId/zoom  { zoom }  -> restyle + push (409 if wall member / not framed)
  fastify.put("/api/v1/screens/:screenId/zoom", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SetZoomBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.setScreenZoom(params.data.screenId, body.data.zoom);
    if (!result.ok) {
      if (result.error === "wall-member") {
        return reply.code(409).send({
          error: `screen ${params.data.screenId} is a member of video wall ${result.wallId}; zoom the wall`,
          wallId: result.wallId,
        });
      }
      // no-content / not-zoomable are conflicts with the screen's current state, not bad requests.
      if (result.error === "no-content" || result.error === "not-zoomable") {
        return reply.code(409).send({ error: result.error, screenId: params.data.screenId });
      }
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    fastify.log.info(
      {
        event: "screen.zoom",
        screenId: params.data.screenId,
        zoom: body.data.zoom,
        revision: control.state.revision,
      },
      "screen zoom set",
    );
    for (const slice of result.slices) pushRender(slice.screenId, slice);
    broadcaster.broadcast(); // the console's content read-out carries the live zoom
    return { ok: true, revision: control.state.revision, zoom: body.data.zoom };
  });

  // PUT /api/v1/walls/:wallId/zoom  { zoom }  -> restyle + push to every member
  fastify.put("/api/v1/walls/:wallId/zoom", async (request, reply) => {
    const params = WallParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SetZoomBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.setWallZoom(params.data.wallId, body.data.zoom);
    if (!result.ok) {
      if (result.error === "unknown-wall") {
        return reply.code(404).send({ error: `unknown wall: ${params.data.wallId}` });
      }
      return reply.code(409).send({ error: result.error, wallId: params.data.wallId });
    }

    fastify.log.info(
      {
        event: "wall.zoom",
        wallId: params.data.wallId,
        zoom: body.data.zoom,
        screens: result.slices.map((s) => s.screenId),
        revision: control.state.revision,
      },
      "video wall zoom set",
    );
    for (const slice of result.slices) pushRender(slice.screenId, slice);
    broadcaster.broadcast();
    return {
      ok: true,
      wallId: params.data.wallId,
      revision: control.state.revision,
      zoom: body.data.zoom,
      screens: result.slices.map((s) => s.screenId),
    };
  });

  // POST /api/v1/walls/:wallId/ident  { on, ttlMs? }  -> ident-pulse to every member
  fastify.post("/api/v1/walls/:wallId/ident", async (request, reply) => {
    const params = WallParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = IdentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const members = control.identWall(params.data.wallId);
    if (!members) {
      return reply.code(404).send({ error: `unknown wall: ${params.data.wallId}` });
    }

    let delivered = 0;
    for (const screen of members) {
      delivered += sendIdentPulse(screen, body.data.on);
      if (body.data.on && body.data.ttlMs) {
        scheduleIdentOff(screen.id, body.data.ttlMs);
      }
    }
    return {
      ok: true,
      wallId: params.data.wallId,
      on: body.data.on,
      screens: members.map((s) => s.id),
      delivered,
    };
  });

  // ── Phase 3c routes (content library) ─────────────────────────────────────────
  //
  // CRUD over the reusable library of content sources ({id, name, kind, url}). Create/rename a source
  // is registry metadata → it only broadcasts a fresh admin/state (which now carries contentSources[]).
  // Editing or deleting an IN-USE source re-resolves (or clears) every screen/wall showing it, so those
  // routes ALSO push `server/render` to each affected member's player (the instant path).

  // GET /api/v1/content-sources -> ContentSource[]
  fastify.get("/api/v1/content-sources", async () => control.getContentSources());

  // POST /api/v1/content-sources  { name, kind, url }  -> ContentSource (201)
  fastify.post("/api/v1/content-sources", async (request, reply) => {
    const body = CreateContentSourceBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.createContentSource(body.data);
    if (!result.ok) {
      if (result.error === "unknown-profile") {
        return reply.code(404).send({ error: `unknown credential profile: ${body.data.credentialProfileId}` });
      }
      // POL-34 — playlist authoring errors are the operator's to fix: 400 with a plain sentence.
      return reply.code(400).send({ error: playlistItemErrorDetail(result.error, result.itemSourceId) });
    }
    const source = result.source;
    fastify.log.info(
      { event: "content-source.create", sourceId: source.id, kind: source.kind, name: source.name },
      "content source created",
    );
    broadcaster.broadcast();
    return reply.code(201).send({ ok: true, source });
  });

  // PATCH /api/v1/content-sources/:id  { name?, kind?, url? }  -> re-resolve + push in-use renders
  fastify.patch("/api/v1/content-sources/:id", async (request, reply) => {
    const params = ContentSourceParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = UpdateContentSourceBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.updateContentSource(params.data.id, body.data);
    if (!result.ok) {
      if (result.error === "unknown-source") {
        return reply.code(404).send({ error: `unknown content source: ${params.data.id}` });
      }
      if (result.error === "unknown-profile") {
        return reply
          .code(404)
          .send({ error: `unknown credential profile: ${body.data.credentialProfileId}` });
      }
      if (result.error === "invalid-source") {
        return reply.code(400).send({ error: "the update leaves the source inconsistent" });
      }
      if (result.error === "invalid-shape") {
        return reply
          .code(400)
          .send({ error: "a page source needs a definition; every other kind needs a url" });
      }
      // POL-34 — playlist authoring errors (bad item reference / missing duration).
      return reply.code(400).send({ error: playlistItemErrorDetail(result.error, result.itemSourceId) });
    }

    // Re-resolved every screen/wall showing this source — push the new render to each affected player.
    for (const slice of result.slices) pushRender(slice.screenId, slice);

    fastify.log.info(
      {
        event: "content-source.update",
        sourceId: result.source.id,
        kind: result.source.kind,
        screens: result.slices.map((s) => s.screenId),
        revision: control.state.revision,
      },
      "content source updated",
    );
    broadcaster.broadcast();
    return { ok: true, source: result.source, screens: result.slices.map((s) => s.screenId) };
  });

  // DELETE /api/v1/content-sources/:id  -> clear in-use assignments (empty render) + push
  fastify.delete("/api/v1/content-sources/:id", async (request, reply) => {
    const params = ContentSourceParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.deleteContentSource(params.data.id);
    if (!result) {
      return reply.code(404).send({ error: `unknown content source: ${params.data.id}` });
    }

    // Phase 7 lifecycle: if this source was backed by an uploaded file, unlink it from the disk volume
    // (a linked / non-uploaded source has nothing on disk → this is a no-op for it).
    const unlinked = await media.deleteBySourceId(params.data.id);

    // Cleared every screen/wall that was showing this source — push the (now empty) slice to each.
    for (const slice of result.slices) pushRender(slice.screenId, slice);

    fastify.log.info(
      {
        event: "content-source.delete",
        sourceId: params.data.id,
        screens: result.slices.map((s) => s.screenId),
        fileUnlinked: unlinked,
        revision: control.state.revision,
      },
      "content source deleted",
    );
    broadcaster.broadcast();
    return { ok: true, sourceId: params.data.id, screens: result.slices.map((s) => s.screenId) };
  });

  // ── POL-97 routes (overlays — a page composited above whatever is playing) ────
  //
  // PUT /api/v1/overlays                    { scope, targetId?, sourceId } -> apply/replace
  // DELETE /api/v1/overlays/:scope[/:targetId]                             -> remove
  // GET /api/v1/overlays                                                   -> assignments + coverage
  //
  // Neither mutation bumps the revision or touches a stored slice: the overlay is resolved per screen
  // at SEND time, so applying or removing one is a re-push of the SAME content with (or without) one
  // extra layer. The pushes go only to the screens whose RESOLVED overlay actually changed — a screen
  // a narrower scope already covers keeps what it has (screen > wall > mural > fleet).

  // GET /api/v1/overlays -> { overlays: OverlayAssignment[], coverage: {screenId, scope, sourceId}[] }
  fastify.get("/api/v1/overlays", async () => ({
    overlays: control.getOverlays(),
    coverage: control.overlayCoverage(),
  }));

  // PUT /api/v1/overlays  { scope, targetId?, sourceId }
  fastify.put("/api/v1/overlays", async (request, reply) => {
    const body = SetOverlayBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.setOverlay(body.data.scope, body.data.targetId, body.data.sourceId);
    if (!result.ok) {
      if (result.error === "unknown-target") {
        return reply
          .code(404)
          .send({ error: `unknown ${body.data.scope}: ${body.data.targetId}` });
      }
      if (result.error === "unknown-source") {
        return reply.code(404).send({ error: `unknown content source: ${body.data.sourceId}` });
      }
      // Only a page composes over content — every other kind would occlude what it sits above.
      return reply.code(400).send({ error: "an overlay must be a page source (author one in the Studio)" });
    }

    for (const screenId of result.screenIds) pushRender(screenId, control.sliceForPlayer(screenId));

    fastify.log.info(
      {
        event: "overlay.set",
        scope: body.data.scope,
        targetId: body.data.targetId,
        sourceId: body.data.sourceId,
        screens: result.screenIds,
      },
      "overlay applied",
    );
    broadcaster.broadcast();
    return { ok: true, overlay: result.assignment, screens: result.screenIds };
  });

  // DELETE /api/v1/overlays/:scope  |  /api/v1/overlays/:scope/:targetId
  fastify.delete("/api/v1/overlays/:scope/:targetId?", async (request, reply) => {
    const params = OverlayParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const { scope, targetId } = params.data;
    if ((scope === "fleet") !== (targetId === undefined)) {
      return reply.code(400).send({
        error: scope === "fleet" ? "the fleet scope takes no targetId" : `the ${scope} scope needs a targetId`,
      });
    }

    const result = await control.clearOverlay(scope, targetId);
    if (!result) {
      return reply.code(404).send({ error: `no overlay on ${scope}${targetId ? ` ${targetId}` : ""}` });
    }

    for (const screenId of result.screenIds) pushRender(screenId, control.sliceForPlayer(screenId));

    fastify.log.info(
      { event: "overlay.clear", scope, targetId, screens: result.screenIds },
      "overlay removed",
    );
    broadcaster.broadcast();
    return { ok: true, screens: result.screenIds };
  });

  // ── POL-24 routes (credential profiles — content auth) ────────────────────────
  //
  // CRUD over the centrally-held OAuth clients (Bucket A / D11). The client secret crosses the wire
  // INBOUND ONLY: every response and the admin/state broadcast carry CredentialProfileView (config +
  // live token health, never the secret). Create/update (re)seed the TokenService so the token cache
  // reflects the new config immediately; /test forces one exchange NOW and returns the IdP's answer.

  // GET /api/v1/credential-profiles -> CredentialProfileView[]
  fastify.get("/api/v1/credential-profiles", async () => control.getCredentialProfileViews());

  // POST /api/v1/credential-profiles  { name, tokenEndpoint, clientId, clientSecret, … } -> View (201)
  fastify.post("/api/v1/credential-profiles", async (request, reply) => {
    const body = CreateCredentialProfileBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const profile = await control.createCredentialProfile(body.data);
    tokens.upsertProfile(profile); // fetch the first token immediately
    fastify.log.info(
      { event: "credential-profile.create", profileId: profile.id, name: profile.name },
      "credential profile created",
    );
    broadcaster.broadcast();
    const view = control.getCredentialProfileViews().find((v) => v.id === profile.id);
    return reply.code(201).send({ ok: true, profile: view });
  });

  // PATCH /api/v1/credential-profiles/:id  (clientSecret omitted = unchanged) -> View
  fastify.patch("/api/v1/credential-profiles/:id", async (request, reply) => {
    const params = CredentialProfileParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = UpdateCredentialProfileBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const profile = await control.updateCredentialProfile(params.data.id, body.data);
    if (!profile) {
      return reply.code(404).send({ error: `unknown credential profile: ${params.data.id}` });
    }
    tokens.upsertProfile(profile); // re-fetch with the new config
    fastify.log.info(
      { event: "credential-profile.update", profileId: profile.id, name: profile.name },
      "credential profile updated",
    );
    broadcaster.broadcast();
    const view = control.getCredentialProfileViews().find((v) => v.id === profile.id);
    return { ok: true, profile: view };
  });

  // DELETE /api/v1/credential-profiles/:id -> 409 while any source references it (reassign first)
  fastify.delete("/api/v1/credential-profiles/:id", async (request, reply) => {
    const params = CredentialProfileParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.deleteCredentialProfile(params.data.id);
    if (!result.ok) {
      if (result.error === "unknown-profile") {
        return reply.code(404).send({ error: `unknown credential profile: ${params.data.id}` });
      }
      return reply
        .code(409)
        .send({ error: "in-use", inUseBy: result.inUseBy ?? 0 });
    }
    tokens.removeProfile(params.data.id);
    fastify.log.info(
      { event: "credential-profile.delete", profileId: params.data.id },
      "credential profile deleted",
    );
    broadcaster.broadcast();
    return { ok: true, profileId: params.data.id };
  });

  // POST /api/v1/credential-profiles/:id/test -> force a token exchange NOW; the IdP's answer, never
  // the token. (The exchange also updates the cached token/status, so a fixed IdP heals immediately.)
  fastify.post("/api/v1/credential-profiles/:id/test", async (request, reply) => {
    const params = CredentialProfileParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    if (!control.getCredentialProfileInternal(params.data.id)) {
      return reply.code(404).send({ error: `unknown credential profile: ${params.data.id}` });
    }

    const result = await tokens.testProfile(params.data.id);
    fastify.log.info(
      { event: "credential-profile.test", profileId: params.data.id, ok: result.ok },
      "credential profile tested",
    );
    broadcaster.broadcast(); // status likely changed either way
    return {
      ok: result.ok,
      ...(result.expiresIn !== undefined ? { expiresIn: result.expiresIn } : {}),
      ...(result.error !== undefined ? { error: result.error } : {}),
    };
  });

  // ── Phase 7 routes (media upload) ─────────────────────────────────────────────
  //
  // POST /api/v1/media — GATED (operator only; it lives under /api/v1, behind the session gate). A
  // multipart upload of ONE image/* or video/* file: stream it to the disk volume (MEDIA_DIR) under a
  // generated <id>.<ext> (never the client filename), enforce the size cap, then create a Phase-3c
  // ContentSource {kind, name, url:`${PUBLIC_BASE}/media/<id>`} so it appears in the library + admin/state
  // and assigns to screens/walls exactly like a linked source. The matching ungated serve route
  // (GET /media/:id) is registered TOP-LEVEL in index.ts. Returns {ok, source} (the {ok,resource}
  // convention). 415 for a non-image/video type, 413 when the file exceeds MEDIA_MAX_BYTES.
  fastify.post("/api/v1/media", async (request, reply) => {
    let data;
    try {
      data = await request.file();
    } catch (err) {
      if (isFileTooLargeError(err)) return reply.code(413).send({ error: "file too large" });
      return reply.code(400).send({ error: "invalid multipart upload" });
    }
    if (!data) {
      return reply.code(400).send({ error: "no file in multipart upload" });
    }

    const kind = kindForMime(data.mimetype);
    if (!kind) {
      // Drain the rejected stream so busboy/the connection isn't left hanging on an unconsumed file.
      data.file.resume();
      return reply.code(415).send({ error: `unsupported media type: ${data.mimetype}` });
    }

    const originalName = data.filename && data.filename.length > 0 ? data.filename : "upload";
    const providedName = readField(data.fields, "name");
    const name = (providedName && providedName.trim().length > 0 ? providedName.trim() : originalName)
      .slice(0, 120);

    let record;
    try {
      record = await media.save(data.file, data.mimetype, originalName, mediaConfig.maxBytes);
    } catch (err) {
      if (err instanceof MediaTooLargeError || isFileTooLargeError(err)) {
        return reply.code(413).send({ error: "file too large" });
      }
      throw err;
    }

    const url = `${mediaConfig.publicBase}/media/${record.id}`;
    const created = await control.createContentSource({ name, kind, url });
    if (!created.ok) {
      // Unreachable (no profile is referenced), but keep the union honest rather than assert.
      return reply.code(500).send({ error: "failed to create content source for upload" });
    }
    const source = created.source;
    await media.attachSource(record.id, source.id);

    fastify.log.info(
      {
        event: "media.upload",
        mediaId: record.id,
        sourceId: source.id,
        kind,
        mime: record.mime,
        size: record.size,
        name: source.name,
      },
      "media uploaded",
    );
    broadcaster.broadcast();
    return reply.code(201).send({ ok: true, source });
  });

  // ── Phase 3d routes (scenes) ──────────────────────────────────────────────────
  //
  // A scene is a named SNAPSHOT of a mural's whole wall. Saving/renaming/scheduling/deleting a scene is
  // registry metadata → those routes broadcast a fresh admin/state (which now carries scenes[]). APPLY
  // re-lays the wall (split/place/move + combine + content), so it ALSO pushes `server/render` to every
  // affected member's player (the instant path). The schedule time is illustrative — STORED, NOT FIRED.

  // GET /api/v1/scenes -> Scene[]
  fastify.get("/api/v1/scenes", async () => control.getScenes());

  // POST /api/v1/scenes  { name, muralId }  -> snapshot the mural's CURRENT wall as a new Scene (201)
  fastify.post("/api/v1/scenes", async (request, reply) => {
    const body = CreateSceneBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const scene = await control.snapshotScene(body.data.name, body.data.muralId);
    if (!scene) {
      return reply.code(404).send({ error: `unknown mural: ${body.data.muralId}` });
    }

    fastify.log.info(
      {
        event: "scene.create",
        sceneId: scene.id,
        muralId: scene.muralId,
        placements: scene.placements.length,
        walls: scene.walls.length,
        screens: scene.screens.length,
      },
      "scene saved",
    );
    broadcaster.broadcast();
    // Convention: { ok, <resource> } (like murals/walls/sources). api.createScene reads body.scene.
    return reply.code(201).send({ ok: true, scene });
  });

  // POST /api/v1/scenes/:id/apply  -> re-apply the scene to its mural; push render to every member
  fastify.post("/api/v1/scenes/:id/apply", async (request, reply) => {
    const params = SceneParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.applyScene(params.data.id);
    if (!result) {
      return reply.code(404).send({ error: `unknown scene: ${params.data.id}` });
    }

    // Apply re-laid the wall (split/place/move + combine + content) — push the new slices live.
    for (const slice of result.slices) pushRender(slice.screenId, slice);

    fastify.log.info(
      {
        event: "scene.apply",
        sceneId: result.scene.id,
        muralId: result.scene.muralId,
        screens: result.slices.map((s) => s.screenId),
        revision: control.state.revision,
      },
      "scene applied",
    );
    broadcaster.broadcast();
    return {
      ok: true,
      sceneId: result.scene.id,
      revision: control.state.revision,
      screens: result.slices.map((s) => s.screenId),
    };
  });

  // PATCH /api/v1/scenes/:id  { name?, scheduleAt? }  -> rename and/or set illustrative schedule time
  fastify.patch("/api/v1/scenes/:id", async (request, reply) => {
    const params = SceneParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = UpdateSceneBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const scene = await control.updateScene(params.data.id, body.data);
    if (!scene) {
      return reply.code(404).send({ error: `unknown scene: ${params.data.id}` });
    }

    fastify.log.info(
      { event: "scene.update", sceneId: scene.id, name: scene.name, scheduleAt: scene.scheduleAt ?? null },
      "scene updated",
    );
    broadcaster.broadcast();
    // Convention: { ok, <resource> }. api.updateScene reads body.scene.
    return reply.send({ ok: true, scene });
  });

  // DELETE /api/v1/scenes/:id  -> delete a saved scene (does not touch the live wall)
  fastify.delete("/api/v1/scenes/:id", async (request, reply) => {
    const params = SceneParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const ok = await control.deleteScene(params.data.id);
    if (!ok) {
      return reply.code(404).send({ error: `unknown scene: ${params.data.id}` });
    }

    fastify.log.info({ event: "scene.delete", sceneId: params.data.id }, "scene deleted");
    broadcaster.broadcast();
    return { ok: true, sceneId: params.data.id };
  });
}
