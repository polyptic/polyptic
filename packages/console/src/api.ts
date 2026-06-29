/**
 * REST client for the control plane (http://localhost:8080/api/v1).
 *
 * Every outgoing body is validated against the shared contract's zod schema before it leaves the
 * browser — the same parse-at-the-edge discipline used on the wire (see @polyptic/protocol). The
 * route paths follow the existing server conventions (POST /screens/:id/rename, /ident) extended for
 * Phase 3 murals & placement and Phase 3b combined surfaces (walls + content).
 */
import {
  CombineScreensBody,
  CreateContentSourceBody,
  CreateMuralBody,
  CreateSceneBody,
  IdentBody,
  PlaceScreenBody,
  RenameMuralBody,
  RenameScreenBody,
  SetContentBody,
  UpdateContentSourceBody,
  UpdateSceneBody,
} from "@polyptic/protocol";
import type { ContentSource, Scene } from "@polyptic/protocol";

const BASE = "http://localhost:8080/api/v1";

/** A non-2xx REST response, with the parsed error payload (if any) for diagnostics. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly payload?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function send<T = unknown>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    let payload: unknown;
    try {
      payload = await res.json();
    } catch {
      payload = undefined;
    }
    throw new ApiError(res.status, `${method} ${path} -> ${res.status}`, payload);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : (undefined as T));
}

// ── Murals ────────────────────────────────────────────────────────────────────

/** POST /api/v1/murals { name } — create a new mural. */
export function createMural(name: string): Promise<unknown> {
  return send("POST", "/murals", CreateMuralBody.parse({ name }));
}

/** POST /api/v1/murals/:muralId/rename { name }. */
export function renameMural(muralId: string, name: string): Promise<unknown> {
  return send("POST", `/murals/${encodeURIComponent(muralId)}/rename`, RenameMuralBody.parse({ name }));
}

/** DELETE /api/v1/murals/:muralId. */
export function deleteMural(muralId: string): Promise<unknown> {
  return send("DELETE", `/murals/${encodeURIComponent(muralId)}`);
}

// ── Placement ───────────────────────────────────────────────────────────────

/** PUT /api/v1/screens/:screenId/placement { muralId, x, y, w?, h? } — place or move on a mural. */
export function placeScreen(screenId: string, body: PlaceScreenBody): Promise<unknown> {
  return send("PUT", `/screens/${encodeURIComponent(screenId)}/placement`, PlaceScreenBody.parse(body));
}

/** DELETE /api/v1/screens/:screenId/placement — return the screen to the unplaced tray. */
export function unplaceScreen(screenId: string): Promise<unknown> {
  return send("DELETE", `/screens/${encodeURIComponent(screenId)}/placement`);
}

// ── Screen registry / content (existing Phase 2 routes) ──────────────────────

/** POST /api/v1/screens/:screenId/rename { friendlyName }. */
export function renameScreen(screenId: string, friendlyName: string): Promise<unknown> {
  return send(
    "POST",
    `/screens/${encodeURIComponent(screenId)}/rename`,
    RenameScreenBody.parse({ friendlyName }),
  );
}

/** POST /api/v1/screens/:screenId/ident { on, ttlMs? } — flash the screen on the wall. */
export function identScreen(screenId: string, body: IdentBody): Promise<unknown> {
  return send("POST", `/screens/${encodeURIComponent(screenId)}/ident`, IdentBody.parse(body));
}

/**
 * PUT /api/v1/screens/:screenId/content — point one screen at content. The body is EITHER a library
 * source (`{ sourceId }`) or an ad-hoc link (`{ url }`, an ad-hoc web surface, the Phase-3b path).
 * Exactly one of the two (enforced by SetContentBody's refinement).
 */
export function setScreenContent(screenId: string, body: SetContentBody): Promise<unknown> {
  return send(
    "PUT",
    `/screens/${encodeURIComponent(screenId)}/content`,
    SetContentBody.parse(body),
  );
}

// ── Combined surfaces / video walls (Phase 3b) ───────────────────────────────

