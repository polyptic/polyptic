/**
 * Auth + Settings REST routes (Phase 3f / D29).
 *
 *   POST /api/v1/auth/login            LoginBody → verify → mint session → Set-Cookie → {ok,user}.
 *                                      401 generic on bad creds (no enumeration); 429 on lockout.
 *   POST /api/v1/auth/logout           revoke the session + clear the cookie. Always 200 (public).
 *   GET  /api/v1/auth/me               {user} for a valid session, else 401 (self-reports; public).
 *   POST /api/v1/auth/change-password  ChangePasswordBody → verify current → re-hash; re-issues the
 *                                      session cookie (all old sessions are revoked). 401/400.
 *   GET    /api/v1/settings/enrollment                EnrollmentInfo {mode, token, tokens[]} (gated).
 *   POST   /api/v1/settings/enrollment/regenerate     rotate the bake token (grace window) → EnrollmentInfo.
 *   POST   /api/v1/settings/enrollment/tokens         POL-104 — cut a batch token.
 *   POST   /api/v1/settings/enrollment/tokens/:id/rotate   successor + grace window on the old secret.
 *   POST   /api/v1/settings/enrollment/tokens/:id/revoke   block NEW enrolments (running boxes untouched).
 *   POST   /api/v1/settings/enrollment/tokens/:id/bake     make it the token new boot media carry.
 *   DELETE /api/v1/settings/enrollment/tokens/:id          forget it.
 *
 *   GET    /api/v1/operators       list the accounts (POL-107; admin-only).
 *   POST   /api/v1/operators       CreateOperatorBody → 201 {operator}; 409 on a duplicate email.
 *   PATCH  /api/v1/operators/:id   UpdateOperatorBody → change role and/or reset the password.
 *   DELETE /api/v1/operators/:id   remove the account + its sessions.
 *
 * The global gate (registered in index.ts) protects every /api/v1/** route EXCEPT login, logout and
 * me (which authenticate themselves), and (POL-107) enforces the per-route ROLE policy in `roles.ts`
 * — the operator routes above are admin-only by that policy's deny-by-default, not by a check here.
 * NEVER log a password or hash — and never log a token SECRET either (POL-104): the routes below log
 * ids and names, never the value itself.
 */
import {
  ChangePasswordBody,
  CreateEnrollmentTokenBody,
  CreateOperatorBody,
  EnrollmentInfo,
  LoginBody,
  Operator,
  RotateEnrollmentTokenBody,
  UpdateOperatorBody,
} from "@polyptic/protocol";
import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { SESSION_COOKIE } from "./auth-local";
import type { AuthService } from "./auth-local";
import { toTokenView } from "./enroll";
import type { Enrollment } from "./enroll";

const TokenParams = z.object({ id: z.string().min(1) });

/** The grace window a plain "regenerate"/rotate leaves the old secret alive for. A day is long enough
 *  for the boxes that are powered off overnight, short enough that a rotation still means something. */
const DEFAULT_GRACE_HOURS = 24;

