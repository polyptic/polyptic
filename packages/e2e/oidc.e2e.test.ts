/**
 * @polyptic/e2e — GENERIC OIDC OPERATOR SIGN-IN (POL-106 / D101, Phase 6) against a STUB IdP.
 *
 * Phase 6 has been deferred since day one, and the local-auth work (D29/D31) was explicitly built as
 * the seam OIDC would drop into. This suite proves the drop landed: a full **Authorization Code +
 * PKCE** flow against a real (if tiny) identity provider — discovery document, authorize endpoint,
 * token endpoint, JWKS, RS256-signed ID tokens — mints an ORDINARY Polyptic session, and every way of
 * lying to the callback is refused.
 *
 * The stub IdP is a `Bun.serve` on an ephemeral port (the POL-24 pattern) and is deliberately GENERIC:
 * it implements the spec, not a vendor. Nothing in the server knows or could know which product is on
 * the other end — that is the whole point of non-negotiable #5.
 *
 * The story, in source order (bun runs tests sequentially):
 *   1.  /auth/providers advertises the operator-named provider (no session needed).
 *   2.  /auth/oidc/start redirects to the IdP with response_type=code, a PKCE S256 challenge, state,
 *       nonce and the EXACT registered redirect_uri — and parks the transaction in a cookie.
 *   3.  the full flow: authorize → callback → a signed, HttpOnly Polyptic session cookie, which then
 *       authorizes a gated route and reports the claim-mapped operator at /auth/me.
 *   4.  local sign-in STILL works on the same server (coexistence: the break-glass path).
 *   5.  the rejection matrix — bad state, no transaction, bad nonce, bad signature, wrong issuer,
 *       wrong audience, expired token, dead code — each a 401 with NO session cookie.
 *   6.  RP-initiated logout: the SSO session's logout hands back the IdP's end-session URL; a LOCAL
 *       session's logout does not.
 *   7.  a second server with NO OIDC config: providers.oidc is null, /auth/oidc/start 404s, and local
 *       auth is untouched (zero regression for every existing deployment).
 *
 * DISCIPLINE: we never assert on a token's contents, only on status codes, the presence/absence of a
 * session cookie, and the public AuthUser shape.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthProviders, AuthUser } from "@polyptic/protocol";
import { SignJWT, exportJWK, generateKeyPair } from "jose";

// ─────────────────────────────────────────────────────────────────────────────
// Config — ports above 8240 (8090–8103 belong to the other e2e suites).
// ─────────────────────────────────────────────────────────────────────────────

const PORT = 8241; // the OIDC-enabled control plane
const BARE_PORT = 8242; // a second control plane with NO OIDC config at all
const BASE = `http://localhost:${PORT}`;
const BARE_BASE = `http://localhost:${BARE_PORT}`;
const TEST_TIMEOUT = 20_000;

const CLIENT_ID = "polyptic-console";
const CLIENT_SECRET = "stub-client-secret";
const PROVIDER_NAME = "Company SSO";
const REDIRECT_URI = `${BASE}/api/v1/auth/oidc/callback`;
const POST_LOGIN_URL = `${BASE}/wall`;

const OPERATOR_SUB = "8f4b2c1e-idp-subject";
const OPERATOR_EMAIL = "sso.operator@example.test";

const ADMIN_EMAIL = "local.admin@polyptic.test";
const ADMIN_PASSWORD = "e2e-correct-horse-battery";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const serverEntry = resolve(repoRoot, "packages", "server", "src", "index.ts");

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────────────────────────
// A cookie jar (the auth.e2e pattern): cookie values are opaque to the test.
// ─────────────────────────────────────────────────────────────────────────────

function rawSetCookies(res: Response): string[] {
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

  has(name: string): boolean {
    return this.jar.has(name);
  }
}

const SESSION_COOKIE = "polyptic_session";

async function drain(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    /* already consumed */
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// The stub IdP — a spec-shaped OpenID Provider in ~80 lines. No vendor anywhere.
//
// `tamper` makes it LIE in one specific way per rejection test; the server must catch every lie.
// ─────────────────────────────────────────────────────────────────────────────

type Tamper = "none" | "nonce" | "aud" | "iss" | "exp" | "sig";
let tamper: Tamper = "none";