/** POST /api/v1/murals/:muralId/walls { muralId, memberScreenIds } — combine ≥2 adjacent screens. */
export function combineScreens(muralId: string, memberScreenIds: string[]): Promise<unknown> {
  return send(
    "POST",
    `/murals/${encodeURIComponent(muralId)}/walls`,
    CombineScreensBody.parse({ muralId, memberScreenIds }),
  );
}

/** DELETE /api/v1/walls/:wallId — split a combined surface back into individual screens. */
export function splitWall(wallId: string): Promise<unknown> {
  return send("DELETE", `/walls/${encodeURIComponent(wallId)}`);
}

/**
 * PUT /api/v1/walls/:wallId/content — assign content that spans across the whole combined surface.
 * The body is EITHER a library source (`{ sourceId }`) or an ad-hoc link (`{ url }`, the Phase-3b
 * spanning-web path that the 3b walls e2e exercises). Exactly one of the two.
 */
export function setWallContent(wallId: string, body: SetContentBody): Promise<unknown> {
  return send(
    "PUT",
    `/walls/${encodeURIComponent(wallId)}/content`,
    SetContentBody.parse(body),
  );
}

/** POST /api/v1/walls/:wallId/ident { on, ttlMs? } — flash every panel of a combined surface. */
export function identWall(wallId: string, body: IdentBody): Promise<unknown> {
  return send("POST", `/walls/${encodeURIComponent(wallId)}/ident`, IdentBody.parse(body));
}

// ── Content library (Phase 3c) ───────────────────────────────────────────────

/** POST /api/v1/content-sources { name, kind, url } — create a reusable library source. */
export function createContentSource(body: CreateContentSourceBody): Promise<ContentSource> {
  return send("POST", "/content-sources", CreateContentSourceBody.parse(body));
}

/** PATCH /api/v1/content-sources/:sourceId { name?, kind?, url? } — partial update of a source. */
export function updateContentSource(
  sourceId: string,
  body: UpdateContentSourceBody,
): Promise<ContentSource> {
  return send(
    "PATCH",
    `/content-sources/${encodeURIComponent(sourceId)}`,
    UpdateContentSourceBody.parse(body),
  );
}

/** DELETE /api/v1/content-sources/:sourceId — remove a source from the library. */
export function deleteContentSource(sourceId: string): Promise<unknown> {
  return send("DELETE", `/content-sources/${encodeURIComponent(sourceId)}`);
}

// ── Scenes (Phase 3d) ─────────────────────────────────────────────────────────

/**
 * POST /api/v1/scenes { name, muralId } — save the CURRENT state of a mural as a new scene. The
 * server snapshots placements + walls + per-screen/per-wall content itself; the client only names it.
 */
export async function createScene(body: CreateSceneBody): Promise<Scene> {
  const res = await send<{ scene: Scene }>("POST", "/scenes", CreateSceneBody.parse(body));
  return res.scene;
}

/**
 * POST /api/v1/scenes/:sceneId/apply — re-apply a saved scene to its mural (re-lays the wall,
 * re-groups walls, re-assigns content, sets it active). The server pushes the new slices live.
 */
export function applyScene(sceneId: string): Promise<unknown> {
  return send("POST", `/scenes/${encodeURIComponent(sceneId)}/apply`);
}

/**
 * PATCH /api/v1/scenes/:sceneId { name?, scheduleAt? } — rename a scene and/or set its illustrative
 * schedule time (HH:MM, or null to clear). The time is stored, not fired (illustrative only).
 */
export async function updateScene(sceneId: string, body: UpdateSceneBody): Promise<Scene> {
  const res = await send<{ scene: Scene }>("PATCH", `/scenes/${encodeURIComponent(sceneId)}`, UpdateSceneBody.parse(body));
  return res.scene;
}

/** DELETE /api/v1/scenes/:sceneId — delete a saved scene. */
export function deleteScene(sceneId: string): Promise<unknown> {
  return send("DELETE", `/scenes/${encodeURIComponent(sceneId)}`);
}
