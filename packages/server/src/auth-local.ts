/**
 * Local operator authentication (Phase 3f / D29) — the secure heart of the product.
 *
 * THE WHOLE POINT of Polyptic is to eliminate plaintext passwords, so every credential here is handled
 * to that standard:
 *
 *   - Passwords are hashed with **argon2id** via Bun's built-in `Bun.password.hash` / `.verify` — no
 *     external crypto dependency, no home-grown hashing. We store ONLY the hash; the plaintext is never
 *     persisted, logged, or returned.
 *   - A login mints an OPAQUE, random session token. The server stores only `sha256(token)` as the
 *     session id, so a database read never yields a usable token. The raw token rides in a cookie that
 *     is httpOnly, sameSite=lax, SIGNED (via @fastify/cookie + COOKIE_SECRET) and `secure` when served
 *     over HTTPS. Sessions are revocable (delete the row) and expire (~7 days).
 *   - Login is rate-limited per (email, IP): 5 failures within a window trips a 429 lockout for a
 *     cooldown. In-memory (note: per-process).
 *   - Failures are constant-time (Bun.password.verify) and generic ("invalid email or password"), with a
 *     dummy verify on the no-such-user path so presence/absence of an account can't be timed.
 *
 * `AuthService` owns all of this. It reads its config from the environment with secure-by-default
 * values and LOUD warnings whenever a dev default is in play (AUTH_ENABLED off, dev cookie secret, dev
 * admin password). It holds a reference to the Fastify instance purely to sign/unsign cookies once
 * @fastify/cookie is registered.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { AuthUser } from "@polyptic/protocol";
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

import type { EnrollmentMode, PersistedBootstrap, Store } from "./store/types";

/** Make the resolved operator available to handlers after the auth gate runs. */
declare module "fastify" {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

/** Name of the session cookie. */
export const SESSION_COOKIE = "polyptic_session";

/** Session lifetime: ~7 days. */
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Rate-limit window + lockout cooldown for failed logins. */
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;

/** Dev defaults — used only when the operator hasn't configured the real values; each warns loudly. */
const DEV_COOKIE_SECRET = "polyptic-dev-cookie-secret-change-me-in-production-please-32+chars";
const DEV_ADMIN_EMAIL = "operator@polyptic.local";
const DEV_ADMIN_PASSWORD = "polyptic-admin";

/** Hash a password with argon2id (Bun built-in). Never store/log the plaintext. */
export async function hashPassword(password: string): Promise<string> {
  return Bun.password.hash(password, { algorithm: "argon2id" });
}

/** Constant-time verify of a password against an argon2id hash (Bun built-in). */
export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(password, hash);
  } catch {
    // A malformed/unknown hash never authenticates.
    return false;
  }
}

/** Normalize an email for storage + lookup: trim + lower-case (so logins are case-insensitive). */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** A fresh opaque session token (32 random bytes, hex). The raw value only ever lives in the cookie. */
function generateSessionToken(): string {
  return randomBytes(32).toString("hex");
}

/** The value the server stores for a session token: its sha256, hex-encoded. */
function sessionId(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Result of a login attempt. */
export type LoginResult =
  | { ok: true; user: AuthUser; token: string }
  | { ok: false; reason: "invalid" }
  | { ok: false; reason: "locked"; retryAfterSec: number };

interface FailRecord {
  count: number;
  /** Epoch ms of the first failure in the current window. */
  windowStart: number;
  /** Epoch ms until which the (email,IP) pair is locked out, or 0 if not locked. */
  lockedUntil: number;
}

export interface AuthConfig {
  /** Master switch. Default TRUE (secure). When false, ALL auth is skipped (tests/dev) with a warning. */
  enabled: boolean;
  /** Cookie signing secret (@fastify/cookie). A dev default is used + warned when unset. */
  cookieSecret: string;
  /** True if the dev cookie secret is in use (drives the boot warning). */
  usingDevCookieSecret: boolean;
  /** Mark the session cookie `secure` (HTTPS-only). SECURE_COOKIES → PUBLIC_BASE_URL scheme → NODE_ENV. */
  secureCookies: boolean;
  /** The declared public scheme, when PUBLIC_BASE_URL parses: drives the plain-HTTP boot warning. */
  publicScheme: "http" | "https" | null;
}

/** The scheme of PUBLIC_BASE_URL when it parses as an http(s) URL, else null (unset/garbage). */
function publicSchemeFromEnv(env: NodeJS.ProcessEnv): "http" | "https" | null {
  const raw = env.PUBLIC_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const proto = new URL(raw).protocol;
    if (proto === "https:") return "https";
    if (proto === "http:") return "http";
  } catch {
    // Not a URL — fall through to the NODE_ENV default rather than guess.
  }
  return null;
}

