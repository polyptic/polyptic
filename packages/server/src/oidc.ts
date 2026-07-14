/**
 * Generic OIDC operator sign-in (POL-106 / D101) — Phase 6, dropped onto the D29 seam.
 *
 * This is an ADD-ON to local auth, never a replacement: a successful OIDC callback mints exactly the
 * SAME signed httpOnly session cookie `AuthService.login()` mints, so every downstream gate (the
 * /api/v1 preHandler, the /admin WS origin+cookie check, POL-54's player-token minting) is untouched
 * and knows nothing about identity providers. Local accounts remain the break-glass path.
 *
 * VENDOR-NEUTRAL BY CONSTRUCTION (non-negotiable #5): the only inputs are an issuer URL, a client id
 * and a client secret. Everything else — authorization endpoint, token endpoint, JWKS, the signing
 * algorithms, the token-endpoint auth method, the end-session endpoint — is read from the IdP's own
 * discovery document (`/.well-known/openid-configuration`). No provider is named anywhere in this
 * file, and none ever should be.
 *
 * The flow is Authorization Code + PKCE (S256), the only flow appropriate for a confidential client
 * in 2026:
 *
 *   1. `authorizationRequest()` mints `state`, `nonce` and a PKCE `code_verifier`, and returns the
 *      authorize URL plus a TRANSACTION that the route parks in a short-lived, SIGNED, httpOnly
 *      cookie. The transaction is deliberately NOT server state: a two-replica deployment can land
 *      the callback on the other pod, and an in-memory map would 401 at random.
 *   2. `complete()` re-reads that cookie, requires `state` to match (CSRF), exchanges the code at the
 *      token endpoint with the `code_verifier` (PKCE — a stolen code is useless without it) and the
 *      EXACT same `redirect_uri`, then verifies the ID token against the IdP's JWKS: signature,
 *      `iss`, `aud`, `exp`/`iat` (60s clock tolerance) — and `nonce` against the transaction, which
 *      is what makes a replayed ID token from another login useless.
 *
 * ID-token verification is delegated to `jose` (`createRemoteJWKSet` + `jwtVerify`) rather than
 * hand-rolled: RS256/JWKS verification is the classic security footgun (alg confusion, `alg:none`,
 * kid rotation, key-type mixups) and this is the smallest, most-audited library that does it. We do
 * NOT delegate the flow itself — it is ~60 lines of fetch, and every check is explicit + testable.
 *
 * Groups/roles are OUT OF SCOPE: we map `sub`/`email`/`preferred_username` to the operator identity
 * shown in the activity feed and stop there. The RBAC seam is `identityFromClaims()` — it already
 * receives the full claim set; the role mapping hangs off it when POL-107 lands.
 */
import { createHash, randomBytes } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";
import type { FastifyBaseLogger } from "fastify";
import type { JWTPayload } from "jose";

/** Everything an operator configures. Read once at boot; a partial config REFUSES to start. */
export interface OidcConfig {
  /** Issuer URL (no trailing slash). Discovery hangs off it; the ID token's `iss` must match it. */
  issuer: string;
  clientId: string;
  clientSecret: string;
  /** Display name for the console's button. Operator-chosen — never a hardcoded vendor name. */
  providerName: string;
  /** Requested scopes. `openid` is always included. */
  scopes: string[];
  /** The EXACT redirect URI registered at the IdP. Sent on both the authorize and token requests. */
  redirectUri: string;
  /** Where the browser lands after a successful callback (the console). */
  postLoginUrl: string;
  /** Optional email-domain allowlist. Empty = every identity the IdP authenticates may sign in. */
  allowedDomains: string[];
  /** Offer RP-initiated logout at the IdP when the discovery document advertises it. */
  rpLogout: boolean;
}

/** The per-login transaction parked in a signed, httpOnly cookie between `start` and `callback`. */
export interface OidcTransaction {
  state: string;
  nonce: string;
  /** PKCE code_verifier. The IdP only ever saw its S256 hash. */
  verifier: string;
}

/** The operator identity distilled from the ID token's claims (never a token, never a secret). */
export interface OidcIdentity {
  /** The IdP's stable subject — the durable identifier (an email can be reassigned; `sub` cannot). */
  subject: string;
  /** The email we key the Polyptic operator account on (and show in the activity feed). */
  email: string;
  /** `preferred_username`, when the IdP sends one. Informational. */
  username?: string;
}

/** Why a callback was refused. Each one has a test. */
export type OidcFailure =
  | "not-configured"
  | "provider-error" // the IdP itself redirected back with ?error=
  | "no-code"
  | "state" // missing/expired transaction cookie, or state mismatch (CSRF)
  | "token-exchange" // the token endpoint said no (bad code, bad client secret, bad redirect_uri)
  | "no-id-token"
  | "signature" // JWKS said no: wrong key, tampered token, alg confusion
  | "issuer"
  | "audience"
  | "expired"
  | "nonce" // a replayed ID token from another login
  | "claims" // no usable identity in the token
  | "domain"; // authenticated, but outside the email-domain allowlist