interface AuthCode {
  nonce: string;
  challenge: string;
  redirectUri: string;
}

let idp: ReturnType<typeof Bun.serve> | undefined;
let issuer = "";
/** Requests the token endpoint saw — used to prove PKCE + the exact redirect_uri really travel. */
const tokenRequests: Array<Record<string, string>> = [];

async function startStubIdp(): Promise<void> {
  const signing = await generateKeyPair("RS256", { extractable: true });
  const rogue = await generateKeyPair("RS256", { extractable: true }); // never published in the JWKS
  const jwk = await exportJWK(signing.publicKey);
  jwk.kid = "stub-key-1";
  jwk.alg = "RS256";
  jwk.use = "sig";

  const codes = new Map<string, AuthCode>();

  const s256 = (verifier: string): string =>
    new Bun.CryptoHasher("sha256").update(verifier, "ascii").digest("base64url");

  idp = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);

      if (url.pathname === "/.well-known/openid-configuration") {
        return Response.json({
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
          token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"],
          code_challenge_methods_supported: ["S256"],
          scopes_supported: ["openid", "profile", "email"],
        });
      }

      if (url.pathname === "/jwks") {
        return Response.json({ keys: [jwk] });
      }

      // The authorize endpoint stands in for the human: it validates the request and redirects back
      // with a code. A real IdP would show a login form here; nothing else differs.
      if (url.pathname === "/authorize") {
        const q = url.searchParams;
        if (q.get("client_id") !== CLIENT_ID) return new Response("bad client_id", { status: 400 });
        if (q.get("response_type") !== "code") return new Response("bad response_type", { status: 400 });
        if (q.get("code_challenge_method") !== "S256") return new Response("no PKCE", { status: 400 });
        const redirectUri = q.get("redirect_uri") ?? "";
        if (redirectUri !== REDIRECT_URI) return new Response("redirect_uri mismatch", { status: 400 });
        const code = `code-${crypto.randomUUID()}`;
        codes.set(code, {
          nonce: q.get("nonce") ?? "",
          challenge: q.get("code_challenge") ?? "",
          redirectUri,
        });
        const back = new URL(redirectUri);
        back.searchParams.set("code", code);
        back.searchParams.set("state", q.get("state") ?? "");
        return Response.redirect(back.toString(), 302);
      }

      if (url.pathname === "/token" && req.method === "POST") {
        const form = new URLSearchParams(await req.text());
        const fields = Object.fromEntries(form.entries());
        tokenRequests.push(fields);

        const basic = req.headers.get("authorization");
        const secretOk = basic
          ? basic.startsWith("Basic ")
          : fields.client_secret === CLIENT_SECRET && fields.client_id === CLIENT_ID;
        if (!secretOk) return Response.json({ error: "invalid_client" }, { status: 401 });

        const record = codes.get(fields.code ?? "");
        if (!record) return Response.json({ error: "invalid_grant" }, { status: 400 });
        codes.delete(fields.code ?? ""); // authorization codes are single-use
        if (fields.redirect_uri !== record.redirectUri) {
          return Response.json({ error: "invalid_grant", error_description: "redirect_uri" }, { status: 400 });
        }
        // PKCE: the code is worthless without the verifier whose hash we were given up-front.
        if (!fields.code_verifier || s256(fields.code_verifier) !== record.challenge) {
          return Response.json({ error: "invalid_grant", error_description: "PKCE" }, { status: 400 });
        }

        const now = Math.floor(Date.now() / 1000);
        const expired = tamper === "exp";
        const key = tamper === "sig" ? rogue.privateKey : signing.privateKey;
        const idToken = await new SignJWT({
          nonce: tamper === "nonce" ? "a-different-login-entirely" : record.nonce,
          email: OPERATOR_EMAIL,
          preferred_username: "sso.operator",
          // A group claim rides along on purpose: POL-106 must IGNORE it (RBAC is POL-107).
          groups: ["wall-admins"],
        })
          .setProtectedHeader({ alg: "RS256", kid: "stub-key-1" })
          .setIssuer(tamper === "iss" ? "https://someone-elses-idp.test" : issuer)
          .setAudience(tamper === "aud" ? "a-different-client" : CLIENT_ID)
          .setSubject(OPERATOR_SUB)
          .setIssuedAt(expired ? now - 3600 : now)
          .setExpirationTime(expired ? now - 1800 : now + 300)
          .sign(key);

        return Response.json({
          access_token: "stub-access-token",
          id_token: idToken,
          token_type: "Bearer",
          expires_in: 300,
        });
      }

      if (url.pathname === "/logout") return new Response("bye", { status: 200 });
      return new Response("not found", { status: 404 });
    },
  });
  issuer = `http://localhost:${idp.port}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Server lifecycle
// ─────────────────────────────────────────────────────────────────────────────

let proc: ReturnType<typeof Bun.spawn> | null = null;
let bareProc: ReturnType<typeof Bun.spawn> | null = null;

async function waitForServer(base: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "never responded";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/api/v1/auth/me`);
      await drain(res);
      if (res.status > 0) return;
    } catch (err) {
      lastErr = String(err);
    }
    await sleep(100);
  }
  throw new Error(`server did not become ready on ${base}: ${lastErr}`);
}