/** Read the auth config from the environment, secure-by-default. */
export function authConfigFromEnv(env: NodeJS.ProcessEnv = process.env): AuthConfig {
  // Secure by default: only an explicit "false" disables auth.
  const enabled = (env.AUTH_ENABLED ?? "true").toLowerCase() !== "false";
  const rawSecret = env.COOKIE_SECRET?.trim();
  const usingDevCookieSecret = !rawSecret || rawSecret.length === 0;
  const cookieSecret = usingDevCookieSecret ? DEV_COOKIE_SECRET : rawSecret;
  // Precedence (POL-43, then POL-70):
  //   1. An EXPLICIT SECURE_COOKIES always wins (either way). The old `|| production` forced
  //      Secure cookies on plain-HTTP production deploys, where the browser silently drops them —
  //      login "succeeds" but no session ever persists (found live on the first in-cluster deploy).
  //   2. Else the DECLARED public scheme decides: PUBLIC_BASE_URL=https://… → Secure on,
  //      http://… → Secure off (the same POL-43 silent-login-failure otherwise) — so a TLS
  //      deployment is secure with zero extra knobs and a plain-HTTP homelab keeps working,
  //      each with the matching boot banner (POL-70/D89).
  //   3. Else NODE_ENV=production defaults Secure on (the pre-POL-70 behaviour, unchanged).
  const rawSecure = env.SECURE_COOKIES?.trim().toLowerCase();
  const publicScheme = publicSchemeFromEnv(env);
  const secureCookies = rawSecure
    ? rawSecure === "true"
    : publicScheme
      ? publicScheme === "https"
      : env.NODE_ENV === "production";
  return { enabled, cookieSecret, usingDevCookieSecret, secureCookies, publicScheme };
}

export interface AuthServiceDeps {
  store: Store;
  fastify: FastifyInstance;
  config: AuthConfig;
  log: FastifyBaseLogger;
}

/**
 * The local-auth service. Constructed AFTER @fastify/cookie is registered (it uses the instance's
 * sign/unsign helpers). Owns password hashing, sessions, the login rate-limiter, the `requireAuth`
 * preHandler, the admin-WS cookie check, admin seeding, and the enrollment-bootstrap helpers.
 */
export class AuthService {
  private readonly store: Store;
  private readonly fastify: FastifyInstance;
  private readonly log: FastifyBaseLogger;
  readonly config: AuthConfig;

  /** Per-(email,IP) failed-attempt records (in-memory; per-process). */
  private readonly fails = new Map<string, FailRecord>();
  /** A precomputed argon2id hash used to equalize timing on the no-such-user path. */
  private dummyHashPromise: Promise<string> | null = null;

  constructor(deps: AuthServiceDeps) {
    this.store = deps.store;
    this.fastify = deps.fastify;
    this.config = deps.config;
    this.log = deps.log;
  }

  /** Whether auth is enforced. When false the gate + admin-WS check are no-ops. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Cookie options for the signed, http-only session cookie. */
  cookieOptions(): {
    path: string;
    httpOnly: boolean;
    sameSite: "lax";
    signed: boolean;
    secure: boolean;
    maxAge: number;
  } {
    return {
      path: "/",
      httpOnly: true,
      sameSite: "lax",
      signed: true,
      secure: this.config.secureCookies,
      maxAge: Math.floor(SESSION_TTL_MS / 1000),
    };
  }

  // ── Admin seeding ────────────────────────────────────────────────────────────

