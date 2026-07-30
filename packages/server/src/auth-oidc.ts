/**
 * BROKERED SIGN-IN over OIDC (POL-191) — how an organisation's own people get in.
 *
 * A hosted deployment sits on a cluster where every other service already authenticates through an
 * OIDC broker (Dex), which in turn binds the organisation's LDAP directory. Making an admin hand-mint
 * a local Polyptic account, with a Polyptic password, for someone the directory already knows is both
 * a chore and a second credential to leak. This module makes the IdP the authority instead.
 *
 * ── Deliberately NOT LDAP ───────────────────────────────────────────────────────────────────────
 *
 * The broker fronts the directory, so speaking OIDC reaches LDAP without this server holding a bind
 * DN, a service password, or a second identity backend to keep correct. One protocol, and it is the
 * one the rest of the cluster already speaks.
 *
 * ── The flow ────────────────────────────────────────────────────────────────────────────────────
 *
 * Authorization code + PKCE, discovered from the issuer's `/.well-known/openid-configuration`:
 *
 *   1. `/auth/oidc/start` mints a `state`, a `nonce` and a PKCE verifier, parks them in a SHORT-LIVED
 *      SIGNED cookie, and redirects to the IdP. The transaction lives in the cookie rather than in
 *      server memory so that a multi-replica deployment cannot fail a login by landing the callback on
 *      a different pod than the start — a bug that would be intermittent, replica-count-dependent, and
 *      thoroughly miserable to diagnose.
 *   2. `/auth/oidc/callback` checks the `state` against that cookie, exchanges the code (with the
 *      verifier) at the token endpoint, and reads the identity from the **userinfo** endpoint using
 *      the access token it just received.
 *   3. The account is found or provisioned, its role is re-derived from the IdP's groups, and the
 *      SAME opaque session cookie a local login mints is issued. Everything downstream — the gate, the
 *      role policy, mural grants, the /admin WS check — is untouched and cannot tell the two apart.
 *
 * **Why userinfo rather than verifying the ID token's signature.** The token response is fetched by
 * this server, directly from the issuer's own token endpoint, over TLS, in a channel we opened. The
 * ID token has not passed through the browser, so there is nothing for a signature check to defend
 * against here (OIDC Core §3.1.3.7 makes exactly this allowance). Taking it means no JWKS cache to
 * keep fresh, no key-rotation failure mode, and no JWT library — three things that can silently break
 * a login six months after anyone last thought about them.
 *
 * ── What the IdP decides, and what it does not ──────────────────────────────────────────────────
 *
 * The directory owns identity and GLOBAL role. Every sign-in re-reads the groups claim and re-stamps
 * the account, so removing someone from an LDAP group demotes them the next time they log in.
 *
 * The directory does NOT own mural grants — those are Polyptic's own, assigned by an admin here. A
 * group grant is the seam between the two: an admin names a group they do not manage, and the
 * directory decides who is in it.
 *
 * NEVER log a token, a code, a verifier or a client secret. The log lines below carry an issuer, a
 * subject, an email and a role, and nothing else.
 */
import { createHash, randomBytes } from "node:crypto";

import type { OperatorRole } from "@polyptic/protocol";
import type { FastifyBaseLogger, FastifyInstance } from "fastify";

/** How long a sign-in transaction may stay open: the user has this long to authenticate at the IdP. */
const TRANSACTION_TTL_MS = 10 * 60 * 1000;

/** The cookie holding the in-flight transaction (state + nonce + PKCE verifier + return path). */
export const OIDC_TX_COOKIE = "polyptic_oidc_tx";

/** Discovery is cached this long. Long enough that a sign-in never waits on it; short enough that a
 *  provider moving an endpoint is picked up the same day without a restart. */
const DISCOVERY_TTL_MS = 60 * 60 * 1000;

/** Every network call to the IdP is bounded — a hung provider must fail a login, not hang a worker. */
const IDP_TIMEOUT_MS = 10_000;