beforeAll(async () => {
  await startStubIdp();

  const common = {
    ...process.env,
    STORE: "memory",
    // AUTH_ENABLED left unset → secure by default (auth ON). This suite proves the gate + the seam.
    COOKIE_SECRET: "e2e-oidc-cookie-secret-please-rotate-0123456789",
    POLYPTIC_ADMIN_EMAIL: ADMIN_EMAIL,
    POLYPTIC_ADMIN_PASSWORD: ADMIN_PASSWORD,
    PLAYER_BASE_URL: "http://localhost:5173",
    LOG_LEVEL: "error",
  };

  proc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: {
      ...common,
      PORT: String(PORT),
      // The whole OIDC configuration: an issuer, a client, a secret. Nothing vendor-shaped.
      OIDC_ISSUER: issuer,
      OIDC_CLIENT_ID: CLIENT_ID,
      OIDC_CLIENT_SECRET: CLIENT_SECRET,
      OIDC_PROVIDER_NAME: PROVIDER_NAME,
      OIDC_REDIRECT_URI: REDIRECT_URI,
      OIDC_POST_LOGIN_URL: POST_LOGIN_URL,
      OIDC_RP_LOGOUT: "true",
    },
    stdout: "inherit",
    stderr: "inherit",
  });

  // The control group: identical server, NO OIDC env. Proves the zero-regression claim.
  bareProc = Bun.spawn(["bun", serverEntry], {
    cwd: repoRoot,
    env: { ...common, PORT: String(BARE_PORT) },
    stdout: "inherit",
    stderr: "inherit",
  });

  await waitForServer(BASE);
  await waitForServer(BARE_BASE);
}, 40_000);

afterAll(async () => {
  for (const p of [proc, bareProc]) {
    if (!p) continue;
    p.kill();
    try {
      await p.exited;
    } catch {
      /* already gone */
    }
  }
  idp?.stop(true);
}, 15_000);

// ─────────────────────────────────────────────────────────────────────────────
// Flow helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Kick off a sign-in: returns the transaction jar and the IdP authorize URL the server chose. */
async function startSignIn(): Promise<{ jar: CookieJar; authorizeUrl: URL }> {
  const jar = new CookieJar();
  const res = await fetch(`${BASE}/api/v1/auth/oidc/start`, { redirect: "manual" });
  jar.ingest(res);
  await drain(res);
  expect(res.status).toBe(302);
  const location = res.headers.get("location");
  expect(location).toBeTruthy();
  return { jar, authorizeUrl: new URL(location as string) };
}

/** Walk the IdP's authorize endpoint and return the callback URL it redirects the browser back to. */
async function authorize(authorizeUrl: URL): Promise<URL> {
  const res = await fetch(authorizeUrl.toString(), { redirect: "manual" });
  await drain(res);
  expect(res.status).toBe(302);
  return new URL(res.headers.get("location") as string);
}

/** Deliver a callback URL to the server (optionally without the transaction cookie). */
async function callback(url: URL, jar: CookieJar | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (jar) headers["cookie"] = jar.header();
  const res = await fetch(url.toString(), { redirect: "manual", headers });
  if (jar) jar.ingest(res);
  return res;
}

