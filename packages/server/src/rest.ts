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
 * POL-103 tags + selector-targeted bulk operations:
 *   PUT  /api/v1/machines/:machineId/tags     -> replace a machine's whole tag set; 404 unknown
 *   POST /api/v1/machines/bulk/reboot         -> each takes {selector} (e.g. "tag=atrium") or
 *   POST /api/v1/machines/bulk/shell             {machineIds}, fans out, and answers a per-machine
 *   POST /api/v1/machines/bulk/ident             result list. Offline boxes are an OUTCOME, not a
 *   POST /api/v1/machines/bulk/approve           failed call. 400 if no target is named.
 *
 * POL-50 operator route:
 *   POST /api/v1/screens/:screenId/inspect    -> server/inspect: pop the kiosk browser's Web Inspector
 *                                                ON that panel; 202 delivered (the agent's ack decides
 *                                                the outcome), 404 unknown, 409 not-approved or offline
 */
import { z } from "zod";

import type { ShellRelay } from "./shell-relay";
import type { DevtoolsRelay } from "./devtools-relay";
import { probeFraming } from "./framing";
import type { PanelPowerScheduler } from "./panel-power";

import {
  BulkApproveBody,
  BulkContentBody,
  BulkIdentBody,
  BulkOpResponse,
  BulkRebootBody,
  BulkShellBody,
  CastArmBody,
  CombineScreensBody,
  CreateContentSourceBody,
  CreateCredentialProfileBody,
  CreateMuralBody,
  CreatePreRegistrationBody,
  CreateSceneBody,
  IdentBody,
  ImportPreRegistrationsBody,
  InspectBody,
  machineHasName,
  MoveTargetsBody,
  PanelHoursBody,
  PanelPowerBody,
  PlaceScreenBody,
  UnplaceScreensBody,
  PreRegistration,
  RebootBody,
  ShellArmBody,
  RenameMachineBody,
  RenameMuralBody,
  RenameScreenBody,
  RenameVideoWallBody,
  ScreenVariablesBody,
  ServerToAgentApply,
  ServerToAgentInspect,
  ServerToAgentPending,
  UpdatePanelPowerBody,
  ServerToAgentReboot,
  ServerToAgentRejected,
  ServerToAgentIdent,
  ServerToPlayerIdent,
  ServerToPlayerRender,
  ServerToPlayerSettings,
  SetContentBody,
  SetAudioBody,
  SetMachineTagsBody,
  SetZoomBody,
  SetPlaylistEntryZoomBody,
  Surface,
  UpdateContentSourceBody,
  UpdateCredentialProfileBody,
  UpdateBootOrderPolicyBody,
  UpdateDisplaySettingsBody,
  UpdateSceneBody,
} from "@polyptic/protocol";
import type { FastifyInstance } from "fastify";
import type { BulkMachineResult, Screen, ScreenSlice } from "@polyptic/protocol";

import { appliedCount, fanOut, resolveTarget, unknownIdResults } from "./bulk";

import { MediaTooLargeError, ingestUpload, isFileTooLargeError, kindForMime, mediaIdFromUrl, readField } from "./media";
import { NO_CONVERTER_MESSAGE, documentExtForMime, documentFormatLabel } from "./document-convert";
import { DEFAULT_DWELL_SECONDS, deckDisplayName, ingestDocument } from "./documents";
import { parsePreRegistrationCsv } from "./preregistration";

import type { DocumentConverter } from "./document-convert";
import type { DocumentJobs } from "./documents";
import type { ActivityLog } from "./activity";
import type { CaptureCoordinator } from "./capture";
import type { ControlPlane } from "./state";
import { pendingUrlFor } from "./state";
import type { AgentHub, PlayerHub } from "./hub";
import type { AdminBroadcaster, Presence } from "./admin";
import type { MediaProber } from "./media-probe";
import type { MediaStore } from "./media";
import type { TokenService } from "./tokens";
import type { SourceHealthTracker } from "./source-health";

/** Phase 7 — where uploaded media lands + how its serve URL is built. Wired from env in index.ts. */
export interface MediaConfig {
  /** Absolute public base for the serve route, e.g. http://host:8080 → url `${publicBase}/media/<id>`. */
  publicBase: string;
  /** Byte cap enforced on an upload (mirrors the multipart fileSize limit). */
  maxBytes: number;
  /** POL-109 — the ingest prober (metadata + poster frames + codec validation). Behind the adapter
   *  seam: this route knows only the interface, and a server with no toolchain still accepts uploads. */
  prober: MediaProber;
  /** POL-114 — the document converter (PDF/slides → page images). Same seam, opposite degradation:
   *  with no converter there is no deck to show, so a document upload is REFUSED, not accepted (D132). */
  converter: DocumentConverter;
  /** POL-114 — the live conversion jobs, pushed to the console on `admin/state`. */
  documentJobs: DocumentJobs;
}

const ScreenParams = z.object({ screenId: z.string().min(1) });
const MachineParams = z.object({ machineId: z.string().min(1) });
/** POL-104 — a pre-registration record id. */
const PreRegistrationParams = z.object({ id: z.string().min(1) });
const MuralParams = z.object({ id: z.string().min(1) });
const MuralIdParams = z.object({ muralId: z.string().min(1) });
const WallParams = z.object({ wallId: z.string().min(1) });
const ContentSourceParams = z.object({ id: z.string().min(1) });

/** A plain sentence for each playlist authoring error (POL-34), shown to the operator verbatim. */
function playlistItemErrorDetail(
  error: "unknown-item-source" | "nested-playlist" | "live-stream-step" | "item-needs-duration",
  itemSourceId?: string,
): string {
  switch (error) {
    case "unknown-item-source":
      return `playlist item references an unknown source: ${itemSourceId}`;
    case "nested-playlist":
      return `a playlist cannot contain another playlist (${itemSourceId})`;
    case "live-stream-step":
      return `a playlist cannot contain a live stream — assign it to a screen directly (${itemSourceId})`;
    case "item-needs-duration":
      return `playlist items that are not videos need a duration (${itemSourceId})`;
  }
}
/** "1 machine" / "12 machines" — a bulk op leaves ONE activity line, and it counts the blast radius. */
function countMachines(n: number): string {
  return `${n} ${n === 1 ? "machine" : "machines"}`;
}

