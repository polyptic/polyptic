/**
 * @polyptic/e2e — REAL local-operator AUTH suite (Phase 3f, decision D29) against the live control plane.
 *
 * THE WHOLE PRODUCT EXISTS TO ELIMINATE PLAINTEXT PASSWORDS, so this suite proves the auth gate is
 * genuinely closed and the session machinery is sound — end to end, over the wire, against the real
 * server process (NOT a mock). We spawn `packages/server/src/index.ts` with `Bun.spawn` on its own
 * PORT (8096), STORE=memory, **AUTH_ENABLED left unset (→ secure by default = ON)**, a COOKIE_SECRET
 * so the session cookie is signed, and a seeded admin (POLYPTIC_ADMIN_EMAIL + POLYPTIC_ADMIN_PASSWORD).
 *
 * Bun runs tests in source order, sequentially, so the flow below is an ordered story:
 *   1. a protected route (GET /api/v1/machines) WITHOUT a cookie → 401 (the gate is closed).
 *   2. POST /auth/login with the WRONG password → 401, a GENERIC message (no user enumeration), and
 *      NO Set-Cookie (a failed login must never mint a session).
 *   3. POST /auth/login with the CORRECT password → 2xx, a Set-Cookie that is HttpOnly, and the body
 *      reports the AuthUser (id + email, never a secret).
 *   4. reusing that cookie, the protected route → 200, and GET /auth/me → the signed-in user.
 *   5. GET /api/v1/settings/enrollment (with cookie) → EnrollmentInfo {mode, token}.
 *   6. POST /auth/change-password (with cookie) actually changes it: the OLD password then fails to
 *      log in, the NEW one succeeds.
 *   7. 5 rapid WRONG logins (a dedicated email, so the admin account stays usable) → 429 lockout.
 *   8. POST /auth/logout → the session is revoked server-side: the very same cookie no longer
 *      authorizes the protected route (→ 401).
 *
 * SECURITY DISCIPLINE IN THIS TEST: we NEVER assert on (or log) a password or a hash value. We assert
 * on STATUS CODES, the presence/absence of Set-Cookie, the HttpOnly flag, and the public AuthUser/
 * EnrollmentInfo shapes only. The cookie is treated as an opaque bearer token via a small cookie jar
 * (capture Set-Cookie → send Cookie back).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthUser, EnrollmentInfo } from "@polyptic/protocol";

// ─────────────────────────────────────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8096;
const BASE = `http://localhost:${PORT}`;
const TEST_TIMEOUT = 15_000;

const ADMIN_EMAIL = "operator@polyptic.test";
const ADMIN_PASSWORD = "e2e-correct-horse-battery";
const NEW_PASSWORD = "e2e-new-correct-horse-staple";
const WRONG_PASSWORD = "e2e-totally-wrong-password";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Send a RAW HTTP/1.1 request line verbatim and return the response status. `fetch()` (and every WHATWG
 * client) normalises the path before it hits the wire, so it CANNOT express a `//api/v1/...` target,
 * but UEFI firmware / shim can, and do. This raw socket is the only way to prove the gate handles the
 * literal duplicate-slash path a boot client actually sends. Resolves with the numeric status code.
 */
