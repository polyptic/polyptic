/**
 * Scoped API tokens (POL-102 / D97) — the second credential on the operator surface.
 *
 * Until now the REST API had exactly one key: the operator's browser session cookie. That makes a
 * self-hostable wall orchestrator unscriptable — a CI job that wants to put its build status on the
 * wall, an incident tool that wants to cast a dashboard, a cron that rotates a scene, all had to
 * scrape a login. This module mints NAMED, SCOPED bearer tokens instead, presented as
 * `Authorization: Bearer <secret>` on `/api/v1` ALONGSIDE (never instead of) the session cookie.
 *
 * The security posture is deliberately the one the rest of the codebase already uses:
 *
 *   - The secret is 32 random bytes (`plp_` + 64 hex chars) — high entropy, so the server stores only
 *     its **sha256**, exactly like a session id (D29) and the 2b machine credential. A database read
 *     never yields a usable token. The plaintext is returned ONCE, at creation, and is never logged.
 *   - **Deny by default.** A token may reach only the routes named in {@link TOKEN_ROUTES}, each of
 *     which requires exactly one scope. Everything else — the auth routes, token management itself,
 *     the enrolment secret, the DevTools tunnel — is refused with 403 no matter what scopes the token
 *     carries. A token therefore cannot mint another token or escalate into an operator session.
 *   - **Expiry + revocation** are checked on every request (an expired row can never authorize; a
 *     revoked token is simply gone).
 *   - **Rate-limited like login**: 5 rejected bearer presentations from one IP within a window trips
 *     a 429 lockout, so the token space can't be brute-forced (it's 256-bit, but the limiter is what
 *     makes that true in practice and matches the auth-route posture).
 *   - `lastUsedAt` is stamped coarsely (at most once a minute per token) so a busy trigger doesn't
 *     turn every request into a write.
 *
 * NOTHING here weakens the session path: `AuthService.requireAuth` still tries the cookie first and
 * only consults this service when a request carries no session but does carry a bearer header.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import { ApiToken, ApiTokenScope } from "@polyptic/protocol";
import type { ApiToken as ApiTokenType, ApiTokenScope as ApiTokenScopeType } from "@polyptic/protocol";

import type { PersistedApiToken, Store } from "./store/types";

/** Prefix on every minted token. Makes a leaked secret greppable/scannable and identifies the issuer. */
export const TOKEN_PREFIX = "plp_";

/** How much of a token is kept as its non-secret display prefix (`plp_` + 8 hex = 12 chars). */
const DISPLAY_PREFIX_LEN = TOKEN_PREFIX.length + 8;

/** Rate-limit window + lockout cooldown for rejected bearer tokens — mirrors the login limiter. */
const FAIL_WINDOW_MS = 15 * 60 * 1000;
const FAIL_MAX = 5;
const FAIL_LOCKOUT_MS = 15 * 60 * 1000;

/** Don't rewrite lastUsedAt more often than this per token (a hot trigger must not hammer the DB). */
const TOUCH_INTERVAL_MS = 60 * 1000;

/** A route a token may reach, and the single scope that unlocks it. `admin` unlocks all of them. */
interface TokenRoute {
  method: string;
  /** Matched against the path RELATIVE to `/api/v1` (e.g. `/scenes/abc/apply`). */
  pattern: RegExp;
  scope: Exclude<ApiTokenScopeType, "admin">;
}

/** One path segment (an id): anything but a slash. */
const SEG = "[^/]+";

/**
 * THE ALLOW-LIST — the whole token attack surface, in one table. Everything not here is refused.
 *
 * `read` covers every GET the console itself reads (state, machines, screens, scenes, the content
 * library, murals, walls) — enough for an external system to look up the id it wants to act on.
 * The write verbs are the four the ticket asks for: apply a scene, assign content to a screen or a
 * wall, ident, reboot. (Zoom rides `content:write` — it is a property of the content on a target.)
 *
 * Deliberately ABSENT, and unreachable by ANY scope: `/auth/**` (a token must never mint a session
 * or change a password), `/settings/api-tokens/**` (no self-minting), `/settings/enrollment` (the
 * fleet's bootstrap secret), `/screens/:id/devtools/**` (a live remote-debugger tunnel into a wall),
 * plus every destructive registry verb (approve/reject/remove machines + screens, delete murals,
 * scenes, sources, credential profiles, media upload, image rebuilds). Those stay operator-only.
 */