export type OidcResult =
  | { ok: true; identity: OidcIdentity; claims: JWTPayload }
  | { ok: false; reason: OidcFailure; detail?: string };

/** The slice of the discovery document we use. Everything is the IdP's word, not ours. */
interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  code_challenge_methods_supported?: string[];
}

/** Discovery is cached for an hour — a wall of screens must not depend on the IdP being up. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;
const HTTP_TIMEOUT_MS = 15_000;
/** The transaction cookie lives just long enough for a human to authenticate at the IdP. */
export const OIDC_TX_COOKIE = "polyptic_oidc_tx";
export const OIDC_TX_TTL_SEC = 10 * 60;
/** Set on an OIDC-minted session so logout knows to offer RP-initiated logout (no schema change). */
export const OIDC_SSO_COOKIE = "polyptic_oidc_sso";

/** base64url with no padding — PKCE + state/nonce encoding. */
function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The S256 PKCE challenge for a verifier: base64url(sha256(verifier)). */
export function codeChallenge(verifier: string): string {
  return b64url(createHash("sha256").update(verifier, "ascii").digest());
}

/** A fresh, unguessable value for state / nonce / the PKCE verifier (43 chars from 32 bytes). */
function randomValue(): string {
  return b64url(randomBytes(32));
}

/**
 * Read the OIDC config from the environment. Returns null when the deployment has no IdP configured
 * (the default — a stack with no `OIDC_*` env behaves byte-for-byte as it did before POL-106).
 * A HALF-configured IdP throws: silently serving local-only auth when the operator believes SSO is
 * on is the failure mode we refuse (same posture as the TLS cert/key pair, D89).
 */
export function oidcConfigFromEnv(env: NodeJS.ProcessEnv = process.env): OidcConfig | null {
  const issuerRaw = env.OIDC_ISSUER?.trim();
  const clientId = env.OIDC_CLIENT_ID?.trim();
  const clientSecret = env.OIDC_CLIENT_SECRET?.trim();

  const anySet = Boolean(issuerRaw || clientId || clientSecret);
  if (!anySet) return null;
  if (!issuerRaw || !clientId || !clientSecret) {
    throw new Error(
      "OIDC is half-configured: OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must ALL be set " +
        "(or all be unset for local-only sign-in).",
    );
  }

  let issuerUrl: URL;
  try {
    issuerUrl = new URL(issuerRaw);
  } catch {
    throw new Error(`OIDC_ISSUER is not a URL: ${issuerRaw}`);
  }
  const issuer = issuerUrl.toString().replace(/\/+$/, "");

  // The redirect URI must match what is registered at the IdP EXACTLY (character for character), so
  // it is either stated outright or derived from the one public origin (PUBLIC_BASE_URL, D89).
  const publicBase = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const redirectUri = env.OIDC_REDIRECT_URI?.trim() || (publicBase ? `${publicBase}${OIDC_CALLBACK_PATH}` : "");
  if (!redirectUri) {
    throw new Error(
      "OIDC needs a redirect URI: set OIDC_REDIRECT_URI (it must match the IdP registration exactly), " +
        "or set PUBLIC_BASE_URL and it is derived as <PUBLIC_BASE_URL>" +
        OIDC_CALLBACK_PATH +
        ".",
    );
  }

  const scopes = (env.OIDC_SCOPES?.trim() || "openid profile email")
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (!scopes.includes("openid")) scopes.unshift("openid");

  const postLoginUrl =
    env.OIDC_POST_LOGIN_URL?.trim() || (publicBase ? `${publicBase}/wall` : "/wall");

  const allowedDomains = (env.OIDC_ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase().replace(/^@/, ""))
    .filter((d) => d.length > 0);

  return {
    issuer,
    clientId,
    clientSecret,
    providerName: env.OIDC_PROVIDER_NAME?.trim() || "SSO",
    scopes,
    redirectUri,
    postLoginUrl,
    allowedDomains,
    rpLogout: /^(1|true|yes)$/i.test(env.OIDC_RP_LOGOUT?.trim() ?? ""),
  };
}

/** Where the IdP sends the browser back. Also the tail of the derived redirect URI. */
export const OIDC_CALLBACK_PATH = "/api/v1/auth/oidc/callback";
export const OIDC_START_PATH = "/api/v1/auth/oidc/start";

/** Does this string look like an email address (good enough to key an operator account on)? */
function looksLikeEmail(value: unknown): value is string {
  return typeof value === "string" && /^[^\s@]+@[^\s@.]+\.[^\s@]+$/.test(value);
}