  /**
   * Seed an admin user on first boot if no users exist. Uses POLYPTIC_ADMIN_EMAIL +
   * POLYPTIC_ADMIN_PASSWORD when both are set, otherwise a dev default with a LOUD "change me" warning.
   * Never logs the password.
   */
  async seedAdmin(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const existing = await this.store.countUsers();
    if (existing > 0) return;

    const envEmail = env.POLYPTIC_ADMIN_EMAIL?.trim();
    const envPassword = env.POLYPTIC_ADMIN_PASSWORD;
    const usingDefaults = !envEmail || !envPassword;
    const email = normalizeEmail(envEmail && envEmail.length > 0 ? envEmail : DEV_ADMIN_EMAIL);
    const password = usingDefaults ? DEV_ADMIN_PASSWORD : (envPassword as string);

    const passwordHash = await hashPassword(password);
    await this.store.createUser({
      id: `user_${randomUUID()}`,
      email,
      passwordHash,
      createdAt: new Date().toISOString(),
    });

    if (usingDefaults) {
      this.log.warn(
        { event: "auth.admin.seeded.default", email },
        `⚠️  SEEDED A DEFAULT ADMIN (${email}) WITH A WELL-KNOWN DEV PASSWORD — CHANGE ME. Set ` +
          "POLYPTIC_ADMIN_EMAIL + POLYPTIC_ADMIN_PASSWORD before first boot (or change the password " +
          "via Settings) for any non-throwaway deployment.",
      );
    } else {
      this.log.info({ event: "auth.admin.seeded", email }, "seeded admin operator from environment");
    }
  }

  // ── Login + sessions ───────────────────────────────────────────────────────────

  private async dummyHash(): Promise<string> {
    if (!this.dummyHashPromise) {
      this.dummyHashPromise = hashPassword(`dummy-${randomBytes(16).toString("hex")}`);
    }
    return this.dummyHashPromise;
  }

  /**
   * Attempt a login. Enforces the per-(email,IP) lockout, verifies the password in constant time, and
   * on success mints + persists a session, returning the raw token for the cookie. Generic failure
   * (no user enumeration). Never logs/returns the password or hash.
   */
  async login(emailRaw: string, password: string, ip: string): Promise<LoginResult> {
    const email = normalizeEmail(emailRaw);
    // Two independent counters — per (email,ip) AND per email alone. Locking on EITHER stops a
    // distributed brute-force (many IPs against one account) that a composite-only key would miss.
    const ipKey = `${email}|${ip}`;
    const emailKey = `email:${email}`;
    const now = Date.now();

    const lockedIp = this.lockState(ipKey, now);
    const lockedEmail = this.lockState(emailKey, now);
    if (lockedIp.locked || lockedEmail.locked) {
      const until = Math.max(lockedIp.until, lockedEmail.until);
      return { ok: false, reason: "locked", retryAfterSec: Math.ceil((until - now) / 1000) };
    }

    const user = await this.store.getUserByEmail(email);
    let valid = false;
    if (user) {
      valid = await verifyPassword(password, user.passwordHash);
    } else {
      // Equalize timing so an absent account can't be distinguished from a wrong password.
      await verifyPassword(password, await this.dummyHash());
    }

    if (!user || !valid) {
      this.recordFailure(ipKey, now);
      this.recordFailure(emailKey, now);
      return { ok: false, reason: "invalid" };
    }

    this.fails.delete(ipKey); // successful login clears both counters
    this.fails.delete(emailKey);
    const token = await this.issueSession(user.id);
    return { ok: true, user: { id: user.id, email: user.email }, token };
  }

  /**
   * Sign in an operator who was authenticated ELSEWHERE (POL-106 / D101: a verified OIDC ID token).
   * The IdP is the authority; this method never sees a password. It mints exactly the session
   * `login()` mints — same opaque token, same row, same cookie — so every downstream gate is
   * identical for an SSO operator and a local one.
   *
   * The account is JIT-provisioned on first sign-in, keyed on the (normalized) email so the activity
   * feed reads the same for both paths. Such an account gets an UNUSABLE password hash — a random
   * secret nobody, including us, ever holds — so a federated identity can never be signed into
   * through the local password path, and an operator off-boarded at the IdP is off-boarded here.
   * (Rate-limiting stays on the local path: brute force has nothing to attack here.)
   */
  async loginFederated(emailRaw: string): Promise<{ user: AuthUser; token: string }> {
    const email = normalizeEmail(emailRaw);
    let user = await this.store.getUserByEmail(email);
    if (!user) {
      const passwordHash = await hashPassword(randomBytes(32).toString("hex"));
      user = {
        id: `user_${randomUUID()}`,
        email,
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      await this.store.createUser(user);
      this.log.info(
        { event: "auth.federated.provisioned", userId: user.id, email },
        "provisioned an operator account from the identity provider",
      );
    }
    const token = await this.issueSession(user.id);
    return { user: { id: user.id, email: user.email }, token };
  }

  /** Mint + persist a fresh session for a user, returning the raw token for the cookie. */
  async issueSession(userId: string): Promise<string> {
    const now = Date.now();
    const token = generateSessionToken();
    await this.store.createSession({
      id: sessionId(token),
      userId,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + SESSION_TTL_MS).toISOString(),
    });
    return token;
  }