export function registerAuthRoutes(
  fastify: FastifyInstance,
  auth: AuthService,
  enrollment: Enrollment,
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
    // proceeds without a sign-in. No session is involved — and it reports `admin`, because with the
    // gate off the server enforces nothing: an open stack must not render a half-disabled console.
    if (!auth.enabled) {
      return { user: { id: "auth-disabled", email: "operator@polyptic.local", role: "admin" } };
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

  /** The enrolment surface, straight off the live policy: the mode, the BAKE token's secret (the
   *  pre-POL-104 scalar the wizard still reads) and every token. */
  function enrollmentInfo(): EnrollmentInfo {
    const tokens = enrollment.list();
    return EnrollmentInfo.parse({
      mode: enrollment.open ? "open" : "gated",
      token: enrollment.currentToken ?? null,
      tokens: tokens.map(toTokenView),
    });
  }

  // GET /api/v1/settings/enrollment  -> EnrollmentInfo {mode, token, tokens[]}
  fastify.get("/api/v1/settings/enrollment", async () => enrollmentInfo());

  // POST /api/v1/settings/enrollment/regenerate  -> EnrollmentInfo
  //
  // The pre-POL-104 action, kept (the cold-start wizard calls it) but no longer destructive. On an OPEN
  // deployment it cuts the FIRST token (switching to gated). On a gated one it ROTATES the bake token
  // with the default 24 h grace window — the old secret keeps enrolling for a day, so the media already
  // flashed (and any boot in flight) still land. It used to replace the one token outright, which
  // stranded every stick in the estate the moment an operator clicked it.
  fastify.post("/api/v1/settings/enrollment/regenerate", async () => {
    const bake = enrollment.bakeToken();
    if (!bake) {
      await enrollment.createToken({ name: "Enrolment token", bake: true });
      fastify.log.info({ event: "enrollment.regenerate", mode: "gated" }, "enrolment gated — first token cut");
      return enrollmentInfo();
    }
    const rotated = await enrollment.rotateToken(bake.id, DEFAULT_GRACE_HOURS);
    fastify.log.info(
      {
        event: "enrollment.regenerate",
        mode: "gated",
        rotatedFrom: bake.id,
        newTokenId: rotated?.next.id,
        graceHours: DEFAULT_GRACE_HOURS,
      },
      "enrolment token rotated — the old secret keeps enrolling until its grace window closes",
    );
    return enrollmentInfo();
  });

  // ── Operator accounts (POL-107). ADMIN-ONLY — enforced by the gate's role policy (these paths are
  // absent from ROUTE_POLICY, so they fall through to its deny-by-default `admin`), NOT by anything
  // here. The handlers below may therefore assume the caller is an admin. ──

  // GET /api/v1/operators -> Operator[] (never a hash)
  fastify.get("/api/v1/operators", async () => {
    const operators = await auth.listOperators();
    return { operators: operators.map((o) => Operator.parse(o)) };
  });

  // POST /api/v1/operators { email, password(min8), role }
  fastify.post("/api/v1/operators", async (request, reply) => {
    const body = CreateOperatorBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const created = await auth.createOperator(body.data.email, body.data.password, body.data.role);
    if (created === "duplicate") {
      return reply.code(409).send({ error: "an operator with that email already exists" });
    }
    // Log the id + role; NEVER the password.
    fastify.log.info(
      { event: "auth.operator.created", userId: created.id, role: created.role },
      "operator account created",
    );
    return reply.code(201).send({ operator: Operator.parse(created) });
  });

  // PATCH /api/v1/operators/:id { role?, password? } — change role and/or reset the password
  fastify.patch<{ Params: { id: string } }>("/api/v1/operators/:id", async (request, reply) => {
    const body = UpdateOperatorBody.safeParse(request.body);
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const target = request.params.id;
    // An admin demoting ITSELF would 403 on its very next call — refuse rather than strand the console.
    if (body.data.role && body.data.role !== "admin" && request.authUser?.id === target) {
      return reply.code(409).send({ error: "you cannot change your own role" });
    }
    const updated = await auth.updateOperator(target, body.data);
    if (updated === "not-found") return reply.code(404).send({ error: "no such operator" });
    if (updated === "last-admin") {
      return reply.code(409).send({ error: "the last admin cannot be demoted" });
    }
    fastify.log.info(
      { event: "auth.operator.updated", userId: updated.id, role: updated.role, passwordReset: Boolean(body.data.password) },
      "operator account updated",
    );
    return { operator: Operator.parse(updated) };
  });

  // DELETE /api/v1/operators/:id
  fastify.delete<{ Params: { id: string } }>("/api/v1/operators/:id", async (request, reply) => {
    const target = request.params.id;
    if (request.authUser?.id === target) {
      return reply.code(409).send({ error: "you cannot delete your own account" });
    }
    const result = await auth.deleteOperator(target);
    if (result === "not-found") return reply.code(404).send({ error: "no such operator" });
    if (result === "last-admin") {
      return reply.code(409).send({ error: "the last admin cannot be removed" });
    }
    fastify.log.info({ event: "auth.operator.deleted", userId: target }, "operator account deleted");
    return { ok: true };
  });

  // ── Enrolment tokens (POL-104) ─────────────────────────────────────────────

  // POST /api/v1/settings/enrollment/tokens  { name, expiresInDays?, maxEnrollments?, bake? }
  fastify.post("/api/v1/settings/enrollment/tokens", async (request, reply) => {
    const body = CreateEnrollmentTokenBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const token = await enrollment.createToken(body.data);
    fastify.log.info(
      {
        event: "enrollment.token.create",
        tokenId: token.id,
        name: token.name,
        expiresAt: token.expiresAt,
        maxEnrollments: token.maxEnrollments,
        bake: token.bake,
      },
      "enrolment token created",
    );
    return { ok: true, token: toTokenView(token), enrollment: enrollmentInfo() };
  });

  // POST /api/v1/settings/enrollment/tokens/:id/rotate  { graceHours? }
  fastify.post("/api/v1/settings/enrollment/tokens/:id/rotate", async (request, reply) => {
    const params = TokenParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid params" });
    const body = RotateEnrollmentTokenBody.safeParse(request.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: "invalid body", issues: body.error.issues });
    }
    const rotated = await enrollment.rotateToken(params.data.id, body.data.graceHours);
    if (!rotated) return reply.code(404).send({ error: `unknown enrolment token: ${params.data.id}` });
    fastify.log.info(
      {
        event: "enrollment.token.rotate",
        tokenId: params.data.id,
        newTokenId: rotated.next.id,
        graceHours: body.data.graceHours,
        oldExpiresAt: rotated.old.expiresAt,
        oldRevokedAt: rotated.old.revokedAt,
      },
      "enrolment token rotated",
    );
    return { ok: true, token: toTokenView(rotated.next), enrollment: enrollmentInfo() };
  });

  // POST /api/v1/settings/enrollment/tokens/:id/revoke
  //
  // Blocks NEW enrolments on this token. Machines that ALREADY enrolled on it hold a durable
  // per-machine credential and keep running — revoking a token never darkens a working wall. Killing a
  // box is a separate, explicit act (reject it in Machines).
  fastify.post("/api/v1/settings/enrollment/tokens/:id/revoke", async (request, reply) => {
    const params = TokenParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid params" });
    const token = await enrollment.revokeToken(params.data.id);
    if (!token) return reply.code(404).send({ error: `unknown enrolment token: ${params.data.id}` });
    fastify.log.info(
      { event: "enrollment.token.revoke", tokenId: token.id, name: token.name, uses: token.uses },
      "enrolment token revoked — new enrolments blocked; machines already enrolled on it keep running",
    );
    return { ok: true, token: toTokenView(token), enrollment: enrollmentInfo() };
  });

  // POST /api/v1/settings/enrollment/tokens/:id/bake  — make this the token new boot media carry.
  fastify.post("/api/v1/settings/enrollment/tokens/:id/bake", async (request, reply) => {
    const params = TokenParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid params" });
    const token = await enrollment.setBakeToken(params.data.id);
    if (!token) return reply.code(404).send({ error: `unknown enrolment token: ${params.data.id}` });
    fastify.log.info(
      { event: "enrollment.token.bake", tokenId: token.id, name: token.name },
      "enrolment token selected for baking — /boot/grub.cfg and the next boot medium carry it",
    );
    return { ok: true, token: toTokenView(token), enrollment: enrollmentInfo() };
  });

  // DELETE /api/v1/settings/enrollment/tokens/:id  — forget it entirely. Machines enrolled on it are
  // untouched; deleting every token puts the deployment back into OPEN mode, which is loud on purpose.
  fastify.delete("/api/v1/settings/enrollment/tokens/:id", async (request, reply) => {
    const params = TokenParams.safeParse(request.params);
    if (!params.success) return reply.code(400).send({ error: "invalid params" });
    const ok = await enrollment.deleteToken(params.data.id);
    if (!ok) return reply.code(404).send({ error: `unknown enrolment token: ${params.data.id}` });
    fastify.log.info(
      { event: "enrollment.token.delete", tokenId: params.data.id, open: enrollment.open },
      enrollment.open
        ? "last enrolment token deleted — enrolment is now OPEN (every agent auto-approves)"
        : "enrolment token deleted",
    );
    return { ok: true, enrollment: enrollmentInfo() };
  });
}