/**
 * Claims → operator identity. `sub` is the durable identifier; the EMAIL is what an operator reads
 * in the activity feed, so we take the best one on offer:
 *
 *   1. the `email` claim (the normal case — every IdP with the `email` scope sends it),
 *   2. `preferred_username`, when it is itself email-shaped (common where usernames are UPNs),
 *   3. a synthetic `<sub>@<issuer-host>` — never pretty, but stable, unique, and it keeps a working
 *      sign-in for an IdP configured without the email scope rather than failing the login.
 *
 * This function is the RBAC SEAM (POL-107): it already sees every claim, so a group/role mapping
 * (`groups`, `roles`, whatever the deployment's IdP calls it) hangs off exactly here.
 */
export function identityFromClaims(claims: JWTPayload, issuer: string): OidcIdentity | null {
  const subject = typeof claims.sub === "string" ? claims.sub.trim() : "";
  if (!subject) return null;

  const preferred = claims.preferred_username;
  let email: string | null = null;
  if (looksLikeEmail(claims.email)) email = (claims.email as string).trim().toLowerCase();
  else if (looksLikeEmail(preferred)) email = preferred.trim().toLowerCase();
  else {
    let host = "idp.invalid";
    try {
      host = new URL(issuer).hostname || host;
    } catch {
      /* an unparseable issuer can't happen (config validated it) — keep the placeholder */
    }
    const local = subject.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 64);
    email = `${local}@${host}`.toLowerCase();
  }

  const username = typeof preferred === "string" && preferred.trim().length > 0 ? preferred.trim() : undefined;
  return { subject, email, ...(username ? { username } : {}) };
}

export interface OidcServiceDeps {
  config: OidcConfig;
  log: FastifyBaseLogger;
  /** Injected in tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/**
 * The OIDC engine. One instance per deployment; holds no per-user state (the login transaction rides
 * in the browser's cookie), so it is replica-safe by construction.
 */
export class OidcService {
  readonly config: OidcConfig;
  private readonly log: FastifyBaseLogger;
  private readonly fetchImpl: typeof fetch;

  private discovery: Discovery | null = null;
  private discoveredAt = 0;
  private jwks: ReturnType<typeof createRemoteJWKSet> | null = null;
  private jwksUri = "";

