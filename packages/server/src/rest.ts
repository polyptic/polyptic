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
 */
import { z } from "zod";

import {
  CombineScreensBody,
  CreateContentSourceBody,
  CreateMuralBody,
  CreateSceneBody,
  IdentBody,
  PlaceScreenBody,
  RenameMuralBody,
  RenameScreenBody,
  ServerToAgentApply,
  ServerToAgentRejected,
  ServerToPlayerIdent,
  ServerToPlayerRender,
  SetContentBody,
  Surface,
  UpdateContentSourceBody,
  UpdateSceneBody,
} from "@polyptic/protocol";
import type { FastifyInstance } from "fastify";
import type { Screen, ScreenSlice } from "@polyptic/protocol";

import { MediaTooLargeError, isFileTooLargeError, kindForMime, readField } from "./media";

import type { CaptureCoordinator } from "./capture";
import type { ControlPlane } from "./state";
import type { AgentHub, PlayerHub } from "./hub";
import type { AdminBroadcaster } from "./admin";
import type { MediaStore } from "./media";

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
): void {
  function pushRender(screenId: string, slice: ScreenSlice): number {
    const message = ServerToPlayerRender.parse({
      t: "server/render",
      revision: control.state.revision,
      slice,
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

    const result = await control.combineScreens(params.data.muralId, body.data.memberScreenIds);
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

    const source = await control.createContentSource(body.data);
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
    if (!result) {
      return reply.code(404).send({ error: `unknown content source: ${params.data.id}` });
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
    const source = await control.createContentSource({ name, kind, url });
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
