/**
 * REST client for the control plane (http://localhost:8080/api/v1).
 *
 * Every outgoing body is validated against the shared contract's zod schema before it leaves the
 * browser — the same parse-at-the-edge discipline used on the wire (see @polyptic/protocol). The
 * route paths follow the existing server conventions (POST /screens/:id/rename, /ident) extended for
 * Phase 3 murals & placement and Phase 3b combined surfaces (walls + content).
 */
import {
  CastArmBody,
  CombineScreensBody,
  CreateContentSourceBody,
  CreateCredentialProfileBody,
  CreateMuralBody,
  CreateSceneBody,
  IdentBody,
  InspectBody,
  PlaceScreenBody,
  RenameMuralBody,
  RenameScreenBody,
  RenameVideoWallBody,
  SetContentBody,
  SetZoomBody,
  UpdateContentSourceBody,
  UpdateCredentialProfileBody,
  UpdateSceneBody,
} from "@polyptic/protocol";
import type {
  ContentSource,
  CredentialProfileTestResult,
  CredentialProfileView,
  DocumentJob,
  Scene,
  VideoWall,
} from "@polyptic/protocol";

/** Dev runs the console on Vite (:5175) against the server on :8080 (CORS_ORIGIN covers it).
 *  A production build is served BY the server itself (single image, D28/D31), so the API is
 *  same-origin — hardcoding localhost:8080 there breaks any containerized/port-forwarded deploy
 *  (found live: the in-cluster console called the operator's :8080 dev stack instead of its pod). */
const BASE = import.meta.env.DEV ? "http://localhost:8080/api/v1" : `${window.location.origin}/api/v1`;

/** Ungated GET /healthz — lives at the SERVER root (not /api/v1). The sign-in footer shows the
 *  deployed version from it (baked into the image via POLYPTIC_VERSION at release build). */
export async function serverHealth(): Promise<{ version?: string; revision?: string }> {
  const res = await fetch(BASE.replace(/\/api\/v1$/, "/healthz"));
  if (!res.ok) throw new Error(`GET /healthz -> ${res.status}`);
  return (await res.json()) as { version?: string; revision?: string };
}

/** Absolute URL of a screen's remote-DevTools entry (POL-67). Opened in a NEW TAB (not fetched),
 *  so it must be absolute against the API origin — in dev the console runs on Vite while the API
 *  (and the DevTools proxy) live on the server. The route redirects into Chrome's own DevTools
 *  frontend, proxied over the agent WS. */
export function devtoolsUrl(screenId: string): string {
  return `${BASE}/screens/${encodeURIComponent(screenId)}/devtools`;
}

/** Absolute URL of an API path (e.g. "/settings/https/ca.crt") against the API origin — for the
 *  rare non-JSON fetch (file downloads) that bypasses `send` but must still hit the right host in
 *  dev (console on Vite :5175, API on :8080). */
export function apiUrl(path: string): string {
  return `${BASE}${path}`;
}

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

/** Per-request transport knobs. */
export interface SendOptions {
  /**
   * Suppress the global "session expired" redirect for THIS request even on a 401. Set by the auth
   * probes (login / me) whose 401 is an expected, locally-handled outcome — not a dropped session.
   */
  suppressAuthRedirect?: boolean;
}

// A single app-wide hook fired when an authenticated request comes back 401 (the server-side session
// expired or was revoked mid-use). The router registers it to bounce the operator to /signin. Kept at
// module scope so every api call shares one handler without threading it through call sites.
let onUnauthorized: (() => void) | null = null;

/** Register (or clear, with null) the handler invoked when a guarded request 401s. */
export function setUnauthorizedHandler(handler: (() => void) | null): void {
  onUnauthorized = handler;
}

/**
 * The shared REST transport. Every request carries the session cookie (`credentials: "include"`) so
 * the server's auth preHandler sees it — same-origin in prod, cross-origin to :8080 in dev (the
 * server must allow credentialed CORS from the Vite origin for that to work). A 401 on a guarded
 * request trips the global unauthorized handler (→ /signin) unless the caller opts out.
 */
export async function send<T = unknown>(
  method: string,
  path: string,
  body?: unknown,
  opts: SendOptions = {},
): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    credentials: "include",
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
    if (res.status === 401 && !opts.suppressAuthRedirect) onUnauthorized?.();
    throw new ApiError(res.status, `${method} ${path} -> ${res.status}`, payload);
  }

  if (res.status === 204) return undefined as T;
  const text = await res.text();
  return (text ? (JSON.parse(text) as T) : (undefined as T));
}

// ── Live previews / thumbnails (Phase 5) ─────────────────────────────────────