  constructor(deps: OidcServiceDeps) {
    this.config = deps.config;
    this.log = deps.log;
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** Fetch (and cache) the IdP's discovery document. The ONLY place provider specifics come from. */
  async discover(force = false): Promise<Discovery> {
    if (!force && this.discovery && Date.now() - this.discoveredAt < DISCOVERY_TTL_MS) {
      return this.discovery;
    }
    const url = `${this.config.issuer}/.well-known/openid-configuration`;
    const res = await this.fetchImpl(url, { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`OIDC discovery failed: GET ${url} → HTTP ${res.status}`);
    const doc = (await res.json()) as Discovery;
    for (const field of ["issuer", "authorization_endpoint", "token_endpoint", "jwks_uri"] as const) {
      if (typeof doc[field] !== "string" || doc[field].length === 0) {
        throw new Error(`OIDC discovery document from ${url} has no ${field}`);
      }
    }
    // The spec REQUIRES the document's issuer to equal the one we asked about — a mismatch means the
    // document was served by someone else, and every `iss` check downstream would be checking a lie.
    if (doc.issuer.replace(/\/+$/, "") !== this.config.issuer) {
      throw new Error(
        `OIDC discovery issuer mismatch: configured ${this.config.issuer}, document says ${doc.issuer}`,
      );
    }
    this.discovery = doc;
    this.discoveredAt = Date.now();
    if (this.jwksUri !== doc.jwks_uri) {
      // createRemoteJWKSet caches keys and re-fetches on an unknown `kid`, so rotation is free.
      this.jwks = createRemoteJWKSet(new URL(doc.jwks_uri), { timeoutDuration: HTTP_TIMEOUT_MS });
      this.jwksUri = doc.jwks_uri;
    }
    return doc;
  }

  /** The IdP's RP-initiated logout endpoint, when it advertises one and the operator opted in. */
  async endSessionUrl(): Promise<string | null> {
    if (!this.config.rpLogout) return null;
    let doc: Discovery;
    try {
      doc = await this.discover();
    } catch {
      return null;
    }
    if (!doc.end_session_endpoint) return null;
    const url = new URL(doc.end_session_endpoint);
    // No id_token_hint: we deliberately do not persist ID tokens (see D101). client_id +
    // post_logout_redirect_uri is the spec's other accepted pairing and is widely supported.
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("post_logout_redirect_uri", this.config.postLoginUrl);
    return url.toString();
  }

  /** Begin a login: mint the transaction and build the authorize URL (PKCE S256, state + nonce). */
  async authorizationRequest(): Promise<{ url: string; tx: OidcTransaction }> {
    const doc = await this.discover();
    const tx: OidcTransaction = { state: randomValue(), nonce: randomValue(), verifier: randomValue() };
    const url = new URL(doc.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.config.clientId);
    url.searchParams.set("redirect_uri", this.config.redirectUri);
    url.searchParams.set("scope", this.config.scopes.join(" "));
    url.searchParams.set("state", tx.state);
    url.searchParams.set("nonce", tx.nonce);
    url.searchParams.set("code_challenge", codeChallenge(tx.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), tx };
  }

  /**
   * Finish a login: state check → code exchange (PKCE) → ID-token verification → identity.
   * Returns a REASON on every failure path; the route turns them all into one flat 401 (an operator
   * gets the reason in the server log, an attacker gets nothing).
   */
  async complete(params: {
    code: string | undefined;
    state: string | undefined;
    tx: OidcTransaction | null;
  }): Promise<OidcResult> {
    if (!params.tx) return { ok: false, reason: "state", detail: "no login transaction cookie" };
    if (!params.state || params.state !== params.tx.state) {
      return { ok: false, reason: "state", detail: "state mismatch" };
    }
    if (!params.code) return { ok: false, reason: "no-code" };

    const doc = await this.discover();

    // Token-endpoint client authentication: honour what the IdP says it supports (basic when it is
    // the only one on offer, else the universally-accepted post form). Never guess a vendor default.
    const methods = doc.token_endpoint_auth_methods_supported ?? [];
    const useBasic = methods.includes("client_secret_basic") && !methods.includes("client_secret_post");

    const form = new URLSearchParams({
      grant_type: "authorization_code",
      code: params.code,
      redirect_uri: this.config.redirectUri,
      code_verifier: params.tx.verifier,
      client_id: this.config.clientId,
    });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded" };
    if (useBasic) {
      const basic = Buffer.from(
        `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
      ).toString("base64");
      headers["authorization"] = `Basic ${basic}`;
    } else {
      form.set("client_secret", this.config.clientSecret);
    }

    let idToken: string;
    try {
      const res = await this.fetchImpl(doc.token_endpoint, {
        method: "POST",
        headers,
        body: form.toString(),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        return { ok: false, reason: "token-exchange", detail: `HTTP ${res.status} ${body.slice(0, 200)}` };
      }
      const payload = (await res.json()) as { id_token?: unknown };
      if (typeof payload.id_token !== "string" || payload.id_token.length === 0) {
        return { ok: false, reason: "no-id-token" };
      }
      idToken = payload.id_token;
    } catch (err) {
      return { ok: false, reason: "token-exchange", detail: String(err instanceof Error ? err.message : err) };
    }

    // ── ID-token verification (jose): signature against the IdP's JWKS, plus iss / aud / exp / iat. ──
    let claims: JWTPayload;
    try {
      if (!this.jwks) throw new Error("no JWKS (discovery did not run)");
      const verified = await jwtVerify(idToken, this.jwks, {
        issuer: this.config.issuer,
        audience: this.config.clientId,
        clockTolerance: 60,
      });
      claims = verified.payload;
    } catch (err) {
      return { ok: false, reason: verifyFailureReason(err), detail: (err as Error).message };
    }

    // The nonce binds the ID token to THIS browser's login attempt — without it a token captured
    // from another (even legitimate) login could be replayed into our callback.
    if (typeof claims.nonce !== "string" || claims.nonce !== params.tx.nonce) {
      return { ok: false, reason: "nonce" };
    }

    const identity = identityFromClaims(claims, this.config.issuer);
    if (!identity) return { ok: false, reason: "claims", detail: "no sub claim" };

    if (this.config.allowedDomains.length > 0) {
      const domain = identity.email.split("@")[1] ?? "";
      if (!this.config.allowedDomains.includes(domain)) {
        return { ok: false, reason: "domain", detail: domain };
      }
    }

    this.log.debug({ event: "oidc.verified", subject: identity.subject }, "OIDC id_token verified");
    return { ok: true, identity, claims };
  }
}

/**
 * Map a jose verification error onto our reason vocabulary. jose's error codes are the contract here
 * (they are stable across versions); anything unrecognised is treated as a signature failure, which
 * is the safe direction — a token we cannot classify is a token we do not trust.
 */
export function verifyFailureReason(err: unknown): OidcFailure {
  const code = (err as { code?: string } | undefined)?.code ?? "";
  const claim = (err as { claim?: string } | undefined)?.claim ?? "";
  if (code === "ERR_JWT_EXPIRED") return "expired";
  if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
    if (claim === "iss") return "issuer";
    if (claim === "aud") return "audience";
    if (claim === "nonce") return "nonce";
    if (claim === "exp" || claim === "iat" || claim === "nbf") return "expired";
    return "claims";
  }
  return "signature";
}