export interface OidcConfig {
  issuer: string;
  clientId: string;
  /** Empty for a public client. Dex issues confidential clients, so this is normally set. */
  clientSecret: string;
  /** Where the IdP sends the browser back. Derived from PUBLIC_BASE_URL unless set explicitly. */
  redirectUri: string;
  scopes: string;
  /** The claim carrying group membership. `groups` for Dex/Keycloak; Entra uses `roles` or `groups`. */
  groupsClaim: string;
  /** Group name → global role. Checked most-powerful first, so being in both admin and viewer groups
   *  lands on admin (a mapping that took power away by accident would be the worse failure). */
  adminGroups: string[];
  operatorGroups: string[];
  viewerGroups: string[];
  /** Role for someone in NONE of the mapped groups. `viewer` by default: they can read the fleet, and
   *  a mural grant is what gives them anything more. */
  defaultRole: OperatorRole;
  /** What the sign-in button says. */
  label: string;
}

/** The endpoints we need out of the discovery document. */
interface Discovery {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  userinfoEndpoint: string;
  fetchedAt: number;
}

/** The in-flight transaction, as carried in the signed cookie. */
interface Transaction {
  state: string;
  nonce: string;
  verifier: string;
  /** Where to land the browser afterwards. Always a same-origin PATH — see `safeReturnPath`. */
  returnTo: string;
  createdAt: number;
}

/** The identity an IdP asserted, once we have read userinfo. */
export interface OidcIdentity {
  issuer: string;
  subject: string;
  email: string;
  displayName: string | null;
  groups: string[];
}

export type OidcCallbackResult =
  | { ok: true; identity: OidcIdentity; role: OperatorRole; returnTo: string }
  | { ok: false; reason: string };

/** Split a comma/space-separated env list into trimmed, lower-cased group names (grants and mappings
 *  both match case-insensitively; directories are not consistent about case). */
function groupList(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(/[,\s]+/)
    .map((g) => g.trim().toLowerCase())
    .filter((g) => g.length > 0);
}

/**
 * Read the OIDC config from the environment. Returns null when OIDC is not configured — which is the
 * normal state for a self-hosted single-team deployment, and is silent rather than a warning.
 *
 * An issuer WITHOUT a client id is a different thing: a half-finished configuration. That warns
 * loudly, because the sign-in page will simply not offer the button and the operator would otherwise
 * be left wondering why.
 */
export function oidcConfigFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  log?: FastifyBaseLogger,
): OidcConfig | null {
  const issuer = env.OIDC_ISSUER?.trim().replace(/\/+$/, "");
  const clientId = env.OIDC_CLIENT_ID?.trim();
  if (!issuer && !clientId) return null;
  if (!issuer || !clientId) {
    log?.warn(
      { event: "auth.oidc.misconfigured", hasIssuer: Boolean(issuer), hasClientId: Boolean(clientId) },
      "⚠️  OIDC is HALF-CONFIGURED — both OIDC_ISSUER and OIDC_CLIENT_ID are required. Single sign-on " +
        "is OFF and the sign-in page will offer local accounts only.",
    );
    return null;
  }

  const base = env.PUBLIC_BASE_URL?.trim().replace(/\/+$/, "");
  const redirectUri = env.OIDC_REDIRECT_URI?.trim() || (base ? `${base}/api/v1/auth/oidc/callback` : "");
  if (!redirectUri) {
    log?.warn(
      { event: "auth.oidc.misconfigured", reason: "no-redirect-uri" },
      "⚠️  OIDC is configured but has no redirect URI — set PUBLIC_BASE_URL (preferred) or " +
        "OIDC_REDIRECT_URI. Single sign-on is OFF.",
    );
    return null;
  }

  const defaultRole = (() => {
    const raw = env.OIDC_DEFAULT_ROLE?.trim().toLowerCase();
    if (raw === "admin" || raw === "operator" || raw === "viewer") return raw;
    if (raw) {
      log?.warn(
        { event: "auth.oidc.misconfigured", reason: "bad-default-role", value: raw },
        `OIDC_DEFAULT_ROLE is not a role (${raw}) — falling back to viewer`,
      );
    }
    return "viewer" as const;
  })();

  return {
    issuer,
    clientId,
    clientSecret: env.OIDC_CLIENT_SECRET?.trim() ?? "",
    redirectUri,
    scopes: env.OIDC_SCOPES?.trim() || "openid profile email groups",
    groupsClaim: env.OIDC_GROUPS_CLAIM?.trim() || "groups",
    adminGroups: groupList(env.OIDC_ADMIN_GROUPS),
    operatorGroups: groupList(env.OIDC_OPERATOR_GROUPS),
    viewerGroups: groupList(env.OIDC_VIEWER_GROUPS),
    defaultRole,
    label: env.OIDC_LABEL?.trim() || "single sign-on",
  };
}

