/**
 * authConfigFromEnv — the SECURE_COOKIES / NODE_ENV precedence contract (POL-43 regression).
 *
 * The documented rule: an EXPLICIT SECURE_COOKIES always wins; NODE_ENV=production is only the
 * default when it is unset. The original implementation OR'd them, so a plain-HTTP production
 * deploy (SECURE_COOKIES=false, NODE_ENV=production) still stamped `Secure` on the session
 * cookie — which browsers silently drop over http, so login "succeeded" but nothing persisted.
 */
import { describe, expect, test } from "bun:test";

import { authConfigFromEnv } from "../src/auth-local";

describe("authConfigFromEnv secureCookies", () => {
  test("explicit SECURE_COOKIES=false beats NODE_ENV=production (the plain-HTTP deploy case)", () => {
    expect(authConfigFromEnv({ SECURE_COOKIES: "false", NODE_ENV: "production" }).secureCookies).toBe(false);
  });

  test("explicit SECURE_COOKIES=true works outside production", () => {
    expect(authConfigFromEnv({ SECURE_COOKIES: "true", NODE_ENV: "development" }).secureCookies).toBe(true);
  });

  test("unset SECURE_COOKIES defaults from NODE_ENV", () => {
    expect(authConfigFromEnv({ NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(authConfigFromEnv({ NODE_ENV: "development" }).secureCookies).toBe(false);
    expect(authConfigFromEnv({}).secureCookies).toBe(false);
  });

  test("empty/whitespace SECURE_COOKIES counts as unset, not as false", () => {
    expect(authConfigFromEnv({ SECURE_COOKIES: "", NODE_ENV: "production" }).secureCookies).toBe(true);
    expect(authConfigFromEnv({ SECURE_COOKIES: "  ", NODE_ENV: "production" }).secureCookies).toBe(true);
  });
});