/**
 * Fetch the latest capture for a screen as a browser object URL, or null when there's nothing to
 * show. This is the live-preview path: the server holds the most recent `agent/thumbnail` frame the
 * agent captured for the screen's machine; GET /api/v1/screens/:id/thumbnail returns it as raw image
 * bytes (200) or 204 when no capture is available yet (or the machine can't capture).
 *
 * It deliberately does NOT go through `send()` — that helper JSON-parses the body, whereas a
 * thumbnail is binary. We `fetch` directly with `credentials: "include"` so the operator's session
 * cookie rides along (a bare `<img src>` would NOT send the cookie cross-origin to :8080 in dev,
 * which is exactly why the preview has to be fetched-to-blob and handed back as an object URL).
 *
 * The caller OWNS the returned URL and MUST `URL.revokeObjectURL()` it once the next frame replaces
 * it (or the preview unmounts) — otherwise every refresh leaks a blob. A non-2xx other than 204 is
 * treated as "no preview" (returns null); a 401 additionally trips the global unauthorized handler so
 * an expired session still bounces the operator to /signin, consistent with `send()`.
 */
export async function fetchThumbnail(screenId: string): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/screens/${encodeURIComponent(screenId)}/thumbnail`, {
      method: "GET",
      credentials: "include",
    });
  } catch {
    // Network/CORS failure — treat as "no preview right now" rather than throwing into the poll loop.
    return null;
  }

  if (res.status === 204) return null;
  if (!res.ok) {
    if (res.status === 401) onUnauthorized?.();
    return null;
  }

  const blob = await res.blob();
  if (blob.size === 0) return null;
  return URL.createObjectURL(blob);
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

// ── Machines (enrollment, Phase 2b) ──────────────────────────────────────────

/**
 * POST /api/v1/machines/:machineId/approve — admit a pending machine. The server promotes it to
 * `approved`, registers its reported outputs as screens, and broadcasts the new admin/state.
 */
export function approveMachine(machineId: string): Promise<unknown> {
  return send("POST", `/machines/${encodeURIComponent(machineId)}/approve`);
}

/**
 * POST /api/v1/machines/:machineId/reject { reason? } — deny a pending machine, or revoke an already
 * approved one. The optional reason is sent only when supplied (the server treats it as advisory).
 */
export function rejectMachine(machineId: string, reason?: string): Promise<unknown> {
  const trimmed = reason?.trim();
  return send(
    "POST",
    `/machines/${encodeURIComponent(machineId)}/reject`,
    trimmed ? { reason: trimmed } : undefined,
  );
}

/** POST /api/v1/machines/:machineId/ident { on, ttlMs? } — flash every screen the machine drives. */
export function identMachine(machineId: string, body: IdentBody): Promise<unknown> {
  return send("POST", `/machines/${encodeURIComponent(machineId)}/ident`, IdentBody.parse(body));
}

/**
 * POST /api/v1/machines/:machineId/reboot — power-cycle one box (POL-55). Rejects with an ApiError on
 * 409 when the machine is offline or not approved, so the caller can tell the operator what happened.
 */
export function rebootMachine(machineId: string): Promise<unknown> {
  return send("POST", `/machines/${encodeURIComponent(machineId)}/reboot`);
}

/** Arm or disarm a box for the remote shell (POL-59). */
export function setMachineShell(machineId: string, enabled: boolean): Promise<unknown> {
  return send("POST", `/machines/${encodeURIComponent(machineId)}/shell`, { enabled });
}

/**
 * DELETE /api/v1/machines/:machineId — permanently forget a machine (POL-14). Unlike reject/revoke,
 * this deletes the machine, all its screens, their placement + content, and its credential; the server
 * closes its agent socket. A removed machine must re-enrol to return.
 */
export function deleteMachine(machineId: string): Promise<unknown> {
  return send("DELETE", `/machines/${encodeURIComponent(machineId)}`);
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
 * POST /api/v1/screens/:screenId/inspect { on } — show/hide the kiosk browser's Web Inspector ON that
 * panel (POL-50). Answers 202: the request was delivered to the agent, not applied — the screen's
 * `inspecting` flag (or `inspectError`) arrives later on an admin/state broadcast, once the box acks.
 * Rejects with an ApiError on 409 (machine offline or not approved).
 */
export function inspectScreen(screenId: string, body: InspectBody): Promise<unknown> {
  return send("POST", `/screens/${encodeURIComponent(screenId)}/inspect`, InspectBody.parse(body));
}

/** POST /api/v1/screens/:screenId/cast { enabled } — enable/disable casting (AirPlay) on one screen
 *  (POL-119). Persistent, no TTL; disabling kills the receiver and any live session immediately. */
export function setScreenCast(screenId: string, enabled: boolean): Promise<unknown> {
  return send("POST", `/screens/${encodeURIComponent(screenId)}/cast`, CastArmBody.parse({ enabled }));
}

/**
 * DELETE /api/v1/screens/:screenId — permanently forget a single screen (POL-14). Dissolves any
 * combined surface it belonged to and clears its player. If the screen's machine is still connected
 * and reports this output, it reappears on the machine's next reconnect.
 */
export function deleteScreen(screenId: string): Promise<unknown> {
  return send("DELETE", `/screens/${encodeURIComponent(screenId)}`);
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

/** PUT /api/v1/screens/:screenId/zoom { zoom } — zoom the page this screen is framing (POL-57). The
 *  server remembers it for this (screen, page) pair, so the page returns at this zoom next time. */
export function setScreenZoom(screenId: string, zoom: number): Promise<unknown> {
  return send("PUT", `/screens/${encodeURIComponent(screenId)}/zoom`, SetZoomBody.parse({ zoom }));
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

/** PUT /api/v1/walls/:wallId/zoom { zoom } — zoom the page spanning a combined surface (POL-57).
 *  Every member takes the same zoom, so the wall stays one continuous page. */
export function setWallZoom(wallId: string, zoom: number): Promise<unknown> {
  return send("PUT", `/walls/${encodeURIComponent(wallId)}/zoom`, SetZoomBody.parse({ zoom }));
}

/** POST /api/v1/walls/:wallId/ident { on, ttlMs? } — flash every panel of a combined surface. */
export function identWall(wallId: string, body: IdentBody): Promise<unknown> {
  return send("POST", `/walls/${encodeURIComponent(wallId)}/ident`, IdentBody.parse(body));
}

/**
 * POST /api/v1/walls/:wallId/rename { name } — give a combined surface an operator-chosen name. The
 * server persists it (additive: the column is nullable) and re-broadcasts; we return the updated
 * VideoWall when the response carries one (`{ wall }`) so an optimistic caller can reconcile.
 */
export async function renameVideoWall(wallId: string, name: string): Promise<VideoWall | undefined> {
  const res = await send<{ wall?: VideoWall } | undefined>(
    "POST",
    `/walls/${encodeURIComponent(wallId)}/rename`,
    RenameVideoWallBody.parse({ name }),
  );
  return res?.wall;
}

// ── Content library (Phase 3c) ───────────────────────────────────────────────

/** POST /api/v1/content-sources { name, kind, url|definition } — create a reusable library source.
 *  Returns the created source (the Studio needs the server-assigned id to keep saving to it). */
export async function createContentSource(body: CreateContentSourceBody): Promise<ContentSource> {
  const res = await send<{ source: ContentSource }>(
    "POST",
    "/content-sources",
    CreateContentSourceBody.parse(body),
  );
  return res.source;
}

/** PATCH /api/v1/content-sources/:sourceId — partial update of a source. Returns the updated source. */
export async function updateContentSource(
  sourceId: string,
  body: UpdateContentSourceBody,
): Promise<ContentSource> {
  const res = await send<{ source: ContentSource }>(
    "PATCH",
    `/content-sources/${encodeURIComponent(sourceId)}`,
    UpdateContentSourceBody.parse(body),
  );
  return res.source;
}

/** DELETE /api/v1/content-sources/:sourceId — remove a source from the library. */
export function deleteContentSource(sourceId: string): Promise<unknown> {
  return send("DELETE", `/content-sources/${encodeURIComponent(sourceId)}`);
}

// ── Credential profiles (POL-24) ─────────────────────────────────────────────
// Centrally-held OAuth clients for content auth. The clientSecret crosses the wire INBOUND ONLY —
// every response carries a CredentialProfileView (config + live token health, never the secret).

/** POST /api/v1/credential-profiles — create a profile; the server fetches its first token at once. */
export async function createCredentialProfile(
  body: CreateCredentialProfileBody,
): Promise<CredentialProfileView | undefined> {
  const res = await send<{ profile?: CredentialProfileView }>(
    "POST",
    "/credential-profiles",
    CreateCredentialProfileBody.parse(body),
  );
  return res?.profile;
}

/** PATCH /api/v1/credential-profiles/:id — partial update (clientSecret omitted = unchanged). */
export async function updateCredentialProfile(
  profileId: string,
  body: UpdateCredentialProfileBody,
): Promise<CredentialProfileView | undefined> {
  const res = await send<{ profile?: CredentialProfileView }>(
    "PATCH",
    `/credential-profiles/${encodeURIComponent(profileId)}`,
    UpdateCredentialProfileBody.parse(body),
  );
  return res?.profile;
}

/** DELETE /api/v1/credential-profiles/:id — 409 (in-use) while any source still references it. */
export function deleteCredentialProfile(profileId: string): Promise<unknown> {
  return send("DELETE", `/credential-profiles/${encodeURIComponent(profileId)}`);
}

/** POST /api/v1/credential-profiles/:id/test — force a token exchange NOW; the IdP's live answer. */
export function testCredentialProfile(profileId: string): Promise<CredentialProfileTestResult> {
  return send("POST", `/credential-profiles/${encodeURIComponent(profileId)}/test`) as Promise<CredentialProfileTestResult>;
}

// ── Media uploads (Phase 7) ──────────────────────────────────────────────────

/** What an upload came back as: a finished media source (image/video, POL-109), or — for a DOCUMENT
 *  (POL-114) — a conversion JOB to watch, because a 60-slide deck is not a request/response. */
export type UploadResult =
  | { source: ContentSource; warning?: string }
  | { job: DocumentJob };

/**
 * POST /api/v1/media — upload an image or video file to the server's disk volume. The server saves
 * it under MEDIA_DIR, records it, and mints a ContentSource (kind image|video) whose `url` is an
 * absolute URL to the ungated GET /media/:id serve route, so a player on another host can fetch it.
 * It then returns `{ source, warning? }`; we hand back both — POL-109's ingest may ACCEPT a file and
 * still have something to say about it (e.g. this server has no media toolchain, so nothing about the
 * file could be checked). A REJECTED file never gets here: it comes back as a 415 whose `error` is the
 * operator-facing sentence (the codec named, the fix stated), which the store surfaces verbatim.
 *
 * This deliberately does NOT go through `send()`: the body is multipart/form-data (a FormData with
 * the file + optional display name), not JSON, and we want upload PROGRESS, which `fetch` can't
 * report on a request body. So we drive an XMLHttpRequest directly — `withCredentials = true` is the
 * XHR equivalent of `credentials: "include"`, carrying the operator's session cookie to the GATED
 * upload route (same-origin in prod, credentialed cross-origin to :8080 in dev).
 *
 * A non-2xx rejects with an `ApiError` carrying the status + parsed JSON payload (so callers can
 * special-case 413 "too large" / 415 "unsupported type"); a 401 additionally trips the global
 * unauthorized handler (→ /signin), consistent with `send()`. `onProgress` (0..1), when supplied, is
 * called as the bytes go up — and once more with 1 on completion.
 */
export function uploadMedia(
  file: File,
  name?: string,
  onProgress?: (fraction: number) => void,
): Promise<UploadResult> {
  const form = new FormData();
  // The server generates the stored id + derives the extension from the validated mime; the original
  // filename is sent only as a fallback display name (never used to build the on-disk path).
  // Append the `name` text field BEFORE the file: multipart parsers (busboy) stream parts in order
  // and the server reads `name` while consuming the file stream — a `name` after the file is missed.
  const trimmed = name?.trim();
  if (trimmed) form.append("name", trimmed);
  form.append("file", file, file.name);

  return new Promise<UploadResult>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${BASE}/media`);
    xhr.withCredentials = true;
    xhr.responseType = "text";

    if (onProgress && xhr.upload) {
      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable && ev.total > 0) onProgress(ev.loaded / ev.total);
      };
    }

    xhr.onload = () => {
      const raw = xhr.responseText;
      let payload: unknown;
      try {
        payload = raw ? JSON.parse(raw) : undefined;
      } catch {
        payload = undefined;
      }

      if (xhr.status >= 200 && xhr.status < 300) {
        const body = payload as
          | { source?: ContentSource; warning?: string; job?: DocumentJob }
          | undefined;
        // POL-114 — a DOCUMENT answers 202 with a conversion JOB, not a finished source: the deck
        // appears in the library (via admin/state) when the pages have actually been rendered, and
        // the job's progress rides the same broadcast in the meantime.
        if (body?.job) {
          onProgress?.(1);
          resolve({ job: body.job });
          return;
        }
        const source = body?.source;
        if (source) {
          onProgress?.(1);
          resolve(body?.warning ? { source, warning: body.warning } : { source });
        } else {
          reject(new ApiError(xhr.status, "POST /media -> missing source in response", payload));
        }
        return;
      }

      if (xhr.status === 401) onUnauthorized?.();
      reject(new ApiError(xhr.status, `POST /media -> ${xhr.status}`, payload));
    };

    xhr.onerror = () => reject(new ApiError(0, "POST /media -> network error"));
    xhr.onabort = () => reject(new ApiError(0, "POST /media -> aborted"));

    xhr.send(form);
  });
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
