/**
 * Auth + Settings REST routes (Phase 3f / D29).
 *
 *   POST /api/v1/auth/login            LoginBody → verify → mint session → Set-Cookie → {ok,user}.
 *                                      401 generic on bad creds (no enumeration); 429 on lockout.
 *   POST /api/v1/auth/logout           revoke the session + clear the cookie. Always 200 (public).
 *   GET  /api/v1/auth/me               {user} for a valid session, else 401 (self-reports; public).
 *   POST /api/v1/auth/change-password  ChangePasswordBody → verify current → re-hash; re-issues the
 *                                      session cookie (all old sessions are revoked). 401/400.
 *   GET  /api/v1/settings/enrollment            EnrollmentInfo {mode, token} (auth-gated).
 *   POST /api/v1/settings/enrollment/regenerate new gated token → EnrollmentInfo (auth-gated).
 *
 * Generic OIDC sign-in (POL-106 / D101) hangs off the SAME seam — a verified ID token mints the same
 * session cookie as a local login, so nothing downstream changes:
 *
 *   GET  /api/v1/auth/providers        AuthProviders {local, oidc|null} — which buttons to draw (public).
 *   GET  /api/v1/auth/oidc/start       302 → the IdP (Authorization Code + PKCE); parks the
 *                                      state/nonce/verifier in a signed httpOnly cookie (public).
 *   GET  /api/v1/auth/oidc/callback    state → code exchange (PKCE) → JWKS-verified ID token → session
 *                                      cookie → 302 to the console. Any lie = a flat 401 (public).
 *
 * The global gate (registered in index.ts) protects every /api/v1/** route EXCEPT login, logout, me
 * and those three (which authenticate themselves). NEVER log a password or hash.
 */
import { AuthProviders, ChangePasswordBody, EnrollmentInfo, LoginBody } from "@polyptic/protocol";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import { SESSION_COOKIE } from "./auth-local";
import type { AuthService } from "./auth-local";
import type { Enrollment } from "./enroll";
import { OIDC_SSO_COOKIE, OIDC_START_PATH, OIDC_TX_COOKIE, OIDC_TX_TTL_SEC } from "./oidc";
import type { OidcService, OidcTransaction } from "./oidc";

