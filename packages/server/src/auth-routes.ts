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
 *   GET    /api/v1/settings/api-tokens          POL-102 — the scoped API tokens (safe view).
 *   POST   /api/v1/settings/api-tokens          mint one → {token, secret}; the secret is shown ONCE.
 *   DELETE /api/v1/settings/api-tokens/:id      revoke one (delete the row).
 *
 * The global gate (registered in index.ts) protects every /api/v1/** route EXCEPT login, logout and
 * me (which authenticate themselves). NEVER log a password or hash.
 */
import { ApiTokenCreated, ChangePasswordBody, CreateApiTokenBody, EnrollmentInfo, LoginBody } from "@polyptic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { SESSION_COOKIE } from "./auth-local";
import type { AuthService } from "./auth-local";
import type { ApiTokenService } from "./api-tokens";
import type { Enrollment } from "./enroll";

const ApiTokenParams = z.object({ id: z.string().min(1) });

export function registerAuthRoutes(
  fastify: FastifyInstance,
  auth: AuthService,
  enrollment: Enrollment,
  apiTokens: ApiTokenService,
): void {
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
  fastify.post("/api/v1/auth/logout", async (request, reply) => {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (raw) {
      const unsigned = fastify.unsignCookie(raw);
      if (unsigned.valid && unsigned.value != null) {
        await auth.destroySession(unsigned.value);
      }
    }
    reply.clearCookie(SESSION_COOKIE, { path: "/" });
    return { ok: true };
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

  // ── Scoped API tokens (POL-102/D97) ─────────────────────────────────────────
  // OPERATOR-ONLY by construction: these paths are absent from the token allow-list (api-tokens.ts),
  // so the gate refuses a bearer token here with a 403 no matter what scopes it holds — a token can
  // never mint another token. The secret is returned exactly ONCE, by the create call, and is never
  // logged (the log line below carries the token's public name + prefix only).

  // GET /api/v1/settings/api-tokens  -> { tokens: ApiToken[] } (safe view — no secrets exist to leak)
  fastify.get("/api/v1/settings/api-tokens", async () => {
    return { tokens: await apiTokens.list() };
  });

  // POST /api/v1/settings/api-tokens  { name, scopes, expiresInDays? } -> ApiTokenCreated {token, secret}
  fastify.post("/api/v1/settings/api-tokens", async (request, reply) => {
    const body = CreateApiTokenBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    // With auth disabled (dev) there is no operator to attribute the mint to — record it as such.
    const createdBy = request.authUser?.id ?? "auth-disabled";
    const minted = await apiTokens.mint(
      body.data.name,
      body.data.scopes,
      createdBy,
      body.data.expiresInDays,
    );
    fastify.log.info(
      {
        event: "api.token.created",
        tokenId: minted.token.id,
        token: minted.token.prefix,
        scopes: minted.token.scopes,
        createdBy,
      },
      `minted API token "${minted.token.name}"`,
    );
    return reply.code(201).send(ApiTokenCreated.parse(minted));
  });

  // DELETE /api/v1/settings/api-tokens/:id  -> revoke (the row is deleted; 404 if unknown)
  fastify.delete("/api/v1/settings/api-tokens/:id", async (request, reply) => {
    const params = ApiTokenParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid id" });
    const revoked = await apiTokens.revoke(params.data.id);
    if (!revoked) return reply.code(404).send({ error: "unknown api token" });
    fastify.log.info({ event: "api.token.revoked", tokenId: params.data.id }, "API token revoked");
    return { ok: true };
  });
}