/** base64url of a buffer — PKCE and the opaque randoms both want URL-safe, un-padded output. */
function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The S256 PKCE challenge for a verifier. */
function pkceChallenge(verifier: string): string {
  return base64url(createHash("sha256").update(verifier, "utf8").digest());
}

/**
 * Where to send the browser after a successful sign-in.
 *
 * ONLY a same-origin path is ever honoured: it must start with a single `/` and must not start with
 * `//` (which a browser reads as a protocol-relative URL to another host). Anything else becomes `/`.
 * Without this the login endpoint is an open redirect — the classic way to make a phishing link that
 * genuinely begins with the victim organisation's own domain.
 */
export function safeReturnPath(raw: unknown): string {
  if (typeof raw !== "string" || raw.length === 0) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//")) return "/";
  return raw;
}

/** A tolerant read of a claim that should be a list of group names. Providers vary: an array of
 *  strings, or one space/comma-separated string. Anything else asserts no groups. */
function readGroups(claim: unknown): string[] {
  if (Array.isArray(claim)) {
    return claim.filter((g): g is string => typeof g === "string").map((g) => g.trim()).filter(Boolean);
  }
  if (typeof claim === "string") {
    return claim.split(/[,\s]+/).map((g) => g.trim()).filter(Boolean);
  }
  return [];
}

export class OidcService {
  readonly config: OidcConfig;
  private readonly fastify: FastifyInstance;
  private readonly log: FastifyBaseLogger;
  private discovery: Discovery | null = null;
  private discoveryInFlight: Promise<Discovery> | null = null;

  constructor(deps: { config: OidcConfig; fastify: FastifyInstance; log: FastifyBaseLogger }) {
    this.config = deps.config;
    this.fastify = deps.fastify;
    this.log = deps.log;
  }

  /** Fetch (and cache) the issuer's discovery document. Concurrent callers share one request. */
  private async discover(): Promise<Discovery> {
    const cached = this.discovery;
    if (cached && Date.now() - cached.fetchedAt < DISCOVERY_TTL_MS) return cached;
    if (this.discoveryInFlight) return this.discoveryInFlight;

    const url = `${this.config.issuer}/.well-known/openid-configuration`;
    this.discoveryInFlight = (async () => {
      const res = await fetch(url, { signal: AbortSignal.timeout(IDP_TIMEOUT_MS) });
      if (!res.ok) throw new Error(`discovery failed: ${res.status} ${res.statusText}`);
      const doc = (await res.json()) as Record<string, unknown>;
      const authorizationEndpoint = doc.authorization_endpoint;
      const tokenEndpoint = doc.token_endpoint;
      const userinfoEndpoint = doc.userinfo_endpoint;
      if (
        typeof authorizationEndpoint !== "string" ||
        typeof tokenEndpoint !== "string" ||
        typeof userinfoEndpoint !== "string"
      ) {
        throw new Error("discovery document is missing an endpoint we require");
      }
      const next: Discovery = {
        authorizationEndpoint,
        tokenEndpoint,
        userinfoEndpoint,
        fetchedAt: Date.now(),
      };
      this.discovery = next;
      return next;
    })().finally(() => {
      this.discoveryInFlight = null;
    });
    return this.discoveryInFlight;
  }

  /**
   * Probe the issuer once at boot so a broken configuration is LOUD at start-up rather than at the
   * first person's first sign-in. A failure is not fatal: local sign-in still works, and a provider
   * that is merely slow to come up will be picked up on the next discovery.
   */
  async probe(): Promise<boolean> {
    try {
      await this.discover();
      this.log.info(
        { event: "auth.oidc.ready", issuer: this.config.issuer, clientId: this.config.clientId },
        `single sign-on ready — brokered by ${this.config.issuer}`,
      );
      return true;
    } catch (err) {
      this.log.warn(
        { event: "auth.oidc.discovery.failed", issuer: this.config.issuer, err: String(err) },
        "⚠️  could not read the OIDC discovery document — single sign-on will retry on first use; " +
          "local sign-in is unaffected",
      );
      return false;
    }
  }