/** The happy path, end to end. Returns the jar holding the freshly-minted Polyptic session. */
async function signInWithSso(): Promise<{ jar: CookieJar; res: Response }> {
  const { jar, authorizeUrl } = await startSignIn();
  const cbUrl = await authorize(authorizeUrl);
  const res = await callback(cbUrl, jar);
  return { jar, res };
}

/** Run one lie past the callback and assert it is refused with NO session. */
async function expectRejected(mutate: (cb: URL) => URL | null, expectedReason: string): Promise<void> {
  const { jar, authorizeUrl } = await startSignIn();
  const cbUrl = await authorize(authorizeUrl);
  const tampered = mutate(cbUrl);
  const res = await callback(tampered ?? cbUrl, tampered === null ? null : jar);
  expect(res.status).toBe(401);
  const body = (await res.json()) as { reason?: string };
  expect(body.reason).toBe(expectedReason);
  // The cardinal rule: a refused sign-in must never mint a session.
  const cookies = rawSetCookies(res).join(" ; ");
  expect(cookies).not.toContain(`${SESSION_COOKIE}=`);
  expect(jar.has(SESSION_COOKIE)).toBe(false);
}

// ─────────────────────────────────────────────────────────────────────────────
// 1–2. The provider is advertised, and the authorize request is spec-correct
// ─────────────────────────────────────────────────────────────────────────────