export function registerAuthRoutes(
  fastify: FastifyInstance,
  auth: AuthService,
  enrollment: Enrollment,
  /** POL-106: the OIDC engine, or undefined when no IdP is configured (the default). */
  oidc?: OidcService,
): void {
  /** Read + unsign a cookie, returning its raw value (null when absent or tampered with). */
  const readSigned = (request: FastifyRequest, name: string): string | null => {
    const raw = request.cookies?.[name];
    if (!raw) return null;
    const unsigned = fastify.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value == null) return null;
    return unsigned.value;
  };

  // GET /api/v1/auth/providers  -> which sign-in methods this deployment offers (public, pre-session).
  // With no OIDC config this reports `{ local: true, oidc: null }` — the console then renders exactly
  // the pre-POL-106 sign-in page.
  fastify.get("/api/v1/auth/providers", async () =>
    AuthProviders.parse({
      local: true,
      oidc: oidc ? { name: oidc.config.providerName, startUrl: OIDC_START_PATH } : null,
    }),
  );

  // GET /api/v1/auth/oidc/start  -> 302 to the IdP (Authorization Code + PKCE). Public: it IS the
  // sign-in. The state/nonce/verifier ride back to us in a short-lived signed httpOnly cookie, so a
  // multi-replica deployment can service the callback on any pod.
  fastify.get(OIDC_START_PATH, async (request, reply) => {
    if (!oidc) return reply.code(404).send({ error: "oidc is not configured" });
    try {
      const { url, tx } = await oidc.authorizationRequest();
      reply.setCookie(OIDC_TX_COOKIE, JSON.stringify(tx), {
        path: "/",
        httpOnly: true,
        sameSite: "lax", // the IdP redirects the browser BACK to us — lax lets the cookie ride along
        signed: true,
        secure: auth.config.secureCookies,
        maxAge: OIDC_TX_TTL_SEC,
      });
      fastify.log.info({ event: "oidc.start" }, "starting an OIDC sign-in");
      return reply.redirect(url, 302);
    } catch (err) {
      // Discovery is the usual suspect (IdP down / wrong issuer) — say so in the log, not the body.
      fastify.log.error({ event: "oidc.start.failed", err: String(err) }, "could not start OIDC sign-in");
      return reply.code(503).send({ error: "identity provider unavailable" });
    }
  });

  // GET /api/v1/auth/oidc/callback?code&state  -> verify EVERYTHING, then mint the SAME session cookie
  // the local login mints. Public (it authenticates itself). Every rejection is a flat 401 with no
  // cookie: the reason is logged for the operator, never handed to the caller.
  fastify.get("/api/v1/auth/oidc/callback", async (request, reply) => {
    if (!oidc) return reply.code(404).send({ error: "oidc is not configured" });
    const query = (request.query ?? {}) as Record<string, string | undefined>;

    const deny = (reason: string, detail?: string): FastifyReply => {
      fastify.log.warn({ event: "oidc.callback.denied", reason, detail }, "OIDC sign-in rejected");
      reply.clearCookie(OIDC_TX_COOKIE, { path: "/" });
      return reply.code(401).send({ error: "sign-in failed", reason });
    };

    // The IdP can also refuse (consent declined, unassigned user, …) — it says so in ?error=.
    if (query.error) return deny("provider-error", query.error);

    let tx: OidcTransaction | null = null;
    const rawTx = readSigned(request, OIDC_TX_COOKIE);
    if (rawTx) {
      try {
        tx = JSON.parse(rawTx) as OidcTransaction;
      } catch {
        tx = null;
      }
    }

    let result;
    try {
      result = await oidc.complete({ code: query.code, state: query.state, tx });
    } catch (err) {
      fastify.log.error({ event: "oidc.callback.error", err: String(err) }, "OIDC callback blew up");
      return deny("provider-error", String(err));
    }
    if (!result.ok) return deny(result.reason, result.detail);

    // Verified. From here on it is an ordinary Polyptic session — nothing downstream knows or cares
    // that an IdP was involved.
    const { user, token } = await auth.loginFederated(result.identity.email);
    reply.clearCookie(OIDC_TX_COOKIE, { path: "/" });
    reply.setCookie(SESSION_COOKIE, token, auth.cookieOptions());
    // A marker (signed, httpOnly, no identity in it) so logout can offer RP-initiated logout for an
    // SSO session without persisting ID tokens or adding a column to the sessions table.
    if (oidc.config.rpLogout) {
      reply.setCookie(OIDC_SSO_COOKIE, "1", { ...auth.cookieOptions(), signed: true });
    }
    fastify.log.info(
      { event: "auth.login.oidc", userId: user.id, subject: result.identity.subject },
      "operator signed in via the identity provider",
    );
    return reply.redirect(oidc.config.postLoginUrl, 302);
  });

  // POST /api/v1/auth/login  { email, password }
  fastify.post("/api/v1/auth/login", async (request, reply) => {
    const body = LoginBody.safeParse(request.body);
    if (!body.success) {
      // Generic 401 (not 400) so a malformed body can't be used to probe behaviour differently.
      return reply.code(401).send({ error: "invalid email or password" });
    }

    const result = await auth.login(body.data.email, body.data.password, request.ip);
    if (!result.ok && result.reason === "locked") {
      reply.header("retry-after", String(result.retryAfterSec));
      return reply.code(429).send({
        error: "too many failed attempts — try again later",
        retryAfterSec: result.retryAfterSec,
      });
    }
    if (!result.ok) {
      return reply.code(401).send({ error: "invalid email or password" });
    }

    reply.setCookie(SESSION_COOKIE, result.token, auth.cookieOptions());
    fastify.log.info({ event: "auth.login", userId: result.user.id }, "operator signed in");
    return { ok: true, user: result.user };
  });

  // POST /api/v1/auth/logout  -> revoke session + clear cookie (idempotent; always 200)
  // POL-106: when the session came from the IdP AND the operator opted into RP-initiated logout, the
  // response also carries the IdP's end-session URL; the console navigates there so the sign-out
  // reaches the provider too. The LOCAL session is destroyed either way — an IdP that is down, or a
  // local (break-glass) session, must never leave an operator signed in here.
  fastify.post("/api/v1/auth/logout", async (request, reply) => {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (raw) {
      const unsigned = fastify.unsignCookie(raw);
      if (unsigned.valid && unsigned.value != null) {
        await auth.destroySession(unsigned.value);
      }
    }
    const wasSso = readSigned(request, OIDC_SSO_COOKIE) === "1";
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    reply.clearCookie(OIDC_SSO_COOKIE, { path: "/" });
    const endSessionUrl = oidc && wasSso ? await oidc.endSessionUrl() : null;
    return endSessionUrl ? { ok: true, endSessionUrl } : { ok: true };
  });

  // GET /api/v1/auth/me  -> {user} or 401 (self-reports; never forced by the gate)
  fastify.get("/api/v1/auth/me", async (request, reply) => {
    // When auth is disabled (tests/dev), mirror open-mode: report a synthetic operator so the console
    // proceeds without a sign-in. No session is involved.
    if (!auth.enabled) {
      return { user: { id: "auth-disabled", email: "operator@polyptic.local" } };
    }
    const user = await auth.verifyRequest(request);
    if (!user) return reply.code(401).send({ error: "unauthorized" });
    return { user };
  });

  // POST /api/v1/auth/change-password  { currentPassword, newPassword(min8) }
  fastify.post("/api/v1/auth/change-password", async (request, reply) => {
    const body = ChangePasswordBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    // The gate guarantees a session when auth is enabled; when disabled there is no operator to change.
    const current = request.authUser;
    if (!current) {
      return reply.code(401).send({ error: "unauthorized" });
    }

    const ok = await auth.changePassword(current.id, body.data.currentPassword, body.data.newPassword);
    if (!ok) {
      return reply.code(401).send({ error: "current password is incorrect" });
    }

    // changePassword revoked every session (incl. this one) — re-issue a fresh cookie so the operator
    // stays signed in on this device while any other sessions are forced to re-authenticate.
    const token = await auth.issueSession(current.id);
    reply.setCookie(SESSION_COOKIE, token, auth.cookieOptions());
    fastify.log.info({ event: "auth.password.changed", userId: current.id }, "operator changed password");
    return { ok: true };
  });

  // GET /api/v1/settings/enrollment  -> EnrollmentInfo {mode, token}
  fastify.get("/api/v1/settings/enrollment", async () => {
    const info = await auth.enrollmentInfo();
    return EnrollmentInfo.parse(info);
  });

  // POST /api/v1/settings/enrollment/regenerate  -> new gated token → EnrollmentInfo
  fastify.post("/api/v1/settings/enrollment/regenerate", async () => {
    const boot = await auth.regenerateEnrollment();
    // Make the new token live for the agent WS path immediately (switches the deployment to gated).
    enrollment.setToken(boot.token ?? undefined);
    fastify.log.info({ event: "enrollment.regenerate", mode: boot.mode }, "enrollment token regenerated");
    return EnrollmentInfo.parse({ mode: boot.mode, token: boot.token });
  });
}
