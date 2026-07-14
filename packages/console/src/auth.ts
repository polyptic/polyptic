/**
 * Operator session + settings endpoints (Phase 3f — D29 real local accounts).
 *
 * Replaces the Phase-3a localStorage stub. The session itself lives ONLY in an httpOnly, signed,
 * sameSite session cookie set by the server — the browser never sees, stores, or can script the
 * session id (that's the whole point: no token in JS, no plaintext anywhere). These helpers just
 * drive the auth/settings REST surface; the cookie rides along automatically via the shared
 * transport's `credentials: "include"`. The reactive "who am I" lives in the Pinia store.
 *
 * Every response is zod-validated at the edge against the shared contract, same discipline as the
 * wire. No secret (password or hash) is ever sent back by these routes or logged here.
 */
import {
  AuthUser,
  BackupDocument,
  ChangePasswordBody,
  DisplaySettings,
  EnrollmentInfo,
  HttpsInfo,
  ImportResult,
  LoginBody,
  ImageUpdateInfo,
  NetbootInfo,
  UpdateImageSettingsBody,
} from "@polyptic/protocol";
import type {
  BackupDocument as BackupDocumentT,
  ChangePasswordBody as ChangePasswordBodyT,
  DisplaySettings as DisplaySettingsT,
  ImportMode as ImportModeT,
  ImportResult as ImportResultT,
  LoginBody as LoginBodyT,
} from "@polyptic/protocol";

import { ApiError, apiUrl, send } from "./api";

const BASE_AUTH = "/auth";
const BASE_SETTINGS = "/settings";

/** The server may return the user bare or wrapped as `{ user }`; accept either, then validate. */
function unwrapUser(raw: unknown): AuthUser {
  const candidate =
    raw && typeof raw === "object" && "user" in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).user
      : raw;
  return AuthUser.parse(candidate);
}

/** Likewise tolerate `{ enrollment }` wrapping for the enrollment-info routes. */
function unwrapEnrollment(raw: unknown): EnrollmentInfo {
  const candidate =
    raw && typeof raw === "object" && "enrollment" in (raw as Record<string, unknown>)
      ? (raw as Record<string, unknown>).enrollment
      : raw;
  return EnrollmentInfo.parse(candidate);
}

/**
 * POST /api/v1/auth/login { email, password } → the signed-in AuthUser (the server also sets the
 * session cookie). A 401 here is an expected "wrong credentials" outcome and a 429 is a lockout —
 * both are handled by the sign-in form, so we suppress the global session-expired redirect.
 */
export async function login(body: LoginBodyT): Promise<AuthUser> {
  const raw = await send<unknown>("POST", `${BASE_AUTH}/login`, LoginBody.parse(body), {
    suppressAuthRedirect: true,
  });
  return unwrapUser(raw);
}

/** POST /api/v1/auth/logout — revoke the server-side session and clear the cookie. */
export async function logout(): Promise<void> {
  await send<unknown>("POST", `${BASE_AUTH}/logout`);
}

/**
 * GET /api/v1/auth/me → the current AuthUser, or a 401 (self-reporting) when not signed in. This is
 * the router guard's session probe; its 401 is expected, so it never triggers the global redirect.
 */
export async function fetchMe(): Promise<AuthUser> {
  const raw = await send<unknown>("GET", `${BASE_AUTH}/me`, undefined, {
    suppressAuthRedirect: true,
  });
  return unwrapUser(raw);
}

/**
 * POST /api/v1/auth/change-password { currentPassword, newPassword } — rotate the operator's
 * password (newPassword min 8, enforced by the contract). Never echoes either value back.
 */
export async function changePassword(body: ChangePasswordBodyT): Promise<void> {
  await send<unknown>("POST", `${BASE_AUTH}/change-password`, ChangePasswordBody.parse(body));
}

/** GET /api/v1/settings/enrollment → open-mode note or the gated bootstrap token (operator-only). */
export async function getEnrollment(): Promise<EnrollmentInfo> {
  const raw = await send<unknown>("GET", `${BASE_SETTINGS}/enrollment`);
  return unwrapEnrollment(raw);
}

/** POST /api/v1/settings/enrollment/regenerate → mint a fresh gated token, returning the new info. */
export async function regenerateEnrollment(): Promise<EnrollmentInfo> {
  const raw = await send<unknown>("POST", `${BASE_SETTINGS}/enrollment/regenerate`);
  return unwrapEnrollment(raw);
}

/**
 * GET /api/v1/settings/netboot → where a diskless box HTTP-boots from (control-plane base + the
 * `/boot/grub.cfg` boot config URL) and the optional boot-medium download (POL-33). Secret-free, the
 * enrolment token the boot flow bakes in lives in the enrollment card, not here.
 */