  /** Resolve a raw session token to its operator, or null if invalid/expired (sweeping if expired). */
  async verifySessionToken(token: string): Promise<AuthUser | null> {
    const id = sessionId(token);
    const session = await this.store.getSession(id);
    if (!session) return null;
    if (Date.parse(session.expiresAt) <= Date.now()) {
      await this.store.deleteSession(id);
      return null;
    }
    const user = await this.store.getUserById(session.userId);
    if (!user) return null;
    return { id: user.id, email: user.email };
  }

  /** Revoke the session carried by a raw token (logout). No-op if the token is unknown. */
  async destroySession(token: string): Promise<void> {
    await this.store.deleteSession(sessionId(token));
  }

  /**
   * Change a user's password: verify the current password, then re-hash + store the new one and revoke
   * all of that user's OTHER sessions. Returns false if the current password is wrong. Never logs either
   * password. (The caller re-issues the current session via the existing cookie.)
   */
  async changePassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<boolean> {
    const user = await this.store.getUserById(userId);
    if (!user) return false;
    const ok = await verifyPassword(currentPassword, user.passwordHash);
    if (!ok) return false;
    const newHash = await hashPassword(newPassword);
    await this.store.updateUserPassword(userId, newHash);
    // Invalidate every existing session so a leaked old session can't outlive the password change.
    await this.store.deleteSessionsForUser(userId);
    return true;
  }

  // ── Request/WS verification ──────────────────────────────────────────────────

  /** Read + verify the session cookie on a Fastify request. Returns the operator or null. */
  async verifyRequest(request: FastifyRequest): Promise<AuthUser | null> {
    const raw = request.cookies?.[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = this.fastify.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value == null) return null;
    return this.verifySessionToken(unsigned.value);
  }

  /** Verify a session from a raw `Cookie:` header (used by the /admin WS upgrade). */
  async verifyCookieHeader(header: string | undefined): Promise<AuthUser | null> {
    if (!header) return null;
    const cookies = this.fastify.parseCookie(header);
    const raw = cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = this.fastify.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value == null) return null;
    return this.verifySessionToken(unsigned.value);
  }

  /**
   * Fastify preHandler used by the global API gate. When auth is enabled it requires a valid session on
   * every `/api/v1/**` route except the public auth endpoints; otherwise it replies 401. Stashes the
   * resolved operator on `request.authUser`.
   */
  requireAuth = async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (!this.config.enabled) return;
    const user = await this.verifyRequest(request);
    if (!user) {
      await reply.code(401).send({ error: "unauthorized" });
      return;
    }
    request.authUser = user;
  };

  // ── Login rate-limiter (in-memory, per-process) ───────────────────────────────

  private lockState(key: string, now: number): { locked: boolean; until: number } {
    const rec = this.fails.get(key);
    if (rec && rec.lockedUntil > now) return { locked: true, until: rec.lockedUntil };
    return { locked: false, until: 0 };
  }

  private recordFailure(key: string, now: number): void {
    const rec = this.fails.get(key);
    if (!rec || now - rec.windowStart > LOGIN_WINDOW_MS) {
      this.fails.set(key, { count: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    rec.count += 1;
    if (rec.count >= LOGIN_MAX_FAILS) {
      rec.lockedUntil = now + LOGIN_LOCKOUT_MS;
      // Reset the counter so the window restarts after the cooldown expires.
      rec.count = 0;
      rec.windowStart = now;
    }
  }

  // ── Enrollment bootstrap (Settings view) ──────────────────────────────────────

  /** The current enrollment info {mode, token} for the Settings view + cold-start wizard. */
  async enrollmentInfo(): Promise<{ mode: EnrollmentMode; token: string | null }> {
    const boot = await this.store.getBootstrap();
    if (!boot) return { mode: "open", token: null };
    return { mode: boot.mode, token: boot.token };
  }

  /** Regenerate the gated enrollment token, persist it, and return the new {mode, token}. */
  async regenerateEnrollment(): Promise<PersistedBootstrap> {
    const token = randomBytes(24).toString("hex");
    const boot: PersistedBootstrap = { mode: "gated", token };
    await this.store.setBootstrap(boot);
    return boot;
  }
}