describe("POL-106 — generic OIDC sign-in against a stub IdP", () => {
  test(
    "GET /auth/providers (no session) advertises the operator-named provider beside local accounts",
    async () => {
      const res = await fetch(`${BASE}/api/v1/auth/providers`);
      expect(res.status).toBe(200);
      const providers = AuthProviders.parse(await res.json());
      expect(providers.local).toBe(true);
      expect(providers.oidc).not.toBeNull();
      // The NAME comes from config — the console renders it verbatim and never hardcodes a vendor.
      expect(providers.oidc!.name).toBe(PROVIDER_NAME);
      expect(providers.oidc!.startUrl).toBe("/api/v1/auth/oidc/start");
    },
    TEST_TIMEOUT,
  );

  test(
    "GET /auth/oidc/start → 302 to the IdP with code+PKCE(S256)+state+nonce and the EXACT redirect_uri",
    async () => {
      const { jar, authorizeUrl } = await startSignIn();
      const q = authorizeUrl.searchParams;
      expect(authorizeUrl.origin).toBe(issuer); // discovery decided this, not us
      expect(q.get("response_type")).toBe("code");
      expect(q.get("client_id")).toBe(CLIENT_ID);
      expect(q.get("redirect_uri")).toBe(REDIRECT_URI); // exact match, character for character
      expect(q.get("scope")?.split(" ")).toContain("openid");
      expect(q.get("code_challenge_method")).toBe("S256");
      expect((q.get("code_challenge") ?? "").length).toBeGreaterThan(20);
      expect((q.get("state") ?? "").length).toBeGreaterThan(20);
      expect((q.get("nonce") ?? "").length).toBeGreaterThan(20);
      // The verifier never leaves the browser's (signed, httpOnly) transaction cookie.
      expect(jar.has("polyptic_oidc_tx")).toBe(true);
    },
    TEST_TIMEOUT,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 3. The full flow mints an ORDINARY Polyptic session
  // ───────────────────────────────────────────────────────────────────────────

  test(
    "the full Authorization-Code+PKCE flow mints the SAME httpOnly session a local login mints",
    async () => {
      const before = tokenRequests.length;
      const { jar, res } = await signInWithSso();

      // The callback lands the operator on the console.
      expect(res.status).toBe(302);
      expect(res.headers.get("location")).toBe(POST_LOGIN_URL);
      const setCookies = rawSetCookies(res).join(" ; ");
      expect(setCookies).toContain(`${SESSION_COOKIE}=`);
      expect(setCookies.toLowerCase()).toContain("httponly");
      expect(jar.has(SESSION_COOKIE)).toBe(true);
      await drain(res);

      // PKCE really travelled: the token request carried a verifier and the exact redirect_uri.
      const exchange = tokenRequests[before];
      expect(exchange).toBeDefined();
      expect(exchange!.grant_type).toBe("authorization_code");
      expect(exchange!.code_verifier?.length ?? 0).toBeGreaterThan(20);
      expect(exchange!.redirect_uri).toBe(REDIRECT_URI);

      // And the session is an ordinary one: it opens the gate, and /auth/me knows who it is.
      const machines = await fetch(`${BASE}/api/v1/machines`, { headers: { cookie: jar.header() } });
      expect(machines.status).toBe(200);
      await drain(machines);

      const meRes = await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie: jar.header() } });
      expect(meRes.status).toBe(200);
      const me = AuthUser.parse(((await meRes.json()) as { user: unknown }).user);
      // Claim mapping: the `email` claim became the operator identity the activity feed shows.
      expect(me.email).toBe(OPERATOR_EMAIL);
    },
    TEST_TIMEOUT,
  );

  test(
    "signing in again re-uses the SAME operator account (JIT-provisioned once, keyed on the claim)",
    async () => {
      const { jar } = await signInWithSso();
      const meRes = await fetch(`${BASE}/api/v1/auth/me`, { headers: { cookie: jar.header() } });
      const me = AuthUser.parse(((await meRes.json()) as { user: unknown }).user);
      expect(me.email).toBe(OPERATOR_EMAIL);
    },
    TEST_TIMEOUT,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 4. Coexistence — the local (break-glass) path is untouched
  // ───────────────────────────────────────────────────────────────────────────

  test(
    "local email+password sign-in STILL works with OIDC enabled (the break-glass path)",
    async () => {
      const jar = new CookieJar();
      const res = await fetch(`${BASE}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      jar.ingest(res);
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
      const user = AuthUser.parse(((await res.json()) as { user: unknown }).user);
      expect(user.email).toBe(ADMIN_EMAIL);

      const machines = await fetch(`${BASE}/api/v1/machines`, { headers: { cookie: jar.header() } });
      expect(machines.status).toBe(200);
      await drain(machines);
    },
    TEST_TIMEOUT,
  );

  test(
    "the JIT-provisioned SSO account has NO usable password (it can never be signed into locally)",
    async () => {
      // The account exists (we signed in with it above). A local login attempt against it must fail:
      // its stored hash is a random secret nobody holds.
      const res = await fetch(`${BASE}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: OPERATOR_EMAIL, password: "obviously-not-the-password" }),
      });
      expect(res.status).toBe(401);
      expect(rawSetCookies(res).length).toBe(0);
      await drain(res);
    },
    TEST_TIMEOUT,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 5. The rejection matrix — every lie the callback can be told
  // ───────────────────────────────────────────────────────────────────────────

  test(
    "a MISMATCHED state is rejected (CSRF: someone else's callback in this browser)",
    async () => {
      await expectRejected((cb) => {
        cb.searchParams.set("state", "not-the-state-we-minted");
        return cb;
      }, "state");
    },
    TEST_TIMEOUT,
  );

  test(
    "a callback with NO transaction cookie is rejected (no state to compare against)",
    async () => {
      await expectRejected(() => null, "state");
    },
    TEST_TIMEOUT,
  );

  test(
    "the IdP's own ?error= (declined consent / unassigned user) is rejected, not swallowed",
    async () => {
      const { jar } = await startSignIn();
      const url = new URL(REDIRECT_URI);
      url.searchParams.set("error", "access_denied");
      const res = await callback(url, jar);
      expect(res.status).toBe(401);
      expect(((await res.json()) as { reason?: string }).reason).toBe("provider-error");
    },
    TEST_TIMEOUT,
  );

  test(
    "a DEAD authorization code is rejected at the token endpoint (never reaches verification)",
    async () => {
      await expectRejected((cb) => {
        cb.searchParams.set("code", "a-code-the-idp-never-issued");
        return cb;
      }, "token-exchange");
    },
    TEST_TIMEOUT,
  );

  test(
    "an ID token with the WRONG NONCE is rejected (a replayed token from another login)",
    async () => {
      tamper = "nonce";
      try {
        await expectRejected((cb) => cb, "nonce");
      } finally {
        tamper = "none";
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "an ID token signed by a key that is NOT in the IdP's JWKS is rejected (bad signature)",
    async () => {
      tamper = "sig";
      try {
        await expectRejected((cb) => cb, "signature");
      } finally {
        tamper = "none";
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "an ID token from the WRONG ISSUER is rejected (even signed by the right key)",
    async () => {
      tamper = "iss";
      try {
        await expectRejected((cb) => cb, "issuer");
      } finally {
        tamper = "none";
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "an ID token minted for a DIFFERENT AUDIENCE is rejected (a token for another client)",
    async () => {
      tamper = "aud";
      try {
        await expectRejected((cb) => cb, "audience");
      } finally {
        tamper = "none";
      }
    },
    TEST_TIMEOUT,
  );

  test(
    "an EXPIRED ID token is rejected (beyond the 60s clock tolerance)",
    async () => {
      tamper = "exp";
      try {
        await expectRejected((cb) => cb, "expired");
      } finally {
        tamper = "none";
      }
    },
    TEST_TIMEOUT,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 6. Logout
  // ───────────────────────────────────────────────────────────────────────────

  test(
    "logout revokes the SSO session AND offers the IdP's end-session URL (RP-initiated logout)",
    async () => {
      const { jar } = await signInWithSso();
      const snapshot = jar.header();

      const out = await fetch(`${BASE}/api/v1/auth/logout`, {
        method: "POST",
        headers: { cookie: snapshot },
      });
      expect(out.status).toBe(200);
      const body = (await out.json()) as { ok: boolean; endSessionUrl?: string };
      expect(body.ok).toBe(true);
      expect(body.endSessionUrl).toBeTruthy();
      expect(body.endSessionUrl).toContain(`${issuer}/logout`);
      expect(body.endSessionUrl).toContain(`client_id=${CLIENT_ID}`);

      // The LOCAL session is dead regardless of what the IdP does next.
      const after = await fetch(`${BASE}/api/v1/machines`, { headers: { cookie: snapshot } });
      expect(after.status).toBe(401);
      await drain(after);
    },
    TEST_TIMEOUT,
  );

  test(
    "a LOCAL session's logout gets no end-session URL (it never involved the IdP)",
    async () => {
      const jar = new CookieJar();
      const login = await fetch(`${BASE}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      jar.ingest(login);
      await drain(login);

      const out = await fetch(`${BASE}/api/v1/auth/logout`, {
        method: "POST",
        headers: { cookie: jar.header() },
      });
      const body = (await out.json()) as { ok: boolean; endSessionUrl?: string };
      expect(body.ok).toBe(true);
      expect(body.endSessionUrl).toBeUndefined();
    },
    TEST_TIMEOUT,
  );

  // ───────────────────────────────────────────────────────────────────────────
  // 7. The control group — a deployment with NO OIDC config is unchanged
  // ───────────────────────────────────────────────────────────────────────────

  test(
    "a server with NO OIDC config: providers.oidc is null, /oidc/start 404s, local auth is untouched",
    async () => {
      const providersRes = await fetch(`${BARE_BASE}/api/v1/auth/providers`);
      expect(providersRes.status).toBe(200);
      const providers = AuthProviders.parse(await providersRes.json());
      expect(providers.local).toBe(true);
      expect(providers.oidc).toBeNull();

      const start = await fetch(`${BARE_BASE}/api/v1/auth/oidc/start`, { redirect: "manual" });
      expect(start.status).toBe(404);
      await drain(start);

      const cb = await fetch(`${BARE_BASE}/api/v1/auth/oidc/callback?code=x&state=y`, {
        redirect: "manual",
      });
      expect(cb.status).toBe(404);
      await drain(cb);

      // …and the local gate behaves exactly as the Phase-3f suite pins it.
      const gated = await fetch(`${BARE_BASE}/api/v1/machines`);
      expect(gated.status).toBe(401);
      await drain(gated);

      const jar = new CookieJar();
      const login = await fetch(`${BARE_BASE}/api/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email: ADMIN_EMAIL, password: ADMIN_PASSWORD }),
      });
      jar.ingest(login);
      expect(login.status).toBeLessThan(300);
      await drain(login);

      const machines = await fetch(`${BARE_BASE}/api/v1/machines`, { headers: { cookie: jar.header() } });
      expect(machines.status).toBe(200);
      await drain(machines);
    },
    TEST_TIMEOUT,
  );
});