const CredentialProfileParams = z.object({ id: z.string().min(1) });
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
  /** POL-94 — per-source content health; a deleted source's reports are dropped with it. */
  health: SourceHealthTracker,
  panelPower: PanelPowerScheduler,
): void {
  // POL-18 — machines whose placed windows the agent may still be holding. A content change on such
  // a machine must push a fresh apply even when the new state has none (so the agent tears the
  // window down); a machine that never had windows skips the extra frame entirely.
  //
  // Seeded from REAL placed-window state (not left empty), so a server restart cannot strand a
  // floating window: control.init() has already hydrated the persisted slices by the time routes
  // register, so a screen that still holds a `placement: "window"` surface is recorded here up
  // front — and a later clear/reassign of that screen fires the teardown apply instead of
  // short-circuiting on an empty Set and leaving the window over empty content.
  const machinesWithWindows = new Set<string>();
  for (const machine of control.getMachines()) {
    const hasWindows = control
      .assignmentsForMachine(machine.id)
      .some((a) => (a.windows?.length ?? 0) > 0);
    if (hasWindows) machinesWithWindows.add(machine.id);
  }

  /**
   * POL-18 — keep a machine's agent in step with its screens' WINDOW placements. Content changes
   * ride the player channel (instant, D5) — but a `placement: "window"` surface is rendered by the
   * AGENT, so whenever a render might have changed a window set we push a full `server/apply` for
   * that machine (always the complete per-output list: the agent retires unlisted connectors).
   * No-op for machines that neither have nor had windows, so the common path costs nothing.
   */
  function syncWindowsToAgent(screenId: string): void {
    const screen = control.getScreen(screenId);
    if (!screen) return;
    const assignments = control.assignmentsForMachine(screen.machineId);
    const hasWindows = assignments.some((a) => (a.windows?.length ?? 0) > 0);
    if (!hasWindows && !machinesWithWindows.has(screen.machineId)) return;
    if (hasWindows) machinesWithWindows.add(screen.machineId);
    else machinesWithWindows.delete(screen.machineId);
    const apply = ServerToAgentApply.parse({
      t: "server/apply",
      revision: control.state.revision,
      machineId: screen.machineId,
      screens: assignments,
    });
    const delivered = agentHub.send(screen.machineId, apply);
    fastify.log.info(
      {
        event: "apply.windows",
        machineId: screen.machineId,
        windows: assignments.flatMap((a) => (a.windows ?? []).map((w) => `${a.connector}:${w.id}`)),
        delivered,
      },
      "pushed window placements to agent",
    );
  }

  function pushRender(screenId: string, slice: ScreenSlice): number {
    const message = ServerToPlayerRender.parse({
      t: "server/render",
      revision: control.state.revision,
      // Stamp the screen's current friendly name so the player labels itself with it, not the raw id.
      friendlyName: control.getScreen(screenId)?.friendlyName ?? screenId,
      // POL-119: stamp the cast toggle the same way — the badge's cast glyph, not render data.
      castEnabled: control.getScreen(screenId)?.castEnabled ?? false,
      // POL-24: stamp the current auth token into web/dashboard URLs at SEND time (stored slices keep
      // the clean url, so the DB never holds a token and every load gets a live one).
      slice: control.decorateSliceForSend(slice),
    });
    const delivered = hub.send(screenId, message);
    // POL-18 — a render change may have added/removed/moved a placed window; tell the agent too.
    syncWindowsToAgent(screenId);
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

  /**
   * POL-18 — probe a web/dashboard source's framing headers and store the verdict. When the verdict
   * changes how the source renders (auto mode), the returned slices are pushed live — the automatic
   * web → web-window fallback — and the agents of the affected machines get fresh window placements
   * through pushRender's sync. Fire-and-forget from create/update (a slow target site must never
   * hold an operator's save hostage); awaited by the explicit re-probe route.
   */
  async function probeSourceFraming(sourceId: string, url: string): Promise<void> {
    const verdict = await probeFraming(url);
    const result = await control.setSourceFraming(sourceId, verdict);
    if (!result.changed) return;
    for (const slice of result.slices) pushRender(slice.screenId, slice);
    fastify.log.info(
      { event: "content-source.framing", sourceId, verdict, screens: result.slices.map((s) => s.screenId) },
      "framing verdict stored",
    );
    broadcaster.broadcast();
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
    // POL-154 — the ident overlay is drawn by the player, but an OS-level web-window (POL-18) floats
    // ABOVE the player and hides it. So when this screen hosts a web-window, ALSO tell its AGENT to
    // raise that connector's player over the window for the flash (`on`) and drop it back after
    // (`off`). Best-effort and additive: a screen with no window sends nothing, and an agent that
    // predates the connector field simply ignores it.
    if (control.windowsForScreen(screen.id).length > 0) {
      agentHub.send(
        screen.machineId,
        ServerToAgentIdent.parse({ t: "server/ident", on, connector: screen.connector }),
      );
      fastify.log.info(
        { event: "ident.window-raise", screenId: screen.id, connector: screen.connector, on },
        "raised player over web-window for ident",
      );
    }
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

    // POL-119 — a cast-enabled screen advertises its friendly name on mDNS, so a rename must reach
    // the box too: a same-revision apply re-push restarts that receiver under the new name (a brief
    // advertisement blip, accepted in the pitch). Not sent for uncast screens — nothing to relabel.
    if (screen.castEnabled) {
      agentHub.send(
        screen.machineId,
        ServerToAgentApply.parse({
          t: "server/apply",
          revision: control.state.revision,
          machineId: screen.machineId,
          screens: control.assignmentsFor(screen.machineId),
        }),
      );
    }

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

  // POST /api/v1/machines/:machineId/rename  { label }  (POL-117)
  //
  // Any machine, any status, any time — naming a still-PENDING box is the point: several identical
  // netbooted boxes (all hostnamed `localhost.localdomain`) are indistinguishable exactly while they
  // queue for approval. Registry metadata like a screen rename: no revision bump, no player push —
  // the admin/state broadcast relabels every open console live.
  fastify.post("/api/v1/machines/:machineId/rename", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = RenameMachineBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const machine = await control.renameMachine(params.data.machineId, body.data.label);
    if (!machine) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }

    fastify.log.info(
      { event: "machine.rename", machineId: machine.id, label: machine.label },
      "machine renamed",
    );
    broadcaster.broadcast();
    return { ok: true, machine };
  });

  // POST /api/v1/machines/:machineId/ident  { on, ttlMs? }  -> ident every screen on the machine
  //
  // POL-117 — a PENDING machine can ident too, so the operator knows which physical panel they are
  // approving. It has no screens (no player WS to pulse), so the pulse rides the one channel a
  // pending box already holds: the agent WS. The server re-sends `server/pending` with `&ident=1`
  // appended to the holding board's URL; the agent's existing URL-diff handling re-places the board,
  // which comes up flashing. Deliberately NOT a new pre-approval capability — the box could already
  // be told to show the pending board, this just varies which face of it.
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

    if (machine.status === "pending") {
      const sendPendingBoard = (ident: boolean): number => {
        // POL-145 — a NAMED machine flashes its name (the id rides small underneath); only an
        // unnamed box falls back to the raw id. The label is re-read at send time so the TTL-off
        // (and any ident after a rename) always carries the current truth. Same additive URL-param
        // path as `ident=1`, so deployed agents need no change — they just re-place the URL.
        const current = control.getMachine(machine.id) ?? machine;
        const name =
          ident && machineHasName(current) ? `&name=${encodeURIComponent(current.label.trim())}` : "";
        return agentHub.send(
          machine.id,
          ServerToAgentPending.parse({
            t: "server/pending",
            machineId: machine.id,
            pendingUrl: pendingUrlFor(machine.id) + (ident ? `&ident=1${name}` : ""),
          }),
        );
      };
      const delivered = sendPendingBoard(body.data.on);
      if (body.data.on && body.data.ttlMs) {
        setTimeout(() => {
          // Re-check the status at fire time: an approve inside the TTL window means the box now
          // shows real content — a stale pending frame must not drag it back to the holding board.
          if (control.getMachine(machine.id)?.status === "pending") sendPendingBoard(false);
        }, body.data.ttlMs);
      }
      fastify.log.info(
        { event: "ident.pending", machineId: machine.id, on: body.data.on, delivered },
        "pushed pending-board ident to agent",
      );
      return { ok: true, machineId: machine.id, on: body.data.on, screens: [], delivered };
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
        .send({ error: `machine ${machine.id} is ${machine.status}, not approved, so it cannot be rebooted` });
    }

    const reason = body.data.reason?.trim() || "requested by an operator from the console";
    const delivered = agentHub.send(
      machine.id,
      ServerToAgentReboot.parse({ t: "server/reboot", reason }),
    );
    if (delivered === 0) {
      return reply.code(409).send({ error: `machine ${machine.id} is offline, so there is nothing to reboot` });
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

    // POL-117 — pre-approval, the ONLY thing reachable on a box is its own holding board (the
    // pending ident). An unapproved box must not be armable for a shell: approval is the trust
    // boundary, and arming would let a console session reach a terminal on hardware nobody admitted.
    // (Disarming is always allowed — locking down never needs approval.)
    const target = control.getMachine(params.data.machineId);
    if (target && target.status !== "approved" && body.data.enabled) {
      return reply.code(409).send({
        error: `machine ${target.id} is ${target.status}, not approved, so its console cannot be enabled`,
      });
    }

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

  // ── Tags + selector-targeted bulk operations (POL-103) ──────────────────────
  //
  // At fifty boxes every fleet action is fifty clicks. Tags group them ("atrium", "floor:2",
  // "canary"); a selector (`tag=atrium`, or an AND: `tag=floor:2,tag=canary`) targets a whole group;
  // the bulk verbs below fan out over it and answer a RESULT PER MACHINE. Three offline boxes are a
  // reported outcome, not a failed call — partial success is the normal case at this scale.
  //
  // Every bulk body must NAME its target (a selector, or an explicit machineIds list). A bulk verb
  // with no target is a 400 and never means "the whole fleet"; likewise a selector that parses but
  // matches nothing is an honest `matched: 0`, not a fan-out over everything.

  // PUT /api/v1/machines/:machineId/tags  { tags }  -> replace the machine's whole tag set
  fastify.put("/api/v1/machines/:machineId/tags", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SetMachineTagsBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const machine = await control.setMachineTags(params.data.machineId, body.data.tags);
    if (!machine) {
      return reply.code(404).send({ error: `unknown machine: ${params.data.machineId}` });
    }

    broadcaster.broadcast();
    fastify.log.info(
      { event: "machine.tags", machineId: machine.id, tags: machine.tags },
      "machine tags set",
    );
    return { ok: true, machineId: machine.id, tags: machine.tags };
  });

  /** The one shape every bulk verb answers with (+ its single summarized activity line). */
  function bulkReply(
    action: string,
    target: string,
    results: BulkMachineResult[],
    summary: (applied: number) => string,
  ): unknown {
    const applied = appliedCount(results);
    if (applied > 0) activity.push("accent", summary(applied));
    broadcaster.broadcast();
    fastify.log.info(
      { event: `machines.bulk.${action}`, target, matched: results.length, applied },
      "bulk operation fanned out",
    );
    return BulkOpResponse.parse({
      ok: true,
      action,
      target,
      matched: results.length,
      applied,
      results,
    });
  }

  // POST /api/v1/machines/bulk/reboot  { selector | machineIds, reason? }
  fastify.post("/api/v1/machines/bulk/reboot", async (request, reply) => {
    const body = BulkRebootBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const resolved = resolveTarget(control.getMachines(), body.data);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });

    const reason = body.data.reason?.trim() || "requested by an operator from the console";
    const results = await fanOut(resolved.machines, (machine) => {
      if (machine.status !== "approved") {
        return {
          machineId: machine.id,
          label: machine.label,
          outcome: "skipped" as const,
          detail: `${machine.status}, not approved — cannot reboot it`,
        };
      }
      const delivered = agentHub.send(
        machine.id,
        ServerToAgentReboot.parse({ t: "server/reboot", reason }),
      );
      return delivered === 0
        ? {
            machineId: machine.id,
            label: machine.label,
            outcome: "offline" as const,
            detail: "offline — nothing to reboot",
          }
        : { machineId: machine.id, label: machine.label, outcome: "applied" as const };
    });
    results.push(...unknownIdResults(resolved.unknownIds));

    return bulkReply("reboot", resolved.target, results, (n) => `Rebooting ${countMachines(n)}`);
  });

  // POST /api/v1/machines/bulk/shell  { selector | machineIds, enabled }  -> arm/disarm a group
  fastify.post("/api/v1/machines/bulk/shell", async (request, reply) => {
    const body = BulkShellBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const resolved = resolveTarget(control.getMachines(), body.data);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });

    const enabled = body.data.enabled;
    const results = await fanOut(resolved.machines, async (machine) => {
      const updated = await control.setShellEnabled(machine.id, enabled);
      if (!updated) {
        return {
          machineId: machine.id,
          label: machine.label,
          outcome: "failed" as const,
          detail: "unknown machine — it may have been removed",
        };
      }
      // Disarming must not leave a terminal open on a box the operator just locked down.
      if (!enabled) shellRelay.closeMachineSessions(machine.id, "console disabled");
      return { machineId: machine.id, label: machine.label, outcome: "applied" as const };
    });
    results.push(...unknownIdResults(resolved.unknownIds));

    return bulkReply(
      "shell",
      resolved.target,
      results,
      (n) => `Console ${enabled ? "enabled" : "disabled"} on ${countMachines(n)}`,
    );
  });

  // POST /api/v1/machines/bulk/ident  { selector | machineIds, on, ttlMs? }  -> ident a whole group
  fastify.post("/api/v1/machines/bulk/ident", async (request, reply) => {
    const body = BulkIdentBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const resolved = resolveTarget(control.getMachines(), body.data);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });

    const { on, ttlMs } = body.data;
    const results = await fanOut(resolved.machines, (machine) => {
      const screens = control.getScreens().filter((s) => s.machineId === machine.id);
      if (screens.length === 0) {
        return {
          machineId: machine.id,
          label: machine.label,
          outcome: "skipped" as const,
          detail: "no screens yet — nothing to flash",
        };
      }
      let delivered = 0;
      for (const screen of screens) {
        delivered += sendIdentPulse(screen, on);
        if (on && ttlMs) scheduleIdentOff(screen.id, ttlMs);
      }
      return delivered === 0
        ? {
            machineId: machine.id,
            label: machine.label,
            outcome: "offline" as const,
            detail: "no player connected — nothing to flash",
          }
        : { machineId: machine.id, label: machine.label, outcome: "applied" as const };
    });
    results.push(...unknownIdResults(resolved.unknownIds));

    return bulkReply("ident", resolved.target, results, (n) => `Ident pulsed on ${countMachines(n)}`);
  });

  // POST /api/v1/machines/bulk/approve  { selector | machineIds }  -> admit a batch of pending boxes
  fastify.post("/api/v1/machines/bulk/approve", async (request, reply) => {
    const body = BulkApproveBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const resolved = resolveTarget(control.getMachines(), body.data);
    if (!resolved.ok) return reply.code(400).send({ error: resolved.error });

    const results = await fanOut(resolved.machines, async (machine) => {
      if (machine.status === "approved") {
        return {
          machineId: machine.id,
          label: machine.label,
          outcome: "skipped" as const,
          detail: "already approved",
        };
      }
      const result = await control.approveMachine(machine.id);
      if (!result) {
        return {
          machineId: machine.id,
          label: machine.label,
          outcome: "failed" as const,
          detail: "unknown machine — it may have been removed",
        };
      }
      // Live admit: if the agent is connected NOW, push it server/apply for its (new) screens. An
      // offline box is still APPROVED — it collects its state on its next hello, so this is not an
      // `offline` outcome, unlike a reboot that was never delivered.
      agentHub.send(
        machine.id,
        ServerToAgentApply.parse({
          t: "server/apply",
          revision: control.state.revision,
          machineId: machine.id,
          screens: result.assignments,
        }),
      );
      return { machineId: machine.id, label: machine.label, outcome: "applied" as const };
    });
    results.push(...unknownIdResults(resolved.unknownIds));

    return bulkReply("approve", resolved.target, results, (n) => `Approved ${countMachines(n)}`);
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
        error: `screen ${screen.id} belongs to a machine that is not approved, so it cannot be inspected`,
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
        .send({ error: `${machine.label} is offline, so there is nothing to show an inspector on` });
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

  // ── Panel power (POL-101) ─────────────────────────────────────────────────────
  //
  // Manual wake/sleep (per screen, and per machine for a whole box's panels) + the daily panel-hours
  // window. The non-negotiable, restated where it can be violated: a screen that SHOULD be showing
  // content is never blanked. Nothing below runs on a timer over the wall's state, nothing infers
  // idleness — a panel goes dark only because an operator said so, or because a window an operator
  // set says the day is over.
  //
  // 202, not 200, for the power routes: the request is DELIVERED, not applied. The agent's
  // `agent/power-ack` (ws.ts) is what marks a screen asleep, because only the box knows whether the
  // compositor took the DPMS command and whether the CEC bus answered.

  /**
   * Deliver one operator power frame for a screen. Note what it does NOT do: it never touches the
   * scheduler's memory. That is what makes a manual action hold until the next boundary — the
   * schedule's opinion hasn't changed, so no edge exists and the next tick says nothing (see
   * panel-power.ts). An operator who wakes a wall for an evening visit gets their evening.
   */
  function pushScreenPower(screenId: string, on: boolean): number {
    const delivered = panelPower.send(screenId, on, "requested by an operator from the console");
    // Drop any previous refusal so the console shows THIS attempt's outcome, not the last one.
    if (delivered > 0) presence.setScreenPowerError(screenId, null);
    return delivered;
  }

  // POST /api/v1/screens/:screenId/power  { on }  -> wake/sleep ONE panel
  fastify.post("/api/v1/screens/:screenId/power", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = PanelPowerBody.safeParse(request.body ?? {});
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
        error: `screen ${screen.id} belongs to a machine that is not approved, so it cannot be powered`,
      });
    }

    const delivered = pushScreenPower(screen.id, body.data.on);
    if (delivered === 0) {
      return reply
        .code(409)
        .send({ error: `${machine.label} is offline, so there is nothing to ${body.data.on ? "wake" : "sleep"}` });
    }
    broadcaster.broadcast();
    return reply.code(202).send({ ok: true, screenId: screen.id, on: body.data.on, delivered });
  });

  // POST /api/v1/machines/:machineId/power  { on }  -> wake/sleep EVERY panel a box drives (bulk)
  fastify.post("/api/v1/machines/:machineId/power", async (request, reply) => {
    const params = MachineParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = PanelPowerBody.safeParse(request.body ?? {});
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
        .send({ error: `machine ${machine.id} is ${machine.status}, not approved, so its panels cannot be powered` });
    }

    const screens = control.getScreens().filter((s) => s.machineId === machine.id);
    if (screens.length === 0) {
      return reply.code(409).send({ error: `${machine.label} drives no screens` });
    }
    // One frame per connector — the machine is plumbing, the screens are the subject (D4).
    let delivered = 0;
    for (const screen of screens) delivered += pushScreenPower(screen.id, body.data.on);
    if (delivered === 0) {
      return reply
        .code(409)
        .send({ error: `${machine.label} is offline, so there is nothing to ${body.data.on ? "wake" : "sleep"}` });
    }

    broadcaster.broadcast();
    fastify.log.info(
      { event: "machine.power", machineId: machine.id, on: body.data.on, screens: screens.length, delivered },
      body.data.on ? "pushed panel wake to every screen" : "pushed panel sleep to every screen",
    );
    return reply.code(202).send({ ok: true, machineId: machine.id, on: body.data.on, delivered });
  });

  // PUT /api/v1/screens/:screenId/panel-hours  { hours | null }  -> set/clear a screen's daily window
  //
  // 200, not 202: this one IS applied here — it changes stored config, not the glass. The window takes
  // effect at its next boundary, and a screen with NO window (the default, and what every existing
  // deployment has) is never touched by the scheduler at all.
  fastify.put("/api/v1/screens/:screenId/panel-hours", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = PanelHoursBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const screen = control.getScreen(params.data.screenId);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    await control.setPanelHours(screen.id, body.data.hours);
    const hours = body.data.hours;
    activity.push(
      "info",
      hours && hours.enabled
        ? `Panel hours for ${screen.friendlyName}: ${hours.on}–${hours.off} (${control.getPanelPowerConfig().timezone})`
        : `Panel hours cleared for ${screen.friendlyName} — it runs 24/7`,
    );
    // Bring the screen to where its NEW window says it should be, now, rather than making the operator
    // wait until tonight to discover whether they typed what they meant. Only when the two disagree:
    // `desired === asleep` is exactly the mismatch (want-awake-but-asleep, or want-asleep-but-awake).
    const desired = panelPower.desiredFor(screen.id);
    if (desired !== null) {
      if (desired === presence.isScreenAsleep(screen.id)) {
        panelPower.send(screen.id, desired, "panel hours updated");
      }
      // Record the schedule's opinion either way, so the next tick doesn't mistake a stale value for
      // a boundary and send a redundant frame.
      panelPower.noteScheduleApplied(screen.id, desired);
    }
    broadcaster.broadcast();
    fastify.log.info(
      { event: "screen.panel_hours", screenId: screen.id, hours },
      "panel hours updated",
    );
    return { ok: true, screenId: screen.id, hours: control.getPanelHours(screen.id) ?? null };
  });

  // GET /api/v1/settings/panel-power -> PanelPowerConfig { timezone }
  fastify.get("/api/v1/settings/panel-power", async () => control.getPanelPowerConfig());

  // PUT /api/v1/settings/panel-power  { timezone }  -> PanelPowerConfig
  //
  // The zone is EXPLICIT by design: the server's own TZ is an accident of where it is hosted, and the
  // operator's browser is an accident of where they are standing. A wall keeps ITS building's hours.
  fastify.put("/api/v1/settings/panel-power", async (request, reply) => {
    const body = UpdatePanelPowerBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    // Validate the zone against the runtime's own tz database — a typo must fail HERE, loudly, not
    // silently degrade the scheduler to UTC at 19:00 six weeks from now.
    try {
      new Intl.DateTimeFormat("en-GB", { timeZone: body.data.timezone });
    } catch {
      return reply
        .code(400)
        .send({ error: `unknown timezone: ${body.data.timezone} (expected an IANA zone, e.g. Europe/London)` });
    }

    const config = await control.setPanelTimezone(body.data.timezone);
    activity.push("info", `Panel-hours timezone set to ${config.timezone}`);
    broadcaster.broadcast();
    fastify.log.info({ event: "settings.panel_power.set", timezone: config.timezone }, "panel-power timezone updated");
    return config;
  });

  // POST /api/v1/screens/:screenId/cast  { enabled }  -> enable/disable casting (POL-119)
  //
  // The persistent per-screen AirPlay-receiver toggle. Persisted first (desired state — an offline
  // box reconciles it from the apply it gets on its next hello), then, when the agent is connected
  // NOW, a same-revision `server/apply` re-push makes it start/stop the receiver immediately, and a
  // same-revision `server/render` re-push flips the player badge's cast glyph (the rename trick —
  // neither mutation is render data, so the revision must not move).
  fastify.post("/api/v1/screens/:screenId/cast", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = CastArmBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const screen = await control.setScreenCastEnabled(params.data.screenId, body.data.enabled);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    const delivered = agentHub.send(
      screen.machineId,
      ServerToAgentApply.parse({
        t: "server/apply",
        revision: control.state.revision,
        machineId: screen.machineId,
        screens: control.assignmentsFor(screen.machineId),
      }),
    );
    pushRender(screen.id, control.sliceForPlayer(screen.id));

    // Disabling kills the receiver (and with it any live session) on the box; don't leave the
    // console saying "casting" until the agent's next status lands — the operator's intent is now.
    if (!body.data.enabled) presence.setScreenCasting(screen.id, false);
    broadcaster.broadcast();

    fastify.log.info(
      {
        event: "screen.cast",
        screenId: screen.id,
        machineId: screen.machineId,
        connector: screen.connector,
        enabled: body.data.enabled,
        delivered,
      },
      body.data.enabled ? "casting enabled" : "casting disabled",
    );
    return { ok: true, screen, delivered };
  });

  // POST /api/v1/screens/:screenId/variables  { variables }  -> per-screen template variables (POL-111)
  //
  // The whole map, replaced. Registry metadata (like a rename), so no revision bump — but the screen's
  // render IS re-pushed at the SAME revision, because what the player should now show HAS changed:
  // `decorateSliceForSend` re-substitutes the clean, stored templates against the new scope and the
  // player DOM-diffs the new URL/text in place. No reload, no duplicated source, nothing substituted
  // written to the DB.
  fastify.post("/api/v1/screens/:screenId/variables", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = ScreenVariablesBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const screen = await control.setScreenVariables(params.data.screenId, body.data.variables);
    if (!screen) {
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    pushRender(screen.id, control.sliceForPlayer(screen.id));
    broadcaster.broadcast();

    fastify.log.info(
      {
        event: "screen.variables",
        screenId: screen.id,
        // Keys only — a value is operator content and has no business in the logs.
        keys: Object.keys(screen.variables),
      },
      "screen variables set",
    );
    return { ok: true, screen };
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

  // ── Pre-registration (POL-104) ───────────────────────────────────────────────
  //
  // Boxes an operator declares BEFORE they ever boot, so commissioning a rack is a paste rather than
  // N blind approvals. A record is NOT a credential and admits nothing: it is consulted only after a
  // hello has already authenticated against a valid enrolment token, and all it decides is the box's
  // name, its tags, and whether a human has to click Approve.

  // GET /api/v1/pre-registrations -> { records }
  fastify.get("/api/v1/pre-registrations", async () => ({
    records: control.listPreRegistrations().map((r) => PreRegistration.parse(r)),
  }));

  // POST /api/v1/pre-registrations  CreatePreRegistrationBody -> the new record
  fastify.post("/api/v1/pre-registrations", async (request, reply) => {
    const body = CreatePreRegistrationBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    if (!body.data.machineId && !body.data.dmiSerial && !body.data.mac) {
      // A record with no key can never match anything — refuse it rather than let an operator believe
      // a box is pre-registered when nothing will ever claim it.
      return reply.code(400).send({ error: "a pre-registration needs a MAC, a DMI serial or a machine id" });
    }
    const record = await control.addPreRegistration(body.data);
    fastify.log.info(
      { event: "prereg.create", id: record.id, label: record.label, autoApprove: record.autoApprove },
      "pre-registration created",
    );
    broadcaster.broadcast();
    return { ok: true, record: PreRegistration.parse(record) };
  });

  // POST /api/v1/pre-registrations/import  { csv, autoApprove } -> { created, errors }
  //
  // A CSV paste, because the operator's source of truth is a delivery note or a spreadsheet of MAC
  // labels. Bad lines are REPORTED with their line number, never silently dropped: a row that vanishes
  // in a 50-box paste is a box that never auto-approves and nobody knows why.
  fastify.post("/api/v1/pre-registrations/import", async (request, reply) => {
    const body = ImportPreRegistrationsBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const parsed = parsePreRegistrationCsv(body.data.csv);
    const created: PreRegistration[] = [];
    for (const line of parsed.records) {
      created.push(
        await control.addPreRegistration({
          ...(line.label ? { label: line.label } : {}),
          tags: line.tags,
          autoApprove: body.data.autoApprove,
          ...(line.machineId ? { machineId: line.machineId } : {}),
          ...(line.dmiSerial ? { dmiSerial: line.dmiSerial } : {}),
          ...(line.mac ? { mac: line.mac } : {}),
        }),
      );
    }
    fastify.log.info(
      { event: "prereg.import", created: created.length, errors: parsed.errors.length },
      "pre-registrations imported",
    );
    broadcaster.broadcast();
    return {
      ok: true,
      created: created.map((r) => PreRegistration.parse(r)),
      errors: parsed.errors,
    };
  });

  // DELETE /api/v1/pre-registrations/:id
  fastify.delete("/api/v1/pre-registrations/:id", async (request, reply) => {
    const params = PreRegistrationParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const ok = await control.removePreRegistration(params.data.id);
    if (!ok) return reply.code(404).send({ error: `unknown pre-registration: ${params.data.id}` });
    fastify.log.info({ event: "prereg.delete", id: params.data.id }, "pre-registration deleted");
    broadcaster.broadcast();
    return { ok: true };
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
    // POL-92 — and forget its live state (vitals ring, last heartbeat), so a re-enrolling box with
    // the same machine id never inherits the dead one's readings.
    presence.forgetMachine(params.data.machineId);

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

  // ── UEFI boot-order policy (POL-115) ──────────────────────────────────────────
  //
  // One fleet-wide boolean: may a running box put its own UEFI boot entry back at the head of
  // BootOrder when the firmware displaces it? Default OFF — a box reports the drift and writes
  // nothing. Nothing is pushed to boxes here: they read the policy on their own poll (GET
  // /boot/policy) right before they would act on it, so this route only records the operator's intent.

  // GET /api/v1/settings/boot-order -> BootOrderPolicy { reassert }
  fastify.get("/api/v1/settings/boot-order", async () => control.getBootOrderPolicy());

  // PUT /api/v1/settings/boot-order  { reassert }  -> BootOrderPolicy
  fastify.put("/api/v1/settings/boot-order", async (request, reply) => {
    const body = UpdateBootOrderPolicyBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const policy = await control.setBootOrderPolicy({ reassert: body.data.reassert });
    fastify.log.info({ event: "settings.boot-order.set", reassert: policy.reassert }, "boot-order policy updated");
    broadcaster.broadcast();
    return policy;
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

    // POL-100 — a member of a combined surface may be nudged around, but never OUT of its wall: a
    // wall whose members stop forming one contiguous region would span content across canvas nobody
    // is showing. Refuse the move (nothing is written); the operator splits the wall first.
    const existing = control.getPlacement(params.data.screenId);
    const broken = control.wallBrokenByPlacement(params.data.screenId, {
      x: body.data.x,
      y: body.data.y,
      w: body.data.w ?? existing?.w ?? 0,
      h: body.data.h ?? existing?.h ?? 0,
    });
    if (broken) {
      return reply.code(409).send({
        error: `moving ${params.data.screenId} there would break up ${broken.name ?? broken.id}, so split the surface first or drag the whole surface`,
        wallId: broken.id,
      });
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
      body.data.pack === true,
    );
    if (!result.ok) {
      const status =
        result.error === "unknown-mural" || result.error === "unknown-screen"
          ? 404
          : result.error === "already-combined"
            ? 409
            : 400;
      // POL-100 — a gappy selection is refused with a reason the console can act on (offer to pack).
      const message =
        result.error === "not-adjacent"
          ? "those screens don't sit next to each other — close the gaps (pack) or move them together"
          : result.error;
      return reply
        .code(status)
        .send({ error: result.error, message, screenId: result.screenId, wallId: result.wallId });
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
          error: `screen ${params.data.screenId} is a member of video wall ${result.wallId}, so set content on the wall`,
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

  // ── Clearing content + bulk canvas operations (POL-96) ───────────────────────
  //
  // "Show nothing" is an intent in its own right: DELETE the content and the screen falls back to the
  // idle splash (D39) instead of being handed some other page to display. The bulk route is the same
  // thing across a whole selection — one call, one fan-out, one broadcast, one activity line, so a
  // 20-screen assign costs the operator one interaction and the control plane one push per player.

  // DELETE /api/v1/screens/:screenId/content  -> clear one screen (409 if it's a wall member)
  fastify.delete("/api/v1/screens/:screenId/content", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.clearScreenContent(params.data.screenId);
    if (!result.ok) {
      if (result.error === "wall-member") {
        return reply.code(409).send({
          error: `screen ${params.data.screenId} is a member of video wall ${result.wallId}, so clear the wall`,
          wallId: result.wallId,
        });
      }
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    for (const slice of result.slices) pushRender(slice.screenId, slice);
    fastify.log.info(
      { event: "screen.content.clear", screenId: params.data.screenId, revision: control.state.revision },
      "screen content cleared",
    );
    broadcaster.broadcast(); // surfaceCount changed
    return { ok: true, revision: control.state.revision };
  });

  // DELETE /api/v1/walls/:wallId/content  -> clear a combined surface (the wall itself survives)
  fastify.delete("/api/v1/walls/:wallId/content", async (request, reply) => {
    const params = WallParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const result = await control.clearWallContent(params.data.wallId);
    if (!result.ok) {
      return reply.code(404).send({ error: `unknown wall: ${params.data.wallId}` });
    }

    for (const slice of result.slices) pushRender(slice.screenId, slice);
    fastify.log.info(
      { event: "wall.content.clear", wallId: params.data.wallId, revision: control.state.revision },
      "video wall content cleared",
    );
    broadcaster.broadcast();
    return { ok: true, revision: control.state.revision };
  });

  // POST /api/v1/content/assign  { screenIds, wallIds, content|null }  -> bulk assign OR bulk clear
  fastify.post("/api/v1/content/assign", async (request, reply) => {
    const body = BulkContentBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.applyBulkContent(
      { screenIds: body.data.screenIds, wallIds: body.data.wallIds },
      body.data.content,
    );
    if (!result.ok) {
      return reply.code(404).send({ error: `unknown content source: ${body.data.content?.sourceId}` });
    }

    for (const slice of result.slices) pushRender(slice.screenId, slice);
    fastify.log.info(
      {
        event: body.data.content ? "content.bulk-assign" : "content.bulk-clear",
        screens: result.applied.screens,
        walls: result.applied.walls,
        skipped: result.skipped.length,
        revision: control.state.revision,
      },
      body.data.content ? "content assigned in bulk" : "content cleared in bulk",
    );
    broadcaster.broadcast();
    return {
      ok: true,
      revision: control.state.revision,
      applied: result.applied,
      skipped: result.skipped,
    };
  });

  // POST /api/v1/screens/unplace  { screenIds }  -> return several screens to the tray in one call
  fastify.post("/api/v1/screens/unplace", async (request, reply) => {
    const body = UnplaceScreensBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.unplaceScreens(body.data.screenIds);
    for (const slice of result.slices) pushRender(slice.screenId, slice);
    fastify.log.info(
      { event: "screen.bulk-unplace", screenIds: result.unplaced },
      "screens unplaced in bulk",
    );
    broadcaster.broadcast();
    return { ok: true, unplaced: result.unplaced };
  });

  // POST /api/v1/murals/:muralId/move  { screenIds, wallIds, dx, dy }  -> atomic translate (POL-100)
  //
  // A whole combined surface drags as ONE unit (all members shift together) and a keyboard nudge
  // moves a whole selection — both land here, so the wall's adjacency is re-checked once, against the
  // finished geometry, and refused before a single row is written if it would break.
  fastify.post("/api/v1/murals/:muralId/move", async (request, reply) => {
    const params = MuralIdParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = MoveTargetsBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.moveTargets(
      params.data.muralId,
      { screenIds: body.data.screenIds, wallIds: body.data.wallIds },
      body.data.dx,
      body.data.dy,
    );
    if (!result.ok) {
      const status =
        result.error === "unknown-mural" ||
        result.error === "unknown-screen" ||
        result.error === "unknown-wall"
          ? 404
          : 409;
      return reply.code(status).send({
        error:
          result.error === "breaks-wall"
            ? `that move would break up the combined surface ${result.wallId} — split it first`
            : result.error,
        screenId: result.screenId,
        wallId: result.wallId,
      });
    }

    fastify.log.info(
      {
        event: "canvas.move",
        muralId: params.data.muralId,
        screens: body.data.screenIds,
        walls: body.data.wallIds,
        dx: body.data.dx,
        dy: body.data.dy,
      },
      "canvas selection moved",
    );
    // A rigid translation changes no slice (span offsets are union-relative) — no render push needed.
    broadcaster.broadcast();
    return { ok: true, placements: result.placements };
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
          error: `screen ${params.data.screenId} is a member of video wall ${result.wallId}, so zoom the wall`,
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

  // ── Audio (POL-112) ──────────────────────────────────────────────────────────
  //
  // Turn the sound on (and set its level) for the audible content on a screen or a combined surface.
  // Same in-place discipline as zoom: the surface keeps its id, so the player re-applies muted/volume
  // to the video element it already has — the clip does not restart. The one-unmuted-panel guard for
  // a wall is enforced in the control plane, not here, so no client can route around it.

  // PUT /api/v1/screens/:screenId/audio  { muted, volume }  (409 if wall member / not audible)
  fastify.put("/api/v1/screens/:screenId/audio", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SetAudioBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.setScreenAudio(params.data.screenId, body.data);
    if (!result.ok) {
      if (result.error === "wall-member") {
        return reply.code(409).send({
          error: `screen ${params.data.screenId} is a member of video wall ${result.wallId}, so set the wall's audio`,
          wallId: result.wallId,
        });
      }
      // no-content / not-audible are conflicts with the screen's current state, not bad requests.
      if (result.error === "no-content" || result.error === "not-audible") {
        return reply.code(409).send({ error: result.error, screenId: params.data.screenId });
      }
      return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
    }

    fastify.log.info(
      {
        event: "screen.audio",
        screenId: params.data.screenId,
        muted: body.data.muted,
        volume: body.data.volume,
        revision: control.state.revision,
      },
      "screen audio set",
    );
    for (const slice of result.slices) pushRender(slice.screenId, slice);
    broadcaster.broadcast(); // the console's content read-out carries the live audio
    return { ok: true, revision: control.state.revision, ...body.data };
  });

  // PUT /api/v1/walls/:wallId/audio  { muted, volume }  -> anchor panel sounds, the rest stay muted
  fastify.put("/api/v1/walls/:wallId/audio", async (request, reply) => {
    const params = WallParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SetAudioBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.setWallAudio(params.data.wallId, body.data);
    if (!result.ok) {
      if (result.error === "unknown-wall") {
        return reply.code(404).send({ error: `unknown wall: ${params.data.wallId}` });
      }
      return reply.code(409).send({ error: result.error, wallId: params.data.wallId });
    }

    fastify.log.info(
      {
        event: "wall.audio",
        wallId: params.data.wallId,
        muted: body.data.muted,
        volume: body.data.volume,
        screens: result.slices.map((s) => s.screenId),
        revision: control.state.revision,
      },
      "video wall audio set",
    );
    for (const slice of result.slices) pushRender(slice.screenId, slice);
    broadcaster.broadcast();
    return {
      ok: true,
      wallId: params.data.wallId,
      revision: control.state.revision,
      ...body.data,
      screens: result.slices.map((s) => s.screenId),
    };
  });

  // ── Playlist step zoom (POL-133) ─────────────────────────────────────────────
  //
  // Zoom ONE framed step of the playlist a screen/wall is showing, identified by the step's library
  // source. Same D62 model as page zoom — remembered against the (target, step source) pair — and the
  // same instant path: the push re-stamps the entry inside the SAME playlist surface (same id, same
  // startedAt), so the rotation keeps its position and a live step rescales without a reload.

  // PUT /api/v1/screens/:screenId/playlist-zoom  { sourceId, zoom }
  fastify.put("/api/v1/screens/:screenId/playlist-zoom", async (request, reply) => {
    const params = ScreenParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SetPlaylistEntryZoomBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.setScreenPlaylistEntryZoom(
      params.data.screenId,
      body.data.sourceId,
      body.data.zoom,
    );
    if (!result.ok) {
      if (result.error === "wall-member") {
        return reply.code(409).send({
          error: `screen ${params.data.screenId} is a member of video wall ${result.wallId}, so zoom the wall's step`,
          wallId: result.wallId,
        });
      }
      if (result.error === "unknown-screen") {
        return reply.code(404).send({ error: `unknown screen: ${params.data.screenId}` });
      }
      // no-content / not-zoomable / unknown-entry conflict with the screen's current state.
      return reply.code(409).send({ error: result.error, screenId: params.data.screenId });
    }

    fastify.log.info(
      {
        event: "screen.playlist-zoom",
        screenId: params.data.screenId,
        sourceId: body.data.sourceId,
        zoom: body.data.zoom,
        revision: control.state.revision,
      },
      "playlist step zoom set",
    );
    for (const slice of result.slices) pushRender(slice.screenId, slice);
    broadcaster.broadcast(); // the console's step read-out carries the live zoom
    return { ok: true, revision: control.state.revision, zoom: body.data.zoom };
  });

  // PUT /api/v1/walls/:wallId/playlist-zoom  { sourceId, zoom }  -> re-stamp on every member
  fastify.put("/api/v1/walls/:wallId/playlist-zoom", async (request, reply) => {
    const params = WallParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const body = SetPlaylistEntryZoomBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }

    const result = await control.setWallPlaylistEntryZoom(
      params.data.wallId,
      body.data.sourceId,
      body.data.zoom,
    );
    if (!result.ok) {
      if (result.error === "unknown-wall") {
        return reply.code(404).send({ error: `unknown wall: ${params.data.wallId}` });
      }
      return reply.code(409).send({ error: result.error, wallId: params.data.wallId });
    }

    fastify.log.info(
      {
        event: "wall.playlist-zoom",
        wallId: params.data.wallId,
        sourceId: body.data.sourceId,
        zoom: body.data.zoom,
        screens: result.slices.map((s) => s.screenId),
        revision: control.state.revision,
      },
      "video wall playlist step zoom set",
    );
    for (const slice of result.slices) pushRender(slice.screenId, slice);
    broadcaster.broadcast();
    return { ok: true, wallId: params.data.wallId, revision: control.state.revision, zoom: body.data.zoom };
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
    // POL-18 — probe the new source's framing in the background; a "blocked" verdict flips its
    // (auto) placement to a window when it is later assigned. Never blocks the operator's save.
    if ((source.kind === "web" || source.kind === "dashboard") && source.url) {
      void probeSourceFraming(source.id, source.url);
    }
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

    // POL-114 — a deck's dwell is the ONE authored field of a converted document, and it lives in the
    // media catalogue with the pages it times (not on the source row — nothing to migrate). Write it
    // first, then let the ordinary update path re-resolve + push, so every wall showing the deck picks
    // the new page timing up on the same instant path as any other content edit.
    const { dwellSeconds, ...patch } = body.data;
    if (dwellSeconds !== undefined) {
      const source = control.getContentSource(params.data.id);
      if (!source) return reply.code(404).send({ error: `unknown content source: ${params.data.id}` });
      if (source.kind !== "deck") {
        return reply.code(400).send({ error: "only a deck has a per-page dwell time" });
      }
      const mediaId = mediaIdFromUrl(source.url ?? "");
      const written = mediaId ? await media.setDeckDwell(mediaId, dwellSeconds) : false;
      if (!written) {
        return reply.code(409).send({ error: "this deck's converted pages are no longer on disk" });
      }
      const slices = await control.refreshSource(params.data.id);
      for (const slice of slices) pushRender(slice.screenId, slice);
      broadcaster.broadcast();
      if (Object.keys(patch).length === 0) {
        const updated = control.getContentSource(params.data.id);
        return { ok: true, source: updated, screens: slices.map((s) => s.screenId) };
      }
    }

    const result = await control.updateContentSource(params.data.id, patch);
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
          .send({ error: "a page source needs a definition and every other kind needs a url" });
      }
      // POL-34 — playlist authoring errors (bad item reference / missing duration).
      return reply.code(400).send({ error: playlistItemErrorDetail(result.error, result.itemSourceId) });
    }

    // Re-resolved every screen/wall showing this source — push the new render to each affected player.
    for (const slice of result.slices) pushRender(slice.screenId, slice);

    // POL-18 — a URL change dropped the stored framing verdict (it described the old address);
    // re-probe the new one in the background.
    if (
      (result.source.kind === "web" || result.source.kind === "dashboard") &&
      result.source.url &&
      result.source.framing === undefined
    ) {
      void probeSourceFraming(result.source.id, result.source.url);
    }

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

  // POST /api/v1/content-sources/:id/probe-framing  -> re-run the framing probe NOW (POL-18) and
  // return the verdict. Awaited on purpose: the console's "re-check" and the e2e suite both want a
  // deterministic answer, and a single header fetch is cheap.
  fastify.post("/api/v1/content-sources/:id/probe-framing", async (request, reply) => {
    const params = ContentSourceParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }
    const source = control.getContentSource(params.data.id);
    if (!source) {
      return reply.code(404).send({ error: `unknown content source: ${params.data.id}` });
    }
    if ((source.kind !== "web" && source.kind !== "dashboard") || !source.url) {
      return reply.code(400).send({ error: "only web/dashboard sources have framing to probe" });
    }
    await probeSourceFraming(source.id, source.url);
    const probed = control.getContentSource(params.data.id);
    return { ok: true, framing: probed?.framing ?? "unknown" };
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

    // POL-94 — the source is gone; so is anything the players ever said about it.
    health.forgetSource(params.data.id);

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

  /**
   * POL-114 — run one document upload through the converter, OFF the request that accepted it.
   *
   * Everything an operator sees while this runs comes from the job (pushed on `admin/state`): the
   * status, the pages landing one by one, and — on failure — the sentence to act on. The deck source
   * is created ONLY when pages actually exist; a failed conversion unlinks the upload, so a document
   * that cannot be shown never becomes a library row (the POL-109 rule, applied to documents).
   */
  async function convertDocument(
    jobId: string,
    mediaId: string,
    deckName: string,
    format: string,
    originalName: string,
  ): Promise<void> {
    const jobs = mediaConfig.documentJobs;
    const record = media.get(mediaId);
    if (!record) {
      jobs.update(jobId, { status: "failed", error: "The upload disappeared before it was converted." });
      broadcaster.broadcast();
      return;
    }

    try {
      const result = await ingestDocument(mediaConfig.converter, media, record, mediaConfig.publicBase, {
        onProgress: (pagesDone) => {
          jobs.update(jobId, { status: "rendering", pagesDone });
          broadcaster.broadcast();
        },
      });

      if (!result.ok) {
        await media.deleteById(mediaId);
        jobs.update(jobId, { status: "failed", error: result.message.slice(0, 400) });
        activity.push("warn", `Couldn't convert ${originalName} — ${result.message}`);
        fastify.log.info(
          { event: "document.failed", jobId, mediaId, format, error: result.message },
          "document conversion failed",
        );
        broadcaster.broadcast();
        return;
      }

      const url = `${mediaConfig.publicBase}/media/${mediaId}`;
      const created = await control.createContentSource({ name: deckName, kind: "deck", url });
      if (!created.ok) {
        await media.deleteById(mediaId);
        jobs.update(jobId, { status: "failed", error: "The converted deck could not be added to the library." });
        broadcaster.broadcast();
        return;
      }
      await media.attachSource(mediaId, created.source.id);

      jobs.update(jobId, {
        status: "ready",
        pagesDone: result.pageCount,
        pageCount: result.pageCount,
        sourceId: created.source.id,
      });
      activity.push(
        "good",
        `Converted ${originalName} → ${result.pageCount} page${result.pageCount === 1 ? "" : "s"} (${documentFormatLabel(format)})`,
      );
      fastify.log.info(
        {
          event: "document.converted",
          jobId,
          mediaId,
          sourceId: created.source.id,
          format,
          pages: result.pageCount,
          dwellSeconds: DEFAULT_DWELL_SECONDS,
        },
        "document converted to a deck",
      );
      broadcaster.broadcast();
    } catch (err) {
      // A converter must not throw for a bad file, but a disk error can still land here — the upload
      // must not be left half-converted in the catalogue.
      await media.deleteById(mediaId);
      jobs.update(jobId, {
        status: "failed",
        error: "Converting this document failed unexpectedly. Try exporting it to PDF and uploading that.",
      });
      fastify.log.error({ event: "document.error", jobId, mediaId, err }, "document conversion threw");
      broadcaster.broadcast();
    }
  }

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

    const docExt = documentExtForMime(data.mimetype);
    const kind = docExt ? null : kindForMime(data.mimetype);
    if (!kind && !docExt) {
      // Drain the rejected stream so busboy/the connection isn't left hanging on an unconsumed file.
      data.file.resume();
      return reply.code(415).send({ error: `unsupported media type: ${data.mimetype}` });
    }

    const originalName = data.filename && data.filename.length > 0 ? data.filename : "upload";
    const providedName = readField(data.fields, "name");
    const name = (providedName && providedName.trim().length > 0 ? providedName.trim() : originalName)
      .slice(0, 120);

    // ── POL-114 — a DOCUMENT takes the deck pipeline, not the media one ───────────────────────────
    // Refuse BEFORE a byte lands if this server cannot convert: a document is not content until it
    // has been converted, so storing it would create a library row that provably cannot paint (D132).
    if (docExt) {
      if (!(await mediaConfig.converter.available())) {
        data.file.resume();
        fastify.log.info(
          { event: "document.refused", reason: "no-converter", mime: data.mimetype, name: originalName },
          "document upload refused — no converter on this server",
        );
        return reply.code(415).send({ error: NO_CONVERTER_MESSAGE, reason: "no-converter" });
      }

      let docRecord;
      try {
        docRecord = await media.save(data.file, data.mimetype, originalName, mediaConfig.maxBytes);
      } catch (err) {
        if (err instanceof MediaTooLargeError || isFileTooLargeError(err)) {
          return reply.code(413).send({ error: "file too large" });
        }
        throw err;
      }

      const deckName = providedName?.trim()
        ? providedName.trim().slice(0, 120)
        : deckDisplayName(originalName, docExt);
      const job = mediaConfig.documentJobs.start(deckName);

      // Conversion runs OFF the request (a 60-slide deck is tens of seconds; an HTTP request held
      // that long meets a proxy's read timeout). Progress rides the admin/state broadcast.
      void convertDocument(job.id, docRecord.id, deckName, docExt, originalName);

      fastify.log.info(
        { event: "document.accepted", jobId: job.id, mediaId: docRecord.id, mime: data.mimetype, format: docExt },
        "document accepted for conversion",
      );
      broadcaster.broadcast();
      return reply.code(202).send({ ok: true, job });
    }

    // Not a document → the media (image/video) path. `kind` is non-null here by the guard above; the
    // check keeps that provable rather than asserted.
    if (!kind) {
      data.file.resume();
      return reply.code(415).send({ error: `unsupported media type: ${data.mimetype}` });
    }

    let record;
    try {
      record = await media.save(data.file, data.mimetype, originalName, mediaConfig.maxBytes);
    } catch (err) {
      if (err instanceof MediaTooLargeError || isFileTooLargeError(err)) {
        return reply.code(413).send({ error: "file too large" });
      }
      throw err;
    }

    // POL-109 — INGEST, before the file is allowed to become a library source: probe it, make its
    // poster, and refuse a codec/container the wall browser provably cannot decode. A rejected upload
    // is unlinked and never appears in the library — the whole point is that "it's in your library"
    // means "it will show on a wall". A server with no toolchain accepts and warns (D129).
    const ingest = await ingestUpload(mediaConfig.prober, media, record, mediaConfig.publicBase);
    if (!ingest.ok) {
      await media.deleteById(record.id);
      fastify.log.info(
        {
          event: "media.rejected",
          reason: ingest.reason,
          mime: record.mime,
          size: record.size,
          name: originalName,
        },
        "media upload rejected by ingest",
      );
      activity.push("warn", `Upload rejected: ${name} — ${ingest.message}`);
      return reply.code(415).send({ error: ingest.message, reason: ingest.reason });
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
        probed: ingest.metadata.probed,
        ...(ingest.metadata.durationSeconds !== undefined
          ? { durationSeconds: ingest.metadata.durationSeconds }
          : {}),
        ...(ingest.metadata.videoCodec !== undefined ? { videoCodec: ingest.metadata.videoCodec } : {}),
      },
      "media uploaded",
    );
    broadcaster.broadcast();
    // The created source is re-read so it carries the ingest decoration (`media`) the console renders.
    const decorated = control.getContentSource(source.id) ?? source;
    return reply.code(201).send({
      ok: true,
      source: decorated,
      ...(ingest.metadata.warning ? { warning: ingest.metadata.warning } : {}),
    });
  });

  // ── Phase 3d routes (scenes) ──────────────────────────────────────────────────
  //
  // A scene is a named SNAPSHOT of a mural's whole wall. Saving/renaming/deleting a scene is registry
  // metadata → those routes broadcast a fresh admin/state (which now carries scenes[]). APPLY re-lays
  // the wall (split/place/move + combine + content), so it ALSO pushes `server/render` to every
  // affected member's player (the instant path). WHEN a scene plays lives in `schedule-routes.ts`
  // (POL-89): dayparts + schedules, resolved by a ticker that calls this same apply path.

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

  // GET /api/v1/scenes/:id/diff  -> the APPLY PREVIEW (POL-95): what applying this scene would change
  // on its mural (content / placement / combine / split / cleared), computed server-side against the
  // LIVE wall. Read-only — it changes nothing, and it never gates the apply (which stays one click).
  fastify.get("/api/v1/scenes/:id/diff", async (request, reply) => {
    const params = SceneParams.safeParse(request.params);
    if (!params.success) {
      return reply.code(400).send({ error: "invalid params", issues: params.error.issues });
    }

    const diff = control.diffScene(params.data.id);
    if (!diff) {
      return reply.code(404).send({ error: `unknown scene: ${params.data.id}` });
    }
    return reply.send({ ok: true, diff });
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

  // PATCH /api/v1/scenes/:id  { name? }  -> rename a saved scene
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
      { event: "scene.update", sceneId: scene.id, name: scene.name },
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
