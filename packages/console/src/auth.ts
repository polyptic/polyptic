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
  ApiToken,
  ApiTokenCreated,
  AuthUser,
  ChangePasswordBody,
  CreateApiTokenBody,
  DisplaySettings,
  EnrollmentInfo,
  HttpsInfo,
  LoginBody,
  ImageUpdateInfo,
  NetbootInfo,
  UpdateImageSettingsBody,
} from "@polyptic/protocol";
import type {
  ApiToken as ApiTokenT,
  ApiTokenCreated as ApiTokenCreatedT,
  ChangePasswordBody as ChangePasswordBodyT,
  CreateApiTokenBody as CreateApiTokenBodyT,
  DisplaySettings as DisplaySettingsT,
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

// ── Scoped API tokens (POL-102/D97) ──────────────────────────────────────────
// The credential an external system (CI, an incident tool, a cron) presents as
// `Authorization: Bearer <secret>` instead of scraping a login. The secret exists in exactly one
// response — the create call — and is never retrievable again: the server stores only its sha256.
// These routes are OPERATOR-ONLY (a token cannot mint another token), so they ride the session
// cookie like every other Settings call.

/** GET /api/v1/settings/api-tokens → every token, newest first (safe view — never a secret). */
export async function listApiTokens(): Promise<ApiTokenT[]> {
  const raw = await send<{ tokens?: unknown }>("GET", `${BASE_SETTINGS}/api-tokens`);
  const list = Array.isArray(raw?.tokens) ? raw.tokens : [];
  return list.map((token) => ApiToken.parse(token));
}

/**
 * POST /api/v1/settings/api-tokens { name, scopes, expiresInDays? } → { token, secret }. THE ONLY
 * time the secret exists — show it once, let the operator copy it, and never store it in the app.
 */
export async function createApiToken(body: CreateApiTokenBodyT): Promise<ApiTokenCreatedT> {
  const raw = await send<unknown>("POST", `${BASE_SETTINGS}/api-tokens`, CreateApiTokenBody.parse(body));
  return ApiTokenCreated.parse(raw);
}

/** DELETE /api/v1/settings/api-tokens/:id → revoke it; the next request carrying it is refused. */
export async function revokeApiToken(id: string): Promise<void> {
  await send<unknown>("DELETE", `${BASE_SETTINGS}/api-tokens/${encodeURIComponent(id)}`);
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