export async function getNetboot(): Promise<NetbootInfo> {
  const raw = await send<unknown>("GET", `${BASE_SETTINGS}/netboot`);
  return NetbootInfo.parse(raw);
}

/**
 * GET /api/v1/settings/https → how THIS listener serves TLS (POL-70/D89): off (plain HTTP / behind
 * an ingress), provided (operator cert files) or self-signed (the deployment's own persisted CA,
 * downloadable below). Drives the Settings ▸ HTTPS card.
 */
export async function getHttpsInfo(): Promise<HttpsInfo> {
  const raw = await send<unknown>("GET", `${BASE_SETTINGS}/https`);
  return HttpsInfo.parse(raw);
}

/**
 * GET /api/v1/settings/https/ca.crt → the self-signed CA certificate as a Blob (PEM). Bypasses
 * `send` (file, not JSON) but rides the same session cookie; the caller anchors it into a download.
 */
export async function downloadHttpsCa(): Promise<Blob> {
  const res = await fetch(apiUrl(`${BASE_SETTINGS}/https/ca.crt`), { credentials: "include" });
  if (!res.ok) throw new ApiError(res.status, `GET ${BASE_SETTINGS}/https/ca.crt -> ${res.status}`);
  return res.blob();
}

/** GET /api/v1/settings/image → schedule + urgency + last rebuild + published images (POL-41). */
export async function getImageUpdates(): Promise<ImageUpdateInfo> {
  const raw = await send<unknown>("GET", `${BASE_SETTINGS}/image`);
  return ImageUpdateInfo.parse(raw);
}

/** PUT /api/v1/settings/image { scheduleEnabled?, scheduleTime?, urgent? } (POL-41). */
export async function updateImageSettings(patch: UpdateImageSettingsBody): Promise<ImageUpdateInfo> {
  const raw = await send<unknown>("PUT", `${BASE_SETTINGS}/image`, patch);
  return ImageUpdateInfo.parse(raw);
}

/** POST /api/v1/settings/image/rebuild → kick a rebuild now: the daily refresh (default) or the
 *  weekly full rebuild from the base ISO (POL-41/POL-43). */
export async function rebuildImageNow(kind: "refresh" | "full" = "refresh"): Promise<ImageUpdateInfo> {
  const raw = await send<unknown>("POST", `${BASE_SETTINGS}/image/rebuild`, { kind });
  return ImageUpdateInfo.parse(raw);
}

/** POST /api/v1/settings/image/activate → serve a retained build (POL-45). Fleet-wide: boxes on a
 *  different image reboot into it per the roll-out policy, so an older build is a rollback. */
export async function activateImage(arch: "arm64" | "amd64", imageId: string): Promise<ImageUpdateInfo> {
  const raw = await send<unknown>("POST", `${BASE_SETTINGS}/image/activate`, { arch, imageId });
  return ImageUpdateInfo.parse(raw);
}

/** GET /api/v1/settings/display → the current fleet-wide display settings (badge toggle) (POL-6). */
export async function getDisplaySettings(): Promise<DisplaySettingsT> {
  const raw = await send<unknown>("GET", `${BASE_SETTINGS}/display`);
  return DisplaySettings.parse(raw);
}

/** PUT /api/v1/settings/display { showBadges } → the applied settings (POL-6). */
export async function updateDisplaySettings(showBadges: boolean): Promise<DisplaySettingsT> {
  const raw = await send<unknown>("PUT", `${BASE_SETTINGS}/display`, { showBadges });
  return DisplaySettings.parse(raw);
}

// ── Backup / restore (POL-113) ─────────────────────────────────────────────────

/**
 * GET /api/v1/export → the whole declarative state as one portable document (murals, screens, walls,
 * scenes, the content library incl. page definitions and playlists, credential profiles WITHOUT their
 * secrets, settings, and a media manifest). Validated at the edge like every other response.
 */
export async function exportBackup(): Promise<BackupDocumentT> {
  const raw = await send<unknown>("GET", "/export");
  return BackupDocument.parse(raw);
}

/**
 * POST /api/v1/import → restore. `dryRun` computes the plan (adds/updates/deletes) and touches
 * NOTHING; the same call with `dryRun: false` runs exactly that plan. `replace` additionally deletes
 * what the document does not mention — the destructive option, named as such in the UI.
 */
export async function importBackup(
  document: BackupDocumentT,
  options: { mode: ImportModeT; dryRun: boolean },
): Promise<ImportResultT> {
  const raw = await send<unknown>("POST", "/import", {
    document,
    mode: options.mode,
    dryRun: options.dryRun,
  });
  return ImportResult.parse(raw);
}