export const TOKEN_ROUTES: TokenRoute[] = [
  // ── read ────────────────────────────────────────────────────────────────────
  { method: "GET", pattern: /^\/state$/, scope: "read" },
  { method: "GET", pattern: /^\/machines$/, scope: "read" },
  { method: "GET", pattern: /^\/screens$/, scope: "read" },
  { method: "GET", pattern: /^\/murals$/, scope: "read" },
  { method: "GET", pattern: /^\/walls$/, scope: "read" },
  { method: "GET", pattern: /^\/scenes$/, scope: "read" },
  { method: "GET", pattern: /^\/content-sources$/, scope: "read" },
  // ── scenes:apply — the alarm/CI "recall this layout" verb ────────────────────
  { method: "POST", pattern: new RegExp(`^/scenes/${SEG}/apply$`), scope: "scenes:apply" },
  // ── content:write — cast content at a screen or a combined surface ───────────
  { method: "PUT", pattern: new RegExp(`^/screens/${SEG}/content$`), scope: "content:write" },
  { method: "PUT", pattern: new RegExp(`^/walls/${SEG}/content$`), scope: "content:write" },
  { method: "PUT", pattern: new RegExp(`^/screens/${SEG}/zoom$`), scope: "content:write" },
  { method: "PUT", pattern: new RegExp(`^/walls/${SEG}/zoom$`), scope: "content:write" },
  // ── machines:operate — ident + reboot ───────────────────────────────────────
  { method: "POST", pattern: new RegExp(`^/screens/${SEG}/ident$`), scope: "machines:operate" },
  { method: "POST", pattern: new RegExp(`^/walls/${SEG}/ident$`), scope: "machines:operate" },
  { method: "POST", pattern: new RegExp(`^/machines/${SEG}/ident$`), scope: "machines:operate" },
  { method: "POST", pattern: new RegExp(`^/machines/${SEG}/reboot$`), scope: "machines:operate" },
];

/** The scope a route needs, or null when no token may reach it at all (the default). */
export function requiredScope(method: string, apiPath: string): ApiTokenScopeType | null {
  const upper = method.toUpperCase();
  for (const route of TOKEN_ROUTES) {
    if (route.method === upper && route.pattern.test(apiPath)) return route.scope;
  }
  return null;
}

/** The token behind the current request, stashed for the audit trail. Never carries the secret. */
export interface AuthorizedToken {
  id: string;
  name: string;
  prefix: string;
  scopes: ApiTokenScopeType[];
}

/** Make the authorizing token available to the audit hook + handlers after the gate runs. */
declare module "fastify" {
  interface FastifyRequest {
    apiToken?: AuthorizedToken;
  }
}

/** The gate's verdict on a bearer token. A failure carries the status + a message safe to return. */
export type TokenVerdict =
  | { ok: true; token: AuthorizedToken }
  | { ok: false; status: 401 | 403 | 429; error: string; retryAfterSec?: number };

/** sha256(secret) hex — the only trace of a token the server ever holds. */
export function hashSecret(secret: string): string {
  return createHash("sha256").update(secret, "utf8").digest("hex");
}

/** Mint a fresh secret: `plp_` + 32 random bytes as hex. */
function generateSecret(): string {
  return `${TOKEN_PREFIX}${randomBytes(32).toString("hex")}`;
}

/** The `Authorization: Bearer <secret>` value on a request, or null. Case-insensitive scheme. */
export function bearerFrom(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^bearer\s+(.+)$/i.exec(header.trim());
  const value = match?.[1]?.trim();
  return value && value.length > 0 ? value : null;
}

interface FailRecord {
  count: number;
  windowStart: number;
  lockedUntil: number;
}

export interface ApiTokenServiceDeps {
  store: Store;
}

export class ApiTokenService {
  private readonly store: Store;
  /** Per-IP rejected-bearer records (in-memory, per-process — same shape as the login limiter). */
  private readonly fails = new Map<string, FailRecord>();
  /** id → epoch ms of the last lastUsedAt write, so a hot token touches the store at most once a minute. */
  private readonly touched = new Map<string, number>();

  constructor(deps: ApiTokenServiceDeps) {
    this.store = deps.store;
  }

  // ── Management (session-gated REST; never reachable by a token) ───────────────

  /**
   * Mint a token. Returns the SAFE view plus the raw secret — the only time the secret exists outside
   * the caller's clipboard. Never log the second element.
   */
  async mint(
    name: string,
    scopes: ApiTokenScopeType[],
    createdBy: string,
    expiresInDays?: number,
  ): Promise<{ token: ApiTokenType; secret: string }> {
    const secret = generateSecret();
    const now = Date.now();
    const row: PersistedApiToken = {
      id: `apitok_${randomUUID()}`,
      name: name.trim(),
      secretHash: hashSecret(secret),
      prefix: secret.slice(0, DISPLAY_PREFIX_LEN),
      // Dedupe + normalize through the contract so a bogus scope can never be persisted.
      scopes: [...new Set(scopes.map((s) => ApiTokenScope.parse(s)))],
      createdAt: new Date(now).toISOString(),
      createdBy,
      expiresAt:
        expiresInDays === undefined
          ? null
          : new Date(now + expiresInDays * 24 * 60 * 60 * 1000).toISOString(),
      lastUsedAt: null,
    };
    await this.store.createApiToken(row);
    return { token: toView(row), secret };
  }

