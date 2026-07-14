/**
 * POL-106 — OIDC config parsing, PKCE, claim mapping and the verification-failure vocabulary.
 *
 * These are the parts of the OIDC seam that must be right BEFORE a single byte reaches an IdP. The
 * live flow (discovery → authorize → code exchange → JWKS verification) is proven end to end against
 * a stub IdP in `packages/e2e/oidc.e2e.test.ts`; here we pin:
 *
 *   - a deployment with NO OIDC env is unchanged (config is null → no routes, no button);
 *   - a HALF-configured IdP refuses to boot (never quietly serve local-only auth to an operator who
 *     believes SSO is on);
 *   - the redirect URI is exact and derived from the one public origin when not stated;
 *   - the PKCE challenge really is base64url(sha256(verifier));
 *   - claims → operator identity, including the fallbacks that keep a login working when an IdP is
 *     configured without the `email` scope.
 */
import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import {
  OIDC_CALLBACK_PATH,
  codeChallenge,
  identityFromClaims,
  oidcConfigFromEnv,
  verifyFailureReason,
} from "../src/oidc";

const FULL = {
  OIDC_ISSUER: "https://idp.example.test/realms/polyptic",
  OIDC_CLIENT_ID: "polyptic-console",
  OIDC_CLIENT_SECRET: "s3cret",
  PUBLIC_BASE_URL: "https://polyptic.example.test",
} as NodeJS.ProcessEnv;

describe("oidcConfigFromEnv (POL-106)", () => {
  test("no OIDC env at all → null: the deployment is byte-for-byte the pre-POL-106 one", () => {
    expect(oidcConfigFromEnv({} as NodeJS.ProcessEnv)).toBeNull();
    expect(oidcConfigFromEnv({ PUBLIC_BASE_URL: "https://x.test" } as NodeJS.ProcessEnv)).toBeNull();
  });

  test("a half-configured IdP THROWS (issuer without client id/secret, and every other partial)", () => {
    expect(() => oidcConfigFromEnv({ OIDC_ISSUER: FULL.OIDC_ISSUER } as NodeJS.ProcessEnv)).toThrow(/half-configured/);
    expect(() =>
      oidcConfigFromEnv({ OIDC_ISSUER: FULL.OIDC_ISSUER, OIDC_CLIENT_ID: "x" } as NodeJS.ProcessEnv),
    ).toThrow(/half-configured/);
    expect(() => oidcConfigFromEnv({ OIDC_CLIENT_SECRET: "x" } as NodeJS.ProcessEnv)).toThrow(/half-configured/);
  });

  test("a garbage issuer throws rather than being carried into a redirect", () => {
    expect(() =>
      oidcConfigFromEnv({ ...FULL, OIDC_ISSUER: "not-a-url" } as NodeJS.ProcessEnv),
    ).toThrow(/not a URL/);
  });

  test("configured → issuer normalized (no trailing slash), defaults filled, redirect derived", () => {
    const cfg = oidcConfigFromEnv({ ...FULL, OIDC_ISSUER: `${FULL.OIDC_ISSUER}/` } as NodeJS.ProcessEnv);
    expect(cfg).not.toBeNull();
    expect(cfg!.issuer).toBe("https://idp.example.test/realms/polyptic");
    expect(cfg!.clientId).toBe("polyptic-console");
    // Derived from the ONE public origin (D89) — and it must match the IdP registration exactly.
    expect(cfg!.redirectUri).toBe(`https://polyptic.example.test${OIDC_CALLBACK_PATH}`);
    expect(cfg!.postLoginUrl).toBe("https://polyptic.example.test/wall");
    expect(cfg!.scopes).toEqual(["openid", "profile", "email"]);
    expect(cfg!.providerName).toBe("SSO"); // generic default — no vendor is ever named in code
    expect(cfg!.allowedDomains).toEqual([]);
    expect(cfg!.rpLogout).toBe(false);
  });

  test("no PUBLIC_BASE_URL and no OIDC_REDIRECT_URI → throws (an exact redirect URI is mandatory)", () => {
    const env = { ...FULL, PUBLIC_BASE_URL: undefined } as NodeJS.ProcessEnv;
    expect(() => oidcConfigFromEnv(env)).toThrow(/redirect URI/);
  });

  test("explicit OIDC_REDIRECT_URI wins over the derived one; scopes always carry openid", () => {
    const cfg = oidcConfigFromEnv({
      ...FULL,
      OIDC_REDIRECT_URI: "https://console.example.test/api/v1/auth/oidc/callback",
      OIDC_SCOPES: "profile email groups",
      OIDC_PROVIDER_NAME: "Company SSO",
      OIDC_ALLOWED_DOMAINS: "example.test, @other.test",
      OIDC_RP_LOGOUT: "true",
      OIDC_POST_LOGIN_URL: "http://localhost:5175/wall",
    } as NodeJS.ProcessEnv)!;
    expect(cfg.redirectUri).toBe("https://console.example.test/api/v1/auth/oidc/callback");
    expect(cfg.scopes[0]).toBe("openid");
    expect(cfg.scopes).toContain("groups");
    expect(cfg.providerName).toBe("Company SSO");
    expect(cfg.allowedDomains).toEqual(["example.test", "other.test"]);
    expect(cfg.rpLogout).toBe(true);
    expect(cfg.postLoginUrl).toBe("http://localhost:5175/wall");
  });
});