  /** Cookie options for the transaction cookie: same protections as the session cookie, but tiny TTL
   *  and no lifetime beyond the round-trip. */
  private txCookieOptions(secure: boolean): {
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
      // `lax` is required, not incidental: the callback arrives as a TOP-LEVEL cross-site GET
      // redirect from the IdP, and a `strict` cookie would not be sent with it — the transaction
      // would be invisible and every login would fail state validation.
      sameSite: "lax",
      signed: true,
      secure,
      maxAge: Math.floor(TRANSACTION_TTL_MS / 1000),
    };
  }

  /**
   * Begin a sign-in: mint the transaction, return the cookie value to set and the IdP URL to redirect
   * to. Throws if discovery fails (the route turns that into a 503 the operator can read).
   */
  async begin(
    returnTo: string,
    secure: boolean,
  ): Promise<{ redirectTo: string; cookie: string; cookieOptions: ReturnType<OidcService["txCookieOptions"]> }> {
    const discovery = await this.discover();
    const tx: Transaction = {
      state: base64url(randomBytes(24)),
      nonce: base64url(randomBytes(24)),
      verifier: base64url(randomBytes(48)),
      returnTo: safeReturnPath(returnTo),
      createdAt: Date.now(),
    };

    const params = new URLSearchParams({
      response_type: "code",
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri,
      scope: this.config.scopes,
      state: tx.state,
      nonce: tx.nonce,
      code_challenge: pkceChallenge(tx.verifier),
      code_challenge_method: "S256",
    });

    return {
      redirectTo: `${discovery.authorizationEndpoint}?${params.toString()}`,
      cookie: JSON.stringify(tx),
      cookieOptions: this.txCookieOptions(secure),
    };
  }

  /**
   * Finish a sign-in: validate the state against the transaction cookie, exchange the code, and read
   * the identity. Returns a plain failure reason rather than throwing — the route renders it as a
   * message on the sign-in page, and none of these reasons is a secret.
   */
  async complete(
    query: { code?: unknown; state?: unknown; error?: unknown; error_description?: unknown },
    rawTxCookie: string | undefined,
  ): Promise<OidcCallbackResult> {
    // The IdP can refuse before we ever see a code (consent declined, unknown client, …).
    if (typeof query.error === "string" && query.error.length > 0) {
      const detail = typeof query.error_description === "string" ? query.error_description : "";
      return { ok: false, reason: detail ? `${query.error}: ${detail}` : query.error };
    }
    if (typeof query.code !== "string" || typeof query.state !== "string") {
      return { ok: false, reason: "the sign-in response was missing its code or state" };
    }

    const tx = this.readTransaction(rawTxCookie);
    if (!tx) return { ok: false, reason: "the sign-in took too long, so start again" };
    // Constant-time-ish equality is unnecessary here (the attacker supplies BOTH sides and neither is
    // a stored secret), but a mismatch is a hard stop: this is the CSRF defence.
    if (tx.state !== query.state) {
      return { ok: false, reason: "the sign-in could not be verified, so start again" };
    }

    const discovery = await this.discover();
    const token = await this.exchange(discovery.tokenEndpoint, query.code, tx.verifier);
    if (!token) return { ok: false, reason: "the identity provider refused the sign-in" };

    const identity = await this.userinfo(discovery.userinfoEndpoint, token);
    if (!identity) return { ok: false, reason: "the identity provider returned no usable identity" };

    return { ok: true, identity, role: this.roleFor(identity.groups), returnTo: tx.returnTo };
  }

  /** Read + validate the transaction cookie. Returns null if absent, unsigned, malformed or expired. */
  private readTransaction(raw: string | undefined): Transaction | null {
    if (!raw) return null;
    const unsigned = this.fastify.unsignCookie(raw);
    if (!unsigned.valid || unsigned.value == null) return null;
    try {
      const tx = JSON.parse(unsigned.value) as Transaction;
      if (
        typeof tx.state !== "string" ||
        typeof tx.nonce !== "string" ||
        typeof tx.verifier !== "string" ||
        typeof tx.createdAt !== "number"
      ) {
        return null;
      }
      // The cookie's own maxAge should have expired it, but a clock or a cookie jar can disagree —
      // so the TTL is enforced here too, where it is actually load-bearing.
      if (Date.now() - tx.createdAt > TRANSACTION_TTL_MS) return null;
      return { ...tx, returnTo: safeReturnPath(tx.returnTo) };
    } catch {
      return null;
    }
  }

  /** Exchange the authorization code for tokens. Returns the ACCESS token, or null on any refusal. */
  private async exchange(
    tokenEndpoint: string,
    code: string,
    verifier: string,
  ): Promise<string | null> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: this.config.redirectUri,
      client_id: this.config.clientId,
      code_verifier: verifier,
    });
    const headers: Record<string, string> = {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    };
    // A confidential client authenticates with HTTP Basic — the secret goes in the header, never in
    // the body, and never anywhere near a log line.
    if (this.config.clientSecret) {
      const basic = Buffer.from(
        `${encodeURIComponent(this.config.clientId)}:${encodeURIComponent(this.config.clientSecret)}`,
      ).toString("base64");
      headers.authorization = `Basic ${basic}`;
    }

    try {
      const res = await fetch(tokenEndpoint, {
        method: "POST",
        headers,
        body: body.toString(),
        signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
      });
      if (!res.ok) {
        // The STATUS is logged; the response body is not — it can echo the code back at us.
        this.log.warn(
          { event: "auth.oidc.token.rejected", status: res.status },
          "the identity provider refused the token exchange",
        );
        return null;
      }
      const json = (await res.json()) as Record<string, unknown>;
      return typeof json.access_token === "string" ? json.access_token : null;
    } catch (err) {
      this.log.warn(
        { event: "auth.oidc.token.failed", err: String(err) },
        "could not reach the identity provider's token endpoint",
      );
      return null;
    }
  }

  /** Read the identity from the userinfo endpoint with the freshly-issued access token. */
  private async userinfo(userinfoEndpoint: string, accessToken: string): Promise<OidcIdentity | null> {
    try {
      const res = await fetch(userinfoEndpoint, {
        headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
        signal: AbortSignal.timeout(IDP_TIMEOUT_MS),
      });
      if (!res.ok) {
        this.log.warn(
          { event: "auth.oidc.userinfo.rejected", status: res.status },
          "the identity provider refused the userinfo request",
        );
        return null;
      }
      const claims = (await res.json()) as Record<string, unknown>;
      const subject = typeof claims.sub === "string" ? claims.sub : "";
      const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : "";
      // Both are required. The subject is the account's identity; the email is what an admin sees in
      // the People panel and in Settings ▸ Operators, and an account nobody can identify is unusable.
      if (!subject || !email) {
        this.log.warn(
          { event: "auth.oidc.userinfo.incomplete", hasSubject: Boolean(subject), hasEmail: Boolean(email) },
          "the identity provider returned no subject or no email — add the `email` scope to the client",
        );
        return null;
      }
      const name = typeof claims.name === "string" ? claims.name.trim() : "";
      return {
        issuer: this.config.issuer,
        subject,
        email,
        displayName: name.length > 0 ? name : null,
        groups: readGroups(claims[this.config.groupsClaim]),
      };
    } catch (err) {
      this.log.warn(
        { event: "auth.oidc.userinfo.failed", err: String(err) },
        "could not reach the identity provider's userinfo endpoint",
      );
      return null;
    }
  }

  /**
   * Map the IdP's groups onto a GLOBAL role, most powerful first.
   *
   * Someone in both an admin group and a viewer group is an admin: a mapping that took power away by
   * accident is the worse of the two failures, and the operator who put them in the admin group meant
   * it. With no group mapping configured at all, everyone lands on `defaultRole` (`viewer`) — a
   * deployment then hands out capability through mural grants, which is the point.
   */
  roleFor(groups: string[]): OperatorRole {
    const held = new Set(groups.map((g) => g.trim().toLowerCase()));
    if (this.config.adminGroups.some((g) => held.has(g))) return "admin";
    if (this.config.operatorGroups.some((g) => held.has(g))) return "operator";
    if (this.config.viewerGroups.some((g) => held.has(g))) return "viewer";
    return this.config.defaultRole;
  }
}