  /** Every token, newest first — the Settings list. Secret-free by construction. */
  async list(): Promise<ApiTokenType[]> {
    const rows = await this.store.listApiTokens();
    return rows
      .map(toView)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  /** Revoke a token. Returns false when the id is unknown (so REST can 404 honestly). */
  async revoke(id: string): Promise<boolean> {
    const rows = await this.store.listApiTokens();
    if (!rows.some((row) => row.id === id)) return false;
    await this.store.deleteApiToken(id);
    this.touched.delete(id);
    return true;
  }

  // ── The gate ──────────────────────────────────────────────────────────────────

  /**
   * Authorize a bearer token for one request. The full decision:
   *   1. the presenting IP must not be locked out (429),
   *   2. the token must exist (sha256 lookup) and not be expired → else 401 + a recorded failure,
   *   3. the route must be on the allow-list AND the token must hold its scope (or `admin`) → else 403.
   * A 403 is NOT a credential failure, so it does not feed the brute-force limiter (the token is
   * genuine, it just isn't allowed there) — but it IS refused with a message that says exactly why.
   */
  async authorize(
    secret: string,
    method: string,
    apiPath: string,
    ip: string,
    now = Date.now(),
  ): Promise<TokenVerdict> {
    const locked = this.lockState(ip, now);
    if (locked.locked) {
      return {
        ok: false,
        status: 429,
        error: "too many rejected API tokens — try again later",
        retryAfterSec: Math.ceil((locked.until - now) / 1000),
      };
    }

    const row = await this.store.getApiTokenByHash(hashSecret(secret));
    if (!row || !constantTimeEqual(row.secretHash, hashSecret(secret))) {
      this.recordFailure(ip, now);
      return { ok: false, status: 401, error: "invalid API token" };
    }
    if (row.expiresAt && Date.parse(row.expiresAt) <= now) {
      this.recordFailure(ip, now);
      return { ok: false, status: 401, error: "API token expired" };
    }

    const scopes = row.scopes.filter(isScope);
    const needed = requiredScope(method, apiPath);
    if (needed === null) {
      return {
        ok: false,
        status: 403,
        error: "this endpoint is not available to API tokens — sign in as an operator",
      };
    }
    if (!scopes.includes("admin") && !scopes.includes(needed)) {
      return {
        ok: false,
        status: 403,
        error: `API token is missing the "${needed}" scope`,
      };
    }

    // A genuine, in-scope use: clear this IP's failure record and stamp lastUsedAt (coarsely).
    this.fails.delete(ip);
    void this.touch(row.id, now);
    return {
      ok: true,
      token: { id: row.id, name: row.name, prefix: row.prefix, scopes },
    };
  }

  /** Stamp lastUsedAt at most once a minute per token. Failures are non-fatal (never break a request). */
  private async touch(id: string, now: number): Promise<void> {
    const last = this.touched.get(id) ?? 0;
    if (now - last < TOUCH_INTERVAL_MS) return;
    this.touched.set(id, now);
    try {
      await this.store.touchApiToken(id, new Date(now).toISOString());
    } catch {
      // A failed bookkeeping write must never turn a valid request into an error.
      this.touched.delete(id);
    }
  }

  // ── Rejected-bearer limiter (in-memory, per-process — mirrors the login limiter) ──

  private lockState(key: string, now: number): { locked: boolean; until: number } {
    const rec = this.fails.get(key);
    if (rec && rec.lockedUntil > now) return { locked: true, until: rec.lockedUntil };
    return { locked: false, until: 0 };
  }

  private recordFailure(key: string, now: number): void {
    const rec = this.fails.get(key);
    if (!rec || now - rec.windowStart > FAIL_WINDOW_MS) {
      this.fails.set(key, { count: 1, windowStart: now, lockedUntil: 0 });
      return;
    }
    rec.count += 1;
    if (rec.count >= FAIL_MAX) {
      rec.lockedUntil = now + FAIL_LOCKOUT_MS;
      rec.count = 0;
      rec.windowStart = now;
    }
  }
}

/** A persisted row → the safe wire view (validated against the contract; there is no secret in it). */
function toView(row: PersistedApiToken): ApiTokenType {
  return ApiToken.parse({
    id: row.id,
    name: row.name,
    scopes: row.scopes.filter(isScope),
    prefix: row.prefix,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt ?? null,
    lastUsedAt: row.lastUsedAt ?? null,
  });
}

/** Narrow a persisted scope string to the contract's enum (a legacy/unknown value is dropped). */
function isScope(value: string): value is ApiTokenScopeType {
  return ApiTokenScope.safeParse(value).success;
}

/** Constant-time compare of two hex digests of equal length. */
function constantTimeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