describe("PKCE (S256)", () => {
  test("the challenge is base64url(sha256(verifier)), unpadded", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const expected = createHash("sha256")
      .update(verifier, "ascii")
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(codeChallenge(verifier)).toBe(expected);
    expect(codeChallenge(verifier)).not.toContain("=");
  });
});

describe("identityFromClaims — the claim → operator mapping (and the RBAC seam)", () => {
  const issuer = "https://idp.example.test/realms/polyptic";

  test("the email claim wins and is normalized", () => {
    const id = identityFromClaims({ sub: "abc-123", email: "Ada.Lovelace@Example.test" }, issuer);
    expect(id).toEqual({ subject: "abc-123", email: "ada.lovelace@example.test" });
  });

  test("preferred_username is used when it is email-shaped, and is always carried through", () => {
    const id = identityFromClaims({ sub: "abc-123", preferred_username: "ada@example.test" }, issuer)!;
    expect(id.email).toBe("ada@example.test");
    expect(id.username).toBe("ada@example.test");
  });

  test("no email anywhere → a stable synthetic <sub>@<issuer-host> (the login still works)", () => {
    const id = identityFromClaims({ sub: "user|42:weird", preferred_username: "ada" }, issuer)!;
    expect(id.email).toBe("user-42-weird@idp.example.test");
    expect(id.username).toBe("ada");
  });

  test("no sub → no identity (the durable identifier is not optional)", () => {
    expect(identityFromClaims({ email: "ada@example.test" }, issuer)).toBeNull();
  });

  test("group/role claims are carried in the payload but IGNORED here — RBAC is POL-107", () => {
    const id = identityFromClaims(
      { sub: "abc", email: "ada@example.test", groups: ["wall-admins"] },
      issuer,
    )!;
    expect(id).not.toHaveProperty("groups");
    expect(id.email).toBe("ada@example.test");
  });
});

describe("verifyFailureReason — the rejection vocabulary", () => {
  test("jose's error codes map onto the reasons the rejection matrix asserts on", () => {
    expect(verifyFailureReason({ code: "ERR_JWT_EXPIRED" })).toBe("expired");
    expect(verifyFailureReason({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim: "iss" })).toBe("issuer");
    expect(verifyFailureReason({ code: "ERR_JWT_CLAIM_VALIDATION_FAILED", claim: "aud" })).toBe("audience");
    expect(verifyFailureReason({ code: "ERR_JWS_SIGNATURE_VERIFICATION_FAILED" })).toBe("signature");
    expect(verifyFailureReason({ code: "ERR_JWKS_NO_MATCHING_KEY" })).toBe("signature");
    // Anything we cannot classify is treated as a signature failure — the safe direction.
    expect(verifyFailureReason(new Error("who knows"))).toBe("signature");
  });
});