function rawStatus(rawPath: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const sock = connect(PORT, "localhost", () => {
      sock.write(`GET ${rawPath} HTTP/1.1\r\nHost: localhost:${PORT}\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    sock.setEncoding("utf8");
    sock.on("data", (chunk) => {
      buf += chunk;
    });
    sock.on("end", () => {
      const m = /^HTTP\/1\.\d (\d{3})/.exec(buf);
      if (m && m[1]) resolvePromise(Number(m[1]));
      else reject(new Error(`no status line in response: ${buf.slice(0, 120)}`));
    });
    sock.on("error", reject);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// A tiny cookie jar.
//
// We capture Set-Cookie response headers, keep the latest name=value per cookie, and replay them as a
// Cookie request header. Deletions (Max-Age=0 / an empty value / a past Expires) drop the cookie. The
// cookie VALUE is opaque to the test — we never parse or assert on its contents, only the flags on the
// raw Set-Cookie string (e.g. HttpOnly) and whether it authorizes a request.
// ─────────────────────────────────────────────────────────────────────────────

function rawSetCookies(res: Response): string[] {
  // Bun/undici expose getSetCookie() which correctly splits multiple Set-Cookie headers.
  const anyHeaders = res.headers as unknown as { getSetCookie?: () => string[] };
  if (typeof anyHeaders.getSetCookie === "function") return anyHeaders.getSetCookie();
  const single = res.headers.get("set-cookie");
  return single ? [single] : [];
}

class CookieJar {
  private readonly jar = new Map<string, string>();

  ingest(res: Response): void {
    for (const sc of rawSetCookies(res)) {
      const firstPair = sc.split(";")[0] ?? "";
      const eq = firstPair.indexOf("=");
      if (eq < 0) continue;
      const name = firstPair.slice(0, eq).trim();
      const value = firstPair.slice(eq + 1).trim();
      const lower = sc.toLowerCase();
      const cleared =
        value === "" ||
        /(?:^|;)\s*max-age\s*=\s*0\b/.test(lower) ||
        lower.includes("expires=thu, 01 jan 1970");
      if (cleared) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([n, v]) => `${n}=${v}`).join("; ");
  }

  get size(): number {
    return this.jar.size;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// REST helpers
// ─────────────────────────────────────────────────────────────────────────────

interface ReqOpts {
  cookie?: string; // explicit Cookie header (e.g. a snapshot taken before logout)
  jar?: CookieJar; // if set, Cookie is taken from the jar AND any Set-Cookie is ingested back
  body?: unknown; // JSON body for POST
}

async function req(method: string, path: string, opts: ReqOpts = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  const cookie = opts.cookie ?? (opts.jar ? opts.jar.header() : "");
  if (cookie) headers["cookie"] = cookie;
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  const res = await fetch(`${BASE}${path}`, { method, headers, body });
  if (opts.jar) opts.jar.ingest(res);
  return res;
}

const getJson = (path: string, opts: ReqOpts = {}) => req("GET", path, opts);
const postJson = (path: string, body?: unknown, opts: ReqOpts = {}) =>
  req("POST", path, { ...opts, body });

/** Drain a response body so the connection is freed (we mostly care about status, not payloads). */
async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Server process lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;

/**
 * Readiness probe. With AUTH on, /api/v1/state is gated (401 until signed in), so we cannot poll it
 * for "ok". Instead we hit /api/v1/auth/me — the deliberately-UNPROTECTED self-reporting endpoint that
 * answers 401 when nobody is signed in. ANY HTTP response (even 401) means the server is up.
 */
async function waitForServer(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/api/v1/auth/me`);
      await drain(res);
      // A real HTTP status (typically 401) proves the listener + routes are live.
      if (res.status > 0) return;
      lastErr = `status ${res.status}`;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${BASE}: ${lastErr}`);
}

beforeAll(async () => {
  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...process.env,
      STORE: "memory",
      PORT: String(PORT),
      // AUTH_ENABLED intentionally LEFT UNSET → secure-by-default (auth ON). This suite proves the gate.
      COOKIE_SECRET: "e2e-cookie-secret-please-rotate-in-prod-0123456789",
      POLYPTIC_ADMIN_EMAIL: ADMIN_EMAIL,
      POLYPTIC_ADMIN_PASSWORD: ADMIN_PASSWORD,
      PLAYER_BASE_URL: "http://localhost:5173",
      LOG_LEVEL: "error",
    },
    stdout: "inherit",
    stderr: "inherit",
  });
  await waitForServer();
}, 30_000);

afterAll(async () => {
  if (proc) {
    proc.kill();
    try {
      await proc.exited;
    } catch {
      /* already gone */
    }
  }
}, 10_000);

// A jar that carries the primary signed-in session through steps 3 → 6.
const session = new CookieJar();

// ─────────────────────────────────────────────────────────────────────────────
// The ordered auth story
// ─────────────────────────────────────────────────────────────────────────────

describe("phase 3f local operator auth (gate ON)", () => {
  test(
    "a protected route without a session cookie is rejected with 401",
    async () => {
      const res = await getJson("/api/v1/machines");
      expect(res.status).toBe(401);
      await drain(res);
    },
    TEST_TIMEOUT,
  );

  test(
    "a raw duplicate-slash variant of a protected route is STILL gated (no ignoreDuplicateSlashes bypass)",
    async () => {
      // The server sets Fastify ignoreDuplicateSlashes (for shim's `<dir>//grubx64.efi` HTTP-boot
      // fetch), so `//api/v1/machines` ROUTES to the real handler; the gate must collapse the same
      // slashes or it sees a leading `//`, fails its startsWith check, and skips auth entirely. Must be
      // sent raw over a socket, since fetch normalises the path away and would not exercise the bug.
      expect(await rawStatus("/api/v1/machines")).toBe(401); // sanity: the raw client itself is gated
      expect(await rawStatus("//api/v1/machines")).toBe(401); // the bypass path (200 before the fix)
      expect(await rawStatus("///api/v1/machines")).toBe(401);
    },
    TEST_TIMEOUT,
  );

  test(
    "login with the wrong password → 401, a generic message, and NO Set-Cookie",
    async () => {
      const probe = new CookieJar();
      const res = await postJson(
        "/api/v1/auth/login",
        { email: ADMIN_EMAIL, password: WRONG_PASSWORD },
        { jar: probe },
      );
      expect(res.status).toBe(401);

      // No session may be minted on a failed login.
      expect(rawSetCookies(res).length).toBe(0);
      expect(probe.size).toBe(0);

      // The message must be generic (no user enumeration) — never reveal which factor was wrong, and
      // certainly never echo the password.
      const text = await res.text();
      const lower = text.toLowerCase();
      expect(lower).not.toContain(WRONG_PASSWORD.toLowerCase());
      // It should not disclose whether the EMAIL existed (e.g. "no such user" / "unknown email").
      expect(lower).not.toContain("no such user");
      expect(lower).not.toContain("unknown email");
      expect(lower).not.toContain("user not found");
    },
    TEST_TIMEOUT,
  );

  test(
    "login with the correct password → 2xx, an HttpOnly Set-Cookie, and the AuthUser body",
    async () => {
      const res = await postJson(
        "/api/v1/auth/login",
        { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        { jar: session },
      );
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);

      // A session cookie was set, and it MUST be HttpOnly (not reachable from document.cookie / XSS).
      const cookies = rawSetCookies(res);
      expect(cookies.length).toBeGreaterThan(0);
      const flags = cookies.join(" ; ").toLowerCase();
      expect(flags).toContain("httponly");
      // On localhost dev (http) the cookie must NOT be Secure, or it would never be sent back here.
      expect(flags).not.toContain("secure");
      expect(session.size).toBeGreaterThan(0);

      // The body reports the public operator identity — id + email — and nothing secret.
      const user = AuthUser.parse(((await res.json()) as { user: unknown }).user);
      expect(user.email).toBe(ADMIN_EMAIL);
      expect(typeof user.id).toBe("string");
      expect(user.id.length).toBeGreaterThan(0);
    },
    TEST_TIMEOUT,
  );

  test(
    "the captured session cookie now authorizes the protected route, and /auth/me reports the user",
    async () => {
      const machines = await getJson("/api/v1/machines", { jar: session });
      expect(machines.status).toBe(200);
      await drain(machines);

      const meRes = await getJson("/api/v1/auth/me", { jar: session });
      expect(meRes.status).toBe(200);
      const me = AuthUser.parse(((await meRes.json()) as { user: unknown }).user);
      expect(me.email).toBe(ADMIN_EMAIL);
      expect(typeof me.id).toBe("string");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /settings/enrollment (signed in) returns EnrollmentInfo {mode, token}",
    async () => {
      const res = await getJson("/api/v1/settings/enrollment", { jar: session });
      expect(res.status).toBe(200);
      const info = EnrollmentInfo.parse(await res.json());
      expect(["open", "gated"]).toContain(info.mode);
      // token is string|null by contract; in OPEN mode (no bootstrap token) it is null.
      expect(info.token === null || typeof info.token === "string").toBe(true);
    },
    TEST_TIMEOUT,
  );

  test(
    "change-password (with cookie) really changes it: old password fails, new password works",
    async () => {
      const changed = await postJson(
        "/api/v1/auth/change-password",
        { currentPassword: ADMIN_PASSWORD, newPassword: NEW_PASSWORD },
        { jar: session },
      );
      expect(changed.status).toBeGreaterThanOrEqual(200);
      expect(changed.status).toBeLessThan(300);
      await drain(changed);

      // The OLD password must no longer authenticate (one failed attempt — well under the lockout).
      const oldJar = new CookieJar();
      const oldTry = await postJson(
        "/api/v1/auth/login",
        { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
        { jar: oldJar },
      );
      expect(oldTry.status).toBe(401);
      expect(oldJar.size).toBe(0);
      await drain(oldTry);

      // The NEW password works and mints a fresh session.
      const newJar = new CookieJar();
      const newTry = await postJson(
        "/api/v1/auth/login",
        { email: ADMIN_EMAIL, password: NEW_PASSWORD },
        { jar: newJar },
      );
      expect(newTry.status).toBeGreaterThanOrEqual(200);
      expect(newTry.status).toBeLessThan(300);
      expect(newJar.size).toBeGreaterThan(0);
      const user = AuthUser.parse(((await newTry.json()) as { user: unknown }).user);
      expect(user.email).toBe(ADMIN_EMAIL);
    },
    TEST_TIMEOUT,
  );

  test(
    "5 rapid wrong logins trip a 429 lockout (dedicated email, so the admin stays usable)",
    async () => {
      // A throwaway email keeps the per-email counter isolated from the admin account used elsewhere.
      const victim = "lockme@polyptic.test";
      const statuses: number[] = [];
      // Fire enough attempts to cross the "5 fails in a window" threshold; capture each status.
      for (let i = 0; i < 7; i++) {
        const res = await postJson("/api/v1/auth/login", {
          email: victim,
          password: WRONG_PASSWORD,
        });
        statuses.push(res.status);
        // No session may EVER be set on these failures.
        expect(rawSetCookies(res).length).toBe(0);
        await drain(res);
      }
      // Before the threshold the server answers 401 (bad creds); once locked it answers 429.
      expect(statuses).toContain(429);
      // Every attempt must be a rejection — never a 2xx.
      for (const s of statuses) expect(s === 401 || s === 429).toBe(true);
      // The lockout should be "sticky" within the window: the final attempt is locked out.
      expect(statuses[statuses.length - 1]).toBe(429);
    },
    TEST_TIMEOUT,
  );

  test(
    "logout revokes the session server-side: the same cookie no longer authorizes (401)",
    async () => {
      // Establish a known-good, isolated session to revoke (the new admin password from step 6).
      const jar = new CookieJar();
      const login = await postJson(
        "/api/v1/auth/login",
        { email: ADMIN_EMAIL, password: NEW_PASSWORD },
        { jar },
      );
      expect(login.status).toBeGreaterThanOrEqual(200);
      expect(login.status).toBeLessThan(300);
      await drain(login);

      // Snapshot the exact Cookie header BEFORE logout, so we can replay the now-revoked cookie value.
      const snapshot = jar.header();
      expect(snapshot.length).toBeGreaterThan(0);

      // Sanity: it authorizes right now.
      const before = await getJson("/api/v1/machines", { cookie: snapshot });
      expect(before.status).toBe(200);
      await drain(before);

      const out = await postJson("/api/v1/auth/logout", undefined, { jar });
      expect(out.status).toBeGreaterThanOrEqual(200);
      expect(out.status).toBeLessThan(300);
      await drain(out);

      // The revoked session id must be dead even though we present the identical cookie value.
      const after = await getJson("/api/v1/machines", { cookie: snapshot });
      expect(after.status).toBe(401);
      await drain(after);

      // And /auth/me self-reports unauthenticated again.
      const me = await getJson("/api/v1/auth/me", { cookie: snapshot });
      expect(me.status).toBe(401);
      await drain(me);
    },
    TEST_TIMEOUT,
  );
});
